import { decidesNothing, isWorkMachine } from "../machine.ts";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { type CleanExit, endDaemonRun, daemonVersion, readBootId, readJournal, readReleaseHistory, startDaemonRun } from "../ops-stops.ts";
import { RESTART_EXIT_CODE, spawnDetached } from "../selfdev.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { readShippedDefaults, seedWorkspaces } from "./helpers.ts";
import { homedir } from "node:os";
import { abortOrphanedTasks, Db } from "../db.ts";
import { OpsLoadSampler } from "../ops-load.ts";
import { AFTER_CHECK_MS, resumeDueAfters, resumeJobsOnTurnEnd, type WaitState } from "../depends-resume.ts";
import { boundsOf, checkWaits, WAIT_CHECK_MS, waitsDirOf } from "../waits.ts";
import { startWorktreeSweep } from "../worktree-sweep.ts";
import { startSettleSweep } from "../task-settle.ts";
import { writeConfigFiles } from "../workspace-config.ts";
import { TURN_DONE } from "../task-status.ts";
import { sweepPrivateTmps } from "../tasks/sessions.ts";
import { HostIdle, type IdleInput } from "../hostidle.ts";
import { createDockerdIdle } from "../dockerd-idle.ts";

export async function performRestart(sc: Pick<ServerContext, "db" | "restarting" | "broadcast" | "stopAll" | "cfg" | "server">, argv: string[], supervised: boolean, force: boolean) {
  // Re-check the gate right before stopping: a task may have started in the meantime.
  if (!force && sc.db.listWorkingTasks("gate").length > 0) {
    sc.restarting = false;
    sc.broadcast({ type: "error", message: "restart cancelled: a task started meanwhile" });
    return;
  }
  try {
    await sc.stopAll("restart");
  } catch (e) {
    console.error(`restart: stop failed (${String((e as Error).message ?? e)}); exiting anyway`);
  }
  if (supervised) process.exit(RESTART_EXIT_CODE);
  try {
    spawnDetached(argv, sc.cfg.home, process.cwd(), { ...ownUplinkEnv, ...(sc.cfg.idleStopCmd ? { SWITCHBOARD_IDLE_STOP_CMD: sc.cfg.idleStopCmd } : {}) });
  } catch (e) {
    console.error(`restart: could not spawn the replacement (${String((e as Error).message ?? e)}); restarting on the old code`);
    process.exit(RESTART_EXIT_CODE);
  }
  // Hand over only once the replacement serves; otherwise we cannot help from here, so exit with the restart code
  // (a supervisor respawns us; standalone the user re-runs `bun run core` — the log says why).
  const port = sc.server.port ?? sc.cfg.port;
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

/** Re-read what the shipped version carries. A broken or missing shipped file keeps the previous value (the user's copy under home still wins first). */
export const reloadRelease = (sc: Pick<ServerContext, "cfg" | "routing" | "pricing" | "mcpPolicy" | "mcp" | "liveRoot" | "webDist">): string | null => {
  let root: string;
  try { root = realpathSync(join(sc.cfg.home, "releases", "current")); } catch { return null; }
  const next = readShippedDefaults(sc.cfg.home, root);
  for (const why of next.kept) console.warn(`release reload: keeping the previous ${why}`);
  if (next.routing) Object.assign(sc.routing, next.routing);
  if (next.pricing) Object.assign(sc.pricing, next.pricing);
  if (next.mcpPolicy) {
    sc.mcpPolicy = next.mcpPolicy;
    sc.mcp.setPolicy(sc.mcpPolicy);
  }
  sc.liveRoot = root;
  sc.webDist = join(root, "apps", "web", "dist");
  return basename(root);
};

export const stopAll = async (sc: Pick<ServerContext, "adviceStop" | "adviceRunning" | "recheckTimer" | "uplinkTimer" | "leaseTimer" | "promotionTimer" | "afterTimer" | "waitTimer" | "stopWorktreeSweep" | "stopSettleSweep" | "history" | "knowledge" | "scheduler" | "resumer" | "backlog" | "hostIdle" | "dockerdIdle" | "opsLoadSampler" | "runnerLogins" | "githubLogins" | "deviceAuths" | "selfdev" | "pty" | "mcp" | "tasks" | "runId" | "db" | "judgeStop" | "applying" | "server" | "apiRequestsTimer" | "snapshotTimer" | "stopped" | "flushApiRequests">, cleanExit: CleanExit = "shutdown") => {
  sc.adviceStop.abort(new Error("the daemon is stopping"));
  await Promise.all(sc.adviceRunning);
  clearInterval(sc.recheckTimer);
  if (sc.uplinkTimer) clearInterval(sc.uplinkTimer);
  if (sc.leaseTimer) clearInterval(sc.leaseTimer);
  if (sc.promotionTimer) clearTimeout(sc.promotionTimer);
  if (sc.afterTimer) clearInterval(sc.afterTimer);
  clearInterval(sc.waitTimer);
  sc.stopWorktreeSweep?.();
  sc.stopSettleSweep?.();
  sc.history.stop();
  sc.knowledge.close();
  sc.scheduler.stop();
  sc.resumer.stop();
  sc.backlog.stop();
  sc.hostIdle?.stop();
  sc.dockerdIdle?.stop();
  sc.opsLoadSampler?.stop();
  sc.runnerLogins.stop();
  sc.githubLogins.stop();
  sc.deviceAuths.stop();
  sc.selfdev.cancelAll();
  sc.pty?.closeAll();
  await sc.mcp.revokeAll();
  const cut = await sc.tasks.shutdown();
  if (sc.runId !== null) endDaemonRun(sc.db, sc.runId, { cleanExit, endedAt: Date.now(), taskIds: cut });
  sc.runId = null; // a second stop finds the database closed
  sc.judgeStop.abort();
  // a policy being applied finishes before the database goes
  await sc.applying;
  sc.server.stop(true);
  clearInterval(sc.apiRequestsTimer);
  clearInterval(sc.snapshotTimer);
  sc.stopped = true;
  sc.flushApiRequests();
  sc.db.close();
};

export function setupHome(sc: Pick<ServerContextInit, "db" | "cfg" | "webhookOpen">): void {
  sc.db = new Db(sc.cfg.dbPath);
  try {
    // only a finished task of this database, with no resume planned (another daemon's, or one that may continue, stays)
    sweepPrivateTmps(join(sc.cfg.home, "tmp"), 3 * 24 * 3600 * 1000, (id) => {
      const t = sc.db.getTask(id);
      return t !== null && t.resumeAt === null && ["done", "error", "aborted"].includes(t.status); // TERMINAL, not TURN_ENDED: a background process still uses the tmp
    });
  } catch {
    // the sweep is housekeeping
  }
  seedWorkspaces(sc.db, sc.cfg);
  // the settings kept here for repositories that have no `ops.config.json`: written where the kit and the scripts read them
  writeConfigFiles(sc.cfg.home, sc.db);
  // The Webhook route is open without the token only with a Secret to verify the deliveries against
  sc.webhookOpen = sc.cfg.githubWebhook && !!sc.cfg.githubWebhookSecret;
  if (sc.cfg.githubWebhook && !sc.cfg.githubWebhookSecret) console.warn("backlog: SWITCHBOARD_GITHUB_WEBHOOK=1 but SWITCHBOARD_GITHUB_WEBHOOK_SECRET is unset: the webhook route stays closed (asks for the token)");
}

/**
 * What the host's idle stop counts. `pty` is the shells that still count (`PtyManager.busy`): a Workspace's shell left
 * with no socket, input or output for its idle bound is not one of them, so a forgotten one cannot keep the host up.
 */
export const idleInput = (sc: Pick<ServerContextInit, "db" | "tasks" | "wsCount" | "pty" | "nextWakeAt">, now: number = Date.now()): IdleInput => ({
  running: sc.db.listTasksByStatus("running").length,
  waiting: sc.db.listTasksByStatus("waiting").length,
  background: sc.tasks.backgroundJobs() + sc.db.listJobs(Number.MAX_SAFE_INTEGER).length /* the running jobs */,
  ws: sc.wsCount,
  pty: sc.pty?.busy(now) ?? 0,
  nextWakeAt: sc.nextWakeAt(),
});

/** The uplink's mode, which only this daemon and its own replacement may carry (setupTimers removes it from the environment). */
const UPLINK_OWN = ["SWITCHBOARD_UPLINK", "SWITCHBOARD_UPLINK_PREVIEW", "SWITCHBOARD_UPLINK_MACHINES"] as const;
const ownUplinkEnv: Record<string, string> = {};

/**
 * The look for stops whose wait is over without an import or a job saying so: a date that has passed, and a promotion the
 * running version now contains (`promoted#<sha>`). An import or a job's end does not ask git.
 */
export const resumeDueWaits = (sc: Pick<ServerContextInit, "db" | "tasks" | "releasedOf">, now = Date.now()): Promise<string[]> => {
  const promotedOf = (sha: string) => sc.releasedOf(sha).then((r): WaitState => (r === null ? "unknown" : r ? "closed" : "open"));
  return resumeDueAfters({ db: sc.db, tasks: sc.tasks, now, promotedOf }).catch((e) => {
    console.error(`[stops] depends resume after a date or a promotion: ${String((e as Error)?.message ?? e)}`);
    return [];
  });
};

export function setupTimers(sc: Pick<ServerContextInit, "hostIdle" | "cfg" | "db" | "tasks" | "wsCount" | "pty" | "nextWakeAt" | "dockerdIdle" | "afterTimer" | "opts" | "waitsChecking" | "waitTimer" | "settings" | "broadcast" | "stopWorktreeSweep" | "stopSettleSweep" | "restarting" | "resumeDueWaits">): void {
  // The stop command is this daemon's alone: runners, terminal shells and what they start must not inherit it. A
  // scratch daemon a Task boots with `loadConfig({ ...process.env, … })` would otherwise count only its own empty
  // database, and 20 minutes later stop the host under the Tasks this daemon is running.
  delete process.env.SWITCHBOARD_IDLE_STOP_CMD;
  // The uplink's mode is this daemon's alone too (the instance's sb-env or a work machine's env file sets it): a scratch
  // daemon a Task boots from the inherited environment would otherwise take leases and write exports as this machine.
  // Without the second variable no mode is read (loadUplink), and the others name nothing a child needs.
  // Its own replacement (a restart without a supervisor) gets them back, as the stop command (performRestart).
  for (const name of UPLINK_OWN) {
    const v = process.env[name];
    if (v !== undefined) ownUplinkEnv[name] = v;
    delete process.env[name];
  }
  sc.hostIdle = sc.cfg.idleStopCmd && !sc.cfg.candidate
      ? new HostIdle(
          () => idleInput(sc),
          (at) => {
            const arg = at === null ? "-" : new Date(at).toISOString();
            console.log(`hostidle: idle for 20 minutes; running ${sc.cfg.idleStopCmd} ${arg}`);
            try {
              Bun.spawn([sc.cfg.idleStopCmd!, arg], { stdout: "inherit", stderr: "inherit" });
            } catch (e) {
              console.error(`hostidle: ${sc.cfg.idleStopCmd} failed to start: ${String((e as Error).message ?? e)}`);
            }
          },
        )
      : null;
  sc.hostIdle?.start();
  sc.dockerdIdle = createDockerdIdle(sc.cfg, homedir());
  sc.dockerdIdle?.start();
  sc.tasks.onTurnEnd(() => sc.hostIdle?.touch());
  if (!decidesNothing(sc.cfg)) resumeJobsOnTurnEnd(sc.db, sc.tasks);
  // a stop that waits on a date goes on once the date has passed, in a workspace with no import too, and one that waits on a
  // promotion once the running version contains it (looked at once more after the port is ours: setupAfterListen)
  const resumeDue = () => void sc.resumeDueWaits();
  sc.afterTimer = decidesNothing(sc.cfg) ? null : setInterval(resumeDue, sc.opts.afterCheckMs ?? AFTER_CHECK_MS);
  sc.afterTimer?.unref();
  // what every Task waits for and until when, looked at in one place: the screens show it, and a wait past its limit or a silent runner is the person's to see
  sc.waitsChecking = false;
  sc.waitTimer = setInterval(() => {
    if (sc.waitsChecking) return;
    sc.waitsChecking = true;
    void checkWaits({ db: sc.db, tasks: sc.tasks, dir: waitsDirOf(sc.cfg.home), bounds: () => boundsOf(sc.settings().quotaAndResume), broadcastTask: (task) => sc.broadcast({ type: "task.updated", task }) }, Date.now())
      .catch((e) => console.error(`[waits] check failed: ${String((e as Error)?.message ?? e)}`))
      .finally(() => { sc.waitsChecking = false; });
  }, sc.opts.waitCheckMs ?? WAIT_CHECK_MS);
  sc.waitTimer.unref();
  // the worktrees Tasks leave beside a repository go once nothing in them can be lost (all in the default branch, no change, a day old, unused), in every workspace's repository
  sc.stopWorktreeSweep = startWorktreeSweep({ candidate: !!sc.cfg.candidate, read: () => ({ workspaces: sc.db.listWorkspaces(), tasks: sc.db.listTasks() }) });
  // a stopped Task whose wait is over (its Issue closed, a newer Task of the Issue or the schedule started) leaves 要対応 and 待ち. Not on a
  // work machine (the instance settles the Tasks it takes in). A candidate does: it writes its own copy only, and shows what the version would
  sc.stopSettleSweep = isWorkMachine(sc.cfg) ? null : startSettleSweep({ db: sc.db, tasks: sc.tasks });
  sc.restarting = false;
}

export function setupAfterListen(sc: Pick<ServerContextInit, "db" | "settings" | "tasks" | "resumeDueWaits" | "afterTimer" | "countRules" | "opsLoadSampler" | "cfg" | "runId" | "lastJudgingAt" | "judgeReply" | "firstPass" | "history">): void {
  // Only once the port is ours: a second daemon on the same home would otherwise close the live daemon's tasks and
  // then die on EADDRINUSE. Tasks still running / waiting now belong to nobody.
  const orphaned = abortOrphanedTasks(sc.db, Date.now(), sc.settings().quotaAndResume.maxStopResumes);
  if (orphaned.length) console.warn(`tasks: ${orphaned.length} left running/waiting by a previous daemon marked aborted (${orphaned.join(", ")})`);
  // The Tasks the previous daemon left waiting for a slot start now (a candidate leaves them: `holdQueue`)
  sc.tasks.drain();
  // A promotion restarts the daemon, so a Task waiting on it can go on right now (a date that passed while no daemon ran too).
  // Not before the port is ours: a second daemon on the same home would otherwise resolve the live daemon's waits.
  if (sc.afterTimer) void sc.resumeDueWaits();
  // their rows were saved at the turn before the cut; the stop just written changes the counts
  for (const id of orphaned) {
    const t = sc.db.getTask(id);
    if (t && t.executionMode !== "cloud") {
      try {
        sc.countRules(t);
      } catch (e) {
        console.warn(`evals: recount after the stop failed for ${id}: ${(e as Error).message}`);
      }
    }
  }
  // The host's load once a minute. A candidate on a spare port shares the unit: the live daemon samples it
  sc.opsLoadSampler = sc.cfg.candidate ? null : new OpsLoadSampler(sc.db, { home: sc.cfg.home });
  sc.opsLoadSampler?.start();
  // This start's row in daemon_runs: closes the previous one with its cause. A candidate runs on a copy.
  sc.runId = sc.cfg.candidate
    ? null
    : startDaemonRun(sc.db, { now: Date.now(), version: daemonVersion(sc.cfg), bootId: readBootId(), journal: readJournal, history: readReleaseHistory(sc.cfg.home), orphaned: orphaned.filter((id) => sc.db.getTask(id)?.executionMode !== "cloud") });
  // A judgement the last daemon was cut off in is made again, once; a mark that no longer fits is dropped.
  const cutOff = sc.db.listTasksJudging();
  let rejudged = 0;
  for (const t of cutOff) {
    const text = sc.db.lastReply(t.id)?.text.trim();
    if (TURN_DONE.has(t.status) && t.outcome === "unknown" && !t.shadowOf && t.executionMode !== "cloud" && sc.settings().judge.enabled && text && t.judgingAt !== null) {
      sc.lastJudgingAt = Math.max(sc.lastJudgingAt, t.judgingAt);
      sc.judgeReply(t.id, t, text, t.judgingAt);
      rejudged++;
    } else sc.db.updateTask(t.id, { judgingAt: null, updatedAt: t.updatedAt });
  }
  if (rejudged) console.warn(`judge: ${rejudged} task(s) left judging by a previous daemon judged again`);
  // The first pass over the session logs is deferred so the port answers first; later passes follow growing files.
  sc.firstPass = true;
  if (!sc.cfg.candidate) sc.history.start((r) => {
    if (r.created || r.appended) console.log(`history: ${r.created} terminal session(s) imported, ${r.appended} task(s) extended from ${sc.cfg.claudeProjectsDir}`);
    if (sc.firstPass && r.skippedForeign) console.log(`history: ${r.skippedForeign} session log(s) outside any workspace (add the workspace to import them)`);
    sc.firstPass = false; // errors are logged by the importer itself, each distinct one once
  });
}
