import { StopRecord, type StopChange, type StopNext, type StopSummary, type Task } from "@switchboard/protocol";
import { z } from "zod";
import type { Db } from "./db.ts";

/**
 * Repeated stops (#939): which stops are the same one again, what changed since the previous one, and what the work
 * needs next. The records are the tasks' `stop.record` events — the source of truth, so a restart forgets nothing.
 */

/** The work a stop belongs to: the Issue (workspace + number, so the same number in another repository is other work) or, with none, the task. */
export function workKey(w: StopRecord["work"]): string {
  return w.issue !== null ? `${w.workspaceId ?? "-"}#${w.issue}` : `task:${w.taskId}`;
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
    // An answer is to the stop at this place (work + op + target) that was newest when it was given: one to another
    // series' stop is not this one's, and one given before anything stopped here answers nothing.
    const owner = (a: NonNullable<StopRecord["answer"]>) => stops.filter((s) => placeKey(s) === placeKey(last) && first.get(s.id)! < a.at).at(-1);
    // A runner names an Issue comment by URL, which is a pointer, not proof (#948): until the comment is read and its
    // repository and author checked (#950 — nothing reads it yet), only an answer the daemon saw the person give counts.
    const ours = (a: StopRecord["answer"]) => !!a && a.ref.startsWith("seq:") && (() => { const o = owner(a); return !!o && stopKey(o) === key; })();
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
 * The only answer a runner may name (#948): a GitHub Issue / PR comment, by URL — never words of its own, which would
 * turn its free text into the person's answer. The URL is a pointer, not proof: whoever resumes on it (#950) reads the
 * comment and checks its repository and author. Anything else is dropped (the report itself is kept).
 */
const COMMENT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+#(issuecomment-|discussion_r|pullrequestreview-)\d+$/;

/**
 * What a runner reports about a stop (#948): task.note's `stop`, or a `switchboard-stop` fence in its own reply. The
 * daemon adds the work, the time and — unless the runner names one (an Issue comment it read) — the answer.
 */
export const StopReport = StopRecord.omit({ work: true, at: true, answer: true }).extend({ id: z.string().min(1).max(100), answer: z.string().max(300).regex(COMMENT_URL).optional().catch(undefined) });
export type StopReport = z.infer<typeof StopReport>;

/** The Issue a stage Task is for (its `stage` column, #1139); null for any other task. */
export const issueOf = (task: Pick<Task, "workspaceId" | "stage">): number | null => (task.workspaceId ? task.stage?.issue ?? null : null);

export const stopWork = (task: Task): StopRecord["work"] => ({ workspaceId: task.workspaceId, issue: issueOf(task), taskId: task.id });

/** Every stop of the task's work: of all the stage Tasks of its Issue when it has one (another Task on the same Issue stops the same work), else its own. */
export function stopRecordsFor(db: Db, task: Task): StopRecord[] {
  const issue = issueOf(task);
  return db.listStopRecords(issue !== null ? db.stageTaskIds(task.workspaceId!, issue) : [task.id]);
}

/** The newest record of each stop of `records` still open (waiting / retrying) — the ones an answer or 中断 moves. */
export function openStops(records: StopRecord[]): StopRecord[] {
  const latest = new Map<string, StopRecord>();
  for (const r of records) latest.set(r.id, r);
  return [...latest.values()].filter((r) => r.state === "waiting" || r.state === "retrying");
}

const MAX_FENCE = 8_000;

/**
 * Reads one kind of fence (` ```<name> `) out of a runner's reply as it streams (#948, #1778): only a fence opened at the
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

/** The stop reports (#948): `switchboard-stop` fences checked against StopReport. */
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

/** The bounded retry (#949): two more tries of the same operation, 5 s then 30 s after the failure. Fixed, not a setting. */
export const RETRY_DELAYS_MS = [5_000, 30_000] as const;

export const lastAttempt = (s: Pick<StopRecord, "actions">) => Math.max(0, ...s.actions.map((a) => a.attempt));

/**
 * Whether the stop may be tried again by itself (#949), and which attempt that is. Only a passing failure (`transient`:
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

/**
 * What every runner start is told (#949): how to report a stop (task.note's `stop`, or a `switchboard-stop` fence), the
 * retry rule, not to write beyond the request (#1987), and the stops of its work still open with the retries left. The runner retries its own tools itself;
 * the daemon never runs its commands. Short: it goes before every start's prompt.
 */
export function stopRecoveryPrompt(open: StopSummary[]): string {
  const lines = [
    "[Switchboard: 止まったときの報告]",
    "作業が止まったら（使用上限・承認や回答の待ち・依存の待ち・一時障害など）、理由を報告してください。Workspace MCP の task.note が使えるなら引数 stop に、無ければ返答の中に次のフェンスで書きます（根拠は短く。秘密やコマンドの生の出力は書かない）:",
    "```switchboard-stop",
    '{"id":"<この停止の短い名前>","op":"<操作>","target":"<対象>","reason":"usage-limit|github-limit|transient|auth|permission|input|decision|depends|unknown","safety":"read-only|before-effect|unknown","evidence":"<根拠>","state":"waiting|retrying|exhausted|resolved","actions":[{"attempt":1,"what":"<したこと>","ok":null}]}',
    "```",
    `再実行してよいのは、一時障害（通信の切断・タイムアウト・HTTP 502/503/504）で、読み取り専用か何かする前に失敗したと確かめられる操作だけ。同じ操作を最大 ${RETRY_DELAYS_MS.length} 回（${RETRY_DELAYS_MS.map((d) => `${d / 1000} 秒後`).join("、")}）まで。再実行の前に state "retrying" と試行番号を報告し、承認はいつもどおり毎回受ける。成功したら "resolved"、使い切ったら "exhausted" を報告して止まる。認証・権限・入力のエラーや、何かしたか分からない操作は再実行しない。Workspace MCP の exec.run は自分で再試行するので、その失敗は再実行しない。`,
    "依頼の範囲外の書き込み（計画モードでの commit・push・マージ、聞かずに昇格、依頼に無い Issue を閉じる）はしない。要るなら判断待ちで聞く。",
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
