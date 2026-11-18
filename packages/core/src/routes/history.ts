import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/history. */
export function historyRoutes(sc: Pick<ServerContext, "json" | "history" | "bad">): Routes {
  return {
    // Terminal history: status of the session-log import, and a pass on request (the UI's 今すぐ取り込む).
    "/api/history": () => sc.json(sc.history.status()),
    "/api/history/import": {
      POST: () => {
        try {
          return sc.json(sc.history.scan());
        } catch (e) {
          return sc.bad(`scan failed: ${String((e as Error).message ?? e)}`, 500);
        }
      },
    },
  };
}
