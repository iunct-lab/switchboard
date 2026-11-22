// test-reads: packages/core/fixtures/
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Ask, AskAnswerResult, AskQuestion, AskChanged, AskList, Backlog, RunnerAdapter, RunnerSession, Task } from "@switchboard/protocol";
import { importing } from "../fixtures/github-import.ts";
import { answerStoredDecision, screenAnswer } from "./backlog-edit.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";

/* POST /api/asks/answer, the Issue side: a fake runner and a fake gh, as asks.test.ts boots them. */

const pages = (await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json()) as unknown[];
const decisions = (await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json()) as { data: { repository: Record<string, { comments: { nodes: Array<{ body: string; createdAt: string }> } }> } };
const HEAD = "b".repeat(40);
/** The meta workspace is this checkout, whose origin is not the fake gh's acme/app: no origin to check (tasks.test.ts checks it). */
const FAKE_ORIGIN = () => null;
const ASKED = "a".repeat(40);

/**
 * The fixtures' gh. `place` replaces where Issue 306's question stopped; `pr` answers `gh pr view` (the PR the question names).
 * Every call is kept in `calls`.
 */
type PrView = { state: string; head: string; comments: Array<{ body: string; createdAt: string }>; commits: Array<{ committedDate: string }> };
function fakeGh(opts: { place?: string; pr?: PrView; prs?: Record<string, PrView>; tasks306?: string[]; /** Comments added to an Issue, by its alias (`i304`). */ comments?: Record<string, Array<{ body: string; createdAt: string }>> } = {}) {
  const calls: string[][] = [];
  const own = structuredClone(decisions);
  for (const [alias, nodes] of Object.entries(opts.comments ?? {})) own.data.repository[alias]!.comments.nodes.push(...nodes);
  if (opts.place) {
    const nodes = own.data.repository.i306!.comments.nodes;
    nodes[2] = { ...nodes[2]!, body: nodes[2]!.body.replace("**止めた場所**: Task #307", `**止めた場所**: ${opts.place}`) };
  }
  // one open Task of Issue 306 per file named (what its 実装 would touch)
  if (opts.tasks306) own.data.repository.i306 = { ...own.data.repository.i306!, subIssues: { nodes: opts.tasks306.map((f, n) => ({ number: 3061 + n, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: `触る場所: \`${f}\``, comments: { nodes: [] } })) } } as never;
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

async function boot(gh: GhRunner, adapter: RunnerAdapter = holding, pulls: Array<Record<string, unknown>> = []): Promise<string> {
  home = mkdtempSync(join(tmpdir(), "sb-asks-answer-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh, () => pulls), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
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
/** The screen's answer: the headers a browser adds on its own page (`page: false` = a bare call, as a Task's curl sends). */
const answer = (base: string, id: string, a: unknown, page = true, more: object = {}) => fetch(`${base}/api/asks/answer`, { method: "POST", headers: page ? { origin: base, "sec-fetch-site": "same-origin" } : {}, body: JSON.stringify({ id, answer: a, ...more }) });
/** What waits to be sent to GitHub: per operation, its Issue's number, kind, field and what is sent. */
const queued = () =>
  core!.db.listPendingBacklogOperations().map((o) => {
    const issue = core!.db.getBacklogRecord({ ...o, objectKind: "issue", externalId: o.issue });
    return [((issue?.local ?? issue?.remote) as { number: number } | null)?.number, o.kind, o.field, o.payload];
  });
const stageTasks = (n: number) => core!.db.listTasks().filter((t) => t.stage?.issue === n);
const B = "B: ファイル — 影響: 移行が要らない";
const meta = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
const insertStage = (title: string, status: Task["status"], stage: Task["stage"], at = Date.now() - 60_000) =>
  core!.db.insertTask({ id: `tsk_${status}_${at}`, workspaceId: meta().id, title, stage, runner: "claude", cwd: meta().path, scope: [meta().path], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at });

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
    expect(queued()).toEqual([[306, "comment", null, { body: `## 回答\n\n${B}\n\n移行はしない`, screen: true, heads: {} }], [306, "set", "label:needs-decision", false]]);
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
    expect(queued()[0]).toEqual([306, "comment", null, { body: "## 回答\n\nB で", screen: true, heads: {} }]);
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

  test("a stage Task already active before the answer is not the Task the answer started: no started: record, the card stays answered and queued", async () => {
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
    // the firing (its reply awaited above) may pick Issue 306 once answered: it finds that start under way or running, never a second one
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
    expect(queued()[0]).toEqual([306, "comment", null, { body: `## 回答\n\n差分が変わったのでマージ判定をやり直して\n\n（この回答は問いの時点の PR へのものです。回答の時点で: PR #12 の差分が変わりました（${ASKED.slice(0, 7)} → ${HEAD.slice(0, 7)}））`, screen: true, heads: {} }]);
  });

  test("a grant of the PR the question stopped at is for the head the answer was checked against: the PR is read once, not again for the grant", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const fake = fakeGh({ place: "PR #12（+40/-3）", pr: { state: "OPEN", head: HEAD, comments: [], commits: [] } });
    const base = await boot(fake.gh);
    const ask = await decisionOf306(base);
    expect((await answer(base, ask.id, { kind: "text", text: GRANT })).status).toBe(200);
    expect(queued()[0]).toEqual([306, "comment", null, { body: `## 回答\n\n${GRANT}`, screen: true, heads: { "acme/app#12": HEAD } }]);
    expect(fake.calls.filter((a) => a[0] === "pr")).toEqual([["pr", "view", "12", "-R", "acme/app", "--json", "state,headRefOid,comments,commits"]]);
  });

  test("a grant of the PR the question stopped at, in words given after the PR moved, is for the head read by the answer's check (the head at the answer), and the PR is not read again", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    // moved since the question: words still go, and their grant is for the head read now (the head when the answer was taken)
    const moved = fakeGh({ place: "PR #12（+40/-3）", pr: { state: "OPEN", head: HEAD, comments: [{ body: `[merge-ask] security ${ASKED}`, createdAt: "2026-09-22T02:00:00Z" }], commits: [] } });
    const base = await boot(moved.gh);
    expect((await answer(base, (await decisionOf306(base)).id, { kind: "text", text: GRANT })).status).toBe(200);
    expect((queued()[0]![3] as { heads: unknown }).heads).toEqual({ "acme/app#12": HEAD });
    expect(moved.calls.filter((a) => a[0] === "pr")).toHaveLength(1);
  });

  test("a grant of the PR the question stopped at is for no head when the answer's check read none: kept as not read, and the PR is not read again for the grant", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const none = fakeGh({ place: "PR #12（+40/-3）", pr: { state: "OPEN", head: null as never, comments: [], commits: [] } });
    const base = await boot(none.gh);
    expect((await answer(base, (await decisionOf306(base)).id, { kind: "text", text: GRANT })).status).toBe(200);
    expect((queued()[0]![3] as { heads: unknown }).heads).toEqual({ "acme/app#12": null });
    expect(none.calls.filter((a) => a[0] === "pr")).toHaveLength(1);
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

  test("重なり overlap: an answer to a Ready PBI whose Task names a file an open PR changes is written but starts no 実装 — queued with the log's reason; one with another file starts", async () => {
    const base = await boot(fakeGh({ tasks306: ["src/a.ts"] }).gh, holding, [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }]);
    const ask = await decisionOf306(base);
    const body = (await (await answer(base, ask.id, { kind: "choice", choice: B })).json()) as AskAnswerResult;
    expect(queued()[0]).toEqual([306, "comment", null, { body: `## 回答\n\n${B}`, screen: true, heads: {} }]);
    expect(stageTasks(306)).toEqual([]);
    expect(body.ask!.resume).toMatchObject({ state: "queued", taskId: null });
    expect(body.ask!.resume!.reason!.startsWith("重なり: #306（")).toBe(true);
    expect(body.ask!.resume!.reason).toContain("PR #900: src/a.ts");
  });

  test("重なり overlap: the same answer with the open PR on another file starts the 実装", async () => {
    const base = await boot(fakeGh({ tasks306: ["src/a.ts"] }).gh, holding, [{ number: 900, files: ["src/b.ts"], headRefName: "sb/999-x" }]);
    const ask = await decisionOf306(base);
    const body = (await (await answer(base, ask.id, { kind: "choice", choice: B })).json()) as AskAnswerResult;
    expect(body.ask!.resume).toMatchObject({ state: "running" });
    expect(stageTasks(306).map((t) => t.title.split(":")[0])).toEqual(["#306 実装"]);
  });

  test("重なり overlap: an answer while the PBI's 実装 already runs answers that Task, not the overlap refusal", async () => {
    const base = await boot(fakeGh({ tasks306: ["src/a.ts"] }).gh, holding, [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }]);
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "running", { issue: 306, action: "complete" });
    const ask = await decisionOf306(base);
    const body = (await (await answer(base, ask.id, { kind: "choice", choice: B })).json()) as AskAnswerResult;
    expect(stageTasks(306)).toHaveLength(1);
    expect(body.ask!.resume).toMatchObject({ state: "running", taskId: t.id });
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
    expect(queued()[0]).toEqual([306, "comment", null, { body: "## 回答\n\n直してから進めて", screen: true, heads: {} }]);
    expect(stageTasks(306)).toHaveLength(1); // the one inserted
    expect(body.ask!.resume).toMatchObject({ state: "queued", taskId: null });
    expect(body.ask!.resume!.reason).toContain("ci: failure");
    expect(body.ask!.resume!.reason).toContain("ランナー側の拒否");
  });

  // PR 12 as GitHub has it when a grant of it is recorded: the grant holds for this head
  const HEAD12 = "1".repeat(40);
  const PR12: PrView = { state: "OPEN", head: HEAD12, comments: [], commits: [] };

  test("merge grant on a stage Task's stop: the grant goes to that Task as one reply and is recorded for it — no new stage Task, nothing on the Issue", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const prompts: string[] = [];
    const base = await boot(fakeGh({ pr: PR12 }).gh, { ...holding, start: (o) => (prompts.push(o.prompt), holding.start(o, () => {})) });
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: "gh pr merge", target: "PR #12", reason: "permission", evidence: "refused", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: GRANT, at: Date.now() - 30_000 } });
    core!.db.updateTask(t.id, { outcome: "needs_action" }); // the stop is written straight to the log, so the outcome its record would set is set by hand
    const ask = (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 306)!;
    const r = (await (await answer(base, ask.id, { kind: "grant" })).json()) as AskAnswerResult;
    expect(r.ask).toMatchObject({ state: "answered", resume: { taskId: t.id } });
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    expect(prompts).toEqual([GRANT]);
    expect(stageTasks(306).map((x) => x.id)).toEqual([t.id]);
    expect(queued().filter((o) => o[0] === 306)).toEqual([]);
    expect(core!.db.hasMergeGrant(t.id, "acme/app", "merge", 12, HEAD12)).toBe(true); // for the Issue's repository
    expect(core!.db.hasMergeGrant(t.id, "acme/other", "merge", 12, HEAD12)).toBe(false);
    // the grant is of the head the PR had: another head is not granted
    expect(core!.db.hasMergeGrant(t.id, "acme/app", "merge", 12, "2".repeat(40))).toBe(false);
    // a resend of the same answer sends nothing more
    const again = (await (await answer(base, ask.id, { kind: "grant" })).json()) as AskAnswerResult;
    expect(again.already).toBe(true);
    await Bun.sleep(50);
    expect(prompts).toEqual([GRANT]);
    expect(grantRows().filter((g) => g.by === "owner")).toHaveLength(1);
  });

  test("merge grant on a stage Task's stop: the grant is not copied to a shadow running alongside that Task", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const prompts: string[] = [];
    const base = await boot(fakeGh({ pr: PR12 }).gh, { ...holding, start: (o) => (prompts.push(o.prompt), holding.start(o, () => {})) });
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    core!.db.insertTask({ ...t, id: "tsk_shadow", stage: null, shadowOf: t.id });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: "gh pr merge", target: "PR #12", reason: "permission", evidence: "refused", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: GRANT, at: Date.now() - 30_000 } });
    core!.db.updateTask(t.id, { outcome: "needs_action" });
    const ask = (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 306)!;
    const r = (await (await answer(base, ask.id, { kind: "grant" })).json()) as AskAnswerResult;
    expect(r.ask).toMatchObject({ state: "answered", resume: { taskId: t.id } });
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    await Bun.sleep(100);
    expect(prompts).toEqual([GRANT]);
  });

  test("merge grant on a stage Task's stop: it goes to that Task even when its PBI overlaps an open PR, and over the Task's budget it is refused — resume failed, the stop still open", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const prompts: string[] = [];
    const base = await boot(fakeGh({ pr: PR12, tasks306: ["src/a.ts"] }).gh, { ...holding, start: (o) => (prompts.push(o.prompt), holding.start(o, () => {})) }, [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }]);
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: "gh pr merge", target: "PR #12", reason: "permission", evidence: "refused", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: GRANT, at: Date.now() - 30_000 } });
    core!.db.updateTask(t.id, { outcome: "needs_action" });
    const ask = (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 306)!;
    core!.db.updateTask(t.id, { budgetUsd: 0.01 });
    core!.db.insertLedger({ taskId: t.id, runner: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, source: "reported", ts: Date.now() });
    const refused = (await (await answer(base, ask.id, { kind: "grant" })).json()) as AskAnswerResult;
    expect(refused.ask).toMatchObject({ state: "open", resume: { state: "failed", taskId: t.id } });
    expect(refused.ask!.resume!.reason).toContain("budget exceeded");
    expect(prompts).toEqual([]);
    // the budget raised, the same stop is answered again: sent to that Task, not held back by the overlap
    core!.db.updateTask(t.id, { budgetUsd: 100 });
    const r = (await (await answer(base, ask.id, { kind: "grant" })).json()) as AskAnswerResult;
    expect(r.ask).toMatchObject({ state: "answered", resume: { taskId: t.id } });
    expect(r.ask!.resume!.state).not.toBe("queued");
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    expect(prompts).toEqual([GRANT]);
    expect(stageTasks(306)).toHaveLength(1);
  });

  const startStage = async (base: string, n: number) => {
    const r = await fetch(`${base}/api/backlog/${n}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: meta().id, action: "complete" }) });
    expect([n, r.status]).toEqual([n, 201]);
    return ((await r.json()) as { id: string }).id;
  };
  const grantRows = () => core!.db.sqlite.query("SELECT task_id, repo, kind, target, by, source FROM task_grants ORDER BY rowid").all() as Array<{ task_id: string; repo: string; kind: string; target: number; by: string; source: string }>;
  const screenAnswerOn = (n: number, text: string) => answerStoredDecision(core!.db, core!.db.getWorkspaceBacklogSource(meta().id)!, n, text, Date.now(), { screen: true });

  test("merge grant: an answer without a grant sentence leaves nothing behind, however many stage Tasks start on it", async () => {
    const base = await boot(fakeGh().gh, { ...holding, start: (o) => holding.start(o, () => {}) });
    screenAnswerOn(306, "直してから進めて\n> PR #12 を判定の外でマージしてよい");
    for (let n = 0; n < 3; n++) {
      const id = await startStage(base, 306);
      core!.db.sqlite.run("UPDATE tasks SET status = 'done' WHERE id = ?", [id]);
    }
    expect(grantRows()).toEqual([]);
    expect(core!.db.getSetting<unknown>("mergeGrantAnswers", null)).toBeNull(); // no list of used answers is kept beside the grants
  });

  test("merge grant: an answer to an Issue's question is the person's permission only when the request came in as the screen's — a bare call's or a Task's starts the work and grants nothing", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const base = await boot(fakeGh({ pr: PR12 }).gh, { ...holding, start: (o) => holding.start(o, () => {}) });
    const source = core!.db.getWorkspaceBacklogSource(meta().id)!;
    const post = (body: object, page: boolean) => fetch(`${base}/api/backlog/306/answer`, { method: "POST", headers: { "content-type": "application/json", ...(page ? { origin: base, "sec-fetch-site": "same-origin" } : {}) }, body: JSON.stringify({ workspaceId: meta().id, ...body }) });
    const marks = () => core!.db.listBacklogOperations(source).filter((o) => o.kind === "comment").map((o) => { const p = o.payload as { screen?: boolean; by?: string }; return p.screen ? "screen" : (p.by ?? "none"); });
    // a Task's own call (no page headers), then one that looks like the page's but names the Task that sends it
    expect((await post({ text: GRANT }, false)).status).toBe(202);
    expect(screenAnswer(core!.db, source, 306)).toBeNull();
    const first = await startStage(base, 306);
    core!.db.sqlite.run("UPDATE tasks SET status = 'done' WHERE id = ?", [first]);
    expect(grantRows()).toEqual([]);
    expect(marks()).toEqual(["api"]);
  });

  test("merge grant: a stop answered with its grant by a bare call goes to that Task and is not the person's grant", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const prompts: string[] = [];
    const base = await boot(fakeGh({ pr: PR12 }).gh, { ...holding, start: (o) => (prompts.push(o.prompt), holding.start(o, () => {})) });
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: "gh pr merge", target: "PR #12", reason: "permission", evidence: "refused", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: GRANT, at: Date.now() - 30_000 } });
    core!.db.updateTask(t.id, { outcome: "needs_action" });
    const ask = (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 306)!;
    const r = (await (await answer(base, ask.id, { kind: "grant" }, false)).json()) as AskAnswerResult;
    expect(r.ask!.resume!.taskId).toBe(t.id);
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    expect(prompts.some((p) => p.includes(GRANT))).toBe(true);
    expect(stageTasks(306)).toHaveLength(1);
    expect(grantRows().filter((g) => g.by === "owner")).toEqual([]);
    expect(core!.db.hasMergeGrant(t.id, "acme/app", "merge", 12, HEAD12)).toBe(false);
  });

  test("merge grant: the answer route keeps who answered — the page's is the screen's answer, one that names a sending Task is that Task's", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const base = await boot(fakeGh({ pr: PR12 }).gh, { ...holding, start: (o) => holding.start(o, () => {}) });
    const source = core!.db.getWorkspaceBacklogSource(meta().id)!;
    const post = (n: number, body: object) => fetch(`${base}/api/backlog/${n}/answer`, { method: "POST", headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ workspaceId: meta().id, ...body }) });
    expect((await post(306, { text: GRANT, from: "task_abc" })).status).toBe(202);
    expect(screenAnswer(core!.db, source, 306)).toBeNull();
    expect(core!.db.listBacklogOperations(source).filter((o) => o.kind === "comment").map((o) => (o.payload as { by?: string }).by)).toEqual(["task:task_abc"]);
    const first = await startStage(base, 306);
    core!.db.sqlite.run("UPDATE tasks SET status = 'done' WHERE id = ?", [first]);
    expect(grantRows()).toEqual([]);
  });

  test("merge grant: the page's answer on the answer route is the person's, and its grant goes to the stage Task started after it", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const base = await boot(fakeGh({ pr: PR12 }).gh, { ...holding, start: (o) => holding.start(o, () => {}) });
    const source = core!.db.getWorkspaceBacklogSource(meta().id)!;
    const r = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ workspaceId: meta().id, text: GRANT }) });
    expect(r.status).toBe(202);
    expect(screenAnswer(core!.db, source, 306)?.text).toBe(GRANT);
    const first = await startStage(base, 306);
    expect(grantRows()).toEqual([{ task_id: first, repo: "acme/app", kind: "merge", target: 12, by: "owner", source: expect.stringMatching(/./) }]);
  });

  test("merge grant: an answer that gave its grant here is used for the release before this one too — its id is in the setting that release reads, in its form and within its bound, so a rollback does not give the grant again", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const base = await boot(fakeGh({ pr: PR12 }).gh, { ...holding, start: (o) => holding.start(o, () => {}) });
    // the setting as the release before left it: full to its bound
    const before = Array.from({ length: 200 }, (_, n) => `op_old_${n}`);
    core!.db.setSetting("mergeGrantAnswers", before);
    screenAnswerOn(306, GRANT);
    const first = await startStage(base, 306);
    const [row] = grantRows();
    expect(row).toMatchObject({ task_id: first, by: "owner" });
    // what that release does at the start of a stage: `used.includes(answer.id)` over this array decides whether the grant is given
    const used = core!.db.getSetting<string[]>("mergeGrantAnswers", []);
    expect(used.includes(row!.source)).toBe(true);
    expect(used).toEqual([...before.slice(1), row!.source]);
    // a second stage Task on the same answer: nothing more is granted, and the id is not written twice
    core!.db.sqlite.run("UPDATE tasks SET status = 'done' WHERE id = ?", [first]);
    await startStage(base, 306);
    expect(grantRows()).toEqual([row!]);
    expect(core!.db.getSetting<string[]>("mergeGrantAnswers", [])).toEqual(used);
  });

  test("merge grant: an answer on a PBI's Task gives its grant once — to the first stage Task started after it, however many grants came since", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const base = await boot(fakeGh({ tasks306: ["src/a.ts"], pr: PR12 }).gh, { ...holding, start: (o) => holding.start(o, () => {}) });
    // the person answers on the Issue of the PBI's Task (3061); the PBI's stage Task reads its Tasks' answers too
    screenAnswerOn(306, "進めて"); // the PBI's own question, so that its stage can start
    await Bun.sleep(5);
    screenAnswerOn(3061, `B — 許可: ${GRANT}`);
    const first = await startStage(base, 306);
    core!.db.sqlite.run("UPDATE tasks SET status = 'done' WHERE id = ?", [first]);
    const rows = grantRows();
    expect(rows).toEqual([{ task_id: first, repo: "acme/app", kind: "merge", target: 12, by: "owner", source: expect.stringMatching(/./) }]);
    // far more grants than any list of used answers would hold are recorded in between: the answer's own record still says it is spent
    for (let n = 0; n < 250; n++) core!.db.recordMergeGrant({ taskId: `tsk_other_${n}`, repo: "acme/app", kind: "merge", target: 1000 + n, by: "owner", source: `op_other_${n}` });
    const second = await startStage(base, 306);
    expect(second).not.toBe(first);
    core!.db.sqlite.run("UPDATE tasks SET status = 'done' WHERE id = ?", [second]);
    const third = await startStage(base, 306);
    for (const id of [second, third]) expect([id, core!.db.hasMergeGrant(id, "acme/app", "merge", 12, HEAD12)]).toEqual([id, false]);
    expect(core!.db.hasMergeGrant(first, "acme/app", "merge", 12, HEAD12)).toBe(true);
    expect(grantRows().filter((r) => r.source === rows[0]!.source)).toEqual(rows);
  });

  test("permission stop grant reply: a stage Task's refused stop is answered by its grant as one reply to that Task — nothing on the Issue, no next stage Task", async () => {
    const GRANT = "git push を origin の sb/x にすることだけ許可します";
    const prompts: string[] = [];
    const base = await boot(fakeGh().gh, { ...holding, start: (o) => (prompts.push(o.prompt), holding.start(o, () => {})) });
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: "git push", target: "sb/x", reason: "permission", evidence: "denied", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant: GRANT, at: Date.now() - 30_000 } });
    core!.db.updateTask(t.id, { outcome: "needs_action" }); // the stop is written straight to the log, so the outcome its record would set is set by hand
    const ask = (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 306)!;
    expect(ask).toMatchObject({ grant: GRANT, answers: ["grant", "text"], blockers: [] });
    const r = await answer(base, ask.id, { kind: "grant" });
    expect(r.status).toBe(200);
    expect(queued().filter((o) => o[0] === 306)).toEqual([]);
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    expect(prompts).toEqual([GRANT]);
    // a resend of the grant keeps how it goes on: the stopped Task, read again
    const first = ((await r.json()) as AskAnswerResult).ask!.resume;
    expect(first?.taskId).toBe(t.id);
    const again = (await (await answer(base, ask.id, { kind: "grant" })).json()) as AskAnswerResult;
    expect(again).toMatchObject({ already: true, ask: { resume: { taskId: t.id } } });
    expect(stageTasks(306).map((x) => x.id)).toEqual([t.id]);
    expect(((await (await fetch(`${base}/api/policies`)).json()) as { policies: unknown[] }).policies).toEqual([]);
  });

  test("grant changed: a stage Task's permission stop reported again with another grant is another question — its grant button sends the new grant once, and an answer to the id the stop had before is 409 with the question now", async () => {
    const [A, MID, B] = ["git push を origin の sb/x にすることだけ許可します", "git push を origin の sb/y にすることだけ許可します", "git push を origin の sb/z にすることだけ許可します"];
    const prompts: string[] = [];
    const turns = scripted([[end("止まった")], [end("止まった")], [end("止まった")]]);
    const base = await boot(fakeGh().gh, { ...turns, start: (o, emit) => (prompts.push(o.prompt), ((s) => ({ ...s, send: (text: string) => (prompts.push(text), s.send(text)) }))(turns.start(o, emit))) });
    const t = insertStage("#306 実装: PBI: 判断待ちの PBI", "done", { issue: 306, action: "complete" });
    // the same stop (id, op, target, reason) reported with `grant`; the outcome its record would set is set by hand
    const report = async (grant: string) => {
      for (let n = 0; n < 400 && core!.db.getTask(t.id)!.status !== "done"; n++) await Bun.sleep(10);
      await Bun.sleep(2);
      core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: 306, taskId: t.id }, op: "git push", target: "sb/x", reason: "permission", evidence: "denied", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant, at: Date.now() } });
      core!.db.updateTask(t.id, { outcome: "needs_action" });
      return (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === 306)!;
    };
    const grant = async (id: string) => {
      const r = await answer(base, id, { kind: "grant" });
      return { status: r.status, body: (await r.json()) as AskAnswerResult & AskChanged };
    };
    const first = await report(A);
    expect(first).toMatchObject({ grant: A, state: "open", answers: ["grant", "text"] });
    expect(first.id).toMatch(/^stop:.+@\d+$/);
    expect(await grant(first.id)).toMatchObject({ status: 200, body: { already: false } });
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    expect(prompts).toEqual([A]);
    // reported again with another grant, twice: each is a question of its own, under the same id up to the time
    const mid = await report(MID);
    const now = await report(B);
    expect(now).toMatchObject({ grant: B, state: "open", answers: ["grant", "text"] });
    expect(new Set([first.id, mid.id, now.id]).size).toBe(3);
    expect(new Set([first.id, mid.id, now.id].map((id) => id.slice(0, id.lastIndexOf("@")))).size).toBe(1);
    // the id the stop had with the grant before (never answered): 409 with the question now, nothing sent
    expect(await grant(mid.id)).toMatchObject({ status: 409, body: { error: "問いが新しくなりました", current: { id: now.id, grant: B } } });
    // the id answered with the first grant: not its kept result while the stop asks again with another grant
    expect(await grant(first.id)).toMatchObject({ status: 409, body: { error: "問いが新しくなりました", current: { id: now.id, grant: B } } });
    expect(prompts).toEqual([A]);
    // the question now: not the first answer's result — the new grant goes to the Task
    expect(await grant(now.id)).toMatchObject({ status: 200, body: { already: false, ask: { resume: { taskId: t.id } } } });
    for (let n = 0; n < 200 && prompts.length < 2; n++) await Bun.sleep(10);
    expect(prompts).toEqual([A, B]);
    // a resend of that answer, and one of the first answer under its own id: the result kept, nothing more sent
    expect(await grant(now.id)).toMatchObject({ status: 200, body: { already: true } });
    expect(await grant(first.id)).toMatchObject({ status: 200, body: { already: true } });
    await Bun.sleep(50);
    expect(prompts).toEqual([A, B]);
    expect(queued().filter((o) => o[0] === 306)).toEqual([]);
    expect(stageTasks(306).map((x) => x.id)).toEqual([t.id]);
    expect(core!.db.askAnswer(mid.id)).toBeNull();
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

  test("kinds: an unknown id is 409, a malformed answer 400", async () => {
    const base = await boot(fakeGh().gh);
    expect((await answer(base, "nothing:here", { kind: "text", text: "x" })).status).toBe(409);
    expect((await answer(base, "x", { kind: "nope" })).status).toBe(400);
  });

  /** A stage Task of Issue `n` stopped for the person (`input`), with no process: a reply resumes it. */
  const stoppedStage = (n: number, over: { budgetUsd?: number } = {}) => {
    const t = insertStage(`#${n} 実装: PBI: 実装中の PBI`, "done", { issue: n, action: "complete" });
    if (over.budgetUsd !== undefined) core!.db.updateTask(t.id, { budgetUsd: over.budgetUsd });
    core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: meta().id, issue: n, taskId: t.id }, op: "ask", target: "", reason: "input", evidence: "どちらか", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() - 1000 } });
    core!.db.updateTask(t.id, { outcome: "needs_action" }); // the stop is written straight to the log, so the outcome its record would set is set by hand
    return t;
  };
  const userTurnsOf = (id: string) => core!.db.listEvents(id).filter((e) => e.ev.t === "message.delta" && e.ev.role === "user").map((e) => (e.ev as { text: string }).text);
  const stopOf = async (base: string, n: number) => (await asks(base)).find((a) => a.kind === "stop" && a.pbi?.number === n)!;

  test("stage Task stop reply: a text is one reply to the Task, nothing on the Issue, no policy; the answer says it runs; a resend sends nothing more", async () => {
    const prompts: string[] = [];
    const base = await boot(fakeGh().gh, { ...holding, start: (o, emit) => (prompts.push(o.prompt), emit({ t: "message.delta", role: "user", text: o.prompt }), holding.start(o, emit)) });
    const t = stoppedStage(305);
    const stop = await stopOf(base, 305);
    expect(stop).toMatchObject({ answers: ["text"], policy: { scopes: [] }, task: { id: t.id } });
    const r = await answer(base, stop.id, { kind: "text", text: "A で進めて" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AskAnswerResult;
    expect(body).toMatchObject({ already: false, ask: { state: "answered", resume: { state: "running", taskId: t.id } } });
    for (let n = 0; n < 200 && !prompts.length; n++) await Bun.sleep(10);
    expect(prompts).toEqual(["A で進めて"]);
    expect(queued().filter((o) => o[0] === 305)).toEqual([]);
    // the list reads the same Task: answered, going on
    expect(await stopOf(base, 305)).toMatchObject({ state: "answered", resume: { state: "running", taskId: t.id } });
    const again = (await (await answer(base, stop.id, { kind: "text", text: "A で進めて" })).json()) as AskAnswerResult;
    expect(again).toMatchObject({ already: true, ask: { state: "answered" } });
    await Bun.sleep(50);
    expect(prompts).toEqual(["A で進めて"]);
    expect(((await (await fetch(`${base}/api/policies`)).json()) as { policies: unknown[] }).policies).toEqual([]);
  });

  test("stage Task stop reply: over the Task's budget the reply is refused — resume failed, the stop still open and answerable again", async () => {
    const base = await boot(fakeGh().gh);
    const t = stoppedStage(305, { budgetUsd: 0.01 });
    core!.db.insertLedger({ taskId: t.id, runner: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, source: "reported", ts: Date.now() });
    const stop = await stopOf(base, 305);
    const body = (await (await answer(base, stop.id, { kind: "text", text: "A で進めて" })).json()) as AskAnswerResult;
    expect(body.ask).toMatchObject({ state: "open", resume: { state: "failed", taskId: t.id } });
    expect(body.ask!.resume!.reason).toContain("budget exceeded");
    expect(userTurnsOf(t.id)).toEqual([]);
    expect(await stopOf(base, 305)).toMatchObject({ state: "open", resume: { state: "failed", taskId: t.id } });
    expect(((await (await answer(base, stop.id, { kind: "text", text: "A で進めて" })).json()) as AskAnswerResult).already).toBe(false);
  });
});

/* ---------- the Task side: a tool approval, a check, a stop of a Task with no Issue ---------- */

const ASK_WRITE: AgentEvent = { t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: { file_path: "/tmp/x" }, detail: "write x" };
/** An operational check is the question tool's questions of the Task's last turn, not what the reply's text says. */
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

describe("POST /api/asks/answer — questions the work went on from with their recommendation", () => {
  const ASKED_AT = "2026-09-25T00:00:00Z";
  // (no word of the table's stop list in it: a question with one would wait, not go on)
  const B = "B: ファイル — 影響: 読み口はそのまま";
  const GO = ["## 判断待ち", "", "**問い**: 保存先をどちらにするか", "**選択肢**:", "- A: DB — 影響: 読み口を書き換える", `- ${B}`, "**推奨**: A — 今の読み口のまま", "**進め方**: 推奨で進める（種類: task-order） — 戻せる変更"].join("\n"); // on a PBI's own Issue: the kind a PBI can carry (its place is checked)
  const going = () => fakeGh({ comments: { i304: [{ body: GO, createdAt: ASKED_AT }], i305: [{ body: GO, createdAt: ASKED_AT }] } });
  const proceeding = async (base: string) => (await asks(base)).filter((a) => a.proceeding);
  const comments = () => queued().filter((o) => o[1] === "comment");
  const NAMED = ` — 問い ${new Date(ASKED_AT).toISOString()}`;

  test("a stage Task that posts a 推奨で進める question the work may not go on from stops at that question: the comment route says why, the Task's turn is ended, and the PBI waits for the person; a question that may go on, or one another Task or a call with no sender wrote, leaves the Task running", async () => {
    const base = await boot(fakeGh().gh, { ...holding, start: (o) => holding.start(o, () => {}) });
    const start = async (n: number) => ((await (await fetch(`${base}/api/backlog/${n}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: meta().id, action: "complete" }) })).json()) as { id: string }).id;
    // `as`: the Task the request proves it comes from (the headers `ops-kit backlog comment` sends); `token` replaces the Task's own
    const proofOf = async (id: string) => ((await (await fetch(`${base}/api/tasks/${id}/mcp`)).json()) as { token: string }).token;
    const post = async (n: number, text: string, as?: string, token?: string) => (await (await fetch(`${base}/api/backlog/${n}/comment`, { method: "POST", headers: as ? { "x-task-id": as, "x-task-token": token ?? (await proofOf(as)) } : {}, body: JSON.stringify({ workspaceId: meta().id, text }) })).json()) as { operation: string; waits?: string };
    const status = (id: string) => core!.db.getTask(id)!.status;
    const going = await start(304);
    const stopping = await start(305);
    expect([status(going), status(stopping)]).toEqual(["running", "running"]);
    // 304: the order of its Tasks — the table lets it go on
    expect((await post(304, GO, going)).waits).toBeUndefined();
    // 305: the operation is in a code fence and the kind says it is an implementation choice
    const fenced = ["## 判断待ち", "**問い**: どちらで進めるか", "**選択肢**:", "- A: 下のコマンドで直す", "- B: 待つ", "**推奨**: A", "**進め方**: 推奨で進める（種類: implementation-choice）", "```bash", "gh repo edit --visibility public", "```"].join("\n");
    // written on 305 by the other PBI's Task, and by a call that names no sender: the question waits for the person, but
    // it is not the question of the Task at work on 305 — a comment does not end another Task's turn
    for (const sender of [going, undefined]) {
      expect((await post(305, fenced, sender)).waits).toContain("安全の確認に当たる語");
      await Bun.sleep(100);
      expect([status(going), status(stopping)]).toEqual(["running", "running"]);
      expect(core!.db.listEvents(stopping).some((e) => e.ev.t === "status" && e.ev.text.includes("この Task はここで止めます"))).toBe(false);
    }
    // the Task at work on 305 merely named — with no token, with another Task's token, or in the body (which the route
    // does not take): the refusal is said, and its turn goes on
    for (const token of ["", await proofOf(going)]) {
      expect((await post(305, fenced, stopping, token)).waits).toContain("安全の確認に当たる語");
      await Bun.sleep(100);
      expect([status(going), status(stopping)]).toEqual(["running", "running"]);
    }
    expect((await fetch(`${base}/api/backlog/305/comment`, { method: "POST", body: JSON.stringify({ workspaceId: meta().id, text: fenced, from: stopping }) })).status).toBe(400);
    await Bun.sleep(100);
    expect(status(stopping)).toBe("running");
    // by the Task at work on 305 itself: it stops
    const refused = await post(305, fenced, stopping);
    expect(refused.waits).toContain("安全の確認に当たる語");
    for (let n = 0; n < 200 && status(stopping) !== "aborted"; n++) await Bun.sleep(10);
    expect([status(going), status(stopping)]).toEqual(["running", "aborted"]);
    expect(core!.db.listEvents(stopping).some((e) => e.ev.t === "status" && e.ev.text.includes("「推奨で進める」では進められません") && e.ev.text.includes("この Task はここで止めます"))).toBe(true);
    // the PBI waits for the person like a labelled one; the other goes on
    const items = ((await (await fetch(`${base}/api/backlog?workspaceId=${meta().id}`)).json()) as { items: Array<{ number: number; stage: string }> }).items;
    expect(items.find((i) => i.number === 305)!.stage).toBe("needs-decision");
    expect(items.find((i) => i.number === 304)!.stage).not.toBe("needs-decision");
  });

  test("proceed-all: one answer confirms every such question of the Workspace on its own Issue, leaves a waiting decision alone, starts nothing; sent again it confirms none", async () => {
    const base = await boot(going().gh);
    const open = await proceeding(base);
    expect(open.map((a) => [a.pbi?.number, a.state, a.needs, a.answers]).sort()).toEqual([[304, "open", "auto", ["confirm", "choice", "text"]], [305, "open", "auto", ["confirm", "choice", "text"]]]);
    // a call that is not the page's (a Task's token or curl) cannot confirm in the person's name, at once or one by one
    const askIds = open.map((a) => a.id);
    for (const id of [`proceed-all:${meta().id}`, open[0]!.id]) {
      const bare = await answer(base, id, { kind: "confirm", ok: true }, false, { askIds });
      expect(bare.status).toBe(403);
      expect(((await bare.json()) as { reason: string }).reason).toBe("human");
    }
    expect(comments()).toEqual([]);
    // only a confirmation is taken by this id
    expect((await answer(base, `proceed-all:${meta().id}`, { kind: "allow" })).status).toBe(400);
    expect((await answer(base, `proceed-all:${meta().id}`, { kind: "confirm", ok: false, text: "違う" })).status).toBe(400);
    // without the questions the screen showed nothing is confirmed: the set is never read anew for the person
    expect((await answer(base, `proceed-all:${meta().id}`, { kind: "confirm", ok: true })).status).toBe(400);
    expect((await answer(base, `proceed-all:${meta().id}`, { kind: "confirm", ok: true }, true, { askIds: [] })).status).toBe(400);
    expect(comments()).toEqual([]);
    const r = await answer(base, `proceed-all:${meta().id}`, { kind: "confirm", ok: true }, true, { askIds });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { confirmed: string[] }).confirmed.sort()).toEqual(open.map((a) => a.id).sort());
    // one ## 回答 per Issue, not marked as the person's words to a stage Task, and no label operation (there is none to take off)
    expect(queued().sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([304, 305].map((n) => [n, "comment", null, { body: `## 回答\n\n**確定**: 推奨のまま A（まとめて）${NAMED}` }]));
    expect(core!.db.listTasks().filter((t) => t.stage)).toEqual([]);
    expect((await decisionOf306(base)).state).toBe("open");
    expect((await proceeding(base)).map((a) => a.state)).toEqual(["answered", "answered"]);
    const again = await answer(base, `proceed-all:${meta().id}`, { kind: "confirm", ok: true }, true, { askIds });
    expect(((await again.json()) as { confirmed: string[] }).confirmed).toEqual([]);
    expect(comments()).toHaveLength(2);
    // another Workspace's id confirms nothing
    expect(((await (await answer(base, "proceed-all:ws_none", { kind: "confirm", ok: true }, true, { askIds })).json()) as { confirmed: string[] }).confirmed).toEqual([]);
  });

  test("proceed-all confirms only the questions the screen showed: one of the Workspace that was not on it stays open and gets no ## 回答", async () => {
    const base = await boot(going().gh);
    const open = await proceeding(base);
    const [seen, unseen] = [open.find((a) => a.pbi?.number === 304)!, open.find((a) => a.pbi?.number === 305)!];
    // the screen was drawn with one question; the other came up before the press (or the id sent is not one of this list)
    const r = await answer(base, `proceed-all:${meta().id}`, { kind: "confirm", ok: true }, true, { askIds: [seen.id, "proceed:ws_none#1@0"] });
    expect(((await r.json()) as { confirmed: string[] }).confirmed).toEqual([seen.id]);
    expect(queued().map((q) => q[0])).toEqual([304]);
    expect((await proceeding(base)).map((a) => [a.pbi?.number, a.state]).sort()).toEqual([[304, "answered"], [305, "open"]]);
    expect(unseen.id).not.toBe(seen.id);
  });

  test("overturn: another choice writes ## 回答 with the 覆す line and starts one stage Task with it; sent again it starts no more", async () => {
    const base = await boot(going().gh);
    const ask = (await proceeding(base)).find((a) => a.pbi?.number === 304)!;
    const r = await answer(base, ask.id, { kind: "choice", choice: B });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AskAnswerResult;
    expect(body).toMatchObject({ already: false, ask: { id: ask.id, state: "answered", resume: { state: "running" } } });
    expect(comments()).toEqual([[304, "comment", null, { body: `## 回答\n\n**覆す**: 推奨 A → B${NAMED}\n\n${B}`, screen: true, heads: {} }]]);
    expect(stageTasks(304)).toHaveLength(1);
    expect(body.ask!.resume!.taskId).toBe(stageTasks(304)[0]!.id);
    const again = (await (await answer(base, ask.id, { kind: "choice", choice: B })).json()) as AskAnswerResult;
    expect(again.already).toBe(true);
    expect(comments()).toHaveLength(1);
    expect(stageTasks(304)).toHaveLength(1);
    // words of the person's own overturn it too
    const other = (await proceeding(base)).find((a) => a.pbi?.number === 305)!;
    await answer(base, other.id, { kind: "text", text: "C の読みで" });
    expect(comments()[1]).toEqual([305, "comment", null, { body: `## 回答\n\n**覆す**: 推奨 A → 自由文${NAMED}\n\nC の読みで`, screen: true, heads: {} }]);
  });

  // two questions on one PBI's Issue that could not go on (no kind said): the older keeps its `proceed:` id, the newer is the waiting decision
  const T1 = "2026-09-25T00:00:00Z";
  const T2 = "2026-09-25T00:00:02Z";
  const STOPPED = (q: string) => ["## 判断待ち", "", `**問い**: ${q}`, "**選択肢**:", "- A: DB — 影響: 読み口を書き換える", `- ${B}`, "**推奨**: A — 今の読み口のまま", "**進め方**: 推奨で進める"].join("\n");
  const stoppedTwice = () => fakeGh({ comments: { i304: [{ body: STOPPED("保存先をどちらにするか"), createdAt: T1 }, { body: STOPPED("読み口をどちらにするか"), createdAt: T2 }] } });
  const of304 = async (base: string) => {
    const on = (await asks(base)).filter((a) => a.pbi?.number === 304);
    return { older: on.find((a) => a.id.startsWith("proceed:") && a.id.endsWith(`@${T1}`))!, newer: on.find((a) => a.id.endsWith(`@${T2}`))!, all: on };
  };

  test("two stopped questions on one Issue: an answer to the older one names it, so it alone is answered — also when the list is read again — and the newer one still waits", async () => {
    const base = await boot(stoppedTwice().gh);
    const before = await of304(base);
    expect(before.all.map((a) => [a.id.split(":")[0], a.state, a.needs, a.proceeding ?? null]).sort()).toEqual([["decision", "open", "person", null], ["proceed", "open", "person", null]]);
    const r = (await (await answer(base, before.older.id, { kind: "choice", choice: B })).json()) as AskAnswerResult;
    expect(r).toMatchObject({ already: false, ask: { id: before.older.id, state: "answered" } });
    // nothing confirmed or overturned: the first line only names the question
    expect(comments()).toEqual([[304, "comment", null, { body: `## 回答\n\n**止めて聞く問いへの回答** — 問い ${new Date(T1).toISOString()}\n\n${B}`, screen: true, heads: {} }]]);
    const after = await of304(base);
    expect([after.older.state, after.newer.state]).toEqual(["answered", "open"]);
    expect(after.newer.id).toBe(before.newer.id);
  });

  test("two stopped questions on one Issue: an answer to the newer one answers it alone — the older one stays open in the reply and when the list is read again", async () => {
    const base = await boot(stoppedTwice().gh);
    const before = await of304(base);
    const r = (await (await answer(base, before.newer.id, { kind: "choice", choice: B })).json()) as AskAnswerResult;
    expect(r).toMatchObject({ already: false, ask: { id: before.newer.id, state: "answered" } });
    expect(comments()).toHaveLength(1);
    const after = (await asks(base)).filter((a) => a.pbi?.number === 304);
    expect(after.find((a) => a.id === before.older.id)!.state).toBe("open");
    // the newer one reads as answered, not as gone or open
    expect(after.filter((a) => a.id === before.newer.id).map((a) => a.state)).not.toContain("open");
    expect(after.filter((a) => a.id !== before.older.id).map((a) => [a.kind, a.state])).toEqual([["decision", "answered"]]);
    expect(after.filter((a) => a.state === "open").map((a) => a.id)).toEqual([before.older.id]);
  });

  test("an answer to an Issue's question given on the screen keeps the head of the PR its grant names, read when it was answered — a stopped question's and an overturned one's alike", async () => {
    const GRANT = "PR #12 を判定の外でマージしてよい";
    const HEAD = "1".repeat(40);
    const fake = fakeGh({ pr: { state: "OPEN", head: HEAD, comments: [], commits: [] }, comments: { i304: [{ body: STOPPED("保存先をどちらにするか"), createdAt: T1 }, { body: STOPPED("読み口をどちらにするか"), createdAt: T2 }], i305: [{ body: GO, createdAt: ASKED_AT }] } });
    const base = await boot(fake.gh);
    const headReads = () => fake.calls.filter((c) => c[0] === "pr" && c.at(-1) === "headRefOid").length;
    const kept = (n: number) => comments().filter((o) => o[0] === n).map((o) => (o[3] as { screen?: boolean; heads?: unknown }));
    // a stopped question, on the screen: one read of the PR, kept with the answer
    await answer(base, (await of304(base)).older.id, { kind: "text", text: GRANT });
    expect(kept(304)).toMatchObject([{ screen: true, heads: { "acme/app#12": HEAD } }]);
    expect(headReads()).toBe(1);
    // a question the work went on from, overturned on the screen with words that carry the grant
    await answer(base, (await proceeding(base)).find((a) => a.pbi?.number === 305)!.id, { kind: "text", text: GRANT });
    expect(kept(305)).toMatchObject([{ screen: true, heads: { "acme/app#12": HEAD } }]);
  });

  test("the recommended choice confirms: ## 回答 with the 確定 line, and no stage Task", async () => {
    const base = await boot(going().gh);
    const ask = (await proceeding(base)).find((a) => a.pbi?.number === 304)!;
    const body = (await (await answer(base, ask.id, { kind: "choice", choice: "A: DB — 影響: 読み口を書き換える" })).json()) as AskAnswerResult;
    expect(body).toMatchObject({ already: false, ask: { state: "answered", resume: null } });
    expect(comments()).toEqual([[304, "comment", null, { body: `## 回答\n\n**確定**: 推奨のまま A${NAMED}` }]]);
    expect(stageTasks(304)).toHaveLength(0);
    // it cannot be put on hold: nothing waits on it
    const other = (await proceeding(base)).find((a) => a.pbi?.number === 305)!;
    expect((await answer(base, other.id, { kind: "hold" })).status).toBe(409);
  });
});

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
    expect(ask).toMatchObject({ answers: ["questions"], place: null, recommendation: null });
    const r = await answer(base, ask.id, MERGE_ANSWER);
    expect(r.status).toBe(200);
    expect(((await r.json()) as AskAnswerResult).ask).toMatchObject({ state: "answered", changedAt: expect.any(Number) });
    await until(() => userTurns(id).includes(MERGE_LINE));
    expect(userTurns(id)).toEqual([MERGE_LINE]);
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

  test("task side: a check with a stop condition not met is still answered — an old stop does not take the options away", async () => {
    const base = await boot(fakeGh().gh, scripted([checkTurn(CONTINUE_QS), []]));
    const id = await checkTask(base, { workspaceId: undefined });
    // a stop that waits on the person (decision): a depends stop would make the Task wait on something else, with no check (personWait)
    core!.db.appendEvent(id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: null, issue: null, taskId: id }, op: "gh pr merge", target: "#12", reason: "decision", evidence: "CI", safety: "before-effect", conditions: [{ key: "ci", value: "failure", met: false }], answer: null, actions: [], state: "waiting", at: Date.now() } });
    const ask = await askOf(base, (a) => a.kind === "check" && a.task?.id === id);
    expect(ask).toMatchObject({ answers: ["questions"], blockers: [] });
    expect((await answer(base, ask.id, { kind: "questions", answers: [{ choices: ["A: 続ける"] }] })).status).toBe(200);
    await until(() => userTurns(id).length === 1);
    expect(userTurns(id)).toEqual(["- 続けるか: A: 続ける"]);
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

  test("task side: grant changed — a Task's permission stop reported again with another grant is another question, and its grant button sends the new grant to the Task", async () => {
    const [A, B] = ["git push を origin の sb/x にすることだけ許可します", "git push を origin の sb/y にすることだけ許可します"];
    const base = await boot(fakeGh().gh, scripted([[end("止まった")], [end("止まった")], [end("止まった")]]));
    const id = await newTask(base, "refused", { workspaceId: undefined });
    const report = async (grant: string) => {
      await until(() => status(id) !== "running");
      await Bun.sleep(2);
      core!.db.appendEvent(id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: null, issue: null, taskId: id }, op: "git push", target: "origin", reason: "permission", evidence: "denied", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant, at: Date.now() } });
      core!.db.updateTask(id, { outcome: "needs_action" });
      return askOf(base, (a) => a.kind === "stop" && a.task?.id === id);
    };
    const first = await report(A);
    expect(first).toMatchObject({ grant: A, state: "open" });
    expect((await (await answer(base, first.id, { kind: "grant" })).json()) as AskAnswerResult).toMatchObject({ already: false });
    await until(() => userTurns(id).length === 1);
    const now = await report(B);
    expect(now).toMatchObject({ grant: B, state: "open" });
    expect(now.id).not.toBe(first.id);
    expect((await (await answer(base, now.id, { kind: "grant" })).json()) as AskAnswerResult).toMatchObject({ already: false });
    await until(() => userTurns(id).length === 2);
    expect(userTurns(id)).toEqual([A, B]);
    // a resend sends nothing more
    expect((await (await answer(base, now.id, { kind: "grant" })).json()) as AskAnswerResult).toMatchObject({ already: true });
    await Bun.sleep(50);
    expect(userTurns(id)).toEqual([A, B]);
  });
});

describe("GET /api/asks — mockups", () => {
  test("mockups: the Task a ## 判断待ち names with **画面イメージ** gives its HTML artifacts, not a removed one nor a text one", async () => {
    const base = await boot(fakeGh({ place: "Task #307\n**画面イメージ**: tsk_mock" }).gh);
    const at = Date.now() - 60_000;
    core!.db.insertTask({ id: "tsk_mock", workspaceId: meta().id, title: "mockups", stage: null, runner: "claude", cwd: home, scope: [home], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at });
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
