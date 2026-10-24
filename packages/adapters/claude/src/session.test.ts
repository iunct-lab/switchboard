import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@switchboard/protocol";
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
