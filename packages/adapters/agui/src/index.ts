import type { AgentEvent, PermissionDecision, RunnerAdapter, RunnerDetection, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { createAguiState, createSseParser, mapAguiEvent } from "./parse.ts";

export * from "./parse.ts";

/**
 * A runner for one AG-UI server (https://docs.ag-ui.com, 1.0): one adapter per configured endpoint. Each turn is one
 * `POST baseUrl` of a `RunAgentInput`, answered with SSE (mapped in parse.ts). No AG-UI SDK, nothing of any one agent's
 * (docs/design/custom-adapter.md).
 *
 * The session: `threadId` is the session id; `messages` is the whole history the agent is shown, held here in memory
 * only, so after a restart `hasSession` is false and the daemon starts a new session with a recap. A run that ends in
 * `outcome: interrupt` leaves its interrupts open; the answers go in `resume` of the next run on the same thread.
 */
export interface AguiAdapterOptions {
  /** The runner's id: `RunnerAdapter.id` and `session.start.runner`. */
  id: RunnerId;
  /** The name the person knows this runner by. */
  label: string;
  /** The URL the `RunAgentInput` is posted to. */
  baseUrl: string;
  /** Name of the environment variable holding a bearer token. Read on every request; the value is never kept or logged. Unset or empty sends no header. */
  tokenEnv?: string;
  /** Hand the Task's `mcpServers` (Workspace MCP endpoint and token) to the agent in `forwardedProps.switchboard`. Off by default: it sends a credential. */
  sendWorkspaceMcp?: boolean;
  /** Request timeout for `detect`. */
  timeoutMs?: number;
  /** How long the stream may go without a byte before the turn is treated as dead (as in the ADK adapter). Default 2 h. */
  streamIdleTimeoutMs?: number;
}

const DEFAULTS = { timeoutMs: 10_000, streamIdleTimeoutMs: 2 * 60 * 60_000 };
type ResolvedOptions = AguiAdapterOptions & typeof DEFAULTS;

/** The bearer header of one request, from the environment each time: a rotated token needs no restart, and the value stays out of the options. */
function authHeaders(o: { tokenEnv?: string }): Record<string, string> {
  const token = o.tokenEnv ? process.env[o.tokenEnv] : undefined;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function createAguiAdapter(options: AguiAdapterOptions): RunnerAdapter {
  const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const o = { ...DEFAULTS, ...defined } as ResolvedOptions;
  return {
    id: o.id,
    label: o.label,
    // The agent decides what to ask (interrupts); Switchboard has no knob for it.
    permissionModes: [],
    // AG-UI has no way to ask for a server's state. Reachability only: any HTTP answer means something listens (a POST-only
    // route answers GET with 405, an authenticated one with 401). The note is always set: the runner list reads a runner
    // with no note as DAK (apps/web/src/components/Home.tsx).
    async detect(): Promise<RunnerDetection> {
      try {
        const r = await fetch(o.baseUrl, { method: "GET", headers: authHeaders(o), signal: AbortSignal.timeout(o.timeoutMs) });
        await r.body?.cancel().catch(() => {});
        if (r.status >= 500) return { available: false, note: `${o.label} at ${o.baseUrl} → HTTP ${r.status}` };
        return { available: true, version: "ag-ui", path: o.baseUrl, note: `AG-UI at ${o.baseUrl} (reachable)` };
      } catch (e) {
        return { available: false, note: `${o.label} agent not reachable at ${o.baseUrl} (${String((e as Error).message ?? e)})` };
      }
    },
    start(opts, emit) {
      return new AguiSession(o, opts, emit);
    },
    // The history lives in the session object only.
    hasSession: () => false,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Message = Record<string, unknown>;
type ResumeItem = { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown };

interface PendingInterrupt {
  kind: "permission" | "question";
  /** The boolean property of `responseSchema` that says allow / deny (permission only). */
  approveKey?: string;
  schema?: Any;
}

const APPROVE_NAMES = /^(approved?|allow(ed)?|confirm(ed)?|accept(ed)?|ok|yes)$/i;

/**
 * Whether a schema says nothing beyond its type (and names, notes, and for an object its properties and which are
 * required): any other keyword (`const`, `enum`, `oneOf`, `not`, `pattern`, …) may rule out one of the answers this
 * adapter would send, so such a schema is not filled in — it becomes a question, answered with `cancelled`.
 */
const PLAIN = new Set(["type", "title", "description", "properties", "required", "additionalProperties", "$schema"]);
function plain(schema: Any, type: string): boolean {
  if (!schema || typeof schema !== "object" || schema.type !== type) return false;
  if (!Object.keys(schema).every((k) => PLAIN.has(k))) return false;
  return type !== "object" || (typeof schema.properties === "object" && !!schema.properties);
}

/**
 * The boolean property an approval answer sets, or undefined when the schema is not one a yes / no can fill. Only a
 * property named as an approval counts: guessing at another boolean (`deny`) could turn a denial into consent. Both
 * the schema and the property must be plain (above), and no other property may be required.
 */
function approvalKey(schema: Any): string | undefined {
  if (!plain(schema, "object")) return undefined;
  const key = Object.keys(schema.properties).find((k) => APPROVE_NAMES.test(k) && plain(schema.properties[k], "boolean"));
  if (!key) return undefined;
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  return required.every((r) => r === key) ? key : undefined;
}

/** A text answer shaped for `responseSchema`, or undefined when the schema cannot take plain text. */
function textPayload(schema: Any, text: string): { payload: unknown } | undefined {
  if (!schema) return { payload: text };
  if (plain(schema, "string")) return { payload: text };
  if (plain(schema, "object")) {
    const strings = Object.keys(schema.properties).filter((k) => plain(schema.properties[k], "string"));
    const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
    if (strings.length === 1 && required.every((r) => r === strings[0])) return { payload: { [strings[0]!]: text } };
  }
  return undefined;
}

/**
 * One AG-UI thread per task session. Each user turn, and each resume, is one POST whose SSE stream is mapped to
 * AgentEvent; the stream closing ends the run. An interrupt run leaves the turn open for permission asks; for question
 * asks only, the turn ends (`session.end`) and the person's next message answers them.
 */
class AguiSession implements RunnerSession {
  readonly exited: Promise<number | null>;
  private resolveExit!: (c: number | null) => void;
  private threadId = crypto.randomUUID();
  private messages: Message[] = [];
  private runs = 0;
  private controller: AbortController | null = null;
  private current: Promise<void> = Promise.resolve();
  private queue: string[] = [];
  private closed = false;
  private pending = new Map<string, PendingInterrupt>();
  private answers = new Map<string, ResumeItem>();
  /** Messages to add to the history with the next run's resume (a question answered in text that its schema cannot take). */
  private extraUser: string[] = [];
  /** The turn of the current interrupt run has ended to wait for answers to its questions. */
  private endedForQuestions = false;

  constructor(
    private o: ResolvedOptions,
    private opts: StartOptions,
    private emit: (ev: AgentEvent) => void,
  ) {
    this.exited = new Promise((r) => (this.resolveExit = r));
    this.emit({ t: "message.delta", role: "user", text: opts.prompt });
    // No model: none is sent (PBI decision log), so the one the agent ran on is not known here (usage.model says it per run).
    this.emit({ t: "session.start", runner: o.id, runnerSessionId: this.threadId, cwd: opts.cwd, runnerVersion: "ag-ui" });
    if (opts.preamble) this.messages.push({ id: crypto.randomUUID(), role: "system", content: opts.preamble });
    this.messages.push({ id: crypto.randomUUID(), role: "user", content: opts.prompt });
    this.run();
  }

  private run(resume?: ResumeItem[]) {
    this.current = this.turn(resume);
  }

  private body(resume?: ResumeItem[]): unknown {
    // Model selection is not built (PBI decision log): only the Workspace MCP endpoint, and only when configured.
    const switchboard: Record<string, unknown> = {};
    if (this.o.sendWorkspaceMcp && this.opts.mcpServers) switchboard.mcpServers = this.opts.mcpServers;
    return {
      threadId: this.threadId,
      runId: `run-${++this.runs}`,
      state: {},
      messages: this.messages,
      tools: [],
      context: [],
      forwardedProps: Object.keys(switchboard).length ? { switchboard } : {},
      ...(resume ? { resume } : {}),
    };
  }

  /** One POST → one run. Serialized: a send() during a run is queued and runs after it. */
  private async turn(resume?: ResumeItem[]): Promise<void> {
    if (this.closed) return;
    const controller = (this.controller = new AbortController());
    const state = createAguiState();
    // History bookkeeping: the assistant message of this run, from the same mapping the screen gets (parse.ts; a call's
    // arguments as the text the server sent), and the tool results' whole content from the raw event (the mapped summary is cut).
    let assistant: { content: string; toolCalls: Message[] } = { content: "", toolCalls: [] };
    const flush = () => {
      if (assistant.content || assistant.toolCalls.length) this.messages.push({ id: crypto.randomUUID(), role: "assistant", ...(assistant.content ? { content: assistant.content } : {}), ...(assistant.toolCalls.length ? { toolCalls: assistant.toolCalls } : {}) });
      assistant = { content: "", toolCalls: [] };
    };
    let terminal: "success" | "interrupt" | "error" | "cancelled" | undefined;
    let status: "ok" | "error" | "aborted" = "ok";
    const handle = (data: string) => {
      let ev: Any;
      try {
        ev = JSON.parse(data);
      } catch {
        this.emit({ t: "status", text: `unparsed: ${data.slice(0, 200)}` });
        return;
      }
      const mapped = mapAguiEvent(state, ev);
      for (const out of mapped) {
        if (out.t === "message.delta") assistant.content += out.text;
        else if (out.t === "tool.call") assistant.toolCalls.push({ id: out.id, type: "function", function: { name: out.name, arguments: state.done.get(out.id)?.args || "{}" } });
      }
      switch (ev?.type) {
        case "TOOL_CALL_RESULT":
          if (typeof ev.toolCallId === "string") {
            flush();
            this.messages.push({ id: typeof ev.messageId === "string" ? ev.messageId : crypto.randomUUID(), role: "tool", toolCallId: ev.toolCallId, content: typeof ev.content === "string" ? ev.content : "" });
          }
          break;
        case "RUN_ERROR":
          terminal = "error";
          break;
        case "RUN_FINISHED":
          terminal = ev.outcome?.type === "interrupt" ? "interrupt" : ev.outcome?.type === "cancelled" ? "cancelled" : "success";
          break;
      }
      const interrupts: Any[] = ev?.type === "RUN_FINISHED" && ev.outcome?.type === "interrupt" && Array.isArray(ev.outcome.interrupts) ? ev.outcome.interrupts : [];
      const kinds = new Map<string, PendingInterrupt>();
      for (const i of interrupts) {
        if (typeof i?.id !== "string") continue;
        const key = typeof i.toolCallId === "string" && i.toolCallId ? approvalKey(i.responseSchema) : undefined;
        const fillable = typeof i.toolCallId === "string" && i.toolCallId && (i.responseSchema === undefined || key !== undefined);
        kinds.set(i.id, fillable ? { kind: "permission", approveKey: key, schema: i.responseSchema } : { kind: "question", schema: i.responseSchema });
      }
      for (const out of mapped) {
        if (out.t === "permission.ask") {
          const k = kinds.get(out.id);
          if (k) this.pending.set(out.id, k);
          if (k?.kind === "question") {
            const i = interrupts.find((x) => x.id === out.id);
            this.emit({ t: "question.ask", id: out.id, questions: [{ header: typeof i?.reason === "string" ? i.reason : null, question: out.detail, options: [], multiSelect: false }] });
            continue;
          }
        }
        this.emit(out);
      }
    };
    try {
      const r = await fetch(this.o.baseUrl, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders(this.o) }, body: JSON.stringify(this.body(resume)), signal: controller.signal, timeout: this.o.streamIdleTimeoutMs });
      if (!r.ok || !r.body) {
        const text = await r.text().catch(() => "");
        this.emit({ t: "error", message: `${this.o.label}: HTTP ${r.status} ${text.slice(0, 300)}` });
        status = "error";
      } else {
        const sse = createSseParser();
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const data of sse.feed(dec.decode(value, { stream: true }))) handle(data);
        }
        for (const data of sse.flush()) handle(data);
        if (terminal === undefined) {
          // A truncated run is not a finished one: no RUN_FINISHED is made up, and the server is not said to have stopped.
          this.emit({ t: "error", message: `${this.o.label}: the stream ended before RUN_FINISHED` });
          status = "error";
        } else if (terminal === "error") status = "error";
      }
    } catch (e) {
      if (controller.signal.aborted) status = "aborted";
      else {
        this.emit({ t: "error", message: `${this.o.label}: request failed: ${String((e as Error).message ?? e)}` });
        status = "error";
      }
    }
    flush();
    if (this.controller === controller) this.controller = null;

    // An interrupt outcome that names no interrupt it could read leaves nothing to answer: the run just ends.
    if (status === "ok" && terminal === "interrupt" && this.pending.size > 0) {
      this.endedForQuestions = false;
      // A message sent while the run's stream was still being read was queued: it answers the questions, if any. First,
      // so that an answered question does not end the turn the resume run continues.
      const next = this.queue.shift();
      if (next !== undefined && !this.answerQuestions(next)) this.queue.unshift(next);
      // Permission asks keep the turn open; once none is left unanswered, open questions end it (below).
      this.endIfOnlyQuestionsLeft();
      await this.maybeResume();
      return;
    }
    // Interrupts left open on a run that did not end in one cannot be answered any more.
    this.dropPending();
    this.emit({ t: "session.end", status, ...(terminal === "cancelled" ? { summary: "the server cancelled the run" } : status === "aborted" ? { summary: "aborted by user" } : {}) });
    if (status === "aborted" || this.closed) return;
    const next = this.queue.shift();
    if (next !== undefined) await this.sendNow(next);
  }

  /**
   * Questions are answered by the person's next message, which can only come once the turn has ended: when no
   * permission ask is left unanswered and a question is, the turn ends (once per interrupt run).
   */
  private endIfOnlyQuestionsLeft() {
    if (this.endedForQuestions) return;
    const open = [...this.pending].filter(([id]) => !this.answers.has(id)).map(([, p]) => p.kind);
    if (open.includes("permission") || !open.includes("question")) return;
    this.endedForQuestions = true;
    this.emit({ t: "session.end", status: "ok" });
  }

  /** Permission asks left open are denied by timeout (no person answered: #651); questions just go. */
  private dropPending() {
    for (const [id, p] of this.pending) if (p.kind === "permission" && !this.answers.has(id)) this.emit({ t: "permission.resolved", id, decision: "deny", by: "timeout" });
    this.pending.clear();
    this.answers.clear();
    this.extraUser = [];
  }

  /** Starts the resume run once every open interrupt has an answer and no run is in flight. */
  private async maybeResume(): Promise<void> {
    if (this.controller || this.closed || this.pending.size === 0) return;
    if (![...this.pending.keys()].every((id) => this.answers.has(id))) return;
    const resume = [...this.pending.keys()].map((id) => this.answers.get(id)!);
    for (const t of this.extraUser) this.messages.push({ id: crypto.randomUUID(), role: "user", content: t });
    this.pending.clear();
    this.answers.clear();
    this.extraUser = [];
    await this.turn(resume);
  }

  private async sendNow(text: string): Promise<void> {
    this.messages.push({ id: crypto.randomUUID(), role: "user", content: text });
    await this.turn();
  }

  send(text: string): void {
    if (this.closed) throw new Error(`${this.o.label} session is closed; resume the task instead`);
    this.emit({ t: "message.delta", role: "user", text });
    if (!this.controller && this.answerQuestions(text)) {
      this.current = this.maybeResume();
      return;
    }
    if (this.controller || this.pending.size > 0) {
      this.queue.push(text);
      return;
    }
    this.current = this.sendNow(text);
  }

  /** One message answers every open question; false when none is open. */
  private answerQuestions(text: string): boolean {
    const questions = [...this.pending].filter(([id, p]) => p.kind === "question" && !this.answers.has(id));
    if (questions.length === 0) return false;
    for (const [id, p] of questions) {
      const fit = textPayload(p.schema, text);
      if (fit) this.answers.set(id, { interruptId: id, status: "resolved", payload: fit.payload });
      else {
        // The schema cannot take text: the interrupt is cancelled and the agent is shown the answer as a user message.
        this.answers.set(id, { interruptId: id, status: "cancelled" });
        if (!this.extraUser.includes(text)) this.extraUser.push(text);
      }
    }
    return true;
  }

  respondPermission(id: string, decision: PermissionDecision, _reason?: string, by: "user" | "rule" = "user"): void {
    const p = this.pending.get(id);
    if (!p || p.kind !== "permission" || this.answers.has(id)) throw new Error(`no pending confirmation ${id}`);
    this.emit({ t: "permission.resolved", id, decision, by });
    // `resolved` + payload from the schema; `cancelled` only when a denial cannot be said in a payload.
    if (p.approveKey) this.answers.set(id, { interruptId: id, status: "resolved", payload: { [p.approveKey]: decision === "allow" } });
    else if (decision === "allow") this.answers.set(id, { interruptId: id, status: "resolved" });
    else this.answers.set(id, { interruptId: id, status: "cancelled" });
    // While the stream is still being read, the end of the run starts the resume.
    if (this.controller) return;
    this.endIfOnlyQuestionsLeft();
    this.current = this.maybeResume();
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    const active = !!this.controller;
    const open = [...this.pending.values()].some((p) => p.kind === "permission");
    this.controller?.abort();
    if (active) await Promise.race([this.current, new Promise<void>((r) => setTimeout(r, 2000))]);
    else if (open) {
      this.dropPending();
      this.emit({ t: "session.end", status: "aborted", summary: "aborted by user" });
    }
    this.pending.clear();
    this.answers.clear();
    this.finish(active || open ? null : 0);
  }

  async close(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    const grace = opts.graceMs ?? 3000;
    if (this.controller && grace > 0) await Promise.race([this.exited, this.current, new Promise<void>((r) => setTimeout(r, grace))]);
    if (!this.closed) {
      this.controller?.abort();
      this.finish(0);
    }
  }

  private finish(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    this.resolveExit(code);
  }
}
