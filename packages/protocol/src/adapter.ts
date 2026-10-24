import type { AgentEvent, PermissionDecision, RunnerId } from "./events.ts";
import type { ExecutionMode, Attachment, ModelOption, PermissionModeOption, RunnerLogin } from "./model.ts";

/** One MCP server as Claude Code's `mcpServers` holds it (stdio: command/args/env; http / sse: url/headers). */
export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface StartOptions {
  executionMode?: ExecutionMode;
  cwd: string;
  /** Directories the task is allowed to touch. cwd is always included. */
  scope: string[];
  prompt: string;
  model?: string;
  /** Runner-native permission mode (one of RunnerAdapter.permissionModes). Unset = the adapter's default. */
  permissionMode?: string;
  /** Runner-native thinking effort (one of RunnerAdapter.efforts, #833). Unset = the CLI's own default. */
  effort?: string;
  /** Resume a previous runner session (runner-native id). */
  resumeSessionId?: string;
  /**
   * Sent to the runner ahead of the first prompt but not shown as the user's message: the daemon's recap of the
   * task when the session to resume is not on this machine (#179).
   */
  preamble?: string;
  /**
   * Variables added to the runner's process, over the ones it inherits: the PATH that puts the check in front of
   * `gh` (#661, docs/design/secret-guard.md).
   */
  env?: Record<string, string>;
  /**
   * Commands to run before each shell command (absolute paths, quoted for the shell). Each gets the runner's hook input
   * on its standard input; exit 2 stops the command (#764, docs/design/shared-tmp-guard.md). Claude Code makes them
   * PreToolUse hooks for Bash. Codex has no hook it can trust without a record in ~/.codex (#787), so it uses `privateTmp`.
   */
  guards?: string[];
  /**
   * A directory only this task writes under (#787): the temp area of a runner that cannot run `guards`. Codex makes it
   * TMPDIR and a writable root and closes the rest of /tmp, so a fixed name there fails with a read-only error and
   * cannot meet another session's files. Claude Code ignores it. The daemon creates it and removes it when the task ends.
   */
  privateTmp?: string;
  /**
   * Files attached to the first prompt (#125). Their paths are already in `prompt`; an adapter whose runner cannot
   * reach the paths (DAK in its container, #124) sends the contents along. Others ignore it.
   */
  attachments?: Attachment[];
  /**
   * Where files the runner makes may be written (#124): the task's attachment directory. An adapter whose runner
   * hands files back (DAK's artifacts) writes them here and emits `artifact(file)`; the daemon registers each as an
   * attachment. Unset = the daemon has no attachment store.
   */
  attachmentDir?: string;
  /**
   * The MCP servers Switchboard hands the task, and only those: Claude Code reads no other MCP configuration
   * (`--strict-mcp-config`), so the user-wide ones in ~/.claude.json are not started per task (#2090). Other runners
   * ignore it.
   */
  mcpServers?: Record<string, McpServerConfig>;
}

export interface RunnerSession {
  /** Send a follow-up user turn. `attachments`: as in StartOptions, for this turn. */
  send(text: string, attachments?: Attachment[]): void;
  /**
   * Answer a pending permission.ask. `by` says who decided (default user; the daemon passes "rule" for auto-allows).
   * `answers` (question text → chosen label(s) / free text) is the user's reply to a question tool such as Claude's
   * AskUserQuestion; adapters whose runner has no such tool ignore it.
   */
  respondPermission(id: string, decision: PermissionDecision, reason?: string, by?: "user" | "rule", answers?: Record<string, string>): void;
  /**
   * Switch the permission mode of the live session (#58). Claude applies it at once (`set_permission_mode`) and
   * resolves once the runner confirmed (rejects if it refused), Codex from the next turn (`turn/start` overrides).
   * Adapters that cannot switch a live process omit it; the daemon then releases the idle process so the next turn
   * resumes with the new mode.
   */
  setPermissionMode?(mode: string): void | Promise<void>;
  /** Interrupt and stop the runner process. Emits session.end(aborted) only if a turn was in flight. */
  abort(): Promise<void>;
  /**
   * Release an idle runner process without treating it as an abort: the task keeps its status and can be
   * continued later with `resumeSessionId`. Adapters end stdin and kill after `graceMs` (default a few seconds;
   * 0 = kill immediately, used at daemon shutdown).
   */
  close(opts?: { graceMs?: number }): Promise<void>;
  /** Resolves with the process exit code when the runner exits. */
  readonly exited: Promise<number | null>;
}

export interface RunnerDetection {
  available: boolean;
  version?: string;
  path?: string;
  note?: string;
  /**
   * Whether the runner's own login is usable, judged from the runner's own status command (#180). Switchboard never
   * reads the credential files. Absent = the runner has no such login (DAK).
   */
  login?: RunnerLogin;
  /** What to type in a terminal tab to log in again. */
  loginHint?: string;
}

/**
 * A RunnerAdapter wraps one agent CLI/API and speaks AgentEvent.
 * Adapters must be optional: the daemon boots with any subset installed.
 */
export interface RunnerAdapter {
  readonly id: RunnerId;
  /** Permission modes this runner offers, in display order. Omit / empty when the runner has no such knob (DAK). */
  readonly permissionModes?: PermissionModeOption[];
  /** Mode used when StartOptions.permissionMode is unset — the same one the runner's own terminal starts in. */
  readonly defaultPermissionMode?: string;
  /** Models this runner offers, in display order (#155). Omit / empty when the runner picks its model itself (DAK). */
  readonly models?: ModelOption[];
  /** Thinking efforts this runner offers, in display order (#833). Omit / empty when the runner decides itself (DAK). */
  readonly efforts?: ModelOption[];
  /**
   * The model the CLI uses when StartOptions.model is unset — the user's own CLI setting, read on every call so a
   * change there shows up without a restart. Undefined = not set / not readable.
   */
  cliDefaultModel?(): string | undefined;
  detect(): Promise<RunnerDetection>;
  start(opts: StartOptions, emit: (ev: AgentEvent) => void): RunnerSession;
  /**
   * Whether the runner's own record of a session is on this machine, so `resumeSessionId` can continue it. False =
   * the task came from another machine without it; the daemon then starts a new session with a recap. Omit when
   * the runner keeps its sessions elsewhere (DAK).
   */
  hasSession?(sessionId: string): boolean;
  /**
   * The runner's own login command, after its executable (#354): the daemon runs it and relays the URL / device code
   * it prints to the screen, so nobody opens a terminal. Omit when the runner has no login of its own (DAK).
   */
  readonly loginArgs?: string[];
  /** Hosts the login URL may be on: another URL the CLI prints first (an update notice) is not relayed. */
  readonly loginHosts?: string[];
}
