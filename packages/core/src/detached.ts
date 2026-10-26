import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Processes a task left behind (#1397). The runner's environment carries
 * SWITCHBOARD_TASK_ID; anything the task started (setsid and nohup keep the environment) still has it in
 * /proc/<pid>/environ after leaving the process tree. Linux only: without /proc nothing is found.
 */
export const TASK_MARK = "SWITCHBOARD_TASK_ID";

export const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "latin1");
  } catch {
    return undefined;
  }
};

export const HOME_MARK = "SWITCHBOARD_DAEMON_HOME";

/** What the daemon itself started a process for (`judge` = a scoring / rubric / suggestion turn), for the load sampler (#2086). */
export const DAEMON_JOB_MARK = "SWITCHBOARD_DAEMON_JOB";

export const statFields = (procRoot: string, pid: number): string[] | undefined => {
  const stat = read(join(procRoot, String(pid), "stat"));
  // "pid (comm) S ppid pgrp session ...": comm may hold spaces and parentheses, so cut after the last ")"
  return stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ") : undefined;
};

/** The pids of `pid` and its ancestors up to 1, from <procRoot>/<pid>/stat (the daemon, sb-rescue, scripts/dev.ts). */
function selfAndAncestors(procRoot: string): Set<number> {
  const out = new Set<number>();
  let pid = process.pid;
  while (pid > 1 && !out.has(pid)) {
    out.add(pid);
    const f = statFields(procRoot, pid);
    if (!f) break;
    const ppid = Number(f[1]);
    if (!Number.isInteger(ppid)) break;
    pid = ppid;
  }
  return out;
}

/** Task id -> pids that carry its mark. The daemon and its ancestors are never listed. */
export function taskIdsInProcesses(procRoot = "/proc", home?: string): Map<string, number[]> {
  const found = new Map<string, number[]>();
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return found;
  }
  const skip = selfAndAncestors(procRoot);
  // A daemon started from a task carries that task's mark in its initial environment, and so do the siblings it
  // started (scripts/dev.ts's vite): the daemon's own session is never a task's detached process
  const session = statFields(procRoot, process.pid)?.[3];
  const prefix = `${TASK_MARK}=`;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    const environ = read(join(procRoot, name, "environ"));
    if (!environ) continue;
    if (session !== undefined && statFields(procRoot, pid)?.[3] === session) continue;
    const entries = environ.split("\0");
    if (home !== undefined && !entries.includes(`${HOME_MARK}=${home}`)) continue; // another daemon's task
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const id = entry.slice(prefix.length);
      if (id) found.set(id, [...(found.get(id) ?? []), pid]);
      break;
    }
  }
  return found;
}

export function taskProcesses(taskId: string, procRoot = "/proc", home?: string): number[] {
  return taskIdsInProcesses(procRoot, home).get(taskId) ?? [];
}

const kill = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    // ESRCH (gone already) or EPERM (not ours): nothing to do
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM, then SIGKILL for what is still there after `graceMs`. Returns how many were found. */
export async function stopPids(pids: number[], graceMs = 2000): Promise<number> {
  for (const pid of pids) kill(pid, "SIGTERM");
  if (pids.length === 0) return 0;
  const until = Date.now() + graceMs;
  while (Date.now() < until && pids.some(alive)) await new Promise((r) => setTimeout(r, 50));
  for (const pid of pids) if (alive(pid)) kill(pid, "SIGKILL");
  return pids.length;
}

export async function stopTaskProcesses(taskId: string, opts: { procRoot?: string; graceMs?: number; home?: string } = {}): Promise<number> {
  return stopPids(taskProcesses(taskId, opts.procRoot, opts.home), opts.graceMs);
}

/**
 * At the daemon's start: what tasks that ended while no daemon ran left behind. `isEnded` says which ids are over
 * (terminal and nothing planned); a mark of a task not known to it, or still going, is left alone.
 */
export async function stopEndedTasksProcesses(isEnded: (taskId: string) => boolean, opts: { procRoot?: string; graceMs?: number; home?: string } = {}): Promise<Map<string, number>> {
  const stopped = new Map<string, number>();
  for (const [id, pids] of taskIdsInProcesses(opts.procRoot, opts.home)) {
    if (!isEnded(id)) continue;
    stopped.set(id, await stopPids(pids, opts.graceMs));
  }
  return stopped;
}
