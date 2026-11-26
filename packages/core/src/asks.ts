import type { AnswerPolicy, Artifact, Ask, AskAnswerKind, AskQuestion, AskBlocker, AskResume, AskPolicy, ApprovalRuleMatch, BacklogItem, EventEnvelope, PendingApproval, PolicySubject, ProceedingQuestion, StopSummary, Task } from "@switchboard/protocol";
import { CONSENT_CHARS } from "./merge-consent.ts";
import { overWaits, personWait } from "@switchboard/protocol";
import { afterTime } from "../../../scripts/parallel-guard.ts";
import { ASK_HISTORY_MS, PROCEED_CONFIRMED } from "./backlog-comments.ts";
import { isAnswered, isUnblocked, priorityRank } from "./backlog-pick.ts";
import type { GhRunner } from "./backlog-gh.ts";
import type { GateRecord } from "./gate-records.ts";
import { matchPolicies, POLICY_DEFAULT_DAYS, subjectChanges } from "./policies.ts";
import { issueOf, NEEDS_PERSON, resumableDepends, spanText, WAIT_KEY } from "./stops.ts";
import { IN_FLIGHT, TURN_ENDED } from "./task-status.ts";
import { answerableWait, siblingWaitLabels, stopsMakingWait, WAIT_KEEP_CHOICE, WAIT_RETRYING_NEXT, WAIT_STOP_CHOICE, waitAnswerNext } from "./waits.ts";

/**
 * The questions waiting on the user, built from the records each time they are read — the
 * Issues' labels and comments, the PBIs' bodies, `stop.record` — never stored, as 判断待ち and the Backlog screen's 利用者確認 items read them.
 */

export { ASK_HISTORY_MS };

/**
 * The question, choices, recommendation, where it stopped (`**止めた場所**:`, with the first `PR #n` it names) and
 * the Task whose artifacts are its screen mockups (`**画面イメージ**:`, the first id in it) of a `## 判断待ち`
 * (`**問い**:`), in the form of issue-workflow's 「判断待ちの出し方」.
 * A choice's ` — 許可: <文>` is its grant, kept in the choice's text too (the reply sends the line as it is).
 * Lines not in that form are left; what is not there is null / empty.
 */
export function parseAskBlock(text: string): { question: string | null; choices: string[]; grants: Array<string | null>; recommendation: Ask["recommendation"]; place: Ask["place"]; mockupTask: string | null } {
  let question: string | null = null;
  let mockupTask: string | null = null;
  let recommendation: Ask["recommendation"] = null;
  let place: Ask["place"] = null;
  let inPlace = false;
  const choices: string[] = [];
  let inChoices = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const field = /^\*\*(問い|選択肢|推奨|止めた場所|画面イメージ)\*\*[:：]\s*(.*)$/.exec(line);
    if (field) {
      inChoices = field[1] === "選択肢";
      inPlace = field[1] === "止めた場所" && place === null;
      const value = field[2]!.trim();
      if (field[1] === "問い" && question === null && value) question = value;
      if (field[1] === "画面イメージ" && mockupTask === null && value) mockupTask = /[\w-]+/.exec(value)?.[0] ?? null;
      if (field[1] === "止めた場所" && place === null && value) place = { text: value, pr: Number(/PR #(\d+)/.exec(value)?.[1] ?? 0) || null, reasons: [], diff: /\+\d+\/-\d+/.exec(value)?.[0] ?? null };
      if (field[1] === "推奨" && value) {
        const cut = value.indexOf(" — ");
        recommendation = cut < 0 ? { choice: value, why: "" } : { choice: value.slice(0, cut).trim(), why: value.slice(cut + 3).trim() };
      }
      continue;
    }
    if (inPlace && place && /^[-*]?\s*\[(聞く|再チェック)/.test(line)) {
      place.reasons.push(line.replace(/^[-*]\s*/, ""));
      place.diff ??= /\+\d+\/-\d+/.exec(line)?.[0] ?? null;
      continue;
    }
    // a standalone diff summary (`+40/-3`, `（+40/-3）`) under 止めた場所 does not end the reasons below it
    if (inPlace && place && /^[-*]?\s*[（(]?\+\d+\/-\d+[)）]?$/.test(line)) {
      place.diff ??= /\+\d+\/-\d+/.exec(line)![0];
      continue;
    }
    if (inChoices && /^[-*] /.test(line)) choices.push(line.slice(2).trim());
    else if (line) inChoices = inPlace = false;
  }
  return { question, choices, grants: choices.map(grantOfChoice), recommendation, place, mockupTask };
}

/** The grant of a choice: what follows ` — 許可: ` in its line; null = none. */
export function grantOfChoice(choice: string): string | null {
  const m = / — 許可[:：]\s*(.+)$/.exec(choice);
  return m ? m[1]!.trim() : null;
}

/** The screen mockups of a Task, by its id. */
export type MockupsOf = (taskId: string) => Artifact[];

/** parseAskBlock's fields of the question, with the mockups of the Task it names in place of that Task's id. */
const askBlock = (text: string, mockupsOf: MockupsOf | undefined) => {
  const { mockupTask, ...rest } = parseAskBlock(text);
  return { ...rest, mockups: mockupTask && mockupsOf ? mockupsOf(mockupTask) : [] };
};

/**
 * What an answer does not take away: a PR / Issue still open, a stop condition not met in a series not resolved
 * (`ci: failure` — the daemon does not judge CI itself), and the runner's refusal (permission / auth) when no tool approval
 * of the Task is waiting (an approval is answered; a refusal is not).
 */
export function blockersOf(input: { waits: BacklogItem["waits"]; stops: StopSummary[]; approvalPending: boolean }): AskBlocker[] {
  const out: AskBlocker[] = [];
  for (const w of input.waits)
    if (w.open !== false) out.push({ kind: "depends", detail: w.open === null ? `${w.kind === "pr" ? "PR" : "Issue"} #${w.number} の状態が未取得` : w.kind === "pr" ? `PR #${w.number} が未マージ` : `Issue #${w.number} が未完了` });
  for (const s of input.stops) {
    if (s.state === "resolved") continue;
    for (const c of s.conditions) if (!c.met) out.push({ kind: "condition", detail: `${c.key}: ${c.value}` });
    // a permission stop with a grant is answered by sending the grant
    if ((s.reason === "permission" || s.reason === "auth") && !input.approvalPending && !(s.reason === "permission" && s.grant))
      out.push({ kind: "runner", detail: `${s.op} ${s.target}: ${s.evidence}（ランナー側の拒否。回答では解除されません）`.replace(/ {2,}/g, " ") });
  }
  return out;
}

/** Why an answer on an item on hold does not go on by itself. */
export const ON_HOLD_RESUME = "保留中（on-hold を外すと次の定期実行で再開）";

/**
 * How an Issue's answer goes on: through the stage Task created after it — running, or failed when it ended in error
 * (done = the work went on: null, resolved). Before one is: a start that failed after the answer, else queued with what still
 * stands in the way, else queued for the next firing (on hold: until the label comes off). null = not answered.
 */
export function resumeOfIssue(input: {
  answeredAt: number | null;
  /** The stage Task the answer itself started (server/asks.ts keeps its id): its resume even when it was created before `answeredAt` (GitHub's comment time, later than the start). */
  startedTaskId?: string | null;
  stageTasks: Array<{ id: string; status: Task["status"]; createdAt: number; updatedAt: number }>;
  failure: { at: number; reason: string } | null;
  blockers: AskBlocker[];
  onHold?: boolean;
}): AskResume | null {
  const { answeredAt, failure, blockers } = input;
  if (answeredAt === null) return null;
  const t = input.stageTasks.filter((x) => x.createdAt >= answeredAt || x.id === input.startedTaskId).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (t) {
    if (IN_FLIGHT.has(t.status)) return { state: "running", reason: null, taskId: t.id, at: t.createdAt };
    if (t.status === "error" || t.status === "aborted") return { state: "failed", reason: `工程 Task が ${t.status}`, taskId: t.id, at: t.updatedAt };
    return null;
  }
  if (failure && failure.at >= answeredAt) return { state: "failed", reason: failure.reason, taskId: null, at: failure.at };
  if (blockers.length) return { state: "queued", reason: blockers.map((b) => b.detail).join("・"), taskId: null, at: answeredAt };
  return { state: "queued", reason: input.onHold ? ON_HOLD_RESUME : "次の定期実行で再開", taskId: null, at: answeredAt };
}

/**
 * How a Task goes on after the person's reply: the reply is its record and its resume, so it is the Task's state —
 * waiting for the usage limit or for a run slot, running, failed (in error, or a send that failed after the reply). null = no reply, or it
 * went on and stopped again by itself (idle / done: resolved).
 */
export function resumeOfTask(input: { task: Task; repliedAt: number | null; failure: { at: number; reason: string } | null }): AskResume | null {
  const { task: t, repliedAt, failure } = input;
  if (repliedAt === null) return null;
  if (failure && failure.at >= repliedAt) return { state: "failed", reason: failure.reason, taskId: t.id, at: failure.at };
  if (t.resumeAt !== null) return { state: "queued", reason: `使用上限の解除待ち（${new Date(t.resumeAt).toISOString()}）`, taskId: t.id, at: t.updatedAt };
  if (t.queuedAt !== null) return { state: "queued", reason: "実行枠待ち", taskId: t.id, at: t.queuedAt };
  if (IN_FLIGHT.has(t.status)) return { state: "running", reason: null, taskId: t.id, at: repliedAt };
  if (t.status === "error" || t.status === "aborted") return { state: "failed", reason: `Task が ${t.status}`, taskId: t.id, at: t.updatedAt };
  return null;
}

/**
 * The kinds of answer a question takes on screen. Only an open or held one is answered; an automatic one takes
 * none, and neither does a check or a stop with something an answer does not take away (a reply would set the Task going).
 * A check with a question tool's questions takes their answers together when any of them has options; one whose
 * questions all lack options, or with neither choices nor questions, takes none on the card — it is answered from the
 * Task's own send box.
 */
export function answersOf(a: Pick<Ask, "kind" | "needs" | "state" | "choices" | "questions" | "blockers" | "grant" | "proceeding">): AskAnswerKind[] {
  if (a.state !== "open" && a.state !== "held") return [];
  if ((a.kind === "check" || a.kind === "stop") && a.blockers.length) return [];
  const choice: AskAnswerKind[] = a.choices.length ? ["choice"] : [];
  switch (a.kind) {
    case "approval":
      return ["allow", "deny"];
    case "decision":
      // one the work went on from waits for nothing: confirmed as it is (`confirm`) or overturned by another answer, never put on hold
      return a.proceeding ? ["confirm", ...choice, "text"] : [...choice, "text", "hold"];
    case "check":
      // questions none of which has options take no answer on the card either: the send box answers them
      return a.questions.some((q) => q.options.length) ? ["questions"] : a.questions.length ? [] : a.choices.length ? ["choice", "text"] : [];
    case "confirmation":
      return ["confirm"];
    case "stop":
      return a.needs === "person" ? (a.grant ? ["grant", "text"] : ["text"]) : [];
    case "wait":
      // a wait past its limit that has the two answers (止める / 待ち続ける); a PBI's wait for PRs / Issues has no choices
      return a.needs === "person" ? choice : [];
    default:
      return [];
  }
}

/**
 * The one reply that answers a question tool's questions: a line per question, `- <question>: <labels joined by
 * ", ">[ — 許可: <文>] | <free text>`. null = the answers do not fit the questions as they are now (a different count, an option no
 * longer offered, more than one option of a single-choice question, a question left unanswered).
 */
export function questionsReply(questions: AskQuestion[], answers: Array<{ choices: string[]; text?: string }>): string | null {
  if (!questions.length || answers.length !== questions.length) return null;
  const lines: string[] = [];
  for (const [i, q] of questions.entries()) {
    const a = answers[i]!;
    if (q.options.length) {
      const labels = new Set(q.options.map((o) => o.label));
      if (!a.choices.length || (!q.multiSelect && a.choices.length > 1) || a.choices.some((c) => !labels.has(c)) || a.text) return null;
      // a chosen option's ` — 許可: <文>` goes at the end of the line, as the person's say on it
      const grants = a.choices.flatMap((c) => grantOfChoice(q.options.find((o) => o.label === c)?.description ?? "") ?? []);
      lines.push(`- ${q.question}: ${a.choices.join(", ")}${grants.map((g) => ` — 許可: ${g}`).join("")}`);
    } else {
      const text = a.text?.trim();
      if (!text || a.choices.length) return null;
      lines.push(`- ${q.question}: ${text}`);
    }
  }
  return lines.join("\n");
}

/**
 * What the person chose of a question tool's questions, apart from the questions the Task wrote, in two forms:
 * - `said`: for each question, `- ` and the chosen labels with their ` — 許可: <文>` (or the free text, which keeps its own
 *   lines; one starting with `>` begins on a line of its own), as the person's words for the reader. No question's line is in it.
 * - `readerSaid` / `readerAsked`: for the reader of the person's own words, each answer (the text of `said`, a label's line breaks flattened)
 *   paired with its question by number (`- 2: はい` answers `質問 2: …`), as the same label can answer two questions. The questions are the Task's words; only
 *   the answers are the person's.
 * - `parts`: the texts read by letters for a fixed sentence, each a message of its own: the chosen options' grants (one
 *   sentence each, as a structure and not mixed into a text), then the free answers of the submission together as one message.
 *   A label is not one.
 * - `questionsText`: the questions as written, whole: the numbers a reader may name are taken from it (the reader's
 *   `readerAsked` is cut).
 * null = the same as `questionsReply`.
 */
export function questionsChosen(questions: AskQuestion[], answers: Array<{ choices: string[]; text?: string }>): { said: string; readerSaid: string; readerAsked: string; parts: string[]; questionsText: string } | null {
  if (questionsReply(questions, answers) === null) return null;
  // what the Task wrote (a question, a label) is one line for the reader: a line break would let a part of it pass for
  // another numbered line. The person's free text keeps its lines everywhere: a quoted line stays quoted, and a fixed
  // sentence on its own line still ends its line.
  const flat = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();
  // the reader's prompt cuts what is long. Only what the Task wrote is shortened here: every question keeps a share of
  // the prompt's room for the reply (its start and its end, where a number is usually named), so no answer loses its
  // question. The person's text is never shortened here; the prompt has its own limit for it and says when it cut.
  const room = Math.max(40, Math.floor(CONSENT_CHARS.asked / 2 / questions.length));
  const cut = (text: string) => (text.length > room ? `${text.slice(0, Math.ceil(room / 2))}…${text.slice(-Math.floor(room / 2))}` : text);
  const parts = questions.map((q, i) => {
    const a = answers[i]!;
    // a free text whose first line is quoted starts on a line of its own, so the answer's prefix does not hide the quote
    if (!q.options.length) return { said: a.text!.trim(), reader: a.text!.trim(), sep: /^>/.test(a.text!.trim()) ? "\n" : " " };
    const grants = a.choices.flatMap((c) => grantOfChoice(q.options.find((o) => o.label === c)?.description ?? "") ?? []).map((g) => ` — 許可: ${g}`).join("");
    return { said: `${a.choices.join(", ")}${grants}`, reader: `${flat(a.choices.join(", "))}${grants}`, sep: " " };
  });
  return {
    // the chosen options' sentences, one each; the free answers of the one submission together as one message (a word among
    // them that is no fixed sentence keeps every sentence among them from being read by letters)
    parts: [
      ...questions.flatMap((q, i) => (q.options.length ? answers[i]!.choices.flatMap((c) => grantOfChoice(q.options.find((o) => o.label === c)?.description ?? "") ?? []) : [])),
      ...(questions.some((q) => !q.options.length) ? [questions.flatMap((q, i) => (q.options.length ? [] : [answers[i]!.text!.trim()])).join("\n")] : []),
    ],
    questionsText: questions.map((q) => q.question).join("\n"),
    said: parts.map((p) => `-${p.sep}${p.said}`).join("\n"),
    readerSaid: parts.map((p, i) => `- ${i + 1}:${p.sep}${p.reader}`).join("\n"),
    readerAsked: questions.map((q, i) => `質問 ${i + 1}: ${cut(flat(q.question))}`).join("\n"),
  };
}

/**
 * What changed on the PR a question stopped at since it was asked, read from GitHub once (its head, state and commits) and from
 * the app's merge verdicts of it (gate jobs): the head is not the one the newest verdict before the question that asked the
 * person judged, new commits after the question when there is no such verdict, or the PR is no longer open. Empty = nothing
 * changed. Throws when gh fails: nothing is known, so nothing is answered.
 */
export interface PrFacts {
  /** The PR's head now, and the kinds the newest verdict of that head asked about (`ask` then `recheck`, comma-separated; null when it asked nothing). */
  head: string;
  mergeAsk: string | null;
  /** A verdict of the app judged the head now. false: what the question asks about is not known, so no policy answers it. */
  judged: boolean;
  changes: string[];
}

/**
 * How long a read of a PR from GitHub is waited for when an answer or a grant depends on it (`prFacts`, the head of a
 * grant): past it the read counts as not made. The `gh` process is not killed; only the wait ends.
 */
export const GH_READ_TIMEOUT_MS = 8_000;

export async function prFacts(gh: GhRunner, cwd: string, repo: string, pr: number, askedAt: number, gates: readonly GateRecord[], timeoutMs = GH_READ_TIMEOUT_MS): Promise<PrFacts> {
  // an answer waits for this read: one that does not end is given up, and the answer is refused with nothing written
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`gh pr view ${pr}: ${timeoutMs / 1000} 秒で応答がありません`)), timeoutMs)));
  const r = await Promise.race([gh(["pr", "view", String(pr), "-R", repo, "--json", "state,headRefOid,commits"], cwd), late]).finally(() => clearTimeout(timer));
  if (r.code !== 0) throw new Error(`gh pr view ${pr}: ${(r.stderr.trim() || `exit ${r.code}`).slice(0, 200)}`);
  const v = JSON.parse(r.stdout) as { state: string; headRefOid: string; commits: Array<{ committedDate: string }> };
  // a reply without a head says nothing of what the PR is now: not known, as a failed read
  if (typeof v.headRefOid !== "string" || !/^[0-9a-f]{40}$/i.test(v.headRefOid)) throw new Error(`gh pr view ${pr}: head がありません`);
  const changes: string[] = [];
  const head = v.headRefOid.toLowerCase();
  // the newest verdict before the question that stopped on a kind (to ask or to recheck): the head the question was about
  const sha = gates.filter((g) => g.startedAt <= askedAt && (g.ask.length > 0 || g.recheck.length > 0)).at(-1)?.head ?? null;
  if (sha && sha !== head) changes.push(`PR #${pr} の差分が変わりました（${sha.slice(0, 7)} → ${v.headRefOid.slice(0, 7)}）`);
  else if (!sha && v.commits.some((c) => Date.parse(c.committedDate) > askedAt)) changes.push(`PR #${pr} に問いの後のコミットがあります`);
  if (v.state !== "OPEN") changes.push(`PR #${pr} は ${v.state} です`);
  const onHead = gates.filter((g) => g.head === head).at(-1);
  const kinds = onHead ? [...onHead.ask, ...onHead.recheck] : [];
  return { head: v.headRefOid, mergeAsk: kinds.length ? kinds.join(",") : null, judged: onHead !== undefined, changes };
}

export async function prChanges(gh: GhRunner, cwd: string, repo: string, pr: number, askedAt: number, gates: readonly GateRecord[]): Promise<string[]> {
  return (await prFacts(gh, cwd, repo, pr, askedAt, gates)).changes;
}

/** A start that failed after an answer: kept by the daemon (nothing records it), by the question's id. */
export type ResumeFailures = (askId: string) => { at: number; reason: string } | null;

/**
 * What the policies need that the questions do not carry. `approval` = a tool approval's subject and the Knowledge
 * `confirm` rule that fires on it; `confirm` = the same for a stop record's `<op> <target>` read as a command. Without it
 * no question has a subject and none can be saved as a policy.
 */
export interface PolicyEnv {
  policies: AnswerPolicy[];
  pbiOpen: (number: number) => boolean;
  approval: (a: PendingApproval) => { subject: PolicySubject | null; confirmHit: ApprovalRuleMatch | null };
  confirm: (workspaceId: string | null, command: string) => ApprovalRuleMatch | null;
}

/** The newest stop series before the question that took a person's say (decision / permission / input), as a subject. */
function stopSubject(stops: StopSummary[], at: number, kind: PolicySubject["kind"]): PolicySubject | null {
  const s = stops.filter((x) => (x.reason === "decision" || x.reason === "permission" || x.reason === "input") && x.firstAt <= at).sort((a, b) => b.firstAt - a.firstAt)[0];
  return s ? { kind, op: s.op, target: s.target, conditions: s.conditions.map((c) => ({ key: c.key, value: c.value })), head: null } : null;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The PBI a question belongs to for a policy's range: its own, or the Issue its stage Task works on. */
export const policyPbi = (a: Pick<Ask, "pbi" | "task">): number | null => a.pbi?.number ?? a.task?.stageIssue ?? null;


const GRANT_NOTE = "許可文は 1 回きりで、方針には保存しません";

/** What the screen shows about policies for one question. */
export function policyOf(ask: Ask, input: { policies: AnswerPolicy[]; confirmHit: ApprovalRuleMatch | null; pbiOpen: boolean; now: number }): AskPolicy {
  const { subject } = ask;
  const pbi = policyPbi(ask);
  const refused = ask.blockers.some((b) => b.kind === "runner");
  // a grant allows one operation once: saved as a policy it would allow the same again
  const granted = ask.grant !== null || ask.grants.some((g) => g !== null);
  const [scopes, note]: [AskPolicy["scopes"], string | null] =
    // a check is made of a question tool's questions only: a plain card, answered once and never a policy (so is a wait past its limit: each answer is that time's);
    // one the work went on from is looked at by the person afterwards, never answered by a saved policy
    ask.answers.length === 0 || refused || ask.kind === "check" || ask.kind === "wait" || ask.proceeding
      ? [[], refused ? "ランナー側の拒否は保存した方針では解除できません" : null]
      : granted
        ? [[], GRANT_NOTE]
        : // a stage Task's stop is answered by a reply in its conversation: never a policy
        ask.kind === "stop" && ask.issue !== null
        ? [[], null]
        : input.confirmHit
        ? [[], `都度確認のルール ${input.confirmHit.source}: ${input.confirmHit.pattern} に当たります`]
        : !subject
          ? [["once"], "操作と対象が記録されていないため、今回のみ"]
          : [pbi !== null ? ["once", "pbi", "repo"] : ["once", "repo"], null];
  // the question a policy answered is the one the use names, or the one it was answered as (a decision's id names the answer's time)
  const usedFor = (u: AnswerPolicy["uses"][number]) => u.askId === ask.id || u.answered === ask.id;
  const applied = input.policies.find((p) => p.uses.some(usedFor)) ?? null;
  let previous: AskPolicy["previous"] = null;
  if (subject && (ask.state === "open" || ask.state === "held")) {
    const m = matchPolicies(input.policies, { id: ask.id, subject, workspaceId: ask.workspace?.id ?? null, pbi, pbiOpen: input.pbiOpen, choices: ask.choices }, input.now);
    const last = m.hit ? undefined : [...m.misses].sort((a, b) => b.policy.updatedAt - a.policy.updatedAt)[0];
    if (last) previous = { id: last.policy.id, answer: last.policy.answer, at: last.policy.updatedAt, why: last.why, changes: subjectChanges(last.policy.uses[0]?.subject ?? last.policy.from, subject) };
  }
  return {
    scopes,
    note,
    defaults: scopes.length && subject ? { target: subject.target, when: subject.conditions, expiresAt: input.now + POLICY_DEFAULT_DAYS * DAY_MS } : null,
    applied: applied ? { id: applied.id, scope: applied.scope, at: applied.uses.find(usedFor)!.at, summary: `${applied.scope} / ${applied.op} ${applied.target} / 期限 ${applied.expiresAt === null ? "なし" : day(applied.expiresAt)}` } : null,
    previous,
  };
}

const withPolicy = (a: Ask, subject: PolicySubject | null, confirmHit: ApprovalRuleMatch | null, env: PolicyEnv, now: number): Ask => {
  const withSubject = { ...a, subject };
  return { ...withSubject, policy: policyOf(withSubject, { policies: env.policies, confirmHit, pbiOpen: policyPbi(withSubject) !== null && env.pbiOpen(policyPbi(withSubject)!), now }) };
};

/** The answer fields of a built question: what it takes, and nothing in the way or going on yet. */
const noPolicy: AskPolicy = { scopes: [], note: null, defaults: null, applied: null, previous: null };
export const unanswered = { questions: [] as AskQuestion[], grants: [] as Array<string | null>, grant: null, answers: [] as AskAnswerKind[], mockups: [] as Artifact[], place: null, blockers: [] as AskBlocker[], resume: null, subject: null, policy: noPolicy, unblocks: [] as Ask["unblocks"], waiting: [] as Ask["waiting"], priority: null, lastReply: null, stall: null };
/** Fills `answers` once the rest is known. */
const withAnswers = (a: Ask): Ask => ({ ...a, answers: answersOf(a) });

const issueUrl = (i: BacklogItem, n: number) => i.url.replace(/\d+$/, String(n));

/** The fields every question of a backlog item shares. */
const base = (i: BacklogItem): Pick<Ask, "workspace" | "pbi" | "issue" | "task" | "choices" | "questions" | "grants" | "grant" | "recommendation" | "conditions" | "answers" | "mockups" | "place" | "blockers" | "resume" | "subject" | "policy" | "unblocks" | "waiting" | "priority" | "lastReply" | "stall"> => ({
  ...unanswered,
  workspace: { id: i.workspaceId, name: i.workspaceName },
  pbi: { number: i.number, title: i.title, url: i.url },
  issue: { number: i.number, url: i.url },
  task: null,
  choices: [],
  recommendation: null,
  conditions: [],
});

/** A stop series as a question (the series' `next`): decide = a person answers, wait / retry = it goes on by itself, resume = answered, none = resolved. */
/** The date an open `depends` stop waits for (its `after` condition), for the reason: "（期日 <日時> まで）". */
const dueOf = (s: StopSummary): string => {
  const due = s.reason === "depends" && s.state !== "resolved" ? s.conditions.find((c) => c.key === "after" && !c.met) : undefined;
  return due ? `（期日 ${due.value} まで）` : "";
};

/** The longest last reply an open stop carries (the Claude adapter's summary limit). */
export const LAST_REPLY_MAX = 2000;

/** A Task's last reply as shown on its stop: null when blank, cut to LAST_REPLY_MAX characters (then `…`). */
export function lastReplyOf(text: string | null): string | null {
  if (text === null || text.trim() === "") return null;
  return text.length > LAST_REPLY_MAX ? `${text.slice(0, LAST_REPLY_MAX)}…` : text;
}

/** An id up to its time (its last `@`): the same question asked again keeps this part. The whole id when it has no `@`. */
export const askIdBase = (id: string): string => (id.lastIndexOf("@") < 0 ? id : id.slice(0, id.lastIndexOf("@")));

/** A stop's question: its series, and the time the newest stop took its present op + reason + grant — reported again with another grant, it is another question, and no earlier answer is its answer. */
export const stopAskId = (s: Pick<StopSummary, "key" | "contentAt">): string => `stop:${s.key.replaceAll("\u0000", "|")}@${s.contentAt}`;

/** A `depends` stop the app does not resume asks the person: its question is the stop's, so a wait past its limit makes none of its own. */
export const asksPersonOnStop = (s: Pick<StopSummary, "reason" | "state" | "conditions">): boolean => s.reason === "depends" && s.state === "waiting" && !resumableDepends(s);

function stopAsk(s: StopSummary, shared: Omit<Ask, "id" | "kind" | "needs" | "state" | "at" | "changedAt" | "reason" | "question" | "next" | "source" | "route" | "conditions" | "task" | "lastReply">, next: string | null, outcome: Task["outcome"] | null, lastReply?: (taskId: string) => string | null): Ask {
  // a first stop has no earlier one to show the answer as a change (`next` stays decide): its `answered` says the person's reply came after it
  const answered = s.lastAnswer !== null && (s.next === "resume" || (s.next === "decide" && s.answered));
  // a stop that asks (`next` decide) is a question for the person while the stopping Task's outcome (written from its stop
  // records) is needs_action — or failed: a turn cut or stopped with the stop still asking goes on by nothing but the
  // person — and over once it is finished (a later turn ended with nothing to do); a stop that waits by
  // itself stays auto, whatever the Task's outcome. A `depends` stop the app does not resume asks the person too.
  const asks = s.next === "decide" || asksPersonOnStop(s);
  const [needs, state]: [Ask["needs"], Ask["state"]] =
    s.next === "none" ? [NEEDS_PERSON.has(s.reason) || s.lastAnswer ? "person" : "auto", "resolved"] : answered ? ["person", "answered"] : asks && (outcome === "needs_action" || outcome === "failed") ? ["person", "open"] : asks && outcome === "finished" ? ["auto", "resolved"] : ["auto", "open"];
  return {
    ...shared,
    id: stopAskId(s),
    kind: "stop",
    needs,
    state,
    at: s.firstAt,
    changedAt: answered ? s.lastAnswer!.at : state === "open" ? s.firstAt : s.lastAt,
    task: { id: s.work.taskId, title: null },
    reason: `${s.reason}: ${s.evidence}${dueOf(s)}`,
    question: null,
    grant: NEEDS_PERSON.has(s.reason) ? s.grant : null,
    next,
    source: { label: "停止記録", url: null, taskId: s.work.taskId },
    route: "task",
    conditions: s.conditions,
    lastReply: needs === "person" && state === "open" ? lastReplyOf(lastReply?.(s.work.taskId) ?? null) : null,
  };
}

/**
 * The questions of the backlog's items: their ## 判断待ち (held once a `## 保留` came after it), the criteria waiting on the
 * user's check, their waits and their stage Tasks' stops — each with what stands in the way of the item, and an
 * answered one with how it goes on. `approvalPending`: a tool approval of the item's stage Task is waiting.
 */
export function asksFromBacklog(items: BacklogItem[], now: number, opts: { resumeFailures?: ResumeFailures; approvalPending?: (i: BacklogItem) => boolean; policy?: PolicyEnv; mockups?: MockupsOf; startedBy?: (workspaceId: string, pbi: number) => string | null; lastReply?: (taskId: string) => string | null; taskOf?: (id: string) => Task | null } = {}): Ask[] {
  const asks: Ask[] = [];
  for (const i of items) {
    const blockers = blockersOf({ waits: i.waits, stops: i.stopSummary, approvalPending: opts.approvalPending?.(i) ?? false });
    const shared = { ...base(i), blockers };
    const resume = (id: string, answeredAt: number | null) =>
      resumeOfIssue({ answeredAt, startedTaskId: opts.startedBy?.(i.workspaceId, i.number) ?? null, stageTasks: i.lastTask ? [i.lastTask] : [], failure: opts.resumeFailures?.(id) ?? null, blockers, onHold: i.onHold });
    const from = asks.length;
    if (i.stage === "needs-decision") {
      const d = i.decision;
      const at = d ? Date.parse(d.at) : Date.parse(i.updatedAt);
      const on = d?.issue ?? i.number;
      asks.push({
        ...shared,
        ...(d ? askBlock(d.body, opts.mockups) : { question: null }),
        id: `decision:${i.workspaceId}#${on}@${d?.at ?? ""}`,
        kind: "decision",
        needs: "person",
        state: i.heldAt ? "held" : "open",
        at,
        changedAt: i.heldAt ? Date.parse(i.heldAt) : at,
        issue: { number: on, url: issueUrl(i, on) },
        reason: "実装の判断",
        next: `#${i.number} の続きの工程 Task`,
        source: { label: `#${on} の ## 判断待ち`, url: issueUrl(i, on), taskId: null },
        route: "backlog",
      });
    } else if (i.stage === "in-progress" && i.answeredAt) {
      const answeredAt = Date.parse(i.answeredAt);
      const id = `decision:${i.workspaceId}#${i.number}@${i.answeredAt}`;
      // a stage Task created after the answer is its resume: answered while it runs or once it failed, resolved once done.
      // Before one is, a stage Task that ended after the answer (it was running when it came) went on past it too
      // the one the answer itself started is after it too, even when GitHub's comment time is later than its start
      const after = !!i.lastTask && (i.lastTask.createdAt >= answeredAt || i.lastTask.id === opts.startedBy?.(i.workspaceId, i.number));
      // no stage Task ever (one that could not start): answered, not gone on yet
      const waiting = isAnswered(i) || !i.lastTask;
      const r = after || waiting ? resume(id, answeredAt) : null;
      const resolved = after ? r === null : !waiting && i.lastTask!.updatedAt >= answeredAt;
      if (waiting || after || resolved)
        asks.push({
          ...shared,
          resume: resolved ? null : r,
          id,
          kind: "decision",
          needs: "person",
          state: resolved ? "resolved" : "answered",
          at: answeredAt,
          changedAt: answeredAt,
          reason: "実装の判断",
          question: null,
          next: `#${i.number} の続きの工程 Task`,
          source: { label: `#${i.number} の ## 回答`, url: i.url, taskId: null },
          route: "backlog",
        });
    }
    for (const c of i.confirmations) {
      // before its 期日 the line is not asked; the very time is past, as `afterTime` readers count it
      if (c.after && afterTime(c.after) > now) continue;
      const at = Date.parse(i.updatedAt);
      asks.push({
        ...shared,
        id: `confirm:${i.workspaceId}#${i.number}:${c.n}`,
        kind: "confirmation",
        needs: "person",
        state: "open",
        at,
        changedAt: at,
        reason: "受け入れ条件の利用者確認",
        question: c.text,
        next: `PBI #${i.number} の受け入れ条件 ${c.n} のチェック`,
        source: { label: `#${i.number} の受け入れ条件 ${c.n}`, url: i.url, taskId: null },
        route: "backlog",
      });
    }
    // all closed and not resumed yet stays open (every condition met): once an 実装 starts, the server empties the waits,
    // so a wait that went on is not in the records to be told resolved
    // not read is not closed: it holds the PBI as an open one does
    const open = i.waits.filter((w) => w.open !== false);
    // nothing automatic reads it again (GitHub answered not found / forbidden): a person looks and starts 実装
    const unread = i.waits.some((w) => w.open === null);
    if (i.waitsAt && (open.length > 0 || isUnblocked(i))) {
      const at = Date.parse(i.waitsAt);
      asks.push({
        ...shared,
        id: `wait:${i.workspaceId}#${i.number}@${i.waitsAt}`,
        kind: "wait",
        needs: unread ? "person" : "auto",
        state: "open",
        at,
        changedAt: at,
        reason: open.length > 0 ? `${open.map((w) => `${w.kind === "pr" ? "PR" : "Issue"} #${w.number}${w.open === null ? "（未取得）" : ""}`).join(" / ")} の完了待ち` : "待っていた PR / Issue が閉じた。再開を待っている",
        question: null,
        // a Ready row's button starts 実装; an in-progress row's is 状況を確認, which does not resume it
        next: unread ? `未取得の相手を確かめて ${i.stage === "ready" ? `#${i.number} の「実装する」` : `/pbi-complete ${i.number} を手で始める`}` : `#${i.number} の /pbi-complete の再開`,
        source: { label: `#${i.number} の /pbi-complete の release`, url: i.url, taskId: null },
        route: unread ? "backlog" : "none",
        conditions: i.waits.map((w) => ({ key: `${w.kind}#${w.number}`, value: w.open === null ? "unknown" : w.open ? "open" : "closed", met: w.open === false })),
      });
    }
    for (const s of i.stopSummary) {
      const outcome = (opts.taskOf?.(s.work.taskId) ?? (i.lastTask?.id === s.work.taskId ? i.lastTask : null))?.outcome ?? null;
      // an earlier stage Task that failed is not what holds the Issue: a later stage Task took the work over, so its stop does not ask the person again
      const superseded = !!i.lastTask && i.lastTask.id !== s.work.taskId;
      const a = stopAsk(s, shared, `#${i.number} の工程 Task が続く`, superseded && outcome === "failed" ? null : outcome, opts.lastReply);
      // the person's reply went to the stage Task itself (a stop's answer is a reply in its conversation): it goes on as that Task does
      const task = a.task ? (opts.taskOf?.(a.task.id) ?? null) : null;
      // a failure of a reply to an earlier stop of the series is not this stop's
      const failed = ((f) => (f && f.at >= s.lastAt ? f : null))(opts.resumeFailures?.(a.id) ?? null);
      if (a.state === "answered") asks.push({ ...a, resume: task ? resumeOfTask({ task, repliedAt: s.lastAnswer!.at, failure: failed }) : resume(a.id, s.lastAnswer!.at) });
      // a reply the Task refused (its budget) left the stop open; its failure stays visible
      else asks.push(a.state === "open" && failed && task ? { ...a, resume: { state: "failed", reason: failed.reason, taskId: task.id, at: failed.at } } : a);
    }
    for (let k = from; k < asks.length; k++) asks[k] = withAnswers(asks[k]!);
    const env = opts.policy;
    if (env)
      for (let k = from; k < asks.length; k++) {
        const a = asks[k]!;
        // a stop question is one series itself; the others take the work's newest series before them
        const subject = a.kind === "decision" || a.kind === "check" || a.kind === "stop" ? stopSubject(i.stopSummary, a.at, a.kind === "check" ? "check" : "decision") : null;
        asks[k] = withPolicy(a, subject, subject ? env.confirm(a.workspace?.id ?? null, `${subject.op} ${subject.target}`) : null, env, now);
      }
  }
  return asks.filter(isShown(now));
}

/** Open and held ones always; answered / resolved ones for ASK_HISTORY_MS after their change. */
const isShown = (now: number) => (a: Ask) => a.state === "open" || a.state === "held" || now - a.changedAt <= ASK_HISTORY_MS;

/** Why a question the work went on from is over without an answer: its PBI closed with the recommendation standing. */
export const PROCEED_SETTLED = "推奨で確定した";

/**
 * The questions the work went on from with their recommendation (`proceedingOf`), as decisions marked `proceeding`:
 * nothing waits on them (`needs` auto), so they are never among the person's open questions. Open while the PBI is and
 * no `## 回答` came — the person confirms it, or overturns it with another answer; answered once one came; resolved
 * (`PROCEED_SETTLED`) once the PBI closed without one.
 */
export function proceedingAsks(list: ProceedingQuestion[], now: number, opts: { mockups?: MockupsOf } = {}): Ask[] {
  return list
    .map((q): Ask => {
      const at = Date.parse(q.at);
      const confirmed = !!q.answer && q.answer.body.split("\n").some((l) => l.trim().startsWith(PROCEED_CONFIRMED));
      // the table did not let the work go on from it: the person's to answer, never among the ones confirmed in one press
      const stopped = q.stopped ?? null;
      const [state, changedAt, reason]: [Ask["state"], number, string] = q.answer
        ? ["answered", Date.parse(q.answer.at), stopped ? "実装の判断（回答済み）" : confirmed ? "実装の判断（推奨のままで確定）" : "実装の判断（推奨を覆した）"]
        : q.pbi.open
          ? ["open", at, stopped ? `実装の判断（止めて聞く）: 問いは「推奨で進める」と書いているが、${stopped}。進めてよいかは戻せるかの表（ops-kit/reversibility.json）が決める` : "実装の判断（推奨で進行中）"]
          : ["resolved", q.closedAt ? Date.parse(q.closedAt) : at, stopped ? "PBI が閉じた（回答なし）" : PROCEED_SETTLED];
      return withAnswers({
        ...unanswered,
        ...askBlock(q.body, opts.mockups),
        id: `proceed:${q.workspaceId}#${q.issue.number}@${q.at}`,
        kind: "decision",
        needs: stopped ? "person" : "auto",
        state,
        at,
        changedAt,
        workspace: { id: q.workspaceId, name: q.workspaceName },
        pbi: { number: q.pbi.number, title: q.pbi.title, url: q.pbi.url },
        issue: q.issue,
        task: null,
        reason,
        next: stopped ? `回答すると、その答えで #${q.pbi.number} の工程 Task が進む` : `答えなくても #${q.pbi.number} は推奨の案で進む。違う答えにすると、その答えで直す工程 Task が始まる`,
        source: { label: `#${q.issue.number} の ## 判断待ち`, url: q.issue.url, taskId: null },
        route: "backlog",
        conditions: [],
        ...(stopped ? {} : { proceeding: true }),
      });
    })
    .filter(isShown(now));
}

/** What `withGone` reads of the records: whether a stored Issue / PR ended, and when a newer stage Task of the same Issue finished. */
export interface GoneFacts {
  endOf: (workspaceId: string, n: number) => { kind: "issue" | "pr"; state: "CLOSED" | "MERGED"; at: number | null } | null;
  /** When a stage Task of Issue `issue` created after Task `taskId` ended as done; null = none did. */
  newerStageDone: (workspaceId: string, issue: number, taskId: string) => number | null;
  /** When job `id` ended; null = it still runs, or there is none. */
  jobEnded: (id: number) => number | null;
  /** When a later run of the same schedule as Task `taskId` ended as done; null = none did, or the Task is not a schedule's (or is a stage Task). */
  laterRunDone: (taskId: string) => number | null;
}

/**
 * The person's open questions whose target is gone are over, with no answer: the Issue asked on (or the stage Task's)
 * is closed, the PR it stopped at (`place.pr`, a stop's unmet `pr#<n>` condition) is merged or closed, or a newer stage
 * Task of the same Issue finished. A question for a wait past its limit (`Ask.wait`) is over when what it waits for is:
 * the stage Task's Issue closed, the PR / Issue of its key (`pr#<n>` / `issue#<n>`) ended, the job of its key (`job#<n>`)
 * ended, or a later run of the same schedule finished — a key of any other form is not read. Resolved with what went as the reason, shown for ASK_HISTORY_MS after it went (when
 * that is not recorded, after the question's own last change). A tool approval is never one: the runner waits on it.
 * Only the question is taken off the list — what holds the item (a label, a reply waited for) is the Backlog's to show.
 */
/** The waits whose other side can end without the Task: those of a Task that is not at work. A turn's own wait (a command, the runner's output, a run slot, the person) is not over because an Issue closed or a later run finished. */
const ENDED_WAITS: ReadonlySet<string> = new Set(["depends", "job", "date", "stop", "resume"]);
export function withGone(asks: Ask[], facts: GoneFacts, now: number): Ask[] {
  // a wait's job and the later runs of its schedule are the daemon's own records: read for a Task with no workspace too
  const ownEnd = (a: Ask, job: number | undefined) => {
    if (a.kind !== "wait") return null;
    const ended = job === undefined ? null : facts.jobEnded(job);
    if (ended !== null) return { why: `job#${job} が終わった`, at: ended };
    const later = a.task ? facts.laterRunDone(a.task.id) : null;
    return later === null ? null : { why: "同じ定期実行の後の回が終わった", at: later };
  };
  const gone = (a: Ask): { why: string; at: number | null } | null => {
    const ws = a.workspace?.id;
    // the wait's key, when it is one whose end is recorded: [, "pr" | "issue" | "job", n]
    const key = a.kind === "wait" ? WAIT_KEY.exec(a.wait?.key ?? "") : null;
    const named = (kind: string) => (key?.[1] === kind ? Number(key[2]) : undefined);
    if (!ws) return ownEnd(a, named("job"));
    const issues = [...new Set([a.issue?.number, stageIssue(a)].filter((n): n is number => typeof n === "number"))];
    for (const n of [...issues, named("issue")]) {
      const e = n === undefined ? null : facts.endOf(ws, n);
      if (e?.kind === "issue") return { why: `#${n} が閉じた`, at: e.at };
    }
    const prs = [a.place?.pr, named("pr"), ...a.conditions.flatMap((c) => (!c.met && /^pr#\d+$/.test(c.key) ? [Number(c.key.slice(3))] : []))].filter((n): n is number => typeof n === "number");
    for (const n of prs) {
      const e = facts.endOf(ws, n);
      if (e?.kind === "pr") return { why: `PR #${n} が${e.state === "MERGED" ? "マージされた" : "閉じた"}`, at: e.at };
    }
    if (a.kind !== "wait" && a.task && issues.length) {
      for (const n of issues) {
        const at = facts.newerStageDone(ws, n, a.task.id);
        if (at !== null) return { why: `#${n} のより新しい工程 Task が終わった`, at };
      }
    }
    return ownEnd(a, named("job"));
  };
  return asks
    .map((a) => {
      if ((a.state !== "open" && a.state !== "held") || a.needs !== "person" || !(a.kind === "decision" || a.kind === "check" || a.kind === "stop" || a.kind === "confirmation" || (a.kind === "wait" && a.wait !== undefined && ENDED_WAITS.has(a.wait.kind)))) return a;
      const g = gone(a);
      return g ? { ...a, state: "resolved" as const, changedAt: g.at ?? a.changedAt, reason: `${g.why}（対象が無くなった）`, answers: [], resume: null, lastReply: null } : a;
    })
    .filter(isShown(now));
}

export interface TaskAskInput {
  approvals: PendingApproval[];
  /** The Tasks changed within ASK_HISTORY_MS, and the live ones. */
  tasks: Task[];
  /** The question tool's questions of the Task's last turn and the seq of the `session.end` that ended it and the ts of its last `question.ask` (`askedAt`, null = none) (`Db.lastTurnQuestions`); null = it never ended a turn. */
  lastTurnQuestions: (taskId: string) => { questions: AskQuestion[]; seq: number; askedAt: number | null } | null;
  /** The permission.ask / permission.resolved events of these Tasks, oldest first. */
  permissionEvents: (taskIds: string[]) => EventEnvelope[];
  stops: (task: Task) => StopSummary[];
  workspaceName: (id: string) => string | null;
  now: number;
  /** A send that failed after the person's answer, by the question's id. */
  resumeFailures?: ResumeFailures;
  /** The saved answer policies (a past answer applied again). */
  policy?: PolicyEnv;
  /** The screen mockups of a Task, for the options that have one. */
  mockups?: MockupsOf;
  /** A Task's last reply (the newest `session.end`'s summary); null = it never ended a turn. */
  lastReply?: (taskId: string) => string | null;
}

/**
 * The questions of the Tasks: tool approvals (open, and answered by the person within the day), an operational check
 * a stopped Task left (outcome needs_action, not reviewed — never read from free text otherwise), a wait for the usage
 * limit (`resumeAt`), and the stops of Tasks with no Issue (a stage Task's stops are its Issue's, asksFromBacklog's).
 */
export function asksFromTasks(input: TaskAskInput): Ask[] {
  const { tasks, now } = input;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blockers = new Map<string, AskBlocker[]>();
  const blockersOfTask = (t: Task | undefined, taskId: string) => {
    if (!blockers.has(taskId)) blockers.set(taskId, t ? blockersOf({ waits: [], stops: input.stops(t), approvalPending: input.approvals.some((a) => a.taskId === taskId) }) : []);
    return blockers.get(taskId)!;
  };
  const shared = (t: Task | undefined, taskId: string, title: string) => ({
    ...unanswered,
    blockers: blockersOfTask(t, taskId),
    workspace: t?.workspaceId ? { id: t.workspaceId, name: input.workspaceName(t.workspaceId) ?? t.workspaceId } : null,
    pbi: null,
    issue: null,
    task: { id: taskId, title, stageIssue: t?.stage?.issue ?? null },
    choices: [],
    recommendation: null,
    conditions: [],
  });
  const asks: Ask[] = [];
  const pendings = new Map(input.approvals.map((a) => [`approval:${a.taskId}:${a.id}`, a]));
  for (const a of input.approvals) {
    asks.push({
      ...shared(byId.get(a.taskId), a.taskId, a.taskTitle),
      id: `approval:${a.taskId}:${a.id}`,
      kind: "approval",
      needs: "person",
      state: "open",
      at: a.askedAt,
      changedAt: a.askedAt,
      reason: `ツールの実行に承認が要る: ${a.tool}`,
      question: a.detail,
      next: `Task「${a.taskTitle}」がそのまま続く`,
      source: { label: "Task の会話", url: null, taskId: a.taskId },
      route: "approval",
    });
  }
  const asked = new Map<string, EventEnvelope>();
  for (const e of input.permissionEvents(tasks.map((t) => t.id))) {
    if (e.ev.t === "permission.ask") asked.set(`${e.taskId}:${e.ev.id}`, e);
    if (e.ev.t !== "permission.resolved" || e.ev.by !== "user" || now - e.ts > ASK_HISTORY_MS) continue;
    const t = byId.get(e.taskId);
    const ask = asked.get(`${e.taskId}:${e.ev.id}`);
    if (!t || !ask || ask.ev.t !== "permission.ask") continue;
    const resolved = TURN_ENDED.has(t.status) && t.updatedAt >= e.ts;
    const id = `approval:${t.id}:${e.ev.id}`;
    asks.push({
      ...shared(t, t.id, t.title),
      resume: resolved ? null : resumeOfTask({ task: t, repliedAt: e.ts, failure: input.resumeFailures?.(id) ?? null }),
      id,
      kind: "approval",
      needs: "person",
      state: resolved ? "resolved" : "answered",
      at: ask.ts,
      changedAt: resolved ? t.updatedAt : e.ts,
      reason: `ツールの実行に承認が要る: ${ask.ev.tool}`,
      question: ask.ev.detail,
      next: `Task「${t.title}」がそのまま続く`,
      source: { label: "Task の会話", url: null, taskId: t.id },
      route: "task",
    });
  }
  for (const t of tasks) {
    // a stage Task's check is gone once another stage Task of its Issue started after it stopped: the work went on past it
    const n = issueOf(t);
    const superseded = n !== null && tasks.some((o) => o.id !== t.id && o.workspaceId === t.workspaceId && issueOf(o) === n && o.createdAt > t.updatedAt);
    const turn = input.lastTurnQuestions(t.id);
    if (!superseded && personWait(t) === "needs") {
      // the check is the question tool's questions, and only those: what the reply's text says makes none
      if (turn?.questions.length) {
        const { questions } = turn;
        const checkId = `check:${t.id}:${turn.seq}`;
        const failed = input.resumeFailures?.(checkId) ?? null;
        asks.push({
          ...shared(t, t.id, t.title),
          question: questions[0]!.question,
          questions,
          // nothing is read from the question's text: no place, and the recommended option is seen by its label's ` (Recommended)`
          // nothing stands in its way either: a Task that stopped to ask is answered, a stop from before the question neither hides the check nor takes the options away
          blockers: [],
          // the screen mockups are the asking Task's own artifacts
          mockups: input.mockups?.(t.id).filter((a) => a.title.startsWith("画面イメージ")) ?? [],
          id: checkId,
          // a reply the Task refused (its budget) left the check open; its failure stays visible
          resume: failed ? { state: "failed", reason: failed.reason, taskId: t.id, at: failed.at } : null,
          kind: "check",
          needs: "person",
          state: "open",
          at: t.updatedAt,
          changedAt: t.updatedAt,
          reason: "質問",
          next: `Task「${t.title}」の続き`,
          source: { label: "Task の質問ツールの問い", url: null, taskId: t.id },
          route: "task",
        });
      }
    }
    if (t.resumeAt !== null) {
      const limit = t.resumeAt > now;
      asks.push({
        ...shared(t, t.id, t.title),
        id: `resume:${t.id}@${t.resumeAt}`,
        kind: "stop",
        needs: "auto",
        state: "open",
        at: t.updatedAt,
        changedAt: t.updatedAt,
        reason: limit ? "usage-limit: 使用上限の解除待ち" : "transient: 中断からの自動再開待ち",
        question: null,
        next: `Task「${t.title}」の自動再開`,
        source: { label: "Task の会話", url: null, taskId: t.id },
        route: "task",
        conditions: [{ key: "resumeAt", value: new Date(t.resumeAt).toISOString(), met: !limit }],
      });
    }
    // a wait past its limit, or a runner silent past its: nothing ends it by itself any more, so it is the person's to look at
    for (const w of overWaits(t, now)) {
      // a hook wait past its limit is 応答なし at the wait watch's next look: it is asked as that, not as a wait over its limit
      if (w.kind === "hook") continue;
      const silent = w.kind === "output";
      // a wait that comes from a stop of a Task whose turn is over is answered here; any other is the Task's own to end
      const answered = answerableWait(t, w);
      // the stops that make the wait: one the person is asked about as a stop is not asked again as a wait, and one retrying goes on by itself
      const makers = answered ? stopsMakingWait(input.stops(t), w.key) : [];
      if (makers.length && makers.every(asksPersonOnStop)) continue;
      const retrying = makers.length > 0 && makers.every((s) => s.state === "retrying");
      const spans =`${spanText(now - w.since)}（上限 ${spanText(w.until - w.since)}）`;
      asks.push({
        ...shared(t, t.id, t.title),
        blockers: [],
        id: `waitover:${t.id}:${w.key}@${w.until}`,
        kind: "wait",
        needs: "person",
        state: "open",
        at: w.until,
        changedAt: w.until,
        reason: silent ? `応答なし: ${w.label}が ${spans} 無い` : `待ちが上限を過ぎた: ${w.label} を ${spans} 待っている`,
        question: null,
        choices: answered ? (retrying ? [WAIT_STOP_CHOICE] : [WAIT_STOP_CHOICE, WAIT_KEEP_CHOICE]) : [],
        next: silent ? "Task を開いて様子を見る（固まっていれば中断して、返信で再開する）" : answered ? (retrying ? WAIT_RETRYING_NEXT : waitAnswerNext(siblingWaitLabels(makers, w.key))) : "Task を開いて、待ち続けるか・相手を進めるか・止めるかを決める",
        source: { label: "待ちの記録", url: null, taskId: t.id },
        route: "task",
        wait: { kind: w.kind, key: w.key },
      });
    }
    if (issueOf(t) === null)
      for (const s of input.stops(t)) {
        const a = stopAsk(s, shared(t, t.id, t.title), `Task「${t.title}」が続く`, t.outcome, input.lastReply);
        // an answered stop goes on as its Task does (running, the usage limit, failed), as the answer itself says
        asks.push({ ...a, task: { id: t.id, title: t.title, stageIssue: t.stage?.issue ?? null }, ...(a.state === "answered" ? { resume: resumeOfTask({ task: t, repliedAt: s.lastAnswer!.at, failure: input.resumeFailures?.(a.id) ?? null }) } : {}) });
      }
  }
  const env = input.policy;
  const policed = (a: Ask): Ask => {
    if (!env) return a;
    if (a.kind === "approval") {
      const p = pendings.get(a.id);
      const { subject, confirmHit } = p ? env.approval(p) : { subject: null, confirmHit: null };
      return withPolicy(a, subject, confirmHit, env, now);
    }
    const t = a.task ? byId.get(a.task.id) : undefined;
    // a check (a question tool's questions) has no subject: no policy is saved from it or applied to it
    const subject = t && a.kind === "stop" ? stopSubject(input.stops(t), a.at, "decision") : null;
    return withPolicy(a, subject, subject ? env.confirm(a.workspace?.id ?? null, `${subject.op} ${subject.target}`) : null, env, now);
  };
  return asks.map((a) => policed(withAnswers(a))).filter(isShown(now));
}

/** The reason code a stop question was built with (`<reason>: <evidence>`). */
export const stopReasonOf = (a: Ask) => (a.kind === "stop" ? (a.reason?.split(":")[0] ?? null) : null);

const GROUP: Record<string, number> = { "person/open": 0, "auto/open": 1 };
// a held one is still the person's to answer
const groupOf = (a: Ask) => (a.state === "open" ? GROUP[`${a.needs}/open`]! : a.state === "held" ? 0 : a.state === "answered" ? 2 : 3);

/** Which of a Task's open questions is kept when they ask the same thing: lower first. */
const RANK: Partial<Record<Ask["kind"], number>> = { check: 1, stop: 2 };

/**
 * The fold of a Task's open question: the person's (an approval, a check, a stop a person has to answer) are one, and
 * the automatic ones (the wait for the usage limit and its stop) are one. null = not folded.
 */
function foldKey(a: Ask): string | null {
  if (a.state !== "open" || !a.task) return null;
  const code = stopReasonOf(a);
  if (a.needs === "person" && (a.kind === "approval" || a.kind === "check" || (code !== null && NEEDS_PERSON.has(code as StopSummary["reason"])))) return `person:${a.task.id}`;
  if (a.needs === "auto" && code === "usage-limit") return `auto:${a.task.id}`;
  return null;
}

/** The Issue a stage Task works on (`Task.stage`). */
const stageIssue = (a: Ask) => a.task?.stageIssue ?? null;

/**
 * One question once: the same id is kept once (the newest change); a Task's open questions that ask the same are one
 * (a person's: approval > check > stop, each approval kept; automatic: the wait for the usage limit over its stop), the
 * kept one taking the others' conditions (its own reason stays); and a
 * stage Task's decision stop or check is folded into the ## 判断待ち of its Issue — the answer is written there — while it
 * is open, and once it is answered if it was asked before the answer.
 * Ordered: a person's open ones, automatic ones, answered, resolved; newest first in each.
 */
export function dedupeAsks(asks: Ask[]): Ask[] {
  const byId = new Map<string, Ask>();
  for (const a of asks) {
    const had = byId.get(a.id);
    if (!had || a.changedAt > had.changedAt) byId.set(a.id, a);
  }
  const conditions = (keep: Ask, drop: Ask) => [...keep.conditions, ...drop.conditions.filter((c) => !keep.conditions.some((k) => k.key === c.key))];
  // a permission stop's grant stays answerable on the check it folds into (an approval is answered by itself)
  const merged = (keep: Ask, drop: Ask): Ask =>
    keep.kind !== "approval" && keep.grant === null && drop.grant !== null && drop.answers.includes("grant")
      ? { ...keep, conditions: conditions(keep, drop), grant: drop.grant, answers: ["grant", ...keep.answers], policy: { ...keep.policy, scopes: [], note: GRANT_NOTE, defaults: null } }
      : { ...keep, conditions: conditions(keep, drop) };
  const folded = new Map<string, Ask>();
  const rest: Ask[] = [];
  for (const a of byId.values()) {
    const key = foldKey(a);
    if (key === null || a.kind === "approval") rest.push(a);
    else {
      const had = folded.get(key);
      const better = !had || (RANK[a.kind] ?? 9) < (RANK[had.kind] ?? 9) || (a.kind === had.kind && a.id.startsWith("resume:"));
      folded.set(key, !had ? a : better ? merged(a, had) : merged(had, a));
    }
  }
  // each approval is answered on its own, so approvals stay apart; what else the Task asks folds into its newest one
  const approvals = new Map<string, Ask>();
  for (const a of rest) if (a.kind === "approval" && a.state === "open" && (approvals.get(foldKey(a)!)?.at ?? -1) < a.at) approvals.set(foldKey(a)!, a);
  for (const [key, a] of folded) {
    const approval = approvals.get(key);
    if (!approval) continue;
    rest[rest.indexOf(approval)] = merged(approval, a);
    folded.delete(key);
  }
  const unique = [...rest, ...folded.values()];
  // an Issue's decision → up to when a stage Task's question is that one: an open one takes all, an answered one those
  // asked before the answer (one asked after it is a new question)
  const decided = new Map<string, number>();
  // one the work went on from waits for no answer: a stage Task's question is not that one
  for (const a of unique.filter((x) => x.kind === "decision" && x.state !== "resolved" && !x.proceeding))
    for (const x of [a.issue, a.pbi]) if (x) decided.set(`${a.workspace?.id}#${x.number}`, Math.max(decided.get(`${a.workspace?.id}#${x.number}`) ?? 0, a.state === "answered" ? a.changedAt : Infinity));
  const onDecided = (a: Ask) => {
    if (a.state !== "open") return false;
    const n = a.kind === "check" ? stageIssue(a) : stopReasonOf(a) === "decision" ? (a.issue?.number ?? stageIssue(a)) : null;
    return n !== null && a.at <= (decided.get(`${a.workspace?.id}#${n}`) ?? -1);
  };
  return unique.filter((a) => !onDecided(a)).sort((a, b) => groupOf(a) - groupOf(b) || b.at - a.at);
}

/** The numbers a question is about: its PBI, the Issue it is asked on, and its stage Task's Issue. */
const askNumbers = (a: Ask) => new Set([a.pbi?.number, a.issue?.number, stageIssue(a)].filter((n): n is number => typeof n === "number"));

/**
 * The questions with what waits on them: the other PBIs of the same Workspace whose unmet prerequisite or wait names the
 * question's numbers (directly; Issues and PRs share numbers, so only the number is compared). They are `unblocks` when
 * the answer closes the question's PBI — the confirmation line `pbiProgress` names (`progress.closesOnAnswer`), the only
 * answer that meets a prerequisite — and `waiting` otherwise: they wait for the PBI to be done, not for this answer.
 * `priority` = the Priority of the question's item. The person's questions (open, or held) are ordered by how many an
 * answer lets go on (`unblocks`; `waiting` is not counted), then Priority (P0 first, unset last), then newest; the other
 * groups keep `dedupeAsks`' order.
 */
export function rankAsks(asks: Ask[], items: BacklogItem[]): Ask[] {
  const none: Ask["unblocks"] = [];
  const ranked = asks.map((a) => {
    const ns = askNumbers(a);
    const ws = a.workspace?.id;
    const list = items
      .filter((i) => i.type === "pbi" && i.workspaceId === ws && !ns.has(i.number) && [...i.waits, ...i.prereqs].some((w) => w.state !== "met" && ns.has(w.number)))
      .sort((x, y) => x.number - y.number)
      .map((i) => ({ number: i.number, title: i.title, url: i.url }));
    const own = [...ns].map((n) => items.find((i) => i.workspaceId === ws && i.number === n)).find((i) => i !== undefined);
    const pbi = a.pbi ? items.find((i) => i.workspaceId === ws && i.number === a.pbi!.number) : undefined;
    const line = a.kind === "confirmation" ? Number(/:(\d+)$/.exec(a.id)?.[1]) : NaN;
    const closes = !!pbi && pbi.progress.closesOnAnswer === line;
    return { ...a, unblocks: closes ? list : none, waiting: closes ? none : list, priority: own?.priority ?? null };
  });
  const person = ranked.filter((a) => groupOf(a) === 0).sort((a, b) => b.unblocks.length - a.unblocks.length || priorityRank(a.priority) - priorityRank(b.priority) || b.at - a.at);
  return [...person, ...ranked.filter((a) => groupOf(a) !== 0)];
}
