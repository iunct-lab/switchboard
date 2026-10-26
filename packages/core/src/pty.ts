// Terminal tab (#16): one interactive shell per task, in the task's cwd. The PTY is bun-pty (bun:ffi) inside the
// daemon — no bridge process. A shell outlives its WebSocket clients; it ends when
// the task ends (onTaskEnd), when the user exits it, when close() is called, or with the daemon.
// The first frame to a socket is PtyAttached (the session's id); after that, output as raw strings. A socket that comes
// back with ?shell=<id> is attached to that session only — never to a new shell (#1137).
import { childEnv } from "@switchboard/adapter-claude";
import type { IPty } from "bun-pty";
import { z } from "zod";

/** Shells open at once. Not a setting: the host is small and only a task whose terminal tab was opened has one. */
export const MAX_PTY_SESSIONS = 8;
import { supportedTeleportArgs, TeleportOutput, type TeleportResult } from "./claude-cloud.ts";

/** Where an official Teleport is: running, waiting for the user's answer in the terminal, or being ended after it resumed. */
export type TeleportPhase = "teleporting" | "needs-input" | "exiting";
export interface TeleportProgress { phase: TeleportPhase; question?: string }

/** Quiet times (ms) for Teleport. Constants, not settings; tests shorten them through PtyManager.load. */
export interface TeleportTimings { exitQuietMs: number; questionQuietMs: number; exitWaitMs: number }
export const TELEPORT_TIMINGS: TeleportTimings = { exitQuietMs: 1000, questionQuietMs: 3000, exitWaitMs: 10000 };
/** The CLI's menu takes `/exit` and Enter as separate input; written together they are mixed up. */
const TELEPORT_ENTER_DELAY_MS = 300;
/** The name `/rename` gives the continued session: a fixed word, so nothing from the Cloud Task is typed into the CLI. */
export const TELEPORT_SESSION_NAME = "continued-from-cloud";

/** The first frame to a terminal socket: which session it is on, for ?shell= when it comes back (#1137). */
export type PtyAttached = { type: "attached"; shell: string };

/** What a terminal socket (/ws/pty) may send. Output travels the other way as raw strings, after PtyAttached. */
export const PtyClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
]);

/** How much output (in UTF-16 units, as strings count) is kept per session and re-sent on attach, so coming back to the tab shows what happened. */
export const REPLAY_CHARS = 64 * 1024;

/** One WebSocket. `close` is called when the shell exits. */
export interface PtyClient {
  send(data: string): void;
  close(): void;
}

type Spawn = typeof import("bun-pty").spawn;

interface Session {
  /** Memory only: a session ends with the daemon, so an id kept anywhere else would name nothing. */
  id: string;
  pty: IPty | null;
  kind: "pending" | "starting" | "shell" | "teleport" | "importing";
  /** The last REPLAY_CHARS of output. */
  recent: string;
  cols: number; rows: number;
  clients: Set<PtyClient>;
  /** Teleport only: cancels the quiet timers. */
  stopTimers?: () => void;
}

export class PtyManager {
  private sessions = new Map<string, Session>();
  private constructor(private spawn: Spawn, private timings: TeleportTimings = TELEPORT_TIMINGS) {}

  /**
   * null when a PTY cannot be opened here: an unsupported OS / arch, or a distribution without the native library.
   * The daemon then reports features.pty = false and refuses /ws/pty. Importing is not enough of a check — bun-pty
   * logs a failed dlopen and lets the import succeed, and only the first spawn throws — so one throwaway process is
   * spawned.
   */
  static async load(importer: () => Promise<{ spawn: Spawn }> = () => import("bun-pty"), timings?: Partial<TeleportTimings>): Promise<PtyManager | null> {
    try {
      const { spawn } = await importer();
      spawn("/bin/sh", ["-c", "exit 0"], { name: "xterm-256color" }).kill();
      return new PtyManager(spawn, { ...TELEPORT_TIMINGS, ...timings });
    } catch (e) {
      console.warn(`pty: terminal tab disabled — ${String((e as Error).message ?? e).split("\n")[0]}`);
      return null;
    }
  }

  /** Active shells and imports (#181: keep the host alive until the result is delivered). */
  get size(): number {
    return [...this.sessions.values()].filter(s => s.pty !== null || s.kind === "importing").length;
  }

  /** The task's shell, started on first use. */
  open(taskId: string, cwd: string, shell: string): void {
    if (this.sessions.has(taskId)) return;
    if (this.size >= MAX_PTY_SESSIONS) throw new Error(`too many terminals open (max ${MAX_PTY_SESSIONS}); close one first`);
    const pty = this.spawn(shell, ["-i"], { name: "xterm-256color", cols: 80, rows: 24, cwd });
    const s: Session = { id: crypto.randomUUID(), pty, kind: "shell", recent: "", cols: 80, rows: 24, clients: new Set() };
    this.sessions.set(taskId, s);
    pty.onData((data) => {
      s.recent = (s.recent + data).slice(-REPLAY_CHARS);
      // never start the replay in the middle of a surrogate pair
      if (s.recent.length === REPLAY_CHARS && /^[\udc00-\udfff]/.test(s.recent)) s.recent = s.recent.slice(1);
      for (const c of s.clients) c.send(data);
    });
    pty.onExit(() => {
      if (this.sessions.get(taskId) === s) this.sessions.delete(taskId);
      for (const c of s.clients) c.close();
      s.clients.clear();
    });
  }

  /** Connecting to the Teleport view must not start a shell or a CLI. */
  prepareTeleport(taskId: string): void {
    if (!this.sessions.has(taskId)) this.sessions.set(taskId, { id: crypto.randomUUID(), pty: null, kind: "pending", recent: "", cols: 80, rows: 24, clients: new Set() });
  }

  async startTeleport(taskId: string, cwd: string, bin: string, cloudId: string, exited: (result: TeleportResult) => void | Promise<void>, progress: (p: TeleportProgress) => void = () => {}): Promise<void> {
    const s = this.sessions.get(taskId);
    if (!s || s.kind !== "pending") throw new Error("Terminalが使用中です。既存shell/Teleportを終了してから明示操作してください。");
    s.kind = "starting";
    try {
      const args = await supportedTeleportArgs(bin, cwd, cloudId);
      if (this.sessions.get(taskId) !== s) throw new Error("Terminalが閉じられました。");
      if (this.size >= MAX_PTY_SESSIONS) throw new Error(`too many terminals open (max ${MAX_PTY_SESSIONS}); close one first`);
      // Without the parent's Claude Code session markers, as for any Claude child: inherited, they turn the log off.
      // bun-pty adds `env` to the daemon's own environment rather than replacing it, so the markers are unset by env(1).
      const env = childEnv(), unset = Object.keys(process.env).filter(k => !(k in env)).flatMap(k => ["-u", k]);
      const pty = this.spawn("/usr/bin/env", [...unset, bin, ...args], { name: "xterm-256color", cols: s.cols, rows: s.rows, cwd, env });
      s.pty = pty; s.kind = "teleport";
      const parser = new TeleportOutput(cloudId);
      // Nothing is ever written before the CLI has resumed the target session: its questions (trust, stash, branch) are
      // the user's. After that, once it has been quiet, `/rename` records one local entry without asking the model: the
      // CLI writes the resumed conversation to its normal log only once this session records something, and prints the
      // evidence (`claude --resume <UUID>`) only when that log exists (#1865). Once it confirms, one `/exit` ends it.
      const t = this.timings;
      let timer: ReturnType<typeof setTimeout> | undefined, stage: "wait" | "naming" | "exiting" = "wait", typing = false, asking = false;
      const emit = (p: TeleportProgress) => { try { progress(p); } catch { /* A broken observer must not stop the CLI. */ } };
      // Once the person is asked after `/rename` or `/exit`, the terminal is theirs: nothing more is typed, even if the
      // confirmation arrives late. Before `/rename` the ask is undone by the CLI's next output (it was a question).
      const ask = () => { asking = true; if (stage === "naming") stage = "exiting"; emit({ phase: "needs-input", question: parser.question() }); };
      s.stopTimers = () => { clearTimeout(timer); stage = "exiting"; };
      // The echo of what is typed must not cancel its Enter (or the wait that follows it).
      const type = (text: string) => {
        typing = true; pty.write(text);
        timer = setTimeout(() => { pty.write("\r"); typing = false; timer = setTimeout(ask, t.exitWaitMs); }, TELEPORT_ENTER_DELAY_MS);
      };
      // Before `/rename`: quiet after resumed → name it; quiet before resumed → the CLI is asking something.
      // After `/rename`: quiet after its confirmation → `/exit` once; no confirmation in time → ask the person.
      const arm = () => {
        if (stage === "exiting" || typing) return; // the `\r` and the wait timers run on their own; output must not cancel them
        clearTimeout(timer);
        if (stage === "naming") {
          timer = parser.renamed ? setTimeout(() => { stage = "exiting"; type("/exit"); }, t.exitQuietMs) : setTimeout(ask, t.exitWaitMs);
          return;
        }
        if (!parser.ready) { timer = setTimeout(ask, t.questionQuietMs); return; }
        timer = setTimeout(() => {
          stage = "naming"; emit({ phase: "exiting" });
          type(`/rename ${TELEPORT_SESSION_NAME}`);
        }, t.exitQuietMs);
      };
      emit({ phase: "teleporting" });
      arm();
      pty.onData(data => {
        parser.feed(data);
        if (asking && stage === "wait") { asking = false; emit({ phase: "teleporting" }); }
        arm();
        s.recent = (s.recent + data).slice(-REPLAY_CHARS);
        if (s.recent.length === REPLAY_CHARS && /^[\udc00-\udfff]/.test(s.recent)) s.recent = s.recent.slice(1);
        for (const c of s.clients) c.send(data);
      });
      pty.onExit(({ exitCode }) => {
        s.stopTimers?.(); s.stopTimers = undefined;
        s.pty = null; s.kind = "importing"; // The process has exited: never signal or write to its potentially reused PID.
        const result = parser.finish(exitCode);
        const close = () => {
          if (this.sessions.get(taskId) === s) this.sessions.delete(taskId);
          for (const c of s.clients) {
            try { c.send(`\r\n${result.message}\r\n`); } catch { /* A disconnected client must not prevent closing others. */ }
            try { c.close(); } catch { /* Already closed. */ }
          }
          s.clients.clear();
        };
        const failed = () => { result.message = "Local取込み結果は未確認です。Taskと公式Terminalの案内を確認してください。"; close(); };
        try {
          const completion = exited(result);
          if (completion) void completion.then(close, failed);
          else close();
        } catch { failed(); }
      });
    } catch (e) {
      s.kind = "pending";
      if (s.clients.size === 0 && this.sessions.get(taskId) === s) this.sessions.delete(taskId);
      throw e;
    }
  }

  /** Sends what the shell printed so far, then everything new. */
  attach(taskId: string, client: PtyClient): void {
    const s = this.sessions.get(taskId);
    if (!s) return client.close();
    if (s.recent) client.send(s.recent);
    s.clients.add(client);
  }

  detach(taskId: string, client: PtyClient): void {
    const s = this.sessions.get(taskId);
    s?.clients.delete(client);
    if (s?.kind === "pending" && s.clients.size === 0) this.sessions.delete(taskId);
  }

  write(taskId: string, data: string): void {
    this.sessions.get(taskId)?.pty?.write(data);
  }

  resize(taskId: string, cols: number, rows: number): void {
    const s = this.sessions.get(taskId);
    if (s) { s.cols = cols; s.rows = rows; s.pty?.resize(cols, rows); }
  }

  /** Whether the task has a terminal session of any kind (a shell, a Teleport, an import in progress). */
  has(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  /** The id of the task's session (a shell, a Teleport, an import), if it has one. */
  sessionId(taskId: string): string | undefined {
    return this.sessions.get(taskId)?.id;
  }

  pid(taskId: string): number | undefined {
    return this.sessions.get(taskId)?.pty?.pid;
  }

  close(taskId: string): void {
    const s = this.sessions.get(taskId);
    s?.stopTimers?.();
    if (s?.pty) end(s.pty);
    else if (s) { this.sessions.delete(taskId); for (const c of s.clients) { try { c.close(); } catch { /* Already closed. */ } } s.clients.clear(); }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

/**
 * Hangs up the terminal, then kills the shell. Killing the shell alone is not enough everywhere: bash and zsh pass
 * SIGHUP on to their background jobs, dash (Linux's /bin/sh) does not and `sleep 300 &` would outlive the daemon.
 * So every process still attached to the shell's tty gets the SIGHUP a closing terminal window would have sent.
 * What the user detached on purpose (nohup, setsid, disown + no tty) stays. Without `ps` only the shell is killed.
 */
function end(pty: IPty): void {
  try {
    const ps = (...args: string[]) => Bun.spawnSync(["ps", ...args]).stdout.toString();
    const tty = ps("-o", "tty=", "-p", String(pty.pid)).trim();
    if (tty && !tty.startsWith("?")) {
      for (const line of ps("-ax", "-o", "pid=,tty=").split("\n")) {
        const [pid, on] = line.trim().split(/\s+/);
        if (on === tty) {
          try {
            process.kill(Number(pid), "SIGHUP");
          } catch {
            /* already gone */
          }
        }
      }
    }
  } catch {
    /* no ps here */
  }
  pty.kill();
}
