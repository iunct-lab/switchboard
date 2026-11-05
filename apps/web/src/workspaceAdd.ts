import type { WorkspaceRemoval } from "@switchboard/protocol";
import type { WorkspaceClone } from "./api.ts";
import { t } from "./i18n.ts";
import { common as m } from "./i18n/common.ts";

/** The line for a clone under the add form (#2575): going on, or why it did not become a workspace. */
export function cloneRowText(c: WorkspaceClone): string {
  return c.state === "cloning" ? t(m.cloning, { repo: c.repo, path: c.path }) : t(m.cloneFailed, { repo: c.repo, error: c.error ?? t(m.cloneNoReason) });
}

/** The one warning line of the confirmation to remove a workspace (#2600): what the copy would lose, or Tasks still running; null = nothing to say. */
export function removalWarning(r: Pick<WorkspaceRemoval, "dirty" | "unpushed" | "running">, deleteCopy: boolean): string | null {
  if (r.running > 0) return t(m.removeRunning, { n: r.running });
  if (!deleteCopy || (!r.dirty && !r.unpushed)) return null;
  return r.dirty && r.unpushed ? t(m.removeDirtyUnpushed) : r.dirty ? t(m.removeDirty) : t(m.removeUnpushed);
}

/** 外す is enabled only when the typed name matches and no Task runs there. */
export const canRemove = (typed: string, r: Pick<WorkspaceRemoval, "name" | "running">) => typed === r.name && r.running === 0;
