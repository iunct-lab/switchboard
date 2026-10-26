import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createClaudeHistoryParser, hasPendingEnd, serializeHistoryState, type TimedEvent } from "@switchboard/adapter-claude";
import type { EventEnvelope, HistoryScanResult, HistorySession, HistoryStatus, PricingTable, ServerMessage, Task, Workspace } from "@switchboard/protocol";
import { Db, newId } from "./db.ts";
import { ledgerRowFor } from "./pricing.ts";

export interface HistoryImporterOptions {
  /** Claude Code's `~/.claude/projects`. */
  projectsDir: string;
  /** Interval between passes; 0 = only at boot and on request. */
  pollMs: number;
  pricing?: () => PricingTable;
  broadcast?: (msg: ServerMessage) => void;
  /** A task whose runner process Switchboard holds right now: its log is being written by that process, leave it alone. */
  isLive?: (taskId: string) => boolean;
  /**
   * Permission modes that skip approvals (the adapter's `danger` ones). A terminal session that ran in such a mode is
   * imported without one: continuing it from here resolves the mode like a new task instead of inheriting the bypass.
   */
  dangerModes?: Set<string>;
  log?: (message: string) => void;
}

/** A trailing end_turn is taken as the end of the turn only once the file has been quiet this long (blocks of one message arrive together, but not atomically). */
const QUIET_MS = 5_000;
/** How much of a file one pass reads; the rest waits for the next pass so a first import of a huge log cannot stall the daemon. */
const MAX_SLICE_BYTES = 16 * 1024 * 1024;
/** How far into a file the cwd is looked for (the first prompt can be long; the `cwd` key follows `message`). */
const MAX_HEAD_BYTES = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;

/**
 * Terminal sessions (#91). Claude Code logs every session under `~/.claude/projects/<dir>/<sessionId>.jsonl`;
 * Switchboard already relies on that folder for `--resume`. The importer reads it and turns sessions the person ran
 * in a terminal into tasks with `origin: "terminal"`, so they sit next to the tasks Switchboard started, with the
 * same transcript, the same ledger and the same 差分 tab.
 *
 * Rules:
 *  - Only records with `entrypoint: "cli"` are imported (the adapter's parser drops the rest). A session Switchboard
 *    drove itself (`sdk-cli`) is already recorded live; a file that holds nothing but such records makes no task.
 *  - A file is tied to a task by its session id: an existing task with that `runnerSessionId` (Switchboard ran it —
 *    terminal turns typed later with `claude --resume` are appended to it), else a new terminal task, but only when
 *    the session's cwd is a registered workspace or under one (everything else is skippedForeign). Paths are
 *    compared resolved (Claude Code logs the physical cwd; a workspace is stored as typed).
 *  - Files are followed incrementally: byte offset and the parser's serialized state live in `history_imports`, so a
 *    pass — or a daemon restart — never re-announces a session or counts a message's usage twice. An unchanged file
 *    costs a stat; a foreign file's cwd is read once.
 *  - Events keep the log's timestamps; a new task's createdAt / updatedAt are the first / last record's time, so
 *    imported history sorts where it happened, not where it was read.
 *  - Usage is priced from the table (`priced`); Claude Code's own `cost-state` is cumulative and only written at the
 *    end, so it is not used (docs/design/claude-stream-json.md).
 */
export class HistoryImporter {
  private timer?: ReturnType<typeof setInterval>;
  private boot?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private lastScanAt: number | null = null;
  private lastResult: HistoryScanResult | null = null;
  /** cwd of files not tied to any task, read once per file (a file's cwd never changes). */
  private cwdOf = new Map<string, string>();
  /** Files under a workspace that made no task (another host's session, no terminal record yet): size when last read, so they are re-read only when they grow. */
  private idle = new Map<string, number>();
  /** Errors already logged, so a persistent one is reported once, not every pass. */
  private reported = new Set<string>();

  constructor(
    private db: Db,
    private opts: HistoryImporterOptions,
  ) {}

  /** First pass on the next tick (so the caller's port answers first), then every `pollMs`. `onScan` sees each result. */
  start(onScan?: (r: HistoryScanResult) => void) {
    this.stopped = false;
    const pass = () => {
      if (this.stopped) return;
      try {
        onScan?.(this.scan());
      } catch (e) {
        this.opts.log?.(`history: scan failed: ${this.describe(e)}`);
      }
    };
    this.boot = setTimeout(pass, 0);
    if (this.opts.pollMs > 0) {
      this.timer = setInterval(pass, this.opts.pollMs);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  stop() {
    this.stopped = true;
    if (this.boot) clearTimeout(this.boot);
    if (this.timer) clearInterval(this.timer);
    this.boot = undefined;
    this.timer = undefined;
  }

  status(): HistoryStatus {
    return { dir: this.opts.projectsDir, enabled: existsSync(this.opts.projectsDir), pollMs: this.opts.pollMs, lastScanAt: this.lastScanAt, lastResult: this.lastResult, sessions: this.db.listHistoryImports() };
  }

  /** The session log behind a task, if any (a Switchboard task has one too once its file has been seen). */
  forTask(taskId: string): HistorySession | null {
    return this.db.historyImportForTask(taskId);
  }

  /** Called only with a normal-exit UUID proven by the official Teleport output. */
  async importTeleportedSession(cloudTaskId: string, localSessionId: string, cwd: string): Promise<Task> {
    const cloud = this.db.getTask(cloudTaskId);
    if (this.stopped || !cloud || cloud.runner !== "claude" || cloud.executionMode !== "cloud" || !cloud.cloudSession || !cloud.workspaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(localSessionId)) throw new Error("Cloud/Localセッションを確認できません。");
    const paths = listDirs(this.opts.projectsDir).flatMap(dir => listFiles(dir, ".jsonl")).filter(file => basename(file, ".jsonl") === localSessionId);
    if (paths.length !== 1) throw new Error("通常Local履歴が見つからない、または一意ではありません。");
    const path = paths[0]!, original = statSync(path), size = original.size, roots = this.roots(this.db.listWorkspaces());
    // The caller says where the continuation runs (the clone itself or a worktree under the same Workspace).
    if (workspaceFor(cwd, roots)?.id !== cloud.workspaceId) throw new Error("通常Local履歴のcwd/Workspaceが一致しません。");
    let offset = 0, matched = false;
    // Check every session-bearing record before importing; never infer identity from a timestamp or newest file.
    while (offset < size) {
      const slice = readLines(path, offset, Math.min(size, offset + MAX_SLICE_BYTES));
      if (slice.next === offset) throw new Error("通常Local履歴が書込み途中です。");
      offset = slice.next;
      for (const line of slice.lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        if (record.sessionId !== undefined && record.sessionId !== localSessionId) throw new Error("通常Local履歴のセッションIDが一致しません。");
        if (record.cwd !== undefined && (typeof record.cwd !== "string" || realOf(record.cwd) !== realOf(cwd) || workspaceFor(record.cwd, roots)?.id !== cloud.workspaceId)) throw new Error("通常Local履歴のcwd/Workspaceが一致しません。");
        matched ||= record.sessionId === localSessionId && record.cwd !== undefined && record.entrypoint === "cli";
      }
      if (offset < size) await Bun.sleep(0);
    }
    const owners = this.db.listTasksBySession("claude", localSessionId);
    if (!matched || owners.length > 1 || owners.some(t => t.executionMode !== "local" || realOf(t.cwd) !== realOf(cwd) || t.workspaceId !== cloud.workspaceId || (t.sourceCloudTaskId !== null && t.sourceCloudTaskId !== cloud.id) || this.opts.isLive?.(t.id))) throw new Error("通常Local履歴の所有者を確認できません。");
    const res = emptyResult();
    do {
      const current = statSync(path);
      if (current.size !== size || current.mtimeMs !== original.mtimeMs || current.ino !== original.ino) throw new Error("通常Local履歴が変更されました。結果は未確認です。");
      const before = this.db.getHistoryImport(localSessionId)?.offset ?? 0;
      this.importFile(path, roots, res, { closeTurn: true });
      const row = this.db.getHistoryImport(localSessionId);
      if (!row || (row.offset <= before && row.offset < size)) throw new Error("通常Local履歴を読み込めません。");
      if (row.offset >= size) break;
      await Bun.sleep(0);
    } while (true);
    const row = this.db.getHistoryImport(localSessionId)!;
    const local = this.db.updateTask(row.taskId, { sourceCloudTaskId: cloud.id });
    if (!local) throw new Error("通常Local Taskが見つかりません。");
    this.opts.broadcast?.({ type: "task.updated", task: local });
    return local;
  }

  /**
   * Read a task's log now, before a turn is sent to it from here: a terminal turn that finished inside the poll
   * window must land in the transcript before the turn that follows it, not after. No-op while the process is live
   * (then the file is ours) or when the task has no log yet.
   */
  catchUp(taskId: string) {
    const row = this.db.historyImportForTask(taskId);
    if (!row || this.stopped) return;
    const res = emptyResult();
    try {
      // The person is replying from here, so whatever the terminal turn was, it is over: close it now rather than
      // after the reply's own turn (the quiet-time rule is for a file that may still be growing).
      this.importFile(row.path, this.roots(this.db.listWorkspaces()), res, { closeTurn: true });
    } catch (e) {
      this.opts.log?.(`history: ${basename(row.path)}: ${this.describe(e)}`);
    }
    this.report(res.errors);
  }

  /** One synchronous pass over every `.jsonl` one level below the projects folder. Errors are per file and never stop the pass. */
  scan(): HistoryScanResult {
    const res = emptyResult();
    if (this.stopped || !existsSync(this.opts.projectsDir)) {
      this.lastScanAt = res.ts;
      this.lastResult = res;
      return res;
    }
    const workspaces = this.roots(this.db.listWorkspaces());
    for (const dir of listDirs(this.opts.projectsDir)) {
      for (const file of listFiles(dir, ".jsonl")) {
        res.files++;
        try {
          this.importFile(file, workspaces, res);
        } catch (e) {
          res.errors.push(`${basename(file)}: ${this.describe(e)}`);
        }
      }
    }
    this.lastScanAt = res.ts;
    this.lastResult = res;
    this.report(res.errors);
    return res;
  }

  /** Workspaces with their paths resolved once per pass (realpath per file would be N × M syscalls). */
  private roots(workspaces: Workspace[]): ResolvedWorkspace[] {
    return workspaces.map((ws) => ({ ws, root: realOf(ws.path).replace(/\/+$/, "") }));
  }

  /** Log each distinct error once. */
  private report(errors: string[]) {
    for (const e of errors) {
      if (this.reported.has(e)) continue;
      this.reported.add(e);
      this.opts.log?.(`history: ${e}`);
    }
  }

  private importFile(path: string, workspaces: ResolvedWorkspace[], res: HistoryScanResult, opts: { closeTurn?: boolean } = {}) {
    const sessionId = basename(path, ".jsonl");
    const stat = statSync(path);
    const known = this.db.getHistoryImport(sessionId);
    if (known && known.path !== path) {
      // The same session id under another project folder: one file feeds the task; a second one cannot share its offset.
      res.errors.push(`${basename(path)}: session already imported from ${basename(join(known.path, ".."))}; this copy is ignored`);
      return;
    }
    const owners = known ? [this.db.getTask(known.taskId)].filter((t): t is Task => !!t) : this.db.listTasksBySession("claude", sessionId);
    let task: Task | null = owners[0] ?? null;
    if (owners.some((t) => this.opts.isLive?.(t.id))) return; // our own process is writing this file; read it once released

    let offset = known?.offset ?? 0;
    if (offset > stat.size) {
      // Rewritten or truncated: re-reading from 0 would duplicate what was already imported. Skip what is there now.
      res.errors.push(`${basename(path)}: file shrank from ${offset} to ${stat.size} bytes; continuing from its end`);
      offset = stat.size;
      if (known) this.db.upsertHistoryImport({ ...known, offset, importedAt: Date.now() });
    }
    if (known && stat.size === offset && !hasPendingEnd(known.state)) return; // nothing new, nothing pending
    if (!known && this.idle.get(path) === stat.size) return; // read before, made nothing, has not grown

    let cwd: string | undefined;
    if (!task) {
      // Not tied to anything yet: is this a session in one of the workspaces at all? The head is read once for that.
      cwd = this.cwdOf.get(path) ?? firstCwd(path);
      if (!cwd) return; // metadata only so far (a session that just started); look again next pass
      this.cwdOf.set(path, cwd);
      if (!workspaceFor(cwd, workspaces)) {
        res.skippedForeign++;
        return;
      }
    }

    let parser: ReturnType<typeof createClaudeHistoryParser>;
    try {
      parser = createClaudeHistoryParser(known?.state);
    } catch (e) {
      // A state this build cannot read (corrupt row, another version): go on from the offset with a fresh parser
      // that knows the session was announced. Re-reading from 0 would duplicate the whole transcript.
      res.errors.push(`${basename(path)}: saved parser state unreadable (${this.describe(e)}); continuing from byte ${offset} with a fresh parser`);
      parser = createClaudeHistoryParser();
      parser.state.started = true;
    }
    const events: TimedEvent[] = [];
    let next = offset;
    // One slice per pass for a file that feeds a task (the rest next pass). A file that has no task yet is read to
    // the end in one go: only its whole content says whether it holds a terminal record at all.
    while (stat.size > next) {
      const slice = readLines(path, next, Math.min(stat.size, next + MAX_SLICE_BYTES));
      if (slice.next === next) break; // a partial line is still being written
      next = slice.next;
      for (const line of slice.lines) events.push(...parser.feed(line));
      if (task || events.length > 0) break;
    }
    const complete = next >= stat.size;
    const quiet = complete && Date.now() - stat.mtimeMs > QUIET_MS;
    if (quiet || (opts.closeTurn && complete)) events.push(...parser.flush());
    const s = parser.state;
    const state = serializeHistoryState(s);
    if (events.length === 0 && next === offset && known) return; // read nothing new (a partial line is still being written)

    let created = false;
    if (!task && events.length === 0) {
      // Written only by an SDK host that is not (yet) a task here — Switchboard's own process before its
      // session.start arrived, or another program. Remembered by size: read again only once it grows.
      if (s.entrypoints.has("sdk-cli") && !s.entrypoints.has("cli")) res.skippedOtherHost++;
      if (complete) this.idle.set(path, stat.size);
      return;
    }
    const table = this.opts.pricing?.();
    const envelopes: EventEnvelope[] = [];
    this.db.sqlite.transaction(() => {
      if (!task) {
        const at = s.cwd ?? cwd!;
        const ws = workspaceFor(at, workspaces);
        const firstPrompt = events.find((e) => e.ev.t === "message.delta" && e.ev.role === "user")?.ev as { text?: string } | undefined;
        const mode = s.permissionMode && !this.opts.dangerModes?.has(s.permissionMode) ? s.permissionMode : null;
        task = {
          id: newId("task"),
          workspaceId: ws?.id ?? null,
          title: s.title ?? titleFrom(firstPrompt?.text) ?? `Terminal session ${sessionId.slice(0, 8)}`,
          runner: "claude",
          cwd: at,
          scope: [at],
          status: "done",
          runnerSessionId: sessionId, executionMode: "local", cloudSession: null, sourceCloudTaskId: null,
          model: s.model ?? null,
          routing: null,
          budgetUsd: null,
          scheduleId: null,
          permissionMode: mode,
          effort: null,
          origin: "terminal",
          resumeAt: null, resumeReason: null,
          shadowOf: null,
          shadowStopped: false,
          workspaceReason: null,
          titlePending: false,
          outcome: "unknown",
          // the person watched it in the terminal (#492): not listed under 要対応; a continued turn keeps it reviewed
          reviewedAt: s.lastTs ?? events.at(-1)!.ts,
          archivedAt: null,
          judgedResult: null,
          judgedReason: null,
          judgedBy: null, judgingAt: null,
          stage: null,
          // imported as done: it came to that with the log's last record
          statusAt: s.lastTs ?? events.at(-1)!.ts,
          createdAt: s.firstTs ?? events[0]!.ts,
          updatedAt: s.lastTs ?? events.at(-1)!.ts,
        };
        this.db.insertTask(task);
        created = true;
      }
      const t = task;
      for (const e of events) {
        envelopes.push(this.db.appendEventAt(t.id, e.ev, e.ts));
        if (e.ev.t === "usage") this.db.insertLedger(ledgerRowFor(table, t, e.ev, e.ts));
      }
      this.db.upsertHistoryImport({ sessionId, taskId: t.id, path, offset: next, state, importedAt: Date.now() });
      if (events.length > 0) {
        // What the log knows about the session, on the task record. A Switchboard task keeps its own title / mode;
        // only its clock moves when a terminal turn was appended.
        const patch: Parameters<Db["updateTask"]>[1] = { updatedAt: Math.max(t.updatedAt, s.lastTs ?? 0) };
        if (t.origin === "terminal") {
          if (s.title && s.title !== t.title) patch.title = s.title;
          if (s.model && !t.model) patch.model = s.model;
          if (s.permissionMode && s.permissionMode !== t.permissionMode && !this.opts.dangerModes?.has(s.permissionMode)) patch.permissionMode = s.permissionMode;
        }
        this.db.updateTask(t.id, patch);
      }
    })();
    this.cwdOf.delete(path);
    this.idle.delete(path);
    if (created) res.created++;
    else if (events.length > 0) res.appended++;

    if (!this.opts.broadcast || events.length === 0 || !task) return;
    const after = this.db.getTask(task.id);
    // A brand-new task arrives whole with task.updated (the UI loads its events when opened); appended turns stream.
    if (!created) for (const env of envelopes) this.opts.broadcast({ type: "event", env });
    if (after) this.opts.broadcast({ type: "task.updated", task: after });
  }

  /** Error text for the API and the log: never the absolute projects path. */
  private describe(e: unknown): string {
    return String((e as Error).message ?? e).replaceAll(this.opts.projectsDir, "<projects>");
  }
}

function emptyResult(): HistoryScanResult {
  return { ts: Date.now(), files: 0, created: 0, appended: 0, skippedForeign: 0, skippedOtherHost: 0, errors: [] };
}

export interface ResolvedWorkspace {
  ws: Workspace;
  /** realpath of ws.path without a trailing slash. */
  root: string;
}

/**
 * The workspace whose path is the cwd or an ancestor of it; the longest match when workspaces nest. Both sides are
 * resolved (macOS logs `/private/var/…` for a `/var/…` cwd; a workspace may be registered through a symlink).
 */
export function workspaceFor(cwd: string, workspaces: ResolvedWorkspace[]): Workspace | undefined {
  const target = realOf(cwd);
  let best: ResolvedWorkspace | undefined;
  for (const w of workspaces) {
    if (target !== w.root && !target.startsWith(`${w.root}/`)) continue;
    if (!best || w.root.length > best.root.length) best = w;
  }
  return best?.ws;
}

function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** First line of the first prompt, cut the way Home names a task from its body. */
function titleFrom(text: string | undefined): string | undefined {
  const line = text?.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 48) : undefined;
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(ext))
      .map((d) => join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** The `cwd` of the first record that has one, reading the file line by line up to MAX_HEAD_BYTES. */
function firstCwd(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    let carry = "";
    let pos = 0;
    const buf = Buffer.alloc(CHUNK);
    while (pos < MAX_HEAD_BYTES) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const cwd = cwdOfLine(line);
        if (cwd) return cwd;
      }
    }
    return cwdOfLine(carry);
  } finally {
    closeSync(fd);
  }
}

function cwdOfLine(line: string): string | undefined {
  if (!line.includes('"cwd"')) return undefined;
  try {
    const r = JSON.parse(line) as { cwd?: unknown };
    return typeof r?.cwd === "string" && r.cwd ? r.cwd : undefined;
  } catch {
    return undefined; // a partial line, or not JSON
  }
}

/** Complete lines in [offset, end); a partial last line stays unread (`next` stops after the last newline). */
function readLines(path: string, offset: number, end: number): { lines: string[]; next: number } {
  const len = end - offset;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  let got = 0;
  try {
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  const last = got > 0 ? buf.lastIndexOf(10, got - 1) : -1;
  if (last < 0) return { lines: [], next: offset };
  return { lines: buf.subarray(0, last + 1).toString("utf8").split("\n").filter((l) => l.length > 0), next: offset + last + 1 };
}
