/**
 * What changes in the three files that pin the host's tools when a pin goes to a new version: where each file of a
 * tool is downloaded, whether its sha256 agrees with what the distributor publishes, the new text of the files and the
 * body of the pull request. Pure: nothing is written (the caller does that) and what is downloaded is hashed as a
 * stream, never stored on disk or in /tmp (RAM).
 */
import { createHash } from "node:crypto";

export type PinFileName = "devtools" | "node" | "dockerfile";

/** How a file's sha256 is published: `.sha256` beside the file; a list of `<sha256>  <file name>` lines (checksums.txt, SHASUMS256.txt); GitHub's own `digest` of the release asset. */
export type Published = "sha256-file" | { list: (v: string) => string } | "node-shasums" | "github-digest";

export interface PinFile {
  /** the line `NAME=<sha256>` (`ARG NAME=…` in the Dockerfile) that holds this file's sha256 */
  shaVar: string;
  file: PinFileName;
  /** `v` is the plain version, without a `v` prefix */
  url: (v: string) => string;
  published: Published;
  /** the distributor may publish no checksum (a 404 is then "公表なし", not a failure) */
  optional?: true;
}

const GH = "https://github.com";
const DOCKER = (cpu: string) => `https://download.docker.com/linux/static/stable/${cpu}`;
const nodeUrl = (cpu: string) => (v: string) => `https://nodejs.org/dist/v${v}/node-v${v}-linux-${cpu}.tar.xz`;
const composeUrl = (cpu: string) => (v: string) => `${GH}/docker/compose/releases/download/v${v}/docker-compose-linux-${cpu}`;
const uvUrl = (cpu: string) => (v: string) => `${GH}/astral-sh/uv/releases/download/${v}/uv-${cpu}-unknown-linux-gnu.tar.gz`;
const gitleaksUrl = (cpu: string) => (v: string) => `${GH}/gitleaks/gitleaks/releases/download/v${v}/gitleaks_${v}_linux_${cpu}.tar.gz`;
const gitleaksList = { list: (v: string) => `${GH}/gitleaks/gitleaks/releases/download/v${v}/gitleaks_${v}_checksums.txt` };
const ghStackUrl = (cpu: string) => (v: string) => `${GH}/github/gh-stack/releases/download/v${v}/linux-${cpu}`;

/**
 * Each `*_VERSION` this script moves, with the files whose sha256 move with it. The one place where the tools differ.
 * A `*_VERSION` that is not here is not raised automatically.
 */
export const PIN_FILES: Record<string, PinFile[]> = {
  NODE_VERSION: [
    { shaVar: "NODE_SHA256", file: "node", url: nodeUrl("arm64"), published: "node-shasums" },
    { shaVar: "NODE_SHA256", file: "dockerfile", url: nodeUrl("arm64"), published: "node-shasums" },
    { shaVar: "NODE_SHA256_X86_64", file: "dockerfile", url: nodeUrl("x64"), published: "node-shasums" },
  ],
  DOCKER_VERSION: [
    { shaVar: "DOCKER_SHA256", file: "devtools", url: (v) => `${DOCKER("aarch64")}/docker-${v}.tgz`, published: "sha256-file", optional: true },
    { shaVar: "DOCKER_ROOTLESS_SHA256", file: "devtools", url: (v) => `${DOCKER("aarch64")}/docker-rootless-extras-${v}.tgz`, published: "sha256-file", optional: true },
    { shaVar: "DOCKER_SHA256", file: "dockerfile", url: (v) => `${DOCKER("aarch64")}/docker-${v}.tgz`, published: "sha256-file", optional: true },
    { shaVar: "DOCKER_SHA256_X86_64", file: "dockerfile", url: (v) => `${DOCKER("x86_64")}/docker-${v}.tgz`, published: "sha256-file", optional: true },
  ],
  COMPOSE_VERSION: [
    { shaVar: "COMPOSE_SHA256", file: "devtools", url: composeUrl("aarch64"), published: "sha256-file" },
    { shaVar: "COMPOSE_SHA256", file: "dockerfile", url: composeUrl("aarch64"), published: "sha256-file" },
    { shaVar: "COMPOSE_SHA256_X86_64", file: "dockerfile", url: composeUrl("x86_64"), published: "sha256-file" },
  ],
  UV_VERSION: [
    { shaVar: "UV_SHA256", file: "devtools", url: uvUrl("aarch64"), published: "sha256-file" },
    { shaVar: "UV_SHA256", file: "dockerfile", url: uvUrl("aarch64"), published: "sha256-file" },
    { shaVar: "UV_SHA256_X86_64", file: "dockerfile", url: uvUrl("x86_64"), published: "sha256-file" },
  ],
  GITLEAKS_VERSION: [
    { shaVar: "GITLEAKS_SHA256", file: "devtools", url: gitleaksUrl("arm64"), published: gitleaksList },
    { shaVar: "GITLEAKS_SHA256", file: "dockerfile", url: gitleaksUrl("arm64"), published: gitleaksList },
    { shaVar: "GITLEAKS_SHA256_X86_64", file: "dockerfile", url: gitleaksUrl("x64"), published: gitleaksList },
  ],
  SAM_VERSION: [
    { shaVar: "SAM_SHA256", file: "devtools", url: (v) => `${GH}/aws/aws-sam-cli/releases/download/v${v}/aws-sam-cli-linux-arm64.zip`, published: "github-digest" },
  ],
  GH_STACK_VERSION: [
    { shaVar: "GH_STACK_SHA256", file: "dockerfile", url: ghStackUrl("arm64"), published: "github-digest" },
    { shaVar: "GH_STACK_SHA256_X86_64", file: "dockerfile", url: ghStackUrl("amd64"), published: "github-digest" },
  ],
  // only a version is pinned: npx checks npm's integrity
  PLAYWRIGHT_VERSION: [],
  PLAYWRIGHT_MCP_VERSION: [],
};

/** The files that hold each tool's `*_VERSION` line (`NAME=` in the host's scripts, `ARG NAME=` in the Dockerfile); each must keep it. */
export const VERSION_FILES: Record<string, PinFileName[]> = {
  NODE_VERSION: ["node", "dockerfile"],
  DOCKER_VERSION: ["devtools", "dockerfile"],
  COMPOSE_VERSION: ["devtools", "dockerfile"],
  UV_VERSION: ["devtools", "dockerfile"],
  GITLEAKS_VERSION: ["devtools", "dockerfile"],
  SAM_VERSION: ["devtools"],
  GH_STACK_VERSION: ["devtools", "dockerfile"],
  PLAYWRIGHT_VERSION: ["devtools", "dockerfile"],
  PLAYWRIGHT_MCP_VERSION: ["devtools"],
};

/** A version is written into shell scripts and a Dockerfile, so only `<major>.<minor>.<patch>` is taken (the form every pinned tool uses and the host's tests read). */
const VERSION = /^\d+\.\d+\.\d+$/;

export type How = "公表値と一致" | "GitHub の digest と一致" | "公表なし" | "版だけ（npm）";

/** `unpublished`: the URLs of the files the distributor published no checksum for (their sha256 is the download's own) */
export type Verified = { ok: true; shas: Record<string, string>; how: How; unpublished: string[] } | { ok: false; why: string };

const SHA = /^[0-9a-f]{64}$/;

async function sha256Of(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return hash.digest("hex");
    hash.update(value);
  }
}

const baseName = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** The distributor's value for `url`; null when it publishes none. Throws when it cannot be read (the caller says "cannot tell"). */
async function publishedSha(f: PinFile, v: string, url: string, fetchText: (url: string) => Promise<string>): Promise<string | null> {
  const p = f.published;
  const ofList = (text: string, listUrl: string): string => {
    const found = new Set<string>();
    for (const line of text.split("\n")) {
      const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
      if (m && m[2] === baseName(url)) found.add(m[1]!.toLowerCase());
    }
    if (found.size > 1) throw new Error(`${listUrl} に ${baseName(url)} の違う行が 2 つ以上ある`);
    const [sha] = found;
    if (!sha) throw new Error(`${listUrl} に ${baseName(url)} の行が無い`);
    return sha;
  };
  if (p === "github-digest") {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url);
    if (!m) throw new Error(`GitHub の asset の URL ではない: ${url}`);
    const api = `https://api.github.com/repos/${m[1]}/releases/tags/${m[2]}`;
    const { assets } = JSON.parse(await fetchText(api)) as { assets?: { name?: unknown; digest?: unknown }[] };
    const asset = Array.isArray(assets) ? assets.find((a) => a.name === m[3]) : undefined;
    const digest = typeof asset?.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined;
    if (!digest) throw new Error(`${api} に ${m[3]} の sha256 の digest が無い`);
    return digest;
  }
  try {
    if (p === "sha256-file") {
      const text = await fetchText(`${url}.sha256`);
      const m = /^([0-9a-fA-F]{64})(?:\s|$)/.exec(text.trim());
      if (!m) throw new Error(`${url}.sha256 が読めない`);
      return m[1]!.toLowerCase();
    }
    const listUrl = p === "node-shasums" ? `https://nodejs.org/dist/v${v}/SHASUMS256.txt` : p.list(v);
    return ofList(await fetchText(listUrl), listUrl);
  } catch (e) {
    // only "the distributor has no such file" is "not published"; any other failure is "cannot tell".
    // The message's shape is `hostFetch`'s (`<host> answered <status>`), so only its end is read.
    if (f.optional && / answered 404$/.test((e as Error).message)) return null;
    throw e;
  }
}

/**
 * Downloads each file of `name` at `version` as a stream, takes its sha256 and checks it against what the distributor
 * publishes. A different value is `ok: false` naming the tool and the file. Throws when a distributor cannot be read.
 */
export async function verifyFiles(
  name: string,
  version: string,
  fetchBytes: (url: string) => Promise<ReadableStream<Uint8Array>>,
  fetchText: (url: string) => Promise<string>,
): Promise<Verified> {
  const files = PIN_FILES[name];
  if (!files) return { ok: false, why: `${name}: 自動で上げる道具の表に無い` };
  if (files.length === 0) return { ok: true, shas: {}, how: "版だけ（npm）", unpublished: [] };
  // one download per URL (the host and the image pin the same arm64 file)
  const urls = [...new Set(files.map((f) => f.url(version)))];
  const computed = new Map(await Promise.all(urls.map(async (u) => [u, await sha256Of(await fetchBytes(u))] as const)));
  // one read per checksum URL (SHASUMS256.txt and a GitHub release serve several files; unauthenticated API reads are few)
  const texts = new Map<string, Promise<string>>();
  const readOnce = (u: string): Promise<string> => texts.get(u) ?? (texts.set(u, fetchText(u)), texts.get(u)!);
  const shas: Record<string, string> = {};
  const hows = new Set<How>();
  const unpublished = new Set<string>();
  for (const f of files) {
    const url = f.url(version);
    const sha = computed.get(url)!;
    const want = await publishedSha(f, version, url, readOnce);
    if (want === null) {
      hows.add("公表なし");
      unpublished.add(url);
    }
    else if (want !== sha) return { ok: false, why: `${name} の ${baseName(url)}（${f.file} の ${f.shaVar}）: 取ってきた物の sha256 ${sha} が公表値 ${want} と違う（${url}）` };
    else hows.add(f.published === "github-digest" ? "GitHub の digest と一致" : "公表値と一致");
    shas[f.shaVar] = sha;
  }
  const how: How = hows.has("公表なし") ? "公表なし" : hows.has("GitHub の digest と一致") ? "GitHub の digest と一致" : "公表値と一致";
  return { ok: true, shas, how, unpublished: [...unpublished] };
}

export type Texts = Record<PinFileName, string>;

const lineOf = (name: string) => new RegExp(`^((?:ARG )?${name}=)(\\S+)$`, "m");

/**
 * The files' new text. Only the `NAME=value` and `ARG NAME=value` lines of the bumped versions and their sha256 are
 * replaced; a `v` prefix on the version stays as the line had it. Throws when a line to replace is not there, or when the
 * version is not `<major>.<minor>.<patch>`.
 */
export function rewrite(texts: Texts, bumps: { name: string; version: string; shas: Record<string, string> }[]): Texts {
  const out: Texts = { ...texts };
  const set = (file: PinFileName, name: string, value: (old: string) => string): void => {
    const re = lineOf(name);
    if (!re.test(out[file])) throw new Error(`${file} に ${name}= の行が無い`);
    out[file] = out[file].replace(re, (_m, head: string, old: string) => `${head}${value(old)}`);
  };
  for (const b of bumps) {
    const files = PIN_FILES[b.name];
    if (!files) throw new Error(`${b.name}: 自動で上げる道具の表に無い`);
    if (!VERSION.test(b.version)) throw new Error(`${b.name}: 版の形が <major>.<minor>.<patch> ではない: ${JSON.stringify(b.version)}`);
    const versionFiles = VERSION_FILES[b.name];
    if (!versionFiles) throw new Error(`${b.name}: 版の行のファイルの表に無い`);
    for (const file of versionFiles) set(file, b.name, (old) => (old.startsWith("v") ? "v" : "") + b.version);
    for (const f of files) {
      const sha = b.shas[f.shaVar];
      if (!sha || !SHA.test(sha)) throw new Error(`${b.name}: ${f.shaVar} の sha256 が無い`);
      set(f.file, f.shaVar, () => sha);
    }
    // the x86-64 file is another file than the arm64 one (container/versions.test.ts checks the same)
    for (const [v, sha] of Object.entries(b.shas))
      if (v.endsWith("_X86_64") && b.shas[v.slice(0, -"_X86_64".length)] === sha) throw new Error(`${b.name}: ${v} が arm64 の sha256 と同じ`);
  }
  return out;
}

export interface BodyRow {
  name: string;
  from: string;
  to: string;
  /** the new version's publish date */
  published: string;
  urls: string[];
  how: How;
  /** the URLs of the files checked against nothing (`Verified.unpublished`); `how` is "公表なし" exactly when this is not empty */
  unpublished: string[];
}

/** The pull request's body: per tool the old → new version, the new one's publish date and age, where it was taken from and how the checksum was checked. */
export function prBody(rows: BodyRow[], opts: { minAgeDays: number; securityMinAgeDays: number; now: Date }): string {
  const age = (published: string) => {
    const at = Date.parse(published);
    if (!Number.isFinite(at)) throw new Error(`公開日が読めない: ${published}`);
    return Math.floor((opts.now.getTime() - at) / 86_400_000);
  };
  const lines = [
    "固定版の道具を、公開から寝かせる期間を過ぎた版へ上げる（`scripts/bump-host-pins.ts` が作った PR）。",
    "",
    `寝かせる期間: 公開から ${opts.minAgeDays} 日（セキュリティ修正の版は ${opts.securityMinAgeDays} 日）を過ぎた版だけを選んでいる。`,
    "",
    "| 道具 | 旧版 → 新版 | 新版の公開日（経過日数） | 取得元 | checksum の確かめ方 |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.name.replace(/_VERSION$/, "")} | ${r.from} → ${r.to} | ${r.published.slice(0, 10)}（${age(r.published)} 日） | ${r.urls.join("<br>")} | ${r.how} |`),
  ];
  for (const r of rows) {
    if ((r.how === "公表なし") !== r.unpublished.length > 0) throw new Error(`${r.name}: 公表なしと、公表値の無い物の一覧が合わない`);
    if (r.how === "公表なし") {
      // the files are named by URL (the CPUs' archives share a file name); nothing is said about the files that were checked
      const which = `: ${r.unpublished.join("、")}`;
      lines.push("", `- ${r.name.replace(/_VERSION$/, "")}: 次の物は配布元が checksum を公表していないので、取ってきた物が正しいかを確かめられない（sha256 は取ってきた物から算出した値）${which}`);
    }
    if (r.how === "GitHub の digest と一致") lines.push("", `- ${r.name.replace(/_VERSION$/, "")}: 照らした相手は GitHub が受け取った物の digest で、配布元の改ざんは見分けられない。`);
  }
  return `${lines.join("\n")}\n`;
}
