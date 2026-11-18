import type { Routes, ServerContext } from "../server/context.ts";
import { knowledgeError, knowledgeStatus } from "./shared.ts";

/** The routes under /api/knowledge. */
export function knowledgeRoutes(sc: Pick<ServerContext, "json" | "knowledge" | "bad" | "readJson">): Routes {
  return {
    "/api/knowledge": async () => sc.json({ dir: sc.knowledge.dir, disabled: sc.knowledge.disabled, git: await sc.knowledge.gitStatus(), docs: sc.knowledge.list() }),
    "/api/knowledge/search": (req) => {
      try {
        return sc.json(sc.knowledge.search(new URL(req.url).searchParams.get("q") ?? ""));
      } catch (e) {
        return sc.bad(`search failed: ${String((e as Error).message ?? e)}`, 500);
      }
    },
    "/api/knowledge/reindex": { POST: () => sc.json(sc.knowledge.scan()) },
    "/api/knowledge/doc": {
      GET: (req) => {
        const path = new URL(req.url).searchParams.get("path") ?? "";
        try {
          return sc.json(sc.knowledge.read(path));
        } catch (e) {
          return sc.bad(knowledgeError(e), knowledgeStatus(e));
        }
      },
      POST: async (req) => {
        const body = await sc.readJson(req, (x) => x as { path?: unknown; content?: unknown });
        if (typeof body.path !== "string" || typeof body.content !== "string") return sc.bad("path and content (strings) required");
        if (body.content.length > 1_000_000) return sc.bad("content too large (1 MB limit)", 413);
        try {
          return sc.json(sc.knowledge.write(body.path, body.content), 201);
        } catch (e) {
          return sc.bad(knowledgeError(e), knowledgeStatus(e));
        }
      },
    },
  };
}
