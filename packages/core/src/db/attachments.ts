/** Attachments. */

import type { Attachment } from "@switchboard/protocol";
import { ArtifactQueries } from "./artifacts.ts";

/** Attachments. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class AttachmentQueries extends ArtifactQueries {
  /* ---------- attachments ---------- */

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAttachment(r: any): Attachment {
  return { id: r.id, taskId: r.task_id ?? null, name: r.name, mime: r.mime, size: Number(r.size), path: r.path, createdAt: Number(r.created_at) };
}
