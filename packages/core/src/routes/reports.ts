import type { Routes, ServerContext } from "../server/context.ts";
import { acrossQuery } from "./shared.ts";

/** The routes under /api/reports. */
export function reportsRoutes(sc: Pick<ServerContext, "db" | "bad" | "json">): Routes {
  return {
    // Across Tasks, newest first: the HTML artifacts of every task and every artifact. Both read
    // the same q / before / limit (acrossQuery) and the same query, so the two lists filter and page alike.
    "/api/reports": (req) => {
      const o = acrossQuery(new URL(req.url), sc.db);
      return typeof o === "string" ? sc.bad(o) : sc.json(sc.db.listArtifactsAcross({ ...o, htmlOnly: true }));
    },
  };
}
