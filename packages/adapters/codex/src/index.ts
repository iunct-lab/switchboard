import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ModelOption, PermissionDecision, PermissionModeOption, RunnerAdapter, RunnerDetection, RunnerLogin, RunnerSession, StartOptions } from "@switchboard/protocol";
import type { AskForApproval } from "./generated/v2/AskForApproval";
import type { SandboxMode } from "./generated/v2/SandboxMode";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { Turn } from "./generated/v2/Turn";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams";
import { approvalDecision, CLIENT_INFO, createCodexParser, jsonRpcError, jsonRpcNotification, jsonRpcRequest, jsonRpcResult } from "./parse.ts";

export * from "./parse.ts";

/** Official installer (macOS / Linux). We never bundle the CLI; the user installs and signs in themselves. */
export const CODEX_INSTALL_HINT = "curl -fsSL https://chatgpt.com/codex/install.sh | sh  (https://developers.openai.com/codex/cli)";
/** Fallback detection only: the ChatGPT desktop app ships a codex binary. Not recommended as the primary install. */
export const CHATGPT_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

export interface CodexAdapterOptions {
  /** Executable name or absolute path. Default: "codex" from PATH, then the ChatGPT.app fallback. */
  bin?: string;
  /** Sandbox of the `auto` / `untrusted` presets. Default workspace-write; scope dirs become extra writable roots. */
  sandbox?: SandboxMode;
  /** Approval policy of the `auto` preset (StartOptions.permissionMode unset or "auto"). `never` is not a default. */
  approvalPolicy?: Exclude<AskForApproval, "never">;
  /** Extra `-c key=value` config overrides passed to app-server. */
  config?: string[];
  /** Where to look for the user's config.toml (model default). Default ~/.codex. */
  codexHome?: string;
}

/** The task's own temp directory is the runner's TMPDIR (#787). */
export function appServerEnv(opts: StartOptions): Record<string, string> {
  return { ...opts.env, ...(opts.privateTmp ? { TMPDIR: opts.privateTmp } : {}) };
}

export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    // Do not leak a surrounding Claude Code session into the child; harmless for codex but keeps parity with the claude adapter.
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Permission presets. Auto delegates boundary approvals to Codex's reviewer; on-request retains manual review.
 * `full-access` is the only way to `never`, and it is an explicit choice — never a default.
 */
export const CODEX_PERMISSION_MODES: PermissionModeOption[] = [
  { value: "auto", label: "Auto（自動審査）", description: "サンドボックスを維持し、境界外の操作は Codex の自動レビュアーが審査。拒否された操作は停止または安全な代替へ" },
  { value: "on-request", label: "境界外は手動確認（従来の Auto）", description: "workspace-write サンドボックス内は自動、境界外の操作はユーザーが確認" },
  { value: "read-only", label: "読み取りのみ", description: "read-only サンドボックス。書き込みや外部アクセスは都度確認" },
  { value: "untrusted", label: "都度確認", description: "信頼済みの読み取りコマンド以外はすべて確認" },
  { value: "full-access", label: "すべて許可（危険）", description: "サンドボックスなし・確認なし（danger-full-access + never）", danger: true },
];
export const CODEX_DEFAULT_PERMISSION_MODE = "auto";

/** Models offered in the UI (#155). Any other id the CLI accepts can still be typed. */
export const CODEX_MODELS: ModelOption[] = [
  { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { value: "gpt-6-astra", label: "GPT-6 Astra" },
  { value: "gpt-6-sol", label: "GPT-6 Sol" },
  { value: "gpt-6-luna", label: "GPT-6 Luna" },
];

/** Thinking efforts offered in the UI (#833): the reasoning efforts every model above takes (`codex debug models`, 0.162.1). */
export const CODEX_EFFORTS: ModelOption[] = ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value }));

export interface CodexPermissionPreset {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
}

/** Preset name → (approvalPolicy, sandbox). Unknown / unset names fall back to `auto` with the adapter's own defaults. */
export function resolvePermissionPreset(permissionMode: string | undefined, o: Pick<CodexAdapterOptions, "sandbox" | "approvalPolicy"> = {}): CodexPermissionPreset {
  switch (permissionMode) {
    case "read-only":
      return { approvalPolicy: "on-request", sandbox: "read-only" };
    case "untrusted":
      return { approvalPolicy: "untrusted", sandbox: o.sandbox ?? "workspace-write" };
    case "full-access":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "on-request": // the pre-#58 name of the default policy; kept as an alias
      return { approvalPolicy: "on-request", sandbox: o.sandbox ?? "workspace-write" };
    default:
      return { approvalPolicy: o.approvalPolicy ?? "on-request", sandbox: o.sandbox ?? "workspace-write" };
  }
}

/** Approval policy of a preset (kept for callers that only need that half). */
export function resolveApprovalPolicy(permissionMode: string | undefined, fallback: Exclude<AskForApproval, "never"> = "on-request"): AskForApproval {
  return resolvePermissionPreset(permissionMode, { approvalPolicy: fallback }).approvalPolicy;
}

/**
 * Best-effort default model from ~/.codex/config.toml, so usage rows can be priced and the UI can say what an empty
 * model runs on (#155). Only the top-level `model` key counts: one inside a table (`[profiles.x]`) is not the default.
 */
export function defaultModelFromConfig(codexHome = join(homedir(), ".codex")): string | undefined {
  try {
    const toml = readFileSync(join(codexHome, "config.toml"), "utf8");
    const top = toml.split(/^\s*\[/m)[0] ?? "";
    const m = top.match(/^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m);
    return m?.[1] ?? m?.[2];
  } catch {
    return undefined;
  }
}

export function buildThreadStartParams(opts: StartOptions, o: CodexAdapterOptions = {}): ThreadStartParams {
  const preset = resolvePermissionPreset(opts.permissionMode, o);
  return {
    cwd: opts.cwd,
    model: opts.model ?? null,
    approvalPolicy: preset.approvalPolicy,
    approvalsReviewer: approvalsReviewer(opts.permissionMode),
    sandbox: preset.sandbox,
    ephemeral: false,
  };
}

export function buildThreadResumeParams(opts: StartOptions, threadId: string, o: CodexAdapterOptions = {}): ThreadResumeParams {
  const preset = resolvePermissionPreset(opts.permissionMode, o);
  return {
    threadId,
    cwd: opts.cwd,
    model: opts.model ?? null,
    approvalPolicy: preset.approvalPolicy,
    approvalsReviewer: approvalsReviewer(opts.permissionMode),
    sandbox: preset.sandbox,
  };
}

/** Scope directories other than cwd become extra writable roots (the Codex analogue of Claude's --add-dir). */
export function buildSandboxPolicy(opts: StartOptions, sandbox: SandboxMode = "workspace-write"): SandboxPolicy | null {
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  const extra = opts.scope.filter((d) => d && d !== opts.cwd);
  // privateTmp (#787): /tmp is read-only for the task; its own temp directory (TMPDIR, set in the constructor) is the only place under it
  if (opts.privateTmp) return { type: "workspaceWrite", writableRoots: [...extra, opts.privateTmp], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: false };
  return { type: "workspaceWrite", writableRoots: extra, networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false };
}

function approvalsReviewer(mode: string | undefined): "auto_review" | "user" {
  return mode === undefined || mode === "auto" ? "auto_review" : "user";
}

/** Turn-level overrides reset both policy and reviewer when switching modes in an existing process. */
export function buildTurnStartParams(threadId: string, text: string, opts: StartOptions, o: CodexAdapterOptions = {}): TurnStartParams {
  const preset = resolvePermissionPreset(opts.permissionMode, o);
  return { threadId, input: [{ type: "text", text, text_elements: [] }], approvalPolicy: preset.approvalPolicy, approvalsReviewer: approvalsReviewer(opts.permissionMode), sandboxPolicy: buildSandboxPolicy(opts, preset.sandbox), cwd: opts.cwd, ...(opts.effort ? { effort: opts.effort } : {}) };
}

function resolveBin(options: CodexAdapterOptions): { exe?: string; fallback: boolean } {
  if (options.bin) return { exe: existsSync(options.bin) ? options.bin : Bun.which(options.bin) ?? undefined, fallback: false };
  const onPath = Bun.which("codex");
  if (onPath) return { exe: onPath, fallback: false };
  return existsSync(CHATGPT_APP_CODEX) ? { exe: CHATGPT_APP_CODEX, fallback: true } : { exe: undefined, fallback: false };
}

/** What to type in a terminal tab when the login has run out (#180). Device flow: works on a machine without a browser. */
export const CODEX_LOGIN_HINT = "codex login --device-auth";

/**
 * `codex login status` (0.155.0-alpha.9.2): exit 0 = logged in, 1 = "Not logged in". Its output names the login method,
 * so it is discarded unread; the credential file is never looked at (#180). No answer within `timeoutMs`, or a CLI
 * without the subcommand → unknown.
 */
export async function loginStatus(exe: string, timeoutMs = 10_000): Promise<RunnerLogin> {
  try {
    const proc = Bun.spawn([exe, "login", "status"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: childEnv() });
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
 * Whether a rollout of the thread (`<codexHome>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`) is on this machine. The
 * default home is the spawned codex's: CODEX_HOME (inherited by the child), else ~/.codex.
 */
export function codexSessionExists(threadId: string, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): boolean {
  try {
    return readdirSync(join(codexHome, "sessions"), { recursive: true }).some((f) => String(f).endsWith(`-${threadId}.jsonl`));
  } catch {
    return false;
  }
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): RunnerAdapter {
  return {
    id: "codex",
    permissionModes: CODEX_PERMISSION_MODES,
    defaultPermissionMode: CODEX_DEFAULT_PERMISSION_MODE,
    models: CODEX_MODELS,
    efforts: CODEX_EFFORTS,
    loginArgs: ["login", "--device-auth"],
    loginHosts: ["auth.openai.com"],
    cliDefaultModel: () => defaultModelFromConfig(options.codexHome),
    hasSession: (id) => codexSessionExists(id, options.codexHome),
    async detect(): Promise<RunnerDetection> {
      const { exe, fallback } = resolveBin(options);
      if (!exe) return { available: false, note: `"${options.bin ?? "codex"}" not found on PATH. Install Codex CLI: ${CODEX_INSTALL_HINT}` };
      try {
        const proc = Bun.spawn([exe, "--version"], { stdout: "pipe", stderr: "pipe", env: childEnv() });
        const text = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        const version = text.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? text;
        const available = proc.exitCode === 0;
        return {
          available,
          version,
          path: exe,
          note: fallback ? `using the codex bundled with ChatGPT.app (fallback). Prefer the official installer: ${CODEX_INSTALL_HINT}` : undefined,
          ...(available ? { login: await loginStatus(exe), loginHint: CODEX_LOGIN_HINT } : {}),
        };
      } catch (e) {
        return { available: false, note: String(e) };
      }
    },
    start(opts, emit) {
      const { exe } = resolveBin(options);
      if (!exe) throw new Error(`codex not found. Install Codex CLI: ${CODEX_INSTALL_HINT}`);
      return new CodexSession(exe, opts, emit, options);
    },
  };
}

type RpcId = string | number;
interface RpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * One `codex app-server` process per task session, driven over stdio JSON-RPC.
 * Lifecycle: initialize → initialized → thread/start | thread/resume → turn/start … turn/completed.
 * Approvals arrive as server *requests*; we answer them when the user decides (never on their behalf).
 */
class CodexSession implements RunnerSession {
  readonly exited: Promise<number | null>;
  private proc: ReturnType<typeof Bun.spawn>;
  private parser = createCodexParser();
  private nextId = 1;
  private pending = new Map<number, (r: RpcResponse) => void>();
  /** permission.ask id (unique per process) → raw JSON-RPC id of the server request, replied with the same type. */
  private openApprovals = new Map<string, RpcId>();
  private nonce = Math.random().toString(16).slice(2, 6);
  private closed = false;
  private aborting = false;
  private closing = false;
  private stderrTail = "";
  private threadId?: string;
  private ready: Promise<void>;
  /** Turns are serialized: the next turn/start or turn/steer is decided only after the previous request answered. */
  private turnChain: Promise<void> = Promise.resolve();
  private queue: string[] = [];

  constructor(
    bin: string,
    private opts: StartOptions,
    private emit: (ev: AgentEvent) => void,
    private o: CodexAdapterOptions,
  ) {
    const args = ["app-server", "--listen", "stdio://"];
    for (const c of o.config ?? []) args.push("-c", c);
    this.proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, env: childEnv(process.env, appServerEnv(opts)), stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    const stderrDone = this.pumpStderr();
    const stdoutDone = this.pumpStdout();
    this.exited = this.proc.exited.then(async (code) => {
      // Bounded drain: MCP servers spawned by codex may inherit our pipes and outlive it; they must not hold the session open.
      await Promise.race([Promise.all([stdoutDone, stderrDone]), new Promise((r) => setTimeout(r, 1500))]);
      this.closed = true;
      this.killGroup("SIGKILL");
      for (const resolve of this.pending.values()) resolve({ error: { message: "codex exited" } });
      this.pending.clear();
      // Non-zero exit that we did not ask for: record stderr in the transcript. The daemon's exit handler owns the
      // status (session.end) so this is informational and safe to emit even after session.start.
      if (code !== 0 && !this.aborting && !this.closing) {
        this.emit({ t: "error", message: this.stderrTail.trim() || `codex exited with code ${code}` });
      }
      return code;
    });
    this.emit({ t: "message.delta", role: "user", text: opts.prompt });
    this.ready = this.handshake().catch((e) => {
      this.emit({ t: "error", message: `codex handshake failed: ${String((e as Error).message ?? e)}` });
      void this.close();
    });
  }

  private async handshake() {
    const init = await this.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
    if (init.error) throw new Error(init.error.message ?? "initialize failed");
    this.write(jsonRpcNotification("initialized"));
    const resume = this.opts.resumeSessionId;
    const res = resume
      ? await this.request("thread/resume", buildThreadResumeParams(this.opts, resume, this.o))
      : await this.request("thread/start", buildThreadStartParams(this.opts, this.o));
    if (res.error) throw new Error(res.error.message ?? "thread/start failed");
    const thread = (res.result as { thread?: Thread } | undefined)?.thread;
    if (!thread) throw new Error("thread/start returned no thread");
    this.threadId = thread.id;
    this.parser.state.model = this.opts.model ?? defaultModelFromConfig(this.o.codexHome);
    for (const ev of this.parser.threadStarted(thread)) this.emit(ev);
    this.enqueueTurn(this.opts.preamble ? `${this.opts.preamble}\n\n${this.opts.prompt}` : this.opts.prompt);
    for (const text of this.queue.splice(0)) this.enqueueTurn(text);
  }

  private enqueueTurn(text: string) {
    this.turnChain = this.turnChain.then(() => this.startTurn(text)).catch(() => undefined);
  }

  private async startTurn(text: string) {
    if (!this.threadId || this.closed) return;
    const active = this.parser.state.activeTurnId;
    let res: RpcResponse | undefined;
    if (active) {
      res = await this.request("turn/steer", { threadId: this.threadId, expectedTurnId: active, input: [{ type: "text", text, text_elements: [] }] } satisfies TurnSteerParams);
      // The turn may have completed between our check and the server's; fall back to a fresh turn.
      if (res.error) res = undefined;
    }
    if (!res) {
      res = await this.request("turn/start", buildTurnStartParams(this.threadId, text, this.opts, this.o));
      const turn = (res.result as { turn?: Turn } | undefined)?.turn;
      // The response precedes the turn/started notification; record the id now so a quick follow-up steers instead of colliding.
      if (turn && !this.parser.state.activeTurnId) this.parser.state.activeTurnId = turn.id;
    }
    if (res.error) this.emit({ t: "error", message: res.error.message ?? "turn/start failed" });
  }

  send(text: string): void {
    if (this.closed || this.closing) throw new Error("runner process has exited; resume the task instead");
    this.emit({ t: "message.delta", role: "user", text });
    if (!this.threadId) {
      this.queue.push(text);
      return;
    }
    this.enqueueTurn(text);
  }

  respondPermission(id: string, decision: PermissionDecision, _reason?: string, by: "user" | "rule" = "user"): void {
    const raw = this.openApprovals.get(id);
    if (raw === undefined) throw new Error(`no pending approval ${id}`);
    this.openApprovals.delete(id);
    this.write(jsonRpcResult(raw, approvalDecision(decision)));
    this.emit({ t: "permission.resolved", id, decision, by });
  }

  /** Applies from the next `turn/start` (its approvalPolicy / sandboxPolicy override the thread's); a turn in flight keeps its policy. The daemon notes the change in the transcript. */
  setPermissionMode(mode: string): void {
    if (this.closed || this.closing) throw new Error("runner process has exited; the next turn starts with the new mode");
    this.opts = { ...this.opts, permissionMode: mode };
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.aborting = true;
    // A stalled handshake must not make abort hang: give it a moment, then just kill.
    await Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, 3000))]);
    const turnId = this.parser.state.activeTurnId;
    let interrupted = false;
    if (this.threadId && turnId && !this.closed) {
      const completed = new Promise<void>((r) => {
        const check = setInterval(() => {
          if (!this.parser.state.activeTurnId || this.closed) {
            clearInterval(check);
            r();
          }
        }, 50);
      });
      // an app-server that never answers the interrupt must not keep abort (and the daemon's shutdown) waiting
      await Promise.race([this.request("turn/interrupt", { threadId: this.threadId, turnId }), new Promise<void>((r) => setTimeout(r, 3000))]);
      await Promise.race([completed, new Promise<void>((r) => setTimeout(r, 8000))]);
      interrupted = !this.parser.state.activeTurnId;
    }
    await this.close();
    // turn/completed(interrupted) already produced session.end(aborted); synthesize only if it never arrived.
    if (turnId && !interrupted) this.emit({ t: "session.end", status: "aborted", summary: "aborted by user" });
  }

  /** app-server has no graceful shutdown request; ending stdin makes it exit, kill after `graceMs` as a fallback. */
  async close(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      this.proc.stdin && typeof this.proc.stdin !== "number" && this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    const grace = opts.graceMs ?? 3000;
    if (grace > 0) await Promise.race([this.exited.then(() => undefined), new Promise<void>((r) => setTimeout(r, grace))]);
    if (!this.closed) await this.terminate();
    await this.exited;
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

  /* ---------- JSON-RPC plumbing ---------- */

  private request(method: string, params: unknown): Promise<RpcResponse> {
    if (this.closed) return Promise.resolve({ error: { message: "codex exited" } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try {
        this.write(jsonRpcRequest(id, method, params));
      } catch (e) {
        this.pending.delete(id);
        resolve({ error: { message: String((e as Error).message ?? e) } });
      }
    });
  }

  private write(line: string) {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("stdin not piped");
    try {
      stdin.write(line);
      stdin.flush();
    } catch (e) {
      // EPIPE: app-server died before reading. Pending requests are resolved by the exit handler.
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
    if (!line.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      this.emit({ t: "status", text: `unparsed: ${line.slice(0, 200)}` });
      return;
    }
    if (!m || typeof m !== "object") return;
    const hasId = m.id !== undefined && m.id !== null;
    if (hasId && typeof m.method !== "string") {
      const resolve = this.pending.get(Number(m.id));
      if (resolve) {
        this.pending.delete(Number(m.id));
        resolve({ result: m.result, error: m.error });
      }
      return;
    }
    if (hasId) {
      // Server request. Only approvals are supported; they get a per-process-unique public id the UI answers with.
      const publicId = `${this.nonce}:${String(m.id)}`;
      const events = this.parser.feed(JSON.stringify({ ...m, id: publicId }));
      const ask = events.find((e) => e.t === "permission.ask");
      if (ask && ask.t === "permission.ask") this.openApprovals.set(ask.id, m.id as RpcId);
      else this.write(jsonRpcError(m.id as RpcId, `Switchboard does not support ${m.method}`));
      for (const ev of events) this.emit(ev);
      return;
    }
    for (const ev of this.parser.feed(line)) this.emit(ev);
  }

  private async pumpStderr(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    const reader = stderr.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.stderrTail = (this.stderrTail + dec.decode(value, { stream: true })).slice(-2000);
    }
  }
}
