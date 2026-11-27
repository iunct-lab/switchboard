import { BundleInput, type RunnerId } from "@switchboard/protocol";
import { buildBundlePrompt } from "../backlog-prompt.ts";
import { readStoredIssue } from "../backlog-stored.ts";
import { loadProcess, type ProcessDef } from "../process-defs.ts";
import { bundleHold, holdForBundle, releaseBundle } from "../server/bundle.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/bundle: see the hold (GET), start a bundle of PBIs (POST), end the hold (DELETE). */
export function bundleRoutes(sc: Pick<ServerContext, "json" | "bad" | "db" | "scheduler" | "startMetaTask" | "metaWorkspace" | "settings" | "releaseStatus">): Routes {
  // a start that has not yet put its hold: a second POST in this time is refused as if the hold stood
  let starting = false;
  return {
    "/api/bundle": {
      GET: () => sc.json(bundleHold(sc)),
      /**
       * 束: one Task in the meta workspace under the p3-bundle candidate, then the hold under that Task's id. Switchboard's own
       * backlog only. A Task that does not start leaves no hold.
       */
      POST: async (req) => {
        const parsed = BundleInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const meta = sc.metaWorkspace();
        if (!meta) return sc.bad("meta workspace がありません", 409);
        for (const n of parsed.data.pbis) {
          const issue = readStoredIssue(sc.db, meta, n)?.issue;
          if (!issue || issue.state !== "OPEN" || !issue.labels.includes("type:pbi")) return sc.bad(`#${n} は開いている PBI ではありません`);
        }
        const held = bundleHold(sc);
        if (held || starting) return sc.bad(held ? `束の作業中です（Task ${held.taskId}）。止めを解いてから始める` : "束を始めている途中です", 409);
        // a definition that cannot be read or rendered starts nothing, like a stage's
        let def: ProcessDef;
        let prompt: (runner: RunnerId) => string;
        try {
          const read = loadProcess("p3-bundle", meta.path);
          def = read;
          prompt = (runner) => buildBundlePrompt(parsed.data.pbis, { review: sc.settings().reviewRunner, runner }, read);
          prompt("claude");
        } catch (e) {
          return sc.bad(`候補の定義を読めません: ${(e as Error).message ?? e}`, 409);
        }
        starting = true;
        try {
          // the version to go back to is read first: between the Task's start and its hold nothing is waited on
          const status = await sc.releaseStatus();
          const base = "current" in status ? status.current ?? null : null;
          const r = await sc.startMetaTask({ kind: "bundle", title: `まとめて入れる: ${parsed.data.pbis.map((n) => "#" + n).join(", ")}`, prompt, process: def.id, processReason: "bundle button", issues: [...new Set(parsed.data.pbis)].sort((a, b) => a - b) });
          if ("error" in r) return sc.bad(r.error, r.status);
          holdForBundle(sc, r.task.id, base);
          return sc.json(r.task, 201);
        } finally {
          starting = false;
        }
      },
      /** End the hold: only the schedules it stopped are turned back on. */
      DELETE: () => sc.json(releaseBundle(sc)),
    },
  };
}
