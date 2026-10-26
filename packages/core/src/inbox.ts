import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { InboxNote, KnowledgeDoc } from "@switchboard/protocol";
import type { KnowledgeStore } from "./knowledge.ts";

/**
 * Inbox (proposal Screen A, issue #9): notes that are not yet tied to a repository.
 * A note is just a Markdown file under notes/ in the Knowledge folder with a little frontmatter;
 * promoting it to a Task records the task id on the note instead of deleting anything.
 */
export type { InboxNote };

/** Filename-safe slug: unicode letters/digits kept, bounded by code points (never splits a surrogate pair). */
export function slugify(s: string): string {
  const firstLine = s.trim().split("\n")[0] ?? "";
  const base = Array.from(firstLine.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-"))
    .slice(0, 48)
    .join("")
    .replace(/^-+|-+$/g, "");
  return base || "note";
}

/** Local calendar date (a note written at 08:00 JST belongs to that day, not to yesterday UTC). */
export function localDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function notePath(text: string, now = new Date()): string {
  return `notes/${localDate(now)}-${slugify(text)}.md`;
}

function cleanTitle(raw: string | undefined, body: string): string {
  const t = (raw ?? "").replace(/\r/g, "").trim();
  const fallback = (body.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
  return (t || fallback || "note").slice(0, 80);
}

export function renderNote(n: Omit<InboxNote, "path">, extraFrontmatter: Record<string, unknown> = {}): string {
  const fm: Record<string, unknown> = { ...extraFrontmatter, title: n.title, created: n.created, status: n.status };
  if (n.workspaceHint) fm.workspace = n.workspaceHint;
  else delete fm.workspace;
  if (n.taskId) fm.task = n.taskId;
  if (n.source) fm.source = { schedule: n.source.schedule, title: n.source.title };
  return `---\n${stringifyYaml(fm)}---\n${n.body.trim()}\n`;
}

function toSource(v: unknown): InboxNote["source"] {
  const s = v as { schedule?: unknown; title?: unknown } | null | undefined;
  return s && typeof s.schedule === "string" && typeof s.title === "string" ? { schedule: s.schedule, title: s.title } : undefined;
}

export function toNote(doc: KnowledgeDoc, body: string): InboxNote {
  const fm = doc.frontmatter as Record<string, unknown>;
  return {
    path: doc.path,
    title: doc.title,
    body: body.trim(),
    created: typeof fm.created === "string" ? fm.created : fm.created instanceof Date ? fm.created.toISOString() : new Date(doc.mtime).toISOString(),
    workspaceHint: typeof fm.workspace === "string" ? fm.workspace : undefined,
    status: fm.status === "promoted" ? "promoted" : fm.status === "closed" ? "closed" : "inbox",
    taskId: typeof fm.task === "string" ? fm.task : undefined,
    source: toSource(fm.source),
  };
}

export class Inbox {
  constructor(private store: KnowledgeStore) {}

  /** Pending notes, newest first. Uses the indexed frontmatter to skip promoted notes before touching the filesystem. */
  list(): InboxNote[] {
    const out: InboxNote[] = [];
    for (const d of this.store.list()) {
      if (d.kind !== "notes" || ["promoted", "closed"].includes((d.frontmatter as Record<string, unknown>).status as string)) continue;
      try {
        const n = toNote(d, this.store.read(d.path).body);
        if (n.status === "inbox") out.push(n);
      } catch {
        /* deleted between index and read; the next scan drops it */
      }
    }
    return out.sort((a, b) => (a.created === b.created ? a.path.localeCompare(b.path) : a.created < b.created ? 1 : -1));
  }

  add(text: string, opts: { title?: string; workspaceHint?: string; source?: InboxNote["source"]; now?: Date } = {}): InboxNote {
    const body = text.replace(/\r\n/g, "\n").trim();
    if (!body) throw new Error("empty note");
    const now = opts.now ?? new Date();
    const title = cleanTitle(opts.title, body);
    const base = notePath(opts.title?.trim() || body, now);
    // Numeric suffix on collision, checked against the filesystem (not only the index, which may lag a watcher tick).
    let path = base;
    for (let i = 2; this.store.exists(path); i++) path = base.replace(/\.md$/, `-${i}.md`);
    const note: Omit<InboxNote, "path"> = { title, body, created: now.toISOString(), workspaceHint: opts.workspaceHint?.trim() || undefined, status: "inbox", source: opts.source };
    this.store.write(path, renderNote(note));
    return { ...note, path };
  }

  /**
   * The one way the daemon leaves a note for the user (#2401): marked with the schedule that put it there, and the previous
   * open notice of the same schedule is closed (superseded_by) so a daily check does not pile up one note per day.
   * Written first, closed after: a failure leaves two notices, never none.
   */
  addNotice(text: string, opts: { title?: string; source: { schedule: string; title: string }; now?: Date }): InboxNote {
    const note = this.add(text, { title: opts.title, now: opts.now, source: opts.source });
    for (const old of this.list()) {
      if (old.path === note.path || old.source?.schedule !== opts.source.schedule) continue;
      try {
        this.close(old.path, { supersededBy: note.path, now: opts.now });
      } catch {
        /* closed or gone meanwhile */
      }
    }
    return note;
  }

  get(path: string): InboxNote {
    const { doc, body } = this.store.read(path);
    if (doc.kind !== "notes") throw new Error("not an inbox note");
    return toNote(doc, body);
  }

  /** Rewrite the frontmatter of a note in place: keys the user added by hand and the body are kept untouched. */
  private patchFrontmatter(path: string, patch: Record<string, unknown>): InboxNote {
    const { doc, content, body } = this.store.read(path);
    if (doc.kind !== "notes") throw new Error("not an inbox note");
    const n = toNote(doc, body);
    if (n.status === "promoted") throw Object.assign(new Error(`note already promoted to ${n.taskId ?? "a task"}`), { code: "EEXIST" });
    if (n.status === "closed") throw Object.assign(new Error("note already closed"), { code: "EEXIST" });
    const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?\n?/m);
    const existing = (m && m[1]!.trim() ? (parseYaml(m[1]!) as Record<string, unknown>) : {}) ?? {};
    const rawBody = m ? content.slice(m[0].length) : content;
    this.store.write(path, `---\n${stringifyYaml({ ...existing, ...patch })}---\n${rawBody}`);
    return n;
  }

  /** Mark a note as promoted to a task. The file stays in notes/ so the idea's origin is traceable. */
  markPromoted(path: string, taskId: string): InboxNote {
    const n = this.patchFrontmatter(path, { status: "promoted", task: taskId });
    return { ...n, status: "promoted", taskId };
  }

  /** Close a note without making a task: it leaves the list, the file stays in notes/ with status: closed. */
  close(path: string, opts: { supersededBy?: string; now?: Date } = {}): InboxNote {
    const patch: Record<string, unknown> = { status: "closed", closed: (opts.now ?? new Date()).toISOString() };
    if (opts.supersededBy) patch.superseded_by = opts.supersededBy;
    const n = this.patchFrontmatter(path, patch);
    return { ...n, status: "closed" };
  }
}
