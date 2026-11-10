/**
 * Records the raw SSE of an AG-UI server into the recordings folder (outside Git), one file per scene.
 *   bun packages/adapters/agui/fixtures/record.ts <agent-url> <version>      e.g. http://127.0.0.1:47931/agent 1.0.0
 * The server is the scripted fake-model one described in docs/design/custom-adapter.md (built on the
 * ag-ui-protocol package in a throwaway directory); the prompt prefix picks the scene. Files are named
 * agui-<version>-<scene>.sse, under packages/adapters/agui/fixtures/ of SWITCHBOARD_FIXTURES.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordingsDir } from "../../../../scripts/recordings.ts";

const [url, version] = process.argv.slice(2);
if (!url || !version) {
  console.error("Usage: bun record.ts <agent-url> <version>");
  process.exit(2);
}
const dir = join(recordingsDir(), "packages/adapters/agui/fixtures");
mkdirSync(dir, { recursive: true });

type Message = Record<string, unknown>;
const input = (threadId: string, runId: string, messages: Message[], extra: Record<string, unknown> = {}) => ({
  threadId, runId, state: {}, messages, tools: [], context: [], forwardedProps: {}, ...extra,
});
const user = (content: string): Message => ({ id: "u1", role: "user", content });

/** Reads the whole stream, or stops after `stopAfter` bytes (a client that closes the connection). */
async function post(body: unknown, stopAfter?: number): Promise<string> {
  const ctl = new AbortController();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: ctl.signal,
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  let text = "";
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if (stopAfter !== undefined && text.length >= stopAfter) {
      ctl.abort();
      break;
    }
  }
  return text;
}
const save = (scene: string, text: string) => {
  const path = join(dir, `agui-${version}-${scene}.sse`);
  writeFileSync(path, text);
  console.log(`${path} (${text.length} bytes)`);
};

save("text", await post(input("t-text", "r1", [user("text hello")])));
save("tool", await post(input("t-tool", "r1", [user("tool read a.txt")])));
// Scene 3: a run that ends with an interrupt, then the next run on the thread answers it in `resume`.
const interrupted = await post(input("t-int", "r1", [user("interrupt delete a.txt")]));
save("interrupt", interrupted);
const finished = interrupted.split("\n").find((l) => l.includes('"RUN_FINISHED"'));
const interrupts = JSON.parse(finished!.slice("data: ".length)).outcome.interrupts as { id: string }[];
save(
  "interrupt-resume",
  await post(
    input("t-int", "r2", [user("interrupt delete a.txt"), { id: "a1", role: "assistant", toolCalls: [{ id: "tc9", type: "function", function: { name: "delete_file", arguments: '{"path":"a.txt"}' } }] }], {
      resume: interrupts.map((i) => ({ interruptId: i.id, status: "resolved", payload: { approved: true } })),
    }),
  ),
);
// Scene 4: the client closes the connection after the first chunks; the server's log says whether it stopped.
save("disconnect", await post(input("t-cut", "r1", [user("disconnect")]), 300));
