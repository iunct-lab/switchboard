import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/sources. */
export function sourcesRoutes(sc: Pick<ServerContext, "json" | "sources">): Routes {
  return {
    /** What became of the requests of each speaker (and route) in the last ?days= days (default 30, 1 to 3650). Counted from the stored records and the Tasks (no GitHub call), held for an hour per ?days=. */
    "/api/sources": {
      GET: async (req) => {
        const n = Number(new URL(req.url).searchParams.get("days") ?? 30);
        const days = Number.isFinite(n) ? Math.min(3650, Math.max(1, Math.round(n))) : 30;
        return sc.json(await sc.sources.get(days));
      },
    },
  };
}
