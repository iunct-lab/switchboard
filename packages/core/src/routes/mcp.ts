import { tokenFromRequest } from "../auth.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /mcp. */
export function mcpRoutes(sc: Pick<ServerContext, "tokenCounts" | "mcp" | "refused" | "bad">): Routes {
  return {
    // the per-task tokens too count only from this machine on the cloud host: the runners call 127.0.0.1
    "/mcp/:id": (req, srv) => (sc.tokenCounts(req, srv) ? sc.mcp.handle(String(req.params.id), tokenFromRequest(req, true), req) : sc.refused(req, srv, sc.bad("unauthorized", 401))),
  };
}
