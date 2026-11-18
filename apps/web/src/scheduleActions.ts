import type { Schedule } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { backlog as m } from "./i18n/backlog.ts";

/** The kinds of schedule as the screen names them: the create form's select, the row's tag and the edit form's heading share this. */
export const SCHEDULE_ACTIONS: ReadonlyArray<{ value: Schedule["action"]; label: string }> = [
  { value: "prompt", label: t(m.actionPrompt) },
  { value: "backlog-next", label: t(m.actionBacklogNext) },
  { value: "secret-scan", label: t(m.actionSecretScan) },
  { value: "insights", label: "Claude Code Insights" },
  { value: "approval-window", label: t(m.actionApprovalWindow) },
];

/** The kind that runs on claude only: the form locks the runner on it. */
export const claudeOnlyAction = (action: string): boolean => action === "insights";

/** A kind's name; one the screen does not know is shown as is. */
export const scheduleActionLabel = (action: string): string => SCHEDULE_ACTIONS.find((a) => a.value === action)?.label ?? action;
