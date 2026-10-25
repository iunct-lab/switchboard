import { recordingText, skipRecordings, assertRecordings } from "../../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { AgentEvent } from "@switchboard/protocol";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, childEnv, CLAUDE_EFFORTS, CLAUDE_LOGIN_HINT, CLAUDE_MODELS, CLAUDE_PERMISSION_MODES, cliDefaultModelFromSettings, createClaudeAdapter, loginStatus } from "./index.ts";
import { createClaudeParser, permissionResponseLine, setPermissionModeLine, summarizeToolInput } from "./parse.ts";

const fixture = recordingText("packages/adapters/claude/fixtures/write-with-permission.jsonl");
const resumeFixture = recordingText("packages/adapters/claude/fixtures/resume-turn.jsonl");
const resumeMissingFixture = recordingText("packages/adapters/claude/fixtures/resume-missing.jsonl");
const resumeCostFixture = recordingText("packages/adapters/claude/fixtures/resume-cost.jsonl");
const backgroundFixture = recordingText("packages/adapters/claude/fixtures/background-notification.jsonl");

function replay() {
  const p = createClaudeParser();
  const events = fixture.split("\n").flatMap((l) => p.feed(l));
  return events;
}

describe("claude stream-json → AgentEvent (recorded replay)", () => {
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl"))("every emitted event validates against the protocol schema", () => {
    assertRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl");
    for (const ev of replay()) expect(() => AgentEvent.parse(ev)).not.toThrow();
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl"))("session.start carries the runner session id, cwd and model", () => {
    assertRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl");
    const start = replay().find((e) => e.t === "session.start");
    expect(start).toBeDefined();
    if (start?.t !== "session.start") throw new Error();
    expect(start.runner).toBe("claude");
    expect(start.runnerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(start.cwd).toBe("/tmp/spike");
    expect(start.model).toBe("claude-haiku-4-5-20251001");
    expect(start.runnerVersion).toBe("2.1.261");
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl"))("a Write tool call surfaces as tool.call → permission.ask → tool.result(ok)", () => {
    assertRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl");
    const evs = replay();
    const call = evs.find((e) => e.t === "tool.call");
    const ask = evs.find((e) => e.t === "permission.ask");
    const res = evs.find((e) => e.t === "tool.result");
    if (call?.t !== "tool.call" || ask?.t !== "permission.ask" || res?.t !== "tool.result") throw new Error("missing events");
    expect(call.name).toBe("Write");
    expect(call.summary).toBe("/tmp/spike/spike-note.txt");
    expect(ask.kind).toBe("write");
    expect(ask.tool).toBe("Write");
    expect(ask.toolUseId).toBe(call.id);
    expect(res.id).toBe(call.id);
    expect(res.ok).toBe(true);
    expect(evs.indexOf(call)).toBeLessThan(evs.indexOf(ask));
    expect(evs.indexOf(ask)).toBeLessThan(evs.indexOf(res));
    // the successful Write becomes an artifact(diff) for the 差分 tab
    const art = evs.find((e) => e.t === "artifact");
    if (art?.t !== "artifact") throw new Error("no artifact");
    expect(art).toMatchObject({ kind: "diff", path: "/tmp/spike/spike-note.txt" });
    expect(evs.indexOf(art)).toBeGreaterThan(evs.indexOf(res));
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl"))("assistant text is emitted once (streamed deltas win over the assistant echo)", () => {
    assertRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl");
    const text = replay()
      .filter((e) => e.t === "message.delta" && e.role === "assistant")
      .map((e) => (e.t === "message.delta" ? e.text : ""))
      .join("");
    expect(text).toContain("Created `spike-note.txt`");
    expect(text.split("Created `spike-note.txt`").length).toBe(2);
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl"))("quota comes from rate_limit_event with both windows", () => {
    assertRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl");
    const q = replay().find((e) => e.t === "quota");
    if (q?.t !== "quota") throw new Error();
    expect(q.runner).toBe("claude");
    expect(q.windows.five_hour?.utilization).toBeCloseTo(0.16);
    expect(q.windows.seven_day?.utilization).toBeCloseTo(0.02);
    expect(q.limitType).toBe("five_hour");
    expect(q.status).toBe("allowed");
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl"))("result yields reported usage with cost, then session.end ok", () => {
    assertRecordings("packages/adapters/claude/fixtures/write-with-permission.jsonl");
    const evs = replay();
    const usage = evs.filter((e) => e.t === "usage" && e.source === "reported");
    expect(usage.length).toBe(1);
    const u = usage[0];
    if (u?.t !== "usage") throw new Error();
    expect(u.costUsd).toBeCloseTo(0.021436, 6);
    expect(u.model).toBe("claude-haiku-4-5-20251001");
    expect(u.outputTokens).toBe(398); // modelUsage's, with what subagents spent; result.usage says 385
    expect(u.cumulative).toBe(true);
    const end = evs.at(-1);
    expect(end?.t).toBe("session.end");
    if (end?.t === "session.end") expect(end.status).toBe("ok");
  });
});

describe("result → usage per model (#2353)", () => {
  test("every model of modelUsage is its own cumulative usage, with that model's cost and tokens", () => {
    const p = createClaudeParser();
    const evs = p.feed(JSON.stringify({
      type: "result", subtype: "success", total_cost_usd: 1.25,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 1.0 },
        "claude-haiku-5-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.25 },
      },
    }));
    expect(evs.filter((e) => e.t === "usage")).toEqual([
      { t: "usage", source: "reported", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 1.0, cumulative: true },
      { t: "usage", source: "reported", model: "claude-haiku-5-5", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, cumulative: true },
    ]);
    expect(evs.at(-1)?.t).toBe("session.end");
  });
});

describe("--resume (recorded against Claude Code 2.1.261, issue #2)", () => {
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/resume-turn.jsonl"))("a resumed process re-announces the same session id and answers from the earlier context", () => {
    assertRecordings("packages/adapters/claude/fixtures/resume-turn.jsonl");
    const p = createClaudeParser();
    const evs = resumeFixture.split("\n").flatMap((l) => p.feed(l));
    for (const ev of evs) expect(() => AgentEvent.parse(ev)).not.toThrow();
    const start = evs.find((e) => e.t === "session.start");
    if (start?.t !== "session.start") throw new Error();
    // the id comes from the recording's init line: an id of a real run is not written into the tests
    const init = resumeFixture.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).find((m) => m.type === "system" && m.subtype === "init");
    expect(init?.session_id).toBeString();
    expect(start.runnerSessionId).toBe(init.session_id);
    const text = evs.filter((e) => e.t === "message.delta" && e.role === "assistant").map((e) => (e.t === "message.delta" ? e.text : "")).join("");
    expect(text.toLowerCase()).toContain("pelican"); // the word was only ever said in the previous process
    expect(evs.at(-1)?.t).toBe("session.end");
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/resume-turn.jsonl"))("1-hour cache writes come out separately, from the stream's iterations and from the result", () => {
    assertRecordings("packages/adapters/claude/fixtures/resume-turn.jsonl");
    const p = createClaudeParser();
    const usage = resumeFixture.split("\n").flatMap((l) => p.feed(l)).filter((e) => e.t === "usage");
    // the result's figures are modelUsage's, which has no 1-hour split (the cost is the runner's own, #2353)
    expect(usage.map((e) => (e.t === "usage" ? [e.source, e.cacheWriteTokens, e.cacheWrite1hTokens] : []))).toEqual([["turn", 585, 585], ["reported", 585, undefined]]);
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/resume-missing.jsonl"))("resuming a session that no longer exists yields session.end(error) from the result line", () => {
    assertRecordings("packages/adapters/claude/fixtures/resume-missing.jsonl");
    const p = createClaudeParser();
    const evs = resumeMissingFixture.split("\n").flatMap((l) => p.feed(l));
    const end = evs.find((e) => e.t === "session.end");
    if (end?.t !== "session.end") throw new Error("no session.end");
    expect(end.status).toBe("error");
    expect(end.summary).toBe("error_during_execution");
    expect(evs.filter((e) => e.t === "usage" && e.source === "reported")).toHaveLength(0); // modelUsage is empty: nothing spent
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/resume-cost.jsonl"))("the result's cost is the session's running total, and --resume carries it on (Claude Code 2.1.308, #2353)", () => {
    assertRecordings("packages/adapters/claude/fixtures/resume-cost.jsonl");
    // two processes of one session: the second was started with --resume
    const results = resumeCostFixture.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((m) => m.type === "result");
    expect(results).toHaveLength(2);
    expect(results[1].session_id).toBe(results[0].session_id);
    const p = createClaudeParser();
    const usage = resumeCostFixture.split("\n").flatMap((l) => p.feed(l)).filter((e) => e.t === "usage" && e.source === "reported");
    for (const ev of usage) expect(() => AgentEvent.parse(ev)).not.toThrow();
    const [a, b] = usage.map((e) => (e.t === "usage" ? e : null))!;
    expect([a?.model, b?.model, a?.cumulative, b?.cumulative]).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", true, true]);
    // the resumed process does not start again from 0: its total includes the first process's, and so do its tokens
    expect(b!.costUsd!).toBeGreaterThan(a!.costUsd!);
    expect(b!.costUsd).toBe(results[1].total_cost_usd);
    expect(b!.cacheWriteTokens).toBe(a!.cacheWriteTokens + results[1].usage.cache_creation_input_tokens);
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/background-notification.jsonl"))("background jobs: the count goes up in the turn, back to 0 on the notification, and the process starts a turn of its own (Claude Code 2.1.308)", () => {
    assertRecordings("packages/adapters/claude/fixtures/background-notification.jsonl");
    // one live process: a turn that starts `sleep 15` with run_in_background and ends, then the job's notification
    const p = createClaudeParser();
    const events = backgroundFixture.split("\n").flatMap((l) => p.feed(l));
    for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
    const flow = events.filter((e) => e.t === "session.start" || e.t === "session.end" || e.t === "background").map((e) => (e.t === "background" ? `background ${e.count}` : e.t));
    expect(flow).toEqual(["session.start", "background 1", "session.end", "background 0", "session.start", "session.end"]);
  });

  test("buildArgs passes --resume and never --no-session-persistence", () => {
    const args = buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", resumeSessionId: "abc" });
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "abc"]);
    expect(args).not.toContain("--no-session-persistence");
  });

  test("buildArgs: effort becomes --effort, also on a resume; none when unset or empty (#833)", () => {
    const flag = (args: string[]) => (args.includes("--effort") ? args[args.indexOf("--effort") + 1] : undefined);
    expect(flag(buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", effort: "high" }))).toBe("high");
    expect(flag(buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", effort: "low", resumeSessionId: "abc" }))).toBe("low");
    expect(buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p" })).not.toContain("--effort");
    expect(buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", effort: "" })).not.toContain("--effort");
  });

  test("buildArgs: guards become one PreToolUse Bash hook in --settings, none without guards", () => {
    const args = buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", guards: ["'/k/ops-kit/bin/deny-shared-tmp'", "/k/other"] }, ["--x"]);
    const at = args.indexOf("--settings");
    expect(JSON.parse(args[at + 1]!)).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/k/ops-kit/bin/deny-shared-tmp'" }, { type: "command", command: "/k/other" }] }] },
    });
    expect(args.at(-1)).toBe("--x");
    expect(buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p" })).not.toContain("--settings");
    expect(buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", guards: [] })).not.toContain("--settings");
  });

  test("buildArgs: always --strict-mcp-config with only the handed MCP servers in --mcp-config (#2090)", () => {
    const config = (args: string[]) => (args.includes("--strict-mcp-config") ? args[args.indexOf("--mcp-config") + 1] : undefined);
    expect(config(buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p" }))).toBe('{"mcpServers":{}}');
    const playwright = { command: "npx", args: ["@playwright/mcp@latest", "--headless"] };
    const args = buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", mcpServers: { playwright } }, ["--x"]);
    expect(JSON.parse(config(args)!)).toEqual({ mcpServers: { playwright } });
    expect(args.at(-1)).toBe("--x");
  });
});

describe("live permission mode switch (fake claude binary that records stdin)", () => {
  test("setPermissionMode writes the control request and settles on the control_response (refusal rejects, success resolves)", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-mode-"));
    const bin = join(dir, "claude");
    // Answers like 2.1.263: an unknown mode gets an error response, a known one success + the system/status echo.
    writeFileSync(
      bin,
      `#!/bin/sh
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "${dir}/stdin.log"
  case "$line" in
    *set_permission_mode*bogus*) echo '{"type":"control_response","response":{"subtype":"error","request_id":"mode-1","error":"Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan"}}';;
    *set_permission_mode*) echo '{"type":"control_response","response":{"subtype":"success","request_id":"mode-2","response":{"mode":"plan"}}}'; echo '{"type":"system","subtype":"status","status":null,"permissionMode":"plan"}';;
  esac
done
`,
    );
    chmodSync(bin, 0o755);
    try {
      const events: AgentEvent[] = [];
      const session = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi", permissionMode: "auto" }, (e) => events.push(e));
      await expect(session.setPermissionMode!("bogus")).rejects.toThrow(/must be one of/);
      await session.setPermissionMode!("plan");
      await new Promise((r) => setTimeout(r, 200)); // the system/status echo follows the response, possibly in a later chunk
      expect(events.find((e) => e.t === "status" && e.text === "permission mode: plan")).toBeDefined();
      await session.close({ graceMs: 2000 });
      const lines = readFileSync(join(dir, "stdin.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.request?.subtype ?? l.type)).toEqual(["initialize", "user", "set_permission_mode", "set_permission_mode"]);
      expect(lines.slice(2).map((l) => l.request.mode)).toEqual(["bogus", "plan"]);
      await expect(session.setPermissionMode!("plan")).rejects.toThrow(/exited/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("process exit without a result line (fake claude binary)", () => {
  test("stderr becomes an error event and exited resolves with the exit code", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\necho 'No conversation found with session ID: 0000' 1>&2\nexit 1\n");
    chmodSync(bin, 0o755);
    try {
      const events: AgentEvent[] = [];
      const session = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi", resumeSessionId: "0000" }, (e) => events.push(e));
      expect(await session.exited).toBe(1);
      const err = events.find((e) => e.t === "error");
      if (err?.t !== "error") throw new Error("no error event");
      expect(err.message).toContain("No conversation found with session ID: 0000");
      // an abort after the fact reports nothing: the turn never started
      await session.abort();
      expect(events.filter((e) => e.t === "session.end")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawn plumbing", () => {
  test("child env drops the parent's Claude Code markers but keeps the rest", () => {
    const env = childEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_PID: "1", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
    // what the daemon adds (StartOptions.env) goes over what is inherited
    expect(childEnv({ PATH: "/bin", HOME: "/h" }, { PATH: "/kit/bin:/bin" })).toEqual({ PATH: "/kit/bin:/bin", HOME: "/h" });
  });

  test("args enable bidirectional stream-json with host-answered permissions and --add-dir for extra scope", () => {
    const args = buildArgs({ cwd: "/repo", scope: ["/repo", "/other"], prompt: "x", model: "haiku", resumeSessionId: "abc" });
    expect(args).toContain("--permission-prompt-tool");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--include-partial-messages");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/other");
    expect(args.filter((a) => a === "--add-dir").length).toBe(1);
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
  });

  test("permission mode: auto by default (what an interactive claude starts in; -p alone would be manual), explicit modes pass through", () => {
    const args = buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    const plan = buildArgs({ cwd: "/w", scope: ["/w"], prompt: "p", permissionMode: "plan" });
    expect(plan[plan.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(plan.filter((a) => a === "--permission-mode")).toHaveLength(1);
    const adapter = createClaudeAdapter();
    expect(adapter.defaultPermissionMode).toBe("auto");
    expect(adapter.permissionModes?.map((m) => m.value)).toEqual(["auto", "acceptEdits", "default", "plan", "dontAsk", "bypassPermissions"]);
    expect(CLAUDE_PERMISSION_MODES.filter((m) => m.danger).map((m) => m.value)).toEqual(["bypassPermissions"]);
  });

  test("set_permission_mode: request line shape and the system/status echo (recorded from 2.1.263)", () => {
    expect(JSON.parse(setPermissionModeLine("mode-1", "acceptEdits"))).toEqual({ type: "control_request", request_id: "mode-1", request: { subtype: "set_permission_mode", mode: "acceptEdits" } });
    const p = createClaudeParser();
    const echo = p.feed('{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits","uuid":"u","session_id":"s"}');
    expect(echo).toEqual([{ t: "status", text: "permission mode: acceptEdits" }]);
    // a status message with a status keeps its old mapping
    expect(p.feed('{"type":"system","subtype":"status","status":"requesting","permissionMode":"auto"}')).toEqual([{ t: "status", text: "requesting" }]);
    // the success/error control_response is not an event; the session reports a refusal as a status note
    expect(p.feed('{"type":"control_response","response":{"subtype":"error","request_id":"mode-2","error":"Cannot set permission mode"}}')).toEqual([]);
  });

  test("permission response echoes input on allow and a message on deny", () => {
    const allow = JSON.parse(permissionResponseLine("r1", "allow", { a: 1 }));
    expect(allow.response.response).toEqual({ behavior: "allow", updatedInput: { a: 1 } });
    const deny = JSON.parse(permissionResponseLine("r1", "deny", { a: 1 }, "no"));
    expect(deny.response.response).toEqual({ behavior: "deny", message: "no" });
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl"))("AskUserQuestion: the recorded ask becomes a permission.ask carrying the questions, and answers go back inside updatedInput (2.1.277)", async () => {
    assertRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl");
    const lines = (recordingText("packages/adapters/claude/fixtures/ask-user-question.jsonl")).split("\n").filter(Boolean);
    const [request, sent, toolResult] = lines as [string, string, string];
    const [ask] = createClaudeParser().feed(request);
    expect(AgentEvent.parse(ask)).toMatchObject({ t: "permission.ask", kind: "other", tool: "AskUserQuestion" });
    if (ask?.t !== "permission.ask") throw new Error("not an ask");
    const input = ask.input as { questions: { question: string }[] };
    const answers = { [input.questions[0]!.question]: "Blue", [input.questions[1]!.question]: "Apple, 梨（自由記述）" };
    // byte-for-byte what the recording sent (the "> " line), which Claude answered with "The user answered: …"
    expect(permissionResponseLine(ask.id, "allow", ask.input, undefined, answers).trim()).toBe(sent.slice(2));
    expect(JSON.parse(toolResult).message.content[0].content).toContain('"Which color do you prefer?"="Blue"');
    // the question text is the agent's: a prototype-named key is sent like any other (ids in the fixture are synthetic)
    expect(permissionResponseLine(ask.id, "allow", ask.input, undefined, JSON.parse('{"__proto__":"x"}'))).toContain('"answers":{"__proto__":"x"}');
    // a deny never carries answers
    expect(JSON.parse(permissionResponseLine(ask.id, "deny", ask.input, undefined, answers)).response.response).toEqual({ behavior: "deny", message: "Denied by user in Switchboard" });
  });

  test("tool summaries prefer the human-relevant field", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la", description: "list" })).toBe("ls -la");
    expect(summarizeToolInput("Grep", { pattern: "foo", path: "src" })).toBe("foo in src");
    expect(summarizeToolInput("Task", { x: 1, y: 2 })).toBe("Task(x, y)");
  });
});

describe("models (#155)", () => {
  test("cliDefaultModel is the model of the user's settings.json, read on every call; absent when unset, missing or malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-home-"));
    try {
      const adapter = createClaudeAdapter({ claudeHome: dir });
      expect(adapter.models).toBe(CLAUDE_MODELS);
      expect(adapter.cliDefaultModel?.()).toBeUndefined(); // no settings.json
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "haiku", theme: "dark" }));
      expect(adapter.cliDefaultModel?.()).toBe("haiku");
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
      expect(adapter.cliDefaultModel?.()).toBeUndefined();
      writeFileSync(join(dir, "settings.json"), "{ not json");
      expect(cliDefaultModelFromSettings(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("efforts (#833)", () => {
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/effort-high.jsonl"))("effort: a turn recorded with --effort high (fixtures/effort-high.jsonl) replays as session.start … session.end(ok)", async () => {
    assertRecordings("packages/adapters/claude/fixtures/effort-high.jsonl");
    const lines = (recordingText("packages/adapters/claude/fixtures/effort-high.jsonl")).split("\n").filter(Boolean);
    expect(JSON.parse(lines[0]!).text).toContain("--effort high"); // what the CLI was started with
    expect(lines.some((l) => JSON.parse(l).per_turn_effort_active === true)).toBe(true);
    const p = createClaudeParser();
    const evs = lines.flatMap((l) => p.feed(l));
    for (const ev of evs) expect(() => AgentEvent.parse(ev)).not.toThrow();
    expect(evs[0]).toMatchObject({ t: "session.start", runner: "claude", runnerVersion: "2.1.296" });
    expect(evs.filter((e) => e.t === "message.delta").map((e) => (e.t === "message.delta" ? e.text : "")).join("")).toBe("2");
    expect(evs.at(-1)).toMatchObject({ t: "session.end", status: "ok" });
  });


  test("effort: the adapter lists the values claude --effort takes", () => {
    expect(createClaudeAdapter().efforts).toBe(CLAUDE_EFFORTS);
    expect(CLAUDE_EFFORTS.map((e) => e.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("login (#180)", () => {
  /** A stand-in `claude`: `--version` answers, `auth status` runs `authStatus` (shell). */
  function fakeClaude(dir: string, authStatus: string): string {
    const bin = join(dir, `claude-${Math.random().toString(16).slice(2)}`);
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.281 (Claude Code)"; exit 0; fi\nif [ "$1 $2" = "auth status" ]; then ${authStatus}; fi\nexit 9\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  test("detect reports the login from the exit code of `claude auth status`: 0 = ok, 1 = expired, an unknown subcommand = unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-login-"));
    try {
      const ok = await createClaudeAdapter({ bin: fakeClaude(dir, `echo '{"loggedIn":true,"email":"a@b"}'; exit 0`) }).detect();
      expect(ok).toMatchObject({ available: true, version: "2.1.281", login: "ok", loginHint: CLAUDE_LOGIN_HINT });
      expect(JSON.stringify(ok)).not.toContain("a@b"); // the account named on stdout never reaches the detection
      const expired = await createClaudeAdapter({ bin: fakeClaude(dir, `echo '{"loggedIn":false}'; exit 1`) }).detect();
      expect(expired).toMatchObject({ available: true, login: "expired", loginHint: CLAUDE_LOGIN_HINT });
      const old = await createClaudeAdapter({ bin: fakeClaude(dir, `echo "error: unknown command 'auth'" >&2; exit 1`) }).detect();
      expect(old.login).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loginKind is the authMethod of `claude auth status` (#2528): claude.ai / api_key → console / absent or an old CLI → none; the account never reaches the detection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-login-"));
    const who = `"email":"someone@example.com","orgName":"Acme Org","accountName":"Some Person"`;
    const kind = async (stdout: string, exit = 0) => createClaudeAdapter({ bin: fakeClaude(dir, `echo '${stdout}'; exit ${exit}`) }).detect();
    try {
      const claudeAi = await kind(`{"loggedIn":true,"authMethod":"claude.ai",${who}}`);
      expect(claudeAi).toMatchObject({ login: "ok", loginKind: "claude.ai" });
      const api = await kind(`{"loggedIn":true,"authMethod":"api_key",${who}}`);
      expect(api).toMatchObject({ login: "ok", loginKind: "console" });
      for (const d of [claudeAi, api]) for (const secret of ["someone@example.com", "Acme Org", "Some Person"]) expect(JSON.stringify(d)).not.toContain(secret);
      const none = await kind(`{"loggedIn":true,${who}}`);
      expect(none.login).toBe("ok");
      expect(none.loginKind).toBeUndefined();
      expect((await kind(`not json`)).loginKind).toBeUndefined();
      expect((await kind(`{"loggedIn":false,"authMethod":"claude.ai"}`, 1))).toMatchObject({ login: "expired" });
      expect((await kind(`{"authMethod":"other"}`)).loginKind).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a multibyte character cut at the end of stderr does not break the stdout JSON (#2528)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-login-"));
    try {
      // 0xE3 0x81 is the first two bytes of あ: stderr ends mid-character while stdout is valid JSON
      const r = await loginStatus(fakeClaude(dir, `printf '\\343\\201' >&2; sleep 0.2; echo '{"authMethod":"api_key"}'; exit 0`));
      expect(r).toEqual({ login: "ok", kind: "console" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the claude adapter offers `auth logout` (#2528)", () => {
    expect(createClaudeAdapter().logoutArgs).toEqual(["auth", "logout"]);
  });

  test("a status command that does not answer in time is unknown, not expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-login-"));
    try {
      expect(await loginStatus(fakeClaude(dir, "sleep 5"), 100)).toEqual({ login: "unknown" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("process group (fake claude binary that leaves a child)", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (fn: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await Bun.sleep(20);
    return fn();
  };
  /** Leaves `sleep 300 &` behind and keeps reading stdin; writes its own pid and the child's. */
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-pg-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\necho $$ > "${dir}/self.pid"\nsleep 300 &\necho $! > "${dir}/child.pid"\ncat > /dev/null\n`);
    chmodSync(bin, 0o755);
    return { dir, bin };
  }
  const pids = async (dir: string) => {
    const read = (f: string) => {
      try {
        return Number(readFileSync(join(dir, f), "utf8").trim());
      } catch {
        return 0;
      }
    };
    await until(() => read("child.pid") > 0 && read("self.pid") > 0);
    return { self: read("self.pid"), child: read("child.pid") };
  };

  test("a runner that ignores SIGTERM is killed after the grace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-pg-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > "${dir}/self.pid"\nwhile :; do sleep 1; done\n`);
    chmodSync(bin, 0o755);
    try {
      const session = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi" }, () => {});
      await until(() => existsSync(join(dir, "self.pid")));
      const self = Number(readFileSync(join(dir, "self.pid"), "utf8").trim());
      await session.close({ graceMs: 0 });
      expect(await until(() => !alive(self), 3000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a runner that exits by itself leaves nothing behind either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-pg-"));
    const bin = join(dir, "claude");
    // exits at once; `sleep` ignores SIGTERM here so only the SIGKILL after the exit can end it
    writeFileSync(bin, `#!/bin/sh\n(trap '' TERM; exec sleep 300) &\necho $! > "${dir}/child.pid"\nexit 0\n`);
    chmodSync(bin, 0o755);
    try {
      const session = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi" }, () => {});
      await session.exited;
      const read = () => {
        try {
          return Number(readFileSync(join(dir, "child.pid"), "utf8").trim());
        } catch {
          return 0;
        }
      };
      await until(() => read() > 0);
      const child = read();
      expect(child).toBeGreaterThan(0);
      expect(await until(() => !alive(child))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const how of ["abort", "close"] as const) {
    test(`${how} ends the runner and the child it left behind`, async () => {
      const { dir, bin } = setup();
      try {
        const session = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi" }, () => {});
        const { self, child } = await pids(dir);
        expect(alive(child)).toBe(true);
        if (how === "abort") await session.abort();
        else await session.close({ graceMs: 0 });
        await session.exited;
        expect(await until(() => !alive(child) && !alive(self))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
