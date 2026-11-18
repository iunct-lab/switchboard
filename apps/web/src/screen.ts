import type { Task } from "@switchboard/protocol";

/**
 * `task.artifact`: the 成果物 to open first (Insights' list links to it); `evals.report`: the report Insights opens first
 * (Home's line); `evals.artifacts`: Insights' レポート section shows every artifact instead of the HTML ones;
 * `terminal`: a Workspace's shell opened from the Rail, with no Task.
 */
export type View = { name: "home" } | { name: "task"; id: string; artifact?: string } | { name: "ledger" } | { name: "evals"; report?: string; artifacts?: boolean } | { name: "schedules" } | { name: "backlog" } | { name: "resources" } | { name: "approvals" } | { name: "settings" } | { name: "terminal"; workspaceId: string };

/** Room left for a task's title inside the label; FeedbackInput.screen takes at most 200 characters. */
const TITLE_MAX = 120;

/** How the feedback dialog names the screen it was opened from; it goes into the request's 出典 as one line. */
export function screenLabel(view: View, task?: Task, workspaceName?: string): string {
  // ui-strings: value "ターミナル" — sent to the daemon as the request's 出典
  if (view.name === "terminal") return `ターミナル（${workspaceName ?? view.workspaceId}）`;
  if (view.name === "task") {
    if (!task) return `Task (${view.id})`;
    const title = task.title.replace(/\s+/g, " ").trim();
    // sent to the daemon (the request's 出典); the dialog shows it through `shownScreen`
    return `Task「${title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title}」(${task.id})`;
  }
  // ui-strings: value "判断待ち" — sent to the daemon; the dialog shows 判断待ち through `shownScreen`
  return { home: "Home", ledger: "Ledger", evals: "Insights", schedules: "Schedules", backlog: "Backlog", resources: "Resources", approvals: "判断待ち", settings: "Settings" }[view.name];
}
