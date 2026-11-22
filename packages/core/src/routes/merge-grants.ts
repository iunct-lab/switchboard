import type { Routes, ServerContext } from "../server/context.ts";
import { consentWaitMs } from "../server/merge-consent.ts";

/** The routes under /api/merge-grants. */
export function mergeGrantsRoutes(sc: Pick<ServerContext, "bad" | "json" | "db" | "pendingConsent" | "settings">): Routes {
  /** Waits for the reads of `taskId`'s replies that are still going, also one queued behind the first, up to `consentWaitMs` in all. */
  const readingOf = async (taskId: string): Promise<void> => {
    const until = Date.now() + consentWaitMs(sc);
    for (let reading = sc.pendingConsent.get(taskId); reading && Date.now() < until; reading = sc.pendingConsent.get(taskId)) await Promise.race([reading, Bun.sleep(until - Date.now())]);
  };
  return {
    /**
     * The merge grants recorded as the person's (merge-grants.ts says what that means), read by the check in front of
     * `gh`. GET ?taskId&repo&kind&target[&head] answers whether the task has that grant for that repository (the one the
     * caller is about to write to). A merge / answer grant holds for the head the PR had when it was given: `head` (40
     * hex) is the head about to be merged or named by the mark, and without it the answer is false. The caller says which
     * Task it is; nothing here proves it. A reply of the person's own words that is still being read for a grant
     * (`noteConsent`) is waited for first, up to `consentWaitMs`.
     */
    "/api/merge-grants": {
      GET: async (req) => {
        const q = new URL(req.url).searchParams;
        const taskId = q.get("taskId") ?? "";
        const repo = q.get("repo") ?? "";
        const kind = q.get("kind") ?? "";
        const target = Number(q.get("target"));
        const head = q.get("head") ?? undefined;
        if (!taskId || !repo || !["merge", "answer"].includes(kind) || !Number.isInteger(target)) return sc.bad("taskId, repo, kind (merge|answer) and target required");
        if (head !== undefined && !/^[0-9a-f]{40}$/i.test(head)) return sc.bad("head must be a 40-digit sha");
        await readingOf(taskId);
        return sc.json({ granted: sc.db.hasMergeGrant(taskId, repo, kind, target, head) });
      },
    },
  };
}
