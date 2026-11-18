import { z } from "zod";

/** What a Task can ask the daemon to run for it: the kinds are fixed and the daemon builds their argv — no command is taken. */
export const JobKind = z.enum(["local-ci", "review"]);
export type JobKind = z.infer<typeof JobKind>;
/** `aborted`: the job's process went away without leaving its exit code (the host stopped, it was killed). */
export const JobStatus = z.enum(["running", "pass", "fail", "aborted"]);
export type JobStatus = z.infer<typeof JobStatus>;
/** A job the daemon runs as its own child, not the Task's. Times are epoch ms. `summary`: status, exit code, the log's last lines and its path. */
export const Job = z.object({
  id: z.number(),
  kind: JobKind,
  taskId: z.string(),
  pr: z.number(),
  runner: z.enum(["codex", "claude"]).nullable(),
  cwd: z.string(),
  status: JobStatus,
  exitCode: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  summary: z.string().nullable(),
});
export type Job = z.infer<typeof Job>;
/** A review by a runner other than the main reviewer says which of these it is (`JobRequest`'s `as`). */
export const ReviewAs = z.enum(["fallback", "recheck", "audit"]);
export type ReviewAs = z.infer<typeof ReviewAs>;

/** `POST /api/jobs`. `cwd`: a checkout of the Task's repository (its folder, a worktree, a clone). Review reads `promptFile` and writes `outFile`. */
export const JobRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-ci"), taskId: z.string().min(1), pr: z.number().int().positive(), cwd: z.string().min(1),
    /** The recordings folder: it becomes `SWITCHBOARD_FIXTURES` in the job's environment, so a missing recording fails the run. */
    fixtures: z.string().min(1).optional(),
    /** `--local`: every step runs on this machine, not in the build off the host. */
    local: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("review"), taskId: z.string().min(1), pr: z.number().int().positive(), cwd: z.string().min(1), promptFile: z.string().min(1), outFile: z.string().min(1),
    /** Omitted: the app picks the main reviewer from the review setting and the Task's runner. Named: it must be that reviewer, unless `as` says why not. */
    runner: z.enum(["codex", "claude"]).optional(),
    /**
     * Why the named runner is not the main reviewer: it stands in for one at its usage limit (`fallback`), it is the second
     * reader of a recheck (`recheck`), or it reads a merged PR again (`audit`). Without it, only the main reviewer runs.
     */
    as: ReviewAs.optional(),
  }),
]);
export type JobRequest = z.infer<typeof JobRequest>;
