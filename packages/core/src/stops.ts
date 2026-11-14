import { personWait, RunnerId, StopRecord, type StopChange, type StopNext, type StopSummary, type Task, type TaskStopMark } from "@switchboard/protocol";
import { z } from "zod";
import type { Db } from "./db.ts";

/**
 * Repeated stops: which stops are the same one again, what changed since the previous one, and what the work
 * needs next. The records are the tasks' `stop.record` events — the source of truth, so a restart forgets nothing.
 */

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

function nextOf(s: StopRecord, changes: StopChange[], askedBefore: boolean, answered: boolean): StopNext {
  if (s.state === "resolved") return "none";
  if (s.state === "exhausted") return "decide";
  if (s.state === "retrying") return "retry";
  // A condition still unmet holds the work back, whatever else changed.
  if (s.conditions.some((c) => !c.met)) return "wait";
  if (changes.some((c) => c.kind === "answer" || c.kind === "condition-met")) return "resume";
  if (!NEEDS_PERSON.has(s.reason)) return "wait";
  // This series stopped before and was answered, and no new answer came: asking again gets the same answer — even
  // when another cause came in between (that cause was its own series, asked on its own).
  return askedBefore && answered ? "wait" : "decide";
}

/**
 * Whether `a` is an answer to `last`'s series (the newest stop of it): an answer is to the stop at the same place
 * (work + op + target) that was newest when it was given — one to another series' stop is not this one's, and one given
 * before anything stopped here answers nothing. A runner names an Issue comment by URL, which is a pointer, not proof:
 * until the comment is read and its repository and author checked (nothing reads it yet), only an answer the daemon saw
 * the person give (`seq:`) counts. `stops` = one record per stop (its latest), `first` = when each stop first came.
 */
function answerIsOwn(stops: StopRecord[], first: Map<string, number>, last: StopRecord, a: StopRecord["answer"]): boolean {
  if (!a || !a.ref.startsWith("seq:")) return false;
  const owner = stops.filter((s) => placeKey(s) === placeKey(last) && first.get(s.id)! < a.at).at(-1);
  return !!owner && stopKey(owner) === stopKey(last);
}

/**
 * Whether `last` (the newest stop of its series) was answered after it came: an answer the newest stop carries over from
 * an earlier stop at the same place (recordStop keeps it) is not an answer to this one — the Task stopped again after it.
 */
function answeredAfter(stops: StopRecord[], first: Map<string, number>, last: StopRecord): boolean {
  return answerIsOwn(stops, first, last, last.answer) && last.answer!.at >= first.get(last.id)!;
}

/**
 * The series of `records` (any order), newest stop last first. A record with an id seen before updates that stop (its
 * state moved: retrying → resolved …); a new id is the series stopping again. Changes are against the stop before the
 * newest one at the same work + op + target, of any reason — so a different cause shows as `cause`.
 */
export function reduceStops(records: StopRecord[]): StopSummary[] {
  const byId = new Map<string, StopRecord>();
  const first = new Map<string, number>();
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    if (!first.has(r.id)) first.set(r.id, r.at);
    byId.set(r.id, r);
  }
  // One entry per stop (its latest state), in the order the stops first happened.
  const stops = [...byId.values()].sort((a, b) => first.get(a.id)! - first.get(b.id)!);
  const series = new Map<string, StopRecord[]>();
  for (const s of stops) series.set(stopKey(s), [...(series.get(stopKey(s)) ?? []), s]);
  const out: StopSummary[] = [];
  for (const [key, list] of series) {
    const last = list[list.length - 1]!;
    const lastFirst = first.get(last.id)!;
    const newest = (rs: StopRecord[]) => rs.reduce<StopRecord["answer"]>((a, s) => (s.answer && (!a || s.answer.at >= a.at) ? s.answer : a), null);
    // Answers seen before `last`, at this place in any series: one that came back is not a new answer.
    const before = stops.filter((s) => placeKey(s) === placeKey(last) && first.get(s.id)! < lastFirst);
    const ours = (a: StopRecord["answer"]) => answerIsOwn(stops, first, last, a);
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
      lastAnswer,
      answered: answeredAfter(stops, first, last),
      grant: last.grant ?? null,
      conditions: last.conditions,
      actions: last.actions,
      changes,
      unchanged,
      next: nextOf(last, changes, list.length > 1, list.some((x) => ours(x.answer))),
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * What `stopMarks` needs of `reduceStops(records)[0]` — the series with the latest `lastAt` (the first of them on a tie) —
 * without the answers, changes and next step the marks do not carry (those make `reduceStops` slow over thousands of
 * Tasks). A test holds the two equal.
 */
export function lastStopMark(records: StopRecord[]): TaskStopMark | null {
  const byId = new Map<string, StopRecord>();
  const first = new Map<string, number>();
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
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
  // the answer is checked for the newest series only: the others are not shown
  return { key, reason: last.reason, state: last.state, conditions: last.conditions, count, answered: answeredAfter(stops, first, last) };
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
 * would be lost). A Task with no stop record of its own is left out. Whether the mark means the person is wanted is
 * `personWait`'s call, made by the reader.
 */
export function stopMarks(db: Db, tasks: Task[]): Record<string, TaskStopMark> {
  const out: Record<string, TaskStopMark> = {};
  const records = db.listStopRecordsOfStopped();
  for (const t of tasks) {
    const own = records.get(t.id);
    // a Task reviewed or at work waits on no one, whatever it stopped on (the outcome set aside, as the web's stopCandidates).
    // listStopRecordsOfStopped narrows the same way in SQL (for speed); this decides again by the Tasks passed in.
    if (!own || personWait({ ...t, outcome: "unknown" }, null) === "none") continue;
    const mark = lastStopMark(own);
    if (mark) out[t.id] = mark;
  }
  return out;
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

/**
 * What every runner start is told: how to report a stop (task.note's `stop`, or a `switchboard-stop` fence), the
 * retry rule, not to write beyond the request, and the stops of its work still open with the retries left. The runner retries its own tools itself;
 * the daemon never runs its commands. Short: it goes before every start's prompt.
 */
export function stopRecoveryPrompt(open: StopSummary[]): string {
  const lines = [
    "[Switchboard: 止まったときの報告]",
    "作業が止まったら（使用上限・承認や回答の待ち・依存の待ち・一時障害など）、理由を報告してください。Workspace MCP の task.note が使えるなら引数 stop に、無ければ返答の中に次のフェンスで書きます（根拠は短く。秘密やコマンドの生の出力は書かない）:",
    "```switchboard-stop",
    '{"id":"<この停止の短い名前>","op":"<操作>","target":"<対象>","reason":"usage-limit|github-limit|transient|auth|permission|input|decision|depends|disk-full|unknown","safety":"read-only|before-effect|unknown","evidence":"<根拠>","state":"waiting|retrying|exhausted|resolved","conditions":[{"key":"pr#12","value":"open","met":false}],"actions":[{"attempt":1,"what":"<したこと>","ok":null}]}',
    "```",
    `再実行してよいのは、一時障害（通信の切断・タイムアウト・HTTP 502/503/504）で、読み取り専用か何かする前に失敗したと確かめられる操作だけ。同じ操作を最大 ${RETRY_DELAYS_MS.length} 回（${RETRY_DELAYS_MS.map((d) => `${d / 1000} 秒後`).join("、")}）まで。再実行の前に state "retrying" と試行番号を報告し、承認はいつもどおり毎回受ける。成功したら "resolved"、使い切ったら "exhausted" を報告して止まる。認証・権限・入力のエラー、ディスクの空き切れや、何かしたか分からない操作は再実行しない。Workspace MCP の exec.run は自分で再試行するので、その失敗は再実行しない。`,
    "依存の待ち（depends）は待っている PR・Issue を conditions に pr#N / issue#N で、使用上限（usage-limit）は止めたランナーを runner#<ランナー>（value は戻る時刻を ISO 8601 のタイムゾーンつきで、分からなければ unknown）で書く。日数の経過を待つ（depends）は conditions に {\"key\":\"after\",\"value\":\"<ISO 8601 のタイムゾーンつき日時>\"}（pr#N などと一緒でもよく、全部が済んでから続く。待てるのは 7 日まで）。7 日を超えるなら PBI の工程 Task は占有の解放の --after で引き渡す（ほかの停止は conditions を省く）。並列ガードの overlap が重なり（defer）で進めないと言ったら、その出力の conditions をそのまま写す（前提の待ちを定期実行に引き渡すときの書き方は、手順にあればそれに従う）。",
    'ランナーの自動承認や権限に拒まれて止まった（reason "permission"）なら、拒まれた操作だけを名指しした許可文を "grant" に 1 文で書く（例 "grant":"<対象> に <内容> を登録することだけ許可します"。値や秘密は書かない）。利用者が選べば、その許可文が利用者の返信として 1 回だけ届く。',
    "依頼の範囲外の書き込み（計画モードでの commit・push・マージ、リポジトリの CLAUDE.md が認めていない昇格、依頼に無い Issue を閉じる）はしない。要るなら判断待ちで聞く。",
  ];
  if (open.length) {
    lines.push("この作業でまだ解けていない停止:");
    for (const s of open.slice(0, 5)) {
      const left = s.reason === "transient" && s.safety !== "unknown" ? `、再試行の残り ${Math.max(0, RETRY_DELAYS_MS.length - lastAttempt(s))} 回` : "";
      lines.push(`- ${s.op}${s.target ? ` ${s.target}` : ""}: ${s.reason}（止まったのは ${s.count} 回、${s.state}${left}）`);
    }
  }
  return lines.join("\n");
}
