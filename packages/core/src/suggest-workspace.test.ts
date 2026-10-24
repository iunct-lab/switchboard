import { recordingText, skipRecordings, assertRecordings } from "../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, StartOptions, Workspace } from "@switchboard/protocol";
import { createClaudeParser } from "@switchboard/adapter-claude";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { buildWorkspacePrompt, parseWorkspaceChoice, WorkspaceSuggester, type WorkspaceContext } from "./suggest-workspace.ts";

// Recorded 2026-09-19 with Claude Code, `--model claude-haiku-4-5 --permission-mode plan`, fed the prompt
// buildWorkspacePrompt() produces for CTX below (the paths do not exist, so each brief is the generic one). Washed
// the same way as suggest-claude.jsonl: no `control_response` line, `system/init` keeps only what the parser reads.
const fixture = recordingText("packages/core/fixtures/suggest-workspace-claude.jsonl");

const WORKSPACES: Workspace[] = [
  { id: "ws_switchboard", name: "switchboard", path: "/Users/dev/work/switchboard", kind: "meta", createdAt: 1, backlog: "github" },
  { id: "ws_dak", name: "dak", path: "/Users/dev/work/dak", kind: "repo", createdAt: 2, backlog: "github" },
  { id: "ws_blog", name: "blog", path: "/Users/dev/work/blog", kind: "repo", createdAt: 3, backlog: "github" },
];
const CTX: WorkspaceContext = { title: "dak の README の誤字を直す", prompt: "dak の README にあるインストール手順の誤字を直してください。", workspaces: WORKSPACES };

const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response) => r.json() as Promise<any>;

/** Replays events for every turn; `events` sees the prompt, so the API tests can answer what the daemon actually asked. */
function replayAdapter(events: (prompt: string) => AgentEvent[], opts: { starts?: StartOptions[]; never?: boolean; modes?: string[] } = {}): RunnerAdapter {
  return {
    id: "claude",
    permissionModes: (opts.modes ?? ["plan"]).map((value) => ({ value, label: value, description: value })),
    async detect() {
      return { available: true, version: "replay" };
    },
    start(startOpts, emit) {
      opts.starts?.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      if (!opts.never) queueMicrotask(() => (events(startOpts.prompt).forEach(emit), resolveExit(0)));
      const session: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(0), close: async () => resolveExit(0), exited };
      return session;
    },
  };
}

const recorded = (): AgentEvent[] => {
  const p = createClaudeParser();
  return fixture.split("\n").flatMap((l) => p.feed(l));
};
const text = (t: string): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: t }, { t: "session.end", status: "ok" }];

describe("WorkspaceSuggester (recorded Claude replay)", () => {
  test.skipIf(skipRecordings("packages/core/fixtures/suggest-workspace-claude.jsonl"))("the recorded answer becomes {workspaceId, reason}, asked read-only in the daemon's own directory", async () => {
    assertRecordings("packages/core/fixtures/suggest-workspace-claude.jsonl");
    const starts: StartOptions[] = [];
    const usage: Array<Extract<AgentEvent, { t: "usage" }>> = [];
    const s = new WorkspaceSuggester({ adapter: replayAdapter(recorded, { starts }), cwd: "/tmp/switchboard-home/suggest", model: "claude-haiku-4-5", permissionMode: "plan", onUsage: (u) => usage.push(u) });
    const out = await s.suggest(CTX, new AbortController().signal);
    expect(out.workspaceId).toBe("ws_dak");
    expect(out.reason.length).toBeGreaterThan(0);
    expect(starts[0]).toMatchObject({ cwd: "/tmp/switchboard-home/suggest", scope: ["/tmp/switchboard-home/suggest"], model: "claude-haiku-4-5", permissionMode: "plan" });
    // one per model of the result's `modelUsage` (#2353)
    expect(usage.map((u) => [u.source, u.model])).toEqual([["reported", "claude-haiku-4-5-20251001"], ["reported", "claude-haiku-4-5"]]);
  });

  test("no candidates, an id outside the candidates, and no answer all throw — nothing is chosen by default", async () => {
    const run = (events: AgentEvent[], workspaces = WORKSPACES) => new WorkspaceSuggester({ adapter: replayAdapter(() => events), cwd: "/tmp/h" }).suggest({ ...CTX, workspaces }, new AbortController().signal);
    await expect(run(text('{"workspaceId": "ws_dak", "reason": "x"}'), [])).rejects.toThrow(/no workspace is registered/);
    await expect(run(text('{"workspaceId": "ws_elsewhere", "reason": "x"}'))).rejects.toThrow(/none of which is a registered workspace/);
    await expect(run(text("わかりません"))).rejects.toThrow(/no JSON object/);
    await expect(run([{ t: "session.end", status: "ok" }])).rejects.toThrow(/answered nothing/);
    // a runner that never answers is given up on when the caller's deadline fires
    const never = new WorkspaceSuggester({ adapter: replayAdapter(() => [], { never: true }), cwd: "/tmp/h" }).suggest(CTX, AbortSignal.timeout(20));
    await expect(never).rejects.toThrow();
  });

  test("parseWorkspaceChoice skips the echoed format line and reads fenced or nested answers", () => {
    expect(parseWorkspaceChoice('形式: {"workspaceId": "<候補の id のいずれか>", "reason": "…"}\n{"workspaceId": "ws_blog", "reason": "記事の話"}', WORKSPACES)).toEqual({ workspaceId: "ws_blog", reason: "記事の話" });
    expect(parseWorkspaceChoice('```json\n{"answer": {"workspaceId": "ws_dak", "reason": " "}}\n```', WORKSPACES)).toEqual({ workspaceId: "ws_dak", reason: "（理由なし）" });
  });

  test("the prompt lists every candidate by id, name, kind, path and the head of its brief; the task is capped", () => {
    const p = buildWorkspacePrompt({ ...CTX, prompt: "あ".repeat(3000) });
    expect(p).toContain("- id: ws_dak / name: dak / kind: repo / path: /Users/dev/work/dak");
    expect(p).toContain("あなたは Switchboard（このアプリ自身）のリポジトリで作業しています。");
    expect(p).not.toContain("あ".repeat(1201));
  });
});

describe("POST /api/tasks without cwd and workspaceId (#135)", () => {
  /** A daemon with two repositories besides the meta workspace, and a runner that answers the Workspace question by name. */
  async function boot(adapters: RunnerAdapter[]) {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autows-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), adapters, { port: 0, selfdevChecks: false });
    const b = `http://127.0.0.1:${c.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const repos: Workspace[] = [];
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(h, name), { recursive: true });
      repos.push(await post("/api/workspaces", { path: join(h, name), name }).then(j));
    }
    return { c, b, home: h, post, repos, done: async () => (await c.stop(), rmSync(h, { recursive: true, force: true })) };
  }
  /** Answers the Workspace question with the candidate whose name the task mentions; any other turn is a plain task turn. */
  const chooser = (starts: StartOptions[], pick: (prompt: string) => string | null) =>
    replayAdapter(
      (prompt) => {
        if (!prompt.includes("## 候補の Workspace")) return text("done");
        const id = pick(prompt);
        return [
          { t: "message.delta", role: "assistant", text: id === null ? "わかりません" : JSON.stringify({ workspaceId: id, reason: "依頼が名指ししている" }) },
          { t: "usage", source: "reported", model: "cheap-model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 },
          { t: "session.end", status: "ok" },
        ];
      },
      { starts },
    );
  const idOf = (prompt: string, name: string) => prompt.match(new RegExp(`- id: (\\S+) / name: ${name} `))?.[1] ?? null;

  test("the daemon picks a registered Workspace, records why, and bills the turn to the task", async () => {
    const starts: StartOptions[] = [];
    const { c, home, post, repos, done } = await boot([chooser(starts, (p) => idOf(p, "beta"))]);
    try {
      const r = await post("/api/tasks", { title: "beta の README を直して", prompt: "beta の README を直して", runner: "claude" });
      expect(r.status).toBe(201);
      const t = await j(r);
      expect(t).toMatchObject({ workspaceId: repos[1]!.id, cwd: repos[1]!.path, workspaceReason: "依頼が名指ししている" });
      expect(c.db.getTask(t.id)!.workspaceReason).toBe("依頼が名指ししている");
      // the choice ran read-only in the daemon's suggest directory, not in a repository; the task then ran in the chosen one
      expect(starts[0]).toMatchObject({ permissionMode: "plan", cwd: join(home, "suggest") });
      expect(starts[1]).toMatchObject({ cwd: repos[1]!.path });
      expect(c.db.sqlite.query("SELECT runner, cost_usd AS costUsd FROM ledger WHERE task_id = ? AND model = 'cheap-model'").all(t.id)).toEqual([{ runner: "claude", costUsd: 0.02 }]);

      // picked by hand — by cwd, or by workspaceId alone — nothing is asked and no reason is recorded
      const before = starts.length;
      const byCwd = await post("/api/tasks", { workspaceId: repos[0]!.id, cwd: repos[0]!.path, title: "t", prompt: "p", runner: "claude" }).then(j);
      expect(byCwd).toMatchObject({ cwd: repos[0]!.path, workspaceReason: null });
      const byId = await post("/api/tasks", { workspaceId: repos[0]!.id, title: "t", prompt: "p", runner: "claude" }).then(j);
      expect(byId).toMatchObject({ cwd: repos[0]!.path, workspaceReason: null });
      expect(starts.slice(before).every((s) => !s.prompt.includes("## 候補の Workspace"))).toBe(true);
      expect((await post("/api/tasks", { workspaceId: "ws_nope", title: "t", prompt: "p", runner: "claude" })).status).toBe(404);
    } finally {
      await done();
    }
  });

  test("when nothing can be chosen the task is not created: 409 with the reason, never a silent default", async () => {
    const cases: Array<{ adapters: RunnerAdapter[]; why: RegExp }> = [
      { adapters: [chooser([], () => "ws_elsewhere")], why: /none of which is a registered workspace/ },
      { adapters: [chooser([], () => null)], why: /no JSON object/ },
      // the routing runner (claude by default) is not installed: only dak is
      { adapters: [{ ...chooser([], () => null), id: "dak" }], why: /claude が未検出/ },
      // a runner with permission modes but no read-only one is not asked
      { adapters: [replayAdapter(() => text("{}"), { modes: ["auto"] })], why: /読み取り専用モードがありません/ },
    ];
    for (const { adapters, why } of cases) {
      const { c, post, done } = await boot(adapters);
      try {
        const r = await post("/api/tasks", { title: "t", prompt: "p", runner: adapters[0]!.id });
        expect(r.status).toBe(409);
        const body = await j(r);
        expect(body.error).toStartWith("Workspace を選んでください（");
        expect(body.error).toMatch(why);
        expect(c.db.listTasks()).toHaveLength(0);
      } finally {
        await done();
      }
    }
  });

  test("review #148: a Workspace whose directory is gone is refused before anything is asked, and a task that fails to start still carries the selection turn's cost", async () => {
    const starts: StartOptions[] = [];
    const inner = chooser(starts, (p) => idOf(p, "beta"));
    // the task turn cannot start; the selection turn (asked first) can
    const failing: RunnerAdapter = { ...inner, start: (o, emit) => { if (!o.prompt.includes("## 候補の Workspace")) throw new Error("spawn failed"); return inner.start(o, emit); } };
    const { c, post, repos, done } = await boot([failing]);
    try {
      const r = await post("/api/tasks", { title: "beta を直して", prompt: "beta を直して", runner: "claude" });
      expect(r.status).toBe(409);
      const failed = c.db.listTasks();
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ status: "error", cwd: repos[1]!.path, workspaceReason: "依頼が名指ししている" });
      expect(c.db.sqlite.query("SELECT runner, cost_usd AS costUsd FROM ledger WHERE task_id = ? AND model = 'cheap-model'").all(failed[0]!.id)).toEqual([{ runner: "claude", costUsd: 0.02 }]);

      rmSync(repos[0]!.path, { recursive: true, force: true });
      const before = starts.length;
      const gone = await post("/api/tasks", { workspaceId: repos[0]!.id, title: "t", prompt: "p", runner: "claude" });
      expect(gone.status).toBe(409);
      expect((await j(gone)).error).toBe("workspace directory does not exist");
      expect(starts).toHaveLength(before);
      expect(c.db.listTasks()).toHaveLength(1);
    } finally {
      await done();
    }
  });

  test("settings tunables (#835): judgeAndChoice.workspaceChoiceTimeoutMs gives up on a runner that does not answer, read at each choice", async () => {
    const never: RunnerAdapter = {
      ...replayAdapter(() => []),
      start(o, emit) {
        let resolveExit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (resolveExit = r));
        if (!o.prompt.includes("## 候補の Workspace")) queueMicrotask(() => (text("done").forEach(emit), resolveExit(0)));
        const stop = async () => resolveExit(0);
        return { send: () => undefined, respondPermission: () => undefined, abort: stop, close: stop, exited };
      },
    };
    const { c, b, post, done } = await boot([never]);
    try {
      await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ judgeAndChoice: { workspaceChoiceTimeoutMs: 1000 } }) });
      const t0 = Date.now();
      const r = await post("/api/tasks", { title: "t", prompt: "p", runner: "claude" });
      expect(r.status).toBe(409);
      expect((await j(r)).error).toContain("claude が 1 秒以内に答えませんでした");
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(c.db.listTasks()).toHaveLength(0);
    } finally {
      await done();
    }
  });

  test("the choice is a prerequisite, not advice: routing.llm.timeoutMs (the runner-suggestion deadline) does not cut it short", async () => {
    // answers the Workspace question after 1.2 s — longer than the shortest timeoutMs a person can save
    const slow: RunnerAdapter = {
      ...replayAdapter(() => []),
      start(o, emit) {
        let resolveExit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (resolveExit = r));
        const choosing = o.prompt.includes("## 候補の Workspace");
        const answer = choosing ? JSON.stringify({ workspaceId: idOf(o.prompt, "alpha"), reason: "遅いが正しい" }) : "done";
        // closed / aborted: a timer still pending must not emit into a daemon the test has already stopped
        const timer = setTimeout(() => (text(answer).forEach(emit), resolveExit(0)), choosing ? 1200 : 0);
        const stop = async () => (clearTimeout(timer), resolveExit(0));
        return { send: () => undefined, respondPermission: () => undefined, abort: stop, close: stop, exited };
      },
    };
    const { c, b, post, repos, done } = await boot([slow]);
    try {
      await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { timeoutMs: 1000 } } }) });
      const r = await post("/api/tasks", { title: "alpha を直して", prompt: "alpha を直して", runner: "claude" });
      expect(r.status).toBe(201);
      const t = await j(r);
      expect(t).toMatchObject({ cwd: repos[0]!.path, workspaceReason: "遅いが正しい" });
    } finally {
      await done();
    }
  });
});
