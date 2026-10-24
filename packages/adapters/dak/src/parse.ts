import { readFileSync } from "node:fs";
import type { AgentEvent, Attachment } from "@switchboard/protocol";

/**
 * Pure mapping from Google ADK `POST /run_sse` events (as served by DAK's agent container, `adk web --a2a`) to
 * AgentEvent. Recorded against google-adk 2.x behind DAK @ e966c05 (fixtures in ../fixtures):
 *  - event.content.parts[].text (partial, not thought)   → message.delta (assistant), messageId = invocationId:segment
 *  - parts[].text with thought: true                      → status "thinking" (content not shown)
 *  - final (partial: false) event                         → text only if nothing streamed for the current segment
 *    (a functionCall/functionResponse starts a new segment, so an invocationId spanning several tool calls does not
 *    suppress a later, un-streamed reply just because an earlier one in the same turn already streamed)
 *  - parts[].functionCall                                 → tool.call; `adk_request_confirmation` → permission.ask instead
 *  - actions.requestedToolConfirmations (ADK native)      → permission.ask per function call id
 *  - parts[].functionResponse                             → tool.result (ok unless response.error / isError)
 *  - usageMetadata on final events                        → usage(turn) per model call; summed into usage(reported) at end
 *  - errorCode / errorMessage                             → error
 */
export interface DakParserState {
  invocationId?: string;
  /**
   * ADK keeps one invocationId for a whole turn even across several tool calls, so "did this invocation already
   * stream" is not enough to dedupe a final full-replay event against streamed deltas: a model that speaks, calls a
   * tool, then speaks again produces two distinct text segments under the same invocationId, and the second one
   * would be wrongly suppressed by the first having streamed. `segment` increments at every functionCall /
   * functionResponse boundary; `segmentStreamed` tracks only the current segment.
   */
  segment: number;
  segmentStreamed: boolean;
  /** Sum of this turn's usage, emitted as usage(reported) when the stream ends. */
  turnUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Text of the current segment only (reset at each boundary); becomes the session.end summary. */
  lastText?: string;
  model?: string;
  /** Open confirmation requests: permission.ask id (= function call id) → original call. */
  confirmations: Map<string, { name: string; args: unknown }>;
  errored?: string;
}

export function createDakParserState(): DakParserState {
  return { segment: 0, segmentStreamed: false, turnUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, confirmations: new Map() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Feed one SSE `data:` payload (already JSON-decoded). */
export function mapAdkEvent(ev: Any, s: DakParserState): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!ev || typeof ev !== "object") return out;
  if (typeof ev.invocationId === "string") s.invocationId = ev.invocationId;
  if (typeof ev.modelVersion === "string") s.model = ev.modelVersion;
  const inv = s.invocationId ?? "inv";
  const parts: Any[] = Array.isArray(ev.content?.parts) ? ev.content.parts : [];
  const partial = ev.partial === true;
  const confirmations = ev.actions?.requestedToolConfirmations && typeof ev.actions.requestedToolConfirmations === "object" ? (ev.actions.requestedToolConfirmations as Record<string, Any>) : {};

  for (const p of parts) {
    if (typeof p.text === "string") {
      if (p.thought === true) {
        if (partial) out.push({ t: "status", text: "thinking" });
        continue;
      }
      const msgId = `${inv}:${s.segment}`;
      if (partial) {
        s.segmentStreamed = true;
        out.push({ t: "message.delta", role: "assistant", text: p.text, messageId: msgId });
        s.lastText = (s.lastText ?? "") + p.text;
      } else if (!s.segmentStreamed && p.text) {
        out.push({ t: "message.delta", role: "assistant", text: p.text, messageId: msgId });
        s.lastText = (s.lastText ?? "") + p.text;
      }
    } else if (p.functionCall && typeof p.functionCall === "object") {
      // A tool call always ends the current text segment: any later assistant text is a fresh segment that must
      // not be suppressed by this one having (or not having) streamed.
      s.segment++;
      s.segmentStreamed = false;
      s.lastText = undefined;
      const fc = p.functionCall;
      const id = String(fc.id ?? `${inv}:${fc.name}`);
      if (fc.name === "adk_request_confirmation") {
        // DAK's explicit confirmation tool: the agent asks before running `originalFunctionCall`.
        const orig = fc.args?.originalFunctionCall ?? {};
        const name = String(orig.name ?? "tool");
        s.confirmations.set(id, { name, args: orig.args });
        out.push({ t: "permission.ask", id, kind: kindOf(name), tool: name, input: orig.args ?? {}, detail: summarize(name, orig.args), toolUseId: String(orig.id ?? id) });
      } else if (confirmations[id]) {
        s.confirmations.set(id, { name: String(fc.name), args: fc.args });
        out.push({ t: "permission.ask", id, kind: kindOf(String(fc.name)), tool: String(fc.name), input: fc.args ?? {}, detail: str(confirmations[id]?.hint) ?? summarize(String(fc.name), fc.args), toolUseId: id });
      } else {
        out.push({ t: "tool.call", id, name: String(fc.name ?? "tool"), input: fc.args ?? {}, summary: summarize(String(fc.name ?? "tool"), fc.args) });
      }
    } else if (p.functionResponse && typeof p.functionResponse === "object") {
      s.segment++;
      s.segmentStreamed = false;
      s.lastText = undefined;
      const fr = p.functionResponse;
      const id = String(fr.id ?? `${inv}:${fr.name}`);
      if (fr.name === "adk_request_confirmation") continue; // our own answer echoed back
      const resp = fr.response ?? {};
      const failed = resp?.isError === true || typeof resp?.error === "string" || (typeof resp?.error === "object" && resp.error !== null);
      out.push({ t: "tool.result", id, ok: !failed, summary: truncate(responseText(resp), 600) });
    }
  }
  // ADK-native confirmations that were not matched to a functionCall in this event still need an ask. The
  // confirmation payload itself has not been observed to carry a tool name in any recording; best-effort probe a
  // few likely keys before giving up (this branch has no real fixture — only DAK's own adk_request_confirmation
  // wrapper has been recorded — so treat the exact shape as unconfirmed).
  for (const [id, c] of Object.entries(confirmations)) {
    if (s.confirmations.has(id)) continue;
    const name = str(c?.toolName) ?? str(c?.tool) ?? str(c?.name) ?? str(c?.payload?.name) ?? "tool";
    s.confirmations.set(id, { name, args: c?.payload });
    out.push({ t: "permission.ask", id, kind: kindOf(name), tool: name, input: c?.payload ?? {}, detail: str(c?.hint) ?? summarize(name, c?.payload), toolUseId: id });
  }
  const u = ev.usageMetadata;
  if (u && typeof u === "object" && !partial) {
    const cached = num(u.cachedContentTokenCount);
    const usage = { inputTokens: Math.max(0, num(u.promptTokenCount) - cached), outputTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount), cacheReadTokens: cached, cacheWriteTokens: 0 };
    for (const k of Object.keys(usage) as Array<keyof typeof usage>) s.turnUsage[k] += usage[k];
    out.push({ t: "usage", source: "turn", model: s.model, ...usage });
  }
  if (typeof ev.errorMessage === "string" || typeof ev.errorCode === "string") {
    s.errored = `${ev.errorCode ?? "error"}: ${ev.errorMessage ?? ""}`.trim();
    out.push({ t: "error", message: s.errored });
  }
  return out;
}

/** The stream closed: report the turn's usage and end the session (unless a confirmation is still open — then the turn waits). */
export function endOfStream(s: DakParserState, status: "ok" | "error" | "aborted" = s.errored ? "error" : "ok"): AgentEvent[] {
  const out: AgentEvent[] = [];
  const u = s.turnUsage;
  if (u.inputTokens || u.outputTokens || u.cacheReadTokens) out.push({ t: "usage", source: "reported", model: s.model, ...u, costUsd: undefined });
  s.turnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  out.push({ t: "session.end", status, summary: status === "error" ? s.errored : s.lastText });
  s.lastText = undefined;
  s.errored = undefined;
  return out;
}

/** Split an SSE byte stream into `data:` payloads (events end at a blank line; multiple data lines join with \n). */
export function createSseParser() {
  let buf = "";
  return {
    feed(chunk: string): string[] {
      buf += chunk.replace(/\r\n/g, "\n");
      const out: string[] = [];
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) out.push(data);
      }
      return out;
    },
    flush(): string[] {
      const rest = buf;
      buf = "";
      const data = rest
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      return data ? [data] : [];
    },
  };
}

/* ---------- helpers ---------- */

export function kindOf(name: string): Extract<AgentEvent, { t: "permission.ask" }>["kind"] {
  const n = name.toLowerCase();
  if (/(exec|run|shell|command|bash)/.test(n)) return "exec";
  if (/(write|edit|patch|create|delete|remove|move|rename|send|pay|transfer)/.test(n)) return "write";
  if (/(fetch|http|search|browse|url)/.test(n)) return "network";
  return "other";
}

export function summarize(name: string, args: Any): string {
  if (!args || typeof args !== "object") return name;
  const keys = Object.keys(args);
  if (keys.length === 0) return name;
  const first = args[keys[0]!];
  const v = typeof first === "string" ? first : JSON.stringify(first);
  return `${name}(${keys[0]}=${truncate(String(v), 80)}${keys.length > 1 ? ", …" : ""})`;
}

function responseText(resp: Any): string {
  if (typeof resp === "string") return resp;
  if (typeof resp?.result === "string") return resp.result;
  if (Array.isArray(resp?.content)) return resp.content.map((c: Any) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  if (typeof resp?.error === "string") return resp.error;
  return JSON.stringify(resp ?? null);
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

/* ---------- outbound ---------- */

/** A user turn: the text, then the attachments' parts (`attachmentParts`). */
export function userMessage(app: string, user: string, session: string, text: string, attachmentParts: unknown[] = []): unknown {
  return { app_name: app, user_id: user, session_id: session, new_message: { role: "user", parts: [{ text }, ...attachmentParts] }, streaming: true };
}

/**
 * Attachments (#124) as message parts, one each: text files (text/*, JSON, YAML, SVG) as a text part headed by the
 * file name, everything else (images, PDF, …) as `inline_data` — DAK runs in a container and cannot open the paths in
 * the prompt. Reads the files now: a file that cannot be read throws here, before the turn is said or sent.
 */
export function attachmentParts(attachments: Attachment[] = []): unknown[] {
  return attachments.map((a) => {
    const bytes = readFileSync(a.path);
    if (a.mime.startsWith("text/") || ["application/json", "application/yaml", "image/svg+xml"].includes(a.mime)) return { text: `--- ${a.name} ---\n${bytes.toString("utf8")}` };
    return { inline_data: { mime_type: a.mime, data: bytes.toString("base64") } };
  });
}

/** Answer a confirmation the way DAK's CLI does: a functionResponse for `adk_request_confirmation` with `confirmed`. */
export function confirmationMessage(app: string, user: string, session: string, callId: string, confirmed: boolean, invocationId?: string): unknown {
  return {
    app_name: app,
    user_id: user,
    session_id: session,
    ...(invocationId ? { invocation_id: invocationId } : {}),
    new_message: { role: "user", parts: [{ functionResponse: { id: callId, name: "adk_request_confirmation", response: { confirmed } } }] },
    streaming: true,
  };
}
