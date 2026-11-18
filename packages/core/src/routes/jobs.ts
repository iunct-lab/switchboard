import { JobRequest } from "@switchboard/protocol";
import { JOBS_KEEP_MS, JobError, requestJob } from "../jobs.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/jobs. */
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
  };
}
