import type { Task } from "@switchboard/protocol";

/** The rail's state filter (#1142): four fixed choices, not saved. */
export type StatusFilter = "all" | "active" | "done" | "stopped";

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "実行中・待ち" },
  { value: "done", label: "完了" },
  { value: "stopped", label: "エラー・中断" },
];

/** Rows the rail draws at once, and how many more each 「さらに表示」 adds. */
export const PAGE = 50;

const inStatus = (t: Task, s: StatusFilter) =>
  s === "all" || (s === "active" ? t.status === "running" || t.status === "waiting" : s === "done" ? t.status === "done" : t.status === "error" || t.status === "aborted");

/**
 * The rail's Task list (#1142): the archived ones or the others, in the chosen state, whose title or cwd holds `q`
 * (case-insensitive). Searched in what the page already holds: the list follows task.updated, so nothing is asked again.
 */
export function filterTasks(tasks: Task[], f: { q: string; status: StatusFilter; archived: boolean }): Task[] {
  const q = f.q.trim().toLowerCase();
  return tasks.filter((t) => (t.archivedAt !== null) === f.archived && inStatus(t, f.status) && (!q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q)));
}
