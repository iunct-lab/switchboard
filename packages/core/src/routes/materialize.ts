import { homedir } from "node:os";
import { MaterializeApplyInput } from "@switchboard/protocol";
import * as materializer from "../materializer.ts";
import type { Routes, ServerContext } from "../server/context.ts";
import { knowledgeError, knowledgeStatus } from "./shared.ts";

/** The routes under /api/materialize. */
export function materializeRoutes(sc: Pick<ServerContext, "db" | "bad" | "json" | "knowledge">): Routes {
  return {
    // Without workspaceId: write user-level files. With workspaceId: remove old repository blocks only.
    "/api/materialize/preview": (req) => {
      const id = new URL(req.url).searchParams.get("workspaceId");
      const ws = id !== null ? sc.db.getWorkspace(id) : undefined;
      if (id !== null && !ws) return sc.bad("workspace not found", 404);
      try {
        return sc.json({ workspace: ws, ...materializer.plan(sc.knowledge, { home: homedir(), workspace: ws ?? undefined }) });
      } catch (e) {
        return sc.bad(knowledgeError(e), knowledgeStatus(e));
      }
    },
    "/api/materialize/apply": {
      POST: async (req) => {
        let body: unknown;
        try { body = await req.json(); } catch { return sc.bad("invalid JSON"); }
        const parsed = MaterializeApplyInput.safeParse(body);
        if (!parsed.success) return sc.bad(parsed.error.message);
        const id = parsed.data.workspaceId;
        const ws = id !== undefined ? sc.db.getWorkspace(id) : undefined;
        if (id !== undefined && !ws) return sc.bad("workspace not found", 404);
        try {
          const opts = { home: homedir(), workspace: ws ?? undefined };
          const result = materializer.apply(materializer.plan(sc.knowledge, opts).files, { paths: parsed.data.paths, expected: parsed.data.expected, force: parsed.data.force });
          return sc.json({ ...result, ...materializer.plan(sc.knowledge, opts) }, result.skipped.some((s) => s.reason === "stale") ? 409 : 200);
        } catch (e) {
          return sc.bad(knowledgeError(e), knowledgeStatus(e));
        }
      },
    },
  };
}
