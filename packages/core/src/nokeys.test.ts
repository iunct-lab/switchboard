import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

/**
 * "No keys" (README, #180): Switchboard's code never reads, stores or returns the runners' credentials. The runners
 * log in themselves (terminal tab) and a token from Parameter Store reaches `claude` through a wrapper outside this
 * code (scripts/host/claude-wrapper.sh). These tests fail when a change starts touching them.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCES = ["packages/**/src/**/*.ts", "apps/web/src/**/*.{ts,tsx}"]
  .flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd: ROOT })])
  .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes("/generated/") && !f.includes("node_modules"))
  .sort();

/** A source without its comment lines (`//`, and ` * ` inside a block): the path checks are about code, not prose. */
const code = (f: string) =>
  readFileSync(join(ROOT, f), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\/\*\*?|\*)/.test(l))
    .join("\n");

describe("no keys (#180)", () => {
  test("no source names a credential file or a token variable, not even in a comment", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    const named = /auth\.json|\.credentials\.json|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|setup-token/;
    const hits = SOURCES.flatMap((f) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .flatMap((line, i) => (named.test(line) ? [`${f}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  test("only these files build a path into ~/.claude or ~/.codex, and only for what they say", () => {
    // config.ts: ~/.claude/projects (terminal history, #91) and ~/.codex (its sessions/, for export #179).
    // adapters: settings.json / config.toml, the CLI's own default model (#155). materializer.ts: a repository's .claude/commands. config.ts / claude-cloud.ts name a repository's .claude/worktrees (the continuation worktree and its info/exclude line, #1395).
    const allowed = ["packages/adapters/claude/src/index.ts", "packages/adapters/codex/src/index.ts", "packages/core/src/claude-cloud.ts", "packages/core/src/config.ts", "packages/core/src/materializer.ts"];
    // A quoted ".claude" segment or a path continuing into it (`${home}/.claude`). A prompt naming the repository's own
    // `.claude/skills/…` (backlog.ts, feedback.ts) is text for the agent. Strings the UI shows are text too.
    const users = SOURCES.filter((f) => /["'`]\.(?:claude|codex)["'`]|[/}]\.(?:claude|codex)\b/.test(code(f)));
    expect(users.filter((f) => !f.startsWith("apps/web/"))).toEqual(allowed);
  });
});

describe("no keys over the API (#180)", () => {
  const TOKEN = "fake-token-xyz-180";
  const saved = { oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, anthropic: process.env.ANTHROPIC_API_KEY };
  let home: string;
  let core: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  const adapter: RunnerAdapter = {
    id: "claude",
    async detect() {
      return { available: true, version: "fake", login: "ok", loginHint: "claude auth login" };
    },
    start(_opts, emit) {
      queueMicrotask(() => {
        emit({ t: "session.start", runner: "claude", runnerSessionId: "sess-nokeys", cwd: home });
        emit({ t: "message.delta", role: "assistant", text: "done" });
        emit({ t: "session.end", status: "ok", summary: "done" });
      });
      return { send() {}, respondPermission() {}, abort: async () => {}, close: async () => {}, exited: Promise.resolve(0) };
    },
  };

  beforeAll(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    process.env.ANTHROPIC_API_KEY = TOKEN;
    home = mkdtempSync(join(tmpdir(), "switchboard-test-nokeys-"));
    // only these settings: a SWITCHBOARD_DB or the like in the developer's environment must not reach the test daemon
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false });
    base = `http://127.0.0.1:${core.server.port}`;
  });

  afterAll(async () => {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [["CLAUDE_CODE_OAUTH_TOKEN", saved.oauth], ["ANTHROPIC_API_KEY", saved.anthropic]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a token in the daemon's environment appears in no response", async () => {
    const t = (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: home, title: "t", prompt: "p", runner: "claude" }) }).then((r) => r.json())) as { id: string };
    for (let i = 0; i < 100 && ((await fetch(`${base}/api/tasks/${t.id}`).then((r) => r.json())) as { task: { status: string } }).task.status !== "done"; i++) await Bun.sleep(20);
    for (const path of ["/api/health", "/api/health?recheck=1", "/api/settings", "/api/tasks", `/api/tasks/${t.id}`, "/api/workspaces"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).not.toContain(TOKEN);
    }
  });
});
