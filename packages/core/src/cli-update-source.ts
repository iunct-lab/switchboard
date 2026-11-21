/**
 * Where a new Claude Code or Codex CLI comes from, and whether what was fetched can be trusted: read the newest version
 * and its checksum from the distributor the installers read from, decide whether it is old enough to take, notice that
 * the distributor withdrew it, and check a downloaded file against the checksum and the signature.
 *
 * Pure functions over injected `fetch` / `gpg` / `cosign`; nothing here starts the daemon or changes the host. The
 * distributors are fixed (the installers' own hosts), not a setting: a setting that moves them would move the line this
 * file guards.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CliRunner = "claude" | "codex";

export interface CliRelease {
  runner: CliRunner;
  version: string;
  /** epoch ms the distributor says it published the version. */
  publishedAt: number;
  assetUrl: string;
  /** null = the distributor published no checksum for this file. */
  sha256: string | null;
  /** null = the distributor published no signature for this file. */
  signature: { kind: "gpg" | "sigstore"; url: string } | null;
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: "not-official" | "mismatch" | "withdrawn" | "unsigned"; detail: string };
export type Refusal = Extract<Verdict, { ok: false }>;
export type ReadResult = { ok: true; release: CliRelease } | Refusal;

/** Every host a download, or any redirect on the way to it, may come from. Observed: github.com answers a release asset with a redirect to release-assets.githubusercontent.com. */
export const OFFICIAL_HOSTS: readonly string[] = [
  "downloads.claude.ai",
  "github.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

export function isOfficial(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && OFFICIAL_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

const CLAUDE_BASE = "https://downloads.claude.ai/claude-code-releases";
const CLAUDE_KEY_URL = "https://downloads.claude.ai/keys/claude-code.asc";
const CODEX_REPO = "openai/codex";
const CODEX_LATEST = `https://github.com/${CODEX_REPO}/releases/latest`;
const CODEX_TAG_API = `https://api.github.com/repos/${CODEX_REPO}/releases/tags`;
/** Who signs a Codex release: the certificate GitHub Actions issues to its release workflow, run for the version's tag. */
export const codexSigner = (version: string) => `https://github.com/${CODEX_REPO}/.github/workflows/rust-release.yml@refs/tags/rust-v${version}`;
const CODEX_SIGNER_ISSUER = "https://token.actions.githubusercontent.com";
/** What cosign prints when it could not fetch sigstore's trusted root (TUF) — a network fault, not a verdict on the file. */
const COSIGN_UNREACHABLE = /\btuf\b|dial tcp|no such host|i\/o timeout|connection refused|TLS handshake/i;

/**
 * Primary key fingerprint of the Claude Code release signing key, as Anthropic's setup page prints it under "Binary
 * integrity and code signing" (https://code.claude.com/docs/en/setup).
 */
export const CLAUDE_RELEASE_KEY_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliSourceDeps {
  /** Called with `redirect: "manual"`; the redirects are followed here so every hop is checked. */
  fetch: (url: string, init: { method: "GET" | "HEAD"; redirect: "manual" }) => Promise<Response>;
  gpg: (args: string[]) => Promise<CmdResult>;
  /** sigstore's verifier, pinned in aws/host/devtools.sh: reads the cosign bundle Codex publishes next to each asset. */
  cosign: (args: string[]) => Promise<CmdResult>;
  /** Runs `fn` in a fresh private directory and removes it afterwards. */
  tmp: <T>(fn: (dir: string) => Promise<T>) => Promise<T>;
  sha256Of: (file: string) => Promise<string>;
  /** The platform the file is for: CPU and whether the C library is musl (as claude.ai/install.sh decides). */
  target: () => { arch: "arm64" | "x64"; musl: boolean };
}

class NotOfficialError extends Error {}
class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${url} answered ${status}`);
  }
}

const MAX_REDIRECTS = 5;

/** GET/HEAD `url`, following redirects by hand: a hop to a host outside OFFICIAL_HOSTS throws NotOfficialError. Returns the final non-redirect response. */
async function getOfficial(url: string, deps: CliSourceDeps, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isOfficial(at)) throw new NotOfficialError(`${at} is not on an official host`);
    const res = await deps.fetch(at, { method, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) throw new Error(`${at} redirected without a location`);
    at = new URL(location, at).toString();
  }
  if (!isOfficial(at)) throw new NotOfficialError(`${at} is not on an official host`);
  throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
}

async function okResponse(url: string, deps: CliSourceDeps): Promise<Response> {
  const res = await getOfficial(url, deps);
  if (res.status !== 200) throw new HttpError(res.status, url);
  return res;
}

/** Turns an official-host violation into a refusal; any other error (network, 5xx) propagates so the caller tries again later. */
async function guard<T>(fn: () => Promise<T>): Promise<T | Refusal> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NotOfficialError) return { ok: false, reason: "not-official", detail: e.message };
    throw e;
  }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/;
/** Orders two version names by their leading `major.minor.patch` (what follows is ignored; a name without one reads as 0.0.0). Pass the version names the distributors publish, not raw `--version` output. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)?.slice(1).map(Number) ?? [];
  const pb = SEMVER.exec(b)?.slice(1).map(Number) ?? [];
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
/** A published checksum in lower case; `undefined` when one was published but is not a sha256 (that is a refusal, not "none"). */
function sumOf(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined; // a number or an object where a checksum goes is unreadable, not "none"
  const v = raw.trim().toLowerCase();
  return SHA256_HEX.test(v) ? v : undefined;
}

/* ---------- Claude Code ---------- */

function claudePlatform(deps: CliSourceDeps): string {
  const { arch, musl } = deps.target();
  return `linux-${arch}${musl ? "-musl" : ""}`;
}

async function claudeLatestVersion(deps: CliSourceDeps): Promise<string> {
  const v = (await (await okResponse(`${CLAUDE_BASE}/latest`, deps)).text()).trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Claude latest is not a version: ${v.slice(0, 40)}`);
  return v;
}

async function readClaude(deps: CliSourceDeps): Promise<ReadResult> {
  const version = await claudeLatestVersion(deps);
  const manifestUrl = `${CLAUDE_BASE}/${version}/manifest.json`;
  let manifest: { version?: string; buildDate?: string; platforms?: Record<string, { checksum?: string }> };
  try {
    manifest = (await (await okResponse(manifestUrl, deps)).json()) as typeof manifest;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      return { ok: false, reason: "withdrawn", detail: `latest names ${version} but its manifest is gone` };
    }
    throw e;
  }
  if (manifest.version !== version) {
    return { ok: false, reason: "mismatch", detail: `manifest says ${manifest.version}, latest says ${version}` };
  }
  const platform = claudePlatform(deps);
  const checksum = sumOf(manifest.platforms?.[platform]?.checksum);
  if (checksum === undefined) return { ok: false, reason: "mismatch", detail: `${version}: the checksum for ${platform} is not a sha256` };
  const sigUrl = `${manifestUrl}.sig`;
  // Only a 404 means "no signature"; any other failure is an outage, so try again later rather than read it as unsigned.
  const sigHead = await getOfficial(sigUrl, deps, "HEAD");
  if (sigHead.status !== 200 && sigHead.status !== 404) throw new HttpError(sigHead.status, sigUrl);
  const publishedAt = Date.parse(manifest.buildDate ?? "");
  if (Number.isNaN(publishedAt)) throw new Error(`${manifestUrl} has no readable buildDate: ${String(manifest.buildDate).slice(0, 40)}`);
  return {
    ok: true,
    release: {
      runner: "claude",
      version,
      publishedAt,
      assetUrl: `${CLAUDE_BASE}/${version}/${platform}/claude`,
      sha256: checksum,
      signature: sigHead.status === 200 ? { kind: "gpg", url: sigUrl } : null,
    },
  };
}

/* ---------- Codex ---------- */

function codexTarget(deps: CliSourceDeps): string {
  return `${deps.target().arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
}

async function codexLatestVersion(deps: CliSourceDeps): Promise<string> {
  if (!isOfficial(CODEX_LATEST)) throw new NotOfficialError(CODEX_LATEST);
  // The redirect of `releases/latest` is the answer, not a hop to follow.
  const res = await deps.fetch(CODEX_LATEST, { method: "HEAD", redirect: "manual" });
  if (res.status < 300 || res.status >= 400) throw new HttpError(res.status, CODEX_LATEST);
  const location = res.headers.get("location") ?? "";
  const target = new URL(location || CODEX_LATEST, CODEX_LATEST).toString();
  if (!isOfficial(target)) throw new NotOfficialError(`Codex latest redirects to ${target}`);
  const version = /\/releases\/tag\/rust-v(\d+\.\d+\.\d+)$/.exec(target)?.[1];
  if (!version) throw new Error(`Codex latest did not name a release: ${target.slice(0, 80)}`);
  return version;
}

interface CodexReleaseJson {
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets?: Array<{ name: string; digest?: string | null; browser_download_url: string }>;
}

async function codexReleaseJson(version: string, deps: CliSourceDeps): Promise<CodexReleaseJson> {
  return (await (await okResponse(`${CODEX_TAG_API}/rust-v${version}`, deps)).json()) as CodexReleaseJson;
}

async function readCodex(deps: CliSourceDeps): Promise<ReadResult> {
  const version = await codexLatestVersion(deps);
  let json: CodexReleaseJson;
  try {
    json = await codexReleaseJson(version, deps);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      return { ok: false, reason: "withdrawn", detail: `latest names rust-v${version} but the release is gone` };
    }
    throw e;
  }
  if (json.draft || json.prerelease) {
    return { ok: false, reason: "withdrawn", detail: `rust-v${version} is ${json.draft ? "a draft" : "a prerelease"}` };
  }
  const name = `codex-package-${codexTarget(deps)}.tar.gz`;
  const assets = json.assets ?? [];
  const asset = assets.find((a) => a.name === name);
  if (!asset) throw new Error(`rust-v${version} has no ${name}`);
  if (!isOfficial(asset.browser_download_url)) return { ok: false, reason: "not-official", detail: `${name} is at ${asset.browser_download_url}` };
  // a digest of another kind, or "sha256:" with nothing after it, is published but unreadable: refused below, not taken for none
  const raw = asset.digest as unknown;
  const digest = raw === undefined || raw === null ? null : typeof raw === "string" && raw.startsWith("sha256:") ? sumOf(raw.slice(7)) : undefined;
  const sums = assets.find((a) => a.name === "codex-package_SHA256SUMS");
  const listedAll: string[] = [];
  if (sums) {
    const body = await (await okResponse(sums.browser_download_url, deps)).text();
    for (const line of body.split("\n")) {
      const [sum, file] = line.trim().split(/\s+/);
      // `sha256sum -b` writes the name as `*name` (binary mode)
      if ((file === name || file === `*${name}`) && sum !== undefined) listedAll.push(sum);
    }
  }
  // every line for the package must agree: two different checksums for one file is no checksum to trust
  const listedSums = [...new Set(listedAll.map((x) => sumOf(x)))];
  const listedSum = listedSums.length === 0 ? null : listedSums.length === 1 ? listedSums[0] : undefined;
  if (digest === undefined || listedSum === undefined) return { ok: false, reason: "mismatch", detail: `${name}: a published checksum is not a sha256` };
  if (digest && listedSum && digest !== listedSum) {
    return { ok: false, reason: "mismatch", detail: `${name}: the asset digest ${digest} and SHA256SUMS ${listedSum} differ` };
  }
  const sha256 = digest ?? listedSum;
  const bundle = assets.find((a) => a.name === `${name}.sigstore`);
  if (bundle && !isOfficial(bundle.browser_download_url)) return { ok: false, reason: "not-official", detail: `${bundle.name} is at ${bundle.browser_download_url}` };
  const publishedAt = Date.parse(json.published_at ?? "");
  if (Number.isNaN(publishedAt)) throw new Error(`rust-v${version} has no readable published_at: ${String(json.published_at).slice(0, 40)}`);
  return {
    ok: true,
    release: {
      runner: "codex",
      version,
      publishedAt,
      assetUrl: asset.browser_download_url,
      sha256,
      signature: bundle ? { kind: "sigstore", url: bundle.browser_download_url } : null,
    },
  };
}

/** Only the name of the newest version (one small read): enough to tell whether there is anything new before `readLatest`. */
export async function latestVersion(runner: CliRunner, deps: CliSourceDeps): Promise<string | Refusal> {
  return guard(() => (runner === "claude" ? claudeLatestVersion(deps) : codexLatestVersion(deps)));
}

/** The newest version the distributor offers for this host, with the checksum and signature it publishes. Network errors throw (try again later); the distributor's own faults come back as a refusal. */
export async function readLatest(runner: CliRunner, deps: CliSourceDeps): Promise<ReadResult> {
  return guard(() => (runner === "claude" ? readClaude(deps) : readCodex(deps)));
}

/** Saves the file at `url` to `file` through the official hosts only (every redirect hop is checked). A hop outside is a `not-official` refusal; any other failure throws. */
export async function download(url: string, file: string, deps: CliSourceDeps): Promise<Refusal | null> {
  return guard<null>(async () => {
    await Bun.write(file, await okResponse(url, deps));
    return null;
  });
}

/** Whether `waitHours` have passed since the distributor published the version (0 = always). */
export function isDue(release: CliRelease, waitHours: number, now: number): boolean {
  return now - release.publishedAt >= waitHours * 3_600_000;
}

/** ok = the version is still offered and nothing newer has not replaced it. Otherwise `withdrawn`: it is gone, a draft or prerelease, or the distributor's newest is older than it. */
export async function withdrawn(release: CliRelease, deps: CliSourceDeps): Promise<Verdict> {
  return guard<Verdict>(async () => {
    const gone = (detail: string): Verdict => ({ ok: false, reason: "withdrawn", detail });
    if (release.runner === "claude") {
      try {
        await okResponse(`${CLAUDE_BASE}/${release.version}/manifest.json`, deps);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return gone(`${release.version} has no manifest any more`);
        throw e;
      }
      const latest = await claudeLatestVersion(deps);
      return compareVersions(latest, release.version) < 0 ? gone(`the newest is ${latest}, older than ${release.version}`) : { ok: true };
    }
    let json: CodexReleaseJson;
    try {
      json = await codexReleaseJson(release.version, deps);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return gone(`rust-v${release.version} is gone`);
      throw e;
    }
    if (json.draft || json.prerelease) return gone(`rust-v${release.version} is now ${json.draft ? "a draft" : "a prerelease"}`);
    const latest = await codexLatestVersion(deps);
    return compareVersions(latest, release.version) < 0 ? gone(`the newest is ${latest}, older than ${release.version}`) : { ok: true };
  });
}

/* ---------- checking a downloaded file ---------- */

export interface VerifyOptions {
  /** What to do with a file the distributor published no checksum or no signature for. A checksum that differs is always `mismatch`. */
  missingSignature: "refuse" | "allow";
}

const mismatch = (detail: string): Refusal => ({ ok: false, reason: "mismatch", detail });

/** The primary fingerprints a key file carries (`gpg --show-keys --with-colons`: the first `fpr` after each `pub`). */
function primaryFingerprints(colons: string): string[] {
  const out: string[] = [];
  let wantFpr = false;
  for (const line of colons.split("\n")) {
    if (line.startsWith("pub:")) wantFpr = true;
    else if (line.startsWith("sub:")) wantFpr = false;
    else if (wantFpr && line.startsWith("fpr:")) {
      out.push(line.split(":")[9] ?? "");
      wantFpr = false;
    }
  }
  return out;
}

async function verifyGpg(file: string, release: CliRelease, deps: CliSourceDeps): Promise<Verdict> {
  const sigUrl = release.signature!.url;
  const manifestUrl = sigUrl.replace(/\.sig$/, "");
  return deps.tmp(async (dir) => {
    const save = async (name: string, url: string) => {
      const path = join(dir, name);
      await Bun.write(path, await (await okResponse(url, deps)).arrayBuffer());
      return path;
    };
    const [keyFile, manifestFile, sigFile] = await Promise.all([
      save("key.asc", CLAUDE_KEY_URL),
      save("manifest.json", manifestUrl),
      save("manifest.json.sig", sigUrl),
    ]);
    // A private home, and no agent: the host has no gpg-agent, and a signature check needs none.
    const home = ["--homedir", dir, "--batch", "--no-autostart"];
    const shown = await deps.gpg([...home, "--with-colons", "--show-keys", keyFile]);
    const keys = primaryFingerprints(shown.stdout);
    if (shown.code !== 0 || keys.length !== 1 || keys[0] !== CLAUDE_RELEASE_KEY_FINGERPRINT) {
      return mismatch(`the signing key is ${keys.join(",") || "unreadable"}, not ${CLAUDE_RELEASE_KEY_FINGERPRINT}`);
    }
    const imported = await deps.gpg([...home, "--import", keyFile]);
    if (imported.code !== 0) return mismatch(`the signing key did not import: ${imported.stderr.slice(0, 200)}`);
    const checked = await deps.gpg([...home, "--status-fd", "1", "--verify", sigFile, manifestFile]);
    const valid = checked.stdout.split("\n").find((l) => l.startsWith("[GNUPG:] VALIDSIG "));
    const primary = valid?.trim().split(" ").at(-1);
    if (checked.code !== 0 || primary !== CLAUDE_RELEASE_KEY_FINGERPRINT) {
      return mismatch(`the manifest signature is not valid for ${CLAUDE_RELEASE_KEY_FINGERPRINT}`);
    }
    // The signature covers the manifest; tie it to the version and to this platform's checksum the file was compared with.
    const manifest = JSON.parse(await Bun.file(manifestFile).text()) as {
      version?: string;
      platforms?: Record<string, { checksum?: string }>;
    };
    if (manifest.version !== release.version) {
      return mismatch(`the signed manifest is for ${String(manifest.version)}, not ${release.version}`);
    }
    const platform = claudePlatform(deps);
    const signed = sumOf(manifest.platforms?.[platform]?.checksum);
    if (signed === undefined) return mismatch(`the signed manifest's checksum for ${platform} is not a sha256`);
    if (release.sha256 === null) {
      // No checksum was read before; verify() already applied missingSignature to that. A checksum the signed manifest
      // does carry is still the file's to match.
      if (signed === null) return { ok: true };
      const actual = await deps.sha256Of(file);
      return actual === signed ? { ok: true } : mismatch(`sha256 is ${actual}, the signed manifest lists ${signed} for ${platform}`);
    }
    return signed === release.sha256 ? { ok: true } : mismatch(`the signed manifest lists another checksum for ${platform}`);
  });
}

async function verifySigstore(file: string, release: CliRelease, deps: CliSourceDeps): Promise<Verdict> {
  return deps.tmp(async (dir) => {
    const bundle = join(dir, "bundle.sigstore");
    await Bun.write(bundle, await (await okResponse(release.signature!.url, deps)).arrayBuffer());
    // Codex signs with a keyless certificate from GitHub Actions: only its release workflow, at this version's tag, counts.
    const r = await deps.cosign([
      "verify-blob",
      "--bundle",
      bundle,
      "--certificate-identity",
      codexSigner(release.version),
      "--certificate-oidc-issuer",
      CODEX_SIGNER_ISSUER,
      file,
    ]);
    if (r.code === 0) return { ok: true };
    // cosign that could not run here, or could not reach sigstore's trusted root, says nothing about the release: try again later
    if (r.code === 127 || COSIGN_UNREACHABLE.test(r.stderr)) throw new Error(`cosign could not check the signature: ${r.stderr.trim().slice(0, 200)}`);
    return mismatch(`the signature does not verify: ${r.stderr.trim().slice(0, 200)}`);
  });
}

/** Checks a downloaded `file` against what the distributor published: the hosts, the sha256, then the signature. */
export async function verify(file: string, release: CliRelease, opts: VerifyOptions, deps: CliSourceDeps): Promise<Verdict> {
  const outside = [release.assetUrl, release.signature?.url].find((u) => u !== undefined && !isOfficial(u));
  if (outside) return { ok: false, reason: "not-official", detail: `${outside} is not on an official host` };
  const unsigned = (what: string): Verdict =>
    opts.missingSignature === "refuse" ? { ok: false, reason: "unsigned", detail: `the distributor published no ${what}` } : { ok: true };

  if (release.sha256 === null) {
    const v = unsigned("checksum");
    if (!v.ok) return v;
  } else {
    const actual = await deps.sha256Of(file);
    if (actual !== release.sha256) return mismatch(`sha256 is ${actual}, the distributor lists ${release.sha256}`);
  }
  if (release.signature === null) return unsigned("signature");
  return guard<Verdict>(() => (release.signature!.kind === "gpg" ? verifyGpg(file, release, deps) : verifySigstore(file, release, deps)));
}

/* ---------- the real dependencies ---------- */

async function run(cmd: string[]): Promise<CmdResult> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

async function isMusl(arch: string): Promise<boolean> {
  if (await Bun.file(`/lib/libc.musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`).exists()) return true;
  const ldd = await run(["ldd", "/bin/ls"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return /musl/.test(ldd.stdout + ldd.stderr);
}

export async function realCliSourceDeps(): Promise<CliSourceDeps> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const musl = await isMusl(arch);
  return {
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
    gpg: (args) => run(["gpg", ...args]),
    cosign: (args) => run(["cosign", ...args]).catch((e: Error) => ({ code: 127, stdout: "", stderr: `cosign is not here (aws/host/devtools.sh installs it): ${e.message}` })),
    tmp: async (fn) => {
      const dir = await mkdtemp(join(tmpdir(), "switchboard.cli-source."));
      try {
        return await fn(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    sha256Of: (file) =>
      new Promise((resolve, reject) => {
        const h = createHash("sha256");
        createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
      }),
    target: () => ({ arch, musl }),
  };
}
