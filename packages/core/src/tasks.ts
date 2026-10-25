import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { githubLimitHit } from "./ratelimit.ts";
import type { AgentEvent, ApprovalRuleMatch, McpServerConfig, StopRecord, Attachment, CreateTaskInput, PendingApproval, PermissionDecision, PricingTable, RoutingSuggestion, RunnerAdapter, RunnerId, RunnerSession, ServerMessage, SetOutcomeInput, Task } from "@switchboard/protocol";
import { CloudSessionRef } from "@switchboard/protocol";
import { readCloudPreparation } from "./claude-cloud.ts";
import { ledgerRowFor, usageSince } from "./pricing.ts";
import { withAttachments, type AttachmentStore } from "./attachments.ts";
import { artifactPrompt, parseArtifactFence, type ArtifactFence, type ArtifactStore } from "./artifacts.ts";
import { Db, newId } from "./db.ts";
import { MAX_STOP_RESUMES, planResumeAfterStop } from "./interrupted.ts";
import { recapOf } from "./recap.ts";
import { canTransition, IN_FLIGHT, InvalidTaskTransitionError, TERMINAL } from "./task-status.ts";
import { setupScripts, syncSkills } from "./skillsync.ts";
import { FenceReader, lastAttempt, openStops, reduceStops, reserveStopRetry, StopFenceReader, stopRecordsFor, stopRecoveryPrompt, stopWork, type StopReport } from "./stops.ts";

interface LiveSession {
  session: RunnerSession;
  /** The agent's `switchboard-artifact` fences in its replies (#1778), read like the stop reports. */
  artifactReader: FenceReader<ArtifactFence>;
  /** Unanswered permission.ask by id, with when it was asked (kept in memory: an ask lives only as long as its runner). */
  pendingPermissions: Map<string, { ask: Extract<AgentEvent, { t: "permission.ask" }>; at: number }>;
  /** permission.ask raised by Switchboard itself (Workspace MCP exec.run), resolved by the user's answer. */
  hostAsks: Map<string, (d: PermissionDecision) => void>;
  /** ask id → rule that auto-allowed it, so the adapter's permission.resolved can carry the rule. */
  ruleMatches: Map<string, ApprovalRuleMatch>;
  /** The budget value whose crossing was already noted in the transcript (avoids a note per usage event). */
  budgetNoted?: number;
  /** Armed after session.end: releases the idle runner process so later turns go through --resume. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Background jobs the runner still has (the last `background` event). While any is left the process is not released. */
  background?: number;
  /**
   * The next turn must restart the runner (--resume) instead of reusing this process: its mode changed and it could
   * not switch live, or its scope grew (an attachment directory, #125) and roots are only read at start.
   */
  restartNext?: boolean;
  /**
   * The task's model was changed (#155) while this process — started with the old one — is still attached. Its
   * session.start (Claude reports one per turn) names the old model and must not write it back over the choice.
   */
  modelChanged?: boolean;
  /** `error` messages of the turn in flight (bounded), handed to turn-end listeners with the session.end (#102). */
  turnErrors: string[];
  /** The turn's tool calls not yet answered: id → the tool and its input as one key (#550). */
  turnCalls: Map<string, { name: string; key: string }>;
  /** The GitHub limit lines the turn's commands met, per command key; a later success of the same command takes it out (#550). */
  turnGithub: Map<string, string>;
  /** The last quota report of the turn in flight — the runner's own view of the window that stopped it (#102). */
  turnQuota?: Extract<AgentEvent, { t: "quota" }>;
  /** `switchboard-stop` reports in the runner's reply as it streams (#948). */
  stopReader: StopFenceReader;
}

/** What a turn ended with: its session.end, the error messages raised during it, and its last quota report. */
export interface TurnEnd {
  end: Extract<AgentEvent, { t: "session.end" }>;
  errors: string[];
  quota?: Extract<AgentEvent, { t: "quota" }>;
  /** The last GitHub limit line a command of the turn met and never got past (#550). */
  githubLimit?: string;
}

/** `send(…, { asResume: true })` found the task moved on meanwhile (a reply, 中断, a cancel): nothing was sent. */
export class ResumeSupersededError extends Error {
  constructor(why: string) {
    super(`resume superseded: ${why}`);
  }
}

/**
 * What `create()` takes: the API's input with the Workspace settled. `cwd` is optional on the wire ("自動", #135) and
 * resolved by the server before this point; `workspaceReason` is the daemon's own record of that choice, which is
 * why it is not a field of `CreateTaskInput` (a client cannot claim a task was auto-routed).
 */
export type NewTaskInput = Omit<CreateTaskInput, "executionMode"> & { cwd: string; executionMode?: CreateTaskInput["executionMode"]; workspaceReason?: string; stage?: Task["stage"] };

/**
 * The temp directory only this task writes under (StartOptions.privateTmp, #787): `<root>/<task id>`, where the root is
 * the daemon's own (`<home>/tmp`), so that another daemon, or one started on a copy of the database, never shares it.
 */
export function privateTmpOf(root: string, taskId: string): string {
  const dir = join(root, taskId);
  if (!taskId || basename(dir) !== taskId || taskId === "." || taskId === "..") throw new Error(`task id "${taskId}" is not a directory name`);
  return dir;
}

/** Makes it (or takes the one a resume left): a real directory of this user's, closed to others. A symlink or a foreign one is refused. */
export function makePrivateTmp(root: string, taskId: string): string {
  const dir = privateTmpOf(root, taskId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${dir} is not a directory of this user's`);
  chmodSync(dir, 0o700);
  const now = new Date();
  utimesSync(dir, now, now); // the sweep's age counts from the last start
  return dir;
}

/**
 * Removes the directories of tasks the database lets go (#787). A `done` task is not over (a follow-up resumes the same
 * thread and its files), so those wait for this sweep at the daemon's start: older than `maxAgeMs` by their mtime.
 */
export function sweepPrivateTmps(root: string, maxAgeMs: number, removable: (taskId: string) => boolean, now = Date.now()): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!removable(name)) continue;
    const dir = join(root, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || now - st.mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      n++;
    } catch {
      // not ours or not removable: left
    }
  }
  return n;
}

export interface TaskManagerOptions {
  /** Where a Codex task's own temp directory is made (#787): `<daemon home>/tmp`. Unset = none is made. */
  privateTmpRoot?: string;
  /** Refuse a Local turn while an interactive Terminal owns its working directory. */
  beforeResume?: (task: Task) => void;
  /** Keep a finished runner process around this long for quick follow-ups. 0 releases immediately. */
  idleMs?: number;
  /**
   * The router. The suggestion is recomputed here at creation time (never taken from the client) so the decision
   * log cannot be poisoned and always matches the prompt that was actually submitted.
   */
  suggest?: (input: NewTaskInput, scope: string[]) => RoutingSuggestion | undefined;
  /**
   * Knowledge approval rules (#13). "allow" answers the ask at once (recorded as by: rule); "ask" leaves it to the
   * user, optionally with the confirm rule that matched so the UI can show why. Absent = ask every time.
   */
  approval?: (task: Task, ask: Extract<AgentEvent, { t: "permission.ask" }>) => { decision: "ask" | "allow"; match?: ApprovalRuleMatch };
  /** Price table (#14): usage without a reported cost is priced from it; billing decides what counts as 実課金. */
  pricing?: () => PricingTable;
  /** Saved Amazon Bedrock region of the runner (#1730); undefined = the runner's own login. Not for cloud runs. */
  bedrock?: (task: Task) => { region: string } | undefined;
  /** Saved per-runner default permission mode (#58); undefined = the adapter's own default. */
  defaultPermissionMode?: (runner: RunnerId) => string | undefined;
  /** Saved shadow runner (#99), used when a creation does not say; null / undefined = no shadow by default. */
  defaultShadowRunner?: () => RunnerId | null | undefined;
  /** Files attached to turns (#125). Absent = `attachmentIds` are refused. */
  attachments?: AttachmentStore;
  /** The artifacts store (#1778): where an agent's `switchboard-artifact` fence registers a report. Unset = fences are read and refused. */
  artifacts?: ArtifactStore;
  /** Where the kit's `device-auth` sends a Task's approval wait (#662): added to the runner's environment. */
  deviceAuthEnv?: (taskId: string) => Record<string, string>;
  /** What the kit's `docker` front reads (#1418): the label for the task's containers and the file its compose projects are written to. */
  dockerEnv?: (taskId: string) => Record<string, string>;
  /** How many daemon stops in a row a turn is resumed after (#835, `quotaAndResume.maxStopResumes`). Absent = `MAX_STOP_RESUMES`. */
  maxStopResumes?: () => number;
  /** The MCP servers a Task's runner gets (#2090, `mcp.yaml` `servers`). Absent = none. */
  mcpServers?: (task: Task) => Record<string, McpServerConfig>;
}

/** One word for the shell: in single quotes, a quote inside written as '\''. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * What ends the runner's reply and is recorded after the fences it closes (#948, #1936): a tool call, an ask, the session's
 * end. The person's next message closes them too, but after it is recorded — its files are recorded before it, and a row
 * between them would split them.
 */
const endsReply = (ev: AgentEvent) => ev.t === "tool.call" || ev.t === "permission.ask" || ev.t === "session.end";

/**
 * TaskManager owns the lifecycle: create → start adapter → persist/broadcast events → status transitions → ledger.
 * It never decides anything on the agent's behalf: permissions wait for the user, except where the user wrote an
 * explicit allow rule in Knowledge, which is applied and recorded as by: rule (System ENABLES, Agent DECIDES, User APPROVES).
 */
export class TaskManager {
  private live = new Map<string, LiveSession>();
  /** Sessions whose process is being released/aborted; a new turn must wait for them so one session id never has two processes. */
  private closing = new Map<string, Promise<void>>();

  private beforeResume: TaskManagerOptions["beforeResume"];
  private idleMs: number;
  private suggest: TaskManagerOptions["suggest"];
  private approval: TaskManagerOptions["approval"];
  private pricing: TaskManagerOptions["pricing"];
  private defaultPermissionMode: TaskManagerOptions["defaultPermissionMode"];
  private defaultShadowRunner: TaskManagerOptions["defaultShadowRunner"];
  private attachments: TaskManagerOptions["attachments"];
  private artifacts: TaskManagerOptions["artifacts"];
  private privateTmpRoot: string | undefined;
  private deviceAuthEnv: TaskManagerOptions["deviceAuthEnv"];
  private dockerEnv: TaskManagerOptions["dockerEnv"];
  private maxStopResumes: () => number;
  private mcpServers: TaskManagerOptions["mcpServers"];
  private bedrock: TaskManagerOptions["bedrock"];

  private endListeners = new Set<(taskId: string, task: Task) => void>();
  private turnEndListeners = new Set<(taskId: string, task: Task, turn: TurnEnd) => void>();
  /** Told whenever a task's planned resume is forgotten, or a person starts a turn (#550: a plan still being made must be dropped too). */
  private planForgottenListeners = new Set<(taskId: string) => void>();

  constructor(
    private db: Db,
    private adapters: Map<RunnerId, RunnerAdapter>,
    private broadcast: (msg: ServerMessage) => void,
    opts: TaskManagerOptions = {},
  ) {
    this.beforeResume = opts.beforeResume;
    this.idleMs = opts.idleMs ?? 10 * 60 * 1000;
    this.suggest = opts.suggest;
    this.approval = opts.approval;
    this.pricing = opts.pricing;
    this.defaultPermissionMode = opts.defaultPermissionMode;
    this.defaultShadowRunner = opts.defaultShadowRunner;
    this.attachments = opts.attachments;
    this.artifacts = opts.artifacts;
    this.privateTmpRoot = opts.privateTmpRoot;
    this.deviceAuthEnv = opts.deviceAuthEnv;
    this.dockerEnv = opts.dockerEnv;
    this.maxStopResumes = opts.maxStopResumes ?? (() => MAX_STOP_RESUMES);
    this.mcpServers = opts.mcpServers;
    this.bedrock = opts.bedrock;
  }

  /**
   * Why `mode` cannot be used with `runner` (undefined = fine). Adapters list what they accept; a runner without a
   * list (DAK) has no knob at all. Used by the API for 400s before anything is created or changed.
   */
  checkPermissionMode(runner: RunnerId, mode: string): string | undefined {
    const adapter = this.adapters.get(runner);
    if (!adapter) return `runner "${runner}" is not installed`;
    const modes = adapter.permissionModes ?? [];
    if (modes.length === 0) return `runner "${runner}" has no permission modes (its own configuration decides what is confirmed)`;
    if (!modes.some((m) => m.value === mode)) return `unknown permission mode "${mode}" for ${runner} (one of ${modes.map((m) => m.value).join(", ")})`;
    return undefined;
  }

  /** Why `effort` cannot be used with `runner` (#833; undefined = fine): the same closed list as permission modes. */
  checkEffort(runner: RunnerId, effort: string): string | undefined {
    const adapter = this.adapters.get(runner);
    if (!adapter) return `runner "${runner}" is not installed`;
    const efforts = adapter.efforts ?? [];
    if (efforts.length === 0) return `runner "${runner}" has no thinking efforts (its own configuration decides)`;
    if (!efforts.some((e) => e.value === effort)) return `unknown effort "${effort}" for ${runner} (one of ${efforts.map((e) => e.value).join(", ")})`;
    return undefined;
  }

  /** The mode a new task runs with: explicit → saved runner default → adapter default. A stale saved value falls back rather than failing the task. */
  resolvePermissionMode(runner: RunnerId, requested?: string): string | null {
    const adapter = this.adapters.get(runner);
    if (!adapter) throw new Error(`runner "${runner}" is not installed`);
    if (requested !== undefined) {
      const why = this.checkPermissionMode(runner, requested);
      if (why) throw new Error(why);
      return requested;
    }
    if (!adapter.permissionModes?.length) return null;
    const saved = this.defaultPermissionMode?.(runner);
    if (saved !== undefined && !this.checkPermissionMode(runner, saved)) return saved;
    return adapter.defaultPermissionMode ?? null;
  }

  /**
   * Change the mode of an existing task (#58). A live session that can switch does so now (Claude at once, Codex from
   * its next turn); one that cannot is released if idle so the next turn resumes with the new mode. The change is
   * recorded in the transcript either way.
   */
  async setPermissionMode(taskId: string, mode: string): Promise<Task> {
    const task = this.mustGet(taskId);
    this.requireLocal(task);
    const why = this.checkPermissionMode(task.runner, mode);
    if (why) throw new Error(why);
    const live = this.live.get(taskId);
    // A live runner that can switch is asked first; the record only changes once it confirmed (Claude answers the
    // control request; a refusal — unknown mode, a policy — must not leave the task claiming a mode it is not in).
    if (live?.session.setPermissionMode) {
      try {
        await live.session.setPermissionMode(mode);
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        this.onEvent(taskId, live, { t: "status", text: `permission mode not changed (${msg})` });
        throw new Error(`runner refused permission mode ${mode}: ${msg}`);
      }
    }
    const updated = this.db.updateTask(taskId, { permissionMode: mode });
    if (!updated) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: updated });
    if (!live) {
      this.record(taskId, { t: "status", text: `permission mode → ${mode} (applies when the task resumes)` });
      return updated;
    }
    if (live.session.setPermissionMode) {
      this.onEvent(taskId, live, { t: "status", text: `permission mode → ${mode}` });
      return updated;
    }
    this.onEvent(taskId, live, { t: "status", text: `permission mode → ${mode} (applies to the next turn)` });
    // No live switch: this process would keep the old mode for quick follow-ups. Release it now if idle; a turn in
    // flight finishes as it is and the next turn restarts the runner (send() checks the flag).
    live.restartNext = true;
    if (updated.status !== "running" && updated.status !== "waiting") await this.release(taskId);
    return updated;
  }

  /**
   * Change the model of an existing task (#155); null = back to the CLI's default. One path for every runner: the
   * process that is running keeps the model it was started with, so it is released (now if idle, else before the next
   * turn — `restartNext`) and the next turn resumes the same session with the new model.
   */
  async setModel(taskId: string, model: string | null): Promise<Task> {
    this.requireLocal(this.mustGet(taskId));
    const updated = this.db.updateTask(taskId, { model });
    if (!updated) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: updated });
    const name = model ?? "CLI default";
    const live = this.live.get(taskId);
    if (!live) {
      this.record(taskId, { t: "status", text: `model → ${name} (applies when the task resumes)` });
      return updated;
    }
    this.onEvent(taskId, live, { t: "status", text: `model → ${name} (applies to the next turn)` });
    live.restartNext = true;
    live.modelChanged = true;
    if (updated.status !== "running" && updated.status !== "waiting") await this.release(taskId);
    return updated;
  }

  /** Called when a task's planned resume is forgotten (setResumeAt null — a reply, 中断, a cancel) or a person starts a turn. */
  onPlanForgotten(l: (taskId: string) => void): () => void {
    this.planForgottenListeners.add(l);
    return () => this.planForgottenListeners.delete(l);
  }

  /** Called on every session.end of a task (turn finished), with the task as it stands after the transition and what the turn ended with. */
  onTurnEnd(l: (taskId: string, task: Task, turn: TurnEnd) => void): () => void {
    this.turnEndListeners.add(l);
    return () => this.turnEndListeners.delete(l);
  }

  /**
   * Called when a task is over for good: it is in a terminal status AND its runner process is gone (exited, released
   * after the idle window, or aborted). A "done" task whose process still lingers can take a follow-up, so its
   * Workspace MCP endpoint stays valid until then.
   */
  onTaskEnd(l: (taskId: string, task: Task) => void): () => void {
    this.endListeners.add(l);
    return () => this.endListeners.delete(l);
  }

  /** Append an event that did not come from the runner (Workspace MCP tool calls, host notes). */
  record(taskId: string, ev: AgentEvent): void {
    const live = this.live.get(taskId);
    if (live) this.onEvent(taskId, live, ev);
    else {
      const env = this.db.appendEvent(taskId, ev);
      this.broadcast({ type: "event", env });
    }
  }

  /**
   * Raise a permission.ask on behalf of the host (Workspace MCP). Resolves with the user's decision (or a Knowledge
   * allow rule, recorded as by: rule); a task without a live runner, or one that ends first, resolves "deny".
   */
  askPermission(taskId: string, ask: Omit<Extract<AgentEvent, { t: "permission.ask" }>, "t" | "id">): Promise<PermissionDecision> {
    const live = this.live.get(taskId);
    if (!live) return Promise.resolve("deny");
    const id = `host_${crypto.randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      live.hostAsks.set(id, resolve);
      this.onEvent(taskId, live, { t: "permission.ask", id, ...ask });
    });
  }

  /**
   * Record a stop the runner reported (#948): task.note's `stop` or a `switchboard-stop` fence. Its id is the runner's
   * within this task. The answer is the one it names (an Issue comment), else the newest one this stop or the same
   * work + op + target already had — never one made up from the conversation. The same report twice (a note and a
   * fence) is recorded once. A retry (#949) is reserved only by the bounded rule (`reserveStopRetry`) and only for the
   * next attempt: one refused is recorded as waiting / exhausted with the reason, and the caller hears why.
   */
  recordStop(taskId: string, report: StopReport): { ok: true; stop: StopRecord } | { ok: false; why: string } {
    const task = this.mustGet(taskId);
    const now = Date.now();
    const id = `${taskId}/${report.id}`;
    const known = stopRecordsFor(this.db, task);
    const prev = known.filter((r) => r.id === id).at(-1);
    const place = known.filter((r) => r.op === report.op && r.target === report.target && r.answer).at(-1);
    const named = report.answer && (prev?.answer?.ref === report.answer ? prev.answer : { ref: report.answer, at: now });
    const { answer: _, ...rest } = report;
    // an action reported without a time keeps the one it was first recorded with
    const actions = rest.actions.map((a) => (a.at ? a : { ...a, at: prev?.actions.find((p) => p.attempt === a.attempt && p.what === a.what)?.at ?? now }));
    const stop: StopRecord = { ...rest, actions, id, work: stopWork(task), answer: named || prev?.answer || place?.answer || null, at: now };
    if (stop.state === "retrying") {
      const r = reserveStopRetry(prev, stop);
      if (!r.ok) {
        const refused: StopRecord = { ...stop, state: r.exhausted ? "exhausted" : "waiting", actions: [...(prev?.actions ?? []), { attempt: prev ? lastAttempt(prev) : 0, at: now, what: `再試行しない: ${r.why}`, ok: false }].slice(-20) };
        if (!(prev && prev.state === refused.state && prev.actions.at(-1)?.what === refused.actions.at(-1)?.what)) this.record(taskId, { t: "stop.record", stop: refused });
        return { ok: false, why: r.why };
      }
      if (lastAttempt(stop) !== r.attempt) return { ok: false, why: `再試行 ${r.attempt - 1} 回目は予約済みです（次は ${r.attempt} 回目）` };
    }
    const same = (s: StopRecord) => JSON.stringify({ ...s, at: 0, work: 0 });
    if (prev && same(prev) === same(stop)) return { ok: true, stop: prev };
    this.record(taskId, { t: "stop.record", stop });
    return { ok: true, stop };
  }

  /** This task's stop `reportId` as last recorded (#949); undefined when it never stopped so. */
  stopOf(taskId: string, reportId: string): StopRecord | undefined {
    return this.db.listStopRecords([taskId]).filter((r) => r.id === `${taskId}/${reportId}`).at(-1);
  }

  /** Move the task's own open stops (#948): an answer the person gave, or 中断 cancelling a planned retry. */
  private moveOpenStops(taskId: string, f: (s: StopRecord) => StopRecord | null) {
    for (const s of openStops(this.db.listStopRecords([taskId]))) {
      const next = f(s);
      if (next) this.record(taskId, { t: "stop.record", stop: { ...next, at: Date.now() } });
    }
  }

  /** Every unanswered permission.ask of every live task, newest first (#26). */
  pendingApprovals(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const [taskId, live] of this.live) {
      if (!live.pendingPermissions.size) continue;
      const task = this.db.getTask(taskId);
      if (!task) continue;
      const workspace = task.workspaceId ? (this.db.getWorkspace(task.workspaceId)?.name ?? null) : null;
      for (const [id, { ask, at }] of live.pendingPermissions) out.push({ taskId, taskTitle: task.title, workspace, id, kind: ask.kind, tool: ask.tool, input: ask.input, detail: ask.detail, askedAt: at });
    }
    return out.sort((a, b) => b.askedAt - a.askedAt);
  }

  availableRunners(): RunnerId[] {
    return [...this.adapters.keys()];
  }

  /** Raise (or remove) a task's budget. The over-budget hold is derived from spend vs. budget, so raising it past the spend lifts it. */
  setBudget(taskId: string, budgetUsd: number | null): Task {
    const t = this.db.updateTask(taskId, { budgetUsd });
    if (!t) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: t });
    return t;
  }

  /**
   * The person's say on what the task came to (#492): 確認済み on / off, the outcome by hand, or both. Setting it to
   * needs_action / failed without `reviewed` takes 確認済み off, so the task is back under 要対応. The list order
   * (updatedAt) does not move.
   */
  setOutcome(taskId: string, input: SetOutcomeInput): Task {
    const cur = this.db.getTask(taskId);
    if (!cur) throw new Error(`task ${taskId} not found`);
    const reopen = input.reviewed === undefined && (input.outcome === "needs_action" || input.outcome === "failed");
    const reviewedAt = input.reviewed === true ? Date.now() : input.reviewed === false || reopen ? null : cur.reviewedAt;
    const t = this.db.updateTask(taskId, { ...(input.outcome ? { outcome: input.outcome } : {}), reviewedAt, updatedAt: cur.updatedAt })!;
    this.broadcast({ type: "task.updated", task: t });
    return t;
  }

  /** Hide a stopped Task from the list, or bring it back (#1142). Like setOutcome, the list order does not move. */
  setArchived(taskId: string, archived: boolean): Task {
    const cur = this.mustGet(taskId);
    if (cur.status === "running" || cur.status === "waiting" || cur.status === "idle") throw new Error("a running or idle task cannot be archived");
    const t = this.db.updateTask(taskId, { archivedAt: archived ? Date.now() : null, updatedAt: cur.updatedAt })!;
    this.broadcast({ type: "task.updated", task: t });
    return t;
  }

  /** Plan (or forget) a resume after a usage-limit stop (#102) or a GitHub limit (#550, `reason`). Any turn that starts clears it. */
  setResumeAt(taskId: string, resumeAt: number | null, reason: "limit" | "github" = "limit"): Task {
    if (resumeAt !== null) this.requireLocal(this.mustGet(taskId));
    const t = this.db.updateTask(taskId, { resumeAt, resumeReason: resumeAt === null ? null : reason });
    if (!t) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: t });
    if (resumeAt === null) for (const l of this.planForgottenListeners) l(taskId);
    return t;
  }

  /** Derived, not remembered: survives a daemon restart and follows manual budget changes. */
  isOverBudget(taskId: string): boolean {
    const t = this.db.getTask(taskId);
    if (!t || t.budgetUsd === null) return false;
    return this.db.taskCost(taskId).costUsd > t.budgetUsd;
  }

  /** Whether a runner process is currently attached to the task (for tests and the UI's "process alive" hint). */
  isLive(taskId: string): boolean {
    return this.live.has(taskId);
  }

  /**
   * `precomputed` is for the one caller that has to run the router before this point: `POST /api/tasks` with LLM
   * suggestions on (#25) awaits an async suggester, which cannot happen inside this synchronous method. It is still
   * the daemon's own suggestion for this very input — never anything a client sent — and everything else (the
   * scheduler, Inbox promotion) keeps getting the rule table computed here. `afterInsert` runs once the row exists and
   * before the runner starts: what the suggestion turns cost is billed there, so a task that then fails to start (it
   * stays, as an error task) still carries it.
   */
  checkCloudInput(input: Omit<CreateTaskInput, "executionMode"> & { executionMode?: string }): string | undefined {
    if (input.executionMode !== "cloud") return;
    if (input.runner !== "claude") return "Cloud は Claude だけを選択できます。";
    if (!input.cwd && !input.workspaceId) return "Cloud は Workspace を明示選択してください。";
    if (input.model !== undefined || input.permissionMode !== undefined || input.effort !== undefined || input.budgetUsd !== undefined || input.scheduleId !== undefined || input.shadowRunner || input.attachmentIds?.length || input.scope?.some((p) => p !== input.cwd)) return "Cloud はモデル・権限・予算・スケジュール・並走・添付・追加scopeを指定できません。公式 Web で操作してください。";
  }

  create(input: NewTaskInput, precomputed?: RoutingSuggestion, afterInsert?: (task: Task) => void): Task {
    const why = this.checkCloudInput(input);
    if (why) throw new Error(why);
    const cloud = input.executionMode === "cloud";
    const adapter = this.adapters.get(input.runner);
    if (!adapter) throw new Error(`runner "${input.runner}" is not installed`);
    const now = Date.now();
    const id = newId("task");
    // Attachments (#125): their directory (deterministic from the id) is in the scope from the start so the first
    // turn can read them without asking; the files themselves move only once nothing else can refuse the creation.
    const attDir = input.attachmentIds?.length ? this.attachmentDir(id) : null;
    const scope = Array.from(new Set([input.cwd, ...(input.scope ?? []), ...(attDir ? [attDir] : [])]));
    const permissionMode = cloud ? null : this.resolvePermissionMode(input.runner, input.permissionMode);
    const effort = input.effort || null;
    const whyEffort = effort === null ? undefined : this.checkEffort(input.runner, effort);
    if (whyEffort) throw new Error(whyEffort);
    const suggestion = cloud ? undefined : precomputed ?? this.suggest?.(input, scope);
    const task: Task = {
      id,
      workspaceId: input.workspaceId ?? null,
      title: input.title,
      runner: input.runner,
      cwd: input.cwd,
      scope,
      status: "idle",
      runnerSessionId: null, executionMode: input.executionMode ?? "local", cloudSession: null, sourceCloudTaskId: null,
      model: input.model ?? null,
      routing: suggestion ? { suggested: suggestion.runner, ruleId: suggestion.ruleId, reason: suggestion.reason, overridden: suggestion.runner !== input.runner, llm: suggestion.llm ?? null } : null,
      budgetUsd: input.budgetUsd ?? null,
      scheduleId: input.scheduleId ?? null,
      permissionMode,
      effort,
      origin: "switchboard",
      resumeAt: null, resumeReason: null,
      shadowOf: null,
      shadowStopped: false,
      workspaceReason: input.workspaceReason ?? null,
      outcome: "unknown",
      reviewedAt: null,
      archivedAt: null,
      judgedResult: null,
      judgedReason: null,
      judgedBy: null, judgingAt: null,
      stage: input.stage ?? null,
      statusAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const atts = this.takeAttachments(input.attachmentIds, id); // a bad id throws here: no row, nothing moved
    this.db.insertTask(task);
    afterInsert?.(task);
    this.recordAttachments(task.id, atts);
    const prompt = withAttachments(input.prompt, atts);
    this.startOrFail(task, prompt, atts);
    this.startShadow(task, input, prompt, atts);
    return this.db.getTask(task.id) ?? task;
  }

  /** Move the uploads under the task (the store refuses unknown / already-sent ids as a whole). */
  private takeAttachments(ids: string[] | undefined, taskId: string): Attachment[] {
    if (!ids?.length) return [];
    if (!this.attachments) throw new Error("attachments are not enabled on this daemon");
    return this.attachments.attach(ids, taskId);
  }

  private attachmentDir(taskId: string): string {
    if (!this.attachments) throw new Error("attachments are not enabled on this daemon");
    return this.attachments.taskDir(taskId);
  }

  /** One transcript row per file, just before the turn's own user message, so the UI shows them with it. */
  private recordAttachments(taskId: string, atts: Attachment[]) {
    for (const a of atts) this.record(taskId, { t: "attachment", id: a.id, name: a.name, mime: a.mime, size: a.size });
  }

  /**
   * Widen a task's scope to where its attachments live (a turn on a task created without any, or a shadow reading
   * the primary's files). A live runner only learns its roots at start, so it is flagged to restart with --resume;
   * whether that happens on this very turn is decided (and said) in sendOne.
   */
  private widenScope(task: Task, dirs: string[]): { task: Task; widened: boolean } {
    const missing = dirs.filter((d) => !task.scope.includes(d));
    if (!missing.length) return { task, widened: false };
    const updated = this.db.updateTask(task.id, { scope: [...task.scope, ...missing] });
    if (!updated) return { task, widened: false };
    this.broadcast({ type: "task.updated", task: updated });
    const live = this.live.get(task.id);
    if (live) live.restartNext = true;
    return { task: updated, widened: true };
  }

  /**
   * A turn that starts a runner process: the first of a new task, or a reply that finds none. An adapter that throws
   * from start() (a missing binary, a server that refused the session, no file descriptors left: EMFILE) leaves the
   * row saying why — error event, status error — instead of an idle task that never ran.
   */
  private startOrFail(task: Task, prompt: string, atts: Attachment[], resume?: string, preamble?: string) {
    try {
      this.startSession(task, prompt, resume, preamble, atts);
    } catch (e) {
      this.record(task.id, { t: "error", message: String((e as Error).message ?? e) });
      // a Cloud Task lands on idle / error by whether it got a session; a local one is already error (startSession)
      if (task.executionMode === "cloud") this.updateCloudState(task.id);
      else this.setStatus(task.id, "error");
      throw e;
    }
  }

  /**
   * Shadow run (#99): the same prompt on a second runner, as its own task linked by `shadowOf`. The primary is
   * already running; nothing here may fail it — an unavailable default runner or a runner that will not start is
   * noted in the primary's transcript instead. Copied: workspace, cwd / scope, title, the prompt, the budget (the
   * same cap on each side — a paid shadow is capped like the primary, a free runner never reaches it). Not copied: routing (routing_log is
   * training data for #25 and the shadow was not a decision), scheduleId (the schedule did not run it), the
   * permission mode (modes are runner-native; the shadow gets its own runner's saved / adapter default, and the
   * primary's transcript says which — the two may differ in what they can touch in the shared cwd).
   */
  private startShadow(primary: Task, input: NewTaskInput, prompt: string, atts: Attachment[]) {
    if (primary.executionMode === "cloud") return;
    const runner = input.shadowRunner === undefined ? this.defaultShadowRunner?.() ?? null : input.shadowRunner;
    if (!runner) return;
    if (runner === primary.runner) {
      this.record(primary.id, { t: "status", text: `並走（${runner}）は主ランナーと同じなので作りません` });
      return;
    }
    if (!this.adapters.get(runner)) {
      this.record(primary.id, { t: "status", text: `並走（${runner}）は未検出のため作りません` });
      return;
    }
    const now = Date.now();
    const permissionMode = this.resolvePermissionMode(runner);
    const shadow: Task = {
      id: newId("task"),
      workspaceId: primary.workspaceId,
      title: primary.title,
      runner,
      cwd: primary.cwd,
      scope: primary.scope,
      status: "idle",
      runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null,
      model: null,
      routing: null,
      budgetUsd: primary.budgetUsd,
      scheduleId: null,
      permissionMode,
      effort: null, // another runner: its own list, so the CLI default (#833)
      origin: "switchboard",
      resumeAt: null, resumeReason: null,
      shadowOf: primary.id,
      shadowStopped: false,
      workspaceReason: primary.workspaceReason,
      outcome: "unknown",
      reviewedAt: null,
      archivedAt: null,
      judgedResult: null,
      judgedReason: null,
      judgedBy: null, judgingAt: null,
      stage: null,
      statusAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertTask(shadow);
    this.recordAttachments(shadow.id, atts);
    try {
      this.startSession(shadow, prompt, undefined, undefined, atts);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      this.record(shadow.id, { t: "error", message: msg });
      this.setStatus(shadow.id, "error");
      this.record(primary.id, { t: "status", text: `並走（${runner}）を起動できませんでした（${msg}）` });
      return;
    }
    this.record(primary.id, {
      t: "status",
      text: `並走（${runner}）を開始 — 承認モード: ${permissionMode ?? "ランナー側の設定で決まる"}（主の ${primary.permissionMode ?? "ランナー側の設定"} は引き継がれない）。返信はここから写される`,
    });
  }

  /**
   * Follow-up turn. A turn sent to a primary task is copied to its shadow (#99) once the primary took it; a turn sent
   * to the shadow itself stays there. A shadow the user stopped (`shadowStopped`, set by abort()) is left alone;
   * so is one waiting on an approval (a turn pushed into it would end the open confirmation as denied on DAK) — that
   * is noted on both sides, and the person can send the text to the shadow by hand after answering. Anything else
   * — done, errored, aborted by a daemon restart, mid-turn (queued by the adapter) — gets the copy. A copy that
   * fails (a budget the user put on the shadow, a runner that will not resume) is noted on both transcripts, since
   * the person is looking at the primary; it is never raised here. `mirror: false` (the resumer's 今すぐ再開) and
   * `asResume` turns (#102: the daemon continuing this task after its own runner's limit lifted) are not copied —
   * the shadow's runner was not stopped by that.
   */
  async send(taskId: string, text: string, opts: { asResume?: boolean; mirror?: boolean; attachmentIds?: string[] } = {}): Promise<Task> {
    // Everything that can refuse the turn (unknown task, a superseded resume, the budget) runs before any file moves:
    // a refused turn leaves the uploads in the inbox, reusable. Attachments (#125) are taken once, by the primary;
    // the shadow reads the same files (its scope is widened to them).
    await this.preflight(taskId, opts);
    const atts = this.takeAttachments(opts.attachmentIds, taskId);
    this.recordAttachments(taskId, atts);
    text = withAttachments(text, atts);
    const before = this.db.nextSeq(taskId);
    const task = await this.dispatch(taskId, text, atts);
    // The person's turn answers the task's open stops (#948), by its user message (none echoed = nothing recorded).
    if (!opts.asResume) {
      const said = this.db.listEvents(taskId, before - 1).find((e) => e.ev.t === "message.delta" && e.ev.role === "user");
      if (said) this.moveOpenStops(taskId, (s) => ({ ...s, answer: { ref: `seq:${said.seq}`, at: said.ts } }));
    }
    const shadow = opts.asResume || opts.mirror === false ? null : this.db.shadowTaskOf(taskId);
    if (shadow && !shadow.shadowStopped) {
      if (shadow.status === "waiting") {
        this.record(shadow.id, { t: "status", text: "並走元への返信は写しませんでした: この Task は承認待ちです。答えたあと、必要なら同じ文面をここに直接送ってください" });
        this.record(taskId, { t: "status", text: `並走（${shadow.runner}）は承認待ちのため返信を写しませんでした。承認に答えたあと、並走に直接送れます` });
      } else {
        this.recordAttachments(shadow.id, atts);
        this.sendOne(shadow.id, text, { atts }).catch((e) => {
          const msg = String((e as Error).message ?? e);
          this.record(shadow.id, { t: "status", text: `並走の返信を送れませんでした（${msg}）` });
          this.record(taskId, { t: "status", text: `並走（${shadow.runner}）に返信を写せませんでした（${msg}）。ここから先の会話は並走と食い違います` });
        });
      }
    }
    return task;
  }

  /**
   * One task's follow-up turn. Reuses the live process; otherwise restarts the runner with --resume once any release
   * has finished. A person's turn supersedes a planned resume (#102) the moment it is asked for; the resumer's own
   * turn (`asResume`) only goes out if the plan is still there after the wait — a reply or 中断 that landed meanwhile
   * wins (ResumeSupersededError, nothing sent).
   */
  private async sendOne(taskId: string, text: string, opts: { asResume?: boolean; atts?: Attachment[] } = {}): Promise<Task> {
    await this.preflight(taskId, opts);
    return this.dispatch(taskId, text, opts.atts ?? []);
  }

  /** The checks that can refuse a turn, before anything is moved or recorded. Throws; returns the task as it stands. */
  private async preflight(taskId: string, opts: { asResume?: boolean }): Promise<Task> {
    let task = this.mustGet(taskId);
    this.requireLocal(task);
    this.beforeResume?.(task);
    if (!opts.asResume) {
      if (task.resumeAt !== null) task = this.setResumeAt(taskId, null);
      else for (const l of this.planForgottenListeners) l(taskId);
    }
    await this.closing.get(taskId);
    task = this.mustGet(taskId);
    this.beforeResume?.(task);
    if (opts.asResume) {
      if (task.resumeAt === null) throw new ResumeSupersededError("the plan was cleared meanwhile");
      if (task.status === "running" || task.status === "waiting") throw new ResumeSupersededError(`the task is ${task.status}`);
      task = this.setResumeAt(taskId, null);
    }
    if (this.isOverBudget(taskId)) throw new Error(`budget exceeded ($${task.budgetUsd}); raise the budget to continue`);
    return task;
  }

  /**
   * Hand the text to the runner: the live process, or a restart with --resume. `atts` = the turn's attachments: the
   * scope must cover their folders, and the adapter gets them with the text (DAK sends the contents, #124).
   */
  private async dispatch(taskId: string, text: string, atts: Attachment[]): Promise<Task> {
    let task = this.mustGet(taskId);
    const dirs = Array.from(new Set(atts.map((a) => dirname(a.path))));
    let widened = false;
    if (dirs.length) ({ task, widened } = this.widenScope(task, dirs));
    const live = this.live.get(taskId);
    // A process flagged for restart is released first; release() refuses while a turn is in flight, and then the
    // live process takes the text as before (the mode change waits for the next turn) — never two processes.
    if (live && (!live.restartNext || !(await this.release(taskId)))) {
      if (widened) {
        this.onEvent(taskId, live, { t: "status", text: "添付ディレクトリを scope に加えました。実行中のプロセスには渡せないため、この返信の添付を読むときに承認が出ることがあります。次のターンで再開します" });
      }
      this.disarmIdle(live);
      live.turnErrors = [];
      live.turnQuota = undefined;
      live.session.send(text, atts);
      return this.setStatus(taskId, "running");
    }
    if (widened && live) this.record(taskId, { t: "status", text: "添付ディレクトリを scope に加えたので、プロセスを再開します（--resume）" });
    task = this.mustGet(taskId); // the release above was awaited: a model (#155) or mode chosen meanwhile is the one to start with
    let resume = task.runnerSessionId ?? undefined;
    let preamble: string | undefined;
    // A task moved from another machine (#179) whose session record did not come along: `--resume` would fail at once
    // (error_during_execution), so start a new session and hand it the transcript Switchboard kept.
    if (resume && this.adapters.get(task.runner)?.hasSession?.(resume) === false) {
      preamble = recapOf(this.db.listEvents(taskId).map((e) => e.ev));
      this.record(taskId, { t: "status", text: `前のセッション（${resume}）の記録がこの機械に無いため、これまでのやり取りを渡して新しいセッションで続けます` });
      resume = undefined;
    }
    this.startOrFail(this.withResolvedMode(task), text, atts, resume, preamble);
    return this.mustGet(taskId);
  }

  /** Background jobs of the attached runners (Claude's run_in_background shells and Monitors): work the host is still doing. */
  backgroundJobs(): number {
    let n = 0;
    for (const l of this.live.values()) n += l.background ?? 0;
    return n;
  }

  /** Whether a runner process is attached to the task or still closing after a release (its grace period). */
  holdsProcess(taskId: string): boolean {
    return this.live.has(taskId) || this.closing.has(taskId);
  }

  /** Release the idle task's process and wait until every close of it in flight, earlier ones included, has finished. */
  async releaseAndWait(taskId: string): Promise<void> {
    await this.release(taskId);
    await this.closing.get(taskId);
  }

  /** Release the runner process of an idle task (no turn in flight). The task keeps its status; the next turn resumes. */
  async release(taskId: string, opts: { graceMs?: number } = {}): Promise<boolean> {
    const live = this.live.get(taskId);
    if (!live) return false;
    const task = this.db.getTask(taskId);
    if (task && !TERMINAL.has(task.status) && task.status !== "idle") return false;
    this.disarmIdle(live);
    this.live.delete(taskId);
    await this.track(taskId, live.session.close(opts));
    return true;
  }

  private track(taskId: string, p: Promise<void>): Promise<void> {
    const done = p.catch(() => undefined).finally(() => {
      if (this.closing.get(taskId) === done) this.closing.delete(taskId);
      this.maybeEnded(taskId);
    });
    this.closing.set(taskId, done);
    return done;
  }

  /** Fire onTaskEnd listeners once the task is terminal and no process is attached. */
  private maybeEnded(taskId: string) {
    if (this.live.has(taskId)) return;
    const t = this.db.getTask(taskId);
    if (t && TERMINAL.has(t.status)) for (const l of this.endListeners) l(taskId, t);
  }

  /** `answers`: the user's reply to a question tool (AskUserQuestion), handed to the adapter with the allow. */
  respondPermission(taskId: string, id: string, decision: PermissionDecision, answers?: Record<string, string>): Task {
    this.requireLocal(this.mustGet(taskId));
    const live = this.live.get(taskId);
    if (!live) throw new Error("task has no live runner session");
    if (!live.pendingPermissions.has(id)) throw new Error(`no pending permission ${id}`);
    const host = live.hostAsks.get(id);
    if (host) {
      live.hostAsks.delete(id);
      live.pendingPermissions.delete(id);
      host(decision);
      this.onEvent(taskId, live, { t: "permission.resolved", id, decision, by: "user" });
      return this.afterAnswer(taskId, live);
    }
    live.session.respondPermission(id, decision, undefined, "user", answers);
    live.pendingPermissions.delete(id);
    return this.afterAnswer(taskId, live);
  }

  /** An answer moves a turn in flight on; a finished task that was only holding the ask keeps its status. */
  private afterAnswer(taskId: string, live: LiveSession): Task {
    const t = this.mustGet(taskId);
    return IN_FLIGHT.has(t.status) ? this.setStatus(taskId, live.pendingPermissions.size ? "waiting" : "running") : t;
  }

  async abort(taskId: string): Promise<Task> {
    const live = this.live.get(taskId);
    let task = this.mustGet(taskId);
    if (task.executionMode === "cloud") {
      if (live) { await live.session.close(); this.live.delete(taskId); }
      this.record(taskId, { t: "status", text: "開始プロセスを閉じました。Cloud 作業の停止は確認していません。公式 Web で操作してください。" });
      return this.updateCloudState(taskId);
    }
    // 中断 also means "do not come back to this on its own" (#102).
    // 中断 forgets any planned resume — a plan still waiting for its GitHub budget read too (#550, onPlanForgotten);
    // a finished task with no plan is not rewritten (its updatedAt is what the backlog reads)
    if (task.resumeAt !== null) task = this.setResumeAt(taskId, null);
    else for (const l of this.planForgottenListeners) l(taskId);
    // Stopping a shadow (#99) is the user saying "no more copies" — whatever state it is in (mid-turn, done, error).
    // Only this path sets the flag: a daemon restart that closes a shadow as aborted does not detach it.
    const primaryId = task.shadowOf;
    if (primaryId && !task.shadowStopped) {
      task = this.db.updateTask(taskId, { shadowStopped: true }) ?? task;
      this.broadcast({ type: "task.updated", task });
      this.record(taskId, { t: "status", text: "並走を停止: 以後、並走元への返信はここに写されません（ここへ直接送ることはできます）" });
      this.record(primaryId, { t: "status", text: `並走（${task.runner}）を停止しました。以後の返信は写されません` });
    }
    // Stopping the primary does not stop its shadow (independent tasks), but a resume the shadow had planned on its
    // own (#102) is a turn nobody asked for any more — a paid shadow must not come back hours after the request died.
    const shadow = primaryId ? null : this.db.shadowTaskOf(taskId);
    if (shadow && shadow.resumeAt !== null) {
      this.setResumeAt(shadow.id, null);
      this.record(shadow.id, { t: "status", text: "並走元が中断されたので、予定していた自動再開を取り消しました（返信すれば続けられます）" });
    }
    // 中断 cancels a planned retry (#948): the stop waits for the person again.
    this.moveOpenStops(taskId, (s) => (s.state === "retrying" ? { ...s, state: "waiting", actions: [...s.actions, { attempt: Math.max(0, ...s.actions.map((a) => a.attempt)), at: Date.now(), what: "中断で再試行を取り消し", ok: false }].slice(-20) } : null));
    if (live) {
      this.disarmIdle(live);
      this.live.delete(taskId);
      // An idle process (turn already finished) is released, not aborted: the task keeps its result.
      if (TERMINAL.has(task.status)) {
        await this.track(taskId, live.session.close());
        return task;
      }
      await this.track(taskId, live.session.abort());
    }
    return TERMINAL.has(task.status) ? task : this.setStatus(taskId, "aborted");
  }

  /**
   * Abort in-flight turns, kill idle processes right away. Finished tasks keep their status across a daemon restart; a
   * turn cut here, or a finished one's wait on background jobs, is planned to continue on the next start (interrupted.ts).
   * Returns the ids of those tasks.
   */
  async shutdown(): Promise<string[]> {
    const now = Date.now();
    const cut: string[] = [];
    await Promise.all(
      [...this.live.entries()].map(([taskId, l]) => {
        this.disarmIdle(l);
        const task = this.db.getTask(taskId);
        const idle = !task || TERMINAL.has(task.status) || task.status === "idle";
        // a finished task still waiting on its runner's background jobs loses them with the process: planned like a cut turn,
        // unless it already waits for a limit's reset (that plan stays; its resume comes then)
        const waitingOnJobs = !!task && (task.status === "done" || task.status === "error") && (l.background ?? 0) > 0 && task.resumeAt === null;
        if (task && (!idle || waitingOnJobs) && task.executionMode !== "cloud") {
          planResumeAfterStop(this.db, task, now, (ev) => this.record(taskId, ev), this.maxStopResumes());
          cut.push(taskId);
        }
        return (idle ? l.session.close({ graceMs: 0 }) : l.session.abort()).catch(() => undefined);
      }),
    );
    this.live.clear();
    return cut;
  }

  /* ---------- internals ---------- */

  /**
   * Tasks from before #58 carry no mode (NULL). Resuming one goes through the same resolution as a new task (saved
   * runner default → adapter default) and records the result, so the row says what the resumed turn ran with.
   */
  private withResolvedMode(task: Task): Task {
    if (task.permissionMode !== null) return task;
    const mode = this.resolvePermissionMode(task.runner);
    if (mode === null) return task;
    const updated = this.db.updateTask(task.id, { permissionMode: mode });
    if (!updated) return task;
    this.broadcast({ type: "task.updated", task: updated });
    return updated;
  }

  private startSession(task: Task, prompt: string, resumeSessionId: string | undefined, preamble?: string, attachments: Attachment[] = []) {
    const adapter = this.adapters.get(task.runner);
    if (!adapter) throw new Error(`runner "${task.runner}" is not installed`);
    // A task moved from another machine (#179) whose folder is not here: say so on the task and fail like a start
    // that threw (callers note it on a primary / answer 409), instead of a spawn error with no trace on the task.
    if (!existsSync(task.cwd)) {
      const msg = `作業フォルダ ${task.cwd} がこの機械に無いため、ランナーを起動できません`;
      this.record(task.id, { t: "status", text: msg });
      this.setStatus(task.id, "error");
      throw new Error(msg);
    }
    if (task.executionMode === "cloud") { this.startCloudSession(task, prompt, adapter); return; }
    // Development-standard skills where the runner reads them (#469). A skill that cannot be placed never stops the task.
    const meta = this.db.listWorkspaces().find((w) => w.kind === "meta");
    if (meta) {
      try {
        for (const s of syncSkills({ metaPath: meta.path, cwd: task.cwd }).skipped) {
          this.record(task.id, { t: "status", text: `スキル ${s.name} はリポジトリにあるもの（${s.path}）を使います。Switchboard の正本は置いていません` });
        }
      } catch (e) {
        this.record(task.id, { t: "status", text: `スキルを置けませんでした: ${(e as Error).message ?? e}` });
      }
      // Copies of the operating tools that do not call the shared kit (#557); noted, never stopped on.
      try {
        for (const name of setupScripts({ metaPath: meta.path, cwd: task.cwd }).copies) {
          this.record(task.id, { t: "status", text: `scripts/setup/${name} は共通キットを呼ばない写しです。検査の結果が共通スキルとずれることがあります` });
        }
      } catch (e) {
        this.record(task.id, { t: "status", text: `scripts/setup を調べられませんでした: ${(e as Error).message ?? e}` });
      }
    }
    // The check in front of `gh` (#661, docs/design/secret-guard.md): the kit's bin first in the runner's PATH, and
    // the folder of the bun this daemon runs on last (the check runs on bun; a daemon started by bun's full path has
    // none in its PATH; last, so that it does not come before the user's own tools)
    const path = meta ? { PATH: [join(meta.path, "ops-kit/bin"), process.env.PATH ?? "", dirname(process.execPath)].join(delimiter) } : undefined;
    const deviceAuth = this.deviceAuthEnv?.(task.id);
    // #1397: everything the task starts, detached or not, carries this; onTaskEnd stops what still does
    const env = { ...path, ...deviceAuth, ...this.dockerEnv?.(task.id), SWITCHBOARD_TASK_ID: task.id };
    // The stop for writes to fixed names right under /tmp (#764, docs/design/shared-tmp-guard.md): the kit's hook
    const guards = meta ? [shellQuote(join(meta.path, "ops-kit/bin/deny-shared-tmp"))] : undefined;
    // How to report a stop and when to retry (#949), with the work's stops still open: before every start's prompt.
    const recovery = stopRecoveryPrompt(reduceStops(stopRecordsFor(this.db, task)).filter((s) => s.state !== "resolved"));
    // The insights schedule's Task (#1838) sends `/insights` and nothing else: Claude Code expands a built-in slash
    // command only when it is the whole user message, so nothing goes in front of it (no recap, no stop report).
    const bare = !!task.scheduleId && this.db.getSchedule(task.scheduleId)?.action === "insights";
    preamble = bare ? undefined : [preamble, recovery, artifactPrompt()].filter((p): p is string => !!p).join("\n\n");
    // in flight before the adapter can emit anything: its events only move a running / waiting task (onEvent)
    this.setStatus(task.id, "running");
    const live: LiveSession = { session: undefined as unknown as RunnerSession, pendingPermissions: new Map(), hostAsks: new Map(), ruleMatches: new Map(), turnErrors: [], turnCalls: new Map(), turnGithub: new Map(), stopReader: new StopFenceReader(), artifactReader: new FenceReader("switchboard-artifact", parseArtifactFence) };
    this.live.set(task.id, live);
    try {
      // For the runner that cannot run the hook (Codex, #787): a temp directory of the task's own, removed when it ends.
      // Not made = the task does not start (the error below), never a Codex without the stop.
      const privateTmp = meta && task.runner === "codex" && this.privateTmpRoot ? makePrivateTmp(this.privateTmpRoot, task.id) : undefined;
      live.session = adapter.start(
        { cwd: task.cwd, scope: task.scope, prompt, model: task.model ?? undefined, permissionMode: task.permissionMode ?? undefined, effort: task.effort ?? undefined, resumeSessionId, preamble, env, guards, privateTmp, bedrock: this.bedrock?.(task), attachments, attachmentDir: this.attachments?.taskDir(task.id), mcpServers: this.mcpServers?.(task) },
        (ev) => this.onEvent(task.id, live, ev),
      );
    } catch (e) {
      // An adapter that throws from start() must not leave a session-less entry behind (shutdown would trip on it).
      this.live.delete(task.id);
      this.setStatus(task.id, "error");
      throw e;
    }
    void live.session.exited.then((code) => {
      for (const resolve of live.hostAsks.values()) resolve("deny");
      live.hostAsks.clear();
      if (this.live.get(task.id) === live) {
        this.disarmIdle(live);
        this.live.delete(task.id);
        const cur = this.db.getTask(task.id);
        if (cur && (cur.status === "running" || cur.status === "waiting")) {
          this.onEvent(task.id, live, { t: "session.end", status: code === 0 ? "ok" : "error", summary: `runner exited (${code})` });
        }
        this.maybeEnded(task.id);
      }
    });
  }

  private requireLocal(task: Task) {
    if (task.executionMode === "cloud") throw new Error("Cloud の続行・再開・設定変更は公式 Web で操作してください。");
  }

  private updateCloudState(taskId: string): Task {
    const task = this.mustGet(taskId);
    // the outcome is the rule's (task-status.ts): a Cloud Task is never judged here, so unknown
    const updated = this.transition(taskId, task.cloudSession ? "idle" : "error", { resumeAt: null, resumeReason: null, runnerSessionId: null })!;
    this.broadcast({ type: "task.updated", task: updated });
    return updated;
  }

  private startCloudSession(task: Task, prompt: string, adapter: RunnerAdapter) {
    const preparation = readCloudPreparation(task.cwd);
    this.record(task.id, { t: "status", text: `Cloud 明示選択による転送範囲の了承。起動直前の Git 状態: ${JSON.stringify(preparation)}` });
    const live: LiveSession = { session: undefined as unknown as RunnerSession, pendingPermissions: new Map(), hostAsks: new Map(), ruleMatches: new Map(), turnErrors: [], turnCalls: new Map(), turnGithub: new Map(), stopReader: new StopFenceReader(), artifactReader: new FenceReader("switchboard-artifact", parseArtifactFence) };
    this.live.set(task.id, live);
    this.setStatus(task.id, "running");
    try {
      live.session = adapter.start({ executionMode: "cloud", cwd: task.cwd, scope: [task.cwd], prompt }, (ev) => this.onEvent(task.id, live, ev));
    } catch (e) {
      this.live.delete(task.id); this.updateCloudState(task.id); throw e;
    }
    void live.session.exited.then(() => {
      if (this.live.get(task.id) !== live) return;
      this.live.delete(task.id);
      const current = this.updateCloudState(task.id);
      this.record(task.id, { t: "status", text: current.cloudSession ? "開始プロセスは終了しました。Cloud 作業の状態は未確認です。公式 Web で操作してください。" : "Cloud 作成の参照を確認できません。公式 Web で有無を確認してください。自動再試行はしません。" });
    });
  }

  /**
   * Budget (#15): once cumulative API-equivalent spend passes the task's budget, further turns are refused (409)
   * until the user raises the budget or stops the task. The crossing is noted once per turn in the transcript; the
   * decision itself is a UI action (×2 / 中断), not a permission.ask — a running turn is never interrupted, and a
   * synthetic ask arriving next to session.end would leave the task in a contradictory state.
   */
  private checkBudget(taskId: string, live: LiveSession, task: Task) {
    if (task.budgetUsd === null) return;
    const spent = this.db.taskCost(taskId).costUsd;
    if (spent <= task.budgetUsd) return;
    if (live.budgetNoted === task.budgetUsd) return;
    live.budgetNoted = task.budgetUsd;
    this.onEvent(taskId, live, { t: "status", text: `予算 $${task.budgetUsd} を超過（API 換算 $${spent.toFixed(4)}）。次のターンは予算を上げるまで送れません` });
  }

  private armIdle(taskId: string, live: LiveSession) {
    this.disarmIdle(live);
    if (this.idleMs < 0 || live.background) return;
    live.idleTimer = setTimeout(() => void this.release(taskId), this.idleMs);
  }

  private disarmIdle(live: LiveSession) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = undefined;
  }

  private onEvent(taskId: string, live: LiveSession, ev: AgentEvent) {
    const cloudTask = this.db.getTask(taskId);
    if (cloudTask?.executionMode === "cloud") {
      if (ev.t === "cloud.session.created") {
        const ref = CloudSessionRef.safeParse({ id: ev.id, url: ev.url });
        if (!ref.success) { this.record(taskId, { t: "error", message: "Cloud 参照を検証できません。公式 Web で確認してください。" }); return; }
        if (cloudTask.cloudSession) return;
        this.db.updateTask(taskId, { cloudSession: ref.data });
        this.updateCloudState(taskId);
      } else if (ev.t !== "message.delta" && ev.t !== "status" && ev.t !== "error") return;
      const env = this.db.appendEvent(taskId, ev);
      this.broadcast({ type: "event", env });
      return;
    }
    if (ev.t === "cloud.session.created") return;
    // Approval rules run before the ask is persisted so the recorded event carries the matched rule.
    let autoAllow: ApprovalRuleMatch | undefined;
    if (ev.t === "permission.ask" && this.approval) {
      const t = this.db.getTask(taskId);
      const verdict = t ? this.approval(t, ev) : { decision: "ask" as const };
      if (verdict.match) ev = { ...ev, rule: verdict.match };
      if (verdict.decision === "allow") autoAllow = verdict.match;
    }
    if (ev.t === "permission.resolved" && ev.by === "rule" && !ev.rule) {
      const m = live.ruleMatches.get(ev.id);
      if (m) ev = { ...ev, rule: m };
      live.ruleMatches.delete(ev.id);
    }
    // a fence whose closing line ends the reply (no newline after it) is only read when the reply ends: read it before the
    // event that ends the reply is recorded, so its stop / artifact row comes before the tool row or 完了 (#1936)
    if (endsReply(ev)) this.readFences(taskId, live, ev);
    const env = this.db.appendEvent(taskId, ev);
    const task = this.db.getTask(taskId);
    if (!task) return;
    this.readStops(taskId, live, ev, env.seq, env.ts);

    if (ev.t === "permission.ask" && autoAllow) {
      // Recorded as asked → resolved by rule; the task never enters "waiting". Then handed to the runner / host ask.
      this.broadcast({ type: "event", env });
      const host = live.hostAsks.get(ev.id);
      if (host) {
        live.hostAsks.delete(ev.id);
        host("allow");
        this.onEvent(taskId, live, { t: "permission.resolved", id: ev.id, decision: "allow", by: "rule", rule: autoAllow });
        return;
      }
      try {
        // The adapter emits permission.resolved(by: rule) itself once it has answered the runner.
        live.ruleMatches.set(ev.id, autoAllow);
        live.session.respondPermission(ev.id, "allow", `allowed by rule ${autoAllow.source}: ${autoAllow.pattern}`, "rule");
        return;
      } catch (e) {
        // The runner did not take the answer (closed stdin, unknown id): fall through and let the user decide.
        live.ruleMatches.delete(ev.id);
        this.onEvent(taskId, live, { t: "status", text: `rule allow could not be delivered (${String((e as Error).message ?? e)}); asking the user` });
      }
    }

    switch (ev.t) {
      case "session.start":
        {
          // a runner's event moves a task only while a turn is in flight; the session id and model are kept either way
          const extra = { runnerSessionId: ev.runnerSessionId ?? task.runnerSessionId, model: live.modelChanged ? task.model : (ev.model ?? task.model) };
          // A turn the attached runner starts on its own after the last one ended (Claude Code on a background job's
          // notification) is in flight like a sent one: the idle release must not kill it mid-command (Exit code 137),
          // and its end must be reported. A released or aborted process is no longer attached.
          const ownTurn = (task.status === "done" || task.status === "error") && this.live.get(taskId) === live;
          if (ownTurn) {
            this.disarmIdle(live);
            live.turnErrors = [];
            live.turnQuota = undefined;
          }
          if (!(IN_FLIGHT.has(task.status) || ownTurn) || !this.transition(taskId, "running", extra)) this.db.updateTask(taskId, extra);
        }
        break;
      case "permission.ask":
        live.pendingPermissions.set(ev.id, { ask: ev, at: env.ts }); // the recorded event's time, as the transcript and /api/queue show it
        if (IN_FLIGHT.has(task.status)) this.transition(taskId, "waiting");
        break;
      case "permission.resolved":
        live.pendingPermissions.delete(ev.id);
        if (task.status === "waiting" && live.pendingPermissions.size === 0) this.transition(taskId, "running");
        break;
      case "usage":
        if (ev.source === "reported" && !ev.cumulative) {
          this.db.insertLedger(ledgerRowFor(this.pricing?.(), task, ev, env.ts));
          this.checkBudget(taskId, live, task);
        } else if (ev.source === "reported") {
          // a running total of the session (Claude, #2353): the row is what it grew by since the last one of this model
          const prev = this.db.lastReportedTotal(taskId, ev.model ?? null);
          const turn = usageSince(prev, ev, task.runnerSessionId, prev ? 0 : this.db.migratedCredit(taskId, task.runnerSessionId));
          if (turn) {
            this.db.insertLedger(ledgerRowFor(this.pricing?.(), task, turn.usage, env.ts), turn.total);
            this.checkBudget(taskId, live, task);
          }
        }
        break;
      case "artifact": {
        // A file the runner made in the task's attachment directory (#124) is one of the task's files from here on.
        const a = ev.kind === "file" ? this.attachments?.register(taskId, ev.path) : undefined;
        if (a) this.recordAttachments(taskId, [a]);
        break;
      }
      case "quota":
        for (const [w, v] of Object.entries(ev.windows)) this.db.upsertQuota(ev.runner, w, v.utilization, v.resetsAt, env.ts);
        live.turnQuota = ev;
        break;
      case "tool.call":
        live.turnCalls.set(ev.id, { name: ev.name, key: `${ev.name}:${JSON.stringify(ev.input ?? null)}` });
        break;
      case "tool.result": {
        // a GitHub limit line at the head of a command's result (#550); the same command succeeding later takes it out
        const call = live.turnCalls.get(ev.id);
        live.turnCalls.delete(ev.id);
        if (call) {
          const hit = githubLimitHit(call.name, ev.summary ?? "");
          if (hit) live.turnGithub.set(call.key, hit);
          else if (ev.ok) live.turnGithub.delete(call.key);
        }
        break;
      }
      case "session.end":
        // Only an in-flight turn can end. A late session.end (e.g. the process being released) must not
        // rewrite a task that already finished.
        if (task.status === "running" || task.status === "waiting") {
          this.transition(taskId, ev.status === "ok" ? "done" : ev.status === "aborted" ? "aborted" : "error");
          // A shadow's turn that ended in error (#99) — a session the agent lost, an ADK error — is invisible from the
          // primary, which is where the person is looking; the copies stop matching from here on.
          if (ev.status === "error" && task.shadowOf) this.record(task.shadowOf, { t: "status", text: `並走（${task.runner}）のターンがエラーで終わりました（${ev.summary ?? ""}）。ここから先の会話は並走と食い違います` });
        }
        // Keep the process for quick follow-ups only when nothing is pending; a permission still open means the turn is not over.
        if (ev.status !== "aborted" && live.pendingPermissions.size === 0 && this.live.get(taskId) === live) this.armIdle(taskId, live);
        // A turn ended only if one was in flight; the session.end that closing an idle process emits is not a turn.
        if (task.status === "running" || task.status === "waiting") {
          const after = this.db.getTask(taskId);
          const turn: TurnEnd = { end: ev, errors: live.turnErrors, quota: live.turnQuota, githubLimit: [...live.turnGithub.values()].at(-1) };
          live.turnCalls.clear();
          live.turnGithub.clear();
          live.turnErrors = [];
          live.turnQuota = undefined;
          if (after) for (const l of this.turnEndListeners) l(taskId, after, turn);
        }
        break;
      case "background":
        live.background = ev.count;
        // a job left keeps the process (its notification starts the next turn); the last one gone starts the idle clock
        if (ev.count > 0) this.disarmIdle(live);
        else if (!IN_FLIGHT.has(task.status) && live.pendingPermissions.size === 0 && this.live.get(taskId) === live) this.armIdle(taskId, live);
        break;
      case "error":
        // Recorded in the transcript only. The status is decided by session.end (or by the exit handler when the
        // process dies without one), so a recoverable mid-turn error cannot stick over a later session.end(ok).
        // Kept for the turn-end listeners (a usage-limit stop may be reported here rather than in session.end).
        if (live.turnErrors.length < 5) live.turnErrors.push(ev.message.slice(0, 300));
        break;
      default:
        break;
    }

    this.broadcast({ type: "event", env });
    const updated = this.db.getTask(taskId);
    if (updated && (updated.status !== task.status || updated.runnerSessionId !== task.runnerSessionId)) {
      this.broadcast({ type: "task.updated", task: updated });
    }
  }

  /**
   * Stop reports in the runner's own reply (#948): assistant text only — a tool's output or the person's message is
   * never read; a tool call, an ask, the turn's end or the person's message closes the message. A person's answer to an ask answers the task's open stops that wait on one.
   */
  private readStops(taskId: string, live: LiveSession, ev: AgentEvent, seq: number, ts: number) {
    if (ev.t === "stop.record") return;
    // the reply's own text and the person's next message, after they are recorded; the other ends were read before (onEvent)
    if (ev.t === "message.delta") this.readFences(taskId, live, ev);
    // an answer to an ask answers the stops waiting on one (permission / decision), not a CI wait or a usage limit
    if (ev.t === "permission.resolved" && ev.by === "user") this.moveOpenStops(taskId, (s) => (s.reason === "permission" || s.reason === "decision" ? { ...s, answer: { ref: `seq:${seq}`, at: ts } } : null));
  }

  /**
   * The runner's `switchboard-stop` (#948) and `switchboard-artifact` (#1778) fences: a reply's text feeds them, and what
   * ends the reply (`endsReply`, the person's next message) closes a fence still open in it.
   */
  private readFences(taskId: string, live: LiveSession, ev: AgentEvent) {
    const text = ev.t === "message.delta" && ev.role === "assistant" ? ev : null;
    const reports = text ? live.stopReader.feed(text.text, text.messageId) : live.stopReader.end();
    for (const r of reports) this.recordStop(taskId, r);
    const found = text ? live.artifactReader.feed(text.text, text.messageId) : live.artifactReader.end();
    for (const a of found) this.saveArtifact(taskId, a);
  }

  /**
   * An agent's `switchboard-artifact` fence (#1778): registered as a path typed on the 成果物 tab would be — the same
   * scope, the same limits, the same path replacing its copy. A refusal is one status line on the Task, never a stop.
   */
  private saveArtifact(taskId: string, fence: ArtifactFence) {
    const task = this.db.getTask(taskId);
    if (!task) return;
    if (!fence.ok) {
      this.record(taskId, { t: "status", text: `成果物を登録できませんでした（フェンスが読めません: ${fence.why}）` });
      return;
    }
    const report = fence.report;
    if (!this.artifacts) {
      this.record(taskId, { t: "status", text: "成果物を登録できませんでした（この構成では成果物の置き場がありません）" });
      return;
    }
    try {
      const a = this.artifacts.add(task, { source: report.path, title: report.title });
      this.record(taskId, { t: "artifact.saved", id: a.id, title: a.title });
    } catch (e) {
      this.record(taskId, { t: "status", text: `成果物を登録できませんでした（${String((e as Error).message ?? e)}）` });
    }
  }

  private setStatus(taskId: string, status: Task["status"]): Task {
    const before = this.mustGet(taskId).status;
    const t = this.transition(taskId, status);
    // a move the table lacks is a mistake of whoever asked (an API call on a finished task), not something to store
    if (!t) throw new InvalidTaskTransitionError(taskId, before, status);
    this.broadcast({ type: "task.updated", task: t });
    if (TERMINAL.has(status) && !TERMINAL.has(before)) this.maybeEnded(taskId);
    return t;
  }

  /**
   * The one place a task's status is written (#1140): checked against the table (task-status.ts) first, and `null`
   * when the move is not allowed, with the row untouched. The outcome follows by rule in `Db.updateTask`.
   */
  private transition(taskId: string, status: Task["status"], extra: Partial<Pick<Task, "runnerSessionId" | "model" | "resumeAt" | "resumeReason">> = {}): Task | null {
    const cur = this.db.getTask(taskId);
    if (!cur || !canTransition(cur.status, status)) return null;
    return this.db.updateTask(taskId, { status, ...extra });
  }

  private mustGet(taskId: string): Task {
    const t = this.db.getTask(taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    return t;
  }
}
