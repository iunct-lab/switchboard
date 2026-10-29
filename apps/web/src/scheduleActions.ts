import type { Schedule } from "@switchboard/protocol";

/** The kinds of schedule as the screen names them (#1838): the create form's select, the row's tag and the edit form's heading share this. */
export const SCHEDULE_ACTIONS: ReadonlyArray<{ value: Schedule["action"]; label: string }> = [
  { value: "prompt", label: "プロンプト" },
  { value: "backlog-next", label: "バックログを進める" },
  { value: "secret-scan", label: "認証の値の検査" },
  { value: "insights", label: "Claude Code Insights" },
  { value: "approval-window", label: "承認待ちのメモ" },
];

/** A kind's name; one the screen does not know is shown as is. */
export const scheduleActionLabel = (action: string): string => SCHEDULE_ACTIONS.find((a) => a.value === action)?.label ?? action;
