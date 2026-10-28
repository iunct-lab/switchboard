import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AnswerPolicy, ApprovalRuleMatch, Artifact, AskList, PolicySubject, Backlog, BacklogItem, PendingApproval, RunnerAdapter, RunnerId, RunnerSession, StopSummary, Task } from "@switchboard/protocol";
import { importing } from "../fixtures/github-import.ts";
import { answersOf, ASK_HISTORY_MS, asksFromBacklog, asksFromTasks, blockersOf, dedupeAsks, grantOfChoice, parseAskBlock, resumeOfIssue, resumeOfTask } from "./asks.ts";
import { heldSince, type GhRunner } from "./backlog.ts";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const ISSUES = "https://github.com/o/r/issues";

const item = (over: Partial<BacklogItem>): BacklogItem => ({
  number: 1, title: "t", url: `${ISSUES}/${over.number ?? 1}`, type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", tasks: null, decision: null, activeTaskId: null, projectStatus: null, lastTask: null, replyWaiting: false, report: null, answeredAt: null, heldAt: null, confirmations: [], closable: false, waits: [], waitsAt: null, overlap: null, prereqs: [], stopSummary: [], mockupTask: null, mockups: [], sync: { state: "synced", reason: null, lastSuccessfulSync: null, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A" }, workspaceId: "ws_meta", workspaceName: "switchboard", ...over,
});

const stop = (over: Partial<StopSummary>): StopSummary => ({
  key: "ws_meta#5\u0000gh pr merge\u0000#7\u0000decision\u0000", work: { workspaceId: "ws_meta", issue: 5, taskId: "tk_5" }, op: "gh pr merge", target: "#7", reason: "decision", evidence: "merge-gate stop",
  safety: "unknown", count: 1, state: "waiting", firstAt: NOW - 3_600_000, lastAt: NOW - 3_600_000, lastAnswer: null, grant: null, conditions: [], actions: [], changes: [], unchanged: false, next: "decide", ...over,
});

const DECISION = ["## 判断待ち", "**問い**: どちらの読みで作るか", "**選択肢**:", "- A: 既存の画面を置き換える — 影響: URL はそのまま", "- B: 新しい画面 — 影響: Rail が増える", "**推奨**: A — 画面を増やさない", "**止めた場所**: Task #9"].join("\n");

describe("parseAskBlock", () => {
  test("a ## 判断待ち and an operational check give the question, two choices and the recommendation with its reason", () => {
    expect(parseAskBlock(DECISION)).toEqual({
      question: "どちらの読みで作るか",
      choices: ["A: 既存の画面を置き換える — 影響: URL はそのまま", "B: 新しい画面 — 影響: Rail が増える"],
      grants: [null, null],
      recommendation: { choice: "A", why: "画面を増やさない" },
      place: { text: "Task #9", pr: null },
      mockupTask: null,
    });
    const check = parseAskBlock("前置き\n\n**確認**: PR #12 をマージしてよいか\n**選択肢**:\n- A: マージする\n- B: 待つ\n**推奨**: A — CI が緑\n");
    expect(check.question).toBe("PR #12 をマージしてよいか");
    expect(check.choices).toEqual(["A: マージする", "B: 待つ"]);
    expect(check.recommendation).toEqual({ choice: "A", why: "CI が緑" });
  });

  test("text without a recommendation has recommendation null; text without the form has nothing", () => {
    expect(parseAskBlock("**問い**: 続けるか").recommendation).toBeNull();
    expect(parseAskBlock("終わりました。")).toEqual({ question: null, choices: [], grants: [], recommendation: null, place: null, mockupTask: null });
  });

  test("place: **止めた場所** gives its text and the first PR it names; a place without a PR has pr null", () => {
    expect(parseAskBlock("**確認**: マージしてよいか\n**止めた場所**: PR #12（+40/-3）、PR #13 の下").place).toEqual({ text: "PR #12（+40/-3）、PR #13 の下", pr: 12 });
    expect(parseAskBlock("**問い**: どちらか\n**止めた場所**: Task #9 の手順 2").place).toEqual({ text: "Task #9 の手順 2", pr: null });
  });
});

describe("answers (#936)", () => {
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
    const refused = item({ number: 5, stage: "in-progress", stopSummary: [stops[1]!] });
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
    const lastTask = { id: "tk_new", status: "running" as const, statusAt: Date.parse(answeredAt) + 1000, createdAt: Date.parse(answeredAt) + 1000, updatedAt: Date.parse(answeredAt) + 1000, action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null };
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

  test("resume task: the usage limit queues, running runs, error fails; no reply is null", () => {
    const t = (over: Partial<Task>) => ({ id: "tk_1", status: "idle", resumeAt: null, updatedAt: NOW, ...over }) as Task;
    expect(resumeOfTask({ task: t({}), repliedAt: null, failure: null })).toBeNull();
    expect(resumeOfTask({ task: t({ status: "waiting", resumeAt: Date.parse("2026-10-07T15:00:00Z") }), repliedAt: NOW - 1, failure: null })).toMatchObject({ state: "queued", reason: "使用上限の解除待ち（2026-10-07T15:00:00.000Z）" });
    expect(resumeOfTask({ task: t({ status: "running" }), repliedAt: NOW - 1, failure: null })).toMatchObject({ state: "running", taskId: "tk_1" });
    expect(resumeOfTask({ task: t({ status: "error" }), repliedAt: NOW - 1, failure: null })).toMatchObject({ state: "failed", reason: "Task が error" });
    expect(resumeOfTask({ task: t({ status: "idle" }), repliedAt: NOW - 1, failure: { at: NOW, reason: "送れなかった" } })).toMatchObject({ state: "failed", reason: "送れなかった" });
    expect(resumeOfTask({ task: t({ status: "idle" }), repliedAt: NOW - 1, failure: null })).toBeNull();
  });

  test("answers: an approval, a decision with choices, a check without, a confirmation, a refused stop and an automatic one", () => {
    const a = (over: Partial<Parameters<typeof answersOf>[0]>) => answersOf({ kind: "decision", needs: "person", state: "open", choices: [], blockers: [], grant: null, ...over });
    expect(a({ kind: "approval" })).toEqual(["allow", "deny"]);
    expect(a({ kind: "decision", choices: ["A", "B"] })).toEqual(["choice", "text", "hold"]);
    expect(a({ kind: "decision", state: "held" })).toEqual(["text", "hold"]);
    expect(a({ kind: "check" })).toEqual(["text"]);
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

describe("grants (#2745)", () => {
  const GRANT = "定期実行 sch_x を enabled: false で POST /api/schedules に登録することだけ許可します";
  const CHECK = `**確認**: 定期実行を登録してよいか\n**選択肢**:\n- A: 登録しない\n- B: 登録する — 許可: ${GRANT}\n**推奨**: B — 確かめるため`;
  const task = (over: Partial<Task> = {}): Task =>
    ({ id: "tk_g", workspaceId: null, title: "t", runner: "claude", cwd: "/tmp", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "needs_action", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: NOW - 600_000, createdAt: NOW - 600_000, updatedAt: NOW - 60_000, ...over }) as Task;
  const fromTasks = (t: Task, stops: StopSummary[], reply: string | null) =>
    asksFromTasks({ approvals: [], tasks: [t], lastReply: () => (reply ? { text: reply, seq: 9 } : null), permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW, policy: { policies: [], pbiOpen: () => true, approval: () => ({ subject: null, confirmHit: null }), confirm: () => null } });
  const refused = (over: Partial<StopSummary> = {}) =>
    stop({ key: "task:tk_g\u0000POST /api/schedules\u0000\u0000permission\u0000", work: { workspaceId: null, issue: null, taskId: "tk_g" }, op: "POST /api/schedules", target: "", reason: "permission", evidence: "auto mode denied", next: "decide", ...over });

  test("choice grant: a choice's ` — 許可: ` is its grant, in the order of the choices; a choice without one is null and its text stays whole", () => {
    const b = parseAskBlock(CHECK);
    expect(b.choices).toEqual(["A: 登録しない", `B: 登録する — 許可: ${GRANT}`]);
    expect(b.grants).toEqual([null, GRANT]);
    expect(grantOfChoice("A: 登録しない — 影響: なし")).toBeNull();
    expect(grantOfChoice("A: x — 許可：全角の区切り")).toBe("全角の区切り");
    const [check] = fromTasks(task(), [], CHECK);
    expect(check).toMatchObject({ kind: "check", grants: [null, GRANT], grant: null, answers: ["choice", "text"] });
    // a grant is not saved as a policy
    expect(check!.policy).toMatchObject({ scopes: [], note: "許可文は 1 回きりで、方針には保存しません" });
  });

  test("permission stop grant: a permission stop with a grant is not in the way and is answered by it; one without stays the runner's refusal", () => {
    const [g] = fromTasks(task({ outcome: "unknown" }), [refused({ grant: GRANT })], null);
    expect(g).toMatchObject({ kind: "stop", needs: "person", state: "open", grant: GRANT, blockers: [], answers: ["grant", "text"] });
    expect(g!.policy).toMatchObject({ scopes: [], note: "許可文は 1 回きりで、方針には保存しません" });
    const [none] = fromTasks(task({ outcome: "unknown" }), [refused()], null);
    expect(none).toMatchObject({ grant: null, answers: [] });
    expect(none!.blockers.map((b) => b.kind)).toEqual(["runner"]);
    // only a permission stop's grant counts: an auth refusal stays the runner's
    expect(blockersOf({ waits: [], stops: [refused({ reason: "auth", grant: GRANT })], approvalPending: false }).map((b) => b.kind)).toEqual(["runner"]);
    const [auth] = fromTasks(task({ outcome: "unknown" }), [refused({ reason: "auth", grant: GRANT })], null);
    expect(auth!.grant).toBeNull();
  });

  test("permission stop grant: folded into the Task's check, the grant stays answerable and is not saved as a policy", () => {
    const list = dedupeAsks(fromTasks(task(), [refused({ grant: GRANT })], "**確認**: 続けるか\n**選択肢**:\n- A: はい"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "check", grant: GRANT, answers: ["grant", "choice", "text"], policy: { scopes: [], note: "許可文は 1 回きりで、方針には保存しません" } });
    // a stop without a grant folds as before
    expect(dedupeAsks(fromTasks(task(), [refused({ reason: "input" })], "**確認**: 続けるか"))[0]).toMatchObject({ kind: "check", grant: null, answers: ["text"] });
  });
});

describe("asksFromBacklog", () => {
  test("from backlog: a decision, two confirmations, an open wait, a decide stop and a usage-limit stop", () => {
    const asks = asksFromBacklog(
      [
        item({ number: 3, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T10:00:00Z", issue: 9 } }),
        item({ number: 4, stage: "in-progress", confirmations: [{ n: 2, text: "PC で見える（利用者確認: 画面）" }, { n: 3, text: "スマホで見える（利用者確認: 画面）" }] }),
        item({ number: 6, waits: [{ number: 70, kind: "pr", open: true, state: "pending", reason: "prerequisite", pbi: null }, { number: 71, kind: "issue", open: false, state: "met", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" }),
        item({ number: 5, stage: "in-progress", stopSummary: [stop({}), stop({ key: "ws_meta#5\u0000codex exec\u0000\u0000usage-limit\u0000", op: "codex exec", target: "", reason: "usage-limit", evidence: "5h window", next: "wait", conditions: [{ key: "resetsAt", value: "2026-10-07T15:00:00Z", met: false }] })] }),
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
    expect(limit).toMatchObject({ id: "stop:ws_meta#5|codex exec||usage-limit|", reason: "usage-limit: 5h window", task: { id: "tk_5" }, conditions: [{ key: "resetsAt" }] });
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

  test("stops: resume with an answer is answered at the answer's time, without one it goes on by itself; a resolved usage-limit stop was automatic", () => {
    const answer = { ref: "seq:12", at: NOW - 600_000 };
    const [answered] = asksFromBacklog([item({ number: 5, stopSummary: [stop({ next: "resume", lastAnswer: answer })] })], NOW);
    expect(answered).toMatchObject({ kind: "stop", needs: "person", state: "answered", changedAt: answer.at });
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
    const lastTask = (updatedAt: number) => ({ id: "tk", status: "done" as const, statusAt: updatedAt, createdAt: updatedAt, updatedAt, action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null });
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
    // a wait not read (#1046) is neither open nor met: nothing reads it again, so a person looks
    const unread = asksFromBacklog([item({ number: 6, waits: [{ number: 70, kind: "pr", open: false, state: "met", reason: "prerequisite", pbi: null }, { number: 99, kind: "issue", open: null, state: "missing", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" })], NOW);
    expect(unread).toMatchObject([{ kind: "wait", needs: "person", route: "backlog", next: "未取得の相手を確かめて #6 の「実装する」", reason: "Issue #99（未取得） の完了待ち", conditions: [{ key: "pr#70", met: true }, { key: "issue#99", value: "unknown", met: false }] }]);
    const unreadBuilding = asksFromBacklog([item({ number: 6, stage: "in-progress", waits: [{ number: 99, kind: "issue", open: null, state: "missing", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" })], NOW);
    expect(unreadBuilding).toMatchObject([{ kind: "wait", needs: "person", next: "未取得の相手を確かめて /pbi-complete 6 を手で始める" }]);
    const done = asksFromBacklog([item({ number: 5, stopSummary: [stop({ state: "resolved", next: "none", lastAt: NOW - ASK_HISTORY_MS - 1 })] })], NOW);
    expect(done).toEqual([]);
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
        item({ number: 2, stage: "in-progress", answeredAt: "2026-10-07T11:00:00Z", lastTask: { id: "tk", status: "done", statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000, action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null } }),
        item({ number: 6, waits: [{ number: 70, kind: "pr", open: true, state: "pending", reason: "prerequisite", pbi: null }], waitsAt: "2026-10-07T09:00:00Z" }),
        item({ number: 3, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T08:00:00Z", issue: 3 } }),
        item({ number: 4, stage: "needs-decision", decision: { body: DECISION, at: "2026-10-07T10:00:00Z", issue: 4 } }),
      ],
      NOW,
    );
    expect(dedupeAsks(asks).map((a) => `${a.kind}#${a.pbi!.number}`)).toEqual(["decision#4", "decision#3", "wait#6", "decision#2"]);
  });
});

describe("mockups (#2221)", () => {
  const art = (id: string, title: string): Artifact => ({ id, taskId: "tk_m", title, kind: "file", source: `/w/${id}.html`, entry: `${id}.html`, mime: "text/html", size: 1, removedAt: null, createdAt: NOW, updatedAt: NOW });
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

  test("mockups: an operational check's reply with **画面イメージ** has them too; other questions have none", () => {
    const t = { id: "tk_c", workspaceId: null, title: "t", status: "done", outcome: "needs_action", reviewedAt: null, resumeAt: null, stage: null, createdAt: NOW - 600_000, updatedAt: NOW - 60_000 } as unknown as Task;
    const list = asksFromTasks({ approvals: [], tasks: [t], lastReply: () => ({ text: "**確認**: どちらの画面にするか\n**画面イメージ**: `tk_m`", seq: 9 }), permissionEvents: () => [], stops: () => [], workspaceName: () => null, now: NOW, mockups });
    expect(list.find((a) => a.kind === "check")!.mockups).toEqual(two);
    const backlog = asksFromBacklog([item({ number: 4, stage: "in-progress", confirmations: [{ n: 1, text: "見える（利用者確認: 画面）" }] })], NOW, { mockups });
    expect(backlog.map((a) => a.mockups)).toEqual([[]]);
  });
});

describe("asksFromTasks", () => {
  const task = (over: Partial<Task>): Task => ({
    id: "tk_1", workspaceId: null, title: "t", runner: "claude", cwd: "/tmp", scope: [], status: "waiting", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard",
    resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: NOW - 600_000, createdAt: NOW - 600_000, updatedAt: NOW - 60_000, ...over,
  }) as Task;
  const approval = (taskId: string, id: string, askedAt: number): PendingApproval => ({ taskId, taskTitle: "t", workspace: null, id, kind: "write", tool: "Write", input: {}, detail: `write ${id}`, askedAt });
  const taskStop = (taskId: string, over: Partial<StopSummary>) => stop({ key: `task:${taskId}\u0000${over.op ?? "op"}\u0000\u0000${over.reason ?? "decision"}\u0000`, work: { workspaceId: null, issue: null, taskId }, ...over });
  const build = (tasks: Task[], extra: { approvals?: PendingApproval[]; stops?: StopSummary[]; reply?: string } = {}) =>
    dedupeAsks(asksFromTasks({ approvals: extra.approvals ?? [], tasks, lastReply: () => (extra.reply === undefined ? null : { text: extra.reply, seq: 9 }), permissionEvents: () => [], stops: () => extra.stops ?? [], workspaceName: () => null, now: NOW }));

  test("a resumeAt in the past is the resume after an interruption, its condition met", () => {
    const at = NOW - 1_000;
    expect(build([task({ resumeAt: at })])).toMatchObject([{ kind: "stop", needs: "auto", reason: "transient: 中断からの自動再開待ち", conditions: [{ key: "resumeAt", met: true }] }]);
  });

  test("fold: a check and a person's stop go into the newest open approval with their conditions; two approvals stay two", () => {
    const t = task({ outcome: "needs_action", status: "done" });
    const stops = [taskStop(t.id, { reason: "input", conditions: [{ key: "answer", value: "none", met: false }] })];
    const asks = build([t], { approvals: [approval(t.id, "p1", NOW - 5_000), approval(t.id, "p2", NOW - 1_000)], stops, reply: "**確認**: 続けるか" });
    expect(asks.map((a) => a.id)).toEqual([`approval:${t.id}:p2`, `approval:${t.id}:p1`]);
    expect(asks[0]!.conditions).toEqual([{ key: "answer", value: "none", met: false }]);
  });

  test("fold: a person's stop goes into the check; a stop that waits by itself stays apart from the person's one", () => {
    const t = task({ outcome: "needs_action", status: "done" });
    const decide = taskStop(t.id, { op: "a", reason: "input", next: "decide" });
    const waits = taskStop(t.id, { op: "b", reason: "permission", next: "wait", conditions: [{ key: "pr#3", value: "open", met: false }] });
    const asks = build([t], { stops: [waits, decide], reply: "**確認**: 続けるか" });
    expect(asks.map((a) => `${a.kind}/${a.needs}`)).toEqual(["check/person", "stop/auto"]);
    expect(asks[0]!.question).toBe("続けるか");
  });

  test("fold: a stage Task's check before the answer goes into its Issue's answered decision; one after it stays", () => {
    const answeredAt = "2026-10-07T11:00:00Z";
    const pbi = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { id: "tk", status: "done", statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000, action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null } })], NOW);
    const before = task({ id: "tk_a", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", createdAt: Date.parse(answeredAt) - 120_000, updatedAt: Date.parse(answeredAt) - 60_000 });
    const after = task({ id: "tk_b", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", createdAt: Date.parse(answeredAt) - 90_000, updatedAt: Date.parse(answeredAt) + 60_000 });
    const fromTasks = asksFromTasks({ approvals: [], tasks: [before, after], lastReply: () => ({ text: "**確認**: 続けるか", seq: 9 }), permissionEvents: () => [], stops: () => [], workspaceName: () => "switchboard", now: NOW });
    expect(dedupeAsks([...pbi, ...fromTasks]).map((a) => `${a.kind}/${a.state}/${a.task?.id ?? "-"}`)).toEqual(["check/open/tk_b", "decision/answered/-"]);
  });

  test("fold: the Issue of a stage Task comes from Task.stage, not its title", () => {
    const answeredAt = "2026-10-07T11:00:00Z";
    const pbi = asksFromBacklog([item({ number: 2, stage: "in-progress", answeredAt, lastTask: { id: "tk", status: "done", statusAt: NOW - 7_200_000, createdAt: NOW - 7_200_000, updatedAt: NOW - 7_200_000, action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null } })], NOW);
    const at = { createdAt: Date.parse(answeredAt) - 120_000, updatedAt: Date.parse(answeredAt) - 60_000 };
    const renamed = task({ id: "tk_r", workspaceId: "ws_meta", title: "renamed", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", ...at });
    const plain = task({ id: "tk_p", workspaceId: "ws_meta", title: "#2 実装", stage: null, outcome: "needs_action", status: "done", ...at });
    const kinds = (t: Task) => dedupeAsks([...pbi, ...asksFromTasks({ approvals: [], tasks: [t], lastReply: () => ({ text: "**確認**: 続けるか", seq: 9 }), permissionEvents: () => [], stops: () => [], workspaceName: () => "switchboard", now: NOW })]).map((a) => `${a.kind}/${a.state}`);
    expect(kinds(renamed)).toEqual(["decision/answered"]);
    expect(kinds(plain)).toEqual(["check/open", "decision/answered"]);
  });

  test("a stage Task's check is gone once a stage Task of the same Issue started after it stopped; another Issue's or workspace's does not count", () => {
    const old = task({ id: "tk_old", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, outcome: "needs_action", status: "done", createdAt: NOW - 7_200_000, updatedAt: NOW - 3_600_000 });
    const next = task({ id: "tk_next", workspaceId: "ws_meta", title: "#2 実装", stage: { issue: 2, action: "complete" }, status: "running", createdAt: NOW - 600_000 });
    const other = task({ id: "tk_other", workspaceId: "ws_meta", title: "#3 実装", stage: { issue: 3, action: "complete" }, status: "running", createdAt: NOW - 600_000 });
    const build2 = (tasks: Task[]) => asksFromTasks({ approvals: [], tasks, lastReply: () => ({ text: "**確認**: 続けるか", seq: 9 }), permissionEvents: () => [], stops: () => [], workspaceName: () => null, now: NOW }).map((a) => `${a.kind}/${a.task?.id}`);
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

/* ---------- GET /api/asks (#1002): a fake runner and a fake gh, as core.test.ts and backlog.test.ts boot them ---------- */

const pages = (await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json()) as unknown[];
const decisions = (await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json()) as unknown;
const fakeGh: GhRunner = async (args) => {
  if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};

const CHECK = "PR を出しました。\n\n**確認**: PR #12 をマージしてよいか\n**選択肢**:\n- A: マージする\n- B: 待つ\n**推奨**: A — CI が緑\n**止めた場所**: PR #12";
const ASK: AgentEvent = { t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: { file_path: "/tmp/x" }, detail: "write x" };

/** A scripted runner (core.test.ts's fakeAdapter, cut down): replays `script`, pausing on a permission.ask until it is answered; lingers after its turn. */
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
    core = await startServer(cfg, [runner("claude", [ASK, { t: "message.delta", role: "assistant", text: "writing" }]), runner("codex", [end(CHECK)])], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(fakeGh), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
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
    const person = list.filter((x) => x.needs === "person" && x.state === "open");
    expect(person.map((x) => x.kind).sort()).toEqual(["approval", "check", "confirmation", "confirmation", "decision"]);
    expect(person.find((x) => x.kind === "approval")).toMatchObject({ id: `approval:${a}:perm1`, question: "write x", route: "approval", task: { id: a, title: "approve me" }, source: { taskId: a } });
    expect(person.find((x) => x.kind === "check")).toMatchObject({ question: "PR #12 をマージしてよいか", choices: ["A: マージする", "B: 待つ"], recommendation: { choice: "A", why: "CI が緑" }, route: "task", source: { taskId: c } });
    expect(person.find((x) => x.kind === "decision")).toMatchObject({ pbi: { number: 306 }, question: "保存先をどちらにするか", route: "backlog" });
    for (const x of person) expect(x.workspace).toEqual({ id: meta().id, name: meta().name });
    expect(person.find((x) => x.kind === "decision")!.source.url).toStartWith("https://github.com/acme/app/issues/");
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
});

describe("policy (#938)", () => {
  const DECIDE = "## 判断待ち\n**問い**: マージしてよいか\n**選択肢**:\n- A: マージする\n- B: 待つ\n**推奨**: A — CI が緑\n**止めた場所**: PR #12";
  const decisionStop = (over: Partial<StopSummary> = {}) => stop({ op: "gh pr merge", target: "PR #13", reason: "decision", firstAt: NOW - 10_800_000, conditions: [{ key: "area", value: "web", met: true }], ...over });
  const savedFrom: PolicySubject = { kind: "decision", op: "gh pr merge", target: "PR #12", conditions: [{ key: "area", value: "web" }], head: null };
  const saved = (over: Partial<AnswerPolicy> = {}): AnswerPolicy => ({
    id: "p1", scope: "repo", workspaceId: "ws_meta", pbi: null, askId: null, kind: "decision", op: "gh pr merge", target: "PR #12", when: [], answer: { kind: "choice", choice: "A: マージする" },
    expiresAt: NOW - 1000, revokedAt: null, createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000, from: savedFrom, uses: [], ...over,
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
    ({ id: "tk_1", workspaceId: null, title: "t", runner: "claude", cwd: "/tmp", scope: [], status: "waiting", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: NOW - 600_000, createdAt: NOW - 600_000, updatedAt: NOW - 60_000, ...over }) as Task;
  const fromTasks = (approvals: PendingApproval[], policies: AnswerPolicy[] = [], confirmHit: ApprovalRuleMatch | null = null, stops: StopSummary[] = [], tasks: Task[] = [task({})], reply: string | null = null) =>
    asksFromTasks({ approvals, tasks, lastReply: () => (reply ? { text: reply, seq: 9 } : null), permissionEvents: () => [], stops: () => stops, workspaceName: () => null, now: NOW, policy: env(policies, confirmHit) });
  const exec = (command: string, id = "p1"): PendingApproval => ({ taskId: "tk_1", taskTitle: "t", workspace: null, id, kind: "exec", tool: "Bash", input: { command }, detail: command, askedAt: NOW - 1000 });

  test("policy: subject — an exec approval is op exec and the command, a network one has none; a check / decision takes the newest series before it, head null, no GitHub call", () => {
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
    const check = fromTasks([], [], null, [decisionStop({ firstAt: NOW - 120_000 })], [task({ outcome: "needs_action" })], "**確認**: 続けるか\n**選択肢**:\n- A: はい\n- B: いいえ")[0]!;
    expect(check).toMatchObject({ kind: "check", subject: { kind: "check", op: "gh pr merge" } });
  });

  test("policy: scopes — a PBI's check gives 3, a Task without a PBI once / repo, no series once only with a note; a permission stop or a confirm rule gives none", () => {
    const a = decide([], [decisionStop()]);
    expect(a.policy).toMatchObject({ scopes: ["once", "pbi", "repo"], note: null });
    expect(a.policy.defaults).toMatchObject({ target: "PR #13", when: [{ key: "area", value: "web" }], expiresAt: NOW + 30 * 86_400_000 });
    const t = fromTasks([], [], null, [decisionStop({ firstAt: NOW - 120_000 })], [task({ outcome: "needs_action" })], "**確認**: 続けるか\n**選択肢**:\n- A: はい")[0]!;
    expect(t.policy.scopes).toEqual(["once", "repo"]);
    // a stage Task's own question belongs to the PBI it works on
    const staged = fromTasks([], [], null, [decisionStop({ firstAt: NOW - 120_000 })], [task({ outcome: "needs_action", workspaceId: "ws_meta", stage: { issue: 938, action: "complete" } })], "**確認**: 続けるか\n**選択肢**:\n- A: はい")[0]!;
    expect(staged.policy.scopes).toEqual(["once", "pbi", "repo"]);
    expect(decide([], []).policy).toMatchObject({ scopes: ["once"], note: "操作と対象が記録されていないため、今回のみ" });
    const refused = asksFromBacklog([item({ number: 5, stage: "in-progress", stopSummary: [stop({ reason: "permission", evidence: "denied by the runner", next: "decide" })] })], NOW, { policy: env() })[0]!;
    expect(refused.policy).toMatchObject({ scopes: [], note: "ランナー側の拒否は保存した方針では解除できません", defaults: null });
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
