import type { AgentEvent } from "@switchboard/protocol";
import { cacheWrite1h, permissionKindOf, summarizeToolInput } from "./parse.ts";

/**
 * Pure mapping from Claude Code's own session log to AgentEvent (issue #91).
 *
 * Claude Code writes every session — the interactive terminal as much as `claude -p` — to
 * `~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<sessionId>.jsonl`, one JSON
 * record per line. Switchboard already depends on that folder for `--resume`; reading it is what lets a session
 * that was run in a terminal show up next to the tasks Switchboard started itself.
 *
 * Record shapes (verified against Claude Code 2.1.208–2.1.265 logs, 2026-08..09; see docs/design/claude-stream-json.md):
 *  - `user` / `assistant`     the conversation. `message.content` is a string (a typed prompt) or content blocks
 *                             (text / thinking / tool_use / tool_result). An assistant message is logged as one
 *                             record per content block, all sharing `message.id`, `stop_reason` and `usage`; the
 *                             records of one message are only ever interleaved with its own tool results and
 *                             attachments, never with another assistant message.
 *  - `entrypoint`             `cli` = the terminal; `sdk-cli` = a host driving `claude -p` (Switchboard itself, or
 *                             another program). Only `cli` records are terminal history; the host records its own.
 *  - `remoteSourced: true`   Teleport conversation records still carry `entrypoint: cli`; this metadata
 *                             does not change message, tool or usage parsing (Task #1127 observation).
 *  - `isMeta` / `isCompactSummary` / `promptSource: system`   injected by Claude Code, not written by a person.
 *  - `message.model: "<synthetic>"`   text Claude Code produced itself (a rate-limit banner), not a model answer.
 *  - `ai-title`, `permission-mode`, `cost-state`, `attachment`, `system`, `queue-operation`, …   session metadata.
 *
 * There is no `result` line: a turn ends when an assistant message stops with `end_turn` / `stop_sequence` /
 * `refusal`, a person interrupts (`[Request interrupted by user…]` text block), or the next typed prompt arrives.
 */
export interface TimedEvent {
  /** The record's own timestamp (ms), so the imported transcript keeps the time it happened, not the import time. */
  ts: number;
  ev: AgentEvent;
}

export interface ClaudeHistoryState {
  sessionId?: string;
  cwd?: string;
  version?: string;
  /** Latest `ai-title` — Claude Code's own name for the session. */
  title?: string;
  /** Latest `permission-mode` record (or the mode carried on a typed prompt). */
  permissionMode?: string;
  /** Model of the first assistant message (later messages may switch; the task records the first). */
  model?: string;
  firstTs?: number;
  lastTs?: number;
  /** `entrypoint` values seen on records that carry one. */
  entrypoints: Set<string>;
  /** Whether the `session.start` for this file has been emitted. */
  started: boolean;
  /** The assistant message whose records are arriving now; its tool_use ids, so a repeated record cannot add a tool row twice. */
  currentMessageId?: string;
  currentToolIds: Set<string>;
  /** The last message whose usage was emitted (one record per content block repeats the same usage). */
  lastUsageMessageId?: string;
  /** tool_use id → path for write-class tools, so a successful result becomes artifact(diff). Cleared by the result. */
  writes: Map<string, string>;
  /** Assistant output since the last session.end: the next typed prompt closes the turn. */
  turnOpen: boolean;
  /** The message that stopped the turn; its session.end goes out once a record of another message arrives, or at flush(). */
  endPending?: { messageId: string; ts: number; status: "ok" | "error"; summary?: string };
  /** The message whose end was already emitted, so a late record of it (a slice boundary inside the message) cannot end the turn again. */
  closedMessageId?: string;
}

export function createClaudeHistoryState(): ClaudeHistoryState {
  return { entrypoints: new Set(), started: false, currentToolIds: new Set(), writes: new Map(), turnOpen: false };
}

/** `entrypoint: "cli"` — written by the interactive terminal (an SDK host records what it drives itself). */
export function isTerminalRecord(rec: unknown): boolean {
  return !!rec && typeof rec === "object" && (rec as { entrypoint?: unknown }).entrypoint === "cli";
}

/** The folder name Claude Code derives from a cwd: every character outside [A-Za-z0-9] becomes "-". */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * `saved` is the JSON from `serializeHistoryState()` of an earlier run over the same file: the importer reads a
 * growing log in slices (and across daemon restarts), and a message whose blocks straddle a slice must not count
 * its usage twice, lose its Write → artifact link, restart the turn bookkeeping, or announce the session again.
 * Throws on a corrupt `saved`: continuing from the caller's byte offset with a fresh state would do all of that.
 */
export function createClaudeHistoryParser(saved?: string | null) {
  const state = restoreHistoryState(saved);
  return {
    state,
    /** One log line → zero or more events. Unparseable lines are skipped (the log is written by another program). */
    feed(line: string): TimedEvent[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        return [];
      }
      return mapClaudeLogRecord(rec, state);
    },
    /** Close a turn whose end was the last thing in the file (nothing after it to trigger the deferred end). */
    flush(): TimedEvent[] {
      return flushEnd(state);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const STATE_VERSION = 1;

/** Parser state as JSON (Sets and Maps as arrays; bounded: nothing here grows with the length of the session). */
export function serializeHistoryState(s: ClaudeHistoryState): string {
  return JSON.stringify({ v: STATE_VERSION, ...s, entrypoints: [...s.entrypoints], currentToolIds: [...s.currentToolIds], writes: [...s.writes] });
}

/**
 * Inverse of serializeHistoryState(). Empty input is a fresh state; anything else that is not a state written by
 * this version throws (the caller must not read on from its offset with a fresh state).
 */
export function restoreHistoryState(json: string | null | undefined): ClaudeHistoryState {
  const fresh = createClaudeHistoryState();
  if (!json) return fresh;
  let j: Any;
  try {
    j = JSON.parse(json);
  } catch (e) {
    throw new Error(`saved parser state is not JSON: ${String((e as Error).message ?? e)}`);
  }
  if (!j || typeof j !== "object" || j.v !== STATE_VERSION) throw new Error(`saved parser state is not version ${STATE_VERSION}`);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const end = j.endPending;
  return {
    ...fresh,
    sessionId: str(j.sessionId),
    cwd: str(j.cwd),
    version: str(j.version),
    title: str(j.title),
    permissionMode: str(j.permissionMode),
    model: str(j.model),
    firstTs: typeof j.firstTs === "number" ? j.firstTs : undefined,
    lastTs: typeof j.lastTs === "number" ? j.lastTs : undefined,
    entrypoints: new Set(strs(j.entrypoints)),
    started: j.started === true,
    currentMessageId: str(j.currentMessageId),
    currentToolIds: new Set(strs(j.currentToolIds)),
    lastUsageMessageId: str(j.lastUsageMessageId),
    writes: new Map(Array.isArray(j.writes) ? j.writes.filter((e: unknown) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") : []),
    turnOpen: j.turnOpen === true,
    endPending: end && typeof end.messageId === "string" && typeof end.ts === "number" ? { messageId: end.messageId, ts: end.ts, status: end.status === "error" ? "error" : "ok", summary: str(end.summary) } : undefined,
    closedMessageId: str(j.closedMessageId),
  };
}

/** Whether a serialized state still owes a `session.end` (an end_turn seen, not yet emitted) — without restoring it. */
export function hasPendingEnd(saved: string | null | undefined): boolean {
  if (!saved) return false;
  try {
    const j = JSON.parse(saved) as { endPending?: unknown };
    return !!j && typeof j === "object" && !!j.endPending && typeof j.endPending === "object";
  } catch {
    return false;
  }
}

const HUMAN_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);
/** stop_reason values that end the turn (max_tokens does not: Claude Code continues the message). */
const END_REASONS: Record<string, "ok" | "error"> = { end_turn: "ok", stop_sequence: "ok", refusal: "error" };

export function mapClaudeLogRecord(rec: Any, s: ClaudeHistoryState): TimedEvent[] {
  if (!rec || typeof rec !== "object") return [];
  if (typeof rec.sessionId === "string" && !s.sessionId) s.sessionId = rec.sessionId;
  // Session metadata carries no entrypoint and applies to the file as a whole.
  if (rec.type === "ai-title") {
    if (typeof rec.aiTitle === "string" && rec.aiTitle.trim()) s.title = rec.aiTitle.trim();
    return [];
  }
  if (rec.type === "permission-mode") {
    if (typeof rec.permissionMode === "string") s.permissionMode = rec.permissionMode;
    return [];
  }
  if (typeof rec.entrypoint === "string") s.entrypoints.add(rec.entrypoint);
  if (!isTerminalRecord(rec)) return [];
  if (rec.isSidechain === true) return [];

  const ts = timestampOf(rec, s);
  if (s.firstTs === undefined) s.firstTs = ts;
  s.lastTs = ts;
  if (typeof rec.cwd === "string" && !s.cwd) s.cwd = rec.cwd;
  if (typeof rec.version === "string" && !s.version) s.version = rec.version;

  const out: TimedEvent[] = [];
  const msgId = rec.type === "assistant" ? str(rec.message?.id) : undefined;
  // A record of another message means the message that stopped the turn is complete: close the turn before anything else.
  if (s.endPending && s.endPending.messageId !== msgId) out.push(...flushEnd(s));

  switch (rec.type) {
    case "user": {
      if (rec.isMeta === true || rec.isCompactSummary === true) break;
      const content = rec.message?.content;
      if (typeof content === "string") {
        if (isHumanPrompt(rec, content)) out.push(...humanPrompt(rec, content, ts, s));
        break;
      }
      if (!Array.isArray(content)) break;
      for (const c of content) {
        if (c?.type === "tool_result" && typeof c.tool_use_id === "string") {
          const ok = c.is_error !== true;
          out.push({ ts, ev: { t: "tool.result", id: c.tool_use_id, ok, summary: truncate(textOf(c.content), 600) } });
          const path = s.writes.get(c.tool_use_id);
          if (path && ok) out.push({ ts, ev: { t: "artifact", kind: "diff", path } });
          s.writes.delete(c.tool_use_id);
        } else if (c?.type === "text" && typeof c.text === "string") {
          if (c.text.startsWith("[Request interrupted by user")) {
            // The person pressed Esc: the turn in flight is over, whatever was pending.
            s.endPending = undefined;
            s.turnOpen = false;
            out.push({ ts, ev: { t: "session.end", status: "aborted", summary: c.text } });
          } else if (isHumanPrompt(rec, c.text) && c.text.trim()) {
            out.push(...humanPrompt(rec, c.text, ts, s));
          }
        }
      }
      break;
    }
    case "assistant": {
      const msg = rec.message;
      if (!msg || typeof msg !== "object") break;
      const model = str(msg.model);
      // "<synthetic>": Claude Code's own text (a session-limit banner), not an answer — shown as an error, no usage.
      const synthetic = !model || model === "<synthetic>";
      if (!synthetic && !s.model) s.model = model;
      out.push(...ensureStarted(ts, s));
      if (msgId !== s.currentMessageId) {
        s.currentMessageId = msgId;
        s.currentToolIds = new Set();
      }
      // A late record of a message whose end was already emitted (slice boundary inside the message) is more of
      // the same turn, not a new one.
      const closed = msgId !== undefined && msgId === s.closedMessageId;
      if (!closed) s.turnOpen = true;
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c?.type === "tool_use" && typeof c.id === "string") {
          if (s.currentToolIds.has(c.id)) continue;
          s.currentToolIds.add(c.id);
          const name = String(c.name ?? "tool");
          if (permissionKindOf(name) === "write" && typeof c.input?.file_path === "string") s.writes.set(c.id, c.input.file_path);
          out.push({ ts, ev: { t: "tool.call", id: c.id, name, input: c.input, summary: summarizeToolInput(name, c.input) } });
        } else if (c?.type === "text" && typeof c.text === "string" && c.text) {
          if (synthetic) out.push({ ts, ev: { t: "error", message: c.text } });
          else out.push({ ts, ev: { t: "message.delta", role: "assistant", text: c.text, messageId: msgId } });
        }
        // thinking blocks are not part of what a person reads back
      }
      // One record per content block, each repeating the message's usage: count it once per message.
      const u = msg.usage;
      if (u && msgId && msgId !== s.lastUsageMessageId && !synthetic) {
        s.lastUsageMessageId = msgId;
        const usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens) };
        if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0) {
          out.push({ ts, ev: { t: "usage", source: "turn", model, ...usage, cacheWrite1hTokens: cacheWrite1h(u) } });
        }
      }
      const reason = typeof msg.stop_reason === "string" ? END_REASONS[msg.stop_reason] : undefined;
      if (msgId && reason && !closed) {
        const banner = synthetic ? firstText(msg.content) : undefined;
        s.endPending = { messageId: msgId, ts, status: synthetic ? "error" : reason, summary: banner ?? (msg.stop_reason === "refusal" ? "refusal" : undefined) };
      }
      break;
    }
    default:
      // system/turn_duration, attachment, queue-operation, file-history-*, cost-state, …: nothing a transcript shows.
      break;
  }
  return out;
}

/**
 * A prompt a person typed (or queued / accepted), as opposed to text Claude Code injected on their behalf.
 * Records without `origin` / `promptSource` (older versions, `!` shell lines, slash commands) are the person's when
 * they are plain text; the tagged ones (`<bash-input>`, `<bash-stdout>`, `<command-name>`, `<local-command-stdout>`)
 * are the terminal's own bookkeeping of local commands.
 */
function isHumanPrompt(rec: Any, text: string): boolean {
  if (rec.origin && typeof rec.origin === "object") return rec.origin.kind === "human";
  if (typeof rec.promptSource === "string") return HUMAN_SOURCES.has(rec.promptSource);
  return rec.isMeta !== true && !text.trimStart().startsWith("<");
}

function humanPrompt(rec: Any, text: string, ts: number, s: ClaudeHistoryState): TimedEvent[] {
  const out: TimedEvent[] = [];
  if (typeof rec.permissionMode === "string") s.permissionMode = rec.permissionMode;
  out.push(...ensureStarted(ts, s));
  // A new prompt while the previous turn never announced its end (context ran out, the process died): close it.
  if (s.turnOpen) {
    s.endPending = undefined;
    s.turnOpen = false;
    out.push({ ts, ev: { t: "session.end", status: "ok" } });
  }
  out.push({ ts, ev: { t: "message.delta", role: "user", text } });
  return out;
}

function ensureStarted(ts: number, s: ClaudeHistoryState): TimedEvent[] {
  if (s.started) return [];
  s.started = true;
  // The first record is the person's prompt, so the model is not known yet; the task takes it from state.model.
  return [{ ts, ev: { t: "session.start", runner: "claude", runnerSessionId: s.sessionId, cwd: s.cwd ?? "", model: s.model, permissionMode: s.permissionMode, runnerVersion: s.version } }];
}

function flushEnd(s: ClaudeHistoryState): TimedEvent[] {
  if (!s.endPending) return [];
  const { ts, status, summary, messageId } = s.endPending;
  s.endPending = undefined;
  s.turnOpen = false;
  s.closedMessageId = messageId;
  return [{ ts, ev: summary ? { t: "session.end", status, summary } : { t: "session.end", status } }];
}

function timestampOf(rec: Any, s: ClaudeHistoryState): number {
  const t = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  if (Number.isFinite(t)) return t;
  return s.lastTs ?? Date.now();
}

function firstText(content: Any): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const c = content.find((b) => b?.type === "text" && typeof b.text === "string" && b.text);
  return c ? truncate(c.text, 300) : undefined;
}

function textOf(content: Any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
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
