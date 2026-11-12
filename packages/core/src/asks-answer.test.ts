// test-reads: packages/core/fixtures/
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Ask, AskAnswerResult, AskQuestion, AskChanged, AskList, Backlog, RunnerAdapter, RunnerSession, Task } from "@switchboard/protocol";
import { importing } from "../fixtures/github-import.ts";
import type { GhRunner } from "./backlog.ts";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";

/* POST /api/asks/answer (#936), the Issue side: a fake runner and a fake gh, as asks.test.ts boots them. */

const pages = (await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json()) as unknown[];
const decisions = (await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json()) as { data: { repository: Record<string, { comments: { nodes: Array<{ body: string; createdAt: string }> } }> } };
const HEAD = "b".repeat(40);
/** The meta workspace is this checkout, whose origin is not the fake gh's acme/app: no origin to check (#2799; tasks.test.ts checks it). */
const FAKE_ORIGIN = () => null;
const ASKED = "a".repeat(40);

/**
 * The fixtures' gh. `place` replaces where #306's question stopped; `pr` answers `gh pr view` (the PR the question names).
 * Every call is kept in `calls`.
 */
type PrView = { state: string; head: string; comments: Array<{ body: string; createdAt: string }>; commits: Array<{ committedDate: string }> };
function fakeGh(opts: { place?: string; pr?: PrView; prs?: Record<string, PrView> } = {}) {
  const calls: string[][] = [];
  const own = structuredClone(decisions);
  if (opts.place) {
    const nodes = own.data.repository.i306!.comments.nodes;
    nodes[2] = { ...nodes[2]!, body: nodes[2]!.body.replace("**止めた場所**: Task #307", `**止めた場所**: ${opts.place}`) };
  }
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
    if (args[0] === "pr" && args[1] === "view") {
      const pr = opts.prs?.[args[2]!] ?? opts.pr;
      return pr ? { code: 0, stdout: JSON.stringify({ state: pr.state, headRefOid: pr.head, comments: pr.comments, commits: pr.commits }), stderr: "" } : { code: 1, stdout: "", stderr: "no pr" };
    }
    if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(own), stderr: "" };
    return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
  };
  return { gh, calls };
}

/** A runner whose Task runs until it is stopped. */
const holding: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true, version: "fake" }),
  start: () => ({ send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) }),
};
/** No runner to start on: the stage Task is not created. */
const broken: RunnerAdapter = { ...holding, detect: async () => ({ available: false }) };

let core: CoreServer | null = null;
let home = "";
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(home, { recursive: true, force: true });
});

async function boot(gh: GhRunner, adapter: RunnerAdapter = holding): Promise<string> {
  home = mkdtempSync(join(tmpdir(), "sb-asks-answer-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
  const base = `http://127.0.0.1:${core.server.port}`;
  for (let n = 0; n < 400; n++) {
    const b = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
    if (b.syncs.length && !b.syncs.some((s) => s.syncing)) break;
    await Bun.sleep(10);
  }
  return base;
}

const asks = async (base: string) => ((await (await fetch(`${base}/api/asks`)).json()) as AskList).asks;
const decisionOf306 = async (base: string) => (await asks(base)).find((a) => a.kind === "decision" && a.pbi?.number === 306)!;
const answer = (base: string, id: string, a: unknown) => fetch(`${base}/api/asks/answer`, { method: "POST", body: JSON.stringify({ id, answer: a }) });
/** What waits to be sent to GitHub (#886): per operation, its Issue's number, kind, field and what is sent. */
const queued = () =>
  core!.db.listPendingBacklogOperations().map((o) => {
    const issue = core!.db.getBacklogRecord({ ...o, objectKind: "issue", externalId: o.issue });
    return [((issue?.local ?? issue?.remote) as { number: number } | null)?.number, o.kind, o.field, o.payload];
  });
const stageTasks = (n: number) => core!.db.listTasks().filter((t) => t.stage?.issue === n);
const B = "B: ファイル — 影響: 移行が要らない";
const meta = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
const insertStage = (title: string, status: Task["status"], stage: Task["stage"], at = Date.now() - 60_000) =>
  core!.db.insertTask({ id: `tsk_${status}_${at}`, workspaceId: meta().id, title, stage, runner: "claude", cwd: meta().path, scope: [meta().path], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at });

describe("POST /api/asks/answer — the Issue side", () => {
  test("answer decision: the chosen line is written on the Issue, the label comes off, then one 実装 starts and the answer says it runs", async () => {
    const fake = fakeGh();
    const base = await boot(fake.gh);
    const ask = await decisionOf306(base);
    expect(ask).toMatchObject({ state: "open", answers: ["choice", "text", "hold"], place: { text: "Task #307", pr: null } });
    const r = await answer(base, ask.id, { kind: "choice", choice: B, note: "移行はしない" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AskAnswerResult;
    expect(body.already).toBe(false);
    expect(body.ask).toMatchObject({ id: ask.id, state: "answered", answers: [], resume: { state: "running" } });
    expect(queued()).toEqual([[306, "comment", null, { body: `## 回答\n\n${B}\n\n移行はしない`, screen: true }], [306, "set", "label:needs-decision", false]]);
    expect(stageTasks(306).map((t) => t.title.split(":")[0])).toEqual(["#306 実装"]);
    expect(body.ask!.resume!.taskId).toBe(stageTasks(306)[0]!.id);
    // nothing was asked of GitHub to answer (the import alone reads it; there is no PR to check)
    expect(fake.calls.filter((a) => a[0] === "pr" || a[0] === "issue")).toEqual([]);
    // the list now has it answered, going on with that Task
    const after = (await asks(base)).find((a) => a.kind === "decision" && a.pbi?.number === 306)!;
    expect(after).toMatchObject({ state: "answered", resume: { state: "running", taskId: stageTasks(306)[0]!.id } });
  });

  test("start fails: the answer is written, the resume says failed with the reason, and so does the list", async () => {
    const base = await boot(fakeGh().gh, broken);
    const ask = await decisionOf306(base);
    const body = (await (await answer(base, ask.id, { kind: "text", text: "B で" })).json()) as AskAnswerResult;
    expect(queued()[0]).toEqual([306, "comment", null, { body: "## 回答\n\nB で", screen: true }]);
    expect(body.ask!.resume).toMatchObject({ state: "failed", reason: "ランナーが検出されていません", taskId: null });
    expect(stageTasks(306)).toHaveLength(0);
    const after = (await asks(base)).find((a) => a.kind === "decision" && a.pbi?.number === 306)!;
    expect(after).toMatchObject({ state: "answered", resume: { state: "failed", reason: body.ask!.resume!.reason } });
  });

  test("twice at once: two answers to the same question write once and start once; the second says already", async () => {
    const base = await boot(fakeGh().gh);
    const ask = await decisionOf306(base);
    const [a, b] = await Promise.all([answer(base, ask.id, { kind: "choice", choice: B }), answer(base, ask.id, { kind: "choice", choice: B })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [(await a.json()) as AskAnswerResult, (await b.json()) as AskAnswerResult];
    expect(bodies.map((x) => x.already).sort()).toEqual([false, true]);
    expect(queued().filter((o) => o[1] === "comment")).toHaveLength(1);
    expect(stageTasks(306)).toHaveLength(1);
  });

  test("resent: an answer whose reply was lost, sent again, gets the same result and writes nothing more", async () => {
    const base = await boot(fakeGh().gh);
    const ask = await decisionOf306(base);
    await answer(base, ask.id, { kind: "choice", choice: B }); // its reply lost
    const before = queued();
    const r = await answer(base, ask.id, { kind: "choice", choice: B });
    expect(r.status).toBe(200);
    expect((await r.json()) as AskAnswerResult).toMatchObject({ already: true, ask: { id: ask.id, state: "answered" } });
    expect(queued()).toEqual(before);
    expect(stageTasks(306)).toHaveLength(1);
  });

  test("a stage Task already active before the answer is not the Task the answer started: no started: record, the card stays answered and queued (#4532)", async () => {
    const base = await boot(fakeGh().gh);
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "running", { issue: 306, action: "complete" });
    const ask = await decisionOf306(base);
    const body = (await (await answer(base, ask.id, { kind: "choice", choice: B })).json()) as AskAnswerResult;
    expect(stageTasks(306)).toHaveLength(1); // the one inserted: the answer started nothing
    // the POST says it runs (that Task), but it is not recorded as the answer's own
    expect(body.ask!.resume).toMatchObject({ state: "running", taskId: t.id });
    expect(core!.db.askAnswer(`started:${meta().id}#306`)).toBeNull();
    const after = (await asks(base)).find((a) => a.kind === "decision" && a.pbi?.number === 306)!;
    expect(after.state).toBe("answered");
    expect(after.resume?.state).toBe("queued");
  });

  test("with a firing: an answer and backlog-next's firing at once start one stage Task of the item", async () => {
    const base = await boot(fakeGh().gh);
    const ask = await decisionOf306(base);
    const s = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: meta().id, runner: "claude", prompt: "", action: "backlog-next" }) });
    const id = ((await s.json()) as { id: string }).id;
    await fetch(`${base}/api/workspaces/${meta().id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep: { implement: 3, plan: 0 } }) });
    const [r] = await Promise.all([answer(base, ask.id, { kind: "choice", choice: B }), fetch(`${base}/api/schedules/${id}/run`, { method: "POST" })]);
    expect(r.status).toBe(200);
    // the firing (its reply awaited above) may pick #306 once answered: it finds that start under way or running, never a second one
    expect(stageTasks(306)).toHaveLength(1);
  });

  test("changed: an answer to an older question of the item is 409 with what changed and the question now; nothing is written", async () => {
    const fake = fakeGh();
    const base = await boot(fake.gh);
    const now = await decisionOf306(base);
    const old = now.id.replace(/@.*$/, "@2026-09-21T01:00:00Z");
    const r = await answer(base, old, { kind: "text", text: "A で" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as AskChanged;
    expect(body.changes).toEqual(["問いが新しくなりました"]);
    expect(body.current?.id).toBe(now.id);
    expect(queued()).toEqual([]);
    expect(stageTasks(306)).toHaveLength(0);
    // a choice that is not one of the question's
    const c = await answer(base, now.id, { kind: "choice", choice: "C: 別の案" });
    expect(c.status).toBe(409);
    expect(((await c.json()) as AskChanged).changes).toEqual(["選択肢が変わりました"]);
  });

  test("changed: the PR the question stopped at has another head than its [merge-ask] named → 409 naming both; one gh read, nothing written", async () => {
    const asked = "2026-09-22T02:00:00Z";
    const fake = fakeGh({ place: "PR #12（+40/-3）", pr: { state: "OPEN", head: HEAD, comments: [{ body: `[merge-ask] security ${ASKED}`, createdAt: asked }], commits: [{ committedDate: "2026-09-23T00:00:00Z" }] } });
    const base = await boot(fake.gh);
    const ask = await decisionOf306(base);
    expect(ask.place).toEqual({ text: "PR #12（+40/-3）", pr: 12, reasons: [], diff: "+40/-3" });
    const r = await answer(base, ask.id, { kind: "choice", choice: B });
    expect(r.status).toBe(409);
    expect(((await r.json()) as AskChanged).changes).toEqual([`PR #12 の差分が変わりました（${ASKED.slice(0, 7)} → ${HEAD.slice(0, 7)}）`]);
    expect(fake.calls.filter((a) => a[0] === "pr")).toEqual([["pr", "view", "12", "-R", "acme/app", "--json", "state,headRefOid,comments,commits"]]);
    expect(queued()).toEqual([]);
    // not a dead end: a text (asking to check again) is not the PR's approval and goes
    expect((await answer(base, ask.id, { kind: "text", text: "差分が変わったのでマージ判定をやり直して" })).status).toBe(200);
    expect(queued()[0]).toEqual([306, "comment", null, { body: `## 回答\n\n差分が変わったのでマージ判定をやり直して\n\n（この回答は問いの時点の PR へのものです。回答の時点で: PR #12 の差分が変わりました（${ASKED.slice(0, 7)} → ${HEAD.slice(0, 7)}））`, screen: true }]);
  });

  test("unchanged PR: the head its [merge-ask] named is still the head → written and going on", async () => {
    const fake = fakeGh({ place: "PR #12", pr: { state: "OPEN", head: ASKED, comments: [{ body: `[merge-ask] security ${ASKED}`, createdAt: "2026-09-22T02:00:00Z" }], commits: [] } });
    const base = await boot(fake.gh);
    const r = await answer(base, (await decisionOf306(base)).id, { kind: "choice", choice: B });
    expect(r.status).toBe(200);
    expect(stageTasks(306)).toHaveLength(1);
  });

  test("hold: only a ## 保留 is written — the label stays, nothing starts — and the question is held, still the person's", async () => {
    const base = await boot(fakeGh().gh);
    const ask = await decisionOf306(base);
    const r = await answer(base, ask.id, { kind: "hold", text: "CI を見てから" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as AskAnswerResult).ask).toMatchObject({ state: "held", resume: null });
    expect(queued()).toEqual([[306, "comment", null, { body: "## 保留\n\nCI を見てから" }]]);
    expect(stageTasks(306)).toHaveLength(0);
    const held = await decisionOf306(base);
    expect(held).toMatchObject({ id: ask.id, state: "held", needs: "person", answers: ["choice", "text", "hold"] });
    // the hold sent again (its reply lost): nothing more written
    expect(((await (await answer(base, ask.id, { kind: "hold", text: "CI を見てから" })).json()) as AskAnswerResult).already).toBe(true);
    expect(queued()).toHaveLength(1);
    // answered later by the same id: written and going on, not taken for a resend of the hold
    const later = await answer(base, ask.id, { kind: "choice", choice: B });
    expect((await later.json()) as AskAnswerResult).toMatchObject({ already: false, ask: { state: "answered", resume: { state: "running" } } });
    expect(queued().map((o) => o[1])).toEqual(["comment", "comment", "set"]);
    expect(stageTasks(306)).toHaveLength(1);
  });

  test("blocked: a stop condition not met and the runner's refusal stay after the answer — written, nothing started, queued with both reasons", async () => {
    const base = await boot(fakeGh().gh);
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    const stop = (id: string, reason: "depends" | "permission", conditions: Array<{ key: string; value: string; met: boolean }>) =>
      core!.db.appendEvent(t.id, { t: "stop.record", stop: { id, work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: reason === "depends" ? "gh pr merge" : "git push", target: "#12", reason, evidence: reason === "depends" ? "CI が失敗" : "denied", safety: "before-effect", conditions, answer: null, actions: [], state: "waiting", at: Date.now() - 30_000 } });
    stop("s1", "depends", [{ key: "ci", value: "failure", met: false }]);
    stop("s2", "permission", []);
    const ask = await decisionOf306(base);
    const body = (await (await answer(base, ask.id, { kind: "text", text: "直してから進めて" })).json()) as AskAnswerResult;
    expect(queued()[0]).toEqual([306, "comment", null, { body: "## 回答\n\n直してから進めて", screen: true }]);
    expect(stageTasks(306)).toHaveLength(1); // the one inserted
    expect(body.ask!.resume).toMatchObject({ state: "queued", taskId: null });
    expect(body.ask!.resume!.reason).toContain("ci: failure");
    expect(body.ask!.resume!.reason).toContain("ランナー側の拒否");
  });

  test("permission stop grant reply: a stage Task's refused stop is answered on its Issue by its grant — a ## 回答 the next stage Task gets as the person's words (#2745)", async () => {
    const GRANT = "git push を origin の sb/x にすることだけ許可します";
    const prompts: string[] = [];
    const base = await boot(fakeGh().gh, { ...holding, start: (o) => (prompts.push(o.prompt), holding.start(o, () => {})) });
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: "git push", target: "sb/x", reason: "permission", evidence: "denied", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: GRANT, at: Date.now() - 30_000 } });
    const ask = (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 306)!;
    expect(ask).toMatchObject({ grant: GRANT, answers: ["grant", "text"], blockers: [] });
    // only the grant is answered here; a text to a stage Task's stop is still not
    expect((await answer(base, ask.id, { kind: "text", text: "x" })).status).toBe(422);
    const r = await answer(base, ask.id, { kind: "grant" });
    expect(r.status).toBe(200);
    expect(queued()[0]).toEqual([306, "comment", null, { body: `## 回答\n\n${GRANT}`, screen: true }]);
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    expect(prompts.at(-1)).toContain(`利用者が画面で答えた Issue #306 の最新の回答（利用者の言葉）:\n\n\`\`\`\`text\n${GRANT}\n\`\`\`\``);
    expect(((await (await fetch(`${base}/api/policies`)).json()) as { policies: unknown[] }).policies).toEqual([]);
  });

  test("confirmation: ok checks the line and, the PBI not closable yet, starts nothing; a no without a reason is 400", async () => {
    const base = await boot(fakeGh().gh);
    const c = (await asks(base)).find((a) => a.kind === "confirmation" && a.pbi?.number === 308)!;
    expect(c.answers).toEqual(["confirm"]);
    expect((await answer(base, c.id, { kind: "confirm", ok: false })).status).toBe(400);
    const r = await answer(base, c.id, { kind: "confirm", ok: true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as AskAnswerResult).ask).toMatchObject({ state: "answered", resume: null });
    expect(queued().map((o) => [o[0], o[1], o[2]])).toEqual([[308, "set", "body"], [308, "comment", null]]);
    expect(stageTasks(308)).toHaveLength(0);
  });

  test("kinds: a question this side does not answer is 422, an unknown id 409, a malformed answer 400", async () => {
    const base = await boot(fakeGh().gh);
    expect((await answer(base, "nothing:here", { kind: "text", text: "x" })).status).toBe(409);
    expect((await answer(base, "x", { kind: "nope" })).status).toBe(400);
    // a stop of #305's stage Task waits for the person, but its answer is not written from here yet
    const t = insertStage("#305 実装: PBI: 実装中の PBI", "done", { issue: 305, action: "complete" });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 305, taskId: t.id }, op: "ask", target: "", reason: "input", evidence: "どちらか", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() - 1000 } });
    const stop = (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 305)!;
    expect(stop.answers).toEqual(["text"]);
    expect((await answer(base, stop.id, { kind: "text", text: "x" })).status).toBe(422);
  });
});

/* ---------- the Task side (#1011): a tool approval, a check, a stop of a Task with no Issue ---------- */

const ASK_WRITE: AgentEvent = { t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: { file_path: "/tmp/x" }, detail: "write x" };
/** An operational check is the question tool's questions of the Task's last turn (#3122), not what the reply's text says. */
const CHECK_QS: AskQuestion[] = [{ header: null, question: "PR #12 をマージしてよいか", options: [{ label: "A: マージする (Recommended)", description: "CI が緑" }, { label: "B: 待つ", description: null }], multiSelect: false }];
const CONTINUE_QS: AskQuestion[] = [{ header: null, question: "続けるか", options: [{ label: "A: 続ける", description: null }], multiSelect: false }];
const OPEN_QS: AskQuestion[] = [{ header: null, question: "続けるか", options: [], multiSelect: false }];
const MERGE_LINE = "- PR #12 をマージしてよいか: A: マージする (Recommended)";
const MERGE_ANSWER = { kind: "questions", answers: [{ choices: ["A: マージする (Recommended)"] }] };
const checkTurn = (questions: AskQuestion[] = CHECK_QS): AgentEvent[] => [{ t: "question.ask", id: "q1", questions }, end("確認をお願いします")];
const end = (summary: string, status: "ok" | "error" = "ok"): AgentEvent => ({ t: "session.end", status, summary });
const LIMIT = "You've hit your session limit · resets 4:10am (Asia/Tokyo)";
const limitTurn = (): AgentEvent[] => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  return [{ t: "quota", runner: "claude", windows: { five_hour: { utilization: 1.06, resetsAt } }, status: "rejected", limitType: "five_hour" }, { t: "message.delta", role: "assistant", text: LIMIT }, end(LIMIT, "error")];
};

/**
 * A runner that plays one turn per start / send from `turns`, pausing on a permission.ask until it is answered (then the
 * rest of that turn); the process lingers after its turn. `allows` = the permission ids it was answered on.
 */
function scripted(turns: Array<AgentEvent[] | (() => AgentEvent[])>, allows: string[] = []): RunnerAdapter {
  let n = 0;
  const next = () => {
    const t = turns[n++] ?? [];
    return typeof t === "function" ? t() : t;
  };
  return {
    id: "claude",
    detect: async () => ({ available: true, version: "fake" }),
    start(_opts, emit) {
      let exit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (exit = r));
      let waiting: { id: string; rest: AgentEvent[] } | null = null;
      const play = (evs: AgentEvent[]) => {
        for (let k = 0; k < evs.length; k++) {
          const ev = evs[k]!;
          emit(ev);
          if (ev.t === "permission.ask") return void (waiting = { id: ev.id, rest: evs.slice(k + 1) });
        }
      };
      queueMicrotask(() => play(next()));
      return {
        send: (text: string) => {
          emit({ t: "message.delta", role: "user", text });
          queueMicrotask(() => play(next()));
        },
        respondPermission: (pid: string, decision: "allow" | "deny") => {
          if (waiting?.id !== pid) throw new Error("unexpected permission id");
          const rest = waiting.rest;
          waiting = null;
          allows.push(pid);
          emit({ t: "permission.resolved", id: pid, decision, by: "user" });
          queueMicrotask(() => play(rest));
        },
        abort: async () => exit(null),
        close: async () => exit(0),
        exited,
      } satisfies RunnerSession;
    },
  };
}

describe("POST /api/asks/answer — task side", () => {
  const until = async (ok: () => boolean | Promise<boolean>) => {
    for (let n = 0; n < 400 && !(await ok()); n++) await Bun.sleep(10);
  };
  const newTask = async (base: string, title: string, over: object = {}) => {
    const t = (await (await fetch(`${base}/api/tasks`, { method: "POST", body: JSON.stringify({ cwd: home, title, prompt: "go", runner: "claude", workspaceId: meta().id, ...over }) })).json()) as Task;
    return t.id;
  };
  const status = (id: string) => core!.db.getTask(id)!.status;
  const userTurns = (id: string) => core!.db.listEvents(id).filter((e) => e.ev.t === "message.delta" && e.ev.role === "user").map((e) => (e.ev as { text: string }).text);
  /** A Task that ended with the operational check, marked 要対応. */
  const checkTask = async (base: string, over: object = {}) => {
    const id = await newTask(base, "check me", over);
    await until(() => status(id) !== "running");
    await fetch(`${base}/api/tasks/${id}/outcome`, { method: "POST", body: JSON.stringify({ outcome: "needs_action" }) });
    return id;
  };
  const askOf = async (base: string, pred: (a: Ask) => boolean) => (await asks(base)).find(pred)!;
  const PR = (head: string) => ({ state: "OPEN", head, comments: [{ body: `[merge-ask] security ${ASKED}`, createdAt: new Date(Date.now() - 60_000).toISOString() }], commits: [] });

  test("task side: allow — the runner gets the allow once though two arrive at once, and the Task runs on", async () => {
    const allows: string[] = [];
    const base = await boot(fakeGh().gh, scripted([[ASK_WRITE, { t: "message.delta", role: "assistant", text: "writing" }]], allows));
    const id = await newTask(base, "approve me");
    await until(() => status(id) === "waiting");
    const ask = await askOf(base, (a) => a.kind === "approval" && a.task?.id === id);
    expect(ask.answers).toEqual(["allow", "deny"]);
    const [a, b] = await Promise.all([answer(base, ask.id, { kind: "allow" }), answer(base, ask.id, { kind: "allow" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [(await a.json()) as AskAnswerResult, (await b.json()) as AskAnswerResult];
    expect(bodies.map((x) => x.already).sort()).toEqual([false, true]);
    expect(allows).toEqual(["perm1"]);
    expect(bodies.find((x) => !x.already)!.ask).toMatchObject({ state: "answered", resume: { state: "running", taskId: id } });
    expect(status(id)).toBe("running");
  });

  test("task side: check — the recommended option is the Task's next user turn; the answer is answered", async () => {
    const base = await boot(fakeGh({ pr: PR(ASKED) }).gh, scripted([checkTurn(), [{ t: "message.delta", role: "assistant", text: "merging" }]]));
    const id = await checkTask(base);
    const ask = await askOf(base, (a) => a.kind === "check" && a.task?.id === id);
    expect(ask).toMatchObject({ answers: ["questions"], place: { pr: 12 }, recommendation: { choice: "A: マージする (Recommended)", why: "CI が緑" } });
    const r = await answer(base, ask.id, MERGE_ANSWER);
    expect(r.status).toBe(200);
    expect(((await r.json()) as AskAnswerResult).ask).toMatchObject({ state: "answered", changedAt: expect.any(Number) });
    await until(() => userTurns(id).includes(MERGE_LINE));
    expect(userTurns(id)).toEqual([MERGE_LINE]);
  });

  // the batch reads the choices of a check (#2778): it follows the question tool's questions in #3123
  test.skip("merge batch answers only the chosen, unchanged PRs", async () => {
    const sec = (pr: number) => `**確認**: PR #${pr} をマージしてよいか\n**止めた場所**: PR #${pr} のマージ判定\n[聞く] セキュリティ: security:github（+40/-5）\n**選択肢**:\n- A: マージする — CI が緑\n- B: 待つ`;
    const turn = (pr: number): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: sec(pr) }, end(sec(pr))];
    const view = (head: string): PrView => ({ state: "OPEN", head, comments: [{ body: `[merge-ask] security ${ASKED}`, createdAt: new Date(Date.now() - 60_000).toISOString() }], commits: [] });
    const base = await boot(fakeGh({ prs: { "21": view(ASKED), "22": view(HEAD), "23": view(ASKED) } }).gh, scripted([turn(21), turn(22), turn(23)]));
    const ids = [await checkTask(base, { title: "t21" }), await checkTask(base, { title: "t22" }), await checkTask(base, { title: "t23", budgetUsd: 0.01 })];
    await until(async () => ((await (await fetch(`${base}/api/asks`)).json()) as AskList).batches.some((b) => b.id === "batch:security-merge" && b.asks.length === 3));
    const shown = new Map(((await (await fetch(`${base}/api/asks`)).json()) as AskList).batches.find((b) => b.id === "batch:security-merge")!.asks.map((a) => [a.taskId, a.askId]));
    const post = (taskIds: string[]) => fetch(`${base}/api/asks/answer`, { method: "POST", body: JSON.stringify({ id: "batch:security-merge", answer: { kind: "allow" }, taskIds, askIds: taskIds.map((t) => shown.get(t) ?? `check:${t}:`) }) });
    // nothing chosen is nothing sent
    expect((await post([])).status).toBe(400);
    expect(((await (await post(["tk_not_in_batch"])).json()) as { results: unknown[] }).results).toMatchObject([{ taskId: "tk_not_in_batch", result: "changed" }]);
    const r = await post([ids[0]!, ids[1]!]);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: Array<{ taskId: string; result: string; detail?: string }> };
    expect(body.results.map((x) => [x.taskId, x.result])).toEqual([[ids[0]!, "sent"], [ids[1]!, "changed"]]);
    await until(() => userTurns(ids[0]!).length > 0);
    expect(userTurns(ids[0]!)).toEqual(["A: マージする — CI が緑"]);
    expect(userTurns(ids[1]!)).toEqual([]);
    expect(userTurns(ids[2]!)).toEqual([]);
    // the one sent has left the batch: a resend is changed and nothing is sent again
    expect(((await (await post([ids[0]!])).json()) as { results: unknown[] }).results).toMatchObject([{ taskId: ids[0]!, result: "changed" }]);
    expect(userTurns(ids[0]!)).toHaveLength(1);
    // a Task that refuses the reply (over its budget) is failed, not sent, and still waits in the batch
    core!.db.insertLedger({ taskId: ids[2]!, runner: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, source: "reported", ts: Date.now() });
    const refused = (await (await post([ids[2]!])).json()) as { results: Array<{ taskId: string; result: string; detail?: string }> };
    expect(refused.results).toMatchObject([{ taskId: ids[2]!, result: "failed" }]);
    expect(refused.results[0]!.detail).toContain("budget exceeded");
    expect(userTurns(ids[2]!)).toEqual([]);
  });

  test.skip("merge batch sends nothing to a Task whose question is not the one the screen showed", async () => {
    const sec = (pr: number) => `**確認**: PR #${pr} をマージしてよいか\n**止めた場所**: PR #${pr} のマージ判定\n[聞く] セキュリティ: security:github（+40/-5）\n**選択肢**:\n- A: マージする — CI が緑\n- B: 待つ`;
    const turn = (pr: number): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: sec(pr) }, end(sec(pr))];
    const view: PrView = { state: "OPEN", head: ASKED, comments: [{ body: `[merge-ask] security ${ASKED}`, createdAt: new Date(Date.now() - 60_000).toISOString() }], commits: [] };
    const base = await boot(fakeGh({ prs: { "31": view, "32": view } }).gh, scripted([turn(31), turn(32)]));
    const ids = [await checkTask(base, { title: "t31" }), await checkTask(base, { title: "t32" })];
    const batchOf = async () => ((await (await fetch(`${base}/api/asks`)).json()) as AskList).batches.find((b) => b.id === "batch:security-merge");
    await until(async () => (await batchOf())?.asks.length === 2);
    const shown = (await batchOf())!.asks;
    const askOfTask = (t: string) => shown.find((a) => a.taskId === t)!.askId;
    const post = (taskIds: string[], askIds: string[]) => fetch(`${base}/api/asks/answer`, { method: "POST", body: JSON.stringify({ id: "batch:security-merge", answer: { kind: "allow" }, taskIds, askIds }) });
    // the screen saw an earlier question of the first Task (it asked again since): nothing reaches it, the other still goes
    const r = await post([ids[0]!, ids[1]!], [`${askOfTask(ids[0]!)}:before`, askOfTask(ids[1]!)]);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: Array<{ taskId: string; result: string; detail?: string }> };
    expect(body.results.map((x) => [x.taskId, x.result])).toEqual([[ids[0]!, "changed"], [ids[1]!, "sent"]]);
    expect(body.results[0]!.detail).toContain("問いが変わった");
    await until(() => userTurns(ids[1]!).length > 0);
    expect(userTurns(ids[0]!)).toEqual([]);
    // the second Task's question has left the batch (answered above): that row only is changed, the first still goes
    const again = (await (await post([ids[1]!, ids[0]!], [askOfTask(ids[1]!), askOfTask(ids[0]!)])).json()) as { results: Array<{ taskId: string; result: string }> };
    expect(again.results.map((x) => [x.taskId, x.result])).toEqual([[ids[1]!, "changed"], [ids[0]!, "sent"]]);
    await until(() => userTurns(ids[0]!).length > 0);
    expect(userTurns(ids[1]!)).toHaveLength(1);
    // both answered, the batch is gone: a press from the old screen is each row changed, nothing sent
    await until(async () => !(await batchOf()));
    const gone = (await (await post([ids[0]!], [askOfTask(ids[0]!)])).json()) as { results: Array<{ taskId: string; result: string }> };
    expect(gone.results.map((x) => [x.taskId, x.result])).toEqual([[ids[0]!, "changed"]]);
    expect(userTurns(ids[0]!)).toHaveLength(1);
    // askIds are required and line up with taskIds; a Task twice is a bad request
    expect((await post([ids[0]!], [])).status).toBe(400);
    expect((await fetch(`${base}/api/asks/answer`, { method: "POST", body: JSON.stringify({ id: "batch:security-merge", answer: { kind: "allow" }, taskIds: [ids[0]!] }) })).status).toBe(400);
    expect((await post([ids[0]!, ids[0]!], [askOfTask(ids[0]!), askOfTask(ids[0]!)])).status).toBe(400);
  });

  test("task side: usage limit — the reply's turn stops at the limit; asked again, the answer says it waits for the limit to lift", async () => {
    const base = await boot(fakeGh().gh, scripted([checkTurn(CONTINUE_QS), limitTurn]));
    const id = await checkTask(base, { workspaceId: undefined });
    const ask = await askOf(base, (a) => a.kind === "check" && a.task?.id === id);
    expect((await answer(base, ask.id, { kind: "questions", answers: [{ choices: ["A: 続ける"] }] })).status).toBe(200);
    await until(() => core!.db.getTask(id)!.resumeAt !== null);
    const again = (await (await answer(base, ask.id, { kind: "questions", answers: [{ choices: ["A: 続ける"] }] })).json()) as AskAnswerResult;
    expect(again.already).toBe(true);
    expect(again.ask!.resume).toMatchObject({ state: "queued", taskId: id });
    expect(again.ask!.resume!.reason).toStartWith("使用上限の解除待ち");
  });

  test("task side: send fails — over its budget the reply is not sent: resume failed with the reason, the question still open", async () => {
    const base = await boot(fakeGh().gh, scripted([checkTurn(CONTINUE_QS)]));
    const id = await checkTask(base, { budgetUsd: 0.01 });
    core!.db.insertLedger({ taskId: id, runner: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, source: "reported", ts: Date.now() });
    const ask = await askOf(base, (a) => a.kind === "check" && a.task?.id === id);
    const body = (await (await answer(base, ask.id, { kind: "questions", answers: [{ choices: ["A: 続ける"] }] })).json()) as AskAnswerResult;
    expect(body.ask).toMatchObject({ state: "open", resume: { state: "failed", taskId: id } });
    expect(body.ask!.resume!.reason).toContain("budget exceeded");
    expect(userTurns(id)).toEqual([]);
    // the list says so too, the question still open
    expect(await askOf(base, (a) => a.id === ask.id)).toMatchObject({ state: "open", resume: { state: "failed" } });
    // not remembered as answered: the person can answer again once the budget is raised
    expect(((await (await answer(base, ask.id, { kind: "questions", answers: [{ choices: ["A: 続ける"] }] })).json()) as AskAnswerResult).already).toBe(false);
  });

  test("task side: pr changed — the head moved past its [merge-ask]: the option is 409 and nothing is sent", async () => {
    const base = await boot(fakeGh({ pr: PR(HEAD) }).gh, scripted([checkTurn(), []]));
    const id = await checkTask(base);
    const ask = await askOf(base, (a) => a.kind === "check" && a.task?.id === id);
    const r = await answer(base, ask.id, MERGE_ANSWER);
    expect(r.status).toBe(409);
    expect(((await r.json()) as AskChanged).changes).toEqual([`PR #12 の差分が変わりました（${ASKED.slice(0, 7)} → ${HEAD.slice(0, 7)}）`]);
    expect(userTurns(id)).toEqual([]);
  });

  test("task side: stale approval — answered on the Task's screen first, the answer here is 409 and the runner hears once", async () => {
    const allows: string[] = [];
    const base = await boot(fakeGh().gh, scripted([[ASK_WRITE, { t: "message.delta", role: "assistant", text: "writing" }]], allows));
    const id = await newTask(base, "approve me");
    await until(() => status(id) === "waiting");
    const ask = await askOf(base, (a) => a.kind === "approval" && a.task?.id === id);
    await fetch(`${base}/api/tasks/${id}/permission`, { method: "POST", body: JSON.stringify({ id: "perm1", decision: "allow" }) });
    expect((await answer(base, ask.id, { kind: "deny" })).status).toBe(409);
    expect(allows).toEqual(["perm1"]);
  });

  test("task side: a check with a stop condition not met takes no answer — a reply would set the Task going", async () => {
    const base = await boot(fakeGh().gh, scripted([checkTurn(OPEN_QS)]));
    const id = await checkTask(base, { workspaceId: undefined });
    core!.db.appendEvent(id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: null, issue: null, taskId: id }, op: "gh pr merge", target: "#12", reason: "depends", evidence: "CI", safety: "before-effect", conditions: [{ key: "ci", value: "failure", met: false }], answer: null, actions: [], state: "waiting", at: Date.now() } });
    const ask = await askOf(base, (a) => a.kind === "check" && a.task?.id === id);
    expect(ask).toMatchObject({ answers: [], blockers: [{ kind: "condition", detail: "ci: failure" }] });
    const r = await answer(base, ask.id, { kind: "text", text: "続けて" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as AskChanged).changes).toEqual(["ci: failure"]);
    expect(userTurns(id)).toEqual([]);
  });

  test("task side: a check about a PR of a Task with no workspace — its PR cannot be checked: an option is 409", async () => {
    const base = await boot(fakeGh().gh, scripted([checkTurn(), []]));
    const id = await checkTask(base, { workspaceId: undefined });
    const ask = await askOf(base, (a) => a.kind === "check" && a.task?.id === id);
    const r = await answer(base, ask.id, MERGE_ANSWER);
    expect(r.status).toBe(409);
    expect(((await r.json()) as AskChanged).changes[0]).toContain("確かめられません");
    expect(userTurns(id)).toEqual([]);
  });

  test("task side: runner refusal — a Task stopped only by the runner's refusal takes no answer; POST is 409 and nothing is sent", async () => {
    const base = await boot(fakeGh().gh, scripted([[end("止まった")]]));
    const id = await newTask(base, "refused", { workspaceId: undefined });
    await until(() => status(id) !== "running");
    core!.db.appendEvent(id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: null, issue: null, taskId: id }, op: "git push", target: "origin", reason: "permission", evidence: "denied", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() } });
    const ask = await askOf(base, (a) => a.kind === "stop" && a.task?.id === id);
    expect(ask.answers).toEqual([]);
    const r = await answer(base, ask.id, { kind: "text", text: "続けて" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as AskChanged).changes[0]).toContain("ランナー側の拒否");
    expect(userTurns(id)).toEqual([]);
  });

  test("task side: a stage Task's permission stop with its tool approval waiting is not the runner's refusal in GET /api/asks", async () => {
    const base = await boot(fakeGh().gh, scripted([[ASK_WRITE]]));
    const id = await newTask(base, "#305 実装: PBI: 実装中の PBI");
    await until(() => status(id) === "waiting");
    core!.db.appendEvent(id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 305, taskId: id }, op: "Write", target: "/tmp/x", reason: "permission", evidence: "approval", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() } });
    const items = (await asks(base)).filter((a) => a.pbi?.number === 305);
    expect(items.flatMap((a) => a.blockers).filter((b) => b.kind === "runner")).toEqual([]);
  });
});

describe("GET /api/asks — mockups (#2221)", () => {
  test("mockups: the Task a ## 判断待ち names with **画面イメージ** gives its HTML artifacts, not a removed one nor a text one", async () => {
    const base = await boot(fakeGh({ place: "Task #307\n**画面イメージ**: tsk_mock" }).gh);
    const at = Date.now() - 60_000;
    core!.db.insertTask({ id: "tsk_mock", workspaceId: meta().id, title: "mockups", stage: null, runner: "claude", cwd: home, scope: [home], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at });
    const add = async (name: string, body: string, title: string) => {
      await Bun.write(join(home, name), body);
      const r = await fetch(`${base}/api/tasks/tsk_mock/artifacts`, { method: "POST", body: JSON.stringify({ source: join(home, name), title }) });
      expect(r.status).toBe(201);
      return (await r.json()) as { id: string };
    };
    const a = await add("a.html", "<p>A</p>", "画面イメージ A: 上");
    const b = await add("b.html", "<p>B</p>", "画面イメージ B: 下");
    await add("notes.txt", "text", "メモ");
    expect((await fetch(`${base}/api/artifacts/${b.id}`, { method: "DELETE" })).status).toBe(200);
    const d = await decisionOf306(base);
    expect(d.mockups.map((m) => [m.id, m.title, m.mime])).toEqual([[a.id, "画面イメージ A: 上", "text/html"]]);
  });
});
