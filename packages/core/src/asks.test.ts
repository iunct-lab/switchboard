// test-reads: packages/core/fixtures/
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AnswerPolicy, ApprovalRuleMatch, Artifact, AskList, AskQuestion, PolicySubject, Backlog, BacklogItem, EventEnvelope, PendingApproval, RunnerAdapter, RunnerId, RunnerSession, StopRecord, StopSummary, Task, WaitRecord } from "@switchboard/protocol";
import { importing } from "../fixtures/github-import.ts";
import type { Ask, ProceedingQuestion } from "@switchboard/protocol";
import { PROCEED_SETTLED, proceedingAsks, withGone, type GoneFacts } from "./asks.ts";
import { answersOf, ASK_HISTORY_MS, asksFromBacklog, asksFromTasks, blockersOf, dedupeAsks, grantOfChoice, LAST_REPLY_MAX, lastReplyOf, ON_HOLD_RESUME, parseAskBlock, questionsChosen, questionsReply, rankAsks, resumeOfIssue, resumeOfTask } from "./asks.ts";
import { prFacts } from "./asks.ts";
import { WAIT_ANSWER_NEXT, WAIT_RETRYING_NEXT } from "./waits.ts";
import { gateRecordsOf } from "./gate-records.ts";
import { parseMergeGrants } from "./merge-grants.ts";
import { closedHits, noticeAsks } from "./asks-notices.ts";
import { approvalBatches } from "./approval-batch.ts";
import { heldSince } from "./backlog-comments.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { reduceStops } from "./stops.ts";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const ISSUES = "https://github.com/o/r/issues";

/** `lastTurnQuestions` of a Task whose last turn asked one question tool question; options are `label` or `[label, description]`; a null question = it never ended a turn. */
const turnOf = (question: string | null, options: Array<string | [string, string]> = [], askedAt: number | null = NOW) => (): { questions: AskQuestion[]; seq: number; askedAt: number | null } | null =>
  question === null ? null : { questions: [{ header: null, question, options: options.map((o) => (typeof o === "string" ? { label: o, description: null } : { label: o[0], description: o[1] })), multiSelect: false }], seq: 9, askedAt };

const item = (over: Partial<BacklogItem>): BacklogItem => ({
  number: 1, title: "t", url: `${ISSUES}/${over.number ?? 1}`, type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", commentedAt: null, tasks: null, decision: null, activeTaskId: null, projectStatus: null, lastTask: null, replyWaiting: false, report: null, answeredAt: null, heldAt: null, confirmations: [], postMerge: [], closable: false, autoHeld: null, progress: { closableByApi: false, closesOnAnswer: null, checking: false }, onHold: false, claim: null, flow: false, bodyChars: 0, requestChars: null, kind: null, requestFrom: null, origin: null, labels: [], waits: [], waitsAt: null, waitsUntil: null, overlap: null, prereqs: [], events: [], stopSummary: [], mockupTask: null, mockups: [], sync: { state: "synced", reason: null, lastSuccessfulSync: null, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A" }, workspaceId: "ws_meta", workspaceName: "switchboard", ...over,
});

/** The last stage Task of an item whose stop asks the person: the Task's outcome (written from its stop records) is what opens the question. */
const stageTask = (outcome: NonNullable<BacklogItem["lastTask"]>["outcome"] = "needs_action", id = "tk_5"): NonNullable<BacklogItem["lastTask"]> =>
  ({ id, status: "done", statusAt: NOW - 3_600_000, createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000, action: "complete", outcome, reviewedAt: null, resumeAt: null, started: true });

const stop = (over: Partial<StopSummary>): StopSummary => ({
  id: "s1", key: "ws_meta#5\u0000gh pr merge\u0000#7\u0000decision\u0000", work: { workspaceId: "ws_meta", issue: 5, taskId: "tk_5" }, op: "gh pr merge", target: "#7", reason: "decision", evidence: "merge-gate stop",
  safety: "unknown", count: 1, state: "waiting", firstAt: NOW - 3_600_000, lastAt: NOW - 3_600_000, contentAt: NOW - 3_600_000, lastAnswer: null, answered: false, grant: null, conditions: [], actions: [], changes: [], unchanged: false, next: "decide", ...over,
});

const DECISION = ["## 判断待ち", "**問い**: どちらの読みで作るか", "**選択肢**:", "- A: 既存の画面を置き換える — 影響: URL はそのまま", "- B: 新しい画面 — 影響: Rail が増える", "**推奨**: A — 画面を増やさない", "**止めた場所**: Task #9"].join("\n");

describe("parseAskBlock", () => {
  test("a ## 判断待ち gives the question, two choices and the recommendation with its reason", () => {
    expect(parseAskBlock(DECISION)).toEqual({
      question: "どちらの読みで作るか",
      choices: ["A: 既存の画面を置き換える — 影響: URL はそのまま", "B: 新しい画面 — 影響: Rail が増える"],
      grants: [null, null],
      recommendation: { choice: "A", why: "画面を増やさない" },
      place: { text: "Task #9", pr: null, reasons: [], diff: null },
      mockupTask: null,
    });
    // a reply's `**確認**:` is not read: an operational check comes from the question tool only
    expect(parseAskBlock("前置き\n\n**確認**: PR #12 をマージしてよいか\n**選択肢**:\n- A: マージする\n").question).toBeNull();
  });

  test("text without a recommendation has recommendation null; text without the form has nothing", () => {
    expect(parseAskBlock("**問い**: 続けるか").recommendation).toBeNull();
    expect(parseAskBlock("終わりました。")).toEqual({ question: null, choices: [], grants: [], recommendation: null, place: null, mockupTask: null });
  });

  test("place: **止めた場所** gives its text and the first PR it names; a place without a PR has pr null", () => {
    expect(parseAskBlock("**問い**: マージしてよいか\n**止めた場所**: PR #12（+40/-3）、PR #13 の下").place).toEqual({ text: "PR #12（+40/-3）、PR #13 の下", pr: 12, reasons: [], diff: "+40/-3" });
    expect(parseAskBlock("**問い**: どちらか\n**止めた場所**: Task #9 の手順 2").place).toEqual({ text: "Task #9 の手順 2", pr: null, reasons: [], diff: null });
  });
});

describe("answers", () => {
  const DECIDE = "## 判断待ち\n**問い**: どちらか\n**選択肢**:\n- A: 置き換える\n- B: 足す\n**推奨**: A — 少ない";

  test("hold: a ## 保留 after the ## 判断待ち makes it held and still the person's; its answers stay open", () => {
    const [held] = asksFromBacklog([item({ number: 3, stage: "needs-decision", decision: { body: DECIDE, at: "2026-10-07T10:00:00Z", issue: 3 }, heldAt: "2026-10-07T11:00:00Z" })], NOW);
    expect(held).toMatchObject({ kind: "decision", needs: "person", state: "held", changedAt: Date.parse("2026-10-07T11:00:00Z"), answers: ["choice", "text", "hold"] });
    // a held question older than the history window stays: it is still not answered
    const [old] = asksFromBacklog([item({ number: 3, stage: "needs-decision", decision: { body: DECIDE, at: "2026-09-01T10:00:00Z", issue: 3 }, heldAt: "2026-09-01T11:00:00Z" })], NOW);
    expect(old!.state).toBe("held");
    expect(dedupeAsks([held!])[0]!.state).toBe("held");
  });

  test("blockers: an open PR wait, a ci condition not met and a permission refusal give 3; a waiting tool approval takes the refusal away", () => {
    const stops = [
      stop({ key: "a", reason: "depends", conditions: [{ key: "ci", value: "failure", met: false }, { key: "review", value: "done", met: true }], next: "wait" }),
      stop({ key: "b", op: "gh pr merge", target: "#7", reason: "permission", evidence: "denied by the runner", next: "decide" }),
      stop({ key: "c", reason: "permission", state: "resolved", conditions: [{ key: "x", value: "y", met: false }], next: "none" }),
    ];
    const waits = [{ number: 70, kind: "pr" as const, open: true, state: "pending" as const, reason: "prerequisite" as const, pbi: null }, { number: 71, kind: "issue" as const, open: false, state: "met" as const, reason: "prerequisite" as const, pbi: null }, { number: 72, kind: "issue" as const, open: null, state: "missing" as const, reason: "overlap" as const, pbi: null }];
    expect(blockersOf({ waits, stops, approvalPending: false })).toEqual([
      { kind: "depends", detail: "PR #70 が未マージ" },
      { kind: "depends", detail: "Issue #72 の状態が未取得" },
      { kind: "condition", detail: "ci: failure" },
      { kind: "runner", detail: "gh pr merge #7: denied by the runner（ランナー側の拒否。回答では解除されません）" },
    ]);
    expect(blockersOf({ waits: [], stops, approvalPending: true }).map((b) => b.kind)).toEqual(["condition"]);
    // the item's stage Task has a tool approval waiting: its permission stop is answered by that approval
    const refused = item({ number: 5, stage: "in-progress", lastTask: stageTask(), stopSummary: [stops[1]!] });
    expect(asksFromBacklog([refused], NOW)[0]).toMatchObject({ blockers: [{ kind: "runner" }], answers: [] });
    expect(asksFromBacklog([refused], NOW, { approvalPending: (i) => i.number === 5 })[0]).toMatchObject({ blockers: [], answers: ["text"] });
  });

  test("hold: a hold kept here (…:00.000Z) in the same second after GitHub's question (…:00Z) is compared as a time", () => {
    const comments = [{ body: "## 保留", createdAt: "2026-10-07T10:00:00.500Z" }];
    expect(heldSince(comments, { at: "2026-10-07T10:00:00Z" })).toBe("2026-10-07T10:00:00.500Z");
    expect(heldSince([{ body: "## 保留", createdAt: "2026-10-07T10:00:00.000Z" }], { at: "2026-10-07T10:00:00Z" })).toBeNull();
    // a labelled Issue whose ## 判断待ち is not there is held by its ## 保留
    expect(heldSince(comments, null)).toBe("2026-10-07T10:00:00.500Z");
    expect(heldSince([], null)).toBeNull();
  });

  test("resume issue: answer only → queued for the next firing; a stage Task after it running / error; a failed start; blockers queue with their reason", () => {
    const at = NOW - 60_000;
    const task = (status: Task["status"], createdAt = NOW) => ({ id: "tk_s", status, createdAt, updatedAt: NOW });
    expect(resumeOfIssue({ answeredAt: null, stageTasks: [], failure: null, blockers: [] })).toBeNull();
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [], failure: null, blockers: [] })).toEqual({ state: "queued", reason: "次の定期実行で再開", taskId: null, at });
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [], failure: null, blockers: [], onHold: true })).toMatchObject({ state: "queued", reason: ON_HOLD_RESUME });
    // a stage Task created before the answer is not its resume
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [task("running", at - 1)], failure: null, blockers: [] })!.state).toBe("queued");
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [task("running")], failure: null, blockers: [] })).toEqual({ state: "running", reason: null, taskId: "tk_s", at: NOW });
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [task("error")], failure: null, blockers: [] })).toMatchObject({ state: "failed", reason: "工程 Task が error", taskId: "tk_s" });
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [task("done")], failure: null, blockers: [] })).toBeNull();
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [], failure: { at: NOW, reason: "ランナーが検出されていません" }, blockers: [] })).toMatchObject({ state: "failed", reason: "ランナーが検出されていません" });
    // a failure before the answer is an older start's
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [], failure: { at: at - 1, reason: "x" }, blockers: [] })!.state).toBe("queued");
    expect(resumeOfIssue({ answeredAt: at, stageTasks: [], failure: null, blockers: [{ kind: "depends", detail: "PR #70 が未マージ" }, { kind: "condition", detail: "ci: failure" }] })).toMatchObject({ state: "queued", reason: "PR #70 が未マージ・ci: failure" });
  });

  test("resume issue: an answered PBI's decision and an answered stop of its stage Task carry it; a failure is read by the question's id", () => {
    const answeredAt = "2026-10-07T11:00:00Z";
    const lastTask = { id: "tk_new", status: "running" as const, statusAt: Date.parse(answeredAt) + 1000, createdAt: Date.parse(answeredAt) + 1000, updatedAt: Date.parse(answeredAt) + 1000, action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
    const [running] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask })], NOW);
    // the stage Task created after the answer is its resume: answered while it runs, failed once in error, resolved once done
    expect(running).toMatchObject({ state: "answered", resume: { state: "running", taskId: "tk_new" } });
    const [errored] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { ...lastTask, status: "error" } })], NOW);
    expect(errored).toMatchObject({ state: "answered", resume: { state: "failed", reason: "工程 Task が error" } });
    const [done] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { ...lastTask, status: "done" } })], NOW);
    expect(done).toMatchObject({ state: "resolved", resume: null });
    const before = { ...lastTask, status: "done" as const, statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000 };
    const id = `decision:ws_meta#2@${answeredAt}`;
    const [queued] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: before })], NOW);
    expect(queued).toMatchObject({ id, state: "answered", resume: { state: "queued", reason: "次の定期実行で再開" }, answers: [] });
    const [failed] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: before })], NOW, { resumeFailures: (x) => (x === id ? { at: NOW, reason: "workspace directory does not exist" } : null) });
    expect(failed!.resume).toMatchObject({ state: "failed", reason: "workspace directory does not exist" });
    const answeredStop = stop({ next: "resume", lastAnswer: { at: NOW - 1000, ref: "#5 ## 回答" } });
    const [s] = asksFromBacklog([item({ number: 5, stage: "in-progress", stopSummary: [answeredStop], lastTask: before })], NOW);
    expect(s).toMatchObject({ kind: "stop", state: "answered", resume: { state: "queued" } });
  });

  test("a stage Task started by the answer is its resume even when GitHub's comment time is later", () => {
    const createdAt = Date.parse("2026-10-07T11:00:00Z");
    const answeredAt = new Date(createdAt + 5000).toISOString();
    const lastTask = { id: "tk_new", status: "running" as const, statusAt: createdAt, createdAt, updatedAt: createdAt, action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
    const [a] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask })], NOW, { startedBy: (w, n) => (w === "ws_meta" && n === 2 ? "tk_new" : null) });
    expect(a).toMatchObject({ state: "answered", resume: { state: "running", taskId: "tk_new" } });
    // still its resume once the running Task is updated after the answer (a title or a permission), and resolved once done
    const startedBy = () => "tk_new";
    const [b] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { ...lastTask, updatedAt: createdAt + 10000 } })], NOW, { startedBy });
    expect(b).toMatchObject({ state: "answered", resume: { state: "running", taskId: "tk_new" } });
    const [c] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { ...lastTask, status: "done", updatedAt: createdAt + 10000 } })], NOW, { startedBy });
    expect(c).toMatchObject({ state: "resolved", resume: null });
  });

  test("a running stage Task from before the answer, not started by it, stays queued", () => {
    const createdAt = Date.parse("2026-10-07T11:00:00Z");
    const answeredAt = new Date(createdAt + 5000).toISOString();
    const lastTask = { id: "tk_old", status: "running" as const, statusAt: createdAt, createdAt, updatedAt: createdAt, action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
    for (const startedBy of [undefined, () => null, () => "tk_other"]) {
      const [a] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask })], NOW, { startedBy });
      expect(a).toMatchObject({ state: "answered", resume: { state: "queued", reason: "次の定期実行で再開" } });
    }
  });

  test("resumeOfTask: the usage limit and a run-slot wait queue, running runs, error fails; no reply is null", () => {
    const t = (over: Partial<Task>) => ({ id: "tk_1", status: "idle", resumeAt: null, queuedAt: null, updatedAt: NOW, ...over }) as Task;
    expect(resumeOfTask({ task: t({}), repliedAt: null, failure: null })).toBeNull();
    expect(resumeOfTask({ task: t({ status: "waiting", resumeAt: Date.parse("2026-10-07T15:00:00Z") }), repliedAt: NOW - 1, failure: null })).toMatchObject({ state: "queued", reason: "使用上限の解除待ち（2026-10-07T15:00:00.000Z）" });
    expect(resumeOfTask({ task: t({ status: "idle", queuedAt: NOW - 5 }), repliedAt: NOW - 1, failure: null })).toEqual({ state: "queued", reason: "実行枠待ち", taskId: "tk_1", at: NOW - 5 });
    expect(resumeOfTask({ task: t({ status: "running" }), repliedAt: NOW - 1, failure: null })).toMatchObject({ state: "running", taskId: "tk_1" });
    expect(resumeOfTask({ task: t({ status: "error" }), repliedAt: NOW - 1, failure: null })).toMatchObject({ state: "failed", reason: "Task が error" });
    expect(resumeOfTask({ task: t({ status: "idle" }), repliedAt: NOW - 1, failure: { at: NOW, reason: "送れなかった" } })).toMatchObject({ state: "failed", reason: "送れなかった" });
    expect(resumeOfTask({ task: t({ status: "idle" }), repliedAt: NOW - 1, failure: null })).toBeNull();
  });

  test("answers: an approval, a decision with choices, a check without, a confirmation, a refused stop and an automatic one", () => {
    const a = (over: Partial<Parameters<typeof answersOf>[0]>) => answersOf({ kind: "decision", needs: "person", state: "open", choices: [], questions: [], blockers: [], grant: null, ...over });
    expect(a({ kind: "approval" })).toEqual(["allow", "deny"]);
    expect(a({ kind: "decision", choices: ["A", "B"] })).toEqual(["choice", "text", "hold"]);
    expect(a({ kind: "decision", state: "held" })).toEqual(["text", "hold"]);
    // a check without choices is answered from the Task's send box; one with a question tool's questions takes their answers
    expect(a({ kind: "check" })).toEqual([]);
    const free = { header: null, question: "q", options: [], multiSelect: false };
    const picked = { ...free, options: [{ label: "A", description: null }] };
    expect(a({ kind: "check", questions: [picked, free] })).toEqual(["questions"]);
    // only questions without options: none on the card
    expect(a({ kind: "check", questions: [free] })).toEqual([]);
    expect(a({ kind: "check", questions: [free, free], choices: ["A"] })).toEqual([]);
    expect(a({ kind: "check", choices: ["A"] })).toEqual(["choice", "text"]);
    expect(a({ kind: "confirmation" })).toEqual(["confirm"]);
    expect(a({ kind: "stop" })).toEqual(["text"]);
    expect(a({ kind: "stop", blockers: [{ kind: "runner", detail: "x" }] })).toEqual([]);
    expect(a({ kind: "stop", needs: "auto" })).toEqual([]);
    expect(a({ kind: "wait", needs: "auto" })).toEqual([]);
    expect(a({ kind: "decision", state: "answered" })).toEqual([]);
    // built: a decision of the backlog, and a Task's approval
    const [d] = asksFromBacklog([item({ number: 3, stage: "needs-decision", decision: { body: DECIDE, at: "2026-10-07T10:00:00Z", issue: 3 } })], NOW);
    expect(d!.answers).toEqual(["choice", "text", "hold"]);
  });
});

describe("lastReply", () => {
  const reply = (text: string | null) => (id: string) => (id === "tk_5" ? text : null);
  const noTurn = { lastTurnQuestions: () => null, permissionEvents: () => [], workspaceName: () => null, approvals: [] as PendingApproval[], now: NOW };
  const issueTask = { id: "tk_5", workspaceId: null, title: "t", status: "done", outcome: "needs_action", reviewedAt: null, resumeAt: null, stage: null, createdAt: NOW - 600_000, updatedAt: NOW - 60_000 } as unknown as Task;

  test("an open stop a person has to answer carries the Task's last reply: a stage Task's and a Task with no Issue's", () => {
    const [stage] = asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask: stageTask(), stopSummary: [stop({})] })], NOW, { lastReply: reply("マージ判定は CI だけが赤です。どうしますか。") });
    expect(stage).toMatchObject({ kind: "stop", needs: "person", state: "open", lastReply: "マージ判定は CI だけが赤です。どうしますか。" });
    const [plain] = asksFromTasks({ ...noTurn, tasks: [issueTask], stops: () => [stop({ work: { workspaceId: "ws_meta", issue: null, taskId: "tk_5" } })], lastReply: reply("途中までです。") });
    expect(plain).toMatchObject({ kind: "stop", needs: "person", state: "open", lastReply: "途中までです。" });
  });

  test("a Task that never ended a turn, a blank reply, and a source with no reader give null", () => {
    expect(asksFromBacklog([item({ number: 5, stopSummary: [stop({})] })], NOW, { lastReply: reply(null) })[0]!.lastReply).toBeNull();
    expect(asksFromBacklog([item({ number: 5, stopSummary: [stop({})] })], NOW, { lastReply: reply(" \n ") })[0]!.lastReply).toBeNull();
    expect(asksFromBacklog([item({ number: 5, stopSummary: [stop({})] })], NOW)[0]!.lastReply).toBeNull();
  });

  test("a stop that waits for a decision opens a question for the person only while the Task's outcome is needs_action", () => {
    const of = (outcome: NonNullable<BacklogItem["lastTask"]>["outcome"]) => asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask: stageTask(outcome), stopSummary: [stop({})] })], NOW)[0]!;
    expect(of("needs_action")).toMatchObject({ kind: "stop", needs: "person", state: "open" });
    // finished: the Task ended with nothing to do, so the old question is over, not left open as an automatic wait
    expect(of("finished")).toMatchObject({ kind: "stop", needs: "auto", state: "resolved" });
    for (const outcome of ["waits", "unknown"] as const) expect(of(outcome)).toMatchObject({ kind: "stop", needs: "auto", state: "open" });
  });

  test("a depends stop the app does not resume asks the person while the Task's outcome is needs_action", () => {
    const of = (outcome: NonNullable<BacklogItem["lastTask"]>["outcome"], conditions: StopSummary["conditions"]) =>
      asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask: stageTask(outcome), stopSummary: [stop({ reason: "depends", next: "wait", conditions })] })], NOW)[0]!;
    // no condition, and one the app cannot watch: nothing continues them but the person
    for (const conditions of [[], [{ key: "subagent#1", value: "running", met: false }]]) {
      expect(of("needs_action", conditions)).toMatchObject({ kind: "stop", needs: "person", state: "open" });
      expect(of("failed", conditions)).toMatchObject({ kind: "stop", needs: "person", state: "open" });
      expect(of("finished", conditions)).toMatchObject({ kind: "stop", needs: "auto", state: "resolved" });
    }
    // a PR the app watches: it goes on by itself, whatever the Task's outcome
    expect(of("needs_action", [{ key: "pr#12", value: "open", met: false }])).toMatchObject({ kind: "stop", needs: "auto", state: "open" });
  });

  test("a reply over the limit is cut to LAST_REPLY_MAX characters and an ellipsis; one at the limit is whole", () => {
    expect(lastReplyOf("あ".repeat(LAST_REPLY_MAX))).toBe("あ".repeat(LAST_REPLY_MAX));
    expect(lastReplyOf("あ".repeat(LAST_REPLY_MAX + 1))).toBe(`${"あ".repeat(LAST_REPLY_MAX)}…`);
    const [s] = asksFromBacklog([item({ number: 5, lastTask: stageTask(), stopSummary: [stop({})] })], NOW, { lastReply: reply("x".repeat(LAST_REPLY_MAX + 1)) });
    expect(s!.lastReply).toBe(`${"x".repeat(LAST_REPLY_MAX)}…`);
  });

  test("an automatic wait, an answered stop and a resolved stop carry no reply", () => {
    const answer = { ref: "seq:12", at: NOW - 600_000 };
    const stops = [stop({ reason: "usage-limit", next: "wait" }), stop({ next: "resume", lastAnswer: answer }), stop({ state: "resolved", next: "none", lastAt: NOW - 60_000 })];
    for (const s of stops) expect(asksFromBacklog([item({ number: 5, lastTask: stageTask("waits"), stopSummary: [s] })], NOW, { lastReply: reply("返答") })[0]!.lastReply).toBeNull();
    expect(asksFromTasks({ ...noTurn, tasks: [{ ...issueTask, outcome: "waits" }], stops: () => [stop({ work: { workspaceId: "ws_meta", issue: null, taskId: "tk_5" }, next: "wait" })], lastReply: reply("返答") })[0]!.lastReply).toBeNull();
  });
});

describe("grants", () => {
  const GRANT = "定期実行 sch_x を enabled: false で POST /api/schedules に登録することだけ許可します";
  const OPTIONS: Array<[string, string]> = [["A: 登録しない", "何もしない"], ["B: 登録する (Recommended)", `確かめるため — 許可: ${GRANT}`]];
  const task = (over: Partial<Task> = {}): Task =>
    ({ id: "tk_g", workspaceId: null, title: "t", runner: "claude", cwd: "/tmp", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard", resumeAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "needs_action", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: NOW - 600_000, createdAt: NOW - 600_000, updatedAt: NOW - 60_000, ...over }) as Task;
  const fromTasks = (t: Task, stops: StopSummary[], reply: string | null, options: Array<string | [string, string]> = ["A: はい", "B: いいえ"]) =>
    asksFromTasks({ approvals: [], tasks: [t], lastTurnQuestions: turnOf(reply, options), permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW, policy: { policies: [], pbiOpen: () => true, approval: () => ({ subject: null, confirmHit: null }), confirm: () => null } });
  const refused = (over: Partial<StopSummary> = {}) =>
    stop({ key: "task:tk_g\u0000POST /api/schedules\u0000\u0000permission\u0000", work: { workspaceId: null, issue: null, taskId: "tk_g" }, op: "POST /api/schedules", target: "", reason: "permission", evidence: "auto mode denied", next: "decide", ...over });

  test("choice grant: a chosen option's ` — 許可: ` ends its line of the one reply; an option without one adds none", () => {
    expect(grantOfChoice("A: 登録しない — 影響: なし")).toBeNull();
    expect(grantOfChoice("A: x — 許可：全角の区切り")).toBe("全角の区切り");
    const [check] = fromTasks(task(), [], "定期実行を登録してよいか", OPTIONS);
    expect(check).toMatchObject({ kind: "check", reason: "質問", grant: null, answers: ["questions"] });
    const qs = check!.questions;
    expect(questionsReply(qs, [{ choices: ["B: 登録する (Recommended)"] }])).toBe(`- 定期実行を登録してよいか: B: 登録する (Recommended) — 許可: ${GRANT}`);
    expect(questionsReply(qs, [{ choices: ["A: 登録しない"] }])).toBe("- 定期実行を登録してよいか: A: 登録しない");
  });

  test("permission stop grant: a permission stop with a grant is not in the way and is answered by it; one without stays the runner's refusal", () => {
    const [g] = fromTasks(task({ outcome: "needs_action" }), [refused({ grant: GRANT })], null);
    expect(g).toMatchObject({ kind: "stop", needs: "person", state: "open", grant: GRANT, blockers: [], answers: ["grant", "text"] });
    expect(g!.policy).toMatchObject({ scopes: [], note: "許可文は 1 回きりで、方針には保存しません" });
    const [none] = fromTasks(task({ outcome: "needs_action" }), [refused()], null);
    expect(none).toMatchObject({ grant: null, answers: [] });
    expect(none!.blockers.map((b) => b.kind)).toEqual(["runner"]);
    // only a permission stop's grant lifts the blocker: an auth refusal stays the runner's, though its grant is carried to the ask
    expect(blockersOf({ waits: [], stops: [refused({ reason: "auth", grant: GRANT })], approvalPending: false }).map((b) => b.kind)).toEqual(["runner"]);
    const [auth] = fromTasks(task({ outcome: "needs_action" }), [refused({ reason: "auth", grant: GRANT })], null);
    expect(auth!.grant).toBe(GRANT);
  });

  test("a person's stop with a grant takes the grant whatever its reason", () => {
    const [d] = fromTasks(task({ outcome: "needs_action" }), [refused({ reason: "decision", grant: GRANT })], null);
    expect(d).toMatchObject({ kind: "stop", needs: "person", state: "open", grant: GRANT });
    expect(d!.answers).toContain("grant");
    // a reason a person does not answer carries none
    const [t] = fromTasks(task({ outcome: "needs_action" }), [refused({ reason: "transient", grant: GRANT })], null);
    expect(t?.grant ?? null).toBeNull();
  });

  test("a stop re-reported with a new reason after a reply is open and answerable by its grant", () => {
    const rec = (over: Partial<StopRecord>): StopRecord => ({ id: "merge-ask", op: "gh pr merge", target: "PR #1", reason: "decision", evidence: "x", safety: "unknown", state: "waiting", conditions: [], actions: [], grant: GRANT, answer: null, at: 1000, work: { workspaceId: null, issue: null, taskId: "tk_g" }, ...over }) as StopRecord;
    const reply = { ref: "seq:7", at: 2000 };
    const summaries = reduceStops([rec({}), rec({ answer: reply, at: 2500 }), rec({ reason: "permission", answer: reply, at: 3000 })]);
    const [g] = fromTasks(task({ outcome: "needs_action" }), summaries, null);
    expect(g).toMatchObject({ kind: "stop", state: "open", grant: GRANT });
    expect(g!.answers).toContain("grant");
  });

  test("a new grant after an answered one is the person's open question, answerable by that grant", () => {
    const [A, B] = ["PR #12 を判定の外でマージしてよい", "PR #13 を判定の外でマージしてよい"];
    const rec = (over: Partial<StopRecord>): StopRecord => ({ id: "g1", op: "gh pr merge", target: "PR", reason: "permission", evidence: "x", safety: "unknown", state: "waiting", conditions: [], actions: [], grant: A, answer: null, at: 1000, work: { workspaceId: null, issue: null, taskId: "tk_g" }, ...over }) as StopRecord;
    const reply = { ref: "seq:7", at: 2000 };
    // the first grant's stop answered, then the same series stops under a new id with another grant (the earlier answer carried over)
    const summaries = reduceStops([rec({}), rec({ answer: reply, at: 2001 }), rec({ id: "g2", grant: B, answer: reply, at: 3000 })]);
    const [g] = fromTasks(task({ outcome: "needs_action" }), summaries, null);
    expect(g).toMatchObject({ kind: "stop", needs: "person", state: "open", grant: B, answers: ["grant", "text"] });
    // the same grant again is not asked again
    const same = reduceStops([rec({}), rec({ answer: reply, at: 2001 }), rec({ id: "g2", answer: reply, at: 3000 })]);
    expect(fromTasks(task({ outcome: "needs_action" }), same, null)[0]?.needs).not.toBe("person");
  });

  test("permission stop grant: folded into the Task's check, the grant stays answerable and is not saved as a policy", () => {
    const list = dedupeAsks(fromTasks(task(), [refused({ grant: GRANT })], "続けるか", ["A: はい"]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "check", grant: GRANT, answers: ["grant", "questions"], policy: { scopes: [], note: "許可文は 1 回きりで、方針には保存しません" } });
    // a stop without a grant folds as before
    expect(dedupeAsks(fromTasks(task(), [refused({ reason: "input" })], "続けるか", []))[0]).toMatchObject({ kind: "check", grant: null, answers: [] });
  });
});

describe("asksFromBacklog", () => {
  test("利用者確認: a line with a 期日 is not asked before it, and is from the time itself on", () => {
    const line = (n: number, after: string | null) => ({ n, text: `${n}. 出ない（利用者確認: 期日 ${after} 以降 — 確認）`, after });
    const ids = (now: number) =>
      asksFromBacklog([item({ number: 4, stage: "in-progress", confirmations: [line(1, "2026-10-07T12:00:00Z"), line(2, "2026-10-07T21:00:01+09:00"), { n: 3, text: "3. 画面（利用者確認: 画面）", after: null }] })], now)
        .filter((a) => a.kind === "confirmation").map((a) => a.id);
    expect(ids(NOW - 1)).toEqual(["confirm:ws_meta#4:3"]);
    expect(ids(NOW)).toEqual(["confirm:ws_meta#4:1", "confirm:ws_meta#4:3"]);
    expect(ids(NOW + 3_600_000)).toEqual(["confirm:ws_meta#4:1", "confirm:ws_meta#4:2", "confirm:ws_meta#4:3"]);
  });


  test("from backlog: a decision, two confirmations, an open wait, a decide stop and a usage-limit stop", () => {
    const asks = asksFromBacklog(
      [
        item({ number: 3, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T10:00:00Z", issue: 9 } }),
        item({ number: 4, stage: "in-progress", confirmations: [{ n: 2, text: "PC で見える（利用者確認: 画面）", after: null }, { n: 3, text: "スマホで見える（利用者確認: 画面）", after: null }] }),
        item({ number: 6, waits: [{ number: 70, kind: "pr", open: true, state: "pending", reason: "prerequisite", pbi: null }, { number: 71, kind: "issue", open: false, state: "met", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" }),
        item({ number: 5, stage: "in-progress", lastTask: stageTask(), stopSummary: [stop({}), stop({ key: "ws_meta#5\u0000codex exec\u0000\u0000usage-limit\u0000", op: "codex exec", target: "", reason: "usage-limit", evidence: "5h window", next: "wait", conditions: [{ key: "resetsAt", value: "2026-10-07T15:00:00Z", met: false }] })] }),
      ],
      NOW,
    );
    const person = asks.filter((a) => a.needs === "person" && a.state === "open");
    const auto = asks.filter((a) => a.needs === "auto" && a.state === "open");
    expect(person.map((a) => a.kind).sort()).toEqual(["confirmation", "confirmation", "decision", "stop"]);
    expect(auto.map((a) => a.kind).sort()).toEqual(["stop", "wait"]);

    const decision = asks.find((a) => a.kind === "decision")!;
    expect(decision).toMatchObject({
      id: "decision:ws_meta#9@2026-10-07T10:00:00Z", question: "どちらの読みで作るか", recommendation: { choice: "A", why: "画面を増やさない" }, route: "backlog",
      workspace: { id: "ws_meta", name: "switchboard" }, pbi: { number: 3 }, issue: { number: 9, url: `${ISSUES}/9` }, source: { url: `${ISSUES}/9` },
    });
    expect(asks.find((a) => a.id === "confirm:ws_meta#4:3")).toMatchObject({ kind: "confirmation", question: "スマホで見える（利用者確認: 画面）", route: "backlog" });
    const wait = asks.find((a) => a.kind === "wait")!;
    expect(wait).toMatchObject({ id: "wait:ws_meta#6@2026-10-07T09:00:00Z", reason: "PR #70 の完了待ち" });
    expect(wait.conditions).toEqual([{ key: "pr#70", value: "open", met: false }, { key: "issue#71", value: "closed", met: true }]);
    const limit = auto.find((a) => a.kind === "stop")!;
    expect(limit).toMatchObject({ id: `stop:ws_meta#5|codex exec||usage-limit|@${NOW - 3_600_000}`, reason: "usage-limit: 5h window", task: { id: "tk_5" }, conditions: [{ key: "resetsAt" }] });
  });

  test("after: a depends stop with a date is an auto wait that names the date in its reason", () => {
    const due = "2026-11-20T09:00:00+09:00";
    const asks = asksFromBacklog([item({ number: 5, stage: "in-progress", stopSummary: [stop({ key: "ws_meta#5\u0000overlap\u0000\u0000depends\u0000", op: "overlap", target: "", reason: "depends", evidence: "3 日分の集計を待つ", next: "wait", conditions: [{ key: "after", value: due, met: false }] })] })], NOW);
    const a = asks.find((x) => x.kind === "stop")!;
    expect(a).toMatchObject({ needs: "auto", state: "open", reason: `depends: 3 日分の集計を待つ（期日 ${due} まで）` });
    // a stop without a date, and one whose date is met, say nothing of it
    const plain = asksFromBacklog([item({ number: 5, stage: "in-progress", stopSummary: [stop({ reason: "depends", evidence: "e", next: "wait", conditions: [{ key: "pr#12", value: "open", met: false }] })] })], NOW).find((x) => x.kind === "stop")!;
    expect(plain.reason).toBe("depends: e");
  });

  test("missing: a needs-decision item without its ## 判断待ち has no question, but its PBI and source are known", () => {
    const [a] = asksFromBacklog([item({ number: 8, title: "PBI 8", stage: "needs-decision", decision: null })], NOW);
    expect(a).toMatchObject({ kind: "decision", needs: "person", state: "open", question: null, recommendation: null, choices: [] });
    expect(a!.pbi).toEqual({ number: 8, title: "PBI 8", url: `${ISSUES}/8` });
    expect(a!.source.url).toBe(`${ISSUES}/8`);
    // the id does not move when the Issue is edited
    const [later] = asksFromBacklog([item({ number: 8, title: "PBI 8", stage: "needs-decision", decision: null, updatedAt: "2026-10-07T11:59:00Z" })], NOW);
    expect(later!.id).toBe(a!.id);
  });

  test("stops: a stop that asks is the person's when its failed Task is the item's newest stage Task, not when a later stage Task took the work over", () => {
    const gaveUp = stop({ state: "exhausted", next: "decide" });
    const failed = { id: "tk_5", outcome: "failed", status: "aborted", resumeAt: null, queuedAt: null, updatedAt: NOW } as Task;
    const of = (lastTask: NonNullable<BacklogItem["lastTask"]>) => asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask, stopSummary: [gaveUp] })], NOW, { taskOf: (id) => (id === "tk_5" ? failed : null) }).find((a) => a.kind === "stop");
    expect(of(stageTask("failed", "tk_5"))).toMatchObject({ needs: "person", state: "open" });
    expect(of(stageTask("unknown", "tk_6"))).toMatchObject({ needs: "auto", state: "open" });
  });

  test("stops: resume with an answer is answered at the answer's time, without one it goes on by itself; a resolved usage-limit stop was automatic", () => {
    const answer = { ref: "seq:12", at: NOW - 600_000 };
    const [answered] = asksFromBacklog([item({ number: 5, stopSummary: [stop({ next: "resume", lastAnswer: answer })] })], NOW);
    expect(answered).toMatchObject({ kind: "stop", needs: "person", state: "answered", changedAt: answer.at });
    // a first stop answered in its Task stays `decide` (no earlier stop shows the answer as a change): answered by its own `answered`, going on as the Task does
    const replied = item({ number: 5, stopSummary: [stop({ answered: true, lastAnswer: answer })] });
    const task = { id: "tk_5", status: "running", resumeAt: null, queuedAt: null, updatedAt: NOW } as Task;
    expect(asksFromBacklog([replied], NOW, { taskOf: () => task })[0]).toMatchObject({ state: "answered", changedAt: answer.at, resume: { state: "running", taskId: "tk_5" } });
    expect(asksFromBacklog([replied], NOW, { taskOf: () => ({ ...task, status: "error" }) })[0]!.resume).toMatchObject({ state: "failed", reason: "Task が error" });
    // a reply the Task refused leaves the stop open with the failure
    const failure = { at: NOW - 1000, reason: "budget exceeded" };
    expect(asksFromBacklog([item({ number: 5, stopSummary: [stop({})] })], NOW, { taskOf: () => task, resumeFailures: () => failure })[0]).toMatchObject({ state: "open", resume: { state: "failed", reason: "budget exceeded", taskId: "tk_5" } });
    // a failure of a reply to an earlier stop of the series is not the newer stop's
    expect(asksFromBacklog([item({ number: 5, stopSummary: [stop({ lastAt: NOW })] })], NOW, { taskOf: () => task, resumeFailures: () => failure })[0]!.resume).toBeNull();
    // a Task with no Issue: its first stop answered in its conversation goes on as the Task does, as the stage Task's does
    const plain = { ...task, workspaceId: null, title: "t", outcome: null, reviewedAt: null, stage: null, createdAt: NOW - 600_000 } as unknown as Task;
    const noIssue = asksFromTasks({ approvals: [], tasks: [plain], lastTurnQuestions: () => null, permissionEvents: () => [], workspaceName: () => null, now: NOW, stops: () => [stop({ work: { workspaceId: "ws_meta", issue: null, taskId: "tk_5" }, answered: true, lastAnswer: answer })] });
    expect(noIssue.find((a) => a.kind === "stop")).toMatchObject({ state: "answered", resume: { state: "running", taskId: "tk_5" } });
    const [resume] = asksFromBacklog([item({ number: 5, stopSummary: [stop({ next: "resume" })] })], NOW);
    expect(resume).toMatchObject({ needs: "auto", state: "open" });
    const [limit] = asksFromBacklog([item({ number: 5, stopSummary: [stop({ reason: "usage-limit", state: "resolved", next: "none", lastAt: NOW - 60_000 })] })], NOW);
    expect(limit).toMatchObject({ needs: "auto", state: "resolved" });
    const [retried] = asksFromBacklog([item({ number: 5, stopSummary: [stop({ reason: "transient", state: "resolved", next: "none", lastAt: NOW - 60_000, lastAnswer: answer })] })], NOW);
    expect(retried).toMatchObject({ needs: "person", state: "resolved" });
    const [decided] = asksFromBacklog([item({ number: 5, stopSummary: [stop({ state: "resolved", next: "none", lastAt: NOW - 60_000 })] })], NOW);
    expect(decided).toMatchObject({ needs: "person", state: "resolved" });
  });

  test("states: an answered in-progress PBI is answered; once its next Task ran it is resolved; one older than a day is not returned", () => {
    const answeredAt = "2026-10-07T11:00:00Z";
    const lastTask = (updatedAt: number) => ({ id: "tk", status: "done" as const, statusAt: updatedAt, createdAt: updatedAt, updatedAt, action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true });
    const [answered] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: lastTask(NOW - 7_200_000) })], NOW);
    expect(answered).toMatchObject({ kind: "decision", state: "answered", question: null, changedAt: Date.parse(answeredAt), id: `decision:ws_meta#2@${answeredAt}` });
    const [resolved] = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: lastTask(NOW - 60_000) })], NOW);
    expect(resolved).toMatchObject({ state: "resolved", id: answered!.id });
    const old = new Date(NOW - ASK_HISTORY_MS - 60_000).toISOString();
    expect(asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt: old, lastTask: lastTask(NOW - 60_000) })], NOW)).toEqual([]);
    const unblocked = asksFromBacklog([item({ number: 6, waits: [{ number: 70, kind: "pr", open: false, state: "met", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" })], NOW);
    expect(unblocked).toMatchObject([{ kind: "wait", state: "open", needs: "auto", conditions: [{ key: "pr#70", met: true }] }]);
    // a day after the release the closed wait is still listed until the work goes on (the server then empties the waits)
    expect(asksFromBacklog([item({ number: 6, waits: [{ number: 70, kind: "pr", open: false, state: "met", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-05T09:00:00Z" })], NOW)).toMatchObject([{ kind: "wait", state: "open" }]);
    // a wait not read is neither open nor met: nothing reads it again, so a person looks
    const unread = asksFromBacklog([item({ number: 6, waits: [{ number: 70, kind: "pr", open: false, state: "met", reason: "prerequisite", pbi: null }, { number: 99, kind: "issue", open: null, state: "missing", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" })], NOW);
    expect(unread).toMatchObject([{ kind: "wait", needs: "person", route: "backlog", next: "未取得の相手を確かめて #6 の「実装する」", reason: "Issue #99（未取得） の完了待ち", conditions: [{ key: "pr#70", met: true }, { key: "issue#99", value: "unknown", met: false }] }]);
    const unreadBuilding = asksFromBacklog([item({ number: 6, stage: "in-progress", waits: [{ number: 99, kind: "issue", open: null, state: "missing", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" })], NOW);
    expect(unreadBuilding).toMatchObject([{ kind: "wait", needs: "person", next: "未取得の相手を確かめて /pbi-complete 6 を手で始める" }]);
    const done = asksFromBacklog([item({ number: 5, stopSummary: [stop({ state: "resolved", next: "none", lastAt: NOW - ASK_HISTORY_MS - 1 })] })], NOW);
    expect(done).toEqual([]);
  });
});

describe("proceedingAsks", () => {
  const GO = ["## 判断待ち", "**問い**: どちらの読みで作るか", "**選択肢**:", "- A: 置き換える — 影響: URL はそのまま", "- B: 新しい画面 — 影響: Rail が増える", "**推奨**: A — 画面を増やさない", "**進め方**: 推奨で進める（種類: implementation-choice） — 戻せる"].join("\n");
  const q = (over: Partial<ProceedingQuestion> = {}): ProceedingQuestion => ({ workspaceId: "ws_meta", workspaceName: "meta", issue: { number: 51, url: `${ISSUES}/51` }, pbi: { number: 5, title: "PBI", url: `${ISSUES}/5`, open: true }, body: GO, at: "2026-10-07T00:00:00Z", answer: null, closedAt: null, stopped: null, ...over });

  test("an open PBI's is open, going on by itself, and takes a confirmation, a choice or words — never a hold or a policy", () => {
    const [a] = proceedingAsks([q()], NOW);
    expect(a).toMatchObject({ id: "proceed:ws_meta#51@2026-10-07T00:00:00Z", kind: "decision", needs: "auto", state: "open", proceeding: true, pbi: { number: 5 }, issue: { number: 51 }, question: "どちらの読みで作るか", recommendation: { choice: "A", why: "画面を増やさない" }, answers: ["confirm", "choice", "text"], policy: { scopes: [] }, route: "backlog" });
    expect(a!.choices).toHaveLength(2);
  });

  test("one the reversibility table did not let go on is the person's to answer: not proceeding (never confirmed in one press), with the table's reason", () => {
    const [a] = proceedingAsks([q({ stopped: "種類が書かれていない" })], NOW);
    expect(a).toMatchObject({ kind: "decision", needs: "person", state: "open", answers: expect.arrayContaining(["choice", "text"]) });
    expect(a!.proceeding).toBeUndefined();
    expect(a!.reason).toContain("止めて聞く");
    expect(a!.reason).toContain("種類が書かれていない");
    expect(a!.next).not.toContain("答えなくても");
  });

  test("answered once a ## 回答 came (confirmed or overturned), for a day", () => {
    const at = "2026-10-07T06:00:00Z";
    expect(proceedingAsks([q({ answer: { at, body: "## 回答\n\n**確定**: 推奨のまま A — 問い 2026-10-07T00:00:00Z" } })], NOW)[0]).toMatchObject({ state: "answered", changedAt: Date.parse(at), reason: "実装の判断（推奨のままで確定）", answers: [] });
    expect(proceedingAsks([q({ answer: { at, body: "## 回答\n\n**覆す**: 推奨 A → B — 問い 2026-10-07T00:00:00Z\n\nB: 新しい画面" } })], NOW)[0]).toMatchObject({ state: "answered", reason: "実装の判断（推奨を覆した）" });
    expect(proceedingAsks([q({ answer: { at, body: "## 回答\nA" } })], NOW + ASK_HISTORY_MS + Date.parse(at) - NOW + 1)).toEqual([]);
  });

  test("a closed PBI's with no answer is resolved as 推奨で確定した, not left open; gone a day after the PBI closed", () => {
    const closedAt = "2026-10-07T09:00:00Z";
    const closed = q({ pbi: { number: 5, title: "PBI", url: `${ISSUES}/5`, open: false }, closedAt });
    expect(proceedingAsks([closed], NOW)[0]).toMatchObject({ state: "resolved", reason: PROCEED_SETTLED, changedAt: Date.parse(closedAt), answers: [] });
    expect(PROCEED_SETTLED).toBe("推奨で確定した");
    expect(proceedingAsks([closed], Date.parse(closedAt) + ASK_HISTORY_MS + 1)).toEqual([]);
  });

  test("it does not take a stage Task's own question into it, as a waiting decision of the Issue does", () => {
    const stopOf = (decided: Ask[]) => dedupeAsks([...decided, ...asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask: stageTask(), stopSummary: [stop({})] })], NOW)]).filter((a) => a.kind === "stop");
    expect(stopOf(proceedingAsks([q({ issue: { number: 5, url: `${ISSUES}/5` } })], NOW))).toHaveLength(1);
    // the same Issue asked as a waiting decision folds it
    expect(stopOf(asksFromBacklog([item({ number: 5, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T11:00:00Z", issue: 5 } })], NOW))).toHaveLength(0);
  });
});

describe("withGone", () => {
  const none: GoneFacts = { endOf: () => null, newerStageDone: () => null, jobEnded: () => null, laterRunDone: () => null };
  const decision = () => asksFromBacklog([item({ number: 5, stage: "needs-decision", decision: { body: DECISION.replace("Task #9", "PR #12"), at: "2026-10-07T00:00:00Z", issue: 51 } })], NOW)[0]!;
  const stopped = (conditions: StopSummary["conditions"] = []) => asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask: stageTask(), stopSummary: [stop({ conditions })] })], NOW)[0]!;
  const open = (list: Ask[]) => list.filter((a) => a.needs === "person" && (a.state === "open" || a.state === "held")).length;

  test("what is still there stays open", () => {
    expect(withGone([decision(), stopped()], none, NOW).map((a) => a.state)).toEqual(["open", "open"]);
  });

  test("a decision on a closed Issue is resolved with what went, not counted as the person's", () => {
    const at = NOW - 3_600_000;
    const out = withGone([decision()], { ...none, endOf: (w, n) => (w === "ws_meta" && n === 51 ? { kind: "issue", state: "CLOSED", at } : null) }, NOW);
    expect(out).toMatchObject([{ state: "resolved", reason: "#51 が閉じた（対象が無くなった）", changedAt: at, answers: [] }]);
    expect(open(out)).toBe(0);
    // gone from the list a day after it went
    expect(withGone([decision()], { ...none, endOf: () => ({ kind: "issue", state: "CLOSED", at: NOW - ASK_HISTORY_MS - 1 }) }, NOW)).toEqual([]);
  });

  test("a question about a merged PR (where it stopped, or a stop's unmet pr# condition) is resolved; a closed one says closed", () => {
    const merged: GoneFacts = { ...none, endOf: (_w, n) => (n === 12 ? { kind: "pr", state: "MERGED", at: NOW - 60_000 } : null) };
    expect(withGone([decision()], merged, NOW)).toMatchObject([{ state: "resolved", reason: "PR #12 がマージされた（対象が無くなった）" }]);
    expect(withGone([stopped([{ key: "pr#12", value: "open", met: false }])], merged, NOW)).toMatchObject([{ kind: "stop", state: "resolved", reason: "PR #12 がマージされた（対象が無くなった）" }]);
    expect(withGone([stopped([{ key: "pr#12", value: "open", met: false }])], { ...none, endOf: () => ({ kind: "pr", state: "CLOSED", at: NOW }) }, NOW)[0]!.reason).toBe("PR #12 が閉じた（対象が無くなった）");
    // a number that is an Issue's is not the PR
    expect(withGone([stopped([{ key: "pr#12", value: "open", met: false }])], { ...none, endOf: (_w, n) => (n === 12 ? { kind: "issue", state: "CLOSED", at: NOW } : null) }, NOW)[0]!.state).toBe("open");
  });

  test("a stop whose Issue had a newer stage Task finish is resolved", () => {
    const out = withGone([stopped()], { ...none, newerStageDone: (w, n, taskId) => (w === "ws_meta" && n === 5 && taskId === "tk_5" ? NOW - 1000 : null) }, NOW);
    expect(out).toMatchObject([{ state: "resolved", reason: "#5 のより新しい工程 Task が終わった（対象が無くなった）", changedAt: NOW - 1000 }]);
  });

  test("a question going on by its recommendation, and a tool approval, are never taken off this way", () => {
    const all: GoneFacts = { endOf: () => ({ kind: "issue", state: "CLOSED", at: NOW }), newerStageDone: () => NOW, jobEnded: () => NOW, laterRunDone: () => NOW };
    const going = proceedingAsks([{ workspaceId: "ws_meta", workspaceName: "meta", issue: { number: 51, url: `${ISSUES}/51` }, pbi: { number: 5, title: "PBI", url: `${ISSUES}/5`, open: true }, body: DECISION, at: "2026-10-07T00:00:00Z", answer: null, closedAt: null, stopped: null }], NOW);
    const approval = { ...decision(), id: "approval:tk_1:p1", kind: "approval" as const };
    expect(withGone([...going, approval], all, NOW).map((a) => a.state)).toEqual(["open", "open"]);
  });

  // a wait past its limit, as asksFromTasks makes it of a stopped Task's stored waits
  const overWait = (kind: WaitRecord["kind"], key: string, over: Partial<Task> = {}): Ask => {
    const t = { id: "tk_w", workspaceId: "ws_meta", title: "t", status: "done", outcome: "waits", reviewedAt: null, resumeAt: null, queuedAt: null, stage: null, statusAt: NOW - 5 * 86_400_000, createdAt: NOW - 5 * 86_400_000, updatedAt: NOW - 5 * 86_400_000, waits: [{ kind, key, label: key, since: NOW - 4 * 86_400_000, until: NOW - 3_600_000 }], ...over } as Task;
    return asksFromTasks({ approvals: [], tasks: [t], lastTurnQuestions: () => null, permissionEvents: () => [], stops: () => [], workspaceName: () => "meta", now: NOW }).find((a) => a.id.startsWith("waitover:"))!;
  };

  test("a wait past its limit says which wait it is, and stays open while what it waits for is still there", () => {
    expect(overWait("depends", "pr#12")).toMatchObject({ id: `waitover:tk_w:pr#12@${NOW - 3_600_000}`, kind: "wait", needs: "person", state: "open", wait: { kind: "depends", key: "pr#12" } });
    const asks = [overWait("depends", "pr#12"), overWait("depends", "issue#7"), overWait("job", "job#3"), overWait("resume", "resume", { workspaceId: null })];
    expect(withGone(asks, none, NOW).map((a) => a.state)).toEqual(["open", "open", "open", "open"]);
  });

  test("a wait past its limit of a stage Task whose Issue closed is resolved", () => {
    const closed: GoneFacts = { ...none, endOf: (w, n) => (w === "ws_meta" && n === 5 ? { kind: "issue", state: "CLOSED", at: NOW - 60_000 } : null) };
    const out = withGone([overWait("stop", "tk_w/s1:ci", { stage: { issue: 5, action: "complete" } })], closed, NOW);
    expect(out).toMatchObject([{ kind: "wait", state: "resolved", reason: "#5 が閉じた（対象が無くなった）", changedAt: NOW - 60_000, answers: [] }]);
    expect(open(out)).toBe(0);
    // another Task's Issue is not this one's
    expect(withGone([overWait("stop", "tk_w/s1:ci", { stage: { issue: 6, action: "complete" } })], closed, NOW)[0]!.state).toBe("open");
  });

  test("a wait past its limit for a PR that was merged or closed, or an Issue that closed, is resolved", () => {
    const ended: GoneFacts = { ...none, endOf: (_w, n) => (n === 12 ? { kind: "pr", state: "MERGED", at: NOW - 60_000 } : n === 13 ? { kind: "pr", state: "CLOSED", at: NOW } : n === 7 ? { kind: "issue", state: "CLOSED", at: NOW - 1000 } : null) };
    expect(withGone([overWait("depends", "pr#12")], ended, NOW)).toMatchObject([{ state: "resolved", reason: "PR #12 がマージされた（対象が無くなった）", changedAt: NOW - 60_000 }]);
    expect(withGone([overWait("depends", "pr#13")], ended, NOW)[0]!.reason).toBe("PR #13 が閉じた（対象が無くなった）");
    expect(withGone([overWait("depends", "issue#7")], ended, NOW)).toMatchObject([{ state: "resolved", reason: "#7 が閉じた（対象が無くなった）", changedAt: NOW - 1000 }]);
    // a number that is a PR's is not the Issue waited for, and the other way round
    expect(withGone([overWait("depends", "issue#12"), overWait("depends", "pr#7")], ended, NOW).map((a) => a.state)).toEqual(["open", "open"]);
  });

  test("a wait past its limit for a job is resolved once the job ended, however it ended — with no workspace too; a running job's stays open", () => {
    const jobs: GoneFacts = { ...none, jobEnded: (id) => (id === 3 ? NOW - 2000 : null) };
    expect(withGone([overWait("job", "job#3", { workspaceId: null })], jobs, NOW)).toMatchObject([{ state: "resolved", reason: "job#3 が終わった（対象が無くなった）", changedAt: NOW - 2000 }]);
    expect(withGone([overWait("job", "job#3")], jobs, NOW)[0]!.state).toBe("resolved");
    expect(withGone([overWait("job", "job#4")], jobs, NOW)[0]!.state).toBe("open");
  });

  test("a wait past its limit of a schedule's Task is resolved once a later run of the schedule finished; while that run goes on it stays open", () => {
    const later: GoneFacts = { ...none, laterRunDone: (id) => (id === "tk_w" ? NOW - 3000 : null) };
    expect(withGone([overWait("resume", "resume", { workspaceId: null, scheduleId: "sch_1" })], later, NOW)).toMatchObject([{ state: "resolved", reason: "同じ定期実行の後の回が終わった（対象が無くなった）", changedAt: NOW - 3000 }]);
    expect(withGone([overWait("resume", "resume", { workspaceId: null, scheduleId: "sch_1" })], none, NOW)[0]!.state).toBe("open");
  });

  test("a wait past its limit of a Task at work (a command, the runner's output, a run slot, the person) is the turn's own: a closed Issue or a later run does not end it", () => {
    const all: GoneFacts = { ...none, endOf: () => ({ kind: "issue", state: "CLOSED", at: NOW }), laterRunDone: () => NOW, jobEnded: () => NOW };
    // (a wait for the person is not asked about here at all: it is the person's own question)
    const own: Array<[WaitRecord["kind"], string]> = [["output", "output"], ["command", "tk_w/w1"], ["queue", "queue"]];
    for (const [kind, key] of own) {
      const a = overWait(kind, key, { status: "running", stage: { issue: 5, action: "complete" }, scheduleId: "sch_1" });
      expect([kind, a?.wait?.kind, a && withGone([a], all, NOW)[0]!.state]).toEqual([kind, kind, "open"]);
    }
    expect(withGone([overWait("output", "output", { status: "running", workspaceId: null, scheduleId: "sch_1" })], all, NOW)[0]!.state).toBe("open");
  });

  test("a wait past its limit whose key has no fixed form is not read: it stays open whatever ended", () => {
    const all: GoneFacts = { ...none, endOf: (_w, n) => ({ kind: n === 1 ? "pr" : "issue", state: "CLOSED", at: NOW }), jobEnded: () => NOW };
    expect(withGone([overWait("stop", "task_x/tag-ci-v1:tag#v1")], all, NOW)[0]!.state).toBe("open");
  });
});

describe("answersOf: a wait past its limit", () => {
  const overWait = (kind: WaitRecord["kind"], key: string, status: Task["status"] = "done"): Ask => {
    const t = { id: "tk_w", workspaceId: null, title: "t", status, outcome: "waits", reviewedAt: null, resumeAt: null, queuedAt: null, stage: null, statusAt: NOW - 5 * 86_400_000, createdAt: NOW - 5 * 86_400_000, updatedAt: NOW - 5 * 86_400_000, waits: [{ kind, key, label: key, since: NOW - 4 * 86_400_000, until: NOW - 3_600_000 }] } as Task;
    return asksFromTasks({ approvals: [], tasks: [t], lastTurnQuestions: () => null, permissionEvents: () => [], stops: () => [], workspaceName: () => null, now: NOW, policy: { policies: [], pbiOpen: () => true, approval: () => ({ subject: null, confirmHit: null }), confirm: () => null } }).find((a) => a.id.startsWith("waitover:"))!;
  };

  test("a wait that comes from a stop of a Task whose turn is over takes 止める / 待ち続ける, never saved as a policy", () => {
    const fromStops: Array<[WaitRecord["kind"], string]> = [["depends", "pr#12"], ["depends", "issue#7"], ["job", "job#3"], ["date", "after:2026-11-12T00:00:00Z"], ["stop", "tk_w/s1:ci"], ["stop", "tk_w/s1"], ["resume", "runner#codex"]];
    for (const [kind, key] of fromStops)
      expect(overWait(kind, key)).toMatchObject({ kind: "wait", needs: "person", state: "open", wait: { kind, key }, choices: ["止める", "待ち続ける"], answers: ["choice"], next: "止める: この待ちを片づけ、相手が片づいても再開しない / 待ち続ける: 上限をいまから数え直す", policy: { scopes: [], note: null } });
  });

  test("a wait of a Task at work (a command, the queue, the runner's output), a planned resume, and a stop's wait once the Task is in a turn again take no answer", () => {
    const own: Array<[WaitRecord["kind"], string]> = [["command", "command:1"], ["queue", "queue"], ["output", "output"], ["resume", "resume"]];
    for (const [kind, key] of own) expect(overWait(kind, key)).toMatchObject({ kind: "wait", wait: { kind, key }, choices: [], answers: [] });
    for (const status of ["running", "waiting", "background"] as const) expect(overWait("depends", "pr#12", status)).toMatchObject({ choices: [], answers: [] });
    expect(overWait("queue", "queue").next).toBe("Task を開いて、待ち続けるか・相手を進めるか・止めるかを決める");
  });

  test("answersOf itself: the choices of a person's open wait, none without choices, for an automatic wait or once it is answered", () => {
    const a = (over: Partial<Parameters<typeof answersOf>[0]>) => answersOf({ kind: "wait", needs: "person", state: "open", choices: ["止める", "待ち続ける"], questions: [], blockers: [], grant: null, ...over });
    expect([a({}), a({ choices: [] }), a({ needs: "auto" }), a({ state: "answered" }), a({ state: "resolved" })]).toEqual([["choice"], [], [], [], []]);
  });

  // the waits a stop makes, past their limits, asked with the stop summaries of the Task
  const overOf = (stops: StopSummary[], keys: Array<[WaitRecord["kind"], string]>): Ask[] => {
    const waits = keys.map(([kind, key]) => ({ kind, key, label: key, since: NOW - 4 * 86_400_000, until: NOW - 3_600_000 }));
    const t = { id: "tk_w", workspaceId: null, title: "t", status: "done", outcome: "waits", reviewedAt: null, resumeAt: null, queuedAt: null, stage: null, statusAt: NOW - 5 * 86_400_000, createdAt: NOW - 5 * 86_400_000, updatedAt: NOW - 5 * 86_400_000, waits } as Task;
    return asksFromTasks({ approvals: [], tasks: [t], lastTurnQuestions: () => null, permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW });
  };
  const unmet = (...keys: string[]) => keys.map((key) => ({ key, value: "open", met: false }));

  test("止めるの文: names the other waits the same stop makes, and is the plain sentence for a stop of one condition", () => {
    const two = stop({ id: "s1", reason: "depends", op: "gh pr merge", target: "PR #12", conditions: unmet("pr#12", "issue#7") });
    const next = (stops: StopSummary[], keys: Array<[WaitRecord["kind"], string]>) => overOf(stops, keys).find((a) => a.kind === "wait" && a.wait?.key === keys[0]![1])!.next;
    expect(next([two], [["depends", "pr#12"], ["depends", "issue#7"]])).toBe(`${WAIT_ANSWER_NEXT}（同じ停止の Issue #7 も一緒に片づく）`);
    const one = stop({ id: "s1", reason: "depends", conditions: unmet("pr#12") });
    expect(next([one], [["depends", "pr#12"]])).toBe(WAIT_ANSWER_NEXT);
  });

  test("再開できない depends の停止は 1 件: no wait question over a stop that already asks the person", () => {
    const kinds = (stops: StopSummary[], keys: Array<[WaitRecord["kind"], string]>) => overOf(stops, keys).filter((a) => a.state === "open").map((a) => a.kind);
    // no condition: the wait is the stop's own id
    expect(kinds([stop({ id: "s1", reason: "depends", conditions: [] })], [["stop", "s1"]])).toEqual(["stop"]);
    // a condition whose key has no fixed form: the app does not resume it
    expect(kinds([stop({ id: "s1", reason: "depends", conditions: unmet("tag#v1") })], [["stop", "s1:tag#v1"]])).toEqual(["stop"]);
    // a stop the app resumes keeps its wait question
    expect(kinds([stop({ id: "s1", reason: "depends", conditions: unmet("pr#12") })], [["depends", "pr#12"]])).toContain("wait");
  });

  test("再試行中の停止の待ち: only 止める is offered, and the sentence says nothing is needed to keep waiting", () => {
    const a = overOf([stop({ id: "s1", reason: "transient", state: "retrying", conditions: unmet("job#3") })], [["job", "job#3"]]).find((x) => x.kind === "wait")!;
    expect(a).toMatchObject({ choices: ["止める"], answers: ["choice"], next: WAIT_RETRYING_NEXT });
    expect(WAIT_RETRYING_NEXT).toContain("再試行中なので、待ち続けるならこのまま何もしない");
  });
});

describe("dedupeAsks", () => {
  test("dedupe: an open decision and the decision stop of the same PBI's stage Task are one; the same id twice is one", () => {
    const asks = asksFromBacklog([item({ number: 5, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T10:00:00Z", issue: 11 }, stopSummary: [stop({})] })], NOW);
    expect(asks.map((a) => a.kind).sort()).toEqual(["decision", "stop"]);
    expect(dedupeAsks(asks).map((a) => a.kind)).toEqual(["decision"]);
    const onPbi = asksFromBacklog([item({ number: 5, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T10:00:00Z", issue: 5 }, stopSummary: [stop({})] })], NOW);
    expect(dedupeAsks(onPbi).map((a) => a.kind)).toEqual(["decision"]);
    const one = dedupeAsks([...asks, ...asks.map((a) => ({ ...a, changedAt: a.changedAt + 1 }))]);
    expect(one).toHaveLength(1);
    expect(one[0]!.changedAt).toBe(asks.find((a) => a.kind === "decision")!.changedAt + 1);
  });

  test("order: a person's open ones, then automatic ones, then answered, then resolved; newest first in each", () => {
    const asks = asksFromBacklog(
      [
        item({ number: 2, stage: "in-progress", answeredAt: "2026-10-07T11:00:00Z", lastTask: { id: "tk", status: "done", statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000, action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true } }),
        item({ number: 6, waits: [{ number: 70, kind: "pr", open: true, state: "pending", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" }),
        item({ number: 3, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T08:00:00Z", issue: 3 } }),
        item({ number: 4, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T10:00:00Z", issue: 4 } }),
      ],
      NOW,
    );
    expect(dedupeAsks(asks).map((a) => `${a.kind}#${a.pbi!.number}`)).toEqual(["decision#4", "decision#3", "wait#6", "decision#2"]);
  });
});

describe("rankAsks", () => {
  const decide = (n: number, at: string, over: Partial<BacklogItem> = {}) => item({ number: n, stage: "needs-decision", decision: { body: DECISION, at, issue: n }, ...over });
  const pre = (n: number, state: "met" | "pending" = "pending") => ({ number: n, kind: "issue" as const, need: "done" as const, state, via: [], confirming: false });
  const wait = (n: number) => ({ number: n, kind: "pr" as const, open: true, state: "pending" as const, reason: "overlap" as const, pbi: null });

  test("waiting: the other PBIs of the same Workspace naming the question's PBI, Issue or stage Issue with an unmet prerequisite or wait; a met one, another Workspace's same number and itself are not counted; a question whose answer does not close its PBI unblocks none", () => {
    const items = [
      decide(5, "2026-10-07T10:00:00Z", { priority: "P1", prereqs: [pre(5)] }),
      item({ number: 20, title: "waits on 5", prereqs: [pre(5)] }),
      item({ number: 21, title: "waits on 5 by release", waits: [wait(5)] }),
      item({ number: 22, prereqs: [pre(5, "met")] }),
      item({ number: 23, prereqs: [pre(5)], workspaceId: "ws_other" }),
      item({ number: 24, type: "request", prereqs: [pre(5)] }),
      item({ number: 25, title: "waits on the stage Issue", prereqs: [pre(40)] }),
    ];
    const [d] = rankAsks(dedupeAsks(asksFromBacklog(items, NOW)), items).filter((a) => a.kind === "decision");
    expect(d).toMatchObject({ unblocks: [], waiting: [{ number: 20, title: "waits on 5", url: `${ISSUES}/20` }, { number: 21, title: "waits on 5 by release", url: `${ISSUES}/21` }], priority: "P1" });
    // a stage Task's question is about its Issue too
    const [s] = rankAsks(dedupeAsks(asksFromBacklog([item({ number: 9, stopSummary: [stop({ work: { workspaceId: "ws_meta", issue: 9, taskId: "tk_9" } })] })], NOW)).map((a) => ({ ...a, task: { ...a.task!, stageIssue: 40 } })), items);
    expect(s!.waiting.map((u) => u.number)).toEqual([25]);
    expect(s!.unblocks).toEqual([]);
    expect(s!.priority).toBeNull();
  });

  test("unblocks: only the confirmation whose answer closes its PBI (progress.closesOnAnswer) lets the PBIs waiting on it go on", () => {
    const line = (n: number) => ({ n, text: `${n}. 見た目（利用者確認: 画面で見る）`, after: null });
    const building = (over: Partial<BacklogItem>) => item({ number: 5, stage: "in-progress", projectStatus: "In progress", tasks: { total: 2, done: 2, doneAt: null }, ...over });
    const waiter = item({ number: 20, title: "waits on 5", prereqs: [pre(5)] });
    const confirms = (own: BacklogItem) => rankAsks(dedupeAsks(asksFromBacklog([own, waiter], NOW)), [own, waiter]).filter((a) => a.kind === "confirmation").map((a) => [a.id.split(":").at(-1), a.unblocks.map((u) => u.number), a.waiting.map((u) => u.number)]);
    // the last line of a PBI whose Tasks are all closed: answering it closes the PBI
    expect(confirms(building({ confirmations: [line(3)], progress: { closableByApi: true, closesOnAnswer: 3, checking: false } }))).toEqual([["3", [20], []]]);
    // two lines left: neither answer closes it, the PBI behind it only waits
    expect(confirms(building({ confirmations: [line(3), line(4)], progress: { closableByApi: true, closesOnAnswer: null, checking: false } }))).toEqual([["3", [], [20]], ["4", [], [20]]]);
    // the line that closes is the one named, not any line of a PBI that has one (and it is ranked first)
    expect(confirms(building({ confirmations: [line(3), line(4)], progress: { closableByApi: true, closesOnAnswer: 4, checking: false } }))).toEqual([["4", [20], []], ["3", [], [20]]]);
    // a decision on the same PBI closes nothing, whatever the PBI's lines
    const asked = item({ number: 5, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T10:00:00Z", issue: 5 }, tasks: { total: 2, done: 2, doneAt: null }, confirmations: [line(3)], progress: { closableByApi: false, closesOnAnswer: null, checking: false } });
    expect(rankAsks(dedupeAsks(asksFromBacklog([asked, waiter], NOW)), [asked, waiter]).map((a) => [a.kind, a.unblocks.length, a.waiting.length])).toEqual([["decision", 0, 1], ["confirmation", 0, 1]]);
  });

  test("orders the person's questions by how many an answer lets go on, then Priority (P0 first, unset last), then newest — not by how many only wait; automatic, answered and resolved keep their order", () => {
    const lastTask = { id: "tk", status: "done" as const, statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000, action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
    const items = [
      decide(1, "2026-10-07T11:00:00Z"),
      decide(2, "2026-10-07T10:00:00Z", { priority: "P2" }),
      decide(8, "2026-10-07T08:30:00Z", { priority: "P2" }),
      decide(9, "2026-10-07T06:00:00Z", { heldAt: "2026-10-07T06:30:00Z" }),
      item({ number: 10, stage: "in-progress", answeredAt: "2026-10-07T11:00:00Z", lastTask }),
      item({ number: 11, stage: "in-progress", answeredAt: "2026-10-07T10:30:00Z", lastTask }),
      item({ number: 12, stopSummary: [stop({ key: "ws_meta#12\u0000x\u0000\u0000decision\u0000", work: { workspaceId: "ws_meta", issue: 12, taskId: "tk_12" }, state: "resolved", next: "none", lastAt: NOW - 60_000 })] }),
      decide(3, "2026-10-07T09:00:00Z", { priority: "P0" }),
      decide(4, "2026-10-07T08:00:00Z"),
      decide(5, "2026-10-07T07:00:00Z", { priority: "P3" }),
      item({ number: 6, waits: [{ ...wait(70), reason: "prerequisite" }], waitsAt: "2026-10-07T09:30:00Z" }),
      item({ number: 7, waits: [{ ...wait(71), reason: "prerequisite" }], waitsAt: "2026-10-07T09:40:00Z", prereqs: [pre(6)] }),
      item({ number: 30, prereqs: [pre(4), pre(5)] }),
      item({ number: 31, prereqs: [pre(4), pre(9)] }),
      item({ number: 32, prereqs: [pre(10), pre(12)] }),
      // the last user check of a PBI whose Tasks are all closed: answering it lets `#33` go on
      item({ number: 40, stage: "in-progress", updatedAt: "2026-10-07T05:00:00Z", tasks: { total: 1, done: 1, doneAt: null }, confirmations: [{ n: 2, text: "2. 見た目（利用者確認: 画面）", after: null }], progress: { closableByApi: true, closesOnAnswer: 2, checking: false } }),
      item({ number: 33, prereqs: [pre(40)] }),
    ];
    const deduped = dedupeAsks(asksFromBacklog(items, NOW));
    const ranked = rankAsks(deduped, items);
    // `#40`'s answer lets one go on, so it is first though it is the oldest and has no Priority; `#4` (two wait for it), `#5` and
    // `#9` (one each) are not moved up by those: Priority, then newest (Issues 2 and 8 tie on Priority, so the newer first)
    expect(ranked.map((a) => `${a.kind}/${a.state}#${a.pbi!.number}`)).toEqual([
      "confirmation/open#40", "decision/open#3", "decision/open#2", "decision/open#8", "decision/open#5", "decision/open#1", "decision/open#4", "decision/held#9",
      "wait/open#7", "wait/open#6", "decision/answered#10", "decision/answered#11", "stop/resolved#12",
    ]);
    // the other groups keep dedupeAsks' order even when PBIs wait on them
    const rest = (l: typeof ranked) => l.filter((a) => a.needs === "auto" || a.state === "answered" || a.state === "resolved").map((a) => a.id);
    expect(rest(ranked)).toEqual(rest(deduped));
    expect(ranked.find((a) => a.pbi!.number === 40)).toMatchObject({ unblocks: [{ number: 33 }], waiting: [] });
    expect(ranked.find((a) => a.pbi!.number === 4)!.waiting.map((u) => u.number)).toEqual([30, 31]);
    expect(ranked.find((a) => a.pbi!.number === 10)!.waiting.map((u) => u.number)).toEqual([32]);
    expect(ranked.find((a) => a.pbi!.number === 6)!.waiting.map((u) => u.number)).toEqual([7]);
  });
});

describe("mockups", () => {
  const art = (id: string, title: string): Artifact => ({ id, taskId: "tk_m", title, kind: "file", source: `/w/${id}.html`, entry: `${id}.html`, mime: "text/html", size: 1, removedAt: null, createdAt: NOW, updatedAt: NOW, appDays: 0, appRequestTaskId: null });
  const two = [art("art_a", "画面イメージ A: 上に並べる"), art("art_b", "画面イメージ B: 下に並べる")];
  const asked: string[] = [];
  const mockups = (id: string) => (asked.push(id), id === "tk_m" ? two : []);

  test("mockups: a ## 判断待ち with **画面イメージ** has its Task's mockups; without the line it has none", () => {
    asked.length = 0;
    const of = (body: string) => asksFromBacklog([item({ number: 3, stage: "needs-decision", decision: { body, at: "2026-10-07T10:00:00Z", issue: 9 } })], NOW, { mockups }).find((a) => a.kind === "decision")!;
    expect(parseAskBlock(`${DECISION}\n**画面イメージ**: tk_m（2 案）`).mockupTask).toBe("tk_m");
    expect(of(`${DECISION}\n**画面イメージ**: tk_m`).mockups).toEqual(two);
    expect(asked).toEqual(["tk_m"]);
    expect(of(DECISION).mockups).toEqual([]);
    expect(asked).toEqual(["tk_m"]);
    // an unknown Task has none
    expect(of(`${DECISION}\n**画面イメージ**: tk_gone`).mockups).toEqual([]);
  });

  test("mockups: an operational check has the asking Task's own 画面イメージ artifacts; other questions have none", () => {
    const t = { id: "tk_m", workspaceId: null, title: "t", status: "done", outcome: "needs_action", reviewedAt: null, resumeAt: null, stage: null, createdAt: NOW - 600_000, updatedAt: NOW - 60_000 } as unknown as Task;
    const list = asksFromTasks({ approvals: [], tasks: [t], lastTurnQuestions: turnOf("どちらの画面にするか", ["A", "B"]), permissionEvents: () => [], stops: () => [], workspaceName: () => null, now: NOW, mockups });
    expect(list.find((a) => a.kind === "check")!.mockups).toEqual(two);
    const backlog = asksFromBacklog([item({ number: 4, stage: "in-progress", confirmations: [{ n: 1, text: "見える（利用者確認: 画面）", after: null }] })], NOW, { mockups });
    expect(backlog.map((a) => a.mockups)).toEqual([[]]);
  });
});

describe("asksFromTasks", () => {
  const task = (over: Partial<Task>): Task => ({
    id: "tk_1", workspaceId: null, title: "t", runner: "claude", cwd: "/tmp", scope: [], status: "waiting", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard",
    resumeAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: NOW - 600_000, createdAt: NOW - 600_000, updatedAt: NOW - 60_000, ...over,
  }) as Task;
  const approval = (taskId: string, id: string, askedAt: number): PendingApproval => ({ taskId, taskTitle: "t", workspace: null, id, kind: "write", tool: "Write", input: {}, detail: `write ${id}`, askedAt });
  const taskStop = (taskId: string, over: Partial<StopSummary>) => stop({ key: `task:${taskId}\u0000${over.op ?? "op"}\u0000\u0000${over.reason ?? "decision"}\u0000`, work: { workspaceId: null, issue: null, taskId }, ...over });
  const build = (tasks: Task[], extra: { approvals?: PendingApproval[]; stops?: StopSummary[]; reply?: string } = {}) =>
    dedupeAsks(asksFromTasks({ approvals: extra.approvals ?? [], tasks, lastTurnQuestions: turnOf(extra.reply ?? null, ["A: はい"]), permissionEvents: () => [], stops: () => extra.stops ?? [], workspaceName: () => null, now: NOW }));

  test("a reply's text makes no check", () => {
    // the reply carries a `**確認**:` block but the turn asked no question tool question: nothing is asked of the person
    const reply = "PR を出しました。\n\n**確認**: PR #12 をマージしてよいか\n**選択肢**:\n- A: マージする\n- B: 待つ";
    const t = task({ outcome: "needs_action", status: "done" });
    const list = asksFromTasks({ approvals: [], tasks: [t], lastTurnQuestions: () => ({ questions: [], seq: 9, askedAt: null }), permissionEvents: () => [], stops: () => [], workspaceName: () => null, now: NOW });
    expect(reply).toContain("**確認**");
    expect(list.filter((a) => a.kind === "check")).toEqual([]);
    expect(build([t])).toEqual([]);
  });

  test("a question tool check reads nothing from the question's text: no place; the recommended option is only its label's mark", () => {
    const text = "PR #12 をマージしてよいか\n[聞く] セキュリティ: security:github（+40/-5）\n- [再チェック web] 未実施";
    const [check] = asksFromTasks({ approvals: [], tasks: [task({ outcome: "needs_action", status: "done" })], lastTurnQuestions: turnOf(text, [["A: 待つ", "x"], ["B: マージする (Recommended)", "CI が緑"]]), permissionEvents: () => [], stops: () => [], workspaceName: () => null, now: NOW });
    expect(check).toMatchObject({ kind: "check", question: text, place: null, recommendation: null, answers: ["questions"], policy: { scopes: [], note: null } });
    expect(check!.questions[0]!.options.map((o) => o.label)).toEqual(["A: 待つ", "B: マージする (Recommended)"]);
  });

  test("an old stop does not block a question tool check", () => {
    // a stop whose condition is not met, and a refusal of the runner: neither takes the options away
    const stops = [stop({ reason: "decision", op: "gh pr merge", conditions: [{ key: "ci", value: "success", met: false }] }), stop({ key: "perm", reason: "permission", op: "POST /api/x", target: "", evidence: "auto mode denied", next: "decide" })];
    const list = asksFromTasks({ approvals: [], tasks: [task({ outcome: "needs_action", status: "done" })], lastTurnQuestions: turnOf("続けるか", ["A", "B"]), permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW });
    const check = dedupeAsks(list).find((a) => a.kind === "check")!;
    expect(check).toMatchObject({ answers: ["questions"], blockers: [] });
  });

  test("a check waits on personWait: the Task's outcome decides it, not the stops it left", () => {
    const asked = (stops: StopSummary[]) => dedupeAsks(asksFromTasks({ approvals: [], tasks: [task({ outcome: "needs_action", status: "done" })], lastTurnQuestions: turnOf("続けるか", ["A", "B"]), permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW })).some((a) => a.kind === "check");
    expect(asked([])).toBe(true);
    const depends = (lastAt: number) => stop({ reason: "depends", next: "wait", lastAt, conditions: [{ key: "ci", value: "success", met: false }] });
    // the stop does not decide it: the outcome does (a Task that only waits on a condition is `waits`, no check)
    expect(asked([depends(NOW + 1_000)])).toBe(true);
    expect(dedupeAsks(asksFromTasks({ approvals: [], tasks: [task({ outcome: "waits", status: "done" })], lastTurnQuestions: turnOf("続けるか", ["A", "B"]), permissionEvents: () => [], stops: () => [depends(NOW + 1_000)], workspaceName: () => null, now: NOW })).some((a) => a.kind === "check")).toBe(false);
    // a Task that ended done asks nothing again, whatever stop it left
    const doneAsked = (stops: StopSummary[]) => dedupeAsks(asksFromTasks({ approvals: [], tasks: [task({ outcome: "finished", status: "done" })], lastTurnQuestions: turnOf("続けるか", ["A", "B"]), permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW })).some((a) => a.kind === "check");
    expect(doneAsked([stop({ reason: "decision", lastAt: NOW + 1_000 })])).toBe(false);
    expect(doneAsked([stop({ reason: "decision", lastAt: NOW + 1_000, answered: true, lastAnswer: { ref: "seq:9", at: NOW } })])).toBe(false);
  });

  test("a resumeAt in the past is the resume after an interruption, its condition met", () => {
    const at = NOW - 1_000;
    expect(build([task({ resumeAt: at })])).toMatchObject([{ kind: "stop", needs: "auto", reason: "transient: 中断からの自動再開待ち", conditions: [{ key: "resumeAt", met: true }] }]);
  });

  test("an answered approval is resolved once the Task's turn ended, also with a background process left", () => {
    const ts = NOW - 30_000;
    const events = [
      { taskId: "tk_1", ts: ts - 5_000, ev: { t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: {}, detail: "write p1" } },
      { taskId: "tk_1", ts, ev: { t: "permission.resolved", id: "p1", decision: "allow", by: "user" } },
    ] as unknown as EventEnvelope[];
    const stateOf = (status: Task["status"]) =>
      asksFromTasks({ approvals: [], tasks: [task({ status, updatedAt: ts + 1_000 })], lastTurnQuestions: turnOf(null), permissionEvents: () => events, stops: () => [], workspaceName: () => null, now: NOW }).find((a) => a.kind === "approval")?.state;
    expect(stateOf("done")).toBe("resolved");
    expect(stateOf("background")).toBe("resolved");
    expect(stateOf("running")).toBe("answered");
  });

  test("fold: a check and a person's stop go into the newest open approval with their conditions; two approvals stay two", () => {
    const t = task({ outcome: "needs_action", status: "done" });
    const stops = [taskStop(t.id, { reason: "input", conditions: [{ key: "answer", value: "none", met: false }] })];
    const asks = build([t], { approvals: [approval(t.id, "p1", NOW - 5_000), approval(t.id, "p2", NOW - 1_000)], stops, reply: "続けるか" });
    expect(asks.map((a) => a.id)).toEqual([`approval:${t.id}:p2`, `approval:${t.id}:p1`]);
    expect(asks[0]!.conditions).toEqual([{ key: "answer", value: "none", met: false }]);
  });

  test("fold: a person's stop goes into the check; a stop that waits by itself stays apart from the person's one", () => {
    const t = task({ outcome: "needs_action", status: "done" });
    const decide = taskStop(t.id, { op: "a", reason: "input", next: "decide" });
    const waits = taskStop(t.id, { op: "b", reason: "permission", next: "wait", conditions: [{ key: "pr#3", value: "open", met: false }] });
    const asks = build([t], { stops: [waits, decide], reply: "続けるか" });
    expect(asks.map((a) => `${a.kind}/${a.needs}`)).toEqual(["check/person", "stop/auto"]);
    expect(asks[0]!.question).toBe("続けるか");
  });

  test("fold: a stage Task's check before the answer goes into its Issue's answered decision; one after it stays", () => {
    const answeredAt = "2026-10-07T11:00:00Z";
    const pbi = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { id: "tk", status: "done", statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000, action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true } })], NOW);
    const before = task({ id: "tk_a", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", createdAt: Date.parse(answeredAt) - 120_000, updatedAt: Date.parse(answeredAt) - 60_000 });
    const after = task({ id: "tk_b", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", createdAt: Date.parse(answeredAt) - 90_000, updatedAt: Date.parse(answeredAt) + 60_000 });
    const fromTasks = asksFromTasks({ approvals: [], tasks: [before, after], lastTurnQuestions: turnOf("続けるか"), permissionEvents: () => [], stops: () => [], workspaceName: () => "switchboard", now: NOW });
    expect(dedupeAsks([...pbi, ...fromTasks]).map((a) => `${a.kind}/${a.state}/${a.task?.id ?? "-"}`)).toEqual(["check/open/tk_b", "decision/answered/-"]);
  });

  test("fold: the Issue of a stage Task comes from Task.stage, not its title", () => {
    const answeredAt = "2026-10-07T11:00:00Z";
    const pbi = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { id: "tk", status: "done", statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000, action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true } })], NOW);
    const at = { createdAt: Date.parse(answeredAt) - 120_000, updatedAt: Date.parse(answeredAt) - 60_000 };
    const renamed = task({ id: "tk_r", workspaceId: "ws_meta", title: "renamed", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", ...at });
    const plain = task({ id: "tk_p", workspaceId: "ws_meta", title: "#2 実装", stage: null, outcome: "needs_action", status: "done", ...at });
    const kinds = (t: Task) => dedupeAsks([...pbi, ...asksFromTasks({ approvals: [], tasks: [t], lastTurnQuestions: turnOf("続けるか"), permissionEvents: () => [], stops: () => [], workspaceName: () => "switchboard", now: NOW })]).map((a) => `${a.kind}/${a.state}`);
    expect(kinds(renamed)).toEqual(["decision/answered"]);
    expect(kinds(plain)).toEqual(["check/open", "decision/answered"]);
  });

  test("a stage Task's check is gone once a stage Task of the same Issue started after it stopped; another Issue's or workspace's does not count", () => {
    const old = task({ id: "tk_old", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", createdAt: NOW - 7_200_000, updatedAt: NOW - 3_600_000 });
    const next = task({ id: "tk_next", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, status: "running", createdAt: NOW - 600_000 });
    const other = task({ id: "tk_other", workspaceId: "ws_meta", title: "#3 実装", stage: { issue: 3, action: "complete" }, status: "running", createdAt: NOW - 600_000 });
    const build2 = (tasks: Task[]) => asksFromTasks({ approvals: [], tasks, lastTurnQuestions: turnOf("続けるか"), permissionEvents: () => [], stops: () => [], workspaceName: () => null, now: NOW }).map((a) => `${a.kind}/${a.task?.id}`);
    expect(build2([old, other])).toEqual(["check/tk_old"]);
    expect(build2([old, next])).toEqual([]);
    // one that started before the old one stopped (its check is newer), or in another workspace, does not count
    expect(build2([old, { ...next, createdAt: NOW - 5_400_000 }])).toEqual(["check/tk_old"]);
    expect(build2([old, { ...next, workspaceId: "ws_lib" }])).toEqual(["check/tk_old"]);
  });

  test("fold: the usage-limit wait and the usage-limit stop of a Task are one, the wait kept with both conditions", () => {
    const t = task({ resumeAt: NOW + 3_600_000 });
    const limit = taskStop(t.id, { reason: "usage-limit", next: "wait", conditions: [{ key: "resetsAt", value: "x", met: false }] });
    const asks = build([t], { stops: [limit] });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.id).toStartWith("resume:");
    expect(asks[0]!.conditions.map((c) => c.key)).toEqual(["resumeAt", "resetsAt"]);
  });
});

/* ---------- GET /api/asks: a fake runner and a fake gh, as the tests on api-test-harness.ts boot them ---------- */

const pages = (await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json()) as unknown[];
const decisions = (await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json()) as unknown;
const fakeGh: GhRunner = async (args) => {
  if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};

const CHECK_QS: AskQuestion[] = [{ header: null, question: "PR #12 をマージしてよいか\n[聞く] セキュリティ: security:github（+40/-5）", options: [{ label: "A: マージする (Recommended)", description: "CI が緑" }, { label: "B: 待つ", description: null }], multiSelect: false }];
const ASK: AgentEvent = { t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: { file_path: "/tmp/x" }, detail: "write x" };

/** A scripted runner (api-test-harness.ts's fakeAdapter, cut down): replays `script`, pausing on a permission.ask until it is answered; lingers after its turn. */
function runner(id: RunnerId, script: AgentEvent[]): RunnerAdapter {
  return {
    id,
    detect: async () => ({ available: true, version: "fake" }),
    start(_opts, emit) {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      let i = 0;
      let waitingFor: string | null = null;
      const pump = () => {
        while (i < script.length) {
          const ev = script[i++]!;
          if (ev.t === "permission.ask") waitingFor = ev.id;
          emit(ev);
          if (ev.t === "permission.ask") return;
        }
      };
      queueMicrotask(pump);
      return {
        send: (text) => {
          emit({ t: "message.delta", role: "user", text });
          i = 0;
          queueMicrotask(pump);
        },
        respondPermission: (pid, decision) => {
          if (waitingFor !== pid) throw new Error("unexpected permission id");
          waitingFor = null;
          emit({ t: "permission.resolved", id: pid, decision, by: "user" });
          queueMicrotask(pump);
        },
        abort: async () => resolveExit(null),
        close: async () => resolveExit(0),
        exited,
      } satisfies RunnerSession;
    },
  };
}

describe("GET /api/asks", () => {
  let core: CoreServer;
  let home: string;
  let base: string;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>); // eslint-disable-line @typescript-eslint/no-explicit-any
  const asks = async () => ((await fetch(`${base}/api/asks`).then((r) => r.json())) as AskList).asks;
  const until = async (ok: () => Promise<boolean>) => {
    for (let n = 0; n < 400 && !(await ok()); n++) await Bun.sleep(10);
  };
  const status = async (id: string) => core.db.getTask(id)!.status;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "sb-asks-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    const end = (summary: string): AgentEvent => ({ t: "session.end", status: "ok", summary });
    core = await startServer(cfg, [runner("claude", [ASK, { t: "message.delta", role: "assistant", text: "writing" }]), runner("codex", [{ t: "question.ask", id: "q0", questions: CHECK_QS }, end("PR を出しました。")])], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(fakeGh), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
    base = `http://127.0.0.1:${core.server.port}`;
    await until(async () => !((await fetch(`${base}/api/backlog`).then((r) => r.json())) as Backlog).syncs.some((s) => s.syncing));
  });
  afterEach(async () => {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  });

  /** A Task that asks for an approval (claude), or one that ends with an operational check, marked 要対応 (codex). */
  const approvalTask = async (title: string, workspaceId?: string) => {
    const t = await post("/api/tasks", { cwd: home, title, prompt: "write x", runner: "claude", ...(workspaceId ? { workspaceId } : {}) });
    await until(async () => (await status(t.id)) === "waiting");
    return t.id as string;
  };
  const checkTask = async (title: string, workspaceId?: string) => {
    const t = await post("/api/tasks", { cwd: home, title, prompt: "open the PR", runner: "codex", ...(workspaceId ? { workspaceId } : {}) });
    await until(async () => (await status(t.id)) !== "running");
    await post(`/api/tasks/${t.id}/outcome`, { outcome: "needs_action" });
    return t.id as string;
  };
  const meta = () => core.db.listWorkspaces().find((w) => w.kind === "meta")!;

  test("GET /api/asks: an approval, an operational check, the backlog's decision and confirmations are a person's open questions, each with its workspace and source", async () => {
    const a = await approvalTask("approve me", meta().id);
    const c = await checkTask("check me", meta().id);
    const list = await asks();
    // the meta checkout's origin is not the faked acme/app: that workspace's notice is not what this looks at
    const person = list.filter((x) => x.needs === "person" && x.state === "open" && x.kind !== "notice");
    expect(person.map((x) => x.kind).sort()).toEqual(["approval", "check", "confirmation", "confirmation", "decision"]);
    expect(person.find((x) => x.kind === "approval")).toMatchObject({ id: `approval:${a}:perm1`, question: "write x", route: "approval", task: { id: a, title: "approve me" }, source: { taskId: a } });
    expect(person.find((x) => x.kind === "check")).toMatchObject({ question: "PR #12 をマージしてよいか\n[聞く] セキュリティ: security:github（+40/-5）", questions: CHECK_QS, choices: [], place: null, recommendation: null, policy: { scopes: [], note: null }, route: "task", source: { taskId: c } });
    expect(person.find((x) => x.kind === "decision")).toMatchObject({ pbi: { number: 306 }, question: "保存先をどちらにするか", route: "backlog" });
    for (const x of person) expect(x.workspace).toEqual({ id: meta().id, name: meta().name });
    expect(person.find((x) => x.kind === "decision")!.source.url).toStartWith("https://github.com/acme/app/issues/");
  });

  test("GET /api/asks: each question carries unblocks and the Priority of its PBI", async () => {
    const backlog = (await fetch(`${base}/api/backlog`).then((r) => r.json())) as Backlog;
    const d = (await asks()).find((x) => x.kind === "decision" && x.pbi?.number === 306)!;
    expect(d.unblocks).toEqual([]);
    expect(d.priority).toBe(backlog.items.find((i) => i.number === 306)!.priority);
    for (const x of await asks()) expect(Array.isArray(x.unblocks)).toBe(true);
  });

  test("dedupe tasks: a Task's approval and its permission stop are one; a stage Task that wrote ## 判断待ち and ended 要対応 is the decision only", async () => {
    const a = await approvalTask("no issue");
    core.db.appendEvent(a, { t: "stop.record", stop: { id: "s1", work: { workspaceId: null, issue: null, taskId: a }, op: "Write", target: "/tmp/x", reason: "permission", evidence: "approval", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() } });
    const mine = (await asks()).filter((x) => x.task?.id === a);
    expect(mine.map((x) => x.kind)).toEqual(["approval"]);
    const c = await checkTask("#306 実装", meta().id);
    // the Issue is the Task's stage column, not its title
    expect((await asks()).filter((x) => x.task?.id === c)).toHaveLength(1);
    core.db.sqlite.query("UPDATE tasks SET stage_issue = 306, stage_action = 'complete', title = 'renamed' WHERE id = ?").run(c);
    const list = await asks();
    expect(list.filter((x) => x.task?.id === c)).toEqual([]);
    expect(list.filter((x) => x.kind === "decision" && x.pbi?.number === 306)).toHaveLength(1);
  });

  test("auto: a Task waiting for the usage limit to lift goes on by itself, its reason usage-limit", async () => {
    const c = await checkTask("limited");
    await post(`/api/tasks/${c}/outcome`, { reviewed: true });
    const at = Date.now() + 3_600_000;
    core.db.updateTask(c, { resumeAt: at });
    const [x] = (await asks()).filter((y) => y.task?.id === c);
    expect(x).toMatchObject({ kind: "stop", needs: "auto", state: "open", id: `resume:${c}@${at}`, conditions: [{ key: "resumeAt", value: new Date(at).toISOString(), met: false }] });
    expect(x!.reason).toStartWith("usage-limit");
  });

  test("answered approval: once allowed it stays as answered with the same id while the Task goes on, resolved once it ended", async () => {
    const a = await approvalTask("allow me");
    await post(`/api/tasks/${a}/permission`, { id: "perm1", decision: "allow" });
    await until(async () => (await status(a)) !== "waiting");
    const mine = async () => (await asks()).filter((x) => x.task?.id === a);
    expect(await mine()).toMatchObject([{ id: `approval:${a}:perm1`, kind: "approval", state: "answered", question: "write x", route: "task", answers: [], resume: { state: "running", taskId: a } }]);
    await post(`/api/tasks/${a}/abort`, {});
    await until(async () => (await status(a)) === "aborted");
    expect(await mine()).toMatchObject([{ id: `approval:${a}:perm1`, state: "resolved" }]);
  });

  test("question tool asks answered in one reply", async () => {
    const questions: AskQuestion[] = [
      { header: "場所", question: "どこを直すか", options: [{ label: "web", description: null }, { label: "core", description: "デーモン" }], multiSelect: false },
      { header: null, question: "何を足すか", options: [{ label: "テスト", description: null }, { label: "文書", description: null }], multiSelect: true },
    ];
    const script: AgentEvent[] = [{ t: "question.ask", id: "q1", questions }, { t: "session.end", status: "ok", summary: "Waiting for your choices" }];
    // what reaches the runner: the prompt of each start (after a restart the reply resumes the session)
    const prompts: string[] = [];
    const asking = runner("claude", script);
    const start = asking.start.bind(asking);
    asking.start = (opts, emit) => (prompts.push(opts.prompt), start(opts, emit));
    const boot = async () => {
      const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
      core = await startServer(cfg, [asking, runner("codex", [])], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(fakeGh), judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
      base = `http://127.0.0.1:${core.server.port}`;
    };
    await core.stop();
    await boot();
    const t = await post("/api/tasks", { cwd: home, title: "ask me", prompt: "ask two questions", runner: "claude" });
    await until(async () => (await status(t.id)) === "done");
    // the question tool's turn leaves the Task 要対応 at once, no judge
    expect(core.db.getTask(t.id)!.outcome).toBe("needs_action");
    const mine = async () => (await asks()).filter((x) => x.task?.id === t.id && x.state === "open");
    const [check] = await mine();
    expect(check).toMatchObject({ kind: "check", needs: "person", question: "どこを直すか", questions, choices: [], answers: ["questions"], route: "task" });
    // one answer for two questions, an option not offered, two options of a single choice: 409, nothing sent
    for (const answers of [[{ choices: ["web"] }], [{ choices: ["ui"] }, { choices: ["テスト"] }], [{ choices: ["web", "core"] }, { choices: ["テスト"] }]]) {
      const r = await fetch(`${base}/api/asks/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: check!.id, answer: { kind: "questions", answers } }) });
      expect(r.status).toBe(409);
    }
    // the daemon restarts: the same question, under the same id, from the events
    await core.stop();
    await boot();
    expect((await mine()).map((x) => [x.id, x.questions.length, x.answers])).toEqual([[check!.id, 2, ["questions"]]]);
    const r = await post("/api/asks/answer", { id: check!.id, answer: { kind: "questions", answers: [{ choices: ["core"] }, { choices: ["テスト", "文書"] }] } });
    expect(r.ask).toMatchObject({ id: check!.id, state: "answered" });
    // one reply with every answer reaches the runner, and the Task goes on
    await until(async () => core.db.listEvents(t.id).filter((e) => e.ev.t === "session.end").length === 2);
    expect(prompts).toEqual(["ask two questions", "- どこを直すか: core\n- 何を足すか: テスト, 文書"]);
    expect(core.db.listEvents(t.id).filter((e) => e.ev.t === "session.end")).toHaveLength(2);
  });
});

describe("question tool answer on any PR", () => {
  const ASKED = "a".repeat(40);
  const MOVED = "b".repeat(40);
  let core: CoreServer | null = null;
  let home = "";
  afterEach(async () => {
    await core?.stop();
    core = null;
    rmSync(home, { recursive: true, force: true });
  });

  test("question tool answer goes on whatever the PR", async () => {
    // a fake gh: the PR's head is not the one the [merge-ask] mark named
    const gh: GhRunner = async (args) =>
      args[0] === "pr" && args[1] === "view"
        ? { code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: MOVED, comments: [{ body: `[merge-ask] security ${ASKED}`, createdAt: new Date(Date.now() - 60_000).toISOString() }], commits: [] }), stderr: "" }
        : fakeGh(args, "");
    home = mkdtempSync(join(tmpdir(), "sb-asks-moved-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    const script: AgentEvent[] = [{ t: "question.ask", id: "q1", questions: CHECK_QS }, { t: "session.end", status: "ok", summary: "確認をお願いします" }];
    core = await startServer(cfg, [runner("claude", script), runner("codex", [])], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: () => null, gh: importing(gh), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
    const base = `http://127.0.0.1:${core.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (let n = 0; n < 400 && ((await fetch(`${base}/api/backlog`).then((r) => r.json())) as Backlog).syncs.some((s) => s.syncing); n++) await Bun.sleep(10);
    const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
    const t = (await (await post("/api/tasks", { cwd: home, title: "ask me", prompt: "open the PR", runner: "claude", workspaceId: meta.id })).json()) as Task;
    for (let n = 0; n < 400 && core.db.getTask(t.id)!.status !== "done"; n++) await Bun.sleep(10);
    const check = (((await fetch(`${base}/api/asks`).then((r) => r.json())) as AskList).asks).find((a) => a.kind === "check" && a.task?.id === t.id)!;
    expect(check).toMatchObject({ answers: ["questions"], place: null });
    const userTurns = () => core!.db.listEvents(t.id).filter((e) => e.ev.t === "message.delta" && e.ev.role === "user").length;
    // the PR's head is not the one the question named, and no gh read is needed: the option goes as one reply
    const r = await post("/api/asks/answer", { id: check.id, answer: { kind: "questions", answers: [{ choices: ["A: マージする (Recommended)"] }] } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ask: { state: string } }).ask.state).toBe("answered");
    for (let n = 0; n < 400 && userTurns() < 1; n++) await Bun.sleep(10);
    expect(userTurns()).toBe(1);
  });
});

describe("policy", () => {
  const DECIDE = "## 判断待ち\n**問い**: マージしてよいか\n**選択肢**:\n- A: マージする\n- B: 待つ\n**推奨**: A — CI が緑\n**止めた場所**: PR #12";
  const decisionStop = (over: Partial<StopSummary> = {}) => stop({ op: "gh pr merge", target: "PR #13", reason: "decision", firstAt: NOW - 10_800_000, conditions: [{ key: "area", value: "web", met: true }], ...over });
  const savedFrom: PolicySubject = { kind: "decision", op: "gh pr merge", target: "PR #12", conditions: [{ key: "area", value: "web" }], head: null };
  const saved = (over: Partial<AnswerPolicy> = {}): AnswerPolicy => ({
    id: "p1", scope: "repo", workspaceId: "ws_meta", pbi: null, askId: null, kind: "decision", op: "gh pr merge", target: "PR #12", when: [], answer: { kind: "choice", choice: "A: マージする" },
    expiresAt: NOW - 1000, revokedAt: null, createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000, from: savedFrom, uses: [], useCount: 0, firstUsedAt: null, ...over,
  });
  let ghCalls = 0;
  const env = (policies: AnswerPolicy[] = [], confirmHit: ApprovalRuleMatch | null = null) => ({
    policies,
    pbiOpen: () => true,
    approval: (a: PendingApproval) => ({ subject: a.kind === "exec" || a.kind === "write" ? ({ kind: "approval", op: a.kind, target: a.kind === "exec" ? String((a.input as { command: string }).command) : "src/a.ts", conditions: [], head: null } as PolicySubject) : null, confirmHit }),
    confirm: () => confirmHit,
  });
  const decide = (policies: AnswerPolicy[], stops: StopSummary[], confirmHit: ApprovalRuleMatch | null = null) =>
    asksFromBacklog([item({ number: 5, stage: "needs-decision", decision: { body: DECIDE, at: "2026-10-07T10:00:00Z", issue: 5 }, stopSummary: stops })], NOW, { policy: env(policies, confirmHit) })[0]!;
  const task = (over: Partial<Task>) =>
    ({ id: "tk_1", workspaceId: null, title: "t", runner: "claude", cwd: "/tmp", scope: [], status: "waiting", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard", resumeAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: NOW - 600_000, createdAt: NOW - 600_000, updatedAt: NOW - 60_000, ...over }) as Task;
  const fromTasks = (approvals: PendingApproval[], policies: AnswerPolicy[] = [], confirmHit: ApprovalRuleMatch | null = null, stops: StopSummary[] = [], tasks: Task[] = [task({})], reply: string | null = null) =>
    asksFromTasks({ approvals, tasks, lastTurnQuestions: turnOf(reply, ["A: はい", "B: いいえ"]), permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW, policy: env(policies, confirmHit) });
  const exec = (command: string, id = "p1"): PendingApproval => ({ taskId: "tk_1", taskTitle: "t", workspace: null, id, kind: "exec", tool: "Bash", input: { command }, detail: command, askedAt: NOW - 1000 });

  test("policy: subject — an exec approval is op exec and the command, a network one has none; a decision takes the newest series before it, head null, no GitHub call; a question tool check has none", () => {
    const [ok] = fromTasks([exec("bun test")]);
    expect(ok!.subject).toEqual({ kind: "approval", op: "exec", target: "bun test", conditions: [], head: null });
    const [net] = fromTasks([{ ...exec("x"), kind: "network" }]);
    expect(net!.subject).toBeNull();
    const old = decisionStop({ key: "old", target: "PR #1", firstAt: NOW - 14_400_000, conditions: [] });
    const newer = decisionStop({ key: "new" });
    const later = decisionStop({ key: "later", target: "PR #99", firstAt: Date.parse("2026-10-07T11:00:00Z") });
    ghCalls = 0;
    expect(decide([], [old, newer, later]).subject).toEqual({ kind: "decision", op: "gh pr merge", target: "PR #13", conditions: [{ key: "area", value: "web" }], head: null });
    expect(ghCalls).toBe(0);
    const check = fromTasks([], [], null, [decisionStop({ firstAt: NOW - 120_000 })], [task({ outcome: "needs_action" })], "続けるか")[0]!;
    // a question tool's check has no subject, whatever stop records the Task has
    expect(check).toMatchObject({ kind: "check", subject: null });
  });

  test("policy: scopes — a PBI's decision gives 3, no series once only with a note, a question tool check none; a permission stop or a confirm rule gives none", () => {
    const a = decide([], [decisionStop()]);
    expect(a.policy).toMatchObject({ scopes: ["once", "pbi", "repo"], note: null });
    expect(a.policy.defaults).toMatchObject({ target: "PR #13", when: [{ key: "area", value: "web" }], expiresAt: NOW + 30 * 86_400_000 });
    const t = fromTasks([], [], null, [decisionStop({ firstAt: NOW - 120_000 })], [task({ outcome: "needs_action" })], "続けるか")[0]!;
    // a question tool's check takes no policy: no scope, no note, not even for a stage Task's
    expect(t.policy).toMatchObject({ scopes: [], note: null, defaults: null });
    const staged = fromTasks([], [], null, [decisionStop({ firstAt: NOW - 120_000 })], [task({ outcome: "needs_action", workspaceId: "ws_meta", stage: { issue: 938, action: "complete" } })], "続けるか")[0]!;
    expect(staged.policy).toMatchObject({ scopes: [], note: null });
    expect(decide([], []).policy).toMatchObject({ scopes: ["once"], note: "操作と対象が記録されていないため、今回のみ" });
    const refused = asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask: stageTask(), stopSummary: [stop({ reason: "permission", evidence: "denied by the runner", next: "decide" })] })], NOW, { policy: env() })[0]!;
    expect(refused.policy).toMatchObject({ scopes: [], note: "ランナー側の拒否は保存した方針では解除できません", defaults: null });
    // a stage Task's stop (on an Issue) is answered by a reply in its conversation: no scope, no note, though a decision of a PBI takes three
    const stageStop = asksFromBacklog([item({ number: 5, stage: "in-progress", lastTask: stageTask(), stopSummary: [decisionStop()] })], NOW, { policy: env() })[0]!;
    expect(stageStop).toMatchObject({ kind: "stop", answers: ["text"], policy: { scopes: [], note: null, defaults: null } });
    const hit: ApprovalRuleMatch = { source: "rules/a.md", pattern: "bun*", mode: "confirm", subject: "bun test" };
    expect(fromTasks([exec("bun test")], [], hit)[0]!.policy).toMatchObject({ scopes: [], note: "都度確認のルール rules/a.md: bun* に当たります" });
  });

  test("policy: previous — an expired policy of the same op shows its answer, why and what changed; one that matches shows none", () => {
    const a = decide([saved()], [decisionStop()]);
    expect(a.policy.previous).toMatchObject({ id: "p1", answer: { kind: "choice" }, why: "期限切れ", changes: ["対象: PR #12 → PR #13"] });
    expect(decide([saved({ expiresAt: NOW + 1000, target: "PR #*" })], [decisionStop()]).policy.previous).toBeNull();
    expect(decide([], [decisionStop()]).policy.previous).toBeNull();
  });

  test("policy: applied — the policy whose uses name this question is shown", () => {
    const use = { at: NOW - 500, askId: "decision:ws_meta#5@2026-10-07T10:00:00Z", taskId: null, issue: 5, subject: savedFrom };
    const a = decide([saved({ expiresAt: NOW + 86_400_000, uses: [use] })], [decisionStop()]);
    expect(a.policy.applied).toMatchObject({ id: "p1", scope: "repo", at: NOW - 500 });
    expect(a.policy.applied!.summary).toContain("gh pr merge PR #12");
    expect(decide([], [decisionStop()]).policy.applied).toBeNull();
  });
});

describe("approvalBatches", () => {
  const task = (id: string, over: Partial<Task> = {}): Task =>
    ({ id, workspaceId: null, title: `title ${id}`, runner: "claude", cwd: "/tmp", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard", resumeAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "needs_action", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: NOW - 600_000, createdAt: NOW - 600_000, updatedAt: NOW - 60_000, ...over }) as Task;
  const rec = (t: Task, over: Partial<StopRecord>): StopRecord => ({ id: `${t.id}/x`, work: { workspaceId: t.workspaceId, issue: null, taskId: t.id }, op: "op", target: "", reason: "decision", evidence: "e", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", grant: null, at: NOW - 60_000, ...over });
  const sso = (t: Task, at: number, over: Partial<StopRecord> = {}) => rec(t, { id: `${t.id}/sso`, op: "aws sso login", reason: "auth", at, ...over });

  test("groups sso and deploy stops across tasks", () => {
    const a = task("tk_a", { workspaceId: "ws_1", createdAt: NOW - 900_000 });
    const b = task("tk_b", { workspaceId: "ws_2", createdAt: NOW - 800_000 });
    const c = task("tk_c", { workspaceId: "ws_3", createdAt: NOW - 700_000 });
    const d = task("tk_d", { workspaceId: "ws_1", createdAt: NOW - 600_000 });
    const [e, f, g, h] = [task("tk_e"), task("tk_f", { status: "running" }), task("tk_g"), task("tk_h")];
    const entries = [
      // reported again with a grant: the same stop since NOW - 30_000, its question the one of its present grant
      { task: c, records: [rec(c, { op: "POST /api/daemon/promote", target: "main", reason: "permission", at: NOW - 30_000 }), rec(c, { op: "POST /api/daemon/promote", target: "main", reason: "permission", grant: "main を昇格することだけ許可します", at: NOW - 20_000 })] },
      { task: b, records: [sso(b, NOW - 40_000)] },
      // the newest stop counts: a's login came after its merge question
      { task: a, records: [rec(a, { id: "tk_a/m", op: "gh pr merge", target: "PR #1", at: NOW - 90_000 }), sso(a, NOW - 50_000)] },
      // not waiting on the person: a merge refusal (not a deploy), a login answered by a reply, a running Task, a resolved one
      { task: d, records: [rec(d, { op: "gh pr merge", target: "PR #2", reason: "permission" })] },
      { task: e, records: [sso(e, NOW - 9_000), sso(e, NOW - 8_000, { answer: { ref: "seq:3", at: NOW - 8_000 } })] },
      { task: f, records: [sso(f, NOW)] },
      { task: g, records: [sso(g, NOW - 9_000), sso(g, NOW, { state: "resolved" })] },
      // a login stop and a newer one resolved: went on past it; a login "answered" by a runner's comment URL still waits;
      // a Task waiting on a tool approval is sent nothing
      { task: task("tk_i"), records: [sso(task("tk_i"), NOW - 9_000), rec(task("tk_i"), { id: "tk_i/y", op: "gh api", state: "resolved", at: NOW - 5_000 })] },
      { task: task("tk_j", { createdAt: NOW - 650_000 }), records: [sso(task("tk_j"), NOW - 9_000, { answer: { ref: "https://github.com/o/r/issues/1#issuecomment-2", at: NOW - 9_000 } })] },
      { task: task("tk_k", { status: "waiting" }), records: [sso(task("tk_k"), NOW)] },
      // stopped on the login again after the answer: a new stop, carrying the earlier answer (recordStop), unanswered
      { task: h, records: [sso(h, NOW - 9_000, { answer: { ref: "seq:3", at: NOW - 8_000 } }), sso(h, NOW - 5_000, { id: "tk_h/sso2", answer: { ref: "seq:3", at: NOW - 8_000 } })] },
      // a login still waiting, but the Task's outcome says the person is not wanted (finished, or only waits): no batch
      { task: task("tk_l", { outcome: "finished" }), records: [sso(task("tk_l"), NOW - 9_000)] },
      { task: task("tk_m", { outcome: "waits" }), records: [sso(task("tk_m"), NOW - 9_000)] },
    ];
    const asks = dedupeAsks(entries.flatMap((x) => asksFromTasks({ approvals: [], tasks: [x.task], lastTurnQuestions: turnOf(null), permissionEvents: () => [], stops: () => reduceStops(x.records), workspaceName: (id) => id, now: NOW })));
    const batches = approvalBatches(entries, asks);
    expect(batches.map((x) => x.id)).toEqual(["batch:sso", "batch:deploy"]);
    // oldest Task first, across workspaces; each one's question as listed (a needs_action Task with no question tool question has no check, so its stop stays its own)
    expect(batches[0]!.asks).toEqual([
      { askId: `stop:task:tk_a|aws sso login||auth|@${NOW - 50_000}`, taskId: "tk_a", title: "title tk_a", workspaceId: "ws_1", op: "aws sso login", at: NOW - 50_000 },
      { askId: `stop:task:tk_b|aws sso login||auth|@${NOW - 40_000}`, taskId: "tk_b", title: "title tk_b", workspaceId: "ws_2", op: "aws sso login", at: NOW - 40_000 },
      { askId: `stop:task:tk_j|aws sso login||auth|@${NOW - 9_000}`, taskId: "tk_j", title: "title tk_j", workspaceId: null, op: "aws sso login", at: NOW - 9_000 },
      // asked and answered before
      { askId: `stop:task:tk_h|aws sso login||auth|@${NOW - 5_000}`, taskId: "tk_h", title: "title tk_h", workspaceId: null, op: "aws sso login", at: NOW - 5_000 },
    ]);
    expect(batches[1]!.asks).toEqual([{ askId: `stop:task:tk_c|POST /api/daemon/promote|main|permission|@${NOW - 20_000}`, taskId: "tk_c", title: "title tk_c", workspaceId: "ws_3", op: "POST /api/daemon/promote", at: NOW - 30_000 }]);
    // each names its stop's question as listed, whose id carries the time the stop took its present content
    expect(batches.flatMap((x) => x.asks).map((x) => asks.find((q) => q.id === x.askId)?.task?.id)).toEqual(["tk_a", "tk_b", "tk_j", "tk_h", "tk_c"]);
    // a kind with no Task has no batch
    expect(approvalBatches(entries.slice(1, 3), asks).map((x) => x.kind)).toEqual(["sso"]);
    expect(approvalBatches([], [])).toEqual([]);
  });
});

describe("noticeAsks", () => {
  const ws = { id: "ws_1", name: "app" };
  const why = "origin は acme/app、登録は acme/app-dev です。登録のリポジトリの clone にする（`git remote set-url origin https://github.com/acme/app-dev.git` など）まで Task を起動しません";
  test("noticeAsks: what a work machine put and was not taken in is told once per machine — open with the keys and reasons, closed by dismiss for those objects, open again only for a new one", () => {
    const t0 = 1_000_000;
    const a1 = { machine: "pc1", key: "uplink/pc1/pc1-2.tar.zst", reason: "its name is not a delta of this machine" };
    const first = noticeAsks({ unusable: [], refused: [a1], now: t0 }, {});
    expect(first.asks).toEqual([expect.objectContaining({ id: `notice:uplink-refused:pc1@${t0}`, kind: "notice", needs: "person", state: "open", question: "作業場 pc1 から届いたもの 1 件を取り込まなかった", reason: "uplink/pc1/pc1-2.tar.zst: its name is not a delta of this machine", answers: ["dismiss"] })]);
    // read again: the same notice, nothing written
    const again = noticeAsks({ unusable: [], refused: [a1], now: t0 + 1000 }, first.record);
    expect(again.record).toBe(first.record);
    // the person closed it (what the answer route writes): the same object is not told again
    const key = "uplink-refused:pc1";
    const closed = { ...again.record, [key]: { ...again.record[key]!, dismissed: closedHits(again.record[key]!), closed: true, resolvedAt: t0 + 2000 } };
    const quiet = noticeAsks({ unusable: [], refused: [a1], now: t0 + 3000 }, closed);
    expect(quiet.asks).toEqual([]);
    expect(quiet.record).toBe(closed);
    // a new refusal of that machine: told, with only the new object
    const a2 = { machine: "pc1", key: "backlog/pc1/000000000007.json", reason: "pc1 is not registered for acme/secret" };
    const more = noticeAsks({ unusable: [], refused: [a1, a2], now: t0 + 4000 }, quiet.record);
    expect(more.asks).toEqual([expect.objectContaining({ state: "open", question: "作業場 pc1 から届いたもの 1 件を取り込まなかった", reason: "backlog/pc1/000000000007.json: pc1 is not registered for acme/secret" })]);
  });

  test("noticeAsks: a host CLI version not put in is told per runner with the reason in words — closed by dismiss for that version, open again for a newer one, resolved once one went in", () => {
    const t0 = 1_000_000;
    const c1 = { runner: "claude", version: "2.5.0", reason: "mismatch: 2.5.0: the checksum for linux-arm64 is not a sha256", current: "2.4.0", at: t0 };
    const first = noticeAsks({ unusable: [], cliRefused: [c1], now: t0 }, {});
    expect(first.asks).toEqual([expect.objectContaining({ id: `notice:cli:claude@${t0}`, kind: "notice", needs: "person", state: "open", question: "claude 2.5.0 を入れませんでした（checksum が配布元と合わない）", reason: "checksum が配布元と合わない: 2.5.0: the checksum for linux-arm64 is not a sha256\n拒んだときの版: 2.4.0", answers: ["dismiss"] })]);
    expect(first.asks[0]!.next).toContain("新しい版が通れば自動で入り、この知らせは解消済みになる");
    // a reason in words already (not one of the four codes) is shown as it is
    expect(noticeAsks({ unusable: [], cliRefused: [{ ...c1, reason: "置けなかった: disk full" }], now: t0 }, {}).asks[0]!.reason).toBe("置けなかった: disk full\n拒んだときの版: 2.4.0");
    const again = noticeAsks({ unusable: [], cliRefused: [c1], now: t0 + 1000 }, first.record);
    expect(again.record).toBe(first.record);
    // closed: the same version is not told again
    const key = "cli:claude";
    const closed = { ...again.record, [key]: { ...again.record[key]!, dismissed: closedHits(again.record[key]!), closed: true, resolvedAt: t0 + 2000 } };
    const quiet = noticeAsks({ unusable: [], cliRefused: [c1], now: t0 + 3000 }, closed);
    expect(quiet.asks).toEqual([]);
    expect(quiet.record).toBe(closed);
    // a newer version refused: open again
    const more = noticeAsks({ unusable: [], cliRefused: [{ ...c1, version: "2.6.0", at: t0 + 4000 }], now: t0 + 4000 }, quiet.record);
    expect(more.asks).toEqual([expect.objectContaining({ state: "open", question: "claude 2.6.0 を入れませんでした（checksum が配布元と合わない）" })]);
    // one went in after it (the caller leaves the refusal out): resolved, shown for a day; a closed one just goes
    const gone = noticeAsks({ unusable: [], now: t0 + 5000 }, more.record);
    expect(gone.asks).toEqual([expect.objectContaining({ state: "resolved", question: "claude 2.6.0 を入れませんでした（checksum が配布元と合わない）", answers: [] })]);
    expect(noticeAsks({ unusable: [], now: t0 + 6000 }, closed).asks).toEqual([]);
    // a refusal before the name could be read ("unknown") closed for one reason does not hide one for another reason
    const u1 = { runner: "claude", version: "unknown", reason: "not-official: https://evil.example/x is not on an official host", current: "2.4.0", at: t0 };
    const u = noticeAsks({ unusable: [], cliRefused: [u1], now: t0 }, {});
    const uClosed = { ...u.record, [key]: { ...u.record[key]!, dismissed: closedHits(u.record[key]!), closed: true, resolvedAt: t0 + 1 } };
    expect(noticeAsks({ unusable: [], cliRefused: [u1], now: t0 + 2 }, uClosed).asks).toEqual([]);
    expect(noticeAsks({ unusable: [], cliRefused: [{ ...u1, reason: "withdrawn: gone" }], now: t0 + 3 }, uClosed).asks).toEqual([expect.objectContaining({ state: "open", question: "claude unknown を入れませんでした（配布元が取り下げた）" })]);
  });

  test("noticeAsks: an unusable workspace is open until it is fixed, then resolved", () => {
    const t0 = 1_000_000;
    const first = noticeAsks({ unusable: [{ workspace: ws, why }], now: t0 }, {});
    expect(first.asks).toHaveLength(1);
    const a = first.asks[0]!;
    expect(a).toMatchObject({ id: "notice:workspace:ws_1", kind: "notice", needs: "person", state: "open", at: t0, changedAt: t0, workspace: ws, question: "workspace app を使えません", route: "none", answers: [] });
    expect(a.source.label).toBe("workspace の検査");
    expect(a.reason).toBe("origin は acme/app、登録は acme/app-dev です。");
    expect(a.next).toStartWith("登録のリポジトリの clone にする");
    // read again, still broken: the first sight is kept and nothing is written
    const again = noticeAsks({ unusable: [{ workspace: ws, why }], now: t0 + 5000 }, first.record);
    expect(again.record).toBe(first.record);
    expect(again.asks[0]).toMatchObject({ state: "open", at: t0 });
    // fixed: resolved with no answer, the question still readable
    const fixed = noticeAsks({ unusable: [], now: t0 + 9000 }, again.record);
    expect(fixed.asks[0]).toMatchObject({ id: "notice:workspace:ws_1", state: "resolved", at: t0, changedAt: t0 + 9000, question: "workspace app を使えません", answers: [] });
    expect(noticeAsks({ unusable: [], now: t0 + 10_000 }, fixed.record).record).toBe(fixed.record);
    // a day after it was fixed it drops off
    const later = noticeAsks({ unusable: [], now: t0 + 9000 + ASK_HISTORY_MS + 1 }, fixed.record);
    expect(later.asks).toEqual([]);
    expect(later.record).toEqual({});
  });

  test("noticeAsks: broken again after a fix is a new notice", () => {
    const fixed = noticeAsks({ unusable: [], now: 2000 }, noticeAsks({ unusable: [{ workspace: ws, why }], now: 1000 }, {}).record);
    const back = noticeAsks({ unusable: [{ workspace: ws, why }], now: 3000 }, fixed.record);
    expect(back.asks[0]).toMatchObject({ state: "open", at: 3000, changedAt: 3000 });
  });

  const scan = (at: number, lines: string[]) => ({ schedule: { id: "sch_1", title: "認証の検査" }, result: { at, repos: 1, hits: lines.filter((l) => l.startsWith("  ")).length, failed: 0, lines } });
  const hit = ["o/a: 当たり 1 件（scanned 3）", "  https://github.com/o/a/issues/1: github-token（2 行目）"];
  test("noticeAsks: a schedule's notice belongs to the schedule's workspace (meta), a workspace's to that workspace", () => {
    const meta = { id: "ws_meta", name: "switchboard" };
    const r = noticeAsks(
      {
        unusable: [{ workspace: ws, why }],
        scans: [{ ...scan(10, hit), workspace: meta }],
        windows: [{ schedule: { id: "sch_w", title: "承認待ち" }, workspace: meta, note: { title: "SSO・配備の承認待ち: 1", body: "x" } }],
        now: 100,
      },
      {},
    );
    expect(r.asks.map((a) => [a.id.split("@")[0], a.workspace])).toEqual([
      ["notice:workspace:ws_1", ws],
      ["notice:scan:sch_1", meta],
      ["notice:approval-window:sch_w", meta],
    ]);
  });

  test("noticeAsks: a scan hit is open, dismissed stays closed for the same hits, comes back for new ones, resolves when clean", () => {
    const first = noticeAsks({ unusable: [], scans: [scan(10, hit)], now: 100 }, {});
    expect(first.asks).toHaveLength(1);
    expect(first.asks[0]).toMatchObject({ id: "notice:scan:sch_1@100", kind: "notice", state: "open", answers: ["dismiss"], workspace: null, question: "認証の値の検査: 当たり 1 件 / 検査できなかった 0 リポジトリ", reason: "https://github.com/o/a/issues/1: github-token（2 行目）", source: { label: "予定「認証の検査」" } });
    // the next firing with the same hit: the same question
    expect(noticeAsks({ unusable: [], scans: [scan(20, hit)], now: 200 }, first.record).asks[0]!.id).toBe("notice:scan:sch_1@100");
    // dismissed (what the answer writes): the same hit does not come back
    const key = Object.keys(first.record)[0]!;
    const dismissed = { ...first.record, [key]: { ...first.record[key]!, dismissed: first.record[key]!.fingerprint, closed: true, resolvedAt: 150 } };
    expect(noticeAsks({ unusable: [], scans: [scan(20, hit)], now: 200 }, dismissed).asks).toEqual([]);
    // a new hit: a new question
    const more = [...hit, "  https://github.com/o/a/issues/2: aws-key（1 行目）"];
    // a new hit next to the closed one: only the new one shows
    const back = noticeAsks({ unusable: [], scans: [scan(30, more)], now: 300 }, dismissed);
    expect(back.asks[0]).toMatchObject({ id: "notice:scan:sch_1@300", state: "open", question: "認証の値の検査: 当たり 1 件 / 検査できなかった 0 リポジトリ", reason: "https://github.com/o/a/issues/2: aws-key（1 行目）" });
    // clean: resolved, no answer left
    const clean = noticeAsks({ unusable: [], scans: [scan(40, ["o/a: 0 件（scanned 3）"])], now: 400 }, back.record);
    expect(clean.asks[0]).toMatchObject({ id: "notice:scan:sch_1@300", state: "resolved", changedAt: 400, answers: [] });
    // a firing that failed as a whole (the scheduler's line) is a notice too
    const failedRun = noticeAsks({ unusable: [], scans: [scan(50, ["検査が失敗した（Error。理由は scan_issues.sh を手で走らせて見る）"])], now: 500 }, {});
    expect(failedRun.asks[0]).toMatchObject({ state: "open", question: "認証の値の検査: 当たり 0 件 / 検査できなかった 1 リポジトリ" });
    // so is a firing with no meta workspace to run the kit from (the scheduler's own line)
    expect(noticeAsks({ unusable: [], scans: [scan(60, ["meta workspace がない（共通キットの scan-issues を呼べない）"])], now: 600 }, {}).asks).toHaveLength(1);
    // a dismissed hit does not come back when a repository fails alongside it; the failure alone shows, with no dismiss
    const down = "o/x: 検査できなかった（exit 2）";
    const withFail = noticeAsks({ unusable: [], scans: [scan(70, [...hit, down])], now: 700 }, dismissed);
    expect(withFail.asks[0]).toMatchObject({ state: "open", question: "認証の値の検査: 当たり 0 件 / 検査できなかった 1 リポジトリ", reason: down, answers: [] });
    // the failure gone, the closed hit still there: the failure's notice is resolved, the hit stays closed
    const recovered = noticeAsks({ unusable: [], scans: [scan(80, hit)], now: 800 }, withFail.record);
    expect(recovered.asks).toMatchObject([{ state: "resolved", changedAt: 800, answers: [] }]);
    expect(noticeAsks({ unusable: [], scans: [scan(90, hit)], now: 800 + ASK_HISTORY_MS + 1 }, recovered.record).asks).toEqual([]);
    // two hits closed together: one of them alone later stays closed (each hit is remembered)
    const two = noticeAsks({ unusable: [], scans: [scan(10, more)], now: 1000 }, {});
    const k2 = Object.keys(two.record)[0]!;
    const closedTwo = { ...two.record, [k2]: { ...two.record[k2]!, dismissed: closedHits(two.record[k2]!), closed: true, resolvedAt: 1001 } };
    expect(noticeAsks({ unusable: [], scans: [scan(20, hit)], now: 1100 }, closedTwo).asks).toEqual([]);
    // dismissed, then clean: nothing to show, the record is dropped
    expect(noticeAsks({ unusable: [], scans: [scan(40, ["o/a: 0 件（scanned 3）"])], now: 400 }, dismissed)).toEqual({ asks: [], record: {} });
  });
});

describe("prFacts", () => {
  const HEAD = "c".repeat(40);
  const ASKED_AT = Date.parse("2026-10-07T12:00:00Z");
  const view = (v: object): GhRunner => async () => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });

  test("prFacts gives up past the time limit", async () => {
    // a gh that never answers: the read ends at the limit, with the PR's number in what it says
    const never: GhRunner = () => new Promise(() => undefined);
    const began = Date.now();
    await expect(prFacts(never, "/", "o/r", 12, ASKED_AT, [], 50)).rejects.toThrow("gh pr view 12: 0.05 秒で応答がありません");
    expect(Date.now() - began).toBeLessThan(2000);
    // one that answers in time is read as before
    expect(await prFacts(view({ state: "OPEN", headRefOid: HEAD, commits: [] }), "/", "o/r", 12, ASKED_AT, [], 50)).toEqual({ head: HEAD, mergeAsk: null, judged: false, changes: [] });
  });

  test("prFacts throws on a reply without a head", async () => {
    // a verdict before the question names a head, and the reply has none: not known, said with the PR's number
    const gates = [{ head: "a".repeat(40), startedAt: ASKED_AT - 60_000, ask: ["security:gates"], recheck: [] }];
    await expect(prFacts(view({ state: "OPEN", commits: [] }), "/", "o/r", 12, ASKED_AT, gates)).rejects.toThrow("gh pr view 12: head がありません");
    await expect(prFacts(view({ state: "OPEN", headRefOid: null, commits: [] }), "/", "o/r", 12, ASKED_AT, gates)).rejects.toThrow("gh pr view 12: head がありません");
    await expect(prFacts(view({ state: "OPEN", headRefOid: "abc", commits: [] }), "/", "o/r", 12, ASKED_AT, [])).rejects.toThrow("gh pr view 12: head がありません");
  });

  test("the kinds a merge question asks about come from the gate's judgement of the head, not from a PR comment", async () => {
    const OLD = "a".repeat(40);
    const asked: string[][] = [];
    const gh: GhRunner = async (args) => (asked.push(args), { code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: HEAD, commits: [], comments: [{ body: `[merge-ask] size ${HEAD}`, createdAt: new Date(ASKED_AT - 1).toISOString() }] }), stderr: "" });
    // the newest verdict of the head now: its ask then its recheck kinds; an older head's verdict is not this head's
    const gates = [{ head: OLD, startedAt: ASKED_AT - 120_000, ask: ["migration"], recheck: [] }, { head: HEAD, startedAt: ASKED_AT - 60_000, ask: ["security:gates"], recheck: ["size"] }];
    expect(await prFacts(gh, "/", "o/r", 12, ASKED_AT, gates)).toEqual({ head: HEAD, mergeAsk: "security:gates,size", judged: true, changes: [] });
    // a `[merge-ask]` comment alone is no judgement: the kinds are not known
    expect(await prFacts(gh, "/", "o/r", 12, ASKED_AT, [])).toMatchObject({ mergeAsk: null, judged: false });
    // the PR's comments are not asked of GitHub
    expect(asked.every((a) => !a.join(" ").includes("comments"))).toBe(true);
    // the question was asked at another head's verdict: the PR moved since
    expect((await prFacts(gh, "/", "o/r", 12, ASKED_AT, gates.slice(0, 1))).changes).toEqual([`PR #12 の差分が変わりました（${OLD.slice(0, 7)} → ${HEAD.slice(0, 7)}）`]);
  });

  test("gateRecordsOf reads the gate jobs' judgements of a PR, oldest first, by the repository as the jobs record it", () => {
    const job = (id: number, over: object) => ({ id, kind: "gate", pr: 12, startedAt: id, result: null, ...over }) as never;
    const own = [job(1, { result: { gate: { head: HEAD.toUpperCase(), ask: ["size"], recheck: [] } } }), job(2, { kind: "review", result: { gate: { head: HEAD, ask: [], recheck: [] } } }), job(3, {}), job(4, { result: { gate: { head: HEAD, ask: [], recheck: ["size"] } } })];
    const db = { jobsOf: (repo: string, prs: number[]) => (repo === "o/r" && prs[0] === 12 ? own : []), jobsSince: (repo: string) => (repo === "o/r" ? own : []) };
    expect(gateRecordsOf(db, "O/R", 12, 0)).toEqual([{ head: HEAD, startedAt: 1, ask: ["size"], recheck: [] }, { head: HEAD, startedAt: 4, ask: [], recheck: ["size"] }]);
  });

  test("gateRecordsOf gives each PR of a stack's verdict its own entry: a lower PR's is in the top PR's job, the top PR's is its own entry, not the stack's union", () => {
    const LOW = "d".repeat(40);
    const stack = { pr: 13, kind: "gate", id: 7, startedAt: 7, result: { gate: { head: HEAD, ask: ["security:gates", "migration"], recheck: ["size"], stack: [{ pr: 12, head: LOW, ask: ["migration"], recheck: [] }, { pr: 13, head: HEAD, ask: ["security:gates"], recheck: ["size"] }] } } } as never;
    const db = { jobsOf: (_: string, prs: number[]) => (prs[0] === 13 ? [stack] : []), jobsSince: () => [stack] };
    expect(gateRecordsOf(db, "o/r", 12, 0)).toEqual([{ head: LOW, startedAt: 7, ask: ["migration"], recheck: [] }]);
    expect(gateRecordsOf(db, "o/r", 13, 0)).toEqual([{ head: HEAD, startedAt: 7, ask: ["security:gates"], recheck: ["size"] }]);
    // a PR the stack does not name has none of it
    expect(gateRecordsOf(db, "o/r", 14, 0)).toEqual([]);
  });
});

describe("questionsChosen", () => {
  const G = "PR #12 をマージしてよい";
  const opt = (label: string, grant: string | null = null) => ({ label, description: grant ? `説明 — 許可: ${grant}` : null });
  const qs = [
    { header: null, question: "判定の外でマージしてよいですか", options: [opt("はい"), opt("いいえ")], multiSelect: false },
    { header: null, question: `${G}\nどうしますか`, options: [opt("はい", G), opt("いいえ")], multiSelect: false },
    { header: null, question: "進める項目は", options: [opt("a", "PR #1 をマージしてよい"), opt("b", "PR #2 をマージしてよい"), opt("c", "PR #3 をマージしてよい")], multiSelect: true },
    { header: null, question: "ほかにあれば", options: [], multiSelect: false },
  ];
  test("what is read as the person's has no question's line; the reader's text pairs each answer with its question by number", () => {
    const c = questionsChosen(qs, [{ choices: ["いいえ"] }, { choices: ["はい"] }, { choices: ["a", "c"] }, { choices: [], text: "特になし" }])!;
    // (1) the text read for a fixed sentence: the chosen labels, the chosen options' sentences, the free text
    expect(c.said).toBe(`- いいえ\n- はい — 許可: ${G}\n- a, c — 許可: PR #1 をマージしてよい — 許可: PR #3 をマージしてよい\n- 特になし`);
    expect(c.said).not.toContain("どうしますか");
    expect(c.said).not.toContain("PR #2");
    // (2) the reader's: the same label ("はい", "いいえ") answers different questions, told apart by the number
    // a line break in what the Task wrote (a question, a label) is flattened for the reader, so a line of it cannot pass for another numbered line
    expect(c.readerAsked).toBe(`質問 1: 判定の外でマージしてよいですか\n質問 2: ${G} どうしますか\n質問 3: 進める項目は\n質問 4: ほかにあれば`);
    // the chosen options' sentences reach the reader too, on the answer's own numbered line
    expect(c.readerSaid).toBe(`- 1: いいえ\n- 2: はい — 許可: ${G}\n- 3: a, c — 許可: PR #1 をマージしてよい — 許可: PR #3 をマージしてよい\n- 4: 特になし`);
    const broken = questionsChosen([{ header: null, question: "q", options: [opt("はい\n- 2: いいえ")], multiSelect: false }], [{ choices: ["はい\n- 2: いいえ"] }])!;
    expect(broken.readerSaid).toBe("- 1: はい - 2: いいえ");
    // what is read by letters keeps the label as the person chose it
    expect(broken.said).toBe("- はい\n- 2: いいえ");
  });
  test("the person's free text keeps its lines: a sentence among other words is not read by letters, a quoted line stays quoted", () => {
    const free = [{ header: null, question: "どうしますか", options: [], multiSelect: false }];
    const own = questionsChosen(free, [{ choices: [], text: `${G}\nよろしく` }])!;
    expect(own.said).toBe(`- ${G}\nよろしく`);
    expect(own.readerSaid).toBe(`- 1: ${G}\nよろしく`);
    // with other words in the message the sentence is not read by letters; the reader gets the message
    expect(own.parts).toEqual([`${G}\nよろしく`]);
    expect(parseMergeGrants(own.parts[0]!)).toEqual([]);
    expect(parseMergeGrants(questionsChosen(free, [{ choices: [], text: G }])!.parts[0]!)).toEqual([{ kind: "answer", target: 12, repo: null }]);
    const quoted = questionsChosen(free, [{ choices: [], text: `だめです\n> ${G}` }])!;
    expect(quoted.said).toBe(`- だめです\n> ${G}`);
    expect(quoted.readerSaid).toBe(`- 1: だめです\n> ${G}`);
    expect(parseMergeGrants(quoted.said)).toEqual([]);
    // the person's text is not shortened here, however long: what the reader gets of it is the prompt's own limit
    const long = `${"説明です。".repeat(190)}これでマージして構いません`;
    expect(questionsChosen(free, [{ choices: [], text: long }])!.readerSaid).toBe(`- 1: ${long}`);
    // a quote on the first line too: the answer's own prefix does not hide it
    const first = questionsChosen(free, [{ choices: [], text: `> ${G}\nこれは違います` }])!;
    expect(first.said).toBe(`-\n> ${G}\nこれは違います`);
    expect(first.readerSaid).toBe(`- 1:\n> ${G}\nこれは違います`);
    expect(parseMergeGrants(first.said)).toEqual([]);
  });
  test("the sentences read by letters come as a structure: the chosen options' grants, then each free text as a message of its own", () => {
    const c = questionsChosen(qs, [{ choices: ["いいえ"] }, { choices: ["はい"] }, { choices: ["a", "c"] }, { choices: [], text: `条件\nx — 許可: ${G}` }])!;
    expect(c.parts).toEqual([G, "PR #1 をマージしてよい", "PR #3 をマージしてよい", `条件\nx — 許可: ${G}`]);
  });
  test("the free texts of one submission are one message: any word that is not a fixed sentence keeps the sentences among them from being read by letters", () => {
    const free = (question: string) => ({ header: null, question, options: [], multiSelect: false });
    const yesNo = { header: null, question: "進めるか", options: [opt("はい", G), opt("いいえ")], multiSelect: false };
    const two = questionsChosen([free("条件"), free("入力"), yesNo], [{ choices: [], text: "CI が緑になってから" }, { choices: [], text: G }, { choices: ["いいえ"] }])!;
    expect(two.parts).toEqual([`CI が緑になってから\n${G}`]);
    expect(parseMergeGrants(two.parts[0]!)).toEqual([]);
    const alone = questionsChosen([free("入力"), yesNo], [{ choices: [], text: G }, { choices: ["いいえ"] }])!;
    expect(alone.parts.flatMap((p) => parseMergeGrants(p))).toEqual([{ kind: "answer", target: 12, repo: null }]);
    // a chosen option's sentence is a part of its own: a memo of another question does not take it away
    const chosen = questionsChosen([free("メモ"), yesNo], [{ choices: [], text: "あとでメモ" }, { choices: ["はい"] }])!;
    expect(chosen.parts).toEqual([G, "あとでメモ"]);
    expect(chosen.parts.flatMap((p) => parseMergeGrants(p))).toEqual([{ kind: "answer", target: 12, repo: null }]);
  });
  test("the questions' own text, whole, is there for the numbers a reader may name, however long the questions are", () => {
    const long = [{ header: null, question: `${"長い説明 ".repeat(1500)}PR #77 の件${"長い説明 ".repeat(1500)}`, options: [opt("はい")], multiSelect: false }];
    const c = questionsChosen(long, [{ choices: ["はい"] }])!;
    expect(c.readerAsked).not.toContain("#77");
    expect(c.questionsText).toContain("PR #77");
  });
  test("an answer that does not fit the questions is none", () => {
    expect(questionsChosen(qs, [])).toBeNull();
  });
});
