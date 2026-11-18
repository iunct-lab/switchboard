import { balanceView } from "../balance.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/balance. */
export function balanceRoutes(sc: Pick<ServerContext, "bad" | "json" | "db">): Routes {
  return {
    /** The workspaces' balance over ?days=7|30 and the capacity the weekly quota leaves (any other days is 400). Counted at each look from the tables: no GitHub call. */
    "/api/balance": {
      GET: (req) => {
        const days = Number(new URL(req.url).searchParams.get("days") ?? 7);
        if (days !== 7 && days !== 30) return sc.bad("days must be 7 or 30", 400);
        return sc.json(balanceView(sc.db, sc.db.listWorkspaces(), days));
      },
    },
  };
}
