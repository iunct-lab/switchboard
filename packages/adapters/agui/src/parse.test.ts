// test-reads: packages/adapters/agui/src/parse.ts
import { recordingText, skipRecordings, assertRecordings } from "../../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { AgentEvent } from "@switchboard/protocol";
import { createAguiState, createSseParser, mapAguiEvent, type AguiState } from "./parse.ts";

/** Recorded against ag-ui-protocol 1.0.0 with a scripted model (docs/design/custom-adapter.md, "What the AG-UI recordings showed"). */
const file = (name: string) => `packages/adapters/agui/fixtures/agui-1.0.0-${name}.sse`;
function replay(name: string, state: AguiState = createAguiState()) {
  const sse = createSseParser();
  const events: AgentEvent[] = [];
  for (const data of [...sse.feed(recordingText(file(name))), ...sse.flush()]) events.push(...mapAguiEvent(state, JSON.parse(data)));
  for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
  return { events, state };
}
const text = (evs: AgentEvent[]) => evs.map((e) => (e.t === "message.delta" ? e.text : "")).join("");

describe("AG-UI SSE → AgentEvent (recorded, ag-ui-protocol 1.0.0)", () => {
  test.skipIf(skipRecordings(file("text")))("text: deltas in order, one usage with cached tokens split out", () => {
    assertRecordings(file("text"));
    const { events } = replay("text");
    expect(text(events)).toBe("Hello from the fake model.");
    expect(events.filter((e) => e.t === "usage")).toEqual([{ t: "usage", source: "reported", model: "scripted-1", inputTokens: 9, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 }]);
  });

  test.skipIf(skipRecordings(file("tool")))("tool: arguments joined at END, result ok / failed by metadata.isError", () => {
    assertRecordings(file("tool"));
    const { events } = replay("tool");
    expect(events.filter((e) => e.t === "tool.call").map((e) => (e.t === "tool.call" ? [e.id, e.name, e.input] : []))).toEqual([
      ["tc1", "read_file", { path: "a.txt" }],
      ["tc2", "read_file", { path: "missing.txt" }],
    ]);
    expect(events.filter((e) => e.t === "tool.result")).toEqual([
      expect.objectContaining({ id: "tc1", ok: true, summary: "file contents" }),
      expect.objectContaining({ id: "tc2", ok: false }),
    ]);
    expect(text(events)).toBe("Checking.Done.");
  });

  test.skipIf(skipRecordings(file("interrupt"), file("interrupt-resume")))("interrupt: one permission.ask naming the tool; the resumed run continues", () => {
    assertRecordings(file("interrupt"), file("interrupt-resume"));
    const { events, state } = replay("interrupt");
    const asks = events.filter((e) => e.t === "permission.ask");
    expect(asks).toEqual([{ t: "permission.ask", id: "int-1", kind: "write", tool: "delete_file", input: { path: "a.txt" }, detail: "Delete a.txt?", toolUseId: "tc9" }]);
    expect(events.filter((e) => e.t === "usage")).toHaveLength(1);
    expect(text(replay("interrupt-resume", state).events)).toBe("Approved, deleting.");
  });

  test.skipIf(skipRecordings(file("disconnect")))("disconnect: a stream cut mid-run maps what arrived and ends without a usage", () => {
    assertRecordings(file("disconnect"));
    const { events } = replay("disconnect");
    expect(text(events)).toStartWith("chunk0 chunk1 ");
    expect(events.some((e) => e.t === "usage" || e.t === "permission.ask")).toBe(false);
  });
});

describe("AG-UI mapping, synthetic", () => {
  const map = (...evs: unknown[]) => {
    const s = createAguiState();
    return evs.flatMap((e) => mapAguiEvent(s, e));
  };
  test("SSE: a CRLF split across chunks still ends each event", () => {
    const p = createSseParser();
    const got = [...p.feed('data: {"a":1}\r'), ...p.feed('\n\r'), ...p.feed('\ndata: {"b":2}\r\n\r\n'), ...p.flush()];
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("RUN_ERROR → error, with the code when given", () => {
    expect(map({ type: "RUN_ERROR", message: "boom", code: "E1" })).toEqual([{ t: "error", message: "E1: boom" }]);
    expect(map({ type: "RUN_ERROR" })).toEqual([{ t: "error", message: "AG-UI run error" }]);
  });
  test("unknown types, reasoning, and missing fields are skipped without throwing", () => {
    expect(map(null, 3, {}, { type: "NEW_THING" }, { type: "REASONING_MESSAGE_CONTENT", delta: "x" }, { type: "CUSTOM", name: "a", value: 1 }, { type: "TEXT_MESSAGE_CONTENT" }, { type: "TOOL_CALL_ARGS" }, { type: "TOOL_CALL_END", toolCallId: "nope" }, { type: "TOOL_CALL_RESULT" }, { type: "RUN_FINISHED", outcome: { type: "interrupt" }, usage: [null, "x"] })).toEqual([]);
  });
  test("TOOL_CALL_CHUNK: one tool.call, ended by the next non-chunk event, and an interrupt names it", () => {
    const evs = map(
      { type: "TOOL_CALL_CHUNK", toolCallId: "c1", toolCallName: "delete_file", delta: '{"path":' },
      { type: "TOOL_CALL_CHUNK", delta: '"a.txt"}' },
      { type: "TOOL_CALL_CHUNK", toolCallId: "c2", toolCallName: "read_file", delta: "{}" },
      { type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "i", toolCallId: "c2" }] } },
    );
    expect(evs).toEqual([
      expect.objectContaining({ t: "tool.call", id: "c1", name: "delete_file", input: { path: "a.txt" } }),
      expect.objectContaining({ t: "tool.call", id: "c2", name: "read_file", input: {} }),
      expect.objectContaining({ t: "permission.ask", id: "i", tool: "read_file", toolUseId: "c2" }),
    ]);
  });
  test("text: only assistant messages, the role read from the chunk or from TEXT_MESSAGE_START", () => {
    const evs = map(
      { type: "TEXT_MESSAGE_START", messageId: "u", role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "u", delta: "from user" },
      { type: "TEXT_MESSAGE_END", messageId: "u" },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "d", role: "developer", delta: "from developer" },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "d", delta: " still developer" },
      { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "hi" },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "b", delta: " there" },
    );
    expect(evs).toEqual([
      { t: "message.delta", role: "assistant", text: "hi", messageId: "a" },
      { t: "message.delta", role: "assistant", text: " there", messageId: "b" },
    ]);
  });
  test("usage: cached tokens above the input clamp the uncached input at 0", () => {
    expect(map({ type: "RUN_FINISHED", usage: [{ inputTokens: 2, cachedInputTokens: 5, outputTokens: 1 }] })).toEqual([{ t: "usage", source: "reported", model: undefined, inputTokens: 0, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 0 }]);
  });
  test("unparseable arguments are kept as text; an interrupt naming no known call still asks", () => {
    const evs = map({ type: "TOOL_CALL_START", toolCallId: "a", toolCallName: "x" }, { type: "TOOL_CALL_ARGS", toolCallId: "a", delta: "{bad" }, { type: "TOOL_CALL_END", toolCallId: "a" }, { type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "i", reason: "input_required" }] } });
    expect(evs[0]).toMatchObject({ t: "tool.call", input: { arguments: "{bad" } });
    expect(evs[1]).toMatchObject({ t: "permission.ask", id: "i", tool: "input_required", toolUseId: "i" });
  });
});
