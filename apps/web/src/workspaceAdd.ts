import { BaselineInput, WorkspaceRulesInput, type Workspace, type WorkspaceRemoval } from "@switchboard/protocol";
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

/** 取り込み is offered on a repository of your own, with or without GitHub (its rules can be kept on Switchboard's side); someone else's has 元の更新を取り込む. */
export const canAdopt = (w: Pick<Workspace, "kind" | "upstream">) => w.kind === "repo" && !w.upstream;

/** The longest rules text the API takes: read from its schema, so the screen and the API cannot drift apart. */
export const RULES_MAX = WorkspaceRulesInput.shape.rules.maxLength ?? 0;

/** 保存 is enabled when the text differs from what is kept (the API trims it) and fits. Empty is allowed: it removes the rules. */
export const canSaveRules = (draft: string, saved: string) => draft.trim() !== saved.trim() && draft.length <= RULES_MAX;

/** The longest concept the API takes, after trimming: read from its schema, so the screen and the API cannot drift apart. */
export const BASELINE_MAX = BaselineInput.shape.concept.maxLength ?? 0;

/** 始める is enabled when the concept has something in it and fits. */
export const canStartBaseline = (concept: string) => concept.trim().length > 0 && concept.trim().length <= BASELINE_MAX;

/** The line under the concept box when it does not fit (why 始める cannot be pressed); null = nothing to say. */
export function baselineWarning(concept: string): string | null {
  const n = concept.trim().length;
  return n > BASELINE_MAX ? t(m.baselineTooLong, { n, max: BASELINE_MAX }) : null;
}
