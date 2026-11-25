/** The jobs the daemon runs for Tasks. */

import type { Job, JobKind, JobResult, JobStatus, ReviewAs } from "@switchboard/protocol";
import { ScheduleQueries } from "./schedules.ts";

/** The jobs the daemon runs for Tasks. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class JobQueries extends ScheduleQueries {
  /* ---------- jobs the daemon runs for Tasks ---------- */

  /** `model` / `effort`: what a review's runner was started with; left out = null (the CLI's own, or not a review). */
  insertJob(j: { kind: JobKind; taskId: string; pr: number; runner: "codex" | "claude" | null; cwd: string; startedAt: number; repo: string; head: string | null; as: ReviewAs | null; kinds: string[]; model?: string | null; effort?: string | null }): Job {
    const r = this.sqlite
      .query("INSERT INTO jobs (kind, task_id, pr, runner, cwd, status, started_at, repo, head, as_reason, kinds, model, effort) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(j.kind, j.taskId, j.pr, j.runner, j.cwd, j.startedAt, j.repo, j.head, j.as, j.kinds.join(","), j.model ?? null, j.effort ?? null) as JobRow;
    return rowToJob(r);
  }

  /** The model a job ran on, read after it ended (a Claude review started on the CLI's own); a model already recorded stays. */
  setJobModel(id: number, model: string) {
    this.sqlite.query("UPDATE jobs SET model = ? WHERE id = ? AND model IS NULL").run(model, id);
  }

  /** What a job's end recorded of its output; a `head` or `base` given replaces the one recorded, one left out stays. */
  setJobResult(id: number, r: { head?: string; base?: string; result: JobResult }) {
    this.sqlite.query("UPDATE jobs SET result = ?, head = COALESCE(?, head), base = COALESCE(?, base) WHERE id = ?").run(JSON.stringify(r.result), r.head ?? null, r.base ?? null, id);
  }

  /** The jobs run for these PRs of a repository (`repo` as recorded), oldest first. A job's row is never deleted: what a verdict reads stays. */
  jobsOf(repo: string, prs: number[]): Job[] {
    if (!prs.length) return [];
    const marks = prs.map(() => "?").join(",");
    return (this.sqlite.query(`SELECT * FROM jobs WHERE repo = ? AND pr IN (${marks}) ORDER BY id`).all(repo, ...prs) as JobRow[]).map(rowToJob);
  }

  /** The review jobs asked for a PR number, in any repository, newest first (a caller keeps the repository's own). */
  reviewJobsForPr(pr: number): Job[] {
    return (this.sqlite.query("SELECT * FROM jobs WHERE kind = 'review' AND pr = ? ORDER BY id DESC").all(pr) as JobRow[]).map(rowToJob);
  }

  /** The tag CI jobs of a repository (`repo` as recorded) asked for a tag's commit (`head`), oldest first. */
  tagCiJobsOf(repo: string, sha: string): Job[] {
    return (this.sqlite.query("SELECT * FROM jobs WHERE kind = 'tag-ci' AND repo = ? AND head = ? ORDER BY id").all(repo, sha) as JobRow[]).map(rowToJob);
  }

  /** The tag CI job a Task `taskId` (the app's own) started in a repository that is running now, for any commit; null when none is. A job a Task asked for is not counted. */
  tagCiRunning(repo: string, taskId: string): Job | null {
    const r = this.sqlite.query("SELECT * FROM jobs WHERE kind = 'tag-ci' AND repo = ? AND task_id = ? AND status = 'running' ORDER BY id LIMIT 1").get(repo, taskId) as JobRow | null;
    return r ? rowToJob(r) : null;
  }

  /** The jobs of a repository started at or after `sinceMs`, oldest first. */
  jobsSince(repo: string, sinceMs: number): Job[] {
    return (this.sqlite.query("SELECT * FROM jobs WHERE repo = ? AND started_at >= ? ORDER BY id").all(repo, sinceMs) as JobRow[]).map(rowToJob);
  }

  /** When the first job that recorded a head started, in a repository (`repo` as recorded); null when none did. Before it the jobs hold no record a verdict or an audit reads. */
  firstHeadedJobAt(repo: string): number | null {
    return (this.sqlite.query("SELECT MIN(started_at) AS at FROM jobs WHERE repo = ? AND head IS NOT NULL").get(repo) as { at: number | null }).at;
  }

  /** The wrapper's pid and the boot it runs in: after a reboot the pid may be another process's (recoverJobs). */
  setJobPid(id: number, pid: number, bootId: string | null) {
    this.sqlite.query("UPDATE jobs SET pid = ?, boot_id = ? WHERE id = ?").run(pid, bootId, id);
  }

  /** Ends a running job once; a job already ended stays as it was (null). */
  finishJob(id: number, end: { status: Exclude<JobStatus, "running">; exitCode: number | null; summary: string; endedAt: number }): Job | null {
    const r = this.sqlite
      .query("UPDATE jobs SET status = ?, exit_code = ?, summary = ?, ended_at = ? WHERE id = ? AND status = 'running' RETURNING *")
      .get(end.status, end.exitCode, end.summary, end.endedAt, id) as JobRow | null;
    return r ? rowToJob(r) : null;
  }

  getJob(id: number): Job | null {
    const r = this.sqlite.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    return r ? rowToJob(r) : null;
  }

  /** The pid of a job's wrapper shell and the boot it started in (null: not started / not known), for recoverJobs. */
  jobPid(id: number): { pid: number | null; bootId: string | null } {
    const r = this.sqlite.query("SELECT pid, boot_id FROM jobs WHERE id = ?").get(id) as { pid: number | null; boot_id: string | null } | null;
    return { pid: r?.pid ?? null, bootId: r?.boot_id ?? null };
  }

  /** Running jobs and those that ended since `sinceMs`, newest first. */
  listJobs(sinceMs: number): Job[] {
    return (this.sqlite.query("SELECT * FROM jobs WHERE status = 'running' OR ended_at >= ? ORDER BY id DESC").all(sinceMs) as JobRow[]).map(rowToJob);
  }
}

type JobRow = { id: number; kind: string; task_id: string; pr: number; runner: string | null; cwd: string; status: string; exit_code: number | null; started_at: number; ended_at: number | null; summary: string | null; repo: string; head: string | null; base: string | null; as_reason: string | null; kinds: string; result: string | null; model: string | null; effort: string | null };
const rowToJob = (r: JobRow): Job => ({ id: r.id, kind: r.kind as JobKind, taskId: r.task_id, pr: r.pr, runner: r.runner as Job["runner"], cwd: r.cwd, status: r.status as JobStatus, exitCode: r.exit_code, startedAt: r.started_at, endedAt: r.ended_at, summary: r.summary, repo: r.repo, head: r.head, base: r.base, as: r.as_reason as ReviewAs | null, kinds: r.kinds ? r.kinds.split(",") : [], result: r.result ? (JSON.parse(r.result) as JobResult) : null, model: r.model, effort: r.effort });
