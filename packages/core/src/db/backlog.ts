/** The stored backlog: the records read from the service, and the edits waiting to be sent. */

import type { BacklogCommentData, BacklogObjectKind, BacklogRecord, BacklogRepositoryKey, BacklogRepositorySync, BacklogSource } from "@switchboard/protocol";
import { backlogFieldValue, conflictRevision, mergeBacklogField, sameBacklogValue } from "../backlog-merge.ts";
import { WorkspaceQueries } from "./workspaces.ts";

/** One record of an import: `remote` is read only when `fetchState` is `fetched`. */
export type BacklogSnapshotEntry = BacklogRecord extends infer R ? (R extends BacklogRecord ? Pick<R, "objectKind" | "externalId" | "remote" | "fetchState"> : never) : never;

/**
 * One change to the backlog made here and not yet sent to the service. `create` = a new Issue (`payload`: its
 * fields), `set` = one field of a record (`payload`: the value; `field` as `applyBacklogField` reads it), `comment` = a
 * new comment (`payload`: `{ body }`). `issue` = the Issue record it belongs to (`local:<uuid>` until it is created):
 * the operations of one Issue are sent in `seq` order, one after the other. `target` = the record it changes (the Issue,
 * one of its comments or Project items). `base` = the field's value the edit was made on (a `set` only): what is sent
 * is held when the service's value is no longer it. `artifact` = one report of a closed PBI's work attached to its Issue
 * on GitHub (`payload`: BacklogArtifactPayload); it changes no stored record.
 */
export type BacklogOperationKind = "create" | "set" | "comment" | "artifact";
/**
 * What an `artifact` operation sends: the registered artifact (its copy is read when it is sent, not kept here), the name
 * it gets on the Issue — also how a second send finds it there — and what it is; `url` for a link.
 */
export interface BacklogArtifactPayload { artifactId: string; name: string; kind: "markdown" | "html" | "link"; url?: string }
/**
 * `pending` = waits to be sent; `sending` = a request is out; `unknown` = the request went out and its answer was lost
 * (a restart turns `sending` into this): looked for before anything is sent again; `conflict` = held, the service's
 * value moved since `base`; `failed` = not retried by itself (auth, permission, input); `done` = sent.
 */
export type BacklogOperationStatus = "pending" | "sending" | "unknown" | "conflict" | "failed" | "done";
/**
 * What the read after a write found in GitHub's edit history: another login's edit of the field between the
 * check and the write, which the write replaced. `value` absent = the revision's content is gone from the history (the
 * editor and the time stay), or `unreadable` = why the history could not be read (then nothing is known); `since` = the
 * check read's time the history is read from, so a later send can read it again.
 */
export interface BacklogOverwritten { value?: unknown; editor: string | null; at: string | null; unreadable?: string; since?: string }
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
  /** A conflict found after the write: kept until chosen on, whatever an import reads. */
  overwritten: BacklogOverwritten | null;
  /** The Task (proved by its token) that asked for it; null = no proof, a work machine's envelope, or written before the column existed. */
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}
/** An operation `applyBacklogEdit` queues (`id`: given, else a new UUID); `replace` = the id of a `pending` one of the same record and field whose payload this replaces instead. */
export type NewBacklogOperation = Pick<BacklogOperation, "issue" | "targetKind" | "target" | "kind" | "payload"> & { id?: string; field?: string; base?: unknown; replace?: string; taskId?: string | null; /** a comment written earlier (moved when GitHub sync is turned on): sent without the window */ noDelay?: boolean };
/** A choice on a conflict refused; `status` = the HTTP status the API answers with. Nothing was changed. */
/** A comment is sent to GitHub only this long after it is written, and can be taken back until then (it notifies people). */
export const SEND_DELAY_MS = 60_000;
/** A comment still inside the window it was written with (not one waiting out a limit or a backoff after a try). */
export function inSendWindow(op: Pick<BacklogOperation, "kind" | "status" | "attempt" | "retryAt" | "createdAt">, now: number): boolean {
  return op.kind === "comment" && op.status === "pending" && op.attempt === 0 && op.retryAt === op.createdAt + SEND_DELAY_MS && op.retryAt > now;
}

export class BacklogResolveError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}
/** A record's value after an edit; a record not stored yet (a new Issue or comment) is added as not fetched. */
export type BacklogLocalEntry = { objectKind: BacklogObjectKind; externalId: string; local: unknown };

/**
 * Applies a `set` operation's `value` to a copy of a record's data: an Issue's `title` / `body` / `state` /
 * `stateReason` / `milestone` / `parent` / `change` (a local change's merge, laid over it), or `label:<name>` (true = on, false = off); a Project item's `field:<name>`. `member` (a
 * Project item in the Project or not) changes no value. Anything else is refused.
 */
export function applyBacklogField(kind: BacklogObjectKind, data: unknown, field: string, value: unknown): unknown {
  if (!isBacklogField(kind, field)) throw new Error(`a ${kind} has no field ${field}`);
  const d = structuredClone(data) as Record<string, any>;
  if (field.startsWith("label:")) {
    const name = field.slice("label:".length);
    d.labels = value ? [...new Set([...(d.labels ?? []), name])] : (d.labels ?? []).filter((l: string) => l !== name);
  } else if (field.startsWith("field:")) d.fields = { ...d.fields, [field.slice("field:".length)]: value };
  // a local change's merge is laid over its branches
  else if (field === "change") d.change = { ...d.change, ...(value as object) };
  else {
    // a close is completed until a `stateReason` operation after it says otherwise, as GitHub answers it; an open Issue
    // has no reason. A state it already has changes nothing
    if (kind === "issue" && field === "state" && d.state !== value) d.stateReason = value === "CLOSED" ? "COMPLETED" : null;
    if (field !== "member") d[field] = value;
  }
  return d;
}

const isBacklogField = (kind: BacklogObjectKind, field: string | null | undefined): field is string =>
  !!field && (kind === "issue" ? /^label:./.test(field) || ["title", "body", "state", "stateReason", "milestone", "parent", "change"].includes(field) : kind === "project-item" && (/^field:./.test(field) || field === "member"));

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The stored backlog: the records read from the service, and the edits waiting to be sent. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class BacklogQueries extends WorkspaceQueries {
  /** The records of a repository as last read, by kind and id, and in the order of the table. Frozen: every caller shares them. */
  private readonly backlogRecordsCopy = new Map<string, { rows: Map<string, BacklogRecord>; records: BacklogRecord[] }>();

  /* ---------- stored backlog ---------- */

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
      const stored = snap.records.map((r) => (r.fetchState === "fetched" && r.remote && r.objectKind === "comment" ? { ...r, remote: this.writtenComment(key, r.externalId, r.remote as BacklogCommentData) } : r));
      for (const r of stored) {
        if (r.fetchState !== "fetched") marked.run(...key, r.objectKind, r.externalId, r.fetchState);
        else if (!r.remote) throw new Error(`a fetched ${r.objectKind} ${r.externalId} has no value`);
        else fetched.run(...key, r.objectKind, r.externalId, JSON.stringify(r.remote), JSON.stringify(r.remote), snap.syncedAt);
      }
      for (const r of stored) if (r.fetchState === "fetched") this.mergeBacklogRecord(repo, r.objectKind, r.externalId, r.remote, snap.syncedAt);
      // an edit waiting to be sent shows on top of what was read: the fields it does not change follow the service
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

  /** What the last import of a workspace read; null = never imported. */
  getWorkspaceBacklogSource(id: string): BacklogSource | null {
    const r = this.sqlite.query("SELECT backlog_source FROM workspaces WHERE id = ?").get(id) as { backlog_source: string | null } | null;
    return r?.backlog_source ? JSON.parse(r.backlog_source) : null;
  }

  setWorkspaceBacklogSource(id: string, source: BacklogSource): void {
    this.sqlite.query("UPDATE workspaces SET backlog_source = ? WHERE id = ?").run(JSON.stringify(source), id);
  }

  /**
   * Moves a repository's stored records and operations under another key (a backlog kept here only, turned to
   * GitHub). The ids do not meet: the records made here are `sb:` ones, GitHub's are its node ids. What is known of the
   * old repository's reads goes with it (the new one has its own).
   */
  moveBacklogRecords(from: BacklogRepositoryKey, to: BacklogRepositoryKey): void {
    for (const table of ["backlog_records", "backlog_operations"])
      this.sqlite.query(`UPDATE ${table} SET service = ?, host = ?, repository = ? WHERE service = ? AND host = ? AND repository = ?`).run(to.service, to.host, to.repository, from.service, from.host, from.repository);
    this.sqlite.query("DELETE FROM backlog_repositories WHERE service = ? AND host = ? AND repository = ?").run(from.service, from.host, from.repository);
  }

  /** A repository's stored records, operations and read state (its last workspace was removed). */
  deleteBacklogRepository(key: BacklogRepositoryKey): void {
    this.sqlite.transaction(() => {
      for (const table of ["backlog_records", "backlog_operations", "backlog_repositories"])
        this.sqlite.query(`DELETE FROM ${table} WHERE service = ? AND host = ? AND repository = ?`).run(key.service, key.host, key.repository);
    })();
  }

  /** A record's value as the service has it, written without a read (a comment made here moved to its Issue's new number); the repository's read state is not touched. */
  setBacklogRecordRemote(key: BacklogRepositoryKey & { objectKind: BacklogObjectKind; externalId: string }, remote: unknown): void {
    this.sqlite.query("UPDATE backlog_records SET remote = ?1, base = CASE WHEN local IS NULL THEN ?1 ELSE base END WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?")
      .run(JSON.stringify(remote), key.service, key.host, key.repository, key.objectKind, key.externalId);
  }

  deleteBacklogRecord(key: BacklogRepositoryKey & { objectKind: BacklogObjectKind; externalId: string }): void {
    this.sqlite.query("DELETE FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?").run(key.service, key.host, key.repository, key.objectKind, key.externalId);
  }

  /** The stage Tasks of a workspace made before `before` (ms) on Issue `from` go to `to`, all at once (a `to` that is another's `from` is not moved twice). */
  renumberStageIssues(workspaceId: string, numbers: Array<{ from: number; to: number }>, before: number): void {
    const ids = numbers.map((n) => ({ ...n, tasks: this.sqlite.query("SELECT id FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND created_at < ?").all(workspaceId, n.from, before) as Array<{ id: string }> }));
    // `updated_at` moves with it: a work machine's uplink sends a Task's row by that time, and the instance takes the newer row
    const now = Date.now();
    for (const n of ids) for (const t of n.tasks) this.sqlite.query("UPDATE tasks SET stage_issue = ?, updated_at = MAX(updated_at, ?) WHERE id = ?").run(n.to, now, t.id);
  }

  getBacklogRepository(repo: BacklogRepositoryKey): BacklogRepositorySync | null {
    const r = this.sqlite.query("SELECT * FROM backlog_repositories WHERE service = ? AND host = ? AND repository = ?").get(repo.service, repo.host, repo.repository) as any;
    return r ? { service: r.service, host: r.host, repository: r.repository, cursor: r.cursor, lastSuccessfulSync: r.last_successful_sync, retryAt: r.retry_at } : null;
  }

  /**
   * A repository's records, of one kind when `kind` is given. Each is read and parsed once, and again only after it is written:
   * the backlog list asks for them on every look, and this API blocks the daemon. Frozen — copy before changing.
   */
  listBacklogRecords(repo: BacklogRepositoryKey, kind?: BacklogObjectKind): BacklogRecord[] {
    const records = this.backlogRecordsOf(repo);
    return kind ? records.filter((r) => r.objectKind === kind) : records;
  }

  private backlogRecordsOf(repo: BacklogRepositoryKey): BacklogRecord[] {
    const key = `${repo.service}/${repo.host}/${repo.repository}`;
    const copy = this.backlogRecordsCopy.get(key);
    const changed = this.sqlite.query("SELECT DISTINCT object_kind, external_id FROM backlog_records_changed WHERE repo = ?").all(key) as Array<{ object_kind: BacklogObjectKind; external_id: string }>;
    if (copy && !changed.length) return copy.records;
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const rowKey = (kind: string, id: string) => `${kind}/${id}`;
    const inOrder = (rows: Map<string, BacklogRecord>) => Object.freeze([...rows.values()].sort((a, b) => cmp(a.objectKind, b.objectKind) || cmp(a.externalId, b.externalId))) as BacklogRecord[];
    if (copy && !this.sqlite.inTransaction) {
      for (const c of changed) {
        const r = this.getBacklogRecord({ ...repo, objectKind: c.object_kind, externalId: c.external_id });
        if (r) copy.rows.set(rowKey(c.object_kind, c.external_id), deepFreeze(r));
        else copy.rows.delete(rowKey(c.object_kind, c.external_id));
      }
      copy.records = inOrder(copy.rows);
    } else {
      const read = this.sqlite.query("SELECT * FROM backlog_records WHERE service = ? AND host = ? AND repository = ?").all(repo.service, repo.host, repo.repository).map(rowToBacklogRecord);
      const rows = new Map(read.map((r) => [rowKey(r.objectKind, r.externalId), deepFreeze(r)]));
      // a rollback takes the notes back, so what a transaction reads is not kept
      if (this.sqlite.inTransaction) return inOrder(rows);
      this.backlogRecordsCopy.set(key, { rows, records: inOrder(rows) });
    }
    this.sqlite.query("DELETE FROM backlog_records_changed WHERE repo = ?").run(key);
    return this.backlogRecordsCopy.get(key)!.records;
  }

  getBacklogRecord(key: BacklogRepositoryKey & { objectKind: BacklogObjectKind; externalId: string }): BacklogRecord | null {
    const r = this.sqlite
      .query("SELECT * FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?")
      .get(key.service, key.host, key.repository, key.objectKind, key.externalId);
    return r ? rowToBacklogRecord(r) : null;
  }

  /* ---------- backlog edits waiting to be sent ---------- */

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
          .query(`INSERT INTO backlog_operations (id, service, host, repository, issue, target_kind, target, kind, field, payload, base, status, retry_at, created_at, updated_at, task_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
          .run(id, ...key, op.issue, op.targetKind, op.target, op.kind, op.field ?? null, payload, op.kind === "set" ? JSON.stringify(op.base ?? null) : null, op.kind === "comment" && !op.noDelay ? now + SEND_DELAY_MS : null, now, now, op.taskId ?? null);
        return id;
      });
      // a record the service has shows its operations on top of it, whatever `local` the caller wrote
      for (const op of edit.operations)
        if (op.kind === "set") {
          this.settleHeldBacklogField(repo, op.targetKind, op.target, op.field!, now);
          this.rebaseBacklogRecord(repo, op.targetKind, op.target);
        }
      return ids;
    })();
  }

  /**
   * Takes in an operation a work machine queued (backlog-upbox.ts) in one transaction with the record it made
   * (`local`: a new Issue's or comment's draft). Unlike `applyBacklogEdit` it is never merged into another operation:
   * the work machine finds what came of it by its id — the id it has there for the version sent first, `<id>@<its
   * updatedAt>` for one it changed afterwards (`first` false). The same version again changes nothing (`known`). A
   * later version takes the place of an earlier one still waiting here (that one ends, unsent; found by the exact id,
   * which carries the machine's name, so it is never an operation of this instance's own or of another machine); a `create` already on
   * its way is never queued twice (`sent`: the Issue is made, its later edits go by its number). It goes without a
   * comment's send window: that passed on the work machine.
   */
  takeBacklogOperation(op: BacklogOperation, local: BacklogLocalEntry | null, first: boolean, now = Date.now()): "taken" | "known" | "sent" {
    const key = [op.service, op.host, op.repository] as const;
    return this.sqlite.transaction(() => {
      const id = first ? op.id : `${op.id}@${op.updatedAt}`;
      if (this.getBacklogOperation(id)) return "known";
      if (op.kind === "set" && !isBacklogField(op.targetKind, op.field)) throw new Error(`a ${op.targetKind} has no field ${op.field}`);
      const earlier = first ? [] : (this.sqlite.query("SELECT * FROM backlog_operations WHERE id = ?1 OR substr(id, 1, length(?1) + 1) = ?1 || '@' ORDER BY seq").all(op.id).map(rowToBacklogOperation) as BacklogOperation[]);
      if (op.kind === "create" && earlier.some((e) => e.status !== "pending")) return "sent";
      for (const e of earlier) if (e.status === "pending") this.sqlite.query("UPDATE backlog_operations SET status = 'done', retry_at = NULL, error = ?, updated_at = ? WHERE seq = ?").run("作業場の後の編集に置き換わりました", now, e.seq);
      if (local)
        this.sqlite
          .query(`INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 'unfetched')
                  ON CONFLICT (service, host, repository, object_kind, external_id) DO UPDATE SET local = excluded.local WHERE remote IS NULL`)
          .run(...key, local.objectKind, local.externalId, JSON.stringify(local.local));
      this.sqlite
        .query(`INSERT INTO backlog_operations (id, service, host, repository, issue, target_kind, target, kind, field, payload, base, status, retry_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`)
        .run(id, ...key, op.issue, op.targetKind, op.target, op.kind, op.field ?? null, JSON.stringify(op.payload), op.kind === "set" ? JSON.stringify(op.base ?? null) : null, op.createdAt, now);
      if (op.kind === "set") {
        this.settleHeldBacklogField(op, op.targetKind, op.target, op.field!, now);
        this.rebaseBacklogRecord(op, op.targetKind, op.target);
      }
      return "taken";
    })();
  }

  /**
   * When the sender starts (the daemon, not every opener of the file — `main.ts export` opens it while the daemon runs):
   * a request that was out when the daemon stopped may have been carried out, so it is looked for before it is sent again.
   */
  recoverBacklogOperations(): void {
    this.sqlite.exec("UPDATE backlog_operations SET status = 'unknown' WHERE status = 'sending'");
  }

  /** A waiting operation's payload, rewritten (its `#N` to GitHub's numbers). */
  setBacklogOperationPayload(id: string, payload: unknown, now = Date.now()): void {
    this.sqlite.query("UPDATE backlog_operations SET payload = ?, updated_at = ? WHERE id = ? AND status != 'done'").run(JSON.stringify(payload), now, id);
  }

  /**
   * The heads of a screen answer's grants, put into its comment operation's payload after the answer was kept
   * (backlog-edit.ts `setAnswerHeads`): into a sent one too — the start of the next stage reads them from it — and with
   * no new `updated_at`: what is sent to the service is the same. An operation that is not a screen answer is left.
   */
  setBacklogAnswerHeads(id: string, heads: Record<string, string | null>): void {
    this.sqlite.query("UPDATE backlog_operations SET payload = json_set(payload, '$.heads', json(?)) WHERE id = ? AND kind = 'comment' AND json_extract(payload, '$.screen') = 1").run(JSON.stringify(heads), id);
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

  /** The Task that asked for the newest operation on `target` (a draft's `local:` id before it is sent, the service's id after); null = none, or none with a proof. */
  backlogOperationTask(repo: BacklogRepositoryKey, target: string): string | null {
    const r = this.sqlite
      .query("SELECT task_id FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? AND (target = ?4 OR remote_id = ?4) ORDER BY seq DESC LIMIT 1")
      .get(repo.service, repo.host, repo.repository, target) as { task_id: string | null } | null;
    return r?.task_id ?? null;
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
        const remote = op.targetKind === "comment" ? this.writtenComment(key, to, result.record.remote as BacklogCommentData) : result.record.remote;
        this.sqlite
          .query("UPDATE backlog_records SET remote = ?1, base = ?1, fetched_at = ?2, fetch_state = 'fetched' WHERE service = ?3 AND host = ?4 AND repository = ?5 AND object_kind = ?6 AND external_id = ?7")
          .run(JSON.stringify(remote), now, ...key, op.targetKind, to);
        this.rebaseBacklogRecord(op, op.targetKind, to);
      }
      if (result.follow?.length) this.applyBacklogEdit(op, { records: [], operations: result.follow }, now);
    })();
  }

  /**
   * A comment the app wrote keeps the time it was written (the time its `comment` operation was made) as its `createdAt`,
   * whichever way the service's value reaches the record: the service's time is when it received the comment, a send
   * delay later, and that would order it after what was written after it. `externalId` = the id the comment is stored
   * under (before its send: the id the operation names; after: the service's, which the operation follows to). A comment
   * no operation names was written elsewhere and keeps the service's time, and so does one whose operation is dated a second or more after it.
   */
  private writtenComment(key: readonly [string, string, string], externalId: string, remote: BacklogCommentData): BacklogCommentData {
    const op = this.sqlite
      .query("SELECT created_at FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? AND target_kind = 'comment' AND target = ? AND kind = 'comment' ORDER BY seq LIMIT 1")
      .get(...key, externalId) as { created_at: number } | null;
    // not past the service's time, which GitHub gives to the second (a comment sent at once is dated up to a second
    // before it was written): an operation made on a work machine whose clock runs ahead is dated by that clock
    return op && op.created_at < Date.parse(remote.createdAt) + 1000 ? { ...remote, createdAt: new Date(op.created_at).toISOString() } : remote;
  }

  /**
   * What an import read decides about the edits of a record waiting to be sent (初期方式 A): per field, the
   * first `pending` set of it (one after it was made on the value the first one sends, not on GitHub's) against
   * GitHub's value — already that value, or the edit changed nothing GitHub did not → done; GitHub moved it off the
   * value the edit was made on to another one → `conflict`, held with its base, its value and GitHub's (nothing is
   * written to GitHub; a Status is left to the send, which reads who moved it); a conflict whose value GitHub came to → done. The rest still go, checked again just before they are written (backlog-send.ts).
   */
  private mergeBacklogRecord(repo: BacklogRepositoryKey, kind: BacklogObjectKind, externalId: string, remote: unknown, now: number): void {
    const ops = this.backlogSetsOf(repo, kind, externalId);
    const seen = new Set<string>();
    for (const op of ops) {
      if (seen.has(op.field!)) continue;
      seen.add(op.field!);
      // the reason of a close still waiting to be sent before it is not GitHub's yet: its send decides
      if (op.field === "stateReason" && ops.some((o) => o.field === "state" && o.seq < op.seq)) continue;
      const value = backlogFieldValue(kind, remote, op.field!);
      if (this.settleBacklogField(ops, op.field!, value, now)) continue;
      if ((op.status !== "pending" && op.status !== "conflict") || value === undefined) continue;
      // a conflict the write itself found: GitHub has the value made here, so a read of it decides nothing —
      // it stays, with its reason, until chosen on
      if (op.status === "conflict" && op.overwritten) continue;
      const m = mergeBacklogField(op.field!, op.base, op.payload, value);
      if (m === "local" && op.status === "pending") continue;
      // a Status moved on GitHub: only the send reads who moved it (its Project automation is not a conflict), so it decides
      if (m === "conflict" && op.status === "pending" && op.field === "field:Status") continue;
      // a conflict stays one until it is chosen on, or GitHub comes to the value made here; its reason names GitHub's
      // value now, whatever it moved to (back to the base too)
      const conflict = m === "conflict" || (op.status === "conflict" && m !== "synced");
      const error = conflict ? `取り込んだ GitHub の値が編集の元から変わっています（${op.field}: GitHub は ${JSON.stringify(value)}）` : null;
      if (conflict && op.status === "conflict" && op.error === error) continue;
      this.sqlite.query("UPDATE backlog_operations SET status = ?, error = ?, retry_at = NULL, updated_at = ? WHERE seq = ?").run(conflict ? "conflict" : "done", error, now, op.seq);
    }
  }

  /** The `set` operations of a record not done yet, oldest first. */
  private backlogSetsOf(repo: BacklogRepositoryKey, kind: BacklogObjectKind, externalId: string): BacklogOperation[] {
    return this.sqlite
      .query("SELECT * FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? AND target_kind = ? AND target = ? AND kind = 'set' AND status != 'done' ORDER BY seq")
      .all(repo.service, repo.host, repo.repository, kind, externalId)
      .map(rowToBacklogOperation);
  }

  /**
   * GitHub already has what the last edit of a Project field makes: the ones before it are on their way there,
   * and nothing is left to choose — all of them are done (one the write itself held, with `overwritten`, stays;
   * `keepLast`: the last one stays to be sent). Only a Project field: a label on and off again (a question, then its
   * answer) is not skipped.
   */
  private settleBacklogField(ops: BacklogOperation[], name: string, value: unknown, now: number, keepLast = false): boolean {
    const field = ops.filter((o) => o.field === name && (o.status === "pending" || o.status === "conflict") && !o.overwritten);
    const last = field.at(-1);
    if (!name.startsWith("field:") || value === undefined || field.length < 2 || !sameBacklogValue(name, last!.payload, value)) return false;
    for (const o of keepLast ? field.slice(0, -1) : field) this.sqlite.query("UPDATE backlog_operations SET status = 'done', error = ?, retry_at = NULL, updated_at = ? WHERE seq = ?").run(o === last ? null : "後の編集の値に GitHub が既になっています", now, o.seq);
    return true;
  }

  /**
   * A new edit of a field held as a conflict, against GitHub's value as stored: the import that would settle it may
   * never come (the Project item of a closed Issue is not read again), and the conflict holds the Issue's comments too.
   * The new edit stays to be sent: the stored value may be old, and the check before the write reads GitHub's.
   */
  private settleHeldBacklogField(repo: BacklogRepositoryKey, kind: BacklogObjectKind, externalId: string, field: string, now: number): void {
    const ops = this.backlogSetsOf(repo, kind, externalId);
    if (!ops.some((o) => o.field === field && o.status === "conflict")) return;
    const r = this.getBacklogRecord({ ...repo, objectKind: kind, externalId });
    if (r?.fetchState === "fetched") this.settleBacklogField(ops, field, backlogFieldValue(kind, r.remote, field), now, true);
  }

  /**
   * The user's choice on a held `set`: `local` sends the value made here again, now made on GitHub's value
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
        // found after the write: GitHub has the value made here. Remote = the other's value goes back as a
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

  /**
   * A `failed` operation sent again, its cause put right: back to `pending` as at first (the value the
   * enabling's second press sets). A create that made its Issue keeps `remoteId`, so it goes on from the steps after
   * it. Throws BacklogResolveError: 404 = no such operation of the repository, 409 = not failed (nothing changed).
   */
  retryBacklogOperation(repo: BacklogRepositoryKey, id: string, now = Date.now()): void {
    this.sqlite.transaction(() => {
      const op = this.getBacklogOperation(id);
      if (!op || op.service !== repo.service || op.host !== repo.host || op.repository !== repo.repository) throw new BacklogResolveError(`操作 ${id} はありません`, 404);
      if (op.status !== "failed") throw new BacklogResolveError("この操作は失敗で保留されていません", 409);
      this.sqlite.query("UPDATE backlog_operations SET status = 'pending', attempt = 0, retry_at = NULL, error = NULL, updated_at = ? WHERE id = ?").run(now, id);
    })();
  }

  /**
   * A comment taken back inside its send window (SEND_DELAY_MS): nothing is sent for it, it is `done` with why. Throws
   * BacklogResolveError: 404 = no such operation of the repository, 409 = not a comment still waiting in its window
   * (it is being sent, sent, or past the window).
   */
  cancelBacklogOperation(repo: BacklogRepositoryKey, id: string, now = Date.now()): void {
    this.sqlite.transaction(() => {
      const op = this.getBacklogOperation(id);
      if (!op || op.service !== repo.service || op.host !== repo.host || op.repository !== repo.repository) throw new BacklogResolveError(`操作 ${id} はありません`, 404);
      if (!inSendWindow(op, now)) throw new BacklogResolveError("このコメントは取り消せる間（送る前）を過ぎています", 409);
      this.sqlite.query("UPDATE backlog_operations SET status = 'done', retry_at = NULL, error = '送る前に取り消しました', updated_at = ? WHERE id = ?").run(now, id);
      // the comment kept here goes with it, as a withdrawn post's does: nothing reads its words (or its heading) any more
      if (op.target.startsWith("local:")) this.sqlite.query("DELETE FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?").run(op.service, op.host, op.repository, op.targetKind, op.target);
    })();
  }

  /**
   * Takes back an operation held `unknown` or `failed`: nothing is sent to the service for it, it is `done` with
   * why (`error`), and the Issue's operations after it go on. A post never made (its target still `local:`) leaves no
   * record behind; a create of an Issue never made takes the Issue's operations after it back with it (they cannot be
   * sent to an Issue that does not exist), its record and its comments' too. 404 = no such operation of the repository,
   * 409 = not held so (one being sent is `sending`), or an operation of the enabling of GitHub sync (an `sb:` target).
   */
  withdrawBacklogOperation(repo: BacklogRepositoryKey, id: string, reason: string, now = Date.now()): void {
    this.sqlite.transaction(() => {
      const op = this.getBacklogOperation(id);
      if (!op || op.service !== repo.service || op.host !== repo.host || op.repository !== repo.repository) throw new BacklogResolveError(`操作 ${id} はありません`, 404);
      if (op.status !== "unknown" && op.status !== "failed") throw new BacklogResolveError("この操作は結果不明か失敗で保留されていません", 409);
      // the enabling of GitHub sync waits for its creates and comments (backlog-enable.ts): sent again, never taken back
      if (op.target.startsWith("sb:")) throw new BacklogResolveError("GitHub 同期の有効化の操作は取り下げられません（有効化をもう一度押すか retry で送り直します）", 409);
      const key = [op.service, op.host, op.repository] as const;
      const unmade = op.kind === "create" && op.target.startsWith("local:");
      const why = `取り下げました: ${reason}`.slice(0, 300);
      const take = (o: BacklogOperation) => {
        this.sqlite.query("UPDATE backlog_operations SET status = 'done', retry_at = NULL, error = ?, updated_at = ? WHERE id = ?").run(why, now, o.id);
        if (o.target.startsWith("local:")) this.sqlite.query("DELETE FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND object_kind = ? AND external_id = ?").run(...key, o.targetKind, o.target);
      };
      // an Issue never made: what was to be sent to it goes with it
      if (unmade && op.kind === "create") for (const o of this.listPendingBacklogOperations(op).filter((o) => o.issue === op.issue && o.id !== id)) take(o);
      take(op);
      if (op.kind === "set") this.rebaseBacklogRecord(op, op.targetKind, op.target);
    })();
  }

  /** The value the last `set` of a field still to send makes; undefined when there is none. */
  lastBacklogSetValue(repo: BacklogRepositoryKey, targetKind: BacklogObjectKind, target: string, field: string): unknown {
    const r = this.sqlite
      .query("SELECT payload FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? AND target_kind = ? AND target = ? AND kind = 'set' AND field = ? AND status IN ('pending', 'conflict', 'sending', 'unknown') ORDER BY seq DESC LIMIT 1")
      .get(repo.service, repo.host, repo.repository, targetKind, target, field) as { payload: string } | null;
    return r ? JSON.parse(r.payload) : undefined;
  }

  /** GitHub's value of a `set`'s field as last imported; undefined = not read (never, or 404 / 403 on the last read). */
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
    error: r.error, overwritten: r.overwritten == null ? null : JSON.parse(r.overwritten), taskId: r.task_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
