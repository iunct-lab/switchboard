import { decidesNothing, isWorkMachine } from "../machine.ts";
import { LABEL_KEY } from "../containers.ts";
import { stopEndedTasksProcesses } from "../detached.ts";
import { homedir, tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TeleportProgress, TerminalStatus } from "@switchboard/protocol";
import { memoryHeadroom } from "../ops-load.ts";
import { recoverJobs } from "../jobs.ts";
import { ArtifactStore } from "../artifacts.ts";
import { AttachmentStore } from "../attachments.ts";
import { PtyManager } from "../pty.ts";
import { loadMcpPolicy } from "../mcp.ts";
import { ApprovalRules } from "../approval.ts";
import { loadPricing } from "../pricing.ts";
import { RateLimitResumer } from "../ratelimit.ts";
import { meetJobConditions, resumeDepends } from "../depends-resume.ts";
import { waitsDirOf } from "../waits.ts";
import { workspaceConfigEnv } from "../workspace-config.ts";
import { issueOf } from "../stops.ts";
import { readPolicies, recordUse, writePolicies } from "../policies.ts";
import { KnowledgeStore } from "../knowledge.ts";
import * as materializer from "../materializer.ts";
import { RuleSuggester } from "../routing.ts";
import { heavyStateDir } from "../../../../ops-kit/src/heavy.ts";
import { kitPath, privateTmpOf } from "../tasks/sessions.ts";
import { TaskManager } from "../tasks/manager.ts";
import { HistoryImporter } from "../history.ts";
import { DeviceAuths } from "../deviceauth.ts";
import type { ServerContextInit } from "./context.ts";

export function setupStores(sc: Pick<ServerContextInit, "knowledge" | "cfg" | "db" | "broadcast" | "deviceAuths" | "ruleSuggester" | "routing" | "suggestDir" | "adviceStop" | "adviceRunning" | "approval" | "storedBacklog" | "pricing" | "shipped" | "liveRoot" | "attachments" | "artifacts" | "teleportCwds" | "teleports" | "terminals" | "dockerLogDir" | "mcpPolicy" | "bootCustomRunners" | "promotionDrain">): void {
  // The knowledge folder is optional at boot: an unwritable path or one unreadable file must not stop the daemon.
  sc.knowledge = new KnowledgeStore(sc.cfg.knowledgeDir, sc.db);
  if (sc.knowledge.disabled) console.warn(`knowledge: folder unavailable (${sc.knowledge.disabled}); Knowledge tab will be empty`);
  try {
    const r = sc.knowledge.scan();
    for (const e of r.errors) console.warn(`knowledge: ${e}`);
  } catch (e) {
    console.warn(`knowledge: initial scan failed: ${String((e as Error).message ?? e)}`);
  }
  for (const w of materializer.scopedWarnings(sc.knowledge)) console.warn(`knowledge: ${w.path}: ${w.message}`);
  sc.knowledge.watch();

  sc.knowledge.onChange(() => sc.broadcast({ type: "knowledge.updated", count: sc.knowledge.list().length }));
  // A Task's approval wait (docs/design/device-auth.md): memory and the WebSocket only, never the DB.
  sc.deviceAuths = new DeviceAuths((taskId, auth) => sc.broadcast({ type: "task.deviceAuth", taskId, auth }));
  sc.ruleSuggester = new RuleSuggester(() => sc.routing.table);
  // Where a suggestion turn runs: an empty directory of its own, never `cfg.home` (the API token and the
  // sqlite file live there) and never a repository. Read-only mode stops writes, not reads, and the text in that
  // prompt — task titles from imported sessions — is not the daemon's to trust.
  sc.suggestDir = join(sc.cfg.home, "suggest");
  mkdirSync(sc.suggestDir, { recursive: true });
  /** Stopped with the daemon: a suggestion turn still running ends, and nothing is written past the database's close. */
  sc.adviceStop = new AbortController();
  sc.adviceRunning = new Set<Promise<void>>();
  sc.approval = new ApprovalRules(sc.knowledge, (task) => (task.workspaceId ? sc.db.getWorkspace(task.workspaceId) : null), (id) => sc.db.getWorkspace(id), () => ({ list: readPolicies(sc.db), pbiOpen: (wsId, n) => { const ws = wsId ? sc.db.getWorkspace(wsId) : null; return !!ws && sc.storedBacklog(ws).items.some((i) => i.number === n); } }));
  sc.pricing = loadPricing([join(sc.cfg.home, "pricing.json"), sc.shipped(sc.liveRoot, "pricing.json")]);
  // Attachments: uploads wait in <home>/attachments/inbox until a turn sends them; a day-old leftover is swept at boot.
  sc.attachments = new AttachmentStore(sc.db, sc.cfg.attachmentsDir);
  const swept = sc.attachments.sweep();
  if (swept) console.log(`attachments: removed ${swept} upload(s) that were never sent`);
  // Artifacts: reports registered on the Task screen, copied under <home>/artifacts; a removed one is deleted a day later.
  sc.artifacts = new ArtifactStore(sc.db, sc.cfg.artifactsDir, { privateTmp: (taskId) => privateTmpOf(join(sc.cfg.home, "tmp"), taskId), deny: [sc.cfg.tokenPath, sc.cfg.dbPath, `${sc.cfg.dbPath}-wal`, `${sc.cfg.dbPath}-shm`], tmpRoots: [tmpdir()] });
  const sweptArtifacts = sc.artifacts.sweep();
  if (sweptArtifacts) console.log(`artifacts: removed ${sweptArtifacts} registered report(s) removed a day ago`);
  sc.teleportCwds = new Set<string>();
  // "Continue locally": memory only, like deviceAuths. Started by POST /api/tasks/:id/teleport, not by a terminal socket.
  sc.teleports = new Map<string, TeleportProgress>();
  // Claude Code in a terminal tab: memory only, like teleports; a socket on /ws is sent them all after hello (task.terminals).
  sc.terminals = new Map<string, TerminalStatus>();
  // The compose projects each task started (the kit's `docker` front writes them)
  sc.dockerLogDir = join(sc.cfg.home, "docker");
  mkdirSync(sc.dockerLogDir, { recursive: true });
  sc.mcpPolicy = loadMcpPolicy([join(sc.cfg.home, "mcp.yaml"), sc.shipped(sc.liveRoot, "mcp.yaml")]);
  // The servers added in Settings as the adapters were built from them (main.ts reads the same row before this starts): a change
  // to the saved list takes effect on the next start, so what is sent and where follow this, not the row as it is now.
  sc.bootCustomRunners = new Map(sc.db.getCustomRunners().map((r) => [`custom:${r.name}`, r]));
  /**
   * The wait before a promotion with a restart (promotion.ts `PromotionDrain`): while it holds, a new turn and a new Task
   * queue instead of starting, so the Tasks a restart would cut end and the promotion gets its moment. The Task manager
   * reads it on every start (`drainHold`); a wait past its limit (`settings.release.drainMinutes`) stops holding and what
   * queued starts — no Task is cut for it. In memory only: a daemon always starts with no hold.
   */
  sc.promotionDrain = null;
}

export async function setupTasks(sc: Pick<ServerContextInit, "leaseGate" | "tasks" | "db" | "adapterMap" | "broadcast" | "runnerInfo" | "artifacts" | "opts" | "teleportCwds" | "teleportCwd" | "cfg" | "suggestFor" | "approval" | "pricingTable" | "loginKindOf" | "savedDefaultMode" | "settings" | "attachments" | "localUrl" | "localBacklogEnv" | "mcp" | "dockerLogDir" | "drainHold" | "startMcpServers" | "bedrockOf" | "bedrockTasks" | "adapters" | "history" | "pty">): Promise<void> {
  sc.tasks = new TaskManager(sc.db, sc.adapterMap, sc.broadcast, { runnerForks: (runner) => sc.runnerInfo().find((r) => r.id === runner)?.forks === true, artifacts: sc.artifacts, originOf: sc.opts.gitOrigin, turnGate: (task, by) => sc.leaseGate(task, by), beforeResume: t => { if (t.runner === "claude" && sc.teleportCwds.has(sc.teleportCwd(t.cwd))) throw new Error("Teleport Terminalが使用中です。終了後にLocal Taskを再開してください。"); }, idleMs: sc.cfg.runnerIdleMs, suggest: (input) => sc.suggestFor(input), approval: (task, ask) => {
      const v = sc.approval.evaluate(task, ask);
      // a saved policy answered it: the use is kept with the policy
      if (v.decision === "allow" && v.match.source.startsWith("policy:")) {
        const id = v.match.source.slice("policy:".length);
        writePolicies(sc.db, recordUse(readPolicies(sc.db), id, { at: Date.now(), askId: `approval:${task.id}:${ask.id}`, taskId: task.id, issue: issueOf(task), subject: { kind: "approval", op: ask.kind, target: v.match.subject, conditions: [], head: null } }));
      }
      return v;
    }, pricing: sc.pricingTable, loginKind: (task) => sc.loginKindOf(task.runner, task.id), defaultPermissionMode: sc.savedDefaultMode, subagentEffort: (r) => sc.settings().subagentEffort[r], subagentModel: (r) => sc.settings().subagentModel[r], runnerDefaults: (r) => ({ model: sc.settings().defaultModel[r], effort: sc.settings().defaultEffort[r] }), defaultShadowRunner: () => sc.settings().shadowRunner, defaultFableBudget: () => sc.settings().quotaAndResume.fableBudgetUsd, attachments: sc.attachments, privateTmpRoot: join(sc.cfg.home, "tmp"), waitsDir: waitsDirOf(sc.cfg.home), heavyStateDir: sc.opts.heavyStateDir ?? heavyStateDir(homedir()), deviceAuthEnv: (id) => ({ DEVICE_AUTH_URL: `${sc.localUrl()}/api/tasks/${id}/device-auth`, DEVICE_AUTH_TOKEN_FILE: sc.cfg.tokenPath, SWITCHBOARD_DAEMON_HOME: sc.cfg.home, OPS_KIT_WAITS_DIR: waitsDirOf(sc.cfg.home), BACKLOG_URL: `${sc.localUrl()}/api/backlog`, BACKLOG_TOKEN_FILE: sc.cfg.tokenPath, ...sc.localBacklogEnv(id), ...workspaceConfigEnv({ id: sc.db.getTask(id)?.workspaceId ?? "" }) }), otelFor: (id) => (sc.settings().outbound.classifierLog ? { endpoint: `${sc.localUrl()}/otel/${id}/v1/logs`, token: sc.mcp.issue(id).token } : undefined), runnerTelemetry: () => sc.settings().outbound.runnerTelemetry, dockerEnv: (id) => ({ DOCKER_MARK_LABEL: `${LABEL_KEY}=${id}`, DOCKER_MARK_LOG: join(sc.dockerLogDir, `${id}.jsonl`) }), maxStopResumes: () => sc.settings().quotaAndResume.maxStopResumes, maxRunners: () => sc.settings().maxRunners, memoryHeadroom: () => (process.env.NODE_ENV === "test" ? null : memoryHeadroom()) /* the test daemons do not wait on the host's memory */, holdQueue: sc.cfg.candidate, workMachine: isWorkMachine(sc.cfg), admissionHold: sc.drainHold, reviewRunner: () => sc.settings().reviewRunner, mcpServers: sc.startMcpServers, bedrock: (task) => { const b = sc.bedrockOf(task.runner); if (b) sc.bedrockTasks.add(task.id); else sc.bedrockTasks.delete(task.id); return b; } });
  // Terminal sessions: what Claude Code wrote to ~/.claude/projects while nobody in Switchboard was watching.
  const claudeDanger = new Set((sc.adapters.find((a) => a.id === "claude")?.permissionModes ?? []).filter((m) => m.danger).map((m) => m.value));
  sc.history = new HistoryImporter(sc.db, { projectsDir: sc.cfg.claudeProjectsDir, pollMs: sc.cfg.historyPollMs, pricing: sc.pricingTable, broadcast: sc.broadcast, isLive: (id) => sc.tasks.isLive(id), dangerModes: claudeDanger, log: (m) => console.warn(m) });

  // Terminal tab: null when no PTY can be opened in this distribution.
  sc.pty = await (sc.opts.loadPty ?? (() => PtyManager.load()))();
  if (sc.pty) sc.pty.idleMs = sc.cfg.workspaceShellIdleMs;
}

export function setupJobs(sc: Pick<ServerContextInit, "resumer" | "db" | "tasks" | "savedAutoResume" | "settings" | "githubBudget" | "cfg" | "jobDeps" | "opts" | "runnerChoice" | "pricingTable" | "loginKindOf" | "queueTaskFreed">): void {
  // Usage-limit auto-resume: a task stopped on the runner's limit is continued once it lifts, per-runner setting.
  sc.resumer = new RateLimitResumer(sc.db, sc.tasks, { enabled: sc.savedAutoResume, tunables: () => sc.settings().quotaAndResume, log: (m) => console.log(m), githubBudget: (cwd) => sc.githubBudget.get(cwd) });
  if (!sc.cfg.candidate) sc.resumer.start();
  // Leftovers of tasks that ended while no daemon ran: a task that is over and has nothing planned
  if (!sc.cfg.candidate) {
    void stopEndedTasksProcesses((id) => {
      const t = sc.db.getTask(id);
      return !!t && (t.status === "done" || t.status === "error" || t.status === "aborted") && t.resumeAt === null;
    }, { home: sc.cfg.home }).then((stopped) => {
      for (const [id, n] of stopped) if (n > 0) sc.tasks.record(id, { t: "status", text: `前回のデーモンの間に残った、切り離されたプロセスを ${n} 件止めました` });
    }).catch(() => undefined);
  }
  // Jobs a Task asks for: the daemon's children, with the kit's bin first on PATH as a Task has it (ops-kit
  // heavy / idle-run). A candidate runs on a copy of the database: the live daemon's jobs are not its to end.
  sc.jobDeps = {
    db: sc.db,
    dir: join(sc.cfg.home, "jobs"),
    get env() {
      const meta = sc.db.listWorkspaces().find((w) => w.kind === "meta");
      return { ...process.env, PATH: kitPath(meta?.path ?? null) };
    },
    command: sc.opts.jobCommand,
    reviewChoice: (runner) => sc.runnerChoice(runner, "", ""),
    reviewRunner: () => sc.settings().reviewRunner,
    pricing: sc.pricingTable,
    loginKind: sc.loginKindOf,
    reviewIdleS: sc.cfg.jobReviewIdleS,
    // a build that ended while the daemon was down: its result is written to the PR at the next start (recoverJobs)
    ...(sc.opts.collectPending ? { collectPending: () => sc.opts.collectPending!(sc.jobDeps.env, join(sc.jobDeps.dir, "collect-pending.log")) } : {}),
    // a Task that stopped on `job#<id>` goes on with the job's result, without waiting for the next import
    onFinish: (job) => {
      const workspaceId = sc.db.getTask(job.taskId)?.workspaceId ?? null;
      // a stop that is not depends is not resumed, but its job#<id> is met
      try {
        meetJobConditions({ db: sc.db, tasks: sc.tasks, taskId: job.taskId, jobId: job.id });
      } catch (e) {
        console.error(`[jobs] job#${job.id} conditions after the end: ${String((e as Error)?.message ?? e)}`);
      }
      void (decidesNothing(sc.cfg) ? Promise.resolve([]) : resumeDepends({ db: sc.db, tasks: sc.tasks, workspaceId, now: Date.now() }))
        .catch((e) => console.error(`[jobs] depends resume after job#${job.id}: ${String((e as Error)?.message ?? e)}`))
        // after the resume: a Task it resumed is running again and keeps its place
        .finally(() => sc.queueTaskFreed(job.taskId, "job-end"));
    },
  };
  if (!sc.cfg.candidate) recoverJobs(sc.jobDeps);
}
