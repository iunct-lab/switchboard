import { ExperimentInput, ExperimentOutcomeInput } from "@switchboard/protocol";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/experiments: a record only, nothing here picks a branch or runs one. */
export function experimentsRoutes(sc: Pick<ServerContext, "db" | "json" | "bad" | "strong">): Routes {
  return {
    "/api/experiments": {
      GET: () => sc.json(sc.db.listExperiments()),
      // Registered before the work. Writes need what PATCH /api/settings needs.
      POST: sc.strong(async (req) => {
        const parsed = ExperimentInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        return sc.json(sc.db.registerExperiment(parsed.data, Date.now()), 201);
      }),
    },
    // Recorded after, once: a second record is refused and the first stands.
    "/api/experiments/:id/outcome": {
      POST: sc.strong(async (req) => {
        const parsed = ExperimentOutcomeInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const id = String(req.params.id);
        const before = sc.db.getExperiment(id);
        if (!before) return sc.bad("not found", 404);
        if (before.decidedAt !== null) return sc.bad("outcome already recorded", 409);
        const done = sc.db.recordExperimentOutcome(id, parsed.data, Date.now());
        return done ? sc.json(done) : sc.bad("outcome already recorded", 409);
      }),
    },
  };
}
