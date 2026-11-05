import type { Task, TaskOutcome, TerminalStatus } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/**
 * 要対応 (#492): the stopped tasks the person has not reviewed yet, except those that came to 完了 — a finished task needs
 * nothing from the person, and listing it buries the ones that do. Separate from whether the runner is running — a task
 * waiting on an approval is in both lists. Home and the rail both use these, below 実行中.
 */
export function needsAttention(t: Task): boolean {
  return t.reviewedAt === null && t.outcome !== "done" && t.status !== "running" && t.status !== "idle";
}

const RANK: Record<TaskOutcome, number> = { needs_action: 0, failed: 1, done: 2, unknown: 2 };

/** 要対応 → 失敗 → 未判定; newest first within each. */
export function attentionList(tasks: Task[]): Task[] {
  return tasks.filter(needsAttention).sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || b.updatedAt - a.updatedAt);
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
