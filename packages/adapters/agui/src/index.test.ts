// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import type { AgentEvent, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { AgentEvent as AgentEventSchema } from "@switchboard/protocol";
import { startFakeAgui } from "../fixtures/fake-agui.ts";
import { createAguiAdapter } from "./index.ts";

const fake = startFakeAgui();
afterAll(() => fake.stop());
const adapter = (extra: Partial<Parameters<typeof createAguiAdapter>[0]> = {}) => createAguiAdapter({ id: "custom:sample" as RunnerId, label: "Sample", baseUrl: fake.url, ...extra });
const opts = (prompt: string, extra: Partial<StartOptions> = {}): StartOptions => ({ cwd: "/tmp", scope: ["/tmp"], prompt, ...extra });

function run(start: (emit: (e: AgentEvent) => void) => RunnerSession) {
  const events: AgentEvent[] = [];
  const session = start((e) => events.push(e));
  const until = async (pred: (e: AgentEvent) => boolean, from = 0) => {
    const t0 = Date.now();
    while (!events.slice(from).some(pred)) {
      if (Date.now() - t0 > 20_000) throw new Error(`timeout: ${events.map((e) => e.t).join(",")}`);
      await Bun.sleep(10);
    }
    return events.slice(from).find(pred)!;
  };
  return { events, session, until, ended: (from = 0) => until((e) => e.t === "session.end", from) };
}
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.t === "message.delta" && e.role === "assistant" ? [e.text] : [])).join("");
const last = () => fake.received[fake.received.length - 1]!;

describe("createAguiAdapter against a fake AG-UI server", () => {
  test("a turn streams under the entry's id; every event is valid; hasSession is false", async () => {
    const a = adapter();
    const c = run((emit) => a.start(opts("hello", { model: "m-1" }), emit));
    await c.ended();
    expect(a.id).toBe("custom:sample" as RunnerId);
    expect(c.events.find((e) => e.t === "session.start")).toMatchObject({ runner: "custom:sample" });
    expect(c.events.find((e) => e.t === "session.start")).not.toHaveProperty("model");
    expect(text(c.events)).toBe("echo:hello");
    // The run's own total, booked in the ledger: reported and not cumulative
    expect(c.events.find((e) => e.t === "usage")).toMatchObject({ source: "reported", inputTokens: 9, outputTokens: 7, cacheReadTokens: 3 });
    expect(c.events.find((e) => e.t === "usage")).not.toHaveProperty("cumulative");
    expect(c.events.at(-1)).toEqual({ t: "session.end", status: "ok" });
    for (const e of c.events) expect(() => AgentEventSchema.parse(e)).not.toThrow();
    expect(a.hasSession?.("anything")).toBe(false);
    expect(last()).toMatchObject({ messages: [{ role: "user", content: "hello" }], tools: [], forwardedProps: {} });
  });

  test("a follow-up reuses the thread and sends the whole history", async () => {
    const c = run((emit) => adapter().start(opts("one"), emit));
    await c.ended();
    const first = c.events.find((e) => e.t === "session.start");
    const n = c.events.length;
    c.session.send("two");
    await c.ended(n);
    const body = last();
    expect(first).toMatchObject({ runnerSessionId: body.threadId });
    expect(body.messages.map((m: any) => [m.role, m.content])).toEqual([["user", "one"], ["assistant", "echo:one"], ["user", "two"]]);
    expect(text(c.events)).toBe("echo:oneecho:two");
  });

  test.each([
    ["allow", { approved: true }],
    ["deny", { approved: false }],
  ] as const)("an interrupt becomes a permission.ask and %s goes back in resume", async (decision, payload) => {
    const c = run((emit) => adapter().start(opts("interrupt delete"), emit));
    const ask = await c.until((e) => e.t === "permission.ask");
    expect(ask).toMatchObject({ t: "permission.ask", id: "int-1", tool: "delete_file", toolUseId: "tc9", input: { path: "a.txt" } });
    expect(c.events.some((e) => e.t === "session.end")).toBe(false);
    c.session.respondPermission("int-1", decision);
    await c.ended();
    expect(c.events).toContainEqual({ t: "permission.resolved", id: "int-1", decision, by: "user" });
    const body = last();
    expect(body.resume).toEqual([{ interruptId: "int-1", status: "resolved", payload }]);
    expect(body.threadId).toBe((c.events.find((e) => e.t === "session.start") as any).runnerSessionId);
    // The history carries the assistant's tool call, and no result for it
    expect(body.messages[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "tc9", function: { name: "delete_file", arguments: '{"path":"a.txt"}' } }] });
    expect(text(c.events)).toContain(`resumed int-1:resolved:${JSON.stringify(payload)}`);
  });

  test("a run with a permission and a question: answering the permission ends the turn, the next message answers the question and resumes", async () => {
    const c = run((emit) => adapter().start(opts("mixed"), emit));
    await c.until((e) => e.t === "question.ask" && e.id === "q-1");
    await c.until((e) => e.t === "permission.ask" && e.id === "int-1");
    await Bun.sleep(50);
    expect(c.events.some((e) => e.t === "session.end")).toBe(false);
    const posts = fake.received.length;
    c.session.respondPermission("int-1", "allow");
    await c.ended();
    expect(fake.received.length).toBe(posts);
    const n = c.events.length;
    c.session.send("a.txt");
    await c.ended(n);
    expect(last().resume).toEqual([
      { interruptId: "int-1", status: "resolved", payload: { approved: true } },
      { interruptId: "q-1", status: "resolved", payload: { answer: "a.txt" } },
    ]);
  });

  test("in a run with a permission and a question, a message sent while the stream is open answers the question; the permission then resumes", async () => {
    const c = run((emit) => adapter().start(opts("mixed-slow"), emit));
    await c.until((e) => e.t === "question.ask" && e.id === "q-1");
    c.session.send("b.txt");
    await Bun.sleep(400);
    expect(c.events.some((e) => e.t === "session.end")).toBe(false);
    c.session.respondPermission("int-1", "deny");
    await c.ended();
    expect(last().resume).toEqual([
      { interruptId: "int-1", status: "resolved", payload: { approved: false } },
      { interruptId: "q-1", status: "resolved", payload: { answer: "b.txt" } },
    ]);
    // The message was the answer, not a new turn after the resume
    await Bun.sleep(100);
    expect(last().resume).toBeDefined();
  });

  test("a call whose only argument is a string named `arguments` keeps its JSON text in the history", async () => {
    const c = run((emit) => adapter().start(opts("args-named"), emit));
    await c.ended();
    const n = c.events.length;
    c.session.send("next");
    await c.ended(n);
    expect(last().messages[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "tc3", function: { name: "run", arguments: '{"arguments":"--help"}' } }] });
  });

  test("the history carries a chunked tool call with its result, and no message of another role", async () => {
    const c = run((emit) => adapter().start(opts("chunk"), emit));
    await c.ended();
    expect(c.events).toContainEqual(expect.objectContaining({ t: "tool.call", id: "tc5", name: "read_file", input: { path: "a.txt" } }));
    const n = c.events.length;
    c.session.send("next");
    await c.ended(n);
    expect(last().messages.slice(1, 4)).toEqual([
      expect.objectContaining({ role: "assistant", toolCalls: [{ id: "tc5", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] }),
      expect.objectContaining({ role: "tool", toolCallId: "tc5", content: "file contents" }),
      expect.objectContaining({ role: "assistant", content: "read it" }),
    ]);
  });

  test("resume waits until every interrupt is answered", async () => {
    const c = run((emit) => adapter().start(opts("interrupt-two"), emit));
    await c.until((e) => e.t === "permission.ask" && e.id === "int-2");
    const n = fake.received.length;
    c.session.respondPermission("int-1", "allow");
    await Bun.sleep(100);
    expect(fake.received.length).toBe(n);
    c.session.respondPermission("int-2", "deny");
    await c.ended();
    expect(last().resume).toEqual([
      { interruptId: "int-1", status: "resolved", payload: { approved: true } },
      { interruptId: "int-2", status: "resolved", payload: { approved: false } },
    ]);
  });

  test("with no schema a denial can only be cancelled; an approval is resolved without a payload", async () => {
    const c = run((emit) => adapter().start(opts("interrupt-plain"), emit));
    await c.until((e) => e.t === "permission.ask");
    c.session.respondPermission("int-1", "deny");
    await c.ended();
    expect(last().resume).toEqual([{ interruptId: "int-1", status: "cancelled" }]);
    const d = run((emit) => adapter().start(opts("interrupt-plain"), emit));
    await d.until((e) => e.t === "permission.ask");
    d.session.respondPermission("int-1", "allow");
    await d.ended();
    expect(last().resume).toEqual([{ interruptId: "int-1", status: "resolved" }]);
  });

  test("an interrupt without a tool call is a question: the turn ends and the next message answers it", async () => {
    const c = run((emit) => adapter().start(opts("ask file"), emit));
    await c.ended();
    expect(c.events.some((e) => e.t === "permission.ask")).toBe(false);
    expect(c.events.find((e) => e.t === "question.ask")).toMatchObject({ id: "q-1", questions: [{ header: "input_required", question: "Which file?", options: [], multiSelect: false }] });
    const n = c.events.length;
    c.session.send("a.txt");
    await c.ended(n);
    expect(last().resume).toEqual([{ interruptId: "q-1", status: "resolved", payload: { answer: "a.txt" } }]);
  });

  test.each(["interrupt-deny", "interrupt-const", "interrupt-whole-const"])("%s: a schema a yes / no cannot fill safely is a question, not a permission.ask", async (scene) => {
    const c = run((emit) => adapter().start(opts(scene), emit));
    await c.ended();
    expect(c.events.some((e) => e.t === "permission.ask")).toBe(false);
    expect(c.events.find((e) => e.t === "question.ask")).toMatchObject({ id: "int-1" });
    const n = c.events.length;
    c.session.send("no");
    await c.ended(n);
    expect(last().resume).toEqual([{ interruptId: "int-1", status: "cancelled" }]);
  });

  test("an interrupt outcome with no interrupts ends the run, and a message sent meanwhile is sent next", async () => {
    const c = run((emit) => adapter().start(opts("empty-slow"), emit));
    await c.until((e) => e.t === "message.delta" && e.role === "user");
    await Bun.sleep(100);
    c.session.send("next one");
    await c.until((e) => e.t === "message.delta" && e.role === "assistant" && e.text.includes("next one"));
    expect(last().resume).toBeUndefined();
    expect(last().messages.at(-1)).toMatchObject({ role: "user", content: "next one" });
  });

  test("a message sent while the question's stream is still open answers it", async () => {
    const c = run((emit) => adapter().start(opts("ask-slow file"), emit));
    await c.until((e) => e.t === "question.ask");
    c.session.send("a.txt");
    await c.until((e) => e.t === "message.delta" && e.role === "assistant" && e.text.startsWith("resumed"));
    expect(last().resume).toEqual([{ interruptId: "q-1", status: "resolved", payload: { answer: "a.txt" } }]);
    // The answer was already queued: one turn, ended by the resume run
    await c.ended();
    expect(c.events.filter((e) => e.t === "session.end")).toEqual([{ t: "session.end", status: "ok" }]);
    expect(c.events.at(-1)).toEqual({ t: "session.end", status: "ok" });
  });

  test("a question whose schema cannot take text is cancelled and the answer is shown as a user message", async () => {
    const c = run((emit) => adapter().start(opts("ask-object file"), emit));
    await c.ended();
    const n = c.events.length;
    c.session.send("a.txt because");
    await c.ended(n);
    const body = last();
    expect(body.resume).toEqual([{ interruptId: "q-1", status: "cancelled" }]);
    expect(body.messages.at(-1)).toMatchObject({ role: "user", content: "a.txt because" });
  });

  test("a failed run ends in error; a stream cut before RUN_FINISHED is an error, not a finish", async () => {
    const f = run((emit) => adapter().start(opts("fail now"), emit));
    await f.ended();
    expect(f.events.find((e) => e.t === "error")).toMatchObject({ message: "BOOM: simulated failure" });
    expect(f.events.at(-1)).toMatchObject({ t: "session.end", status: "error" });
    const c = run((emit) => adapter().start(opts("cut now"), emit));
    await c.ended();
    expect(c.events.find((e) => e.t === "error")).toMatchObject({ message: expect.stringContaining("before RUN_FINISHED") });
    expect(c.events.at(-1)).toMatchObject({ t: "session.end", status: "error" });
  });

  test("abort closes the connection and ends the turn as aborted", async () => {
    const before = fake.state.disconnected;
    const c = run((emit) => adapter().start(opts("sleep"), emit));
    await c.until((e) => e.t === "message.delta" && e.role === "assistant");
    await c.session.abort();
    expect(c.events.filter((e) => e.t === "session.end")).toEqual([{ t: "session.end", status: "aborted", summary: "aborted by user" }]);
    expect(await c.session.exited).toBe(null);
    for (let i = 0; i < 100 && fake.state.disconnected === before; i++) await Bun.sleep(10);
    expect(fake.state.disconnected).toBeGreaterThan(before);
  });

  test("abort while an approval is open resolves it as timed out and ends the turn", async () => {
    const c = run((emit) => adapter().start(opts("interrupt delete"), emit));
    await c.until((e) => e.t === "permission.ask");
    await c.session.abort();
    expect(c.events).toContainEqual({ t: "permission.resolved", id: "int-1", decision: "deny", by: "timeout" });
    expect(c.events.at(-1)).toMatchObject({ t: "session.end", status: "aborted" });
  });

  test("abort of an idle session ends nothing; close then send is refused", async () => {
    const c = run((emit) => adapter().start(opts("hello"), emit));
    await c.ended();
    const n = c.events.length;
    await c.session.abort();
    expect(c.events.length).toBe(n);
    expect(await c.session.exited).toBe(0);
    expect(() => c.session.send("x")).toThrow();
  });

  test("the token is read from the named variable on every request and never kept", async () => {
    process.env.AGUI_TEST_TOKEN = "t-1";
    const a = adapter({ tokenEnv: "AGUI_TEST_TOKEN" });
    const c = run((emit) => a.start(opts("hello"), emit));
    await c.ended();
    expect(fake.requests.at(-1)?.authorization).toBe("Bearer t-1");
    process.env.AGUI_TEST_TOKEN = "t-2";
    await a.detect();
    expect(fake.requests.at(-1)?.authorization).toBe("Bearer t-2");
    delete process.env.AGUI_TEST_TOKEN;
    const d = run((emit) => a.start(opts("hello"), emit));
    await d.ended();
    expect(fake.requests.at(-1)?.authorization).toBeNull();
    expect(JSON.stringify(fake.received.at(-1))).not.toContain("t-1");
    expect(JSON.stringify(c.events)).not.toContain("t-1");
  });

  test("forwardedProps carries no model (not built), and the Workspace MCP servers only when the entry turns it on", async () => {
    const mcpServers = { workspace: { type: "http" as const, url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer x" } } };
    const off = run((emit) => adapter().start(opts("hello", { model: "m-1", mcpServers }), emit));
    await off.ended();
    expect(last().forwardedProps).toEqual({});
    const on = run((emit) => adapter({ sendWorkspaceMcp: true }).start(opts("hello", { mcpServers }), emit));
    await on.ended();
    expect(last().forwardedProps).toEqual({ switchboard: { mcpServers } });
  });

  test("detect: reachable with a note; unreachable names the label", async () => {
    expect(await adapter().detect()).toMatchObject({ available: true, note: `AG-UI at ${fake.url} (reachable)` });
    const down = await adapter({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }).detect();
    expect(down.available).toBe(false);
    expect(down.note).toContain("Sample agent not reachable");
  });
});
