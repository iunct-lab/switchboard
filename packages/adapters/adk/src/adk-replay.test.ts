// test-reads: packages/adapters/adk/src/parse.ts
import { recordingText, skipRecordings, assertRecordings } from "../../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { AgentEvent } from "@switchboard/protocol";
import { createAdkParserState, createSseParser, endOfStream, mapAdkEvent, type AdkParserState } from "./parse.ts";

/**
 * Recorded against an ADK server that is not DAK: `adk api_server` (google-adk 2.13.0, 2026-11-04) serving a sample agent
 * whose model is scripted (no key). Its tools: delete_file = FunctionTool(require_confirmation=True) (ADK's native
 * confirmation), deploy = a tool that calls tool_context.request_confirmation() itself, write_report = save_artifact.
 * How to record them again: docs/design/custom-adapter.md, "Recording it again".
 */
const file = (name: string) => `packages/adapters/adk/fixtures/adk-2.13.0-${name}.sse`;
function replay(name: string, state: AdkParserState = createAdkParserState()) {
  const sse = createSseParser();
  const events: AgentEvent[] = [];
  for (const data of [...sse.feed(recordingText(file(name))), ...sse.flush()]) events.push(...mapAdkEvent(JSON.parse(data), state));
  return { events, state };
}
const text = (evs: AgentEvent[]) => evs.filter((e) => e.t === "message.delta" && e.role === "assistant").map((e) => (e.t === "message.delta" ? e.text : "")).join("");

describe("ADK /run_sse → AgentEvent (recorded against adk api_server, google-adk 2.13.0, not DAK)", () => {
  test.skipIf(skipRecordings(file("text")))("text reply: streamed deltas, one usage per model call, session.end with the text", () => {
    assertRecordings(file("text"));
    const { events, state } = replay("text");
    events.push(...endOfStream(state));
    for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
    expect(text(events)).toBe("echo:hello there");
    expect(events.filter((e) => e.t === "usage" && e.source === "turn")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "session.end", status: "ok", summary: "echo:hello there" });
  });

  // ADK asks once in both forms: an adk_request_confirmation call about the tool's call, then the tool's response with
  // requestedToolConfirmations keyed on the tool's call id. One ask, on the adk_request_confirmation call's id.
  for (const [name, tool] of [
    ["native", "delete_file"],
    ["ask", "deploy"],
  ] as const) {
    test.skipIf(skipRecordings(file(name)))(`${name === "native" ? "require_confirmation=True" : "request_confirmation()"}: one ask with the tool's name, on the adk_request_confirmation call`, () => {
      assertRecordings(file(name));
      const raw = recordingText(file(name));
      expect(raw).toContain('"requestedToolConfirmations":{"adk-'); // the recording does hold the second form
      const { events } = replay(name);
      for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
      const asks = events.filter((e) => e.t === "permission.ask");
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ t: "permission.ask", tool });
      const confirmationCall = /"id":"([^"]+)","args":\{"originalFunctionCall"/.exec(raw)?.[1];
      expect(asks[0]?.t === "permission.ask" ? asks[0].id : "").toBe(confirmationCall ?? "missing");
    });
  }

  test.skipIf(skipRecordings(file("native"), file("native-allow")))("native confirmation allowed: the tool runs and the reply follows", () => {
    assertRecordings(file("native"), file("native-allow"));
    const { state } = replay("native");
    const { events } = replay("native-allow", state);
    expect(events.filter((e) => e.t === "tool.result")).toEqual([expect.objectContaining({ ok: true })]);
    expect(text(events)).toContain("deleted");
  });

  test.skipIf(skipRecordings(file("ask"), file("ask-deny")))("request_confirmation() denied: the tool's own error comes back as a failed result", () => {
    assertRecordings(file("ask"), file("ask-deny"));
    const { state } = replay("ask");
    const { events } = replay("ask-deny", state);
    expect(events.filter((e) => e.t === "tool.result")).toEqual([expect.objectContaining({ ok: false })]);
    expect(text(events)).toContain("the person declined");
  });

  test.skipIf(skipRecordings(file("artifact")))("save_artifact: the event names the artifact at version 0", () => {
    assertRecordings(file("artifact"));
    const raw = recordingText(file("artifact"));
    const deltas = [...raw.matchAll(/"artifactDelta":(\{[^}]*\})/g)].map((m) => JSON.parse(m[1]!) as Record<string, number>).filter((d) => Object.keys(d).length);
    expect(deltas).toEqual([{ "report.txt": 0 }]);
    const { events } = replay("artifact");
    expect(text(events)).toContain('"saved": "report.txt"');
  });
});
