import type { ExecutionMode, RunnerId } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";
import { runnerLabel } from "./runners.ts";
import { titleToSend } from "./taskTitle.ts";

/** What the 詳細 of Home's compose form holds: the values a request rarely sets. */
export type ComposeDetails = { title: string; executionMode: ExecutionMode; model: string; effort: string; budget: string; shadow: RunnerId | null };

const TITLE_CHARS = 20;

/**
 * The line beside a closed 詳細: only what differs from what an untouched form would send, in the form's order.
 * `v` holds what would be sent (the caller passes the untouched values for what a mode does not send, e.g. a Cloud task's
 * model). `defaults.model` is the model an untouched select holds (the rule's proposal, or "" = the CLI's own);
 * `defaults.shadow` the runner the saved default runs beside it (null = none); `defaults.briefTitle` the prefix 改善 → put in the title,
 * which alone is not sent (`titleToSend`). Empty when nothing was changed.
 */
export function detailsSummary(v: ComposeDetails, defaults: { model: string; shadow: RunnerId | null; briefTitle?: string }): string {
  const parts: string[] = [];
  const title = titleToSend(v.title, defaults.briefTitle) ?? "";
  if (title) parts.push(t(home.sumTitle, { title: [...title].length > TITLE_CHARS ? `${[...title].slice(0, TITLE_CHARS).join("")}…` : title }));
  if (v.executionMode === "cloud") parts.push(t(home.sumCloud));
  if (v.model !== defaults.model) parts.push(t(home.sumModel, { model: v.model || t(home.cliDefault) }));
  if (v.effort) parts.push(t(home.sumEffort, { effort: v.effort }));
  if (v.budget.trim()) parts.push(t(home.sumBudget, { budget: v.budget.trim() }));
  if (v.shadow !== defaults.shadow) parts.push(t(home.sumShadow, { shadow: v.shadow ? runnerLabel(v.shadow) : t(home.none) }));
  return parts.join(" · ");
}

const KEY = "switchboard.compose.details";

/** Whether 詳細 was left open in this browser; closed when nothing was saved or the storage refuses. */
export function loadDetailsOpen(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(KEY) === "open";
  } catch {
    return false;
  }
}

/** Remembers 詳細 open or closed for the next visit; a storage that refuses is ignored (it only starts closed again). */
export function saveDetailsOpen(storage: Pick<Storage, "setItem">, open: boolean): void {
  try {
    storage.setItem(KEY, open ? "open" : "closed");
  } catch {
    // private mode, quota: the form still works, it only forgets
  }
}

const DEVELOP_SELF_KEY = "switchboard.compose.developSelf";

/**
 * The last 「Switchboard 自体を開発する」 value read from the daemon, for the first draw before the settings answer;
 * `fallback` (the setting's default) when nothing valid was saved or the storage refuses.
 */
export function loadDevelopSelf(storage: Pick<Storage, "getItem">, fallback: boolean): boolean {
  try {
    const v = storage.getItem(DEVELOP_SELF_KEY);
    return v === "on" ? true : v === "off" ? false : fallback;
  } catch {
    return fallback;
  }
}

/** Remembers the value the settings answered for the next first draw; a storage that refuses is ignored. */
export function saveDevelopSelf(storage: Pick<Storage, "setItem">, value: boolean): void {
  try {
    storage.setItem(DEVELOP_SELF_KEY, value ? "on" : "off");
  } catch {
    // private mode, quota: the next first draw falls back to the default
  }
}
