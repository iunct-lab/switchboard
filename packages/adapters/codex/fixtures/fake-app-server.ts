#!/usr/bin/env bun
/**
 * A tiny stand-in for `codex app-server` used by the session tests. Speaks the same JSON-RPC lines the recorded
 * fixtures show, deterministically:
 *   initialize → {}                          thread/start | thread/resume → {thread}
 *   turn/start → {turn} then: turn/started, agentMessage delta/completed, one commandExecution approval request
 *                (answered by the client), commandExecution completed, tokenUsage, turn/completed
 *   turn/steer (while active) → {} and the text is echoed as another agentMessage
 *   turn/interrupt → {} then turn/completed(status: interrupted)
 * Prompts containing "crash" make the process exit 3 without a result; "sleep" keeps the turn open until interrupted.
 */
import { appendFileSync } from "node:fs";
const wireLog = process.argv.find((arg) => arg.startsWith("test_wire_log="))?.slice("test_wire_log=".length);
const enc = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
let turnSeq = 0;
let active: { id: string; threadId: string; sleeping: boolean } | null = null;
let approvalSeq = 0;
const waiting = new Map<number, (d: string) => void>();
const thread = (id: string, cwd: string) => ({ id, cwd, cliVersion: "fake-0.1", sessionId: id, createdAt: 0, updatedAt: 0, status: { type: "idle" } });

async function runTurn(threadId: string, text: string) {
  const id = `turn-${++turnSeq}`;
  active = { id, threadId, sleeping: /sleep/.test(text) };
  enc({ method: "turn/started", params: { threadId, turn: { id, items: [], status: "inProgress" } } });
  if (/crash/.test(text)) {
    process.stderr.write("fake app-server: simulated crash\n");
    process.exit(3);
  }
  enc({ method: "item/started", params: { threadId, turnId: id, item: { type: "agentMessage", id: `msg-${id}`, text: "", phase: "commentary" } } });
  enc({ method: "item/agentMessage/delta", params: { threadId, turnId: id, itemId: `msg-${id}`, delta: `echo:${text}` } });
  enc({ method: "item/completed", params: { threadId, turnId: id, item: { type: "agentMessage", id: `msg-${id}`, text: `echo:${text}`, phase: "final_answer" } } });
  if (active.sleeping) return; // stays open until turn/interrupt
  const itemId = `exec-${id}`;
  enc({ method: "item/started", params: { threadId, turnId: id, item: { type: "commandExecution", id: itemId, command: "/bin/sh -c 'touch x'", cwd: "/tmp", commandActions: [{ type: "unknown", command: "touch x" }], status: "inProgress" } } });
  const reqId = approvalSeq++;
  const decision = await new Promise<string>((r) => {
    waiting.set(reqId, r);
    enc({ method: "item/commandExecution/requestApproval", id: reqId, params: { threadId, turnId: id, itemId, command: "/bin/sh -c 'touch x'", cwd: "/tmp", commandActions: [{ type: "unknown", command: "touch x" }], startedAtMs: 0 } });
  });
  if (!active || active.id !== id) return; // interrupted meanwhile
  const accepted = decision === "accept";
  enc({ method: "item/completed", params: { threadId, turnId: id, item: { type: "commandExecution", id: itemId, command: "/bin/sh -c 'touch x'", cwd: "/tmp", commandActions: [], status: accepted ? "completed" : "declined", exitCode: accepted ? 0 : null, aggregatedOutput: accepted ? "ok\n" : null } } });
  enc({ method: "thread/tokenUsage/updated", params: { threadId, turnId: id, tokenUsage: { last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, total: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } } } });
  active = null;
  enc({ method: "turn/completed", params: { threadId, turn: { id, items: [], status: "completed", error: null, durationMs: 5 } } });
}

const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    if (wireLog) appendFileSync(wireLog, line + "\n");
    const m = JSON.parse(line);
    if (typeof m.method !== "string") {
      // response to one of our requests (approval)
      const r = waiting.get(Number(m.id));
      if (r) {
        waiting.delete(Number(m.id));
        r(m.result?.decision ?? "decline");
      }
      continue;
    }
    switch (m.method) {
      case "initialize":
        enc({ id: m.id, result: { userAgent: "fake" } });
        break;
      case "initialized":
        break;
      case "thread/start":
        enc({ id: m.id, result: { thread: thread("thread-new", m.params.cwd) } });
        break;
      case "thread/resume":
        enc({ id: m.id, result: { thread: thread(m.params.threadId, m.params.cwd) } });
        // codex replays the previous turn's usage on resume, with the OLD turn id
        enc({ method: "thread/tokenUsage/updated", params: { threadId: m.params.threadId, turnId: "turn-old", tokenUsage: { last: { totalTokens: 999, inputTokens: 999, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, total: { totalTokens: 999, inputTokens: 999, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } } } });
        break;
      case "turn/start": {
        if (active) {
          enc({ id: m.id, error: { code: -32600, message: "a turn is already active" } });
          break;
        }
        const id = `turn-${turnSeq + 1}`;
        enc({ id: m.id, result: { turn: { id, items: [], status: "inProgress" } } });
        void runTurn(m.params.threadId, m.params.input[0].text);
        break;
      }
      case "turn/steer":
        if (!active || active.id !== m.params.expectedTurnId) {
          enc({ id: m.id, error: { code: -32600, message: "no such active turn" } });
          break;
        }
        enc({ id: m.id, result: {} });
        enc({ method: "item/completed", params: { threadId: active.threadId, turnId: active.id, item: { type: "agentMessage", id: `steer-${Date.now()}`, text: `steer:${m.params.input[0].text}`, phase: "final_answer" } } });
        break;
      case "turn/interrupt": {
        enc({ id: m.id, result: {} });
        const a = active;
        active = null;
        if (a) enc({ method: "turn/completed", params: { threadId: a.threadId, turn: { id: a.id, items: [], status: "interrupted", error: null } } });
        break;
      }
      default:
        enc({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
    }
  }
}
