/**
 * A Task resumed when what it waited for closed. A runner that stops on another session's work (parallel-guard's
 * overlap) reports a `depends` stop whose conditions name the PRs / Issues it waits for (`pr#N` / `issue#N`). The backlog
 * import reads those again as the waits the Backlog screen shows, and once every one is closed the stop is over.
 *
 * This file decides which stops are over, from what the import stored (it asks GitHub nothing), and after each import
 * continues each such Task (`resumeDepends`). A stop may also wait on a job the daemon runs for the Task (`job#<id>`,
 * jobs.ts): that one is over when the job ends, and the end of a job runs `resumeDepends` too.
 */
import type { BacklogIssueData, BacklogPullRequestData, BacklogRecord, BacklogSource, Job, StopRecord } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import { afterTime } from "../../../scripts/parallel-guard.ts";
import { issueOf, openStops, type StopReport } from "./stops.ts";
import { ResumeSupersededError, type TaskManager } from "./tasks.ts";
import { isWorking } from "./task-status.ts";

/** A wait key of a stop's condition: a PR or an Issue of the workspace's repository, by number, or a job of the daemon, by id. */
export const WAIT_KEY = /^(pr|issue|job)#(\d+)$/;
/** A job the daemon runs for the Task: its id is no number on GitHub, and is read from the jobs table. */
export const JOB_KEY = /^job#(\d+)$/;
/** A wait for a date: the condition's value is an ISO 8601 time with a time zone, like the `runner#<runner>` value of a usage limit. */
export const AFTER_KEY = "after";

/** How long a Task's stops are looked at after it last changed: the stops' summary covers the same week. */
export const STOP_WAITS_MS = 7 * 24 * 3600_000;

/**
 * The open `depends` stops that wait only on PRs / Issues / jobs (every condition a WAIT_KEY, at least one not met yet),
 * with what they still wait for: `numbers` the PRs / Issues (GitHub's), `jobs` the daemon's jobs, `after` the
 * latest date (ms) among the stop's `after` conditions (a value that is no time with a zone is not a wait). A stop
 * with any other condition is not one of these.
 */
export function dependsWaits(records: StopRecord[]): { stop: StopRecord; numbers: number[]; jobs: number[]; after?: number }[] {
  return openStops(records).flatMap((stop) => {
    const isAfter = (c: { key: string; value: string }) => c.key === AFTER_KEY && !Number.isNaN(afterTime(c.value));
    if (stop.reason !== "depends" || stop.conditions.length === 0 || !stop.conditions.every((c) => WAIT_KEY.test(c.key) || isAfter(c))) return [];
    const times = stop.conditions.filter((c) => !c.met && isAfter(c)).map((c) => afterTime(c.value));
    const after = times.length ? Math.max(...times) : undefined;
    const open = stop.conditions.filter((c) => !c.met && WAIT_KEY.test(c.key)).map((c) => WAIT_KEY.exec(c.key)!);
    const numbers = [...new Set(open.filter((m) => m[1] !== "job").map((m) => Number(m[2])))];
    const jobs = [...new Set(open.filter((m) => m[1] === "job").map((m) => Number(m[2])))];
    return numbers.length || jobs.length || after !== undefined ? [{ stop, numbers, jobs, ...(after !== undefined ? { after } : {}) }] : [];
  });
}

/** The numbers the open `depends` stops of a workspace's Tasks changed in the last week wait for: the import reads them again. */
export function stopWaitNumbers(db: Db, workspaceId: string, now: number): number[] {
  const ids = db.listTasksUpdatedSince(now - STOP_WAITS_MS).filter((t) => t.workspaceId === workspaceId).map((t) => t.id);
  return [...new Set(dependsWaits(db.listStopRecords(ids)).flatMap((w) => w.numbers))].sort((a, b) => a - b);
}

export type WaitState = "closed" | "open" | "unknown";

/** Every wait closed: a date is closed at its time and after. One open, or one not read, keeps the stop. */
export const waitsClosed = (w: { numbers: number[]; jobs?: number[]; after?: number }, stateOf: (n: number) => WaitState, jobStateOf: (id: number) => WaitState = () => "unknown", now: number = Date.now()): boolean =>
  w.numbers.every((n) => stateOf(n) === "closed") && (w.jobs ?? []).every((id) => jobStateOf(id) === "closed") && (w.after === undefined || now >= w.after);

/** How a waited-for job stands: running is open, ended (pass / fail / aborted) is closed, no such job is unknown. */
export const jobWaitState = (db: Pick<Db, "getJob">) => (id: number): WaitState => {
  const job = db.getJob(id);
  return !job ? "unknown" : job.status === "running" ? "open" : "closed";
};

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
export const dependsResumePrompt = (keys: string[], afters: string[] = []) =>
  `${AUTO_RESUME_HEAD} ${[...(keys.length ? [`待っていた ${keys.join("、")} が片づきました`] : []), ...afters.map((a) => `期日 ${a} を過ぎました`)].join("。")}。並列ガードの overlap をやり直してから、中断した箇所から作業を続けてください。`;

/**
 * The follow-up turn of a Task whose waited-for jobs ended: each job's result and summary (status, exit code, the
 * log's last lines and its path), and the other keys that closed with them.
 */
export function jobResumePrompt(jobs: Job[], others: string[] = [], afters: string[] = []): string {
  const lines = jobs.map((j) => [`job#${j.id} ${j.kind}${j.runner ? ` (${j.runner})` : ""} PR #${j.pr}: ${j.status}（終了コード ${j.exitCode ?? "なし"}）`, j.summary ?? ""].filter(Boolean).join("\n"));
  const also = [...(others.length ? [`待っていた ${others.join("、")} も片づきました。`] : []), ...afters.map((a) => `期日 ${a} を過ぎました。`)];
  return `${AUTO_RESUME_HEAD} 頼んだ仕事が終わりました。\n\n${lines.join("\n\n")}${also.length ? `\n\n${also.join("")}` : ""}\n\n結果を読んでから続けてください。`;
}

/**
 * After an import of the workspace: every open depends stop (of its Tasks changed in the last week) whose waits all
 * closed is recorded `resolved` under the same id, its conditions met. A Task started by hand then gets one follow-up
 * turn (`dependsResumePrompt`, every key of those stops), in the same runner session — once no depends stop of it still
 * waits (a runner that stopped twice has two stops; one still open holds the turn back). A stage Task (one for an Issue) gets none: what comes next
 * is backlog-next's, which starts the PBI's next stage Task — sending here too would run two on one PBI.
 * Left as it is: a stop with a wait still open or not read, and a Task with no runner session, one running or waiting,
 * or one with a resume planned (that resume continues it). The record is written before the turn, so the next import
 * does not send a second; a turn that could not be sent puts it back to waiting with the reason, and the next import
 * tries again. One given up for a turn that came first (中断, a reply, a planned resume) stays resolved: that turn goes
 * on. Runs after every import of the workspace that stored (BacklogSync.onImported's `every`), and after a job of one
 * of its Tasks ended (`workspaceId` null = the Tasks without a workspace, whose waits can only be jobs). A stop
 * that waits on a job gets its turn on a stage Task too, with the jobs' results (`jobResumePrompt`): it waits on its own
 * PR's CI or review, which backlog-next does not start. Returns the ids of the Tasks it sent a turn to.
 */
export async function resumeDepends(deps: { db: Db; tasks: Pick<TaskManager, "send" | "recordStop">; workspaceId: string | null; now: number }): Promise<string[]> {
  const { db, tasks, workspaceId, now } = deps;
  const source = workspaceId === null ? null : db.getWorkspaceBacklogSource(workspaceId);
  const stateOf: (n: number) => WaitState = source ? stateFromRecords(db.listBacklogRecords(source), source.project) : () => "unknown";
  const jobStateOf = jobWaitState(db);
  const sent: string[] = [];
  for (const task of db.listTasksUpdatedSince(now - STOP_WAITS_MS)) {
    if (task.workspaceId !== workspaceId) continue;
    const waits = dependsWaits(db.listStopRecords([task.id])).filter((w) => w.stop.work.taskId === task.id);
    const closed = waits.filter((w) => waitsClosed(w, stateOf, jobStateOf, now));
    if (!closed.length) continue;
    const jobKeys = closed.flatMap((w) => w.stop.conditions.filter((c) => JOB_KEY.test(c.key)).map((c) => c.key));
    // a stop on a job stays open while another depends stop of the Task still waits: resolved alone, its result would
    // not be in the turn the last one sends
    if (jobKeys.length && closed.length < waits.length) continue;
    // a stage Task gets no turn here for a PR / Issue — that is backlog-next's — but does for its own jobs
    const turn = issueOf(task) === null || jobKeys.length > 0;
    if (turn && (!task.runnerSessionId || isWorking(task, "dedupe"))) continue;
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
    if (!turn || closed.length < waits.length) continue;
    const keys = [...new Set(closed.flatMap((w) => w.stop.conditions.map((c) => c.key)))].filter((k) => k !== AFTER_KEY);
    const afters = [...new Set(closed.flatMap((w) => w.stop.conditions.filter((c) => c.key === AFTER_KEY).map((c) => c.value)))];
    const ended = [...new Set(jobKeys)].map((k) => db.getJob(Number(JOB_KEY.exec(k)![1]))).filter((j): j is Job => j !== null);
    const prompt = jobKeys.length ? jobResumePrompt(ended, keys.filter((k) => !JOB_KEY.test(k)), afters) : dependsResumePrompt(keys, afters);
    try {
      await tasks.send(task.id, prompt, { daemon: true });
      sent.push(task.id);
    } catch (e) {
      // someone else's turn came first (a reply, a planned resume): it goes on without this one
      if (e instanceof ResumeSupersededError) continue;
      for (const w of closed) tasks.recordStop(task.id, report(w, "waiting", `続きを送れなかった: ${String((e as Error)?.message ?? e).slice(0, 150)}`, false));
    }
  }
  return sent;
}

/**
 * A job can end before its Task wrote the stop on it and ended the turn: `resumeDepends` at the job's end then
 * skips the Task (it is running), and a Task without a workspace has no import to look again. So the end of a turn of
 * a Task with a stop on a job looks again. Returns the unsubscribe.
 */
export function resumeJobsOnTurnEnd(db: Db, tasks: Pick<TaskManager, "send" | "recordStop" | "onTurnEnd">): () => void {
  return tasks.onTurnEnd((id, task) => {
    if (!dependsWaits(db.listStopRecords([id])).some((w) => w.jobs.length)) return;
    void resumeDepends({ db, tasks, workspaceId: task.workspaceId, now: Date.now() }).catch((e) => console.error(`[jobs] depends resume after the turn of ${id}: ${String((e as Error)?.message ?? e)}`));
  });
}

/** How often the daemon looks for a date a stop waits on that has passed (`resumeDueAfters`). */
export const AFTER_CHECK_MS = 5 * 60_000;

/**
 * A date passes without any import or job saying so, and a workspace whose backlog is kept here only, or a Task without a
 * workspace, has no import at all. So every AFTER_CHECK_MS the daemon runs `resumeDepends` for each workspace
 * (null = no workspace) that has a Task with an open depends stop whose date has passed. Returns the Tasks it sent a turn to.
 */
export async function resumeDueAfters(deps: { db: Db; tasks: Pick<TaskManager, "send" | "recordStop">; now: number }): Promise<string[]> {
  const { db, tasks, now } = deps;
  const recent = db.listTasksUpdatedSince(now - STOP_WAITS_MS);
  const wsOf = new Map(recent.map((t) => [t.id, t.workspaceId ?? null] as const));
  const due = new Set(dependsWaits(db.listStopRecords(recent.map((t) => t.id))).filter((w) => w.after !== undefined && now >= w.after).map((w) => wsOf.get(w.stop.work.taskId) ?? null));
  const sent: string[] = [];
  for (const workspaceId of due) sent.push(...(await resumeDepends({ db, tasks, workspaceId, now })));
  return sent;
}
