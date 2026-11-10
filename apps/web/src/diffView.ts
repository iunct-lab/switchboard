import type { TaskDiffFile } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";
import { jstClock } from "./time.ts";

/**
 * The diff tab's rows (#3824, #3833): the files to list, and the sentences above them. A `removed` row (the Task wrote under a place
 * that no longer exists) is a sentence naming the place, not a file row. If the API returned copied (`snapshot`) rows right after it,
 * the sentence says when they were copied and the rows are listed; with no row at all the tab says there is no change yet.
 */
export function diffRows(diff: TaskDiffFile[], now = Date.now()): { files: TaskDiffFile[]; notes: string[] } {
  const files: TaskDiffFile[] = [];
  const notes: string[] = [];
  for (let i = 0; i < diff.length; i++) {
    const f = diff[i]!;
    if (f.source !== "removed") {
      if (f.source !== "snapshot") files.push(f);
      continue;
    }
    const copied: TaskDiffFile[] = [];
    // relies on core's order: withSnapshot puts a removed row's snapshot rows directly after it (taskdiff.test.ts)
    while (diff[i + 1]?.source === "snapshot") copied.push(diff[++i]!);
    const at = Math.max(0, ...copied.map((s) => s.at ?? 0));
    notes.push(copied.length > 0 && at > 0 ? t(m.diffSnapshotNote, { time: jstClock(at, now), path: f.path }) : t(m.diffRemoved, { path: f.path }));
    files.push(...copied);
  }
  if (diff.length === 0) notes.push(t(m.noChanges));
  return { files, notes };
}

/** The tag beside a file row: where its diff came from (a copied row says when it was copied). */
export function diffTag(f: TaskDiffFile, now = Date.now()): string {
  if (f.source === "staging") return t(m.staging);
  if (f.source === "snapshot") return t(m.recorded, { time: f.at ? jstClock(f.at, now) : "" }).trim();
  return t(m.worktree);
}
