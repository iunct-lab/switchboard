import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/approvals. */
export function approvalsRoutes(sc: Pick<ServerContext, "json" | "tasks">): Routes {
  return {
    /** Unanswered permission asks across all tasks, newest first (the phone-sized 承認 screen). */
    "/api/approvals": () => sc.json(sc.tasks.pendingApprovals()),
  };
}
