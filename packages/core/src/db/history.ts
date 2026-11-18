/** History imports: which session log feeds which task, and how far it has been read. */

import { homedir } from "node:os";
import type { HistorySession, TaskOrigin } from "@switchboard/protocol";
import { QuotaQueries } from "./quota.ts";

/** History imports: which session log feeds which task, and how far it has been read. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class HistoryImportQueries extends QuotaQueries {
  /* ---------- history imports: which session log feeds which task, and how far it has been read ---------- */

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToHistoryImport(r: any): HistoryImportRow {
  return { sessionId: r.session_id, taskId: r.task_id, path: r.path, offset: r.offset, state: r.state ?? "", importedAt: r.imported_at };
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
