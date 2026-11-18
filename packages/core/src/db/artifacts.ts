/** Artifacts. */

import type { Artifact, ReportRow } from "@switchboard/protocol";
import { RoutingQueries } from "./routing.ts";

/** Artifacts. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class ArtifactQueries extends RoutingQueries {
  /* ---------- artifacts ---------- */

  insertArtifact(a: Artifact): void {
    this.sqlite.query("INSERT INTO artifacts (id, task_id, title, kind, source, entry, mime, size, removed_at, created_at, updated_at, app_days, app_request_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(a.id, a.taskId, a.title, a.kind, a.source, a.entry, a.mime, a.size, a.removedAt, a.createdAt, a.updatedAt, a.appDays, a.appRequestTaskId);
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
   * Artifacts across tasks (for the reports list and the list of every artifact): not removed, newest first by `updated_at` so a
   * refreshed one rises, with the task's title and the schedule's when a schedule started the task. `htmlOnly` keeps
   * the HTML files and folders (the reports). `q` is a literal part of the title, the original path or the task's
   * title. `before` is the id of the previous page's last row. The task's own state (archived, how old) is not read.
   */
  listArtifactsAcross(o: { htmlOnly: boolean; q?: string; before?: string; limit: number }): ReportRow[] {
    const where = ["a.removed_at IS NULL"];
    const args: Array<string | number> = [];
    if (o.htmlOnly) where.push("a.kind IN ('file', 'dir') AND a.mime IN ('text/html', 'application/xhtml+xml')");
    if (o.q) {
      args.push(`%${o.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const p = `?${args.length}`;
      where.push(`(a.title LIKE ${p} ESCAPE '\\' OR a.source LIKE ${p} ESCAPE '\\' OR t.title LIKE ${p} ESCAPE '\\')`);
    }
    if (o.before) {
      args.push(o.before);
      where.push(`(a.updated_at, a.id) < (SELECT updated_at, id FROM artifacts WHERE id = ?${args.length})`);
    }
    return this.sqlite
      .query(
        `SELECT a.*, t.title AS task_title, s.title AS schedule_title FROM artifacts a
         JOIN tasks t ON t.id = a.task_id LEFT JOIN schedules s ON s.id = t.schedule_id
         WHERE ${where.join(" AND ")}
         ORDER BY a.updated_at DESC, a.id DESC LIMIT ?${args.length + 1}`,
      )
      .all(...args, o.limit)
      .map(rowToReport);
  }

  updateArtifact(a: Artifact): void {
    this.sqlite.query("UPDATE artifacts SET title = ?, kind = ?, entry = ?, mime = ?, size = ?, removed_at = ?, updated_at = ? WHERE id = ?").run(a.title, a.kind, a.entry, a.mime, a.size, a.removedAt, a.updatedAt, a.id);
  }

  /**
   * One read through the screen on the local day `day`: counts a new day once. A removed or unknown artifact
   * is not counted (null). `counted` = this call added the day.
   */
  markArtifactAppUse(id: string, day: string): { appDays: number; appRequestTaskId: string | null; counted: boolean } | null {
    const r = this.sqlite.query("UPDATE artifacts SET app_days = app_days + 1, app_last_day = ? WHERE id = ? AND removed_at IS NULL AND (app_last_day IS NULL OR app_last_day != ?) RETURNING app_days, app_request_task_id").get(day, id, day) as { app_days: number; app_request_task_id: string | null } | null;
    if (r) return { appDays: Number(r.app_days), appRequestTaskId: r.app_request_task_id ?? null, counted: true };
    const a = this.getArtifact(id);
    return a && a.removedAt === null ? { appDays: a.appDays, appRequestTaskId: a.appRequestTaskId, counted: false } : null;
  }

  setArtifactAppRequest(id: string, taskId: string): void {
    this.sqlite.query("UPDATE artifacts SET app_request_task_id = ? WHERE id = ?").run(taskId, id);
  }

  deleteArtifact(id: string): void {
    this.sqlite.query("DELETE FROM artifacts WHERE id = ?").run(id);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToArtifact(r: any): Artifact {
  return { id: r.id, taskId: r.task_id, title: r.title, kind: r.kind, source: r.source, entry: r.entry ?? null, mime: r.mime, size: Number(r.size), removedAt: r.removed_at ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), appDays: Number(r.app_days ?? 0), appRequestTaskId: r.app_request_task_id ?? null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToReport(r: any): ReportRow {
  return { ...rowToArtifact(r), taskTitle: String(r.task_title), scheduleTitle: r.schedule_title ?? null };
}
