import type { Artifact, ReportRow } from "@switchboard/protocol";
import { viewOf } from "./artifacts.ts";
import { jstStamp } from "./time.ts";

/** `M/D HH:MM` in JST, as the Task list and a schedule's last result show times. */
const stamp = jstStamp;

/**
 * The line beside a report's title (#1835): when it was registered or last taken again, and who made it — the schedule's
 * title when a schedule started the Task, else the Task's title.
 */
export function reportMeta(r: Pick<ReportRow, "updatedAt" | "taskTitle" | "scheduleTitle">): string {
  return `${stamp(r.updatedAt)} · ${r.scheduleTitle ?? r.taskTitle}`;
}

/** The kind a row of every artifact names (#1833), in the words of how the 成果物 tab opens it. */
export function kindLabel(a: Pick<Artifact, "kind" | "mime">): string {
  if (a.kind === "url") return "URL";
  if (a.kind === "dir") return "フォルダ";
  const how = viewOf(a);
  if (how === "frame") return a.mime.toLowerCase() === "image/svg+xml" ? "画像" : "HTML";
  if (how === "image") return "画像";
  if (how === "text") return "テキスト";
  return (a.mime.split("/")[1] ?? a.mime).toUpperCase();
}

/** The line beside a row of every artifact (#1833): its kind, then what `reportMeta` says. */
export function artifactMeta(r: Pick<ReportRow, "kind" | "mime" | "updatedAt" | "taskTitle" | "scheduleTitle">): string {
  return `${kindLabel(r)} · ${reportMeta(r)}`;
}

/** A read of a list across Tasks (#1835, #1833): the page size, the words to filter by, and the previous page's last id. */
export type AcrossQuery = { limit?: number; q?: string; before?: string };

/** The query string of a read across Tasks; the words are trimmed and left out when blank. */
export function acrossParams(o: AcrossQuery): string {
  const p = new URLSearchParams();
  if (o.limit !== undefined) p.set("limit", String(o.limit));
  const q = o.q?.trim();
  if (q) p.set("q", q);
  if (o.before) p.set("before", o.before);
  const s = p.toString();
  return s ? `?${s}` : "";
}
