import { CloudSession, cloudChildEnv } from "./cloud.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ModelOption, PermissionDecision, PermissionModeOption, RunnerAdapter, RunnerDetection, RunnerLogin, RunnerSession, StartOptions } from "@switchboard/protocol";
import { createClaudeParser, initializeLine, interruptLine, permissionResponseLine, setPermissionModeLine, userMessageLine } from "./parse.ts";

export * from "./parse.ts";
export * from "./history.ts";
export { claudeFolderTrust, cloudTrustGuidance } from "./cloud.ts";

/**
 * Permission modes of Claude Code 2.1.x as `--permission-mode` / `set_permission_mode` accept them (#58). `manual`
 * is the CLI's alias for `default`; the config value is what goes on the wire.
 */
export const CLAUDE_PERMISSION_MODES: PermissionModeOption[] = [
  { value: "auto", label: "自動（Terminal の既定）", description: "Claude Code の分類器が安全な操作を自動承認し、判断できないものだけここで確認" },
  { value: "acceptEdits", label: "編集は自動", description: "ファイル編集は自動承認、コマンド実行などは確認" },
  { value: "default", label: "都度確認", description: "ツール実行のたびに確認（Manual）" },
  { value: "plan", label: "計画のみ", description: "読み取りだけ。編集・実行はしない" },
  { value: "dontAsk", label: "確認なし・拒否", description: "確認が要る操作はすべて拒否（無人実行向け）" },
  { value: "bypassPermissions", label: "すべて許可（危険）", description: "確認なしで何でも実行する。隔離された環境以外では使わない", danger: true },
];

/**
 * What an interactive `claude` starts in on Pro / Max / Team. `claude -p` alone would start in `default` and ignore
 * `permissions.defaultMode`, which is why the flag is always passed (docs: permission-modes.md, built-in defaults).
 */
export const CLAUDE_DEFAULT_PERMISSION_MODE = "auto";

/** Models offered in the UI (#155). `--model` takes any id or alias, so one that is missing here can still be typed. */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-fable-5-1", label: "Fable 5.1" },
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

/** Thinking efforts offered in the UI (#833): the values `claude --effort` takes. */
export const CLAUDE_EFFORTS: ModelOption[] = ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value }));

/**
 * What `claude` without `--model` runs on: the `model` of the user's ~/.claude/settings.json (written by `/model`).
 * Best effort — a project's own settings or ANTHROPIC_MODEL can still override it for one directory.
 */
export function cliDefaultModelFromSettings(claudeHome = join(homedir(), ".claude")): string | undefined {
  try {
    const model = (JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")) as { model?: unknown }).model;
    return typeof model === "string" && model ? model : undefined;
  } catch {
    return undefined;
  }
}

export interface ClaudeAdapterOptions {
  /** Executable name or absolute path. Default: "claude" resolved from PATH. */
  bin?: string;
  /** Extra CLI args appended to every spawn (e.g. ["--setting-sources","user,project"]). */
  extraArgs?: string[];
  /** Where to look for the user's settings.json (model default). Default ~/.claude. */
  claudeHome?: string;
}

/** Environment for the child: inherit everything except the parent's own Claude Code session markers. */
export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export function buildArgs(opts: StartOptions, extra: string[] = []): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    "--permission-prompts", "host",
    "--permission-mode", opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort); // the flag only: the parent's CLAUDE_EFFORT stays out (childEnv)
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  for (const dir of opts.scope) {
    if (dir && dir !== opts.cwd) args.push("--add-dir", dir);
  }
  // the guards (#764) as PreToolUse hooks for Bash; Claude Code adds them to the repository's own hooks
  if (opts.guards?.length) {
    args.push("--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: opts.guards.map((command) => ({ type: "command", command })) }] } }));
  }
  // only the MCP servers Switchboard hands over: the user-wide ones would start per task, used or not (#2090)
  args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: opts.mcpServers ?? {} }));
  args.push(...extra);
  return args;
}

/** What to type in a terminal tab when the login has run out (#180). Prints a URL to open elsewhere, then takes the code. */
export const CLAUDE_LOGIN_HINT = "claude auth login";

/**
 * `claude auth status` (2.1.281): exit 0 = logged in, 1 = not. Its stdout names the account, so it is discarded unread;
 * the credential files are never looked at (#180). No answer within `timeoutMs`, or a CLI without the subcommand → unknown.
 */
export async function loginStatus(exe: string, timeoutMs = 10_000): Promise<RunnerLogin> {
  try {
    const proc = Bun.spawn([exe, "auth", "status"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: childEnv() });
    // stderr is collected as it arrives and awaited only briefly after the exit: a child the command left behind can
    // hold the pipe open, and what came before must still count.
    let stderr = "";
    const decoder = new TextDecoder();
    const drained = (async () => {
      for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true });
    })().catch(() => undefined);
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    if (proc.signalCode) return "unknown";
    if (code === 0) return "ok";
    await Promise.race([drained, Bun.sleep(500)]);
    return /unknown (command|option)|unrecognized/i.test(stderr) ? "unknown" : "expired";
  } catch {
    return "unknown";
  }
}

/**
 * Whether `<claudeHome>/projects/<any project>/<id>.jsonl` exists — the transcript `--resume` reads. Any project folder
 * counts: the folder name is derived from the cwd, and a wrong guess here must not start a new session needlessly.
 * The default home is the spawned claude's: CLAUDE_CONFIG_DIR (childEnv passes it on), else ~/.claude.
 */
export function claudeSessionExists(sessionId: string, claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): boolean {
  const projects = join(claudeHome, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false;
  }
  return dirs.some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): RunnerAdapter {
  const bin = options.bin ?? "claude";
  return {
    id: "claude",
    permissionModes: CLAUDE_PERMISSION_MODES,
    defaultPermissionMode: CLAUDE_DEFAULT_PERMISSION_MODE,
    models: CLAUDE_MODELS,
    efforts: CLAUDE_EFFORTS,
    loginArgs: ["auth", "login"],
    loginHosts: ["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"],
    cliDefaultModel: () => cliDefaultModelFromSettings(options.claudeHome),
    hasSession: (id) => claudeSessionExists(id, options.claudeHome),
    async detect(): Promise<RunnerDetection> {
      try {
        const which = Bun.which(bin);
        if (!which) return { available: false, note: `"${bin}" not found on PATH. Install Claude Code from https://claude.com/claude-code` };
        const proc = Bun.spawn([which, "--version"], { stdout: "pipe", stderr: "pipe", env: childEnv() });
        const text = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        const version = text.match(/\d+\.\d+\.\d+/)?.[0] ?? text;
        if (proc.exitCode !== 0) return { available: false, version, path: which };
        return { available: true, version, path: which, login: await loginStatus(which), loginHint: CLAUDE_LOGIN_HINT };
      } catch (e) {
        return { available: false, note: String(e) };
      }
    },
    start(opts, emit) {
      if (opts.executionMode === "cloud") return new CloudSession(bin, opts, emit, cloudChildEnv(childEnv(process.env, opts.env)));
      return new ClaudeSession(bin, opts, emit, options.extraArgs ?? []);
    },
  };
}

class ClaudeSession implements RunnerSession {
  readonly exited: Promise<number | null>;
  private proc: ReturnType<typeof Bun.spawn>;
  private parser = createClaudeParser();
  private pending = new Map<string, unknown>(); // request_id → tool input
  private closed = false;
  private aborting = false;
  private closing = false;
  /** True from the first user turn until the matching `result` line; abort() only reports an abort while a turn is in flight. */
  private turnActive = false;
  private resultSeen = false;
  private stderrTail = "";
  private stderrDone!: Promise<void>;
  private interruptCounter = 0;
  private modeCounter = 0;
  /** set_permission_mode requests waiting for their control_response (request_id → settle). */
  private modeRequests = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(bin: string, private opts: StartOptions, private emit: (ev: AgentEvent) => void, extraArgs: string[]) {
    const args = buildArgs(opts, extraArgs);
    this.proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd,
      env: childEnv(process.env, opts.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    this.stderrDone = this.pumpStderr();
    const stdoutDone = this.pumpStdout();
    this.exited = this.proc.exited.then(async (code) => {
      // Drain both pipes so `resultSeen` / stderr are final before anyone reacts to the exit. Bounded: a child that
      // inherited our pipes (MCP servers) must not be able to hold the session open.
      await Promise.race([Promise.all([stdoutDone, this.stderrDone]), new Promise((r) => setTimeout(r, 1500))]);
      this.closed = true;
      this.killGroup("SIGKILL");
      for (const w of this.modeRequests.values()) w.reject(new Error("claude exited"));
      // A non-zero exit without a `result` line is the runner refusing to start (e.g. `--resume` of a
      // session that no longer exists). Surface stderr so the UI can show why instead of a bare exit code.
      if (code !== 0 && !this.resultSeen && !this.aborting && !this.closing) {
        this.emit({ t: "error", message: this.stderrTail.trim() || `claude exited with code ${code}` });
      }
      return code;
    });
    this.write(initializeLine());
    this.turnActive = true;
    this.write(userMessageLine(opts.preamble ? `${opts.preamble}\n\n${opts.prompt}` : opts.prompt));
    this.emit({ t: "message.delta", role: "user", text: opts.prompt });
  }

  send(text: string): void {
    if (this.closed || this.closing) throw new Error("runner process has exited; resume the task instead");
    this.emit({ t: "message.delta", role: "user", text });
    this.turnActive = true;
    this.write(userMessageLine(text));
  }

  respondPermission(id: string, decision: PermissionDecision, reason?: string, by: "user" | "rule" = "user", answers?: Record<string, string>): void {
    const input = this.pending.get(id);
    this.pending.delete(id);
    this.write(permissionResponseLine(id, decision, input, reason, answers));
    this.emit({ t: "permission.resolved", id, decision, by });
  }

  /**
   * Live switch (verified on 2.1.263: `control_response` success + `system/status {permissionMode}`). Resolves on the
   * success response; a refusal (unknown mode, a policy such as disableBypassPermissionsMode) or no answer rejects, so
   * the daemon never records a mode the process is not actually in.
   */
  setPermissionMode(mode: string): Promise<void> {
    if (this.closed || this.closing) return Promise.reject(new Error("runner process has exited; the next turn starts with the new mode"));
    const id = `mode-${++this.modeCounter}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error("no answer from claude within 10 s")), 10_000);
      const settle = (err?: Error) => {
        clearTimeout(timer);
        this.modeRequests.delete(id);
        err ? reject(err) : resolve();
      };
      this.modeRequests.set(id, { resolve: () => settle(), reject: settle });
      this.write(setPermissionModeLine(id, mode));
    });
  }

  /** SIGTERM to the group; a runner that ignores it is SIGKILLed after 2 s so a stop never leaves it behind. */
  private async terminate(): Promise<void> {
    this.killGroup("SIGTERM");
    await Promise.race([this.exited.then(() => undefined), new Promise<void>((r) => setTimeout(r, 2000))]);
    if (!this.closed) this.killGroup("SIGKILL");
  }

  /** The runner leads its own process group (`detached`), so a signal here reaches its shells and MCP servers too. */
  private killGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.proc.pid, signal);
    } catch {
      try {
        this.proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** End stdin so an idle process exits on its own; kill after `graceMs`. No session.end is emitted. */
  async close(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      this.proc.stdin && typeof this.proc.stdin !== "number" && this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    const grace = opts.graceMs ?? 5000;
    if (grace > 0) await Promise.race([this.exited.then(() => undefined), new Promise<void>((r) => setTimeout(r, grace))]);
    if (!this.closed) await this.terminate();
    await this.exited;
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.aborting = true;
    try {
      this.write(interruptLine(`int-${++this.interruptCounter}`));
    } catch {
      /* stdin may already be closed */
    }
    const timeout = new Promise<void>((r) => setTimeout(r, 4000));
    await Promise.race([this.exited.then(() => undefined), timeout]);
    if (!this.closed) await this.terminate();
    try {
      this.proc.stdin && typeof this.proc.stdin !== "number" && this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    await this.exited;
    if (this.turnActive) this.emit({ t: "session.end", status: "aborted", summary: "aborted by user" });
  }

  private write(line: string) {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("stdin not piped");
    try {
      stdin.write(line);
      stdin.flush();
    } catch (e) {
      // EPIPE: the runner died before reading (e.g. refused to start). The exit handler reports why; do not throw
      // out of the constructor or send().
      if (!this.closed) this.emit({ t: "status", text: `stdin write failed: ${String((e as Error).message ?? e)}` });
    }
  }

  private async pumpStdout() {
    const stdout = this.proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          this.handleLine(line);
        }
      }
      if (buf.trim()) this.handleLine(buf);
    } catch (e) {
      this.emit({ t: "error", message: `stdout pump failed: ${String(e)}` });
    }
  }

  private handleLine(line: string) {
    // Track permission inputs so we can echo them back as updatedInput on allow.
    try {
      const m = JSON.parse(line);
      if (m?.type === "result") {
        this.resultSeen = true;
        this.turnActive = false;
      }
      if (m?.type === "control_request" && m.request?.subtype === "can_use_tool") {
        this.pending.set(m.request_id, m.request.input);
      }
      // set_permission_mode answers are the only control_responses we act on; the parser ignores the rest.
      if (m?.type === "control_response" && m.response?.request_id) {
        const waiting = this.modeRequests.get(String(m.response.request_id));
        if (waiting) {
          if (m.response.subtype === "error") waiting.reject(new Error(String(m.response.error ?? "refused")));
          else waiting.resolve();
        }
      }
    } catch {
      /* parser will report */
    }
    for (const ev of this.parser.feed(line)) this.emit(ev);
  }

  private async pumpStderr(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    const text = await new Response(stderr).text();
    this.stderrTail = text.slice(-2000);
    const trimmed = text.trim();
    // Non-zero exits report stderr through the `error` event in the exit handler; keep the rest as a status note.
    if (trimmed && this.proc.exitCode === 0) this.emit({ t: "status", text: `stderr: ${trimmed.slice(0, 500)}` });
  }
}
