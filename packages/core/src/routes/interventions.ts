import { interventionView } from "../interventions.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/interventions. */
export function interventionsRoutes(sc: Pick<ServerContext, "json" | "db">): Routes {
  return {
    /** People's interventions and why work stopped, the last 7 and 30 days against the period before each. Counted at each look from the records and the stored Issues: no GitHub call. */
    "/api/interventions": {
      GET: () => sc.json(interventionView(sc.db, sc.db.listWorkspaces())),
    },
  };
}
