import type { WorkspaceRemoval } from "@switchboard/protocol";
import type { WorkspaceClone } from "./api.ts";

/** The line for a clone under the add form (#2575): going on, or why it did not become a workspace. */
export function cloneRowText(c: WorkspaceClone): string {
  return c.state === "cloning" ? `${c.repo} を ${c.path} に clone しています` : `${c.repo} を追加できませんでした: ${c.error ?? "理由は分かりません"}（途中のディレクトリがあれば消してから）`;
}

/** The one warning line of the confirmation to remove a workspace (#2600): what the copy would lose, or Tasks still running; null = nothing to say. */
export function removalWarning(r: Pick<WorkspaceRemoval, "dirty" | "unpushed" | "running">, deleteCopy: boolean): string | null {
  if (r.running > 0) return `動いている Task が ${r.running} 件あります。終えてから外してください`;
  if (!deleteCopy || (!r.dirty && !r.unpushed)) return null;
  return r.dirty && r.unpushed ? "コミットされていない変更と、push していないコミットがあります" : r.dirty ? "コミットされていない変更があります" : "push していないコミットがあります";
}

/** 外す is enabled only when the typed name matches and no Task runs there. */
export const canRemove = (typed: string, r: Pick<WorkspaceRemoval, "name" | "running">) => typed === r.name && r.running === 0;
