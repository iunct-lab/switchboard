import type { BacklogSource } from "@switchboard/protocol";
import type { BacklogOperation, BacklogSnapshotEntry, Db } from "./db.ts";
import { type BacklogExport, ExportError, readBacklogExport } from "./backlog-export.ts";
import { readSent, sentId, takeRefusals, uploadBacklogOperations } from "./backlog-upbox.ts";
import type { S3Store } from "./s3.ts";

/**
 * A work machine's backlog: a copy of what the instance has stored, taken from the export the instance wrote for this
 * machine in the uplink bucket (backlog-export.ts). The work machine never asks the backlog's service. The copy goes
 * into the tables the work machine already reads the backlog from, as what the service has (`remote`), so every reader
 * — the screen, `ops-kit backlog list` / `view` — answers as it always does, with the work machine's own edits still
 * waiting shown on top. A copy replaces the one before it whole.
 *
 * The copy also brings back what came of the edits the work machine put in the uplink bucket (backlog-upbox.ts): an
 * operation the instance sent is done here too and its record takes the number the service gave; one the instance
 * could not send shows its state and reason here.
 */

const REPLICA_KEY = "backlog.replica";

/** Per repository (`service/host/repository`), when its copy was last taken here. */
export function replicaTakenAt(db: Db, source: Pick<BacklogSource, "service" | "host" | "repository">): number | null {
  return db.getSetting<Record<string, number>>(REPLICA_KEY, {})[`${source.service}/${source.host}/${source.repository}`] ?? null;
}

/**
 * Takes the export in for the workspace `at.workspaceId`: the workspace reads the repository the instance's workspace
 * reads (set here, the Project with it). What was copied before stays when it throws. Returns how many records the
 * copy holds and when the instance last imported.
 */
export function importBacklogExport(db: Db, exported: BacklogExport, at: { workspaceId: string }, now = Date.now()): { records: number; replicaSyncedAt: number; settled: number } {
  const source = exported.source;
  const key = [source.service, source.host, source.repository] as const;
  const rows = exported.records;
  const records: BacklogSnapshotEntry[] = [];
  for (const r of rows) {
    records.push({ objectKind: r.objectKind, externalId: r.externalId, remote: r.remote, fetchState: "fetched" } as BacklogSnapshotEntry);
    // one the service stopped answering for keeps its last value and its mark, as on the instance
    if (r.fetchState !== "fetched") records.push({ objectKind: r.objectKind, externalId: r.externalId, remote: null, fetchState: r.fetchState } as unknown as BacklogSnapshotEntry);
  }
  const mine: BacklogSource = { service: source.service, host: source.host, repository: source.repository, project: source.project };
  const sent = readSent(db);
  const outcome = new Map(exported.operations.map((o) => [o.id, o]));
  const remoteOf = new Map(rows.map((r) => [`${r.objectKind} ${r.externalId}`, r.remote]));
  let settled = 0;
  db.sqlite.transaction(() => {
    db.setWorkspaceBacklogSource(at.workspaceId, mine);
    const waiting = db.listPendingBacklogOperations(mine);
    /** What the instance made of an operation put from here: the row under the id it was put as, else (a create is never queued twice) its first version's. */
    const cameOf = (op: BacklogOperation) => {
      const id = sentId(sent, op);
      if (id === null) return null;
      const row = outcome.get(id) ?? (op.kind === "create" ? outcome.get(op.id) : undefined);
      return row && ["done", "failed", "conflict"].includes(row.status) ? (row as typeof row & { status: "done" | "failed" | "conflict" }) : null;
    };
    // a field's edit the instance could not send, or ended without sending, says so here before the copy is laid
    // under it. One it sent is judged against the copy as an import judges it: done once the copy has its value
    // (a copy taken between the instance's write and its read-back still has the old one, and the edit stays on top)
    const sentSets: Array<{ op: BacklogOperation; at: number }> = [];
    for (const op of waiting) {
      const r = op.kind === "set" ? cameOf(op) : null;
      if (!r) continue;
      if (r.status === "done" && r.error === null) {
        sentSets.push({ op, at: r.updatedAt });
        continue;
      }
      db.setBacklogOperationResult(op.id, { status: r.status, error: r.status === "done" ? r.error : `EC2: ${r.error ?? r.status}`, retryAt: null }, now);
      settled++;
    }
    db.putBacklogSnapshot(mine, { records, cursor: null, syncedAt: exported.importedAt });
    for (const { op, at: sentAt } of sentSets) {
      const left = db.getBacklogOperation(op.id);
      if (left?.status === "done") settled++;
      // sent, and the instance has imported since: whatever the service has now came after it
      else if (exported.importedAt >= sentAt) {
        const rec = db.getBacklogRecord({ ...mine, objectKind: op.targetKind, externalId: op.target });
        db.setBacklogOperationResult(op.id, { status: "done", error: null, retryAt: null, ...(rec?.remote ? { record: { externalId: op.target, remote: rec.remote } } : {}) }, now);
        settled++;
      }
    }
    // what the instance no longer has is not kept (nothing made here: those have no value of the service's)
    const there = new Set(rows.map((r) => `${r.objectKind} ${r.externalId}`));
    for (const r of db.listBacklogRecords(mine)) if (r.remote && !r.local && !there.has(`${r.objectKind} ${r.externalId}`)) db.deleteBacklogRecord({ ...mine, objectKind: r.objectKind, externalId: r.externalId });
    // a new Issue or comment the instance sent: the record made here becomes the service's, under its id
    for (const op of db.listPendingBacklogOperations(mine)) {
      const r = op.kind === "set" ? null : cameOf(op);
      if (!r) continue;
      if (r.status !== "done") db.setBacklogOperationResult(op.id, { status: r.status, error: `EC2: ${r.error ?? r.status}`, retryAt: null }, now);
      else {
        const remote = r.remoteId ? (remoteOf.get(`${op.targetKind} ${r.remoteId}`) ?? null) : null;
        // sent, but the copy was taken before the instance stored the record: the next copy has it. One the
        // instance ended without sending (taken back, replaced) made nothing
        if (r.remoteId && !remote) continue;
        db.setBacklogOperationResult(op.id, { status: "done", error: r.error, retryAt: null, ...(remote ? { remoteId: r.remoteId, record: { externalId: r.remoteId!, remote } } : {}) }, now);
        if (!remote && op.target.startsWith("local:")) db.deleteBacklogRecord({ ...mine, objectKind: op.targetKind, externalId: op.target });
      }
      settled++;
    }
    db.setSetting(REPLICA_KEY, { ...db.getSetting<Record<string, number>>(REPLICA_KEY, {}), [key.join("/")]: now });
  })();
  return { records: rows.length, replicaSyncedAt: exported.importedAt, settled };
}

/** Forgets what was copied of `repository` when the workspace reads it: the records the service has, when the copy was taken and when the instance imported it. Edits and drafts made here stay. */
export function dropBacklogCopy(db: Db, workspaceId: string, repository: string): void {
  const source = db.getWorkspaceBacklogSource(workspaceId);
  // the workspace reads another repository now: the withdrawn one's records are not what it holds, and the ones it holds stay
  if (!source || source.repository.toLowerCase() !== repository.toLowerCase()) return;
  db.sqlite.transaction(() => {
    for (const r of db.listBacklogRecords(source)) if (!r.local) db.deleteBacklogRecord({ ...source, objectKind: r.objectKind, externalId: r.externalId });
    const taken = db.getSetting<Record<string, number>>(REPLICA_KEY, {});
    delete taken[`${source.service}/${source.host}/${source.repository}`];
    db.setSetting(REPLICA_KEY, taken);
    // nor when the instance last imported it: the readers would still show that time for a copy that is gone
    db.sqlite.query("DELETE FROM backlog_repositories WHERE service = ? AND host = ? AND repository = ?").run(source.service, source.host, source.repository);
  })();
}

/**
 * What a work machine's `BacklogSync` does in place of asking the service (`BacklogSync.workbench`): `pull` lays the
 * instance's export under a workspace, `push` puts the workspace's edits in the uplink bucket. An export is read from the
 * bucket when the one held here for the repository is older than `intervalMs` or when `force` asks (a read under way is
 * shared); a pull in between takes in the held one again, which settles what came of the edits put since.
 */
export class Workbench {
  private held = new Map<string, { at: number; exported: BacklogExport }>();
  private fetching = new Map<string, Promise<BacklogExport>>();
  constructor(
    private db: Db,
    private opts: {
      /** How often the export of a repository is read again (SWITCHBOARD_BACKLOG_COPY_INTERVAL_S). */
      intervalMs: number;
      /** The most of one export that is read (SWITCHBOARD_BACKLOG_EXPORT_MAX_BYTES). */
      maxBytes?: number;
      machine: string;
      store: S3Store;
      /** The repository (`owner/name`) a workspace's checkout is of; null = none. */
      repositoryOf: (ws: { id: string; path: string }) => string | null;
      clock?: () => number;
    },
  ) {}

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private fetch(repository: string, force: boolean): Promise<BacklogExport> {
    const name = repository.toLowerCase();
    const running = this.fetching.get(name);
    if (running) return running;
    const had = this.held.get(name);
    if (!force && had && this.now() - had.at < this.opts.intervalMs) return Promise.resolve(had.exported);
    const read = readBacklogExport(this.opts.store, this.opts.machine, name, this.opts.maxBytes)
      .then((exported) => (this.held.set(name, { at: this.now(), exported }), exported))
      .finally(() => this.fetching.delete(name));
    this.fetching.set(name, read);
    return read;
  }

  /** Takes the copy in for the workspace; an export that cannot be read leaves the copy before it and rejects with the reason. */
  async pull(ws: { id: string; path: string }, force = false): Promise<void> {
    const repository = this.opts.repositoryOf(ws);
    if (!repository) throw new ExportError("missing", "写しを取り込めません: この workspace の origin からリポジトリを読めません");
    try {
      importBacklogExport(this.db, await this.fetch(repository, force), { workspaceId: ws.id }, this.now());
    } catch (e) {
      // the instance withdrew the export: what was copied of the repository is not kept (what was made here and waits stays)
      if (e instanceof ExportError && e.removed) {
        this.held.delete(repository.toLowerCase());
        dropBacklogCopy(this.db, ws.id, repository);
      }
      throw e;
    }
  }

  /** Puts the edits that wait, then reads what the instance refused of the ones put before (those end as failed, with its reason). */
  async push(_ws: { id: string }, source: BacklogSource): Promise<number> {
    const put = await uploadBacklogOperations(this.db, this.opts.store, source, this.opts.machine, this.now());
    await takeRefusals(this.db, this.opts.store, this.opts.machine, this.now());
    return put;
  }
}
