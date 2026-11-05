import type { Schedule } from "@switchboard/protocol";

/** The kinds of schedule as the screen names them (#1838): the create form's select, the row's tag and the edit form's heading share this. */
export const SCHEDULE_ACTIONS: ReadonlyArray<{ value: Schedule["action"]; label: string }> = [
  { value: "prompt", label: "プロンプト" },
  { value: "backlog-next", label: "バックログを進める" },
  { value: "secret-scan", label: "認証の値の検査" },
  { value: "insights", label: "Claude Code Insights" },
  { value: "approval-window", label: "承認待ちのメモ" },
  { value: "ui-layers", label: "床・天井・壁の点検" },
];

/** The kinds that run on claude only (#1838, #3353): the form locks the runner on them. */
export const claudeOnlyAction = (action: string): boolean => action === "insights" || action === "ui-layers";

/** A kind's name; one the screen does not know is shown as is. */
export const scheduleActionLabel = (action: string): string => SCHEDULE_ACTIONS.find((a) => a.value === action)?.label ?? action;
