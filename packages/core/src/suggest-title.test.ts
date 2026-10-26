import { describe, expect, test } from "bun:test";
import type { AgentEvent, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { buildTitlePrompt, parseSkillCommand, parseTitle, skillCommandTitle, suggestTitle } from "./suggest-title.ts";

/** Replays `events` for every turn of `id`; same shape as the replay adapter in judge.test.ts. */
function replayAdapter(id: RunnerId, events: AgentEvent[], opts: { starts?: StartOptions[] } = {}): RunnerAdapter {
  return {
    id,
    permissionModes: [{ value: id === "claude" ? "plan" : "read-only", label: "ro", description: "ro" }],
    async detect() {
      return { available: true, version: "replay" };
    },
    start(startOpts, emit) {
      opts.starts?.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      queueMicrotask(() => (events.forEach(emit), resolveExit(0)));
      const session: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(0), close: async () => resolveExit(0), exited };
      return session;
    },
  };
}

const answer = (t: string, model: string): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: t }, { t: "usage", source: "reported", model, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, { t: "session.end", status: "ok" }];
const failed: AgentEvent[] = [{ t: "error", message: "You've hit your usage limit." }, { t: "session.end", status: "error" }];
const run = (adapters: RunnerAdapter[]) => suggestTitle({ prompt: "README の誤字を直して", reply: "直しました" }, { adapters: new Map(adapters.map((a) => [a.id, a])), cwd: "/tmp/switchboard-home/suggest" });

describe("parseTitle", () => {
  test("takes the first non-empty line without quotes, #, or a title label, cut to 60 characters", () => {
    expect(parseTitle("\n\nREADME の誤字を直す\n説明")).toBe("README の誤字を直す");
    expect(parseTitle("「README の誤字を直す」")).toBe("README の誤字を直す");
    expect(parseTitle('"Fix typos"')).toBe("Fix typos");
    expect(parseTitle("## タイトル: 誤字修正")).toBe("誤字修正");
    expect(parseTitle("あ".repeat(100))).toHaveLength(60);
  });
  test("an answer with nothing in it throws", () => {
    expect(() => parseTitle("  \n ")).toThrow();
    expect(() => parseTitle('""')).toThrow();
  });
});

describe("buildTitlePrompt", () => {
  test("puts the request and the last reply on one line each, capped", () => {
    const p = buildTitlePrompt({ prompt: `a\n${"x".repeat(3000)}`, reply: "" });
    expect(p).toContain("a xxx");
    expect(p).toContain("(なし)");
    expect(p.length).toBeLessThan(2000);
  });
});

describe("suggestTitle", () => {
  test("codex answers: its title, asked read-only with gpt-6-luna; Claude is not asked", async () => {
    const starts: StartOptions[] = [];
    const claudeStarts: StartOptions[] = [];
    const r = await run([replayAdapter("codex", answer("誤字を直す", "gpt-6-luna"), { starts }), replayAdapter("claude", [], { starts: claudeStarts })]);
    expect(r).toEqual({ title: "誤字を直す", runner: "codex", model: "gpt-6-luna" });
    expect(starts[0]).toMatchObject({ model: "gpt-6-luna", permissionMode: "read-only" });
    expect(claudeStarts).toHaveLength(0);
  });
  test("codex fails: Haiku names it; a codex that is not installed hands over the same way", async () => {
    expect((await run([replayAdapter("codex", failed), replayAdapter("claude", answer("誤字を直す", "claude-haiku-4-5"))])).runner).toBe("claude");
    expect((await run([replayAdapter("claude", answer("誤字を直す", "claude-haiku-4-5"))])).runner).toBe("claude");
  });
  test("neither answers: it throws", async () => {
    await expect(run([replayAdapter("codex", failed), replayAdapter("claude", failed)])).rejects.toThrow();
    await expect(run([])).rejects.toThrow();
  });
});

describe("skill command title", () => {
  test("parseSkillCommand reads /<name> <issue> on the first line, with or without #", () => {
    expect(parseSkillCommand("/pbi-complete 123")).toEqual({ command: "pbi-complete", issue: 123 });
    expect(parseSkillCommand("/pbi-complete #123")).toEqual({ command: "pbi-complete", issue: 123 });
    expect(parseSkillCommand("/foo:bar 7 追記\n本文")).toEqual({ command: "foo:bar", issue: 7 });
    expect(parseSkillCommand("/pbi-complete")).toBeNull();
    expect(parseSkillCommand("直して 123")).toBeNull();
    expect(parseSkillCommand("本文\n/pbi-complete 123")).toBeNull();
  });
  test("skillCommandTitle asks gh in the folder and joins command, number and the Issue's title; any failure is null", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const ok = async (args: string[], cwd: string) => (calls.push({ args, cwd }), { code: 0, stdout: "Task 一覧のタイトル\n", stderr: "" });
    expect(await skillCommandTitle("/pbi-complete 491", "/repo", ok)).toBe("/pbi-complete #491 Task 一覧のタイトル");
    expect(calls[0]).toEqual({ args: ["issue", "view", "491", "--json", "title", "--jq", ".title"], cwd: "/repo" });
    expect(await skillCommandTitle("/pbi-complete 491", "/repo", async () => ({ code: 1, stdout: "", stderr: "no" }))).toBeNull();
    expect(await skillCommandTitle("/pbi-complete 491", "/repo", async () => ({ code: 0, stdout: "\n", stderr: "" }))).toBeNull();
    expect(await skillCommandTitle("/pbi-complete 491", "/repo", async () => { throw new Error("boom"); })).toBeNull();
    expect(await skillCommandTitle("直して", "/repo", ok)).toBeNull();
    expect((await skillCommandTitle("/x 1", "/repo", async () => ({ code: 0, stdout: "あ".repeat(300), stderr: "" })))!).toHaveLength(120);
  });
  test("a gh that never answers gives up after 5 seconds", async () => {
    const t0 = Date.now();
    expect(await skillCommandTitle("/x 1", "/repo", () => new Promise(() => undefined))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(7000);
  }, 10_000);
});
