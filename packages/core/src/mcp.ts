import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mimeFor } from "./attachments.ts";
import { tokenEquals } from "./auth.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AgentEvent, McpServerConfig, PermissionDecision, StagedChange, StopRecord, Task } from "@switchboard/protocol";
import { z } from "zod";
import { lastAttempt, RETRY_DELAYS_MS, StopReport } from "./stops.ts";

/**
 * Workspace MCP (proposal §3, issue #10; per-task tokens cover #31).
 * The daemon is an MCP server so runners without their own file tools (DAK) — or Claude/Codex via --mcp-config — can
 * touch the local repository *through Switchboard's guards*:
 *   fs.list / fs.read / fs.grep   read within the task's scope only (realpath + prefix check, symlinks resolved);
 *                                 fs.read returns images as image content and other binaries as a blob resource
 *   exec.run                      read-only commands run at once; anything else raises permission.ask and waits
 * Every call is recorded on the task as tool.call / tool.result. One endpoint per task: /mcp/<taskId>?token=<disposable>.
 */

export interface McpPolicy {
  exec: { readOnly: string[]; gitReadOnly: string[]; denyFlags: Record<string, string[]>; timeoutMs: number; maxOutputBytes: number };
  fs: { maxReadBytes: number; maxListEntries: number; maxGrepMatches: number; maxGrepFileBytes: number; maxGrepFiles: number };
  sessions: { maxPerTask: number; idleMs: number };
  /**
   * The MCP servers a Claude Task gets (#2090), the only ones it reads. `workspaces` (Workspace names) limits one to
   * the Tasks of those Workspaces; without it every Task gets it.
   */
  servers: Record<string, McpServerConfig & { workspaces?: string[] }>;
}

export const DEFAULT_POLICY: McpPolicy = {
  exec: {
    readOnly: ["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "pwd", "echo", "stat", "file", "tree", "du", "which", "uname", "cut", "uniq", "diff", "sort"],
    gitReadOnly: ["status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "describe"],
    denyFlags: {
      find: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-files0-from", "-L", "-follow"],
      sort: ["-o", "--output", "--compress-program", "--files0-from", "-T", "--temporary-directory"],
      wc: ["--files0-from"],
      du: ["--files0-from", "-L", "--dereference"],
      ls: ["-L", "--dereference"],
      grep: ["-R", "--dereference-recursive", "-S"],
      diff: ["-r", "--recursive", "-l", "--paginate"],
      rg: ["--pre", "--pre-glob", "-L", "--follow", "--hostname-bin", "-z", "--search-zip"],
      tree: ["-o", "-l", "-R"],
      file: ["-C", "--compile", "-m", "--magic-file", "-f", "--files-from", "-z", "-Z", "--uncompress", "--uncompress-noreport"],
      git: ["--output", "--help", "--show-signature"],
    },
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
  },
  fs: { maxReadBytes: 262_144, maxListEntries: 2000, maxGrepMatches: 500, maxGrepFileBytes: 1_048_576, maxGrepFiles: 5000 },
  sessions: { maxPerTask: 8, idleMs: 30 * 60_000 },
  servers: {},
};

export function loadMcpPolicy(paths: string[]): McpPolicy {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const y = parseYaml(readFileSync(p, "utf8")) as Partial<McpPolicy> | null;
    return {
      exec: { ...DEFAULT_POLICY.exec, ...(y?.exec ?? {}), denyFlags: { ...DEFAULT_POLICY.exec.denyFlags, ...(y?.exec?.denyFlags ?? {}) } },
      fs: { ...DEFAULT_POLICY.fs, ...(y?.fs ?? {}) },
      sessions: { ...DEFAULT_POLICY.sessions, ...(y?.sessions ?? {}) },
      servers: validServers(y?.servers),
    };
  }
  return DEFAULT_POLICY;
}

/** The `servers` entries that are objects with `workspaces` absent or a list: a bare `name:` or `workspaces: x` is left out and named on the console, not fatal for every Task (#2136 review). */
function validServers(raw: unknown): McpPolicy["servers"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const ok = (v: unknown): v is McpPolicy["servers"][string] =>
    !!v && typeof v === "object" && !Array.isArray(v) && (!("workspaces" in v) || (Array.isArray(v.workspaces) && v.workspaces.every((w) => typeof w === "string")));
  const skipped = Object.entries(raw).filter(([, v]) => !ok(v)).map(([name]) => name);
  // said once at start, so a typo does not just look like a server that is not there
  if (skipped.length) console.warn(`mcp.yaml: servers ${skipped.join(", ")} skipped: not an object with workspaces as a list`);
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => ok(v)));
}

/** The servers of `policy` a Task of `workspace` (its name; null = no Workspace) gets, without `workspaces` (#2090). */
export function mcpServersFor(policy: McpPolicy, workspace: string | null): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, { workspaces, ...server }] of Object.entries(policy.servers)) {
    if (!workspaces || (workspace !== null && workspaces.includes(workspace))) out[name] = server;
  }
  return out;
}

/** What the MCP layer needs from the task manager. Kept as an interface so tests can drive it without a daemon. */
export interface TaskBridge {
  getTask(taskId: string): Task | null;
  record(taskId: string, ev: AgentEvent): void;
  /** Raise permission.ask on the task and resolve with the user's decision (or a Knowledge allow rule the user wrote). */
  askPermission(taskId: string, ask: Omit<Extract<AgentEvent, { t: "permission.ask" }>, "t" | "id">): Promise<PermissionDecision>;
  /** Record a stop the runner reported (#948); refused when it reserves a retry the rule does not allow (#949). */
  recordStop(taskId: string, report: StopReport): { ok: true } | { ok: false; why: string };
  /** The task's stop `reportId` as last recorded (#949). */
  stopOf(taskId: string, reportId: string): StopRecord | undefined;
  /** Staged writes: nothing here touches the repository until the user applies it in the UI. */
  staging?: {
    stageWrite(taskId: string, scope: Scope, path: string, content: string): StagedChange;
    stagePatch(taskId: string, scope: Scope, path: string, find: string, replace: string): StagedChange;
    list(taskId: string): StagedChange[];
  };
}

/* ---------- scope containment ---------- */

export class Scope {
  private roots: string[];
  constructor(dirs: string[]) {
    this.roots = dirs.filter(Boolean).map((d) => safeRealpath(resolve(d)));
  }
  /** Resolve `p` (relative to the first root, or absolute) to a real path inside the scope, or throw. */
  resolve(p: string): string {
    const abs = resolve(this.roots[0] ?? "/", p);
    // Resolve symlinks on the deepest existing ancestor so a link pointing outside cannot smuggle a path in.
    const real = safeRealpath(abs);
    if (!this.roots.some((r) => real === r || real.startsWith(r + sep))) throw new Error(`outside the task scope: ${p}`);
    return real;
  }
  /** Where git stops looking for a repository: the folder above each root, so git finds none that holds the scope. */
  get gitCeilings(): string {
    return this.roots.map((r) => dirname(r)).join(":");
  }
  /** `GIT_CEILING_DIRECTORIES` splits on `:`, so a folder above a root whose name has one is not a ceiling git keeps. */
  get gitCeilingsHold(): boolean {
    return this.roots.every((r) => !dirname(r).includes(":"));
  }
  get first(): string {
    return this.roots[0] ?? "/";
  }
  display(real: string): string {
    const root = this.roots.find((r) => real === r || real.startsWith(r + sep));
    return root ? relative(root, real) || "." : real;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function safeRealpath(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

/* ---------- exec policy ---------- */

/** Anything that would give `sh` a job: separators, redirections, substitutions, grouping, globs are fine (no shell = no expansion). */
const SHELL_SYNTAX = /[;|&<>$`(){}\n\r]/;

/**
 * Split a command line into argv the way a POSIX shell would for plain words with single/double quotes and
 * backslashes. Returns null when the line contains shell syntax we refuse to interpret (see SHELL_SYNTAX).
 */
export function parseArgv(command: string): string[] | null {
  if (SHELL_SYNTAX.test(command)) return null;
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < command.length) cur += command[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(cur);
  return out;
}

export interface ExecClassification {
  verdict: "read-only" | "needs-approval";
  argv?: string[];
  reason?: string;
}

/**
 * How a bundle of short options is read when a single-letter flag is denied: getopt tools stop at the first letter that
 * takes a value (the rest of the word is that value); any other binary (tree takes values from the next arguments) has
 * every letter read.
 */
const SHORT_WITH_VALUE: Record<string, string> = { sort: "ktTS", file: "FePf", grep: "efmABCdD", rg: "ABCeEfgjmMrtTd", du: "BdtX", diff: "CUDFILSWxX" };

/**
 * `p` (absolute) resolved in the order the OS opens it: a symlink is read before the `..` after it applies (`path.resolve`
 * and Bun's realpath drop `link/..` by its spelling, so `link/../x` would look like `./x`). A missing component ends the
 * walk with the rest joined as spelled: the OS cannot pass through it either.
 */
export function osResolve(p: string): string {
  const todo = p.split("/").filter(Boolean);
  let cur = "/";
  for (let hops = 0; todo.length; ) {
    const part = todo.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    let target: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch {
      return join(next, ...todo);
    }
    if (target === undefined) {
      cur = next;
      continue;
    }
    if (++hops > 40) return next; // a loop: the OS gives up as well
    todo.unshift(...target.split("/").filter(Boolean));
    if (target.startsWith("/")) cur = "/";
  }
  return cur;
}

/**
 * The words of an argument that may name a path: the argument itself (`-` is stdin), and for an option also the value
 * of `--opt=value` and, in a word of short options, every tail after its first letter (`-f<path>`, `-rnf<path>`: which
 * letter takes a value is not known per binary, so each tail is tried). An option-looking word is a path too: `--` does
 * not reliably end the options (`diff -I --` takes it as the value of `-I`), and after a real `--` it names a file.
 */
function pathWords(a: string): string[] {
  if (a === "-") return [];
  if (!a.startsWith("-")) return [a];
  const values = a.startsWith("--") ? (a.includes("=") ? [a.slice(a.indexOf("=") + 1)] : []) : Array.from({ length: a.length - 2 }, (_, i) => a.slice(i + 2));
  return [a, ...values.filter(Boolean)];
}

/**
 * Read-only means: a single argv (no shell syntax), an allow-listed binary, no flag that makes it write or execute,
 * and every path-looking argument inside the scope. Everything else needs the user.
 */
export function classifyCommand(command: string, policy: McpPolicy["exec"], scope?: Scope, cwd?: string): ExecClassification {
  const argv = parseArgv(command.trim());
  if (!argv || argv.length === 0) return { verdict: "needs-approval", reason: "shell syntax or empty command" };
  if (argv[0]!.includes("/")) return { verdict: "needs-approval", reason: "a path as the command" };
  const bin = argv[0]!;
  if (/=/.test(argv[0]!)) return { verdict: "needs-approval", reason: "environment assignment" };
  if (bin === "git") {
    // the subcommand is the first argument: a global option before it can take the next word as its value
    // (`git --namespace status config …` runs config), so none is read as read-only
    const sub = argv[1];
    if (!sub || sub.startsWith("-") || !policy.gitReadOnly.includes(sub)) return { verdict: "needs-approval", reason: `git ${sub ?? ""} is not read-only` };
    // a signature placeholder in a format (%G?, %GG, %GK, …, also with the %+ / %- / %<space> modifiers) starts gpg,
    // like --show-signature
    if (argv.some((a) => /%[-+ ]?G/.test(a))) return { verdict: "needs-approval", reason: "a %G placeholder starts gpg" };
    if (scope && !scope.gitCeilingsHold) return { verdict: "needs-approval", reason: "a folder above the scope has a ':' in its name, so git could look for a repository above the scope" };
  } else if (!policy.readOnly.includes(bin)) return { verdict: "needs-approval", reason: `${bin} is not in the read-only list` };
  if (bin === "uniq") {
    let operands = 0;
    let options = true;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (options && a === "--") { options = false; continue; }
      // These options consume their following value, not an input/output operand.
      if (options && ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"].includes(a)) { i++; continue; }
      if (options && a.startsWith("-") && a !== "-") continue;
      if (++operands >= 2) return { verdict: "needs-approval", reason: "uniq output argument can write" };
    }
  }
  const deny = policy.denyFlags[bin] ?? [];
  // single-letter denied flags also count inside a bundle of short options (`sort -uo out`, `sort -oout`, `sort -o./out`):
  // read as SHORT_WITH_VALUE says (`sort -to` and `git log -Sfoo` stay read-only, `tree -Lo 1 out` asks)
  const shortDeny = deny.filter((d) => /^-[A-Za-z]$/.test(d)).map((d) => d[1]!);
  for (const a of argv.slice(1)) {
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (deny.includes(a) || deny.includes(name) || deny.some((d) => d.endsWith("=") && a.startsWith(d))) return { verdict: "needs-approval", reason: `${bin} ${a} can write, execute or read outside the scope` };
    if (shortDeny.length && /^-[A-Za-z0-9]/.test(a) && !a.startsWith("--")) {
      const takesValue = SHORT_WITH_VALUE[bin] ?? "";
      for (const c of a.slice(1)) {
        if (shortDeny.includes(c)) return { verdict: "needs-approval", reason: `${bin} ${a} can write, execute or read outside the scope` };
        if (takesValue.includes(c) || (takesValue && !/[A-Za-z0-9]/.test(c))) break;
      }
    }
    // GNU tools take any unambiguous prefix of a long option (`sort --compress-prog=sh`, `sort --outp=x`)
    if (/^--[^=]+$/.test(name) && deny.some((d) => d.startsWith("--") && d.replace(/=$/, "").startsWith(name))) return { verdict: "needs-approval", reason: `${bin} ${a} can write, execute or read outside the scope` };
    // Every argument is treated as a potential path: it must resolve inside the scope (this also catches a relative
    // path through a symlink that points outside). Non-path words resolve harmlessly under the root. A path can also
    // ride in an option (`--from-file=<path>`, `-f<path>`), so those words count too.
    for (const p of scope ? pathWords(a) : []) {
      // absolute: `~` is the home folder, a relative path is from where the command runs (`exec.run`'s cwd), not from
      // the scope's first root
      const abs = p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(cwd ?? scope!.first, p);
      // with `..` also in the order the OS opens it: a symlink before the `..` can lead outside (osResolve)
      const opened = p.split("/").includes("..") ? osResolve(p.startsWith("~") ? `${homedir()}/${p.slice(1)}` : p.startsWith("/") ? p : `${cwd ?? scope!.first}/${p}`) : undefined;
      let real: string;
      try {
        real = scope!.resolve(abs);
        if (opened) scope!.resolve(opened);
      } catch {
        return { verdict: "needs-approval", reason: `${a} is outside the task scope` };
      }
      // diff on a directory (an operand or an option's value) compares the files inside it, through their symlinks,
      // without -r too
      if (bin === "diff" && (isDirectory(real) || (opened && isDirectory(opened)))) {
        return { verdict: "needs-approval", reason: `diff ${a} reads the files inside a directory` };
      }
    }
  }
  return { verdict: "read-only", argv };
}

/**
 * Where a read-only command's name leads: only absolute PATH entries count (an empty or relative entry would look in
 * the task's own folder), and a program inside the task scope is not run without the user (the agent can put files there).
 */
export function resolveCommand(name: string, path: string, scope: Scope): { exe: string } | { reason: string } | { missing: string } {
  const exe = Bun.which(name, { PATH: absolutePathEntries(path), cwd: "/" });
  if (!exe) return { missing: `command not found: ${name}` };
  try {
    scope.resolve(exe);
    return { reason: "the command resolves inside the task scope" };
  } catch {
    return { exe };
  }
}

/** PATH without its empty and relative entries (they would name a folder the task can write). */
export function absolutePathEntries(path: string): string {
  return path.split(":").filter((p) => p.startsWith("/")).join(":");
}

/** A folder that does not exist and cannot be made by the daemon's user: a read-only command has no place to write. */
export const READ_ONLY_TMPDIR = "/nonexistent/switchboard-read-only";

/** The environment a read-only command sees: no daemon secrets, no runner session markers. */
export function minimalEnv(cwd: string): Record<string, string> {
  // PATH without its relative entries (a tool that runs another program by name, git's pager or a decompressor, must not
  // find one the task can put in its folder), nowhere to write temporary files (sort spills there on a large input), and
  // no opportunistic write of git's index (`git status` refreshes it otherwise), and no fetch of missing objects in a
  // partial clone
  const env: Record<string, string> = { PATH: absolutePathEntries(process.env.PATH ?? "/usr/bin:/bin"), HOME: process.env.HOME ?? cwd, PWD: cwd, TERM: "dumb", LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: READ_ONLY_TMPDIR, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  return env;
}

/** Regexes with nested quantifiers can take exponential time on one line; refuse them instead of freezing the daemon. */
export function safeRegExp(pattern: string): RegExp {
  if (pattern.length > 200) throw new Error("pattern too long (200 chars max)");
  if (/\([^)]*[*+][^)]*\)\s*[*+{]/.test(pattern) || /[*+]\?[*+]/.test(pattern)) throw new Error("pattern has nested quantifiers; rewrite it without (…)* / (…)+");
  return new RegExp(pattern);
}

/** Read up to `max` bytes from a stream, then stop (and let the caller kill the producer). */
async function readCapped(stream: ReadableStream<Uint8Array> | null | number, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!stream || typeof stream === "number") return { text: "", truncated: false };
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if (text.length > max) {
      text = text.slice(0, max);
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { text, truncated };
}

/** Why a process could not start that may pass by itself (#949). */
const PASSING_SPAWN = new Set(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"]);

/** A failure that may pass (#949): what it was, whether repeating is harmless, and the result to answer with if it is not retried. */
class PassingFailure extends Error {
  constructor(
    message: string,
    readonly safety: StopRecord["safety"],
    readonly result?: unknown,
  ) {
    super(message);
  }
}

/** exec.run children lead their own process group (`detached`), so a kill reaches what the command left behind too. */
function killGroup(proc: { pid: number; kill(signal?: NodeJS.Signals): void }, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/* ---------- per-task endpoints ---------- */

interface Endpoint {
  taskId: string;
  token: string;
  task: Task;
  /** One McpServer + transport per MCP session (a Protocol instance binds to exactly one transport). */
  sessions: Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport; lastSeen: number }>;
  createdAt: number;
  /** exec.run processes still running; `revoke` kills their groups. */
  running: Set<{ pid: number; kill(signal?: NodeJS.Signals): void }>;
}

export class WorkspaceMcp {
  private endpoints = new Map<string, Endpoint>();

  constructor(
    private bridge: TaskBridge,
    private policy: McpPolicy = DEFAULT_POLICY,
    private baseUrl: () => string = () => "",
  ) {}

  /** How a retry waits (#949); a test replaces it. */
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms);
  /** How exec.run starts a process; a test replaces it to make a start fail for a passing reason (#949). */
  spawn: typeof Bun.spawn = Bun.spawn;

  /**
   * exec.run's bounded retry (#949): a passing failure of a run that is harmless to repeat (the system could not start
   * it for now, or a read-only command timed out) is tried again by the rule of `reserveStopRetry` — recorded as the
   * task's stop before the wait, resolved on success, exhausted when the tries are used up. Anything else, and a refused
   * retry, is answered as before. The stop's id comes from the command and its folder, and its tries from the task's
   * events, so the same command called again — by the runner, or after a restart — continues it rather than starting over.
   */
  private async withRetry<T>(taskId: string, key: string, command: string, once: () => Promise<T>): Promise<T> {
    const id = `exec-${Bun.hash(key).toString(36)}`;
    const report = (rest: Partial<StopReport>): StopReport => ({ id, op: "exec.run", target: command.slice(0, 200), reason: "transient", evidence: "", safety: "unknown", conditions: [], actions: [], state: "waiting", ...rest });
    const issued = this.endpoints.get(taskId);
    for (;;) {
      const last = this.bridge.stopOf(taskId, id);
      const prev = last && last.state !== "resolved" ? last : undefined;
      try {
        const out = await once();
        if (prev) this.bridge.recordStop(taskId, report({ safety: prev.safety, evidence: prev.evidence, state: "resolved", actions: [...prev.actions, { attempt: lastAttempt(prev), at: 0, what: "再実行で成功", ok: true }].slice(-20) }));
        return out;
      } catch (e) {
        if (!(e instanceof PassingFailure)) {
          // a retry not approved (or failing otherwise): the stop waits for the person, its tries kept
          if (prev?.state === "retrying") this.bridge.recordStop(taskId, report({ safety: prev.safety, evidence: prev.evidence, state: "waiting", actions: [...prev.actions, { attempt: lastAttempt(prev), at: 0, what: `再実行できず: ${String((e as Error).message ?? e).slice(0, 150)}`, ok: false }].slice(-20) }));
          throw e;
        }
        const attempt = (prev ? lastAttempt(prev) : 0) + 1;
        const delay = RETRY_DELAYS_MS[attempt - 1];
        const what = delay ? `${delay / 1000} 秒後に再実行` : "再実行";
        const r = this.bridge.recordStop(taskId, report({ safety: e.safety, evidence: e.message, state: "retrying", actions: [...(prev?.actions ?? []), { attempt, at: 0, what, ok: null }].slice(-20) }));
        if (!r.ok) {
          if (e.result !== undefined) return e.result as T;
          throw new Error(`${e.message}（${r.why}）`);
        }
        await this.sleep(delay!);
        // the task ended (or its endpoint was revoked) while waiting: nothing may start for it now
        if (this.endpoints.get(taskId) !== issued) throw new Error("task ended; not retried");
      }
    }
  }

  /** Revoke the current token and issue a fresh one (e.g. after handing a URL to a container that is now done with it). */
  async rotate(taskId: string): Promise<{ url: string; token: string }> {
    await this.revoke(taskId);
    return this.issue(taskId);
  }

  /** The scope of a task's endpoint (used by the staging routes to re-check containment at apply time). */
  scopeOf(task: Task): Scope {
    return new Scope(task.scope.length ? task.scope : [task.cwd]);
  }

  /** Issue (or return) the disposable endpoint for a task. Revoked when the task ends. */
  issue(taskId: string): { url: string; token: string } {
    let ep = this.endpoints.get(taskId);
    if (!ep) {
      const task = this.bridge.getTask(taskId);
      if (!task) throw new Error("task not found");
      ep = { taskId, token: `mcp_${crypto.randomUUID().replace(/-/g, "")}`, task, sessions: new Map(), createdAt: Date.now(), running: new Set() };
      this.endpoints.set(taskId, ep);
    }
    return { url: `${this.baseUrl()}/mcp/${taskId}`, token: ep.token };
  }

  /** Whether `token` is the task's current endpoint token (the same check as `handle`): the OpenTelemetry route's (#2236). */
  verify(taskId: string, token: string | null): boolean {
    const ep = this.endpoints.get(taskId);
    return !!ep && tokenEquals(token, ep.token);
  }

  has(taskId: string): boolean {
    return this.endpoints.has(taskId);
  }

  async revoke(taskId: string): Promise<void> {
    const ep = this.endpoints.get(taskId);
    if (!ep) return;
    this.endpoints.delete(taskId);
    for (const p of ep.running) killGroup(p, "SIGKILL");
    ep.running.clear();
    for (const s of ep.sessions.values()) {
      await s.transport.close().catch(() => undefined);
      await s.server.close().catch(() => undefined);
    }
  }

  async revokeAll(): Promise<void> {
    await Promise.all([...this.endpoints.keys()].map((id) => this.revoke(id)));
  }

  /**
   * HTTP entry: /mcp/<taskId>. Token via Authorization: Bearer or ?token=. Sessions (mcp-session-id) map to transports.
   * A new session is only built for an `initialize` request; sessions are capped per task and expire when idle.
   */
  async handle(taskId: string, token: string | null, req: Request): Promise<Response> {
    const ep = this.endpoints.get(taskId);
    if (!ep || !tokenEquals(token, ep.token)) return Response.json({ error: "unauthorized" }, { status: 401 });
    this.expireIdle(ep);
    const sid = req.headers.get("mcp-session-id");
    let session = sid ? ep.sessions.get(sid) : undefined;
    if (!session) {
      if (sid) return Response.json({ error: "unknown session" }, { status: 404 });
      if (req.method !== "POST" || !(await isInitialize(req))) return Response.json({ error: "no session; send initialize first" }, { status: 400 });
      if (ep.sessions.size >= this.policy.sessions.maxPerTask) return Response.json({ error: "too many sessions for this task" }, { status: 429 });
      const server = this.buildServer(ep.task);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          ep.sessions.set(id, { server, transport, lastSeen: Date.now() });
        },
        onsessionclosed: (id) => {
          ep.sessions.delete(id);
        },
      });
      await server.connect(transport);
      session = { server, transport, lastSeen: Date.now() };
      // If initialize fails the transport never registers a session; make sure it is not left connected.
      const res = await transport.handleRequest(req);
      if (!res.headers.get("mcp-session-id")) await server.close().catch(() => undefined);
      return res;
    }
    session.lastSeen = Date.now();
    if (req.method === "DELETE") {
      // Explicit session end: drop it ourselves so the map never depends on the transport's callback timing.
      ep.sessions.delete(sid!);
      const res = await session.transport.handleRequest(req);
      await session.server.close().catch(() => undefined);
      return res;
    }
    return session.transport.handleRequest(req);
  }

  private expireIdle(ep: Endpoint) {
    const cutoff = Date.now() - this.policy.sessions.idleMs;
    for (const [id, s] of ep.sessions) {
      if (s.lastSeen < cutoff) {
        ep.sessions.delete(id);
        void s.transport.close().catch(() => undefined);
        void s.server.close().catch(() => undefined);
      }
    }
  }

  /* ---------- tools ---------- */

  private buildServer(task: Task): McpServer {
    const server = new McpServer({ name: "switchboard-workspace", version: "0.1.0" }, { capabilities: { tools: {} } });
    const scope = new Scope(task.scope.length ? task.scope : [task.cwd]);
    const taskId = task.id;
    const fs = this.policy.fs;
    const execPolicy = this.policy.exec;

    const run = async <T>(name: string, input: unknown, summary: string, fn: () => Promise<T> | T): Promise<{ content: Array<{ type: "text"; text: string } | NonTextContent>; isError?: boolean }> => {
      const id = `mcp_${crypto.randomUUID().slice(0, 8)}`;
      this.bridge.record(taskId, { t: "tool.call", id, name, input, summary });
      try {
        const out = await fn();
        if (out instanceof NonText) {
          this.bridge.record(taskId, { t: "tool.result", id, ok: true, summary: out.summary });
          return { content: [out.content] };
        }
        const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        this.bridge.record(taskId, { t: "tool.result", id, ok: true, summary: text.slice(0, 600) });
        return { content: [{ type: "text", text }] };
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        this.bridge.record(taskId, { t: "tool.result", id, ok: false, summary: msg.slice(0, 600) });
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    };

    server.registerTool(
      "fs.list",
      { description: "List a directory inside the task scope. Returns name, type, size.", inputSchema: { path: z.string().default(".").describe("Directory, relative to the task cwd or absolute inside the scope") } },
      async ({ path }) =>
        run("fs.list", { path }, path, () => {
          const dir = scope.resolve(path);
          const entries = readdirSync(dir, { withFileTypes: true }).slice(0, fs.maxListEntries);
          return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file", size: e.isFile() ? statSync(join(dir, e.name)).size : undefined }));
        }),
    );

    server.registerTool(
      "fs.read",
      {
        description: "Read a file inside the task scope: text as text (offset / limit in lines, truncated to the configured limit), images as image content, other binaries as a blob resource.",
        inputSchema: { path: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() },
      },
      async ({ path, offset, limit }) =>
        run("fs.read", { path, offset, limit }, path, () => {
          const file = scope.resolve(path);
          const st = statSync(file);
          if (!st.isFile()) throw new Error("not a file");
          const { kind, mime } = kindOfFile(file);
          if (kind !== "text") {
            // Half an image is no image: a file over the cap is refused whole (the text branch below truncates instead).
            if (st.size > fs.maxReadBytes * 4) throw new Error(`${kind} too large (${st.size} bytes > ${fs.maxReadBytes * 4})`);
            const data = readFileSync(file).toString("base64");
            const content: NonTextContent = kind === "image" ? { type: "image", data, mimeType: mime } : { type: "resource", resource: { uri: pathToFileURL(file).href, mimeType: mime, blob: data } };
            return new NonText(content, `${mime}, ${st.size} bytes`);
          }
          // Never read more than a few times the reply cap into memory; the tail is simply not available through this tool.
          const text = st.size > fs.maxReadBytes * 4 ? readHead(file, fs.maxReadBytes * 4) + `\n… (file is ${st.size} bytes; only the first ${fs.maxReadBytes * 4} were read)` : readFileSync(file, "utf8");
          const lines = text.split("\n");
          const start = offset ?? 0;
          const end = limit ? start + limit : lines.length;
          const slice = lines.slice(start, end).join("\n");
          return slice.length > fs.maxReadBytes ? slice.slice(0, fs.maxReadBytes) + `\n… (truncated at ${fs.maxReadBytes} bytes)` : slice;
        }),
    );

    server.registerTool(
      "fs.grep",
      { description: "Search files inside the task scope for a regular expression. Returns path:line:text.", inputSchema: { pattern: z.string(), path: z.string().default("."), glob: z.string().optional().describe("Only files whose name matches this glob, e.g. *.ts") } },
      async ({ pattern, path, glob }) =>
        run("fs.grep", { pattern, path, glob }, `${pattern} in ${path}`, async () => {
          const re = safeRegExp(pattern);
          const root = scope.resolve(path);
          const globRe = glob ? new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
          const hits: string[] = [];
          const stack = [root];
          let scanned = 0;
          let skipped = 0;
          while (stack.length && hits.length < fs.maxGrepMatches && scanned < fs.maxGrepFiles) {
            const dir = stack.pop()!;
            let entries;
            try {
              entries = readdirSync(dir, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const e of entries) {
              if (e.name === ".git" || e.name === "node_modules") continue;
              const p = join(dir, e.name);
              if (e.isDirectory()) stack.push(p);
              else if (e.isFile() && (!globRe || globRe.test(e.name))) {
                if (++scanned > fs.maxGrepFiles) break;
                let text: string;
                try {
                  if (statSync(p).size > fs.maxGrepFileBytes) {
                    skipped++;
                    continue;
                  }
                  text = readFileSync(p, "utf8");
                } catch {
                  continue;
                }
                if (text.includes("\0")) continue;
                const lines = text.split("\n");
                for (let i = 0; i < lines.length && hits.length < fs.maxGrepMatches; i++) if (re.test(lines[i]!)) hits.push(`${scope.display(p)}:${i + 1}:${lines[i]!.slice(0, 300)}`);
                // Give the event loop (permissions, WebSocket, other tasks) a turn between files.
                if (scanned % 50 === 0) await new Promise((r) => setTimeout(r, 0));
              }
            }
          }
          const notes = [hits.length >= fs.maxGrepMatches ? `(stopped at ${fs.maxGrepMatches} matches)` : "", scanned >= fs.maxGrepFiles ? `(stopped after ${fs.maxGrepFiles} files)` : "", skipped ? `(${skipped} files over ${fs.maxGrepFileBytes} bytes skipped)` : ""].filter(Boolean);
          return [hits.join("\n") || "(no matches)", ...notes].join("\n");
        }),
    );

    server.registerTool(
      "exec.run",
      {
        description: "Run a shell command in the task cwd. Read-only commands run immediately; anything else waits for the user's approval in Switchboard.",
        inputSchema: { command: z.string(), cwd: z.string().optional().describe("Relative to the task cwd; must stay inside the scope") },
      },
      async ({ command, cwd }) =>
        run("exec.run", { command, cwd }, command, async () => {
          const dir = scope.resolve(cwd ?? ".");
          const cls = classifyCommand(command, execPolicy, scope, dir);
          const issued = this.endpoints.get(taskId);
          // one run, approval included: a retry asks again like the first time (#949)
          const once = async () => {
            let argv: string[];
            let env: Record<string, string>;
            const target = cls.verdict === "read-only" && cls.argv ? resolveCommand(cls.argv[0]!, minimalEnv(dir).PATH!, scope) : undefined;
            if (target && "missing" in target) throw new Error(target.missing);
            // read-only only when it runs as the inspected argv; a program found inside the scope went through the user
            const readOnly = !!(target && "exe" in target && cls.argv);
            if (readOnly && target && "exe" in target && cls.argv) {
              // No shell, no secrets: the exact argv the policy inspected, with a minimal environment.
              env = { ...minimalEnv(dir), GIT_CEILING_DIRECTORIES: scope.gitCeilings };
              argv = [target.exe, ...cls.argv.slice(1)];
            } else {
              const reason = target && "reason" in target ? target.reason : cls.reason;
              const decision = await this.bridge.askPermission(taskId, { kind: "exec", tool: "exec.run", input: { command, cwd: dir, reason }, detail: command });
              if (decision !== "allow") throw new Error(`not approved (${reason ?? "needs approval"})`);
              argv = ["/bin/sh", "-c", command];
              env = {};
              for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_") && !k.startsWith("SWITCHBOARD_")) env[k] = v;
            }
            // approval may have waited across a revoke / rotate: nothing starts for an endpoint that is gone
            if (this.endpoints.get(taskId) !== issued) throw new Error("task ended; not run");
            const proc = (() => {
              try {
                return this.spawn(argv, { cwd: dir, stdout: "pipe", stderr: "pipe", env, detached: true });
              } catch (e) {
                // nothing ran. Only the system being short for now (processes, files, memory) passes; a missing folder or
                // program (ENOENT), or no permission, is the input's and is never retried (#949)
                if (!PASSING_SPAWN.has((e as { code?: string }).code ?? "")) throw e;
                throw new PassingFailure(`起動できませんでした: ${String((e as Error).message ?? e).slice(0, 200)}`, "before-effect");
              }
            })();
            const ep = this.endpoints.get(taskId);
            ep?.running.add(proc);
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              killGroup(proc, "SIGKILL");
            }, execPolicy.timeoutMs);
            // the group goes as soon as either stream hits its cap, and when the leader exits (a background child that
            // holds a pipe open must not keep the run waiting for end-of-file until the timeout)
            const capped = (stream: typeof proc.stdout) =>
              readCapped(stream, execPolicy.maxOutputBytes).then((r) => {
                if (r.truncated) killGroup(proc, "SIGKILL");
                return r;
              });
            const reading = Promise.all([capped(proc.stdout), capped(proc.stderr)]);
            const code = await proc.exited;
            killGroup(proc, "SIGKILL");
            const [out, err] = await reading;
            clearTimeout(timer);
            ep?.running.delete(proc);
            const result = { exitCode: code, stdout: out.text + (out.truncated ? "\n… (truncated)" : ""), stderr: err.text + (err.truncated ? "\n… (truncated)" : ""), timedOut, mode: readOnly ? "read-only" : "approved" };
            // A timeout is a passing failure; repeating it is harmless only for a read-only command (an approved one may have done something).
            if (timedOut) throw new PassingFailure(`${execPolicy.timeoutMs / 1000} 秒でタイムアウト`, readOnly ? "read-only" : "unknown", result);
            return result;
          };
          return this.withRetry(taskId, `${dir}\0${command}`, command, once);
        }),
    );

    const staging = this.bridge.staging;
    if (staging) {
      server.registerTool(
        "fs.write",
        {
          description: "Propose the full content of a file. Nothing is written: the change is staged and shown to the user as a diff; they apply or reject it in Switchboard.",
          inputSchema: { path: z.string(), content: z.string() },
        },
        async ({ path, content }) =>
          run("fs.write", { path, bytes: Buffer.byteLength(content, "utf8") }, path, () => {
            const c = staging.stageWrite(taskId, scope, path, content);
            return { staged: c.id, path: c.rel, status: c.status, note: "pending user approval in Switchboard; the file is unchanged until then" };
          }),
      );
      server.registerTool(
        "fs.patch",
        {
          description: "Propose an edit: replace the unique occurrence of `find` with `replace`. Staged for the user's approval; the file is not modified.",
          inputSchema: { path: z.string(), find: z.string().min(1), replace: z.string() },
        },
        async ({ path, find, replace }) =>
          run("fs.patch", { path, find: find.slice(0, 200), replace: replace.slice(0, 200) }, path, () => {
            const c = staging.stagePatch(taskId, scope, path, find, replace);
            return { staged: c.id, path: c.rel, status: c.status, note: "pending user approval in Switchboard; the file is unchanged until then" };
          }),
      );
      server.registerTool(
        "fs.pending",
        { description: "List this task's staged writes and their status (pending / applied / rejected). fs.read shows the file on disk; pending edits are not applied yet.", inputSchema: {} },
        async () => ({ content: [{ type: "text", text: JSON.stringify(staging.list(taskId).map((c) => ({ id: c.id, path: c.rel, kind: c.kind, status: c.status, stat: c.stat })), null, 2) }] }),
      );
    }

    server.registerTool(
      "task.note",
      {
        description:
          "Leave a note on the Switchboard task transcript (shown to the user). With `stop`, also record why the work stopped (or how a stop moved: retrying / resolved), so a repeated stop is recognised. Never put credentials or raw command output in it.",
        inputSchema: { text: z.string().optional(), stop: StopReport.optional() },
      },
      async ({ text, stop }) => {
        if (!text && !stop) return { content: [{ type: "text", text: "text or stop is required" }], isError: true };
        if (text) this.bridge.record(taskId, { t: "message.delta", role: "assistant", text });
        if (stop) {
          const r = this.bridge.recordStop(taskId, stop);
          if (!r.ok) return { content: [{ type: "text", text: r.why }], isError: true };
        }
        return { content: [{ type: "text", text: "noted" }] };
      },
    );

    return server;
  }
}

function readHead(file: string, bytes: number): string {
  return readHeadBytes(file, bytes).toString("utf8");
}

function readHeadBytes(file: string, bytes: number): Buffer {
  const fd = require("node:fs").openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = require("node:fs").readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    require("node:fs").closeSync(fd);
  }
}

type NonTextContent = { type: "image"; data: string; mimeType: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

/** A tool reply that is not text (fs.read of an image / a binary, #124), with what the transcript shows instead of the bytes. */
class NonText {
  constructor(
    readonly content: NonTextContent,
    readonly summary: string,
  ) {}
}

/**
 * How fs.read returns a file, by its extension (the attachments' `mimeFor`): raster images as image content; text,
 * JSON, YAML and SVG (XML — models take it as text, not as an image) as text; a known binary format (PDF) as a blob;
 * an unknown extension is text unless its first 8 KB hold a NUL byte.
 */
function kindOfFile(file: string): { kind: "text" | "image" | "binary"; mime: string } {
  const mime = mimeFor(file);
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/yaml" || mime === "image/svg+xml") return { kind: "text", mime };
  if (mime.startsWith("image/")) return { kind: "image", mime };
  if (mime !== "application/octet-stream") return { kind: "binary", mime };
  return { kind: readHeadBytes(file, 8192).includes(0) ? "binary" : "text", mime };
}

/** Peek at a POST body: is it a JSON-RPC `initialize`? (The body is re-read by the transport from the clone.) */
async function isInitialize(req: Request): Promise<boolean> {
  try {
    const body = (await req.clone().json()) as { method?: string } | Array<{ method?: string }>;
    const msgs = Array.isArray(body) ? body : [body];
    return msgs.some((m) => m?.method === "initialize");
  } catch {
    return false;
  }
}
