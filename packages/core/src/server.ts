import { isWorkMachine, workMachineGh } from "./machine.ts";
import { existsSync } from "node:fs";
import { type AgentEvent, type LlmRoutingSettings, type RunnerAdapter } from "@switchboard/protocol";
import type { CoreConfig } from "./config.ts";
import { Db } from "./db.ts";
import { type JobDeps } from "./jobs.ts";
import { ArtifactStore } from "./artifacts.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_REQUEST } from "./attachments.ts";
import { PtyManager } from "./pty.ts";
import { WorkspaceMcp } from "./mcp.ts";
import { judgeTurn } from "./judge.ts";
import { suggestTitle } from "./suggest-title.ts";
import { judgeRubric } from "./rubric-judge.ts";
import { type CatalogRunner } from "./model-catalog.ts";
import { SelfDev } from "./selfdev.ts";
import { type S3Store } from "./s3.ts";
import { warmInterventions } from "./interventions.ts";
import { runGh, type GhRunner } from "./backlog-gh.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { type Suggester } from "./routing.ts";
import { TaskManager } from "./tasks/manager.ts";
import { HistoryImporter } from "./history.ts";
import { type GitConfigRunner } from "./github-login.ts";
import type { ServerContextInit, Peer } from "./server/context.ts";
import { joinRoutes } from "./routes/shared.ts";
import { healthRoutes } from "./routes/health.ts";
import { runnersRoutes } from "./routes/runners.ts";
import { githubRoutes } from "./routes/github.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { customRunnersRoutes } from "./routes/custom-runners.ts";
import { schedulesRoutes } from "./routes/schedules.ts";
import { presetsRoutes } from "./routes/presets.ts";
import { queueRoutes } from "./routes/queue.ts";
import { approvalsRoutes } from "./routes/approvals.ts";
import { asksRoutes } from "./routes/asks.ts";
import { policiesRoutes } from "./routes/policies.ts";
import { tasksRoutes } from "./routes/tasks.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { otelRoutes } from "./routes/otel.ts";
import { workspacesRoutes } from "./routes/workspaces.ts";
import { bundleRoutes } from "./routes/bundle.ts";
import { backlogRoutes } from "./routes/backlog.ts";
import { interventionsRoutes } from "./routes/interventions.ts";
import { balanceRoutes } from "./routes/balance.ts";
import { sourcesRoutes } from "./routes/sources.ts";
import { flowRoutes } from "./routes/flow.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { newRepoRoutes } from "./routes/new-repo.ts";
import { processesRoutes } from "./routes/processes.ts";
import { routingRoutes } from "./routes/routing.ts";
import { historyRoutes } from "./routes/history.ts";
import { mergeGrantsRoutes } from "./routes/merge-grants.ts";
import { attachmentsRoutes } from "./routes/attachments.ts";
import { reportsRoutes } from "./routes/reports.ts";
import { artifactsRoutes } from "./routes/artifacts.ts";
import { daemonRoutes } from "./routes/daemon.ts";
import { ledgerRoutes } from "./routes/ledger.ts";
import { perfRoutes } from "./routes/perf.ts";
import { opsRoutes } from "./routes/ops.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { evalsRoutes } from "./routes/evals.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { materializeRoutes } from "./routes/materialize.ts";
import { wsRoutes } from "./routes/ws.ts";
import { bindFunctions } from "./server/bind.ts";
import { fallbackFetch, socketHandlers } from "./server/serve.ts";
import { SETTINGS_KEY } from "./server/helpers.ts";
import { setupHome, setupTimers, setupAfterListen } from "./server/lifecycle.ts";
import { setupLogins } from "./server/logins.ts";
import { setupShipped } from "./server/settings.ts";
import { setupStores, setupTasks, setupJobs } from "./server/setup.ts";
import { setupEntrance, setupSockets, setupRequestLog } from "./server/guards.ts";
import { setupWorkspaceMcp } from "./server/mcp.ts";
import { setupBacklog } from "./server/backlog-read.ts";
import { setupAsks } from "./server/asks.ts";
import { setupPromotion, setupPromotionCheck } from "./server/promotion.ts";
import { setupCliUpdate } from "./server/cli-update.ts";
import { setupScheduler } from "./server/backlog-next.ts";
import { setupQueue } from "./server/queue.ts";
import { setupUplink } from "./server/lease.ts";
import { setupTurnEndHooks, setupSnapshots } from "./server/task-hooks.ts";

/**
 * A HOME with no database yet starts with `developSelf: false`: a new instance does not develop Switchboard itself.
 * An existing database is not touched (the key's absence reads as true). Called by main.ts before the daemon starts.
 */
export function seedNewHome(dbPath: string): void {
  if (existsSync(dbPath)) return;
  const db = new Db(dbPath);
  try {
    db.setSetting(SETTINGS_KEY, { developSelf: false });
  } finally {
    db.close();
  }
}

export interface CoreServer {
  server: ReturnType<typeof Bun.serve>;
  tasks: TaskManager;
  db: Db;
  /** Registered reports. */
  artifacts: ArtifactStore;
  knowledge: KnowledgeStore;
  mcp: WorkspaceMcp;
  selfdev: SelfDev;
  /** Terminal Claude Code sessions read from ~/.claude/projects. */
  history: HistoryImporter;
  /** Local API token (only enforced when not listening on loopback). */
  token: string;
  /** Terminal tab; null when no PTY can be opened here. */
  pty: PtyManager | null;
  /** Read the Web UI and the shipped defaults again from `<home>/releases/current` (SIGHUP, under sb-rescue). The version's sha, or null when there is no `current`. */
  reloadRelease(): string | null;
  stop(): Promise<void>;
}

/** Bun's default 10 s cut a response still waiting on GitHub (backlog, answer, start) → CloudFront 502 → stopped page → Home. */
export const IDLE_TIMEOUT_SECONDS = 120;

export interface StartServerOptions {
  port?: number;
  selfdevChecks?: boolean;
  /**
   * Import every workspace's backlog at boot, unasked. The daemon
   * (main.ts) does; tests and scripts that boot one do not (they would import the checkout's real repository) — their
   * first look at the backlog imports instead.
   */
  backlogAutoImport?: boolean;
  dryRunRestart?: boolean;
  /**
   * Overrides where LLM routing suggestions come from when `settings.routing.llm.enabled`. Called per task
   * creation with the saved settings, so a changed runner / model takes effect without a restart; null = no LLM
   * suggestion (the rule table alone). Unset = the real one, asking the configured runner through its adapter.
   * `onUsage` reports what the turn cost so it can go in the ledger.
   */
  llmSuggester?: (cfg: LlmRoutingSettings, onUsage: (ev: Extract<AgentEvent, { t: "usage" }>) => void, taskId: string) => Suggester | null;
  /** Overrides how the terminal tab's PTY library is loaded; a test passes one that throws to get features.pty = false. */
  loadPty?: () => Promise<PtyManager | null>;
  /** Overrides how `gh` is run for GET /api/backlog; tests and the E2E answer from a fixture. Unset = `gh` from PATH. */
  gh?: GhRunner;
  /** Overrides the command of a job a Task asks for; tests run a fake. Unset = local CI / the review runner. */
  jobCommand?: JobDeps["command"];
  /**
   * Collects, once at start, the results of local CI builds that outlived the daemon (`recoverJobs`); main.ts passes
   * `spawnCollectPending`. Unset (tests, the E2E) = nothing is collected, so a test daemon never writes to a real PR.
   */
  collectPending?: (env: Record<string, string | undefined>, log: string) => void;
  /**
   * Overrides how a checkout's origin URL is read before a runner starts; tests whose fake `gh` names a
   * repository the checkout is not answer for it. Unset = git.
   */
  gitOrigin?: (path: string) => string | null;
  /** Overrides where a request came from (the edge header); a test makes real sockets on 127.0.0.1 look like another machine. */
  peerAddress?: (req: Request) => string | undefined;
  /** The uplink bucket (`cfg.uplink.mode` set); tests pass one kept in memory. Unset = the `aws` CLI. Never used by a daemon that runs alone. */
  s3?: S3Store;
  /** How long a runner login from the screen may stay open; tests shorten it. */
  loginTimeoutMs?: number;
  /** The `gh` executable GitHub's login from the screen runs; tests point it at a fake. Unset = `gh` from PATH. */
  ghBin?: string | null;
  /** How GitHub's login reads and fills git's commit name and email; tests answer by hand. Unset = `git config --global`. */
  gitConfig?: GitConfigRunner;
  /** Overrides the judge asked at the end of a turn; tests answer by hand. Unset = `judgeTurn`, the configured runner's own adapter. */
  judge?: typeof judgeTurn;
  /** Overrides the one that names a task after its first turn; tests answer by hand. Unset = `suggestTitle`. */
  titleSuggester?: typeof suggestTitle;
  /** Overrides the rubric judge the same way; tests answer by hand. */
  rubricJudge?: typeof judgeRubric;
  /** How long a Starter answer about a login cookie is kept, and how often open cookie WebSockets are checked again; tests shorten it. Unset = SESSION_RECHECK_MS. */
  sessionRecheckMs?: number;
  /** How often the daemon under sb-rescue reads the newest release tag and asks for its promotion; tests shorten it. Unset = `settings.release.checkMinutes`. */
  promotionCheckMs?: number;
  /** How long a promotion waiting for the Tasks a restart would cut keeps new turns from starting; tests shorten it. Unset = `settings.release.drainMinutes`. */
  promotionDrainLimitMs?: number;
  /** A restart that was asked for: how long new starts stay held when it never comes, and how often sb-rescue's status is read meanwhile; tests shorten them. Unset = 30 minutes / 5 s. */
  promotionAskedHoldMs?: number;
  promotionAskedPollMs?: number;
  /** How soon the ask at the first moment no Task would be cut is tried again when it could not decide; tests shorten it. Unset = 10 s. */
  promotionIdleRetryMs?: number;
  /** The host CLIs' update: the distributors and the install steps it runs against (tests give a fake distributor and the home to put versions in) and how soon the first and each next read of the distributors comes. Unset = the real ones and `settings.cliUpdate.checkMinutes`. */
  cliUpdate?: { source?: import("./cli-update-source.ts").CliSourceDeps; install?: Partial<import("./cli-update-install.ts").InstallDeps>; checkMs?: number };
  /** Overrides how the tag CI's result of a tag is read (the tag's Release, through gh); tests answer by hand. */
  tagCi?: (tag: string, sha: string) => Promise<"pass" | "fail" | "none">;
  /** How often the daemon looks for a depends stop whose date has passed (`resumeDueAfters`); tests shorten it. Unset = AFTER_CHECK_MS. */
  afterCheckMs?: number;
  /** How often the daemon looks at what the Tasks wait for (`checkWaits`); tests shorten it. Unset = WAIT_CHECK_MS. */
  waitCheckMs?: number;
  /** Overrides where the machine's heavy-process slots are; tests keep them out of the real home. Unset = `ops-kit heavy`'s own, under the home directory. */
  heavyStateDir?: string;
  /**
   * Overrides where 「CLI の表を読む」 reads a CLI's model table from; tests answer with a fake table. null = the
   * CLI is not installed. Unset = the installed CLIs on PATH (`hostReaders`). Called only by GET /api/settings/model-candidates.
   */
  modelCatalog?: (runner: CatalogRunner) => Promise<string | null>;
}

export async function startServer(cfg: CoreConfig, adapters: RunnerAdapter[], opts: StartServerOptions = {}): Promise<CoreServer> {
  // a work machine's daemon never writes to the forge: every `gh` it runs is this one runner, which lets only reads through
  if (isWorkMachine(cfg)) opts = { ...opts, gh: workMachineGh(opts.gh ?? runGh) };
  const sc = { cfg, adapters, opts } as ServerContextInit;
  bindFunctions(sc);
  setupHome(sc);

  await setupLogins(sc);

  setupShipped(sc);

  setupStores(sc);
  await setupTasks(sc);

  setupEntrance(sc);
  setupWorkspaceMcp(sc);
  setupBacklog(sc);
  setupAsks(sc);

  setupPromotion(sc);
  setupScheduler(sc);
  setupQueue(sc);
  setupJobs(sc);
  setupSockets(sc);
  setupUplink(sc);
  setupPromotionCheck(sc);
  setupCliUpdate(sc);
  setupTimers(sc);
  setupTurnEndHooks(sc);

  setupRequestLog(sc);
  setupSnapshots(sc);

  // Read the stored records before listening, so the first GET /api/interventions finds them cached instead of queueing behind the read (it only reads).
  try {
    warmInterventions(sc.db, sc.db.listWorkspaces());
  } catch (e) {
    console.warn(`interventions: warm-up failed: ${(e as Error).message}`);
  }
  sc.server = Bun.serve({
    hostname: sc.cfg.host,
    port: sc.opts.port ?? sc.cfg.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    // One upload may carry MAX_ATTACHMENTS_PER_REQUEST files of MAX_ATTACHMENT_BYTES each, plus multipart overhead.
    maxRequestBodySize: MAX_ATTACHMENTS_PER_REQUEST * MAX_ATTACHMENT_BYTES + 1024 * 1024,
    routes: sc.guardAll(joinRoutes(
      healthRoutes(sc),
      runnersRoutes(sc),
      githubRoutes(sc),
      settingsRoutes(sc),
      customRunnersRoutes(sc),
      schedulesRoutes(sc),
      presetsRoutes(sc),
      queueRoutes(sc),
      approvalsRoutes(sc),
      asksRoutes(sc),
      policiesRoutes(sc),
      tasksRoutes(sc),
      mcpRoutes(sc),
      otelRoutes(sc),
      workspacesRoutes(sc),
      bundleRoutes(sc),
      backlogRoutes(sc),
      interventionsRoutes(sc),
      balanceRoutes(sc),
      sourcesRoutes(sc),
      flowRoutes(sc),
      feedbackRoutes(sc),
      newRepoRoutes(sc),
      processesRoutes(sc),
      routingRoutes(sc),
      historyRoutes(sc),
      mergeGrantsRoutes(sc),
      attachmentsRoutes(sc),
      reportsRoutes(sc),
      artifactsRoutes(sc),
      daemonRoutes(sc),
      ledgerRoutes(sc),
      perfRoutes(sc),
      opsRoutes(sc),
      jobsRoutes(sc),
      evalsRoutes(sc),
      knowledgeRoutes(sc),
      materializeRoutes(sc),
      wsRoutes(sc),
    )),
    fetch: sc.logged(null, sc.limitedGuard(fallbackFetch(sc))) as (req: Request, srv: Peer) => Promise<Response>,
    websocket: socketHandlers(sc),
  });

  setupAfterListen(sc);

  return {
    server: sc.server,
    tasks: sc.tasks,
    db: sc.db,
    artifacts: sc.artifacts,
    knowledge: sc.knowledge,
    mcp: sc.mcp,
    token: sc.token,
    selfdev: sc.selfdev,
    history: sc.history,
    pty: sc.pty,
    reloadRelease: sc.reloadRelease,
    stop: () => sc.stopAll(),
  };
}
