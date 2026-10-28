/**
 * Promotion (#178): a release becomes current only after it booted on another port against a copy of the database,
 * and stays current only if it answers on the real port afterwards. Otherwise the links go back by themselves.
 * Migrations are additive (docs/design/releases-and-rescue.md), so going back needs no database restore; the snapshot
 * taken before each promotion is for the case where going back is not enough.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendHistory, buildRelease, currentOf, previousOf, pruneReleases, releasesDir, restoreLinks, switchTo, type HistoryEntry } from "./releases.ts";
import type { Supervisor } from "./supervisor.ts";

export interface Ctx {
  home: string;
  repo: string;
  port: number;
  sup: Supervisor;
}
export interface PromoteTimes {
  /** How long a candidate may take to answer on its own port. */
  candidateMs?: number;
  /** After the switch: answer within this, … */
  confirmMs?: number;
  /** … and still be up and answering this much later. */
  settleMs?: number;
}

/** Older states come back from Litestream (point in time) or the daily archive in S3 (docs/design/releases-and-rescue.md, Promotion). */
export const KEEP_SNAPSHOTS = 3;
/** The database the daemon uses: sb-rescue hands its environment on, so SWITCHBOARD_DB moves both or neither. */
const dbPath = (home: string) => process.env.SWITCHBOARD_DB ?? join(home, "switchboard.db");
const snapshotsDir = (home: string) => join(home, "snapshots");

/** A consistent copy of the live database (VACUUM INTO reads through the WAL). Null when there is no database yet. */
export function snapshotDb(home: string, label: string, protect?: string): string | null {
  if (!existsSync(dbPath(home))) return null;
  mkdirSync(snapshotsDir(home), { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w-]/g, "")}.db`;
  const db = new Database(dbPath(home));
  try {
    db.exec(`VACUUM INTO '${join(snapshotsDir(home), name).replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  for (const old of listSnapshots(home).slice(KEEP_SNAPSHOTS)) if (old !== protect) rmSync(join(snapshotsDir(home), old), { force: true });
  return name;
}

/** Newest first (the names start with an ISO timestamp). */
export function listSnapshots(home: string): string[] {
  if (!existsSync(snapshotsDir(home))) return [];
  return readdirSync(snapshotsDir(home)).filter((f) => f.endsWith(".db")).sort().reverse();
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
    copyFileSync(join(snapshotsDir(ctx.home), snapshot), staged);
    kept = snapshotDb(ctx.home, "pre-restore", snapshot);
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

/** What "it works" means: health says ok, a WebSocket opens. Null = fine, else the reason. */
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
 * The tasks a restart or a release switch stops (#435): the daemon's running and waiting ones, from its health's
 * `busyTasks` (#2814: not the whole task list), read with the same token as checkDaemon. [] when it does not answer or
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
      .filter((t): t is { id: string; title: string; status: string } => typeof t?.id === "string" && typeof t?.title === "string" && (t.status === "running" || t.status === "waiting"))
      .map(({ id, title, status }) => ({ id, title, status }));
  } catch {
    return [];
  }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}

/** Boot the release on a spare port, a throwaway home and a copy of the snapshot. Null = it works. */
async function tryCandidate(ctx: Ctx, sha: string, snapshot: string | null, candidateMs: number): Promise<string | null> {
  const home = mkdtempSync(join(tmpdir(), "sb-candidate-"));
  if (snapshot) copyFileSync(join(snapshotsDir(ctx.home), snapshot), dbPath(home));
  const port = await freePort();
  const dir = join(releasesDir(ctx.home), sha);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: String(port), SWITCHBOARD_REPO_ROOT: ctx.repo, SWITCHBOARD_CANDIDATE: "1" });
  delete env.SWITCHBOARD_DB;
  // sb-rescue's own secret for 作り直す (#181): the candidate has no use for it, as supervisor.ts does for the daemon (#2077)
  delete env.SWITCHBOARD_STARTER_TOKEN;
  const proc = Bun.spawn([process.execPath, join(dir, "packages", "core", "src", "main.ts")], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([o, e]) => (o + e).trim().slice(-1500));
  let exited: number | null = null;
  void proc.exited.then((code) => (exited = code));
  try {
    let reason = "did not start";
    const end = Date.now() + candidateMs;
    while (Date.now() < end && exited === null) {
      const r = await checkDaemon(port, home);
      if (r === null) return null;
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
      if (Date.now() - passedAt >= settleMs) return null;
    } else {
      passedAt = null;
      reason = r;
    }
    await Bun.sleep(200);
  }
  return `not confirmed within ${Math.round(confirmMs / 1000)} s: ${reason}`;
}

export async function promote(ctx: Ctx, rev: string, times: PromoteTimes = {}): Promise<HistoryEntry> {
  const { candidateMs = 30_000, confirmMs = 60_000, settleMs = 10_000 } = times;
  const from = currentOf(ctx.home);
  const before = previousOf(ctx.home);
  let sha: string;
  try {
    sha = await buildRelease(ctx.repo, rev, ctx.home);
  } catch (e) {
    return appendHistory(ctx.home, { action: "rejected", from, to: rev, ok: false, reason: `could not build the release: ${String((e as Error).message ?? e)}` });
  }
  if (sha === from) return appendHistory(ctx.home, { action: "rejected", from, to: sha, ok: false, reason: "this release is already current" });
  const snapshot = snapshotDb(ctx.home, `before-${sha.slice(0, 7)}`);
  const refused = await tryCandidate(ctx, sha, snapshot, candidateMs);
  if (refused) return appendHistory(ctx.home, { action: "rejected", from, to: sha, ok: false, reason: refused });
  switchTo(ctx.home, sha);
  await ctx.sup.restart();
  const failed = await confirm(ctx, confirmMs, settleMs);
  if (!failed) {
    // Only a confirmed promotion removes anything: a rejection or rollback must not shrink what can be gone back to.
    const removed = pruneReleases(ctx.home).length;
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
