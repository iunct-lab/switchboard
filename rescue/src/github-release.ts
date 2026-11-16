/**
 * Fetch a release of the public repository without git: the latest tag from GitHub Releases, then that tag's source
 * tarball, checked and unpacked. Each check is a way a wrong or damaged tree would otherwise reach `bun install`:
 * a redirect to another repository, a download cut short, a path that climbs out of the target, a tree that is not the
 * commit the tag points at. A failure throws and leaves nothing behind.
 *
 * The tree is matched to the tag by commit, not by `package.json`: the public copy numbers its tags on its own
 * (`publicSync.versioning` is `independent`) and `package.json` keeps the same version across them.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./releases.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TAG = /^v\d+\.\d+\.\d+$/;
const SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const apiBase = () => (process.env.SWITCHBOARD_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
const maxBytes = () => Number(process.env.SWITCHBOARD_MAX_TARBALL_BYTES) || DEFAULT_MAX_BYTES;

export function checkSource(source: string): void {
  if (!SOURCE.test(source)) throw new Error(`not an owner/name: ${source}`);
}

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers: { accept: "application/vnd.github+json", "user-agent": "switchboard-rescue" } });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** The full sha of the commit `tag` (a version tag) of `source` (`owner/name`) points at. */
export async function shaOfTag(source: string, tag: string, fetchImpl: Fetch = fetch): Promise<string> {
  checkSource(source);
  if (!TAG.test(tag)) throw new Error(`not a version tag: ${tag}`);
  const sha = (await getJson(`${apiBase()}/repos/${source}/commits/${tag}`, fetchImpl)).sha;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error(`commit of ${source} ${tag} has no full sha`);
  return sha;
}

/** The newest tagged release of `source` (`owner/name`) and the commit the tag points at. */
export async function latestRelease(source: string, fetchImpl: Fetch = fetch): Promise<{ tag: string; sha: string }> {
  checkSource(source);
  const tag = (await getJson(`${apiBase()}/repos/${source}/releases/latest`, fetchImpl)).tag_name;
  if (typeof tag !== "string" || !TAG.test(tag)) throw new Error(`latest release of ${source} is not a version tag: ${String(tag)}`);
  return { tag, sha: await shaOfTag(source, tag, fetchImpl) };
}

/** Where a tarball redirect may go: GitHub's codeload over https, or the overridden API's own origin (a test server). */
function allowedOrigins(): Set<string> {
  const origins = new Set(["https://codeload.github.com"]);
  if (process.env.SWITCHBOARD_GITHUB_API) origins.add(new URL(apiBase()).origin);
  return origins;
}

/** Read a body into `file`, counting bytes; stops as soon as the limit is passed. Returns the byte count. */
async function saveBody(res: Response, file: string, limit: number): Promise<number> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!res.body) throw new Error("tarball response has no body");
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw new Error(`tarball is larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  writeFileSync(file, Buffer.concat(chunks));
  return total;
}

/**
 * Download the source tarball of `source` at `tag` into `destDir` and return its path. The API answers with a redirect;
 * only a redirect to codeload under `/<owner>/<name>/` is followed.
 */
export async function fetchTarball(source: string, tag: string, destDir: string, fetchImpl: Fetch = fetch): Promise<string> {
  checkSource(source);
  if (!TAG.test(tag)) throw new Error(`not a version tag: ${tag}`);
  const file = join(destDir, `${tag}.tar.gz`);
  // Fetched once per tag: a file under this name passed every check below when it was renamed into place.
  if (existsSync(file)) return file;
  const origins = allowedOrigins();
  const limit = maxBytes();
  let url = `${apiBase()}/repos/${source}/tarball/${tag}`;
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    res = await fetchImpl(url, { redirect: "manual", headers: { "user-agent": "switchboard-rescue" } });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    if (!location || hop >= MAX_REDIRECTS) throw new Error(`tarball of ${source} ${tag}: too many redirects or none to follow`);
    const next = new URL(location, url);
    if (!origins.has(next.origin) || !next.pathname.startsWith(`/${source}/`)) {
      throw new Error(`tarball of ${source} ${tag} redirects to a different repository: ${next.host}${next.pathname}`);
    }
    url = next.toString();
  }
  if (!res.ok) throw new Error(`tarball of ${source} ${tag} returned ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (declared > limit) throw new Error(`tarball is larger than ${limit} bytes`);
  const part = join(destDir, `.${tag}.tar.gz.part`);
  mkdirSync(destDir, { recursive: true });
  try {
    const got = await saveBody(res, part, limit);
    if (Number.isFinite(declared) && got !== declared) throw new Error(`tarball cut short: ${got} of ${declared} bytes`);
    await run(["tar", "-tzf", part], destDir);
    renameSync(part, file);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  return file;
}

/**
 * Names sb-rescue makes inside a release (installed packages, the built web bundle, the file naming the release). A
 * tree that brings one would put files in places the review's diff leaves out, so such a tarball is refused.
 */
export const RELEASE_MADE = ["node_modules", "dist", ".release.json"];

/** Paths that leave the extraction directory: absolute, or with a `..` part. */
const escapes = (member: string) => member.startsWith("/") || member.split("/").includes("..");

/**
 * Unpack `tarball` into `dest` (the top directory stripped), which must not exist yet. The members are listed first:
 * any escaping path, or any member outside the one top directory GitHub names `<owner>-<name>-<short sha>` with the
 * sha `expect.tag` resolved to, refuses the whole file (a tree of another commit is not this release). So do a link
 * (the repository has none; a link could point a later read or write outside the tree) and a name in RELEASE_MADE.
 * `dest` is removed on a failure.
 */
export async function extractTarball(tarball: string, dest: string, expect: { tag: string; sha: string }): Promise<void> {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  const members = (await run(["tar", "-tzf", tarball], process.cwd())).split("\n").filter(Boolean);
  const bad = members.find(escapes);
  if (bad !== undefined) throw new Error(`tarball has a path outside the target: ${bad}`);
  const top = members[0]?.split("/")[0] ?? "";
  const short = /-([0-9a-f]{7,40})$/.exec(top)?.[1];
  if (!short || !expect.sha.startsWith(short)) throw new Error(`tarball of ${expect.tag} is not the tree of ${expect.sha}`);
  const stray = members.find((m) => m !== top && !m.startsWith(`${top}/`));
  if (stray !== undefined) throw new Error(`tarball of ${expect.tag} has a member outside ${top}: ${stray}`);
  const made = members.find((m) => m.split("/").slice(1).some((part) => RELEASE_MADE.includes(part)));
  if (made !== undefined) throw new Error(`tarball of ${expect.tag} has ${made}, a name sb-rescue makes in a release`);
  // `tar -tv` starts each line with the member's type: l = symbolic link, h = hard link.
  const link = (await run(["tar", "-tvzf", tarball], process.cwd())).split("\n").find((line) => line[0] === "l" || line[0] === "h");
  if (link !== undefined) throw new Error(`tarball of ${expect.tag} has a link: ${link.split(/\s+/).slice(5).join(" ")}`);
  mkdirSync(dest, { recursive: true });
  try {
    await run(["tar", "-xzf", tarball, "--strip-components=1", "-C", dest], dest);
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/** Paths in diff's own lines (headers, "Only in", "Files … differ") as a/… and b/…, so no host path reaches the review. */
function relative(out: string, fromDir: string, toDir: string): string {
  return out
    .split("\n")
    .map((line) => {
      const body = line.startsWith("--- ") || line.startsWith("+++ ") ? false : /^[ +\-\\]/.test(line);
      return body ? line : line.replaceAll(`${fromDir}/`, "a/").replaceAll(`${toDir}/`, "b/").replaceAll(fromDir, "a").replaceAll(toDir, "b");
    })
    .join("\n");
}

async function diffOut(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { env: process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code > 1) throw new Error(`${argv.join(" ")} exited ${code}: ${(err || out).trim().slice(-2000)}`); // 1 = the trees differ
  return out;
}

/**
 * Write the unified diff of two unpacked trees to `outFile` (new files included) and return the list of changed paths,
 * one `diff -rq` line each, with the trees named a/ and b/. The names in RELEASE_MADE are left out: the running release
 * has them from its build, and `extractTarball` refuses a new tree that brings one, so leaving them out hides nothing.
 * Links are compared as links, never followed. The external `diff` does the work; if it is missing or fails this throws.
 */
export async function diffTrees(fromDir: string, toDir: string, outFile: string): Promise<string[]> {
  const args = ["--no-dereference", ...RELEASE_MADE.flatMap((n) => ["-x", n]), fromDir, toDir];
  const patch = await diffOut(["diff", "-ruN", ...args]);
  const stat = await diffOut(["diff", "-rqN", ...args]);
  writeFileSync(outFile, relative(patch, fromDir, toDir));
  return relative(stat, fromDir, toDir).split("\n").filter(Boolean);
}
