/**
 * A tiny stand-in for DAK's ADK server (`adk web`) used by the session tests. Serves /list-apps, the session
 * endpoints and /run_sse with the event shapes of the recorded fixtures. Behaviour by prompt:
 *   "confirm …"       → a functionCall to adk_request_confirmation (stream ends with the ask open); the answer's
 *                       functionResponse continues with a tool.result and a final text
 *   "confirm-fail …"  → the same ask, but the stream then errors instead of closing cleanly (the ask never gets
 *                       an answer on this stream — simulates the server hitting an error while a confirmation is open)
 *   "sleep …"         → streams slowly until the client disconnects (abort)
 *   "fail …"          → an ADK error event
 *   "multi …"         → a streamed reply, then a tool call, then a SECOND streamed reply — all under one
 *                       invocationId, to exercise that the second reply is not suppressed by the first
 *   "artifact …"      → a final event with an inlineData part (a PNG) and artifactDelta { "report.txt": 1 }; the
 *                       artifacts are served at GET …/sessions/<id>/artifacts/<name>?version=1 (any name but
 *                       "missing.txt", always FAKE_REPORT)
 *   anything          → thought + streamed text "echo:<prompt>" + usage
 * Every /run_sse body is kept in `received` (session id and the message parts) for tests that check what was sent.
 */
export const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const FAKE_REPORT = "# report\nall good\n";

export function startFakeAdk(port = 0) {
  const sessions = new Map<string, unknown[]>();
  const received: Array<{ session_id: string; parts: unknown[] }> = [];
  let inv = 0;
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/list-apps") return Response.json(["dak_agent"]);
      const a = url.pathname.match(/^\/apps\/[^/]+\/users\/[^/]+\/sessions\/([^/]+)\/artifacts\/([^/]+)$/);
      if (a && req.method === "GET") {
        if (!sessions.has(a[1]!) || decodeURIComponent(a[2]!) === "missing.txt" || url.searchParams.get("version") !== "1") return new Response("not found", { status: 404 });
        return Response.json({ inlineData: { mimeType: "text/plain", data: Buffer.from(FAKE_REPORT).toString("base64") } });
      }
      const m = url.pathname.match(/^\/apps\/([^/]+)\/users\/([^/]+)\/sessions(?:\/([^/]+))?$/);
      if (m) {
        if (req.method === "POST" && !m[3]) {
          const id = `sess-${sessions.size + 1}`;
          sessions.set(id, []);
          return Response.json({ id, appName: m[1], userId: m[2], state: {}, events: [] });
        }
        if (req.method === "GET" && m[3]) return sessions.has(m[3]) ? Response.json({ id: m[3], events: sessions.get(m[3]) }) : new Response("not found", { status: 404 });
      }
      if (url.pathname === "/run_sse" && req.method === "POST") {
        const body = (await req.json()) as { session_id: string; new_message: { parts: Array<{ text?: string; functionResponse?: { id: string; name: string; response: { confirmed: boolean } } }> } };
        received.push({ session_id: body.session_id, parts: body.new_message.parts });
        if (!sessions.has(body.session_id)) return new Response("no session", { status: 404 });
        const id = `e-${++inv}`;
        const text = body.new_message.parts[0]?.text ?? "";
        const fr = body.new_message.parts[0]?.functionResponse;
        const enc = new TextEncoder();
        const base = { invocationId: id, author: "dak_agent", modelVersion: "fake-1", actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} } };
        const ev = (o: unknown) => enc.encode(`data: ${JSON.stringify({ ...base, ...(o as object) })}\n\n`);
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            if (fr) {
              c.enqueue(ev({ content: { parts: [{ functionResponse: { id: fr.id, name: fr.name, response: fr.response } }] }, partial: false }));
              c.enqueue(ev({ content: { parts: [{ functionResponse: { id: "orig-1", name: "delete_file", response: fr.response.confirmed ? { result: "deleted" } : { error: "declined" } } }] }, partial: false }));
              c.enqueue(ev({ content: { parts: [{ text: fr.response.confirmed ? "done" : "not done" }] }, partial: false, finishReason: "STOP", usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2, cachedContentTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 22 } }));
              c.close();
              return;
            }
            c.enqueue(ev({ content: { parts: [{ text: "thinking…", thought: true }] }, partial: true }));
            if (text.startsWith("fail")) {
              c.enqueue(ev({ errorCode: "MALFORMED_FUNCTION_CALL", errorMessage: "simulated failure" }));
              c.close();
              return;
            }
            if (text.startsWith("sleep")) {
              for (let i = 0; i < 100; i++) {
                c.enqueue(ev({ content: { parts: [{ text: "." }] }, partial: true }));
                await sleep(100);
              }
              c.close();
              return;
            }
            if (text.startsWith("confirm-fail")) {
              c.enqueue(ev({ content: { parts: [{ functionCall: { id: "fc-2", name: "adk_request_confirmation", args: { originalFunctionCall: { id: "orig-2", name: "delete_file", args: { path: "y.txt" } } } } }] }, partial: false }));
              c.enqueue(ev({ errorCode: "INTERNAL", errorMessage: "simulated failure while a confirmation was open" }));
              c.close();
              return;
            }
            if (text.startsWith("confirm")) {
              c.enqueue(ev({ content: { parts: [{ functionCall: { id: "fc-1", name: "adk_request_confirmation", args: { originalFunctionCall: { id: "orig-1", name: "delete_file", args: { path: "x.txt" } } } } }] }, partial: false, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 15 } }));
              c.close();
              return;
            }
            if (text.startsWith("artifact")) {
              c.enqueue(ev({ content: { parts: [{ text: "made two files" }, { inlineData: { mimeType: "image/png", data: Buffer.from(FAKE_PNG).toString("base64") } }] }, partial: false, finishReason: "STOP", actions: { ...base.actions, artifactDelta: { "report.txt": 1 } } }));
              c.close();
              return;
            }
            if (text.startsWith("multi")) {
              // Same invocationId throughout: a reply, then a tool call, then a SECOND reply that must not be
              // swallowed by the first having already streamed.
              c.enqueue(ev({ content: { parts: [{ text: "first" }] }, partial: true }));
              c.enqueue(ev({ content: { parts: [{ text: "first" }] }, partial: false, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, cachedContentTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 11 } }));
              c.enqueue(ev({ content: { parts: [{ functionCall: { id: "fc-3", name: "list_files", args: {} } }] }, partial: false }));
              c.enqueue(ev({ content: { parts: [{ functionResponse: { id: "fc-3", name: "list_files", response: { result: "a.txt" } } }] } }));
              // Sent whole, never streamed: this is the case the segment fix protects.
              c.enqueue(ev({ content: { parts: [{ text: "second" }] }, partial: false, finishReason: "STOP", usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1, cachedContentTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 21 } }));
              c.close();
              return;
            }
            for (const w of `echo:${text}`.split(/(?=:)/)) c.enqueue(ev({ content: { parts: [{ text: w }] }, partial: true }));
            c.enqueue(ev({ content: { parts: [{ text: "thinking…", thought: true }, { text: `echo:${text}` }] }, partial: false, finishReason: "STOP", usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, cachedContentTokenCount: 40, thoughtsTokenCount: 3, totalTokenCount: 110 } }));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) };
}
