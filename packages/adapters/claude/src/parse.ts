import type { AgentEvent, PermissionKind } from "@switchboard/protocol";

/**
 * Pure mapping from Claude Code `--output-format stream-json` lines to AgentEvent.
 * Wire facts (verified against Claude Code 2.1.261, see docs/design/claude-stream-json.md):
 *  - system/init            → session.start
 *  - system/background_tasks_changed → background (count of the jobs left; verified on 2.1.308)
 *  - stream_event/*         → message.delta (text_delta), usage (message_delta.usage, source=turn)
 *  - assistant              → tool.call (tool_use blocks); text only if not already streamed
 *  - user (tool_result)     → tool.result
 *  - control_request        → permission.ask (subtype can_use_tool)
 *  - rate_limit_event       → quota
 *  - result                 → usage (source=reported, total_cost_usd) + session.end
 */
export interface ClaudeParserState {
  currentMessageId?: string;
  streamedMessageIds: Set<string>;
  seenToolCalls: Set<string>;
  /** tool_use id → {name, path} for write-class tools, so a successful tool_result can become artifact(diff). */
  writes: Map<string, { name: string; path: string }>;
}

export function createClaudeParserState(): ClaudeParserState {
  return { streamedMessageIds: new Set(), seenToolCalls: new Set(), writes: new Map() };
}

export function createClaudeParser() {
  const state = createClaudeParserState();
  return {
    state,
    feed(line: string): AgentEvent[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return [{ t: "status", text: `unparsed: ${trimmed.slice(0, 200)}` }];
      }
      return mapClaudeMessage(msg, state);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function mapClaudeMessage(m: Any, s: ClaudeParserState): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!m || typeof m !== "object") return out;
  switch (m.type) {
    case "system": {
      if (m.subtype === "init") {
        out.push({
          t: "session.start",
          runner: "claude",
          runnerSessionId: str(m.session_id),
          cwd: str(m.cwd) ?? "",
          model: str(m.model),
          permissionMode: str(m.permissionMode),
          runnerVersion: str(m.claude_code_version),
        });
      } else if (m.subtype === "status" && m.status) {
        out.push({ t: "status", text: String(m.status) });
      } else if (m.subtype === "status" && typeof m.permissionMode === "string") {
        // Emitted after set_permission_mode: `{type:"system", subtype:"status", status:null, permissionMode}`.
        out.push({ t: "status", text: `permission mode: ${m.permissionMode}` });
      } else if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
        out.push({ t: "background", count: m.tasks.length });
      } else if (m.subtype === "permission_denied") {
        out.push({ t: "status", text: `permission denied by runner: ${m.tool_name ?? "tool"}` });
      }
      break;
    }
    case "stream_event": {
      const e = m.event;
      if (!e) break;
      if (e.type === "message_start") {
        s.currentMessageId = str(e.message?.id);
      } else if (e.type === "content_block_delta") {
        const d = e.delta;
        if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
          if (s.currentMessageId) s.streamedMessageIds.add(s.currentMessageId);
          out.push({ t: "message.delta", role: "assistant", text: d.text, messageId: s.currentMessageId });
        }
      } else if (e.type === "message_delta" && e.usage) {
        out.push({
          t: "usage",
          source: "turn",
          inputTokens: num(e.usage.input_tokens),
          outputTokens: num(e.usage.output_tokens),
          cacheReadTokens: num(e.usage.cache_read_input_tokens),
          cacheWriteTokens: num(e.usage.cache_creation_input_tokens),
          cacheWrite1hTokens: cacheWrite1h(e.usage),
        });
      }
      break;
    }
    case "assistant": {
      const msg = m.message;
      const id = str(msg?.id);
      for (const c of Array.isArray(msg?.content) ? msg.content : []) {
        if (c?.type === "tool_use" && typeof c.id === "string") {
          if (s.seenToolCalls.has(c.id)) continue;
          s.seenToolCalls.add(c.id);
          const name = String(c.name ?? "tool");
          if (permissionKindOf(name) === "write" && typeof c.input?.file_path === "string") s.writes.set(c.id, { name, path: c.input.file_path });
          out.push({ t: "tool.call", id: c.id, name, input: c.input, summary: summarizeToolInput(name, c.input) });
        } else if (c?.type === "text" && typeof c.text === "string" && c.text && !(id && s.streamedMessageIds.has(id))) {
          out.push({ t: "message.delta", role: "assistant", text: c.text, messageId: id });
        }
      }
      break;
    }
    case "user": {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "tool_result" && typeof c.tool_use_id === "string") {
            const ok = c.is_error !== true;
            out.push({ t: "tool.result", id: c.tool_use_id, ok, summary: truncate(textOf(c.content), 600) });
            // A successful Write / Edit is a change to the repository: surface it for the 差分 tab.
            const w = s.writes.get(c.tool_use_id);
            if (w && ok) out.push({ t: "artifact", kind: "diff", path: w.path });
            s.writes.delete(c.tool_use_id);
          }
        }
      }
      break;
    }
    case "control_request": {
      const r = m.request;
      if (r?.subtype === "can_use_tool" && typeof m.request_id === "string") {
        const tool = String(r.tool_name ?? "tool");
        out.push({
          t: "permission.ask",
          id: m.request_id,
          kind: permissionKindOf(tool),
          tool,
          input: r.input,
          detail: typeof r.description === "string" && r.description ? r.description : summarizeToolInput(tool, r.input),
          toolUseId: str(r.tool_use_id),
        });
      }
      break;
    }
    case "rate_limit_event": {
      const info = m.rate_limit_info;
      const w = info?.unifiedWindows;
      if (w && typeof w === "object") {
        const windows: Record<string, { utilization: number; resetsAt: number }> = {};
        for (const [k, v] of Object.entries<Any>(w)) {
          windows[k] = { utilization: num(v?.utilization), resetsAt: num(v?.resetsAt) };
        }
        // `rateLimitType` names the window Claude Code is judging by (`resetsAt` at the top repeats that window's reset);
        // `status` is its verdict. Kept so a limit stop can wait for the right window (#102).
        out.push({ t: "quota", runner: "claude", windows, status: str(info.status), limitType: str(info.rateLimitType) });
      }
      break;
    }
    case "result": {
      // `total_cost_usd` and `modelUsage` are the session's running totals, not this turn's: they grow over the turns of
      // one process and carry on after `--resume` (recorded with Claude Code 2.1.308, resume-cost.jsonl); `result.usage`
      // counts this process only and leaves out subagents. So one usage per model of `modelUsage`, marked cumulative —
      // the daemon books the difference (#2353). `modelUsage` has no 1-hour cache split; the cost is the runner's own.
      const mu = m.modelUsage && typeof m.modelUsage === "object" ? (m.modelUsage as Record<string, Any>) : {};
      for (const [model, v] of Object.entries(mu)) {
        out.push({
          t: "usage",
          source: "reported",
          model,
          inputTokens: num(v?.inputTokens),
          outputTokens: num(v?.outputTokens),
          cacheReadTokens: num(v?.cacheReadInputTokens),
          cacheWriteTokens: num(v?.cacheCreationInputTokens),
          costUsd: num(v?.costUSD),
          cumulative: true,
        });
      }
      const isError = m.is_error === true || (typeof m.subtype === "string" && m.subtype !== "success");
      out.push({
        t: "session.end",
        status: isError ? "error" : "ok",
        summary: typeof m.result === "string" ? truncate(m.result, 2000) : str(m.subtype),
        durationMs: typeof m.duration_ms === "number" ? m.duration_ms : undefined,
      });
      break;
    }
    default:
      break;
  }
  return out;
}

export function permissionKindOf(tool: string): PermissionKind {
  if (tool === "Bash" || tool === "exec") return "exec";
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) return "write";
  if (["WebFetch", "WebSearch"].includes(tool)) return "network";
  return "other";
}

export function summarizeToolInput(tool: string, input: Any): string {
  if (!input || typeof input !== "object") return tool;
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return `${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
  if (typeof input.url === "string") return input.url;
  if (typeof input.query === "string") return input.query;
  if (typeof input.description === "string") return input.description;
  const keys = Object.keys(input);
  return keys.length ? `${tool}(${keys.join(", ")})` : tool;
}

function textOf(content: Any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
/**
 * The 1-hour cache writes of a usage object: `cache_creation.ephemeral_1h_input_tokens`, which a stream
 * `message_delta` carries only per iteration (`iterations[].cache_creation`). Undefined when Claude did not say.
 */
export function cacheWrite1h(u: { cache_creation?: unknown; iterations?: unknown }): number | undefined {
  const of = (c: unknown) => (c && typeof c === "object" ? (c as { ephemeral_1h_input_tokens?: unknown }).ephemeral_1h_input_tokens : undefined);
  if (typeof of(u.cache_creation) === "number") return of(u.cache_creation) as number;
  const parts = Array.isArray(u.iterations) ? u.iterations.map((i) => of((i as { cache_creation?: unknown })?.cache_creation)).filter((n): n is number => typeof n === "number") : [];
  return parts.length ? parts.reduce((a, b) => a + b, 0) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/* ---------- outbound (host → claude) ---------- */

export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/** Registers this host as the permission prompter. Must be sent once before the first user turn. */
export function initializeLine(requestId = "init-1"): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize", hooks: {} } }) + "\n";
}

/**
 * `answers` is how an AskUserQuestion is answered (verified 2026-09-19 on 2.1.277, external recording packages/adapters/claude/fixtures/ask-user-question.jsonl (record your own outside Git with the runner-adapter-recording skill;
 * bun scripts/fixtures.ts fetch works only in a clone with the private history)):
 * `updatedInput = { ...input, answers: { [question]: label } }`, several labels of a multiSelect joined with ", ",
 * free text as is. Claude turns it into the tool result "The user answered: …". Without `answers` the tool gets
 * nothing to report, which is why a bare allow was useless for it.
 */
export function permissionResponseLine(requestId: string, decision: "allow" | "deny", input: unknown, reason?: string, answers?: Record<string, string>): string {
  const response =
    decision === "allow"
      ? { behavior: "allow", updatedInput: answers && input && typeof input === "object" ? { ...input, answers } : input }
      : { behavior: "deny", message: reason ?? "Denied by user in Switchboard" };
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n";
}

export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }) + "\n";
}

/** Switch the live session's permission mode; Claude answers with `control_response` (success `{mode}` or error). */
export function setPermissionModeLine(requestId: string, mode: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "set_permission_mode", mode } }) + "\n";
}
