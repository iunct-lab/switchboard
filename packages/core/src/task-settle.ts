import { personWait, type Task } from "@switchboard/protocol";
import { storedEnds } from "./backlog-stored.ts";
import type { Db } from "./db.ts";
import type { TaskManager } from "./tasks/manager.ts";

/** The stored facts `settleReason` reads: whether a stage Issue ended, and the newest Task of the same stage Issue / the same schedule. */
export interface SettleFacts {
  /** Whether the Issue is closed in the stored records; an Issue not read is not. */
  stageEnded: (workspaceId: string, issue: number) => boolean;
  /** The newest stage Task of the Issue in the workspace; null = none. */
  newestStageTask: (workspaceId: string, issue: number) => Pick<Task, "id" | "createdAt"> | null;
  /** The newest Task of the schedule; null = none. */
  newestRun: (scheduleId: string) => Pick<Task, "id" | "createdAt"> | null;
}

/**
 * Why a stopped Task no longer waits on anyone, or null while it does: what it waited for is over. Its stage Issue is
 * closed, another stage Task of the same Issue started after it stopped (the rule the 判断待ち screen takes a check off
 * by), or — for a Task of no stage — a later run of its schedule started after it stopped. Only a Task under 要対応 or 待ち is one (`personWait`
 * needs / unjudged / waits): an open approval, a Task at work and a failed one are not. The newest stage Task of an
 * open Issue and the newest run of a schedule never are, and a Task with neither a stage nor a schedule never is.
 */
export function settleReason(task: Task, facts: SettleFacts): string | null {
  const wait = personWait(task);
  if (task.status === "waiting" || (wait !== "needs" && wait !== "unjudged" && wait !== "waits")) return null;
  const issue = task.stage?.issue;
  if (task.workspaceId && issue !== undefined) {
    if (facts.stageEnded(task.workspaceId, issue)) return `#${issue} が閉じた`;
    const newest = facts.newestStageTask(task.workspaceId, issue);
    if (newest && newest.id !== task.id && newest.createdAt > task.updatedAt) return `#${issue} のより新しい工程 Task が始まった`;
  }
  // a stage Task the backlog schedule started carries that schedule's id: its later runs are other Issues' Tasks, not this one's
  if (task.scheduleId && issue === undefined) {
    const newest = facts.newestRun(task.scheduleId);
    if (newest && newest.id !== task.id && newest.createdAt > task.updatedAt) return "同じ定期実行のより新しい回が始まった";
  }
  return null;
}

/** How a settled Task's record starts (a `status` event): the sweep does not settle a Task that has one since it last stopped. */
export const SETTLE_MARK = "確認済みにした（相手が終わった）";

/** The first sweep after the daemon started, and the time between sweeps. Only stored records are read, so the machine's size does not move these. */
export const SETTLE_FIRST_MS = 10_000;
export const SETTLE_INTERVAL_MS = 5 * 60_000;

export interface SettleDeps {
  db: Db;
  tasks: Pick<TaskManager, "setOutcome" | "record">;
}

/**
 * Marks 確認済み every stopped Task whose wait is over (`settleReason`), with the reason on its record, and returns how
 * many. 確認済み is what takes a Task off 要対応 and 待ち everywhere (`personWait`); the outcome is left as it ended. A
 * Task the person put back (確認済み off) stays: it was settled since it last stopped, whatever was written on its
 * record after. Once it stopped again after a new turn it is judged afresh. A workspace whose backlog is not stored
 * has no closed Issue here, so only a newer Task settles one of its Tasks.
 */
export function settleGoneTasks({ db, tasks }: SettleDeps): number {
  const ends = new Map<string, ReturnType<typeof storedEnds>>();
  const facts: SettleFacts = {
    stageEnded: (ws, n) => (ends.get(ws) ?? ends.set(ws, storedEnds(db, { id: ws })).get(ws)!)(n)?.kind === "issue",
    newestStageTask: (ws, n) => db.lastStageTask(ws, n),
    newestRun: (scheduleId) => {
      const [id] = db.recentScheduleTaskIds(scheduleId, 1);
      return id ? db.getTask(id) : null;
    },
  };
  const gone = db.listSettleCandidates().flatMap((task) => {
    const reason = settleReason(task, facts);
    return reason === null || db.hasStatusRecordSince(task.id, SETTLE_MARK, task.statusAt) ? [] : [{ id: task.id, reason }];
  });
  // one transaction for the first sweep after this is deployed, which settles hundreds
  db.sqlite.transaction(() => {
    for (const { id, reason } of gone) {
      tasks.setOutcome(id, { reviewed: true });
      tasks.record(id, { t: "status", text: `${SETTLE_MARK}: ${reason}` });
    }
  })();
  return gone.length;
}

/** Starts the daemon's sweep: `firstMs` after start, then every `everyMs`. A failed sweep is logged and the next one runs. Returns the stop. */
export function startSettleSweep(o: SettleDeps & { firstMs?: number; everyMs?: number }): () => void {
  const run = () => {
    try {
      const n = settleGoneTasks(o);
      if (n > 0) console.log(`[settle] ${n} Task(s) whose wait is over marked reviewed`);
    } catch (e) {
      console.error(`[settle] ${String((e as Error)?.message ?? e)}`);
    }
  };
  const first = setTimeout(run, o.firstMs ?? SETTLE_FIRST_MS);
  const every = setInterval(run, o.everyMs ?? SETTLE_INTERVAL_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
