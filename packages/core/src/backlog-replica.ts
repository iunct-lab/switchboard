import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { BacklogObjectKind, BacklogSource } from "@switchboard/protocol";
import type { BacklogOperation, BacklogSnapshotEntry, Db } from "./db.ts";
import { importedId, readSent, sentId, takeRefusals, uploadBacklogOperations } from "./backlog-upbox.ts";
import type { S3Store } from "./s3.ts";

/**
 * A work machine's backlog: a copy of what the instance has stored, taken from the instance's database file (its
 * Litestream replica, restored by `fetchReplica`). The work machine never asks the backlog's service. The copy goes
 * into the tables the work machine already reads the backlog from, as what the service has (`remote`), so every reader
 * — the screen, `ops-kit backlog list` / `view` — answers as it always does, with the work machine's own edits still
 * waiting shown on top. A copy replaces the one before it whole.
 *
 * The copy also brings back what came of the edits the work machine put in the uplink bucket (backlog-upbox.ts): an
 * operation the instance sent is done here too and its record takes the number the service gave; one the instance
 * could not send shows its state and reason here.
 */
export class ReplicaError extends Error {
  constructor(readonly kind: "newer" | "missing" | "unread" | "fetch", message: string) {
    super(message);
  }
}

const REPLICA_KEY = "backlog.replica";
const TABLES = ["backlog_records", "backlog_repositories", "backlog_operations"];

/** Per repository (`service/host/repository`), when its copy was last taken here. */
export function replicaTakenAt(db: Db, source: Pick<BacklogSource, "service" | "host" | "repository">): number | null {
  return db.getSetting<Record<string, number>>(REPLICA_KEY, {})[`${source.service}/${source.host}/${source.repository}`] ?? null;
}

const columns = (sqlite: Database, table: string) => (sqlite.query("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map((c) => c.name);

/**
 * Takes the copy at `replicaPath` in for the workspace `at.workspaceId`, whose repository is `at.repository`
 * (`owner/name`): the workspace reads what the instance's workspace of that repository reads (set here, the Project
 * with it). Throws ReplicaError when the instance's database is of a newer shape than this one (`newer`), when no
 * workspace of the instance reads the repository (`missing`), or when the instance never imported it (`unread`) —
 * what was copied before stays. Returns how many records the copy holds and when the instance last imported.
 */
export function importReplica(db: Db, replicaPath: string, at: { workspaceId: string; repository: string }, now = Date.now()): { records: number; replicaSyncedAt: number; settled: number } {
  const replica = new Database(replicaPath, { readonly: true });
  try {
    for (const t of TABLES) {
      const known = new Set(columns(db.sqlite, t));
      const more = columns(replica, t).filter((c) => !known.has(c));
      if (more.length) throw new ReplicaError("newer", `写しを取り込めません: EC2 の DB のほうが新しい形です（${t} の ${more.join("・")}）。この作業場を更新してください`);
    }
    const sources = (replica.query("SELECT backlog_source FROM workspaces WHERE backlog_source IS NOT NULL").all() as Array<{ backlog_source: string }>).map((r) => JSON.parse(r.backlog_source) as BacklogSource);
    const source = sources.find((s) => s.service !== "switchboard" && !s.disabled && s.repository.toLowerCase() === at.repository.toLowerCase());
    if (!source) throw new ReplicaError("missing", `写しを取り込めません: EC2 に ${at.repository} を読む workspace がありません`);
    const key = [source.service, source.host, source.repository] as const;
    const sync = replica.query("SELECT last_successful_sync FROM backlog_repositories WHERE service = ? AND host = ? AND repository = ?").get(...key) as { last_successful_sync: number | null } | null;
    if (sync?.last_successful_sync == null) throw new ReplicaError("unread", `写しを取り込めません: EC2 はまだ ${at.repository} を取り込んでいません`);
    const rows = replica.query("SELECT object_kind, external_id, remote, fetch_state FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND remote IS NOT NULL").all(...key) as Array<{ object_kind: BacklogObjectKind; external_id: string; remote: string; fetch_state: string }>;
    const records: BacklogSnapshotEntry[] = [];
    for (const r of rows) {
      records.push({ objectKind: r.object_kind, externalId: r.external_id, remote: JSON.parse(r.remote), fetchState: "fetched" } as BacklogSnapshotEntry);
      // one the service stopped answering for keeps its last value and its mark, as on the instance
      if (r.fetch_state !== "fetched") records.push({ objectKind: r.object_kind, externalId: r.external_id, remote: null, fetchState: r.fetch_state } as unknown as BacklogSnapshotEntry);
    }
    const mine: BacklogSource = { service: source.service, host: source.host, repository: source.repository, project: source.project };
    const sent = readSent(db);
    const outcome = replica.query("SELECT * FROM backlog_operations WHERE id = ?");
    const remoteOf = replica.query("SELECT remote FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ? AND remote IS NOT NULL");
    let settled = 0;
    db.sqlite.transaction(() => {
      db.setWorkspaceBacklogSource(at.workspaceId, mine);
      const waiting = db.listPendingBacklogOperations(mine);
      /** What the instance made of an operation put from here: the row under the id it was put as, else (a create is never queued twice) its first version's. */
      const cameOf = (op: BacklogOperation) => {
        const id = sentId(sent, op);
        if (id === null) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = (outcome.get(id) ?? (op.kind === "create" ? outcome.get(op.id) : null)) as any;
        return row && ["done", "failed", "conflict"].includes(row.status) ? (row as { status: "done" | "failed" | "conflict"; remote_id: string | null; error: string | null; updated_at: number }) : null;
      };
      // a field's edit the instance could not send, or ended without sending, says so here before the copy is laid
      // under it. One it sent is judged against the copy as an import judges it: done once the copy has its value
      // (a copy taken between the instance's write and its read-back still has the old one, and the edit stays on top)
      const sentSets: Array<{ op: BacklogOperation; at: number }> = [];
      for (const op of waiting) {
        const r = op.kind === "set" ? cameOf(op) : null;
        if (!r) continue;
        if (r.status === "done" && r.error === null) {
          sentSets.push({ op, at: r.updated_at });
          continue;
        }
        db.setBacklogOperationResult(op.id, { status: r.status, error: r.status === "done" ? r.error : `EC2: ${r.error ?? r.status}`, retryAt: null }, now);
        settled++;
      }
      db.putBacklogSnapshot(mine, { records, cursor: null, syncedAt: sync.last_successful_sync! });
      for (const { op, at: sentAt } of sentSets) {
        const left = db.getBacklogOperation(op.id);
        if (left?.status === "done") settled++;
        // sent, and the instance has imported since: whatever the service has now came after it
        else if (sync.last_successful_sync! >= sentAt) {
          const rec = db.getBacklogRecord({ ...mine, objectKind: op.targetKind, externalId: op.target });
          db.setBacklogOperationResult(op.id, { status: "done", error: null, retryAt: null, ...(rec?.remote ? { record: { externalId: op.target, remote: rec.remote } } : {}) }, now);
          settled++;
        }
      }
      // what the instance no longer has is not kept (nothing made here: those have no value of the service's)
      const there = new Set(rows.map((r) => `${r.object_kind} ${r.external_id}`));
      for (const r of db.listBacklogRecords(mine)) if (r.remote && !r.local && !there.has(`${r.objectKind} ${r.externalId}`)) db.deleteBacklogRecord({ ...mine, objectKind: r.objectKind, externalId: r.externalId });
      // a new Issue or comment the instance sent: the record made here becomes the service's, under its id
      for (const op of db.listPendingBacklogOperations(mine)) {
        const r = op.kind === "set" ? null : cameOf(op);
        if (!r) continue;
        if (r.status !== "done") db.setBacklogOperationResult(op.id, { status: r.status, error: `EC2: ${r.error ?? r.status}`, retryAt: null }, now);
        else {
          const remote = r.remote_id ? (remoteOf.get(...key, op.targetKind, r.remote_id) as { remote: string } | null) : null;
          // sent, but the copy was taken before the instance stored the record: the next copy has it. One the
          // instance ended without sending (taken back, replaced) made nothing
          if (r.remote_id && !remote) continue;
          db.setBacklogOperationResult(op.id, { status: "done", error: r.error, retryAt: null, ...(remote ? { remoteId: r.remote_id, record: { externalId: r.remote_id!, remote: JSON.parse(remote.remote) } } : {}) }, now);
          if (!remote && op.target.startsWith("local:")) db.deleteBacklogRecord({ ...mine, objectKind: op.targetKind, externalId: op.target });
        }
        settled++;
      }
      db.setSetting(REPLICA_KEY, { ...db.getSetting<Record<string, number>>(REPLICA_KEY, {}), [key.join("/")]: now });
    })();
    return { records: rows.length, replicaSyncedAt: sync.last_successful_sync, settled };
  } finally {
    replica.close();
  }
}

/** Runs a command; a test passes its own. */
export type Run = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const spawn: Run = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

/**
 * Makes at `out` a database holding only what a work machine reads of the instance's (`importReplica`): the stored
 * backlog records and repositories, which repository each workspace reads, and of the operations only those that
 * machine put (`importedId`). Everything else of `full` — the Tasks, their conversations, the settings, the ledger, the
 * instance's own waiting edits — is not copied.
 */
export function narrowReplica(full: string, out: string, machine: string): void {
  rmSync(out, { force: true });
  const db = new Database(out, { create: true });
  try {
    db.query("ATTACH DATABASE ? AS src").run(full);
    const mine = importedId(machine, "");
    // what the service has, not what the instance still has to send (`local`: its own unsent drafts and answers)
    const cols = (db.query("SELECT name FROM src.pragma_table_info('backlog_records')").all() as Array<{ name: string }>).map((c) => (c.name === "local" ? "NULL AS local" : `"${c.name.replaceAll('"', "")}"`));
    db.run(`CREATE TABLE backlog_records AS SELECT ${cols.join(", ")} FROM src.backlog_records WHERE remote IS NOT NULL`);
    db.run("CREATE TABLE backlog_repositories AS SELECT * FROM src.backlog_repositories");
    db.query("CREATE TABLE backlog_operations AS SELECT * FROM src.backlog_operations WHERE substr(id, 1, ?) = ?").run(mine.length, mine);
    db.run("CREATE TABLE workspaces AS SELECT backlog_source FROM src.workspaces WHERE backlog_source IS NOT NULL");
    db.run("DETACH DATABASE src");
  } finally {
    db.close();
  }
}

/**
 * Restores the instance's database from its Litestream replica (`url`: `s3://<bucket>/litestream/switchboard.db`) to
 * `out`, with the `litestream` the instance itself replicates with; read-only credentials are enough. The file appears
 * at `out` whole or not at all (restored beside it, then renamed). With `machine`, what stays at `out` is only the
 * backlog part (`narrowReplica`) and the restored database is removed: the work machine keeps no copy of the instance's
 * other records on its disk. The credentials can still read all of the replica — see docs/design/work-machine.md,
 * "Before deployment". Throws ReplicaError when there is no replica or it cannot be read.
 */
export async function fetchReplica(opts: { url: string; out: string; run?: Run; machine?: string }): Promise<void> {
  const run = opts.run ?? spawn;
  const tmp = `${opts.out}.tmp-${process.pid}`;
  mkdirSync(dirname(opts.out), { recursive: true, mode: 0o700 });
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
  try {
    const r = await run(["litestream", "restore", "-o", tmp, "-if-replica-exists", opts.url]).catch((e: unknown) => ({ code: 127, stdout: "", stderr: String((e as Error)?.message ?? e) }));
    if (r.code !== 0) throw new ReplicaError("fetch", `写しを取れません: ${(r.stderr.trim() || r.stdout.trim() || `litestream が ${r.code} で終わりました`).slice(0, 300)}`);
    // `-if-replica-exists` ends well with nothing written when there is no replica
    if (!existsSync(tmp)) throw new ReplicaError("fetch", `写しを取れません: ${opts.url} に複製がありません`);
    if (opts.machine) {
      try {
        narrowReplica(tmp, `${tmp}.narrow`, opts.machine);
      } catch (e) {
        throw new ReplicaError("fetch", `写しを取れません: 複製を読めません（${String((e as Error)?.message ?? e).slice(0, 200)}）`);
      }
      renameSync(`${tmp}.narrow`, opts.out);
    } else renameSync(tmp, opts.out);
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}.narrow`, `${tmp}.narrow-journal`]) rmSync(f, { force: true });
  }
}

/**
 * What a work machine's `BacklogSync` does in place of asking the service (`BacklogSync.workbench`): `pull` lays the
 * instance's copy under a workspace, `push` puts the workspace's edits in the uplink bucket. The copy is one file for
 * every workspace: it is restored when the one here is older than `replicaIntervalMs` (the whole replica is read from
 * S3 each time, so not more often by itself) or when `force` asks, and a restore under way is shared.
 */
export class Workbench {
  private at = 0;
  private fetching: Promise<void> | null = null;
  constructor(
    private db: Db,
    private opts: {
      /** Where the copy is kept (`<home>/replica/switchboard.db`). */
      file: string;
      url: string;
      intervalMs: number;
      machine: string;
      store: S3Store;
      /** The repository (`owner/name`) a workspace's checkout is of; null = none. */
      repositoryOf: (ws: { id: string; path: string }) => string | null;
      run?: Run;
      clock?: () => number;
    },
  ) {}

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private fetch(force: boolean): Promise<void> {
    if (this.fetching) return this.fetching;
    if (!force && existsSync(this.opts.file) && this.now() - this.at < this.opts.intervalMs) return Promise.resolve();
    if (!this.opts.url) return Promise.reject(new ReplicaError("fetch", "写しを取れません: SWITCHBOARD_REPLICA_URL が設定されていません"));
    const run = fetchReplica({ url: this.opts.url, out: this.opts.file, run: this.opts.run, machine: this.opts.machine })
      .then(() => void (this.at = this.now()))
      .finally(() => (this.fetching = null));
    return (this.fetching = run);
  }

  /** Takes the copy in for the workspace; a copy that cannot be restored leaves the one before it and rejects with the reason. */
  async pull(ws: { id: string; path: string }, force = false): Promise<void> {
    const repository = this.opts.repositoryOf(ws);
    if (!repository) throw new ReplicaError("missing", "写しを取り込めません: この workspace の origin からリポジトリを読めません");
    await this.fetch(force);
    importReplica(this.db, this.opts.file, { workspaceId: ws.id, repository }, this.now());
  }

  /** Puts the edits that wait, then reads what the instance refused of the ones put before (those end as failed, with its reason). */
  async push(_ws: { id: string }, source: BacklogSource): Promise<number> {
    const put = await uploadBacklogOperations(this.db, this.opts.store, source, this.opts.machine, this.now());
    await takeRefusals(this.db, this.opts.store, this.opts.machine, this.now());
    return put;
  }
}
