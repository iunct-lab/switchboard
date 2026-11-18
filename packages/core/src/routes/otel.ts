import { tokenFromRequest } from "../auth.ts";
import { decisionsFromOtlp } from "../otel.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /otel. */
export function otelRoutes(sc: Pick<ServerContext, "tokenCounts" | "mcp" | "refused" | "bad" | "db" | "tasks" | "countRules" | "json">): Routes {
  return {
    // A Claude Task's OpenTelemetry logs (docs/design/claude-otel.md): its MCP token, the classifier's decisions
    // kept as the task's events and nothing else of the body, the rules row counted again (the logs come after the turn's end)
    "/otel/:id/v1/logs": {
      POST: async (req, srv) => {
        const id = String(req.params.id);
        if (!sc.tokenCounts(req, srv) || !sc.mcp.verify(id, tokenFromRequest(req, false))) return sc.refused(req, srv, sc.bad("unauthorized", 401));
        const t = sc.db.getTask(id);
        // a released runner still flushes its last batch while it closes (its grace period); the token goes when it has
        if (!t || !sc.tasks.holdsProcess(id)) return sc.bad("no live task", 404);
        const decisions = decisionsFromOtlp(await req.json().catch(() => null));
        for (const d of decisions) sc.tasks.record(id, d);
        if (decisions.length) sc.countRules(t);
        return sc.json({});
      },
    },
  };
}
