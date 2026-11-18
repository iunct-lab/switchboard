import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/merge-grants. */
export function mergeGrantsRoutes(sc: Pick<ServerContext, "bad" | "json" | "db">): Routes {
  return {
    /**
     * The merge grants recorded as the person's (merge-grants.ts says what that means), read by the check in front of
     * `gh`. GET ?taskId&repo&kind&target[&head] answers whether the task has that grant for that repository (the one the
     * caller is about to write to). A merge / answer grant holds for the head the PR had when it was given: `head` (40
     * hex) is the head about to be merged or named by the mark, and without it the answer is false. The caller says which
     * Task it is; nothing here proves it.
     */
    "/api/merge-grants": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const taskId = q.get("taskId") ?? "";
        const repo = q.get("repo") ?? "";
        const kind = q.get("kind") ?? "";
        const target = Number(q.get("target"));
        const head = q.get("head") ?? undefined;
        if (!taskId || !repo || !["merge", "answer", "scope"].includes(kind) || !Number.isInteger(target)) return sc.bad("taskId, repo, kind (merge|answer|scope) and target required");
        if (head !== undefined && !/^[0-9a-f]{40}$/i.test(head)) return sc.bad("head must be a 40-digit sha");
        return sc.json({ granted: sc.db.hasMergeGrant(taskId, repo, kind, target, head) });
      },
    },
    /** The merge gate stopped PR `pr` of `repo` for a file the Task `issue` does not name: POST records it; GET answers whether it stopped and whether a scope grant came after. */
    "/api/merge-grants/scope-stop": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { taskId?: unknown; repo?: unknown; issue?: unknown; pr?: unknown };
        if (typeof b.taskId !== "string" || !b.taskId || typeof b.repo !== "string" || !b.repo || !Number.isInteger(b.issue) || !Number.isInteger(b.pr)) return sc.bad("taskId, repo, issue and pr required");
        sc.db.recordScopeStop(b.taskId, b.repo, b.issue as number, b.pr as number);
        return sc.json({ recorded: true });
      },
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const taskId = q.get("taskId") ?? "";
        const repo = q.get("repo") ?? "";
        const issue = Number(q.get("issue"));
        if (!taskId || !repo || !Number.isInteger(issue)) return sc.bad("taskId, repo and issue required");
        const stop = sc.db.scopeStopOf(taskId, repo, issue);
        const at = sc.db.mergeGrantAt(taskId, repo, "scope", issue);
        return sc.json({ stopped: stop !== null, granted: stop !== null && at !== null && at > stop.at });
      },
    },
  };
}
