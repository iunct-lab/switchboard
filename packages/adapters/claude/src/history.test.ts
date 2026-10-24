import { recordingText, skipRecordings, assertRecordings } from "../../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { AgentEvent } from "@switchboard/protocol";
import { claudeProjectDirName, createClaudeHistoryParser, hasPendingEnd, isTerminalRecord, serializeHistoryState, type TimedEvent } from "./history.ts";

// Record shapes copied from Claude Code 2.1.263 session logs (2026-09-06..09), values sanitized. See history.ts.
const FIXTURE = recordingText("packages/adapters/claude/fixtures/terminal-session.jsonl").split("\n").filter(Boolean);

function replay(lines: string[]) {
  const p = createClaudeHistoryParser();
  const out: TimedEvent[] = [];
  for (const l of lines) out.push(...p.feed(l));
  out.push(...p.flush());
  return { events: out, state: p.state };
}

const label = (e: TimedEvent) => (e.ev.t === "message.delta" ? `message.delta(${e.ev.role})` : e.ev.t === "session.end" ? `session.end(${e.ev.status})` : e.ev.t);

describe("claude history (session log → AgentEvent)", () => {
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("replays a terminal session: prompts, assistant text, tool rows, artifact, per-message usage, turn ends, interrupt", () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { events, state } = replay(FIXTURE);
    for (const e of events) expect(AgentEvent.parse(e.ev)).toEqual(e.ev);
    expect(events.map(label)).toEqual([
      "session.start",
      "message.delta(user)",
      "usage", // msg_A: the thinking record carries the usage; counted once for the whole message
      "message.delta(assistant)",
      "tool.call",
      "tool.result",
      "tool.call", // Write
      "usage", // msg_B
      "tool.result",
      "artifact",
      "message.delta(assistant)", // msg_C, end_turn
      "usage", // msg_C
      "session.end(ok)", // deferred until the next record of another message (system/turn_duration)
      "message.delta(user)", // isMeta caveat and the task-notification before it are not prompts
      "tool.call", // msg_D bun test
      "usage",
      "tool.result", // is_error
      "session.end(aborted)", // [Request interrupted by user for tool use]
      "message.delta(user)", // the sdk-cli turn in between is not terminal history
      "message.delta(assistant)", // msg_E, end_turn
      "usage",
      "session.end(ok)", // flush(): the file ends right after end_turn
    ]);
    const start = events[0]!.ev;
    expect(start).toMatchObject({ t: "session.start", runner: "claude", runnerSessionId: "11111111-1111-4111-8111-111111111111", cwd: "/work/repo", permissionMode: "auto", runnerVersion: "2.1.263" });
    expect(events[0]!.ts).toBe(Date.parse("2026-09-06T12:52:26.200Z"));
    const users = events.filter((e) => e.ev.t === "message.delta" && e.ev.role === "user").map((e) => (e.ev as { text: string }).text);
    expect(users).toEqual(["リポジトリの構成を説明して", "テストも走らせて", "ありがとう"]);
    const texts = events.filter((e) => e.ev.t === "message.delta" && e.ev.role === "assistant").map((e) => e.ev as Extract<AgentEvent, { t: "message.delta" }>);
    expect(texts.map((t) => [t.text, t.messageId])).toEqual([
      ["構成を確認します。", "msg_A"],
      ["NOTES.md に構成を書きました。", "msg_C"],
      ["どうぞ。", "msg_E"],
    ]);
    const calls = events.filter((e) => e.ev.t === "tool.call").map((e) => e.ev as Extract<AgentEvent, { t: "tool.call" }>);
    expect(calls.map((c) => [c.id, c.name, c.summary])).toEqual([
      ["toolu_01", "Bash", "ls"],
      ["toolu_02", "Write", "/work/repo/NOTES.md"],
      ["toolu_03", "Bash", "bun test"],
    ]);
    const results = events.filter((e) => e.ev.t === "tool.result").map((e) => e.ev as Extract<AgentEvent, { t: "tool.result" }>);
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ["toolu_01", true],
      ["toolu_02", true],
      ["toolu_03", false],
    ]);
    expect(results[2]!.summary).toContain("1 fail");
    expect(events.find((e) => e.ev.t === "artifact")!.ev).toMatchObject({ kind: "diff", path: "/work/repo/NOTES.md" });
    const usage = events.filter((e) => e.ev.t === "usage").map((e) => e.ev as Extract<AgentEvent, { t: "usage" }>);
    expect(usage).toHaveLength(5); // A B C D E — not msg_S (sdk-cli), and msg_A only once despite three records
    expect(usage[0]).toMatchObject({ source: "turn", model: "claude-fable-5-1", inputTokens: 2, outputTokens: 359, cacheReadTokens: 32349, cacheWriteTokens: 7183 });
    // The turn's end is stamped with the end_turn message's own time, not the time of the record that revealed it.
    const firstEnd = events.find((e) => e.ev.t === "session.end")!;
    expect(firstEnd.ts).toBe(Date.parse("2026-09-06T12:53:30.000Z"));
    expect(events.find((e) => e.ev.t === "session.end" && e.ev.status === "aborted")!.ev).toMatchObject({ summary: "[Request interrupted by user for tool use]" });
    // nothing injected by Claude Code or written by another host leaks into the transcript
    const all = JSON.stringify(events);
    for (const s of ["local-command-caveat", "task-notification", "SDK ホスト経由", "Switchboard から続き", "REDACTED"]) expect(all).not.toContain(s);

    expect(state.title).toBe("リポジトリ構成の説明");
    expect(state.permissionMode).toBe("acceptEdits");
    expect(state.model).toBe("claude-fable-5-1");
    expect(state.cwd).toBe("/work/repo");
    expect([...state.entrypoints].sort()).toEqual(["cli", "sdk-cli"]);
    expect(state.firstTs).toBe(Date.parse("2026-09-06T12:52:26.186Z"));
    expect(state.lastTs).toBe(Date.parse("2026-09-06T13:10:05.000Z"));
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("a file with only sdk-cli records yields no events and no start (the host that drove it recorded them)", () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const sdkOnly = FIXTURE.filter((l) => {
      const r = JSON.parse(l);
      return r.entrypoint === "sdk-cli" || r.type === "ai-title";
    });
    expect(sdkOnly.length).toBeGreaterThan(1);
    const { events, state } = replay(sdkOnly);
    expect(events).toEqual([]);
    expect(state.started).toBe(false);
    expect(state.title).toBe("リポジトリ構成の説明"); // metadata still applies to the file
    expect([...state.entrypoints]).toEqual(["sdk-cli"]);
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("state survives a slice boundary: feeding in two halves with a serialized state equals one pass", () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const whole = replay(FIXTURE).events;
    // cut inside msg_A (between its thinking and text records) and right after the Write tool_use (before its result)
    for (const cut of [4, 8, 10, 17]) {
      const p1 = createClaudeHistoryParser();
      const first: TimedEvent[] = [];
      for (const l of FIXTURE.slice(0, cut)) first.push(...p1.feed(l));
      const p2 = createClaudeHistoryParser(serializeHistoryState(p1.state));
      const second: TimedEvent[] = [];
      for (const l of FIXTURE.slice(cut)) second.push(...p2.feed(l));
      second.push(...p2.flush());
      expect([...first, ...second]).toEqual(whole);
    }
    // a fresh parser at the same cut would re-announce the session and count msg_A's usage again
    const p1 = createClaudeHistoryParser();
    const head: TimedEvent[] = [];
    for (const l of FIXTURE.slice(0, 4)) head.push(...p1.feed(l));
    const naive = createClaudeHistoryParser();
    const tail: TimedEvent[] = [];
    for (const l of FIXTURE.slice(4)) tail.push(...naive.feed(l));
    expect([...head, ...tail].filter((e) => e.ev.t === "usage")).toHaveLength(6);
    expect([...head, ...tail].filter((e) => e.ev.t === "session.start")).toHaveLength(2);
    // a corrupt or foreign saved state must not be silently replaced by a fresh one: the caller would go on from
    // its byte offset and announce the session again / count usage twice
    expect(() => createClaudeHistoryParser("not json")).toThrow(/not JSON/);
    expect(() => createClaudeHistoryParser(JSON.stringify({ started: true }))).toThrow(/version/);
    expect(createClaudeHistoryParser("").state.started).toBe(false);
    // the state stays small however long the session is: nothing accumulates per message
    const long = createClaudeHistoryParser();
    for (let i = 0; i < 2000; i++) long.feed(JSON.stringify({ type: "assistant", entrypoint: "cli", timestamp: "2026-09-06T13:00:00.000Z", message: { model: "m", id: `msg_${i}`, content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: "true" } }], stop_reason: "tool_use", usage: { input_tokens: 1 } } }));
    expect(serializeHistoryState(long.state).length).toBeLessThan(1000);
  });

  test("a message split by a slice boundary ends the turn once; a synthetic banner is an error that ends the turn as error", () => {
    const rec = (id: string, block: unknown, stop: string, model = "claude-fable-5-1") =>
      JSON.stringify({ type: "assistant", entrypoint: "cli", timestamp: "2026-09-06T13:00:00.000Z", message: { model, id, content: [block], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } } });
    // thinking record of an end_turn message, then the file goes quiet (flush), then its text record arrives
    const p1 = createClaudeHistoryParser();
    const a: TimedEvent[] = [...p1.feed(rec("msg_X", { type: "thinking", thinking: "" }, "end_turn")), ...p1.flush()];
    expect(a.map(label)).toEqual(["session.start", "usage", "session.end(ok)"]);
    const p2 = createClaudeHistoryParser(serializeHistoryState(p1.state));
    const b: TimedEvent[] = [...p2.feed(rec("msg_X", { type: "text", text: "late text" }, "end_turn")), ...p2.flush()];
    expect(b.map(label)).toEqual(["message.delta(assistant)"]); // no second end, no second usage
    // …and the next typed prompt does not close the turn again either
    const c = p2.feed(JSON.stringify({ type: "user", entrypoint: "cli", timestamp: "2026-09-06T13:01:00.000Z", origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: "next" } }));
    expect(c.map(label)).toEqual(["message.delta(user)"]);
    // Claude Code's own text (session limit) — not an answer, not usage, and the turn ends as an error
    const p3 = createClaudeHistoryParser();
    const d = [...p3.feed(rec("msg_S", { type: "text", text: "You've hit your session limit · resets 11am" }, "stop_sequence", "<synthetic>")), ...p3.flush()];
    expect(d.map(label)).toEqual(["session.start", "error", "session.end(error)"]);
    expect(d[1]!.ev).toMatchObject({ t: "error", message: "You've hit your session limit · resets 11am" });
    expect(d[2]!.ev).toMatchObject({ t: "session.end", status: "error", summary: "You've hit your session limit · resets 11am" });
    // refusal ends the turn as an error; max_tokens does not end it (Claude Code continues the message)
    const p4 = createClaudeHistoryParser();
    expect([...p4.feed(rec("msg_R", { type: "text", text: "no" }, "refusal")), ...p4.flush()].map(label)).toEqual(["session.start", "message.delta(assistant)", "usage", "session.end(error)"]);
    const p5 = createClaudeHistoryParser();
    expect([...p5.feed(rec("msg_M", { type: "text", text: "long" }, "max_tokens")), ...p5.flush()].map(label)).toEqual(["session.start", "message.delta(assistant)", "usage"]);
  });

  test("records without origin / promptSource: plain text is the person's, tagged local-command bookkeeping is not", () => {
    const user = (content: string) => JSON.stringify({ type: "user", entrypoint: "cli", timestamp: "2026-09-06T13:00:00.000Z", message: { role: "user", content } });
    const p = createClaudeHistoryParser();
    expect(p.feed(user("<bash-input>gh pr list</bash-input>"))).toEqual([]);
    expect(p.feed(user("<bash-stdout>…</bash-stdout><bash-stderr></bash-stderr>"))).toEqual([]);
    expect(p.feed(user("<command-message>x</command-message>\n<command-name>/issue-workflow</command-name>"))).toEqual([]);
    expect(p.feed(user("<local-command-stdout>ok</local-command-stdout>"))).toEqual([]);
    expect(p.feed(user("/compact まとめて")).map(label)).toEqual(["session.start", "message.delta(user)"]);
    // with the fields present they decide, whatever the text looks like
    expect(p.feed(JSON.stringify({ type: "user", entrypoint: "cli", promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: "plain" } }))).toEqual([]);
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("flush() closes a turn that ended the file with end_turn, and only once", () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const p = createClaudeHistoryParser();
    const out: TimedEvent[] = [];
    for (const l of FIXTURE.slice(0, 10)) out.push(...p.feed(l)); // …up to msg_C (end_turn)
    expect(out.filter((e) => e.ev.t === "session.end")).toHaveLength(0);
    expect(hasPendingEnd(serializeHistoryState(p.state))).toBe(true);
    const flushed = p.flush();
    expect(flushed.map(label)).toEqual(["session.end(ok)"]);
    expect(hasPendingEnd(serializeHistoryState(p.state))).toBe(false);
    expect(hasPendingEnd("garbage")).toBe(false);
    expect(p.flush()).toEqual([]);
    // the next record after the flush does not end the turn a second time
    const more = p.feed(FIXTURE[11]!); // system/turn_duration
    expect(more).toEqual([]);
  });

  test("garbage lines and non-cli records are skipped; helpers", () => {
    const p = createClaudeHistoryParser();
    expect(p.feed("not json")).toEqual([]);
    expect(p.feed("")).toEqual([]);
    expect(p.feed(JSON.stringify({ type: "user", entrypoint: "sdk-cli", message: { role: "user", content: "x" } }))).toEqual([]);
    expect(isTerminalRecord({ entrypoint: "cli" })).toBe(true);
    expect(isTerminalRecord({ entrypoint: "sdk-cli" })).toBe(false);
    expect(isTerminalRecord(null)).toBe(false);
    expect(claudeProjectDirName("/home/user/work/my_repo")).toBe("-home-user-work-my-repo");
    expect(claudeProjectDirName("/private/tmp/claude-501/-a/b_c.d")).toBe("-private-tmp-claude-501--a-b-c-d");
  });
});


test.skipIf(skipRecordings("packages/adapters/claude/fixtures/teleport-session.jsonl", "packages/adapters/claude/fixtures/terminal-session.jsonl"))("Teleport remoteSourced cli records preserve full terminal history and incremental deduplication", () => {
    assertRecordings("packages/adapters/claude/fixtures/teleport-session.jsonl", "packages/adapters/claude/fixtures/terminal-session.jsonl");
  const lines = recordingText("packages/adapters/claude/fixtures/teleport-session.jsonl").trim().split("\n");
  expect(replay(lines).events).toEqual(replay(FIXTURE).events);
  const parser = createClaudeHistoryParser(); const events: TimedEvent[] = [];
  const midpoint = Math.floor(lines.length / 2);
  for (const line of lines.slice(0, midpoint)) events.push(...parser.feed(line));
  const restored = createClaudeHistoryParser(serializeHistoryState(parser.state));
  for (const line of lines.slice(midpoint)) events.push(...restored.feed(line));
  events.push(...restored.flush());
  expect(events).toEqual(replay(lines).events);
});
