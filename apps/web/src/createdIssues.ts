import type { BacklogAction, CreatedIssueRow, Task } from "@switchboard/protocol";
import { STAGES } from "./backlogView.ts";
import { t } from "./i18n.ts";
import { backlog } from "./i18n/backlog.ts";
import { task as m } from "./i18n/task.ts";
import { directButton, readyPending, startButton } from "./inProgress.ts";

/** The stage actions the Task screen offers: the ones that start the next step of an Issue the Task opened (not 状況を確認 or 閉じる). */
const OFFERED: ReadonlySet<BacklogAction> = new Set<BacklogAction>(["to-pbi", "direct", "to-tasks", "complete"]);

/**
 * The buttons of one Issue the Task opened: the Backlog row's (`startButton`, then `directButton`), kept to the steps
 * the Task screen starts. None for a row with no backlog item (a request with a derived PBI).
 */
export function createdRowButtons(row: CreatedIssueRow, metaId: string | null): Array<[BacklogAction, string]> {
  if (!row.item) return [];
  return [startButton(row.item), directButton(row.item, metaId)].filter((b): b is [BacklogAction, string] => b !== null && OFFERED.has(b[0]));
}

/**
 * The stage chip of one Issue the Task opened: the Backlog's stage name (a PBI split into Tasks but not Ready gets the
 * Backlog row's 分解済み mark, matching its Ready にする button), PBI 作成済み for a request with no item (it has a derived PBI).
 */
export function createdRowStage(row: CreatedIssueRow): string | null {
  if (row.item && readyPending(row.item)) return t(backlog.readyPending);
  if (row.item) return STAGES.find(([s]) => s === row.item!.stage)?.[1] ?? null;
  return row.kind === "request" ? t(m.createdPbiMade) : null;
}

/**
 * Start one step from the Task screen, as a Backlog row does: the started Task opens (`onStarted`); a 409 naming the
 * stage Task already running opens that Task; any other refusal is the Backlog's 始められませんでした line.
 */
export function startCreatedRow(
  start: (workspaceId: string, n: number, action: BacklogAction) => Promise<Task>,
  row: CreatedIssueRow,
  action: BacklogAction,
  on: { onStarted: (task: Task) => void; onOpenTask: (id: string) => void; onError: (msg: string) => void },
): Promise<void> {
  return start(row.workspaceId, row.number, action).then(on.onStarted, (e) => {
    const running = (e.body as { taskId?: string } | undefined)?.taskId;
    if (e.status === 409 && running) on.onOpenTask(running);
    else on.onError(t(backlog.startFailed, { n: row.number, error: String(e.message ?? e) }));
  });
}
