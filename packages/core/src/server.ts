import { cleanupContainers, LABEL_KEY } from "./containers.ts";
import { stopEndedTasksProcesses, stopTaskProcesses } from "./detached.ts";
import { readCloudPreparation, cloudTransferNotice, prepareTeleportWorktree } from "./claude-cloud.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { AskAnswerInput, AutoStartKind, BacklogAnswerInput, BacklogCommentInput, BacklogCreateInput, BacklogEditInput, BacklogStartInput, BacklogSyncInput, ClientMessage, CreateTaskInput, FeedbackInput, HumanEvalInput, InboxAddInput, InboxPromoteInput, MaterializeApplyInput, PerfSamplesInput, PermissionAnswers, PROTOCOL_VERSION, RunnerId, PresetExpandInput, PresetInput, ScheduleInput, SendTaskInput, SetArchivedInput, SetOutcomeInput, Settings, PolicyPatch, SettingsPatch, SuggestInput, type AgentEvent, type AnswerPolicy, type Ask, type AskAnswer, type AskAnswerResult, type AskChanged, type AskList, type Backlog, BacklogAction, type BacklogItem, type PolicyInput, type PolicySubject, type PolicyList, type Preset, type PresetList, type Task, type TaskEvals, type TeleportProgress, type LlmRoutingSettings, type PricingTable, type RoutingLogRow, type RoutingSuggestion, type RunnerAdapter, type RunnerInfo, type ServerMessage, type Workspace } from "@switchboard/protocol";
import type { CoreConfig } from "./config.ts";
import { abortOrphanedTasks, Db, type ApiRequestRow } from "./db.ts";
import { opsLatency } from "./ops-latency.ts";
import { OpsLoadSampler, opsLoad, readCgroup } from "./ops-load.ts";
import { type CleanExit, daemonVersion, endDaemonRun, opsStops, readBootId, readJournal, readReleaseHistory, startDaemonRun } from "./ops-stops.ts";
import { ArtifactError, ArtifactStore, artifactMime, checkViewKey, withCharset, VIEW_KEY_MS, viewKey } from "./artifacts.ts";
import { AttachmentError, AttachmentStore, extValue, formatBytes, isActiveContent, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_REQUEST } from "./attachments.ts";
import { MAX_PTY_SESSIONS, type PtyAttached, type PtyClient, PtyClientMessage, PtyManager } from "./pty.ts";
import { accessLine, authKind, opLine } from "./accesslog.ts";
import { addressKey, EDGE_HEADER, edgeOk, hostAllowed, isLoopback, isLoopbackAddress, LOOPBACK_HOSTNAMES, loadOrCreateToken, makeFailureLimit, makeSessionCheck, recentOk, sameOrigin, SESSION_COOKIE, SESSION_RECHECK_MS, tokenEquals, tokenFromRequest } from "./auth.ts";
import { buildFeedbackPrompt, buildFixPrompt, feedbackTitle, fixTitle } from "./feedback.ts";
import { measureFootprint } from "./footprint.ts";
import { loadMcpPolicy, mcpServersFor, WorkspaceMcp } from "./mcp.ts";
import { ApprovalRules, subjectsOf } from "./approval.ts";
import { workspaceBrief } from "./brief.ts";
import { judgeTurn } from "./judge.ts";
import { evalRequestDraft, RULES_BY, rulesEvalOf } from "./evals.ts";
import { judgeRubric } from "./rubric-judge.ts";
import { loadRubric } from "./rubric.ts";
import { ledgerRowFor, loadPricing } from "./pricing.ts";
import { checksEnabledByDefault, isSupervised, RESTART_EXIT_CODE, restartArgv, SelfDev, spawnDetached } from "./selfdev.ts";
import { isAuthText, LOGIN_FORCED_RECHECK_MS, LOGIN_RECHECK_MS } from "./login.ts";
import { fallbackNote, fallbackRunner, fmtTime, RateLimitResumer } from "./ratelimit.ts";
import { type BacklogNextResult, Scheduler } from "./scheduler.ts";
import { BacklogSync, noticeTargets, type StoredBacklog } from "./backlog-sync.ts";
import { scanAllRepos } from "./secretscan.ts";
import { setupScripts } from "./skillsync.ts";
import { Staging } from "./staging.ts";
import { collectTaskDiff } from "./taskdiff.ts";
import { parseCron } from "./cron.ts";
import { FlowCache, flowScope, flowView, type FlowWorkspace } from "./flow.ts";
import { interventionView } from "./interventions.ts";
import { checkLocalFields, checkLocalParent } from "./backlog-local.ts";
import { ACTION_FOR_STAGE, localBacklogSource, answerStoredConfirmation, answerStoredDecision, awaitingReply, BacklogEditError, holdStoredDecision, BacklogError, createStoredIssue, editStoredIssue, resolveStoredConflict, buildStartPrompt, failedIn, failedSince, latestTag, pickNext, replyWaitingIn, readStoredIssue, readStoredRecords, workspaceSyncOf, canStartStoredBacklog, commentStoredIssue, overlapIn, promotionStep, QUOTA_FULL, GithubBudgetCache, reportPromoteFailure, type ReleaseState, repoOf, runGh, SLOT_OF_ACTION, type Slot, spinningIn, startTitle, unchangedIn, heldIn, type GhRunner, type OtherRepo } from "./backlog.ts";
import { issueOf, reduceStops, stopRecordsFor } from "./stops.ts";
import { ASK_HISTORY_MS, asksFromBacklog, asksFromTasks, blockersOf, dedupeAsks, policyPbi, prFacts, resumeOfTask, type PolicyEnv, type PrFacts } from "./asks.ts";
import { checkPolicy, matchPolicies, readPolicies, recordUse, subjectChanges, writePolicies } from "./policies.ts";
import { checkPreset, expandPreset, needsTarget, parseTarget, readPresets, writePresets } from "./presets.ts";
import { Inbox } from "./inbox.ts";
import { KnowledgeStore } from "./knowledge.ts";
import * as materializer from "./materializer.ts";
import { CompositeSuggester, loadRoutingTable, RuleSuggester, suggestRunner, type RoutingContext, type Suggester } from "./routing.ts";
import { DEFAULT_EXAMPLE_COUNT, LlmSuggester, readOnlyMode } from "./suggest-llm.ts";
import { WorkspaceSuggester } from "./suggest-workspace.ts";
import { privateTmpOf, sweepPrivateTmps, TaskManager } from "./tasks.ts";
import { HistoryImporter } from "./history.ts";
import { HostIdle, nextWakeFrom } from "./hostidle.ts";
import { RunnerLogins } from "./runnerlogin.ts";
import { DeviceAuths, type DeviceAuthInput } from "./deviceauth.ts";
import { archiveProblem } from "./archive-status.ts";

// Web UI policy: docs/design/web-csp.md.
const WEB_HEADERS = {
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

export interface CoreServer {
  server: ReturnType<typeof Bun.serve>;
  tasks: TaskManager;
  db: Db;
  /** Registered reports (#1777). */
  artifacts: ArtifactStore;
  knowledge: KnowledgeStore;
  mcp: WorkspaceMcp;
  selfdev: SelfDev;
  /** Terminal Claude Code sessions read from ~/.claude/projects (#91). */
  history: HistoryImporter;
  /** Local API token (only enforced when not listening on loopback). */
  token: string;
  /** Terminal tab (#16); null when no PTY can be opened here. */
  pty: PtyManager | null;
  stop(): Promise<void>;
}

const TOPIC = "events";
/** How often the buffered API requests are written to api_requests (#2101). */
const API_REQUESTS_FLUSH_MS = 10_000;
/** undefined = the event socket (/ws); otherwise a terminal socket (/ws/pty) and the task whose shell it shows. */
/** A terminal socket carries its task; either kind carries the login cookie it was let in by, to be checked again (#708). */
type WsData = { ptyTask: string; cwd: string; teleport?: boolean; shell?: string; client?: PtyClient; session?: string } | { ptyTask?: undefined; session?: string } | undefined;
type Routes = NonNullable<Parameters<typeof Bun.serve>[0]["routes"]>;

export interface StartServerOptions {
  port?: number;
  selfdevChecks?: boolean;
  /**
   * Import every workspace's backlog at boot, unasked (#885). The daemon
   * (main.ts) does; tests and scripts that boot one do not (they would import the checkout's real repository) — their
   * first look at the backlog imports instead.
   */
  backlogAutoImport?: boolean;
  dryRunRestart?: boolean;
  /**
   * Overrides where LLM routing suggestions come from when `settings.routing.llm.enabled` (#25). Called per task
   * creation with the saved settings, so a changed runner / model takes effect without a restart; null = no LLM
   * suggestion (the rule table alone). Unset = the real one, asking the configured runner through its adapter.
   * `onUsage` reports what the turn cost so it can go in the ledger.
   */
  llmSuggester?: (cfg: LlmRoutingSettings, onUsage: (ev: Extract<AgentEvent, { t: "usage" }>) => void) => Suggester | null;
  /** Overrides how the terminal tab's PTY library is loaded (#16); a test passes one that throws to get features.pty = false. */
  loadPty?: () => Promise<PtyManager | null>;
  /** Overrides how `gh` is run for GET /api/backlog (#264); tests and the E2E answer from a fixture. Unset = `gh` from PATH. */
  gh?: GhRunner;
  /** Overrides where a request came from (#181 edge header); a test makes real sockets on 127.0.0.1 look like another machine. */
  peerAddress?: (req: Request) => string | undefined;
  /** How long a runner login from the screen may stay open (#354); tests shorten it. */
  loginTimeoutMs?: number;
  /** Overrides the judge asked at the end of a turn (#493); tests answer by hand. Unset = `judgeTurn`, the configured runner's own adapter. */
  judge?: typeof judgeTurn;
  /** Overrides the rubric judge (#1219) the same way; tests answer by hand. */
  rubricJudge?: typeof judgeRubric;
  /** How long a Starter answer about a login cookie is kept, and how often open cookie WebSockets are checked again (#708); tests shorten it. Unset = SESSION_RECHECK_MS. */
  sessionRecheckMs?: number;
}

/** GitHub's `sha256=<hex>` signature of the delivery body under the Webhook's Secret; no signature or another length is false. */
function webhookSigned(body: Uint8Array, header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function startServer(cfg: CoreConfig, adapters: RunnerAdapter[], opts: StartServerOptions = {}): Promise<CoreServer> {
  const db = new Db(cfg.dbPath);
  try {
    // only a finished task of this database, with no resume planned (another daemon's, or one that may continue, stays)
    sweepPrivateTmps(join(cfg.home, "tmp"), 3 * 24 * 3600 * 1000, (id) => {
      const t = db.getTask(id);
      return t !== null && t.resumeAt === null && ["done", "error", "aborted"].includes(t.status);
    });
  } catch {
    // the sweep is housekeeping
  }
  seedWorkspaces(db, cfg);
  // The Webhook route is open without the token only with a Secret to verify the deliveries against (#1493)
  const webhookOpen = cfg.githubWebhook && !!cfg.githubWebhookSecret;
  if (cfg.githubWebhook && !cfg.githubWebhookSecret) console.warn("backlog: SWITCHBOARD_GITHUB_WEBHOOK=1 but SWITCHBOARD_GITHUB_WEBHOOK_SECRET is unset: the webhook route stays closed (asks for the token)");

  const adapterMap = new Map<RunnerId, RunnerAdapter>();
  const detected: Array<{ adapter: RunnerAdapter; info: RunnerInfo }> = [];
  for (const a of adapters) {
    const d = await a.detect();
    detected.push({ adapter: a, info: { id: a.id, ...d, permissionModes: a.permissionModes ?? [], models: a.models ?? [], efforts: a.efforts ?? [] } });
    if (d.available) adapterMap.set(a.id, a);
  }
  // Login (#180): the runner's own status command runs again when /api/health is read and its last answer is over a
  // minute old (only the login is taken from it; which runners are available stays as detected at boot). A turn that
  // ended on an auth error marks the runner expired until a later check or a turn that went through says otherwise.
  let loginCheckedAt = Date.now();
  let loginCheck: Promise<void> | null = null;
  const loginExpired = new Set<RunnerId>();
  // `force` = the banner's 再確認 (?recheck=1): the person just logged in and should not wait out the minute. Still at
  // most one run per LOGIN_FORCED_RECHECK_MS, so a page that keeps requesting it cannot keep spawning the runners.
  const refreshLogins = (force = false): Promise<void> => {
    const age = Date.now() - loginCheckedAt;
    if (age < (force ? LOGIN_FORCED_RECHECK_MS : LOGIN_RECHECK_MS)) return Promise.resolve();
    loginCheck ??= Promise.all(
      detected
        .filter((d) => d.info.available && d.info.login !== undefined)
        .map(async (d) => {
          const r = await d.adapter.detect().catch(() => null);
          if (!r?.available || r.login === undefined) return;
          d.info = { ...d.info, login: r.login, loginHint: r.loginHint };
          if (r.login === "ok") loginExpired.delete(d.adapter.id);
        }),
    ).then(() => {
      loginCheckedAt = Date.now();
      loginCheck = null;
    });
    return loginCheck;
  };
  // A runner's login from the screen (#354): the daemon runs the runner's own login command and relays its URL / code.
  // Done → the login is checked again at once, so the banner goes away.
  const runnerLogins = new RunnerLogins(
    (argv) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")) env[k] = v;
      return Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    },
    (runner) => {
      loginExpired.delete(runner);
      // a check already in flight may have started before the login finished: run another one after it
      void (loginCheck ?? Promise.resolve()).then(() => {
        loginCheckedAt = 0;
        return refreshLogins();
      });
    },
    opts.loginTimeoutMs,
  );
  const loginTarget = (id: string) => {
    const d = detected.find((x) => x.adapter.id === id);
    return d && d.info.available && d.info.path && d.adapter.loginArgs ? { runner: d.adapter.id, argv: [d.info.path, ...d.adapter.loginArgs], hosts: d.adapter.loginHosts ?? [] } : null;
  };
  // Settings (#58) live in sqlite so the UI can change them; read on every use so a PATCH takes effect at once.
  const SETTINGS_KEY = "settings";
  const settings = (): Settings => {
    const parsed = Settings.safeParse(db.getSetting(SETTINGS_KEY, {}));
    if (!parsed.success) console.warn(`settings: stored row is malformed (${parsed.error.message}); using defaults`);
    return parsed.success ? parsed.data : Settings.parse({});
  };
  // The defaults of the tunables (#835), so the settings screen can show each item's default without zod at runtime
  const tunableDefaults = () => {
    const d = Settings.parse({});
    return { quotaAndResume: d.quotaAndResume, judgeAndChoice: d.judgeAndChoice, newDefaults: d.newDefaults };
  };
  const savedDefaultMode = (runner: RunnerId) => settings().defaultPermissionMode[runner];
  const savedAutoResume = (runner: RunnerId) => settings().autoResume[runner] === true;
  // Runner list for /api/health: detection is from boot, the effective default mode and auto-resume follow the saved
  // settings, and the models / the CLI's default model (#155) are read each time — the default is the user's own CLI
  // setting and changes there.
  const runnerInfo = (): RunnerInfo[] =>
    detected.map(({ adapter, info }) => {
      const login = info.login !== undefined && loginExpired.has(adapter.id) ? "expired" : info.login;
      const base = { ...info, login, autoResume: savedAutoResume(adapter.id), models: adapter.models ?? [], cliDefaultModel: adapter.cliDefaultModel?.() };
      if (!info.permissionModes.length) return base;
      const saved = savedDefaultMode(adapter.id);
      const valid = saved !== undefined && info.permissionModes.some((m) => m.value === saved);
      return { ...base, defaultPermissionMode: valid ? saved : adapter.defaultPermissionMode };
    });

  // Rule table: the user's ~/.switchboard/routing.yaml wins over the shipped default. Loaded once per boot.
  const routing = loadRoutingTable([join(cfg.home, "routing.yaml"), join(cfg.codeRoot, "packages", "core", "config", "routing.yaml")]);

  // The knowledge folder is optional at boot: an unwritable path or one unreadable file must not stop the daemon.
  const knowledge = new KnowledgeStore(cfg.knowledgeDir, db);
  if (knowledge.disabled) console.warn(`knowledge: folder unavailable (${knowledge.disabled}); Knowledge tab will be empty`);
  try {
    const r = knowledge.scan();
    for (const e of r.errors) console.warn(`knowledge: ${e}`);
  } catch (e) {
    console.warn(`knowledge: initial scan failed: ${String((e as Error).message ?? e)}`);
  }
  for (const w of materializer.scopedWarnings(knowledge)) console.warn(`knowledge: ${w.path}: ${w.message}`);
  knowledge.watch();
  const inbox = new Inbox(knowledge);

  let server!: ReturnType<typeof Bun.serve>;
  const broadcast = (msg: ServerMessage) => server?.publish(TOPIC, JSON.stringify(msg));
  knowledge.onChange(() => broadcast({ type: "knowledge.updated", count: knowledge.list().length }));
  // A Task's approval wait (#662, docs/design/device-auth.md): memory and the WebSocket only, never the DB.
  const deviceAuths = new DeviceAuths((taskId, auth) => broadcast({ type: "task.deviceAuth", taskId, auth }));
  type SuggestCtxInput = { workspaceId?: string; cwd?: string; title: string; prompt: string; scope?: string[]; kind?: string };
  const routingContext = (input: SuggestCtxInput): RoutingContext => {
    const ws = input.workspaceId ? db.getWorkspace(input.workspaceId) : null;
    const cwd = input.cwd ?? ws?.path;
    const scope = Array.from(new Set([cwd, ...(input.scope ?? [])].filter((d): d is string => !!d)));
    return { title: input.title, prompt: input.prompt, scope, kind: input.kind, workspaceKind: ws?.kind, previousRunner: db.lastRunnerFor(ws?.id, cwd), available: new Set(adapterMap.keys()) };
  };
  const suggestFor = (input: SuggestCtxInput) => suggestRunner(routing.table, routingContext(input));
  const ruleSuggester = new RuleSuggester(() => routing.table);
  // Where a suggestion turn runs (#25): an empty directory of its own, never `cfg.home` (the API token and the
  // sqlite file live there) and never a repository. Read-only mode stops writes, not reads, and the text in that
  // prompt — task titles from the Inbox and imported sessions — is not the daemon's to trust.
  const suggestDir = join(cfg.home, "suggest");
  mkdirSync(suggestDir, { recursive: true });
  /**
   * The real LLM suggester: the configured runner's own adapter, one read-only turn in the daemon's data directory
   * (never a repository), the last decisions as training data. A runner that is not detected means no suggestion —
   * the rule table then stands, and the settings PATCH already refuses to enable an uninstalled one.
   */
  const defaultLlmSuggester = (llmCfg: LlmRoutingSettings, onUsage: (ev: Extract<AgentEvent, { t: "usage" }>) => void): Suggester | null => {
    const adapter = adapterMap.get(llmCfg.runner);
    if (!adapter) {
      console.warn(`routing: LLM suggestions are on but runner "${llmCfg.runner}" is not installed; using the rule table`);
      return null;
    }
    // A runner that has permission modes but none we know to be read-only would run the turn in its *default*
    // mode (Claude auto, Codex workspace-write). A suggestion is not worth a runner that may edit anything.
    const ro = readOnlyMode(adapter);
    if (ro.unconstrained && adapter.permissionModes?.length) {
      console.warn(`routing: ${adapter.id} has no read-only permission mode; not asking it for suggestions`);
      return null;
    }
    return new LlmSuggester({ adapter, cwd: suggestDir, model: llmCfg.model, permissionMode: ro.mode, examples: () => db.routingLog(DEFAULT_EXAMPLE_COUNT), onUsage, log: (m) => console.warn(m) });
  };
  /**
   * The suggestion recorded for a new task (#25). With LLM suggestions off — the default — this is exactly the rule
   * table; with them on, the rule table still decides and the LLM's proposal rides along in `llm`, or is dropped if
   * it fails or misses the deadline. Only task creation pays for it: `POST /api/tasks/suggest` (typed into on every
   * keystroke) stays rule-table-only.
   */
  const suggestForCreate = async (input: SuggestCtxInput): Promise<{ suggestion: RoutingSuggestion; usage: Extract<AgentEvent, { t: "usage" }>[]; runner: RunnerId }> => {
    const ctx = routingContext(input);
    const llmCfg = settings().routing.llm;
    // one usage per model the turn used (Claude's `modelUsage`, #2353)
    const usage: Extract<AgentEvent, { t: "usage" }>[] = [];
    const factory = opts.llmSuggester ?? defaultLlmSuggester;
    const primary = llmCfg.enabled ? factory(llmCfg, (u) => usage.push(u)) : null;
    if (!primary) return { suggestion: suggestRunner(routing.table, ctx), usage, runner: llmCfg.runner };
    // The deadline is the composite's own; nothing above it gives up early (the task is created either way), so the
    // outer signal is a controller that is never aborted.
    const suggestion = await new CompositeSuggester(primary, ruleSuggester, llmCfg.timeoutMs, (m) => console.warn(m)).suggest(ctx, new AbortController().signal);
    return { suggestion, usage, runner: llmCfg.runner };
  };
  /** Thrown by `chooseWorkspace`: the 409 body. Never a silent default — that would read as "the daemon chose this". */
  const pickYourself = (why: string) => new Error(`Workspace を選んでください（${why}）`);
  /**
   * "自動" (#135): `POST /api/tasks` without cwd and workspaceId. One read-only turn of the routing runner
   * (`routing.llm` runner / model; `enabled` is not consulted — leaving the select on 自動 is the instruction,
   * `enabled` is the switch for runner suggestions) picks among the registered Workspaces.
   */
  const chooseWorkspace = async (input: { title: string; prompt: string }): Promise<{ workspace: Workspace; reason: string; usage: Extract<AgentEvent, { t: "usage" }>[]; runner: RunnerId }> => {
    const llmCfg = settings().routing.llm;
    const workspaces = db.listWorkspaces().filter((ws) => existsSync(ws.path));
    if (workspaces.length === 0) throw pickYourself("登録済みの Workspace がありません");
    const adapter = adapterMap.get(llmCfg.runner);
    if (!adapter) throw pickYourself(`自動選択に使うランナー ${llmCfg.runner} が未検出`);
    const ro = readOnlyMode(adapter);
    if (ro.unconstrained && adapter.permissionModes?.length) throw pickYourself(`${adapter.id} に読み取り専用モードがありません`);
    const usage: Extract<AgentEvent, { t: "usage" }>[] = [];
    const suggester = new WorkspaceSuggester({ adapter, cwd: suggestDir, model: llmCfg.model, permissionMode: ro.mode, onUsage: (u) => usage.push(u), log: (m) => console.warn(m) });
    const hangMs = settings().judgeAndChoice.workspaceChoiceTimeoutMs;
    const deadline = AbortSignal.timeout(hangMs);
    try {
      const choice = await suggester.suggest({ title: input.title, prompt: input.prompt, workspaces }, deadline);
      return { workspace: workspaces.find((ws) => ws.id === choice.workspaceId)!, reason: choice.reason, usage, runner: llmCfg.runner };
    } catch (e) {
      // No task exists to bill a failed turn to (ledger rows belong to a task), so what it spent is at least logged.
      console.warn(`workspace: ${llmCfg.runner} could not choose (${String((e as Error).message ?? e)})${usage.length ? `; the turn reported ${JSON.stringify(usage)}` : ""}`);
      throw pickYourself(deadline.aborted ? `${llmCfg.runner} が ${hangMs / 1000} 秒以内に答えませんでした` : `${llmCfg.runner} が選べませんでした: ${String((e as Error).message ?? e).slice(0, 160)}`);
    }
  };
  const approval = new ApprovalRules(knowledge, (task) => (task.workspaceId ? db.getWorkspace(task.workspaceId) : null), (id) => db.getWorkspace(id), () => ({ list: readPolicies(db), pbiOpen: (wsId, n) => { const ws = wsId ? db.getWorkspace(wsId) : null; return !!ws && storedBacklog(ws).items.some((i) => i.number === n); } }));
  const pricing = loadPricing([join(cfg.home, "pricing.json"), join(cfg.codeRoot, "packages", "core", "config", "pricing.json")]);
  // The settings screen's price rows (#1402) over the file's table, read on every use so a PATCH prices the next usage
  const pricingTable = (): PricingTable => ({ ...pricing.table, models: { ...pricing.table.models, ...settings().prices } });
  // Attachments (#125): uploads wait in <home>/attachments/inbox until a turn sends them; a day-old leftover is swept at boot.
  const attachments = new AttachmentStore(db, cfg.attachmentsDir);
  const swept = attachments.sweep();
  if (swept) console.log(`attachments: removed ${swept} upload(s) that were never sent`);
  // Artifacts (#1777): reports registered on the Task screen, copied under <home>/artifacts; a removed one is deleted a day later.
  const artifacts = new ArtifactStore(db, cfg.artifactsDir, { privateTmp: (taskId) => privateTmpOf(join(cfg.home, "tmp"), taskId), deny: [cfg.tokenPath, cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`], tmpRoots: [tmpdir()] });
  const sweptArtifacts = artifacts.sweep();
  if (sweptArtifacts) console.log(`artifacts: removed ${sweptArtifacts} registered report(s) removed a day ago`);
  const teleportCwds = new Set<string>();
  const teleportCwd = (cwd: string) => { try { return realpathSync(cwd); } catch { return resolve(cwd); } };
  // "Continue locally" (#1306): memory only, like deviceAuths. Started by POST /api/tasks/:id/teleport, not by a terminal socket.
  const teleports = new Map<string, TeleportProgress>();
  const setTeleport = (taskId: string, p: TeleportProgress) => {
    const was = teleports.get(taskId);
    if (was && was.phase === p.phase && was.question === p.question && was.message === p.message) return; // the same state again (a start, then the CLI's own first report)
    teleports.set(taskId, p); broadcast({ type: "task.teleport", taskId, progress: p }); };
  /** null = started; a string = why it was refused. */
  const startTeleport = (taskId: string): string | null => {
    const task = db.getTask(taskId);
    const bin = detected.find(d => d.adapter.id === "claude")?.info.path;
    if (!pty || !task || task.runner !== "claude" || task.executionMode !== "cloud" || !task.cloudSession || tasks.isLive(task.id) || !existsSync(task.cwd) || !bin) {
      return "Cloudセッション・停止済みlauncher・cwd・Claude CLIを確認してください。";
    }
    // The continuation runs in its own worktree (#1395): reservation, release and the busy check are about that
    // directory only, so a Local Task at work in the clone is neither stopped nor refused.
    let work: string;
    try { work = prepareTeleportWorktree(task.cwd, task.id); } catch (e) { return String((e as Error).message ?? e); }
    const cwd = teleportCwd(work);
    if (teleportCwds.has(cwd)) return "同じcwdのTeleport Terminalが使用中です。終了後に開始してください。";
    // Only a turn in flight blocks: a finished Local Task's process idles for the next reply (idleMs) or is already
    // closing; Teleport starts once every one of them has exited. An archived one (#1142) can still hold its process.
    const held = [...db.listTasks(), ...db.listTasks(true)].filter(t => t.executionMode === "local" && t.runner === "claude" && teleportCwd(t.cwd) === cwd && tasks.holdsProcess(t.id));
    const busy = held.find(t => t.status === "running" || t.status === "waiting");
    if (busy) return `この Cloud Task の続きの Local Task「${busy.title.replace(/[\x00-\x1f\x7f]/g, " ")}」が作業中です。終わってから押してください。`;
    const cloudId = task.cloudSession.id;
    teleportCwds.add(cwd); // reserved first: beforeResume refuses replies to the held Tasks while they are released
    tasks.record(task.id, { t: "status", text: `作業コピー ${work} で続けます。元の clone は変更しません。` });
    setTeleport(task.id, { phase: "teleporting" });
    pty.prepareTeleport(task.id);
    void Promise.all(held.map(t => tasks.releaseAndWait(t.id))).then(() => pty.startTeleport(task.id, work, bin, cloudId, async result => {
      setTeleport(task.id, { phase: "importing" });
      try {
        if (result.localSessionId) {
          const local = await history.importTeleportedSession(task.id, result.localSessionId, work);
          result.message = "Local Taskへの取込みを確認しました。Cloudへ自動同期しません。";
          tasks.record(task.id, { t: "status", text: result.message });
          setTeleport(task.id, { phase: "done", message: result.message, localTaskId: local.id });
        } else {
          tasks.record(task.id, { t: "status", text: result.message });
          setTeleport(task.id, { phase: "unconfirmed", message: result.message });
        }
      } catch {
        const message = "Local履歴は未確認です。元Cloud Taskを保持しました。公式TerminalとGit状態を確認してください。自動再試行はしません。";
        result.message = message;
        tasks.record(task.id, { t: "status", text: message });
        setTeleport(task.id, { phase: "unconfirmed", message });
      } finally { teleportCwds.delete(cwd); }
    }, p => setTeleport(task.id, p))).catch(e => {
      teleportCwds.delete(cwd);
      setTeleport(task.id, { phase: "unconfirmed", message: String((e as Error).message ?? e) });
    });
    return null;
  };
  // The compose projects each task started (the kit's `docker` front writes them; #1418)
  const dockerLogDir = join(cfg.home, "docker");
  mkdirSync(dockerLogDir, { recursive: true });
  const mcpPolicy = loadMcpPolicy([join(cfg.home, "mcp.yaml"), join(cfg.codeRoot, "packages", "core", "config", "mcp.yaml")]);
  // what a Task's Claude reads instead of the user-wide MCP servers (#2090): mcp.yaml `servers`, for its Workspace
  const taskMcpServers = (t: Task) => mcpServersFor(mcpPolicy, t.workspaceId ? (db.getWorkspace(t.workspaceId)?.name ?? null) : null);
  // a Task on a workspace whose backlog is kept here only (#2265): the kit's `backlog` picks it by id, not by a GitHub repository
  const localBacklogEnv = (id: string): Record<string, string> => {
    const wsId = db.getTask(id)?.workspaceId;
    return wsId && db.getWorkspace(wsId)?.backlog === "switchboard" ? { BACKLOG_WORKSPACE: wsId } : {};
  };
  const tasks = new TaskManager(db, adapterMap, broadcast, { artifacts, beforeResume: t => { if (t.runner === "claude" && teleportCwds.has(teleportCwd(t.cwd))) throw new Error("Teleport Terminalが使用中です。終了後にLocal Taskを再開してください。"); }, idleMs: cfg.runnerIdleMs, suggest: (input) => suggestFor(input), approval: (task, ask) => {
      const v = approval.evaluate(task, ask);
      // a saved policy answered it (#938): the use is kept with the policy
      if (v.decision === "allow" && v.match.source.startsWith("policy:")) {
        const id = v.match.source.slice("policy:".length);
        writePolicies(db, recordUse(readPolicies(db), id, { at: Date.now(), askId: `approval:${task.id}:${ask.id}`, taskId: task.id, issue: issueOf(task), subject: { kind: "approval", op: ask.kind, target: v.match.subject, conditions: [], head: null } }));
      }
      return v;
    }, pricing: pricingTable, defaultPermissionMode: savedDefaultMode, defaultShadowRunner: () => settings().shadowRunner, attachments, privateTmpRoot: join(cfg.home, "tmp"), deviceAuthEnv: (id) => ({ DEVICE_AUTH_URL: `${localUrl()}/api/tasks/${id}/device-auth`, DEVICE_AUTH_TOKEN_FILE: cfg.tokenPath, SWITCHBOARD_DAEMON_HOME: cfg.home, BACKLOG_URL: `${localUrl()}/api/backlog`, BACKLOG_TOKEN_FILE: cfg.tokenPath, ...localBacklogEnv(id) }), dockerEnv: (id) => ({ DOCKER_MARK_LABEL: `${LABEL_KEY}=${id}`, DOCKER_MARK_LOG: join(dockerLogDir, `${id}.jsonl`) }), maxStopResumes: () => settings().quotaAndResume.maxStopResumes, mcpServers: taskMcpServers });
  // Terminal sessions (#91): what Claude Code wrote to ~/.claude/projects while nobody in Switchboard was watching.
  const claudeDanger = new Set((adapters.find((a) => a.id === "claude")?.permissionModes ?? []).filter((m) => m.danger).map((m) => m.value));
  const history = new HistoryImporter(db, { projectsDir: cfg.claudeProjectsDir, pollMs: cfg.historyPollMs, pricing: pricingTable, broadcast, isLive: (id) => tasks.isLive(id), dangerModes: claudeDanger, log: (m) => console.warn(m) });

  // Terminal tab (#16): null when no PTY can be opened in this distribution.
  const pty = await (opts.loadPty ?? (() => PtyManager.load()))();

  // Local API token (#31): enforced only off-loopback. Workspace MCP always needs its per-task token.
  const token = loadOrCreateToken(cfg.tokenPath);
  const authRequired = !isLoopback(cfg.host);
  // DNS rebinding (#1135): with no token asked, every route checks the Host names this machine (or the configured public
  // URL, which is what its clients send). Off loopback the token / cookie guards instead and the Host is not looked at.
  const allowedHosts = new Set(LOOPBACK_HOSTNAMES);
  if (cfg.publicUrl && URL.canParse(cfg.publicUrl)) allowedHosts.add(new URL(cfg.publicUrl).hostname);
  else if (cfg.publicUrl) console.warn(`SWITCHBOARD_PUBLIC_URL is not a URL (${cfg.publicUrl}); only loopback names are allowed as Host`);
  const hostOk = (req: Request) => authRequired || hostAllowed(req, allowedHosts);
  // The token, or on the cloud host the login cookie from the starter Lambda (#211) whose passkey the Starter still
  // knows (#708); /mcp keeps its per-task tokens. `session` is the cookie that let it in, for a WebSocket's recheck.
  const sessionCheck = makeSessionCheck({ publicKey: cfg.sessionPublicKey, starterUrl: cfg.starterUrl, edge: cfg.edgeHeaderValue, keepMs: opts.sessionRecheckMs });
  // On the cloud host (the passkey login is on) a token counts only from this machine (#748): the runners' /mcp calls and
  // sb-rescue's probe. From anywhere else — CloudFront's VPC origin included — only the cookie. Judged by the connection's
  // peer, never a header. A Mac (no public key) is unchanged.
  type Peer = { requestIP(r: Request): { address: string } | null } | undefined;
  const peerOf = (req: Request, srv: Peer) => (opts.peerAddress ? opts.peerAddress(req) : srv?.requestIP(req)?.address);
  const tokenCounts = (req: Request, srv: Peer) => {
    if (!cfg.sessionPublicKey) return true;
    const peer = peerOf(req, srv);
    return peer !== undefined && isLoopbackAddress(peer);
  };
  // `fresh`: a WebSocket's upgrade asks the Starter whatever is kept, so the socket's first answer is new and the
  // periodic recheck below ends it within one period.
  const authorize = async (req: Request, srv: Peer, allowQuery = false, fresh = false): Promise<{ ok: boolean; session?: string }> => {
    if (!authRequired || (tokenCounts(req, srv) && tokenEquals(tokenFromRequest(req, allowQuery), token))) return { ok: true };
    const session = await sessionCheck(req, fresh);
    return { ok: session !== undefined, session };
  };
  const authorized = async (req: Request, srv: Peer, allowQuery = false) => (await authorize(req, srv, allowQuery)).ok;
  // The runners are on this machine: the kit's `device-auth` reaches the daemon here, with the token file's contents.
  const localHost = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  const localUrl = () => `http://${localHost}:${server?.port ?? cfg.port}`;
  const publicUrl = () => cfg.publicUrl ?? `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${server?.port ?? cfg.port}`;
  const staging = new Staging(db, (id, ev) => tasks.record(id, ev));
  const mcp = new WorkspaceMcp({ getTask: (id) => db.getTask(id), record: (id, ev) => tasks.record(id, ev), recordStop: (id, r) => tasks.recordStop(id, r), stopOf: (id, r) => tasks.stopOf(id, r), askPermission: (id, ask) => tasks.askPermission(id, ask), staging }, mcpPolicy, publicUrl);
  // The endpoint lives as long as the task's runner process: a follow-up on a "done" task reuses it; abort/error/release end it.
  tasks.onTaskEnd((taskId, task) => {
    void mcp.revoke(taskId);
    deviceAuths.clear(taskId);
    pty?.close(taskId);
    // What the task detached (setsid / nohup) with the daemon's mark in its environment (#1397); a task with a
    // resume planned keeps it, as at the start
    if (task.resumeAt !== null) return;
    // (a `done` task may be resumed with its files: those are swept at the start, sweepPrivateTmps)
    try {
      if (task.status !== "done") rmSync(privateTmpOf(join(cfg.home, "tmp"), taskId), { recursive: true, force: true });
    } catch {
      // what cannot be removed stays; the cleanup below goes on
    }
    // its compose projects and labelled containers, unless another task still open started the same project (#1418)
    void cleanupContainers(taskId, { logDir: dockerLogDir, isOpen: (id) => tasks.isLive(id) || ((t) => t !== null && !["done", "error", "aborted"].includes(t.status))(db.getTask(id)) }).then((r) => {
      if (r) tasks.record(taskId, { t: "status", text: "skipped" in r ? `コンテナの片付けを飛ばしました（${r.skipped}）` : `コンテナを片付けました（プロジェクト ${r.projects.length} 件、コンテナ ${r.containers} 件${r.failed > 0 ? `、失敗 ${r.failed} 件` : ""}）` });
    }).catch(() => undefined);
    void stopTaskProcesses(taskId, { home: cfg.home }).then((n) => {
      if (n > 0) tasks.record(taskId, { t: "status", text: `切り離されたプロセスを ${n} 件止めました` });
    }).catch(() => undefined);
  });

  // Self-dev (#18): after a turn on the meta workspace finishes successfully, run the repository's checks.
  // Off inside `bun test` and inside a check subprocess (no recursion) unless a test opts in explicitly.
  const checksOn = opts.selfdevChecks ?? checksEnabledByDefault();
  const selfdev = new SelfDev(db, cfg.repoRoot, (taskId, run) => broadcast({ type: "checks.updated", taskId, ok: run.ok }));
  // the backlog is read from what was imported (#885); GitHub is asked by the sync only, and for its budget (#549, below)
  // the candidate runs on a copy of the database: it sends nothing, or what it sent would be sent again (#886)
  const backlog = new BacklogSync(db, opts.gh ?? runGh, undefined, undefined, !cfg.candidate);
  // GitHub's GraphQL budget (#549): read at most once a minute, for backlog-next, the stage buttons and the ledger
  const githubBudget = new GithubBudgetCache(opts.gh ?? runGh, undefined, undefined, undefined, () => backlog.hostWait());
  // the flow of the closed PBIs (#651): GitHub is read for it, so an hour is held; the repository is the import's, as for the backlog
  const flowWorkspaces = (): FlowWorkspace[] => db.listWorkspaces().map((w) => ({ id: w.id, name: w.name, path: w.path, repository: db.getWorkspaceBacklogSource(w.id)?.repository ?? null }));
  const flow = new FlowCache((now) => flowView(opts.gh ?? runGh, flowWorkspaces(), db.sqlite, 30, now), () => flowScope(flowWorkspaces()));
  // a request that was out when the daemon stopped is looked for before it is sent again (#886)
  db.recoverBacklogOperations();
  /**
   * A workspace's stored backlog, without waiting for GitHub. One never imported and not tried yet gets its import asked
   * for, once: a failed one is asked again by 再読込, the daemon's boot or the scheduled sweep, not by every look.
   */
  const storedBacklog = (ws: Workspace, released?: (oid: string) => boolean | null): StoredBacklog => {
    const stored = backlog.read(ws, { released });
    if (stored.fetchedAt !== null || stored.error || stored.syncing) return stored;
    backlog.request(ws);
    return backlog.read(ws, { released });
  };
  const metaWorkspace = () => db.listWorkspaces().find((w) => w.kind === "meta");
  /**
   * Evals (#1218): the rules row is counted at each turn's end (below); a task without one — from before #1218, or
   * read while its first turn runs — is counted now and the row kept, so the list (#1221) never reads every task's
   * events. A Cloud task has no events here and is not evaluated.
   */
  const countRules = (t: Task) => {
    const row = { taskId: t.id, source: "rules" as const, by: RULES_BY, rubric: null, json: rulesEvalOf(t, db.listEvents(t.id), db.taskCost(t.id)), ts: Date.now() };
    db.upsertEval(row);
    return row.json;
  };
  const evalsFor = (t: Task): TaskEvals => {
    if (t.executionMode === "cloud") return { ...db.evalsOf(t.id), rules: null }; // no events here to count; the person may still rate it (#1220)
    const stored = db.evalsOf(t.id);
    const rules = stored.rules ?? countRules(t);
    // status, outcome and cost move after the turn's end (the judge, the person, a process that dies without a session.end): the task's own values win over the row's snapshot
    return { ...stored, rules: { ...rules, status: t.status, outcome: t.outcome, costUsd: db.taskCost(t.id).costUsd } };
  };
  /**
   * The runner a Task that starts by itself is decided on, before 上限のときの代わり: the kind's own (#1337) when it is
   * detected, else the caller's (a schedule's), else the saved one; only a saved one that is not detected falls back to
   * claude. null = none to start on. startMetaTask starts on it, and backlog-next reads its usage (#834).
   */
  const decidedRunner = (kind: AutoStartKind, runner?: RunnerId): RunnerId | null => {
    const auto = settings().autoStart;
    const own = auto.byKind[kind];
    if (own && adapterMap.has(own.runner)) return own.runner;
    const configured = runner ?? auto.runner;
    return adapterMap.has(configured) ? configured : !runner && adapterMap.has("claude") ? "claude" : null;
  };
  /**
   * 上限のときの代わり (#834): the runner a Task that starts by itself (a stage button, feedback, a schedule) starts on,
   * and the transcript's status line when it is not the decided one.
   */
  const autoRunner = (decided: RunnerId): { runner: RunnerId; note?: string } => {
    const now = Date.now();
    const r = fallbackRunner(decided, settings().autoStart, (x) => db.quotaFor(x), (x) => adapterMap.has(x), now);
    return r.from ? { runner: r.runner, note: fallbackNote(r.runner, r.from, now) } : { runner: r.runner };
  };
  /**
   * A fixed-prompt Task on the meta workspace (feedback, backlog stage buttons, backlog-next): the saved
   * 自動で始まる Task の既定 (`settings.autoStart`), else claude. A schedule passes its own runner and id. A backlog stage button on another
   * workspace's Issue, and a request filed for another workspace, pass that workspace (`ws`). The kind's own choice
   * (`autoStart.byKind`, #1337) wins over both, when its runner is detected; otherwise it is as if there were none.
   */
  const startMetaTask = async (req: { kind: AutoStartKind; title: string; prompt: string; attachmentIds?: string[]; runner?: RunnerId; model?: string; effort?: string; scheduleId?: string; shadowRunner?: null; budgetUsd?: number | null; ws?: Workspace; stage?: Task["stage"] }): Promise<{ task: Task } | { error: string; status: number }> => {
    const meta = req.ws ?? metaWorkspace();
    if (!meta) return { error: "meta workspace がありません", status: 409 };
    if (!existsSync(meta.path)) return { error: "workspace directory does not exist", status: 409 };
    const auto = settings().autoStart;
    const own = auto.byKind[req.kind];
    if (own && adapterMap.has(own.runner)) req = { ...req, runner: own.runner, model: own.model, effort: own.effort };
    const decided = decidedRunner(req.kind, req.runner);
    if (!decided) return { error: "ランナーが検出されていません", status: 409 };
    // the decided runner at its limit: the order's next one, on its CLI default model and effort (#834)
    const { runner, note } = autoRunner(decided);
    // the saved model goes with the saved runner only; a caller's own runner brings its own model (empty = the CLI default)
    const model = note ? "" : req.runner ? req.model : runner === auto.runner ? auto.model : "";
    // the effort follows the same rule (#833); a saved one the runner no longer lists falls back to the CLI default
    const wanted = note ? "" : req.runner ? req.effort : runner === auto.runner ? auto.effort : "";
    const effort = wanted && !tasks.checkEffort(runner, wanted) ? wanted : "";
    if (req.attachmentIds?.length) {
      const why = attachments.check(req.attachmentIds);
      if (why) return { error: why.message, status: why.status };
    }
    const input = {
      workspaceId: meta.id, cwd: meta.path, runner, title: req.title, prompt: req.prompt, attachmentIds: req.attachmentIds, scheduleId: req.scheduleId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(req.shadowRunner === null ? { shadowRunner: null } : {}),
      ...(req.budgetUsd ? { budgetUsd: req.budgetUsd } : {}),
      ...(req.stage ? { stage: req.stage } : {}),
    };
    try {
      const routed = await suggestForCreate(input);
      const task = tasks.create(input, routed.suggestion, (t) => {
        for (const u of routed.usage) db.insertLedger(ledgerRowFor(pricingTable(), { id: t.id, runner: routed.runner, model: u.model ?? null }, u, Date.now()));
        if (note) tasks.record(t.id, { t: "status", text: note });
      });
      return { task };
    } catch (e) {
      return { error: String((e as Error).message ?? e), status: 409 };
    }
  };
  /** A stage Task runs on the workspace whose repository the Issue is in, so another repository's #n is not the meta's #n. */
  const activeStageTask = (workspaceId: string, n: number) => db.activeStageTask(workspaceId, n);
  // Issues whose stage Task is being created right now (`<workspaceId>:<n>` → n): startMetaTask awaits (routing, the
  // runner's start), and a second start in that gap must not pass the running/waiting check too.
  const startingStage = new Map<string, { n: number; action: BacklogAction }>();
  /**
   * Starts one stage Task of an Issue (#936): the button, backlog-next and the resume after an answer all come here, so
   * the same Issue never has two. A running / waiting one, or one being created, is answered instead of a second; nothing
   * awaits between that check and the mark, and the mark is taken off however the start ends.
   */
  const startStage = async (input: {
    ws: Workspace;
    meta: Workspace;
    item: BacklogItem;
    action: BacklogAction;
    resume?: { tasksDone: number };
    extra?: Pick<Parameters<typeof startMetaTask>[0], "runner" | "model" | "effort" | "scheduleId" | "shadowRunner" | "budgetUsd">;
  }): Promise<{ task: Task } | { active: Task } | { starting: true } | { error: string; status: number }> => {
    const { ws, item, action } = input;
    const active = activeStageTask(ws.id, item.number);
    if (active) return { active };
    const key = `${ws.id}:${item.number}`;
    if (startingStage.has(key)) return { starting: true };
    startingStage.set(key, { n: item.number, action });
    try {
      const other = otherRepo(input.meta, ws);
      return await startMetaTask({ kind: action, ws, title: startTitle(item, action), stage: { issue: item.number, action }, prompt: buildStartPrompt(item, action, { other, resume: input.resume, local: ws.backlog === "switchboard" }), ...input.extra });
    } finally {
      startingStage.delete(key);
    }
  };
  /** Why `backlog.settle` failed, for a line in backlog-next's log (#2264). */
  const notSettled = (e: unknown) => (e instanceof BacklogError ? e.message : String((e as Error)?.message ?? e).slice(0, 200));
  const withActive = (b: Backlog): Backlog => ({
    ...b,
    items: b.items.map((i) => {
      const t = db.lastStageTask(i.workspaceId, i.number);
      // an 実装 started after the waits were written makes them old (#817): it claimed, or it ended before it could —
      // then it is not started again by itself. A 状況確認 only reads, so the newest 実装 is the one compared (#853)
      const impl = i.waitsAt ? db.lastStageTask(i.workspaceId, i.number, "complete") : null;
      const old = !!impl && impl.createdAt > Date.parse(i.waitsAt!);
      return {
        ...i,
        activeTaskId: activeStageTask(i.workspaceId, i.number)?.id ?? null,
        lastTask: t ? { id: t.id, status: t.status, statusAt: t.statusAt, createdAt: t.createdAt, updatedAt: t.updatedAt, action: t.stage?.action ?? null, outcome: t.outcome, reviewedAt: t.reviewedAt, resumeAt: t.resumeAt } : null,
        stopSummary: reduceStops(db.listStopRecords(db.stageTaskIds(i.workspaceId, i.number))),
        ...(old ? { waits: [], waitsAt: null } : {}),
      };
    }),
  });
  /** Every workspace's stored backlog with its stage Tasks (#885, withActive); `refresh` imports each first (GET /api/backlog). */
  const readBacklog = async (refresh: boolean): Promise<Backlog> => {
    const read = await Promise.all(db.listWorkspaces().map(async (ws) => {
      if (!existsSync(ws.path)) return { ws, stored: null };
      if (refresh) await backlog.sync(ws).catch(() => undefined);
      // the prerequisites judged as backlog-next judges them (#937)
      return { ws, stored: storedBacklog(ws, await releasedIn(ws)) };
    }));
    const errors = read.flatMap(({ ws, stored }) => {
      const message = !stored ? "workspace directory does not exist" : (stored.error ?? (stored.fetchedAt === null ? "まだ GitHub から取り込んでいません" : null));
      return message ? [{ workspaceId: ws.id, workspaceName: ws.name, message, kind: stored?.errorKind ?? ("other" as const) }] : [];
    });
    // a workspace kept only here was never read from GitHub: its time is not "imported from GitHub" (#2362)
    const imported = read.flatMap(({ ws, stored }) => (ws.backlog === "github" && stored?.fetchedAt != null ? [stored.fetchedAt] : []));
    return withActive({
      fetchedAt: imported.length ? Math.min(...imported) : Date.now(),
      items: read.flatMap(({ stored }) => stored?.items ?? []),
      errors,
      syncs: read.flatMap(({ ws, stored }) => (stored ? [{ workspaceId: ws.id, repository: db.getWorkspaceBacklogSource(ws.id)?.repository ?? null, syncing: stored.syncing, syncedAt: stored.fetchedAt, ...workspaceSyncOf(db, ws, { importFailed: stored.error !== null }) }] : [])),
    });
  };
  /** A start that failed after an answer (#936), by the question's id: kept in `ask_answers` for a day (#1139). */
  const failed = (id: string) => db.askAnswer(id)?.failure ?? null;
  /** What the saved policies (#938) need from the daemon: the subject of a tool approval and the Knowledge confirm rules. */
  const policyEnv = (b: Backlog): PolicyEnv => ({
    policies: readPolicies(db),
    pbiOpen: (n) => b.items.some((i) => i.number === n),
    approval: (a) => {
      const t = db.getTask(a.taskId);
      if (!t || (a.kind !== "exec" && a.kind !== "write")) return { subject: null, confirmHit: null };
      const ev = { t: "permission.ask" as const, id: a.id, kind: a.kind, tool: a.tool, input: a.input, detail: a.detail };
      const s = subjectsOf(ev, t);
      const confirmHit = approval.confirmHit(t, ev);
      return { subject: s.blocked || s.values.length !== 1 ? null : { kind: "approval", op: a.kind, target: s.values[0]!, conditions: [], head: null }, confirmHit };
    },
    confirm: (workspaceId, command) => {
      const sp = command.indexOf(" ");
      return approval.confirmOf(workspaceId, "decision", command.slice(0, sp), command.slice(sp + 1));
    },
  });
  /**
   * The questions now (#935, docs/design/asks.md): the open ones and those answered / resolved within the day, one per
   * question, from the stored backlog (no GitHub call) and the Tasks.
   */
  /**
   * A policy that did not apply because the PR's head changed (#938), by the question's id: the list does not read PRs, so
   * the difference is kept when applying read it, and shown as the question's `previous` until it is answered or gone.
   */
  /**
   * A decision's id names its answer's time, so the question a policy answered shows under another id once the answer is
   * read back: each use of a decision is tied to the answered question of its Issue, in order, and kept (#938).
   */
  const tieAnswers = (all: Ask[]) => {
    const list = readPolicies(db);
    const base = (id: string) => id.split("@")[0]!;
    const claimed = new Set(list.flatMap((p) => p.uses.flatMap((u) => (u.answered ? [u.answered] : []))));
    const open = list.flatMap((p) => p.uses.filter((u) => !u.answered && u.askId.startsWith("decision:")).map((u) => ({ p, u }))).sort((x, y) => x.u.at - y.u.at);
    if (!open.length) return;
    let changed = false;
    for (const { p, u } of open) {
      const found = all.filter((a) => a.state === "answered" && a.kind === "decision" && base(a.id) === base(u.askId) && !claimed.has(a.id) && a.changedAt >= u.at - 60_000).sort((x, y) => x.changedAt - y.changedAt)[0];
      if (!found) continue;
      claimed.add(found.id);
      u.answered = found.id;
      void p;
      changed = true;
    }
    if (changed) writePolicies(db, list);
  };
  const headMisses = new Map<string, NonNullable<Ask["policy"]["previous"]>>();
  const currentAsks = async (): Promise<{ backlog: Backlog; asks: Ask[] }> => {
    const now = Date.now();
    const b = await readBacklog(false);
    const live = new Map([...db.listTasksUpdatedSince(now - ASK_HISTORY_MS), ...db.listTasksWithResume(), ...db.listTasksByStatus("waiting"), ...db.listTasksByStatus("running")].map((t) => [t.id, t]));
    const policy = policyEnv(b);
    // the screen mockups a question names (#2221): its Task's HTML artifacts, not removed
    const mockups = (id: string) => artifacts.list(id).filter((a) => a.removedAt === null && a.kind !== "url" && (a.mime === "text/html" || a.mime === "application/xhtml+xml"));
    const fromTasks = asksFromTasks({
      approvals: tasks.pendingApprovals(),
      tasks: [...live.values()],
      lastReply: (id) => db.lastReply(id),
      permissionEvents: (ids) => db.listPermissionEvents(ids),
      stops: (t) => reduceStops(db.listStopRecords([t.id])),
      workspaceName: (id) => db.getWorkspace(id)?.name ?? null,
      now,
      resumeFailures: failed,
      policy,
      mockups,
    });
    const all = dedupeAsks([...asksFromBacklog(b.items, now, { approvalPending: approvalPendingOf(), resumeFailures: failed, policy, mockups }), ...fromTasks]);
    tieAnswers(all);
    for (const id of headMisses.keys()) if (!all.some((a) => a.id === id && (a.state === "open" || a.state === "held"))) headMisses.delete(id);
    return { backlog: b, asks: all.map((a) => (headMisses.has(a.id) ? { ...a, policy: { ...a.policy, previous: headMisses.get(a.id)! } } : a)) };
  };
  /** A stage Task's permission stop with a tool approval waiting is answered by that approval, not refused (#936). */
  const approvalPendingOf = () => {
    const approving = tasks.pendingApprovals().map((a) => db.getTask(a.taskId)).filter((t) => t !== null);
    return (i: BacklogItem) => approving.some((t) => t.workspaceId === i.workspaceId && t.stage?.issue === i.number);
  };
  /** A Task's answer as it goes on now (#936): its resume read again from the Task (running, the usage limit, failed). */
  const nowOf = (r: AskAnswerResult): AskAnswerResult => {
    const a = r.ask;
    const t = a && !a.issue && a.task && a.state === "answered" ? db.getTask(a.task.id) : null;
    return t && a ? { ...r, ask: { ...a, resume: resumeOfTask({ task: t, repliedAt: a.changedAt, failure: failed(a.id) }) } } : r;
  };
  /** An answer being written, by the question's id (#936): a second answer to the same question waits for it. */
  const answering = new Map<string, Promise<{ status: number; body: object }>>();
  // What an answer answered, by the question's id, is `ask_answers` for a day (#936, #1139): a resend whose reply was lost gets it again, nothing written twice.

  /**
   * Answers one question of the backlog (#936): checked against the question now (changed → 409 and nothing written),
   * written where it was asked (kept here and sent to GitHub, #886), then — only after that, and unless a hold or something
   * an answer does not take away stands in the way — the work goes on through startStage.
   */
  const answerAsk = async (id: string, answer: AskAnswer, pre: { pr: number; facts: PrFacts } | null = null, by: AnswerPolicy | null = null): Promise<{ status: number; body: object }> => {
    const changed = (error: string, changes: string[], current: Ask | null) => ({ status: 409, body: { error, changes, current } satisfies AskChanged });
    const { asks } = await currentAsks();
    const ask = asks.find((a) => a.id === id);
    const prefix = (x: string) => x.split("@")[0];
    if (!ask || (ask.state !== "open" && ask.state !== "held")) {
      const current = asks.find((a) => a.id !== id && prefix(a.id) === prefix(id) && (a.state === "open" || a.state === "held")) ?? null;
      const why = ask ? "回答済みです" : current ? "問いが新しくなりました" : "問いがもうありません（対象の Issue が閉じたか、別の所で答えられました）";
      return changed(why, [why], current);
    }
    if (!ask.answers.length) {
      const why = ask.blockers.length ? ask.blockers.map((b) => b.detail) : ["この問いには画面から答えられません"];
      return changed("回答だけでは進められない問いです", why, ask);
    }
    if (!ask.issue && ask.task && (ask.kind === "approval" || ask.kind === "check" || ask.kind === "stop")) return answerTask(id, ask, answer, pre, by);
    if (ask.kind !== "decision" && ask.kind !== "confirmation") return { status: 422, body: { error: `${ask.kind} の問いにはここから答えられません` } };
    if (!ask.answers.includes(answer.kind) || (answer.kind === "choice" && !ask.choices.includes(answer.choice))) return changed("選択肢が変わりました", ["選択肢が変わりました"], ask);
    if (answer.kind === "confirm" && !answer.ok && !answer.text) return { status: 400, body: { error: "違うときは理由を書いてください" } };
    const ws = ask.workspace ? db.getWorkspace(ask.workspace.id) : null;
    const source = ws ? db.getWorkspaceBacklogSource(ws.id) : null;
    if (!ws || !source || !existsSync(ws.path)) return { status: 409, body: { error: "workspace がありません" } };
    const meta = metaWorkspace();
    if (ws.kind !== "meta" && !meta) return { status: 409, body: { error: "meta workspace がありません（工程のスキルはそこから読みます）" } };
    // a held question held again (a resend whose reply was lost): nothing more to write
    if (ask.state === "held" && answer.kind === "hold") return { status: 200, body: { ask, already: true, changes: [] } satisfies AskAnswerResult };
    // a choice may be the PR's approval: not given to a PR that moved since. A text still goes (asking to check again),
    // written with what moved, so the work that reads it knows the answer was to the PR before
    let moved: string[] = [];
    if (ask.place?.pr && (answer.kind === "choice" || answer.kind === "text")) {
      try {
        moved = (pre?.pr === ask.place.pr ? pre.facts : await prFacts(opts.gh ?? runGh, ws.path, source.repository, ask.place.pr, ask.at)).changes;
        if (moved.length && answer.kind === "choice") return changed("問いの後で対象の PR が変わりました。選択肢では答えられません。自由文で確かめ直しを頼むか、新しい問いを待ってください", moved, ask);
      } catch (e) {
        return { status: UPSTREAM_FAILED, body: { error: `PR #${ask.place.pr} を確かめられない: ${String((e as Error).message ?? e)}` } };
      }
    }
    const pbi = ask.pbi!.number;
    const gone = policyGone(by);
    if (gone) return changed(gone, [gone], ask);
    try {
      if (answer.kind === "hold") holdStoredDecision(db, source, ask.issue!.number, answer.text ?? "");
      else if (answer.kind === "confirm") {
        const n = Number(/:(\d+)$/.exec(id)?.[1]);
        const item = storedBacklog(ws).items.find((i) => i.number === pbi);
        const c = item?.confirmations.find((x) => x.n === n);
        if (!c || !answerStoredConfirmation(db, source, pbi, { ...c, ok: answer.ok, reason: answer.text ?? "" })) return changed("本文が変わりました", ["受け入れ条件の本文が変わりました"], null);
      } else {
        const said = answer.kind === "choice" ? `${answer.choice}${answer.note ? `\n\n${answer.note}` : ""}` : answer.kind === "text" ? answer.text : "";
        const text = moved.length ? `${said}\n\n（この回答は問いの時点の PR へのものです。回答の時点で: ${moved.join(" / ")}）` : said;
        answerStoredDecision(db, source, ask.issue!.number, by ? `${text}\n\n${basisLine(by, ask.subject)}` : text);
      }
    } catch (e) {
      if (e instanceof BacklogEditError) return { status: e.status, body: { error: e.message } };
      throw e;
    }
    backlog.send(ws);
    const at = Date.now();
    const done = (resume: Ask["resume"]): { status: number; body: AskAnswerResult } => ({ status: 200, body: { ask: { ...ask, state: answer.kind === "hold" ? "held" : "answered", changedAt: at, answers: [], resume }, already: false, changes: moved } });
    if (answer.kind === "hold") return done(null);
    // the work goes on from the item as stored now (the answer is in it): a hold or what an answer does not take away stops it here
    const item = withActive({ fetchedAt: 0, items: storedBacklog(ws).items, errors: [], syncs: [] }).items.find((i) => i.number === pbi);
    if (!item) return done(null);
    const blockers = blockersOf({ waits: item.waits, stops: item.stopSummary, approvalPending: approvalPendingOf()(item) });
    if (blockers.length) return done({ state: "queued", reason: blockers.map((b) => b.detail).join("・"), taskId: null, at });
    const action = ask.kind === "confirmation" ? (item.closable ? "close" : null) : item.stage === "in-progress" ? "complete" : (ACTION_FOR_STAGE[item.stage] ?? null);
    if (!action) return done(null);
    const r = await startStage({ ws, meta: meta ?? ws, item, action });
    if ("task" in r) return done({ state: "running", reason: null, taskId: r.task.id, at });
    if ("active" in r) return done({ state: "running", reason: null, taskId: r.active.id, at });
    if ("starting" in r) return done({ state: "running", reason: "工程 Task を開始しているところ", taskId: null, at });
    // kept for the question and for the answered one it became (its id names the answer's time)
    const failure = { at, reason: r.error };
    db.rememberAskAnswer(id, { at, failure });
    const now = (await currentAsks()).asks.find((a) => a.kind === ask.kind && a.state === "answered" && a.pbi?.number === pbi && a.workspace?.id === ws.id);
    if (now) db.rememberAskAnswer(now.id, { at, failure });
    return done({ state: "failed", reason: r.error, taskId: null, at });
  };

  /** Why a policy picked to answer cannot be used now (revoked or expired while the answer was prepared), or null. */
  const policyGone = (by: AnswerPolicy | null): string | null => {
    if (!by) return null;
    const cur = readPolicies(db).find((p) => p.id === by.id);
    return !cur || cur.revokedAt !== null || (cur.expiresAt !== null && Date.now() >= cur.expiresAt) ? "方針が無効になったか期限が切れたため、答えませんでした" : null;
  };

  /** The one line that says a saved policy answered (#938): written with the answer, where the person reads it. */
  const basisLine = (p: AnswerPolicy, subject: PolicySubject | null) => {
    const scope = { once: "今回のみ", pbi: "この PBI 内", repo: "このリポジトリ" }[p.scope];
    const when = [...p.when, ...(subject?.conditions.filter((c) => c.key === "merge-ask") ?? [])].map((c) => `${c.key}=${c.value}`).join(" ");
    return `（方針 ${p.id} を適用: ${scope} / ${p.op} ${p.target} / 条件 ${when || "なし"} / 期限 ${p.expiresAt === null ? "なし" : new Date(p.expiresAt).toISOString().slice(0, 10)}）`;
  };

  /**
   * One answer, once (#936): a resend gets the first one's result, a second at the same time waits for the first. The
   * screen's POST and a saved policy's application (#938) both come through here.
   */
  const submitAnswer = async (id: string, answer: AskAnswer, policy?: PolicyInput, by: AnswerPolicy | null = null, pre: { pr: number; facts: PrFacts } | null = null): Promise<{ status: number; body: object }> => {
    // no await from here until the answer is in `answering`: a second one for the same question waits for it
    db.pruneAskAnswers(Date.now() - ASK_HISTORY_MS);
    const had = db.askAnswer(id)?.result;
    if (had) return { status: 200, body: { ...nowOf(had), already: true } satisfies AskAnswerResult };
    const first = answering.get(id);
    if (first) {
      const r = await first;
      return r.status === 200 ? { status: 200, body: { ...nowOf(r.body as AskAnswerResult), already: true } satisfies AskAnswerResult } : r;
    }
    const p = policy ? answerWithPolicy(id, answer, policy) : answerAsk(id, answer, pre, by);
    answering.set(id, p);
    try {
      const r = await p;
      // only an answer closes the question: a hold leaves it open to the person, who answers it later by the same id
      if (r.status === 200 && (r.body as AskAnswerResult).ask?.state === "answered") db.rememberAskAnswer(id, { at: Date.now(), result: r.body as AskAnswerResult });
      return r;
    } finally {
      answering.delete(id);
    }
  };

  /**
   * Answers the open questions a saved policy matches (#938), through the same answer as the screen's, with the policy and
   * its basis written with it. Run when a Task's turn ends and when backlog-next fires; never on a timer of its own. A
   * question the policy does not match, or whose answer is refused (changed, GitHub down), stays the person's.
   */
  let applying: Promise<void> = Promise.resolve();
  const applyPolicies = (): Promise<void> => {
    applying = applying.then(async () => {
      if (judgeStop.signal.aborted || !readPolicies(db).some((p) => p.revokedAt === null)) return;
      const { asks, backlog: b } = await currentAsks();
      for (const ask of asks) {
        if (judgeStop.signal.aborted) return;
        if (ask.state !== "open" || ask.needs !== "person" || (ask.kind !== "check" && ask.kind !== "decision") || !ask.subject || !ask.answers.length || ask.blockers.some((b) => b.kind === "runner")) continue;
        let subject = ask.subject;
        const ws = ask.workspace ? db.getWorkspace(ask.workspace.id) : null;
        const source = ws ? db.getWorkspaceBacklogSource(ws.id) : null;
        let pre: { pr: number; facts: PrFacts } | null = null;
        // a PR's head and merge check can only be read with its repository: without it nothing is answered
        if (ask.place?.pr && (!ws || !source)) continue;
        if (ask.place?.pr && ws && source) {
          try {
            const facts = await prFacts(opts.gh ?? runGh, ws.path, source.repository, ask.place.pr, ask.at);
            pre = { pr: ask.place.pr, facts };
            subject = { ...subject, head: facts.head, conditions: facts.mergeAsk ? [...subject.conditions, { key: "merge-ask", value: facts.mergeAsk }] : subject.conditions };
          } catch {
            continue;
          }
        }
        // what always asks: a security merge check, and a Knowledge confirm rule
        if (subject.conditions.some((c) => c.key === "merge-ask" && c.value.includes("security")) || approval.confirmOf(ask.workspace?.id ?? null, subject.kind, subject.op, subject.target)) continue;
        const matched = matchPolicies(readPolicies(db), { id: ask.id, subject, workspaceId: ask.workspace?.id ?? null, pbi: policyPbi(ask), pbiOpen: policyPbi(ask) !== null && b.items.some((i) => i.number === policyPbi(ask)), choices: ask.choices }, Date.now());
        const hit = matched.hit;
        // the policy was saved on another head of this PR: nothing is answered, and the card says what differs
        const moved = hit ? undefined : matched.misses.find((x) => x.why === "PR の差分が変わった");
        if (moved) headMisses.set(ask.id, { id: moved.policy.id, answer: moved.policy.answer, at: moved.policy.updatedAt, why: moved.why, changes: subjectChanges(moved.policy.uses[0]?.subject ?? moved.policy.from, subject) });
        else headMisses.delete(ask.id);
        if (!hit || !ask.answers.includes(hit.answer.kind)) continue;
        const bare = (c: string) => c.replace(/^[^:]*: /, "");
        const answer: AskAnswer = hit.answer.kind === "choice" ? { kind: "choice", choice: ask.choices.find((c) => bare(c) === bare((hit.answer as { choice: string }).choice)) ?? hit.answer.choice, ...(hit.answer.note ? { note: hit.answer.note } : {}) } : hit.answer;
        const r = await submitAnswer(ask.id, answer, undefined, hit, pre);
        if (r.status === 200 && !(r.body as AskAnswerResult).already) {
          writePolicies(db, recordUse(readPolicies(db), hit.id, { at: Date.now(), askId: ask.id, taskId: ask.task?.id ?? null, issue: ask.issue?.number ?? null, subject }));
        }
      }
    }).catch((e) => console.warn(`policies: not applied (${String((e as Error).message ?? e)})`));
    return applying;
  };

  /**
   * An answer that is saved as a policy too (#938): the policy is checked first (a refusal is 409 and nothing is written or
   * sent), the answer goes the usual way, and only an answer that was written saves it.
   */
  const answerWithPolicy = async (id: string, answer: AskAnswer, input: PolicyInput): Promise<{ status: number; body: object }> => {
    const { asks } = await currentAsks();
    const ask = asks.find((a) => a.id === id);
    // a question that is gone or not open is answerAsk's 409
    if (!ask || (ask.state !== "open" && ask.state !== "held")) return answerAsk(id, answer);
    const refuse = (error: string) => ({ status: 409, body: { error, changes: [error], current: ask } satisfies AskChanged });
    if (!ask.policy.scopes.length) return refuse(ask.policy.note ?? "この問いは方針にできません");
    if (!ask.policy.scopes.includes(input.scope)) return refuse(ask.policy.note ?? "この範囲では保存できません");
    let pre: { pr: number; facts: PrFacts } | null = null;
    let subject = ask.subject;
    if (subject && ask.place?.pr) {
      const ws = ask.workspace ? db.getWorkspace(ask.workspace.id) : null;
      const source = ws ? db.getWorkspaceBacklogSource(ws.id) : null;
      if (ws && source) {
        try {
          const facts = await prFacts(opts.gh ?? runGh, ws.path, source.repository, ask.place.pr, ask.at);
          pre = { pr: ask.place.pr, facts };
          subject = { ...subject, head: facts.head, conditions: facts.mergeAsk ? [...subject.conditions, { key: "merge-ask", value: facts.mergeAsk }] : subject.conditions };
        } catch (e) {
          return { status: UPSTREAM_FAILED, body: { error: `PR #${ask.place.pr} を確かめられない: ${String((e as Error).message ?? e)}` } };
        }
      }
    }
    const confirmHit = subject ? approval.confirmOf(ask.workspace?.id ?? null, subject.kind, subject.op, subject.target) : null;
    const checked = checkPolicy(input, { subject, workspaceId: ask.workspace?.id ?? null, pbi: policyPbi(ask), askId: id, answer, confirmHit, runnerRefusal: ask.blockers.some((b) => b.kind === "runner"), now: Date.now() });
    if (!checked.ok) return refuse(checked.error);
    const r = await answerAsk(id, answer, pre);
    const body = r.body as AskAnswerResult;
    if (r.status !== 200 || body.already || body.ask?.state !== "answered") return r;
    const saved: AnswerPolicy = { ...checked.policy, id: `pol_${crypto.randomUUID().slice(0, 12)}`, uses: [] };
    writePolicies(db, [...readPolicies(db), saved]);
    return { status: 200, body: { ...body, policy: saved } satisfies AskAnswerResult };
  };

  /**
   * Answers one question of a Task (#936): a tool approval through the Task's pending permission, a check or a stop of a
   * Task with no Issue as the person's reply — the reply is its record and its resume. A check about a PR that moved since
   * is 409 with nothing sent. A reply the Task refuses (its budget) is not sent: the question stays open, its resume failed.
   */
  const answerTask = async (id: string, ask: Ask, answer: AskAnswer, pre: { pr: number; facts: PrFacts } | null = null, by: AnswerPolicy | null = null): Promise<{ status: number; body: object }> => {
    const taskId = ask.task!.id;
    let moved: string[] = [];
    const changed = (error: string, changes: string[]) => ({ status: 409, body: { error, changes, current: ask } satisfies AskChanged });
    if (!ask.answers.includes(answer.kind) || (answer.kind === "choice" && !ask.choices.includes(answer.choice))) return changed("選択肢が変わりました", ["選択肢が変わりました"]);
    const at = Date.now();
    const result = (state: Ask["state"], resume: Ask["resume"]): { status: number; body: AskAnswerResult } => ({ status: 200, body: { ask: { ...ask, state, changedAt: at, answers: state === "answered" ? [] : ask.answers, resume }, already: false, changes: moved } });
    if (ask.kind === "approval") {
      try {
        const t = tasks.respondPermission(taskId, id.slice(`approval:${taskId}:`.length), answer.kind === "allow" ? "allow" : "deny");
        return result("answered", resumeOfTask({ task: t, repliedAt: at, failure: null }));
      } catch {
        return changed("承認は既に答えられたか、Task が終わりました", ["承認は既に答えられたか、Task が終わりました"]);
      }
    }
    // as on the Issue side: a choice (it may approve the merge) is refused on a PR that moved; a text goes with what moved
    if (ask.place?.pr) {
      const ws = ask.workspace ? db.getWorkspace(ask.workspace.id) : null;
      const source = ws ? db.getWorkspaceBacklogSource(ws.id) : null;
      // a PR whose repository is not known (the Task has no workspace with a backlog source) cannot be checked: a choice
      // is not given to it, a text goes saying so
      if (!ws || !source) {
        moved = [`PR #${ask.place.pr} の差分を確かめられません（Task の workspace に GitHub の取込み元がありません）`];
        if (answer.kind === "choice") return changed("対象の PR を確かめられないので、選択肢では答えられません。自由文で答えてください", moved);
      } else try {
        moved = (pre?.pr === ask.place.pr ? pre.facts : await prFacts(opts.gh ?? runGh, ws.path, source.repository, ask.place.pr, ask.at)).changes;
        if (moved.length && answer.kind === "choice") return changed("問いの後で対象の PR が変わりました。選択肢では答えられません。自由文で確かめ直しを頼むか、新しい問いを待ってください", moved);
      } catch (e) {
        return { status: UPSTREAM_FAILED, body: { error: `PR #${ask.place.pr} を確かめられない: ${String((e as Error).message ?? e)}` } };
      }
    }
    const said = answer.kind === "choice" ? `${answer.choice}${answer.note ? `\n\n${answer.note}` : ""}` : answer.kind === "text" ? answer.text : "";
    const text = moved.length ? `${said}\n\n（この回答は問いの時点の PR へのものです。回答の時点で: ${moved.join(" / ")}）` : said;
    const gone = policyGone(by);
    if (gone) return changed(gone, [gone]);
    try {
      const t = await tasks.send(taskId, by ? `${basisLine(by, ask.subject)}\n\n${text}` : text);
      return result("answered", resumeOfTask({ task: t, repliedAt: at, failure: null }));
    } catch (e) {
      const failure = { at, reason: String((e as Error).message ?? e) };
      db.rememberAskAnswer(id, { at, failure });
      return result(ask.state, { state: "failed", reason: failure.reason, taskId, at });
    }
  };

  /** sb-rescue's view of the releases (#178); `managed: false` when not under sb-rescue or when it does not answer. */
  type RescueStatus = ReleaseState & { previous: string | null; state: string; busy: string | null; lastError: string | null };
  const releaseStatus = async (): Promise<RescueStatus | { managed: false; error?: string }> => {
    if (!cfg.rescueUrl) return { managed: false };
    try {
      const r = await askRescue("/api/status");
      if (!r.ok) return { managed: false, error: `sb-rescue answered ${r.status} at ${cfg.rescueUrl}` };
      const s = (await r.json()) as Omit<RescueStatus, "managed">;
      return { ...s, managed: true };
    } catch (e) {
      return { managed: false, error: `sb-rescue did not answer at ${cfg.rescueUrl}: ${String((e as Error).message ?? e)}` };
    }
  };
  /** sb-rescue builds, checks on a spare port, switches and rolls back by itself; this only asks (202 = started). */
  const requestPromote = async (commit: string): Promise<{ status: number; body: object }> => {
    const r = await askRescue("/api/promote", { method: "POST", body: JSON.stringify({ commit }) });
    return { status: r.status, body: (await r.json()) as object };
  };
  const busyTasks = () => db.listTasksByStatus("running").length + db.listTasksByStatus("waiting").length;
  /**
   * Why the last promotionFirst held the newest tag (#626): Tasks running (asked again once they end) or a tag that
   * failed. Memory only: a restart forgets it and the next firing makes it again. `GET /api/daemon/release` shows it.
   */
  let promotionHold: { tag: string; failed: boolean; reason: string } | null = null;
  /** Before picking (#282): bring the app up to the newest tag, or hold everything while that tag failed to start. */
  const promotionFirst = async (meta: Workspace): Promise<string | null> => {
    const status = await releaseStatus();
    if (!status.managed) return null;
    const latest = await latestTag(git).catch(() => null);
    const current = (status as ReleaseState).current;
    // exit 0 = the tag's commit is an ancestor of what runs (git throws on any other exit)
    const latestInCurrent = !!latest && !!current && latest.sha !== current && (await git(["merge-base", "--is-ancestor", latest.sha, current]).then(() => true, () => false));
    // counted after the last await: a Task that ends while git runs either counts as ended here or finds the hold set
    const step = promotionStep({ status: status as ReleaseState, latest, busyTasks: busyTasks(), latestInCurrent });
    promotionHold = step.action === "wait" ? { tag: step.failed?.tag ?? latest!.tag, failed: !!step.failed, reason: step.reason } : null;
    if (step.action === "pick") return null;
    if (step.action === "promote") {
      try {
        const r = await requestPromote(step.sha);
        return r.status === 202 ? `${step.tag} の昇格を依頼` : `${step.tag} の昇格を依頼できない: ${JSON.stringify(r.body)}`;
      } catch (e) {
        return `${step.tag} の昇格を依頼できない: ${String((e as Error).message ?? e)}`;
      }
    }
    if (step.failed) {
      const subject = await git(["log", "-1", "--format=%s", step.failed.sha]).catch(() => "");
      const pbi = await reportPromoteFailure(opts.gh ?? runGh, meta.path, { ...step.failed, subject, rescueUrl: cfg.rescuePageUrl! }).catch(() => null);
      return `${step.reason}${pbi ? `（判断待ち: #${pbi}）` : ""}`;
    }
    return step.reason;
  };
  /**
   * Whether a merge commit is in the release that runs (#937), for the `（リリース）` prerequisites: only Switchboard's own
   * workspace (meta) under sb-rescue can tell — `git merge-base --is-ancestor <oid> <current>`, once per commit while
   * `current` stays; anything else answers null (cannot tell, so not met), a commit the checkout does not have too. The commits asked about are the ones the
   * stored prerequisites name.
   */
  let releaseKnown: { current: string; of: Map<string, boolean> } | null = null;
  const releasedIn = async (ws: Workspace): Promise<(oid: string) => boolean | null> => {
    const none = () => null;
    if (ws.kind !== "meta") return none;
    const status = await releaseStatus();
    const current = status.managed ? (status as ReleaseState).current : null;
    if (!current) return none;
    if (releaseKnown?.current !== current) releaseKnown = { current, of: new Map() };
    const known = releaseKnown;
    const asked = new Set<string>();
    backlog.read(ws, { released: (oid) => (asked.add(oid), null) });
    for (const oid of asked) {
      if (known.of.has(oid)) continue;
      // exit 1 = not an ancestor; any other failure (a commit this checkout does not have, a time out) cannot tell, and is not kept
      const r = await git(["merge-base", "--is-ancestor", oid, current]).then(() => true, (e: { exitCode?: number }) => (e.exitCode === 1 ? false : null));
      if (r !== null) known.of.set(oid, r);
    }
    return (oid) => known.of.get(oid) ?? null;
  };
  /** A promotion held only by running Tasks is asked for as soon as none runs (#626), not at the next firing. */
  const promoteWhenIdle = () => {
    if (!promotionHold || promotionHold.failed || busyTasks() > 0) return;
    const meta = metaWorkspace();
    if (!meta) return;
    promotionHold = null; // before the await: a second Task ending meanwhile does not ask again
    void promotionFirst(meta).then((why) => { if (why) scheduler.note(`バックログを進める: Task が空いたので ${why}`); }, () => undefined);
  };
  tasks.onTurnEnd(promoteWhenIdle);
  tasks.onTaskEnd(promoteWhenIdle);
  /**
   * One backlog-next firing (#267, #561): for every registered workspace and each of its two slots (implement / plan),
   * start the slot's next item while fewer stage Tasks of that slot run there than the setting backlogSweep allows (read
   * per firing). While the usage of the runner it starts them on is high, one stage Task at most runs anywhere; while the newest tag waits to be
   * promoted, nothing starts anywhere.
   */
  const startNext = async (scheduleId: string): Promise<BacklogNextResult> => {
    const slots: Record<Slot, number> = settings().backlogSweep;
    const started: BacklogNextResult["started"] = [];
    const skipped: string[] = [];
    const meta = metaWorkspace();
    if (!meta) return { started, skipped: ["meta workspace がありません"] };
    const held = await promotionFirst(meta);
    if (held) return { started, skipped: [held] };
    // Stage Tasks running or waiting, and ones a button (or this firing) is creating right now (startingStage), per workspace and slot.
    const stageTasks = () => db.listActiveStageTasks();
    const busy = (wsId: string, slot: Slot) => {
      const tasks = stageTasks().filter((t) => t.workspaceId === wsId && SLOT_OF_ACTION[t.stage!.action] === slot).map((t) => `工程 Task ${t.id}（${t.title}）が ${t.status}`);
      const starting = [...startingStage].filter(([k, v]) => k.startsWith(`${wsId}:`) && SLOT_OF_ACTION[v.action] === slot).map(([, v]) => `#${v.n} の工程 Task を開始しているところ`);
      return [...tasks, ...starting];
    };
    // The usage that counts is the one of the runner each stage Task starts on (#834): its kind's as startMetaTask decides
    // it (the kind's own, else the schedule's), after 上限のときの代わり; read once per firing.
    const schedule = db.getSchedule(scheduleId);
    const targetOf = Object.fromEntries(BacklogAction.options.map((a) => [a, ((d) => (d ? autoRunner(d).runner : null))(decidedRunner(a, schedule?.runner))])) as Record<BacklogAction, RunnerId | null>;
    // Only a window that has not reset yet counts: a row from before the reset would otherwise hold the sweep for good,
    // since only a turn of that runner writes a new one (resetsAt is in seconds).
    const limit = settings().quotaAndResume.backlogQuotaLimit;
    const windowAt = (r: RunnerId | null, at: number) => (r ? db.quotaFor(r).find((q) => q.utilization >= at && q.resetsAt * 1000 > Date.now()) : undefined);
    // A window at its limit (#1275): the stage Task would end at once on the limit, so it is not started.
    const fullOf = (r: RunnerId | null) => {
      const w = windowAt(r, QUOTA_FULL);
      return w ? `${r} の使用量 ${w.window} が ${Math.round(w.utilization * 100)}%: ${fmtTime(w.resetsAt * 1000, Date.now())} に戻るまで始めない` : "";
    };
    const usageOf = (r: RunnerId | null) => {
      const w = windowAt(r, limit);
      return w ? `${r} の使用量 ${w.window} が ${Math.round(w.utilization * 100)}%（${Math.round(limit * 100)}% 以上）` : "";
    };
    // Why an action's stage Task is not started now: its runner at the limit, or its runner's usage high and a stage Task
    // already running anywhere or started by this firing (one start per firing, asked again before each start: one a
    // button started while GitHub was read counts too). "" = it may start.
    const quotaHeld = (a: BacklogAction) => fullOf(targetOf[a]) || (usageOf(targetOf[a]) && (started.length > 0 || stageTasks().length + startingStage.size > 0) ? usageOf(targetOf[a]) : "");
    const lines = (xs: string[]) => [...new Set(xs.filter(Boolean))];
    // nothing could start: GitHub is not read
    if (BacklogAction.options.every(quotaHeld)) return { started, skipped: lines(BacklogAction.options.map((a) => fullOf(targetOf[a]) || `${usageOf(targetOf[a])}: 工程 Task が動いているので始めない`)) };
    skipped.push(...lines(BacklogAction.options.map((a) => fullOf(targetOf[a]))), ...lines(BacklogAction.options.map((a) => (fullOf(targetOf[a]) ? "" : usageOf(targetOf[a])))).map((u) => `${u}: 全体で 1 件まで`));
    // a saved policy answers the decisions it matches before the next one is picked (#938)
    await applyPolicies();
    const SLOTS: Slot[] = ["implement", "plan"];
    const SLOT_NAME: Record<Slot, string> = { implement: "実装の枠", plan: "計画の枠" };
    // read every workspace that has a free slot in parallel (#441); one GitHub cannot be read for goes on with what is stored (#2264)
    const read = await Promise.all(db.listWorkspaces().map(async (ws) => {
      if (!SLOTS.some((slot) => busy(ws.id, slot).length < slots[slot])) return { ws, items: [] as BacklogItem[], syncHeld: [] as string[], unsynced: null };
      if (!existsSync(ws.path)) return { ws, error: "workspace directory does not exist" };
      // the stored data is what is true (#2264): GitHub is brought up to date first when it can be reached, and when it
      // cannot (a limit, an outage) the workspace goes on with what is stored; only an Issue with a conflict is not picked
      const unsynced = await backlog.settle(ws).then(() => null, (e) => notSettled(e));
      const all = withActive({ fetchedAt: 0, items: backlog.read(ws, { released: await releasedIn(ws) }).items, errors: [], syncs: [] }).items;
      const judged = all.map((item) => ({ item, can: canStartStoredBacklog(item) }));
      return { ws, items: judged.filter((j) => j.can.ok).map((j) => j.item), syncHeld: judged.flatMap((j) => (j.can.ok ? [] : [`#${j.item.number}（${j.can.why}）`])), unsynced };
    }));
    for (const r of read) {
      const { ws } = r;
      if ("error" in r) {
        skipped.push(`${ws.name}: ${r.error}`);
        continue;
      }
      if (r.unsynced) skipped.push(`${ws.name}: GitHub と照合できない（保存データで進める）: ${r.unsynced}`);
      if (r.syncHeld.length) skipped.push(`${ws.name}: 競合があるので自動では始めない: ${r.syncHeld.join(" ")}`);
      const picked = new Set<number>();
      for (const slot of SLOTS) {
        // checked again after GitHub was read: a button may have started a stage meanwhile
        for (let n = 0; ; n++) {
          const running = busy(ws.id, slot);
          if (running.length >= slots[slot]) {
            if (slots[slot] > 0 && n === 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}が埋まっている: ${running.join(" / ")}`);
            break;
          }
          const slotHeld = BacklogAction.options.filter((a) => SLOT_OF_ACTION[a] === slot).map(quotaHeld);
          if (slotHeld.every(Boolean)) {
            if (n === 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: ${lines(slotHeld).join(" / ")}`);
            break;
          }
          const next = pickNext(r.items.filter((i) => !picked.has(i.number)), slot);
          // a Task that ended asking the person, or failed, with no update to the Issue since (#1275); named under that, not as unchanged
          const replyWaiting = n === 0 ? replyWaitingIn(r.items, slot) : [];
          if (replyWaiting.length) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 返事待ち: ${replyWaiting.map((i) => `#${i.number}`).join(" ")}`);
          const failed = n === 0 ? failedIn(r.items, slot) : [];
          if (failed.length) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 前回の Task が失敗したまま更新が無い: ${failed.map((i) => `#${i.number}${i.lastTask!.resumeAt ? `（使用上限、${fmtTime(i.lastTask!.resumeAt, Date.now())} に戻る）` : ""}`).join(" ")}`);
          const unchanged = n === 0 ? unchangedIn(r.items, slot).filter((i) => !failedSince(i) && !awaitingReply(i)) : [];
          if (unchanged.length) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 前回から更新が無い: ${unchanged.map((i) => `#${i.number}`).join(" ")}`);
          // what holds them (#817, #937): an overlap still open, a prerequisite not done yet, one a person has to look at
          const held = n === 0 ? heldIn(r.items, slot) : [];
          for (const [label, of] of HELD_LINES) {
            const rows = held.flatMap(({ item, pending, stuck }) => {
              const named = of(pending, stuck);
              return named.length ? [`#${item.number}（${named.map(heldWhy).join("・")}）`] : [];
            });
            if (rows.length) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: ${label}: ${rows.join(" ")}`);
          }
          // PBIs whose Tasks' files other work touches (#1044): left before a session starts only to find that out
          const overlapped = n === 0 ? overlapIn(r.items, slot) : [];
          const touching = overlapped.filter((i) => i.overlap!.hits.length > 0);
          if (touching.length) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 重なり: ${touching.map((i) => `#${i.number}（${i.overlap!.hits.map((h) => `${h.ref}: ${h.path}`).join("・")}）`).join(" ")}`);
          const undecided = overlapped.filter((i) => i.overlap!.unknown !== null);
          if (undecided.length) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 重なりを判定できない: ${undecided.map((i) => `#${i.number}（${i.overlap!.unknown}）`).join(" ")}`);
          // stalled PBIs whose newest ## 状況 counts as many closed Tasks as now (#578)
          const spinning = n === 0 ? spinningIn(r.items, slot) : [];
          if (spinning.length) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 前回の再開から進んでいない: ${spinning.map((i) => `#${i.number}`).join(" ")}`);
          if (!next) {
            if (n === 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 進められる項目が無い`);
            break;
          }
          picked.add(next.item.number);
          // read again right before the start (#909): the sweep may have taken long since this workspace was read, and an
          // edit may have been kept meanwhile — GitHub when it can be reached, the stored data either way (#2264)
          const late = await backlog.settle(ws).then(() => null, (e) => notSettled(e));
          if (late && !r.unsynced) skipped.push(`${ws.name}: GitHub と照合できない（保存データで進める）: ${late}`);
          const fresh = withActive({ fetchedAt: 0, items: backlog.read(ws, { released: await releasedIn(ws) }).items, errors: [], syncs: [] }).items.find((i) => i.number === next.item.number);
          const can = fresh ? canStartStoredBacklog(fresh) : { ok: false as const, why: "バックログから無くなった" };
          // its stage Task started meanwhile (a button, an answer's resume): the slot's next item instead
          if (fresh?.activeTaskId) {
            skipped.push(`${ws.name}: #${next.item.number} は工程 Task が動いている`);
            continue;
          }
          // what to do is picked again on the item as it is now (a Task reopened meanwhile makes a 閉じる a 実装, or nothing)
          const again = can.ok ? pickNext([fresh!], slot) : null;
          if (!can.ok || !again || again.action !== next.action || !again.resume !== !next.resume) {
            skipped.push(`${ws.name}: #${next.item.number} を始めない: ${can.ok ? "照合の間に変わった（次の発火で選び直す）" : can.why}`);
            continue;
          }
          // the usage of the runner this action starts on (#834): another item of the slot may start on another runner
          const why = quotaHeld(again.action);
          if (why) {
            skipped.push(`${ws.name}: #${next.item.number} を始めない: ${why}`);
            continue;
          }
          // Unattended: no shadow (#99, like prompt schedules) and the schedule's budget applies to the stage Task.
          const t = await startStage({
            ws, meta, item: again.item, action: again.action, resume: again.resume && { tasksDone: again.item.tasks!.done },
            extra: { runner: schedule?.runner, model: schedule?.model, effort: schedule?.effort, scheduleId, shadowRunner: null, budgetUsd: schedule?.budgetUsd },
          });
          // its stage Task started after GitHub was read (a button, an answer's resume): the slot's next item instead
          if ("active" in t || "starting" in t) {
            skipped.push(`${ws.name}: #${next.item.number} は工程 Task が${"active" in t ? "動いている" : "開始中"}`);
            continue;
          }
          if ("error" in t) {
            skipped.push(`${ws.name}: #${next.item.number} を始められない: ${t.error}`);
            break;
          }
          started.push({ task: t.task, label: `${ws.name} #${next.item.number} を ${next.action}` });
        }
      }
    }
    return { started, skipped };
  };
  // secret-scan (#775): every registered repository through the kit's scan-issues; hits or a failure leave one inbox note
  const scanSecrets = async () => {
    const meta = metaWorkspace();
    if (!meta) return { lines: ["meta workspace がない（共通キットの scan-issues を呼べない）"], summary: { repos: 0, hits: 0, failed: 1 } };
    const r = await scanAllRepos({ workspaces: db.listWorkspaces(), metaPath: meta.path, gh: opts.gh ?? runGh });
    if (r.note) inbox.add(r.note.body, { title: r.note.title });
    return r;
  };
  // Scheduler (#20): cron-fired tasks, morning queue view.
  const scheduler = new Scheduler(db, tasks, Date.now, startNext, scanSecrets, () => settings().quotaAndResume.backlogQuotaLimit, autoRunner);
  if (!cfg.candidate) {
    scheduler.start();
    // the stored backlog is brought up to date at boot (#885); reading it does not wait for this
    // what was kept before the stop is sent (a wait still running is waited for by a timer, #886)
    // and read again by itself from then on (#887), more often while it changes
    if (opts.backlogAutoImport) {
      backlog.startPolling();
      for (const ws of db.listWorkspaces()) if (existsSync(ws.path)) backlog.request(ws), backlog.send(ws);
    }
  }
  // Usage-limit auto-resume (#102): a task stopped on the runner's limit is continued once it lifts, per-runner setting.
  const resumer = new RateLimitResumer(db, tasks, { enabled: savedAutoResume, tunables: () => settings().quotaAndResume, log: (m) => console.log(m), githubBudget: (cwd) => githubBudget.get(cwd) });
  if (!cfg.candidate) resumer.start();
  // Leftovers of tasks that ended while no daemon ran (#1397): a task that is over and has nothing planned
  if (!cfg.candidate) {
    void stopEndedTasksProcesses((id) => {
      const t = db.getTask(id);
      return !!t && (t.status === "done" || t.status === "error" || t.status === "aborted") && t.resumeAt === null;
    }, { home: cfg.home }).then((stopped) => {
      for (const [id, n] of stopped) if (n > 0) tasks.record(id, { t: "status", text: `前回のデーモンの間に残った、切り離されたプロセスを ${n} 件止めました` });
    }).catch(() => undefined);
  }
  // Stopping an idle cloud host (#181): only where the environment set a stop command. Core decides when; the command
  // (sb-stop on the host) registers the wake-up and shuts the machine down.
  let wsCount = 0;
  // Sockets let in by a login cookie: asked about afresh every SESSION_RECHECK_MS (not from the kept answers, so one
  // period is the most a removed passkey's socket stays), closed once the passkey is gone (#708).
  const cookieSockets = new Set<ServerWebSocket<WsData>>();
  const recheckTimer = setInterval(() => {
    for (const ws of cookieSockets) {
      const session = ws.data?.session;
      if (!session) continue;
      void sessionCheck(new Request("http://127.0.0.1/", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }), true).then((ok) => {
        if (ok === undefined && cookieSockets.has(ws)) ws.close(4401, "session revoked");
      });
    }
  }, opts.sessionRecheckMs ?? SESSION_RECHECK_MS);
  // The stop command is this daemon's alone: runners, terminal shells and what they start must not inherit it. A
  // scratch daemon a Task boots with `loadConfig({ ...process.env, … })` would otherwise count only its own empty
  // database, and 20 minutes later stop the host under the Tasks this daemon is running.
  delete process.env.SWITCHBOARD_IDLE_STOP_CMD;
  const nextWakeAt = () => nextWakeFrom(db.listTasksWithResume().map((t) => ({ resumeAt: t.resumeAt ?? null, auto: savedAutoResume(t.runner) })), db.listSchedules());
  const hostIdle =
    cfg.idleStopCmd && !cfg.candidate
      ? new HostIdle(
          () => ({ running: db.listTasksByStatus("running").length, waiting: db.listTasksByStatus("waiting").length, background: tasks.backgroundJobs(), ws: wsCount, pty: pty?.size ?? 0, nextWakeAt: nextWakeAt() }),
          (at) => {
            const arg = at === null ? "-" : new Date(at).toISOString();
            console.log(`hostidle: idle for 20 minutes; running ${cfg.idleStopCmd} ${arg}`);
            try {
              Bun.spawn([cfg.idleStopCmd!, arg], { stdout: "inherit", stderr: "inherit" });
            } catch (e) {
              console.error(`hostidle: ${cfg.idleStopCmd} failed to start: ${String((e as Error).message ?? e)}`);
            }
          },
        )
      : null;
  hostIdle?.start();
  tasks.onTurnEnd(() => hostIdle?.touch());
  const isMeta = (t: { workspaceId: string | null }) => !!t.workspaceId && db.getWorkspace(t.workspaceId)?.kind === "meta";
  let restarting = false;
  tasks.onTurnEnd((taskId, t, turn) => {
    if (turn.end.status === "ok") {
      // a turn that went through proves the login, also over a status-command answer from before the person logged in
      loginExpired.delete(t.runner);
      const d = detected.find((x) => x.adapter.id === t.runner);
      if (d?.info.login === "expired") d.info = { ...d.info, login: "ok" };
    }
    if (turn.end.status !== "error" || ![turn.end.summary, ...turn.errors].some((text) => isAuthText(t.runner, text))) return;
    const info = detected.find((d) => d.adapter.id === t.runner)?.info;
    if (info?.login === undefined) return;
    loginExpired.add(t.runner);
    tasks.record(taskId, { t: "status", text: `${t.runner} のログインが切れています。Task の「ターミナル」tab で \`${info.loginHint ?? t.runner}\` を実行してから返信してください` });
  });
  tasks.onTurnEnd((taskId, t) => {
    if (!isMeta(t)) return;
    // A shadow (#99) of a meta task shares the workspace but must not invalidate the primary's checks nor start a
    // second, concurrent check run on the same tree.
    if (t.shadowOf) return;
    selfdev.invalidate(); // the tree changed: earlier runs no longer vouch for it
    if (t.status === "done" && checksOn && !restarting) void selfdev.run(taskId).catch(() => undefined);
  });

  // Evals (#1218): the rule counts of every finished turn. Synchronous and cheap; a failure must not stop the turn's end.
  tasks.onTurnEnd((taskId, t) => {
    if (t.executionMode === "cloud") return;
    try {
      countRules(t);
    } catch (e) {
      console.warn(`evals: task ${taskId} not counted (${String((e as Error).message ?? e)})`);
    }
  });

  // insights (#1838): the schedule's Task ran `/insights` as its first turn; the report Claude Code wrote becomes the
  // Task's artifact. Only that turn is looked at (a follow-up sent to the Task later is an ordinary turn and must not
  // sweep in a report another run — a terminal's, say — made meanwhile), and only a report written since the turn
  // started (an older one is another run's too). A failure is a line on the Task.
  tasks.onTurnEnd((taskId, t, turn) => {
    if (!t.scheduleId || db.getSchedule(t.scheduleId)?.action !== "insights" || turn.end.status !== "ok") return;
    const events = db.listEvents(taskId);
    if (events.filter((e) => e.ev.t === "session.end").length > 1) return; // the ended turn is this one, the first; later ones are follow-ups
    const file = join(cfg.claudeUsageDataDir, "report.html");
    try {
      // the Task's creation, not the runner's session.start: /insights analyses and writes the report before Claude Code
      // reports its session (#1958); the listener runs for the first turn only, so this is that turn's start
      const started = t.createdAt;
      if (statSync(file).mtimeMs <= started) {
        tasks.record(taskId, { t: "status", text: `report.html がこの実行の開始より古いので成果物に写しません（${file}）` });
        return;
      }
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const a = artifacts.addCopy(t, file, `Claude Code Insights ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
      tasks.record(taskId, { t: "status", text: `レポートを成果物に写しました: ${a.title}` });
    } catch (e) {
      const gone = (e as NodeJS.ErrnoException).code === "ENOENT";
      tasks.record(taskId, { t: "status", text: gone ? `report.html が無いので成果物に写しません（${file}）` : `レポートを成果物に写せませんでした: ${String((e as Error).message ?? e)}` });
    }
  });

  /**
   * The automatic judgement (#493): a turn that ended done, on a task the rule left unknown, is judged from its last
   * reply in the background. The judgement is always kept (judged*); the outcome takes it only while it is still
   * unknown — the person may have set it meanwhile, and theirs wins. A shadow (#99) is not judged: the primary is
   * enough, and it would spend the quota twice. `judgingAt` (a column, #1139) marks the reply being judged: a new turn
   * clears it, so a judgement of an older reply writes nothing, and a daemon restart that cut one short has it judged again.
   */
  const judgeStop = new AbortController(); // aborted by stopAll before the database closes
  let lastJudgingAt = 0; // the mark is a time, but never the same twice in this daemon (two turns in a millisecond, a clock set back)
  const judgeReply = (taskId: string, t: Task, lastReply: string, at: number) => {
    const cfg = settings().judge;
    const jc = settings().judgeAndChoice;
    db.updateTask(taskId, { judgingAt: at, updatedAt: t.updatedAt });
    const onUsage = (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => {
      if (!judgeStop.signal.aborted) db.insertLedger(ledgerRowFor(pricingTable(), { id: taskId, runner, model: ev.model ?? null }, ev, Date.now()));
    };
    void (opts.judge ?? judgeTurn)({ title: t.title, prompt: db.firstUserText(taskId) ?? "", lastReply }, { adapters: adapterMap, settings: cfg, cwd: suggestDir, onUsage, log: (m) => console.warn(m), signal: judgeStop.signal, fallback: { runner: jc.judgeFallbackRunner, model: jc.judgeFallbackModel }, timeoutMs: jc.judgeTimeoutMs })
      .then((j) => {
        if (judgeStop.signal.aborted) return;
        const cur = db.getTask(taskId);
        // a turn has started since: this judges a reply that is no longer the last one
        if (!cur || cur.judgingAt !== at || cur.status !== "done") return;
        // updatedAt stays: like 確認済み (#492), a judgement is not activity and must not move the task in the list
        const next = db.updateTask(taskId, { judgedResult: j.result, judgedReason: j.reason, judgedBy: `${j.runner}:${j.model}`, judgingAt: null, ...(cur.outcome === "unknown" ? { outcome: j.result } : {}), updatedAt: cur.updatedAt });
        if (next) broadcast({ type: "task.updated", task: next });
        void applyPolicies();
      })
      .catch((e) => {
        if (!judgeStop.signal.aborted) console.warn(`judge: task ${taskId} is left unjudged (${String((e as Error).message ?? e)})`);
      })
      .finally(() => {
        // stopped with the daemon: the mark stays, so the next start judges this reply again
        if (judgeStop.signal.aborted) return;
        const cur = db.getTask(taskId);
        if (cur?.judgingAt === at) db.updateTask(taskId, { judgingAt: null, updatedAt: cur.updatedAt });
      });
  };
  // a saved policy may answer what this Task's turn left open (#938)
  tasks.onTurnEnd(() => void applyPolicies());
  tasks.onTurnEnd((taskId, t, turn) => {
    const lastReply = turn.end.summary?.trim() ?? "";
    if (t.executionMode === "cloud" || !settings().judge.enabled || t.status !== "done" || t.shadowOf || t.outcome !== "unknown" || !lastReply) return;
    judgeReply(taskId, t, lastReply, (lastJudgingAt = Math.max(Date.now(), lastJudgingAt + 1)));
  });

  /**
   * The rubric judge (#1219): a turn that ended done is scored against the rubric in the background, on the judge
   * runner (`settings.judge`); the row replaces the task's previous one and the screen is told to read it again.
   * The rubric is read once at boot — the person's edit takes effect on the next start. Not a shadow (#99), not Cloud.
   * `rubricSeq` drops a score of an older reply, as `judgingAt` does for the two-way judge.
   */
  const rubric = loadRubric(cfg.home, (m) => console.warn(m));
  let rubricSeqNext = 0;
  const rubricSeq = new Map<string, number>();
  const judgeEvals = (taskId: string, t: Task) => {
    const seq = ++rubricSeqNext;
    rubricSeq.set(taskId, seq);
    const onUsage = (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => {
      if (!judgeStop.signal.aborted) db.insertLedger(ledgerRowFor(pricingTable(), { id: taskId, runner, model: ev.model ?? null }, ev, Date.now()));
    };
    const metrics = (db.evalsOf(taskId).rules ?? countRules(t)).metrics;
    const events = db.listEvents(taskId);
    const lastSeq = events[events.length - 1]?.seq ?? 0;
    const jc = settings().judgeAndChoice;
    void (opts.rubricJudge ?? judgeRubric)({ title: t.title, prompt: db.firstUserText(taskId) ?? "", events: events.map((e) => e.ev), metrics, rubric }, { adapters: adapterMap, settings: settings().judge, cwd: suggestDir, onUsage, log: (m) => console.warn(m), signal: judgeStop.signal, fallback: { runner: jc.judgeFallbackRunner, model: jc.judgeFallbackModel } })
      .then((j) => {
        if (judgeStop.signal.aborted) return;
        const cur = db.getTask(taskId);
        if (!cur || rubricSeq.get(taskId) !== seq) return; // deleted, or a newer scoring took over (that one answers the screen)
        // a turn in flight, or a message the person sent since: this scored a transcript that is no longer the task's. (a status
        // event — a model or mode change, a shadow's error — is not a new transcript; the #493 judge keeps its row then too)
        const stale = cur.status === "running" || cur.status === "waiting" || db.listEvents(taskId, lastSeq).some((e) => e.ev.t === "message.delta" && e.ev.role === "user");
        if (!stale) db.upsertEval({ taskId, source: "judge", by: j.by, rubric: j.rubric, json: j, ts: j.ts });
        broadcast({ type: "evals.updated", taskId }); // also when dropped: the screen's 再評価 is waiting on it
      })
      .catch((e) => {
        if (judgeStop.signal.aborted) return;
        console.warn(`rubric judge: task ${taskId} is left unscored (${String((e as Error).message ?? e)})`);
        // the screen's 再評価 waits on this message; the row it reads back is the previous one (or none)
        broadcast({ type: "evals.updated", taskId });
      })
      .finally(() => {
        if (rubricSeq.get(taskId) === seq) rubricSeq.delete(taskId);
      });
  };
  tasks.onTurnEnd((taskId, t, turn) => {
    // a turn that ended without a reply is not scored, as #493 does not judge it: there is no work reported to score
    if (t.executionMode === "cloud" || t.shadowOf || t.status !== "done" || !settings().evals.judge.enabled || !turn.end.summary?.trim()) return;
    judgeEvals(taskId, t);
  });

  // A reply is copied to the task's shadow (#99); a terminal turn on either side goes in before it.
  const catchUpWithShadow = (taskId: string) => {
    if (db.getTask(taskId)?.executionMode === "cloud") return;
    history.catchUp(taskId);
    const shadow = db.shadowTaskOf(taskId);
    if (shadow) history.catchUp(shadow.id);
  };
  const askRescue = (path: string, init: RequestInit = {}) => fetch(`${cfg.rescueUrl}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  const git = async (args: string[]) => {
    // Never a prompt for credentials (a fetch of tags from an SSH remote would hang the firing), and a time limit.
    const p = Bun.spawn(["git", "-C", cfg.repoRoot, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" } });
    const timer = setTimeout(() => p.kill(), 30_000);
    try {
      const out = (await new Response(p.stdout).text()).trim();
      const code = await p.exited;
      if (code !== 0) throw Object.assign(new Error(`git ${args.join(" ")} failed in ${cfg.repoRoot}`), { exitCode: code });
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
  // content-length so the request's bytes can be recorded (#2101) without reading the body again
  const json = (data: unknown, status = 200) => {
    const body = JSON.stringify(data);
    return new Response(body, { status, headers: { "content-type": "application/json;charset=utf-8", "content-length": String(Buffer.byteLength(body)) } });
  };
  const bad = (message: string, status = 400) => Response.json({ error: message }, { status });
  const artifactResult = (f: () => Response): Response => {
    try {
      return f();
    } catch (e) {
      return e instanceof ArtifactError ? bad(e.message, e.status) : bad(String((e as Error).message ?? e), 500);
    }
  };
  /** A backlog Issue in a path (#886): its number, or the local id of one made here. */
  const issueRef = (p: string): number | string => (/^\d+$/.test(p) ? Number(p) : p);
  /**
   * What the daemon answers when something it depends on (gh / GitHub, sb-rescue) failed. Never 502/504: on the cloud
   * host CloudFront replaces an origin's 502/504 with the "stopped" start page, and the app then leaves for the login page.
   */
  const UPSTREAM_FAILED = 424;
  /** The largest Webhook delivery read (#887): GitHub's Issue payloads are a few KiB; a larger body is refused unread. */
  const WEBHOOK_MAX_BYTES = 64 * 1024;
  /** A request's body, or null once it is longer than `max` bytes (read no further). */
  const readCapped = async (req: Request, max: number): Promise<Uint8Array | null> => {
    if (Number(req.headers.get("content-length") ?? 0) > max) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of req.body ?? []) {
      size += chunk.byteLength;
      if (size > max) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const readJson = async <T>(req: Request, parse: (x: unknown) => T): Promise<T> => parse(await req.json().catch(() => ({})));

  // Every /api route except health goes through the token check when off-loopback.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyHandler = (req: any, srv: any) => any;
  // The strongest operations (#1491): a request that came in on the cookie also needs the Starter's 5-minute passkey
  // check (`sb_recent`, #497), as sb-rescue's screen does. A token (this machine, a Mac) is unchanged: `session` is unset.
  const recentRefusal = (req: Request, session: string | undefined) =>
    session !== undefined && !recentOk(req, cfg.sessionPublicKey, session) ? json({ error: "操作の前にパスキーで確かめてください", reason: "recent" }, 401) : null;
  // `authorize` again (the answer is kept): a session that ended while the body was still arriving is refused, not taken for a token.
  const recentCheck = async (req: Request, srv: Peer) => {
    const auth = await authorize(req, srv);
    return auth.ok ? recentRefusal(req, auth.session) : json({ error: "unauthorized" }, 401);
  };
  const strong = (fn: AnyHandler): AnyHandler => async (req, srv) => (await recentCheck(req, srv)) ?? fn(req, srv);
  /**
   * Making or changing a saved answer policy (#938) lasts past one answer, so it is a person's: it needs the passkey check
   * of `strong`, and it is refused to a Task. A runner can read the daemon's token, so a token is taken only from the web
   * UI's own page (this origin and Sec-Fetch-Site: same-origin); on the cloud host, where the passkey login is on, only the
   * cookie counts. Without the passkey login that is a check on how the request looks, not a proof: a Task on this machine,
   * which runs as the same user, can forge both headers (docs/design/asks.md). Answers a Task gives to its own approval are unchanged (#936): they allow one thing, once.
   */
  const humanCheck = async (req: Request, srv: Peer): Promise<Response | null> => {
    const auth = await authorize(req, srv);
    if (!auth.ok) return json({ error: "unauthorized" }, 401);
    const recent = recentRefusal(req, auth.session);
    if (recent) return recent;
    // the browser adds Sec-Fetch-Site itself and a page cannot change it; a Task's curl has to forge it with the origin
    const fromPage = !!req.headers.get("origin") && sameOrigin(req) && req.headers.get("sec-fetch-site") === "same-origin";
    if (auth.session === undefined && (cfg.sessionPublicKey || !fromPage)) return json({ error: "回答の方針は画面（ブラウザ）から作ります。Task のトークンからは作れません", reason: "human" }, 403);
    return null;
  };
  const dangerMode = (runner: string, mode: string | undefined) => !!mode && adapterMap.get(runner as RunnerId)?.permissionModes?.find((m) => m.value === mode)?.danger === true;
  const viaEdge = (req: Request, srv: Peer) =>
    edgeOk(req, cfg.edgeHeaderValue, peerOf(req, srv));
  const notViaEdge = () => json({ error: "配信元を経由してください" }, 403);
  const notAllowedHost = () => json({ error: `host not allowed: open http://127.0.0.1:${server?.port ?? cfg.port} or set SWITCHBOARD_PUBLIC_URL` }, 403);
  // The request log (#1490), only where a login guards the daemon (off loopback). The client is CloudFront's viewer
  // address, believed only on a request that carried the shared header; otherwise the connection's peer.
  const clientOf = (req: Request, srv: Peer) => {
    // the header itself must match (peer left out): a loopback peer is let through by viaEdge without one
    const viewer = cfg.edgeHeaderValue && edgeOk(req, cfg.edgeHeaderValue, undefined) ? req.headers.get("cloudfront-viewer-address") : null;
    return viewer || peerOf(req, srv);
  };
  // Failed entrances and logins per address (#1492), the Starter's rule: 10 in 10 minutes, then 429 for everything.
  // Not counted: this machine's own peers (the runners' /mcp, sb-rescue's probe), and on the cloud host a request
  // without CloudFront's viewer address (until it is delivered everyone looks like one address and would lock out
  // the person). Only refusals made by the entrance and the guards go through `refused`, never a handler's 403.
  const failures = makeFailureLimit();
  const limitKeyOf = (req: Request, srv: Peer): string | undefined => {
    const peer = peerOf(req, srv);
    if (peer && isLoopbackAddress(peer)) return undefined;
    if (cfg.edgeHeaderValue && !req.headers.get("cloudfront-viewer-address")) return undefined;
    // clientOf is CloudFront's viewer address ("ip:port", IPv6 bracketed or not; believed only with the shared header)
    // or else the connection's peer, a bare address
    const from = clientOf(req, srv);
    if (!from) return undefined;
    return addressKey(from === peer ? from : from.slice(0, from.lastIndexOf(":")).replace(/^\[|\]$/g, ""));
  };
  const refused = (req: Request, srv: Peer, res: Response): Response => {
    const key = limitKeyOf(req, srv);
    if (key) failures.failed(key);
    return res;
  };
  const limitedGuard = (h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
    const wrap = (fn: AnyHandler): AnyHandler => (req, srv) => {
      const key = limitKeyOf(req, srv);
      return key && failures.limited(key) ? bad("too many failed attempts; wait and try again", 429) : fn(req, srv);
    };
    if (typeof h === "function") return wrap(h);
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
  };
  const logOp = (req: Request, srv: Peer, op: string, extra: { task?: string; detail?: unknown } = {}, from = clientOf(req, srv)) => {
    if (authRequired) console.log(opLine({ t: Date.now(), from, op, ...extra }));
  };
  // Every guardAll route's time and size go to api_requests (#2101), written every 10 s; `route` = the route's key, so
  // the fallback `fetch` (route null: static files, unknown paths) is not recorded. The access log stays the cloud host's.
  let apiRequests: ApiRequestRow[] = [];
  let apiRequestsFailed = false;
  const flushApiRequests = () => {
    if (apiRequests.length === 0) return;
    const rows = apiRequests;
    apiRequests = [];
    try {
      db.insertApiRequests(rows);
    } catch (e) {
      // a timing record is not worth the daemon (a lock held past the busy timeout): drop the batch, say it once
      if (!apiRequestsFailed) console.warn(`api_requests: write failed (${String((e as Error).message ?? e)})`);
      apiRequestsFailed = true;
    }
  };
  const apiRequestsTimer = setInterval(flushApiRequests, API_REQUESTS_FLUSH_MS);
  apiRequestsTimer.unref();
  const logged = (route: string | null, h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
    if (!authRequired && route === null) return h;
    const wrap = (fn: AnyHandler): AnyHandler => async (req, srv) => {
      const t0 = performance.now();
      // read before the handler runs: a socket's peer is gone once it has been upgraded
      const who = authRequired ? { from: clientOf(req, srv), method: req.method, path: new URL(req.url).pathname.replace(/^(\/artifacts\/)[^/]*/, "$1<key>"), auth: authKind(req) } : null;
      const done = (status: number, res?: Response) => {
        const ms = performance.now() - t0;
        if (who) console.log(accessLine({ t: Date.now(), ...who, status, ms }));
        // a WebSocket upgrade's time is not a request's speed
        if (route !== null && status !== 101) apiRequests.push({ ts: Date.now(), method: req.method, route, status, ms, bytes: Number(res?.headers.get("content-length")) || null });
      };
      try {
        const res = await fn(req, srv);
        if (res instanceof Response) done(res.status, res);
        else done(101); // undefined = a WebSocket upgrade
        return res;
      } catch (e) {
        done(500);
        throw e;
      }
    };
    if (typeof h === "function") return wrap(h);
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
  };
  // The entrance of every route: the CDN's header (#181), then the Host on loopback (#1135).
  const entryGuard = (h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
    const wrap = (fn: AnyHandler): AnyHandler => (req, srv) => (!viaEdge(req, srv) ? refused(req, srv, notViaEdge()) : !hostOk(req) ? refused(req, srv, notAllowedHost()) : fn(req, srv));
    if (typeof h === "function") return wrap(h);
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
  };
  const guard = (h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
    const wrap = (fn: AnyHandler): AnyHandler => async (req, srv) => {
      if (!sameOrigin(req)) return refused(req, srv, bad("cross-origin request refused", 403));
      if (await authorized(req, srv)) return fn(req, srv);
      return refused(req, srv, bad(cfg.sessionPublicKey ? "unauthorized: log in with the passkey (/_auth/)" : "unauthorized: set Authorization: Bearer <~/.switchboard/token>", 401));
    };
    if (typeof h === "function") return wrap(h);
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
  };

  server = Bun.serve({
    hostname: cfg.host,
    port: opts.port ?? cfg.port,
    // #441: Bun's default 10 s cut a response still waiting on GitHub (backlog, answer, start) → CloudFront 502 → stopped page → Home.
    idleTimeout: 120,
    // One upload may carry MAX_ATTACHMENTS_PER_REQUEST files of MAX_ATTACHMENT_BYTES each (#125), plus multipart overhead.
    maxRequestBodySize: MAX_ATTACHMENTS_PER_REQUEST * MAX_ATTACHMENT_BYTES + 1024 * 1024,
    routes: guardAll({
      // Open so the UI can learn whether a token is needed; paths and runner details only for authorized callers.
      "/api/health": async (req, srv) => {
        // `login` tells the UI how a person gets in before it is authorized: the cloud host's passkey page (#211) or the token.
        const login = cfg.sessionPublicKey ? "passkey" : "token";
        if (!(await authorized(req, srv))) return json({ ok: true, protocol: PROTOCOL_VERSION, authRequired, login });
        // /api/health is open to other origins (the UI learns whether a token is needed); a forced run is not.
        await refreshLogins(new URL(req.url).searchParams.has("recheck") && sameOrigin(req));
        return json({ ok: true, protocol: PROTOCOL_VERSION, login, runners: runnerInfo(), home: cfg.home, homeDisplay: cfg.homeDisplay, homeIsTemp: cfg.homeIsTemp, repoRoot: cfg.repoRoot, authRequired, features: { pty: pty !== null }, archive: archiveProblem(cfg.home), routing: { llm: { ...settings().routing.llm, available: adapterMap.has(settings().routing.llm.runner) } }, mcp: { base: `${publicUrl()}/mcp/<taskId>` } });
      },

      // Settings the UI can change (#58). A saved default mode must be one the runner offers and must not skip
      // approvals (danger modes are a per-task choice, never a default — schedules run unattended on the default);
      // null clears it, also for a runner that is no longer detected.
      // A runner's own login, from the screen (#354). The pasted code goes to the CLI's stdin only.
      "/api/runners/:id/login": {
        GET: (req) => {
          const v = runnerLogins.get(req.params.id as RunnerId);
          return v ? json(v) : bad("no login in progress", 404);
        },
        POST: async (req) => {
          const t = loginTarget(req.params.id ?? "");
          if (!t) return bad(`runner "${req.params.id}" has no login here`, 404);
          return json(await runnerLogins.start(t.runner, t.argv, t.hosts));
        },
        DELETE: (req) => {
          const v = runnerLogins.cancel(req.params.id as RunnerId);
          return v ? json(v) : bad("no login in progress", 404);
        },
      },
      "/api/runners/:id/login/code": {
        POST: async (req) => {
          const body = (await req.json().catch(() => ({}))) as { code?: unknown };
          if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 2000) return bad("code must be a non-empty string");
          const v = await runnerLogins.submit(req.params.id as RunnerId, body.code);
          return v ? json(v) : bad("no login in progress", 404);
        },
      },
      "/api/settings": {
        GET: () => json({ ...settings(), runners: runnerInfo(), defaults: tunableDefaults() }),
        PATCH: strong(async (req, srv) => {
          const parsed = SettingsPatch.safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          const next = settings();
          for (const [runner, mode] of Object.entries(parsed.data.defaultPermissionMode ?? {})) {
            if (mode === null) {
              delete next.defaultPermissionMode[runner];
              continue;
            }
            const adapter = adapterMap.get(runner as RunnerId);
            if (!adapter) return bad(`runner "${runner}" is not installed`);
            const why = tasks.checkPermissionMode(runner as RunnerId, mode);
            if (why) return bad(why);
            if (adapter.permissionModes?.find((m) => m.value === mode)?.danger) return bad(`"${mode}" skips approvals and cannot be a default; choose it per task`);
            next.defaultPermissionMode[runner] = mode;
          }
          for (const [runner, on] of Object.entries(parsed.data.autoResume ?? {})) {
            if (on === null || on === false) {
              delete next.autoResume[runner];
              continue;
            }
            if (!adapterMap.has(runner as RunnerId)) return bad(`runner "${runner}" is not installed`);
            next.autoResume[runner] = true;
          }
          // LLM routing suggestions (#25): a partial patch; the runner must be detected because the suggestion is
          // produced by that runner's own adapter. Enabling it spends that subscription's quota per task creation.
          if (parsed.data.routing?.llm) {
            const patch = parsed.data.routing.llm;
            if (patch.runner !== undefined && !adapterMap.has(patch.runner)) return bad(`runner "${patch.runner}" is not installed`);
            next.routing = { ...next.routing, llm: { ...next.routing.llm, ...patch } };
            if (next.routing.llm.enabled && !adapterMap.has(next.routing.llm.runner)) return bad(`runner "${next.routing.llm.runner}" is not installed`);
          }
          // Shadow run (#99): the default shadow runner must be detected; null switches the default off.
          if (parsed.data.shadowRunner !== undefined) {
            if (parsed.data.shadowRunner !== null && !adapterMap.has(parsed.data.shadowRunner)) return bad(`runner "${parsed.data.shadowRunner}" is not installed`);
            next.shadowRunner = parsed.data.shadowRunner;
          }
          // The automatic judgement (#493): a partial patch; a runner that is not detected cannot be chosen
          if (parsed.data.judge) {
            const patch = parsed.data.judge;
            if (patch.runner !== undefined && !adapterMap.has(patch.runner)) return bad(`runner "${patch.runner}" is not installed`);
            next.judge = { ...next.judge, ...patch };
          }
          // The rubric judge (#1219): on / off only; the runner and model are the judge's
          if (parsed.data.evals?.judge?.enabled !== undefined) next.evals = { ...next.evals, judge: { ...next.evals.judge, enabled: parsed.data.evals.judge.enabled } };
          // The Tasks that start by themselves (#832): the runner must be detected. A runner change without a model
          // goes back to that runner's CLI default (a model belongs to one runner); so does the effort (#833). A sent
          // effort must be one the runner lists; a kept one is not checked again (startMetaTask drops it if stale).
          // A kind's own choice (#1337) follows the same rules over that kind's saved one, else over the common
          // values; null removes it (back to the common values). The common runner's change leaves the kinds alone.
          if (parsed.data.autoStart) {
            const { byKind, ...patch } = parsed.data.autoStart;
            if (patch.runner !== undefined && !adapterMap.has(patch.runner)) return bad(`runner "${patch.runner}" is not installed`);
            // the fallback order (#834) is replaced whole; a runner it adds must be detected. One already in the saved
            // order may stay while it is not detected (fallbackRunner skips it), so the order can still be edited around it.
            const missing = patch.fallback?.find((r) => !adapterMap.has(r) && !next.autoStart.fallback.includes(r));
            if (missing) return bad(`runner "${missing}" is not installed`);
            const runnerChanged = patch.runner !== undefined && patch.runner !== next.autoStart.runner;
            next.autoStart = { ...next.autoStart, ...(runnerChanged ? { model: "", effort: "" } : {}), ...patch };
            const why = patch.effort ? tasks.checkEffort(next.autoStart.runner, patch.effort) : undefined;
            if (why) return bad(why);
            for (const kind of AutoStartKind.options) {
              const kindPatch = byKind?.[kind];
              if (kindPatch === undefined) continue;
              if (kindPatch === null) {
                delete next.autoStart.byKind[kind];
                continue;
              }
              if (kindPatch.runner !== undefined && !adapterMap.has(kindPatch.runner)) return bad(`runner "${kindPatch.runner}" is not installed`);
              const { runner, model, effort } = next.autoStart.byKind[kind] ?? next.autoStart;
              const kindRunnerChanged = kindPatch.runner !== undefined && kindPatch.runner !== runner;
              const choice = { runner, model, effort, ...(kindRunnerChanged ? { model: "", effort: "" } : {}), ...kindPatch };
              const kindWhy = kindPatch.effort ? tasks.checkEffort(choice.runner, kindPatch.effort) : undefined;
              if (kindWhy) return bad(kindWhy);
              next.autoStart.byKind[kind] = choice;
            }
          }
          // backlog-next's slots (#561): read by each firing, so the next one uses them
          if (parsed.data.backlogSweep) next.backlogSweep = { ...next.backlogSweep, ...parsed.data.backlogSweep };
          // The tunables (#835): a partial patch over the saved group, null = the whole group back to the defaults.
          // Read on every use, so the next use takes the new value without a restart.
          const defaults = tunableDefaults();
          const { quotaAndResume: qr, judgeAndChoice: jc, newDefaults: nd } = parsed.data;
          if (qr !== undefined) next.quotaAndResume = qr === null ? defaults.quotaAndResume : { ...next.quotaAndResume, ...qr };
          if (jc !== undefined) next.judgeAndChoice = jc === null ? defaults.judgeAndChoice : { ...next.judgeAndChoice, ...jc };
          if (nd !== undefined) next.newDefaults = nd === null ? defaults.newDefaults : { ...next.newDefaults, ...nd };
          if (next.quotaAndResume.retryMaxDelayMs < next.quotaAndResume.retryDelayMs) return bad("retryMaxDelayMs must not be shorter than retryDelayMs");
          if (jc?.judgeFallbackRunner !== undefined && !adapterMap.has(jc.judgeFallbackRunner)) return bad(`runner "${jc.judgeFallbackRunner}" is not installed`);
          if (nd?.taskRunner !== undefined && !adapterMap.has(nd.taskRunner)) return bad(`runner "${nd.taskRunner}" is not installed`);
          if (nd?.scheduleCron !== undefined) {
            try {
              parseCron(nd.scheduleCron);
            } catch (e) {
              return bad(String((e as Error).message ?? e));
            }
          }
          // Model prices (#1402): a blank model name is refused; null drops the row (back to pricing.json's row)
          for (const [model, row] of Object.entries(parsed.data.prices ?? {})) {
            const name = model.trim();
            if (!name) return bad("model name is empty");
            if (row === null) delete next.prices[name];
            else next.prices[name] = row;
          }
          db.setSetting(SETTINGS_KEY, next);
          logOp(req, srv, "settings.update", { detail: { keys: Object.keys(parsed.data) } });
          return json({ ...next, runners: runnerInfo(), defaults });
        }),
      },

      "/api/schedules": {
        GET: () => json(scheduler.list()),
        POST: async (req) => {
          const parsed = ScheduleInput.safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          try {
            return json(scheduler.create(parsed.data), 201);
          } catch (e) {
            return bad(String((e as Error).message ?? e));
          }
        },
      },
      "/api/schedules/:id": {
        GET: (req) => {
          const s = db.getSchedule(String(req.params.id));
          return s ? json(s) : bad("not found", 404);
        },
        PATCH: async (req) => {
          const parsed = ScheduleInput.partial().safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          try {
            return json(scheduler.update(String(req.params.id), parsed.data));
          } catch (e) {
            return bad(String((e as Error).message ?? e), 404);
          }
        },
        DELETE: (req) => {
          if (!db.getSchedule(String(req.params.id))) return bad("not found", 404);
          scheduler.remove(String(req.params.id));
          return json({ ok: true });
        },
      },
      "/api/schedules/:id/run": {
        POST: async (req) => {
          const id = String(req.params.id);
          // secret-scan reads every repository (minutes, past the request's idle timeout) and starts no Task: answered at
          // once, its lines go to the schedules log (#775)
          if (db.getSchedule(id)?.action === "secret-scan") {
            void scheduler.runNow(id, "manual").catch((e) => scheduler.note(`secret-scan: 始められない (manual): ${String((e as Error).message ?? e)}`));
            return json({ scanning: true }, 202);
          }
          try {
            const task = await scheduler.runNow(id, "manual");
            return task ? json(task, 201) : bad("the previous run is still active, or backlog-next started nothing (see the schedules log)", 409);
          } catch (e) {
            return bad(String((e as Error).message ?? e), 404);
          }
        },
      },
      "/api/schedules/log": () => json(scheduler.recentLog()),
      /**
       * Saved instructions (#940, docs/design/presets.md). Expanding builds the text to put in the request / reply box and
       * writes nothing: the Task is created or the reply sent by POST /api/tasks / send as before, approval and all.
       */
      "/api/presets": {
        GET: () => json({ presets: readPresets(db).sort((a, b) => b.updatedAt - a.updatedAt) } satisfies PresetList),
        POST: async (req) => {
          const parsed = PresetInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const list = readPresets(db);
          const refused = checkPreset(parsed.data, list);
          if (refused) return bad(refused.error, refused.status);
          const now = Date.now();
          const p: Preset = { ...parsed.data, id: `pre_${crypto.randomUUID().slice(0, 12)}`, createdAt: now, updatedAt: now };
          writePresets(db, [...list, p]);
          return json(p, 201);
        },
      },
      "/api/presets/:id": {
        PATCH: async (req) => {
          const parsed = PresetInput.partial().strict().safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const list = readPresets(db);
          const p = list.find((x) => x.id === String(req.params.id));
          if (!p) return bad("not found", 404);
          const next: Preset = { ...p, ...parsed.data, updatedAt: Date.now() };
          const refused = checkPreset(next, list.filter((x) => x.id !== p.id));
          if (refused) return bad(refused.error, refused.status);
          writePresets(db, list.map((x) => (x.id === p.id ? next : x)));
          return json(next);
        },
        DELETE: (req) => {
          const list = readPresets(db);
          if (!list.some((x) => x.id === String(req.params.id))) return bad("not found", 404);
          writePresets(db, list.filter((x) => x.id !== String(req.params.id)));
          return json({ ok: true });
        },
      },
      "/api/presets/:id/expand": {
        POST: async (req) => {
          const parsed = PresetExpandInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const p = readPresets(db).find((x) => x.id === String(req.params.id));
          if (!p) return bad("not found", 404);
          const ws = parsed.data.workspaceId ? db.getWorkspace(parsed.data.workspaceId) : null;
          if (parsed.data.workspaceId && !ws) return bad("workspace not found", 404);
          const raw = parsed.data.target?.trim() ?? "";
          if (!needsTarget(p)) return raw ? bad("この指示は対象を使いません。対象を空にしてください") : json(expandPreset(p, null, null));
          if (!raw) return bad("対象の Issue / PR を入れてください");
          if (!ws) return bad("Workspace を選んでください");
          const target = parseTarget(raw);
          if (!target) return bad(`対象の書き方が分かりません: ${raw.slice(0, 100)}（#12 / owner/name#12 / URL）`);
          let repo: string;
          try {
            repo = (await repoOf(opts.gh ?? runGh, ws.path)).repo;
          } catch (e) {
            return bad(`Workspace ${ws.name} のリポジトリを読めません: ${String((e as Error).message ?? e).slice(0, 200)}`, 424);
          }
          if (target.repo && target.repo.toLowerCase() !== repo.toLowerCase()) return bad(`対象 ${target.repo}#${target.number} は Workspace ${ws.name} のリポジトリ ${repo} ではありません`, 409);
          return json(expandPreset(p, repo, target.number));
        },
      },
      "/api/queue": () => json(scheduler.queue()),
      /** Unanswered permission asks across all tasks, newest first (#26: the phone-sized 承認 screen). */
      "/api/approvals": () => json(tasks.pendingApprovals()),

      /**
       * The questions waiting on the user across the Tasks and every workspace's backlog (#935, docs/design/asks.md): the
       * open ones and those answered / resolved within the day, one per question. The backlog is the stored copy, as GET
       * /api/backlog reads it without refresh — no GitHub call.
       */
      "/api/asks": async () => {
        const { backlog: b, asks } = await currentAsks();
        return json({ fetchedAt: b.fetchedAt, asks, errors: b.errors } satisfies AskList);
      },

      /** The saved answer policies (#938), newest change first. */
      "/api/policies": {
        GET: () => json({ policies: readPolicies(db).sort((a, b) => b.updatedAt - a.updatedAt) } satisfies PolicyList),
      },
      /** Edits a policy's target / conditions / expiry with the same checks as saving, or revokes / restores it (#938). */
      "/api/policies/:id": {
        PATCH: async (req, srv) => {
          const refusal = await humanCheck(req, srv);
          if (refusal) return refusal;
          const parsed = PolicyPatch.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const list = readPolicies(db);
          const p = list.find((x) => x.id === String(req.params.id));
          if (!p) return bad("not found", 404);
          const patch = parsed.data;
          const edits = patch.target !== undefined || patch.when !== undefined || patch.expiresAt !== undefined;
          if (p.scope === "once" && edits) return bad("今回のみの方針は編集できません。無効にするだけです", 409);
          const now = Date.now();
          let next: AnswerPolicy = { ...p };
          if (edits) {
            const confirmHit = approval.confirmOf(p.workspaceId, p.kind, p.op, patch.target ?? p.target);
            const checked = checkPolicy({ scope: p.scope, target: patch.target ?? p.target, when: patch.when ?? p.when, expiresAt: patch.expiresAt === undefined ? p.expiresAt : patch.expiresAt }, { subject: p.from, workspaceId: p.workspaceId, pbi: p.pbi, askId: p.askId ?? "", answer: p.answer, confirmHit, runnerRefusal: false, now });
            if (!checked.ok) return bad(checked.error);
            next = { ...next, target: checked.policy.target, when: checked.policy.when, expiresAt: checked.policy.expiresAt };
          }
          if (patch.revoked !== undefined) next = { ...next, revokedAt: patch.revoked ? (p.revokedAt ?? now) : null };
          next = { ...next, updatedAt: now };
          writePolicies(db, list.map((x) => (x.id === p.id ? next : x)));
          logOp(req, srv, "policy.edit", { detail: { id: p.id, scope: p.scope, target: next.target, revoked: next.revokedAt !== null } });
          return json(next);
        },
      },

      /**
       * Answers one question and goes on (#936, docs/design/asks.md): `{ id, answer }` as on screen. 200 = written (and the
       * work asked to go on), `ask` with its resume; `already` = it was answered before (a resend, or a second click while
       * the first was written) and nothing was written again. 409 = the question changed (AskChanged), nothing written.
       */
      "/api/asks/answer": {
        POST: async (req, srv) => {
          const parsed = AskAnswerInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const { id, answer, policy } = parsed.data;
          if (policy) {
            const refusal = await humanCheck(req, srv);
            if (refusal) return refusal;
            logOp(req, srv, "policy.save", { detail: { ask: id, scope: policy.scope, target: policy.target } });
          }
          const r = await submitAnswer(id, answer, policy);
          return json(r.body, r.status);
        },
      },

      "/api/tasks/:id/mcp": {
        GET: (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          if (t.status === "done" || t.status === "error" || t.status === "aborted") return bad("task has ended; its MCP endpoint is revoked", 409);
          return json(mcp.issue(t.id));
        },
      },

      // A Task's approval wait (#662): the kit's `device-auth` puts and deletes it, the screen reads it. The values stay
      // out of every error and log; only a Task whose runner is attached may put one.
      "/api/tasks/:id/device-auth": {
        GET: (req) => (db.getTask(String(req.params.id)) ? json(deviceAuths.get(String(req.params.id))) : bad("not found", 404)),
        POST: async (req) => {
          const id = String(req.params.id);
          if (!db.getTask(id)) return bad("not found", 404);
          const body = ((await req.json().catch(() => ({}))) ?? {}) as DeviceAuthInput;
          // after the body: a runner that ended while it was read has already had its wait cleared
          if (!tasks.isLive(id)) return bad("the task has no running runner", 409);
          try {
            return json(deviceAuths.put(id, body));
          } catch (e) {
            return bad((e as Error).message);
          }
        },
        DELETE: (req) => {
          const id = String(req.params.id);
          if (!db.getTask(id)) return bad("not found", 404);
          deviceAuths.clear(id);
          return json(null);
        },
      },

      "/api/tasks/:id/mcp/rotate": {
        POST: async (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          if (t.status === "done" || t.status === "error" || t.status === "aborted") return bad("task has ended", 409);
          return json(await mcp.rotate(t.id));
        },
      },

      // Staged writes (#11): list, apply (re-checks scope and that the file did not move on), reject.
      // Ownership is checked before anything is touched: a staged id must belong to the task in the URL.
      "/api/tasks/:id/staging": (req) => {
        const t = db.getTask(String(req.params.id));
        if (!t) return bad("not found", 404);
        const status = new URL(req.url).searchParams.get("status");
        // before/after are large; the list carries the diff and stat, the full texts are in the diff already.
    return json(staging.list(t.id).filter((c) => !status || c.status === status).map(({ before: _b, after: _a, ...rest }) => rest));
      },
      "/api/tasks/:id/staging/:sid/apply": {
        POST: (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const c = db.getStaged(String(req.params.sid));
          if (!c) return bad("staged change not found", 404);
          if (c.taskId !== t.id) return bad("staged change belongs to another task", 403);
          try {
            const applied = staging.apply(c.id, mcp.scopeOf(t));
            return json(applied);
          } catch (e) {
            return bad(String((e as Error).message ?? e), (e as { code?: string }).code === "ECONFLICT" ? 409 : 400);
          }
        },
      },
      "/api/tasks/:id/staging/:sid/reject": {
        POST: (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const c = db.getStaged(String(req.params.sid));
          if (!c) return bad("staged change not found", 404);
          if (c.taskId !== t.id) return bad("staged change belongs to another task", 403);
          try {
            return json(staging.reject(c.id));
          } catch (e) {
            return bad(String((e as Error).message ?? e));
          }
        },
      },

      // the per-task tokens too count only from this machine on the cloud host (#748): the runners call 127.0.0.1
      "/mcp/:id": (req, srv) => (tokenCounts(req, srv) ? mcp.handle(String(req.params.id), tokenFromRequest(req, true), req) : refused(req, srv, bad("unauthorized", 401))),

      "/api/workspaces": {
        GET: () => json(db.listWorkspaces()),
        /**
         * `backlog`: `switchboard` keeps the workspace's backlog in Switchboard only (#2265): its source is set now and
         * stored as an empty import, so it reads as current and nothing asks GitHub. Absent = `github` (a path already
         * registered keeps its own). A path already registered with the other one is 409 (switching is #2266).
         */
        POST: strong(async (req, srv) => {
          const body = await readJson(req, (x) => x as { path?: string; name?: string; backlog?: unknown });
          if (!body.path || !existsSync(body.path)) return bad("path must exist");
          // absent = github; any other value (null too) is refused
          const backlogAt = body.backlog === undefined ? "github" : body.backlog;
          if (backlogAt !== "github" && backlogAt !== "switchboard") return bad('backlog must be "github" or "switchboard"');
          const had = db.listWorkspaces().find((w) => w.path === body.path);
          if (had && body.backlog !== undefined && had.backlog !== backlogAt) return bad(`この workspace のバックログは ${had.backlog} に置いています。切り替えは #2266 です`, 409);
          let ws = db.upsertWorkspace({ path: body.path, name: body.name ?? basename(body.path), kind: "repo" });
          if (backlogAt === "switchboard" && !had) {
            const source = localBacklogSource(ws.id);
            db.setWorkspaceBacklogSource(ws.id, source);
            db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: Date.now() });
            ws = db.getWorkspace(ws.id)!;
          }
          logOp(req, srv, "workspace.add", { detail: { path: body.path, backlog: backlogAt } });
          return json(ws, 201);
        }),
      },

      /**
       * A workspace's settings. `projectVar`: the repository variable its Project URL is under, for the backlog (null =
       * SWITCHBOARD_PROJECT_URL). Only the name is kept; the URL stays in the repository.
       */
      "/api/workspaces/:id": {
        PATCH: async (req) => {
          const id = String(req.params.id);
          if (!db.getWorkspace(id)) return bad("not found", 404);
          const body = await readJson(req, (x) => x as { projectVar?: unknown });
          // a backlog kept here only (#2265) reads no GitHub Project
          if (db.getWorkspace(id)!.backlog === "switchboard" && body.projectVar !== undefined) return bad("この workspace のバックログは Switchboard に置いているので、GitHub の Project は読みません", 409);
          const v = typeof body.projectVar === "string" ? body.projectVar.trim() : body.projectVar;
          if (v !== null && v !== "" && (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))) return bad("projectVar must be a repository variable name (letters, digits, _) or null");
          const next = v ? v : null;
          // the same name again keeps the stored backlog; another one forgets its source until an import reads it (#885)
          if ((db.getWorkspace(id)!.projectVar ?? null) === next) return json(db.getWorkspace(id));
          const ws = db.setWorkspaceProjectVar(id, next);
          // not an import begun with the old variable: it does not write its source back (backlog-sync.ts)
          if (ws && existsSync(ws.path)) backlog.wrote(ws);
          return json(ws);
        },
      },

      /** The prompt prefix Home puts before an improvement request; written per workspace (meta = Switchboard's own map). */
      "/api/workspaces/:id/brief": (req) => {
        const ws = db.getWorkspace(String(req.params.id));
        if (!ws) return bad("not found", 404);
        return json({ workspaceId: ws.id, text: workspaceBrief(ws) });
      },

      /**
       * Open requests and PBIs of every registered workspace's repository and the stage each is at (#264, #294), as the
       * last import stored them (#885): no GitHub call, no wait. A workspace never imported is in `errors` (its import is
       * asked for, see `storedBacklog`); one whose import failed keeps its stored items and has the reason there. ?refresh=1 (the screen's 再読込) imports
       * every workspace first and answers what is stored then — a failed import (a limit, an outage) still answers the
       * stored copy, with the reason.
       */
      "/api/backlog": {
        GET: async (req) => json(await readBacklog(new URL(req.url).searchParams.get("refresh") === "1")),
        /** A new Issue in the workspace's repository (#886): stored here (202, its `localId` and `number`) and created on GitHub later. */
        POST: async (req) => {
          const parsed = BacklogCreateInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const { workspaceId, ...input } = parsed.data;
          const source = db.getWorkspaceBacklogSource(workspaceId);
          if (!db.getWorkspace(workspaceId)) return bad("workspace not found", 404);
          if (!source) return bad("まだ GitHub から取り込んでいません", 409);
          try {
            // a backlog kept here only (#2265) has no service to refuse a parent that is not there, and its fields take
            // the choices of the workspace's ops.config.json
            if (source.service === "switchboard") {
              checkLocalParent(db, source, input.parent);
              input.fields = checkLocalFields(db.getWorkspace(workspaceId)!.path, input) ?? null;
            }
            const made = createStoredIssue(db, source, input);
            backlog.send(db.getWorkspace(workspaceId)!);
            // a backlog kept here only (#2265) numbers it at once; GitHub's numbers it once it is sent (null until then)
            const number = readStoredIssue(db, { id: workspaceId }, made.localId)?.issue.number || null;
            return json({ ...made, number }, 202);
          } catch (e) {
            if (e instanceof BacklogEditError) return bad(e.message, e.status);
            throw e;
          }
        },
      },

      /** People's interventions and why work stopped, the last 7 and 30 days against the period before each (#651). Counted at each look from the records and the stored Issues: no GitHub call. */
      "/api/interventions": {
        GET: () => json(interventionView(db, db.listWorkspaces())),
      },

      /** How long the PBIs closed in the last 30 days took, stage by stage, and in the 30 days before (#651). Held for an hour; ?refresh=1 reads again. */
      "/api/flow": {
        GET: async (req) => json(await flow.get(new URL(req.url).searchParams.get("refresh") === "1")),
      },

      /**
       * A GitHub Webhook delivery (#887): open without the token (GitHub cannot carry it) once the user opened it
       * (`cfg.githubWebhook` and `cfg.githubWebhookSecret`; else the token is asked as anywhere). The delivery must carry
       * X-Hub-Signature-256, the HMAC-SHA256 of the body under the Secret (#1493); a missing or wrong one is 401 and
       * starts nothing. It is only a notice — the
       * workspaces of the repository / Project it names are imported (BacklogSync.hint: at most one per minute each,
       * ten in all), and nothing of the payload is stored or followed. The body is read up to 64 KiB. The answer is the
       * same whether it named any (nothing about what is registered is told). The cloud host's edge check still applies.
       */
      "/api/backlog/webhooks/github": {
        POST: async (req) => {
          if (!sameOrigin(req)) return bad("cross-origin request refused", 403);
          const body = await readCapped(req, WEBHOOK_MAX_BYTES);
          if (body === null) return bad("too large", 413);
          if (!webhookSigned(body, req.headers.get("x-hub-signature-256"), cfg.githubWebhookSecret ?? "")) return bad("signature does not match", 401);
          let payload: unknown;
          try {
            payload = JSON.parse(new TextDecoder().decode(body));
          } catch {
            return bad("not JSON", 400);
          }
          const all = db.listWorkspaces();
          const targets = new Set(noticeTargets(payload, all.map((w) => ({ id: w.id, source: db.getWorkspaceBacklogSource(w.id) }))));
          for (const ws of all) if (targets.has(ws.id) && existsSync(ws.path)) backlog.hint(ws);
          return json({ accepted: true }, 202);
        },
      },

      /**
       * Brings one workspace's stored backlog up to date (#918, the kit's `backlog … --fresh`): what is kept here is sent,
       * then the repository is imported (`BacklogSync.settle`). 200 once stored (read it then with GET); 424 with the reason when GitHub cannot be
       * read now (a limit, an outage) — the kit then answers what is stored, said to be not synced (#2264).
       */
      "/api/backlog/sync": {
        POST: async (req) => {
          const parsed = BacklogSyncInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const ws = db.getWorkspace(parsed.data.workspaceId);
          if (!ws) return bad("workspace not found", 404);
          if (!existsSync(ws.path)) return bad("workspace directory does not exist", 409);
          try {
            await backlog.settle(ws);
          } catch (e) {
            return bad((e as Error).message, UPSTREAM_FAILED);
          }
          return json({ workspaceId: ws.id });
        },
      },

      /**
       * The stored records of one workspace (#919): what the kit's lint and parallel guard read instead of asking GitHub
       * (`readStoredRecords`). 409 = never imported (nothing is read as current); bring it up to date with POST /sync first.
       */
      "/api/backlog/records": {
        GET: (req) => {
          const ws = db.getWorkspace(new URL(req.url).searchParams.get("workspaceId") ?? "");
          if (!ws) return bad("workspace not found", 404);
          const records = readStoredRecords(db, ws);
          return records ? json(records) : bad("まだ GitHub から取り込んでいません", 409);
        },
      },

      /**
       * One stored Issue (#885): body, comments and the Project's fields as shown (with the edits not sent yet, #886),
       * without asking GitHub. `:number` is its number, or the local id of an Issue made here. 404 = not stored.
       */
      "/api/backlog/:number": {
        GET: (req) => {
          const ws = db.getWorkspace(new URL(req.url).searchParams.get("workspaceId") ?? "");
          if (!ws) return bad("workspace not found", 404);
          const detail = readStoredIssue(db, ws, issueRef(req.params.number ?? ""), { importFailed: backlog.importError(ws) !== null });
          return detail ? json(detail) : bad(`#${req.params.number} は保存されていません`, 404);
        },
        /**
         * Edits it (#886): stored here at once (202, the operations) and sent to GitHub later. Or, with `resolve` alone,
         * a choice on a held conflict (#887): 202 with the operation, 409 when none is held there or it moved since read.
         */
        PATCH: async (req) => {
          const parsed = BacklogEditInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const { workspaceId, ...input } = parsed.data;
          if (!db.getWorkspace(workspaceId)) return bad("workspace not found", 404);
          const source = db.getWorkspaceBacklogSource(workspaceId);
          if (!source) return bad("まだ GitHub から取り込んでいません", 409);
          try {
            const { resolve, ...edit } = input;
            if (source.service === "switchboard") {
              // the Issue's own number, whether named by it or by its local id
              checkLocalParent(db, source, edit.parent, readStoredIssue(db, { id: workspaceId }, issueRef(req.params.number ?? ""))?.issue.number);
              edit.fields = checkLocalFields(db.getWorkspace(workspaceId)!.path, edit);
            }
            const edited = resolve ? resolveStoredConflict(db, source, issueRef(req.params.number ?? ""), resolve) : editStoredIssue(db, source, issueRef(req.params.number ?? ""), edit);
            backlog.send(db.getWorkspace(workspaceId)!);
            return json(edited, 202);
          } catch (e) {
            if (e instanceof BacklogEditError) return bad(e.message, e.status);
            throw e;
          }
        },
      },

      /**
       * Answers a needs-decision item (#266): `## 回答` on the Issue, then its label off — stored here at once (202) and
       * sent to GitHub in that order (#886), so an answer is not lost while GitHub cannot be reached. With `confirm`,
       * answers one confirmation of an in-progress PBI instead (#523; `answerStoredConfirmation`).
       */
      "/api/backlog/:number/answer": {
        POST: async (req) => {
          const parsed = BacklogAnswerInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const ws = db.getWorkspace(parsed.data.workspaceId);
          if (!ws) return bad("workspace not found", 404);
          if (!existsSync(ws.path)) return bad("workspace directory does not exist", 409);
          const n = Number(req.params.number);
          const stored = storedBacklog(ws);
          if (stored.fetchedAt === null) return bad(stored.error ?? "まだ GitHub から取り込んでいません", UPSTREAM_FAILED);
          const source = db.getWorkspaceBacklogSource(ws.id)!;
          const item = stored.items.find((i) => i.number === n);
          if (!item) return bad(`#${req.params.number} はバックログにありません`, 404);
          const { confirm } = parsed.data;
          try {
            if (confirm) {
              // a confirmation of an in-progress PBI (#523): that line of its body as stored, the body it is sent with (#886)
              const c = item.confirmations.find((x) => x.n === confirm.n);
              if (!c) return bad(`#${n} に確認待ちの受け入れ条件 ${confirm.n} はありません`, 409);
              if (!answerStoredConfirmation(db, source, n, { ...c, ok: confirm.ok, reason: parsed.data.text })) return bad(`#${n} の本文が変わりました。再読込してください`, 409);
              backlog.send(ws);
              return json({ ok: true }, 202);
            }
            if (item.stage !== "needs-decision") return bad(`#${n} は判断待ちではありません`, 409);
            // a question asked on one of an in-progress PBI's Tasks is answered on that Task (#562), the one on screen only
            const asked = item.decision?.issue ?? n;
            if (parsed.data.issue !== undefined && parsed.data.issue !== asked) return bad(`#${n} の問いは #${asked} に変わりました。読み直してから回答してください`, 409);
            answerStoredDecision(db, source, asked, parsed.data.text);
            backlog.send(ws);
          } catch (e) {
            if (e instanceof BacklogEditError) return bad(e.message, e.status);
            throw e;
          }
          return json({ ok: true }, 202);
        },
      },

      /** A plain comment on a stored Issue (#910): kept here at once (202) and sent to GitHub later, as an answer is. */
      "/api/backlog/:number/comment": {
        POST: async (req) => {
          const parsed = BacklogCommentInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const ws = db.getWorkspace(parsed.data.workspaceId);
          const source = ws && db.getWorkspaceBacklogSource(ws.id);
          if (!ws) return bad("workspace not found", 404);
          if (!source) return bad("まだ GitHub から取り込んでいません", 409);
          try {
            const made = commentStoredIssue(db, source, Number(req.params.number), parsed.data.text);
            backlog.send(ws);
            return json(made, 202);
          } catch (e) {
            if (e instanceof BacklogEditError) return bad(e.message, e.status);
            throw e;
          }
        },
      },

      /**
       * Starts the next stage of one backlog item as a Task with the stage skill's fixed prompt (#265), on the workspace
       * whose repository the Issue is in; another workspace's Task reads the skills from the meta workspace.
       */
      "/api/backlog/:number/start": {
        POST: async (req) => {
          const parsed = BacklogStartInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const ws = db.getWorkspace(parsed.data.workspaceId);
          if (!ws) return bad("workspace not found", 404);
          if (!existsSync(ws.path)) return bad("workspace directory does not exist", 409);
          const meta = metaWorkspace();
          if (ws.kind !== "meta" && !meta) return bad("meta workspace がありません（工程のスキルはそこから読みます）", 409);
          const n = Number(req.params.number);
          // the stored data is what is true (#2264): GitHub is brought up to date first when it can be reached, and a
          // limit or an outage does not hold the start
          await backlog.settle(ws).catch(() => undefined);
          const stored = storedBacklog(ws);
          if (stored.fetchedAt === null) return bad(stored.error ?? "まだ GitHub から取り込んでいません", UPSTREAM_FAILED);
          const items = stored.items;
          const item = items.find((i) => i.number === n);
          if (!item) return bad(`#${req.params.number} はバックログにありません`, 404);
          const can = canStartStoredBacklog(item);
          if (!can.ok) return bad(`#${n} は始めません: ${can.why}`, 409);
          const { action } = parsed.data;
          // 閉じる (#523) goes with closable, not with a stage; complete on an in-progress item is backlog-next's resume
          // of a stalled one (#578), started from a waiting row's 続きを始める (#1045)
          const resume = action === "complete" && item.stage === "in-progress";
          if (action === "close" ? !item.closable : !(ACTION_FOR_STAGE[item.stage] === action || resume)) return bad(`#${n} は ${item.stage}${action === "close" ? "（閉じられない）" : ""} なので ${action} は始められません`, 409);
          const r = await startStage({ ws, meta: meta!, item, action, resume: resume ? { tasksDone: item.tasks?.done ?? 0 } : undefined });
          if ("active" in r) return json({ error: `#${n} の工程 Task が実行中です`, taskId: r.active.id }, 409);
          if ("starting" in r) return json({ error: `#${n} の工程 Task を開始しているところです`, taskId: null }, 409);
          return "task" in r ? json(r.task, 201) : bad(r.error, r.status);
        },
      },

      "/api/feedback": {
        POST: async (req) => {
          const parsed = FeedbackInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const meta = metaWorkspace();
          // no meta workspace: startMetaTask answers 409 for either mode; the brief only needs one to exist
          if (!meta) return bad("meta workspace がありません", 409);
          // a request for another workspace is filed in that repository, as its backlog stage buttons act there
          const ws = parsed.data.mode === "request" && parsed.data.workspaceId ? db.getWorkspace(parsed.data.workspaceId) : meta;
          if (!ws) return bad("workspace not found", 404);
          const other = otherRepo(meta, ws);
          const when = new Date();
          const r = await startMetaTask({
            kind: parsed.data.mode,
            ...(parsed.data.mode === "fix"
              ? { title: fixTitle(parsed.data.text), prompt: buildFixPrompt({ brief: workspaceBrief(meta), text: parsed.data.text, when, screen: parsed.data.screen }) }
              : { ws, title: feedbackTitle(parsed.data.text), prompt: buildFeedbackPrompt({ text: parsed.data.text, when, screen: parsed.data.screen, other, source: parsed.data.source }) }),
            attachmentIds: parsed.data.attachmentIds,
          });
          return "task" in r ? json(r.task, 201) : bad(r.error, r.status);
        },
      },

      "/api/tasks": {
        GET: (req) => json(db.listTasks(new URL(req.url).searchParams.get("archived") === "1")),
        POST: async (req, srv) => {
          const parsed = CreateTaskInput.safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          const cloudWhy = tasks.checkCloudInput(parsed.data);
          if (cloudWhy) return bad(cloudWhy);
          if (parsed.data.executionMode === "cloud" && parsed.data.workspaceId && !db.getWorkspace(parsed.data.workspaceId)) return bad("workspace not found", 404);
          if (parsed.data.cwd !== undefined && !existsSync(parsed.data.cwd)) return bad("cwd must exist");
          const named = parsed.data.workspaceId ? db.getWorkspace(parsed.data.workspaceId) : null;
          if (parsed.data.cwd === undefined && parsed.data.workspaceId && !named) return bad("workspace not found", 404);
          if (parsed.data.cwd === undefined && named && !existsSync(named.path)) return bad("workspace directory does not exist", 409);
          if (parsed.data.executionMode === "cloud" && named) {
            if (!existsSync(named.path)) return bad("workspace directory does not exist", 409);
            if (parsed.data.cwd !== undefined && resolve(parsed.data.cwd) !== resolve(named.path)) return bad("Cloud cwd must match the selected Workspace");
          }
          // scheduleId is meant to be set only by Scheduler.runNow() (it's what makes GET /api/queue's "scheduled"
          // section mean "what ran unattended overnight"); this route is otherwise open, so reject an arbitrary or
          // stale id here rather than silently accepting it and surfacing a misleading schedule title in the queue.
          if (parsed.data.scheduleId !== undefined && !db.getSchedule(parsed.data.scheduleId)) return bad("schedule not found");
          if (parsed.data.permissionMode !== undefined && adapterMap.has(parsed.data.runner)) {
            const why = tasks.checkPermissionMode(parsed.data.runner, parsed.data.permissionMode);
            if (why) return bad(why);
            if (dangerMode(parsed.data.runner, parsed.data.permissionMode)) {
              const refused = await recentCheck(req, srv);
              if (refused) return refused;
            }
          }
          if (parsed.data.effort && adapterMap.has(parsed.data.runner)) {
            const why = tasks.checkEffort(parsed.data.runner, parsed.data.effort);
            if (why) return bad(why);
          }
          // An explicit shadow runner (#99) is checked here so the caller learns at once; a saved default that is
          // not detected is skipped with a note on the task instead (the task itself must still start).
          if (parsed.data.shadowRunner) {
            if (parsed.data.shadowRunner === parsed.data.runner) return bad("shadowRunner must differ from runner");
            if (!adapterMap.has(parsed.data.shadowRunner)) return bad(`runner "${parsed.data.shadowRunner}" is not installed`);
          }
          if (parsed.data.attachmentIds?.length) {
            const why = attachments.check(parsed.data.attachmentIds);
            if (why) return bad(why.message, why.status);
          }
          try {
            // cwd omitted: the named Workspace's path, or — with no Workspace named either — "自動" (#135). The LLM
            // turn comes after every check above and after the runner check, so a request that cannot become a task
            // does not spend a turn first.
            if (!adapterMap.has(parsed.data.runner)) throw new Error(`runner "${parsed.data.runner}" is not installed`);
            const chosen = parsed.data.cwd === undefined && !named ? await chooseWorkspace(parsed.data) : null;
            const input = chosen ? { ...parsed.data, workspaceId: chosen.workspace.id, cwd: chosen.workspace.path, workspaceReason: chosen.reason } : { ...parsed.data, cwd: parsed.data.cwd ?? named!.path };
            const routed = input.executionMode === "cloud" ? null : await suggestForCreate(input);
            // What the suggestion turns spent belongs to the task they were asked about, under the runner that answered
            // (not the task's own runner): asking costs quota, and the Ledger is where that has to show up — also when
            // the task's own runner then fails to start, so it is billed as soon as the row exists.
            const task = tasks.create(input, routed?.suggestion, (t) => {
              for (const turn of [chosen, routed]) if (turn) for (const u of turn.usage) db.insertLedger(ledgerRowFor(pricingTable(), { id: t.id, runner: turn.runner, model: u.model ?? null }, u, Date.now()));
            });
            if (task.permissionMode && adapterMap.get(task.runner)?.permissionModes?.find((m) => m.value === task.permissionMode)?.danger) {
              logOp(req, srv, "task.create.danger", { task: task.id, detail: { runner: task.runner, mode: task.permissionMode } });
            }
            return json(task, 201);
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
        },
      },

      "/api/tasks/suggest": {
        POST: async (req) => {
          const parsed = SuggestInput.safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          const input = parsed.data;
          if (input.workspaceId && !db.getWorkspace(input.workspaceId)) return bad("workspace not found", 404);
          const cloudPreparation = input.executionMode === "cloud"
            ? input.cwd || input.workspaceId
              ? readCloudPreparation(input.cwd ?? db.getWorkspace(input.workspaceId!)!.path)
              : { repository: null, branch: null, dirty: null, unpushed: null, warnings: [cloudTransferNotice, "Cloud の開始には Workspace を明示選択してください。"] }
            : undefined;
          return json({ ...suggestFor(input), source: routing.source, problems: routing.problems, ...(cloudPreparation ? { cloudPreparation } : {}) });
        },
      },

      // Decision log (#25). JSON for the UI; `?format=jsonl` is the training-data export — one example per line,
      // newest first, so `| head -n` is a valid (if newest-biased) sample and the whole body never has to be parsed.
      "/api/routing/log": (req) => {
        const q = new URL(req.url).searchParams;
        const rows = db.routingLog(clampLimit(q.get("limit")));
        if (q.get("format") !== "jsonl") return json(rows);
        // U+2028 / U+2029 survive JSON.stringify as themselves; consumers that split on Unicode line breaks
        // (Python's str.splitlines(), some stream parsers) would see one record as several lines.
        const line = (r: RoutingLogRow) => JSON.stringify(r).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
        return new Response(rows.map(line).join("\n") + (rows.length ? "\n" : ""), { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
      },

      // Agreement rate per suggester (#25): the Ledger's ルーティング一致率 card.
      "/api/routing/stats": (req) => json(db.routingStats(clampDays(new URL(req.url).searchParams.get("days")))),

      // Terminal history (#91): status of the session-log import, and a pass on request (the UI's 今すぐ取り込む).
      "/api/history": () => json(history.status()),
      "/api/history/import": {
        POST: () => {
          try {
            return json(history.scan());
          } catch (e) {
            return bad(`scan failed: ${String((e as Error).message ?? e)}`, 500);
          }
        },
      },

      // The events (#1142): the last `limit` (200 by default; 0 = none, the rest only), or with ?before=<seq> the `limit` just
      // before that seq. ?after=<seq>: every event past that seq (the web's catch-up after a dropped WebSocket, #1137), never cut.
      // The rest is always whole.
      "/api/tasks/:id": (req) => {
        const t = db.getTask(String(req.params.id));
        if (!t) return bad("not found", 404);
        const q = new URL(req.url).searchParams;
        const before = q.has("after") ? null : q.get("before");
        if (before !== null && !(Number.isSafeInteger(Number(before)) && Number(before) > 0)) return bad("before must be a positive integer");
        const limit = q.get("limit") === "0" ? 0 : clampLimit(q.get("limit"));
        const events = q.has("after") ? db.listEvents(t.id, afterSeq(q.get("after"))) : limit === 0 ? [] : before !== null ? db.listEventsBefore(t.id, Number(before), limit) : db.listEventsTail(t.id, limit);
        return json({ task: t, mcpServers: t.runner === "claude" && t.executionMode !== "cloud" ? Object.keys(taskMcpServers(t)) : [], events, cost: db.taskCost(t.id), history: t.executionMode === "cloud" ? null : history.forTask(t.id), localContinuations: db.listLocalTasksForCloud(t.id), sourceCloudTask: t.sourceCloudTaskId ? db.getTask(t.sourceCloudTaskId) : null, attachments: attachments.listForTask(t.id), teleport: teleports.get(t.id) ?? null, stopSummary: reduceStops(stopRecordsFor(db, t)), eventsArchive: db.eventsArchiveOf(t.id) });
      },

      // "Continue locally" (#1306): starts the official Teleport without a terminal socket; progress comes as task.teleport.
      "/api/tasks/:id/teleport": {
        POST: (req) => {
          const id = String(req.params.id);
          if (!db.getTask(id)) return bad("not found", 404);
          const why = startTeleport(id);
          return why ? bad(why, 409) : json({ started: true }, 202);
        },
      },

      "/api/tasks/:id/send": {
        POST: async (req) => {
          const parsed = SendTaskInput.safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          const { text, attachmentIds } = parsed.data;
          if (!text.trim() && !attachmentIds?.length) return bad("text or attachmentIds required");
          if (attachmentIds?.length) {
            const why = attachments.check(attachmentIds);
            if (why) return bad(why.message, why.status);
          }
          try {
            catchUpWithShadow(String(req.params.id)); // a terminal turn that just finished goes in before this one
            return json(await tasks.send(String(req.params.id), text, { attachmentIds }));
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
        },
      },

      // Attachments (#125). Upload first (multipart, one or more `file` fields), then send the ids with a turn.
      "/api/attachments": {
        POST: async (req) => {
          // The whole body is buffered by formData(); an upload that cannot fit is refused from its length first.
          const declared = Number(req.headers.get("content-length") ?? 0);
          if (declared > MAX_ATTACHMENTS_PER_REQUEST * MAX_ATTACHMENT_BYTES) return bad(`upload is ${formatBytes(declared)}; max ${formatBytes(MAX_ATTACHMENT_BYTES)} per file, ${MAX_ATTACHMENTS_PER_REQUEST} files`, 413);
          const form = await req.formData().catch(() => null);
          if (!form) return bad("multipart/form-data with one or more `file` fields required");
          // Bun's FormData and the DOM lib disagree on the entry type; a non-string entry is a File either way.
          const files = form.getAll("file").filter((f) => typeof f !== "string") as unknown as File[];
          if (!files.length) return bad("no `file` field");
          if (files.length > MAX_ATTACHMENTS_PER_REQUEST) return bad(`too many files (${files.length}; max ${MAX_ATTACHMENTS_PER_REQUEST} per upload)`, 413);
          const big = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
          if (big) return bad(`${big.name} is ${formatBytes(big.size)}; max ${formatBytes(MAX_ATTACHMENT_BYTES)} per file`, 413);
          const saved = [];
          for (const f of files) saved.push(attachments.save({ name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }));
          return json(saved, 201);
        },
      },
      "/api/attachments/:id": {
        GET: async (req) => {
          const a = attachments.get(String(req.params.id));
          if (!a) return bad("not found", 404);
          const file = Bun.file(a.path);
          if (!(await file.exists())) return bad(`the file is gone (${a.path})`, 410);
          // Served on the UI's own origin: no document may run here. `sandbox` strips scripts and same-origin from
          // whatever is opened directly (an <img> is unaffected); HTML / SVG / XML additionally download instead of opening.
          return new Response(file, {
            headers: {
              "content-type": a.mime,
              "content-disposition": `${isActiveContent(a.mime) ? "attachment" : "inline"}; filename*=UTF-8''${extValue(a.name)}`,
              "content-security-policy": "sandbox",
              "cache-control": "private, max-age=3600",
              "x-content-type-options": "nosniff",
            },
          });
        },
        DELETE: (req) => {
          try {
            attachments.remove(String(req.params.id));
            return json({ ok: true });
          } catch (e) {
            return e instanceof AttachmentError ? bad(e.message, e.status) : bad(String((e as Error).message ?? e), 500);
          }
        },
      },

      // Reports across Tasks (#1835): the HTML artifacts of every task, newest first. `limit` is an integer 1..100 (default 20).
      "/api/reports": (req) => {
        const raw = new URL(req.url).searchParams.get("limit");
        // absent = 20; a supplied value (even a blank one) must be digits in range — nothing is quietly defaulted or rounded
        const limit = raw === null ? 20 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad("limit must be an integer 1..100");
        return json(db.listReports(limit));
      },
      // Artifacts (#1777): reports registered from the Task screen. Register copies the file; the original may go.
      "/api/tasks/:id/artifacts": {
        GET: (req) => (db.getTask(String(req.params.id)) ? json(artifacts.list(String(req.params.id))) : bad("not found", 404)),
        POST: async (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const body = await readJson(req, (x) => x as { source?: unknown; title?: unknown });
          if (typeof body.source !== "string" || !body.source.trim()) return bad("source (a path or an http(s) URL) required");
          return artifactResult(() => json(artifacts.add(t, { source: body.source as string, title: typeof body.title === "string" ? body.title : undefined }), 201));
        },
      },
      "/api/artifacts/:id": {
        DELETE: (req) => artifactResult(() => json(artifacts.remove(String(req.params.id)))),
      },
      "/api/artifacts/:id/restore": {
        POST: (req) => artifactResult(() => json(artifacts.restore(String(req.params.id)))),
      },
      // A viewing key for one artifact: the only way to a URL under /artifacts, and only for a caller /api lets in.
      "/api/artifacts/:id/view": {
        POST: (req) =>
          artifactResult(() => {
            const a = artifacts.get(String(req.params.id));
            if (!a || a.removedAt !== null) return bad("not found", 404);
            if (a.kind === "url" || !a.entry) return bad("a URL has nothing to view here; open it in a new tab", 400);
            return json({ url: `/artifacts/${viewKey(a.id, Date.now() + VIEW_KEY_MS)}/${a.entry.split("/").map(encodeURIComponent).join("/")}` });
          }),
      },
      // The report's own files. Outside /api: the key in the path is the authorization (the Host and edge checks still
      // apply), and the response gives the page no rights on this origin — `sandbox` without allow-same-origin makes it opaque.
      "/artifacts/:key/*": {
        GET: (req, srv) => {
          const url = new URL(req.url);
          const [, , key = "", ...rest] = url.pathname.split("/");
          const k = checkViewKey(key);
          if (!k.ok) return refused(req, srv, bad(k.status === 410 ? "this link expired; open the report again" : "forbidden", k.status));
          const a = artifacts.get(k.id);
          if (!a || a.removedAt !== null) return bad("not found", 404);
          const file = artifacts.fileOf(a, rest.join("/"));
          if (!file) return bad("not found", 404);
          return new Response(Bun.file(file), {
            headers: {
              "content-type": withCharset(artifactMime(file)),
              "content-disposition": "inline",
              "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
              "x-content-type-options": "nosniff",
              "cache-control": "private, max-age=300",
              "referrer-policy": "no-referrer",
            },
          });
        },
      },
      "/api/artifacts/:id/refresh": {
        POST: (req) =>
          artifactResult(() => {
            const a = artifacts.get(String(req.params.id));
            const t = a && db.getTask(a.taskId);
            return a && t ? json(artifacts.refresh(a.id, t)) : bad("not found", 404);
          }),
      },

      "/api/tasks/:id/permission": {
        POST: async (req) => {
          const body = await readJson(req, (x) => x as { id?: string; decision?: "allow" | "deny"; answers?: unknown });
          if (!body.id || (body.decision !== "allow" && body.decision !== "deny")) return bad("id and decision required");
          const answers = PermissionAnswers.optional().safeParse(body.answers);
          if (!answers.success) return bad("answers must map question text to a string");
          try {
            return json(tasks.respondPermission(String(req.params.id), body.id, body.decision, answers.data));
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
        },
      },

      "/api/tasks/:id/abort": {
        POST: async (req) => json(await tasks.abort(String(req.params.id))),
      },

      // Usage-limit resume (#102): continue now instead of waiting, or forget the planned resume.
      "/api/tasks/:id/resume": {
        POST: async (req) => {
          if (!db.getTask(String(req.params.id))) return bad("not found", 404);
          try {
            return json(await resumer.resumeNow(String(req.params.id)));
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
        },
        DELETE: (req) => {
          if (!db.getTask(String(req.params.id))) return bad("not found", 404);
          return json(resumer.cancel(String(req.params.id)));
        },
      },

      // Change the mode of an existing task (#58): live for Claude, next turn for Codex, resume otherwise.
      "/api/tasks/:id/permission-mode": {
        POST: async (req, srv) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const body = await readJson(req, (x) => x as { mode?: unknown });
          if (typeof body.mode !== "string" || !body.mode) return bad("mode required");
          const why = tasks.checkPermissionMode(t.runner, body.mode);
          if (why) return bad(why);
          if (dangerMode(t.runner, body.mode)) {
            const refused = await recentCheck(req, srv);
            if (refused) return refused;
          }
          try {
            return json(await tasks.setPermissionMode(t.id, body.mode));
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
        },
      },

      // Change the model of an existing task (#155): the next turn resumes the session with it. null / "" = CLI default.
      "/api/tasks/:id/model": {
        POST: async (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const model = (await readJson(req, (x) => x as { model?: unknown } | null))?.model;
          if (model !== null && typeof model !== "string") return bad("model must be a string or null");
          try {
            return json(await tasks.setModel(t.id, model?.trim() || null));
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
        },
      },

      "/api/tasks/:id/checks": {
        GET: (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const run = selfdev.last(t.id);
          return json({ run, running: selfdev.isRunning(t.id), meta: isMeta(t), current: selfdev.isCurrent(run) });
        },
        // Starts (or queues) a run and returns at once; checks.updated announces the result.
        POST: (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          if (!isMeta(t)) return bad("checks run only for tasks on the meta workspace (this repository)", 400);
          void selfdev.run(t.id).catch(() => undefined);
          return json({ run: selfdev.last(t.id), running: true, meta: true, current: false }, 202);
        },
      },

      // Restart the daemon on the current code. Gate: no task running/waiting, no check in flight, and a *current*
      // passing check run for the task — `force: true` skips the gates. Under scripts/dev.ts the daemon exits with
      // RESTART_EXIT_CODE and the supervisor respawns it; standalone it spawns a detached replacement, waits for it
      // to serve /api/health, and comes back up on the old code if that never happens.
      "/api/daemon/restart": {
        POST: strong(async (req, srv) => {
          const body = await readJson(req, (x) => x as { taskId?: string; force?: boolean });
          if (restarting) return bad("already restarting", 409);
          const gate = () => {
            const busy = db.listTasks().filter((t) => t.status === "running" || t.status === "waiting");
            if (busy.length) return `${busy.length} task(s) still running; wait or force`;
            if (selfdev.isRunning()) return "checks are still running; wait or force";
            return null;
          };
          if (!body.force) {
            const why = gate();
            if (why) return bad(why, 409);
            if (!body.taskId) return bad("taskId required (the task whose checks vouch for this tree), or force", 400);
            const run = selfdev.last(body.taskId);
            if (!run) return bad("run the checks first", 409);
            if (!selfdev.isCurrent(run)) return bad("the tree changed since these checks ran; run them again", 409);
            if (!run.ok) return bad(`checks failed (${run.results.filter((r) => !r.ok).map((r) => r.summary).join("; ")}); fix or force`, 409);
          }
          let argv: string[];
          try {
            argv = restartArgv();
          } catch (e) {
            return bad(String((e as Error).message ?? e), 500);
          }
          const supervised = isSupervised();
          logOp(req, srv, "daemon.restart", body.taskId ? { task: body.taskId } : {});
          if (opts.dryRunRestart) return json({ restarting: false, supervised, argv });
          restarting = true;
          broadcast({ type: "daemon.restarting" });
          setTimeout(() => void performRestart(argv, supervised, !!body.force), 200);
          return json({ restarting: true, supervised, argv }, 202);
        }),
      },

      // Releases (#178). Under sb-rescue the daemon runs from an immutable release, so new code arrives by promoting
      // a commit, and sb-rescue does all of it (candidate check, switch, automatic rollback). The daemon only relays:
      // it cannot be trusted to judge or survive its own replacement.
      "/api/daemon/release": async () => {
        const s = await releaseStatus();
        if (!s.managed) return json(s);
        try {
          // `ahead` (#1660): commits in HEAD that the running version lacks — 0 when HEAD is the running version or inside it;
          // null when it cannot be counted (the running version is not in this checkout, git failed).
          const [head, dirty, headSubject, ahead] = await Promise.all([
            git(["rev-parse", "HEAD"]), git(["status", "--porcelain"]), git(["log", "-1", "--format=%s", "HEAD"]),
            s.current ? git(["rev-list", "--count", `${s.current}..HEAD`]).then(Number, () => null) : Promise.resolve(null),
          ]);
          return json({ managed: true, rescuePage: cfg.rescuePageUrl, head, headSubject, ahead, busyTasks: busyTasks(), dirty: dirty !== "", current: s.current, previous: s.previous, state: s.state, busy: s.busy, lastError: s.lastError ?? null, history: s.history.slice(0, 5), hold: promotionHold ? { ...promotionHold, busyTasks: busyTasks() } : null });
        } catch (e) {
          return json({ managed: false, error: `sb-rescue did not answer at ${cfg.rescueUrl}: ${String((e as Error).message ?? e)}` });
        }
      },
      "/api/daemon/promote": {
        POST: strong(async (req, srv) => {
          if (!cfg.rescueUrl) return bad("this daemon does not run from a release (start it with sb-rescue)", 409);
          const body = await readJson(req, (x) => x as { commit?: string; force?: boolean });
          const busy = db.listTasks().filter((t) => t.status === "running" || t.status === "waiting");
          if (busy.length && !body.force) return bad(`${busy.length} task(s) still running; a promotion restarts the daemon — wait or force`, 409);
          try {
            const commit = body.commit ?? (await git(["rev-parse", "HEAD"]));
            const from = clientOf(req, srv);
            const r = await requestPromote(commit);
            if (r.status >= 200 && r.status < 300) logOp(req, srv, "daemon.promote", { detail: { commit } }, from); // sb-rescue took it
            return json({ ...r.body, commit }, r.status);
          } catch (e) {
            return bad(`sb-rescue did not answer at ${cfg.rescueUrl}: ${String((e as Error).message ?? e)}`, UPSTREAM_FAILED);
          }
        }),
      },

      "/api/tasks/:id/diff": async (req) => {
        const t = db.getTask(String(req.params.id));
        if (!t) return bad("not found", 404);
        try {
          return json(await collectTaskDiff(t, db.listEvents(t.id), staging.list(t.id)));
        } catch (e) {
          return bad(String((e as Error).message ?? e), 500);
        }
      },

      "/api/tasks/:id/footprint": async (req) => {
        const t = db.getTask(String(req.params.id));
        if (!t) return bad("not found", 404);
        return json(await measureFootprint(t.scope));
      },

      "/api/footprint": async (req) => {
        const dirs = new URL(req.url).searchParams.getAll("dir").filter((d) => existsSync(d));
        return json(await measureFootprint(dirs));
      },

      "/api/ledger/summary": async () => json({ ...db.ledgerSummary(), github: await githubBudget.get(metaWorkspace()?.path ?? cfg.codeRoot) }),
      "/api/ledger/daily": (req) => json(db.ledgerDaily(clampDays(new URL(req.url).searchParams.get("days")))),
      "/api/ledger/tasks": (req) => json(db.ledgerTasks(clampDays(new URL(req.url).searchParams.get("days")))),
      // Ledger (#1836): the period per runner × model. `days` is an integer 1..90 (absent = 7); anything else is 400, not rounded.
      "/api/ledger/models": (req) => {
        const raw = new URL(req.url).searchParams.get("days");
        const days = raw === null ? 7 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(days) || days < 1 || days > 90) return bad("days must be an integer 1..90");
        return json(db.ledgerModels(days));
      },
      "/api/perf": {
        POST: async (req) => {
          const parsed = PerfSamplesInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          db.insertPerfSamples(parsed.data);
          return json({ ok: true, count: parsed.data.length });
        },
      },
      "/api/perf/summary": () => json(db.perfSummary()),
      "/api/ops/latency": (req) => json(opsLatency(db, clampDays(new URL(req.url).searchParams.get("days")))),
      "/api/ops/stops": (req) => {
        const raw = new URL(req.url).searchParams.get("days");
        const days = raw === null ? 7 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(days) || days < 1 || days > 90) return bad("days must be an integer 1..90");
        return json(opsStops(db, days));
      },
      "/api/ops/load": (req) => {
        const sp = new URL(req.url).searchParams;
        const raw = sp.get("days");
        const days = raw === null ? 7 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(days) || days < 1 || days > 90) return bad("days must be an integer 1..90");
        return json(opsLoad(db, days, { taskId: sp.get("task") ?? undefined, available: readCgroup() !== null }));
      },
      "/api/ledger/pricing": () => json({ ...pricingTable(), fromSettings: Object.keys(settings().prices), source: pricing.source.replace(cfg.home, "~/.switchboard").replace(cfg.codeRoot, "<repo>"), problems: pricing.problems }),
      "/api/tasks/:id/budget": {
        POST: async (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const body = await readJson(req, (x) => x as { budgetUsd?: unknown });
          const b = body.budgetUsd;
          if (b !== null && (typeof b !== "number" || !Number.isFinite(b) || b <= 0)) return bad("budgetUsd must be a positive number or null");
          return json({ task: tasks.setBudget(t.id, b), overBudget: tasks.isOverBudget(t.id) });
        },
      },
      // The Evals list (#1221): newest first, up to `limit` (100, at most 500), filtered by workspace / runner.
      "/api/evals": (req) => {
        const url = new URL(req.url);
        const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 100)));
        const runner = url.searchParams.get("runner");
        if (runner && !RunnerId.safeParse(runner).success) return bad("unknown runner");
        const rows = db.evalsList({ workspaceId: url.searchParams.get("workspaceId") || undefined, runner: (runner as RunnerId | null) || undefined, limit });
        // a local task without a readable rules row (from before #1218, still in its first turn, or a row this version cannot read) is
        // counted here and the row kept, as the Brief does, so the two agree. Paid once per task; one task that cannot be counted
        // stays at null rather than failing the list.
        for (const row of rows) {
          if (row.rules) continue;
          const t = db.getTask(row.taskId);
          if (!t || t.executionMode === "cloud") continue;
          try {
            const m = countRules(t).metrics;
            row.rules = { toolCalls: m.toolCalls, toolFailures: m.toolFailures, errors: m.errors, userInstructions: m.userInstructions, stops: m.stops, lastEnd: m.lastEnd };
          } catch (e) {
            console.warn(`evals: task ${row.taskId} not counted for the list (${String((e as Error).message ?? e)})`);
          }
        }
        return json(rows);
      },

      "/api/tasks/:id/evals": (req) => {
        const t = db.getTask(String(req.params.id));
        if (!t) return bad("not found", 404);
        return json(evalsFor(t));
      },
      // 改善要望にする (#1221): the draft the feedback dialog opens with; the person edits and sends it through /api/feedback.
      "/api/tasks/:id/evals/draft": (req) => {
        const t = db.getTask(String(req.params.id));
        if (!t) return bad("not found", 404);
        return json({ text: evalRequestDraft(t, evalsFor(t)) });
      },
      // 再評価 (#1219): scores the task as it stands now, in the background; the result arrives as evals.updated. Works even with the automatic judge off.
      "/api/tasks/:id/evals/judge": {
        POST: (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          if (t.executionMode === "cloud") return bad("Cloud の Task は評価しません", 409);
          if (t.status === "running" || t.status === "waiting") return bad("ターン中は判定しません", 409);
          if (t.status === "idle" || db.firstUserText(t.id) === null) return bad("まだ会話がありません", 409);
          judgeEvals(t.id, t);
          return json({ queued: true }, 202);
        },
      },

      // The person's own rating (#1220): optional, one per task, replaced on every PUT; never touches the task row itself.
      "/api/tasks/:id/evals/human": {
        PUT: async (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const parsed = HumanEvalInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const ts = Date.now();
          db.upsertEval({ taskId: t.id, source: "human", by: "user", rubric: null, json: { ...parsed.data, by: "user", ts }, ts });
          broadcast({ type: "evals.updated", taskId: t.id });
          return json(evalsFor(t));
        },
        DELETE: (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          db.deleteEval(t.id, "human");
          broadcast({ type: "evals.updated", taskId: t.id });
          return json(evalsFor(t));
        },
      },

      "/api/tasks/:id/outcome": {
        POST: async (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const parsed = SetOutcomeInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          const task = tasks.setOutcome(t.id, parsed.data);
          // an outcome of 要対応 is what makes a Task's check a question (#938)
          void applyPolicies();
          return json({ task });
        },
      },

      "/api/tasks/:id/archive": {
        POST: async (req) => {
          const t = db.getTask(String(req.params.id));
          if (!t) return bad("not found", 404);
          const parsed = SetArchivedInput.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return bad(parsed.error.message);
          try {
            return json(tasks.setArchived(t.id, parsed.data.archived));
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
        },
      },

      "/api/knowledge": async () => json({ dir: knowledge.dir, disabled: knowledge.disabled, git: await knowledge.gitStatus(), docs: knowledge.list() }),
      "/api/knowledge/search": (req) => {
        try {
          return json(knowledge.search(new URL(req.url).searchParams.get("q") ?? ""));
        } catch (e) {
          return bad(`search failed: ${String((e as Error).message ?? e)}`, 500);
        }
      },
      "/api/knowledge/reindex": { POST: () => json(knowledge.scan()) },

      // Inbox: notes not yet tied to a repository. Promotion creates a task and records the task id on the note.
      "/api/inbox": {
        GET: () => json(inbox.list()),
        POST: async (req) => {
          const parsed = InboxAddInput.safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          if (parsed.data.text.length > 200_000) return bad("note too large", 413);
          try {
            return json(inbox.add(parsed.data.text, { title: parsed.data.title, workspaceHint: parsed.data.workspaceHint }), 201);
          } catch (e) {
            return bad(knowledgeError(e), knowledgeStatus(e));
          }
        },
      },
      "/api/inbox/promote": {
        POST: async (req) => {
          const parsed = InboxPromoteInput.safeParse(await req.json().catch(() => ({})));
          if (!parsed.success) return bad(parsed.error.message);
          const ws = db.getWorkspace(parsed.data.workspaceId);
          if (!ws) return bad("workspace not found", 404);
          if (!existsSync(ws.path)) return bad("workspace directory does not exist", 409);
          let note;
          try {
            note = inbox.get(parsed.data.path);
          } catch (e) {
            return bad(knowledgeError(e), knowledgeStatus(e));
          }
          if (note.status === "promoted") return bad(`note already promoted to ${note.taskId ?? "a task"}`, 409);
          const input = CreateTaskInput.safeParse({ workspaceId: ws.id, cwd: ws.path, title: parsed.data.title ?? note.title, prompt: note.body, runner: parsed.data.runner });
          if (!input.success) return bad(input.error.message);
          if (!adapterMap.has(input.data.runner)) return bad(`runner "${input.data.runner}" is not installed`, 409);
          // Create first (the expensive, user-visible step), then mark. A mark failure is reported with the task id so
          // the user can fix the note; the task is not silently duplicated because get() above refuses promoted notes.
          let task;
          try {
            task = tasks.create({ ...input.data, cwd: ws.path });
          } catch (e) {
            return bad(String((e as Error).message ?? e), 409);
          }
          try {
            return json({ task, note: inbox.markPromoted(parsed.data.path, task.id) }, 201);
          } catch (e) {
            return Response.json({ error: `task ${task.id} started but the note could not be marked: ${knowledgeError(e)}`, task }, { status: 500 });
          }
        },
      },

      // Without workspaceId: write user-level files. With workspaceId: remove old repository blocks only.
      "/api/materialize/preview": (req) => {
        const id = new URL(req.url).searchParams.get("workspaceId");
        const ws = id !== null ? db.getWorkspace(id) : undefined;
        if (id !== null && !ws) return bad("workspace not found", 404);
        try {
          return json({ workspace: ws, ...materializer.plan(knowledge, { home: homedir(), workspace: ws ?? undefined }) });
        } catch (e) {
          return bad(knowledgeError(e), knowledgeStatus(e));
        }
      },
      "/api/materialize/apply": {
        POST: async (req) => {
          let body: unknown;
          try { body = await req.json(); } catch { return bad("invalid JSON"); }
          const parsed = MaterializeApplyInput.safeParse(body);
          if (!parsed.success) return bad(parsed.error.message);
          const id = parsed.data.workspaceId;
          const ws = id !== undefined ? db.getWorkspace(id) : undefined;
          if (id !== undefined && !ws) return bad("workspace not found", 404);
          try {
            const opts = { home: homedir(), workspace: ws ?? undefined };
            const result = materializer.apply(materializer.plan(knowledge, opts).files, { paths: parsed.data.paths, expected: parsed.data.expected, force: parsed.data.force });
            return json({ ...result, ...materializer.plan(knowledge, opts) }, result.skipped.some((s) => s.reason === "stale") ? 409 : 200);
          } catch (e) {
            return bad(knowledgeError(e), knowledgeStatus(e));
          }
        },
      },
      "/api/knowledge/doc": {
        GET: (req) => {
          const path = new URL(req.url).searchParams.get("path") ?? "";
          try {
            return json(knowledge.read(path));
          } catch (e) {
            return bad(knowledgeError(e), knowledgeStatus(e));
          }
        },
        POST: async (req) => {
          const body = await readJson(req, (x) => x as { path?: unknown; content?: unknown });
          if (typeof body.path !== "string" || typeof body.content !== "string") return bad("path and content (strings) required");
          if (body.content.length > 1_000_000) return bad("content too large (1 MB limit)", 413);
          try {
            return json(knowledge.write(body.path, body.content), 201);
          } catch (e) {
            return bad(knowledgeError(e), knowledgeStatus(e));
          }
        },
      },

      "/ws": async (req, srv) => {
        if (!sameOrigin(req)) return refused(req, srv, bad("cross-origin request refused", 403));
        const auth = await authorize(req, srv, true, true);
        if (!auth.ok) return refused(req, srv, bad("unauthorized", 401));
        if (srv.upgrade(req, { data: auth.session ? { session: auth.session } : undefined })) return undefined as unknown as Response;
        return bad("websocket upgrade failed", 426);
      },

      // Terminal tab (#16): the task's shell. Same rules as /ws — this socket can run anything the daemon's user can.
      "/ws/pty": async (req, srv) => {
        if (!sameOrigin(req)) return refused(req, srv, bad("cross-origin request refused", 403));
        const auth = await authorize(req, srv, true, true);
        if (!auth.ok) return refused(req, srv, bad("unauthorized", 401));
        const recent = recentRefusal(req, auth.session);
        if (recent) return recent;
        if (!pty) return bad("no terminal in this distribution", 404);
        const task = db.getTask(new URL(req.url).searchParams.get("task") ?? "");
        if (!task) return bad("task not found", 404);
        // ?shell=<id>: coming back to that session only (#1137); without it, the task's session or a new one. A reconnect
        // starts nothing, so the cap does not apply: a gone shell must be told 4404 even when the others fill the cap.
        const shell = new URL(req.url).searchParams.get("shell") ?? undefined;
        if (shell === undefined && !pty.has(task.id) && pty.size >= MAX_PTY_SESSIONS) return bad(`too many terminals open (max ${MAX_PTY_SESSIONS}); close one first`, 429);
        // The shell starts in the socket's open handler: a request that never becomes a socket must not leave one behind.
        const teleport = new URL(req.url).searchParams.get("teleport") === "1";
        const from = clientOf(req, srv); // before the upgrade: the socket's peer is gone after it
        if (srv.upgrade(req, { data: { ptyTask: task.id, cwd: task.cwd, teleport, shell, session: auth.session } })) {
          logOp(req, srv, "pty.open", { task: task.id, ...(teleport ? { detail: "teleport" } : {}) }, from);
          return undefined as unknown as Response;
        }
        return bad("websocket upgrade failed", 426);
      },
    }),
    fetch: logged(null, limitedGuard(async (req: Request, srv: Peer) => {
      if (!viaEdge(req, srv)) return refused(req, srv, notViaEdge());
      if (!hostOk(req)) return refused(req, srv, notAllowedHost());
      // Static web UI when built; otherwise point at the Vite dev server.
      const url = new URL(req.url);
      if (existsSync(cfg.webDist)) {
        const rel = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(join(cfg.webDist, rel));
        if (await file.exists()) return new Response(file, { headers: WEB_HEADERS });
        return new Response(Bun.file(join(cfg.webDist, "index.html")), { headers: WEB_HEADERS });
      }
      return new Response(`Switchboard core is running. Web UI is not built; run "bun run dev" and open http://localhost:5173\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    })) as (req: Request, srv: Peer) => Promise<Response>,
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data?.session) cookieSockets.add(ws);
        if (ws.data?.ptyTask !== undefined) {
          try {
            if (ws.data.shell !== undefined) { /* a reconnect starts nothing */ }
            else if (ws.data.teleport) pty!.prepareTeleport(ws.data.ptyTask);
            else pty!.open(ws.data.ptyTask, ws.data.cwd, process.env.SHELL || "/bin/sh");
          } catch (e) {
            return ws.close(1011, `shell failed to start: ${String((e as Error).message ?? e)}`.slice(0, 120));
          }
          // the session it asked for has ended (exited, the task ended, the daemon restarted): the client offers a new one
          const id = pty!.sessionId(ws.data.ptyTask);
          if (!id || (ws.data.shell !== undefined && ws.data.shell !== id)) return ws.close(4404, "shell gone");
          ws.send(JSON.stringify({ type: "attached", shell: id } satisfies PtyAttached));
          ws.data.client = { send: (data) => void ws.send(data), close: () => ws.close(1000, "shell exited") };
          hostIdle?.touch();
          return pty!.attach(ws.data.ptyTask, ws.data.client);
        }
        wsCount++;
        hostIdle?.touch();
        ws.subscribe(TOPIC);
        ws.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION } satisfies ServerMessage));
      },
      message(ws: ServerWebSocket<WsData>, raw) {
        if (ws.data?.ptyTask !== undefined) {
          const m = PtyClientMessage.safeParse(safeParse(String(raw)));
          if (!m.success) return;
          if (m.data.type === "input") pty!.write(ws.data.ptyTask, m.data.data);
          else pty!.resize(ws.data.ptyTask, m.data.cols, m.data.rows);
          return;
        }
        const parsed = ClientMessage.safeParse(safeParse(String(raw)));
        if (!parsed.success) {
          ws.send(JSON.stringify({ type: "error", message: "bad message" } satisfies ServerMessage));
          return;
        }
        const m = parsed.data;
        try {
          if (m.type === "task.send") {
            catchUpWithShadow(m.taskId);
            tasks.send(m.taskId, m.text).catch((e) => ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) } satisfies ServerMessage)));
          } else if (m.type === "permission.respond") tasks.respondPermission(m.taskId, m.id, m.decision, m.answers);
          else if (m.type === "task.abort") void tasks.abort(m.taskId);
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) } satisfies ServerMessage));
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        hostIdle?.touch();
        cookieSockets.delete(ws);
        if (ws.data?.ptyTask !== undefined) return void (ws.data.client && pty!.detach(ws.data.ptyTask, ws.data.client));
        wsCount--;
        ws.unsubscribe(TOPIC);
      },
    },
  });

  // Only once the port is ours: a second daemon on the same home would otherwise close the live daemon's tasks and
  // then die on EADDRINUSE. Tasks still running / waiting now belong to nobody.
  const orphaned = abortOrphanedTasks(db, Date.now(), settings().quotaAndResume.maxStopResumes);
  if (orphaned.length) console.warn(`tasks: ${orphaned.length} left running/waiting by a previous daemon marked aborted (${orphaned.join(", ")})`);
  // The host's load once a minute (#2086). A candidate on a spare port shares the unit: the live daemon samples it
  const opsLoadSampler = cfg.candidate ? null : new OpsLoadSampler(db, { home: cfg.home });
  opsLoadSampler?.start();
  // This start's row in daemon_runs (#2085): closes the previous one with its cause. A candidate runs on a copy.
  let runId = cfg.candidate
    ? null
    : startDaemonRun(db, { now: Date.now(), version: daemonVersion(cfg), bootId: readBootId(), journal: readJournal, history: readReleaseHistory(cfg.home), orphaned: orphaned.filter((id) => db.getTask(id)?.executionMode !== "cloud") });
  // A judgement the last daemon was cut off in (#1139) is made again, once; a mark that no longer fits is dropped.
  const cutOff = db.listTasksJudging();
  let rejudged = 0;
  for (const t of cutOff) {
    const text = db.lastReply(t.id)?.text.trim();
    if (t.status === "done" && t.outcome === "unknown" && !t.shadowOf && t.executionMode !== "cloud" && settings().judge.enabled && text && t.judgingAt !== null) {
      lastJudgingAt = Math.max(lastJudgingAt, t.judgingAt);
      judgeReply(t.id, t, text, t.judgingAt);
      rejudged++;
    } else db.updateTask(t.id, { judgingAt: null, updatedAt: t.updatedAt });
  }
  if (rejudged) console.warn(`judge: ${rejudged} task(s) left judging by a previous daemon judged again`);
  // The first pass over the session logs is deferred so the port answers first; later passes follow growing files.
  let firstPass = true;
  if (!cfg.candidate) history.start((r) => {
    if (r.created || r.appended) console.log(`history: ${r.created} terminal session(s) imported, ${r.appended} task(s) extended from ${cfg.claudeProjectsDir}`);
    if (firstPass && r.skippedForeign) console.log(`history: ${r.skippedForeign} session log(s) outside any workspace (add the workspace to import them)`);
    firstPass = false; // errors are logged by the importer itself, each distinct one once
  });

  // The /mcp endpoint has its own per-task token; health is open so the UI can learn whether a token is needed; a GitHub
  // Webhook (#887) cannot carry the token and only asks for an import, once the user opened it.
  // The CDN's origin header (#181) and, on loopback, the Host (#1135) come before everything, the open routes included: a
  // cloud host answers nothing to a request that went around CloudFront, a Mac nothing to a page on a rebinding name.
  function guardAll<T extends Routes>(routes: T): T {
    return Object.fromEntries(Object.entries(routes).map(([path, h]) => [path, logged(path, limitedGuard(entryGuard(path === "/api/health" || path === "/ws" || path === "/ws/pty" || path.startsWith("/mcp/") || path.startsWith("/artifacts/") || (path === "/api/backlog/webhooks/github" && webhookOpen) ? (h as AnyHandler) : guard(h as AnyHandler))))])) as T;
  }

  const stopAll = async (cleanExit: CleanExit = "shutdown") => {
    clearInterval(recheckTimer);
    history.stop();
    knowledge.close();
    scheduler.stop();
    resumer.stop();
    backlog.stop();
    hostIdle?.stop();
    opsLoadSampler?.stop();
    runnerLogins.stop();
    deviceAuths.stop();
    selfdev.cancelAll();
    pty?.closeAll();
    await mcp.revokeAll();
    const cut = await tasks.shutdown();
    if (runId !== null) endDaemonRun(db, runId, { cleanExit, endedAt: Date.now(), taskIds: cut });
    runId = null; // a second stop finds the database closed
    judgeStop.abort();
    // a policy being applied (#938) finishes before the database goes
    await applying;
    server.stop(true);
    clearInterval(apiRequestsTimer);
    flushApiRequests();
    db.close();
  };

  async function performRestart(argv: string[], supervised: boolean, force: boolean) {
    // Re-check the gate right before stopping: a task may have started in the meantime.
    if (!force && db.listTasks().some((t) => t.status === "running" || t.status === "waiting")) {
      restarting = false;
      broadcast({ type: "error", message: "restart cancelled: a task started meanwhile" });
      return;
    }
    try {
      await stopAll("restart");
    } catch (e) {
      console.error(`restart: stop failed (${String((e as Error).message ?? e)}); exiting anyway`);
    }
    if (supervised) process.exit(RESTART_EXIT_CODE);
    try {
      spawnDetached(argv, cfg.home, process.cwd(), cfg.idleStopCmd ? { SWITCHBOARD_IDLE_STOP_CMD: cfg.idleStopCmd } : {});
    } catch (e) {
      console.error(`restart: could not spawn the replacement (${String((e as Error).message ?? e)}); restarting on the old code`);
      process.exit(RESTART_EXIT_CODE);
    }
    // Hand over only once the replacement serves; otherwise we cannot help from here, so exit with the restart code
    // (a supervisor respawns us; standalone the user re-runs `bun run core` — the log says why).
    const port = server.port ?? cfg.port;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) process.exit(0);
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.error("restart: the replacement daemon did not come up within 15 s; see ~/.switchboard/daemon.log");
    process.exit(RESTART_EXIT_CODE);
  }

  return {
    server,
    tasks,
    db,
    artifacts,
    knowledge,
    mcp,
    token,
    selfdev,
    history,
    pty,
    stop: () => stopAll(),
  };
}

/** What a Task on another workspace is told about its repository (#557); a `scripts/setup` that cannot be read counts as none. */
/** What holds a PBI in backlog-next's log (#817, #937): a wait or a prerequisite not met. */
type Held = ReturnType<typeof heldIn>[number]["pending"][number];
/** One per line of the log: overlaps still open (待ち), prerequisites not done yet (前提), ones a person has to look at. */
const HELD_LINES: Array<[string, (pending: Held[], stuck: Held[]) => Held[]]> = [
  ["待ち", (pending) => pending.filter((x) => "reason" in x && x.reason === "overlap")],
  ["前提", (pending) => pending.filter((x) => !("reason" in x && x.reason === "overlap"))],
  ["進められない", (_, stuck) => stuck],
];
/** `PR #12 マージ待ち`, `#13 取り下げ`, …; an overlap is named alone (it waits for the other side to close). */
function heldWhy(x: Held): string {
  const ref = `${x.kind === "pr" ? "PR " : ""}#${x.number}`;
  if ("reason" in x && x.reason === "overlap") return x.state === "missing" ? `${ref} 見つからない` : ref;
  const need = "need" in x ? x.need : x.kind === "pr" ? "merged" : "done";
  if (x.state === "pending") return `${ref} ${need === "release" ? "リリース待ち" : need === "merged" ? "マージ待ち" : "未完"}`;
  if (x.state === "withdrawn") return `${ref} 取り下げ`;
  if (x.state === "missing") return `${ref} 見つからない`;
  if (x.state === "cycle") return `${ref} と循環`;
  return need === "release" ? `${ref} の反映を確かめられない` : `${ref} 判定できない`;
}

function otherRepo(meta: Workspace, ws: Workspace): OtherRepo | undefined {
  if (ws.kind === "meta") return undefined;
  let setup = { config: false, kit: [] as string[], copies: [] as string[] };
  try {
    setup = setupScripts({ metaPath: meta.path, cwd: ws.path });
  } catch {
    // the Task starts with the plain instructions
  }
  return { meta: meta.path, projectVar: ws.projectVar, setup };
}

/** The repository this daemon runs from is always registered as the "meta" workspace (self-dev). */
function seedWorkspaces(db: Db, cfg: CoreConfig) {
  db.upsertWorkspace({ name: basename(cfg.repoRoot), path: cfg.repoRoot, kind: "meta" });
}

/** Knowledge errors: ENOENT-class → 404, containment/validation → 400, and never leak absolute paths. */
function knowledgeStatus(e: unknown): number {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT" || /not found/.test(String((e as Error).message ?? e))) return 404;
  if (code === "EACCES" || code === "EPERM") return 403;
  return 400;
}
function knowledgeError(e: unknown): string {
  const msg = String((e as Error).message ?? e);
  return msg.replace(/\/(?:[^/\s'"]+\/)+[^/\s'"]*/g, "<path>");
}

/**
 * `?limit=` of the decision-log export: 1..5000, default 200. Anything that is not a usable count — absent, empty,
 * zero, negative, not a number — falls back to the default rather than 400ing an export. (`Number("")` is 0, which
 * is why the emptiness check comes first: `?limit=` alone used to mean "one row".)
 */
function clampLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(5000, Math.round(n)) : 200;
}

/** `?days=` of the Ledger / routing endpoints: 1..90, default 7. Like `clampLimit`, an unusable value falls back. */
function clampDays(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 7; // Number("") is 0, which used to mean "one day"
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(90, Math.round(n)) : 7;
}

/** `?after=<seq>` of GET /api/tasks/:id: a positive whole seq, else 0 (= every event), like ?days= falling back instead of a 400. */
function afterSeq(raw: string | null): number {
  const n = raw === null || raw.trim() === "" ? 0 : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
