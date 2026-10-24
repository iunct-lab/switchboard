/**
 * How an edit made here stands against what GitHub has (#887, 初期方式 A): one field at a time, the value it was made
 * on (`base`), the value made here (`local`) and GitHub's (`remote`). Both the import (Db.putBacklogSnapshot) and the
 * send (backlog-send.ts, read just before and just after the write) decide with these, so they never disagree on
 * whether two values are the same. A body is never merged: both sides changed it → a conflict, kept with all three.
 */
import { createHash } from "node:crypto";
import type { BacklogObjectKind } from "@switchboard/protocol";

/** A body without the marker a post sent from here ends with (backlog-send.ts): what is shown, edited and compared. */
export const withoutMarker = (body: string) => body.replace(/\r?\n\r?\n<!-- switchboard-op:[0-9a-f-]+ -->\s*$/, "");

/**
 * One field of a record's data, as an operation's `field` names it (db.ts applyBacklogField): an Issue's `title` /
 * `body` (without the marker) / `state` / `milestone` / `parent`, `label:<name>` (on or not; GitHub matches label
 * names without case); a Project item's `field:<name>` (a field with no value is null). `member` and a field the
 * record does not have are undefined: not compared.
 */
export function backlogFieldValue(kind: BacklogObjectKind, data: unknown, field: string): unknown {
  const d = data as Record<string, any> | null;
  if (!d) return undefined;
  if (kind === "project-item") return field.startsWith("field:") ? (d.fields?.[field.slice("field:".length)] ?? null) : undefined;
  if (kind !== "issue") return undefined;
  if (field.startsWith("label:")) return (d.labels as string[]).some((l) => l.toLowerCase() === field.slice("label:".length).toLowerCase());
  if (field === "body") return withoutMarker(d.body);
  return ["title", "state", "milestone", "parent"].includes(field) ? d[field] : undefined;
}

/** Two values of one field in one form: a number field sent as "5" reads back as 5; a body's marker is not part of it. */
export function sameBacklogValue(field: string, a: unknown, b: unknown): boolean {
  const form = (x: unknown) => {
    const v = field === "body" && typeof x === "string" ? withoutMarker(x) : x;
    return typeof v === "number" ? String(v) : JSON.stringify(v ?? null).replace(/^"(-?\d+(\.\d+)?)"$/, "$1");
  };
  return form(a) === form(b);
}

/**
 * `synced` = both sides have the same value; `local` = only this side changed it (send it); `remote` = only GitHub did
 * (take it); `conflict` = both changed it to different values (keep all three, write nothing).
 */
export type FieldMerge = "synced" | "local" | "remote" | "conflict";

export function mergeBacklogField(field: string, base: unknown, local: unknown, remote: unknown): FieldMerge {
  if (sameBacklogValue(field, local, remote)) return "synced";
  if (sameBacklogValue(field, remote, base)) return "local";
  if (sameBacklogValue(field, local, base)) return "remote";
  return "conflict";
}

/**
 * What a choice on a conflict must have seen (#887): changes when the operation, its base, the value made here or
 * GitHub's value moves — GitHub's value not read (undefined) is not its null (no milestone, no parent) — so a choice
 * made on an older screen is refused (409).
 */
export function conflictRevision(op: { id: string; status: string; payload: unknown; base: unknown; overwritten?: unknown }, remote: unknown): string {
  return createHash("sha256").update(JSON.stringify([op.id, op.status, op.payload ?? null, op.base ?? null, remote === undefined ? { unread: true } : remote, op.overwritten ?? null])).digest("hex").slice(0, 16);
}
