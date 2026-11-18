import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/queue. */
export function queueRoutes(sc: Pick<ServerContext, "json" | "scheduler">): Routes {
  return {
    "/api/queue": () => sc.json(sc.scheduler.queue()),
  };
}
