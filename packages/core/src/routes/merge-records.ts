import type { Routes, ServerContext } from "../server/context.ts";
import { waitForConsentRead } from "../server/merge-consent.ts";
import { mergeRecordsOf } from "../merge-records.ts";

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
  };
}
