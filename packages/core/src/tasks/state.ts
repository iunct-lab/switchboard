/**
 * The TaskManager's shared state (see `TaskManagerState`), the types its options and listeners are written in, and
 * the managers whose queue timer is armed.
 */
import { otherMachineOf, requireOwn } from "../machine.ts";
import type { AgentEvent, ApprovalRuleMatch, McpServerConfig, StopRecord, Attachment, CreateTaskInput, PermissionDecision, PricingTable, RoutingSuggestion, RunnerAdapter, RunnerId, RunnerSession, ServerMessage, Task, LoginKind } from "@switchboard/protocol";
import type { AttachmentStore } from "../attachments.ts";
import type { ArtifactFence, ArtifactStore } from "../artifacts.ts";
import { Db } from "../db.ts";
import { MAX_STOP_RESUMES } from "../interrupted.ts";
import { FenceReader, StopFenceReader } from "../stops.ts";
import { foreignWorkspaceOf, RunnerConfigUnconfirmed, runnerConfigOf } from "../runner-config.ts";

/** A reply held for a process's background jobs (see `LiveSession.heldReplies`). */
export interface HeldReply {
  text: string;
  /** The sender's last check, run right before the hand-over; one that throws is not handed over. */
  going?: () => void;
  /** Run once the reply is handed over. */
  sent?: () => void;
  /** Run when the reply is not handed over: dropped (中断, the daemon stopping) or refused by `going`. */
  dropped?: () => void;
  /** The stops the reply answers: only ones that were open when it was sent. */
  answers?: (s: StopRecord) => boolean;
}

export interface LiveSession {
  session: RunnerSession;
  /** The runner's events not yet taken in, oldest first: more than the one in hand only while the database is locked (fromRunner). */
  held: AgentEvent[];
  /** What the runner's exit still has to do once the held events are in. */
  afterHeld?: () => void;
  /** The agent's `switchboard-artifact` fences in its replies, read like the stop reports. */
  artifactReader: FenceReader<ArtifactFence>;
  /** Unanswered permission.ask by id, with when it was asked (kept in memory: an ask lives only as long as its runner). */
  pendingPermissions: Map<string, { ask: Extract<AgentEvent, { t: "permission.ask" }>; at: number }>;
  /** permission.ask raised by Switchboard itself (Workspace MCP exec.run), resolved by the user's answer. */
  hostAsks: Map<string, (d: PermissionDecision) => void>;
  /** ask id → rule that auto-allowed it, so the adapter's permission.resolved can carry the rule. */
  ruleMatches: Map<string, ApprovalRuleMatch>;
  /** The last event recorded for this task is the status `thinking`: a runner's next one adds nothing, so it is not recorded. */
  thinkingRecorded?: boolean;
  /** The budget value whose crossing was already noted in the transcript (avoids a note per usage event). */
  budgetNoted?: number;
  /** Armed after session.end: releases the idle runner process so later turns go through --resume. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Background jobs the runner still has (the last `background` event). While any is left the process is not released. */
  background?: number;
  /** When the runner last gave an event, or was last sent a turn (ms): what its silence is counted from (waits.ts). */
  lastEventAt: number;
  /** The hook the runner runs now, from its heartbeats (`hook.progress`): its name, the first heartbeat (or the start the runner gave), the last heartbeat (ms). Any other event clears it. Memory only: a heartbeat is not a record of the transcript. */
  hook?: { name: string; since: number; beatAt: number };
  /**
   * Replies sent under the admission hold while the Task sat on background jobs, oldest first. The queue holds only idle
   * rows and the process must keep running its jobs, so the text waits here (memory: it goes with the process) until the
   * Task leaves its jobs and turns, or the hold ends; then it is dispatched like a reply sent at that moment (flushHeldReplies).
   * `going` / `sent` are the sender's last check and its record (a grant) and `answers` the stops the reply answers: all
   * three run only when the text is handed over, so a reply dropped here leaves no grant and no answered stop.
   */
  heldReplies?: HeldReply[];
  /**
   * The next turn must restart the runner (--resume) instead of reusing this process: its mode changed and it could
   * not switch live, or its scope grew (an attachment directory) and roots are only read at start.
   */
  restartNext?: boolean;
  /**
   * The task's model was changed while this process — started with the old one — is still attached. Its
   * session.start (Claude reports one per turn) names the old model and must not write it back over the choice.
   */
  modelChanged?: boolean;
  /** The thinking effort this process was started with ("" = the CLI's default); core stamps it on the session.start it records. */
  effort: string;
  /** `error` messages of the turn in flight (bounded), handed to turn-end listeners with the session.end. */
  turnErrors: string[];
  /** The turn's tool calls not yet answered: id → the tool and its input as one key. */
  turnCalls: Map<string, { name: string; key: string; graphql: boolean }>;
  /** The GitHub limit lines the turn's commands met and when, per command key, oldest first; a later success of the same command takes its line out, of a command using GraphQL all of them. */
  turnGithub: Map<string, { line: string; at: number }>;
  /** The disk-full words a failed command of the turn met; the resumer looks at the disk itself before it waits. */
  turnDisk?: string;
  /** The last quota report of the turn in flight — the runner's own view of the window that stopped it. */
  turnQuota?: Extract<AgentEvent, { t: "quota" }>;
  /** The turn in flight asked the person through the runner's question tool: its ok end leaves the Task 要対応. */
  turnQuestion?: boolean;
  /** `switchboard-stop` reports in the runner's reply as it streams. */
  stopReader: StopFenceReader;
}

/** What a turn ended with: its session.end, the error messages raised during it, and its last quota report. */
export interface TurnEnd {
  end: Extract<AgentEvent, { t: "session.end" }>;
  errors: string[];
  quota?: Extract<AgentEvent, { t: "quota" }>;
  /** The last GitHub limit line a command of the turn met and never got past. */
  githubLimit?: string;
  /** When the command met `githubLimit`; a limit a whole window old has no claim on the turn's end. */
  githubLimitAt?: number;
  /** The disk-full words a command or an error of the turn carried. */
  diskFull?: string;
}

/** `send(…, { asResume: true })` found the task moved on meanwhile (a reply, 中断, a cancel): nothing was sent. */
export class ResumeSupersededError extends Error {
  constructor(why: string) {
    super(`resume superseded: ${why}`);
  }
}

/**
 * What `create()` takes: the API's input with the Workspace settled. `cwd` is optional on the wire ("自動") and
 * resolved by the server before this point; `workspaceReason` is the daemon's own record of that choice, which is
 * why it is not a field of `CreateTaskInput` (a client cannot claim a task was auto-routed).
 */
export type NewTaskInput = Omit<CreateTaskInput, "executionMode"> & {
  cwd: string; executionMode?: CreateTaskInput["executionMode"]; workspaceReason?: string; stage?: Task["stage"]; origin?: Task["origin"];
  /** The Issues this Task is started to work on (the numbers), recorded in its provenance. Not on the API's input: only the bundle route passes it. */
  issues?: number[];
  /** The prompt as the app writes it for a runner, when it wrote `prompt` itself: a shadow on another runner gets its own text. Not saved. */
  promptFor?: (runner: RunnerId) => string;
};

/**
 * True for any Fable version (claude-fable-5-1, claude-fable-5-2, ...), with a trailing context tag (`[1m]`), in
 * Amazon Bedrock's form (global.anthropic.claude-fable-5-2) and as the bare alias `fable`. Not for Opus / Sonnet /
 * Haiku or no model. The same reading of the name as `resolveModel` in pricing.ts.
 */
export function isFableModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const name = model.replace(/\[[^\]]*\]$/, "").replace(/^([a-z]+\.)?(anthropic|openai)\./, "");
  return name === "fable" || name.startsWith("claude-fable-");
}

/** Whether a CLI version `a.b.c` is at least `min`. An unknown version (or no minimum recorded) is not. */
export function versionAtLeast(version: string | undefined, min: string | undefined): boolean {
  const parse = (v: string | undefined) => v?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const have = parse(version);
  const need = parse(min);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

export interface TaskManagerOptions {
  /** Whether a runner can start from a past turn: the adapter's `forks` and the detected version. Unset = the adapter's `forks`. */
  runnerForks?: (runner: RunnerId) => boolean;
  /** How a checkout's origin URL is read for the start check (originMismatch). Unset = git. */
  originOf?: (path: string) => string | null;
  /** Where a Codex task's own temp directory is made: `<daemon home>/tmp`. Unset = none is made. */
  privateTmpRoot?: string;
  /**
   * The machine's heavy-process slots (`ops-kit heavy`, the kit's README "Heavy-process slots"): added to a Codex task's scope
   * at start so that its sandbox can take a slot like every other process. Unset = not added.
   */
  heavyStateDir?: string;
  /** Where the Tasks' `ops-kit wait` commands leave their records (waits.ts); a sandboxed runner is let write there. Unset = not added. */
  waitsDir?: string;
  /** Refuse a Local turn while an interactive Terminal owns its working directory. */
  beforeResume?: (task: Task) => void;
  /**
   * Asked before every follow-up turn of a Task, after the checks of whose Task it is: `person` = a reply asked for
   * the turn, `daemon` = the daemon starts it by itself (a planned resume, a wait that was met). Throws to refuse the
   * turn; nothing of it is recorded or moved then. (The PBI's lease, where two machines share work: server/lease.ts.)
   */
  turnGate?: (task: Task, by: "person" | "daemon") => Promise<void>;
  /** Keep a finished runner process around this long for quick follow-ups. 0 releases immediately. */
  idleMs?: number;
  /**
   * The router. The suggestion is recomputed here at creation time (never taken from the client) so the decision
   * log cannot be poisoned and always matches the prompt that was actually submitted.
   */
  suggest?: (input: NewTaskInput, scope: string[]) => RoutingSuggestion | undefined;
  /**
   * Knowledge approval rules. "allow" answers the ask at once (recorded as by: rule); "ask" leaves it to the
   * user, optionally with the confirm rule that matched so the UI can show why. Absent = ask every time.
   */
  approval?: (task: Task, ask: Extract<AgentEvent, { t: "permission.ask" }>) => { decision: "ask" | "allow"; match?: ApprovalRuleMatch };
  /** Price table: usage without a reported cost is priced from it; billing decides what counts as 実課金. */
  pricing?: () => PricingTable;
  /** The login the Task's runner is on now (where the bill of its usage goes); undefined = not known, the price table's `billing` decides. */
  loginKind?: (task: Task) => LoginKind | undefined;
  /** Saved Amazon Bedrock region of the runner; undefined = the runner's own login. Not for cloud runs. */
  bedrock?: (task: Task) => { region: string } | undefined;
  /** Saved per-runner default permission mode; undefined = the adapter's own default. */
  defaultPermissionMode?: (runner: RunnerId) => string | undefined;
  /** Saved subagent thinking effort of the runner (setting `subagentEffort`); undefined = same as the task. Fixed on a local Task when it is created. */
  subagentEffort?: (runner: RunnerId) => string | undefined;
  /** Saved subagent model of the runner (setting `subagentModel`); undefined = same as the task. Fixed on a local Task when it is created. */
  subagentModel?: (runner: RunnerId) => string | undefined;
  /** Saved model and thinking effort of the runner (settings `defaultModel` / `defaultEffort`), used when a local Task is created without them. */
  runnerDefaults?: (runner: RunnerId) => { model?: string; effort?: string };
  /** Saved shadow runner, used when a creation does not say; null / undefined = no shadow by default. */
  defaultShadowRunner?: () => RunnerId | null | undefined;
  /** Settings `quotaAndResume.fableBudgetUsd`: the budget a Fable Task gets when it has none. Unset / null = none. */
  defaultFableBudget?: () => number | null;
  /** Files attached to turns. Absent = `attachmentIds` are refused. */
  attachments?: AttachmentStore;
  /** The artifacts store: where an agent's `switchboard-artifact` fence registers a report. Unset = fences are read and refused. */
  artifacts?: ArtifactStore;
  /** Where the kit's `device-auth` sends a Task's approval wait: added to the runner's environment. */
  deviceAuthEnv?: (taskId: string) => Record<string, string>;
  /** Where a Task's runner sends its OpenTelemetry logs (docs/design/claude-otel.md): the daemon's loopback port and the Task's token. */
  otelFor?: (taskId: string) => { endpoint: string; token: string } | undefined;
  /** Settings `outbound.runnerTelemetry`: true = the runner CLI's own telemetry is not stopped. */
  runnerTelemetry?: () => boolean;
  /** What the kit's `docker` front reads: the label for the task's containers and the file its compose projects are written to. */
  dockerEnv?: (taskId: string) => Record<string, string>;
  /** The review setting (`settings.reviewRunner`): the skills placed at a start or resume are rendered with it. Absent = "other". */
  reviewRunner?: () => "other" | "same";
  /** The recheck and post-merge audit setting: rendered into the skills and passed as `OPS_KIT_RECHECK_RUNNER`. Absent = the review setting's value. */
  recheckRunner?: () => "other" | "same";
  /** How many daemon stops in a row a turn is resumed after (`quotaAndResume.maxStopResumes`). Absent = `MAX_STOP_RESUMES`. */
  maxStopResumes?: () => number;
  /** The MCP servers a Task's runner gets (`mcp.yaml` `servers`). Absent = none. */
  mcpServers?: (task: Task) => Record<string, McpServerConfig> | undefined;
  /** How many local Tasks may run or wait for an answer at once (`settings.maxRunners`). Absent = no limit. */
  maxRunners?: () => number;
  /** The machine's free memory (MemAvailable), the floor of `ops-kit heavy` and the safety valve `taskMinFreeMb`: free < safety holds a new start back; safety <= free < floor only warns. null / absent = judged by the count alone. */
  memoryHeadroom?: () => { free: number; floor: number; safety: number } | null;
  /**
   * A reason not to start anything new while the daemon waits to be replaced (null = no hold). While it returns a value, a new
   * Task and a new turn (a reply to a Task with no process, or to one whose turn has ended) wait in the queue instead of
   * starting; a turn already running is not touched. The caller tells the queue when the hold ends (`resumeAdmission`).
   */
  admissionHold?: () => { wait: string; detail: string } | null;
  /**
   * true = never start the waiting Tasks: a candidate daemon (`SWITCHBOARD_CANDIDATE`) runs on a copy of the database,
   * whose queue is the live daemon's; starting it there would run those Tasks twice, with their real runner sessions.
   */
  holdQueue?: boolean;
  /**
   * true = this daemon is a work machine (machine.ts): it gives no Task a turn of its own (`send` with `daemon`), and
   * its Tasks' sessions are told the forge is read only (`FORGE_READ_ONLY_ENV`).
   */
  workMachine?: boolean;
  /** How often a waiting queue is looked at again while no Task leaves running / waiting (ms, default 30 000). Only a queue that is not empty costs anything. */
  drainTickMs?: number;
}

/**
 * The managers whose queue timer is armed, kept on `globalThis` under a well-known symbol (a test run evaluates this
 * module once per test file, and the one who looks is the test preload, scripts/test-preload.ts, which imports
 * nothing from here): a test that closes its database without stopping the manager leaves a timer that writes
 * `queue tick failed` into the console of the tests after it.
 */
export const ARMED_QUEUES_KEY = Symbol.for("switchboard.armed-queue-timers");
const ARMED_QUEUES: Set<{ stopQueue(): void }> = ((globalThis as unknown as Record<symbol, Set<{ stopQueue(): void }> | undefined>)[ARMED_QUEUES_KEY] ??= new Set());

/**
 * For tests: stops the queue timer of every manager still armed in this process and returns how many there were. A test file that
 * makes managers without shutting each down calls it in its `afterEach` (the timer would tick on the file's closed database).
 */
export function stopArmedQueues(): number {
  const left = [...ARMED_QUEUES];
  for (const q of left) q.stopQueue();
  return left.length;
}

/**
 * What every part of the TaskManager shares: the constructor's options, the live sessions, the listeners, and the
 * checks that read them without changing a Task. The parts are a chain of classes (state → events → sessions →
 * admission → sending → settings → `TaskManager`), each in its own file; a part reads the ones before it, and what it
 * reads from a later one is declared `abstract` here or where it is first read.
 */
export abstract class TaskManagerState {
  abstract drain(): void;

  protected live = new Map<string, LiveSession>();
  /** Sessions whose process is being released/aborted; a new turn must wait for them so one session id never has two processes. */
  protected closing = new Map<string, Promise<void>>();

  protected beforeResume: TaskManagerOptions["beforeResume"];
  protected turnGate: TaskManagerOptions["turnGate"];
  protected originOf: TaskManagerOptions["originOf"];
  protected runnerForks: TaskManagerOptions["runnerForks"];
  protected idleMs: number;
  protected suggest: TaskManagerOptions["suggest"];
  protected approval: TaskManagerOptions["approval"];
  protected pricing: TaskManagerOptions["pricing"];
  protected loginKind: TaskManagerOptions["loginKind"];
  private defaultPermissionMode: TaskManagerOptions["defaultPermissionMode"];
  protected subagentEffort: TaskManagerOptions["subagentEffort"];
  protected subagentModel: TaskManagerOptions["subagentModel"];
  protected runnerDefaults: TaskManagerOptions["runnerDefaults"];
  protected defaultShadowRunner: TaskManagerOptions["defaultShadowRunner"];
  protected defaultFableBudget: TaskManagerOptions["defaultFableBudget"];
  protected attachments: TaskManagerOptions["attachments"];
  protected artifacts: TaskManagerOptions["artifacts"];
  protected privateTmpRoot: string | undefined;
  protected heavyStateDir: string | undefined;
  protected waitsDir: string | undefined;
  protected deviceAuthEnv: TaskManagerOptions["deviceAuthEnv"];
  protected otelFor: TaskManagerOptions["otelFor"];
  protected runnerTelemetry: TaskManagerOptions["runnerTelemetry"];
  protected dockerEnv: TaskManagerOptions["dockerEnv"];
  protected maxStopResumes: () => number;
  protected reviewRunner: TaskManagerOptions["reviewRunner"];
  protected recheckRunner: TaskManagerOptions["recheckRunner"];
  protected mcpServers: TaskManagerOptions["mcpServers"];
  protected bedrock: TaskManagerOptions["bedrock"];
  protected maxRunners: () => number;
  protected memoryHeadroom: TaskManagerOptions["memoryHeadroom"];
  protected admissionHold: TaskManagerOptions["admissionHold"];
  protected holdQueue: boolean;
  protected workMachine: boolean;
  protected draining = false;
  protected stopped = false;
  private drainTimer: ReturnType<typeof setInterval> | undefined;

  protected endListeners = new Set<(taskId: string, task: Task) => void>();
  private backgroundEmptyListeners = new Set<(taskId: string, lost: boolean) => void>();
  protected turnEndListeners = new Set<(taskId: string, task: Task, turn: TurnEnd) => void>();
  /** Told whenever a task's planned resume is forgotten, or a person starts a turn (a plan still being made must be dropped too). */
  protected planForgottenListeners = new Set<(taskId: string) => void>();
  protected queuedStartListeners = new Set<(taskId: string, r: { ok: true } | { ok: false; message: string }, resume: boolean) => void>();
  protected stopRecordedListeners = new Set<(taskId: string, stop: StopRecord, prev: StopRecord | undefined) => void>();

  constructor(
    protected db: Db,
    protected adapters: Map<RunnerId, RunnerAdapter>,
    protected broadcast: (msg: ServerMessage) => void,
    opts: TaskManagerOptions = {},
  ) {
    this.beforeResume = opts.beforeResume;
    this.turnGate = opts.turnGate;
    this.originOf = opts.originOf;
    this.runnerForks = opts.runnerForks;
    this.idleMs = opts.idleMs ?? 10 * 60 * 1000;
    this.suggest = opts.suggest;
    this.approval = opts.approval;
    this.pricing = opts.pricing;
    this.loginKind = opts.loginKind;
    this.defaultPermissionMode = opts.defaultPermissionMode;
    this.subagentEffort = opts.subagentEffort;
    this.subagentModel = opts.subagentModel;
    this.runnerDefaults = opts.runnerDefaults;
    this.defaultShadowRunner = opts.defaultShadowRunner;
    this.defaultFableBudget = opts.defaultFableBudget;
    this.attachments = opts.attachments;
    this.artifacts = opts.artifacts;
    this.privateTmpRoot = opts.privateTmpRoot;
    this.heavyStateDir = opts.heavyStateDir;
    this.waitsDir = opts.waitsDir;
    this.deviceAuthEnv = opts.deviceAuthEnv;
    this.otelFor = opts.otelFor;
    this.runnerTelemetry = opts.runnerTelemetry;
    this.dockerEnv = opts.dockerEnv;
    this.maxStopResumes = opts.maxStopResumes ?? (() => MAX_STOP_RESUMES);
    this.reviewRunner = opts.reviewRunner;
    this.recheckRunner = opts.recheckRunner;
    this.mcpServers = opts.mcpServers;
    this.bedrock = opts.bedrock;
    this.maxRunners = opts.maxRunners ?? (() => Infinity);
    this.memoryHeadroom = opts.memoryHeadroom;
    this.admissionHold = opts.admissionHold;
    this.holdQueue = opts.holdQueue ?? false;
    this.workMachine = opts.workMachine ?? false;
    if (!this.holdQueue) {
      // a throw here would be uncaught and stop the daemon (main.ts); a failed look is retried at the next tick
      this.drainTimer = setInterval(() => {
        try {
          this.drain();
        } catch (e) {
          console.error("[tasks] queue tick failed:", e instanceof Error ? e.message : e);
        }
      }, opts.drainTickMs ?? 30_000);
      this.drainTimer.unref();
      ARMED_QUEUES.add(this);
    }
  }

  /** Stops the queue's timer (`shutdown` calls it). A manager whose database is closed without it keeps ticking on the closed database. */
  stopQueue(): void {
    clearInterval(this.drainTimer);
    this.drainTimer = undefined;
    ARMED_QUEUES.delete(this);
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

  /** Why `effort` cannot be used with `runner` (undefined = fine): the same closed list as permission modes. */
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
   * The settings' Fable budget for a local Task without a budget whose model has just become Fable (`before` was
   * not Fable); null = nothing to add. Only the change to Fable adds it, so a budget the user removed later stays removed.
   */
  protected fableBudgetFor(task: Task, before: string | null | undefined): number | null {
    const budget = this.defaultFableBudget?.() ?? null;
    if (budget === null || task.executionMode === "cloud" || task.budgetUsd !== null || isFableModel(before) || !isFableModel(task.model)) return null;
    return budget;
  }

  /** Called when a task's planned resume is forgotten (setResumeAt null — a reply, 中断, a cancel) or a person starts a turn. */
  onPlanForgotten(l: (taskId: string) => void): () => void {
    this.planForgottenListeners.add(l);
    return () => this.planForgottenListeners.delete(l);
  }

  /** Called when drain() started a Task that waited for a run slot: how the start went, and whether every turn in the wait was automatic (`resume`). */
  onQueuedStart(l: (taskId: string, r: { ok: true } | { ok: false; message: string }, resume: boolean) => void): () => void {
    this.queuedStartListeners.add(l);
    return () => this.queuedStartListeners.delete(l);
  }

  /**
   * Called with every stop the runner reported and the record of the same id before it (from the DB, so it holds
   * across a daemon restart). A repeat of the same report comes too, as `stop === prev` (a resumed turn reports the same
   * stop again).
   */
  onStopRecorded(l: (taskId: string, stop: StopRecord, prev: StopRecord | undefined) => void): () => void {
    this.stopRecordedListeners.add(l);
    return () => this.stopRecordedListeners.delete(l);
  }

  /**
   * Called when the last background job of a task is gone (its count went from some to 0). `lost` = they did not end
   * but went with the runner process (it exited, or was closed on purpose).
   */
  onBackgroundEmpty(l: (taskId: string, lost: boolean) => void): () => void {
    this.backgroundEmptyListeners.add(l);
    return () => this.backgroundEmptyListeners.delete(l);
  }

  protected notifyBackgroundEmpty(taskId: string, lost = false) {
    // one listener's failure must not skip the others
    for (const l of this.backgroundEmptyListeners) {
      try {
        l(taskId, lost);
      } catch (e) {
        console.error(`task ${taskId}: background-empty listener failed:`, e);
      }
    }
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

  /** This task's stop `reportId` as last recorded; undefined when it never stopped so. */
  stopOf(taskId: string, reportId: string): StopRecord | undefined {
    return this.db.listStopRecords([taskId]).filter((r) => r.id === `${taskId}/${reportId}`).at(-1);
  }

  availableRunners(): RunnerId[] {
    return [...this.adapters.keys()];
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

  /** A foreign repository's runner config nobody confirmed, for a Task that would read it; null = none. */
  protected unconfirmedRunnerConfig(at: { workspaceId?: string | null; cwd: string }): RunnerConfigUnconfirmed | null {
    const ws = foreignWorkspaceOf(this.db.listWorkspaces(), at).find((w) => runnerConfigOf(w.path).hash !== this.db.getRunnerConfigOk(w.id));
    return ws ? new RunnerConfigUnconfirmed(ws.name) : null;
  }

  /** Move the uploads under the task (the store refuses unknown / already-sent ids as a whole). */
  protected takeAttachments(ids: string[] | undefined, taskId: string): Attachment[] {
    if (!ids?.length) return [];
    if (!this.attachments) throw new Error("attachments are not enabled on this daemon");
    return this.attachments.attach(ids, taskId);
  }

  protected attachmentDir(taskId: string): string {
    if (!this.attachments) throw new Error("attachments are not enabled on this daemon");
    return this.attachments.taskDir(taskId);
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

  /**
   * The insights schedule's Task sends `/insights` and nothing else: Claude Code expands a built-in slash command
   * only when it is the whole user message, so nothing goes in front of it (no recap, no stop report) or after it
   * (no workspace rules).
   */
  protected isBareCommand(scheduleId: string | null | undefined): boolean {
    return !!scheduleId && this.db.getSchedule(scheduleId)?.action === "insights";
  }

  /**
   * The one check of "may this daemon run, resume, answer, stop or change how this Task runs": not a Task whose record
   * came from another machine (OtherMachineError; machine.ts), not a Cloud Task. Every method that does one of those
   * calls it first, so a caller that forgot its own check is still refused.
   */
  protected requireLocal(task: Task) {
    requireOwn(task);
    if (task.executionMode === "cloud") throw new Error("Cloud の続行・再開・設定変更は公式 Web で操作してください。");
  }

  /** `requireLocal` without the Cloud rule: what is refused for another machine's Task and allowed for a Cloud one (a stop, a note). */
  protected requireOwn(task: Task) {
    requireOwn(task);
  }

  /** Whether the Task is another machine's: a note meant for its transcript is not written (its events are that machine's, in its own order). */
  protected isElsewhere(taskId: string): boolean {
    return otherMachineOf(this.db.getTask(taskId)) !== null;
  }

  protected disarmIdle(live: LiveSession) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = undefined;
  }

  /** When each attached runner last gave an event (or was last sent a turn), by Task. */
  lastEvents(): Map<string, number> {
    return new Map([...this.live].map(([id, l]) => [id, l.lastEventAt]));
  }

  /** The hook each attached runner runs now (from its heartbeats), by Task. */
  lastHooks(): Map<string, { name: string; since: number; beatAt: number }> {
    const m = new Map<string, { name: string; since: number; beatAt: number }>();
    for (const [id, l] of this.live) if (l.hook) m.set(id, l.hook);
    return m;
  }

  protected mustGet(taskId: string): Task {
    const t = this.db.getTask(taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    return t;
  }
}
