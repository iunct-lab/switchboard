import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Attachment } from "@switchboard/protocol";
import { Db, newId } from "./db.ts";

/** One file at most this big; the UI says so before uploading, the API answers 413 after. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Files per upload request (and per turn). */
export const MAX_ATTACHMENTS_PER_REQUEST = 10;
/** An upload nobody sent with a turn is removed at the next boot after this long. */
export const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** What an attachment-only turn says (the runner still gets the file list). */
export const ATTACHMENT_ONLY_TEXT = "添付ファイルを確認してください。";

/** A refusal with the HTTP status it maps to (404 unknown id, 409 already sent). */
export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Files attached to a turn (#125). They live in the daemon's data directory — `<dir>/inbox/<id>/<name>` from the
 * upload until a turn sends them, `<dir>/<taskId>/<name>` from then on — and never inside a repository (a
 * checkout must not show them in `git status`). Runners get the absolute path in the prompt: Claude and Codex run
 * on this machine with their own file tools, and the task's scope is widened to the task's attachment directory
 * so the read needs no extra permission (`--add-dir` for Claude, the sandbox roots for Codex, Workspace MCP's
 * Scope). DAK, which cannot see host paths, gets the contents in its message instead (#124), and the files it makes
 * come back the other way: its adapter writes them into the task's directory and the daemon `register`s them.
 */
export class AttachmentStore {
  constructor(
    private db: Db,
    readonly dir: string,
  ) {
    mkdirSync(join(dir, "inbox"), { recursive: true });
  }

  /**
   * Where a task's attachments are moved to when sent — deterministic, so it can go in the scope before the move.
   * The id is a path segment: one that would leave the store (`../x`, a slash, empty) is refused, whatever the DB says.
   */
  taskDir(taskId: string): string {
    const dir = resolve(this.dir, taskId);
    if (!taskId || basename(dir) !== taskId || dirname(dir) !== resolve(this.dir) || taskId === "inbox") throw new AttachmentError(`task id "${taskId}" is not a directory name`, 400);
    return dir;
  }

  /** The upload's own folder; the only place `attach` moves from and `remove` / `sweep` delete. */
  private inboxDir(id: string): string {
    return join(this.dir, "inbox", id);
  }

  /** A row whose path is not inside its own inbox folder (a tampered / foreign DB) is never moved or deleted from. */
  private inInbox(a: Attachment): boolean {
    return dirname(resolve(a.path)) === resolve(this.inboxDir(a.id));
  }

  save(file: { name: string; mime?: string; bytes: Uint8Array }): Attachment {
    const id = newId("att");
    const name = safeName(file.name);
    const folder = this.inboxDir(id);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name);
    writeFileSync(path, file.bytes);
    const a: Attachment = { id, taskId: null, name, mime: mimeFor(name, file.mime), size: file.bytes.byteLength, path, createdAt: Date.now() };
    this.db.insertAttachment(a);
    return a;
  }

  get(id: string): Attachment | null {
    return this.db.getAttachment(id);
  }

  listForTask(taskId: string): Attachment[] {
    return this.db.listAttachments(taskId);
  }

  /** Why these ids cannot be sent with a turn (undefined = they can): unknown, repeated, or already another task's. */
  check(ids: string[]): AttachmentError | undefined {
    if (ids.length > MAX_ATTACHMENTS_PER_REQUEST) return new AttachmentError(`too many attachments (max ${MAX_ATTACHMENTS_PER_REQUEST} per turn)`, 400);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) return new AttachmentError(`attachment ${id} listed twice`, 400);
      seen.add(id);
      const a = this.db.getAttachment(id);
      if (!a) return new AttachmentError(`attachment ${id} not found`, 404);
      if (a.taskId) return new AttachmentError(`attachment ${id} was already sent with task ${a.taskId}`, 409);
      if (!this.inInbox(a) || !existsSync(a.path)) return new AttachmentError(`attachment ${id}: the file is gone (${a.path})`, 410);
    }
    return undefined;
  }

  /** Move the uploads under the task and record whose they are. Refuses as a whole (nothing moved) if any id is bad. */
  attach(ids: string[], taskId: string): Attachment[] {
    if (!ids.length) return [];
    const folder = this.taskDir(taskId); // refuses an id that is not a plain directory name, before any check
    const why = this.check(ids);
    if (why) throw why;
    mkdirSync(folder, { recursive: true });
    const out: Attachment[] = [];
    for (const id of ids) {
      const a = this.db.getAttachment(id)!;
      const target = freePath(folder, a.name, id);
      renameSync(a.path, target);
      rmSync(this.inboxDir(id), { recursive: true, force: true });
      this.db.attachAttachment(id, taskId, target);
      out.push({ ...a, taskId, path: target });
    }
    return out;
  }

  /**
   * A file a runner wrote into the task's directory (#124: DAK's artifacts) becomes one of the task's attachments.
   * Only a regular file directly in `taskDir(taskId)` (a symlink is not one: it could point out of the directory),
   * not registered yet, is taken; anything else is undefined.
   */
  register(taskId: string, path: string): Attachment | undefined {
    const file = resolve(path);
    if (dirname(file) !== this.taskDir(taskId)) return undefined;
    let size: number;
    try {
      const st = lstatSync(file);
      if (!st.isFile()) return undefined;
      size = st.size;
    } catch {
      return undefined;
    }
    if (this.db.listAttachments(taskId).some((a) => resolve(a.path) === file)) return undefined;
    const name = basename(file);
    const a: Attachment = { id: newId("att"), taskId, name, mime: mimeFor(name), size, path: file, createdAt: Date.now() };
    this.db.insertAttachment(a);
    return a;
  }

  /** Forget an upload that was not sent. One that was sent stays: it is part of a transcript. */
  remove(id: string): void {
    const a = this.db.getAttachment(id);
    if (!a) throw new AttachmentError(`attachment ${id} not found`, 404);
    if (a.taskId) throw new AttachmentError(`attachment ${id} was sent with task ${a.taskId}; it stays with the transcript`, 409);
    rmSync(this.inboxDir(id), { recursive: true, force: true });
    this.db.deleteAttachment(id);
  }

  /** Remove uploads nobody sent within `maxAgeMs` (boot). Returns how many went. */
  sweep(maxAgeMs = INBOX_MAX_AGE_MS, now = Date.now()): number {
    let n = 0;
    for (const a of this.db.listUnattachedBefore(now - maxAgeMs)) {
      rmSync(this.inboxDir(a.id), { recursive: true, force: true }); // never `dirname(a.path)`: the row is data, the folder is ours
      this.db.deleteAttachment(a.id);
      n++;
    }
    return n;
  }
}

/** The block appended to a turn's text so the runner knows what was attached and where to read it. Empty for none. */
export function attachmentNote(atts: Attachment[]): string {
  if (!atts.length) return "";
  const lines = atts.map((a) => `- ${a.path} (${a.mime}, ${formatBytes(a.size)})`);
  return `\n\n添付ファイル（このマシン上のパス。必要なら読んでください）:\n${lines.join("\n")}`;
}

/** Text plus the attachment block; an empty text with attachments becomes the fixed sentence. */
export function withAttachments(text: string, atts: Attachment[]): string {
  if (!atts.length) return text;
  return (text.trim() || ATTACHMENT_ONLY_TEXT) + attachmentNote(atts);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A browser's `File.type` is often empty or `application/octet-stream` for drops (and Bun's multipart parser adds a
 * charset); the extension is the next best hint. Parameters are dropped: the value names a format for the runner.
 */
export function mimeFor(name: string, given?: string): string {
  const bare = (given ?? "").split(";")[0]!.trim().toLowerCase();
  if (bare && bare !== "application/octet-stream") return bare;
  const ext = extname(name).toLowerCase().slice(1);
  return BY_EXT[ext] ?? "application/octet-stream";
}

const BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
};

/** A file name stays under this many UTF-8 bytes (Linux NAME_MAX is 255; leave room for the collision suffix). */
export const MAX_NAME_BYTES = 150;

/**
 * Only the base name, without path separators, control characters or a leading dot; never empty; at most
 * MAX_NAME_BYTES of UTF-8, cut on code points (never inside a surrogate pair) and keeping a short extension.
 */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let cleaned = "";
  for (const ch of base) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += ch;
  }
  cleaned = cleaned.replace(/^\.+/, "").trim() || "file";
  const ext = extname(cleaned).length <= 16 ? extname(cleaned) : "";
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned;
  return cutBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(ext)) + ext;
}

/** The longest prefix of `s` (whole code points) within `max` UTF-8 bytes. */
function cutBytes(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** RFC 8187 ext-value: percent-encode everything outside attr-char (encodeURIComponent leaves `!'()*`). */
export function extValue(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Types a browser would run scripts in if opened as a document: served as a download, never inline. */
export function isActiveContent(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml" || mime === "image/svg+xml" || mime === "text/xml" || mime === "application/xml";
}

/** `name`, or `name-<id tail>.ext` when the task already has one of that name. */
function freePath(folder: string, name: string, id: string): string {
  const first = join(folder, name);
  if (!existsSync(first)) return first;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return join(folder, `${stem}-${id.slice(-4)}${ext}`);
}
