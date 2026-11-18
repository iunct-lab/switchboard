import { NewRepoInput } from "@switchboard/protocol";
import { buildNewRepoPrompt, newRepoTitle } from "../feedback.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/new-repo. */
export function newRepoRoutes(sc: Pick<ServerContext, "bad" | "startMetaTask" | "json">): Routes {
  return {
    "/api/new-repo": {
      POST: async (req) => {
        const parsed = NewRepoInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const r = await sc.startMetaTask({ kind: "new-repo", title: newRepoTitle(parsed.data.name), prompt: buildNewRepoPrompt({ ...parsed.data, when: new Date() }) });
        return "task" in r ? sc.json(r.task, 201) : sc.bad(r.error, r.status);
      },
    },
  };
}
