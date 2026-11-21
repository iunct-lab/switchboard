// test-reads: none
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_RELEASE_KEY_FINGERPRINT,
  codexSigner,
  type CliRelease,
  type CliSourceDeps,
  type CmdResult,
  download,
  isDue,
  latestVersion,
  isOfficial,
  readLatest,
  verify,
  withdrawn,
} from "./cli-update-source.ts";

const SUM = "a".repeat(64);
const OTHER = "b".repeat(64);
const CLAUDE = "https://downloads.claude.ai/claude-code-releases";
const TAG_API = "https://api.github.com/repos/openai/codex/releases/tags";
const HOUR = 3_600_000;

type Route = Response | (() => Response);
const text = (body: string, status = 200) => new Response(body, { status });
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

function fakeDeps(routes: Record<string, Route>, over: Partial<CliSourceDeps> = {}): CliSourceDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (url) => {
      asked.push(url);
      const r = routes[url];
      if (!r) return new Response("nope", { status: 404 });
      const res = typeof r === "function" ? r() : r;
      return new Response(await res.clone().text(), { status: res.status, headers: res.headers });
    },
    gpg: async () => ({ code: 0, stdout: "", stderr: "" }),
    cosign: async () => ({ code: 0, stdout: "", stderr: "" }),
    tmp: async (fn) => {
      const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "switchboard.cli-source-test."));
      try {
        return await fn(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    sha256Of: async () => SUM,
    target: () => ({ arch: "arm64", musl: false }),
    ...over,
  };
}

function claudeRoutes(version: string, builtAt: number, checksum = SUM): Record<string, Route> {
  return {
    [`${CLAUDE}/latest`]: text(`${version}\n`),
    [`${CLAUDE}/${version}/manifest.json`]: json({
      version,
      buildDate: new Date(builtAt).toISOString(),
      platforms: { "linux-arm64": { checksum }, "linux-x64": { checksum: OTHER } },
    }),
    [`${CLAUDE}/${version}/manifest.json.sig`]: text("sig"),
  };
}

function codexRoutes(version: string, publishedAt: number, over: { digest?: string; listed?: string; draft?: boolean } = {}): Record<string, Route> {
  const base = `https://github.com/openai/codex/releases/download/rust-v${version}`;
  const name = "codex-package-aarch64-unknown-linux-musl.tar.gz";
  return {
    "https://github.com/openai/codex/releases/latest": redirect(`https://github.com/openai/codex/releases/tag/rust-v${version}`),
    [`${TAG_API}/rust-v${version}`]: json({
      draft: over.draft ?? false,
      prerelease: false,
      published_at: new Date(publishedAt).toISOString(),
      assets: [
        { name, digest: `sha256:${over.digest ?? SUM}`, browser_download_url: `${base}/${name}` },
        { name: `${name}.sigstore`, digest: "sha256:c", browser_download_url: `${base}/${name}.sigstore` },
        { name: "codex-package_SHA256SUMS", digest: "sha256:d", browser_download_url: `${base}/codex-package_SHA256SUMS` },
      ],
    }),
    [`${base}/codex-package_SHA256SUMS`]: redirect(`https://release-assets.githubusercontent.com/x/sums`),
    "https://release-assets.githubusercontent.com/x/sums": text(
      `${OTHER}  codex-app-server-package-aarch64-unknown-linux-musl.tar.gz\n${over.listed ?? SUM}  ${name}\n`,
    ),
  };
}

function release(over: Partial<CliRelease> = {}): CliRelease {
  return {
    runner: "claude",
    version: "2.1.328",
    publishedAt: 0,
    assetUrl: `${CLAUDE}/2.1.328/linux-arm64/claude`,
    sha256: SUM,
    signature: { kind: "gpg", url: `${CLAUDE}/2.1.328/manifest.json.sig` },
    ...over,
  };
}

describe("reading the newest version", () => {
  test("reads Claude's version, checksum for this platform, and signature", async () => {
    const t = Date.parse("2026-11-18T21:56:43Z");
    const r = await readLatest("claude", fakeDeps(claudeRoutes("2.1.328", t)));
    expect(r).toEqual({
      ok: true,
      release: {
        runner: "claude",
        version: "2.1.328",
        publishedAt: t,
        assetUrl: `${CLAUDE}/2.1.328/linux-arm64/claude`,
        sha256: SUM,
        signature: { kind: "gpg", url: `${CLAUDE}/2.1.328/manifest.json.sig` },
      },
    });
  });

  test("reads the musl platform when the host is musl", async () => {
    const routes = claudeRoutes("2.1.328", 0);
    (routes[`${CLAUDE}/2.1.328/manifest.json`] as Response) = json({
      version: "2.1.328",
      buildDate: new Date(0).toISOString(),
      platforms: { "linux-arm64": { checksum: SUM }, "linux-arm64-musl": { checksum: OTHER } },
    });
    const r = await readLatest("claude", fakeDeps(routes, { target: () => ({ arch: "arm64", musl: true }) }));
    expect(r.ok && r.release.sha256).toBe(OTHER);
    expect(r.ok && r.release.assetUrl).toBe(`${CLAUDE}/2.1.328/linux-arm64-musl/claude`);
  });

  test("reads Codex through the latest redirect, the asset digest and the sigstore bundle", async () => {
    const t = Date.parse("2026-11-18T03:40:48Z");
    const r = await readLatest("codex", fakeDeps(codexRoutes("0.170.0", t)));
    expect(r.ok && r.release).toMatchObject({
      runner: "codex",
      version: "0.170.0",
      publishedAt: t,
      sha256: SUM,
      signature: { kind: "sigstore" },
    });
  });

  test("a checksum in upper case is the same checksum; one that is not a sha256 is refused, not taken for none", async () => {
    const upper = { ...claudeRoutes("2.1.328", 0), [`${CLAUDE}/2.1.328/manifest.json`]: json({ version: "2.1.328", buildDate: new Date(0).toISOString(), platforms: { "linux-arm64": { checksum: SUM.toUpperCase() } } }) };
    const r = await readLatest("claude", fakeDeps(upper));
    expect(r.ok && r.release.sha256).toBe(SUM);
    const bad = { ...claudeRoutes("2.1.328", 0), [`${CLAUDE}/2.1.328/manifest.json`]: json({ version: "2.1.328", buildDate: new Date(0).toISOString(), platforms: { "linux-arm64": { checksum: "not-a-sum" } } }) };
    expect(await readLatest("claude", fakeDeps(bad))).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await readLatest("codex", fakeDeps(codexRoutes("0.170.0", 0, { listed: SUM.toUpperCase() })))).toMatchObject({ ok: true });
    // an empty checksum, a digest of another kind or a bare "sha256:" is published but unreadable
    const empty = { ...claudeRoutes("2.1.328", 0), [`${CLAUDE}/2.1.328/manifest.json`]: json({ version: "2.1.328", buildDate: new Date(0).toISOString(), platforms: { "linux-arm64": { checksum: "" } } }) };
    expect(await readLatest("claude", fakeDeps(empty))).toMatchObject({ ok: false, reason: "mismatch" });
    for (const digest of ["sha512:abc", "sha256:", "", 42 as unknown as string]) {
      const routes = codexRoutes("0.170.0", 0);
      const j = (await (routes[`${TAG_API}/rust-v0.170.0`] as Response).clone().json()) as { assets: Array<{ digest: string }> };
      j.assets[0]!.digest = digest;
      routes[`${TAG_API}/rust-v0.170.0`] = json(j);
      expect(await readLatest("codex", fakeDeps(routes))).toMatchObject({ ok: false, reason: "mismatch" });
    }
  });

  test("SHA256SUMS in binary mode (*name) is read, so its checksum is held to", async () => {
    const routes = codexRoutes("0.170.0", 0, { listed: OTHER });
    routes["https://release-assets.githubusercontent.com/x/sums"] = text(`${OTHER} *codex-package-aarch64-unknown-linux-musl.tar.gz\n`);
    // the asset digest (SUM) and the binary-mode line (OTHER) differ: refused, not read as "no list"
    expect(await readLatest("codex", fakeDeps(routes))).toMatchObject({ ok: false, reason: "mismatch" });
  });

  test("SHA256SUMS with two different lines for the package is refused", async () => {
    const routes = codexRoutes("0.170.0", 0);
    routes["https://release-assets.githubusercontent.com/x/sums"] = text(`${OTHER}  codex-package-aarch64-unknown-linux-musl.tar.gz\n${SUM}  codex-package-aarch64-unknown-linux-musl.tar.gz\n`);
    expect(await readLatest("codex", fakeDeps(routes))).toMatchObject({ ok: false, reason: "mismatch" });
  });

  test("a redirect chain that ends outside the distributor is not-official, even at the hop limit", async () => {
    const hops: Record<string, Route> = {};
    for (let i = 0; i < 5; i++) hops[`${CLAUDE}/hop${i}`] = redirect(i < 4 ? `${CLAUDE}/hop${i + 1}` : "https://evil.example/x"); // the sixth answer, the last one read, points outside
    hops[`${CLAUDE}/latest`] = redirect(`${CLAUDE}/hop0`);
    expect(await readLatest("claude", fakeDeps(hops))).toMatchObject({ ok: false, reason: "not-official" });
  });

  test("a Codex release whose package or bundle is outside the distributor is refused when it is read", async () => {
    const routes = codexRoutes("0.170.0", 0);
    const j = (await (routes[`${TAG_API}/rust-v0.170.0`] as Response).clone().json()) as { assets: Array<{ name: string; browser_download_url: string }> };
    j.assets[0]!.browser_download_url = "https://evil.example/codex.tar.gz";
    routes[`${TAG_API}/rust-v0.170.0`] = json(j);
    expect(await readLatest("codex", fakeDeps(routes))).toMatchObject({ ok: false, reason: "not-official" });
    const bundle = codexRoutes("0.170.0", 0);
    const b = (await (bundle[`${TAG_API}/rust-v0.170.0`] as Response).clone().json()) as { assets: Array<{ name: string; browser_download_url: string }> };
    b.assets[1]!.browser_download_url = "https://evil.example/x.sigstore";
    bundle[`${TAG_API}/rust-v0.170.0`] = json(b);
    expect(await readLatest("codex", fakeDeps(bundle))).toMatchObject({ ok: false, reason: "not-official" });
  });

  test("a release with no signature asset or checksum reads as null, not as an error", async () => {
    const routes = claudeRoutes("2.1.328", 0);
    delete routes[`${CLAUDE}/2.1.328/manifest.json.sig`];
    (routes[`${CLAUDE}/2.1.328/manifest.json`] as Response) = json({ version: "2.1.328", buildDate: new Date(0).toISOString(), platforms: {} });
    const r = await readLatest("claude", fakeDeps(routes));
    expect(r.ok && r.release).toMatchObject({ sha256: null, signature: null });
  });
});

describe("the distributor", () => {
  test("refuses a download from outside the distributor", async () => {
    const routes = codexRoutes("0.170.0", 0);
    routes["https://github.com/openai/codex/releases/latest"] = redirect("https://evil.example/openai/codex/releases/tag/rust-v9.9.9");
    const r = await readLatest("codex", fakeDeps(routes));
    expect(r).toMatchObject({ ok: false, reason: "not-official" });

    // A hop in the middle of a download counts too, and so does a plain-http host.
    const sums = codexRoutes("0.170.0", 0);
    sums["https://release-assets.githubusercontent.com/x/sums"] = redirect("https://evil.example/sums");
    expect(await readLatest("codex", fakeDeps(sums))).toMatchObject({ ok: false, reason: "not-official" });
    expect(isOfficial("http://downloads.claude.ai/x")).toBe(false);
    expect(isOfficial("https://downloads.claude.ai.evil.example/x")).toBe(false);

    // A download is held to the same hosts on every hop.
    const tmp = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "switchboard.cli-source-test."));
    try {
      const hop = { [`${CLAUDE}/2.1.328/linux-arm64/claude`]: redirect("https://evil.example/claude") };
      expect(await download(`${CLAUDE}/2.1.328/linux-arm64/claude`, join(tmp, "f"), fakeDeps(hop))).toMatchObject({ ok: false, reason: "not-official" });
      const fine = { [`${CLAUDE}/2.1.328/linux-arm64/claude`]: text("BIN") };
      expect(await download(`${CLAUDE}/2.1.328/linux-arm64/claude`, join(tmp, "f"), fakeDeps(fine))).toBeNull();
      expect(await Bun.file(join(tmp, "f")).text()).toBe("BIN");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    // verify refuses a file whose URL is outside, before it reads anything.
    const v = await verify("/nonexistent", release({ assetUrl: "https://evil.example/claude" }), { missingSignature: "refuse" }, fakeDeps({}));
    expect(v).toMatchObject({ ok: false, reason: "not-official" });
  });

  test("refuses a checksum that does not match", async () => {
    const wrongFile = await verify("/f", release(), { missingSignature: "allow" }, fakeDeps({}, { sha256Of: async () => OTHER }));
    expect(wrongFile).toMatchObject({ ok: false, reason: "mismatch" });
    // missingSignature: "allow" does not excuse a checksum that is there and differs.

    const twoDisagree = await readLatest("codex", fakeDeps(codexRoutes("0.170.0", 0, { listed: OTHER })));
    expect(twoDisagree).toMatchObject({ ok: false, reason: "mismatch" });
  });

  test("refuses a withdrawn version", async () => {
    const claude = release();
    expect(await withdrawn(claude, fakeDeps(claudeRoutes("2.1.328", 0)))).toEqual({ ok: true });
    expect(await withdrawn(claude, fakeDeps({ [`${CLAUDE}/latest`]: text("2.1.328") }))).toMatchObject({ ok: false, reason: "withdrawn" });
    // Both manifests exist, but the distributor's newest has gone back to the older one.
    const rolledBack = { ...claudeRoutes("2.1.328", 0), [`${CLAUDE}/latest`]: text("2.1.327") };
    expect(await withdrawn(claude, fakeDeps(rolledBack))).toMatchObject({ ok: false, reason: "withdrawn", detail: expect.stringContaining("older") });
    expect(await withdrawn(claude, fakeDeps(claudeRoutes("2.1.327", 0)))).toMatchObject({ ok: false, reason: "withdrawn" });
    expect(await withdrawn(release({ version: "2.1.327" }), fakeDeps(claudeRoutes("2.1.327", 0)))).toEqual({ ok: true });

    const codex = release({ runner: "codex", version: "0.170.0" });
    expect(await withdrawn(codex, fakeDeps(codexRoutes("0.170.0", 0)))).toEqual({ ok: true });
    expect(await withdrawn(codex, fakeDeps(codexRoutes("0.170.0", 0, { draft: true })))).toMatchObject({ ok: false, reason: "withdrawn" });
    const codexBack = { ...codexRoutes("0.170.0", 0), "https://github.com/openai/codex/releases/latest": redirect("https://github.com/openai/codex/releases/tag/rust-v0.169.0") };
    expect(await withdrawn(codex, fakeDeps(codexBack))).toMatchObject({ ok: false, reason: "withdrawn", detail: expect.stringContaining("older") });
    expect(await withdrawn(codex, fakeDeps(codexRoutes("0.169.0", 0)))).toMatchObject({ ok: false, reason: "withdrawn" });
    expect(await withdrawn(codex, fakeDeps({ "https://github.com/openai/codex/releases/latest": redirect("https://github.com/openai/codex/releases/tag/rust-v0.170.0") }))).toMatchObject({ ok: false, reason: "withdrawn" });
  });

  test("only the version name is read to see whether there is anything new", async () => {
    const deps = fakeDeps(codexRoutes("0.170.0", 0));
    expect(await latestVersion("codex", deps)).toBe("0.170.0");
    expect(deps.asked).toEqual(["https://github.com/openai/codex/releases/latest"]);
    const c = fakeDeps(claudeRoutes("2.1.328", 0));
    expect(await latestVersion("claude", c)).toBe("2.1.328");
    expect(c.asked).toEqual([`${CLAUDE}/latest`]);
    // a 5xx that happens to carry a location is an outage, not an answer
    const busy = fakeDeps({ "https://github.com/openai/codex/releases/latest": new Response(null, { status: 503, headers: { location: "https://github.com/openai/codex/releases/tag/rust-v9.9.9" } }) });
    await expect(latestVersion("codex", busy)).rejects.toThrow("503");
  });

  test("a failing distributor is not taken for a withdrawal", async () => {
    const down = fakeDeps({ [`${CLAUDE}/latest`]: text("2.1.328"), [`${CLAUDE}/2.1.328/manifest.json`]: text("busy", 503) });
    await expect(withdrawn(release(), down)).rejects.toThrow("503");
  });

  test("a failing signature or an unreadable date is an error to retry, not an unsigned or never-due version", async () => {
    const sigDown = { ...claudeRoutes("2.1.328", 0), [`${CLAUDE}/2.1.328/manifest.json.sig`]: text("busy", 503) };
    await expect(readLatest("claude", fakeDeps(sigDown))).rejects.toThrow("503");

    const noDate = { ...claudeRoutes("2.1.328", 0), [`${CLAUDE}/2.1.328/manifest.json`]: json({ version: "2.1.328", platforms: {} }) };
    await expect(readLatest("claude", fakeDeps(noDate))).rejects.toThrow("buildDate");
  });
});

describe("waiting", () => {
  test("waits for the hours set", async () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const r = await readLatest("claude", fakeDeps(claudeRoutes("2.1.328", now - HOUR)));
    if (!r.ok) throw new Error("not read");
    expect(isDue(r.release, 0, now)).toBe(true);
    expect(isDue(r.release, 1, now)).toBe(true);
    expect(isDue(r.release, 24, now)).toBe(false);
    expect(isDue(r.release, 24, now + 23 * HOUR)).toBe(true);
  });
});

describe("a downloaded file", () => {
  const refuse = { missingSignature: "refuse" } as const;
  const allow = { missingSignature: "allow" } as const;

  test("a release with no signature is refused as unsigned, and taken when allowed", async () => {
    const bare = release({ signature: null });
    expect(await verify("/f", bare, refuse, fakeDeps({}))).toMatchObject({ ok: false, reason: "unsigned" });
    expect(await verify("/f", bare, allow, fakeDeps({}))).toEqual({ ok: true });
    const noSum = release({ sha256: null, signature: null });
    expect(await verify("/f", noSum, refuse, fakeDeps({}))).toMatchObject({ ok: false, reason: "unsigned" });
    expect(await verify("/f", noSum, allow, fakeDeps({}))).toEqual({ ok: true });
  });

  /** A gpg that behaves like the real one for a key and a manifest signature, driven by what the test says. */
  function gpgThat(keyFpr: string, validSigFpr: string | null): CliSourceDeps["gpg"] {
    return async (args): Promise<CmdResult> => {
      if (args.includes("--show-keys")) return { code: 0, stdout: `pub:-:255:22:AAAA:1::::::scESC:::::::\nfpr:::::::::${keyFpr}:\nsub:-:255:18:BBBB:::::::e:\nfpr:::::::::${"C".repeat(40)}:\n`, stderr: "" };
      if (args.includes("--import")) return { code: 0, stdout: "", stderr: "" };
      return validSigFpr
        ? { code: 0, stdout: `[GNUPG:] GOODSIG X\n[GNUPG:] VALIDSIG ${"D".repeat(40)} 2026-11-18 1 0 4 0 22 8 00 ${validSigFpr}\n`, stderr: "" }
        : { code: 1, stdout: "[GNUPG:] BADSIG X\n", stderr: "bad" };
    };
  }
  const claudeFiles = (): Record<string, Route> => ({
    "https://downloads.claude.ai/keys/claude-code.asc": text("KEY"),
    [`${CLAUDE}/2.1.328/manifest.json`]: json({ version: "2.1.328", platforms: { "linux-arm64": { checksum: SUM }, "linux-x64": { checksum: OTHER } } }),
    [`${CLAUDE}/2.1.328/manifest.json.sig`]: text("sig"),
  });

  test("the Claude manifest signature must come from the key Anthropic's documentation names", async () => {
    const ok = await verify("/f", release(), refuse, fakeDeps(claudeFiles(), { gpg: gpgThat(CLAUDE_RELEASE_KEY_FINGERPRINT, CLAUDE_RELEASE_KEY_FINGERPRINT) }));
    expect(ok).toEqual({ ok: true });

    // A key with another fingerprint is refused before it is imported, even if it would sign the manifest.
    const imported: string[][] = [];
    const stranger = gpgThat("E".repeat(40), "E".repeat(40));
    const strangerKey = await verify("/f", release(), refuse, fakeDeps(claudeFiles(), { gpg: async (a) => (imported.push(a), stranger(a)) }));
    expect(strangerKey).toMatchObject({ ok: false, reason: "mismatch" });
    expect(imported.some((a) => a.includes("--import"))).toBe(false);

    const badSignature = await verify("/f", release(), refuse, fakeDeps(claudeFiles(), { gpg: gpgThat(CLAUDE_RELEASE_KEY_FINGERPRINT, null) }));
    expect(badSignature).toMatchObject({ ok: false, reason: "mismatch" });

    // OTHER is listed in the signed manifest, but for linux-x64, not for this arm64 host.
    const good = { gpg: gpgThat(CLAUDE_RELEASE_KEY_FINGERPRINT, CLAUDE_RELEASE_KEY_FINGERPRINT) };
    const otherFile = release({ sha256: OTHER });
    const otherPlatform = await verify("/f", otherFile, refuse, fakeDeps(claudeFiles(), { ...good, sha256Of: async () => OTHER }));
    expect(otherPlatform).toMatchObject({ ok: false, reason: "mismatch" });

    // A signed manifest of another version is not this version's.
    const older = { ...claudeFiles(), [`${CLAUDE}/2.1.328/manifest.json`]: json({ version: "2.1.327", platforms: { "linux-arm64": { checksum: SUM } } }) };
    expect(await verify("/f", release(), refuse, fakeDeps(older, good))).toMatchObject({ ok: false, reason: "mismatch" });

    // No checksum read before but the signed manifest has one: "allow" still holds the file to it; "refuse" stops at the missing checksum.
    const noSum = release({ sha256: null });
    expect(await verify("/f", noSum, allow, fakeDeps(claudeFiles(), good))).toEqual({ ok: true });
    expect(await verify("/f", noSum, allow, fakeDeps(claudeFiles(), { ...good, sha256Of: async () => OTHER }))).toMatchObject({ ok: false, reason: "mismatch" });
    const unlisted = { ...claudeFiles(), [`${CLAUDE}/2.1.328/manifest.json`]: json({ version: "2.1.328", platforms: {} }) };
    expect(await verify("/f", noSum, allow, fakeDeps(unlisted, { ...good, sha256Of: async () => OTHER }))).toEqual({ ok: true });
    expect(await verify("/f", noSum, refuse, fakeDeps(claudeFiles(), good))).toMatchObject({ ok: false, reason: "unsigned" });
  });

  test("the Codex bundle is checked by cosign against the release workflow of the version's tag", async () => {
    const calls: string[][] = [];
    const bundle = "https://github.com/openai/codex/releases/download/rust-v0.170.0/x.tar.gz.sigstore";
    const rel = (version: string) =>
      release({ runner: "codex", version, assetUrl: `https://github.com/openai/codex/releases/download/rust-v${version}/x.tar.gz`, signature: { kind: "sigstore", url: bundle } });
    /** A cosign that, like the real one, passes only when the certificate in the bundle (signed for 0.170.0) is the one asked for. */
    const cosign = async (args: string[]): Promise<CmdResult> => {
      calls.push(args);
      const at = (flag: string) => args[args.indexOf(flag) + 1];
      const signedFor = "https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.170.0";
      const ok = args[0] === "verify-blob" && at("--certificate-identity") === signedFor && at("--certificate-oidc-issuer") === "https://token.actions.githubusercontent.com";
      return { code: ok ? 0 : 1, stdout: "", stderr: ok ? "Verified OK" : "none of the expected identities matched" };
    };
    expect(await verify("/f", rel("0.170.0"), refuse, fakeDeps({ [bundle]: text("{}") }, { cosign }))).toEqual({ ok: true });
    expect(calls[0]?.at(-1)).toBe("/f");
    expect(codexSigner("0.170.0")).toBe("https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.170.0");
    // the same bundle offered for another version: the certificate names 0.170.0's tag, so it is not that version's signature
    expect(await verify("/f", rel("0.171.0"), refuse, fakeDeps({ [bundle]: text("{}") }, { cosign }))).toMatchObject({ ok: false, reason: "mismatch" });

    // cosign missing on this host, or sigstore's trusted root out of reach: an error to try again, not a refusal of the release
    const fails = (code: number, stderr: string) => fakeDeps({ [bundle]: text("{}") }, { cosign: async () => ({ code, stdout: "", stderr }) });
    await expect(verify("/f", rel("0.170.0"), refuse, fails(127, "cosign is not here"))).rejects.toThrow("cosign could not check");
    await expect(verify("/f", rel("0.170.0"), refuse, fails(1, "error: updating local metadata and targets: tuf: failed to download"))).rejects.toThrow("cosign could not check");
  });

  test("a real file is hashed by the default sha256", async () => {
    const { realCliSourceDeps } = await import("./cli-update-source.ts");
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "switchboard.cli-source-test."));
    try {
      await writeFile(join(dir, "f"), "abc");
      expect(await (await realCliSourceDeps()).sha256Of(join(dir, "f"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
