/**
 * A scripted stand-in for an AG-UI server used by the session tests (event shapes of the recordings made against
 * ag-ui-protocol 1.0.0). One POST route; the last user message picks the scene:
 *   "mixed …"          → a tool call, then one run with a tool_approval interrupt and a question
 *   "mixed-slow …"     → the same, with the stream held open 300 ms after RUN_FINISHED
 *   "args-named …"     → a tool call whose only argument is a string named `arguments`, then text
 *   "chunk …"          → a tool call as TOOL_CALL_CHUNK and its result, a developer message, then assistant text
 *   "interrupt …"      → a tool call, then RUN_FINISHED with a tool_approval interrupt (boolean `approved`)
 *   "interrupt-two …"  → two such interrupts in one run
 *   "interrupt-plain …" → a tool_approval interrupt with no responseSchema
 *   "interrupt-deny …"  → a tool_approval interrupt whose only boolean is `deny` (not an approval name)
 *   "interrupt-const …" → a tool_approval interrupt whose `approved` is `const: true`
 *   "interrupt-whole-const …" → a tool_approval interrupt whose schema itself adds `const: { approved: true }`
 *   "ask …"            → an interrupt with no toolCallId and a string-property schema (a question)
 *   "ask-object …"     → the same, but the schema needs an object the adapter cannot fill from text
 *   "ask-slow …"       → the "ask" question, with the stream held open 300 ms after RUN_FINISHED
 *   "empty-slow …"     → an interrupt outcome with no interrupts, the stream held open 300 ms after RUN_FINISHED
 *   "fail …"           → RUN_ERROR
 *   "cut …"            → a few chunks, then the stream ends without RUN_FINISHED
 *   "sleep …"          → streams slowly until the client disconnects
 *   anything           → streamed text "echo:<prompt>" and usage
 * A request carrying `resume` is answered with text saying what each interrupt got. `received` keeps every body,
 * `requests` every request's method and authorization header, `disconnected` counts clients that closed mid-stream.
 */
export function startFakeAgui(port = 0) {
  const received: Array<Record<string, any>> = [];
  const requests: Array<{ method: string; authorization: string | null }> = [];
  const state = { disconnected: 0 };
  const enc = new TextEncoder();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      requests.push({ method: req.method, authorization: req.headers.get("authorization") });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await req.json()) as Record<string, any>;
      received.push(body);
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const prompt = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const base = { threadId: body.threadId, runId: body.runId };
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          let open = true;
          const ev = (o: unknown) => open && c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const approval = (id: string, toolCallId: string, withSchema = true) => ({ id, reason: "tool_approval", message: `Delete ${toolCallId}?`, toolCallId, ...(withSchema ? { responseSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] } } : {}) });
          const call = (id: string, name: string, args: unknown) => {
            ev({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name });
            ev({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) });
            ev({ type: "TOOL_CALL_END", toolCallId: id });
          };
          const finish = (outcome: unknown) => ev({ type: "RUN_FINISHED", ...base, outcome, usage: [{ provider: "fake", model: "scripted-1", inputTokens: 12, outputTokens: 7, totalTokens: 19, cachedInputTokens: 3 }] });
          ev({ type: "RUN_STARTED", ...base });
          if (Array.isArray(body.resume)) {
            const said = (body.resume as Array<{ interruptId: string; status: string; payload?: unknown }>).map((r) => `${r.interruptId}:${r.status}:${JSON.stringify(r.payload ?? null)}`).join(";");
            ev({ type: "TEXT_MESSAGE_START", messageId: "m-r", role: "assistant" });
            ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m-r", delta: `resumed ${said}` });
            ev({ type: "TEXT_MESSAGE_END", messageId: "m-r" });
            finish({ type: "success" });
          } else if (prompt.startsWith("mixed")) {
            call("tc1", "delete_file", { path: "a.txt" });
            finish({ type: "interrupt", interrupts: [approval("int-1", "tc1"), { id: "q-1", reason: "input_required", message: "Which file?", responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }] });
            if (prompt.startsWith("mixed-slow")) await sleep(300);
          } else if (prompt.startsWith("args-named")) {
            call("tc3", "run", { arguments: "--help" });
            ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "ran" });
            finish({ type: "success" });
          } else if (prompt.startsWith("chunk")) {
            ev({ type: "TOOL_CALL_CHUNK", toolCallId: "tc5", toolCallName: "read_file", delta: '{"path":' });
            ev({ type: "TOOL_CALL_CHUNK", delta: '"a.txt"}' });
            ev({ type: "TOOL_CALL_RESULT", messageId: "r5", toolCallId: "tc5", content: "file contents", role: "tool" });
            ev({ type: "TEXT_MESSAGE_START", messageId: "d1", role: "developer" });
            ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "d1", delta: "internal note" });
            ev({ type: "TEXT_MESSAGE_END", messageId: "d1" });
            ev({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" });
            ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "read it" });
            ev({ type: "TEXT_MESSAGE_END", messageId: "m1" });
            finish({ type: "success" });
          } else if (prompt.startsWith("interrupt-two")) {
            call("tc1", "delete_file", { path: "a.txt" });
            call("tc2", "delete_file", { path: "b.txt" });
            finish({ type: "interrupt", interrupts: [approval("int-1", "tc1"), approval("int-2", "tc2")] });
          } else if (prompt.startsWith("interrupt-plain")) {
            call("tc1", "delete_file", { path: "a.txt" });
            finish({ type: "interrupt", interrupts: [approval("int-1", "tc1", false)] });
          } else if (prompt.startsWith("interrupt-deny")) {
            call("tc1", "delete_file", { path: "a.txt" });
            finish({ type: "interrupt", interrupts: [{ ...approval("int-1", "tc1", false), responseSchema: { type: "object", properties: { deny: { type: "boolean" } }, required: ["deny"] } }] });
          } else if (prompt.startsWith("interrupt-whole-const")) {
            call("tc1", "delete_file", { path: "a.txt" });
            finish({ type: "interrupt", interrupts: [{ ...approval("int-1", "tc1", false), responseSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], const: { approved: true } } }] });
          } else if (prompt.startsWith("interrupt-const")) {
            call("tc1", "delete_file", { path: "a.txt" });
            finish({ type: "interrupt", interrupts: [{ ...approval("int-1", "tc1", false), responseSchema: { type: "object", properties: { approved: { type: "boolean", const: true } }, required: ["approved"] } }] });
          } else if (prompt.startsWith("interrupt")) {
            call("tc9", "delete_file", { path: "a.txt" });
            finish({ type: "interrupt", interrupts: [approval("int-1", "tc9")] });
          } else if (prompt.startsWith("ask-object")) {
            finish({ type: "interrupt", interrupts: [{ id: "q-1", reason: "input_required", message: "Which file and why?", responseSchema: { type: "object", properties: { file: { type: "string" }, why: { type: "string" } }, required: ["file", "why"] } }] });
          } else if (prompt.startsWith("empty-slow")) {
            finish({ type: "interrupt", interrupts: [] });
            await sleep(300);
          } else if (prompt.startsWith("ask-slow")) {
            finish({ type: "interrupt", interrupts: [{ id: "q-1", reason: "input_required", message: "Which file?", responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }] });
            await sleep(300);
          } else if (prompt.startsWith("ask")) {
            finish({ type: "interrupt", interrupts: [{ id: "q-1", reason: "input_required", message: "Which file?", responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }] });
          } else if (prompt.startsWith("fail")) {
            ev({ type: "RUN_ERROR", message: "simulated failure", code: "BOOM" });
          } else if (prompt.startsWith("cut")) {
            ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "partial" });
          } else if (prompt.startsWith("sleep")) {
            try {
              for (let i = 0; i < 100; i++) {
                ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "." });
                await sleep(50);
              }
            } catch {
              open = false;
            }
          } else {
            ev({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" });
            for (const w of `echo:${prompt}`.split(/(?=:)/)) ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: w });
            ev({ type: "TEXT_MESSAGE_END", messageId: "m1" });
            finish({ type: "success" });
          }
          if (open) c.close();
        },
        cancel() {
          state.disconnected++;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/agent`, received, requests, state, stop: () => server.stop(true) };
}
