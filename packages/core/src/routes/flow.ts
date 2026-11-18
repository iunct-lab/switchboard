import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/flow. */
export function flowRoutes(sc: Pick<ServerContext, "json" | "flow">): Routes {
  return {
    /** How long the PBIs closed in the last 30 days took, stage by stage, and in the 30 days before. Held for an hour; ?refresh=1 reads again. */
    "/api/flow": {
      GET: async (req) => sc.json(await sc.flow.get(new URL(req.url).searchParams.get("refresh") === "1")),
    },
  };
}
