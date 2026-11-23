import type { Routes, ServerContext } from "../server/context.ts";
import { waitForConsentRead } from "../server/merge-consent.ts";
import { mergeHistoryOf, mergeRecordsOf } from "../merge-records.ts";

/** The routes under /api/merge-records. */
export function mergeRecordsRoutes(sc: Pick<ServerContext, "bad" | "json" | "db" | "pendingConsent" | "settings">): Routes {
  return {
    /**
     * What a merge verdict reads of PRs of `repo` in one call: `jobs` (the jobs the app ran for them), `granted` (the
     * person's grant for `pr` at `head`, null without `taskId` and `head`) and `direct` (the app started `taskId` as a
     * direct one and it opened `pr`). Read only. A reply of the person's own words still being read for a grant is
     * waited for first when `taskId` is given, as `/api/merge-grants` does.
     */
    "/api/merge-records": {
      GET: async (req) => {
        const q = new URL(req.url).searchParams;
        const repo = q.get("repo") ?? "";
        const prs = q.getAll("pr").map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
        const taskId = q.get("taskId") ?? undefined;
        const head = q.get("head") ?? undefined;
        if (!repo || !prs.length || prs.some((n) => !Number.isSafeInteger(n) || n < 1)) return sc.bad("repo and one or more pr (positive integers) required");
        if (head !== undefined && !/^[0-9a-f]{40}$/i.test(head)) return sc.bad("head must be a 40-digit sha");
        if (taskId) await waitForConsentRead(sc, taskId);
        return sc.json(mergeRecordsOf(sc.db, { repo, prs, taskId, head }));
      },
    },
    /**
     * What a period's tables (merge-audit, post-audit) read of `repo` since `since` (ms) in one call: the jobs, the person's
     * grants, the stored PRs and the comments of the PRs the period touched. Not `/api/backlog/records` (every Issue and
     * every comment): a period's PRs and only their comments. With `titlePrefix`, also the titles of the stored Issues that
     * start with it (open or closed: post-audit's audit PBIs). Read only.
     */
    "/api/merge-records/history": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const repo = q.get("repo") ?? "";
        const since = q.get("since") ?? "";
        if (!repo || !/^\d+$/.test(since) || !Number.isSafeInteger(Number(since))) return sc.bad("repo and since (epoch ms) required");
        const titlePrefix = q.get("titlePrefix") ?? undefined;
        if (titlePrefix !== undefined && (titlePrefix.length === 0 || titlePrefix.length > 200)) return sc.bad("titlePrefix is 1 to 200 characters");
        return sc.json(mergeHistoryOf(sc.db, { repo, sinceMs: Number(since), titlePrefix }));
      },
    },
  };
}
