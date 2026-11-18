import { artifactMime, checkViewKey, localDate, withCharset, VIEW_KEY_MS, viewKey } from "../artifacts.ts";
import { otherMachineOf, ranElsewhereLine } from "../machine.ts";
import type { Routes, ServerContext } from "../server/context.ts";
import { acrossQuery } from "./shared.ts";

/** The routes under /api/artifacts. */
export function artifactsRoutes(sc: Pick<ServerContext, "db" | "bad" | "json" | "artifactResult" | "artifacts" | "startRequestTask" | "refused">): Routes {
  return {
    "/api/artifacts": {
      GET: (req) => {
        const o = acrossQuery(new URL(req.url), sc.db);
        return typeof o === "string" ? sc.bad(o) : sc.json(sc.db.listArtifactsAcross({ ...o, htmlOnly: false }));
      },
    },
    "/api/artifacts/:id": {
      DELETE: (req) => sc.artifactResult(() => sc.json(sc.artifacts.remove(String(req.params.id)))),
    },
    // A throwaway app read the API through the screen: count the local day; on the APP_REQUEST_DAYS-th day
    // Switchboard starts a request Task for it, once per artifact.
    "/api/artifacts/:id/app-use": {
      POST: async (req) => {
        const a = sc.artifacts.get(String(req.params.id));
        if (!a) return sc.bad("not found", 404);
        // only a page the screen frames can use the bridge; a URL has no copy to count or to name in the 出典
        if (a.kind === "url") return sc.bad("a URL artifact is not a throwaway app", 400);
        const use = sc.artifacts.markAppUse(a.id, localDate(new Date()));
        if (!use.due) return sc.json({ appDays: use.appDays, appRequestTaskId: use.appRequestTaskId });
        // the same draft as 要望にする (the PBI's 「同じ下書き」); the 出典 says Switchboard filed it and why
        const r = await sc.startRequestTask({ text: `使い捨てアプリ「${a.title}」を一般機能にしたい。`, source: { kind: "artifact", artifactId: a.id }, auto: true });
        if ("upstream" in r) return sc.json({ appDays: use.appDays, appRequestTaskId: null });
        if (!("task" in r)) {
          // the next day that counts tries again; the page still reads as before
          console.warn(`artifacts: the request for the throwaway app ${a.id} did not start: ${r.error}`);
          return sc.json({ appDays: use.appDays, appRequestTaskId: null });
        }
        sc.artifacts.setAppRequest(a.id, r.task.id);
        return sc.json({ appDays: use.appDays, appRequestTaskId: r.task.id });
      },
    },
    "/api/artifacts/:id/restore": {
      POST: (req) => sc.artifactResult(() => sc.json(sc.artifacts.restore(String(req.params.id)))),
    },
    // A viewing key for one artifact: the only way to a URL under /artifacts, and only for a caller /api lets in.
    "/api/artifacts/:id/view": {
      POST: (req) =>
        sc.artifactResult(() => {
          const a = sc.artifacts.get(String(req.params.id));
          if (!a || a.removedAt !== null) return sc.bad("not found", 404);
          if (a.kind === "url" || !a.entry) return sc.bad("a URL has nothing to view here; open it in a new tab", 400);
          return sc.json({ url: `/artifacts/${viewKey(a.id, Date.now() + VIEW_KEY_MS)}/${a.entry.split("/").map(encodeURIComponent).join("/")}` });
        }),
    },
    // The report's own files. Outside /api: the key in the path is the authorization (the Host and edge checks still
    // apply), and the response gives the page no rights on this origin — `sandbox` without allow-same-origin makes it opaque.
    "/artifacts/:key/*": {
      GET: (req, srv) => {
        const url = new URL(req.url);
        const [, , key = "", ...rest] = url.pathname.split("/");
        const k = checkViewKey(key);
        if (!k.ok) return sc.refused(req, srv, sc.bad(k.status === 410 ? "this link expired; open the report again" : "forbidden", k.status));
        const a = sc.artifacts.get(k.id);
        if (!a || a.removedAt !== null) return sc.bad("not found", 404);
        const file = sc.artifacts.fileOf(a, rest.join("/"));
        if (!file) return sc.bad("not found", 404);
        return new Response(Bun.file(file), {
          headers: {
            "content-type": withCharset(artifactMime(file)),
            "content-disposition": "inline",
            "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
            "x-content-type-options": "nosniff",
            "cache-control": "private, max-age=300",
            "referrer-policy": "no-referrer",
          },
        });
      },
    },
    "/api/artifacts/:id/refresh": {
      POST: (req) =>
        sc.artifactResult(() => {
          const a = sc.artifacts.get(String(req.params.id));
          const t = a && sc.db.getTask(a.taskId);
          // the source of an artifact of another machine's Task is a path of that machine: the same path here is not
          // read into the copy that came in
          const away = otherMachineOf(t);
          if (away) return sc.bad(ranElsewhereLine(away), 409);
          return a && t ? sc.json(sc.artifacts.refresh(a.id, t)) : sc.bad("not found", 404);
        }),
    },
  };
}
