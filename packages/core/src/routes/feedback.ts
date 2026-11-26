import { FeedbackInput, type RunnerId } from "@switchboard/protocol";
import { buildFixPrompt, fixTitle } from "../feedback.ts";
import { workspaceBrief } from "../brief.ts";
import { localForgeOf } from "../backlog-local.ts";
import { savedConfigFile } from "../workspace-config.ts";
import { otherRepo } from "../server/helpers.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/feedback. */
export function feedbackRoutes(sc: Pick<ServerContext, "bad" | "db" | "backlogReads" | "startRequestTask" | "json" | "settings" | "DEVELOP_SELF_OFF" | "metaWorkspace" | "startMetaTask" | "adapterMap">): Routes {
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
        const meta = sc.metaWorkspace();
        // no meta workspace: startMetaTask answers 409; the brief only needs one to exist
        if (!meta) return sc.bad("meta workspace がありません", 409);
        const ws = parsed.data.workspaceId ? sc.db.getWorkspace(parsed.data.workspaceId) : meta;
        if (!ws) return sc.bad("workspace not found", 404);
        if (!sc.backlogReads(ws)) return sc.bad(sc.DEVELOP_SELF_OFF, 409);
        // another repository reads its changes as kept in the app only with a backlog kept in Switchboard, as a stage Task there does (startStage)
        const r = await sc.startMetaTask({
          kind: "fix",
          ws,
          title: fixTitle(parsed.data.text),
          prompt: ((when) => (runner: RunnerId) => buildFixPrompt({ brief: workspaceBrief(ws, [...sc.adapterMap.keys()]), text: parsed.data.text, when, screen: parsed.data.screen, review: sc.settings().reviewRunner, other: otherRepo(meta, ws), localForge: (ws.id === meta.id || ws.backlog === "switchboard") && localForgeOf(ws.path, savedConfigFile(ws.id)), localBacklog: ws.backlog === "switchboard", runner }))(new Date()),
          attachmentIds: parsed.data.attachmentIds,
        });
        return "task" in r ? sc.json(r.task, 201) : sc.bad(r.error, r.status);
      },
    },
  };
}
