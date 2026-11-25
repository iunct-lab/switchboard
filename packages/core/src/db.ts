import { Database } from "bun:sqlite";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";
import { MAX_STOP_RESUMES, planResumeAfterStop } from "./interrupted.ts";
import { IN_FLIGHT } from "./task-status.ts";
import { migrate } from "./db/migrate.ts";
import { SCHEMA } from "./db/schema.ts";
import { rowToTask } from "./db/tasks.ts";
import { CliUpdateQueries } from "./db/cli-updates.ts";

export { newId } from "./db/util.ts";
export { CUSTOM_RUNNERS_KEY } from "./db/core.ts";
export { SEND_DELAY_MS, inSendWindow, BacklogResolveError, applyBacklogField } from "./db/backlog.ts";
export type { BacklogSnapshotEntry, BacklogOperationKind, BacklogArtifactPayload, BacklogOperationStatus, BacklogOverwritten, BacklogOperation, NewBacklogOperation, BacklogLocalEntry } from "./db/backlog.ts";
export { eventsByPrefixSql, EVENTS_PAGE_MAX } from "./db/events.ts";
export { ACCOUNT_SHOWN_CHARS } from "./db/quota.ts";
export type { QuotaWindowRow } from "./db/quota.ts";
export { displayPath } from "./db/history.ts";
export type { HistoryImportRow } from "./db/history.ts";
export type { EvalRow } from "./db/evals.ts";
export { artifactsOfIssues, tasksOfIssues, DEFERRED_WORDS, issuesInText, pullsInText, createdPullsOf, createdIssuesOf, deferredOf, deferredTasksSince, scheduledIssuesSince } from "./db/issue-work.ts";
export { jstDay, jstDayStart } from "./db/ledger.ts";
export { SCHEDULE_LOG_KEEP_MS } from "./db/schedules.ts";
export { sizeClass, nearestRank } from "./db/ops.ts";
export type { ApiRequestRow, OpsLoadRow, OpsLoadGroupRow } from "./db/ops.ts";
export { SAMPLES_BEFORE_THE_LIST } from "./db/migrations/0035-schedule-samples-record.ts";

/** Table name -> column names, and `user_version`: what `needsMigration` compares. */
function schemaShape(db: Database): { tables: Map<string, Set<string>>; version: number } {
  const tables = new Map<string, Set<string>>();
  for (const t of db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>) {
    const cols = db.query("SELECT name FROM pragma_table_info(?)").all(t.name) as Array<{ name: string }>;
    tables.set(t.name, new Set(cols.map((c) => c.name)));
  }
  return { tables, version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version };
}

/**
 * Whether opening `path` with `Db` would change its schema (a table or column the current code expects is missing, or
 * `user_version` is behind): the shape of an empty database that got `SCHEMA` and `migrate` is the reference. False when
 * there is no file. Read-only: the file is not touched.
 */
export function needsMigration(path: string): boolean {
  if (!existsSync(path)) return false;
  const want = new Database(":memory:");
  const have = new Database(path, { readonly: true });
  try {
    want.exec(SCHEMA);
    migrate(want);
    const w = schemaShape(want);
    const h = schemaShape(have);
    if (h.version < w.version) return true;
    for (const [table, cols] of w.tables) {
      const present = h.tables.get(table);
      if (!present) return true;
      for (const c of cols) if (!present.has(c)) return true;
    }
    return false;
  } finally {
    have.close();
    want.close();
  }
}

/**
 * Before the schema is moved on, a copy of the database in sb-rescue's snapshot folder and form (`<home>/snapshots/<ISO>-before-migrate.db.gz`,
 * the rescue page's "restore the database" lists it). Null when nothing needs migrating. Throws when the copy cannot be
 * made: the caller must not migrate without a way back. Old snapshots are pruned by sb-rescue's next `snapshotDb`.
 */
export async function snapshotBeforeMigrate(path: string, home: string, now = new Date()): Promise<string | null> {
  if (!needsMigration(path)) return null;
  const dir = join(home, "snapshots");
  mkdirSync(dir, { recursive: true });
  const name = `${now.toISOString().replace(/[:.]/g, "-")}-before-migrate.db`;
  const copy = join(dir, `${name}.tmp`);
  const raw = join(dir, name);
  const part = `${raw}.gz.part`;
  const db = new Database(path);
  try {
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    renameSync(copy, raw);
    await pipeline(createReadStream(raw), createGzip({ level: constants.Z_BEST_SPEED }), createWriteStream(part));
    renameSync(part, `${raw}.gz`);
    rmSync(raw, { force: true });
  } catch (e) {
    for (const f of [copy, raw, part, `${raw}.gz`]) rmSync(f, { force: true });
    throw e;
  } finally {
    db.close();
  }
  return `${name}.gz`;
}

/**
 * The database of the daemon. Everything is reached from here, under the same names as before the file was cut:
 * `db/schema.ts` has the tables, `db/migrations/` one migration per file (`db/migrate.ts` runs them in the order of
 * `db/migrations/index.ts`), and the queries are methods of one class written across `db/<feature>.ts` — each file's
 * class extends the one before it (`DbCore` in `db/core.ts` first, `Db` here last), so a method's `this` and its types are
 * the plain class's, with no cast. A new query goes into the file of its feature and nowhere else.
 */
export class Db extends CliUpdateQueries {}

/**
 * Tasks still marked running / waiting when a daemon starts belonged to a daemon that is gone: no process can
 * answer for them. They are closed as aborted — the reason goes into session.end.summary (what the transcript shows
 * under 中断), open permission asks are resolved as denied by timeout so no tool row stays 承認待ち — so they neither
 * look alive in the UI nor sit in the queue — and the turn is planned to continue like one the shutdown cut
 * (interrupted.ts), up to `maxStopResumes` stops in a row. One transaction; returns the ids that were closed.
 */
export function abortOrphanedTasks(db: Db, now = Date.now(), maxStopResumes = MAX_STOP_RESUMES): string[] {
  const ids: string[] = [];
  db.sqlite.transaction(() => {
    // a runner's silence (and the hook it ran) ended with its process; the other waits stay as stored, and this daemon's wait watch looks at them again
    for (const t of db.listTasksWithWaits()) if (t.waits!.some((w) => w.kind === "output" || w.kind === "hook")) db.setTaskWaits(t.id, t.waits!.filter((w) => w.kind !== "output" && w.kind !== "hook"));
    for (const status of IN_FLIGHT) {
      for (const t of db.listTasksByStatus(status)) {
        if (t.executionMode === "cloud") {
          db.updateTask(t.id, { status: t.cloudSession ? "idle" : "error", runnerSessionId: null, resumeAt: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null });
          db.appendEvent(t.id, { t: "status", text: "前回の開始プロセスは終了しました。Cloud 作業の状態は未確認です。公式 Web で操作してください。" });
          ids.push(t.id); continue;
        }
        const open = new Set<string>();
        for (const e of db.listEvents(t.id)) {
          if (e.ev.t === "permission.ask") open.add(e.ev.id);
          else if (e.ev.t === "permission.resolved") open.delete(e.ev.id);
        }
        for (const id of open) db.appendEvent(t.id, { t: "permission.resolved", id, decision: "deny", by: "timeout" });
        const resume = t.runnerSessionId ? "返信すると同じセッションを再開します" : "返信すると新しいセッションで再開します";
        db.appendEvent(t.id, { t: "session.end", status: "aborted", summary: `前回のデーモンが終了したため中断扱い（${resume}）` });
        db.updateTask(t.id, { status: "aborted" });
        // a daemon that died without its shutdown (killed, the machine lost) cut the turn all the same; one whose
        // shutdown planned it already and was then killed mid-abort must not count the same stop twice
        if (t.resumeAt === null) planResumeAfterStop(db, t, now, (ev) => db.appendEvent(t.id, ev), maxStopResumes);
        ids.push(t.id);
      }
    }
    // a task whose turn ended waiting for background jobs is `background`, not running: they died with the daemon all the same.
    // A clean shutdown planned its resume already; a kill (oomd) did not.
    for (const r of db.sqlite.query("SELECT * FROM tasks WHERE background IS NOT NULL").all()) {
      const t = rowToTask(r);
      db.setTaskBackground(t.id, null);
      // the jobs were the wait: the turn itself had ended ok
      if (t.status === "background") db.updateTask(t.id, { status: "done" });
      else if (t.status !== "done" && t.status !== "error") continue;
      db.appendEvent(t.id, { t: "status", text: `裏で実行中の処理が前回のデーモンの終了で失われました: ${t.background?.jobs.join(" / ") || "内容不明"}` });
      if (t.resumeAt === null)
        planResumeAfterStop(db, t, now, (ev) => {
          db.appendEvent(t.id, ev);
          // the resumes ran out on a turn that had ended ok: the stop waits for the person, and the outcome says so (an aborted turn's is its status's)
          if (ev.t === "stop.record" && db.getTask(t.id)?.status === "done") db.updateTask(t.id, { outcome: "needs_action" });
        }, maxStopResumes);
      ids.push(t.id);
    }
  })();
  return ids;
}

/** The number of columns over all tables of a database (virtual tables and SQLite's own left out). */
function columnCount(sqlite: Database): number {
  const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'").all() as Array<{ name: string }>;
  return tables.reduce((n, t) => n + (sqlite.query(`SELECT count(*) AS n FROM pragma_table_info(?)`).get(t.name) as { n: number }).n, 0);
}

let codeLevel: number | null = null;

/**
 * The version of the database shape this code writes: the number of columns over all tables of an empty database that
 * got `SCHEMA` and `migrate` (the reference `needsMigration` uses). A migration only adds columns (schema.test.ts), so
 * newer code always has a bigger number, and no constant is raised by hand. It is the code's and not an open file's: a
 * long-used file keeps columns the code no longer declares, and after a rollback a file is ahead of the code that reads it.
 */
export function schemaLevel(): number {
  if (codeLevel === null) {
    const want = new Database(":memory:");
    try {
      want.exec(SCHEMA);
      migrate(want);
      codeLevel = columnCount(want);
    } finally {
      want.close();
    }
  }
  return codeLevel;
}
