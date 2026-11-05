/**
 * A Task resumed when what it waited for closed (#2045). A runner that stops on another session's work (parallel-guard's
 * overlap) reports a `depends` stop whose conditions name the PRs / Issues it waits for (`pr#N` / `issue#N`). The backlog
 * import reads those again with the waits of #817, and once every one is closed the stop is over.
 *
 * This file decides which stops are over, from what the import stored (it asks GitHub nothing), and after each import
 * continues each such Task (`resumeDepends`).
 */
import type { BacklogIssueData, BacklogPullRequestData, BacklogRecord, BacklogSource, StopRecord } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import { issueOf, openStops, type StopReport } from "./stops.ts";
import { ResumeSupersededError, type TaskManager } from "./tasks.ts";

/** A wait key of a stop's condition: a PR or an Issue of the workspace's repository, by number. */
export const WAIT_KEY = /^(pr|issue)#(\d+)$/;

/** How long a Task's stops are looked at after it last changed: the stops' summary covers the same week. */
export const STOP_WAITS_MS = 7 * 24 * 3600_000;

/**
 * The open `depends` stops that wait only on PRs / Issues (every condition a WAIT_KEY, at least one not met yet), with
 * the numbers they still wait for. A stop with any other condition (a time, a value) is not one of these.
 */
export function dependsWaits(records: StopRecord[]): { stop: StopRecord; numbers: number[] }[] {
  return openStops(records).flatMap((stop) => {
    if (stop.reason !== "depends" || stop.conditions.length === 0 || !stop.conditions.every((c) => WAIT_KEY.test(c.key))) return [];
    const numbers = stop.conditions.filter((c) => !c.met).map((c) => Number(WAIT_KEY.exec(c.key)![2]));
    return numbers.length ? [{ stop, numbers: [...new Set(numbers)] }] : [];
  });
}

/** The numbers the open `depends` stops of a workspace's Tasks changed in the last week wait for: the import reads them again. */
export function stopWaitNumbers(db: Db, workspaceId: string, now: number): number[] {
  const ids = db.listTasksUpdatedSince(now - STOP_WAITS_MS).filter((t) => t.workspaceId === workspaceId).map((t) => t.id);
  return [...new Set(dependsWaits(db.listStopRecords(ids)).flatMap((w) => w.numbers))].sort((a, b) => a - b);
}

export type WaitState = "closed" | "open" | "unknown";

/** Every wait closed. One open, or one not read, keeps the stop. */
export const waitsClosed = (w: { numbers: number[] }, stateOf: (n: number) => WaitState): boolean => w.numbers.every((n) => stateOf(n) === "closed");

/**
 * How a waited-for number stands, from the stored records: a PR merged or closed is closed; an Issue closed, or a Task
 * (`type:task`) whose Status on the workspace's Project is not In progress any more (it went back to Backlog, to In
 * review, …), is closed. Not stored, not read as it is, or a Task without a Status there, is unknown. An edit made here and
 * not sent yet (`local`) counts over what GitHub last answered, as the backlog shows it.
 */
export function stateFromRecords(records: BacklogRecord[], project: BacklogSource["project"]): (n: number) => WaitState {
  const issues = new Map<number, BacklogIssueData>();
  const pulls = new Map<number, BacklogPullRequestData>();
  const status = new Map<number, string | number | null>();
  for (const r of records) {
    if (r.fetchState !== "fetched" || !r.remote) continue;
    if (r.objectKind === "issue" && !r.externalId.startsWith("sb:")) issues.set(r.remote.number, r.local ?? r.remote);
    else if (r.objectKind === "pull-request") pulls.set(r.remote.number, r.remote);
    else if (r.objectKind === "project-item") {
      const v = r.local ?? r.remote;
      if (v.owner.toLowerCase() === project.owner.toLowerCase() && v.project === project.number) status.set(v.issue, v.fields.Status ?? null);
    }
  }
  return (n) => {
    const pr = pulls.get(n);
    if (pr) return pr.state === "OPEN" ? "open" : "closed";
    const issue = issues.get(n);
    if (!issue) return "unknown";
    if (issue.state === "CLOSED") return "closed";
    if (!issue.labels.includes("type:task")) return "open";
    const s = status.get(n);
    if (s === undefined || s === null) return "unknown";
    return s === "In progress" ? "open" : "closed";
  };
}

/** The follow-up turn of a Task whose waits closed: it says what closed, and to look at the overlap again before going on. */
export const dependsResumePrompt = (keys: string[]) =>
  `${AUTO_RESUME_HEAD} 待っていた ${keys.join("、")} が片づきました。並列ガードの overlap をやり直してから、中断した箇所から作業を続けてください。`;

/**
 * After an import of the workspace: every open depends stop (of its Tasks changed in the last week) whose waits all
 * closed is recorded `resolved` under the same id, its conditions met. A Task started by hand then gets one follow-up
 * turn (`dependsResumePrompt`, every key of those stops), in the same runner session — once no depends stop of it still
 * waits (a runner that stopped twice has two stops; one still open holds the turn back). A stage Task (one for an Issue, #1139) gets none: what comes next
 * is backlog-next's, which starts the PBI's next stage Task (#817) — sending here too would run two on one PBI.
 * Left as it is: a stop with a wait still open or not read, and a Task with no runner session, one running or waiting,
 * or one with a resume planned (that resume continues it). The record is written before the turn, so the next import
 * does not send a second; a turn that could not be sent puts it back to waiting with the reason, and the next import
 * tries again. One given up for a turn that came first (中断, a reply, a planned resume) stays resolved: that turn goes
 * on. Runs after every import of the workspace that stored (BacklogSync.onImported's `every`). Returns the ids of the
 * Tasks it sent a turn to.
 */
export async function resumeDepends(deps: { db: Db; tasks: Pick<TaskManager, "send" | "recordStop">; workspaceId: string; now: number }): Promise<string[]> {
  const { db, tasks, workspaceId, now } = deps;
  const source = db.getWorkspaceBacklogSource(workspaceId);
  if (!source) return [];
  const stateOf = stateFromRecords(db.listBacklogRecords(source), source.project);
  const sent: string[] = [];
  for (const task of db.listTasksUpdatedSince(now - STOP_WAITS_MS)) {
    if (task.workspaceId !== workspaceId) continue;
    const stage = issueOf(task) !== null;
    if (!stage && (!task.runnerSessionId || task.status === "running" || task.status === "waiting" || task.resumeAt !== null)) continue;
    const waits = dependsWaits(db.listStopRecords([task.id])).filter((w) => w.stop.work.taskId === task.id);
    const closed = waits.filter((w) => waitsClosed(w, stateOf));
    if (!closed.length) continue;
    const report = (w: (typeof waits)[number], state: StopRecord["state"], what: string, ok: boolean): StopReport => ({
      id: w.stop.id.slice(task.id.length + 1),
      op: w.stop.op,
      target: w.stop.target,
      reason: w.stop.reason,
      evidence: w.stop.evidence,
      safety: w.stop.safety,
      conditions: w.stop.conditions.map((c) => (state === "resolved" ? { ...c, met: true } : c)),
      actions: [...w.stop.actions, { attempt: w.stop.actions.length + 1, at: now, what, ok }].slice(-20),
      state,
      ...(w.stop.grant !== undefined ? { grant: w.stop.grant } : {}),
    });
    for (const w of closed) tasks.recordStop(task.id, report(w, "resolved", `待ちが片づいた: ${w.stop.conditions.map((c) => c.key).join(", ")}`, true));
    // one turn for the Task, once none of its waits is open any more (a runner that stopped twice has two stops)
    if (stage || closed.length < waits.length) continue;
    const keys = [...new Set(closed.flatMap((w) => w.stop.conditions.map((c) => c.key)))];
    try {
      await tasks.send(task.id, dependsResumePrompt(keys), { daemon: true });
      sent.push(task.id);
    } catch (e) {
      // someone else's turn came first (a reply, a planned resume): it goes on without this one
      if (e instanceof ResumeSupersededError) continue;
      for (const w of closed) tasks.recordStop(task.id, report(w, "waiting", `続きを送れなかった: ${String((e as Error)?.message ?? e).slice(0, 150)}`, false));
    }
  }
  return sent;
}
