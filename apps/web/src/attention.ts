import { personWait, type PersonWait, type StopCondition, type StopReasonCode, type StopState, type Task, type TaskOutcome, type TaskStopMark, type TaskSummary, type TerminalStatus } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/**
 * The Tasks whose stop record `/api/tasks/stops` is read for: the ones not 確認済み that are stopped, or came to 完了 (a
 * 完了 Task's stop on a human reason still needs the person). A Task at work or reviewed never has its mark read.
 */
export function stopCandidates(tasks: TaskSummary[]): TaskSummary[] {
  // the outcome is set aside (`unknown`): a 完了 guess does not rule out a stop on a human reason
  return tasks.filter((t) => personWait({ ...t, outcome: "unknown" }, null) !== "none");
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

/** One row of 要対応 (#4480): the Tasks stopped by the same series (`TaskStopMark.key`), newest first; `tasks[0]` is the one the row opens. */
export type AttentionGroup = { key: string; tasks: TaskSummary[]; count: number; reason: StopReasonCode | null; state: StopState | null };

/** A Task that needs nothing from the person for now (the folded 待ち section): its stop went on, or waits on a condition. */
export type WaitingRow = { task: TaskSummary; key: string; reason: StopReasonCode; state: StopState; conditions: StopCondition[] };

/** 要対応 → 失敗 → 未判定 by `personWait`, newest first within each; a 完了 Task whose stop needs the person ranks as 要対応. */
function sortedByWait(tasks: TaskSummary[], marks: Record<string, TaskStopMark> | null, keep: (w: PersonWait) => boolean): TaskSummary[] {
  const wait = (t: TaskSummary) => personWait(t, marks?.[t.id] ?? null);
  const rank = (t: TaskSummary) => (wait(t) === "needs" ? 0 : RANK[t.outcome]);
  return tasks.filter((t) => keep(wait(t))).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

/**
 * Splits the Tasks into 要対応 (#492) — what `personWait` says waits on the person: needs them, failed, or not judged yet,
 * grouped by stop series — and the folded 待ち (#4480), what only waits on something else. `personWait` is the one rule
 * in the protocol, read with the Task's last stop mark. Separate from whether the runner is running — a task waiting on
 * an approval is in both lists. Home and the rail read both here, below 実行中. Marks not
 * loaded yet (`marks` null) hide nothing: a Task without a mark stays under `needs`, except a 完了 one (nothing to read).
 */
export function attentionGroups(tasks: TaskSummary[], marks: Record<string, TaskStopMark> | null): { needs: AttentionGroup[]; waiting: WaitingRow[] } {
  const byKey = new Map<string, AttentionGroup>();
  const waiting: WaitingRow[] = [];
  for (const task of sortedByWait(tasks, marks, (w) => w !== "none")) {
    const mark = marks?.[task.id];
    if (mark && personWait(task, mark) === "waits") {
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
  // sortedByWait is sorted (要対応 → 失敗 → 未判定, newest first), so a group sits where its first Task does
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
