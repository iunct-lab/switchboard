/**
 * Immutable releases. A release is one commit of the Switchboard repository, exported and built once under
 * `<home>/releases/<sha>/`; `current` and `previous` are relative symlinks next to them. Nothing writes into a
 * release after it is built, so an agent editing the working tree cannot change the daemon that is running.
 * The history is a JSONL file, not a database row: it must be readable while Switchboard itself is down.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HistoryAction = "install" | "promote" | "rejected" | "auto-rollback" | "rollback" | "restart" | "restore-db" | "rebuild" | "promote-web";
export interface HistoryEntry {
  ts: number;
  action: HistoryAction;
  from: string | null;
  to: string | null;
  ok: boolean;
  reason: string;
}

export const releasesDir = (home: string) => join(home, "releases");

/**
 * Run a command to completion; a non-zero exit throws with the end of its output (that text is the "reason" users see).
 * The environment is passed as it is now: without it Bun starts the child (and looks the command up) with the one the
 * process started with, and a PATH set since (a test without git) would not reach it.
 */
export async function run(argv: string[], cwd: string, raw = false): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}: ${(err || out).trim().slice(-2000)}`);
  return raw ? out : out.trim();
}

export const resolveCommit = (repo: string, rev: string) => run(["git", "-C", repo, "rev-parse", "--verify", `${rev}^{commit}`], repo);

/**
 * What a daemon reads again on SIGHUP without restarting: the Web UI it serves and the default settings it ships with.
 * A file that differs under these needs no restart, whatever else the daemon reads.
 */
export const NO_RESTART_PREFIXES = ["apps/web/", "packages/core/config/"];

/** What a daemon reads from the release it started from (paths relative to the release root; `dirs` end with `/`). */
export interface DaemonReads {
  files: Set<string>;
  dirs: string[];
}

/**
 * Ask the release at `releaseDir` what its daemon reads from it, by running that release's own
 * `packages/core/src/daemon-reads.ts` (not a copy in sb-rescue: this bundle stays as it was installed, and the release
 * knows its own code). Null when that cannot be known: the release has no such command (an older one), it fails,
 * it does not answer within `timeoutMs` (it is killed), its output is not the expected JSON, or it says it is not complete.
 */
export async function daemonReadsOf(releaseDir: string, timeoutMs: number): Promise<DaemonReads | null> {
  const cli = join(releaseDir, "packages/core/src/daemon-reads.ts");
  if (!existsSync(cli)) return null;
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // sb-rescue's own secret for 作り直す: like the daemon and the candidate, the release's code does not get it
    delete env.SWITCHBOARD_STARTER_TOKEN;
    const proc = Bun.spawn([process.execPath, cli], { cwd: releaseDir, env, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const answer = Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const done = await Promise.race([answer, Bun.sleep(timeoutMs).then(() => null)]);
    if (!done) {
      proc.kill();
      return null;
    }
    const [out, code] = done;
    if (code !== 0) return null;
    const r = JSON.parse(out) as { complete?: unknown; files?: unknown; dirs?: unknown };
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (r?.complete !== true || !strings(r.files) || !strings(r.dirs)) return null;
    return { files: new Set(r.files), dirs: r.dirs };
  } catch {
    return null;
  }
}

/**
 * The rule of `restartNeeded` on the files that differ: a restart unless every one lies under NO_RESTART_PREFIXES or,
 * with `reads`, is a file the daemon does not read. No files (nothing differs) is a restart as well.
 */
export function restartNeededFor(files: string[], reads: DaemonReads | null): boolean {
  return files.length === 0 || restartFilesOf(files, reads).length > 0;
}

/** The files that differ which need the restart: not under NO_RESTART_PREFIXES, and (with `reads`) read by the daemon. */
export function restartFilesOf(files: string[], reads: DaemonReads | null): string[] {
  const notRead = (f: string) => reads !== null && !reads.files.has(f) && !reads.dirs.some((d) => f.startsWith(d));
  return files.filter((f) => !(NO_RESTART_PREFIXES.some((p) => f.startsWith(p)) || notRead(f)));
}

/**
 * Does switching the running daemon (started from `running`) to `sha` need a restart? False only when every file that
 * differs lies under NO_RESTART_PREFIXES or, with `reads` (what the daemon reads from `running`), is a file it does not
 * read. Without `reads` (it could not be known) only NO_RESTART_PREFIXES count. True when there is nothing to compare
 * with (`running` is null, git fails, the commit is not in `repo`) or nothing differs: the safe answer is the restart
 * that always worked. `files` are the ones that need it (all of them; empty when there was nothing to compare).
 */
export async function restartNeeded(repo: string, running: string | null, sha: string, reads: DaemonReads | null): Promise<{ restart: boolean; files: string[] }> {
  if (!running) return { restart: true, files: [] };
  try {
    // -z: the paths as they are (git quotes a name with non-ASCII or special characters otherwise, and a quoted name matches nothing read)
    const diff = (await run(["git", "-C", repo, "diff", "--name-only", "-z", "--no-renames", running, sha], repo, true)).split("\0").filter(Boolean);
    const files = restartFilesOf(diff, reads);
    return { restart: diff.length === 0 || files.length > 0, files };
  } catch {
    return { restart: true, files: [] };
  }
}

/**
 * Build an exported tree (`treeDir`, a directory under the releases directory) and rename it to `<home>/releases/<sha>`.
 * The tree is built in place, so a half-built release never has a final name; on failure the tree is removed.
 * `meta` (the tag and commit a tarball came from) is written to `.release.json` before the rename.
 */
export async function buildFromTree(treeDir: string, sha: string, home: string, meta?: { tag: string; sha: string }): Promise<string> {
  try {
    await run([process.execPath, "install", "--frozen-lockfile"], treeDir);
    if (existsSync(join(treeDir, "apps", "web", "package.json"))) await run([process.execPath, "run", "--cwd", "apps/web", "build"], treeDir);
    if (meta) writeFileSync(join(treeDir, ".release.json"), JSON.stringify(meta) + "\n");
    renameSync(treeDir, join(releasesDir(home), sha));
  } catch (e) {
    rmSync(treeDir, { recursive: true, force: true });
    throw e;
  }
  return sha;
}

/** Export `rev` from `repo` and build it. */
export async function buildRelease(repo: string, rev: string, home: string): Promise<string> {
  const sha = await resolveCommit(repo, rev);
  if (existsSync(join(releasesDir(home), sha))) return sha;
  const tmp = join(releasesDir(home), `.tmp-${sha}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = Bun.spawn(["git", "-C", repo, "archive", "--format=tar", sha], { stdout: "pipe", stderr: "pipe" });
    const untar = Bun.spawn(["tar", "-x", "-C", tmp], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
    const [archiveCode, untarCode] = await Promise.all([archive.exited, untar.exited]);
    if (archiveCode !== 0 || untarCode !== 0) throw new Error(`git archive ${sha} failed: ${(await new Response(archive.stderr).text()).trim()}`);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return buildFromTree(tmp, sha, home);
}

export function listReleases(home: string): string[] {
  if (!existsSync(releasesDir(home))) return [];
  return readdirSync(releasesDir(home), { withFileTypes: true }).filter((d) => d.isDirectory() && /^[0-9a-f]{40}$/.test(d.name)).map((d) => d.name);
}

/** `current`, `previous` and this many of the newest releases in the history are kept (docs/design/releases-and-rescue.md). */
export const KEEP_RELEASES = 5;

/**
 * Remove the built releases that nothing points at any more. Kept: `current`, `previous`, and the newest
 * KEEP_RELEASES by the history (`to`, newest first), and `alsoKeep` (the release the daemon was started from: switches
 * without a restart move `current` away from it). A release the history does not mention counts as oldest.
 * Returns the removed ids.
 */
export function pruneReleases(home: string, alsoKeep: (string | null)[] = []): string[] {
  const keep = new Set<string>();
  for (const l of [currentOf(home), previousOf(home), ...alsoKeep]) if (l) keep.add(l);
  const recent: string[] = [];
  for (const e of readHistory(home).reverse()) {
    if (e.to && /^[0-9a-f]{40}$/.test(e.to) && e.ok /* a rejected candidate is not a release to go back to */ && !recent.includes(e.to)) recent.push(e.to);
  }
  for (const sha of recent.slice(0, KEEP_RELEASES)) keep.add(sha);
  const removed: string[] = [];
  for (const sha of listReleases(home)) {
    if (keep.has(sha)) continue;
    rmSync(join(releasesDir(home), sha), { recursive: true, force: true });
    removed.push(sha);
  }
  return removed;
}

function linkOf(home: string, name: "current" | "previous"): string | null {
  try {
    const sha = readlinkSync(join(releasesDir(home), name));
    return existsSync(join(releasesDir(home), sha)) ? sha : null;
  } catch {
    return null;
  }
}
export const currentOf = (home: string) => linkOf(home, "current");
export const previousOf = (home: string) => linkOf(home, "previous");

/** Point a link at a release atomically: a reader sees the old target or the new one, never a missing link. */
function setLink(home: string, name: "current" | "previous", sha: string) {
  const tmp = join(releasesDir(home), `.${name}-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(sha, tmp);
  renameSync(tmp, join(releasesDir(home), name));
}

/** Make `sha` the current release; what was current becomes previous. */
export function switchTo(home: string, sha: string): void {
  // A full commit id and nothing else: `../checkout` exists too, and would put mutable code behind `current`.
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a release id: ${sha}`);
  if (!existsSync(join(releasesDir(home), sha))) throw new Error(`release ${sha} is not built`);
  const cur = currentOf(home);
  if (cur === sha) return;
  if (cur) setLink(home, "previous", cur);
  setLink(home, "current", sha);
}

/** Put both links back exactly (an automatic rollback must not leave the rejected release as `previous`). */
export function restoreLinks(home: string, current: string, previous: string | null): void {
  setLink(home, "current", current);
  if (previous) setLink(home, "previous", previous);
  else rmSync(join(releasesDir(home), "previous"), { force: true });
}

const historyPath = (home: string) => join(releasesDir(home), "history.jsonl");

export function appendHistory(home: string, entry: Omit<HistoryEntry, "ts">): HistoryEntry {
  const full = { ts: Date.now(), ...entry };
  mkdirSync(releasesDir(home), { recursive: true });
  // A torn last line (a crash mid-write) must not swallow this entry too: start on a fresh line.
  const torn = existsSync(historyPath(home)) && !readFileSync(historyPath(home), "utf8").endsWith("\n");
  appendFileSync(historyPath(home), (torn ? "\n" : "") + JSON.stringify(full) + "\n");
  return full;
}

export function readHistory(home: string): HistoryEntry[] {
  if (!existsSync(historyPath(home))) return [];
  return readFileSync(historyPath(home), "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as HistoryEntry];
    } catch {
      return []; // a torn last line must not hide the rest
    }
  });
}
