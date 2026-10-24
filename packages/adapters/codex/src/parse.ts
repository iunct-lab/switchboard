import type { AgentEvent, PermissionKind } from "@switchboard/protocol";
import type { AccountRateLimitsUpdatedNotification } from "./generated/v2/AccountRateLimitsUpdatedNotification";
import type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification";
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams";
import type { ErrorNotification } from "./generated/v2/ErrorNotification";
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { ThreadStartedNotification } from "./generated/v2/ThreadStartedNotification";
import type { ThreadStatusChangedNotification } from "./generated/v2/ThreadStatusChangedNotification";
import type { ThreadTokenUsageUpdatedNotification } from "./generated/v2/ThreadTokenUsageUpdatedNotification";
import type { TokenUsageBreakdown } from "./generated/v2/TokenUsageBreakdown";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification";
import type { TurnStartedNotification } from "./generated/v2/TurnStartedNotification";

/**
 * Pure mapping from `codex app-server` JSON-RPC lines (server → client) to AgentEvent.
 * Wire facts (recorded against codex-cli 0.148.0-alpha.9, fixtures in ../fixtures):
 *  - thread/started (or the thread/start | thread/resume result)  → session.start
 *  - item/started   commandExecution | fileChange | mcpToolCall    → tool.call
 *  - item/completed same                                          → tool.result (+ artifact(diff) for fileChange)
 *  - item/agentMessage/delta                                      → message.delta (assistant); item/completed fills in un-streamed text
 *  - item/commandExecution/requestApproval, item/fileChange/requestApproval (server *requests*, carry a JSON-RPC id) → permission.ask
 *  - thread/tokenUsage/updated                                    → usage(turn)   (per-call `last`)
 *  - turn/completed                                               → usage(reported) for the turn (Δ of `total`) + session.end
 *  - account/rateLimits/updated                                   → quota (primary 5h / secondary 7d as five_hour / seven_day)
 *  - error                                                        → error (or status when willRetry)
 */
export interface CodexParserState {
  threadId?: string;
  activeTurnId?: string;
  sessionStarted: boolean;
  /** agentMessage item ids that already streamed deltas (item/completed must not repeat them). */
  streamed: Set<string>;
  /** itemId → human summary, so file-change approvals (which carry no diff) can show what they are about. */
  toolSummaries: Map<string, string>;
  /** itemId → paths of a fileChange item, so its approval request carries structured paths for approval rules. */
  toolPaths: Map<string, string[]>;
  /** Sum of `last` breakdowns for the active turn → usage(reported) at turn/completed. */
  turnUsage?: TokenUsageBreakdown;
  lastAgentText?: string;
  model?: string;
}

export function createCodexParserState(): CodexParserState {
  return { sessionStarted: false, streamed: new Set(), toolSummaries: new Map(), toolPaths: new Map() };
}

export function createCodexParser() {
  const state = createCodexParserState();
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
      return mapCodexMessage(msg, state);
    },
    /** For the thread/start | thread/resume *response* (responses are correlated by the session, not the stream). */
    threadStarted(thread: Thread): AgentEvent[] {
      return threadStartedEvents(thread, state);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Server → client message. Responses (id without method) are the session's business and yield nothing here. */
export function mapCodexMessage(m: Any, s: CodexParserState): AgentEvent[] {
  if (!m || typeof m !== "object" || typeof m.method !== "string") return [];
  const p = m.params ?? {};
  if (m.id !== undefined && m.id !== null) return mapServerRequest(String(m.id), m.method, p, s);
  switch (m.method) {
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed": {
      // Recorded with codex-cli 0.155.0-alpha.2.6: audit notifications, not human approval requests.
      const review = p.review ?? {};
      const action = typeof p.action?.command === "string" ? p.action.command : p.targetItemId;
      const status = review.status ?? (m.method.endsWith("/started") ? "inProgress" : "unknown");
      return [{ t: "status", text: `Codex 自動審査: ${status}${action ? ` — ${action}` : ""}${typeof review.rationale === "string" ? ` — ${review.rationale}` : ""}` }];
    }
    case "thread/started":
      return threadStartedEvents((p as ThreadStartedNotification).thread, s);
    case "thread/status/changed": {
      const st = (p as ThreadStatusChangedNotification).status;
      return [{ t: "status", text: `thread ${st.type}` }];
    }
    case "turn/started": {
      const turn = (p as TurnStartedNotification).turn;
      s.activeTurnId = turn.id;
      s.turnUsage = undefined;
      s.lastAgentText = undefined;
      return [{ t: "status", text: "turn started" }];
    }
    case "item/started":
      return itemStarted((p as ItemStartedNotification).item, s);
    case "item/agentMessage/delta": {
      const d = p as AgentMessageDeltaNotification;
      s.streamed.add(d.itemId);
      return [{ t: "message.delta", role: "assistant", text: d.delta, messageId: d.itemId }];
    }
    case "item/completed":
      return itemCompleted((p as ItemCompletedNotification).item, s);
    case "thread/tokenUsage/updated": {
      const n = p as ThreadTokenUsageUpdatedNotification;
      // After thread/resume Codex replays the previous turn's usage before turn/started; ignore anything not from the
      // active turn so it is neither double-counted nor charged to this turn.
      if (!s.activeTurnId || n.turnId !== s.activeTurnId) return [];
      s.turnUsage = addUsage(s.turnUsage, n.tokenUsage.last);
      return [usageEvent("turn", n.tokenUsage.last, s.model)];
    }
    case "account/rateLimits/updated": {
      const r = (p as AccountRateLimitsUpdatedNotification).rateLimits;
      const windows: Record<string, { utilization: number; resetsAt: number }> = {};
      for (const [slot, w] of [["primary", r.primary], ["secondary", r.secondary]] as const) {
        if (!w) continue;
        windows[windowName(w.windowDurationMins, slot)] = { utilization: (w.usedPercent ?? 0) / 100, resetsAt: w.resetsAt ?? 0 };
      }
      return Object.keys(windows).length ? [{ t: "quota", runner: "codex", windows }] : [];
    }
    case "turn/completed": {
      const turn = (p as TurnCompletedNotification).turn;
      s.activeTurnId = undefined;
      const out: AgentEvent[] = [];
      if (s.turnUsage) out.push(usageEvent("reported", s.turnUsage, s.model));
      s.turnUsage = undefined;
      const status = turn.status === "completed" ? "ok" : turn.status === "interrupted" ? "aborted" : "error";
      out.push({ t: "session.end", status, summary: turn.error?.message ?? s.lastAgentText, durationMs: turn.durationMs ?? undefined });
      return out;
    }
    case "error": {
      const e = p as ErrorNotification;
      const text = e.error?.message ?? "codex error";
      return e.willRetry ? [{ t: "status", text: `retrying: ${text}` }] : [{ t: "error", message: text }];
    }
    default:
      return [];
  }
}

export function threadStartedEvents(thread: Thread, s: CodexParserState): AgentEvent[] {
  s.threadId = thread.id;
  if (s.sessionStarted) return [];
  s.sessionStarted = true;
  return [
    {
      t: "session.start",
      runner: "codex",
      runnerSessionId: thread.id,
      cwd: thread.cwd,
      model: s.model,
      runnerVersion: thread.cliVersion ?? undefined,
    },
  ];
}

function mapServerRequest(id: string, method: string, p: Any, s: CodexParserState): AgentEvent[] {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const r = p as CommandExecutionRequestApprovalParams;
      const friendly = (r.commandActions ?? []).map((a: Any) => a.command).filter(Boolean).join(" && ") || r.command || "command";
      return [
        {
          t: "permission.ask",
          id,
          kind: "exec",
          tool: "exec",
          input: { command: r.command, cwd: r.cwd, reason: r.reason ?? undefined },
          detail: r.reason ? `${friendly} — ${r.reason}` : friendly,
          toolUseId: r.itemId,
        },
      ];
    }
    case "item/fileChange/requestApproval": {
      const r = p as FileChangeRequestApprovalParams;
      return [
        {
          t: "permission.ask",
          id,
          kind: "write",
          tool: "fileChange",
          input: { itemId: r.itemId, grantRoot: r.grantRoot ?? undefined, reason: r.reason ?? undefined, changes: (s.toolPaths.get(r.itemId) ?? []).map((path) => ({ path })) },
          detail: s.toolSummaries.get(r.itemId) ?? r.reason ?? r.grantRoot ?? "file change",
          toolUseId: r.itemId,
        },
      ];
    }
    default:
      // Anything else (permission profiles, user input, elicitation, tool calls back into the client) is answered by
      // the session with a JSON-RPC error: no fixture covers them yet, so we do not guess their response shape.
      return [{ t: "status", text: `unsupported server request: ${method}` }];
  }
}

function itemStarted(item: ThreadItem, s: CodexParserState): AgentEvent[] {
  switch (item.type) {
    case "commandExecution": {
      const summary = commandSummary(item);
      s.toolSummaries.set(item.id, summary);
      return [{ t: "tool.call", id: item.id, name: "exec", input: { command: item.command, cwd: item.cwd }, summary }];
    }
    case "fileChange": {
      const paths = item.changes.map((c) => c.path);
      const summary = paths.join(", ") || "file change";
      s.toolSummaries.set(item.id, summary);
      s.toolPaths.set(item.id, paths);
      return [{ t: "tool.call", id: item.id, name: "fileChange", input: { changes: item.changes.map((c) => ({ path: c.path, kind: c.kind })) }, summary }];
    }
    case "mcpToolCall": {
      const summary = `${item.server}.${item.tool}`;
      s.toolSummaries.set(item.id, summary);
      return [{ t: "tool.call", id: item.id, name: summary, input: item.arguments, summary }];
    }
    case "webSearch":
      return [{ t: "tool.call", id: item.id, name: "webSearch", input: item, summary: str((item as Any).query) ?? "web search" }];
    case "reasoning":
      return [{ t: "status", text: "thinking" }];
    default:
      return [];
  }
}

function itemCompleted(item: ThreadItem, s: CodexParserState): AgentEvent[] {
  switch (item.type) {
    case "agentMessage": {
      if (item.phase !== "commentary") s.lastAgentText = item.text;
      if (s.streamed.has(item.id) || !item.text) return [];
      return [{ t: "message.delta", role: "assistant", text: item.text, messageId: item.id }];
    }
    case "commandExecution": {
      const ok = item.status === "completed" && (item.exitCode ?? 0) === 0;
      const summary = item.status === "declined" ? "declined" : truncate((item.aggregatedOutput ?? "").trim() || `${item.status}${item.exitCode != null ? ` (exit ${item.exitCode})` : ""}`, 600);
      return [{ t: "tool.result", id: item.id, ok, summary }];
    }
    case "fileChange": {
      const ok = item.status === "completed";
      const out: AgentEvent[] = [{ t: "tool.result", id: item.id, ok, summary: item.status }];
      if (ok) for (const c of item.changes) out.push({ t: "artifact", kind: "diff", path: c.path, stat: diffStat(c.diff) });
      return out;
    }
    case "mcpToolCall": {
      const ok = item.status === "completed" && !item.error;
      const summary = item.error?.message ?? truncate(JSON.stringify(item.result ?? null), 600);
      return [{ t: "tool.result", id: item.id, ok, summary }];
    }
    case "webSearch":
      return [{ t: "tool.result", id: item.id, ok: true, summary: "done" }];
    default:
      return [];
  }
}

/* ---------- helpers ---------- */

export function commandSummary(item: Extract<ThreadItem, { type: "commandExecution" }>): string {
  const friendly = (item.commandActions ?? []).map((a: Any) => a.command).filter((c: unknown): c is string => typeof c === "string" && c.length > 0);
  return friendly.length ? friendly.join(" && ") : item.command;
}

export function windowName(mins: number | null, slot: "primary" | "secondary" = "primary"): string {
  if (mins === 300) return "five_hour";
  if (mins === 10080) return "seven_day";
  return mins ? `${mins}m` : slot;
}

function usageEvent(source: "turn" | "reported", u: TokenUsageBreakdown, model?: string): AgentEvent {
  const cached = u.cachedInputTokens ?? 0;
  return {
    t: "usage",
    source,
    model,
    inputTokens: Math.max(0, (u.inputTokens ?? 0) - cached),
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: u.cacheWriteInputTokens ?? 0,
    // Codex reports tokens only. Pricing (API-equivalent) is applied by the ledger from pricing.json.
    costUsd: undefined,
  };
}

function addUsage(acc: TokenUsageBreakdown | undefined, u: TokenUsageBreakdown): TokenUsageBreakdown {
  const z = (k: keyof TokenUsageBreakdown) => (acc?.[k] ?? 0) + (u[k] ?? 0);
  return {
    totalTokens: z("totalTokens"),
    inputTokens: z("inputTokens"),
    cachedInputTokens: z("cachedInputTokens"),
    cacheWriteInputTokens: z("cacheWriteInputTokens"),
    outputTokens: z("outputTokens"),
    reasoningOutputTokens: z("reasoningOutputTokens"),
  };
}

export function diffStat(diff: string): string {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return `+${add} −${del}`;
}

export function permissionKindOf(tool: string): PermissionKind {
  return tool === "exec" ? "exec" : tool === "fileChange" ? "write" : "other";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/* ---------- outbound (host → codex) ---------- */

export const CLIENT_INFO = { name: "switchboard", title: "Switchboard", version: "0.0.1" };

export function jsonRpcRequest(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}
export function jsonRpcNotification(method: string, params?: unknown): string {
  return JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }) + "\n";
}
export function jsonRpcResult(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: /^\d+$/.test(String(id)) ? Number(id) : id, result }) + "\n";
}
export function jsonRpcError(id: string | number, message: string, code = -32601): string {
  return JSON.stringify({ jsonrpc: "2.0", id: /^\d+$/.test(String(id)) ? Number(id) : id, error: { code, message } }) + "\n";
}

/** Switchboard permission decision → Codex approval decision. */
export function approvalDecision(decision: "allow" | "deny"): { decision: "accept" | "decline" } {
  return { decision: decision === "allow" ? "accept" : "decline" };
}
