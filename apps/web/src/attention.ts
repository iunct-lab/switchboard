import { personWait, type PersonWait, type StopCondition, type StopReasonCode, type StopState, type Task, type TaskOutcome, type TaskListItem, type TaskStopMark, type TaskStatus, type TaskSummary, type TerminalStatus } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/**
 * The Tasks whose stop record `/api/tasks/stops` is read for: the ones not 確認済み that are stopped (`personWait` is not
 * `none`), for the reason of a 待ち row and the series of a 要対応 row. The mark decides no row: the outcome does.
 */
export function stopCandidates(tasks: TaskSummary[]): TaskSummary[] {
  return tasks.filter((t) => personWait(t) !== "none");
}

/** What the last read of the stop marks (or of the list that carried them) covered: the candidates (each `id:statusAt`) and the `stopRev` then. */
export type StopsSeen = { keys: ReadonlySet<string>; rev: number };

/**
 * Whether the stop marks are read again for this list of candidates (`stopCandidates`) and `stopRev`, after `prev`:
 * only when a candidate came or moved status, or a stop record came (`rev` moved: a record does not move a Task's row).
 * No candidate is nothing to read for. A candidate going away needs no read (its mark is no longer shown), nor does
 * one that only changed other fields (a title, a judged outcome: `updatedAt`). `seen` is what to pass as `prev` next time.
 */
export function stopsToRead(prev: StopsSeen | null, tasks: TaskSummary[], rev: number): { seen: StopsSeen; read: boolean } {
  const keys = new Set(stopCandidates(tasks).map((t) => `${t.id}:${t.statusAt}`));
  const read = keys.size > 0 && (prev === null || prev.rev !== rev || [...keys].some((k) => !prev.keys.has(k)));
  return { seen: { keys, rev }, read };
}

/** The stop marks the list `GET /api/tasks` already carries (`TaskListItem.stop`), by Task id: the Tasks with no stop have none. */
export function marksFromList(list: TaskListItem[]): Record<string, TaskStopMark> {
  const marks: Record<string, TaskStopMark> = {};
  for (const x of list) if (x.stop) marks[x.id] = x.stop;
  return marks;
}

/**
 * What a Task that holds or waits for a run slot is called: 実行中 / 承認待ち, and 実行枠待ち for an idle Task in the
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

/** Whether the Task's outcome follows from its status (an open approval, a failure, an abort) and so cannot be set by hand: the same statuses the daemon refuses an outcome write for. */
export function outcomeIsDerived(status: TaskStatus): boolean {
  return status === "waiting" || status === "error" || status === "aborted";
}

/** Whether a person can set the outcome by hand: only once the turn has ended (done / background). A derived one cannot, and idle / running store none yet (the server refuses with 409). */
export function outcomeIsSettable(status: TaskStatus): boolean {
  return !outcomeIsDerived(status) && status !== "idle" && status !== "running";
}

/** The outcomes a person can pick by hand. `waits` comes from the stop records and `failed` from the status, so neither is picked. */
const HAND_SET = ["needs_action", "finished", "unknown"] as const satisfies readonly TaskOutcome[];

/** The outcome select's options: the three a person can pick, then the Task's own value, shown but not pickable, when it is none of them (failed / waits). */
export function outcomeOptions(outcome: TaskOutcome): Array<{ value: TaskOutcome; disabled: boolean }> {
  const set: readonly TaskOutcome[] = HAND_SET;
  return [...set.map((value) => ({ value, disabled: false })), ...(set.includes(outcome) ? [] : [{ value: outcome, disabled: true }])];
}

const RANK: Record<TaskOutcome, number> = { needs_action: 0, failed: 1, finished: 2, waits: 2, unknown: 2 };

/** One row of 要対応: the Tasks stopped by the same series (`TaskStopMark.key`), newest first; `tasks[0]` is the one the row opens. */
export type AttentionGroup = { key: string; tasks: TaskSummary[]; count: number; reason: StopReasonCode | null; state: StopState | null };

/** A Task that needs nothing from the person for now (the folded 待ち section): its outcome is `waits`. The reason and conditions come from its last stop mark, null while that is not read or there is none. */
export type WaitingRow = { task: TaskSummary; key: string; reason: StopReasonCode | null; state: StopState | null; conditions: StopCondition[] };

/** 要対応 → 失敗 → 未判定 by the outcome, newest first within each; an open approval (status waiting, `personWait` needs) ranks as 要対応. */
function sortedByWait(tasks: TaskSummary[], keep: (w: PersonWait) => boolean): TaskSummary[] {
  const rank = (t: TaskSummary) => (personWait(t) === "needs" ? 0 : RANK[t.outcome]);
  return tasks.filter((t) => keep(personWait(t))).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

/**
 * Splits the Tasks into 要対応 — what `personWait` says waits on the person: needs them, failed, or not judged yet,
 * grouped by stop series — and the folded 待ち, the Tasks whose outcome is `waits`. The split reads the outcome
 * only; the stop mark gives a row its series key (要対応) or its reason and conditions (待ち). Separate from whether the
 * runner is running — a task waiting on an approval is in both lists. Home and the rail read both here, below 実行中, and
 * count the rows of `needs`. Marks not loaded yet (`marks` null) hide nothing.
 */
export function attentionGroups(tasks: TaskSummary[], marks: Record<string, TaskStopMark> | null): { needs: AttentionGroup[]; waiting: WaitingRow[] } {
  const byKey = new Map<string, AttentionGroup>();
  const waiting: WaitingRow[] = [];
  for (const task of sortedByWait(tasks, (w) => w !== "none")) {
    const mark = marks?.[task.id];
    if (personWait(task) === "waits") {
      waiting.push({ task, key: mark?.key ?? `task:${task.id}`, reason: mark?.reason ?? null, state: mark?.state ?? null, conditions: mark?.conditions ?? [] });
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

const LABEL: Record<TaskOutcome, string> = { needs_action: t(m.outcomeNeedsAction), failed: t(m.statusFailed), finished: t(m.statusDone), waits: t(m.outcomeWaits), unknown: t(m.outcomeUnknown) };

export function outcomeLabel(o: TaskOutcome): string {
  return LABEL[o];
}

/**
 * What the Task screen shows next to the outcome: the judge's one-line reason, and in the tooltip who judged.
 * The result itself is not read here: the outcome is the one result the screen shows, and a judgement that differs from it is marked on the Evals list.
 */
export function judgementNote(x: Task): { text: string; title: string } | null {
  if (!x.judgedReason) return null;
  // `<runner>:` = judged on that runner's CLI default model (the setting's model is "")
  const by = x.judgedBy?.endsWith(":") ? t(m.cliDefaultBy, { runner: x.judgedBy }) : (x.judgedBy ?? "?");
  return { text: x.judgedReason, title: t(m.judgedTitle, { by }) };
}

/** The dot of a row under 要対応: coloured by the outcome, not the runner's status. */
export function outcomeDotClass(o: TaskOutcome): string {
  return o === "needs_action" ? "wait" : o === "failed" ? "err" : o === "finished" ? "ok" : "idle";
}

/** The rail's mark for Claude Code in a Task's terminal tab. Done shows nothing: it needs nothing from the person. */
export function terminalMark(status: TerminalStatus | undefined): { text: string; className: string } | null {
  return status === "working" ? { text: t(m.termWorking), className: "m" } : status === "waiting" ? { text: t(m.termWaiting), className: "m term-wait" } : null;
}
