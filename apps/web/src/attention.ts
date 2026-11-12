import { isWorkingStatus, type StopCondition, type StopReasonCode, type StopState, type Task, type TaskOutcome, type TaskStopMark, type TaskSummary, type TerminalStatus } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/**
 * 要対応 (#492): the stopped tasks the person has not reviewed yet, except those that came to 完了 — a finished task needs
 * nothing from the person, and listing it buries the ones that do. Separate from whether the runner is running — a task
 * waiting on an approval is in both lists. Home and the rail both use these, below 実行中.
 */
export function needsAttention(t: TaskSummary): boolean {
  return t.reviewedAt === null && t.outcome !== "done" && (t.status === "waiting" || !isWorkingStatus(t.status)) && t.status !== "idle";
}

/**
 * What a Task that holds or waits for a run slot is called (#1141): 実行中 / 承認待ち, and 実行枠待ち for an idle Task in the
 * daemon's queue (`queuedAt`). A Task running in the background keeps its own word. Home, the Task screen's head and the
 * Schedules queue say it with this one function.
 */
export function activeLabel(x: TaskSummary): string | null {
  if (x.status === "running") return t(m.running);
  if (x.status === "waiting") return t(m.statusWaiting);
  if (x.status === "background") return t(m.statusBackground);
  return x.status === "idle" && x.queuedAt !== null ? t(m.statusQueued) : null;
}

export function isActive(x: TaskSummary): boolean {
  return activeLabel(x) !== null;
}

const RANK: Record<TaskOutcome, number> = { needs_action: 0, failed: 1, done: 2, unknown: 2 };

/** 要対応 → 失敗 → 未判定; newest first within each. */
export function attentionList(tasks: TaskSummary[]): TaskSummary[] {
  return tasks.filter(needsAttention).sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || b.updatedAt - a.updatedAt);
}

/** One row of 要対応 (#4480): the Tasks stopped by the same series (`TaskStopMark.key`), newest first; `tasks[0]` is the one the row opens. */
export type AttentionGroup = { key: string; tasks: TaskSummary[]; count: number; reason: StopReasonCode | null; state: StopState | null };

/** A Task that needs nothing from the person for now (the folded 待ち section): its stop went on, or waits on a condition. */
export type WaitingRow = { task: TaskSummary; key: string; reason: StopReasonCode; state: StopState; conditions: StopCondition[] };

// Reasons that wait for the person's decision or operation. `unknown` is here on purpose: not knowing is not a reason to hide it.
const HUMAN_REASONS: ReadonlySet<StopReasonCode> = new Set(["decision", "auth", "permission", "input", "disk-full", "unknown"]);

/**
 * Whether the last stop leaves the person nothing to do now. Only a stop still waiting / exhausted on a reason in
 * HUMAN_REASONS needs them (the PBI's criterion 1); the rest — resolved, retrying, and depends / usage-limit / github-limit /
 * transient whatever their state — go to the folded 待ち, where they are still listed.
 */
function needsNothing(mark: TaskStopMark): boolean {
  return !((mark.state === "waiting" || mark.state === "exhausted") && HUMAN_REASONS.has(mark.reason));
}

/**
 * Splits the list `attentionList` gives (judged by `needsAttention`, which this does not change) into what needs the person
 * (grouped by stop series) and what only waits (#4480). Without a mark — no stop record, or the marks not loaded yet (`marks`
 * null) — and for a failed Task a Task stays under `needs`: nothing that may need a hand is hidden.
 */
export function attentionGroups(tasks: TaskSummary[], marks: Record<string, TaskStopMark> | null): { needs: AttentionGroup[]; waiting: WaitingRow[] } {
  const byKey = new Map<string, AttentionGroup>();
  const waiting: WaitingRow[] = [];
  for (const task of attentionList(tasks)) {
    const mark = marks?.[task.id];
    if (mark && task.outcome !== "failed" && needsNothing(mark)) {
      waiting.push({ task, key: mark.key, reason: mark.reason, state: mark.state, conditions: mark.conditions });
      continue;
    }
    const key = mark?.key ?? `task:${task.id}`;
    const g = byKey.get(key);
    if (g) {
      g.tasks.push(task);
      g.count++;
    } else byKey.set(key, { key, tasks: [task], count: 1, reason: mark?.reason ?? null, state: mark?.state ?? null });
  }
  // attentionList is sorted (要対応 → 失敗 → 未判定, newest first), so a group sits where its first Task does
  return { needs: [...byKey.values()], waiting };
}

const LABEL: Record<TaskOutcome, string> = { needs_action: t(m.outcomeNeedsAction), failed: t(m.statusFailed), done: t(m.statusDone), unknown: t(m.outcomeUnknown) };

export function outcomeLabel(o: TaskOutcome): string {
  return LABEL[o];
}

/**
 * What the Task screen shows next to the outcome (#493): the judge's one-line reason, and in the tooltip who judged.
 * When the person set a different outcome by hand, the judged result is named in the text so the two can be told apart.
 */
export function judgementNote(x: Task): { text: string; title: string } | null {
  if (!x.judgedResult || !x.judgedReason) return null;
  const judged = outcomeLabel(x.judgedResult);
  // `<runner>:` = judged on that runner's CLI default model (the setting's model is "")
  const by = x.judgedBy?.endsWith(":") ? t(m.cliDefaultBy, { runner: x.judgedBy }) : (x.judgedBy ?? "?");
  return { text: x.outcome === x.judgedResult ? x.judgedReason : t(m.judgedText, { judged, reason: x.judgedReason }), title: t(m.judgedTitle, { by, judged }) };
}

/** The dot of a row under 要対応: coloured by the outcome, not the runner's status. */
export function outcomeDotClass(o: TaskOutcome): string {
  return o === "needs_action" ? "wait" : o === "failed" ? "err" : o === "done" ? "ok" : "idle";
}

/** The rail's mark for Claude Code in a Task's terminal tab (#1574). Done shows nothing: it needs nothing from the person. */
export function terminalMark(status: TerminalStatus | undefined): { text: string; className: string } | null {
  return status === "working" ? { text: t(m.termWorking), className: "m" } : status === "waiting" ? { text: t(m.termWaiting), className: "m term-wait" } : null;
}
