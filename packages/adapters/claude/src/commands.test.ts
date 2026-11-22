// test-reads: none
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRecordings, recordingText, skipRecordings } from "../../../../scripts/recordings.ts";
import { commandsOf } from "./commands.ts";
import { commandsTimeoutMs, createClaudeAdapter } from "./index.ts";

const dirs: string[] = [];
const touched: string[] = [];
function temp() {
  const d = mkdtempSync(join(tmpdir(), "sb-claude-commands-"));
  dirs.push(d);
  return d;
}
function setEnv(k: string, v: string) {
  touched.push(k);
  process.env[k] = v;
}
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(25);
  return !alive(pid);
};

const ANSWER = JSON.stringify({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "init-1",
    response: {
      commands: [
        { name: "debug", description: "Debug it", argumentHint: "[issue]", builtin: true },
        { name: "pdf", description: "Make a PDF", argumentHint: "" },
      ],
    },
  },
});

/**
 * A stand-in `claude`: records its pid, its arguments and every line it is sent until it is killed. It answers the
 * first line with `answer` (or never, when hanging) only after 300 ms without a further line, so a line written right
 * after `initialize` is recorded before the answer ends the read.
 */
function fake(dir: string, o: { hang?: boolean; exitAfterAnswer?: boolean } = {}): string {
  const bin = join(dir, "claude");
  const answer = o.hang ? "" : `echo '${ANSWER}'\n`;
  writeFileSync(
    bin,
    `#!/bin/bash\necho $$ > "${dir}/pid"\nprintf '%s\\n' "$@" > "${dir}/args"\n` +
      `read -r a; echo "$a" >> "${dir}/wire"\n` +
      `while read -r -t 0.3 a; do echo "$a" >> "${dir}/wire"; done\n` +
      answer +
      (o.exitAfterAnswer ? "exit 0\n" : `while read -r a; do echo "$a" >> "${dir}/wire"; done\nsleep 30\n`),
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("listCommands", () => {
  test("listCommands returns the commands of the initialize answer", async () => {
    const dir = temp();
    const list = await createClaudeAdapter({ bin: fake(dir) }).listCommands!(dir);
    expect(list).toEqual([
      { name: "debug", description: "Debug it", argumentHint: "[issue]", insert: "/debug" },
      { name: "pdf", description: "Make a PDF", insert: "/pdf" },
    ]);
  });

  test("listCommands writes only initialize and the process does not stay", async () => {
    const dir = temp();
    await createClaudeAdapter({ bin: fake(dir) }).listCommands!(dir);
    const sent = readFileSync(join(dir, "wire"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize" } });
    expect(await gone(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(true);
  });

  test("listCommands starts claude with no MCP servers and the session's extra arguments", async () => {
    const dir = temp();
    await createClaudeAdapter({ bin: fake(dir), extraArgs: ["--setting-sources", "user"] }).listCommands!(dir);
    const args = readFileSync(join(dir, "args"), "utf8").split("\n").filter(Boolean);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(args.slice(-2)).toEqual(["--setting-sources", "user"]);
  });

  test("listCommands reads an answer printed just before claude exits", async () => {
    const dir = temp();
    const list = await createClaudeAdapter({ bin: fake(dir, { exitAfterAnswer: true }) }).listCommands!(dir);
    expect(list.map((c) => c.insert)).toEqual(["/debug", "/pdf"]);
  });

  test("listCommands rejects on timeout and kills the process", async () => {
    const dir = temp();
    setEnv("SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS", "400");
    await expect(createClaudeAdapter({ bin: fake(dir, { hang: true }) }).listCommands!(dir)).rejects.toThrow(/did not answer within 400 ms/);
    expect(await gone(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(true);
  });

  test("the time limit is the environment value when it is a positive number, 15 s otherwise", () => {
    expect(commandsTimeoutMs({ SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS: "250" })).toBe(250);
    expect(commandsTimeoutMs({})).toBe(15_000);
    expect(commandsTimeoutMs({ SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS: "0" })).toBe(15_000);
    expect(commandsTimeoutMs({ SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS: "x" })).toBe(15_000);
  });
});

// fixtures/list-commands-2.1.330.jsonl: Claude Code 2.1.330, recorded 2026-11-21 — the only line a claude prints when it is
// written `initialize` alone (no user message): the control_response with `commands`. The account is masked.
const REC = "packages/adapters/claude/fixtures/list-commands-2.1.330.jsonl";
describe("the recorded initialize answer (recorded replay, Claude Code 2.1.330)", () => {
  test.skipIf(skipRecordings(REC))("the recorded initialize answer gives the command list", () => {
    assertRecordings(REC);
    const lines = recordingText(REC).split("\n").filter((l) => l.trim());
    // initialize alone ends in one answer: no assistant turn, so the model was not called
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["control_response"]);
    const list = commandsOf(JSON.parse(lines[0]!).response.response.commands);
    expect(list.length).toBeGreaterThan(10);
    expect(list.every((c) => c.insert === `/${c.name}` && c.name !== "")).toBe(true);
    expect(list.find((c) => c.name === "debug")).toMatchObject({ argumentHint: "[issue description]", insert: "/debug" });
    expect(list.find((c) => c.name === "init")).toEqual({ name: "init", description: expect.any(String), insert: "/init" });
  });
});
