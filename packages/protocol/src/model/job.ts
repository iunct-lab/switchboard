import { z } from "zod";

/** What a Task can ask the daemon to run for it: the kinds are fixed and the daemon builds their argv — no command is taken. */
export const JobKind = z.enum(["local-ci", "review", "recheck", "tag-ci", "gate"]);
export type JobKind = z.infer<typeof JobKind>;
/** `aborted`: the job's process went away without leaving its exit code (the host stopped, it was killed). */
export const JobStatus = z.enum(["running", "pass", "fail", "aborted"]);
export type JobStatus = z.infer<typeof JobStatus>;
/** The severity words of a finding line, the same four as the review's instructions (`ops-kit/src/review-note.ts`). */
export const FindingSeverity = z.enum(["blocker", "should-fix", "nit", "question"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;
/** What a local CI run records: `outcome` of the head merged into the base (the `[local-ci]` comment's first word), and the hash of the steps when they came from the workspace's settings. */
export const JobCi = z.object({ outcome: z.enum(["pass", "fail"]), stepsHash: z.string().optional() });
export type JobCi = z.infer<typeof JobCi>;
/** What a job's end records of its output. `review`: the findings of a review's output (one per line of its `### Findings` section) and the output's first line. `ci`: a local CI run's outcome; its head and base are the job's own. */
export const JobResult = z.object({
  ci: JobCi.optional(),
  /** What a merge verdict the app ran records (`scripts/merge-gate.ts` in the daemon's own checkout): the verdict at `head` (the PR's head it judged; a stack's verdict is the stack's), the ask and recheck kinds and the reasons that stopped it, whether `--allow-large` was given, whether the main review was skipped (a direct PR), and whether it merged. */
  gate: z.object({
    verdict: z.enum(["merge", "stop"]),
    head: z.string().nullable(),
    ask: z.array(z.string()),
    recheck: z.array(z.string()),
    reasons: z.array(z.string()),
    allowLarge: z.boolean(),
    reviewSkipped: z.boolean(),
    merged: z.boolean(),
  }).optional(),
  /** What a tag CI run records: whether the tag's commit (the job's `head`) passed. Only a run that judged it leaves this; a run that was cut, or did not judge the commit, leaves none. */
  tagCi: z.object({ ok: z.boolean() }).optional(),
  review: z.object({
    findings: z.array(z.object({ severity: FindingSeverity, path: z.string(), line: z.number() })),
    firstLine: z.string(),
  }).optional(),
});
export type JobResult = z.infer<typeof JobResult>;
/** Why a review is not the plain main review (`JobRequest`'s `as`): another runner for `fallback` / `recheck` / `audit`; `attack` is a second review, by the runner `attackReviewer` names. */
export const ReviewAs = z.enum(["fallback", "recheck", "audit", "attack"]);
export type ReviewAs = z.infer<typeof ReviewAs>;

/** A job the daemon runs as its own child, not the Task's. Times are epoch ms. `summary`: status, exit code, the log's last lines and its path. */
export const Job = z.object({
  id: z.number(),
  kind: JobKind,
  taskId: z.string(),
  /** The PR a job was asked for; 0 for a tag CI run (it is for a tag's commit, in `head`). */
  pr: z.number(),
  runner: z.enum(["codex", "claude"]).nullable(),
  cwd: z.string(),
  status: JobStatus,
  exitCode: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  summary: z.string().nullable(),
  /** The repository the PR is in: `owner/name` in lower case; a GitLab project is its path in lower case; the app's own change is `local:<workspaceId>` with the id in lower case; `""` when it was not read (and for a job from before this was recorded). */
  repo: z.string(),
  /** The checkout's head a review was asked to read, or a recheck runs on (`git rev-parse HEAD` when it was requested); null for local CI and for a job from before this was recorded. */
  head: z.string().nullable(),
  /** The base the job's result was measured against, when its end records one; null otherwise. */
  base: z.string().nullable(),
  /** Why a review is not the plain main review (`JobRequest`'s `as`); null for the main review and for local CI. */
  as: ReviewAs.nullable(),
  /** The kinds of a recheck: a review's `as: "recheck"` kinds (empty when the request named none: that record satisfies no recheck), or the one kind of a `recheck` job; empty otherwise. */
  kinds: z.array(z.string()),
  /** What the job's end recorded about its output; null until it ends, and when its output could not be read. */
  result: JobResult.nullable(),
});
export type Job = z.infer<typeof Job>;

/** The `taskId` of a job the app starts itself (a tag CI run for a tag it is about to promote): no Task asked for it. */
export const APP_JOB_TASK = "app";

/** `POST /api/jobs`. `cwd`: a checkout of the Task's repository (its folder, a worktree, a clone). Review reads `promptFile` and writes `outFile`. */
export const JobRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-ci"), taskId: z.string().min(1), pr: z.number().int().positive(), cwd: z.string().min(1),
    /** The recordings folder: it becomes `SWITCHBOARD_FIXTURES` in the job's environment, so a missing recording fails the run. */
    fixtures: z.string().min(1).optional(),
    /** `--local`: every step runs on this machine, not in the build off the host. */
    local: z.boolean().optional(),
    /** `pr` is the number of a change the app holds (the local change of a workspace), not a GitHub PR. */
    change: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("review"), taskId: z.string().min(1), pr: z.number().int().positive(), cwd: z.string().min(1), promptFile: z.string().min(1), outFile: z.string().min(1),
    /** Omitted: the app picks the main reviewer from the review setting and the Task's runner. Named: it must be that reviewer, unless `as` says why not. */
    runner: z.enum(["codex", "claude"]).optional(),
    /**
     * Why this is not the plain main review: it stands in for one at its usage limit (`fallback`), it is the second
     * reader of a recheck (`recheck`), it reads a merged PR again (`audit`), or it is the attacking-side review, by the runner `attackReviewer` names (`attack`). Without it, only the main reviewer runs.
     */
    as: ReviewAs.optional(),
    /** The kinds a recheck reads (`as: "recheck"`, each one a recheck kind). Without them the review is recorded with none, and satisfies no kind's recheck. */
    kinds: z.array(z.string().min(1)).optional(),
    /** `pr` is the number of a change the app holds, not a GitHub PR. */
    change: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("recheck"), taskId: z.string().min(1), pr: z.number().int().positive(), cwd: z.string().min(1),
    /** A recheck whose pass is a command's exit code (`scripts/recheck.ts`); the app builds the command from the kind. */
    recheck: z.enum(["migration", "rescue", "security:lockfile"]),
    /** `pr` is the number of a change the app holds, not a GitHub PR. */
    change: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("gate"), taskId: z.string().min(1), cwd: z.string().min(1),
    /** The PR to judge, or the number of a change the app holds when `change` is set. The daemon builds the command from these fields: no command and no environment is taken. */
    pr: z.number().int().positive(),
    /** Another repository's PR (`--repo owner/name`; the rules stay Switchboard's). */
    repo: z.string().regex(/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/).optional(),
    change: z.boolean().optional(),
    /** `--allow-large`: counts only for the Task's own consent record (the app reads it for `taskId`). */
    allowLarge: z.boolean().optional(),
    /** Merge at a merge verdict: one PR, the stack the PR tops, or the sync PR of the local main (a Merge commit; only a branch `sb/sync-main-<7>`). */
    merge: z.enum(["merge", "merge-stack", "merge-sync"]).optional(),
    /** `--scope`: the Task-scope material of the PR; no judgement. */
    scope: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("tag-ci"), taskId: z.string().min(1), cwd: z.string().min(1),
    /** The run is `scripts/tag-ci.ts` for one commit: `sha` when given (it must be a `v*` tag's commit in the clone the script lists tags in), else the newest tag's commit. It is the job's `head`. */
    sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  }),
]);
export type JobRequest = z.infer<typeof JobRequest>;
