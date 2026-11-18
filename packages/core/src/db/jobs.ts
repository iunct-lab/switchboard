/** The jobs the daemon runs for Tasks. */

import type { Job, JobKind, JobStatus } from "@switchboard/protocol";
import { ScheduleQueries } from "./schedules.ts";

/** The jobs the daemon runs for Tasks. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class JobQueries extends ScheduleQueries {
  /* ---------- jobs the daemon runs for Tasks ---------- */

  insertJob(j: { kind: JobKind; taskId: string; pr: number; runner: "codex" | "claude" | null; cwd: string; startedAt: number }): Job {
    const r = this.sqlite
      .query("INSERT INTO jobs (kind, task_id, pr, runner, cwd, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?) RETURNING *")
      .get(j.kind, j.taskId, j.pr, j.runner, j.cwd, j.startedAt) as JobRow;
    return rowToJob(r);
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

type JobRow = { id: number; kind: string; task_id: string; pr: number; runner: string | null; cwd: string; status: string; exit_code: number | null; started_at: number; ended_at: number | null; summary: string | null };
const rowToJob = (r: JobRow): Job => ({ id: r.id, kind: r.kind as JobKind, taskId: r.task_id, pr: r.pr, runner: r.runner as Job["runner"], cwd: r.cwd, status: r.status as JobStatus, exitCode: r.exit_code, startedAt: r.started_at, endedAt: r.ended_at, summary: r.summary });
