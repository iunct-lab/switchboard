// test-reads: none
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUESTION_DEFERRED_REPLY, type AgentEvent } from "@switchboard/protocol";
import { claudeSessionExists, createClaudeAdapter } from "./index.ts";

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

describe("bedrock (#1730)", () => {
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

describe("question tool (#3056)", () => {
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
