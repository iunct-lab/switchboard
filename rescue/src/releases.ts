/**
 * Immutable releases (#178). A release is one commit of the Switchboard repository, exported and built once under
 * `<home>/releases/<sha>/`; `current` and `previous` are relative symlinks next to them. Nothing writes into a
 * release after it is built, so an agent editing the working tree cannot change the daemon that is running.
 * The history is a JSONL file, not a database row: it must be readable while Switchboard itself is down.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export type HistoryAction = "install" | "promote" | "rejected" | "auto-rollback" | "rollback" | "restart" | "restore-db" | "rebuild";
export interface HistoryEntry {
  ts: number;
  action: HistoryAction;
  from: string | null;
  to: string | null;
  ok: boolean;
  reason: string;
}

export const releasesDir = (home: string) => join(home, "releases");

/** Run a command to completion; a non-zero exit throws with the end of its output (that text is the "reason" users see). */
export async function run(argv: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}: ${(err || out).trim().slice(-2000)}`);
  return out.trim();
}

export const resolveCommit = (repo: string, rev: string) => run(["git", "-C", repo, "rev-parse", "--verify", `${rev}^{commit}`], repo);

/** Export `rev` from `repo` and build it. Built aside and renamed into place, so a half-built release never has a final name. */
export async function buildRelease(repo: string, rev: string, home: string): Promise<string> {
  const sha = await resolveCommit(repo, rev);
  const dir = join(releasesDir(home), sha);
  if (existsSync(dir)) return sha;
  const tmp = join(releasesDir(home), `.tmp-${sha}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = Bun.spawn(["git", "-C", repo, "archive", "--format=tar", sha], { stdout: "pipe", stderr: "pipe" });
    const untar = Bun.spawn(["tar", "-x", "-C", tmp], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
    const [archiveCode, untarCode] = await Promise.all([archive.exited, untar.exited]);
    if (archiveCode !== 0 || untarCode !== 0) throw new Error(`git archive ${sha} failed: ${(await new Response(archive.stderr).text()).trim()}`);
    await run([process.execPath, "install", "--frozen-lockfile"], tmp);
    if (existsSync(join(tmp, "apps", "web", "package.json"))) await run([process.execPath, "run", "--cwd", "apps/web", "build"], tmp);
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return sha;
}

export function listReleases(home: string): string[] {
  if (!existsSync(releasesDir(home))) return [];
  return readdirSync(releasesDir(home), { withFileTypes: true }).filter((d) => d.isDirectory() && /^[0-9a-f]{40}$/.test(d.name)).map((d) => d.name);
}

/** `current`, `previous` and this many of the newest releases in the history are kept (docs/design/releases-and-rescue.md). */
export const KEEP_RELEASES = 5;

/**
 * Remove the built releases that nothing points at any more. Kept: `current`, `previous`, and the newest
 * KEEP_RELEASES by the history (`to`, newest first). A release the history does not mention counts as oldest.
 * Returns the removed ids.
 */
export function pruneReleases(home: string): string[] {
  const keep = new Set<string>();
  for (const l of [currentOf(home), previousOf(home)]) if (l) keep.add(l);
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
