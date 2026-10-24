import type { AgentEvent, Attachment, PermissionDecision, RunnerAdapter, RunnerDetection, RunnerSession, StartOptions } from "@switchboard/protocol";
import { collectArtifacts } from "./artifacts.ts";
import { attachmentParts, confirmationMessage, createDakParserState, createSseParser, endOfStream, mapAdkEvent, userMessage } from "./parse.ts";

export * from "./parse.ts";

/**
 * DAK runner (issue #19): Decentralized-Agent-Kit's agent container speaks Google ADK's REST API.
 * Switchboard talks to `POST /run_sse` over SSE and to the session endpoints; it never runs the agent itself.
 * DAK has no file tools of its own — it reaches the local repository through Switchboard's Workspace MCP
 * (docs/design/dak-adapter.md). No A2A.
 */
export interface DakAdapterOptions {
  /** Base URL of the ADK server. Default http://127.0.0.1:8000 (DAK's docker compose maps agent:8000 there). */
  baseUrl?: string;
  /** ADK app name. Default dak_agent. */
  app?: string;
  /** ADK user id used for sessions. Default "switchboard". */
  user?: string;
  /** Request timeout for the session endpoints. */
  timeoutMs?: number;
  /**
   * Idle timeout for the `/run_sse` stream: how long it may go without a single byte before the turn is treated as
   * dead (Bun's fetch `timeout` resets on every byte). Default 2 h. A healthy turn can be silent for many minutes, so
   * this must not be short (#121); it stays finite so a DAK side that died without closing the connection (paused
   * container, sleeping host, half-open TCP) still ends the turn. Above DAK's own LiteLLM `request_timeout` (6000 s),
   * so a stalled model call surfaces as DAK's error first.
   */
  streamIdleTimeoutMs?: number;
}

const DEFAULTS = { baseUrl: "http://127.0.0.1:8000", app: "dak_agent", user: "switchboard", timeoutMs: 10_000, streamIdleTimeoutMs: 2 * 60 * 60_000 };

export function createDakAdapter(options: DakAdapterOptions = {}): RunnerAdapter {
  // Undefined-safe merge: a caller passing `{ baseUrl: process.env.X }` with X unset must not override the
  // default with `undefined` (plain object spread keeps the key, and `${undefined}/list-apps` is a broken URL).
  const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const o = { ...DEFAULTS, ...defined };
  return {
    id: "dak",
    // No permission knob (#58): DAK's agent decides what to confirm (`require_confirmation` / adk_request_confirmation),
    // and exec.run approvals come from Switchboard's own Workspace MCP policy. Every confirmation still reaches the UI.
    permissionModes: [],
    async detect(): Promise<RunnerDetection> {
      try {
        const r = await fetch(`${o.baseUrl}/list-apps`, { signal: AbortSignal.timeout(o.timeoutMs) });
        if (!r.ok) return { available: false, note: `${o.baseUrl}/list-apps → HTTP ${r.status}` };
        const apps = (await r.json()) as unknown;
        if (!Array.isArray(apps) || !apps.includes(o.app)) return { available: false, note: `ADK server at ${o.baseUrl} does not serve app "${o.app}" (has: ${JSON.stringify(apps)})` };
        return { available: true, version: "adk", path: o.baseUrl, note: `app ${o.app} at ${o.baseUrl}` };
      } catch (e) {
        return { available: false, note: `DAK agent not reachable at ${o.baseUrl} (${String((e as Error).message ?? e)}). Start it with \`docker compose up\` in the DAK repository.` };
      }
    },
    start(opts, emit) {
      return new DakSession(o, opts, emit);
    },
  };
}

interface Pending {
  callId: string;
  invocationId?: string;
}

/** A queued turn, built into a request body once the session id is known (a plain send() may queue before `open()` completes). */
type QueuedTurn = { kind: "text"; text: string; parts: unknown[] } | { kind: "confirmation"; callId: string; confirmed: boolean; invocationId?: string };

/**
 * One ADK session per task session. Each user turn (and each confirmation answer) is one `/run_sse` request whose
 * SSE stream is mapped to AgentEvent; the stream closing ends the turn. Confirmations (`adk_request_confirmation`)
 * leave the turn open: the stream ends, the ask stays pending, and the answer starts the next stream.
 */
class DakSession implements RunnerSession {
  readonly exited: Promise<number | null>;
  private resolveExit!: (c: number | null) => void;
  private state = createDakParserState();
  private sessionId?: string;
  private controller: AbortController | null = null;
  private queue: QueuedTurn[] = [];
  private closed = false;
  private aborting = false;
  private pendingAsks = new Map<string, Pending>();
  /**
   * Whether *this* turn's stream raised a confirmation, decided at the moment it happens rather than by checking
   * `pendingAsks.size` once the stream drains: an ask answered synchronously (e.g. from inside the caller's own
   * event handler, before the read loop even reaches its next `reader.read()`) would otherwise empty `pendingAsks`
   * before this turn's own end-of-stream check runs, making a paused turn look like a finished one.
   */
  private askRaisedThisTurn = false;
  private ready: Promise<void>;

  constructor(
    private o: typeof DEFAULTS,
    private opts: StartOptions,
    private emit: (ev: AgentEvent) => void,
  ) {
    this.exited = new Promise((r) => (this.resolveExit = r));
    this.emit({ t: "message.delta", role: "user", text: opts.prompt });
    this.ready = this.open().catch((e) => {
      this.emit({ t: "error", message: `DAK session failed: ${String((e as Error).message ?? e)}` });
      this.finish(1);
    });
  }

  private async open() {
    const { baseUrl, app, user, timeoutMs } = this.o;
    const base = `${baseUrl}/apps/${encodeURIComponent(app)}/users/${encodeURIComponent(user)}/sessions`;
    let id = this.opts.resumeSessionId;
    if (id) {
      const r = await fetch(`${base}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 404) {
        // The agent no longer has the session (ADK keeps them in memory; a container restart drops them). A task that
        // could never be continued again is worse than one that continues without its context — say so and go on.
        this.emit({ t: "status", text: `前回のセッション ${id} は agent 側にありません（agent の再起動？）。新しいセッションで続けます — これまでの文脈は引き継がれません` });
        id = undefined;
      } else if (!r.ok) throw new Error(`session ${id} could not be checked (HTTP ${r.status})`);
    }
    if (!id) {
      const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: { switchboard: { cwd: this.opts.cwd, scope: this.opts.scope } } }), signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`could not create an ADK session (HTTP ${r.status})`);
      id = ((await r.json()) as { id: string }).id;
    }
    this.sessionId = id;
    this.emit({ t: "session.start", runner: "dak", runnerSessionId: id, cwd: this.opts.cwd, model: this.opts.model, runnerVersion: "adk" });
    await this.turn(userMessage(app, user, id, this.opts.prompt, attachmentParts(this.opts.attachments)));
  }

  /** One /run_sse request → one turn. Serialized: a send() during a turn is queued and runs after it. */
  private async turn(body: unknown): Promise<void> {
    if (this.closed) return;
    this.controller = new AbortController();
    // A fresh turn is a fresh text segment: the previous turn's "already streamed" flag must not carry over and
    // suppress this turn's first reply (segment itself is a monotonic counter, so ids stay unique without a reset).
    this.state.segment++;
    this.state.segmentStreamed = false;
    this.state.lastText = undefined;
    this.askRaisedThisTurn = false;
    let status: "ok" | "error" | "aborted" = "ok";
    try {
      // `timeout` (Bun, idle): a turn can be silent for many minutes — a local LLM writing a long tool call streams
      // nothing, because ADK emits no partial events for function-call arguments. Bun's default (360 s) cut such
      // turns ("The operation timed out."), ADK cancelled the turn and dropped its output, so every retry replayed
      // the same prompt into the same cut (#121). See `streamIdleTimeoutMs`; the user's abort still stops it at once.
      const r = await fetch(`${this.o.baseUrl}/run_sse`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal: this.controller.signal, timeout: this.o.streamIdleTimeoutMs });
      if (!r.ok || !r.body) {
        const text = await r.text().catch(() => "");
        this.emit({ t: "error", message: `/run_sse → HTTP ${r.status} ${text.slice(0, 300)}` });
        status = "error";
      } else {
        const sse = createSseParser();
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const data of sse.feed(dec.decode(value, { stream: true }))) await this.handle(data);
        }
        for (const data of sse.flush()) await this.handle(data);
        if (this.state.errored) status = "error";
      }
    } catch (e) {
      if (this.controller.signal.aborted) status = "aborted";
      else {
        this.emit({ t: "error", message: `/run_sse failed: ${String((e as Error).message ?? e)}` });
        status = "error";
      }
    }
    this.controller = null;
    // A stream that ended with a confirmation still open is not the end of the turn: the answer continues it.
    // Gated on askRaisedThisTurn (set the moment the ask fires), not just on pendingAsks being non-empty: a
    // synchronous respondPermission() — e.g. called from inside the caller's own emit callback, before this line
    // even runs — already deleted the entry, which would otherwise make a merely-paused turn look finished and
    // race straight into endOfStream() before the queued confirmation turn gets a chance to run.
    if (status === "ok" && this.askRaisedThisTurn) {
      if (this.pendingAsks.size > 0) return; // still genuinely waiting on an answer; nothing more to do here
      // Already answered while we were still reading (the racy synchronous case): the answer was queued because
      // `controller` was still set when respondPermission() ran. Drain it now rather than ending a turn that, from
      // the protocol's point of view, is still in progress.
      const next = this.queue.shift();
      if (next !== undefined) await this.turn(this.buildTurnBody(next));
      return;
    }
    // The turn is over some other way (done and clean, errored, or aborted): a confirmation left open on it cannot
    // be answered on a dead stream — resolve it as denied by timeout (no person answered it: #651) so the UI does not show a prompt that will never resolve.
    if (this.pendingAsks.size > 0) {
      for (const id of this.pendingAsks.keys()) this.emit({ t: "permission.resolved", id, decision: "deny", by: "timeout" });
      this.pendingAsks.clear();
    }
    for (const ev of endOfStream(this.state, status)) this.emit(ev);
    if (status === "aborted" || this.closed) return;
    const next = this.queue.shift();
    if (next !== undefined) await this.turn(this.buildTurnBody(next));
  }

  private buildTurnBody(q: QueuedTurn): unknown {
    return q.kind === "text" ? userMessage(this.o.app, this.o.user, this.sessionId!, q.text, q.parts) : confirmationMessage(this.o.app, this.o.user, this.sessionId!, q.callId, q.confirmed, q.invocationId);
  }

  private async handle(data: string) {
    let ev: unknown;
    try {
      ev = JSON.parse(data);
    } catch {
      this.emit({ t: "status", text: `unparsed: ${data.slice(0, 200)}` });
      return;
    }
    // Files the agent made (#124), saved before the event's own mapping so they are on disk by the turn's end. A file
    // that cannot be had is said and skipped; the turn goes on.
    const { baseUrl, app, user, timeoutMs } = this.o;
    const sessionUrl = `${baseUrl}/apps/${encodeURIComponent(app)}/users/${encodeURIComponent(user)}/sessions/${encodeURIComponent(this.sessionId ?? "")}`;
    const signal = this.controller?.signal;
    for (const f of await collectArtifacts(ev, { sessionUrl, attachmentDir: this.opts.attachmentDir, timeoutMs, signal })) {
      if ("path" in f) this.emit({ t: "artifact", kind: "file", path: f.path });
      else if (!signal?.aborted) this.emit({ t: "status", text: `DAK が作ったファイルを取得・保存できませんでした（${f.error}）` }); // an abort is not a failure to report
    }
    for (const out of mapAdkEvent(ev, this.state)) {
      if (out.t === "permission.ask") {
        this.pendingAsks.set(out.id, { callId: out.id, invocationId: this.state.invocationId });
        this.askRaisedThisTurn = true;
      }
      this.emit(out);
    }
  }

  send(text: string, attachments?: Attachment[]): void {
    if (this.closed) throw new Error("DAK session is closed; resume the task instead");
    const parts = attachmentParts(attachments);
    this.emit({ t: "message.delta", role: "user", text });
    if (this.controller || !this.sessionId) {
      this.queue.push({ kind: "text", text, parts });
      return;
    }
    void this.turn(userMessage(this.o.app, this.o.user, this.sessionId, text, parts));
  }

  respondPermission(id: string, decision: PermissionDecision, _reason?: string, by: "user" | "rule" = "user"): void {
    const p = this.pendingAsks.get(id);
    if (!p) throw new Error(`no pending confirmation ${id}`);
    this.pendingAsks.delete(id);
    this.emit({ t: "permission.resolved", id, decision, by });
    if (!this.sessionId) return;
    const q: QueuedTurn = { kind: "confirmation", callId: p.callId, confirmed: decision === "allow", invocationId: p.invocationId };
    // The confirmation ask always arrives at the end of a stream (it keeps the turn open), so `controller` here is
    // null in normal operation; the branch below only guards against answering while some other turn is in flight.
    if (this.controller) this.queue.unshift(q);
    else void this.turn(this.buildTurnBody(q));
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.aborting = true;
    const active = !!this.controller;
    this.controller?.abort();
    await Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, 2000))]);
    if (!active && this.pendingAsks.size === 0) {
      this.finish(0);
      return;
    }
    // The stream abort emits session.end(aborted) through turn(); pending confirmations are simply dropped.
    for (const id of this.pendingAsks.keys()) this.emit({ t: "permission.resolved", id, decision: "deny", by: "timeout" });
    this.pendingAsks.clear();
    if (!active) this.emit({ t: "session.end", status: "aborted", summary: "aborted by user" });
    this.finish(null);
  }

  async close(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    const grace = opts.graceMs ?? 3000;
    // No lingering subprocess to release (DAK's state lives on the ADK server, not here): a session with no turn in
    // flight closes at once. One that is mid-stream gets the grace period to finish naturally before being cut off.
    if (this.controller && grace > 0) await Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, grace))]);
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
