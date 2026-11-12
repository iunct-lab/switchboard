import { isWorkingStatus, taskSummary, type Task, type TaskSummary } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";

/** The rail's state filter (#1142): four fixed choices, not saved. */
export type StatusFilter = "all" | "active" | "done" | "stopped";

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: t(common.filterAll) },
  { value: "active", label: t(common.filterActive) },
  { value: "done", label: t(common.filterDone) },
  { value: "stopped", label: t(common.filterStopped) },
];

/** Rows the rail draws at once, and how many more each 「さらに表示」 adds. */
export const PAGE = 50;

const inStatus = (t: TaskSummary, s: StatusFilter) =>
  s === "all" || (s === "active" ? isWorkingStatus(t.status) : s === "done" ? t.status === "done" : t.status === "error" || t.status === "aborted");

/**
 * The rail's Task list (#1142): the archived ones or the others, in the chosen state, whose title or cwd holds `q`
 * (case-insensitive). Searched in what the page already holds: the list follows task.updated, so nothing is asked again.
 */
export function filterTasks(tasks: TaskSummary[], f: { q: string; status: StatusFilter; archived: boolean }): TaskSummary[] {
  const q = f.q.trim().toLowerCase();
  return tasks.filter((t) => (t.archivedAt !== null) === f.archived && inStatus(t, f.status) && (!q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q)));
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
 * The open Task, whole (#2834): its detail's, else the one last shown for the same id. A failed catch-up forgets the
 * detail until it is read again whole; meanwhile TaskView stays up (an unsent draft is kept). Another Task's is not kept.
 */
export function openTask(last: Task | undefined, id: string, detail: Task | undefined): Task | undefined {
  return detail ?? (last?.id === id ? last : undefined);
}
