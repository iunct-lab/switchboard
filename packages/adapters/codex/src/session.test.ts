// test-reads: packages/adapters/codex/fixtures/fake-app-server.ts
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUESTION_DEFERRED_REPLY, type AgentEvent } from "@switchboard/protocol";
import { bedrockFromConfig, bedrockModelName, telemetryArgs, codexBedrockModel, CODEX_MODELS, codexSessionExists, createCodexAdapter, memoryOffNote } from "./index.ts";

const FAKE = new URL("../fixtures/fake-app-server.ts", import.meta.url).pathname;

test("the adapter names `codex logout` for the daemon's logout route", () => {
  expect(createCodexAdapter().logoutArgs).toEqual(["logout"]);
});

describe("codexSessionExists", () => {
  test("finds the thread's rollout under sessions/YYYY/MM/DD; false when missing or there is no sessions folder", () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-home-"));
    const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    try {
      expect(codexSessionExists(id, home)).toBe(false);
      mkdirSync(join(home, "sessions", "2026", "09", "20"), { recursive: true });
      expect(codexSessionExists(id, home)).toBe(false);
      writeFileSync(join(home, "sessions", "2026", "09", "20", `rollout-2026-09-20T10-00-00-${id}.jsonl`), "{}\n");
      expect(codexSessionExists(id, home)).toBe(true);
      expect(codexSessionExists(id.slice(1), home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("without a home it looks where the spawned codex keeps its sessions: CODEX_HOME, which the child inherits", () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-env-"));
    const before = process.env.CODEX_HOME;
    try {
      mkdirSync(join(home, "sessions", "2026", "09", "20"), { recursive: true });
      writeFileSync(join(home, "sessions", "2026", "09", "20", "rollout-2026-09-20T10-00-00-thread-env.jsonl"), "{}\n");
      process.env.CODEX_HOME = home;
      expect(codexSessionExists("thread-env")).toBe(true);
      expect(createCodexAdapter().hasSession?.("thread-env")).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("preamble", () => {
  test("goes to codex ahead of the prompt in the first turn, but the transcript shows only what the user typed", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-preamble-"));
    const log = join(home, "wire.jsonl");
    const events: AgentEvent[] = [];
    const s = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start(
      { cwd: home, scope: [home], prompt: "状況は？", preamble: "RECAP", permissionMode: "auto" },
      (e) => events.push(e),
    );
    try {
      const deadline = Date.now() + 5000;
      const turnStart = () => {
        try {
          return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.method === "turn/start");
        } catch {
          return undefined;
        }
      };
      while (!turnStart() && Date.now() < deadline) await Bun.sleep(20);
      expect(turnStart()?.params.input[0].text).toBe("RECAP\n\n状況は？");
      expect(events.filter((e) => e.t === "message.delta" && e.role === "user").map((e) => (e.t === "message.delta" ? e.text : ""))).toEqual(["状況は？"]);
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("fork", () => {
  test("fork sends thread/fork with lastTurnId instead of thread/resume, and session.start names the new thread", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-fork-"));
    const log = join(home, "wire.jsonl");
    const events: AgentEvent[] = [];
    const s = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt: "hi", permissionMode: "auto", resumeSessionId: "thread-src", fork: { turn: "turn-1" } }, (e) => events.push(e));
    try {
      for (const deadline = Date.now() + 5000; !events.some((e) => e.t === "permission.ask") && Date.now() < deadline; ) await Bun.sleep(20);
      const ask = events.find((e) => e.t === "permission.ask");
      expect(ask).toBeDefined();
      if (ask?.t === "permission.ask") s.respondPermission(ask.id, "allow");
      for (const deadline = Date.now() + 5000; !events.some((e) => e.t === "session.end") && Date.now() < deadline; ) await Bun.sleep(20);
    } finally {
      await s.close();
    }
    const wire = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => typeof m.method === "string");
    expect(wire.map((m) => m.method)).not.toContain("thread/resume");
    expect(wire.map((m) => m.method)).not.toContain("thread/start");
    const fork = wire.find((m) => m.method === "thread/fork");
    expect(fork.params).toMatchObject({ threadId: "thread-src", lastTurnId: "turn-1", cwd: home });
    const start = events.find((e) => e.t === "session.start");
    expect(start?.t === "session.start" && start.runnerSessionId).toBe("thread-forked");
    const end = events.find((e) => e.t === "session.end");
    expect(end?.t === "session.end" && end.turn).toBe("turn-1");
    expect(wire.find((m) => m.method === "turn/start").params.threadId).toBe("thread-forked");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("effort", () => {
  test("effort: every turn/start of the session carries it (the first and a reply); thread/start does not; none without one", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-effort-"));
    const log = join(home, "wire.jsonl");
    const wire = () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    const run = async (effort: string | undefined, turns: string[]) => {
      const events: AgentEvent[] = [];
      const s = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt: turns[0]!, permissionMode: "auto", ...(effort === undefined ? {} : { effort }) }, (e) => events.push(e));
      const until = async (pred: () => boolean) => {
        for (const deadline = Date.now() + 5000; !pred() && Date.now() < deadline; ) await Bun.sleep(20);
        expect(pred()).toBe(true);
      };
      try {
        for (const [i, text] of turns.entries()) {
          if (i > 0) s.send(text);
          await until(() => events.filter((e) => e.t === "permission.ask").length === i + 1);
          const ask = events.filter((e) => e.t === "permission.ask").at(-1)!;
          if (ask.t === "permission.ask") s.respondPermission(ask.id, "allow");
          await until(() => events.filter((e) => e.t === "session.end").length === i + 1);
        }
      } finally {
        await s.close();
      }
    };
    try {
      await run("high", ["first", "reply"]);
      const starts = wire().filter((m) => m.method === "turn/start");
      expect(starts.map((m) => m.params.input[0].text)).toEqual(["first", "reply"]);
      expect(starts.map((m) => m.params.effort)).toEqual(["high", "high"]);
      expect(wire().find((m) => m.method === "thread/start").params).not.toHaveProperty("effort");
      rmSync(log);
      await run(undefined, ["plain"]);
      expect(wire().find((m) => m.method === "turn/start").params).not.toHaveProperty("effort");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("subagent threads", () => {
  const start = (prompt: string) => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-subagent-"));
    const log = join(home, "wire.jsonl");
    const events: AgentEvent[] = [];
    const session = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt, permissionMode: "auto" }, (e) => events.push(e));
    const wire = (method: string) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.method === method);
    const until = async (pred: () => boolean) => {
      for (const deadline = Date.now() + 5000; !pred() && Date.now() < deadline; ) await Bun.sleep(20);
      expect(pred()).toBe(true);
    };
    return { home, events, session, wire, until, ends: () => events.filter((e) => e.t === "session.end") };
  };

  test("subagent: its approval is asked and answered, input steers the main turn, and only the main turn ends the session", async () => {
    const { home, events, session, wire, until, ends } = start("subagent: go");
    try {
      await until(() => events.some((e) => e.t === "permission.ask"));
      const ask = events.find((e) => e.t === "permission.ask")!;
      expect(ask).toMatchObject({ kind: "exec", toolUseId: "exec-sub" });
      session.send("more");
      await until(() => wire("turn/steer").length === 1);
      expect(wire("turn/steer")[0].params).toMatchObject({ threadId: "thread-new", expectedTurnId: "turn-1" });
      expect(wire("turn/start")).toHaveLength(1);
      if (ask.t === "permission.ask") session.respondPermission(ask.id, "allow");
      await until(() => ends().length === 1);
      await Bun.sleep(100);
      expect(ends()).toHaveLength(1);
      expect(ends()[0]).toMatchObject({ status: "ok", summary: "main-done" });
      expect(events.filter((e) => e.t === "tool.result")).toMatchObject([{ id: "exec-sub", ok: true }]);
      expect(events.filter((e) => e.t === "usage" && e.source === "reported").map((e) => (e.t === "usage" ? e.inputTokens : 0))).toEqual([7, 12]);
      expect(events.filter((e) => e.t === "session.start")).toMatchObject([{ runnerSessionId: "thread-new" }]);
      expect(events.filter((e) => e.t === "status" && e.text.startsWith("thread "))).toEqual([]);
    } finally {
      await session.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("subagent: abort during its turn interrupts the main turn, and the subagent's usage so far is still reported", async () => {
    const { home, events, session, wire, until, ends } = start("subagent: go");
    try {
      await until(() => events.some((e) => e.t === "permission.ask"));
      await session.abort();
      expect(wire("turn/interrupt").map((m) => m.params)).toEqual([{ threadId: "thread-new", turnId: "turn-1" }]);
      await until(() => ends().length === 1);
      expect(ends()[0]).toMatchObject({ status: "aborted" });
      expect(events.filter((e) => e.t === "usage" && e.source === "reported").map((e) => (e.t === "usage" ? e.inputTokens : 0))).toEqual([7]);
    } finally {
      await session.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("telemetryArgs", () => {
  test("telemetryArgs: off by default passes analytics.enabled=false, on adds none", () => {
    expect(telemetryArgs({})).toEqual(["-c", "analytics.enabled=false", "-c", "feedback.enabled=false"]);
    expect(telemetryArgs({ runnerTelemetry: false })).toEqual(telemetryArgs({}));
    expect(telemetryArgs({ runnerTelemetry: true })).toEqual([]);
  });
});

describe("bedrock", () => {
  test("app-server gets the amazon-bedrock provider and region only when StartOptions.bedrock is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-codex-bedrock-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "$OUT"\nenv > "$OUT.env"\n`, { mode: 0o755 });
    const run = async (name: string, bedrock?: { region: string }) => {
      const out = join(dir, name);
      const s = createCodexAdapter({ bin, codexHome: dir, config: ["x=1"] }).start({ cwd: dir, scope: [dir], prompt: "p", env: { OUT: out }, bedrock }, () => undefined);
      await s.exited;
      return { argv: readFileSync(out, "utf8").trim().split("\n"), env: readFileSync(`${out}.env`, "utf8") };
    };
    try {
      const plain = await run("plain");
      expect(plain.argv).toEqual(["app-server", "--listen", "stdio://", "-c", "features.memories=false", "-c", "features.default_mode_request_user_input=true", "-c", "x=1", "-c", "analytics.enabled=false", "-c", "feedback.enabled=false"]);
      const bedrock = await run("bedrock", { region: "ap-northeast-1" });
      expect(bedrock.argv).toEqual(["app-server", "--listen", "stdio://", "-c", "features.memories=false", "-c", "features.default_mode_request_user_input=true", "-c", "x=1", "-c", 'model_provider="amazon-bedrock"', "-c", 'model_providers.amazon-bedrock.aws.region="ap-northeast-1"', "-c", "analytics.enabled=false", "-c", "feedback.enabled=false"]);
      // the environment is the same either way: no key or variable is added for Bedrock
      const names = (env: string) => env.split("\n").map((l) => l.split("=")[0]).filter((n) => n && n !== "OUT").sort();
      expect(names(bedrock.env)).toEqual(names(plain.env));
      expect(createCodexAdapter().bedrockModel).toBe(codexBedrockModel);
      // the model the usage is reported under: the Bedrock id on Bedrock (also for the config.toml default), as is otherwise
      expect(bedrockModelName({ bedrock: { region: "ap-northeast-1" } }, "gpt-6-luna")).toBe("openai.gpt-6-luna");
      expect(bedrockModelName({ bedrock: { region: "ap-northeast-1" } }, "openai.gpt-6.1-sol")).toBe("openai.gpt-6.1-sol");
      expect(bedrockModelName({}, "gpt-6-luna")).toBe("gpt-6-luna");
      expect(bedrockModelName({ bedrock: { region: "ap-northeast-1" } }, undefined)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on Bedrock a task with no model and no config.toml model reports usage under the model app-server runs, as a Bedrock id", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-bedrock-default-"));
    const events: AgentEvent[] = [];
    const s = createCodexAdapter({ bin: FAKE, codexHome: home }).start({ cwd: home, scope: [home], prompt: "p", permissionMode: "auto", bedrock: { region: "ap-northeast-1" } }, (e) => events.push(e));
    try {
      const deadline = Date.now() + 5000;
      while (!events.some((e) => e.t === "permission.ask") && Date.now() < deadline) await Bun.sleep(20);
      const ask = events.find((e) => e.t === "permission.ask");
      if (ask?.t === "permission.ask") s.respondPermission(ask.id, "allow");
      while (!events.some((e) => e.t === "usage") && Date.now() < deadline) await Bun.sleep(20);
      expect(events.filter((e) => e.t === "usage").map((e) => (e.t === "usage" ? e.model : ""))).toContain("openai.gpt-6-luna");
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("bedrockModel", () => {
    expect(codexBedrockModel({ value: "gpt-6-sol", label: "GPT-6 Sol" })).toBeNull();
    expect(codexBedrockModel({ value: "gpt-6.2-sol", label: "GPT-6.2 Sol" })).toEqual({ value: "openai.gpt-6.2-sol", label: "GPT-6.2 Sol" });
    expect(codexBedrockModel({ value: "openai.gpt-6-luna", label: "L" })?.value).toBe("openai.gpt-6-luna");
    expect(CODEX_MODELS.map(codexBedrockModel).filter((m) => m !== null).map((m) => m.value)).toEqual(["openai.gpt-6.1-sol", "openai.gpt-6-astra", "openai.gpt-6-luna"]);
  });

  test("bedrock from config.toml", () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-bedrock-config-"));
    const read = (toml?: string) => {
      rmSync(join(home, "config.toml"), { force: true });
      if (toml !== undefined) writeFileSync(join(home, "config.toml"), toml);
      return bedrockFromConfig(home);
    };
    try {
      expect(read('model = "gpt-6-luna"\nmodel_provider = "amazon-bedrock"\n')).toBe(true);
      expect(read('profile = "aws"\n\n[profiles.aws]\nmodel_provider = "amazon-bedrock"\n')).toBe(true);
      // the profile in use decides, not the top-level provider
      expect(read('profile = "plain"\nmodel_provider = "amazon-bedrock"\n\n[profiles.plain]\nmodel = "gpt-6-luna"\n')).toBe(false);
      expect(read('model_provider = "openai"\n')).toBe(false);
      expect(read()).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("memories", () => {
  test("memories: app-server is started with features.memories=false", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-memories-"));
    const log = join(home, "wire.jsonl");
    const s = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt: "p", permissionMode: "auto" }, () => {});
    try {
      const argv = () => {
        try {
          return (JSON.parse(readFileSync(log, "utf8").split("\n")[0]!) as { argv: string[] }).argv;
        } catch {
          return undefined;
        }
      };
      const deadline = Date.now() + 5000;
      while (!argv() && Date.now() < deadline) await Bun.sleep(20);
      const got = argv() ?? [];
      expect(got[got.indexOf("features.memories=false") - 1]).toBe("-c");
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("memories note: detect warns only when memories stays on", async () => {
    const before = process.env.FAKE_CODEX_MEMORIES;
    try {
      process.env.FAKE_CODEX_MEMORIES = "true";
      expect((await createCodexAdapter({ bin: FAKE }).detect()).note).toContain("features.memories");
      process.env.FAKE_CODEX_MEMORIES = "false";
      expect((await createCodexAdapter({ bin: FAKE }).detect()).note).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.FAKE_CODEX_MEMORIES;
      else process.env.FAKE_CODEX_MEMORIES = before;
    }
  });

  test("memories note: a two-word stage is read as off, a CLI without the row warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-codex-memories-note-"));
    const bin = join(dir, "codex");
    const script = (row: string) => {
      writeFileSync(bin, `#!/bin/sh\necho '${row}'\n`);
      chmodSync(bin, 0o755);
      return bin;
    };
    try {
      expect(await memoryOffNote(script("memories   under development   false"))).toBeUndefined();
      expect(await memoryOffNote(script("other_feature   stable   false"))).toContain("features.memories");
      // a false row does not count when the command failed or was cut off after printing it
      expect(await memoryOffNote(script("memories   stable   false'; exit 1; echo '"))).toContain("features.memories");
      expect(await memoryOffNote(script("memories   stable   false'; sleep 5; echo '"), 100)).toContain("features.memories");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("question tool", () => {
  test("question tool ends the turn: requestUserInput gets the deferred reply for every question once, and the turn ends ok", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-question-"));
    const log = join(home, "wire.jsonl");
    const events: AgentEvent[] = [];
    const session = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt: "question: ask", permissionMode: "auto" }, (e) => events.push(e));
    try {
      for (const deadline = Date.now() + 5000; !events.some((e) => e.t === "session.end") && Date.now() < deadline; ) await Bun.sleep(20);
      const wire = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      // started with the flag that hands the model the tool in the default mode
      const argv = wire[0].argv as string[];
      expect(argv[argv.indexOf("features.default_mode_request_user_input=true") - 1]).toBe("-c");
      const answers = wire.filter((m) => m.result?.answers);
      expect(answers.map((m) => m.result)).toEqual([{ answers: { area: { answers: [QUESTION_DEFERRED_REPLY] }, note: { answers: [QUESTION_DEFERRED_REPLY] } } }]);
      expect(events.filter((e) => e.t === "question.ask")).toMatchObject([{ questions: [{ header: "Area", question: "Which part?", options: [{ label: "web", description: "web." }, { label: "core", description: "core." }], multiSelect: false }, { header: "Note", options: [] }] }]);
      expect(events.filter((e) => e.t === "session.end")).toMatchObject([{ status: "ok", summary: "Waiting for your choices" }]);
    } finally {
      await session.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("MCP tool approvals", () => {
  /** One turn on the fake whose MCP approval is answered with `decision`; returns the permission.ask, the wire and the events. */
  async function mcpTurn(hint: string, decision: "allow" | "deny" | null) {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-mcp-"));
    const log = join(home, "wire.jsonl");
    const events: AgentEvent[] = [];
    const session = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt: `mcp: ${hint}`, permissionMode: "on-request" }, (e) => events.push(e));
    try {
      for (const deadline = Date.now() + 5000; !events.some((e) => e.t === "permission.ask") && Date.now() < deadline; ) await Bun.sleep(20);
      const ask = events.find((e) => e.t === "permission.ask");
      if (ask?.t !== "permission.ask") throw new Error("no permission.ask");
      if (decision === null) {
        await Bun.sleep(200); // nothing answers by itself
        const wire = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        return { ask, answers: wire.filter((m) => m.id !== undefined && typeof m.method !== "string"), events };
      }
      session.respondPermission(ask.id, decision);
      for (const deadline = Date.now() + 5000; !events.some((e) => e.t === "session.end") && Date.now() < deadline; ) await Bun.sleep(20);
      const wire = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      return { ask, answers: wire.filter((m) => m.id !== undefined && typeof m.method !== "string"), events };
    } finally {
      await session.close();
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("answers an mcp elicitation approval", async () => {
    const allowed = await mcpTurn("destructive", "allow");
    expect(allowed.ask).toMatchObject({ kind: "other", tool: "MCP rec.drop_table", input: { table: "logs" }, mcpHint: "destructive" });
    expect(allowed.answers.map((m) => m.result)).toEqual([{ action: "accept", content: null, _meta: null }]);
    expect(allowed.events.find((e) => e.t === "permission.resolved")).toMatchObject({ id: allowed.ask.id, decision: "allow", by: "user" });
    expect(allowed.events.filter((e) => e.t === "session.end")).toMatchObject([{ status: "ok", summary: "ran" }]);
    const denied = await mcpTurn("none", "deny");
    expect(denied.ask.mcpHint).toBe("unknown");
    expect(denied.answers.map((m) => m.result)).toEqual([{ action: "decline", content: null, _meta: null }]);
    expect(denied.events.filter((e) => e.t === "session.end")).toMatchObject([{ status: "ok", summary: "declined" }]);
  });

  test("read-only hint still asks", async () => {
    const r = await mcpTurn("read-only", null);
    expect(r.ask.mcpHint).toBe("read-only");
    expect(r.answers).toEqual([]); // the adapter did not answer; the turn waits for the person
    expect(r.events.some((e) => e.t === "session.end")).toBe(false);
  });
});

describe("account of the usage-limit reports", () => {
  const EMAIL = "sentinel-user@example.invalid";
  const USER = "user-5e17e1a1-sentinel";
  const WORKSPACE = "Sentinel Workspace 7c2f";
  const answer = (userId: string | null, email = EMAIL) => JSON.stringify({ account: { type: "chatgpt", email, planType: "pro", workspaceName: WORKSPACE }, userId, requiresOpenaiAuth: true });
  const nameOf = (id: string) => new Bun.CryptoHasher("sha256").update(`codex:${id}`).digest("hex").slice(0, 16);

  /** A session on the fake whose `account/read` answers with what `file` holds; every console line it causes is collected. */
  async function withAccount(first: string, accountRereadMs: number | undefined, body: (c: { file: string; events: AgentEvent[]; printed: string[]; turn: (text?: string) => Promise<void> }) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-account-"));
    const file = join(home, "account.json");
    writeFileSync(file, first);
    const before = process.env.FAKE_CODEX_ACCOUNT_FILE;
    process.env.FAKE_CODEX_ACCOUNT_FILE = file;
    const printed: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const real = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
    const events: AgentEvent[] = [];
    const s = createCodexAdapter({ bin: FAKE, codexHome: home, ...(accountRereadMs === undefined ? {} : { accountRereadMs }) }).start({ cwd: home, scope: [home], prompt: "limits: 1", permissionMode: "auto" }, (e) => events.push(e));
    let turns = 0;
    const ended = async () => {
      turns++;
      for (const deadline = Date.now() + 5000; events.filter((e) => e.t === "session.end").length < turns && Date.now() < deadline; ) await Bun.sleep(20);
      expect(events.filter((e) => e.t === "session.end").length).toBe(turns);
    };
    try {
      await ended();
      await body({
        file,
        events,
        printed,
        turn: async (text = "limits: next") => {
          s.send(text);
          await ended();
        },
      });
    } finally {
      await s.close();
      methods.forEach((m, i) => (console[m] = real[i]!));
      if (before === undefined) delete process.env.FAKE_CODEX_ACCOUNT_FILE;
      else process.env.FAKE_CODEX_ACCOUNT_FILE = before;
      rmSync(home, { recursive: true, force: true });
    }
  }
  const accounts = (events: AgentEvent[]) => events.flatMap((e) => (e.t === "quota" ? [e.account] : []));

  test("the email, user id and workspace app-server names reach no event and no log line: the report carries only the 16-character name", async () => {
    for (const [userId, id] of [[USER, USER], [null, EMAIL]] as const) {
      await withAccount(answer(userId), undefined, async ({ events, printed }) => {
        expect(accounts(events)).toEqual([nameOf(id)]);
        const out = JSON.stringify(events) + printed.join("\n");
        for (const raw of [EMAIL, "sentinel-user", USER, "5e17e1a1", WORKSPACE]) expect(out).not.toContain(raw);
      });
    }
  });

  test("a login that changed under a running session: the report after the change asks again, and the next one carries the new account's name", async () => {
    await withAccount(answer("user-first"), 0, async ({ file, events, turn }) => {
      writeFileSync(file, answer("user-second"));
      await turn(); // carries the name read before the change, and asks again
      await Bun.sleep(100);
      await turn();
      expect(accounts(events)).toEqual([nameOf("user-first"), nameOf("user-first"), nameOf("user-second")]);
    });
    // within the minute of the last question nothing is asked again
    await withAccount(answer("user-first"), undefined, async ({ file, events, turn }) => {
      writeFileSync(file, answer("user-second"));
      await turn();
      await Bun.sleep(100);
      await turn();
      expect(accounts(events)).toEqual([nameOf("user-first"), nameOf("user-first"), nameOf("user-first")]);
    });
  });
});
