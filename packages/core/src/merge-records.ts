/** What the app records of a PR that a merge verdict reads: the jobs it ran, the person's grant of a head, and whether it started the Task as a direct one. */

import type { BacklogCommentData, BacklogPullRequestData, Job } from "@switchboard/protocol";
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

/** A job as a period's reading takes it: the Task's runner comes with it, since the runner that implemented a PR is the runner of the Task that asked for its jobs. */
export type MergeHistoryJob = MergeRecordJob & { taskRunner: string | null };

export interface MergeHistory {
  jobs: MergeHistoryJob[];
  /** The person's merge and answer grants of these PRs, each of the head it was given for. */
  grants: Array<{ taskId: string; target: number; head: string; at: number }>;
  /**
   * The PRs the period touched: the stored ones updated since `sinceMs` and the PRs of the jobs started since (a PR with
   * jobs and no stored record is `stored: false`: the import saw it neither open nor at its close, so it has no comments
   * and no state here). `head` is null for a record stored before the head was kept.
   */
  pulls: Array<{ number: number; stored: boolean; state: BacklogPullRequestData["state"] | null; mergedAt: string | null; closedAt: string | null; head: string | null; mergeCommit: string | null }>;
  /** The comments of those PRs, as stored (`issue` is the PR's number). */
  comments: BacklogCommentData[];
  /** The titles of the stored Issues (open or closed) that start with the asked `titlePrefix`; empty when none was asked. */
  titles: string[];
  /** When the first job that recorded a head started; null when none did. Before it no job holds a record, so a reading starts here. */
  since: number | null;
}

/**
 * What a period's tables read of a repository (`repo`, any case) in one call, from the app's own records: the jobs of
 * the PRs the period touched (all of them, so an ask before `sinceMs` still gives the wait), the person's grants, the
 * stored PRs and their comments. Nothing is asked of the service. Null when the app knows nothing of `repo`: no GitHub
 * backlog of a workspace is it, no workspace's checkout goes by it (`keysOf`: the key its jobs are recorded under and its
 * origin, as a Task's own grants are keyed — for a backlog kept here, one not imported yet or a GitLab project), and no
 * job with a head was ever recorded under it (a checkout moved or removed since). There is nothing to read then, which
 * an empty answer would not say.
 */
export function mergeHistoryOf(db: Pick<Db, "jobsOf" | "ownerMergeGrantsOf" | "firstHeadedJobAt" | "getTask" | "listWorkspaces" | "getWorkspaceBacklogSource" | "listBacklogRecords" | "jobsSince">, q: { repo: string; sinceMs: number; titlePrefix?: string }, keysOf: (w: { id: string; path: string }) => (string | null)[]): MergeHistory | null {
  const repo = q.repo.toLowerCase();
  const sources = new Map<string, NonNullable<ReturnType<Db["getWorkspaceBacklogSource"]>>>();
  for (const w of db.listWorkspaces()) {
    const s = db.getWorkspaceBacklogSource(w.id);
    if (s && s.service === "github" && s.repository.toLowerCase() === repo) sources.set(`${s.host}/${s.repository}`, s);
  }
  const since = db.firstHeadedJobAt(repo);
  if (!sources.size && since === null && !db.listWorkspaces().some((w) => keysOf(w).some((k) => k?.toLowerCase() === repo))) return null;
  const stored = new Map<number, BacklogPullRequestData>();
  for (const s of sources.values()) {
    for (const r of db.listBacklogRecords(s, "pull-request")) {
      const v = r.remote as BacklogPullRequestData | null;
      if (v?.number) stored.set(v.number, v);
    }
  }
  const touched = new Set<number>();
  for (const [n, v] of stored) if (Date.parse(v.updatedAt) >= q.sinceMs) touched.add(n);
  for (const j of db.jobsSince(repo, q.sinceMs)) if (j.pr > 0) touched.add(j.pr);
  const numbers = [...touched].sort((a, b) => a - b);
  const runners = new Map<string, string | null>();
  const runnerOf = (taskId: string) => (runners.has(taskId) ? runners.get(taskId)! : (runners.set(taskId, db.getTask(taskId)?.runner ?? null), runners.get(taskId)!));
  const jobs = db.jobsOf(repo, numbers).map(({ summary: _summary, cwd: _cwd, ...rest }) => ({ ...rest, taskRunner: runnerOf(rest.taskId) }));
  const comments: BacklogCommentData[] = [];
  for (const s of sources.values()) {
    for (const r of db.listBacklogRecords(s, "comment")) {
      const v = r.remote as BacklogCommentData | null;
      if (v && touched.has(v.issue)) comments.push({ issue: v.issue, body: v.body, createdAt: v.createdAt, ...(v.authorAssociation ? { authorAssociation: v.authorAssociation } : {}) });
    }
  }
  const pulls = numbers.map((n) => {
    const v = stored.get(n);
    return { number: n, stored: !!v, state: v?.state ?? null, mergedAt: v?.mergedAt ?? null, closedAt: v?.closedAt ?? null, head: v?.head ?? null, mergeCommit: v?.mergeCommit ?? null };
  });
  // the stored PBIs (open or closed, labelled `type:pbi` as `record` files them, and still on GitHub at the last import) whose title
  // starts with `titlePrefix`: what post-audit reads to know an audit's PBI was filed
  const titles: string[] = [];
  if (q.titlePrefix) {
    for (const s of sources.values()) {
      for (const r of db.listBacklogRecords(s, "issue")) {
        const v = r.remote as { title?: string; labels?: string[] } | null;
        if (r.fetchState === "fetched" && typeof v?.title === "string" && v.title.startsWith(q.titlePrefix) && v.labels?.includes("type:pbi")) titles.push(v.title);
      }
    }
  }
  return { jobs, grants: db.ownerMergeGrantsOf(repo, numbers), pulls, comments, titles, since };
}
