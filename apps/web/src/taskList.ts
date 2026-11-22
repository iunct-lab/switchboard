import { isWorkingStatus, personWait, taskSummary, type Task, type TaskStopMark, type TaskSummary, type Workspace } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";
import { REASON_LABEL } from "./interventions.ts";

/** The rail's state filter: fixed choices, not saved. */
export type StatusFilter = "all" | "active" | "needs" | "waits" | "done" | "stopped";

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: t(common.filterAll) },
  { value: "active", label: t(common.filterActive) },
  { value: "needs", label: t(common.filterNeeds) },
  { value: "waits", label: t(common.filterWaits) },
  { value: "done", label: t(common.filterDone) },
  { value: "stopped", label: t(common.filterStopped) },
];

/** Rows the rail draws at once, and how many more each 「さらに表示」 adds. */
export const PAGE = 50;

const NEEDS_PERSON = new Set(["needs", "failed", "unjudged"]);

const inStatus = (t: TaskSummary, s: StatusFilter) => {
  switch (s) {
    case "all": return true;
    case "active": return isWorkingStatus(t.status);
    case "needs": return NEEDS_PERSON.has(personWait(t));
    case "waits": return personWait(t) === "waits";
    case "done": return t.status === "done";
    case "stopped": return t.status === "error" || t.status === "aborted";
  }
};

/**
 * The rail's Task list: the archived ones or the others, of the chosen Workspace (null = all), in the chosen state, whose title or cwd holds `q`
 * (case-insensitive). Searched in what the page already holds: the list follows task.updated, so nothing is asked again.
 */
export function filterTasks(tasks: TaskSummary[], f: { q: string; status: StatusFilter; archived: boolean; workspaceId: string | null }): TaskSummary[] {
  const q = f.q.trim().toLowerCase();
  return tasks.filter((t) => (t.archivedAt !== null) === f.archived && (f.workspaceId === null || t.workspaceId === f.workspaceId) && inStatus(t, f.status) && (!q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q)));
}

/** The rail dot of a Task: a Task that only waits on something else (`personWait` waits) is `hold`, not the idle grey of a finished one. */
export function taskDot(t: TaskSummary): string {
  return personWait(t) === "waits" ? "hold" : dotClass(t.status);
}

/** The rail dot of a state alone (the Running · Waiting rows). */
export const dotClass = (s: TaskSummary["status"]) => (s === "running" || s === "background" ? "run" : s === "waiting" ? "wait" : s === "error" ? "err" : "idle");

/** What a waiting Task waits on, as Home's folded 待ち row says it: the conditions (`pr#N:open`), else the reason's label; null when there is no stop record (the caller then says the outcome, as Home does). */
export function waitTitle(mark: TaskStopMark | undefined): string | null {
  if (!mark?.reason) return null;
  return mark.reason === "depends" && mark.conditions.length > 0 ? mark.conditions.map((c) => `${c.key}:${c.value}`).join(" ") : REASON_LABEL[mark.reason];
}

/** A Task as the daemon sent it (socket, a request's response) into the list: replaces the row with the same id, else goes first. Only the list's fields are kept. */
export function upsertSummary(prev: TaskSummary[], task: Task): TaskSummary[] {
  const s = taskSummary(task);
  const i = prev.findIndex((t) => t.id === task.id);
  if (i < 0) return [s, ...prev];
  const next = [...prev];
  next[i] = s;
  return next;
}

/**
 * The open Task, whole: its detail's, else the one last shown for the same id. A failed catch-up forgets the
 * detail until it is read again whole; meanwhile TaskView stays up (an unsent draft is kept). Another Task's is not kept.
 */
export function openTask(last: Task | undefined, id: string, detail: Task | undefined): Task | undefined {
  return detail ?? (last?.id === id ? last : undefined);
}

/** The Workspace name a Home row shows once more than one is registered (a lone Workspace has nothing to tell apart); null = no tag. */
export function workspaceTag(workspaces: Workspace[], workspaceId: string | null): string | null {
  if (workspaces.length < 2) return null;
  return workspaces.find((w) => w.id === workspaceId)?.name ?? null;
}
