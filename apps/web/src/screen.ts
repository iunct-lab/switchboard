import type { Task } from "@switchboard/protocol";

/**
 * `task.artifact`: the 成果物 to open first (#1835 links to it from Insights); `evals.report`: the report Insights opens first
 * (Home's line); `evals.artifacts`: Insights' レポート section shows every artifact instead of the HTML ones (#1833).
 */
export type View = { name: "home" } | { name: "task"; id: string; artifact?: string } | { name: "knowledge" } | { name: "ledger" } | { name: "evals"; report?: string; artifacts?: boolean } | { name: "schedules" } | { name: "backlog" } | { name: "approvals" } | { name: "settings" };

/** Room left for a task's title inside the label; FeedbackInput.screen takes at most 200 characters. */
const TITLE_MAX = 120;

/** How the feedback dialog names the screen it was opened from (#262); it goes into the request's 出典 as one line. */
export function screenLabel(view: View, task?: Task): string {
  if (view.name === "task") {
    if (!task) return `Task (${view.id})`;
    const title = task.title.replace(/\s+/g, " ").trim();
    return `Task「${title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title}」(${task.id})`;
  }
  return { home: "Home", knowledge: "Knowledge", ledger: "Ledger", evals: "Insights", schedules: "Schedules", backlog: "Backlog", approvals: "判断待ち", settings: "Settings" }[view.name];
}
