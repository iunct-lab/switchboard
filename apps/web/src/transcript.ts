import type { AgentEvent, EventEnvelope } from "@switchboard/protocol";
import { fmtDuration } from "./evals.ts";

export type PermissionAsk = Extract<AgentEvent, { t: "permission.ask" }>;
export type ToolCall = Extract<AgentEvent, { t: "tool.call" }>;
export type ToolResult = Extract<AgentEvent, { t: "tool.result" }>;

/** What the `attachment` event carries; the bytes are at /api/attachments/:id. */
export type AttachmentRef = { id: string; name: string; mime: string; size: number };

/** `at` = the daemon's `ts` of the row's first event (#2254). A tool row's `endAt` is its result's; an end row's `durationMs` runs from the turn's first event. */
export type Item = (
  | { kind: "user"; key: string; text: string; attachments?: AttachmentRef[] }
  | { kind: "assistant"; key: string; text: string; messageId?: string; attachments?: AttachmentRef[] }
  | { kind: "tool"; key: string; call?: ToolCall; result?: ToolResult; ask?: PermissionAsk; decision?: "allow" | "deny"; decidedBy?: "user" | "rule" | "timeout"; endAt?: number }
  | { kind: "end"; key: string; status: "ok" | "error" | "aborted"; summary?: string; durationMs: number }
  | { kind: "note"; key: string; text: string; tone: "info" | "error" }
  /** An artifact the agent registered with its fence (#1778): the row opens it on the 成果物 tab. */
  | { kind: "artifact"; key: string; id: string; title: string }
) & { at?: number };

export interface Transcript {
  items: Item[];
  pending: PermissionAsk[];
  lastStatus?: string;
}

/** The instruction the task was started with (#1314): the first YOU row with text — a row of files alone is passed over. */
export function firstInstruction(items: Item[]): Extract<Item, { kind: "user" }> | undefined {
  return items.find((it): it is Extract<Item, { kind: "user" }> => it.kind === "user" && it.text !== "");
}

/** Fold the flat event log into what a person reads: turns, tool rows with their outcome, permission prompts. */
export function foldTranscript(events: EventEnvelope[]): Transcript {
  const items: Item[] = [];
  const toolsById = new Map<string, Extract<Item, { kind: "tool" }>>();
  const asksById = new Map<string, Extract<Item, { kind: "tool" }>>();
  const pending = new Map<string, PermissionAsk>();
  let lastStatus: string | undefined;
  // Attachments (#125) are recorded just before the user message they went with; they fold into that row. Only a
  // `status` (the daemon's scope note) or a `session.start` (a --resume restart) may sit between them; anything
  // else means the runner never echoed that turn (it failed at start), so the files get a row of their own.
  let attachments: AttachmentRef[] = [];
  let attachmentsAt = 0;
  const flush = () => {
    if (attachments.length) items.push({ kind: "user", key: `att-${attachments[0]!.id}`, at: attachmentsAt, text: "", attachments });
    attachments = [];
  };

  let assistant: Extract<Item, { kind: "assistant" }> | undefined;
  let previous: AgentEvent | undefined;
  // the turn's first event: the log's first, then the one after each session.end
  let turnStart: number | undefined;
  // core records artifact before attachment, but broadcasts the nested attachment first.
  // Use the persisted order for both live updates and reloads; do not mutate the caller's log.
  for (const { ev, seq, ts } of [...events].sort((a, b) => a.seq - b.seq)) {
    const key = String(seq);
    turnStart ??= ts;
    if (ev.t !== "attachment" && ev.t !== "status" && ev.t !== "session.start" && !(ev.t === "message.delta" && ev.role === "user")) flush();
    switch (ev.t) {
      case "attachment": {
        const ref = { id: ev.id, name: ev.name, mime: ev.mime, size: ev.size };
        // Only a registered runner file follows artifact(file): core registers absolute paths and names the attachment
        // after the file. An applied staged change records a scope-relative path. User uploads precede their user message.
        if (previous?.t === "artifact" && previous.kind === "file" && previous.path[0] === "/" && previous.path.endsWith(`/${ev.name}`)) {
          flush();
          if (!assistant) {
            assistant = { kind: "assistant", key, at: ts, text: "" };
            items.push(assistant);
          }
          (assistant.attachments ??= []).push(ref);
        } else {
          if (!attachments.length) attachmentsAt = ts;
          attachments.push(ref);
        }
        break;
      }
      case "message.delta": {
        // the reply to go on with: the last item — past the artifact rows a fence put there while the reply still streams
        // (#1778: core records artifact.saved as soon as the closing line arrives), the reply that carried the fence
        let at = items.length - 1;
        while (at >= 0 && items[at]!.kind === "artifact") at--;
        const last = items[at];
        if (ev.role === "user") {
          items.push({ kind: "user", key, at: attachments.length ? attachmentsAt : ts, text: ev.text, ...(attachments.length ? { attachments } : {}) });
          attachments = [];
          assistant = undefined;
        } else if (last?.kind === "assistant" && (!ev.messageId || !last.messageId || last.messageId === ev.messageId)) {
          last.text += ev.text;
          if (!last.messageId) last.messageId = ev.messageId;
          assistant = last;
        } else {
          assistant = { kind: "assistant", key, at: ts, text: ev.text, messageId: ev.messageId };
          items.push(assistant);
        }
        break;
      }
      case "tool.call": {
        const item: Extract<Item, { kind: "tool" }> = { kind: "tool", key, at: ts, call: ev };
        toolsById.set(ev.id, item);
        items.push(item);
        break;
      }
      case "tool.result": {
        const item = toolsById.get(ev.id);
        if (item) {
          item.result = ev;
          item.endAt = ts;
        } else items.push({ kind: "tool", key, at: ts, result: ev, endAt: ts });
        break;
      }
      case "permission.ask": {
        const item = (ev.toolUseId && toolsById.get(ev.toolUseId)) || undefined;
        if (item) {
          item.ask = ev;
          asksById.set(ev.id, item);
        } else {
          const standalone: Extract<Item, { kind: "tool" }> = { kind: "tool", key, at: ts, ask: ev };
          asksById.set(ev.id, standalone);
          items.push(standalone);
        }
        pending.set(ev.id, ev);
        break;
      }
      case "permission.resolved": {
        const item = asksById.get(ev.id);
        if (item) {
          item.decision = ev.decision;
          item.decidedBy = ev.by;
        }
        pending.delete(ev.id);
        break;
      }
      case "session.end":
        items.push({ kind: "end", key, at: ts, status: ev.status, summary: ev.summary, durationMs: ts - turnStart });
        turnStart = undefined;
        pending.clear();
        assistant = undefined;
        break;
      case "cloud.session.created":
        items.push({ kind: "note", key, at: ts, tone: "info", text: `Cloudセッションを作成: ${ev.id}。Cloud側の状態は未確認です。` });
        break;
      case "error":
        items.push({ kind: "note", key, at: ts, tone: "error", text: ev.message });
        break;
      case "status":
        lastStatus = ev.text;
        if (ev.text.startsWith("Codex 自動審査: ")) items.push({ kind: "note", key, at: ts, tone: "info", text: ev.text });
        break;
      case "artifact.saved":
        items.push({ kind: "artifact", key, at: ts, id: ev.id, title: ev.title });
        break;
      default:
        break;
    }
    previous = ev;
  }
  flush(); // a turn still starting, or one whose runner never echoed it
  return { items, pending: [...pending.values()], lastStatus };
}

/** A span as the transcript shows it (#2254): under a second is `<1 秒`, the rest as the Brief's 所要時間. */
export function spanText(ms: number): string {
  return ms < 1000 ? "<1 秒" : fmtDuration(ms);
}

// What the copy buttons put on the clipboard (#695): the raw text, as the runner wrote it, never reformatted.

/** A user or assistant row's text as it is (newlines and leading spaces kept); empty for the other rows. */
export function itemText(it: Item): string {
  return it.kind === "user" || it.kind === "assistant" ? it.text : "";
}

/** A tool row's input as the runner sent it, pretty-printed JSON; empty when the call itself was never seen. */
export function toolInputText(it: Extract<Item, { kind: "tool" }>): string {
  return it.call ? (JSON.stringify(it.call.input, null, 2) ?? "") : "";
}

export function toolResultText(it: Extract<Item, { kind: "tool" }>): string {
  return it.result?.summary ?? "";
}

/**
 * The runner's reply in the turn holding `key`: from the row after the user row before it to the row before the next
 * user row. Only assistant rows, in order, one blank line apart; `rows` is how many there were.
 */
export function turnReply(items: Item[], key: string): { text: string; rows: number } {
  const at = items.findIndex((i) => i.key === key);
  if (at < 0) return { text: "", rows: 0 };
  let start = items[at]!.kind === "user" ? at + 1 : at;
  while (start > 0 && items[start - 1]!.kind !== "user") start--;
  let end = at + 1;
  while (end < items.length && items[end]!.kind !== "user") end++;
  const texts = items.slice(start, end).flatMap((i) => (i.kind === "assistant" && i.text ? [i.text] : []));
  return { text: texts.join("\n\n"), rows: texts.length };
}

const END_LABEL = { ok: "完了", aborted: "中断", error: "エラー" } as const;

/** The whole conversation as Markdown: a heading per message, one line per tool row (no input or result) and per registered artifact, the end. */
export function transcriptMarkdown(items: Item[], runner: string): string {
  const blocks = items.map((it) => {
    switch (it.kind) {
      case "user":
      case "assistant": {
        const files = it.attachments?.length ? `添付: ${it.attachments.map((a) => a.name).join(", ")}` : "";
        return [it.kind === "user" ? "### YOU" : `### ${runner}`, it.text, files].filter(Boolean).join("\n\n");
      }
      case "tool": {
        const name = it.call?.name ?? it.ask?.tool ?? "tool";
        const summary = it.call?.summary ?? it.ask?.detail ?? "";
        const mark = it.result ? (it.result.ok ? "✓" : "✕") : "…";
        // one line per tool row: a multi-line command's summary keeps its newlines
        return `- ${[name, summary.replace(/\s+/g, " ").trim(), mark].filter(Boolean).join(" ")}`;
      }
      case "artifact":
        return `- 成果物: ${it.title.replace(/\s+/g, " ").trim()}`;
      case "end":
        return `— ${END_LABEL[it.status]}${it.status !== "ok" && it.summary ? `: ${it.summary}` : ""} —`;
      case "note":
        return it.text;
    }
  });
  return blocks.join("\n\n");
}
