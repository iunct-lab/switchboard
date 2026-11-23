import { HUMAN_STOP_REASONS, personWait, RunnerId, StopRecord, taskSummary, type StopChange, type StopNext, type StopSummary, type Task, type TaskListItem, type TaskOutcome, type TaskStopMark } from "@switchboard/protocol";
import { z } from "zod";
import type { Db } from "./db.ts";
import { presetReplies } from "./presets.ts";
import { afterTime } from "../../../scripts/parallel-guard.ts";

/**
 * Repeated stops: which stops are the same one again, what changed since the previous one, and what the work
 * needs next. The records are the tasks' `stop.record` events — the source of truth, so a restart forgets nothing.
 */

/** A span for a sentence: minutes under two hours, hours under two days, else days. */
export const spanText = (ms: number): string => (ms < 2 * 3600_000 ? `${Math.max(0, Math.round(ms / 60_000))} 分` : ms < 2 * 86_400_000 ? `${Math.round(ms / 3600_000)} 時間` : `${Math.round(ms / 86_400_000)} 日`);

/** The work a stop belongs to: the Issue (workspace + number, so the same number in another repository is other work), else the schedule, else the task. */
export function workKey(w: StopRecord["work"]): string {
  if (w.issue !== null) return `${w.workspaceId ?? "-"}#${w.issue}`;
  return w.scheduleId ? `schedule:${w.scheduleId}` : `task:${w.taskId}`;
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The series a stop belongs to: same work, operation, target and reason code. How the reason was worded does not count
 * — except for `unknown`, where the evidence is all there is, so unknown stops with other evidence stay apart.
 */
export function stopKey(s: StopRecord): string {
  return [workKey(s.work), s.op, s.target, s.reason, s.reason === "unknown" ? squash(s.evidence) : ""].join("\u0000");
}

/** Same work, operation and target — the stops a new cause is told against. */
export const placeKey = (s: StopRecord) => [workKey(s.work), s.op, s.target].join("\u0000");

/**
 * What changed from `prev` to `cur` (the stops before and now of the same work + op + target): a different cause, a new
 * answer, a condition met since, a condition's value moved / added / gone. Empty = the same stop again. `known` = the
 * newest answer already seen before `cur` (default: prev's) — an answer used once is not new when it comes back.
 */
export function compareStopConditions(prev: StopRecord | undefined, cur: StopRecord, known: StopRecord["answer"] = prev?.answer ?? null): StopChange[] {
  if (!prev) return [];
  const changes: StopChange[] = [];
  if (stopKey(prev) !== stopKey(cur)) changes.push({ kind: "cause", detail: prev.reason === cur.reason ? `${cur.reason}: ${cur.evidence}` : `${prev.reason} → ${cur.reason}` });
  if (cur.answer && cur.answer.ref !== known?.ref) changes.push({ kind: "answer", detail: cur.answer.ref });
  const before = new Map(prev.conditions.map((c) => [c.key, c]));
  for (const c of cur.conditions) {
    const b = before.get(c.key);
    if (c.met && !b?.met) changes.push({ kind: "condition-met", detail: `${c.key}: ${c.value}` });
    else if (!b || b.value !== c.value || b.met !== c.met) changes.push({ kind: "condition", detail: `${c.key}: ${b ? `${b.value} → ` : ""}${c.value}` });
    before.delete(c.key);
  }
  for (const b of before.values()) changes.push({ kind: "condition", detail: `${b.key}: なし` });
  return changes;
}

/** Reasons a retry cannot fix: the person has to act (or has already answered, and nothing changed since). */
export const NEEDS_PERSON = new Set<StopRecord["reason"]>(["auth", "permission", "input", "decision", "unknown"]);

/** The action `resumeDepends` adds when it meets `key` (`issue#N`) of a decision stop from the stored records. */
export const issueAnsweredAction = (key: string) => `回答か Issue の終わりを見た: ${key}`;

/**
 * A decision stop answered on the Issue it named: all its conditions are met and one is an Issue (`issue#N`) that
 * `resumeDepends` met (its action says so) once that Issue had an answer (`## 回答`) after the stop or was closed. A runner
 * writing `met: true` itself is not proof, as with an answer it names (`answerIsOwn`): only what the daemon saw counts. The
 * next stage Task reads the answer from the Issue, so the stop no longer waits for the person — unlike a met `job#N`,
 * which is not their answer.
 */
export const answeredOnIssue = (s: Pick<StopRecord, "reason" | "conditions" | "actions">): boolean =>
  s.reason === "decision" &&
  s.conditions.every((c) => c.met) &&
  s.conditions.some((c) => /^issue#\d+$/.test(c.key) && s.actions.some((a) => a.what === issueAnsweredAction(c.key)));

function nextOf(s: StopRecord, changes: StopChange[], askedBefore: boolean, answered: boolean): StopNext {
  if (s.state === "resolved") return "none";
  if (s.state === "exhausted") return "decide";
  if (s.state === "retrying") return "retry";
  // A condition still unmet holds the work back, whatever else changed.
  if (s.conditions.some((c) => !c.met)) return "wait";
  if (changes.some((c) => c.kind === "answer")) return "resume";
  // answered on the Issue: nothing is sent to the Task (the next stage Task reads it), and the person is not asked again
  if (answeredOnIssue(s)) return "wait";
  // A stop waiting for the person is not let go by a condition met alone: only their answer is.
  if (!NEEDS_PERSON.has(s.reason)) return changes.some((c) => c.kind === "condition-met") ? "resume" : "wait";
  // This series stopped before and was answered, and no new answer came: asking again gets the same answer — even
  // when another cause came in between (that cause was its own series, asked on its own). `answered` counts only an
  // answer to a stop that said the grant this one says (`answeredSameGrant`): a stop with another grant asks again.
  return askedBefore && answered ? "wait" : "decide";
}

/**
 * Whether `a` is an answer to `last`'s series (the newest stop of it): an answer is to the stop at the same place
 * (work + op + target) that was newest when it was given — one to another series' stop is not this one's, and one given
 * before anything stopped here answers nothing. A runner names an Issue comment by URL, which is a pointer, not proof:
 * until the comment is read and its repository and author checked (nothing reads it yet), only an answer the daemon saw
 * the person give (`seq:`) counts. `stops` = one record per stop (its latest), `first` = when each stop first came,
 * `places` = each stop's `placeKey` (made once by `reduceStops`).
 */
function answerIsOwn(stops: StopRecord[], first: Map<string, number>, places: Map<string, string>, last: StopRecord, a: StopRecord["answer"]): boolean {
  return answerOwner(stops, first, places, last, a) !== null;
}

/** The stop `a` was given to when it is an answer to `last`'s series (`answerIsOwn`); null when it is not. */
function answerOwner(stops: StopRecord[], first: Map<string, number>, places: Map<string, string>, last: StopRecord, a: StopRecord["answer"]): StopRecord | null {
  if (!a || !a.ref.startsWith("seq:")) return null;
  const lastPlace = places.get(last.id);
  const owner = stops.filter((s) => places.get(s.id) === lastPlace && first.get(s.id)! < a.at).at(-1);
  return owner && stopKey(owner) === stopKey(last) ? owner : null;
}

/**
 * Whether the answer `x` carries is an answer to `last`'s series given to a stop that then said the grant `last` says
 * now: the person answered what that grant asked, so the same grant asked again gets the same answer — and another
 * grant was never answered. The stop the answer was given to is `x` itself when it was there as the answer came (a reply
 * marks the stops it answers, `tasks.send`'s `answers`: one at the same place it did not mark is not answered by it),
 * else the stop `x` carries it over from (`answerOwner`). The grant that stop said is the one of its record when the
 * answer came (`history`: each stop's records in time order; reported again with another grant since, what was answered
 * stays).
 */
function answeredSameGrant(stops: StopRecord[], first: Map<string, number>, places: Map<string, string>, history: Map<string, StopRecord[]>, last: StopRecord, x: StopRecord): boolean {
  const a = x.answer;
  const owner = answerOwner(stops, first, places, last, a);
  if (!a || !owner) return false;
  const to = a.at >= first.get(x.id)! ? x : owner;
  const records = history.get(to.id)!;
  const then = records.filter((r) => r.at <= a.at).at(-1) ?? records[0]!;
  return (then.grant ?? null) === (last.grant ?? null);
}

/**
 * Whether `last` (the newest stop of its series) was answered after it came: an answer the newest stop carries over from
 * an earlier stop at the same place (recordStop keeps it) is not an answer to this one — the Task stopped again after it.
 */
function answeredAfter(stops: StopRecord[], first: Map<string, number>, since: Map<string, number>, places: Map<string, string>, last: StopRecord): boolean {
  return answerIsOwn(stops, first, places, last, last.answer) && last.answer!.at >= since.get(last.id)!;
}

/**
 * Per stop id, the time its record took its present op + reason + grant (records in time order): a reply older than that
 * answered what the stop used to say, not what it says now. A record re-reported unchanged keeps the time.
 */
function contentSince(sorted: StopRecord[]): Map<string, number> {
  const since = new Map<string, number>();
  const now = new Map<string, string>();
  for (const r of sorted) {
    const content = JSON.stringify([r.op, r.reason, r.grant ?? null]);
    if (now.get(r.id) !== content) since.set(r.id, r.at);
    now.set(r.id, content);
  }
  return since;
}

/**
 * The series of `records` (any order), newest stop last first. A record with an id seen before updates that stop (its
 * state moved: retrying → resolved …); a new id is the series stopping again. Changes are against the stop before the
 * newest one at the same work + op + target, of any reason — so a different cause shows as `cause`.
 * `newestTaskId` (an Issue's stops, read for the item: its newest stage Task): a series still `waiting` whose newest stop
 * is an earlier Task's is left out — a later stage Task took the work over, so nothing waits on that stop any more. A
 * Task's own reading (its detail, its recovery prompt) passes none and keeps every series.
 */
export function reduceStops(records: StopRecord[], opts: { newestTaskId?: string | null } = {}): StopSummary[] {
  const byId = new Map<string, StopRecord>();
  const first = new Map<string, number>();
  const sorted = [...records].sort((a, b) => a.at - b.at);
  const since = contentSince(sorted);
  const history = new Map<string, StopRecord[]>();
  for (const r of sorted) {
    if (!first.has(r.id)) first.set(r.id, r.at);
    byId.set(r.id, r);
    history.set(r.id, [...(history.get(r.id) ?? []), r]);
  }
  // One entry per stop (its latest state), in the order the stops first happened.
  const stops = [...byId.values()].sort((a, b) => first.get(a.id)! - first.get(b.id)!);
  const series = new Map<string, StopRecord[]>();
  for (const s of stops) series.set(stopKey(s), [...(series.get(stopKey(s)) ?? []), s]);
  const places = new Map(stops.map((s) => [s.id, placeKey(s)]));
  const out: StopSummary[] = [];
  for (const [key, list] of series) {
    const last = list[list.length - 1]!;
    if (opts.newestTaskId && last.state === "waiting" && last.work.taskId !== opts.newestTaskId) continue;
    const lastFirst = first.get(last.id)!;
    const newest = (rs: StopRecord[]) => rs.reduce<StopRecord["answer"]>((a, s) => (s.answer && (!a || s.answer.at >= a.at) ? s.answer : a), null);
    // Answers seen before `last`, at this place in any series: one that came back is not a new answer.
    const before = stops.filter((s) => places.get(s.id) === places.get(last.id) && first.get(s.id)! < lastFirst);
    const ours = (a: StopRecord["answer"]) => answerIsOwn(stops, first, places, last, a);
    const changes = compareStopConditions(before.at(-1), last, newest(before)).filter((c) => c.kind !== "answer" || ours(last.answer));
    const lastAnswer = newest(list.filter((x) => x.answer?.ref.startsWith("seq:")));
    const unchanged = list.length > 1 && changes.length === 0;
    out.push({
      key,
      work: last.work,
      op: last.op,
      target: last.target,
      reason: last.reason,
      evidence: last.evidence,
      safety: last.safety,
      count: list.length,
      state: last.state,
      firstAt: first.get(list[0]!.id)!,
      lastAt: last.at,
      contentAt: since.get(last.id)!,
      lastAnswer,
      answered: answeredAfter(stops, first, since, places, last) || answeredOnIssue(last),
      grant: last.grant ?? null,
      conditions: last.conditions,
      actions: last.actions,
      changes,
      unchanged,
      next: nextOf(last, changes, list.length > 1, list.some((x) => answeredSameGrant(stops, first, places, history, last, x))),
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * What `stopMarks` needs of `reduceStops(records)[0]` — the series with the latest `lastAt` (the first of them on a tie) —
 * without the answers, changes and next step the marks do not carry (those make `reduceStops` slow over thousands of
 * Tasks). A test holds the two equal.
 */
export function lastStopMark(records: StopRecord[]): Omit<TaskStopMark, "replies"> | null {
  const byId = new Map<string, StopRecord>();
  const first = new Map<string, number>();
  const sorted = [...records].sort((a, b) => a.at - b.at);
  const since = contentSince(sorted);
  for (const r of sorted) {
    if (!first.has(r.id)) first.set(r.id, r.at);
    byId.set(r.id, r);
  }
  const series = new Map<string, StopRecord[]>();
  const stops = [...byId.values()].sort((a, b) => first.get(a.id)! - first.get(b.id)!);
  for (const s of stops) {
    const k = stopKey(s);
    const list = series.get(k);
    if (list) list.push(s);
    else series.set(k, [s]);
  }
  let best: { key: string; last: StopRecord; count: number } | null = null;
  for (const [key, list] of series) {
    const last = list[list.length - 1]!;
    if (!best || last.at > best.last.at) best = { key, last, count: list.length };
  }
  if (!best) return null;
  const { key, last, count } = best;
  // the answer is checked for the newest series only: the others are not shown; the places are made only when it carries an answer to check
  const places = new Map<string, string>(last.answer ? stops.map((s) => [s.id, placeKey(s)]) : []);
  return { key, reason: last.reason, state: last.state, conditions: last.conditions, count, answered: answeredAfter(stops, first, since, places, last) || answeredOnIssue(last) };
}

/**
 * The only answer a runner may name: a GitHub Issue / PR comment, by URL — never words of its own, which would
 * turn its free text into the person's answer. The URL is a pointer, not proof: whoever resumes on it reads the
 * comment and checks its repository and author. Anything else is dropped (the report itself is kept).
 */
const COMMENT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+#(issuecomment-|discussion_r|pullrequestreview-)\d+$/;

/**
 * What a runner reports about a stop: task.note's `stop`, or a `switchboard-stop` fence in its own reply. The
 * daemon adds the work, the time and — unless the runner names one (an Issue comment it read) — the answer.
 */
export const StopReport = StopRecord.omit({ work: true, at: true, answer: true }).extend({ id: z.string().min(1).max(100), answer: z.string().max(300).regex(COMMENT_URL).optional().catch(undefined) });
export type StopReport = z.infer<typeof StopReport>;

/** A job the daemon runs for the Task: its id is no number on GitHub, and is read from the jobs table. */
export const JOB_KEY = /^job#(\d+)$/;
/** A wait key of a stop's condition: a PR or an Issue of the workspace's repository, by number, or a job of the daemon, by id. */
export const WAIT_KEY = /^(pr|issue|job)#(\d+)$/;
/** A wait for a date: the condition's value is an ISO 8601 time with a time zone, like the `runner#<runner>` value of a usage limit. */
export const AFTER_KEY = "after";

/** A condition that waits for a date the app can read: `after` with an ISO 8601 time with a zone. */
export const isAfterWait = (c: { key: string; value: string }): boolean => c.key === AFTER_KEY && !Number.isNaN(afterTime(c.value));

/**
 * Whether the app continues a `depends` stop when what it waits for is over: every condition is a PR / Issue / job
 * (`WAIT_KEY`) or a date it can read (`after`), and one of them is still unmet. Any other `depends` (no condition, one
 * the app cannot watch, like a subagent or a background run, or every condition already met) is never continued, so it
 * waits for the person.
 */
export function resumableDepends(stop: Pick<StopRecord, "reason" | "conditions">): boolean {
  return stop.reason === "depends" && stop.conditions.some((c) => !c.met) && stop.conditions.every((c) => WAIT_KEY.test(c.key) || isAfterWait(c));
}

/**
 * A stop that is not `depends` is no wait the daemon resumes, so nothing else closes its `job#<id>` conditions: the ones
 * whose job ended (`ended`) are recorded met, even when the Task reports them open again after the job ended. A `depends`
 * stop is left as reported: `dependsWaits` reads its open conditions to send the Task the job's result.
 */
export function meetEndedJobs(report: StopReport, ended: (id: number) => boolean): StopReport {
  if (report.reason === "depends") return report;
  let changed = false;
  const conditions = report.conditions.map((c) => {
    const m = JOB_KEY.exec(c.key);
    if (c.met || !m || !ended(Number(m[1]))) return c;
    changed = true;
    return { ...c, met: true };
  });
  return changed ? { ...report, conditions } : report;
}

/** The Issue a stage Task is for (its `stage` column); null for any other task. */
export const issueOf = (task: Pick<Task, "workspaceId" | "stage">): number | null => (task.workspaceId ? task.stage?.issue ?? null : null);

export const stopWork = (task: Task): StopRecord["work"] => {
  const issue = issueOf(task);
  return { workspaceId: task.workspaceId, issue, taskId: task.id, ...(issue === null && task.scheduleId ? { scheduleId: task.scheduleId } : {}) };
};

/** How many of a schedule's newest Tasks its stops are read from. */
const SCHEDULE_TASKS = 30;

/** Every stop of the task's work: of all the stage Tasks of its Issue when it has one (another Task on the same Issue stops the same work), else of its schedule's recent Tasks, else its own. */
export function stopRecordsFor(db: Db, task: Task): StopRecord[] {
  const issue = issueOf(task);
  if (issue !== null) return db.listStopRecords(db.stageTaskIds(task.workspaceId!, issue));
  return db.listStopRecords(task.scheduleId ? db.recentScheduleTaskIds(task.scheduleId, SCHEDULE_TASKS) : [task.id]);
}

/**
 * The last stop of each stopped Task that is not reviewed (確認済み), whatever its outcome: waiting, done, error or aborted,
 * read in one query (`listStopRecordsOfStopped`). Of each, the newest series (`reduceStops` puts the latest `lastAt` first)
 * among the stops that Task itself reported — not `stopRecordsFor`, which also reads the other Tasks of the same Issue /
 * schedule (their newer stop is not this Task's last stop) and only the schedule's latest Tasks (an older Task's own stop
 * would be lost). A Task with no stop record of its own, or that waits on no one (`personWait`), is left out. The mark
 * only carries what the stop was; whether the person is wanted is the Task's outcome.
 */
export function stopMarks(db: Db, tasks: Task[], now: number): Record<string, TaskStopMark> {
  const out: Record<string, TaskStopMark> = {};
  const replies = presetReplies(db, now);
  const records = db.listStopRecordsOfStopped();
  for (const t of tasks) {
    const own = records.get(t.id);
    // a Task that waits on no one (reviewed, at work, or an outcome that needs nothing) has no mark; the mark is for showing
    // the stop's reason and key, not for deciding whether the person is wanted (that is the outcome, `personWait`).
    // listStopRecordsOfStopped narrows in SQL (for speed); this decides again by the Tasks passed in.
    if (!own || personWait(t) === "none") continue;
    const mark = lastStopMark(own);
    if (mark) out[t.id] = { ...mark, replies: replies.get(mark.reason) ?? [] };
  }
  return out;
}

/** The Tasks as `GET /api/tasks` lists them: each summary with its `stop` from `stopMarks`; a Task with no mark gets no `stop` field. */
export function tasksWithStops(db: Db, tasks: Task[]): TaskListItem[] {
  const marks = stopMarks(db, tasks, Date.now());
  return tasks.map((t) => {
    const stop = marks[t.id];
    return stop ? { ...taskSummary(t), stop } : taskSummary(t);
  });
}

/**
 * The series a schedule keeps stopping on: its latest Task and the one before it (consecutive Tasks, newest first) each
 * have a stop of it that did not end resolved, it is still waiting / exhausted, and nothing released it — a met condition
 * to resume on, all its conditions met, or the person's answer (`seq:`) given after the latest stop came, exhausted too
 * (answerableStops). `count` and `firstAt` are of that run of consecutive Tasks.
 */
export function stuckSchedule(db: Db, schedule: { id: string; lastTaskId: string | null }): StopSummary | null {
  const last = schedule.lastTaskId;
  if (!last) return null;
  const ids = db.recentScheduleTaskIds(schedule.id, SCHEDULE_TASKS);
  const from = ids.indexOf(last);
  if (from < 0) return null;
  const records = db.listStopRecords(ids);
  for (const s of reduceStops(records)) {
    if (s.work.taskId !== last || (s.state !== "waiting" && s.state !== "exhausted") || s.next === "resume") continue;
    if (s.conditions.length > 0 && s.conditions.every((c) => c.met)) continue;
    // per stop of the series: when it first came and its newest state; a Task counts when one of its stops did not end resolved
    const stops = new Map<string, { taskId: string; at: number; state: StopRecord["state"] }>();
    for (const r of records) if (stopKey(r) === s.key) stops.set(r.id, { taskId: r.work.taskId, at: stops.get(r.id)?.at ?? r.at, state: r.state });
    const firstOf = new Map<string, number>();
    for (const x of stops.values()) if (x.state !== "resolved") firstOf.set(x.taskId, Math.min(firstOf.get(x.taskId) ?? Infinity, x.at));
    let count = 0;
    let firstAt = s.lastAt;
    for (const id of ids.slice(from)) {
      const at = firstOf.get(id);
      if (at === undefined) break;
      count++;
      firstAt = at;
    }
    if (count < 2) continue;
    // the person answered the latest stop (a stop carries the newest answer known when it came: only a later one is to it)
    const latest = [...stops].filter(([, x]) => x.taskId === last).sort((a, b) => b[1].at - a[1].at)[0];
    const answer = latest && records.filter((r) => r.id === latest[0]).at(-1)?.answer;
    if (latest && answer?.ref.startsWith("seq:") && answer.at > latest[1].at) continue;
    return { ...s, count, firstAt };
  }
  return null;
}

/** The newest record of each stop the person's reply answers: the open ones, and one that ran out of retries. */
export function answerableStops(records: StopRecord[]): StopRecord[] {
  const latest = new Map<string, StopRecord>();
  for (const r of records) latest.set(r.id, r);
  return [...latest.values()].filter((r) => r.state === "waiting" || r.state === "retrying" || r.state === "exhausted");
}

/** The newest record of each stop of `records` still open (waiting / retrying) — the ones an answer or 中断 moves. */
export function openStops(records: StopRecord[]): StopRecord[] {
  const latest = new Map<string, StopRecord>();
  for (const r of records) latest.set(r.id, r);
  return [...latest.values()].filter((r) => r.state === "waiting" || r.state === "retrying");
}

/**
 * The `outcome` a Task's stop records decide (docs/design/task-outcome.md), or null when it has none (the outcome is left as
 * it is). Of each stop's newest record, those not `resolved` and not answered since the stop was last reported are open: one that waits for the person
 * (a human reason, `waiting` / `exhausted`, no condition to wait on; or a `depends` the app does not continue, `resumableDepends`) is `needs_action`; any other open one is `waits`;
 * records that are all closed are `unknown` during a turn (`inTurn`: the reply after them is still to come) and `finished`
 * after it. Written each time a stop is recorded (`TaskManager.recordStopEvent`), so the column is the one place that
 * says whether the Task waits on the person.
 */
export function outcomeFromStops(records: StopRecord[], inTurn: boolean): TaskOutcome | null {
  if (!records.length) return null;
  const latest = new Map<string, StopRecord>();
  const before = new Map<string, StopRecord>();
  for (const r of records) {
    const prev = latest.get(r.id);
    if (prev) before.set(r.id, prev);
    latest.set(r.id, r);
  }
  // Answered: the newest record brought the answer to this stop's earlier record, or the answer is not older than it. An answer
  // carried over (the stop reported again, or a first stop at a place answered before: `recordStop` keeps the last answer) is older.
  const brought = (r: StopRecord) => before.has(r.id) && r.answer!.ref !== before.get(r.id)!.answer?.ref;
  const answered = (r: StopRecord) => !!r.answer && (brought(r) || r.answer.at >= r.at);
  const open = [...latest.values()].filter((r) => r.state !== "resolved" && !answered(r));
  const waitsOnPerson = (r: StopRecord) => (r.state === "waiting" || r.state === "exhausted") && (r.reason === "depends" ? !resumableDepends(r) : HUMAN_STOP_REASONS.has(r.reason) && r.conditions.length === 0);
  if (open.some(waitsOnPerson)) return "needs_action";
  if (open.length) return "waits";
  return inTurn ? "unknown" : "finished";
}

const MAX_FENCE = 8_000;

/**
 * Reads one kind of fence (` ```<name> `) out of a runner's reply as it streams: only a fence opened at the
 * start of a line, outside any other fence (a quoted example is not a report); its body goes to `parse`, which answers
 * null for anything that is not one. Holds at most one line and one fence body (`MAX_FENCE`); a message id change or
 * `end()` closes the message.
 */
export class FenceReader<T> {
  private line = "";
  private body: string[] | null = null;
  private other: string | null = null;
  private messageId: string | undefined;
  private readonly open: RegExp;

  constructor(
    name: string,
    private parse: (json: string) => T | null,
  ) {
    this.open = new RegExp(`^\`\`\`${name.replace(/[^a-z0-9-]/gi, "")}[ \\t]*$`);
  }

  feed(text: string, messageId?: string): T[] {
    const out = messageId !== this.messageId ? this.end() : [];
    this.messageId = messageId;
    const parts = (this.line + text).split("\n");
    this.line = parts.pop()!.slice(-MAX_FENCE);
    for (const l of parts) this.take(l, out);
    return out;
  }

  end(): T[] {
    const out: T[] = [];
    if (this.line) this.take(this.line, out);
    this.line = "";
    this.body = null;
    this.other = null;
    return out;
  }

  private take(raw: string, out: T[]) {
    const l = raw.replace(/\r$/, "");
    if (this.body) {
      if (/^```[ \t]*$/.test(l)) {
        const r = this.parse(this.body.join("\n"));
        if (r) out.push(r);
        this.body = null;
      } else {
        this.body.push(l);
        // too long: dropped, not held without bound — and skipped to its closing line, which must not open a fence
        if (this.body.reduce((n, b) => n + b.length + 1, 0) > MAX_FENCE) {
          this.body = null;
          this.other = "```";
        }
      }
      return;
    }
    if (this.other) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (m && m[1]![0] === this.other[0] && m[1]!.length >= this.other.length) this.other = null;
      return;
    }
    if (this.open.test(l)) this.body = [];
    else this.other = /^ {0,3}(`{3,}|~{3,})/.exec(l)?.[1] ?? null;
  }
}

/** The stop reports: `switchboard-stop` fences checked against StopReport. */
export class StopFenceReader extends FenceReader<StopReport> {
  constructor() {
    super("switchboard-stop", parseStopReport);
  }
}

/** One report's JSON, checked; null when it is not JSON or not a StopReport. */
export function parseStopReport(json: string): StopReport | null {
  try {
    const r = StopReport.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The bounded retry: two more tries of the same operation, 5 s then 30 s after the failure. Fixed, not a setting. */
export const RETRY_DELAYS_MS = [5_000, 30_000] as const;

export const lastAttempt = (s: Pick<StopRecord, "actions">) => Math.max(0, ...s.actions.map((a) => a.attempt));

/**
 * Whether the stop may be tried again by itself, and which attempt that is. Only a passing failure (`transient`:
 * a dropped connection, a timeout, HTTP 502 / 503 / 504) of an operation known to be harmless to repeat — read-only, or
 * failed before it did anything; an auth / permission / input error or an operation that may have done something is
 * never retried. `prev` = this stop's newest record (its attempts so far; a resolved one starts over).
 */
export function reserveStopRetry(prev: StopRecord | undefined, next: Pick<StopRecord, "reason" | "safety">): { ok: true; attempt: number; delayMs: number } | { ok: false; exhausted: boolean; why: string } {
  const used = prev && prev.state !== "resolved" ? lastAttempt(prev) : 0;
  if (next.reason !== "transient") return { ok: false, exhausted: false, why: `理由が ${next.reason} の停止は自動で再試行しません` };
  if (next.safety === "unknown") return { ok: false, exhausted: false, why: "もう一度実行して安全か分かりません（読み取り専用でも、何かする前の失敗でもない）" };
  if (used >= RETRY_DELAYS_MS.length) return { ok: false, exhausted: true, why: `再試行は ${RETRY_DELAYS_MS.length} 回までです（使い切りました）` };
  return { ok: true, attempt: used + 1, delayMs: RETRY_DELAYS_MS[used]! };
}

/** The runner a usage-limit stop names in its conditions: `runner#codex` with the time the limit lifts as the value. */
export const RUNNER_LIMIT_KEY = /^runner#(.+)$/;

/**
 * The other runner's usage limit a stop reports: a waiting `usage-limit` stop with a `runner#<runner>` condition.
 * `resetsAt` (ms) is the condition's value read as a time; `unknown` or anything unreadable leaves it out.
 */
export function reportedLimit(stop: StopRecord): { runner: RunnerId; resetsAt?: number } | undefined {
  if (stop.reason !== "usage-limit" || stop.state !== "waiting") return undefined;
  for (const c of stop.conditions) {
    const runner = RunnerId.safeParse(RUNNER_LIMIT_KEY.exec(c.key)?.[1]);
    if (!runner.success) continue;
    const at = Date.parse(c.value);
    return Number.isNaN(at) ? { runner: runner.data } : { runner: runner.data, resetsAt: at };
  }
  return undefined;
}

/** What the app knows about a Task when it starts its runner, and the stop report's text depends on. */
export interface PreambleConditions {
  /** The Workspace MCP is among the servers the runner is started with (`task.note`, `exec.run`). */
  workspaceMcp: boolean;
  /** A PBI's stage Task: the only kind that holds an occupancy claim and is judged by the parallel guard. */
  stage: boolean;
  /** The runner is started in plan mode. */
  planMode: boolean;
}

/**
 * What a new session is told once: how to report a stop (task.note's `stop` where the Workspace MCP is attached, a
 * `switchboard-stop` fence otherwise — one of the two, never both), the retry rule, not to write beyond the request,
 * and the stops of its work still open with the retries left. Only the sentences that hold for `cond` are in it. The
 * runner retries its own tools itself; the daemon never runs its commands.
 */
export function stopRecoveryPrompt(open: StopSummary[], cond: PreambleConditions): string {
  const how = "作業が止まったら（使用上限・承認や回答の待ち・依存の待ち・一時障害など）、理由を報告してください。";
  const lines = [
    "[Switchboard: 止まったときの報告]",
    ...(cond.workspaceMcp
      ? [`${how}Workspace MCP の task.note の引数 stop に書きます（根拠は短く。秘密やコマンドの生の出力は書かない）。`]
      : [
          `${how}返答の中に次のフェンスで書きます（根拠は短く。秘密やコマンドの生の出力は書かない）:`,
          "```switchboard-stop",
          '{"id":"<この停止の短い名前>","op":"<操作>","target":"<対象>","reason":"usage-limit|github-limit|transient|auth|permission|input|decision|depends|disk-full|unknown","safety":"read-only|before-effect|unknown","evidence":"<根拠>","state":"waiting|retrying|exhausted|resolved","conditions":[{"key":"pr#12","value":"open","met":false}],"actions":[{"attempt":1,"what":"<したこと>","ok":null}]}',
          "```",
        ]),
    `再実行してよいのは、一時障害（通信の切断・タイムアウト・HTTP 502/503/504）で、読み取り専用か何かする前に失敗したと確かめられる操作だけ。同じ操作を最大 ${RETRY_DELAYS_MS.length} 回（${RETRY_DELAYS_MS.map((d) => `${d / 1000} 秒後`).join("、")}）まで。再実行の前に state "retrying" と試行番号を報告し、承認はいつもどおり毎回受ける。成功したら "resolved"、使い切ったら "exhausted" を報告して止まる。認証・権限・入力のエラー、ディスクの空き切れや、何かしたか分からない操作は再実行しない。${cond.workspaceMcp ? "Workspace MCP の exec.run は自分で再試行するので、その失敗は再実行しない。" : ""}`,
    `依存の待ち（depends）は待っている PR・Issue・デーモンに頼んだ仕事を conditions に pr#N / issue#N / job#N で、使用上限（usage-limit）は止めたランナーを runner#<ランナー>（value は戻る時刻を ISO 8601 のタイムゾーンつきで、分からなければ unknown）で書く。日数の経過を待つ（depends）は conditions に {"key":"after","value":"<ISO 8601 のタイムゾーンつき日時>"}（pr#N などと一緒でもよく、全部が済んでから続く。待てるのは 7 日まで）。${
      cond.stage
        ? "7 日を超えるなら PBI の工程 Task は占有の解放の --after で引き渡す（ほかの停止は conditions を省く）。並列ガードの overlap が重なり（defer）で進めないと言ったら、その出力の conditions をそのまま写す（前提の待ちを定期実行に引き渡すときの書き方は、手順にあればそれに従う）。"
        : "7 日を超えるなら conditions を省く。"
    }サブエージェント・背景の実行・別リポジトリの待ちのように、どの鍵でも書けない待ちはアプリが再開できないので、利用者の要対応に出る。`,
    "何かが済むのを待つときは `ops-kit wait --for \"<何を待つか>\" --timeout <秒> --on-timeout <fail|proceed> -- <判定コマンド>` を使い、until / while と sleep の繰り返しでは待たない（何を待つか・上限・切れたときの動作が無い待ちは書けない。待ちと上限は画面に出る）。fail で切れたら（exit 124）同じ待ちに入り直さず、切れた理由を報告して止まる。",
    'ランナーの自動承認や権限に拒まれて止まった（reason "permission"）なら、拒まれた操作だけを名指しした許可文を "grant" に 1 文で書く（例 "grant":"<対象> に <内容> を登録することだけ許可します"。値や秘密は書かない）。マージ判定の外のマージ・聞く理由の解除（[merge-answer] の投稿）は、拒んだ側の出力が示す決まった文（聞く理由は「PR #<n> をマージしてよい」（投稿の検査がある間は「PR #<n> に [merge-answer] yes を投稿してよい」も通る）、判定の外のマージは「PR #<n> を判定の外でマージしてよい」）をそのまま grant に書く（ほかの言い方では通らない）。利用者が選べば、その許可文が利用者の返信として 1 回だけ届く。',
    `依頼の範囲外の書き込み（${cond.planMode ? "計画モードでの commit・push・マージ、" : ""}リポジトリの CLAUDE.md が認めていない昇格、依頼に無い Issue を閉じる）はしない。要るなら判断待ちで聞く。`,
  ];
  const stops = openStopsPrompt(open);
  return stops ? `${lines.join("\n")}\n${stops}` : lines.join("\n");
}

/**
 * The stops of the work still open, with the retries left; empty when there is none. All a continued session is told at a
 * restart of its process. The operation and its target are quoted apart and the heading says the lines are a record: a
 * line that joined them with a space read as one command with one more argument, and a Task ran it.
 */
export function openStopsPrompt(open: StopSummary[]): string {
  if (!open.length) return "";
  const lines = ["この作業でまだ解けていない停止（前に止まったときの記録。各行の操作は、そのまま実行するコマンドではない）:"];
  for (const s of open.slice(0, 5)) {
    const left = s.reason === "transient" && s.safety !== "unknown" ? `、再試行の残り ${Math.max(0, RETRY_DELAYS_MS.length - lastAttempt(s))} 回` : "";
    lines.push(`- 操作「${s.op}」${s.target ? `、対象「${s.target}」` : ""}: ${s.reason}（止まったのは ${s.count} 回、${s.state}${left}）`);
  }
  return lines.join("\n");
}
