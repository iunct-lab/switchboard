import type { TaskDiffFile } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/**
 * The diff tab's rows (#3824): the files to list, and the sentences above them. A `removed` row (the Task wrote under a place
 * that no longer exists) is a sentence naming the place, not a file row; with no row at all the tab says there is no change yet.
 */
export function diffRows(diff: TaskDiffFile[]): { files: TaskDiffFile[]; notes: string[] } {
  const files = diff.filter((f) => f.source !== "removed");
  const notes = diff.filter((f) => f.source === "removed").map((f) => t(m.diffRemoved, { path: f.path }));
  if (diff.length === 0) notes.push(t(m.noChanges));
  return { files, notes };
}
