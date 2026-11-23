import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JobRequest } from "@switchboard/protocol";
import { JOBS_KEEP_MS, JobError, requestJob } from "../jobs.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/jobs. */
/** How much of a gate job's output the route returns: the verdict is a few KB; the Task-scope material (`--scope`) is the largest. */
const MAX_OUT_BYTES = 2_000_000;

export function jobsRoutes(sc: Pick<ServerContext, "json" | "db" | "bad" | "jobDeps">): Routes {
  return {
    /**
     * Jobs a Task asks the daemon to run (jobs.ts): local CI or a review, as the daemon's child. POST answers
     * 202 with the job (its `id` is what the Task waits on as `job#<id>`); GET lists the running ones and those that
     * ended in the last 7 days, newest first.
     */
    "/api/jobs": {
      GET: () => sc.json(sc.db.listJobs(Date.now() - JOBS_KEEP_MS)),
      POST: async (req) => {
        const parsed = JobRequest.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        try {
          return sc.json(requestJob(sc.jobDeps, parsed.data), 202);
        } catch (e) {
          if (e instanceof JobError) return sc.bad(e.message, e.status);
          throw e;
        }
      },
    },
    /**
     * One job, and for a gate job what its run printed (`out`: the verdict as JSON, or the Task-scope material): a Task's
     * `scripts/merge-gate.ts` reads it every 2 s until the job ends (a verdict and a merge take 10 to 60 s and may take minutes
     * for a stack, longer than one HTTP call is kept). The job's folder is kept 7 days, as the list is.
     */
    "/api/jobs/:id": {
      GET: (req) => {
        const id = /^\d+$/.test(req.params.id ?? "") ? Number(req.params.id) : NaN;
        const job = Number.isSafeInteger(id) ? sc.db.getJob(id) : null;
        if (!job) return sc.bad("no such job", 404);
        let out: string | null = null;
        if (job.kind === "gate") {
          try {
            const text = readFileSync(join(sc.jobDeps.dir, String(id), "out"), "utf8");
            out = text.length > MAX_OUT_BYTES ? `${text.slice(0, MAX_OUT_BYTES)}\n（切った）` : text;
          } catch {
            out = ""; // nothing printed yet, or the folder was pruned
          }
        }
        return sc.json({ job, out });
      },
    },
  };
}
