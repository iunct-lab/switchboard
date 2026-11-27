/**
 * Promotion: a release becomes current only after it booted on another port against a copy of the database,
 * and stays current only if it answers on the real port afterwards. Otherwise the links go back by themselves.
 * Migrations are additive (docs/design/releases-and-rescue.md), so going back needs no database restore; the snapshot
 * taken before each promotion is for the case where going back is not enough.
 */
import { Database } from "bun:sqlite";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, constants } from "node:zlib";
import { extractTarball, fetchTarball, shaOfTag } from "./github-release.ts";
import { appendHistory, buildFromTree, buildRelease, currentOf, daemonReadsOf, previousOf, pruneReleases, releasesDir, restartNeeded, restoreLinks, switchTo, type HistoryEntry } from "./releases.ts";
import type { Supervisor } from "./supervisor.ts";

export interface Ctx {
  home: string;
  repo: string;
  /** `owner/name` of the repository releases come from (`<home>/update-source.json`); null = build from the checkout `repo`. */
  source: string | null;
  port: number;
  sup: Supervisor;
  /**
   * The command that runs another command while it holds one of the machine's heavy-process slots (the kit's
   * `ops-kit heavy --name … --`), or null where the machine has no such limit. A promotion asked for while Tasks run
   * (`ifNoRestart`) builds and starts its candidate inside one (`holdHeavy`).
   */
  heavy?: string[] | null;
}

/** A heavy-process slot held for a promotion; `release` gives it back (also when sb-rescue ends: the holder reads its end of a pipe). */
export type HeavyHold = { release: () => Promise<void> };

/**
 * Takes one of the machine's heavy-process slots through `heavy` (`Ctx.heavy`) and keeps it until `release`: the
 * command runs a holder that says `held` once it has the slot and then waits for its input to close. `{ busy }` = no
 * slot within `waitMs` (every slot is held, or the free memory is under the machine's floor — the wrapper's own line
 * says which), or the wrapper could not be run: nothing is held. Without `heavy` there is no limit to keep (a hold
 * that does nothing).
 */
export async function holdHeavy(heavy: string[] | null | undefined, waitMs: number): Promise<HeavyHold | { busy: string }> {
  if (!heavy?.length) return { release: async () => undefined };
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...heavy, "sh", "-c", "echo held; exec cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
  } catch (e) {
    return { busy: `could not run ${heavy[0]}: ${String((e as Error).message ?? e)}` };
  }
  const said = new Response(proc.stderr).text().catch(() => "");
  const reader = proc.stdout.getReader();
  const first = (async () => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      text += new TextDecoder().decode(value);
      if (text.includes("held")) return true;
    }
  })().catch(() => false);
  const held = await Promise.race([first, Bun.sleep(waitMs).then(() => false)]);
  const end = async () => {
    try {
      await proc.stdin.end();
    } catch { /* already gone */ }
    if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => null)])) === null) proc.kill();
    void reader.cancel().catch(() => undefined);
  };
  if (held) return { release: end };
  proc.kill();
  await Promise.race([proc.exited, Bun.sleep(2000)]);
  const why = (await Promise.race([said, Bun.sleep(500).then(() => "")])).trim().split("\n").filter(Boolean).at(-1) ?? "";
  void reader.cancel().catch(() => undefined);
  return { busy: why.slice(0, 300) || `no heavy-process slot within ${Math.round(waitMs / 1000)} s` };
}
export interface PromoteTimes {
  /** How long a candidate may take to answer on its own port. */
  candidateMs?: number;
  /** How long an `ifNoRestart` promotion waits for a heavy-process slot when its caller did not take one. */
  heavyWaitMs?: number;
  /** After the switch: answer within this, … */
  confirmMs?: number;
  /** … and still be up and answering this much later. */
  settleMs?: number;
  /** A switch without a restart: the daemon must report the new release in `/api/health` within this after SIGHUP. */
  webMs?: number;
  /** How long the running release may take to say what its daemon reads (`daemonReadsOf`); past it, the switch is a restart. */
  readsMs?: number;
}

/** Older states come back from Litestream (point in time) or the daily archive in S3 (docs/design/releases-and-rescue.md, Promotion). */
export const KEEP_SNAPSHOTS = 3;
/** The database the daemon uses: sb-rescue hands its environment on, so SWITCHBOARD_DB moves both or neither. */
const dbPath = (home: string) => process.env.SWITCHBOARD_DB ?? join(home, "switchboard.db");
const snapshotsDir = (home: string) => join(home, "snapshots");

/** Stream, not in memory: a database is hundreds of MB on a small host. The output appears under its name only when it is whole. */
async function transform(from: string, to: string, step: NodeJS.ReadWriteStream): Promise<void> {
  const part = `${to}.part`;
  try {
    await pipeline(createReadStream(from), step, createWriteStream(part));
    renameSync(part, to);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

/** Every finished `.db` in the folder goes to `.db.gz`: the one just taken, and any a killed run left (a copy from before this format too). */
async function compressSnapshots(home: string): Promise<void> {
  for (const f of readdirSync(snapshotsDir(home)).filter((n) => n.endsWith(".db")).sort()) {
    const db = join(snapshotsDir(home), f);
    await transform(db, `${db}.gz`, createGzip({ level: constants.Z_BEST_SPEED }));
    rmSync(db, { force: true });
  }
}

/**
 * Room to ask for per byte of live data: the copy VACUUM INTO writes is that much (free pages are left out), and the gzip
 * written next to it while the copy is still there is about a quarter of it. There is no margin beyond that: a database
 * that compresses worse can still run out of disk in the gzip, which removes the copy and fails the snapshot.
 * The daemon's `copyRoom` (packages/core/src/db.ts) is the same formula, kept in step by hand as this bundle does not import
 * core; the root disk budget in docs/design/host-disk.md reserves this much.
 */
const SNAPSHOT_ROOM = 1.25;
/** What a snapshot needs on disk, from what the database holds now, not from the size of the host. */
export function snapshotNeeds(db: Database): number {
  return Math.ceil(liveBytes(db) * SNAPSHOT_ROOM);
}
/** The live pages of the database times the page size: what a whole copy of it (VACUUM INTO, or the candidate's unpacked one) takes. */
export function liveBytes(db: Database): number {
  const n = (pragma: string) => (db.query(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma]!;
  return (n("page_count") - n("freelist_count")) * n("page_size");
}
/**
 * What the next database snapshot needs, read from the live database without writing; null when there is none yet, or when it
 * cannot be read (a damaged file is what the rescue page is for: its disk figures and clean buttons still answer).
 */
export function diskReserve(home: string): number | null {
  if (!existsSync(dbPath(home))) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath(home), { readonly: true });
    return snapshotNeeds(db);
  } catch (e) {
    console.error("disk reserve: the database cannot be read:", e);
    return null;
  } finally {
    db?.close();
  }
}
const freeOn = (dir: string) => {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
};
const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/**
 * A consistent copy of the live database (VACUUM INTO reads through the WAL), gzipped: a database compresses to about a
 * quarter, and three of them were most of what grew on the disk. Null when there is no database yet.
 */
export async function snapshotDb(home: string, label: string, protect?: string, freeBytes: (dir: string) => number = freeOn): Promise<string | null> {
  if (!existsSync(dbPath(home))) return null;
  mkdirSync(snapshotsDir(home), { recursive: true });
  // what a run killed halfway left: never finished, nothing reads it
  for (const f of readdirSync(snapshotsDir(home)).filter((n) => n.endsWith(".tmp") || n.endsWith(".part") || n.endsWith("-journal"))) rmSync(join(snapshotsDir(home), f), { force: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w-]/g, "")}.db`;
  const copy = join(snapshotsDir(home), `${name}.tmp`); // not `.db` until it is whole
  const db = new Database(dbPath(home));
  try {
    const need = snapshotNeeds(db);
    if (freeBytes(snapshotsDir(home)) < need) {
      // what a success would delete anyway goes first, so the newest ones are not touched
      for (const old of listSnapshots(home).slice(KEEP_SNAPSHOTS - 1)) if (old !== protect) rmSync(join(snapshotsDir(home), old), { force: true });
      const free = freeBytes(snapshotsDir(home));
      if (free < need) throw new Error(`not enough disk for the database snapshot: needs ${mb(need)}, ${mb(free)} free`);
    }
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    renameSync(copy, join(snapshotsDir(home), name));
  } catch (e) {
    rmSync(copy, { force: true });
    rmSync(`${copy}-journal`, { force: true });
    throw e;
  } finally {
    db.close();
  }
  try {
    await compressSnapshots(home);
  } catch (e) {
    rmSync(join(snapshotsDir(home), name), { force: true }); // a whole copy of the database must not stay on a disk that may be why this failed
    throw e;
  }
  for (const old of listSnapshots(home).slice(KEEP_SNAPSHOTS)) if (old !== protect) rmSync(join(snapshotsDir(home), old), { force: true });
  return `${name}.gz`;
}

/** Newest first (the names start with an ISO timestamp). */
export function listSnapshots(home: string): string[] {
  if (!existsSync(snapshotsDir(home))) return [];
  return readdirSync(snapshotsDir(home)).filter((f) => f.endsWith(".db.gz")).sort().reverse();
}

/** Replace the database with a snapshot. What is there now is kept as a `pre-restore` snapshot first. */
export async function restoreDb(ctx: Ctx, snapshot: string): Promise<HistoryEntry> {
  if (snapshot !== basename(snapshot) || !listSnapshots(ctx.home).includes(snapshot)) throw new Error(`no such snapshot: ${snapshot}`);
  await ctx.sup.stop();
  // Nothing is removed until the replacement is complete next to the database: copy first, then keep what is there
  // now (pruning must not take the snapshot being restored), and only then swap by rename.
  const staged = `${dbPath(ctx.home)}.restore`;
  let kept: string | null;
  try {
    await transform(join(snapshotsDir(ctx.home), snapshot), staged, createGunzip());
    kept = await snapshotDb(ctx.home, "pre-restore", snapshot);
  } catch (e) {
    rmSync(staged, { force: true });
    await ctx.sup.restart(); // the database was not touched
    throw e;
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(dbPath(ctx.home) + suffix, { force: true });
  renameSync(staged, dbPath(ctx.home));
  await ctx.sup.restart();
  return appendHistory(ctx.home, { action: "restore-db", from: currentOf(ctx.home), to: currentOf(ctx.home), ok: true, reason: `database restored from ${snapshot}${kept ? `; the one before is kept as ${kept}` : ""}` });
}

/**
 * What "it works" means: health says ok, a WebSocket opens. Null = fine, else the reason. The features the screens
 * depend on are checkFeatures, asked once after this passes (it is polled every 200 ms; the task list is too big for that).
 */
export async function checkDaemon(port: number, home: string): Promise<string | null> {
  const tokenFile = join(home, "token");
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers, signal: AbortSignal.timeout(3000) });
    if (!health.ok || ((await health.json()) as { ok?: boolean }).ok !== true) return `/api/health answered ${health.status}`;
  } catch (e) {
    return `no answer on port ${port} (${String((e as Error).message ?? e)})`;
  }
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ""}`);
    const done = (reason: string | null) => {
      clearTimeout(timer);
      ws.close();
      resolve(reason);
    };
    const timer = setTimeout(() => done("WebSocket /ws did not open"), 3000);
    ws.onopen = () => done(null);
    ws.onerror = () => done("WebSocket /ws refused");
  });
}

/**
 * The smoke of the screens: the task list (`GET /api/tasks`, the call the UI makes first) answers with an array, and when
 * it is not empty its first task reads back (`GET /api/tasks/:id`). A host with no task yet passes. Null = fine, else the reason.
 */
export async function checkFeatures(port: number, home: string): Promise<string | null> {
  const tokenFile = join(home, "token");
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  let path = "/api/tasks";
  try {
    const list = await get(path);
    const tasks: unknown = list.ok ? await list.json().catch(() => null) : null;
    if (!Array.isArray(tasks)) return `${path} answered ${list.ok ? "something that is not a list" : list.status}`;
    if (tasks.length === 0) return null;
    const id = (tasks[0] as { id?: unknown }).id;
    if (typeof id !== "string") return `${path} listed a task without an id`;
    // the task as the UI reads it (`{ task, events, … }`); limit=0 leaves out its events, which can be many
    path = `/api/tasks/${encodeURIComponent(id)}`;
    const one = await get(`${path}?limit=0`);
    if (!one.ok) return `${path} answered ${one.status}`;
    if (((await one.json()) as { task?: { id?: unknown } } | null)?.task?.id !== id) return `${path} answered another task`;
    return null;
  } catch (e) {
    return `${path} did not answer (${String((e as Error).message ?? e)})`;
  }
}

/**
 * The tasks a restart or a release switch stops: the daemon's running and waiting ones and those whose turn ended with background jobs still going, from its health's
 * `busyTasks` (not the whole task list), read with the same token as checkDaemon. [] when it does not answer or
 * answers something else: a daemon that is down has nothing to stop.
 */
export async function tasksThatStop(port: number, home: string): Promise<{ id: string; title: string; status: string }[]> {
  const tokenFile = join(home, "token");
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: token ? { authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(3000) });
    const tasks: unknown = r.ok ? ((await r.json()) as { busyTasks?: unknown } | null)?.busyTasks : null;
    if (!Array.isArray(tasks)) return [];
    return tasks
      .filter((t): t is { id: string; title: string; status: string } => typeof t?.id === "string" && typeof t?.title === "string" && (t.status === "running" || t.status === "waiting" || t.status === "background"))
      .map(({ id, title, status }) => ({ id, title, status }));
  } catch {
    return [];
  }
}

/** The `webRelease` the daemon's health reports (the release its Web UI is served from); null = it does not answer or does not report one (a daemon that does not know SIGHUP). */
export async function webReleaseOf(port: number, home: string): Promise<string | null> {
  const tokenFile = join(home, "token");
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: token ? { authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(3000) });
    const web = r.ok ? ((await r.json()) as { webRelease?: unknown } | null)?.webRelease : null;
    return typeof web === "string" ? web : null;
  } catch {
    return null;
  }
}

/**
 * Can the running daemon take `sha` by reading it again (SIGHUP) instead of restarting? Every file that differs from the
 * release it started from is in the Web UI or the default settings, or is one it does not read (asked of that release,
 * not of the candidate: a candidate cannot declare itself unread), and the daemon says which release it serves.
 * `files` are the files that need the restart (as `restartNeeded`); empty when the difference needs none and only the
 * daemon's missing web release says no, or when there was nothing to compare.
 */
export async function switchesWithoutRestart(ctx: Ctx, sha: string, readsMs = 10_000): Promise<{ ok: boolean; files: string[] }> {
  const running = ctx.sup.running;
  const reads = running ? await daemonReadsOf(join(releasesDir(ctx.home), running), readsMs) : null;
  const { restart, files } = await restartNeeded(ctx.repo, running, sha, reads);
  if (restart) return { ok: false, files };
  return { ok: (await webReleaseOf(ctx.port, ctx.home)) !== null, files: [] };
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}

/** The candidate's throwaway home: on the disk under the sb-rescue home (the unpacked database is too big for a RAM temp folder). */
const candidateDir = (home: string) => join(home, `candidate-${process.pid}`);

/**
 * Remove `candidate-<pid>` homes under `home` whose process is gone (a promotion killed halfway), and with `own` this process's
 * too (only where no candidate of this process runs: one operation at a time); returns what was removed.
 */
export function sweepCandidates(home: string, own = false): string[] {
  if (!existsSync(home)) return [];
  const removed: string[] = [];
  const stuck: string[] = [];
  for (const name of readdirSync(home)) {
    const pid = /^candidate-(\d+)$/.exec(name)?.[1];
    if (!pid) continue;
    if (!(own && Number(pid) === process.pid)) {
      try {
        process.kill(Number(pid), 0);
        continue; // alive
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue; // EPERM: alive, another user's
      }
    }
    try {
      rmSync(join(home, name), { recursive: true, force: true });
      removed.push(join(home, name));
    } catch (e) {
      stuck.push(`${join(home, name)} (${(e as NodeJS.ErrnoException).code ?? e})`); // the others still go
    }
  }
  if (stuck.length) throw new Error(`could not remove a leftover candidate home: ${stuck.join(", ")}`);
  return removed;
}

/**
 * Boot the release on a spare port, a throwaway home and a copy of the snapshot. Null = it works. The room for the unpacked
 * database is checked before anything is unpacked: short of it, nothing is written and the reason says what was needed.
 */
export async function tryCandidate(ctx: Ctx, sha: string, snapshot: string | null, candidateMs: number, freeBytes: (dir: string) => number = freeOn): Promise<string | null> {
  sweepCandidates(ctx.home);
  if (snapshot && existsSync(dbPath(ctx.home))) {
    let need: number;
    const live = new Database(dbPath(ctx.home), { readonly: true });
    try {
      need = liveBytes(live);
    } finally {
      live.close();
    }
    const free = freeBytes(ctx.home);
    if (free < need) return `the candidate's database does not fit: needs ${mb(need)}, ${mb(free)} free`;
  }
  const home = candidateDir(ctx.home);
  rmSync(home, { recursive: true, force: true }); // this pid's own leftover (a killed sb-rescue whose pid came back): one operation runs at a time
  mkdirSync(home, { mode: 0o700 }); // it holds a whole copy of the database
  const dir = join(releasesDir(ctx.home), sha);
  let port: number;
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    if (snapshot) await transform(join(snapshotsDir(ctx.home), snapshot), join(home, "switchboard.db"), createGunzip()); // not dbPath: SWITCHBOARD_DB names the live database
    port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // its Knowledge inside its home too: the home is no temp folder, so core would otherwise take the user's ~/Knowledge
    Object.assign(env, { SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: String(port), SWITCHBOARD_REPO_ROOT: ctx.source ? dir : ctx.repo, SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_KNOWLEDGE: join(home, "Knowledge") });
    delete env.SWITCHBOARD_DB;
    // sb-rescue's own secret for 作り直す: the candidate has no use for it, as supervisor.ts does for the daemon
    delete env.SWITCHBOARD_STARTER_TOKEN;
    proc = Bun.spawn([process.execPath, join(dir, "packages", "core", "src", "main.ts")], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    rmSync(home, { recursive: true, force: true }); // until the candidate runs, nothing else removes its home: a whole database copy must not stay on the disk
    throw e;
  }
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([o, e]) => (o + e).trim().slice(-1500));
  let exited: number | null = null;
  void proc.exited.then((code) => (exited = code));
  try {
    let reason = "did not start";
    const end = Date.now() + candidateMs;
    while (Date.now() < end && exited === null) {
      const r = await checkDaemon(port, home);
      if (r === null) return await checkFeatures(port, home); // once (awaited: the finally below kills the candidate): the list is big, and a failure here is the release's, not a slow start
      reason = r;
      await Bun.sleep(200);
    }
    if (exited !== null) return `the candidate exited (${exited}) before it answered: ${await output}`;
    return `the candidate did not pass within ${Math.round(candidateMs / 1000)} s: ${reason}`;
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
  }
}

/** After the switch: a first good answer within `confirmMs`, and still answering — without a crash — `settleMs` after it. */
async function confirm(ctx: Ctx, confirmMs: number, settleMs: number): Promise<string | null> {
  const end = Date.now() + confirmMs;
  let reason = "did not start";
  let passedAt: number | null = null;
  while (Date.now() < end || passedAt !== null) {
    if (ctx.sup.crashes > 0 || ctx.sup.state === "failed") return `the daemon crashed after the switch: ${ctx.sup.logTail(5).join(" | ")}`;
    const r = await checkDaemon(ctx.port, ctx.home);
    if (r === null) {
      passedAt ??= Date.now();
      if (Date.now() - passedAt >= settleMs) return checkFeatures(ctx.port, ctx.home);
    } else {
      passedAt = null;
      reason = r;
    }
    await Bun.sleep(200);
  }
  return `not confirmed within ${Math.round(confirmMs / 1000)} s: ${reason}`;
}

/**
 * After SIGHUP: the process that got it (`pid`) still runs and reports `sha` as its `webRelease` within `webMs`, then the
 * screens' smoke passes and `GET /` answers 200. A process started again in the meantime (a crash and the supervisor's
 * retry, which starts from the new `current`) would report `sha` too, but its tasks were stopped: that is not a switch without a restart.
 */
async function confirmWeb(ctx: Ctx, sha: string, webMs: number, pid: number | null): Promise<string | null> {
  const end = Date.now() + webMs;
  let seen: string | null = null;
  const replaced = () => (ctx.sup.pid !== pid ? `the daemon process did not survive the reload (it was started again): ${ctx.sup.logTail(5).join(" | ")}` : null);
  while (Date.now() < end) {
    if (ctx.sup.state !== "running") return `the daemon stopped after the reload (${ctx.sup.state}): ${ctx.sup.logTail(5).join(" | ")}`;
    const gone = replaced();
    if (gone) return gone;
    seen = await webReleaseOf(ctx.port, ctx.home);
    if (seen === sha) break;
    await Bun.sleep(200);
  }
  if (seen !== sha) return `the daemon did not report ${sha.slice(0, 7)} as its web release within ${Math.round(webMs / 1000)} s (it reports ${seen ? seen.slice(0, 7) : "none"})`;
  const failed = await checkFeatures(ctx.port, ctx.home);
  if (failed) return failed;
  try {
    const tokenFile = join(ctx.home, "token");
    const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
    const page = await fetch(`http://127.0.0.1:${ctx.port}/`, { headers: token ? { authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(5000) });
    if (!page.ok) return `GET / answered ${page.status}`;
  } catch (e) {
    return `GET / did not answer (${String((e as Error).message ?? e)})`;
  }
  return replaced();
}

/** Build the release `tag` of `source` from its tarball (no git). The tag must be a version tag; the tree is checked on the way in. */

async function buildFromSource(source: string, tag: string, home: string, expectSha?: string): Promise<string> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`a release is promoted by its version tag (v1.2.3), not ${tag}`);
  const sha = await shaOfTag(source, tag);
  if (expectSha && sha !== expectSha) throw new Error(`${tag} now points at ${sha}, not the checked version ${expectSha}: the checked version is not the one that would run`);
  if (existsSync(join(releasesDir(home), sha))) return sha;
  const work = join(releasesDir(home), `.tmp-${sha}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const tarball = await fetchTarball(source, tag, work);
    const tree = join(work, "tree");
    await extractTarball(tarball, tree, { tag, sha });
    return await buildFromTree(tree, sha, home, { tag, sha });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * `expectSha`: from a source repository, the commit the caller checked; a tag that now points elsewhere is rejected before any build.
 * `ifNoRestart`: the caller asked for a switch that keeps its tasks, and this never restarts the daemon for it. Its
 * build (the install and the Web UI's build), the database snapshot and the candidate daemon run while those tasks
 * do, so they run inside one of the machine's heavy-process slots (`held`, or taken here: `holdHeavy`) — the same
 * slots a local CI or a test run waits for, with the same floor of free memory — and with none free nothing is built
 * (it throws; the caller asks again later). The
 * check before the build is asked again here, after the candidate: when it now says restart (the daemon stopped
 * answering health in time, for example), nothing is switched and this throws (the status shows it as the last error).
 * No history entry: a rejected release is never asked for again, and this one is only waiting for the tasks to be idle.
 * A reload that is not confirmed is taken back the way it came — the links are put back and the daemon reads the older
 * release again (a second SIGHUP) — and the release is `rejected` with the reason, so it is not tried again by itself
 * and the person is told. Only when the daemon process that got the reload is gone (it crashed; its tasks stopped with
 * it) is the daemon started again, on the older release.
 */
export async function promote(ctx: Ctx, rev: string, times: PromoteTimes = {}, expectSha?: string, ifNoRestart = false, held?: HeavyHold): Promise<HistoryEntry> {
  const { candidateMs = 30_000, confirmMs = 60_000, settleMs = 10_000, webMs = 10_000, readsMs = 10_000 } = times;
  const from = currentOf(ctx.home);
  const before = previousOf(ctx.home);
  const slot = ifNoRestart ? (held ?? (await holdHeavy(ctx.heavy, times.heavyWaitMs ?? 15_000))) : null;
  if (slot && "busy" in slot) throw new Error(`no heavy-process slot for a build under running tasks (${slot.busy}); nothing was built`);
  try {
    return await promoteHeld(ctx, rev, { candidateMs, confirmMs, settleMs, webMs, readsMs }, expectSha, ifNoRestart, from, before, slot);
  } finally {
    await slot?.release();
  }
}

/** `promote` once its heavy-process slot is held (`slot`; null = a promotion that takes none): the slot is given back as soon as the candidate has been checked. */
async function promoteHeld(ctx: Ctx, rev: string, times: Required<Omit<PromoteTimes, "heavyWaitMs">>, expectSha: string | undefined, ifNoRestart: boolean, from: string | null, before: string | null, slot: HeavyHold | null): Promise<HistoryEntry> {
  // first, before the build and the snapshot need room: a killed run's candidate home (a whole database copy), this process's
  // own too (a restarted sb-rescue can have the same pid). One that cannot be removed is logged (the others still go), and the
  // candidate's start meets it again and rejects the promotion
  try {
    sweepCandidates(ctx.home, true);
  } catch (e) {
    console.error("promote: a leftover candidate home could not be removed:", e);
  }
  const { candidateMs, confirmMs, settleMs, webMs, readsMs } = times;
  let sha: string;
  try {
    sha = ctx.source ? await buildFromSource(ctx.source, rev, ctx.home, expectSha) : await buildRelease(ctx.repo, rev, ctx.home);
  } catch (e) {
    // asked by tag with the commit that was checked: the history names that commit, as the daemon looks failures up by
    // commit. Any failure holds that version, as a failed build does on the checkout path (the daemon reports it, and
    // `この版に更新` asks again): telling a passing outage from a lasting refusal is not attempted
    return appendHistory(ctx.home, { action: "rejected", from, to: expectSha ?? rev, ok: false, reason: `could not build the release: ${String((e as Error).message ?? e)}` });
  }
  if (sha === from) return appendHistory(ctx.home, { action: "rejected", from, to: sha, ok: false, reason: "this release is already current" });
  let snapshot: string | null;
  try {
    snapshot = await snapshotDb(ctx.home, `before-${sha.slice(0, 7)}`);
  } catch (e) {
    return appendHistory(ctx.home, { action: "rejected", from, to: sha, ok: false, reason: `could not take the database snapshot: ${String((e as Error).message ?? e)}` });
  }
  let refused: string | null;
  try {
    refused = await tryCandidate(ctx, sha, snapshot, candidateMs);
  } catch (e) {
    return appendHistory(ctx.home, { action: "rejected", from, to: sha, ok: false, reason: `could not start the candidate: ${String((e as Error).message ?? e)}` });
  }
  if (refused) return appendHistory(ctx.home, { action: "rejected", from, to: sha, ok: false, reason: refused });
  // the heavy part is over: the reload and its checks are the running daemon's own work
  await slot?.release();
  const quiet = from !== null && (await switchesWithoutRestart(ctx, sha, readsMs)).ok;
  if (!quiet && ifNoRestart) throw new Error(`${sha.slice(0, 7)} needs a restart now; asked without one, so nothing was switched`);
  if (quiet && from) {
    // What differs from what the daemon started from is the Web UI and the default settings, which it reads again, or files it does not read: it keeps its tasks.
    switchTo(ctx.home, sha);
    const pid = ctx.sup.pid;
    const reloaded = ctx.sup.reload();
    const failedWeb = reloaded ? await confirmWeb(ctx, sha, webMs, pid) : "no daemon process to reload";
    if (!failedWeb) {
      const removed = pruneReleases(ctx.home, [ctx.sup.running]).length;
      return appendHistory(ctx.home, { action: "promote-web", from, to: sha, ok: true, reason: `checked on a spare port, then read again by the running daemon (no restart) on port ${ctx.port}${snapshot ? `; database snapshot ${snapshot}` : ""}${removed ? `; removed ${removed} old releases` : ""}` });
    }
    // Asked without a restart: the tasks that run are not this promotion's to stop, whatever went wrong with the reload.
    // The links go back and the same process reads the older release again; it is not restarted when that cannot be
    // confirmed either (what differs is the Web UI, the default settings or files the daemon does not read: the person can restart from the rescue page).
    if (ifNoRestart && ctx.sup.pid === pid && ctx.sup.state === "running") {
      restoreLinks(ctx.home, from, before);
      ctx.sup.reload();
      const end = Date.now() + webMs;
      let back = false;
      while (!back && Date.now() < end) {
        back = (await webReleaseOf(ctx.port, ctx.home)) === from;
        if (!back) await Bun.sleep(200);
      }
      return appendHistory(ctx.home, { action: "rejected", from, to: sha, ok: false, reason: `the reload was not confirmed (${failedWeb}); the links were put back and the daemon was not restarted${back ? "" : `, but it did not report ${from.slice(0, 7)} as its web release again within ${Math.round(webMs / 1000)} s: restart it from the rescue page if the screens are wrong`}` });
    }
    // Going back restarts the daemon, as after a restart: only a fresh process is sure to serve the older release again
    // (a daemon that half took the new one may not take the old one by SIGHUP either), and the `auto-rollback` line then
    // means what the stop reasons read it as, a switch that ended the daemon's run. Reached without `ifNoRestart` (a
    // promotion by hand, which accepted a restart), or when the process that got the reload is already gone.
    restoreLinks(ctx.home, from, before);
    await ctx.sup.restart();
    return appendHistory(ctx.home, { action: "auto-rollback", from: sha, to: from, ok: false, reason: `went back by itself (restarted on the older release): ${failedWeb}` });
  }
  switchTo(ctx.home, sha);
  await ctx.sup.restart();
  const failed = await confirm(ctx, confirmMs, settleMs);
  if (!failed) {
    // Only a confirmed promotion removes anything: a rejection or rollback must not shrink what can be gone back to.
    const removed = pruneReleases(ctx.home, [ctx.sup.running]).length;
    return appendHistory(ctx.home, { action: "promote", from, to: sha, ok: true, reason: `checked on a spare port, then confirmed on port ${ctx.port}${snapshot ? `; database snapshot ${snapshot}` : ""}${removed ? `; removed ${removed} old releases` : ""}` });
  }
  if (!from) return appendHistory(ctx.home, { action: "promote", from, to: sha, ok: false, reason: `${failed}; there is no earlier release to go back to` });
  restoreLinks(ctx.home, from, before);
  await ctx.sup.restart();
  return appendHistory(ctx.home, { action: "auto-rollback", from: sha, to: from, ok: false, reason: `went back by itself: ${failed}` });
}

/** Go back to `sha`, or to `previous` when none is given. */
export async function rollback(ctx: Ctx, sha?: string): Promise<HistoryEntry> {
  const from = currentOf(ctx.home);
  const to = sha ?? previousOf(ctx.home);
  if (!to) throw new Error("there is no previous release");
  switchTo(ctx.home, to);
  await ctx.sup.restart();
  return appendHistory(ctx.home, { action: "rollback", from, to, ok: true, reason: sha ? "chosen on the rescue page" : "back to the previous release" });
}
