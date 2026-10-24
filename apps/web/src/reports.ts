import type { ReportRow } from "@switchboard/protocol";
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
