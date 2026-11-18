// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerId, Task } from "@switchboard/protocol";
import { StopRecord } from "@switchboard/protocol";
import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { JUDGE_FALLBACK, JUDGE_TIMEOUT_MS, type judgeTurn } from "./judge.ts";
import type { judgeRubric } from "./rubric-judge.ts";
import { StopReport } from "./stops.ts";
import { NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("automatic judgement", () => {
  // the real adapters echo the prompt as a user message first; the judge reads the task's first one as the request
  const ok: AgentEvent[] = [{ t: "message.delta", role: "user", text: "依頼文" }, ...SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result")];
  const post = (url: string, body?: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  type Call = { input: Parameters<typeof judgeTurn>[0]; opts: Parameters<typeof judgeTurn>[1]; answer: (r: "finished" | "needs_action") => void; fail: (e: Error) => void };
  /** A judge the test answers by hand: each call waits until the test resolves it. */
  const handJudge = () => {
    const calls: Call[] = [];
    const judge: typeof judgeTurn = (input, opts) =>
      new Promise((resolve, reject) => {
        calls.push({ input, opts, fail: reject, answer: (result) => {
          opts.onUsage?.(opts.settings.runner, { t: "usage", source: "reported", model: opts.settings.model, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0012 });
          resolve({ result, reason: result === "finished" ? "報告して終わっている" : "選択を求めている", runner: opts.settings.runner, model: opts.settings.model });
        } });
      });
    return { calls, judge };
  };
  const daemon = (h: string, judge: typeof judgeTurn) =>
    // codex is slow, so its follow-up turn is still running when a test answers the previous judgement
    startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(ok, { lingers: true }), fakeAdapter(ok, { id: "codex", lingers: true, slowMs: 300 })], { port: 0, selfdevChecks: false, judge });

  test("judge: a second turn is judged with its own request", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-turns-"));
    // a runner that echoes what it was sent, as the real adapters do, and answers each turn in its own words
    let turn = 0;
    const echoing: RunnerAdapter = {
      id: "claude",
      detect: async () => ({ available: true, version: "fake" }),
      start(o, emit) {
        const say = (text: string) => queueMicrotask(() => {
          const reply = `返答 ${++turn}`;
          for (const ev of [{ t: "message.delta", role: "user", text }, { t: "message.delta", role: "assistant", text: reply }, { t: "session.end", status: "ok", summary: reply }] as AgentEvent[]) emit(ev);
        });
        emit({ t: "session.start", runner: "claude", runnerSessionId: "s1", cwd: o.cwd });
        say(o.prompt);
        return { send: (text) => say(text), respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
      },
    };
    const first = handJudge();
    let c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [echoing], { port: 0, selfdevChecks: false, judge: first.judge });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const t = (await post(`${b}/api/tasks`, { cwd: h, title: "二択", prompt: "README を直して", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => first.calls.length === 1);
      // one turn: the request and the reply, nothing else
      expect(first.calls[0]!.input).toEqual({ title: "二択", prompt: "README を直して", lastReply: "返答 1" });
      first.calls[0]!.answer("needs_action");
      await waitFor(async () => c.db.getTask(t.id)!.judgedResult === "needs_action");
      expect((await post(`${b}/api/tasks/${t.id}/send`, { text: "A で" })).status).toBe(200);
      await waitFor(async () => first.calls.length === 2);
      const second = { title: "二択", prompt: "README を直して", lastRequest: "A で", previousReply: "返答 1", lastReply: "返答 2" };
      expect(first.calls[1]!.input).toEqual(second);
      // the daemon stops before that judgement came: the next start judges the same reply again, with the same input
      await c.stop();
      const again = handJudge();
      c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [echoing], { port: 0, selfdevChecks: false, judge: again.judge });
      await waitFor(async () => again.calls.length === 1);
      expect(again.calls[0]!.input).toEqual(second);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: a stop recorded while the judge is out sets the outcome, and the judge's answer keeps its own result next to it", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-stop-"));
    const { calls, judge } = handJudge();
    const c = await daemon(h, judge);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = (await post(`${b}/api/tasks`, { cwd: h, title: "decision stop", prompt: "依頼文", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => calls.length === 1);
      expect(c.db.getTask(t.id)).toMatchObject({ status: "done", outcome: "unknown" });
      expect(c.tasks.recordStop(t.id, StopReport.parse({ id: "ask", op: "ask", target: "方針", reason: "decision", evidence: "どちらにするか" })).ok).toBe(true);
      expect(c.db.getTask(t.id)!.outcome).toBe("needs_action");
      calls[0]!.answer("finished");
      await waitFor(async () => c.db.getTask(t.id)!.judgedResult === "finished");
      expect(c.db.getTask(t.id)).toMatchObject({ status: "done", outcome: "needs_action", judgedResult: "finished" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: a turn that ends on a decision stop it reported is needs_action at done, and the judge is not asked", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-fence-"));
    const { calls, judge } = handJudge();
    const fence = "\n```switchboard-stop\n" + JSON.stringify({ id: "ask", op: "ask", target: "方針", reason: "decision", evidence: "どちらにするか" }) + "\n```\n";
    const script: AgentEvent[] = [...ok.slice(0, -1), { t: "message.delta", role: "assistant", text: fence }, ok.at(-1)!];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0, selfdevChecks: false, judge });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = (await post(`${b}/api/tasks`, { cwd: h, title: "decision fence", prompt: "依頼文", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => c.db.getTask(t.id)!.status === "done");
      await new Promise((r) => setTimeout(r, 100));
      expect(c.db.getTask(t.id)).toMatchObject({ status: "done", outcome: "needs_action", judgingAt: null });
      expect(calls.length).toBe(0);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: after the turn, an old stop that closes does not undo the judge's outcome of a later turn, and a reviewed Task is left", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-old-stop-"));
    const { calls, judge } = handJudge();
    const c = await daemon(h, judge);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = (await post(`${b}/api/tasks`, { cwd: h, title: "old stop", prompt: "依頼文", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => calls.length === 1);
      calls[0]!.answer("needs_action");
      await waitFor(async () => c.db.getTask(t.id)!.outcome === "needs_action");
      const report = { id: "ci", op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI 待ち" };
      // a stop of an earlier turn, written straight to the log (as one reported before the judged turn)
      c.db.appendEvent(t.id, { t: "stop.record", stop: StopRecord.parse({ ...report, id: `${t.id}/ci`, work: { workspaceId: null, issue: null, taskId: t.id }, at: 1, state: "waiting" }) });
      c.tasks.recordStopEvent(t.id, StopRecord.parse({ ...report, id: `${t.id}/ci`, work: { workspaceId: null, issue: null, taskId: t.id }, at: Date.now(), state: "resolved" }));
      expect(c.db.getTask(t.id)!.outcome).toBe("needs_action");
      // the person reviewed it: a new open stop does not move it
      c.tasks.setOutcome(t.id, { outcome: "finished", reviewed: true });
      expect(c.tasks.recordStop(t.id, StopReport.parse({ id: "late", op: "x", target: "y", reason: "decision", evidence: "z" })).ok).toBe(true);
      expect(c.db.getTask(t.id)).toMatchObject({ outcome: "finished" });
      expect(c.db.getTask(t.id)!.reviewedAt).not.toBeNull();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: a turn that ended with a background process left (status background) is judged like a done one", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-bg-"));
    const { calls, judge } = handJudge();
    const withBackground = [...ok.slice(0, -1), { t: "background", count: 1 } as AgentEvent, ok[ok.length - 1]!];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(withBackground, { lingers: true })], { port: 0, selfdevChecks: false, judge });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = (await post(`${b}/api/tasks`, { cwd: h, title: "bg judged", prompt: "依頼文", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => calls.length === 1);
      expect(c.db.getTask(t.id)!.status).toBe("background");
      calls[0]!.answer("needs_action");
      await waitFor(async () => c.db.getTask(t.id)!.judgedResult === "needs_action");
      expect(c.db.getTask(t.id)).toMatchObject({ status: "background", outcome: "needs_action" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("selfdev: a meta Task's turn that ended with a background process left (status background) runs the checks like a done one", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-selfdev-bg-"));
    // the meta checkout: a typecheck that passes at once
    const repo = join(h, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "repo", scripts: { typecheck: "true" } }));
    const { judge } = handJudge();
    const withBackground = [...ok.slice(0, -1), { t: "background", count: 1 } as AgentEvent, ok[ok.length - 1]!];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_REPO_ROOT: repo, ...NO_HISTORY }), [fakeAdapter(withBackground, { lingers: true })], { port: 0, selfdevChecks: true, judge });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const meta = c.db.listWorkspaces().find((w) => w.kind === "meta")!;
      const t = (await post(`${b}/api/tasks`, { cwd: repo, workspaceId: meta.id, title: "bg checked", prompt: "依頼文", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => c.db.getCheckRun(t.id) !== null);
      expect(c.db.getTask(t.id)!.status).toBe("background");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("settings tunables: the daemon gives both judges judgeAndChoice's fallback, and the two-way judge its timeout, read per turn", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-tunables-"));
    const { calls, judge } = handJudge();
    const rubricOpts: Array<Parameters<typeof judgeRubric>[1]> = [];
    const rubricJudge: typeof judgeRubric = (_input, opts) => (rubricOpts.push(opts), new Promise(() => undefined));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(ok, { lingers: true }), fakeAdapter(ok, { id: "codex", lingers: true })], { port: 0, selfdevChecks: false, judge, rubricJudge });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const create = async (title: string) => (await post(`${b}/api/tasks`, { cwd: h, title, prompt: "依頼文", runner: "claude" }).then(j)) as Task;
      await create("default");
      await waitFor(async () => calls.length === 1 && rubricOpts.length === 1);
      expect(calls[0]!.opts).toMatchObject({ fallback: { runner: JUDGE_FALLBACK.runner, model: JUDGE_FALLBACK.model }, timeoutMs: JUDGE_TIMEOUT_MS });
      expect(rubricOpts[0]).toMatchObject({ fallback: { runner: JUDGE_FALLBACK.runner, model: JUDGE_FALLBACK.model } });
      expect((await post(`${b}/api/settings`, { judgeAndChoice: { judgeFallbackRunner: "codex", judgeFallbackModel: "m", judgeTimeoutMs: 5000 } }, "PATCH")).status).toBe(200);
      await create("changed");
      await waitFor(async () => calls.length === 2 && rubricOpts.length === 2);
      expect(calls[1]!.opts).toMatchObject({ fallback: { runner: "codex", model: "m" }, timeoutMs: 5000 });
      expect(rubricOpts[1]).toMatchObject({ fallback: { runner: "codex", model: "m" } });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: a done turn is judged in the background — the outcome, the reason and the ledger row; a hand-set outcome is kept next to the judgement; a failing judge leaves it unjudged", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-"));
    const { calls, judge } = handJudge();
    const c = await daemon(h, judge);
    const b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const updates: Task[] = [];
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "task.updated") updates.push(msg.task);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const create = async (title: string, runner: RunnerId = "claude") => (await post(`${b}/api/tasks`, { cwd: h, title, prompt: "依頼文", runner }).then(j)) as Task;
      const turnDone = async (id: string, n: number) => {
        await waitFor(async () => (await get(id)).status === "done");
        await waitFor(async () => calls.length === n);
      };

      // (a) done → the judge sees the title, the first request and the last reply; its answer reaches the outcome, GET and task.updated
      const a = await create("judged");
      await turnDone(a.id, 1);
      expect(calls[0]!.input).toEqual({ title: "judged", prompt: "依頼文", lastReply: "done" });
      expect(calls[0]!.opts).toMatchObject({ settings: { enabled: true, runner: "codex", model: "gpt-6-luna", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 }, cwd: join(h, "suggest") });
      calls[0]!.answer("needs_action");
      await waitFor(async () => updates.some((t) => t.id === a.id && t.outcome === "needs_action" && t.judgedResult === "needs_action"));
      expect(await get(a.id)).toMatchObject({ outcome: "needs_action", judgedResult: "needs_action", judgedReason: "選択を求めている", judgedBy: "codex:gpt-6-luna", status: "done" });

      // (e) the judge's usage is a ledger row of the task, under the runner that judged
      const raw = new Database(join(h, "switchboard.db"), { readonly: true });
      const rows = raw.query("SELECT runner, model, cost_usd FROM ledger WHERE task_id = ? AND runner = 'codex'").all(a.id);
      raw.close();
      expect(rows).toEqual([{ runner: "codex", model: "gpt-6-luna", cost_usd: 0.0012 }]);

      // a new turn clears the judgement of the previous reply
      const sent = await post(`${b}/api/tasks/${a.id}/send`, { text: "again" }).then(j);
      expect(sent).toMatchObject({ status: "running", outcome: "unknown", judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null });
      await turnDone(a.id, 2);
      calls[1]!.answer("finished");
      await waitFor(async () => (await get(a.id)).judgedResult === "finished");

      // (b) the judge throws → unjudged, and the task is still done
      const x = await create("fails");
      await turnDone(x.id, 3);
      calls[2]!.fail(new Error("both runners failed"));
      await Bun.sleep(50);
      expect(await get(x.id)).toMatchObject({ status: "done", outcome: "unknown", judgedResult: null });

      // (c) + (f) the person sets the outcome while the judge is still thinking → the judgement is kept, the outcome is theirs
      const m = await create("by hand");
      await turnDone(m.id, 4);
      expect((await post(`${b}/api/tasks/${m.id}/outcome`, { outcome: "finished" })).status).toBe(200);
      calls[3]!.answer("needs_action");
      await waitFor(async () => (await get(m.id)).judgedResult === "needs_action");
      expect(await get(m.id)).toMatchObject({ outcome: "finished", judgedResult: "needs_action", judgedBy: "codex:gpt-6-luna" });

      // a judgement that arrives after the next turn started is of an older reply and is dropped
      const s = await create("stale");
      await turnDone(s.id, 5);
      await post(`${b}/api/tasks/${s.id}/send`, { text: "more" });
      await turnDone(s.id, 6);
      calls[4]!.answer("needs_action");
      await Bun.sleep(50);
      expect(await get(s.id)).toMatchObject({ outcome: "unknown", judgedResult: null });
      calls[5]!.answer("finished");
      await waitFor(async () => (await get(s.id)).judgedResult === "finished");

      // … and so is one that arrives while the next turn is still running
      const r = await create("running", "codex");
      await turnDone(r.id, 7);
      await post(`${b}/api/tasks/${r.id}/send`, { text: "more" });
      expect((await get(r.id)).status).toBe("running");
      calls[6]!.answer("needs_action");
      await Bun.sleep(50);
      expect(await get(r.id)).toMatchObject({ status: "running", outcome: "unknown", judgedResult: null });
      await turnDone(r.id, 8);
      calls[7]!.answer("finished");
      await waitFor(async () => (await get(r.id)).judgedResult === "finished");
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: judge.enabled off → never asked; judge.runner changed → asked with that runner; an uninstalled runner is refused", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-settings-"));
    const { calls, judge } = handJudge();
    const c = await daemon(h, judge);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const run = async (title: string) => {
        const t = (await post(`${b}/api/tasks`, { cwd: h, title, prompt: "p", runner: "claude" }).then(j)) as Task;
        await waitFor(async () => (await get(t.id)).status === "done");
        await Bun.sleep(50);
        return t;
      };
      const off = await post(`${b}/api/settings`, { judge: { enabled: false } }, "PATCH").then(j);
      expect(off.judge).toEqual({ enabled: false, runner: "codex", model: "gpt-6-luna", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 });
      await run("off");
      expect(calls).toHaveLength(0);

      const on = await post(`${b}/api/settings`, { judge: { enabled: true, runner: "claude", model: "claude-haiku-4-5" } }, "PATCH").then(j);
      expect(on.judge).toEqual({ enabled: true, runner: "claude", model: "claude-haiku-4-5", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 });
      await run("on");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.opts.settings).toEqual({ enabled: true, runner: "claude", model: "claude-haiku-4-5", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 });

      const missing = await post(`${b}/api/settings`, { judge: { runner: "dak" } }, "PATCH");
      expect(missing.status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).judge.runner).toBe("claude");

      // the input caps: a partial patch keeps the runner / model; not a positive integer → 400
      const caps = await post(`${b}/api/settings`, { judge: { recapChars: 30_000, pbiChars: 1_200, requestChars: 500 } }, "PATCH").then(j);
      expect(caps.judge).toEqual({ enabled: true, runner: "claude", model: "claude-haiku-4-5", effort: "", recapChars: 30_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 1_200, requestChars: 500, skillChars: 20_000 });
      expect((await post(`${b}/api/settings`, { judge: { laterChars: 0 } }, "PATCH")).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).judge.laterChars).toBe(4_000);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: a shadow task, a turn that ends with a permission still pending (outcome needs_action), and an empty last reply are not judged", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-skip-"));
    const { calls, judge } = handJudge();
    const silent: AgentEvent[] = [...ok.filter((e) => e.t !== "session.end"), { t: "session.end", status: "ok", summary: "  " }];
    // asks, then ends the turn without waiting for the answer: done, but the rule already made it needs_action
    const endsAsking: RunnerAdapter = {
      ...fakeAdapter([]),
      start(_opts, emit) {
        let exit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (exit = r));
        queueMicrotask(() => {
          emit({ t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: {}, detail: "write" });
          emit({ t: "session.end", status: "ok", summary: "書いてよいですか" });
          exit(0);
        });
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => exit(0), close: async () => exit(0), exited };
      },
    };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [endsAsking, fakeAdapter(ok, { id: "codex", lingers: true }), fakeAdapter(silent, { id: "dak" })], { port: 0, selfdevChecks: false, judge });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const asks = (await post(`${b}/api/tasks`, { cwd: h, title: "asks", prompt: "p", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => (await get(asks.id)).status === "done");
      expect((await get(asks.id)).outcome).toBe("needs_action");
      const quiet = (await post(`${b}/api/tasks`, { cwd: h, title: "quiet", prompt: "p", runner: "dak" }).then(j)) as Task;
      await waitFor(async () => (await get(quiet.id)).status === "done");
      // the shadow (codex) ends with a reply that would be judged; only the primary (dak, empty reply) counts, and it does not qualify
      const primary = (await post(`${b}/api/tasks`, { cwd: h, title: "mirrored", prompt: "p", runner: "dak", shadowRunner: "codex" }).then(j)) as Task;
      await waitFor(async () => (await get(primary.id)).status === "done");
      const shadow = c.db.shadowTaskOf(primary.id)!;
      await waitFor(async () => (await get(shadow.id)).status === "done");
      const control = (await post(`${b}/api/tasks`, { cwd: h, title: "control", prompt: "p", runner: "codex" }).then(j)) as Task;
      await waitFor(async () => (await get(control.id)).status === "done");
      await Bun.sleep(100);
      expect(calls.map((x) => x.input.title)).toEqual(["control"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
