import { FeedbackInput, type RunnerId } from "@switchboard/protocol";
import { buildFixPrompt, fixTitle } from "../feedback.ts";
import { workspaceBrief } from "../brief.ts";
import { localForgeOf } from "../backlog-local.ts";
import { savedConfigFile } from "../workspace-config.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/feedback. */
export function feedbackRoutes(sc: Pick<ServerContext, "bad" | "startRequestTask" | "json" | "settings" | "DEVELOP_SELF_OFF" | "metaWorkspace" | "startMetaTask" | "adapterMap">): Routes {
  return {
    "/api/feedback": {
      POST: async (req) => {
        const parsed = FeedbackInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        if (parsed.data.mode === "request") {
          const r = await sc.startRequestTask(parsed.data);
          if ("upstream" in r) return sc.json({ upstream: r.upstream }, 200);
          return "task" in r ? sc.json(r.task, 201) : sc.bad(r.error, r.status);
        }
        if (!sc.settings().developSelf) return sc.bad(sc.DEVELOP_SELF_OFF, 409);
        const meta = sc.metaWorkspace();
        // no meta workspace: startMetaTask answers 409; the brief only needs one to exist
        if (!meta) return sc.bad("meta workspace がありません", 409);
        const r = await sc.startMetaTask({
          kind: "fix",
          title: fixTitle(parsed.data.text),
          prompt: ((when) => (runner: RunnerId) => buildFixPrompt({ brief: workspaceBrief(meta, [...sc.adapterMap.keys()]), text: parsed.data.text, when, screen: parsed.data.screen, review: sc.settings().reviewRunner, localForge: localForgeOf(meta.path, savedConfigFile(meta.id)), localBacklog: meta.backlog === "switchboard", runner }))(new Date()),
          attachmentIds: parsed.data.attachmentIds,
        });
        return "task" in r ? sc.json(r.task, 201) : sc.bad(r.error, r.status);
      },
    },
  };
}
