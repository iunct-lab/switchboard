import { CloudSessionRef, HumanEval, JudgeEval, RuleEval, SizeClass } from "@switchboard/protocol";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentEvent, AskAnswerResult, Artifact, Attachment, BacklogAction, BacklogObjectKind, BacklogRecord, BacklogRepositoryKey, BacklogRepositorySync, BacklogSource, CheckRun, EvalSource, EvalsListRow, EventEnvelope, HistorySession, KnowledgeDoc, KnowledgeSearchHit, LedgerDaily, LedgerModelRow, LedgerRow, LedgerSummary, LedgerTaskRow, LoadKind, Journey, PerfSample, PerfSummaryRow, ReportRow, RoutingLogRow, RoutingStats, RunnerId, RunnerStats, Schedule, StagedChange, StopRecord, Task, TaskEvals, TaskOrigin, TaskOutcome, TaskStatus, Workspace } from "@switchboard/protocol";
import { teleportWorktreePath } from "./config.ts";
import { MAX_STOP_RESUMES, planResumeAfterStop } from "./interrupted.ts";
import { canTransition, InvalidTaskTransitionError, outcomeOnStatus } from "./task-status.ts";
import { backlogFieldValue, conflictRevision, mergeBacklogField } from "./backlog-merge.ts";
import type { ReportedTotal } from "./pricing.ts";

/** One record of an import (#885): `remote` is read only when `fetchState` is `fetched`. */
export type BacklogSnapshotEntry = BacklogRecord extends infer R ? (R extends BacklogRecord ? Pick<R, "objectKind" | "externalId" | "remote" | "fetchState"> : never) : never;

/**
 * One change to the backlog made here and not yet sent to the service (#886). `create` = a new Issue (`payload`: its
 * fields), `set` = one field of a record (`payload`: the value; `field` as `applyBacklogField` reads it), `comment` = a
 * new comment (`payload`: `{ body }`). `issue` = the Issue record it belongs to (`local:<uuid>` until it is created):
 * the operations of one Issue are sent in `seq` order, one after the other. `target` = the record it changes (the Issue,
 * one of its comments or Project items). `base` = the field's value the edit was made on (a `set` only): what is sent
 * is held when the service's value is no longer it.
 */
export type BacklogOperationKind = "create" | "set" | "comment";
/**
 * `pending` = waits to be sent; `sending` = a request is out; `unknown` = the request went out and its answer was lost
 * (a restart turns `sending` into this): looked for before anything is sent again; `conflict` = held, the service's
 * value moved since `base`; `failed` = not retried by itself (auth, permission, input); `done` = sent.
 */
export type BacklogOperationStatus = "pending" | "sending" | "unknown" | "conflict" | "failed" | "done";
/**
 * What the read after a write found in GitHub's edit history (#1329): another login's edit of the field between the
 * check and the write, which the write replaced. `value` absent = the revision's content is gone from the history (the
 * editor and the time stay), or `unreadable` = why the history could not be read (then nothing is known).
 */
export interface BacklogOverwritten { value?: unknown; editor: string | null; at: string | null; unreadable?: string }
export interface BacklogOperation extends BacklogRepositoryKey {
  seq: number;
  id: string;
  issue: string;
  targetKind: BacklogObjectKind;
  target: string;
  kind: BacklogOperationKind;
  field: string | null;
  payload: unknown;
  base: unknown;
  status: BacklogOperationStatus;
  attempt: number;
  /** Not sent again before this (ms); null = whenever. */
  retryAt: number | null;
  /** The service's id of what a `create` / `comment` made, once known. */
  remoteId: string | null;
  error: string | null;
  /** A conflict found after the write (#1329): kept until chosen on, whatever an import reads. */
  overwritten: BacklogOverwritten | null;
  createdAt: number;
  updatedAt: number;
}
/** An operation `applyBacklogEdit` queues (`id`: given, else a new UUID); `replace` = the id of a `pending` one of the same record and field whose payload this replaces instead. */
export type NewBacklogOperation = Pick<BacklogOperation, "issue" | "targetKind" | "target" | "kind" | "payload"> & { id?: string; field?: string; base?: unknown; replace?: string };
/** A choice on a conflict refused (#887); `status` = the HTTP status the API answers with. Nothing was changed. */
export class BacklogResolveError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}
/** A record's value after an edit; a record not stored yet (a new Issue or comment) is added as not fetched. */
export type BacklogLocalEntry = { objectKind: BacklogObjectKind; externalId: string; local: unknown };

/**
 * Applies a `set` operation's `value` to a copy of a record's data (#886): an Issue's `title` / `body` / `state` /
 * `milestone` / `parent`, or `label:<name>` (true = on, false = off); a Project item's `field:<name>`. `member` (a
 * Project item in the Project or not) changes no value. Anything else is refused.
 */
export function applyBacklogField(kind: BacklogObjectKind, data: unknown, field: string, value: unknown): unknown {
  if (!isBacklogField(kind, field)) throw new Error(`a ${kind} has no field ${field}`);
  const d = structuredClone(data) as Record<string, any>;
  if (field.startsWith("label:")) {
    const name = field.slice("label:".length);
    d.labels = value ? [...new Set([...(d.labels ?? []), name])] : (d.labels ?? []).filter((l: string) => l !== name);
  } else if (field.startsWith("field:")) d.fields = { ...d.fields, [field.slice("field:".length)]: value };
  else if (field !== "member") d[field] = value;
  return d;
}

const isBacklogField = (kind: BacklogObjectKind, field: string | undefined): field is string =>
  !!field && (kind === "issue" ? /^label:./.test(field) || ["title", "body", "state", "milestone", "parent"].includes(field) : kind === "project-item" && (/^field:./.test(field) || field === "member"));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL,
  scope TEXT NOT NULL, status TEXT NOT NULL, runner_session_id TEXT, model TEXT, routing TEXT, budget_usd REAL, schedule_id TEXT,
  permission_mode TEXT, effort TEXT, origin TEXT NOT NULL DEFAULT 'switchboard', resume_at INTEGER, resume_reason TEXT, shadow_of TEXT, shadow_stopped INTEGER NOT NULL DEFAULT 0, workspace_reason TEXT,
  outcome TEXT NOT NULL DEFAULT 'unknown', reviewed_at INTEGER, archived_at INTEGER, judged_result TEXT, judged_reason TEXT, judged_by TEXT, judging_at INTEGER, stage_issue INTEGER, stage_action TEXT,
  status_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, cron TEXT NOT NULL, workspace_id TEXT NOT NULL, runner TEXT NOT NULL, prompt TEXT NOT NULL,
  budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_task_id TEXT, next_run_at INTEGER, created_at INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT 'prompt', model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, runner TEXT NOT NULL, model TEXT,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL, billed_usd REAL NOT NULL DEFAULT 0, source TEXT NOT NULL, ts INTEGER NOT NULL, reported_total TEXT
);
CREATE INDEX IF NOT EXISTS ledger_ts ON ledger (ts);
CREATE INDEX IF NOT EXISTS ledger_task ON ledger (task_id);
CREATE TABLE IF NOT EXISTS routing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, workspace_id TEXT, cwd TEXT NOT NULL,
  suggested TEXT NOT NULL, rule_id TEXT NOT NULL, reason TEXT NOT NULL, chosen TEXT NOT NULL, ts INTEGER NOT NULL,
  suggested_by TEXT NOT NULL DEFAULT 'rule'
);
CREATE INDEX IF NOT EXISTS routing_log_task ON routing_log (task_id);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  path TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, frontmatter TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(path UNINDEXED, title, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS staging (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL, rel TEXT NOT NULL, kind TEXT NOT NULL,
  before_text TEXT, after_text TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, decided_at INTEGER,
  diff_text TEXT NOT NULL DEFAULT '', stat TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS staging_task ON staging (task_id);
CREATE INDEX IF NOT EXISTS staging_status ON staging (status);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
CREATE TABLE IF NOT EXISTS check_runs (
  task_id TEXT PRIMARY KEY, ok INTEGER NOT NULL, json TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history_imports (
  session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL, offset INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT '', imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_imports_task ON history_imports (task_id);
CREATE INDEX IF NOT EXISTS tasks_session ON tasks (runner, runner_session_id);
CREATE TABLE IF NOT EXISTS quota (
  runner TEXT NOT NULL, window TEXT NOT NULL, utilization REAL NOT NULL, resets_at INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (runner, window)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, task_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_task ON attachments (task_id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, entry TEXT, mime TEXT NOT NULL,
  size INTEGER NOT NULL, removed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts (task_id);
CREATE TABLE IF NOT EXISTS perf_samples (
  ts INTEGER NOT NULL, journey TEXT NOT NULL, device TEXT NOT NULL, build TEXT NOT NULL, ms REAL NOT NULL, task_id TEXT, bytes INTEGER, events INTEGER
);
CREATE INDEX IF NOT EXISTS perf_samples_ts ON perf_samples (ts);
CREATE TABLE IF NOT EXISTS backlog_records (
  service TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, object_kind TEXT NOT NULL, external_id TEXT NOT NULL,
  remote TEXT, base TEXT, local TEXT, fetched_at INTEGER, fetch_state TEXT NOT NULL,
  PRIMARY KEY (service, host, repository, object_kind, external_id)
);
CREATE TABLE IF NOT EXISTS backlog_repositories (
  service TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, cursor TEXT, last_successful_sync INTEGER, retry_at INTEGER,
  PRIMARY KEY (service, host, repository)
);
CREATE TABLE IF NOT EXISTS backlog_operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, service TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL,
  issue TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, field TEXT, payload TEXT NOT NULL, base TEXT,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, remote_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, overwritten TEXT
);
CREATE INDEX IF NOT EXISTS backlog_operations_issue ON backlog_operations (service, host, repository, issue);
CREATE TABLE IF NOT EXISTS task_evals (
  task_id TEXT NOT NULL, source TEXT NOT NULL, by TEXT NOT NULL, rubric TEXT, json TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (task_id, source)
);
CREATE TABLE IF NOT EXISTS ask_answers (id TEXT PRIMARY KEY, at INTEGER NOT NULL, result TEXT, failure TEXT);
-- #1755 (local passkeys) was reverted; the table stays empty and unused because migrations only add (schema.test.ts, releases-and-rescue.md)
CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, rp_id TEXT NOT NULL, public_key TEXT NOT NULL, algorithm INTEGER NOT NULL, counter INTEGER NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
-- one row per daemon start (#2085, ops-stops.ts): the stopping daemon writes clean_exit / ended_at, the next start end_reason
CREATE TABLE IF NOT EXISTS daemon_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, end_detail TEXT, clean_exit TEXT,
  version TEXT, boot_id TEXT, interrupted_task_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS daemon_runs_ended ON daemon_runs (ended_at);
-- the host's load once a minute (#2086, ops-load.ts): the unit's cgroup, and task × owner × kind of its processes. 7 days
CREATE TABLE IF NOT EXISTS ops_load (
  ts INTEGER PRIMARY KEY, mem_current INTEGER NOT NULL, mem_max INTEGER, swap_current INTEGER NOT NULL, events_max INTEGER NOT NULL,
  cpu_pct REAL, pressure_some REAL, pressure_full REAL, docker_mem INTEGER, top TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_load_groups (
  ts INTEGER NOT NULL, task_id TEXT, owner TEXT NOT NULL, kind TEXT NOT NULL, rss INTEGER NOT NULL, cpu_ms INTEGER NOT NULL, procs INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_load_groups_ts ON ops_load_groups (ts);
-- one row per API request (#2101): the route as guardAll keys it (/api/tasks/:id), until the handler's Response. 7 days
CREATE TABLE IF NOT EXISTS api_requests (
  ts INTEGER NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, ms REAL NOT NULL, bytes INTEGER
);
CREATE INDEX IF NOT EXISTS api_requests_ts ON api_requests (ts);
`;

/** Wait out the write lock Litestream's checkpoint takes for a moment, instead of failing with SQLITE_BUSY (#688). */
const BUSY_TIMEOUT_MS = 5000;

/** How long the everyday journey timings are kept (#639): older rows go when new ones are saved. */
const PERF_KEEP_MS = 30 * 24 * 3600 * 1000;
/** The speed table's period (#2103): the last 7 days against the 7 before them. */
const PERF_PERIOD_MS = 7 * 24 * 3600 * 1000;
const OPS_LOAD_KEEP_MS = 7 * 24 * 3600 * 1000;
const API_REQUESTS_KEEP_MS = 7 * 24 * 3600 * 1000;
/** A row of api_requests (#2101). `bytes` = the response's content-length, null when it has none. */
export type ApiRequestRow = { ts: number; method: string; route: string; status: number; ms: number; bytes: number | null };
/** A row of ops_load (#2086): the unit's cgroup at one minute; `top` is the JSON of the 10 largest processes. */
export type OpsLoadRow = { memCurrent: number; memMax: number | null; swapCurrent: number; eventsMax: number; cpuPct: number | null; pressureSome: number | null; pressureFull: number | null; dockerMem: number | null; top: string };
export type OpsLoadGroupRow = { taskId: string | null; owner: "task" | "daemon" | "other"; kind: LoadKind; rssBytes: number; cpuMs: number; procs: number };

/**
 * What a routed task cost and how long it took, for a query over `routing_log r JOIN tasks t` (#25, #612). The
 * duration runs to the task's last event rather than `updated_at` (see `routingLog`), clamped at 0.
 */
const TASK_COST_SQL = "COALESCE((SELECT SUM(cost_usd) FROM ledger l WHERE l.task_id = r.task_id), 0)";
const TASK_DURATION_SQL = "MAX(COALESCE((SELECT MAX(ts) FROM events e WHERE e.task_id = r.task_id), t.updated_at) - t.created_at, 0)";

/** One evaluation of a task (#1218): `json` is a `RuleEval` for `rules`; `rubric` names the rubric and version a judge used (#1219), null otherwise. */
export interface EvalRow {
  taskId: string;
  source: EvalSource;
  by: string;
  rubric: string | null;
  json: unknown;
  ts: number;
}

/**
 * The Switchboard Tasks of these workspaces that worked on these Issues (#650): a stage Task of the Issue (`stage_issue`) or a Task whose
 * title starts `#N `. Issue numbers repeat across repositories, so the workspaces (of the repository read) say whose they are.
 * Reads only, so the caller may open the file read-only. `durationMs` is the same creation → last event as routingLog's.
 */
export function tasksOfIssues(sqlite: Database, issues: number[], workspaceIds: string[]): Array<{ id: string; createdAt: number; durationMs: number; costUsd: number }> {
  if (issues.length === 0 || workspaceIds.length === 0) return [];
  const marks = issues.map(() => "?").join(",");
  const titles = issues.map(() => "t.title LIKE ?").join(" OR ");
  return sqlite
    .query(
      `SELECT t.id AS id, t.created_at AS createdAt,
              MAX(COALESCE((SELECT MAX(ts) FROM events e WHERE e.task_id = t.id), t.updated_at) - t.created_at, 0) AS durationMs,
              COALESCE((SELECT SUM(cost_usd) FROM ledger l WHERE l.task_id = t.id), 0) AS costUsd
       FROM tasks t WHERE t.workspace_id IN (${workspaceIds.map(() => "?").join(",")}) AND (t.stage_issue IN (${marks}) OR ${titles}) ORDER BY t.created_at`,
    )
    .all(...workspaceIds, ...issues, ...issues.map((n) => `#${n} %`)) as Array<{ id: string; createdAt: number; durationMs: number; costUsd: number }>;
}

/** The most events one page of a Task's conversation returns (#1142): `limit` is clamped to it, and a page that reaches back to a message's start stops there. */
export const EVENTS_PAGE_MAX = 5000;

export class Db {
  readonly sqlite: Database;

  constructor(path: string) {
    this.sqlite = new Database(path, { create: true });
    this.sqlite.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
    // Only a database with no tables yet takes this; an older file is switched once below.
    this.sqlite.exec("PRAGMA auto_vacuum = INCREMENTAL");
    this.sqlite.exec(SCHEMA);
    migrate(this.sqlite);
    // #1431: the events archive frees pages with `incremental_vacuum`, which only a file in INCREMENTAL mode gives back.
    // The mode of an existing file changes only with a VACUUM; once, before the daemon answers.
    if ((this.sqlite.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum !== 2) this.sqlite.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM");
  }

  close() {
    this.sqlite.close();
  }

  /** A consistent copy of the database at `path` (VACUUM INTO reads through the WAL), as sb-rescue's snapshotDb does. */
  snapshotTo(path: string) {
    this.sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  /* ---------- workspaces ---------- */

  listWorkspaces(): Workspace[] {
    return this.sqlite.query("SELECT * FROM workspaces ORDER BY kind DESC, name").all().map(rowToWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const r = this.sqlite.query("SELECT * FROM workspaces WHERE id = ?").get(id);
    return r ? rowToWorkspace(r) : null;
  }

  /** `backlog` is not stored as such: it is read from the workspace's backlog source (#2265, setWorkspaceBacklogSource). */
  upsertWorkspace(ws: Omit<Workspace, "id" | "createdAt" | "backlog"> & { id?: string }): Workspace {
    const existing = this.sqlite.query("SELECT * FROM workspaces WHERE path = ?").get(ws.path);
    if (existing) {
      this.sqlite.query("UPDATE workspaces SET name = ?, kind = ? WHERE path = ?").run(ws.name, ws.kind, ws.path);
      return rowToWorkspace(this.sqlite.query("SELECT * FROM workspaces WHERE path = ?").get(ws.path));
    }
    const row: Workspace = { id: ws.id ?? newId("ws"), name: ws.name, path: ws.path, kind: ws.kind, createdAt: Date.now(), backlog: "github" };
    this.sqlite.query("INSERT INTO workspaces (id, name, path, kind, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, row.name, row.path, row.kind, row.createdAt);
    return row;
  }

  /**
   * The repository variable the backlog reads the Project URL from; null = back to SWITCHBOARD_PROJECT_URL. The stored
   * backlog's source goes with it (#885): the workspace reads as not imported until an import reads the new Project.
   * A workspace whose backlog is kept here only (#2265) has no Project variable: the caller refuses it first.
   */
  setWorkspaceProjectVar(id: string, name: string | null): Workspace | null {
    this.sqlite.query("UPDATE workspaces SET project_var = ?, backlog_source = NULL WHERE id = ?").run(name, id);
    return this.getWorkspace(id);
  }

  /* ---------- stored backlog (#885) ---------- */

  /**
   * Stores one complete import of a repository in one transaction: each entry's record, then the repository's cursor
   * and `lastSuccessfulSync` (`retryAt` cleared). Call it only when every page was read — a failed import stores
   * nothing, so what was stored before stays. A `fetched` entry replaces `remote` (and `base`, unless an edit is
   * waiting in `local`); any other state only marks the record and keeps the `remote` it had. Records not in the
   * snapshot are left as they are: telling a closed or removed one apart is the importer's (it passes their state).
   */
  putBacklogSnapshot(repo: BacklogRepositoryKey, snap: { records: BacklogSnapshotEntry[]; cursor: string | null; syncedAt: number }): void {
    const key = [repo.service, repo.host, repo.repository] as const;
    const fetched = this.sqlite.query(
      `INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'fetched')
       ON CONFLICT (service, host, repository, object_kind, external_id) DO UPDATE SET remote = excluded.remote, base = CASE WHEN local IS NULL THEN excluded.base ELSE base END, fetched_at = excluded.fetched_at, fetch_state = 'fetched'`,
    );
    const marked = this.sqlite.query(
      `INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT (service, host, repository, object_kind, external_id) DO UPDATE SET fetch_state = excluded.fetch_state`,
    );
    this.sqlite.transaction(() => {
      for (const r of snap.records) {
        if (r.fetchState !== "fetched") marked.run(...key, r.objectKind, r.externalId, r.fetchState);
        else if (!r.remote) throw new Error(`a fetched ${r.objectKind} ${r.externalId} has no value`);
        else fetched.run(...key, r.objectKind, r.externalId, JSON.stringify(r.remote), JSON.stringify(r.remote), snap.syncedAt);
      }
      for (const r of snap.records) if (r.fetchState === "fetched") this.mergeBacklogRecord(repo, r.objectKind, r.externalId, r.remote, snap.syncedAt);
      // an edit waiting to be sent (#886) shows on top of what was read: the fields it does not change follow the service
      for (const r of this.sqlite.query("SELECT object_kind, external_id FROM backlog_records r WHERE service = ?1 AND host = ?2 AND repository = ?3 AND remote IS NOT NULL AND (local IS NOT NULL OR EXISTS (SELECT 1 FROM backlog_operations o WHERE o.service = ?1 AND o.host = ?2 AND o.repository = ?3 AND o.target_kind = r.object_kind AND o.target = r.external_id AND o.kind = 'set' AND o.status != 'done'))").all(...key) as Array<{ object_kind: BacklogObjectKind; external_id: string }>)
        this.rebaseBacklogRecord(repo, r.object_kind, r.external_id);
      this.sqlite
        .query(`INSERT INTO backlog_repositories (service, host, repository, cursor, last_successful_sync, retry_at) VALUES (?, ?, ?, ?, ?, NULL)
                ON CONFLICT (service, host, repository) DO UPDATE SET cursor = excluded.cursor, last_successful_sync = excluded.last_successful_sync, retry_at = NULL`)
        .run(...key, snap.cursor, snap.syncedAt);
    })();
  }

  /** After a failed import: not before `retryAt` (ms). The cursor and `lastSuccessfulSync` stay where the last complete import left them. */
  setBacklogRetryAt(repo: BacklogRepositoryKey, retryAt: number | null): void {
    this.sqlite
      .query(`INSERT INTO backlog_repositories (service, host, repository, cursor, last_successful_sync, retry_at) VALUES (?, ?, ?, NULL, NULL, ?)
              ON CONFLICT (service, host, repository) DO UPDATE SET retry_at = excluded.retry_at`)
      .run(repo.service, repo.host, repo.repository, retryAt);
  }

  /** What the last import of a workspace read (#885); null = never imported. */
  getWorkspaceBacklogSource(id: string): BacklogSource | null {
    const r = this.sqlite.query("SELECT backlog_source FROM workspaces WHERE id = ?").get(id) as { backlog_source: string | null } | null;
    return r?.backlog_source ? JSON.parse(r.backlog_source) : null;
  }

  setWorkspaceBacklogSource(id: string, source: BacklogSource): void {
    this.sqlite.query("UPDATE workspaces SET backlog_source = ? WHERE id = ?").run(JSON.stringify(source), id);
  }

  /**
   * Moves a repository's stored records and operations under another key (#2266: a backlog kept here only, turned to
   * GitHub). The ids do not meet: the records made here are `sb:` ones, GitHub's are its node ids. What is known of the
   * old repository's reads goes with it (the new one has its own).
   */
  moveBacklogRecords(from: BacklogRepositoryKey, to: BacklogRepositoryKey): void {
    for (const table of ["backlog_records", "backlog_operations"])
      this.sqlite.query(`UPDATE ${table} SET service = ?, host = ?, repository = ? WHERE service = ? AND host = ? AND repository = ?`).run(to.service, to.host, to.repository, from.service, from.host, from.repository);
    this.sqlite.query("DELETE FROM backlog_repositories WHERE service = ? AND host = ? AND repository = ?").run(from.service, from.host, from.repository);
  }

  /** A record's value as the service has it, written without a read (#2266: a comment made here moved to its Issue's new number); the repository's read state is not touched. */
  setBacklogRecordRemote(key: BacklogRepositoryKey & { objectKind: BacklogObjectKind; externalId: string }, remote: unknown): void {
    this.sqlite.query("UPDATE backlog_records SET remote = ?1, base = CASE WHEN local IS NULL THEN ?1 ELSE base END WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?")
      .run(JSON.stringify(remote), key.service, key.host, key.repository, key.objectKind, key.externalId);
  }

  deleteBacklogRecord(key: BacklogRepositoryKey & { objectKind: BacklogObjectKind; externalId: string }): void {
    this.sqlite.query("DELETE FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?").run(key.service, key.host, key.repository, key.objectKind, key.externalId);
  }

  /** The stage Tasks of a workspace made before `before` (ms) on Issue `from` go to `to` (#2266), all at once (a `to` that is another's `from` is not moved twice). */
  renumberStageIssues(workspaceId: string, numbers: Array<{ from: number; to: number }>, before: number): void {
    const ids = numbers.map((n) => ({ ...n, tasks: this.sqlite.query("SELECT id FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND created_at < ?").all(workspaceId, n.from, before) as Array<{ id: string }> }));
    for (const n of ids) for (const t of n.tasks) this.sqlite.query("UPDATE tasks SET stage_issue = ? WHERE id = ?").run(n.to, t.id);
  }

  getBacklogRepository(repo: BacklogRepositoryKey): BacklogRepositorySync | null {
    const r = this.sqlite.query("SELECT * FROM backlog_repositories WHERE service = ? AND host = ? AND repository = ?").get(repo.service, repo.host, repo.repository) as any;
    return r ? { service: r.service, host: r.host, repository: r.repository, cursor: r.cursor, lastSuccessfulSync: r.last_successful_sync, retryAt: r.retry_at } : null;
  }

  /** A repository's records, of one kind when `kind` is given. */
  listBacklogRecords(repo: BacklogRepositoryKey, kind?: BacklogObjectKind): BacklogRecord[] {
    return this.sqlite
      .query("SELECT * FROM backlog_records WHERE service = ?1 AND host = ?2 AND repository = ?3 AND (?4 IS NULL OR object_kind = ?4) ORDER BY object_kind, external_id")
      .all(repo.service, repo.host, repo.repository, kind ?? null)
      .map(rowToBacklogRecord);
  }

  getBacklogRecord(key: BacklogRepositoryKey & { objectKind: BacklogObjectKind; externalId: string }): BacklogRecord | null {
    const r = this.sqlite
      .query("SELECT * FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?")
      .get(key.service, key.host, key.repository, key.objectKind, key.externalId);
    return r ? rowToBacklogRecord(r) : null;
  }

  /* ---------- backlog edits waiting to be sent (#886) ---------- */

  /**
   * Stores an edit in one transaction: the records' `local` values and the operations that send it — both or
   * neither. `records` gives the value of a record the service does not have yet (a new Issue or comment); one it has
   * shows its `set` operations on top of its `remote` (rebaseBacklogRecord), whatever `local` is passed for it. A `set`
   * of a field `applyBacklogField` does not know is refused. A `set` replaces the value of the newest `pending` one of the same field of the same record, unless a
   * `create` or `comment` of the Issue was queued after that one (it is sent after them, so a label taken off after an
   * answer stays after it); a `comment` and a `create` are never merged. Returns the ids of the operations (merged into
   * or new), in order. Throws when a `replace` names one no longer pending.
   */
  applyBacklogEdit(repo: BacklogRepositoryKey, edit: { records: BacklogLocalEntry[]; operations: NewBacklogOperation[] }, now = Date.now()): string[] {
    const key = [repo.service, repo.host, repo.repository] as const;
    return this.sqlite.transaction(() => {
      for (const r of edit.records)
        this.sqlite
          .query(`INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 'unfetched')
                  ON CONFLICT (service, host, repository, object_kind, external_id) DO UPDATE SET local = excluded.local`)
          .run(...key, r.objectKind, r.externalId, JSON.stringify(r.local));
      const ids = edit.operations.map((op) => {
        const payload = JSON.stringify(op.payload);
        // a field no import could apply would make every later import of the repository fail
        if (op.kind === "set" && !isBacklogField(op.targetKind, op.field)) throw new Error(`a ${op.targetKind} has no field ${op.field}`);
        if (op.replace) {
          if (this.sqlite.query("UPDATE backlog_operations SET payload = ?, updated_at = ? WHERE id = ? AND service = ? AND host = ? AND repository = ? AND issue = ? AND target_kind = ? AND target = ? AND kind = ? AND field IS ? AND status = 'pending'").run(payload, now, op.replace, ...key, op.issue, op.targetKind, op.target, op.kind, op.field ?? null).changes !== 1)
            throw new Error(`operation ${op.replace} is no longer pending`);
          return op.replace;
        }
        if (op.kind === "set") {
          const last = this.sqlite
            .query(`SELECT seq, id FROM backlog_operations o WHERE service = ?1 AND host = ?2 AND repository = ?3 AND issue = ?4 AND target_kind = ?5 AND target = ?6 AND kind = 'set' AND field = ?7 AND status = 'pending'
                      AND NOT EXISTS (SELECT 1 FROM backlog_operations l WHERE l.service = ?1 AND l.host = ?2 AND l.repository = ?3 AND l.issue = ?4 AND l.kind != 'set' AND l.seq > o.seq)
                    ORDER BY seq DESC LIMIT 1`)
            .get(...key, op.issue, op.targetKind, op.target, op.field ?? null) as { seq: number; id: string } | null;
          if (last) {
            this.sqlite.query("UPDATE backlog_operations SET payload = ?, updated_at = ? WHERE seq = ?").run(payload, now, last.seq);
            return last.id;
          }
        }
        const id = op.id ?? crypto.randomUUID();
        this.sqlite
          .query(`INSERT INTO backlog_operations (id, service, host, repository, issue, target_kind, target, kind, field, payload, base, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(id, ...key, op.issue, op.targetKind, op.target, op.kind, op.field ?? null, payload, op.kind === "set" ? JSON.stringify(op.base ?? null) : null, now, now);
        return id;
      });
      // a record the service has shows its operations on top of it, whatever `local` the caller wrote
      for (const op of edit.operations) if (op.kind === "set") this.rebaseBacklogRecord(repo, op.targetKind, op.target);
      return ids;
    })();
  }

  /**
   * When the sender starts (the daemon, not every opener of the file — `main.ts export` opens it while the daemon runs):
   * a request that was out when the daemon stopped may have been carried out, so it is looked for before it is sent again.
   */
  recoverBacklogOperations(): void {
    this.sqlite.exec("UPDATE backlog_operations SET status = 'unknown' WHERE status = 'sending'");
  }

  /**
   * What an answer to a question did (#1139), by the question's id: `result` (what the answer answered, null while only a failed
   * start is known) and `failure` (a start that failed after the answer). A field not passed keeps its value.
   */
  rememberAskAnswer(id: string, row: { at: number; result?: AskAnswerResult | null; failure?: { at: number; reason: string } | null }): void {
    const had = this.askAnswer(id);
    const result = row.result === undefined ? (had?.result ?? null) : row.result;
    const failure = row.failure === undefined ? (had?.failure ?? null) : row.failure;
    this.sqlite
      .query("INSERT INTO ask_answers (id, at, result, failure) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, result = excluded.result, failure = excluded.failure")
      .run(id, row.at, result ? JSON.stringify(result) : null, failure ? JSON.stringify(failure) : null);
  }

  askAnswer(id: string): { at: number; result: AskAnswerResult | null; failure: { at: number; reason: string } | null } | null {
    const r = this.sqlite.query("SELECT at, result, failure FROM ask_answers WHERE id = ?").get(id) as { at: number; result: string | null; failure: string | null } | null;
    return r ? { at: r.at, result: r.result ? (JSON.parse(r.result) as AskAnswerResult) : null, failure: r.failure ? (JSON.parse(r.failure) as { at: number; reason: string }) : null } : null;
  }

  /** Forgets the answers older than `before` (ms). */
  pruneAskAnswers(before: number): void {
    this.sqlite.query("DELETE FROM ask_answers WHERE at < ?").run(before);
  }

  /** A waiting operation's payload, rewritten (#2266: its `#N` to GitHub's numbers). */
  setBacklogOperationPayload(id: string, payload: unknown, now = Date.now()): void {
    this.sqlite.query("UPDATE backlog_operations SET payload = ?, updated_at = ? WHERE id = ? AND status != 'done'").run(JSON.stringify(payload), now, id);
  }

  /** Every operation of a repository, done ones too, oldest first. */
  listBacklogOperations(repo: BacklogRepositoryKey): BacklogOperation[] {
    return this.sqlite.query("SELECT * FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? ORDER BY seq").all(repo.service, repo.host, repo.repository).map(rowToBacklogOperation);
  }

  /** The operations not sent yet (every status but `done`), of one repository or of all, oldest first. */
  listPendingBacklogOperations(repo?: BacklogRepositoryKey): BacklogOperation[] {
    return this.sqlite
      .query("SELECT * FROM backlog_operations WHERE status != 'done' AND (?1 IS NULL OR (service = ?1 AND host = ?2 AND repository = ?3)) ORDER BY seq")
      .all(repo?.service ?? null, repo?.host ?? null, repo?.repository ?? null)
      .map(rowToBacklogOperation);
  }

  getBacklogOperation(id: string): BacklogOperation | null {
    const r = this.sqlite.query("SELECT * FROM backlog_operations WHERE id = ?").get(id);
    return r ? rowToBacklogOperation(r) : null;
  }

  /**
   * Records what came of sending an operation, in one transaction. `record` = what the service now has for its
   * target: stored as `remote` and `base` (a `local:<uuid>` record takes the service's id `externalId`, and the
   * operations that name it follow), and `local` is the operations still to send applied to it (none = null).
   * `follow` = operations queued after it (what a `create` sends next: its Project item, parent).
   */
  setBacklogOperationResult(
    id: string,
    result: { status: BacklogOperationStatus; attempt?: number; retryAt?: number | null; remoteId?: string | null; error?: string | null; overwritten?: BacklogOverwritten | null; record?: { externalId: string; remote: unknown }; follow?: NewBacklogOperation[] },
    now = Date.now(),
  ): void {
    this.sqlite.transaction(() => {
      const op = this.getBacklogOperation(id);
      if (!op) throw new Error(`no operation ${id}`);
      const overwritten = result.overwritten === undefined ? op.overwritten : result.overwritten;
      this.sqlite
        .query("UPDATE backlog_operations SET status = ?, attempt = ?, retry_at = ?, remote_id = ?, error = ?, overwritten = ?, updated_at = ? WHERE id = ?")
        .run(result.status, result.attempt ?? op.attempt, result.retryAt === undefined ? op.retryAt : result.retryAt, result.remoteId === undefined ? op.remoteId : result.remoteId, result.error === undefined ? op.error : result.error, overwritten === null ? null : JSON.stringify(overwritten), now, id);
      if (result.record) {
        const key = [op.service, op.host, op.repository] as const;
        const to = result.record.externalId;
        if (to !== op.target) {
          // an import may have stored the service's record first: that one stays, the local one goes
          if (this.getBacklogRecord({ ...op, objectKind: op.targetKind, externalId: to }))
            this.sqlite.query("DELETE FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?").run(...key, op.targetKind, op.target);
          else this.sqlite.query("UPDATE backlog_records SET external_id = ? WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?").run(to, ...key, op.targetKind, op.target);
          this.sqlite.query("UPDATE backlog_operations SET target = ? WHERE service = ? AND host = ? AND repository = ? AND target_kind = ? AND target = ?").run(to, ...key, op.targetKind, op.target);
          if (op.targetKind === "issue") this.sqlite.query("UPDATE backlog_operations SET issue = ? WHERE service = ? AND host = ? AND repository = ? AND issue = ?").run(to, ...key, op.target);
        }
        this.sqlite
          .query("UPDATE backlog_records SET remote = ?1, base = ?1, fetched_at = ?2, fetch_state = 'fetched' WHERE service = ?3 AND host = ?4 AND repository = ?5 AND object_kind = ?6 AND external_id = ?7")
          .run(JSON.stringify(result.record.remote), now, ...key, op.targetKind, to);
        this.rebaseBacklogRecord(op, op.targetKind, to);
      }
      if (result.follow?.length) this.applyBacklogEdit(op, { records: [], operations: result.follow }, now);
    })();
  }

  /**
   * What an import read decides about the edits of a record waiting to be sent (#887, 初期方式 A): per field, the
   * first `pending` set of it (one after it was made on the value the first one sends, not on GitHub's) against
   * GitHub's value — already that value, or the edit changed nothing GitHub did not → done; GitHub moved it off the
   * value the edit was made on to another one → `conflict`, held with its base, its value and GitHub's (nothing is
   * written to GitHub); a conflict whose value GitHub came to → done. The rest still go, checked again just before they are written (backlog-send.ts).
   */
  private mergeBacklogRecord(repo: BacklogRepositoryKey, kind: BacklogObjectKind, externalId: string, remote: unknown, now: number): void {
    const ops = this.sqlite
      .query("SELECT * FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? AND target_kind = ? AND target = ? AND kind = 'set' AND status != 'done' ORDER BY seq")
      .all(repo.service, repo.host, repo.repository, kind, externalId)
      .map(rowToBacklogOperation);
    const seen = new Set<string>();
    for (const op of ops) {
      if (seen.has(op.field!)) continue;
      seen.add(op.field!);
      const value = backlogFieldValue(kind, remote, op.field!);
      if ((op.status !== "pending" && op.status !== "conflict") || value === undefined) continue;
      // a conflict the write itself found (#1329): GitHub has the value made here, so a read of it decides nothing —
      // it stays, with its reason, until chosen on
      if (op.status === "conflict" && op.overwritten) continue;
      const m = mergeBacklogField(op.field!, op.base, op.payload, value);
      if (m === "local" && op.status === "pending") continue;
      // a conflict stays one until it is chosen on, or GitHub comes to the value made here; its reason names GitHub's
      // value now, whatever it moved to (back to the base too)
      const conflict = m === "conflict" || (op.status === "conflict" && m !== "synced");
      const error = conflict ? `取り込んだ GitHub の値が編集の元から変わっています（${op.field}: GitHub は ${JSON.stringify(value)}）` : null;
      if (conflict && op.status === "conflict" && op.error === error) continue;
      this.sqlite.query("UPDATE backlog_operations SET status = ?, error = ?, retry_at = NULL, updated_at = ? WHERE seq = ?").run(conflict ? "conflict" : "done", error, now, op.seq);
    }
  }

  /**
   * The user's choice on a held `set` (#887): `local` sends the value made here again, now made on GitHub's value
   * (checked again just before it is written); `remote` keeps GitHub's and drops the edit. `revision` = what the
   * choice saw (conflictRevision of the operation and GitHub's value as stored): another one now → 409, nothing
   * changed. Throws BacklogResolveError: 404 = no such operation of the repository, 409 = not a conflict, the revision
   * is old, or GitHub's value is not read (sending the local value needs it).
   */
  resolveBacklogConflict(repo: BacklogRepositoryKey, id: string, choice: "local" | "remote", revision: string, now = Date.now()): void {
    this.sqlite.transaction(() => {
      const op = this.getBacklogOperation(id);
      if (!op || op.service !== repo.service || op.host !== repo.host || op.repository !== repo.repository) throw new BacklogResolveError(`操作 ${id} はありません`, 404);
      if (op.kind !== "set" || op.status !== "conflict") throw new BacklogResolveError("この操作は競合で保留されていません", 409);
      const value = this.backlogRemoteValue(op);
      if (conflictRevision(op, value) !== revision) throw new BacklogResolveError("競合がこの画面を開いた後に変わりました。読み直してから選んでください", 409);
      if (choice === "local" && value === undefined) throw new BacklogResolveError("GitHub の値を読めていないので、手元の値は送れません。再読込してから選んでください", 409);
      if (op.overwritten) {
        // found after the write (#1329): GitHub has the value made here. Remote = the other's value goes back as a
        // new set on GitHub's current value; local = the edit goes on at GitHub's value (the check will find it done)
        if (choice === "remote" && !("value" in op.overwritten)) throw new BacklogResolveError("相手の値が履歴に残っていないので戻せません。手元を選ぶと今の GitHub の値のまま閉じます", 409);
        if (value === undefined) throw new BacklogResolveError("GitHub の値を読めていないので選べません。再読込してから選んでください", 409);
        this.sqlite
          .query("UPDATE backlog_operations SET status = 'pending', payload = ?, base = ?, attempt = 0, retry_at = NULL, error = NULL, overwritten = NULL, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(choice === "remote" ? op.overwritten.value : op.payload), JSON.stringify(value), now, id);
        this.rebaseBacklogRecord(repo, op.targetKind, op.target);
        return;
      }
      const update = this.sqlite.query("UPDATE backlog_operations SET status = ?, base = ?, attempt = 0, retry_at = NULL, error = ?, updated_at = ? WHERE id = ?");
      if (choice === "local") update.run("pending", JSON.stringify(value), null, now, id);
      else update.run("done", JSON.stringify(op.base ?? null), "GitHub の値を選んだので送りません", now, id);
      this.rebaseBacklogRecord(repo, op.targetKind, op.target);
    })();
  }

  /** GitHub's value of a `set`'s field as last imported (#887); undefined = not read (never, or 404 / 403 on the last read). */
  backlogRemoteValue(op: BacklogOperation): unknown {
    const rec = op.field ? this.getBacklogRecord({ ...op, objectKind: op.targetKind, externalId: op.target }) : null;
    return rec?.fetchState === "fetched" ? backlogFieldValue(op.targetKind, rec.remote, op.field!) : undefined;
  }

  /** `local` of a record that has a `remote`: the `set` operations still to send applied to it in order; none = null (and `base` = `remote`). */
  private rebaseBacklogRecord(repo: BacklogRepositoryKey, kind: BacklogObjectKind, externalId: string): void {
    const key = [repo.service, repo.host, repo.repository] as const;
    const r = this.getBacklogRecord({ ...repo, objectKind: kind, externalId });
    if (!r?.remote) return;
    const ops = this.sqlite
      .query("SELECT field, payload FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? AND target_kind = ? AND target = ? AND kind = 'set' AND status != 'done' ORDER BY seq")
      .all(...key, kind, externalId) as Array<{ field: string; payload: string }>;
    const local = ops.length ? ops.reduce<unknown>((d, o) => applyBacklogField(kind, d, o.field, JSON.parse(o.payload)), r.remote) : null;
    // nothing left to send: both sides agree on what the service has
    this.sqlite
      .query("UPDATE backlog_records SET local = ?1, base = CASE WHEN ?1 IS NULL THEN remote ELSE base END WHERE service = ?2 AND host = ?3 AND repository = ?4 AND object_kind = ?5 AND external_id = ?6")
      .run(local === null ? null : JSON.stringify(local), ...key, kind, externalId);
  }

  /* ---------- tasks ---------- */

  /** The list (#1142): Tasks not archived; `archived` = only the archived ones. */
  listTasks(archived = false): Task[] {
    return this.sqlite.query(`SELECT * FROM tasks WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY updated_at DESC`).all().map(rowToTask);
  }

  getTask(id: string): Task | null {
    const r = this.sqlite.query("SELECT * FROM tasks WHERE id = ?").get(id);
    return r ? rowToTask(r) : null;
  }

  /** Tasks changed at or after `ms` (#935), newest first. */
  listTasksUpdatedSince(ms: number): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE updated_at >= ? ORDER BY updated_at DESC").all(ms).map(rowToTask);
  }

  /** Tasks in one status — a small, naturally-bounded live set (unlike listTasks(), which is every task ever). */
  listTasksByStatus(status: TaskStatus): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC").all(status).map(rowToTask);
  }

  /** The Tasks whose judgement of the last reply was under way (#1139): after a restart, those it cut short. */
  listTasksJudging(): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE judging_at IS NOT NULL").all().map(rowToTask);
  }

  /** The newest running / waiting stage Task of a backlog Issue in a workspace (#1139). */
  activeStageTask(workspaceId: string, issue: number): Task | null {
    const r = this.sqlite.query("SELECT * FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND status IN ('running', 'waiting') ORDER BY updated_at DESC LIMIT 1").get(workspaceId, issue);
    return r ? rowToTask(r) : null;
  }

  /** The newest-created stage Task of a backlog Issue, of `action` only when given (#1139). */
  lastStageTask(workspaceId: string, issue: number, action?: BacklogAction): Task | null {
    const r = action
      ? this.sqlite.query("SELECT * FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND stage_action = ? ORDER BY created_at DESC LIMIT 1").get(workspaceId, issue, action)
      : this.sqlite.query("SELECT * FROM tasks WHERE workspace_id = ? AND stage_issue = ? ORDER BY created_at DESC LIMIT 1").get(workspaceId, issue);
    return r ? rowToTask(r) : null;
  }

  /** Ids of every stage Task of a backlog Issue in a workspace (#1139). */
  stageTaskIds(workspaceId: string, issue: number): string[] {
    return (this.sqlite.query("SELECT id FROM tasks WHERE workspace_id = ? AND stage_issue = ?").all(workspaceId, issue) as Array<{ id: string }>).map((r) => r.id);
  }

  /** Every running / waiting stage Task, whatever the workspace (#1139). */
  listActiveStageTasks(): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE stage_issue IS NOT NULL AND status IN ('running', 'waiting')").all().map(rowToTask);
  }

  /** The `stop.record` events of these tasks (#948), oldest first. */
  listStopRecords(taskIds: string[]): StopRecord[] {
    // a prefix compare, not json_extract over every event of the task: `t` is always written first (appendEvent's JSON.stringify of `{ t, … }`)
    const q = this.sqlite.query(`SELECT ts, seq, json FROM events WHERE task_id = ? AND substr(json, 1, 19) = '{"t":"stop.record",'`);
    const rows = taskIds.flatMap((id) => q.all(id) as Array<{ ts: number; seq: number; json: string }>);
    return rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq).map((r) => (JSON.parse(r.json) as { stop: StopRecord }).stop);
  }

  /** The permission.ask / permission.resolved events of these tasks (#935), oldest first; the same prefix compare as listStopRecords. */
  listPermissionEvents(taskIds: string[]): EventEnvelope[] {
    const prefix = '{"t":"permission.';
    const q = this.sqlite.query("SELECT task_id, ts, seq, json FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ?");
    const rows = taskIds.flatMap((id) => q.all(id, prefix, prefix) as Array<{ task_id: string; ts: number; seq: number; json: string }>);
    return rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq).map((r) => ({ taskId: r.task_id, ts: r.ts, seq: r.seq, ev: JSON.parse(r.json) as AgentEvent }));
  }

  /** Every task, as much as the intervention count (#651) needs of it. */
  listTaskRefs(): Array<{ id: string; workspaceId: string | null; title: string; stageIssue: number | null; scheduleId: string | null; createdAt: number }> {
    return (this.sqlite.query("SELECT id, workspace_id, title, stage_issue, schedule_id, created_at FROM tasks ORDER BY created_at").all() as Array<{ id: string; workspace_id: string | null; title: string; stage_issue: number | null; schedule_id: string | null; created_at: number }>)
      .map((r) => ({ id: r.id, workspaceId: r.workspace_id, title: r.title, stageIssue: r.stage_issue, scheduleId: r.schedule_id, createdAt: r.created_at }));
  }

  /**
   * The events of every task whose JSON begins with one of these (#651), oldest first — one pass over the table, with the
   * prefix compare of listStopRecords (`t` is always written first).
   */
  listEventsByPrefix(prefixes: string[]): EventEnvelope[] {
    const where = prefixes.map(() => "substr(json, 1, length(?)) = ?").join(" OR ");
    const rows = this.sqlite.query(`SELECT task_id, ts, seq, json FROM events WHERE ${where}`).all(...prefixes.flatMap((p) => [p, p])) as Array<{ task_id: string; ts: number; seq: number; json: string }>;
    return rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq).map((r) => ({ taskId: r.task_id, ts: r.ts, seq: r.seq, ev: JSON.parse(r.json) as AgentEvent }));
  }

  /** A task's last reply (#935): the newest session.end's summary and its seq; null when it never ended a turn. */
  lastReply(taskId: string): { text: string; seq: number } | null {
    const prefix = '{"t":"session.end",';
    const r = this.sqlite.query("SELECT seq, json_extract(json, '$.summary') AS text FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq DESC LIMIT 1").get(taskId, prefix, prefix) as { seq: number; text: string | null } | null;
    return r ? { text: r.text ?? "", seq: r.seq } : null;
  }

  insertTask(t: Task): Task {
    if (t.cloudSession) CloudSessionRef.parse(t.cloudSession);
    this.validateCloudSource(t);
    this.sqlite.transaction(() => {
      this.sqlite
        .query(
          `INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, runner_session_id, model, routing, budget_usd, schedule_id, permission_mode, effort, origin, resume_at, resume_reason, shadow_of, shadow_stopped, workspace_reason, outcome, reviewed_at, archived_at, judged_result, judged_reason, judged_by, created_at, updated_at, execution_mode, cloud_session, source_cloud_task_id, stage_issue, stage_action, judging_at, status_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(t.id, t.workspaceId, t.title, t.runner, t.cwd, JSON.stringify(t.scope), t.status, t.runnerSessionId, t.model, t.routing ? JSON.stringify(t.routing) : null, t.budgetUsd, t.scheduleId, t.permissionMode, t.effort, t.origin, t.resumeAt, t.resumeReason, t.shadowOf, t.shadowStopped ? 1 : 0, t.workspaceReason, t.outcome, t.reviewedAt, t.archivedAt, t.judgedResult, t.judgedReason, t.judgedBy, t.createdAt, t.updatedAt, t.executionMode, t.cloudSession ? JSON.stringify(t.cloudSession) : null, t.sourceCloudTaskId, t.stage?.issue ?? null, t.stage?.action ?? null, t.judgingAt, t.statusAt);
      if (t.routing) {
        const logRow = this.sqlite.query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        logRow.run(t.id, t.workspaceId, t.cwd, t.routing.suggested, t.routing.ruleId, t.routing.reason, t.runner, t.createdAt, "rule");
        // An LLM suggestion (#25) is a second opinion on the same decision, so it is a second row rather than a
        // column: each source is then scored against the same `chosen` on its own (`routingStats`).
        if (t.routing.llm) logRow.run(t.id, t.workspaceId, t.cwd, t.routing.llm.runner, "llm", t.routing.llm.reason, t.runner, t.createdAt, "llm");
      }
    })();
    return t;
  }

  /**
   * Runner of the most recent task for the same workspace *or* the same directory (tasks created through the raw API
   * or a scheduler carry no workspaceId) — the routing fallback "what you used last time". Tasks that errored or were
   * aborted do not count as "used", nor does a shadow (#99): the person chose the primary's runner, not the shadow's.
   */
  lastRunnerFor(workspaceId: string | undefined, cwd: string | undefined): RunnerId | undefined {
    if (!workspaceId && !cwd) return undefined;
    const r = this.sqlite
      .query("SELECT runner FROM tasks WHERE (workspace_id = ?1 OR cwd = ?2) AND status NOT IN ('error', 'aborted') AND shadow_of IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(workspaceId ?? "", cwd ?? "");
    return (r as { runner?: RunnerId } | null)?.runner;
  }

  /**
   * The decision log joined with how each task ended (#25): status, outcome (#492), what it cost, how long it took.
   *
   * `durationMs` is creation → the task's last recorded event, not `updated_at`: every patch stamps `updated_at`,
   * so raising a budget days later would otherwise report days of "work" for a decision that took a minute. It
   * keeps growing while the task is still running, and falls back to `updated_at` for a task with no events at all.
   * Clamped at 0 because an imported record can carry timestamps older than its `createdAt`.
   *
   * Ordered by `ts` then `id`: two rows of the same task (rule + llm) and tasks created in the same millisecond
   * would otherwise come back in an arbitrary order, which makes `?limit=` / `| head -n` unreproducible.
   */
  routingLog(limit = 200): RoutingLogRow[] {
    return this.sqlite
      .query(
        `SELECT r.task_id AS taskId, t.title AS title, r.suggested, r.rule_id AS ruleId, r.reason, r.chosen, r.suggested_by AS suggestedBy, t.status, t.outcome,
                ${TASK_COST_SQL} AS costUsd, ${TASK_DURATION_SQL} AS durationMs, r.ts
         FROM routing_log r JOIN tasks t ON t.id = r.task_id ORDER BY r.ts DESC, r.id DESC LIMIT ?`,
      )
      .all(limit) as RoutingLogRow[];
  }

  /**
   * Agreement rate per suggester over the last `days` days (#25): how often `suggested` was the runner the task
   * actually ran on, counted from `routing_log` (one row per suggestion).
   *
   * The two denominators are not the same population and the numbers must not be read as a head-to-head score: a
   * rule suggestion is recorded for every task, an LLM one only when it answered in time, and an unattended task
   * (scheduler, Inbox) never asks the LLM at all. A dropped LLM answer lowers its `total`, it is not a miss.
   * Rows from any other source are reported as `otherTotal` rather than dropped, so "no records" stays truthful.
   */
  routingStats(days = 30, now = Date.now()): RoutingStats {
    const since = now - days * 24 * 3600 * 1000;
    const rows = this.sqlite
      .query("SELECT suggested_by AS suggestedBy, COUNT(*) AS total, SUM(suggested = chosen) AS agreed FROM routing_log WHERE ts >= ? GROUP BY suggested_by")
      .all(since) as Array<{ suggestedBy: string; total: number; agreed: number }>;
    const stats: RoutingStats = { rule: { total: 0, agreed: 0 }, llm: { total: 0, agreed: 0 }, otherTotal: 0, days, byRunner: [] };
    // GROUP BY never yields an empty group and both columns are NOT NULL, so `agreed` is an integer, never null.
    for (const r of rows) {
      if (r.suggestedBy === "rule" || r.suggestedBy === "llm") stats[r.suggestedBy] = { total: r.total, agreed: r.agreed };
      else stats.otherTotal += r.total;
    }
    stats.byRunner = this.runnerStats(since);
    return stats;
  }

  /**
   * How each runner's tasks turned out since `since` (#612). Only the rule rows are read: every routed task has
   * exactly one, so a task the LLM also proposed for is not counted twice. The medians are taken here rather than in
   * SQL (SQLite has no median) — a window is a few hundred rows.
   */
  private runnerStats(since: number): RunnerStats[] {
    const rows = this.sqlite
      .query(
        `SELECT r.chosen AS runner, t.outcome, ${TASK_COST_SQL} AS costUsd, ${TASK_DURATION_SQL} AS durationMs
         FROM routing_log r JOIN tasks t ON t.id = r.task_id WHERE r.suggested_by = 'rule' AND r.ts >= ?`,
      )
      .all(since) as Array<{ runner: RunnerId; outcome: TaskOutcome; costUsd: number; durationMs: number }>;
    const by = new Map<RunnerId, { outcomes: RunnerStats["outcomes"]; costs: number[]; durations: number[] }>();
    for (const r of rows) {
      let acc = by.get(r.runner);
      if (!acc) by.set(r.runner, (acc = { outcomes: { done: 0, needs_action: 0, failed: 0, unknown: 0 }, costs: [], durations: [] }));
      // a value this version does not know (a newer daemon's) still counts, as not yet judged
      acc.outcomes[Object.hasOwn(acc.outcomes, r.outcome) ? r.outcome : "unknown"] += 1;
      acc.costs.push(r.costUsd);
      acc.durations.push(r.durationMs);
    }
    return [...by]
      .map(([runner, a]) => ({ runner, total: a.costs.length, outcomes: a.outcomes, medianCostUsd: median(a.costs), medianDurationMs: median(a.durations) }))
      .sort((a, b) => b.total - a.total || a.runner.localeCompare(b.runner));
  }

  /** The shadow task mirroring `primaryId` (#99), if one was created with it. At most one: `shadow_of` is unique. */
  shadowTaskOf(primaryId: string): Task | null {
    const r = this.sqlite.query("SELECT * FROM tasks WHERE shadow_of = ?").get(primaryId);
    return r ? rowToTask(r) : null;
  }

  /** Imported Local Tasks associated with the original Cloud Task. */
  listLocalTasksForCloud(cloudTaskId: string): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE source_cloud_task_id = ? ORDER BY created_at, id").all(cloudTaskId).map(rowToTask);
  }

  private validateCloudSource(t: Task, previous?: Task): void {
    const changed = !previous || previous.runnerSessionId !== t.runnerSessionId || previous.sourceCloudTaskId !== t.sourceCloudTaskId;
    const owners = changed && t.runnerSessionId ? this.listTasksBySession(t.runner, t.runnerSessionId).filter(other => other.id !== t.id) : [];
    if (owners.some(other => other.sourceCloudTaskId !== null) || (t.sourceCloudTaskId !== null && owners.length > 0)) {
      throw new Error("Local session already has a Task owner");
    }
    if (t.sourceCloudTaskId === null) return;
    const source = this.getTask(t.sourceCloudTaskId);
    let sameCwd = previous?.sourceCloudTaskId === t.sourceCloudTaskId || source?.cwd === t.cwd;
    if (source && !sameCwd) {
      // The Cloud Task's own cwd, or the worktree that "continue locally" made for it (#1395).
      for (const want of [source.cwd, teleportWorktreePath(source.cwd, source.id)]) {
        try { sameCwd = realpathSync(want) === realpathSync(t.cwd); } catch { /* Missing paths cannot prove identity. */ }
        if (sameCwd) break;
      }
    }
    if (t.executionMode !== "local" || t.runner !== "claude" || !t.runnerSessionId || !source || source.executionMode !== "cloud" || source.runner !== "claude" || !sameCwd || source.workspaceId !== t.workspaceId || source.id === t.id) {
      throw new Error("Local continuation must reference a Cloud Task in the same working directory and Workspace");
    }
  }

  /** Tasks of a runner session, earliest first (Switchboard tasks record theirs from session.start; imported ones at creation). */
  listTasksBySession(runner: RunnerId, sessionId: string): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE runner = ? AND runner_session_id = ? ORDER BY created_at").all(runner, sessionId).map(rowToTask);
  }

  /**
   * `updatedAt` may be given by an importer replaying old records; everything else stamps now. A status change without
   * an `outcome` in the patch sets the outcome by rule (#492, `outcomeOnStatus` in task-status.ts) — the one place the rule lives. A status the table (`TASK_TRANSITIONS`) does
   * does not allow is not stored: it throws `InvalidTaskTransitionError` (#1140).
   */
  updateTask(id: string, patch: Partial<Pick<Task, "sourceCloudTaskId" | "cloudSession" | "status" | "runnerSessionId" | "model" | "title" | "budgetUsd" | "permissionMode" | "resumeAt" | "resumeReason" | "shadowStopped" | "scope" | "outcome" | "reviewedAt" | "archivedAt" | "judgedResult" | "judgedReason" | "judgedBy" | "judgingAt" | "updatedAt">>): Task | null {
    if (patch.cloudSession) CloudSessionRef.parse(patch.cloudSession);
    const cur = this.getTask(id);
    if (!cur) return null;
    const moves = patch.status !== undefined && patch.status !== cur.status;
    if (moves && !canTransition(cur.status, patch.status!)) throw new InvalidTaskTransitionError(id, cur.status, patch.status!);
    const rule = moves && patch.outcome === undefined ? outcomeOnStatus(patch.status!, cur.executionMode) : {};
    const updatedAt = patch.updatedAt ?? Date.now();
    // statusAt moves only when the status does (#2029): a title, outcome or 確認済み change keeps when the task came to it
    // a new turn shows the Task again (#1142): only a stopped one stays archived
    const shown = moves && (patch.status === "running" || patch.status === "waiting" || patch.status === "idle") ? { archivedAt: null } : {};
    const next: Task = { ...cur, ...rule, ...patch, ...shown, updatedAt, statusAt: moves ? updatedAt : cur.statusAt };
    this.validateCloudSource(next, cur);
    this.sqlite
      .query("UPDATE tasks SET status = ?, runner_session_id = ?, model = ?, title = ?, budget_usd = ?, permission_mode = ?, resume_at = ?, resume_reason = ?, shadow_stopped = ?, scope = ?, outcome = ?, reviewed_at = ?, archived_at = ?, judged_result = ?, judged_reason = ?, judged_by = ?, judging_at = ?, updated_at = ?, status_at = ?, cloud_session = ?, source_cloud_task_id = ? WHERE id = ?")
      .run(next.status, next.runnerSessionId, next.model, next.title, next.budgetUsd, next.permissionMode, next.resumeAt, next.resumeReason, next.shadowStopped ? 1 : 0, JSON.stringify(next.scope), next.outcome, next.reviewedAt, next.archivedAt, next.judgedResult, next.judgedReason, next.judgedBy, next.judgingAt, next.updatedAt, next.statusAt, next.cloudSession ? JSON.stringify(next.cloudSession) : null, next.sourceCloudTaskId, id);
    return next;
  }

  /* ---------- artifacts (#1777) ---------- */

  insertArtifact(a: Artifact): void {
    this.sqlite.query("INSERT INTO artifacts (id, task_id, title, kind, source, entry, mime, size, removed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(a.id, a.taskId, a.title, a.kind, a.source, a.entry, a.mime, a.size, a.removedAt, a.createdAt, a.updatedAt);
  }

  getArtifact(id: string): Artifact | null {
    const r = this.sqlite.query("SELECT * FROM artifacts WHERE id = ?").get(id);
    return r ? rowToArtifact(r) : null;
  }

  /** The task's artifacts that are not in the undo window, in the order they were added. */
  listArtifacts(taskId: string): Artifact[] {
    return this.sqlite.query("SELECT * FROM artifacts WHERE task_id = ? AND removed_at IS NULL ORDER BY created_at, id").all(taskId).map(rowToArtifact);
  }

  listArtifactsRemovedBefore(ts: number): Artifact[] {
    return this.sqlite.query("SELECT * FROM artifacts WHERE removed_at IS NOT NULL AND removed_at < ?").all(ts).map(rowToArtifact);
  }

  /**
   * Reports across tasks (#1835): every task's HTML artifacts (a file or a folder, not removed), newest first by
   * `updated_at` so a refreshed one rises, with the task's title and the schedule's when a schedule started the task.
   */
  listReports(limit: number): ReportRow[] {
    return this.sqlite
      .query(
        `SELECT a.*, t.title AS task_title, s.title AS schedule_title FROM artifacts a
         JOIN tasks t ON t.id = a.task_id LEFT JOIN schedules s ON s.id = t.schedule_id
         WHERE a.removed_at IS NULL AND a.kind IN ('file', 'dir') AND a.mime IN ('text/html', 'application/xhtml+xml')
         ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
      )
      .all(limit)
      .map(rowToReport);
  }

  updateArtifact(a: Artifact): void {
    this.sqlite.query("UPDATE artifacts SET title = ?, kind = ?, entry = ?, mime = ?, size = ?, removed_at = ?, updated_at = ? WHERE id = ?").run(a.title, a.kind, a.entry, a.mime, a.size, a.removedAt, a.updatedAt, a.id);
  }

  deleteArtifact(id: string): void {
    this.sqlite.query("DELETE FROM artifacts WHERE id = ?").run(id);
  }

  /* ---------- attachments (#125) ---------- */

  insertAttachment(a: Attachment): void {
    this.sqlite.query("INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(a.id, a.taskId, a.name, a.mime, a.size, a.path, a.createdAt);
  }

  getAttachment(id: string): Attachment | null {
    const r = this.sqlite.query("SELECT * FROM attachments WHERE id = ?").get(id);
    return r ? rowToAttachment(r) : null;
  }

  listAttachments(taskId: string): Attachment[] {
    return this.sqlite.query("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, id").all(taskId).map(rowToAttachment);
  }

  /** Uploaded but never sent, older than `beforeTs` — what the boot sweep removes. */
  listUnattachedBefore(beforeTs: number): Attachment[] {
    return this.sqlite.query("SELECT * FROM attachments WHERE task_id IS NULL AND created_at < ? ORDER BY created_at").all(beforeTs).map(rowToAttachment);
  }

  /** The file moved under its task: record where it now lives and whose it is. */
  attachAttachment(id: string, taskId: string, path: string): void {
    this.sqlite.query("UPDATE attachments SET task_id = ?, path = ? WHERE id = ?").run(taskId, path, id);
  }

  deleteAttachment(id: string): void {
    this.sqlite.query("DELETE FROM attachments WHERE id = ?").run(id);
  }

  /** Tasks waiting on a usage limit (#102): resume_at set. A small live set — the column is cleared as soon as a task moves on. */
  listTasksWithResume(): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE resume_at IS NOT NULL ORDER BY resume_at").all().map(rowToTask);
  }

  /** Last quota report of a runner, per window (from `quota` events; #102 reads the saturated window's reset time). */
  quotaFor(runner: RunnerId): Array<{ window: string; utilization: number; resetsAt: number; ts: number }> {
    return this.sqlite.query("SELECT window, utilization, resets_at AS resetsAt, ts FROM quota WHERE runner = ? ORDER BY window").all(runner) as Array<{ window: string; utilization: number; resetsAt: number; ts: number }>;
  }

  /* ---------- settings (#58): small JSON documents the UI can change ---------- */

  getSetting<T>(key: string, fallback: T): T {
    const r = this.sqlite.query("SELECT json FROM settings WHERE key = ?").get(key) as { json: string } | null;
    return r ? safeJson<T>(r.json, fallback) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.sqlite.query("INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(key, JSON.stringify(value));
  }

  /* ---------- events ---------- */

  nextSeq(taskId: string): number {
    const r = this.sqlite.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE task_id = ?").get(taskId) as { m: number };
    return (r?.m ?? 0) + 1;
  }

  appendEvent(taskId: string, ev: AgentEvent): EventEnvelope {
    return this.appendEventAt(taskId, ev, Date.now());
  }

  /** Append with an explicit timestamp — an imported record keeps the time it happened, not the time it was read. */
  appendEventAt(taskId: string, ev: AgentEvent, ts: number): EventEnvelope {
    const env: EventEnvelope = { taskId, seq: this.nextSeq(taskId), ts, ev };
    this.sqlite.query("INSERT INTO events (task_id, seq, ts, json) VALUES (?, ?, ?, ?)").run(taskId, env.seq, env.ts, JSON.stringify(ev));
    return env;
  }

  /* ---------- history imports (#91): which session log feeds which task, and how far it has been read ---------- */

  upsertHistoryImport(row: HistoryImportRow) {
    this.sqlite
      .query(
        `INSERT INTO history_imports (session_id, task_id, path, offset, state, imported_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET task_id = excluded.task_id, path = excluded.path, offset = excluded.offset, state = excluded.state, imported_at = excluded.imported_at`,
      )
      .run(row.sessionId, row.taskId, row.path, row.offset, row.state, row.importedAt);
  }

  getHistoryImport(sessionId: string): HistoryImportRow | null {
    const r = this.sqlite.query("SELECT * FROM history_imports WHERE session_id = ?").get(sessionId);
    return r ? rowToHistoryImport(r) : null;
  }

  historyImportForTask(taskId: string): HistorySession | null {
    const r = this.sqlite.query("SELECT h.*, t.origin AS origin FROM history_imports h JOIN tasks t ON t.id = h.task_id WHERE h.task_id = ? ORDER BY h.imported_at DESC LIMIT 1").get(taskId);
    return r ? rowToHistorySession(r) : null;
  }

  listHistoryImports(): HistorySession[] {
    return this.sqlite.query("SELECT h.*, t.origin AS origin FROM history_imports h JOIN tasks t ON t.id = h.task_id ORDER BY h.imported_at DESC LIMIT 500").all().map(rowToHistorySession);
  }

  listEvents(taskId: string, afterSeq = 0): EventEnvelope[] {
    return (this.sqlite.query("SELECT seq, ts, json FROM events WHERE task_id = ? AND seq > ? ORDER BY seq").all(taskId, afterSeq) as Array<{ seq: number; ts: number; json: string }>).map(
      (r) => ({ taskId, seq: r.seq, ts: r.ts, ev: JSON.parse(r.json) as AgentEvent }),
    );
  }

  /** The last `limit` events of a task, in seq order (#1142): what the Task screen draws first. */
  listEventsTail(taskId: string, limit: number): EventEnvelope[] {
    return this.listEventsBefore(taskId, Number.MAX_SAFE_INTEGER, limit);
  }

  /**
   * The `limit` events just before `beforeSeq`, in seq order (#1142): the page above what the Task screen holds. A reply
   * streams as many deltas of one message (hundreds for a long one), so a page that starts inside a message reaches back
   * to the message's first delta: the screen never opens on a reply cut in half. A page stays within `EVENTS_PAGE_MAX`
   * (a longer message is cut there).
   */
  listEventsBefore(taskId: string, beforeSeq: number, limit: number): EventEnvelope[] {
    type Row = { seq: number; ts: number; json: string };
    let rows = (this.sqlite.query("SELECT seq, ts, json FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(taskId, beforeSeq, limit) as Row[]).reverse();
    const first = rows[0] ? (JSON.parse(rows[0].json) as AgentEvent) : null;
    const room = EVENTS_PAGE_MAX - rows.length;
    if (first?.t === "message.delta" && first.messageId && room > 0) {
      // only the rows the page may still grow by (seqs have holes once events moved to S3): a message starting earlier is cut at the cap anyway
      const start = this.sqlite
        .query("SELECT MIN(seq) AS seq FROM (SELECT seq, json FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) WHERE json_extract(json, '$.t') = 'message.delta' AND json_extract(json, '$.messageId') = ?")
        .get(taskId, rows[0]!.seq, room, first.messageId) as { seq: number | null };
      if (start.seq !== null) rows = [...(this.sqlite.query("SELECT seq, ts, json FROM events WHERE task_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(taskId, start.seq, rows[0]!.seq, room) as Row[]).reverse(), ...rows];
    }
    return rows.map((r) => ({ taskId, seq: r.seq, ts: r.ts, ev: JSON.parse(r.json) as AgentEvent }));
  }

  /** The first thing the person asked in a task (its first user message), or null. One row, not the transcript: a long task has thousands of events. */
  firstUserText(taskId: string): string | null {
    const r = this.sqlite.query("SELECT json_extract(json, '$.text') AS text FROM events WHERE task_id = ? AND json_extract(json, '$.t') = 'message.delta' AND json_extract(json, '$.role') = 'user' ORDER BY seq LIMIT 1").get(taskId) as { text: string | null } | null;
    return r?.text ?? null;
  }

  /* ---------- evals (#1218): one row per task and source; a new evaluation replaces the old one ---------- */

  upsertEval(row: EvalRow) {
    this.sqlite
      .query(
        `INSERT INTO task_evals (task_id, source, by, rubric, json, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, source) DO UPDATE SET by = excluded.by, rubric = excluded.rubric, json = excluded.json, ts = excluded.ts`,
      )
      .run(row.taskId, row.source, row.by, row.rubric, JSON.stringify(row.json), row.ts);
  }

  getEval(taskId: string, source: EvalSource): EvalRow | null {
    const r = this.sqlite.query("SELECT task_id, source, by, rubric, json, ts FROM task_evals WHERE task_id = ? AND source = ?").get(taskId, source) as { task_id: string; source: EvalSource; by: string; rubric: string | null; json: string; ts: number } | null;
    return r ? { taskId: r.task_id, source: r.source, by: r.by, rubric: r.rubric, json: JSON.parse(r.json) as unknown, ts: r.ts } : null;
  }

  deleteEval(taskId: string, source: EvalSource) {
    this.sqlite.query("DELETE FROM task_evals WHERE task_id = ? AND source = ?").run(taskId, source);
  }

  /** The task's evals as the API returns them. A row that no longer parses (an older counter, an older judge shape) reads as null. */
  evalsOf(taskId: string): TaskEvals {
    const rules = this.getEval(taskId, "rules");
    const judge = this.getEval(taskId, "judge");
    const human = this.getEval(taskId, "human");
    const r = rules ? RuleEval.safeParse(rules.json) : null;
    const j = judge ? JudgeEval.safeParse(judge.json) : null;
    const h = human ? HumanEval.safeParse(human.json) : null;
    return { rules: r?.success ? r.data : null, judge: j?.success ? j.data : null, human: h?.success ? h.data : null };
  }

  /**
   * The Evals list (#1221): every task (newest first, `limit` of them), filtered by workspace / runner, with the gist of
   * its rules / judge / human rows. One query: the three eval rows are LEFT JOINed by source, the cost is the ledger's
   * sum. A row that no longer parses reads as null, as in `evalsOf`.
   */
  evalsList(q: { workspaceId?: string; runner?: RunnerId; limit: number }): EvalsListRow[] {
    const rows = this.sqlite
      .query(
        `SELECT t.id AS taskId, t.title AS title, t.runner AS runner, t.workspace_id AS workspaceId, t.status AS status, t.outcome AS outcome, t.updated_at AS updatedAt,
                (SELECT COALESCE(SUM(cost_usd), 0) FROM ledger WHERE task_id = t.id) AS costUsd,
                r.json AS rulesJson, j.json AS judgeJson, h.json AS humanJson
         FROM tasks t
         LEFT JOIN task_evals r ON r.task_id = t.id AND r.source = 'rules'
         LEFT JOIN task_evals j ON j.task_id = t.id AND j.source = 'judge'
         LEFT JOIN task_evals h ON h.task_id = t.id AND h.source = 'human'
         WHERE (? IS NULL OR t.workspace_id = ?) AND (? IS NULL OR t.runner = ?)
         ORDER BY t.updated_at DESC LIMIT ?`,
      )
      .all(q.workspaceId ?? null, q.workspaceId ?? null, q.runner ?? null, q.runner ?? null, q.limit) as Array<{ taskId: string; title: string; runner: RunnerId; workspaceId: string | null; status: TaskStatus; outcome: TaskOutcome; updatedAt: number; costUsd: number; rulesJson: string | null; judgeJson: string | null; humanJson: string | null }>;
    const parse = <T>(json: string | null, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T | null => {
      if (!json) return null;
      try {
        const r = schema.safeParse(JSON.parse(json));
        return r.success ? (r.data as T) : null;
      } catch {
        return null;
      }
    };
    return rows.map((r) => {
      const rules = parse(r.rulesJson, RuleEval);
      const judge = parse(r.judgeJson, JudgeEval);
      const human = parse(r.humanJson, HumanEval);
      const scores = judge ? Object.fromEntries(Object.entries(judge.scores).map(([k, v]) => [k, v.score])) : {};
      const values = Object.values(scores);
      return {
        taskId: r.taskId, title: r.title, runner: r.runner, workspaceId: r.workspaceId, status: r.status, outcome: r.outcome, updatedAt: r.updatedAt, costUsd: r.costUsd,
        rules: rules ? { toolCalls: rules.metrics.toolCalls, toolFailures: rules.metrics.toolFailures, errors: rules.metrics.errors, userInstructions: rules.metrics.userInstructions, stops: rules.metrics.stops, lastEnd: rules.metrics.lastEnd } : null,
        judge: judge && values.length ? { average: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10, scores, rubric: judge.rubric, by: judge.by } : null,
        human: human ? { rating: human.rating, comment: human.comment } : null,
      };
    });
  }

  /* ---------- ledger ---------- */

  /** `reportedTotal`: the running total the row is the difference of (a cumulative report, #2353), kept for the next row. */
  insertLedger(row: LedgerRow, reportedTotal?: ReportedTotal) {
    this.sqlite
      .query(
        `INSERT INTO ledger (task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cache_write_1h, cost_usd, billed_usd, source, ts, reported_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.taskId, row.runner, row.model, row.inputTokens, row.outputTokens, row.cacheRead, row.cacheWrite, row.cacheWrite1h, row.costUsd, row.billedUsd, row.source, row.ts, reportedTotal ? JSON.stringify(reportedTotal) : null);
  }

  /** The last running total booked for this Task and model (#2353); null before the first. Migrated rows are not one model's. */
  lastReportedTotal(taskId: string, model: string | null): ReportedTotal | null {
    const r = this.sqlite
      .query("SELECT reported_total AS t FROM ledger WHERE task_id = ? AND model IS ? AND reported_total IS NOT NULL AND json_extract(reported_total, '$.migrated') IS NULL ORDER BY id DESC LIMIT 1")
      .get(taskId, model) as { t: string } | null;
    return r ? (JSON.parse(r.t) as ReportedTotal) : null;
  }

  /**
   * What the Task's migrated rows booked that no later row has counted against yet (#2353): the last migrated total
   * is all the models of its session together, so the first total of each model after it is counted against the rest.
   * 0 for another runner session, or when the Task had none to resume at the migration: a new session does not carry
   * the old total.
   */
  migratedCredit(taskId: string, session: string | null): number {
    const r = this.sqlite
      .query(
        `SELECT json_extract(m.reported_total, '$.costUsd') AS total, json_extract(m.reported_total, '$.session') AS session,
                (SELECT COALESCE(SUM(json_extract(l.reported_total, '$.carried')), 0) FROM ledger l WHERE l.task_id = m.task_id AND l.id > m.id) AS used
         FROM ledger m WHERE m.task_id = ? AND json_extract(m.reported_total, '$.migrated') = 1 ORDER BY m.id DESC LIMIT 1`,
      )
      .get(taskId) as { total: number; session: string | null; used: number } | null;
    if (!r || !r.session || r.session !== session) return 0;
    return Math.max(0, r.total - r.used);
  }

  /** Where a task's event bodies went (#1431): the S3 keys (one per line, oldest first), when, and how many rows; null if never moved. */
  eventsArchiveOf(taskId: string): { key: string; at: number; count: number } | null {
    const r = this.sqlite.query("SELECT events_archive_key AS key, events_archived_at AS at, events_archived_count AS count FROM tasks WHERE id = ?").get(taskId) as { key: string | null; at: number; count: number } | null;
    return r?.key ? { key: r.key, at: r.at, count: r.count } : null;
  }

  taskCost(taskId: string): { costUsd: number; tokens: number } {
    const r = this.sqlite
      .query("SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(input_tokens+output_tokens+cache_read+cache_write),0) AS t FROM ledger WHERE task_id = ?")
      .get(taskId) as { c: number; t: number };
    return { costUsd: r?.c ?? 0, tokens: r?.t ?? 0 };
  }

  /* ---------- knowledge index (derived from the Markdown folder; rebuildable) ---------- */

  knowledgeUpsert(doc: KnowledgeDoc, body: string) {
    this.sqlite.transaction(() => {
      this.sqlite
        .query(
          `INSERT INTO knowledge_docs (path, title, kind, frontmatter, mtime, size) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET title = excluded.title, kind = excluded.kind, frontmatter = excluded.frontmatter, mtime = excluded.mtime, size = excluded.size`,
        )
        .run(doc.path, doc.title, doc.kind, JSON.stringify(doc.frontmatter), doc.mtime, doc.size);
      this.sqlite.query("DELETE FROM knowledge_fts WHERE path = ?").run(doc.path);
      this.sqlite.query("INSERT INTO knowledge_fts (path, title, body) VALUES (?, ?, ?)").run(doc.path, doc.title, body);
    })();
  }

  knowledgeDelete(path: string) {
    this.sqlite.transaction(() => {
      this.sqlite.query("DELETE FROM knowledge_docs WHERE path = ?").run(path);
      this.sqlite.query("DELETE FROM knowledge_fts WHERE path = ?").run(path);
    })();
  }

  knowledgeGet(path: string): KnowledgeDoc | null {
    const r = this.sqlite.query("SELECT * FROM knowledge_docs WHERE path = ?").get(path);
    return r ? rowToKnowledge(r) : null;
  }

  knowledgeList(): KnowledgeDoc[] {
    return this.sqlite.query("SELECT * FROM knowledge_docs ORDER BY kind, path").all().map(rowToKnowledge);
  }

  /**
   * Trigram MATCH for terms ≥ 3 chars plus LIKE filters for shorter ones (the trigram tokenizer accelerates LIKE too).
   * With no MATCH term the query is LIKE-only and ranked by title.
   */
  knowledgeSearch(ftsQuery: string, like: string[], limit: number): KnowledgeSearchHit[] {
    const likeSql = like.map(() => " AND (f.body LIKE ? OR f.title LIKE ?)").join("");
    const likeArgs = like.flatMap((w) => [`%${w.replace(/[%_\\]/g, "\\$&")}%`, `%${w.replace(/[%_\\]/g, "\\$&")}%`]);
    if (ftsQuery) {
      return this.sqlite
        .query(
          `SELECT f.path AS path, d.title AS title, d.kind AS kind, snippet(knowledge_fts, 2, '[', ']', '…', 12) AS snippet, bm25(knowledge_fts) AS rank
           FROM knowledge_fts f JOIN knowledge_docs d ON d.path = f.path WHERE knowledge_fts MATCH ?${likeSql} ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, ...likeArgs, limit) as KnowledgeSearchHit[];
    }
    const rows = this.sqlite
      .query(`SELECT f.path AS path, d.title AS title, d.kind AS kind, substr(f.body, 1, 160) AS snippet, 0 AS rank FROM knowledge_fts f JOIN knowledge_docs d ON d.path = f.path WHERE 1=1${likeSql} ORDER BY d.title LIMIT ?`)
      .all(...likeArgs, limit) as KnowledgeSearchHit[];
    return rows.map((r) => ({ ...r, snippet: r.snippet.replace(/\s+/g, " ").trim() }));
  }

  /* ---------- staged writes ---------- */

  insertStaged(c: StagedChange) {
    this.sqlite
      .query("INSERT INTO staging (id, task_id, path, rel, kind, before_text, after_text, status, ts, decided_at, diff_text, stat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.taskId, c.path, c.rel, c.kind, c.before, c.after, c.status, c.ts, c.decidedAt, c.diff, c.stat);
  }

  getStaged(id: string): StagedChange | null {
    const r = this.sqlite.query("SELECT * FROM staging WHERE id = ?").get(id);
    return r ? rowToStaged(r) : null;
  }

  listStaged(taskId: string): StagedChange[] {
    return this.sqlite.query("SELECT * FROM staging WHERE task_id = ? ORDER BY ts").all(taskId).map(rowToStaged);
  }

  updateStaged(id: string, status: StagedChange["status"]): StagedChange | null {
    this.sqlite.query("UPDATE staging SET status = ?, decided_at = ? WHERE id = ?").run(status, Date.now(), id);
    return this.getStaged(id);
  }

  /**
   * One row per task with at least one pending staged change (the queue's "staged" section) — a single grouped join
   * instead of a per-task pending-count query run against every task the workspace has ever had.
   */
  pendingStagedByTask(): Array<{ taskId: string; title: string; pending: number }> {
    return this.sqlite
      .query(
        `SELECT s.task_id AS taskId, t.title AS title, COUNT(*) AS pending
         FROM staging s JOIN tasks t ON t.id = s.task_id
         WHERE s.status = 'pending'
         GROUP BY s.task_id`,
      )
      .all() as Array<{ taskId: string; title: string; pending: number }>;
  }

  /* ---------- schedules (#20) ---------- */

  listSchedules(): Schedule[] {
    return this.sqlite.query("SELECT * FROM schedules ORDER BY created_at").all().map(rowToSchedule);
  }

  getSchedule(id: string): Schedule | null {
    const r = this.sqlite.query("SELECT * FROM schedules WHERE id = ?").get(id);
    return r ? rowToSchedule(r) : null;
  }

  insertSchedule(s: Schedule): Schedule {
    this.sqlite
      .query("INSERT INTO schedules (id, title, cron, workspace_id, runner, model, effort, prompt, action, budget_usd, enabled, last_run_at, last_task_id, next_run_at, last_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, s.title, s.cron, s.workspaceId, s.runner, s.model, s.effort, s.prompt, s.action, s.budgetUsd, s.enabled ? 1 : 0, s.lastRunAt, s.lastTaskId, s.nextRunAt, s.lastResult ? JSON.stringify(s.lastResult) : null, s.createdAt);
    return s;
  }

  updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | null {
    const cur = this.getSchedule(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    // a result belongs to the secret-scan action (#1274): a schedule turned into another action starts without one
    if (patch.action !== undefined && patch.action !== cur.action && patch.lastResult === undefined) n.lastResult = null;
    this.sqlite
      .query("UPDATE schedules SET title = ?, cron = ?, workspace_id = ?, runner = ?, model = ?, effort = ?, prompt = ?, action = ?, budget_usd = ?, enabled = ?, last_run_at = ?, last_task_id = ?, next_run_at = ?, last_result = ? WHERE id = ?")
      .run(n.title, n.cron, n.workspaceId, n.runner, n.model, n.effort, n.prompt, n.action, n.budgetUsd, n.enabled ? 1 : 0, n.lastRunAt, n.lastTaskId, n.nextRunAt, n.lastResult ? JSON.stringify(n.lastResult) : null, id);
    return n;
  }

  deleteSchedule(id: string) {
    this.sqlite.query("DELETE FROM schedules WHERE id = ?").run(id);
  }

  /** Tasks started by schedules, newest first. */
  scheduledTasks(sinceTs: number): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE schedule_id IS NOT NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 100").all(sinceTs).map(rowToTask);
  }

  /* ---------- self-dev check runs ---------- */

  saveCheckRun(run: CheckRun) {
    this.sqlite
      .query("INSERT INTO check_runs (task_id, ok, json, ts) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET ok = excluded.ok, json = excluded.json, ts = excluded.ts")
      .run(run.taskId, run.ok ? 1 : 0, JSON.stringify(run), run.ts);
  }

  getCheckRun(taskId: string): CheckRun | null {
    const r = this.sqlite.query("SELECT json FROM check_runs WHERE task_id = ?").get(taskId) as { json: string } | null;
    return r ? safeJson<CheckRun | null>(r.json, null) : null;
  }

  upsertQuota(runner: RunnerId, window: string, utilization: number, resetsAt: number, ts = Date.now()) {
    this.sqlite
      .query(
        `INSERT INTO quota (runner, window, utilization, resets_at, ts) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(runner, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, ts = excluded.ts`,
      )
      .run(runner, window, utilization, resetsAt, ts);
  }

  /** One minute of the host's load (#2086) and its groups, dropping both tables' rows older than 7 days, in one transaction. */
  insertOpsLoad(row: OpsLoadRow, groups: OpsLoadGroupRow[], now = Date.now()) {
    const group = this.sqlite.query("INSERT INTO ops_load_groups (ts, task_id, owner, kind, rss, cpu_ms, procs) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.sqlite.transaction(() => {
      this.sqlite
        .query("INSERT OR REPLACE INTO ops_load (ts, mem_current, mem_max, swap_current, events_max, cpu_pct, pressure_some, pressure_full, docker_mem, top) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(now, row.memCurrent, row.memMax, row.swapCurrent, row.eventsMax, row.cpuPct, row.pressureSome, row.pressureFull, row.dockerMem, row.top);
      for (const g of groups) group.run(now, g.taskId, g.owner, g.kind, g.rssBytes, g.cpuMs, g.procs);
      this.sqlite.query("DELETE FROM ops_load WHERE ts < ?").run(now - OPS_LOAD_KEEP_MS);
      this.sqlite.query("DELETE FROM ops_load_groups WHERE ts < ?").run(now - OPS_LOAD_KEEP_MS);
    })();
  }

  /** Saves buffered API requests (#2101) and drops those older than 7 days, in one transaction. */
  insertApiRequests(rows: ApiRequestRow[], now = Date.now()) {
    const insert = this.sqlite.query("INSERT INTO api_requests (ts, method, route, status, ms, bytes) VALUES (?, ?, ?, ?, ?, ?)");
    this.sqlite.transaction(() => {
      for (const r of rows) insert.run(r.ts, r.method, r.route, r.status, r.ms, r.bytes);
      this.sqlite.query("DELETE FROM api_requests WHERE ts < ?").run(now - API_REQUESTS_KEEP_MS);
    })();
  }

  /** Saves the Web UI's journey timings (#639) and drops those older than 30 days, in one transaction. */
  insertPerfSamples(rows: PerfSample[], now = Date.now()) {
    const insert = this.sqlite.query("INSERT INTO perf_samples (ts, journey, device, build, ms, task_id, bytes, events) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    this.sqlite.transaction(() => {
      for (const r of rows) insert.run(now, r.journey, r.device, r.build, r.ms, r.taskId, r.bytes, r.events);
      this.sqlite.query("DELETE FROM perf_samples WHERE ts < ?").run(now - PERF_KEEP_MS);
    })();
  }

  /**
   * Journey timings per journey × device × size (#639, #2103): the last 7 days against the 7 days before them. A
   * comparison by build stopped working once a build lasted a few hours (promoted 8 times a day). p50 / p90 are nearest-rank.
   */
  perfSummary(now = Date.now()): PerfSummaryRow[] {
    const rows = this.sqlite.query("SELECT ts, journey, device, ms, events FROM perf_samples WHERE ts >= ?").all(now - 2 * PERF_PERIOD_MS) as Array<{ ts: number; journey: Journey; device: PerfSample["device"]; ms: number; events: number | null }>;
    const groups = new Map<string, { journey: Journey; device: PerfSample["device"]; size: SizeClass | null; current: number[]; previous: number[] }>();
    for (const r of rows) {
      const size = sizeClass(r.events);
      const key = `${r.journey}|${r.device}|${size}`;
      const g = groups.get(key) ?? { journey: r.journey, device: r.device, size, current: [], previous: [] };
      (r.ts >= now - PERF_PERIOD_MS ? g.current : g.previous).push(r.ms);
      groups.set(key, g);
    }
    const stats = (ms: number[]) => {
      if (ms.length === 0) return null;
      const sorted = ms.sort((a, b) => a - b);
      return { count: sorted.length, p50: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9) };
    };
    const order = (s: SizeClass | null) => (s === null ? -1 : SizeClass.options.indexOf(s));
    return [...groups.values()]
      .sort((a, b) => a.journey.localeCompare(b.journey) || a.device.localeCompare(b.device) || order(a.size) - order(b.size))
      .map((g) => ({ journey: g.journey, device: g.device, size: g.size, current: stats(g.current), previous: stats(g.previous) }));
  }

  /** Day × runner totals for the last `days` days (JST calendar days, as the Ledger screen shows them — #2028). */
  ledgerDaily(days = 7, now = Date.now()): LedgerDaily[] {
    const from = new Date(jstDayStart(now, days - 1));
    const rows = this.sqlite.query("SELECT runner, ts, cost_usd, billed_usd, input_tokens + output_tokens + cache_read + cache_write AS tokens FROM ledger WHERE ts >= ? ORDER BY ts").all(from.getTime()) as Array<{ runner: RunnerId; ts: number; cost_usd: number; billed_usd: number; tokens: number }>;
    const acc = new Map<string, LedgerDaily>();
    for (const r of rows) {
      const day = jstDay(r.ts);
      const key = `${day}|${r.runner}`;
      const cur = acc.get(key) ?? { day, runner: r.runner, costUsd: 0, billedUsd: 0, tokens: 0 };
      cur.costUsd += r.cost_usd;
      cur.billedUsd += r.billed_usd;
      cur.tokens += r.tokens;
      acc.set(key, cur);
    }
    return [...acc.values()].sort((a, b) => a.day.localeCompare(b.day) || a.runner.localeCompare(b.runner));
  }

  ledgerTasks(days = 7, now = Date.now(), limit = 50): LedgerTaskRow[] {
    const weekTs = now - days * 24 * 3600 * 1000;
    return this.sqlite
      .query(
        `SELECT l.task_id AS taskId, t.title AS title, t.runner AS runner, t.origin AS origin, MAX(l.model) AS model, SUM(l.cost_usd) AS costUsd, SUM(l.billed_usd) AS billedUsd,
                SUM(l.input_tokens + l.output_tokens + l.cache_read + l.cache_write) AS tokens, MAX(l.source = 'unpriced') AS unpriced, MAX(l.ts) AS lastTs
         FROM ledger l JOIN tasks t ON t.id = l.task_id WHERE l.ts >= ? GROUP BY l.task_id ORDER BY costUsd DESC LIMIT ?`,
      )
      .all(weekTs, limit)
      .map((r) => ({ ...(r as Omit<LedgerTaskRow, "unpriced"> & { unpriced: number }), unpriced: (r as { unpriced: number }).unpriced === 1 }));
  }

  /** Ledger screen (#1836): the period (the same days as `ledgerDaily`) per runner × model, costliest first; `tasks` counts Tasks, not usage rows (the PBI's 件数). */
  ledgerModels(days = 7, now = Date.now()): LedgerModelRow[] {
    const from = new Date(jstDayStart(now, days - 1));
    return (
      this.sqlite
        .query(
          `SELECT runner, model, COUNT(DISTINCT task_id) AS n, SUM(input_tokens + output_tokens + cache_read + cache_write) AS tokens, SUM(cost_usd) AS costUsd,
                  SUM(billed_usd) AS billedUsd, MAX(source = 'unpriced') AS unpriced
           FROM ledger WHERE ts >= ? GROUP BY runner, model ORDER BY costUsd DESC, tokens DESC, runner, model`,
        )
        .all(from.getTime()) as Array<{ runner: RunnerId; model: string | null; n: number; tokens: number; costUsd: number; billedUsd: number; unpriced: number }>
    ).map((r) => ({ runner: r.runner, model: r.model, tasks: r.n, tokens: r.tokens, costUsd: r.costUsd, billedUsd: r.billedUsd, unpriced: r.unpriced === 1 }));
  }

  ledgerSummary(now = Date.now()): LedgerSummary {
    const dayTs = jstDayStart(now);
    const weekTs = now - 7 * 24 * 3600 * 1000;
    const today = this.sqlite.query("SELECT runner, COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(billed_usd),0) AS b FROM ledger WHERE ts >= ? GROUP BY runner").all(dayTs) as Array<{ runner: string; c: number; b: number }>;
    const week = this.sqlite.query("SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(billed_usd),0) AS b FROM ledger WHERE ts >= ?").get(weekTs) as { c: number; b: number };
    const quota = this.sqlite.query("SELECT runner, window, utilization, resets_at AS resetsAt, ts FROM quota ORDER BY runner, window").all() as LedgerSummary["quota"];
    const top = this.sqlite
      .query(
        `SELECT l.task_id AS taskId, t.title AS title, l.runner AS runner, SUM(l.cost_usd) AS costUsd,
                SUM(l.input_tokens + l.output_tokens + l.cache_read + l.cache_write) AS tokens
         FROM ledger l JOIN tasks t ON t.id = l.task_id
         WHERE l.ts >= ? GROUP BY l.task_id ORDER BY costUsd DESC LIMIT 5`,
      )
      .all(weekTs) as LedgerSummary["topTasks"];
    const byRunnerToday: Record<string, number> = {};
    for (const r of today) byRunnerToday[r.runner] = r.c;
    return {
      todayUsd: today.reduce((a, r) => a + r.c, 0),
      weekUsd: week?.c ?? 0,
      billedTodayUsd: today.reduce((a, r) => a + r.b, 0),
      billedWeekUsd: week?.b ?? 0,
      byRunnerToday,
      quota,
      topTasks: top,
      github: null, // the daemon's gh reads it (server.ts); the DB does not keep it (#549)
    };
  }
}

/* ---------- helpers ---------- */

/** Additive schema changes for databases created by earlier versions. Each step is idempotent. */
function migrate(db: Database) {
  const cols = new Set((db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("execution_mode")) db.exec("ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'local'");
  if (!cols.has("cloud_session")) db.exec("ALTER TABLE tasks ADD COLUMN cloud_session TEXT");
  if (!cols.has("source_cloud_task_id")) db.exec("ALTER TABLE tasks ADD COLUMN source_cloud_task_id TEXT");
  if (!cols.has("routing")) db.exec("ALTER TABLE tasks ADD COLUMN routing TEXT");
  if (!cols.has("budget_usd")) db.exec("ALTER TABLE tasks ADD COLUMN budget_usd REAL");
  if (!cols.has("schedule_id")) db.exec("ALTER TABLE tasks ADD COLUMN schedule_id TEXT");
  if (!cols.has("permission_mode")) db.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT");
  if (!cols.has("effort")) db.exec("ALTER TABLE tasks ADD COLUMN effort TEXT");
  if (!cols.has("origin")) db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'switchboard'");
  if (!cols.has("resume_at")) db.exec("ALTER TABLE tasks ADD COLUMN resume_at INTEGER");
  if (!cols.has("resume_reason")) db.exec("ALTER TABLE tasks ADD COLUMN resume_reason TEXT");
  if (!cols.has("shadow_of")) db.exec("ALTER TABLE tasks ADD COLUMN shadow_of TEXT");
  const opCols = new Set((db.query("PRAGMA table_info(backlog_operations)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!opCols.has("overwritten")) db.exec("ALTER TABLE backlog_operations ADD COLUMN overwritten TEXT");
  if (!cols.has("shadow_stopped")) db.exec("ALTER TABLE tasks ADD COLUMN shadow_stopped INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("workspace_reason")) db.exec("ALTER TABLE tasks ADD COLUMN workspace_reason TEXT");
  if (!cols.has("outcome")) db.exec("ALTER TABLE tasks ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown'");
  if (!cols.has("reviewed_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN reviewed_at INTEGER");
    // Tasks that stopped before #492 count as reviewed, so 要対応 starts empty rather than listing the whole history.
    db.exec("UPDATE tasks SET reviewed_at = updated_at WHERE status NOT IN ('running', 'waiting', 'idle')");
  }
  if (!cols.has("archived_at")) db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER");
  // #1139: a stage Task's Issue and stage were read off its title; they are columns now. Rows from before take them from
  // the title once, here (the title forms are a copy of what startTitle wrote then; nothing reads a title afterwards).
  // One transaction: an interruption between the ALTERs and the backfill would otherwise leave the columns present and the block skipped for good.
  if (!cols.has("stage_issue")) {
    db.transaction(() => {
      db.exec("ALTER TABLE tasks ADD COLUMN stage_issue INTEGER");
      db.exec("ALTER TABLE tasks ADD COLUMN stage_action TEXT");
      const actionOfName: Record<string, string> = { "PBI にする": "to-pbi", "Task に分解": "to-tasks", "実装": "complete", "状況確認": "check", "閉じる": "close" };
      const set = db.query("UPDATE tasks SET stage_issue = ?, stage_action = ? WHERE id = ?");
      for (const r of db.query("SELECT id, title FROM tasks WHERE title GLOB '#[0-9]* *'").all() as Array<{ id: string; title: string }>) {
        const m = /^#(\d+) (PBI にする|Task に分解|実装|状況確認|閉じる): /.exec(r.title);
        if (m) set.run(Number(m[1]), actionOfName[m[2]!]!, r.id);
      }
    })();
  }
  db.exec("CREATE INDEX IF NOT EXISTS tasks_stage ON tasks (workspace_id, stage_issue)");
  if (!cols.has("judged_result")) db.exec("ALTER TABLE tasks ADD COLUMN judged_result TEXT");
  if (!cols.has("judged_reason")) db.exec("ALTER TABLE tasks ADD COLUMN judged_reason TEXT");
  if (!cols.has("judged_by")) db.exec("ALTER TABLE tasks ADD COLUMN judged_by TEXT");
  if (!cols.has("judging_at")) db.exec("ALTER TABLE tasks ADD COLUMN judging_at INTEGER"); // #1139
  // #1431: where a finished task's event bodies went (S3 key, when, how many rows); the rows stay, as skeletons.
  if (!cols.has("events_archive_key")) db.exec("ALTER TABLE tasks ADD COLUMN events_archive_key TEXT");
  if (!cols.has("events_archived_at")) db.exec("ALTER TABLE tasks ADD COLUMN events_archived_at INTEGER");
  if (!cols.has("events_archived_count")) db.exec("ALTER TABLE tasks ADD COLUMN events_archived_count INTEGER");
  if (!cols.has("events_archived_max_seq")) db.exec("ALTER TABLE tasks ADD COLUMN events_archived_max_seq INTEGER");
  // #2029: when a task came to its status was not kept; rows from before take their last update, the best known bound
  if (!cols.has("status_at")) {
    db.transaction(() => {
      db.exec("ALTER TABLE tasks ADD COLUMN status_at INTEGER");
      db.exec("UPDATE tasks SET status_at = updated_at");
    })();
  }
  const wsCols = new Set((db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!wsCols.has("project_var")) db.exec("ALTER TABLE workspaces ADD COLUMN project_var TEXT");
  if (!wsCols.has("backlog_source")) db.exec("ALTER TABLE workspaces ADD COLUMN backlog_source TEXT");
  const logCols = new Set((db.query("PRAGMA table_info(routing_log)").all() as Array<{ name: string }>).map((c) => c.name));
  // Rows written before #25 are all rule-table suggestions, which is what the default says.
  if (!logCols.has("suggested_by")) db.exec("ALTER TABLE routing_log ADD COLUMN suggested_by TEXT NOT NULL DEFAULT 'rule'");
  // After the ALTER (the index needs the column). Unique: one shadow per primary; NULLs (every other task) do not collide.
  db.exec("DROP INDEX IF EXISTS tasks_shadow_of");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_shadow_of_unique ON tasks (shadow_of)");
  const lcols = new Set((db.query("PRAGMA table_info(ledger)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!lcols.has("billed_usd")) db.exec("ALTER TABLE ledger ADD COLUMN billed_usd REAL NOT NULL DEFAULT 0");
  if (!lcols.has("cache_write_1h")) db.exec("ALTER TABLE ledger ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0");
  // #2353: Claude's `total_cost_usd` is the session's running total, and every turn booked it whole. The rows of a
  // Task's own turns (a reported usage event of the same Task at the same time; the judge's and the routing's one-shot
  // rows have none and are each a whole fresh session) become the difference from the Task's previous row, a total
  // that went down being a new session. The total (all the models of the session together) stays in reported_total,
  // marked migrated, with the session the Task's next turn resumes (`runner_session_id`; none = it starts a new one):
  // the next rows of that session count each model's first total against it (`migratedCredit`).
  if (!lcols.has("reported_total")) {
    db.transaction(() => {
      db.exec("ALTER TABLE ledger ADD COLUMN reported_total TEXT");
      const rows = db
        .query(
          `SELECT id, task_id AS taskId, cost_usd AS cost, billed_usd AS billed, (SELECT runner_session_id FROM tasks t WHERE t.id = l.task_id) AS session
           FROM ledger l
           WHERE runner = 'claude' AND source = 'reported' AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = l.task_id AND e.ts = l.ts
             AND json_extract(e.json, '$.t') = 'usage' AND json_extract(e.json, '$.source') = 'reported')
           ORDER BY task_id, id`,
        )
        .all() as Array<{ id: number; taskId: string; cost: number; billed: number; session: string | null }>;
      const set = db.query("UPDATE ledger SET cost_usd = ?, billed_usd = ?, reported_total = ? WHERE id = ?");
      let task = "";
      let prev = 0;
      for (const r of rows) {
        if (r.taskId !== task) [task, prev] = [r.taskId, 0];
        const turn = r.cost >= prev ? Math.round((r.cost - prev) * 1e10) / 1e10 : r.cost;
        prev = r.cost;
        set.run(turn, r.billed === r.cost ? turn : r.billed, JSON.stringify({ costUsd: r.cost, migrated: true, ...(r.session ? { session: r.session } : {}) }), r.id);
      }
    })();
  }
  // staging gained diff_text / stat with #12; a database from before that made every fs.write / fs.patch fail (#66).
  const schCols = new Set((db.query("PRAGMA table_info(schedules)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!schCols.has("action")) db.exec("ALTER TABLE schedules ADD COLUMN action TEXT NOT NULL DEFAULT 'prompt'");
  // #832: the Tasks that start by themselves ran on routing.llm.runner; they now have settings.autoStart, which starts at that value.
  const settingsRow = db.query("SELECT json FROM settings WHERE key = 'settings'").get() as { json: string } | null;
  if (settingsRow) {
    try {
      const saved = JSON.parse(settingsRow.json) as { autoStart?: unknown; routing?: { llm?: { runner?: string } } };
      if (saved && typeof saved === "object" && !saved.autoStart) {
        saved.autoStart = { runner: saved.routing?.llm?.runner ?? "claude", model: "" };
        db.query("UPDATE settings SET json = ? WHERE key = 'settings'").run(JSON.stringify(saved));
      }
    } catch {
      // a malformed row is reported and replaced by the defaults when it is read (server.ts settings())
    }
  }
  if (!schCols.has("model")) db.exec("ALTER TABLE schedules ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  if (!schCols.has("effort")) db.exec("ALTER TABLE schedules ADD COLUMN effort TEXT NOT NULL DEFAULT ''"); // #833
  if (!schCols.has("last_result")) db.exec("ALTER TABLE schedules ADD COLUMN last_result TEXT"); // #1274, JSON of ScheduleResult
  const perfCols = new Set((db.query("PRAGMA table_info(perf_samples)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!perfCols.has("task_id")) db.exec("ALTER TABLE perf_samples ADD COLUMN task_id TEXT"); // #2100; earlier rows stay null
  if (!perfCols.has("bytes")) db.exec("ALTER TABLE perf_samples ADD COLUMN bytes INTEGER");
  if (!perfCols.has("events")) db.exec("ALTER TABLE perf_samples ADD COLUMN events INTEGER");
  const scols = new Set((db.query("PRAGMA table_info(staging)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!scols.has("diff_text")) db.exec("ALTER TABLE staging ADD COLUMN diff_text TEXT NOT NULL DEFAULT ''");
  if (!scols.has("stat")) db.exec("ALTER TABLE staging ADD COLUMN stat TEXT NOT NULL DEFAULT ''");
  // an add to the Project refused as "already exists" (its auto-add came first) failed the operation; the sender now takes
  // the item that is there, so such an operation is sent again (a create only with the Issue it made: never made twice).
  // GitHub's "Something went wrong" failed it at once too; it is an outage now, sent again (not one failed after 5 tries)
  db.exec(`UPDATE backlog_operations SET status = 'pending', attempt = 0, retry_at = NULL, error = NULL WHERE status = 'failed' AND (error LIKE '%already exists in this project%' OR error LIKE 'gh api %: gh: Something went wrong while executing your query%') AND (kind != 'create' OR remote_id IS NOT NULL)`);
  // #1059: a stored PR gained `updatedAt` and `files`; one stored before is dropped and the next import reads it again
  db.exec(`DELETE FROM backlog_records WHERE object_kind = 'pull-request' AND json_type(remote, '$.files') IS NULL AND json_type(remote, '$.updatedAt') IS NULL`);
  // #1183: a stored PR gained `closes`; one stored before reads as closing nothing until the next import reads it
  for (const col of ["remote", "base", "local"])
    db.exec(`UPDATE backlog_records SET ${col} = json_set(${col}, '$.closes', json('[]')) WHERE object_kind = 'pull-request' AND ${col} IS NOT NULL AND json_type(${col}, '$.closes') IS NULL`);
  // #1014: a stored Issue gained `stateReason`, a PR `mergeCommit`; null until the next import, which reads every Issue
  // again when a value GitHub gave lacked them (one made here gets them when it is sent)
  // #651: a stored Issue / PR gained `closedAt` (a PR `mergedAt`): the same, so a closed one is read again for its time
  const reasonless = `(object_kind = 'issue' AND (json_type(remote, '$.stateReason') IS NULL OR json_type(remote, '$.closedAt') IS NULL)) OR (object_kind = 'pull-request' AND (json_type(remote, '$.mergeCommit') IS NULL OR json_type(remote, '$.closedAt') IS NULL OR json_type(remote, '$.mergedAt') IS NULL))`;
  // IMMEDIATE: a deferred one reads first and then cannot write when another connection (the daemon, while a CLI such
  // as events-archive opens the file) committed in between — SQLITE_BUSY_SNAPSHOT, which busy_timeout does not wait out (#1597)
  db.transaction(() => {
    if (db.query(`SELECT 1 FROM backlog_records WHERE remote IS NOT NULL AND (${reasonless}) LIMIT 1`).get()) db.exec("UPDATE backlog_repositories SET cursor = NULL");
    for (const col of ["remote", "base", "local"])
      for (const [kind, key] of [["issue", "stateReason"], ["issue", "closedAt"], ["pull-request", "mergeCommit"], ["pull-request", "closedAt"], ["pull-request", "mergedAt"]])
        db.exec(`UPDATE backlog_records SET ${col} = json_set(${col}, '$.${key}', json('null')) WHERE object_kind = '${kind}' AND ${col} IS NOT NULL AND json_type(${col}, '$.${key}') IS NULL`);
  }).immediate();
}

/**
 * Tasks still marked running / waiting when a daemon starts belonged to a daemon that is gone (#64): no process can
 * answer for them. They are closed as aborted — the reason goes into session.end.summary (what the transcript shows
 * under 中断), open permission asks are resolved as denied by timeout so no tool row stays 承認待ち — so they neither
 * look alive in the UI nor sit in the queue — and the turn is planned to continue like one the shutdown cut
 * (interrupted.ts), up to `maxStopResumes` stops in a row. One transaction; returns the ids that were closed.
 */
export function abortOrphanedTasks(db: Db, now = Date.now(), maxStopResumes = MAX_STOP_RESUMES): string[] {
  const ids: string[] = [];
  db.sqlite.transaction(() => {
    for (const status of ["running", "waiting"] as const) {
      for (const t of db.listTasksByStatus(status)) {
        if (t.executionMode === "cloud") {
          db.updateTask(t.id, { status: t.cloudSession ? "idle" : "error", runnerSessionId: null, resumeAt: null });
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
  })();
  return ids;
}

/** A row of history_imports; `state` is the serialized parser state of the adapter (opaque here). */
export interface HistoryImportRow {
  sessionId: string;
  taskId: string;
  path: string;
  offset: number;
  state: string;
  importedAt: number;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBacklogRecord(r: any): BacklogRecord {
  const json = (v: string | null) => (v === null ? null : JSON.parse(v));
  return {
    service: r.service, host: r.host, repository: r.repository, objectKind: r.object_kind, externalId: r.external_id,
    remote: json(r.remote), base: json(r.base), local: json(r.local), fetchedAt: r.fetched_at, fetchState: r.fetch_state,
  } as BacklogRecord;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBacklogOperation(r: any): BacklogOperation {
  return {
    seq: r.seq, id: r.id, service: r.service, host: r.host, repository: r.repository, issue: r.issue, targetKind: r.target_kind, target: r.target, kind: r.kind, field: r.field,
    payload: JSON.parse(r.payload), base: r.base === null ? null : JSON.parse(r.base), status: r.status, attempt: r.attempt, retryAt: r.retry_at, remoteId: r.remote_id,
    error: r.error, overwritten: r.overwritten == null ? null : JSON.parse(r.overwritten), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToWorkspace(r: any): Workspace {
  // a workspace whose backlog is kept here only (#2265), or whose GitHub sync is off (#2266), says so in its source
  // (backlog.ts syncsGithub); none, or a GitHub one = github
  const source = r.backlog_source ? (JSON.parse(r.backlog_source) as BacklogSource) : null;
  const backlog = source && (source.service === "switchboard" || source.disabled) ? "switchboard" : "github";
  return { id: r.id, name: r.name, path: r.path, kind: r.kind, createdAt: r.created_at, backlog, ...(r.project_var ? { projectVar: r.project_var } : {}) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSchedule(r: any): Schedule {
  return { id: r.id, title: r.title, cron: r.cron, workspaceId: r.workspace_id, runner: r.runner, model: r.model ?? "", effort: r.effort ?? "", prompt: r.prompt, action: r.action ?? "prompt", budgetUsd: r.budget_usd ?? null, enabled: r.enabled === 1, lastRunAt: r.last_run_at ?? null, lastTaskId: r.last_task_id ?? null, nextRunAt: r.next_run_at ?? null, lastResult: r.last_result ? (JSON.parse(r.last_result) as Schedule["lastResult"]) : null, createdAt: r.created_at };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToStaged(r: any): StagedChange {
  return { id: r.id, taskId: r.task_id, path: r.path, rel: r.rel, kind: r.kind, before: r.before_text ?? null, after: r.after_text, status: r.status, ts: r.ts, decidedAt: r.decided_at ?? null, diff: r.diff_text ?? "", stat: r.stat ?? "" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToHistoryImport(r: any): HistoryImportRow {
  return { sessionId: r.session_id, taskId: r.task_id, path: r.path, offset: r.offset, state: r.state ?? "", importedAt: r.imported_at };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToArtifact(r: any): Artifact {
  return { id: r.id, taskId: r.task_id, title: r.title, kind: r.kind, source: r.source, entry: r.entry ?? null, mime: r.mime, size: Number(r.size), removedAt: r.removed_at ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToReport(r: any): ReportRow {
  return { ...rowToArtifact(r), taskTitle: String(r.task_title), scheduleTitle: r.schedule_title ?? null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAttachment(r: any): Attachment {
  return { id: r.id, taskId: r.task_id ?? null, name: r.name, mime: r.mime, size: Number(r.size), path: r.path, createdAt: Number(r.created_at) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToHistorySession(r: any): HistorySession {
  return { sessionId: r.session_id, taskId: r.task_id, origin: (r.origin ?? "switchboard") as TaskOrigin, path: r.path, pathDisplay: displayPath(r.path), offset: r.offset, importedAt: r.imported_at };
}

/** `/Users/x/.claude/…` → `~/.claude/…` for display; the daemon knows homedir(), the browser does not. */
export function displayPath(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToKnowledge(r: any): KnowledgeDoc {
  return { path: r.path, title: r.title, kind: r.kind, frontmatter: safeJson(r.frontmatter, {}), mtime: r.mtime, size: r.size };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTask(r: any): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id ?? null,
    title: r.title,
    runner: r.runner as RunnerId,
    cwd: r.cwd,
    scope: safeJson<string[]>(r.scope, []),
    status: r.status as TaskStatus,
    executionMode: r.execution_mode,
    sourceCloudTaskId: r.source_cloud_task_id,
    cloudSession: r.cloud_session === null ? null : CloudSessionRef.parse(JSON.parse(r.cloud_session)),
    runnerSessionId: r.runner_session_id ?? null,
    model: r.model ?? null,
    routing: r.routing ? safeJson(r.routing, null) : null,
    budgetUsd: r.budget_usd ?? null,
    scheduleId: r.schedule_id ?? null,
    permissionMode: r.permission_mode ?? null,
    effort: r.effort ?? null,
    origin: (r.origin ?? "switchboard") as TaskOrigin,
    resumeAt: r.resume_at ?? null,
    resumeReason: r.resume_reason ?? null,
    shadowOf: r.shadow_of ?? null,
    shadowStopped: !!r.shadow_stopped,
    workspaceReason: r.workspace_reason ?? null,
    outcome: (r.outcome ?? "unknown") as TaskOutcome,
    reviewedAt: r.reviewed_at ?? null,
    archivedAt: r.archived_at ?? null,
    judgedResult: (r.judged_result ?? null) as Task["judgedResult"],
    judgedReason: r.judged_reason ?? null,
    judgedBy: r.judged_by ?? null,
    judgingAt: r.judging_at ?? null,
    stage: r.stage_issue == null ? null : { issue: r.stage_issue, action: r.stage_action as BacklogAction },
    statusAt: r.status_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A Task's size class by its event count (#2103); null when the sample has none. */
export function sizeClass(events: number | null): SizeClass | null {
  return events === null ? null : events <= 1000 ? "small" : events <= 5000 ? "medium" : "large";
}

/** The nearest-rank `p` quantile of an ascending, non-empty list (perfSummary, opsLatency). */
export function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/** The middle value; the mean of the middle two for an even count; null for none. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const JST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" });
/** `YYYY-MM-DD` of the JST date, whatever the daemon's time zone. */
export function jstDay(ts: number): string {
  return JST_DAY.format(new Date(ts));
}

/** 00:00 JST of the day `back` days before `now`'s JST day. JST has no daylight saving, so every day is 24 h. */
export function jstDayStart(now: number, back = 0): number {
  return Date.parse(`${jstDay(now)}T00:00:00+09:00`) - back * 86_400_000;
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
