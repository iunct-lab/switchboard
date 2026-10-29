import type { AnswerPolicy, Artifact, Ask, AskAnswerKind, AskBlocker, AskResume, AskPolicy, ApprovalRuleMatch, BacklogItem, EventEnvelope, PendingApproval, PolicySubject, ScheduleResult, StopSummary, Task } from "@switchboard/protocol";
import { MERGE_ASK } from "../../../scripts/merge-gate.ts";
import { isAnswered, isUnblocked, priorityRank, type GhRunner } from "./backlog.ts";
import { matchPolicies, POLICY_DEFAULT_DAYS, subjectChanges } from "./policies.ts";
import { issueOf, NEEDS_PERSON } from "./stops.ts";

/**
 * The questions waiting on the user (#935), built from the records each time they are read — the
 * Issues' labels and comments, the PBIs' bodies, `stop.record` — never stored, as #266 and #523 read them.
 */

/** How long an answered / resolved question stays on the list after its state changed. */
export const ASK_HISTORY_MS = 24 * 60 * 60 * 1000;

/**
 * The question, choices, recommendation, where it stopped (`**止めた場所**:`, with the first `PR #n` it names; #936) and
 * the Task whose artifacts are its screen mockups (`**画面イメージ**:`, the first id in it; #2221) of a `## 判断待ち`
 * (`**問い**:`) or an operational check (`**確認**:`), in the form of issue-workflow's 「判断待ちの出し方」.
 * A choice's ` — 許可: <文>` is its grant (#2745), kept in the choice's text too (the reply sends the line as it is).
 * Lines not in that form are left; what is not there is null / empty.
 */
export function parseAskBlock(text: string): { question: string | null; choices: string[]; grants: Array<string | null>; recommendation: Ask["recommendation"]; place: Ask["place"]; mockupTask: string | null } {
  let question: string | null = null;
  let mockupTask: string | null = null;
  let recommendation: Ask["recommendation"] = null;
  let place: Ask["place"] = null;
  const choices: string[] = [];
  let inChoices = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const field = /^\*\*(問い|確認|選択肢|推奨|止めた場所|画面イメージ)\*\*[:：]\s*(.*)$/.exec(line);
    if (field) {
      inChoices = field[1] === "選択肢";
      const value = field[2]!.trim();
      if ((field[1] === "問い" || field[1] === "確認") && question === null && value) question = value;
      if (field[1] === "画面イメージ" && mockupTask === null && value) mockupTask = /[\w-]+/.exec(value)?.[0] ?? null;
      if (field[1] === "止めた場所" && place === null && value) place = { text: value, pr: Number(/PR #(\d+)/.exec(value)?.[1] ?? 0) || null };
      if (field[1] === "推奨" && value) {
        const cut = value.indexOf(" — ");
        recommendation = cut < 0 ? { choice: value, why: "" } : { choice: value.slice(0, cut).trim(), why: value.slice(cut + 3).trim() };
      }
      continue;
    }
    if (inChoices && /^[-*] /.test(line)) choices.push(line.slice(2).trim());
    else if (line) inChoices = false;
  }
  return { question, choices, grants: choices.map(grantOfChoice), recommendation, place, mockupTask };
}

/** The grant of a choice (#2745): what follows ` — 許可: ` in its line; null = none. */
export function grantOfChoice(choice: string): string | null {
  const m = / — 許可[:：]\s*(.+)$/.exec(choice);
  return m ? m[1]!.trim() : null;
}

/** The screen mockups of a Task, by its id (#2221). */
export type MockupsOf = (taskId: string) => Artifact[];

/** parseAskBlock's fields of the question, with the mockups of the Task it names in place of that Task's id. */
const askBlock = (text: string, mockupsOf: MockupsOf | undefined) => {
  const { mockupTask, ...rest } = parseAskBlock(text);
  return { ...rest, mockups: mockupTask && mockupsOf ? mockupsOf(mockupTask) : [] };
};

/**
 * What an answer does not take away (#936): a PR / Issue still open, a stop condition not met in a series not resolved
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
    // a permission stop with a grant is answered by sending the grant (#2745)
    if ((s.reason === "permission" || s.reason === "auth") && !input.approvalPending && !(s.reason === "permission" && s.grant))
      out.push({ kind: "runner", detail: `${s.op} ${s.target}: ${s.evidence}（ランナー側の拒否。回答では解除されません）`.replace(/ {2,}/g, " ") });
  }
  return out;
}

/**
 * How an Issue's answer goes on (#936): through the stage Task created after it — running, or failed when it ended in error
 * (done = the work went on: null, resolved). Before one is: a start that failed after the answer, else queued with what still
 * stands in the way, else queued for the next firing. null = not answered.
 */
export function resumeOfIssue(input: {
  answeredAt: number | null;
  stageTasks: Array<{ id: string; status: Task["status"]; createdAt: number; updatedAt: number }>;
  failure: { at: number; reason: string } | null;
  blockers: AskBlocker[];
}): AskResume | null {
  const { answeredAt, failure, blockers } = input;
  if (answeredAt === null) return null;
  const t = input.stageTasks.filter((x) => x.createdAt >= answeredAt).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (t) {
    if (t.status === "running" || t.status === "waiting") return { state: "running", reason: null, taskId: t.id, at: t.createdAt };
    if (t.status === "error" || t.status === "aborted") return { state: "failed", reason: `工程 Task が ${t.status}`, taskId: t.id, at: t.updatedAt };
    return null;
  }
  if (failure && failure.at >= answeredAt) return { state: "failed", reason: failure.reason, taskId: null, at: failure.at };
  if (blockers.length) return { state: "queued", reason: blockers.map((b) => b.detail).join("・"), taskId: null, at: answeredAt };
  return { state: "queued", reason: "次の定期実行で再開", taskId: null, at: answeredAt };
}

/**
 * How a Task goes on after the person's reply (#936): the reply is its record and its resume, so it is the Task's state —
 * waiting for the usage limit, running, failed (in error, or a send that failed after the reply). null = no reply, or it
 * went on and stopped again by itself (idle / done: resolved).
 */
export function resumeOfTask(input: { task: Task; repliedAt: number | null; failure: { at: number; reason: string } | null }): AskResume | null {
  const { task: t, repliedAt, failure } = input;
  if (repliedAt === null) return null;
  if (failure && failure.at >= repliedAt) return { state: "failed", reason: failure.reason, taskId: t.id, at: failure.at };
  if (t.resumeAt !== null) return { state: "queued", reason: `使用上限の解除待ち（${new Date(t.resumeAt).toISOString()}）`, taskId: t.id, at: t.updatedAt };
  if (t.status === "running" || t.status === "waiting") return { state: "running", reason: null, taskId: t.id, at: repliedAt };
  if (t.status === "error" || t.status === "aborted") return { state: "failed", reason: `Task が ${t.status}`, taskId: t.id, at: t.updatedAt };
  return null;
}

/**
 * The kinds of answer a question takes on screen (#936). Only an open or held one is answered; an automatic one takes
 * none, and neither does a check or a stop with something an answer does not take away (a reply would set the Task going).
 */
export function answersOf(a: Pick<Ask, "kind" | "needs" | "state" | "choices" | "blockers" | "grant">): AskAnswerKind[] {
  if (a.state !== "open" && a.state !== "held") return [];
  if ((a.kind === "check" || a.kind === "stop") && a.blockers.length) return [];
  const choice: AskAnswerKind[] = a.choices.length ? ["choice"] : [];
  switch (a.kind) {
    case "approval":
      return ["allow", "deny"];
    case "decision":
      return [...choice, "text", "hold"];
    case "check":
      return [...choice, "text"];
    case "confirmation":
      return ["confirm"];
    case "stop":
      return a.needs === "person" ? (a.grant ? ["grant", "text"] : ["text"]) : [];
    default:
      return [];
  }
}

/**
 * What changed on the PR a question stopped at since it was asked (#936), read from GitHub once: the head is not the one
 * the newest `[merge-ask]` before the question named (merge-gate's mark), new commits after the question when there is no
 * such mark, or the PR is no longer open. Empty = nothing changed. Throws when gh fails: nothing is known, so nothing is
 * answered.
 */
export interface PrFacts {
  /** The PR's head now, and the kinds of the newest `[merge-ask]` mark that named it (#938: a policy for a merge check is about this head). */
  head: string;
  mergeAsk: string | null;
  changes: string[];
}

export async function prFacts(gh: GhRunner, cwd: string, repo: string, pr: number, askedAt: number): Promise<PrFacts> {
  const r = await gh(["pr", "view", String(pr), "-R", repo, "--json", "state,headRefOid,comments,commits"], cwd);
  if (r.code !== 0) throw new Error(`gh pr view ${pr}: ${(r.stderr.trim() || `exit ${r.code}`).slice(0, 200)}`);
  const v = JSON.parse(r.stdout) as { state: string; headRefOid: string; comments: Array<{ body: string; createdAt: string }>; commits: Array<{ committedDate: string }> };
  const changes: string[] = [];
  const mark = v.comments.filter((c) => Date.parse(c.createdAt) <= askedAt && MERGE_ASK.test(c.body.trim())).at(-1);
  const sha = mark ? MERGE_ASK.exec(mark.body.trim())![2]! : null;
  if (sha && sha !== v.headRefOid) changes.push(`PR #${pr} の差分が変わりました（${sha.slice(0, 7)} → ${v.headRefOid.slice(0, 7)}）`);
  else if (!sha && v.commits.some((c) => Date.parse(c.committedDate) > askedAt)) changes.push(`PR #${pr} に問いの後のコミットがあります`);
  if (v.state !== "OPEN") changes.push(`PR #${pr} は ${v.state} です`);
  const onHead = v.comments.filter((c) => MERGE_ASK.exec(c.body.trim())?.[2] === v.headRefOid).at(-1);
  return { head: v.headRefOid, mergeAsk: onHead ? MERGE_ASK.exec(onHead.body.trim())![1]! : null, changes };
}

export async function prChanges(gh: GhRunner, cwd: string, repo: string, pr: number, askedAt: number): Promise<string[]> {
  return (await prFacts(gh, cwd, repo, pr, askedAt)).changes;
}

/** A start that failed after an answer (#936): kept by the daemon (nothing records it), by the question's id. */
export type ResumeFailures = (askId: string) => { at: number; reason: string } | null;

/**
 * What the policies need that the questions do not carry (#938). `approval` = a tool approval's subject and the Knowledge
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

/** What the screen shows about policies for one question (#938). */
export function policyOf(ask: Ask, input: { policies: AnswerPolicy[]; confirmHit: ApprovalRuleMatch | null; pbiOpen: boolean; now: number }): AskPolicy {
  const { subject } = ask;
  const pbi = policyPbi(ask);
  const refused = ask.blockers.some((b) => b.kind === "runner");
  // a grant allows one operation once (#2745): saved as a policy it would allow the same again
  const granted = ask.grant !== null || ask.grants.some((g) => g !== null);
  const [scopes, note]: [AskPolicy["scopes"], string | null] =
    ask.answers.length === 0 || refused
      ? [[], refused ? "ランナー側の拒否は保存した方針では解除できません" : null]
      : granted
        ? [[], GRANT_NOTE]
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
const unanswered = { grants: [] as Array<string | null>, grant: null, answers: [] as AskAnswerKind[], mockups: [] as Artifact[], place: null, blockers: [] as AskBlocker[], resume: null, subject: null, policy: noPolicy, unblocks: [] as Ask["unblocks"], priority: null };
/** Fills `answers` once the rest is known. */
const withAnswers = (a: Ask): Ask => ({ ...a, answers: answersOf(a) });

const issueUrl = (i: BacklogItem, n: number) => i.url.replace(/\d+$/, String(n));

/** The fields every question of a backlog item shares. */
const base = (i: BacklogItem): Pick<Ask, "workspace" | "pbi" | "issue" | "task" | "choices" | "grants" | "grant" | "recommendation" | "conditions" | "answers" | "mockups" | "place" | "blockers" | "resume" | "subject" | "policy" | "unblocks" | "priority"> => ({
  ...unanswered,
  workspace: { id: i.workspaceId, name: i.workspaceName },
  pbi: { number: i.number, title: i.title, url: i.url },
  issue: { number: i.number, url: i.url },
  task: null,
  choices: [],
  recommendation: null,
  conditions: [],
});

/** A stop series as a question (#939's `next`): decide = a person answers, wait / retry = it goes on by itself, resume = answered, none = resolved. */
function stopAsk(s: StopSummary, shared: Omit<Ask, "id" | "kind" | "needs" | "state" | "at" | "changedAt" | "reason" | "question" | "next" | "source" | "route" | "conditions" | "task">, next: string | null): Ask {
  const answered = s.next === "resume" && s.lastAnswer !== null;
  const [needs, state]: [Ask["needs"], Ask["state"]] =
    s.next === "decide" ? ["person", "open"] : s.next === "none" ? [NEEDS_PERSON.has(s.reason) || s.lastAnswer ? "person" : "auto", "resolved"] : answered ? ["person", "answered"] : ["auto", "open"];
  return {
    ...shared,
    id: `stop:${s.key.replaceAll("\u0000", "|")}`,
    kind: "stop",
    needs,
    state,
    at: s.firstAt,
    changedAt: answered ? s.lastAnswer!.at : state === "open" ? s.firstAt : s.lastAt,
    task: { id: s.work.taskId, title: null },
    reason: `${s.reason}: ${s.evidence}`,
    question: null,
    grant: s.reason === "permission" ? s.grant : null,
    next,
    source: { label: "停止記録", url: null, taskId: s.work.taskId },
    route: "task",
    conditions: s.conditions,
  };
}

/**
 * The questions of the backlog's items: their ## 判断待ち (held once a `## 保留` came after it), the criteria waiting on the
 * user's check, their waits and their stage Tasks' stops — each with what stands in the way of the item (#936), and an
 * answered one with how it goes on. `approvalPending`: a tool approval of the item's stage Task is waiting.
 */
export function asksFromBacklog(items: BacklogItem[], now: number, opts: { resumeFailures?: ResumeFailures; approvalPending?: (i: BacklogItem) => boolean; policy?: PolicyEnv; mockups?: MockupsOf } = {}): Ask[] {
  const asks: Ask[] = [];
  for (const i of items) {
    const blockers = blockersOf({ waits: i.waits, stops: i.stopSummary, approvalPending: opts.approvalPending?.(i) ?? false });
    const shared = { ...base(i), blockers };
    const resume = (id: string, answeredAt: number | null) =>
      resumeOfIssue({ answeredAt, stageTasks: i.lastTask ? [i.lastTask] : [], failure: opts.resumeFailures?.(id) ?? null, blockers });
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
      const after = !!i.lastTask && i.lastTask.createdAt >= answeredAt;
      // no stage Task ever (one that could not start, #936): answered, not gone on yet
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
    // not read (#1046) is not closed: it holds the PBI as an open one does
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
      const a = stopAsk(s, shared, `#${i.number} の工程 Task が続く`);
      asks.push(a.state === "answered" ? { ...a, resume: resume(a.id, s.lastAnswer!.at) } : a);
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

const ENDED = new Set<Task["status"]>(["done", "error", "aborted"]);

export interface TaskAskInput {
  approvals: PendingApproval[];
  /** The Tasks changed within ASK_HISTORY_MS, and the live ones. */
  tasks: Task[];
  /** The Task's last reply (the newest session.end's summary) and that event's seq. */
  lastReply: (taskId: string) => { text: string; seq: number } | null;
  /** The permission.ask / permission.resolved events of these Tasks, oldest first. */
  permissionEvents: (taskIds: string[]) => EventEnvelope[];
  stops: (task: Task) => StopSummary[];
  workspaceName: (id: string) => string | null;
  now: number;
  /** #936: a send that failed after the person's answer, by the question's id. */
  resumeFailures?: ResumeFailures;
  /** #938 */
  policy?: PolicyEnv;
  /** #2221 */
  mockups?: MockupsOf;
}

/**
 * The questions of the Tasks (#935): tool approvals (open, and answered by the person within the day), an operational check
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
    const resolved = ENDED.has(t.status) && t.updatedAt >= e.ts;
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
    if (t.outcome === "needs_action" && t.reviewedAt === null && t.status !== "running" && t.status !== "idle" && !superseded) {
      const reply = input.lastReply(t.id);
      const checkId = `check:${t.id}:${reply?.seq ?? ""}`;
      const failed = input.resumeFailures?.(checkId) ?? null;
      asks.push({
        ...shared(t, t.id, t.title),
        ...(reply ? askBlock(reply.text, input.mockups) : { question: null }),
        id: checkId,
        // a reply the Task refused (#936: its budget) left the check open; its failure stays visible
        resume: failed ? { state: "failed", reason: failed.reason, taskId: t.id, at: failed.at } : null,
        kind: "check",
        needs: "person",
        state: "open",
        at: t.updatedAt,
        changedAt: t.updatedAt,
        reason: "運用の確認",
        next: `Task「${t.title}」の続き`,
        source: { label: "Task の最後の返答", url: null, taskId: t.id },
        route: "task",
      });
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
    if (issueOf(t) === null)
      for (const s of input.stops(t)) asks.push({ ...stopAsk(s, shared(t, t.id, t.title), `Task「${t.title}」が続く`), task: { id: t.id, title: t.title, stageIssue: t.stage?.issue ?? null } });
  }
  // a question tool (AskUserQuestion) is answered with its questions' answers, on the Task's screen
  const env = input.policy;
  const policed = (a: Ask): Ask => {
    if (!env) return a;
    if (a.kind === "approval") {
      const p = pendings.get(a.id);
      const { subject, confirmHit } = p ? env.approval(p) : { subject: null, confirmHit: null };
      return withPolicy(a, subject, confirmHit, env, now);
    }
    const t = a.task ? byId.get(a.task.id) : undefined;
    const subject = t && (a.kind === "check" || a.kind === "stop") ? stopSubject(input.stops(t), a.at, a.kind === "check" ? "check" : "decision") : null;
    return withPolicy(a, subject, subject ? env.confirm(a.workspace?.id ?? null, `${subject.op} ${subject.target}`) : null, env, now);
  };
  return asks.map((a) => policed(a.kind === "approval" && a.reason?.endsWith(": AskUserQuestion") ? { ...a, route: "task" as const } : withAnswers(a))).filter(isShown(now));
}

/** The reason code a stop question was built with (`<reason>: <evidence>`). */
export const stopReasonOf = (a: Ask) => (a.kind === "stop" ? (a.reason?.split(":")[0] ?? null) : null);

const GROUP: Record<string, number> = { "person/open": 0, "auto/open": 1 };
// a held one is still the person's to answer
const groupOf = (a: Ask) => (a.state === "open" ? GROUP[`${a.needs}/open`]! : a.state === "held" ? 0 : a.state === "answered" ? 2 : 3);

/** Which of a Task's open questions is kept when they ask the same thing: lower first. */
const RANK: Partial<Record<Ask["kind"], number>> = { check: 1, stop: 2 };

/**
 * The fold of a Task's open question (#935): the person's (an approval, a check, a stop a person has to answer) are one, and
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
 * The daemon's notices (#2866) as of now, kept between reads under one setting, by what they are about (a workspace, a
 * schedule): the question's id and first sight, when it was first seen gone, and what the screen showed for it (a
 * resolved one is no longer in the input to read it from). A scan's notice keeps its hits' fingerprint, and the one
 * the person dismissed.
 */
export type NoticeRecord = Record<
  string,
  { id: string; at: number; resolvedAt: number | null; question: string; source: string; workspace: { id: string; name: string } | null; fingerprint?: string; dismissed?: string | null; /** The person closed it (dismiss): not shown, even as resolved. */ closed?: boolean }
>;

/** What a secret-scan result's notice is about: its hit lines (places and kinds, no values) and the repositories it could not check. */
/** `fingerprint` is the hits' only: what a dismiss closes (a repository that could not be checked is not a false positive). */
export function scanFindings(result: ScheduleResult | null): { hits: string[]; failed: string[]; fingerprint: string } {
  const lines = result?.lines ?? [];
  const hits = lines.filter((l) => l.startsWith("  ")).map((l) => l.trim());
  // anything but a repository's count line: a repository it could not check, or a firing that failed as a whole
  const failed = lines.filter((l) => !l.startsWith("  ") && !/: (0 件|当たり \d+ 件)（scanned \d+）$/.test(l));
  return { hits, failed, fingerprint: [...hits].sort().join("\n") };
}

/** The hits a dismiss closes (#2866): those closed before and the ones the notice shows now, one line each. */
export const closedHits = (r: NoticeRecord[string]): string =>
  [...new Set([...(r.dismissed ?? "").split("\n"), ...(r.fingerprint ?? "").split("\n")].filter(Boolean))].sort().join("\n");

const SCAN_NEXT = "内容の URL を開いて当たりが本物の値か見る。本物なら先にその値を無効にして（作り直して）からコメントを削除する（次の検査で当たりが無くなれば解消済み）。誤検知なら「誤検知として閉じる」";

/**
 * The daemon's notices as questions (#2866): built from the current state each time, never written as Inbox notes.
 * - a workspace a Task cannot use (`unusableWorkspaces`): open until it is fixed, then resolved with no answer
 * - a secret-scan schedule's last result with hits or a repository it could not check: open, answered by `dismiss`
 *   (a false positive) — the same hits do not come back, new ones do; resolved once a result is clean
 * - an approval-window schedule that fired, while SSO / deploy batches wait (`approvalWindowNote`): open with no answer
 *   (the batches are answered on their cards), resolved once none waits
 * A resolved one drops off a day later. Returns the record to keep (the same object when nothing changed).
 */
export function noticeAsks(
  input: {
    unusable: Array<{ workspace: { id: string; name: string }; why: string }>;
    /** `workspace` = the schedule's (meta), shown as where the notice belongs. */
    scans?: Array<{ schedule: { id: string; title: string }; workspace?: { id: string; name: string } | null; result: ScheduleResult | null }>;
    windows?: Array<{ schedule: { id: string; title: string }; workspace?: { id: string; name: string } | null; note: { title: string; body: string } | null }>;
    now: number;
  },
  record: NoticeRecord,
): { asks: Ask[]; record: NoticeRecord } {
  const { now } = input;
  const next: NoticeRecord = {};
  let changed = false;
  const asks: Ask[] = [];
  const notice = (r: NoticeRecord[string], reason: string | null, todo: string | null, answers: AskAnswerKind[]): Ask => ({
    ...unanswered,
    id: r.id,
    kind: "notice",
    needs: "person",
    state: r.resolvedAt === null ? "open" : "resolved",
    at: r.at,
    changedAt: r.resolvedAt ?? r.at,
    workspace: r.workspace,
    pbi: null,
    issue: null,
    task: null,
    reason,
    question: r.question,
    choices: [],
    recommendation: null,
    next: todo,
    source: { label: r.source, url: null, taskId: null },
    route: "none",
    conditions: [],
    answers: r.resolvedAt === null ? answers : [],
  });
  const same = (a: NoticeRecord[string] | undefined, b: NoticeRecord[string]) => !!a && JSON.stringify(a) === JSON.stringify(b);
  for (const u of input.unusable) {
    const key = `workspace:${u.workspace.id}`;
    const had = record[key];
    const open = had && had.resolvedAt === null;
    const r = { id: `notice:${key}`, at: open ? had.at : now, resolvedAt: null, question: `workspace ${u.workspace.name} を使えません`, source: "workspace の検査", workspace: u.workspace };
    if (!same(had, r)) changed = true;
    next[key] = r;
    // the reason's last sentence says how to fix it
    const cut = u.why.lastIndexOf("。", u.why.length - 2);
    asks.push(notice(r, cut < 0 ? u.why : u.why.slice(0, cut + 1), cut < 0 ? null : u.why.slice(cut + 1), []));
  }
  for (const scan of input.scans ?? []) {
    const key = `scan:${scan.schedule.id}`;
    const had = record[key];
    const f = scanFindings(scan.result);
    // each hit the person closed as a false positive stays closed; a failure is never closed (it resolves once a scan passes)
    const closedSet = new Set((had?.dismissed ?? "").split("\n").filter(Boolean));
    const hits = f.hits.filter((h) => !closedSet.has(h));
    const dismissed = f.hits.length > 0 && hits.length === 0;
    const fingerprint = [...hits].sort().join("\n");
    if (!hits.length && !f.failed.length) {
      if (dismissed) {
        // the closed hits are remembered; what was open (a failure next to them) is resolved now, shown for a day
        const r = had!.resolvedAt === null ? { ...had!, resolvedAt: now } : had!;
        if (r !== had) changed = true;
        next[key] = r;
        if (!r.closed && now - r.resolvedAt! <= ASK_HISTORY_MS) asks.push(notice(r, null, null, []));
      }
      continue; // clean (or never run): an open one is resolved below
    }
    const question = `認証の値の検査: 当たり ${hits.length} 件 / 検査できなかった ${f.failed.length} リポジトリ`;
    const open = had && had.resolvedAt === null && had.fingerprint === fingerprint && had.question === question;
    const at = open ? had.at : now;
    const r = {
      id: `notice:${key}@${at}`,
      at,
      resolvedAt: null,
      question,
      source: `予定「${scan.schedule.title}」`,
      workspace: scan.workspace ?? null,
      fingerprint,
      dismissed: had?.dismissed ?? null,
    };
    if (!same(had, r)) changed = true;
    next[key] = r;
    asks.push(notice(r, [...hits, ...f.failed].join("\n"), SCAN_NEXT, hits.length ? ["dismiss"] : []));
  }
  for (const w of input.windows ?? []) {
    if (!w.note) continue; // nothing waits: an open one is resolved below
    const key = `approval-window:${w.schedule.id}`;
    const had = record[key];
    const at = had && had.resolvedAt === null ? had.at : now;
    const r = { id: `notice:${key}@${at}`, at, resolvedAt: null, question: w.note.title, source: `予定「${w.schedule.title}」`, workspace: w.workspace ?? null };
    if (!same(had, r)) changed = true;
    next[key] = r;
    asks.push(notice(r, w.note.body, "判断待ちのまとまりのカードでログイン・承認する（待ちが無くなれば解消済み）", []));
  }
  for (const [key, had] of Object.entries(record)) {
    if (next[key]) continue;
    if (!had.id) {
      changed = true; // not a record this reads
      continue;
    }
    // a dismissed scan whose hits are gone has nothing left to show
    const shown = !had.closed;
    const r = had.resolvedAt === null ? { ...had, resolvedAt: now } : had;
    if (r !== had) changed = true;
    if (!shown || now - r.resolvedAt! > ASK_HISTORY_MS) {
      changed = true;
      continue;
    }
    next[key] = r;
    asks.push(notice(r, null, null, []));
  }
  return { asks, record: changed ? next : record };
}

/**
 * One question once (#935): the same id is kept once (the newest change); a Task's open questions that ask the same are one
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
  // a permission stop's grant (#2745) stays answerable on the check it folds into (an approval is answered by itself)
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
  for (const a of unique.filter((x) => x.kind === "decision" && x.state !== "resolved"))
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
 * The questions with what waits on them (#1674): `unblocks` = the other PBIs of the same Workspace whose unmet prerequisite
 * or wait names the question's numbers (directly; Issues and PRs share numbers, so only the number is compared), and
 * `priority` = the Priority of the question's item. The person's questions (open, or held) are ordered by how many wait,
 * then Priority (P0 first, unset last), then newest; the other groups keep `dedupeAsks`' order.
 */
export function rankAsks(asks: Ask[], items: BacklogItem[]): Ask[] {
  const ranked = asks.map((a) => {
    const ns = askNumbers(a);
    const ws = a.workspace?.id;
    const unblocks = items
      .filter((i) => i.type === "pbi" && i.workspaceId === ws && !ns.has(i.number) && [...i.waits, ...i.prereqs].some((w) => w.state !== "met" && ns.has(w.number)))
      .sort((x, y) => x.number - y.number)
      .map((i) => ({ number: i.number, title: i.title, url: i.url }));
    const own = [...ns].map((n) => items.find((i) => i.workspaceId === ws && i.number === n)).find((i) => i !== undefined);
    return { ...a, unblocks, priority: own?.priority ?? null };
  });
  const person = ranked.filter((a) => groupOf(a) === 0).sort((a, b) => b.unblocks.length - a.unblocks.length || priorityRank(a.priority) - priorityRank(b.priority) || b.at - a.at);
  return [...person, ...ranked.filter((a) => groupOf(a) !== 0)];
}
