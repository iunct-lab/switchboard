// test-reads: none
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUESTION_DEFERRED_REPLY, type AgentEvent } from "@switchboard/protocol";
import { accountName, claudeSessionExists, createClaudeAdapter, telemetryEnv } from "./index.ts";

describe("claudeSessionExists", () => {
  test("finds <id>.jsonl under any project folder; false when missing or there is no projects folder", () => {
    const home = mkdtempSync(join(tmpdir(), "sb-claude-home-"));
    try {
      expect(claudeSessionExists("abc", home)).toBe(false);
      mkdirSync(join(home, "projects", "-Volumes-x-capsule-host"), { recursive: true });
      expect(claudeSessionExists("abc", home)).toBe(false);
      writeFileSync(join(home, "projects", "-Volumes-x-capsule-host", "abc.jsonl"), "{}\n");
      expect(claudeSessionExists("abc", home)).toBe(true);
      expect(claudeSessionExists("ab", home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("without a home it looks where the spawned claude keeps its sessions: CLAUDE_CONFIG_DIR, which the child inherits", () => {
    const home = mkdtempSync(join(tmpdir(), "sb-claude-config-"));
    const before = process.env.CLAUDE_CONFIG_DIR;
    try {
      mkdirSync(join(home, "projects", "p"), { recursive: true });
      writeFileSync(join(home, "projects", "p", "in-config-dir.jsonl"), "{}\n");
      process.env.CLAUDE_CONFIG_DIR = home;
      expect(claudeSessionExists("in-config-dir")).toBe(true);
      expect(createClaudeAdapter().hasSession?.("in-config-dir")).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("preamble", () => {
  test("goes to claude ahead of the prompt in the first message, but the transcript shows only what the user typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-claude-preamble-"));
    const got = join(dir, "stdin.jsonl");
    const bin = join(dir, "claude");
    // reads the initialize line and the first user message, then exits
    writeFileSync(bin, `#!/bin/sh\nhead -n 2 > "${got}"\nexit 0\n`);
    chmodSync(bin, 0o755);
    const events: AgentEvent[] = [];
    try {
      const s = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "状況は？", preamble: "RECAP" }, (e) => events.push(e));
      await s.exited;
      expect(existsSync(got)).toBe(true);
      const user = readFileSync(got, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.type === "user");
      expect(user.message.content).toBe("RECAP\n\n状況は？");
      expect(events.filter((e) => e.t === "message.delta" && e.role === "user").map((e) => (e.t === "message.delta" ? e.text : ""))).toEqual(["状況は？"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("telemetryEnv", () => {
  test("telemetryEnv: off by default adds the disabling variables, on adds none", () => {
    const off = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" };
    expect(telemetryEnv({})).toEqual(off);
    expect(telemetryEnv({ runnerTelemetry: false })).toEqual(off);
    expect(telemetryEnv({ runnerTelemetry: true })).toEqual({});
  });

  test("telemetryEnv: the child gets the disabling variables by default and no OTEL_ name, even if the parent env has one, and with runnerTelemetry on it adds none but keeps what the parent set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-claude-telemetry-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\nhead -n 2 >/dev/null\nenv > "$OUT"\nexit 0\n`);
    chmodSync(bin, 0o755);
    const out = join(dir, "env.txt");
    const offVars = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER"] as const;
    const before = { out: process.env.OUT, otel: process.env.OTEL_EXPORTER_OTLP_ENDPOINT };
    const beforeOff = offVars.map((k) => [k, process.env[k]] as const);
    const names = async (runnerTelemetry?: boolean) => {
      const s = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "p", runnerTelemetry }, () => undefined);
      await s.exited;
      const v = readFileSync(out, "utf8").split("\n").map((l) => l.split("=")[0] ?? "");
      rmSync(out);
      return v;
    };
    try {
      for (const k of offVars) delete process.env[k];
      process.env.OUT = out;
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1";
      const off = await names();
      expect(off.filter((n) => n.startsWith("OTEL_"))).toEqual([]);
      expect(off).toContain("DISABLE_TELEMETRY");
      expect(off).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
      expect(await names(true)).not.toContain("DISABLE_TELEMETRY");
      process.env.DISABLE_TELEMETRY = "1";
      expect(await names(true)).toContain("DISABLE_TELEMETRY");
    } finally {
      for (const [k, v] of [["OUT", before.out], ["OTEL_EXPORTER_OTLP_ENDPOINT", before.otel], ...beforeOff] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bedrock", () => {
  test("the child gets CLAUDE_CODE_USE_BEDROCK and AWS_REGION only when StartOptions.bedrock is set, even if the parent env has CLAUDE_CODE_USE_BEDROCK", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-claude-bedrock-"));
    const bin = join(dir, "claude");
    // writes the two variables (empty when unset) and exits
    writeFileSync(bin, `#!/bin/sh\nhead -n 2 >/dev/null\nprintf '%s|%s|%s' "$CLAUDE_CODE_USE_BEDROCK" "$AWS_REGION" "\${AWS_SECRET_ACCESS_KEY:-none}" > "$OUT"\nexit 0\n`);
    chmodSync(bin, 0o755);
    const out = join(dir, "env.txt");
    const before = { use: process.env.CLAUDE_CODE_USE_BEDROCK, region: process.env.AWS_REGION, out: process.env.OUT, key: process.env.AWS_SECRET_ACCESS_KEY };
    const run = async (bedrock?: { region: string }) => {
      const s = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "p", bedrock }, () => undefined);
      await s.exited;
      const v = readFileSync(out, "utf8");
      rmSync(out);
      return v;
    };
    try {
      process.env.OUT = out;
      process.env.CLAUDE_CODE_USE_BEDROCK = "1"; // the daemon's own env must not decide
      delete process.env.AWS_REGION;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      expect(await run()).toBe("||none");
      expect(await run({ region: "ap-northeast-1" })).toBe("1|ap-northeast-1|none");
    } finally {
      for (const [k, v] of [["CLAUDE_CODE_USE_BEDROCK", before.use], ["AWS_REGION", before.region], ["OUT", before.out], ["AWS_SECRET_ACCESS_KEY", before.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("question tool", () => {
  test("question tool ends the turn: AskUserQuestion is declined once with the deferred reply, nothing left pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-claude-question-"));
    const got = join(dir, "reply.jsonl");
    const bin = join(dir, "claude");
    const ask = JSON.stringify({ type: "control_request", request_id: "q-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "H", options: [{ label: "a", description: "x" }], multiSelect: false }] } } });
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Waiting.", session_id: "s1" });
    // reads the initialize line and the first message, asks, keeps what comes back, ends the turn and exits
    writeFileSync(bin, `#!/bin/sh\nread a\nread b\necho '${ask}'\nread c\nprintf '%s\\n' "$c" > "${got}"\necho '${result}'\nexit 0\n`);
    chmodSync(bin, 0o755);
    const events: AgentEvent[] = [];
    try {
      const s = createClaudeAdapter({ bin }).start({ cwd: dir, scope: [dir], prompt: "ask" }, (e) => events.push(e));
      await s.exited;
      const reply = readFileSync(got, "utf8").trim().split("\n");
      expect(reply).toHaveLength(1);
      expect(JSON.parse(reply[0]!).response).toEqual({ subtype: "success", request_id: "q-1", response: { behavior: "deny", message: QUESTION_DEFERRED_REPLY } });
      expect(events.filter((e) => e.t === "question.ask")).toEqual([{ t: "question.ask", id: "q-1", questions: [{ header: "H", question: "Which?", options: [{ label: "a", description: "x" }], multiSelect: false }] }]);
      expect(events.some((e) => e.t === "permission.ask")).toBe(false);
      expect(events.find((e) => e.t === "session.end")).toMatchObject({ status: "ok" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("account of the usage-limit reports", () => {
  const EMAIL = "sentinel-user@example.invalid";
  const ORG = "0b9d3c1e-5e17-4e1a-9c2f-5e17e1a15e17";
  const ORG_NAME = "Sentinel Org 7c2f";
  const status = (email = EMAIL) => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email, orgId: ORG, orgName: ORG_NAME, subscriptionType: "max" });
  const LIMITS = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1790000000 } } } });
  // what the CLI answers to `initialize` names the account too
  const INIT = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "init-1", response: { account: { email: EMAIL, organization: ORG_NAME, subscriptionType: "max" } } } });

  /**
   * A stand-in `claude`: `auth status` prints what `status.json` holds at that moment (and the email on stderr), counted
   * in `calls`; a session reads its two first lines, waits, then prints the initialize answer and one usage-limit report.
   */
  function fake(dir: string): { bin: string; login: (json: string) => void; reads: () => number } {
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.281 (Claude Code)"; exit 0; fi\nif [ "$1 $2" = "auth status" ]; then echo x >> "${dir}/calls"; cat "${dir}/status.json"; echo "logged in as ${EMAIL}" >&2; exit 0; fi\nread a\nread b\nsleep 0.5\necho '${INIT}'\necho '${LIMITS}'\nexit 0\n`,
    );
    chmodSync(bin, 0o755);
    return { bin, login: (json) => writeFileSync(join(dir, "status.json"), json), reads: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length : 0) };
  }
  const report = async (adapter: ReturnType<typeof createClaudeAdapter>, dir: string) => {
    const events: AgentEvent[] = [];
    await adapter.start({ cwd: dir, scope: [dir], prompt: "p" }, (e) => events.push(e)).exited;
    return { events, accounts: events.flatMap((e) => (e.t === "quota" ? [e.account] : [])) };
  };

  test("the email and organization `claude auth status` and the session name reach no detection, event or log line: the report carries only the 16-character name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-claude-account-"));
    const printed: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const real = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
    try {
      const f = fake(dir);
      f.login(status());
      const adapter = createClaudeAdapter({ bin: f.bin });
      const detection = await adapter.detect();
      expect(detection).toMatchObject({ available: true, login: "ok", loginKind: "claude.ai" });
      const { events, accounts } = await report(adapter, dir);
      expect(accounts).toEqual([accountName(`${ORG}:${EMAIL}`)]);
      expect(accounts[0]).toMatch(/^[0-9a-f]{16}$/);
      const out = JSON.stringify(detection) + JSON.stringify(events) + printed.join("\n");
      for (const raw of [EMAIL, "sentinel-user", ORG, "0b9d3c1e", ORG_NAME]) expect(out).not.toContain(raw);
    } finally {
      methods.forEach((m, i) => (console[m] = real[i]!));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a login that changed in a terminal after the last detection: a session that starts reads it again, and its report carries the new account's name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-claude-account-"));
    try {
      const f = fake(dir);
      f.login(status());
      const adapter = createClaudeAdapter({ bin: f.bin, accountRereadMs: 0 });
      await adapter.detect();
      expect((await report(adapter, dir)).accounts).toEqual([accountName(`${ORG}:${EMAIL}`)]);
      await Bun.sleep(300); // the read the report asked for is over
      f.login(status("second@example.invalid"));
      expect((await report(adapter, dir)).accounts).toEqual([accountName(`${ORG}:second@example.invalid`)]);
      await Bun.sleep(300);
      // within a minute of the last read nothing is read again: the status command runs once, for the detection
      const calm = createClaudeAdapter({ bin: f.bin });
      await calm.detect();
      const before = f.reads();
      f.login(status("third@example.invalid"));
      expect((await report(calm, dir)).accounts).toEqual([accountName(`${ORG}:second@example.invalid`)]);
      expect(f.reads()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
