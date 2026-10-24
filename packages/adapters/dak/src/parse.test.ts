import { recordingText, skipRecordings, assertRecordings } from "../../../../scripts/recordings.ts";
import { describe, expect, spyOn, test } from "bun:test";
import { AgentEvent, type RunnerSession } from "@switchboard/protocol";
import { confirmationMessage, createDakParserState, createSseParser, endOfStream, kindOf, mapAdkEvent } from "./parse.ts";

async function replay(name: string) {
  const raw = recordingText(`packages/adapters/dak/fixtures/${name}.sse`);
  const sse = createSseParser();
  const state = createDakParserState();
  const events: AgentEvent[] = [];
  for (const data of [...sse.feed(raw), ...sse.flush()]) events.push(...mapAdkEvent(JSON.parse(data), state));
  events.push(...endOfStream(state));
  return { events, state };
}
const text = (evs: AgentEvent[]) => evs.filter((e) => e.t === "message.delta" && e.role === "assistant").map((e) => (e.t === "message.delta" ? e.text : "")).join("");

describe("ADK /run_sse → AgentEvent (recorded against DAK @ e966c05, google-adk 2.x)", () => {
  test("SSE framing: data lines per blank-line-separated event, CRLF tolerated, multi-line data joined", () => {
    const p = createSseParser();
    expect(p.feed('data: {"a":1}\n\ndata: {"b":\ndata: 2}\r\n\r\n')).toEqual(['{"a":1}', '{"b":\n2}']);
    expect(p.feed('data: {"c"')).toEqual([]);
    expect(p.feed(':3}\n\n')).toEqual(['{"c":3}']);
    expect(p.flush()).toEqual([]);
  });

  test.skipIf(skipRecordings("packages/adapters/dak/fixtures/text-reply.sse"))("text reply: thoughts become status, streamed deltas win over the final full text, usage per model call and summed", async () => {
    assertRecordings("packages/adapters/dak/fixtures/text-reply.sse");
    const { events } = await replay("text-reply");
    for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
    expect(text(events)).toBe("pong");
    expect(events.filter((e) => e.t === "status" && e.text === "thinking").length).toBeGreaterThan(0);
    expect(events.some((e) => e.t === "message.delta" && e.text.includes("The user wants"))).toBe(false); // thoughts are not shown
    const turn = events.filter((e) => e.t === "usage" && e.source === "turn");
    expect(turn).toHaveLength(1);
    if (turn[0]?.t !== "usage") throw new Error();
    expect(turn[0]).toMatchObject({ model: "qwen3.8-27b-gsq-rco-iq3_xxs", inputTokens: 808 - 791, cacheReadTokens: 791, outputTokens: 34 + 29 });
    const reported = events.filter((e) => e.t === "usage" && e.source === "reported");
    expect(reported).toHaveLength(1);
    if (reported[0]?.t !== "usage") throw new Error();
    expect(reported[0].costUsd).toBeUndefined();
    const end = events.at(-1);
    expect(end).toMatchObject({ t: "session.end", status: "ok", summary: "pong" });
  });

  test.skipIf(skipRecordings("packages/adapters/dak/fixtures/tool-calls.sse"))("tool calls: functionCall → tool.call, functionResponse → tool.result, MCP content extracted; several model calls sum into one reported usage", async () => {
    assertRecordings("packages/adapters/dak/fixtures/tool-calls.sse");
    const { events } = await replay("tool-calls");
    for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
    const calls = events.filter((e) => e.t === "tool.call");
    expect(calls.map((c) => (c.t === "tool.call" ? c.name : ""))).toEqual(["list_skills", "enable_skill", "list_files"]);
    const results = events.filter((e) => e.t === "tool.result");
    expect(results).toHaveLength(3);
    if (results[2]?.t !== "tool.result") throw new Error();
    expect(results[2].ok).toBe(true);
    expect(results[2].summary).toContain("docker-compose.yml");
    expect(results[2].id).toBe((calls[2] as { id: string }).id);
    const turns = events.filter((e) => e.t === "usage" && e.source === "turn");
    expect(turns.length).toBeGreaterThanOrEqual(3);
    const reported = events.filter((e) => e.t === "usage" && e.source === "reported");
    expect(reported).toHaveLength(1);
    if (reported[0]?.t !== "usage") throw new Error();
    expect(reported[0].outputTokens).toBe(turns.reduce((a, u) => a + (u.t === "usage" ? u.outputTokens : 0), 0));
    expect(text(events).length).toBeGreaterThan(10);
    expect(events.at(-1)?.t).toBe("session.end");
  });

  test.skipIf(skipRecordings("packages/adapters/dak/fixtures/attachment-image.sse"))("a turn with an image attachment (#124): DAK answers about it; nothing is an artifact (recorded against ADK with DAK's fake LLM, which received the image as image_url)", async () => {
    assertRecordings("packages/adapters/dak/fixtures/attachment-image.sse");
    const { events } = await replay("attachment-image");
    for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
    expect(text(events)).toBe("The image is a small solid red square.");
    expect(events.some((e) => e.t === "artifact")).toBe(false);
    expect(events.at(-1)).toMatchObject({ t: "session.end", status: "ok" });
  });

  test.skipIf(skipRecordings("packages/adapters/dak/fixtures/artifact-spill.sse"))("a long tool output (#124): DAK saves it as a tool_output_* artifact, which is DAK's own spill, so no file is fetched or made", async () => {
    assertRecordings("packages/adapters/dak/fixtures/artifact-spill.sse");
    const { events } = await replay("artifact-spill");
    for (const ev of events) expect(() => AgentEvent.parse(ev)).not.toThrow();
    expect(events.filter((e) => e.t === "tool.call").map((e) => (e.t === "tool.call" ? e.name : ""))).toEqual(["read_original_request"]);
    expect(text(events)).toBe("I read the request back.");
    // the real event that names the artifact: collectArtifacts takes nothing from it (a fetch to this closed port would show up as an error entry)
    const raw = recordingText("packages/adapters/dak/fixtures/artifact-spill.sse");
    const sse = createSseParser();
    const named = [...sse.feed(raw), ...sse.flush()].map((d) => JSON.parse(d)).filter((ev) => Object.keys(ev.actions?.artifactDelta ?? {}).length > 0);
    expect(named).toHaveLength(1);
    expect(Object.keys(named[0].actions.artifactDelta)[0]).toStartWith("tool_output_");
    expect(await collectArtifacts(named[0], { sessionUrl: "http://127.0.0.1:9/apps/dak_agent/users/switchboard/sessions/x", attachmentDir: "/nonexistent-dir-for-the-test", timeoutMs: 500 })).toEqual([]);
  });

  test("confirmations: DAK's adk_request_confirmation and ADK-native requestedToolConfirmations both become permission.ask, never tool.call", () => {
    const s = createDakParserState();
    const dak = mapAdkEvent({ invocationId: "inv1", content: { parts: [{ functionCall: { id: "fc_1", name: "adk_request_confirmation", args: { originalFunctionCall: { id: "orig_1", name: "send_sol_payment", args: { to: "addr", amount: 0.01 } } } } }] }, partial: false }, s);
    expect(dak).toEqual([{ t: "permission.ask", id: "fc_1", kind: "write", tool: "send_sol_payment", input: { to: "addr", amount: 0.01 }, detail: "send_sol_payment(to=addr, …)", toolUseId: "orig_1" }]);
    const native = mapAdkEvent({ invocationId: "inv2", content: { parts: [{ functionCall: { id: "fc_2", name: "run_shell", args: { cmd: "ls" } } }] }, actions: { requestedToolConfirmations: { fc_2: { hint: "Run ls?", confirmed: null, payload: {} } } }, partial: false }, s);
    expect(native).toEqual([{ t: "permission.ask", id: "fc_2", kind: "exec", tool: "run_shell", input: { cmd: "ls" }, detail: "Run ls?", toolUseId: "fc_2" }]);
    expect(s.confirmations.size).toBe(2);
    // the echoed functionResponse for our own answer is not a tool result
    expect(mapAdkEvent({ content: { parts: [{ functionResponse: { id: "fc_1", name: "adk_request_confirmation", response: { confirmed: true } } }] } }, s)).toEqual([]);
    // a failed tool
    expect(mapAdkEvent({ content: { parts: [{ functionResponse: { id: "x", name: "t", response: { error: "boom" } } }] } }, s)).toEqual([{ t: "tool.result", id: "x", ok: false, summary: "boom" }]);
    // an ADK error event ends in error
    expect(mapAdkEvent({ errorCode: "MALFORMED", errorMessage: "bad" }, s)).toEqual([{ t: "error", message: "MALFORMED: bad" }]);
    expect(endOfStream(s).at(-1)).toMatchObject({ t: "session.end", status: "error", summary: "MALFORMED: bad" });
  });

  test("outbound: confirmation answers follow DAK's CLI shape; kinds are guessed from tool names", () => {
    expect(confirmationMessage("dak_agent", "sb", "s1", "fc_1", true, "inv1")).toEqual({ app_name: "dak_agent", user_id: "sb", session_id: "s1", invocation_id: "inv1", new_message: { role: "user", parts: [{ functionResponse: { id: "fc_1", name: "adk_request_confirmation", response: { confirmed: true } } }] }, streaming: true });
    expect(kindOf("run_shell_command")).toBe("exec");
    expect(kindOf("write_file")).toBe("write");
    expect(kindOf("web_search")).toBe("network");
    expect(kindOf("list_files")).toBe("other");
  });
});

/* ---------- session tests against fixtures/fake-adk.ts ---------- */

import type { Attachment, StartOptions } from "@switchboard/protocol";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_PNG, FAKE_REPORT, startFakeAdk } from "../fixtures/fake-adk.ts";
import { collectArtifacts } from "./artifacts.ts";
import { createDakAdapter } from "./index.ts";

function collect() {
  const events: AgentEvent[] = [];
  const waitFor = (pred: () => boolean, ms = 20_000) =>
    new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pred()) {
          clearInterval(iv);
          res();
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error("timeout: " + events.map((e) => e.t).join(",")));
        }
      }, 20);
    });
  return { events, waitFor, ends: () => events.filter((e) => e.t === "session.end") };
}

describe("DakSession over HTTP/SSE (fake ADK server)", () => {
  const fake = startFakeAdk();
  const adapter = () => createDakAdapter({ baseUrl: fake.url });
  const opts = (prompt: string): StartOptions => ({ cwd: "/tmp", scope: ["/tmp"], prompt });

  test("detect: reachable server with the app → available; unreachable → note with the compose hint", async () => {
    expect(await adapter().detect()).toMatchObject({ available: true, path: fake.url });
    expect((await createDakAdapter({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }).detect()).note).toContain("docker compose up");
  });

  test("an explicitly undefined option (e.g. an unset env var passed straight through) does not shadow the default", async () => {
    // createDakAdapter({ baseUrl: process.env.SWITCHBOARD_DAK_URL }) with the var unset must still hit 127.0.0.1:8000,
    // not `${undefined}/list-apps`. Regression: plain object spread keeps a key whose value is `undefined`.
    // `app` is set to a name nothing serves so the assertion holds even if something real happens to be listening
    // on the default port in this environment.
    const d = createDakAdapter({ baseUrl: undefined, app: "definitely-not-a-real-app-xyz", timeoutMs: 500 });
    const r = await d.detect();
    expect(r.available).toBe(false);
    expect(r.note).not.toContain("undefined");
    expect(r.note).toContain("127.0.0.1:8000");
  });

  test("a turn: session created, session.start, streamed text, usage reported, session.end; a follow-up is a second turn on the same session", async () => {
    const c = collect();
    const s = adapter().start(opts("hello"), (e) => c.events.push(e));
    await c.waitFor(() => c.ends().length === 1);
    const start = c.events.find((e) => e.t === "session.start");
    expect(start).toMatchObject({ runner: "dak", runnerSessionId: "sess-1", cwd: "/tmp" });
    expect(text(c.events)).toBe("echo:hello");
    expect(c.events.filter((e) => e.t === "usage" && e.source === "reported")).toHaveLength(1);
    s.send("again");
    await c.waitFor(() => c.ends().length === 2);
    expect(text(c.events)).toBe("echo:helloecho:again");
    expect(c.events.filter((e) => e.t === "session.start")).toHaveLength(1);
    await s.close();
    expect(await s.exited).toBe(0);
  });

  test("attachments: images and other binaries go as inline_data, text files as a named text part, on the first turn and on send()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dak-att-"));
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(join(dir, "a.png"), png);
    writeFileSync(join(dir, "a.json"), '{"k":1}');
    writeFileSync(join(dir, "a.yaml"), "k: 1\n");
    const att = (name: string, mime: string): Attachment => ({ id: `att-${name}`, taskId: "t", name, mime, size: 1, path: join(dir, name), createdAt: 0 });
    const c = collect();
    const s = adapter().start({ ...opts("look"), attachments: [att("a.json", "application/json"), att("a.yaml", "application/yaml"), att("a.png", "image/png")] }, (e) => c.events.push(e));
    await c.waitFor(() => c.ends().length === 1);
    const sid = c.events.find((e) => e.t === "session.start")?.runnerSessionId;
    const mine = () => fake.received.filter((r) => r.session_id === sid);
    expect(mine()[0]!.parts).toEqual([{ text: "look" }, { text: '--- a.json ---\n{"k":1}' }, { text: "--- a.yaml ---\nk: 1\n" }, { inline_data: { mime_type: "image/png", data: png.toString("base64") } }]);
    s.send("next", [att("a.png", "image/png")]);
    await c.waitFor(() => c.ends().length === 2);
    expect(mine()[1]!.parts).toEqual([{ text: "next" }, { inline_data: { mime_type: "image/png", data: png.toString("base64") } }]);
    s.send("plain");
    await c.waitFor(() => c.ends().length === 3);
    expect(mine()[2]!.parts).toEqual([{ text: "plain" }]);
    // a file that cannot be read refuses the turn before anything is said or sent
    const said = c.events.length;
    expect(() => s.send("gone", [att("missing.png", "image/png")])).toThrow();
    expect(c.events.length).toBe(said);
    expect(mine()).toHaveLength(3);
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("artifact: an inlineData part and an artifactDelta are saved into attachmentDir (never over a file there) and emitted as artifact(file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dak-art-"));
    writeFileSync(join(dir, "report.txt"), "the person's own upload");
    const c = collect();
    const s = adapter().start({ ...opts("artifact please"), attachmentDir: dir }, (e) => c.events.push(e));
    await c.waitFor(() => c.ends().length === 1);
    const arts = c.events.filter((e) => e.t === "artifact");
    expect(arts).toEqual([
      { t: "artifact", kind: "file", path: join(dir, "inline.png") },
      { t: "artifact", kind: "file", path: join(dir, "report-2.txt") },
    ]);
    expect(new Uint8Array(readFileSync(join(dir, "inline.png")))).toEqual(FAKE_PNG);
    expect(readFileSync(join(dir, "report-2.txt"), "utf8")).toBe(FAKE_REPORT);
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toBe("the person's own upload");
    // the files are on disk before the turn ends; the reply's text is still the reply
    expect(c.events.findIndex((e) => e.t === "artifact")).toBeLessThan(c.events.findIndex((e) => e.t === "session.end"));
    expect(text(c.events)).toBe("made two files");
    // a second turn names the same files again: new names, nothing overwritten
    s.send("artifact again");
    await c.waitFor(() => c.ends().length === 2);
    expect(c.events.filter((e) => e.t === "artifact").slice(2).map((e) => (e.t === "artifact" ? e.path : ""))).toEqual([join(dir, "inline-2.png"), join(dir, "report-3.txt")]);
    await s.close();
    // without an attachment directory nothing is written or emitted
    const c2 = collect();
    const s2 = adapter().start(opts("artifact please"), (e) => c2.events.push(e));
    await c2.waitFor(() => c2.ends().length === 1);
    expect(c2.events.filter((e) => e.t === "artifact")).toHaveLength(0);
    await s2.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000); // three HTTP turns under a loaded full suite: over the 5 s default (docs/design/perf.md "テストの揺れ")

  test("artifact: one that cannot be fetched is an error entry and the others still come; a name cannot leave the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dak-art-"));
    const c = collect();
    const s = adapter().start(opts("hello"), (e) => c.events.push(e));
    await c.waitFor(() => c.ends().length === 1);
    const sid = c.events.find((e) => e.t === "session.start")?.runnerSessionId;
    const out = await collectArtifacts(
      { actions: { artifactDelta: { "missing.txt": 1, "../../escape.txt": 1, "user:notes.md": 1 } } },
      { sessionUrl: `${fake.url}/apps/dak_agent/users/switchboard/sessions/${sid}`, attachmentDir: dir, timeoutMs: 2000 },
    );
    expect(out).toEqual([{ error: "missing.txt: HTTP 404" }, { path: join(dir, "escape.txt") }, { path: join(dir, "notes.md") }]);
    // DAK's own spill of a long tool output is not a file for the person: not fetched, not an error, the others still come
    expect(await collectArtifacts({ actions: { artifactDelta: { "tool_output_fs.read_call_1.txt": 0, "report.txt": 1 } } }, { sessionUrl: `${fake.url}/apps/dak_agent/users/switchboard/sessions/${sid}`, attachmentDir: dir, timeoutMs: 2000 })).toEqual([{ path: join(dir, "report.txt") }]);
    // a directory that cannot be written: each file is an error entry, inline parts and fetched artifacts alike
    const notADir = join(dir, "a-file");
    writeFileSync(notADir, "");
    const failed = await collectArtifacts(
      { content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw==" } }] }, actions: { artifactDelta: { "report.txt": 1 } } },
      { sessionUrl: `${fake.url}/apps/dak_agent/users/switchboard/sessions/${sid}`, attachmentDir: notADir, timeoutMs: 2000 },
    );
    expect(failed).toHaveLength(2);
    expect(failed.map((f) => ("error" in f ? f.error.split(":")[0] : f.path))).toEqual(["inline.png", "report.txt"]);
    // the turn's abort stops a fetch in flight
    const aborted = new AbortController();
    aborted.abort();
    expect(await collectArtifacts({ actions: { artifactDelta: { "report.txt": 1 } } }, { sessionUrl: `${fake.url}/apps/dak_agent/users/switchboard/sessions/${sid}`, attachmentDir: dir, timeoutMs: 2000, signal: aborted.signal })).toEqual([
      { error: expect.stringContaining("report.txt: ") },
    ]);
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("confirmation round trip: the stream ends with the ask open (no session.end), the answer runs the tool and ends the turn", async () => {
    const c = collect();
    const s = adapter().start(opts("confirm please"), (e) => c.events.push(e));
    await c.waitFor(() => c.events.some((e) => e.t === "permission.ask"));
    await new Promise((r) => setTimeout(r, 100));
    expect(c.ends()).toHaveLength(0);
    const ask = c.events.find((e) => e.t === "permission.ask");
    if (ask?.t !== "permission.ask") throw new Error();
    expect(ask).toMatchObject({ id: "fc-1", tool: "delete_file", kind: "write", toolUseId: "orig-1" });
    expect(() => s.respondPermission("nope", "allow")).toThrow(/no pending/);
    s.respondPermission(ask.id, "allow");
    await c.waitFor(() => c.ends().length === 1);
    expect(c.events.find((e) => e.t === "permission.resolved")).toMatchObject({ id: "fc-1", decision: "allow", by: "user" });
    expect(c.events.find((e) => e.t === "tool.result")).toMatchObject({ id: "orig-1", ok: true, summary: "deleted" });
    expect(c.ends()[0]).toMatchObject({ status: "ok", summary: "done" });
    // deny path
    s.send("confirm again");
    await c.waitFor(() => c.events.filter((e) => e.t === "permission.ask").length === 2);
    const ask2 = c.events.filter((e) => e.t === "permission.ask").at(-1);
    if (ask2?.t !== "permission.ask") throw new Error();
    s.respondPermission(ask2.id, "deny");
    await c.waitFor(() => c.ends().length === 2);
    expect(c.events.filter((e) => e.t === "tool.result").at(-1)).toMatchObject({ ok: false });
    await s.close();
  });

  test("a confirmation answered while its own ask is still being read (controller still set) is sent as a real functionResponse, not re-wrapped as text", async () => {
    // Regression: respondPermission() used to push JSON.stringify(confirmationMessage(...)) onto a queue that the
    // turn consumer always re-wrapped with userMessage(), sending the confirmation's JSON as literal chat text.
    // The ask always arrives right before the stream closes, so answering it synchronously from inside the emit
    // callback — before the outer read loop notices `done` and clears `controller` — reliably takes that branch.
    const c = collect();
    let answered = false;
    let s!: RunnerSession;
    s = adapter().start(opts("confirm now"), (e) => {
      c.events.push(e);
      if (e.t === "permission.ask" && !answered) {
        answered = true;
        s.respondPermission(e.id, "allow");
      }
    });
    await c.waitFor(() => c.ends().length === 1);
    expect(c.events.find((e) => e.t === "tool.result")).toMatchObject({ ok: true, summary: "deleted" });
    expect(text(c.events)).toBe("done");
    await s.close();
  });

  test("a stream that errors while a confirmation is open resolves the ask as denied instead of leaving it stuck", async () => {
    const c = collect();
    const s = adapter().start(opts("confirm-fail"), (e) => c.events.push(e));
    await c.waitFor(() => c.ends().length === 1);
    expect(c.events.find((e) => e.t === "permission.ask")).toBeDefined();
    expect(c.events.find((e) => e.t === "permission.resolved")).toMatchObject({ decision: "deny", by: "timeout" });
    expect(c.ends()[0]).toMatchObject({ status: "error" });
    // the ask is gone: answering it now is a programming error, not a hang
    const ask = c.events.find((e) => e.t === "permission.ask");
    if (ask?.t !== "permission.ask") throw new Error();
    expect(() => s.respondPermission(ask.id, "allow")).toThrow(/no pending/);
    await s.close();
  });

  test("a reply after a tool call in the same turn is not suppressed by an earlier reply having already streamed", async () => {
    const c = collect();
    const s = adapter().start(opts("multi"), (e) => c.events.push(e));
    await c.waitFor(() => c.ends().length === 1);
    // both segments must show up, in order, undoubled
    expect(text(c.events)).toBe("firstsecond");
    expect(c.events.filter((e) => e.t === "tool.call")).toHaveLength(1);
    await s.close();
  });

  test("run_sse fetch replaces Bun's default timeout with a long idle timeout (a silent turn must not be cut)", async () => {
    // A local LLM writing a long tool call streams nothing for minutes (ADK emits no partial events for function-call
    // arguments). Bun's default fetch timeout (360 s) cut those turns with "The operation timed out.", ADK then
    // cancelled the turn, and every retry replayed the same prompt into the same cut (#121).
    const seen: Array<{ url: string; init?: RequestInit & { timeout?: unknown } }> = [];
    const real = globalThis.fetch;
    const spy = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return real(input, init);
    }) as typeof fetch);
    try {
      for (const [options, expected] of [[{}, 2 * 60 * 60_000], [{ streamIdleTimeoutMs: 1234 }, 1234]] as const) {
        seen.length = 0;
        const c = collect();
        const s = createDakAdapter({ baseUrl: fake.url, ...options }).start(opts("hi"), (e) => c.events.push(e));
        await c.waitFor(() => c.ends().length === 1);
        const run = seen.find((x) => x.url.endsWith("/run_sse"));
        expect(run?.init?.timeout).toBe(expected);
        expect(run?.init?.signal).toBeInstanceOf(AbortSignal);
        await s.close();
      }
    } finally {
      spy.mockRestore();
    }
  });

  test("a DAK side that goes silent without closing ends the turn after the idle timeout; a hung session endpoint fails after timeoutMs", async () => {
    // Dead peer (paused container, sleeping host): headers and one event arrive, then nothing, and the socket stays
    // open. The turn must end in error rather than stay running forever with every send() queued behind it.
    // Bun checks fetch idle timeouts on a coarse tick: any value up to a few seconds fires after ~8 s (measured on
    // Bun 1.4.2 for 300 / 1000 / 2000 ms), hence the long waits here.
    const silent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/sessions") && req.method === "POST") {
          if (url.pathname.includes("/users/hang/")) return new Promise<Response>(() => {});
          return Response.json({ id: "s-silent" });
        }
        if (url.pathname === "/run_sse") {
          const first = new TextEncoder().encode(`data: ${JSON.stringify({ invocationId: "e-1", author: "dak_agent", content: { parts: [{ text: "th", thought: true }] }, partial: true })}\n\n`);
          return new Response(new ReadableStream({ start: (ctl) => ctl.enqueue(first) }), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const base = `http://127.0.0.1:${silent.port}`;
      const c = collect();
      const t0 = Date.now();
      const s = createDakAdapter({ baseUrl: base, streamIdleTimeoutMs: 300 }).start(opts("hi"), (e) => c.events.push(e));
      await c.waitFor(() => c.ends().length === 1, 20_000);
      expect(c.ends()[0]).toMatchObject({ status: "error" });
      expect(c.events.find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("/run_sse failed") });
      expect(Date.now() - t0).toBeLessThan(20_000);
      await s.close();

      const c2 = collect();
      const s2 = createDakAdapter({ baseUrl: base, user: "hang", timeoutMs: 300 }).start(opts("hi"), (e) => c2.events.push(e));
      await c2.waitFor(() => c2.events.some((e) => e.t === "error"), 5_000);
      expect(c2.events.find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("DAK session failed") });
      await s2.close();
    } finally {
      silent.stop(true);
    }
  }, 30_000);

  test("abort during a stream → session.end(aborted) once; a resume of an unknown session starts a new one and says so; an ADK error ends in error", async () => {
    const c = collect();
    const s = adapter().start(opts("sleep"), (e) => c.events.push(e));
    await c.waitFor(() => c.events.some((e) => e.t === "message.delta" && e.role === "assistant"));
    await s.abort();
    expect(c.ends().map((e) => (e.t === "session.end" ? e.status : ""))).toEqual(["aborted"]);
    expect(await s.exited).toBeNull();

    const c2 = collect();
    const s2 = adapter().start({ ...opts("hi"), resumeSessionId: "sess-nope" }, (e) => c2.events.push(e));
    await c2.waitFor(() => c2.ends().length === 1);
    expect(c2.events.find((e) => e.t === "status")).toMatchObject({ text: expect.stringContaining("新しいセッションで続けます") });
    const started = c2.events.find((e) => e.t === "session.start");
    expect(started && started.t === "session.start" && started.runnerSessionId !== "sess-nope" && !!started.runnerSessionId).toBe(true);
    expect(c2.ends()[0]).toMatchObject({ status: "ok" });
    expect(c2.events.some((e) => e.t === "error")).toBe(false);
    await s2.close();

    const c3 = collect();
    const s3 = adapter().start(opts("fail now"), (e) => c3.events.push(e));
    await c3.waitFor(() => c3.ends().length === 1);
    expect(c3.ends()[0]).toMatchObject({ status: "error" });
    await s3.close();
    fake.stop();
  });
});
