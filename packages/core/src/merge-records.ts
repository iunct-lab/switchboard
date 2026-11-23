/** What the app records of a PR that a merge verdict reads: the jobs it ran, the person's grant of a head, and whether it started the Task as a direct one. */

import type { Job } from "@switchboard/protocol";
import type { Db } from "./db.ts";

/** A job as a verdict reads it: the summary and the checkout's folder stay in the app. */
export type MergeRecordJob = Omit<Job, "summary" | "cwd">;

export interface MergeRecords {
  jobs: MergeRecordJob[];
  /** The person's grant to merge-ask for `prs[0]` at `head` (asked as `answer`: a `merge` grant of the same PR and head answers it too, as it does `hasMergeGrant`); null without a Task or a head to ask with. */
  granted: boolean | null;
  /** The Task was started by the app as a direct one and opened `prs[0]`. */
  direct: boolean;
}

export function mergeRecordsOf(db: Pick<Db, "jobsOf" | "hasMergeGrant" | "getTask" | "createdPullsOf">, q: { repo: string; prs: number[]; taskId?: string; head?: string }): MergeRecords {
  const repo = q.repo.toLowerCase();
  const jobs = db.jobsOf(repo, q.prs).map(({ summary: _summary, cwd: _cwd, ...rest }) => rest);
  const pr = q.prs[0];
  const granted = q.taskId && q.head && pr !== undefined ? db.hasMergeGrant(q.taskId, repo, "answer", pr, q.head) : null;
  const direct = !!q.taskId && pr !== undefined && db.getTask(q.taskId)?.stage?.action === "direct" && db.createdPullsOf(q.taskId).some((c) => c.repo.toLowerCase() === repo && c.number === pr);
  return { jobs, granted, direct };
}
