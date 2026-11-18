// test-reads: packages/adapters/codex/fixtures/fake-app-server.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRecordings, recordingText, skipRecordings } from "../../../../scripts/recordings.ts";
import { buildTurnStartParams, commandsTimeoutMs, createCodexAdapter } from "./index.ts";

const FAKE = new URL("../fixtures/fake-app-server.ts", import.meta.url).pathname;
const dirs: string[] = [];
const touched: string[] = [];
function temp() {
  const d = mkdtempSync(join(tmpdir(), "sb-codex-commands-"));
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

describe("listCommands", () => {
  test("listCommands returns the enabled skills with $name", async () => {
    const home = temp();
    const list = await createCodexAdapter({ bin: FAKE, codexHome: home }).listCommands!(home);
    expect(list).toEqual([
      { name: "alpha", description: "Alpha short", insert: "$alpha" },
      { name: "beta", description: "Beta description", insert: "$beta" },
    ]);
  });

  test("listCommands sends only initialize and skills/list and the process does not stay", async () => {
    const home = temp();
    const log = join(home, "wire.jsonl");
    const pidFile = join(home, "pid");
    setEnv("FAKE_CODEX_PID_FILE", pidFile);
    await createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).listCommands!(home);
    const sent = readFileSync(log, "utf8").split("\n").filter((l) => l.trim() && !l.includes('"argv"')).map((l) => JSON.parse(l).method);
    expect(sent).toEqual(["initialize", "initialized", "skills/list"]);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(25);
    expect(alive(pid)).toBe(false);
  });

  test("listCommands rejects on timeout and kills the process", async () => {
    const home = temp();
    const pidFile = join(home, "pid");
    setEnv("FAKE_CODEX_PID_FILE", pidFile);
    setEnv("FAKE_CODEX_SKILLS_HANG", "1");
    setEnv("SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS", "400");
    await expect(createCodexAdapter({ bin: FAKE, codexHome: home }).listCommands!(home)).rejects.toThrow(/did not answer within 400 ms/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(25);
    expect(alive(pid)).toBe(false);
  });

  test("the time limit is the environment value when it is a positive number, 15 s otherwise", () => {
    expect(commandsTimeoutMs({ SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS: "250" })).toBe(250);
    expect(commandsTimeoutMs({})).toBe(15_000);
    expect(commandsTimeoutMs({ SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS: "0" })).toBe(15_000);
    expect(commandsTimeoutMs({ SWITCHBOARD_RUNNER_COMMANDS_TIMEOUT_MS: "x" })).toBe(15_000);
  });
});

// fixtures/skill-text-0.169.0.jsonl: codex-cli 0.169.0, recorded 2026-11-18 — a workspace with one repo skill (.agents/skills/probe-skill,
// whose SKILL.md alone holds the phrase PROBE-PHRASE-7431-OK). The order is a real session's: initialize, initialized,
// thread/start, turn/start with only the text "$probe-skill go" — no skills/list before it.
const REC = "packages/adapters/codex/fixtures/skill-text-0.169.0.jsonl";
describe("a turn with $skill (recorded replay, codex-cli 0.169.0)", () => {
  test.skipIf(skipRecordings(REC))("a turn with $skill hands the skill to codex without skills/list", () => {
    assertRecordings(REC);
    const lines = recordingText(REC).split("\n").filter((l) => l.trim());
    const sent = lines.filter((l) => l.startsWith("> ")).map((l) => JSON.parse(l.slice(2)));
    // a real session never lists skills before the turn
    expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    // the adapter sends the same shape as the recorded turn: the text only, no skill item
    const sentByAdapter = buildTurnStartParams("t", "$probe-skill go", { cwd: "/w", scope: ["/w"], prompt: "" }).input;
    expect(sentByAdapter).toEqual(sent[3].params.input);
    expect(sent[3].params.input.map((i: { type: string }) => i.type)).toEqual(["text"]);
    // codex still gave the model the skill body: it answered with the phrase only the SKILL.md holds, without reading any file
    const answers = lines.filter((l) => !l.startsWith("> ")).map((l) => JSON.parse(l)).filter((m) => m.method === "item/completed" && m.params.item.type === "agentMessage");
    expect(answers.map((m) => m.params.item.text)).toEqual(["PROBE-PHRASE-7431-OK"]);
    expect(lines.some((l) => !l.startsWith("> ") && l.includes('"type":"commandExecution"'))).toBe(false);
  });
});
