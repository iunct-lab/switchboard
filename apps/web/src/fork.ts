import type { RunnerInfo, Task } from "@switchboard/protocol";

/**
 * Whether the 「ここから分岐」 button is offered on a turn's end row: the turn finished (`ok`) and carries the runner's
 * pointer to it, the Task runs locally (a Cloud Task is operated on the provider's web), and the Task's runner can start
 * from a past turn. The daemon refuses the other cases too; this keeps the button from being offered at all.
 */
export function canFork(task: Pick<Task, "executionMode">, end: { status: "ok" | "error" | "aborted"; turn?: string }, runner: Pick<RunnerInfo, "forks"> | undefined): boolean {
  return end.status === "ok" && !!end.turn && task.executionMode !== "cloud" && runner?.forks === true;
}
