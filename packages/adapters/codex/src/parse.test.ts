import { recordingText, skipRecordings, assertRecordings } from "../../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { AgentEvent, type StartOptions } from "@switchboard/protocol";
import { appServerEnv, buildSandboxPolicy, buildThreadResumeParams, buildThreadStartParams, buildTurnStartParams, childEnv, CODEX_PERMISSION_MODES, resolveApprovalPolicy, resolvePermissionPreset } from "./index.ts";
import { approvalDecision, createCodexParser, diffStat, jsonRpcResult, windowName } from "./parse.ts";

/** Fixtures are raw app-server stdio recordings; lines starting with "> " are what Switchboard sent. */
async function load(name: string) {
  const text = recordingText(`packages/adapters/codex/fixtures/${name}.jsonl`);
  return text.split("\n").filter((l) => l.trim());
}

/** Replay like the session does: responses to our requests are correlated by id; thread/start|resume results seed session.start. */
async function replay(name: string) {
  const p = createCodexParser();
  const events: AgentEvent[] = [];
  const sent = new Map<number, string>();
  for (const line of await load(name)) {
    if (line.startsWith("> ")) {
      const m = JSON.parse(line.slice(2));
      if (typeof m.id === "number" && typeof m.method === "string") sent.set(m.id, m.method);
      continue;
    }
    const m = JSON.parse(line);
    if (m.id !== undefined && typeof m.method !== "string") {
      const method = sent.get(m.id);
      if ((method === "thread/start" || method === "thread/resume") && m.result?.thread) events.push(...p.threadStarted(m.result.thread));
      continue;
    }
    events.push(...p.feed(line));
  }
  return events;
}

const text = (evs: AgentEvent[]) => evs.filter((e) => e.t === "message.delta" && e.role === "assistant").map((e) => (e.t === "message.delta" ? e.text : "")).join("");

describe("codex app-server → AgentEvent (recorded replay, codex-cli 0.148.0-alpha.9)", () => {
  test.skipIf(skipRecordings("packages/adapters/codex/fixtures/exec-workspace-write.jsonl", "packages/adapters/codex/fixtures/approval-and-second-turn.jsonl", "packages/adapters/codex/fixtures/resume.jsonl", "packages/adapters/codex/fixtures/decline-and-interrupt.jsonl"))("every event of every fixture validates against the protocol schema", async () => {
    assertRecordings("packages/adapters/codex/fixtures/exec-workspace-write.jsonl", "packages/adapters/codex/fixtures/approval-and-second-turn.jsonl", "packages/adapters/codex/fixtures/resume.jsonl", "packages/adapters/codex/fixtures/decline-and-interrupt.jsonl");
    for (const f of ["exec-workspace-write", "approval-and-second-turn", "resume", "decline-and-interrupt"]) {
      for (const ev of await replay(f)) expect(() => AgentEvent.parse(ev)).not.toThrow();
    }
  });

  test.skipIf(skipRecordings("packages/adapters/codex/fixtures/exec-workspace-write.jsonl"))("workspace-write run: session.start once, two exec tool calls with results, streamed answer, usage + quota, session.end ok", async () => {
    assertRecordings("packages/adapters/codex/fixtures/exec-workspace-write.jsonl");
    const evs = await replay("exec-workspace-write");
    const starts = evs.filter((e) => e.t === "session.start");
    expect(starts).toHaveLength(1);
    const s = starts[0]!;
    if (s.t !== "session.start") throw new Error();
    expect(s.runner).toBe("codex");
    // the id comes from the recording's thread/started line: an id of a real run is not written into the tests
    const started = (await load("exec-workspace-write")).filter((l) => !l.startsWith("> ")).map((l) => JSON.parse(l)).find((m) => m.method === "thread/started");
    expect(started?.params?.thread?.id).toBeString();
    expect(s.runnerSessionId).toBe(started.params.thread.id);
    expect(s.cwd).toBe("/tmp/spike");
    expect(s.runnerVersion).toBe("0.148.0-alpha.9");

    const calls = evs.filter((e) => e.t === "tool.call");
    expect(calls.map((c) => (c.t === "tool.call" ? c.summary : ""))).toEqual(["echo 'hello from codex.' > note.txt", "cat note.txt"]);
    const results = evs.filter((e) => e.t === "tool.result");
    expect(results).toHaveLength(2);
    if (results[1]?.t !== "tool.result") throw new Error();
    expect(results[1].ok).toBe(true);
    expect(results[1].summary).toBe("hello from codex.");

    // streamed deltas win; item/completed must not repeat the text
    const t = text(evs);
    expect(t).toContain("Created `note.txt` containing exactly `hello from codex.`");
    expect(t.split("Created `note.txt`").length).toBe(2);

    const reported = evs.filter((e) => e.t === "usage" && e.source === "reported");
    expect(reported).toHaveLength(1);
    if (reported[0]?.t !== "usage") throw new Error();
    expect(reported[0].outputTokens).toBe(443);
    expect(reported[0].cacheReadTokens).toBe(43264);
    expect(reported[0].inputTokens).toBe(52590 - 43264);
    expect(reported[0].costUsd).toBeUndefined();
    expect(evs.filter((e) => e.t === "usage" && e.source === "turn")).toHaveLength(3);

    const q = evs.find((e) => e.t === "quota");
    if (q?.t !== "quota") throw new Error();
    expect(q.runner).toBe("codex");
    expect(q.windows.five_hour?.utilization).toBe(0);
    expect(q.windows.seven_day?.resetsAt).toBe(1788960316);

    const end = evs.at(-1);
    if (end?.t !== "session.end") throw new Error();
    expect(end.status).toBe("ok");
    expect(end.summary).toBe("Created `note.txt` containing exactly `hello from codex.`");
    expect(end.durationMs).toBe(19934);
  });

  test.skipIf(skipRecordings("packages/adapters/codex/fixtures/approval-and-second-turn.jsonl"))("untrusted policy: exec approval surfaces as permission.ask bound to the tool call; a second turn ends the session again", async () => {
    assertRecordings("packages/adapters/codex/fixtures/approval-and-second-turn.jsonl");
    const evs = await replay("approval-and-second-turn");
    const ask = evs.find((e) => e.t === "permission.ask");
    if (ask?.t !== "permission.ask") throw new Error("no permission.ask");
    expect(ask.id).toBe("0"); // JSON-RPC id of the server request — what respondPermission answers
    expect(ask.kind).toBe("exec");
    expect(ask.tool).toBe("exec");
    expect(ask.detail).toBe("date > stamp.txt");
    expect(ask.toolUseId).toMatch(/^exec-/);
    const call = evs.find((e) => e.t === "tool.call" && e.id === ask.toolUseId);
    expect(call).toBeDefined();
    expect(evs.indexOf(ask)).toBeGreaterThan(evs.indexOf(call!));
    expect(evs.filter((e) => e.t === "session.end").map((e) => (e.t === "session.end" ? e.status : ""))).toEqual(["ok", "ok"]);
    expect(evs.filter((e) => e.t === "usage" && e.source === "reported")).toHaveLength(2);
    expect(text(evs)).toContain("pong");
  });

  test.skipIf(skipRecordings("packages/adapters/codex/fixtures/decline-and-interrupt.jsonl"))("declined approval yields tool.result(ok=false); turn/interrupt yields session.end(aborted)", async () => {
    assertRecordings("packages/adapters/codex/fixtures/decline-and-interrupt.jsonl");
    const evs = await replay("decline-and-interrupt");
    const declined = evs.find((e) => e.t === "tool.result" && !e.ok);
    if (declined?.t !== "tool.result") throw new Error();
    expect(declined.summary).toBe("declined");
    const ends = evs.filter((e) => e.t === "session.end").map((e) => (e.t === "session.end" ? e.status : ""));
    expect(ends).toEqual(["ok", "aborted"]);
  });

  test.skipIf(skipRecordings("packages/adapters/codex/fixtures/resume.jsonl"))("thread/resume in a fresh process re-announces the thread id and answers from the earlier context", async () => {
    assertRecordings("packages/adapters/codex/fixtures/resume.jsonl");
    const evs = await replay("resume");
    const s = evs.find((e) => e.t === "session.start");
    if (s?.t !== "session.start") throw new Error();
    // the thread id Switchboard asked thread/resume for, read from the recording's sent line
    const resumed = (await load("resume")).filter((l) => l.startsWith("> ")).map((l) => JSON.parse(l.slice(2))).find((m) => m.method === "thread/resume");
    expect(resumed?.params?.threadId).toBeString();
    expect(s.runnerSessionId).toBe(resumed.params.threadId);
    expect(evs.filter((e) => e.t === "session.start")).toHaveLength(1);
    expect(text(evs)).toBe("stamp.txt"); // the file was created by the previous process
    // Codex replays the previous turn's tokenUsage before turn/started; it must not be charged to this turn
    const reported = evs.filter((e) => e.t === "usage" && e.source === "reported");
    expect(reported).toHaveLength(1);
    if (reported[0]?.t !== "usage") throw new Error();
    expect(reported[0].outputTokens).toBe(17); // 5 output tokens of the replayed previous turn are excluded
    expect(evs.filter((e) => e.t === "usage" && e.source === "turn")).toHaveLength(1);
  });
});

describe("request building", () => {
  test.skipIf(skipRecordings("packages/adapters/codex/fixtures/auto-review-0.155.0-alpha.2.6.jsonl"))("recorded auto-review outcomes are visible without human approval (0.155.0-alpha.2.6)", async () => {
    assertRecordings("packages/adapters/codex/fixtures/auto-review-0.155.0-alpha.2.6.jsonl");
    const events = await replay("auto-review-0.155.0-alpha.2.6");
    for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
    expect(events).toHaveLength(2);
    expect(events.every((ev) => ev.t === "status")).toBe(true);
    const messages = events.map((ev) => ev.t === "status" ? ev.text : "");
    expect(messages[0]).toContain("inProgress");
    expect(messages[1]).toContain("approved");
    expect(messages[1]).toContain("it sends no user data");
    expect(createCodexParser().feed(JSON.stringify({ method: "item/autoApprovalReview/completed", params: { review: { status: "denied", rationale: "Not authorized" } } }))).toEqual([{ t: "status", text: "Codex 自動審査: denied — Not authorized" }]);
  });
  const opts: StartOptions = { cwd: "/repo", scope: ["/repo", "/other"], prompt: "hi" };

  test("auto review is explicit across start, resume and mode switches", () => {
    for (const mode of [undefined, "auto", "on-request", "read-only", "untrusted", "full-access"]) {
      const options = { ...opts, permissionMode: mode };
      const expected = mode === undefined || mode === "auto" ? "auto_review" : "user";
      expect(buildThreadStartParams(options).approvalsReviewer).toBe(expected);
      expect(buildThreadResumeParams(options, "t1").approvalsReviewer).toBe(expected);
      expect(buildTurnStartParams("t1", "go", options).approvalsReviewer).toBe(expected);
    }
    expect(CODEX_PERMISSION_MODES.some((m) => m.value === "on-request" && !m.danger)).toBe(true);
    expect(buildTurnStartParams("t1", "go", opts)).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } });
  });

  // fixtures/effort-high.jsonl: codex-cli 0.162.1, recorded 2026-10-12 — initialize → thread/start → turn/start built by
  // buildThreadStartParams / buildTurnStartParams with effort "high" (read-only), one turn. Paths, host and installation
  // id are placeholders; thread / turn / item ids are the CLI's random per-run values.
  test.skipIf(skipRecordings("packages/adapters/codex/fixtures/effort-high.jsonl"))("effort (#833): the recorded turn/start sent effort high, the server took it, and the turn replays to session.end(ok)", async () => {
    assertRecordings("packages/adapters/codex/fixtures/effort-high.jsonl");
    const lines = await load("effort-high");
    const sent = lines.filter((l) => l.startsWith("> ")).map((l) => JSON.parse(l.slice(2)));
    expect(sent.find((m) => m.method === "turn/start").params.effort).toBe("high");
    expect(sent.find((m) => m.method === "thread/start").params).not.toHaveProperty("effort");
    const settings = lines.filter((l) => !l.startsWith("> ")).map((l) => JSON.parse(l)).find((m) => m.method === "thread/settings/updated");
    expect(settings.params.threadSettings.effort).toBe("high");
    const evs = await replay("effort-high");
    for (const ev of evs) expect(() => AgentEvent.parse(ev)).not.toThrow();
    expect(evs[0]).toMatchObject({ t: "session.start", runner: "codex" });
    expect(text(evs)).toBe("2");
    expect(evs.filter((e) => e.t === "session.end")).toEqual([expect.objectContaining({ t: "session.end", status: "ok" })]);
  });

  test("effort (#833): turn/start carries it; thread/start and thread/resume do not; no key when unset or empty", () => {
    expect(buildTurnStartParams("t1", "go", { ...opts, effort: "high" }).effort).toBe("high");
    expect(buildTurnStartParams("t1", "go", opts)).not.toHaveProperty("effort");
    expect(buildTurnStartParams("t1", "go", { ...opts, effort: "" })).not.toHaveProperty("effort");
    expect(buildThreadStartParams({ ...opts, effort: "high" })).not.toHaveProperty("effort");
    expect(buildThreadResumeParams({ ...opts, effort: "high" }, "t1")).not.toHaveProperty("effort");
  });

  test("thread/start maps permissionMode to approvalPolicy and defaults to on-request + workspace-write", () => {
    expect(buildThreadStartParams(opts)).toMatchObject({ cwd: "/repo", approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: false });
    expect(buildThreadStartParams({ ...opts, permissionMode: "untrusted" }).approvalPolicy).toBe("untrusted");
    expect(resolveApprovalPolicy("plan")).toBe("on-request");
    expect(buildThreadResumeParams(opts, "t1").threadId).toBe("t1");
  });

  test("permission presets: full-access is the only way to `never` and is flagged", () => {
    expect(resolvePermissionPreset(undefined)).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(resolvePermissionPreset("auto")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(resolvePermissionPreset("read-only")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(resolvePermissionPreset("untrusted")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(resolvePermissionPreset("full-access")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(resolvePermissionPreset("auto", { sandbox: "read-only", approvalPolicy: "untrusted" })).toEqual({ approvalPolicy: "untrusted", sandbox: "read-only" });
    expect(buildThreadStartParams({ ...opts, permissionMode: "full-access" })).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(buildThreadResumeParams({ ...opts, permissionMode: "read-only" }, "t1")).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
    // turn/start carries the preset too, so a switch mid-session applies at the next turn without a new process
    expect(buildTurnStartParams("t1", "go", { ...opts, permissionMode: "read-only" })).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } });
    expect(buildTurnStartParams("t1", "go", { ...opts, permissionMode: "full-access" })).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(buildTurnStartParams("t1", "go", opts)).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/other"] } });
    const adapter = createCodexAdapter();
    expect(adapter.defaultPermissionMode).toBe("auto");
    expect(adapter.permissionModes).toBe(CODEX_PERMISSION_MODES);
    expect(CODEX_PERMISSION_MODES.filter((m) => m.danger).map((m) => m.value)).toEqual(["full-access"]);
  });

  test("scope dirs become writable roots of the workspace-write sandbox policy", () => {
    expect(buildSandboxPolicy(opts)).toMatchObject({ type: "workspaceWrite", writableRoots: ["/other"], networkAccess: false });
    expect(buildSandboxPolicy(opts, "read-only")).toMatchObject({ type: "readOnly" });
    const turn = buildTurnStartParams("t1", "go", opts);
    expect(turn.input).toEqual([{ type: "text", text: "go", text_elements: [] }]);
    expect(turn.threadId).toBe("t1");
  });

  test("approval responses use the server request id and Codex decision vocabulary", () => {
    expect(approvalDecision("allow")).toEqual({ decision: "accept" });
    expect(approvalDecision("deny")).toEqual({ decision: "decline" });
    expect(JSON.parse(jsonRpcResult("0", approvalDecision("allow")))).toEqual({ jsonrpc: "2.0", id: 0, result: { decision: "accept" } });
  });

  test("helpers", () => {
    expect(windowName(300)).toBe("five_hour");
    expect(windowName(10080)).toBe("seven_day");
    expect(windowName(60)).toBe("60m");
    expect(diffStat("--- a\n+++ b\n-x\n+y\n+z\n")).toBe("+2 −1");
    expect(childEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_X: "y" })).toEqual({ PATH: "/bin" });
    // what the daemon adds (StartOptions.env) goes over what is inherited
    expect(childEnv({ PATH: "/bin", HOME: "/h" }, { PATH: "/kit/bin:/bin" })).toEqual({ PATH: "/kit/bin:/bin", HOME: "/h" });
  });
});

/* ---------- session tests against a fake app-server (fixtures/fake-app-server.ts) ---------- */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_EFFORTS, CODEX_LOGIN_HINT, CODEX_MODELS, createCodexAdapter, defaultModelFromConfig, loginStatus } from "./index.ts";

const FAKE = new URL("../fixtures/fake-app-server.ts", import.meta.url).pathname;

function collect() {
  const events: AgentEvent[] = [];
  const waitFor = (pred: () => boolean, ms = 5000) =>
    new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pred()) {
          clearInterval(iv);
          res();
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error("timeout: " + events.map((e) => e.t).join(",")));
        }
      }, 20);
    });
  return { events, waitFor, ends: () => events.filter((e) => e.t === "session.end") };
}

describe("CodexSession over stdio (fake app-server)", () => {
  test("live Auto/manual switches apply on next turn and resume resets reviewer", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-reviewer-wire-"));
    const log = join(home, "wire.jsonl");
    const a = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] });
    const options = { cwd: home, scope: [home], prompt: "first", permissionMode: "auto" };
    const c = collect();
    const s = a.start(options, (e) => c.events.push(e));
    const asks = () => c.events.filter((e) => e.t === "permission.ask");
    const accept = () => { const ask = asks().at(-1)!; if (ask.t === "permission.ask") s.respondPermission(ask.id, "allow"); };
    let resumed: ReturnType<typeof a.start> | undefined;
    try {
      await c.waitFor(() => asks().length === 1);
      await s.setPermissionMode!("on-request");
      s.send("during active turn");
      await c.waitFor(() => c.events.some((e) => e.t === "message.delta" && e.text === "steer:during active turn"));
      accept(); await c.waitFor(() => c.ends().length === 1);
      s.send("manual turn"); await c.waitFor(() => asks().length === 2);
      accept(); await c.waitFor(() => c.ends().length === 2);
      await s.setPermissionMode!("auto");
      s.send("auto turn"); await c.waitFor(() => asks().length === 3);
      accept(); await c.waitFor(() => c.ends().length === 3);
      await s.close();
      const r = collect();
      resumed = a.start({ ...options, resumeSessionId: "thread-new", permissionMode: "on-request" }, (e) => r.events.push(e));
      await r.waitFor(() => r.events.some((e) => e.t === "permission.ask"));
      const wire = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(wire.filter((m) => m.method === "thread/start").map((m) => m.params.approvalsReviewer)).toEqual(["auto_review"]);
      expect(wire.filter((m) => m.method === "turn/start").map((m) => m.params.approvalsReviewer)).toEqual(["auto_review", "user", "auto_review", "user"]);
      expect(wire.find((m) => m.method === "turn/steer").params.approvalsReviewer).toBeUndefined();
      expect(wire.find((m) => m.method === "thread/resume").params.approvalsReviewer).toBe("user");
      expect(wire.filter((m) => m.method === "turn/start").every((m) => m.params.approvalPolicy === "on-request" && m.params.sandboxPolicy.type === "workspaceWrite" && m.params.sandboxPolicy.networkAccess === false)).toBe(true);
    } finally {
      await resumed?.close(); await s.close(); rmSync(home, { recursive: true, force: true });
    }
  });
  let dir: string;
  const adapter = () => createCodexAdapter({ bin: FAKE, codexHome: dir });
  const opts = (): StartOptions => ({ cwd: dir, scope: [dir], prompt: "first" });

  test("detect accepts an explicit bin path", async () => {
    dir = mkdtempSync(join(tmpdir(), "codex-fake-"));
    expect((await adapter().detect()).available).toBe(true);
    expect(defaultModelFromConfig(dir)).toBeUndefined();
  });

  test("effort (#833): the adapter lists the reasoning efforts every listed model takes", () => {
    const a = createCodexAdapter({ bin: FAKE });
    expect(a.efforts).toBe(CODEX_EFFORTS);
    expect(CODEX_EFFORTS.map((e) => e.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("models (#155): the adapter lists its models; cliDefaultModel is the top-level model of config.toml, in either quote style, never a profile's", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const a = createCodexAdapter({ bin: FAKE, codexHome: home });
    expect(a.models).toBe(CODEX_MODELS);
    expect(a.cliDefaultModel?.()).toBeUndefined();
    writeFileSync(join(home, "config.toml"), 'model = "gpt-6-astra"\n[profiles.cheap]\nmodel = "gpt-6-luna"\n');
    expect(a.cliDefaultModel?.()).toBe("gpt-6-astra");
    writeFileSync(join(home, "config.toml"), "model = 'gpt-6-sol'\n");
    expect(a.cliDefaultModel?.()).toBe("gpt-6-sol");
    writeFileSync(join(home, "config.toml"), 'approval_policy = "never"\n[profiles.cheap]\nmodel = "gpt-6-luna"\n');
    expect(a.cliDefaultModel?.()).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  test("approval round trip: permission.ask id is per-process-unique, the reply carries the raw JSON-RPC id, turn completes", async () => {
    const c = collect();
    const s = adapter().start(opts(), (e) => c.events.push(e));
    await c.waitFor(() => c.events.some((e) => e.t === "permission.ask"));
    const ask = c.events.find((e) => e.t === "permission.ask");
    if (ask?.t !== "permission.ask") throw new Error();
    expect(ask.id).toMatch(/^[0-9a-f]+:0$/);
    expect(ask.detail).toBe("touch x");
    expect(() => s.respondPermission("nope", "allow")).toThrow(/no pending approval/);
    s.respondPermission(ask.id, "allow");
    await c.waitFor(() => c.ends().length === 1);
    const res = c.events.find((e) => e.t === "tool.result");
    if (res?.t !== "tool.result") throw new Error();
    expect(res.ok).toBe(true);
    const usage = c.events.find((e) => e.t === "usage" && e.source === "reported");
    if (usage?.t !== "usage") throw new Error();
    expect(usage).toMatchObject({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 2 });
    expect(c.events.some((e) => e.t === "session.start" && e.runnerSessionId === "thread-new")).toBe(true);
    // a turn that is over is not reported as aborted
    await s.abort();
    expect(c.ends()).toHaveLength(1);
    expect(await s.exited).not.toBeUndefined();
  });

  test("send() before the thread exists is queued and steers the first turn; a send after a turn ends starts a new turn", async () => {
    const c = collect();
    const s = adapter().start(opts(), (e) => c.events.push(e));
    s.send("second"); // thread does not exist yet → queued, then steered into turn 1 (Codex merges input into the active turn)
    await c.waitFor(() => c.events.some((e) => e.t === "permission.ask"));
    s.send("third"); // turn 1 active → turn/steer
    await c.waitFor(() => c.events.some((e) => e.t === "message.delta" && e.role === "assistant" && e.text === "steer:third"));
    expect(c.events.some((e) => e.t === "message.delta" && e.role === "assistant" && e.text === "steer:second")).toBe(true);
    const ask1 = c.events.find((e) => e.t === "permission.ask");
    if (ask1?.t !== "permission.ask") throw new Error();
    s.respondPermission(ask1.id, "deny");
    await c.waitFor(() => c.ends().length === 1);
    expect(c.events.find((e) => e.t === "tool.result")).toMatchObject({ ok: false, summary: "declined" });
    expect(c.events.filter((e) => e.t === "error")).toHaveLength(0);
    // the turn is over → the next send is a fresh turn/start with its own approval (new id)
    s.send("fourth");
    await c.waitFor(() => c.events.filter((e) => e.t === "permission.ask").length === 2);
    const ask2 = c.events.filter((e) => e.t === "permission.ask").at(-1);
    if (ask2?.t !== "permission.ask") throw new Error();
    expect(ask2.id).not.toBe(ask1.id);
    s.respondPermission(ask2.id, "allow");
    await c.waitFor(() => c.ends().length === 2);
    expect(c.events.filter((e) => e.t === "error")).toHaveLength(0);
    await s.close();
  });

  test("abort during a turn → turn/interrupt → exactly one session.end(aborted)", async () => {
    const c = collect();
    const s = adapter().start({ ...opts(), prompt: "sleep" }, (e) => c.events.push(e));
    await c.waitFor(() => c.events.some((e) => e.t === "message.delta" && e.role === "assistant"));
    await s.abort();
    expect(c.ends().map((e) => (e.t === "session.end" ? e.status : ""))).toEqual(["aborted"]);
  });

  test("resume: stale usage replayed for the previous turn is ignored, reported usage covers only this turn", async () => {
    const c = collect();
    const s = adapter().start({ ...opts(), resumeSessionId: "thread-old" }, (e) => c.events.push(e));
    await c.waitFor(() => c.events.some((e) => e.t === "permission.ask"));
    const ask = c.events.find((e) => e.t === "permission.ask");
    if (ask?.t !== "permission.ask") throw new Error();
    s.respondPermission(ask.id, "allow");
    await c.waitFor(() => c.ends().length === 1);
    expect(c.events.some((e) => e.t === "session.start" && e.runnerSessionId === "thread-old")).toBe(true);
    const usages = c.events.filter((e) => e.t === "usage");
    expect(usages.every((u) => u.t === "usage" && u.inputTokens < 900)).toBe(true);
    expect(usages.filter((u) => u.t === "usage" && u.source === "reported")).toHaveLength(1);
    await s.close();
  });

  test("a process dying without a result surfaces stderr as an error event", async () => {
    const c = collect();
    const s = adapter().start({ ...opts(), prompt: "crash" }, (e) => c.events.push(e));
    expect(await s.exited).toBe(3);
    const err = c.events.find((e) => e.t === "error");
    if (err?.t !== "error") throw new Error("no error event: " + c.events.map((e) => e.t).join(","));
    expect(err.message).toContain("simulated crash");
    expect(c.ends()).toHaveLength(0); // the daemon's exit handler owns session.end in this case
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("login (#180)", () => {
  /** A stand-in `codex`: `--version` answers, `login status` runs `loginStatus` (shell). */
  function fakeCodex(dir: string, status: string): string {
    const bin = join(dir, `codex-${Math.random().toString(16).slice(2)}`);
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.155.0-alpha.9.2"; exit 0; fi\nif [ "$1 $2" = "login status" ]; then ${status}; fi\nexit 9\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  test("detect reports the login from the exit code of `codex login status`: 0 = ok, 1 = expired, an unknown subcommand = unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-login-"));
    try {
      expect(await createCodexAdapter({ bin: fakeCodex(dir, "echo 'Logged in using ChatGPT'; exit 0") }).detect())
        .toMatchObject({ available: true, version: "0.155.0-alpha.9.2", login: "ok", loginHint: CODEX_LOGIN_HINT });
      expect(await createCodexAdapter({ bin: fakeCodex(dir, "echo 'Not logged in' >&2; exit 1") }).detect())
        .toMatchObject({ available: true, login: "expired", loginHint: CODEX_LOGIN_HINT });
      expect((await createCodexAdapter({ bin: fakeCodex(dir, "echo \"error: unrecognized subcommand 'status'\" >&2; exit 2") }).detect()).login).toBe("unknown");
      expect(await loginStatus(fakeCodex(dir, "sleep 5"), 100)).toBe("unknown");
      // the message counts even when a child the command left behind keeps stderr open past the exit
      expect(await loginStatus(fakeCodex(dir, "echo \"error: unrecognized subcommand 'status'\" >&2; sleep 5 & exit 2"))).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("process group (fake codex binary that leaves a child)", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-pg-"));
    const bin = join(dir, "codex");
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
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-pg-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > "${dir}/self.pid"\nwhile :; do sleep 1; done\n`);
    chmodSync(bin, 0o755);
    try {
      const session = createCodexAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi" }, () => {});
      await until(() => existsSync(join(dir, "self.pid")));
      const self = Number(readFileSync(join(dir, "self.pid"), "utf8").trim());
      await session.close({ graceMs: 0 });
      expect(await until(() => !alive(self), 3000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a runner that exits by itself leaves nothing behind either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-pg-"));
    const bin = join(dir, "codex");
    // exits at once; `sleep` ignores SIGTERM here so only the SIGKILL after the exit can end it
    writeFileSync(bin, `#!/bin/sh\n(trap '' TERM; exec sleep 300) &\necho $! > "${dir}/child.pid"\nexit 0\n`);
    chmodSync(bin, 0o755);
    try {
      const session = createCodexAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi" }, () => {});
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
        const session = createCodexAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "hi" }, () => {});
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

describe("privateTmp (#787)", () => {
  const base = { cwd: "/r", scope: ["/r", "/other"], prompt: "p" };
  test("with privateTmp, /tmp is closed and the task's own directory is the one writable root under it", () => {
    expect(buildSandboxPolicy({ ...base, privateTmp: "/tmp/switchboard.task.t1" })).toMatchObject({ type: "workspaceWrite", writableRoots: ["/other", "/tmp/switchboard.task.t1"], excludeSlashTmp: true, excludeTmpdirEnvVar: false });
    expect(buildSandboxPolicy(base)).toMatchObject({ writableRoots: ["/other"], excludeSlashTmp: false });
    expect(buildTurnStartParams("t1", "go", { ...base, privateTmp: "/tmp/x" })).toMatchObject({ sandboxPolicy: { excludeSlashTmp: true } });
    expect(appServerEnv({ ...base, env: { A: "1" }, privateTmp: "/tmp/x" })).toEqual({ A: "1", TMPDIR: "/tmp/x" });
    expect(appServerEnv({ ...base, env: { A: "1" } })).toEqual({ A: "1" });
  });
});
