import type { AgentEvent } from "@switchboard/protocol";

/**
 * Pure mapping from AG-UI (https://docs.ag-ui.com, 1.0.0) SSE events to AgentEvent. Written from the spec and checked
 * against recordings of `ag-ui-protocol` 1.0.0 (packages/adapters/agui/fixtures, recorded outside Git):
 *  - TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_CHUNK    → message.delta (assistant only: the role comes from the event or
 *                                                   from the message's TEXT_MESSAGE_START), messageId from the event
 *  - TOOL_CALL_START / ARGS / END                 → tool.call at END (the arguments are joined from the ARGS deltas)
 *  - TOOL_CALL_CHUNK                              → the same, ending at the next event that is not a chunk of that call
 *  - TOOL_CALL_RESULT                             → tool.result (ok unless metadata.isError === true, the only mark recorded)
 *  - RUN_FINISHED.usage[]                         → usage(reported) per provider/model entry: the run's own total, booked in the ledger
 *  - RUN_FINISHED.outcome.interrupts[]            → permission.ask per interrupt (id = interrupt id, toolUseId = its toolCallId)
 *  - RUN_ERROR                                    → error
 * Everything else (RUN_STARTED, STEP_*, STATE_*, MESSAGES_SNAPSHOT, REASONING_*, CUSTOM, RAW, unknown types, missing
 * fields) is skipped. No session.end here: the stream and the run belong to the session, not to this mapping.
 */
export interface AguiState {
  /** Open tool calls, by toolCallId: the name and the argument text so far. */
  calls: Map<string, { name: string; args: string }>;
  /** Finished calls' name and arguments (parsed, and the text as sent), kept to describe an interrupt that names one. */
  done: Map<string, { name: string; input: unknown; args: string }>;
  /** The call that TOOL_CALL_CHUNK events are filling; it ends at the first event that is not a chunk of it. */
  chunk?: string;
  /** Roles of messages opened by TEXT_MESSAGE_START (or a role-bearing chunk), by messageId. */
  roles: Map<string, string>;
}

export function createAguiState(): AguiState {
  return { calls: new Map(), done: new Map(), roles: new Map() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Feed one SSE `data:` payload (already JSON-decoded). */
export function mapAguiEvent(s: AguiState, ev: Any): AgentEvent[] {
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return [];
  // A chunked tool call has no END event: the first event that is not a chunk of it ends it
  const pre: AgentEvent[] = [];
  if (s.chunk && (ev.type !== "TOOL_CALL_CHUNK" || (str(ev.toolCallId) && ev.toolCallId !== s.chunk))) {
    pre.push(...endCall(s, s.chunk));
    s.chunk = undefined;
  }
  return [...pre, ...mapOne(s, ev)];
}

function mapOne(s: AguiState, ev: Any): AgentEvent[] {
  switch (ev.type) {
    case "TEXT_MESSAGE_START": {
      const id = str(ev.messageId);
      if (id && str(ev.role)) s.roles.set(id, ev.role);
      return [];
    }
    case "TEXT_MESSAGE_END":
      s.roles.delete(str(ev.messageId) ?? "");
      return [];
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_CHUNK": {
      const messageId = str(ev.messageId);
      if (ev.type === "TEXT_MESSAGE_CHUNK" && messageId && str(ev.role)) s.roles.set(messageId, ev.role);
      const role = str(ev.role) ?? (messageId ? s.roles.get(messageId) : undefined);
      const delta = str(ev.delta);
      if (!delta) return [];
      if (role !== undefined && role !== "assistant") return [];
      return [{ t: "message.delta", role: "assistant", text: delta, messageId }];
    }
    case "TOOL_CALL_START": {
      const id = str(ev.toolCallId);
      if (!id) return [];
      s.calls.set(id, { name: str(ev.toolCallName) ?? "tool", args: "" });
      return [];
    }
    case "TOOL_CALL_ARGS": {
      const c = s.calls.get(str(ev.toolCallId) ?? "");
      if (c) c.args += str(ev.delta) ?? "";
      return [];
    }
    case "TOOL_CALL_CHUNK": {
      const id = str(ev.toolCallId) ?? s.chunk;
      if (!id) return [];
      if (!s.calls.has(id)) s.calls.set(id, { name: str(ev.toolCallName) ?? "tool", args: "" });
      s.chunk = id;
      s.calls.get(id)!.args += str(ev.delta) ?? "";
      return [];
    }
    case "TOOL_CALL_END":
      return endCall(s, str(ev.toolCallId));
    case "TOOL_CALL_RESULT": {
      const id = str(ev.toolCallId);
      if (!id) return [];
      return [{ t: "tool.result", id, ok: ev.metadata?.isError !== true, summary: truncate(str(ev.content) ?? "", 600) }];
    }
    case "RUN_ERROR":
      return [{ t: "error", message: `${str(ev.code) ? `${ev.code}: ` : ""}${str(ev.message) ?? "AG-UI run error"}` }];
    case "RUN_FINISHED":
      return [...usageOf(ev.usage), ...interruptsOf(s, ev.outcome)];
    default:
      return [];
  }
}

function endCall(s: AguiState, id: string | undefined): AgentEvent[] {
  const c = id ? s.calls.get(id) : undefined;
  if (!id || !c) return [];
  s.calls.delete(id);
  const input = parseArgs(c.args);
  s.done.set(id, { name: c.name, input, args: c.args });
  return [{ t: "tool.call", id, name: c.name, input, summary: summarize(c.name, input) }];
}

function usageOf(usage: Any): AgentEvent[] {
  if (!Array.isArray(usage)) return [];
  const out: AgentEvent[] = [];
  for (const u of usage) {
    if (!u || typeof u !== "object") continue;
    const cached = num(u.cachedInputTokens);
    out.push({ t: "usage", source: "reported", model: str(u.model), inputTokens: Math.max(0, num(u.inputTokens) - cached), outputTokens: num(u.outputTokens), cacheReadTokens: cached, cacheWriteTokens: 0 });
  }
  return out;
}

function interruptsOf(s: AguiState, outcome: Any): AgentEvent[] {
  if (outcome?.type !== "interrupt" || !Array.isArray(outcome.interrupts)) return [];
  const out: AgentEvent[] = [];
  for (const i of outcome.interrupts) {
    const id = str(i?.id);
    if (!id) continue;
    const call = s.done.get(str(i.toolCallId) ?? "");
    const tool = call?.name ?? str(i.reason) ?? "interrupt";
    out.push({ t: "permission.ask", id, kind: kindOf(tool), tool, input: call?.input ?? {}, detail: str(i.message) ?? summarize(tool, call?.input), toolUseId: str(i.toolCallId) ?? id });
  }
  return out;
}

/** Split an SSE byte stream into `data:` payloads (events end at a blank line; multiple data lines join with \n). Same shape as the ADK adapter's. */
export function createSseParser() {
  let buf = "";
  const dataOf = (block: string) =>
    block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
  return {
    feed(chunk: string): string[] {
      // Normalize after joining: a CRLF split across two chunks (`\r` | `\n`) must still read as one line end
      buf = (buf + chunk).replace(/\r\n/g, "\n");
      const out: string[] = [];
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const data = dataOf(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (data) out.push(data);
      }
      return out;
    },
    flush(): string[] {
      const data = dataOf(buf);
      buf = "";
      return data ? [data] : [];
    },
  };
}

function kindOf(name: string): Extract<AgentEvent, { t: "permission.ask" }>["kind"] {
  const n = name.toLowerCase();
  if (/(exec|run|shell|command|bash)/.test(n)) return "exec";
  if (/(write|edit|patch|create|delete|remove|move|rename|send|pay|transfer)/.test(n)) return "write";
  if (/(fetch|http|search|browse|url)/.test(n)) return "network";
  return "other";
}

function parseArgs(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { arguments: text };
  }
}

function summarize(name: string, args: Any): string {
  if (!args || typeof args !== "object") return name;
  const keys = Object.keys(args);
  if (keys.length === 0) return name;
  const first = args[keys[0]!];
  const v = typeof first === "string" ? first : JSON.stringify(first);
  return `${name}(${keys[0]}=${truncate(String(v), 80)}${keys.length > 1 ? ", …" : ""})`;
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
