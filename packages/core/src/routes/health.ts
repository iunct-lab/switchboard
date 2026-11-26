import { listRefused } from "../backlog-upbox.ts";
import { listRefusedDeltas } from "../uplink-s3.ts";
import { basename } from "node:path";
import { PROTOCOL_VERSION } from "@switchboard/protocol";
import { sameOrigin, sessionTimes } from "../auth.ts";
import { listSkipped } from "../uplink.ts";
import { archiveProblem } from "../archive-status.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/health. */
export function healthRoutes(sc: Pick<ServerContext, "cfg" | "authorize" | "json" | "authRequired" | "refreshLogins" | "liveRoot" | "runnerInfo" | "pty" | "settings" | "adapterMap" | "publicUrl" | "db" | "drainView">): Routes {
  return {
    // Open so the UI can learn whether a token is needed; paths and runner details only for authorized callers.
    "/api/health": async (req, srv) => {
      // `login` tells the UI how a person gets in before it is authorized: the cloud host's passkey page or the token.
      const login = sc.cfg.sessionPublicKey ? "passkey" : "token";
      const auth = await sc.authorize(req, srv);
      if (!auth.ok) return sc.json({ ok: true, protocol: PROTOCOL_VERSION, authRequired: sc.authRequired, login });
      // /api/health is open to other origins (the UI learns whether a token is needed); a forced run is not.
      // Only the forced run is waited for; otherwise the check runs behind and this answers with the last one.
      // refreshLogins never rejects (a failing detect() is caught inside), so the one not waited for cannot go unhandled.
      const force = new URL(req.url).searchParams.has("recheck") && sameOrigin(req);
      const check = sc.refreshLogins(force);
      if (force) await check;
      // busyTasks: the Tasks a restart would stop, so sb-rescue's status poll never reads every task.
      return sc.json({ ok: true, protocol: PROTOCOL_VERSION, webRelease: basename(sc.liveRoot), login, session: (auth.session && sessionTimes(auth.session, sc.cfg.sessionPublicKey)) || undefined, runners: sc.runnerInfo(), home: sc.cfg.home, homeDisplay: sc.cfg.homeDisplay, homeIsTemp: sc.cfg.homeIsTemp, repoRoot: sc.cfg.repoRoot, releaseOnly: sc.cfg.releaseOnly, authRequired: sc.authRequired, features: { pty: sc.pty !== null }, archive: archiveProblem(sc.cfg.home), routing: { llm: { ...sc.settings().routing.llm, available: sc.adapterMap.has(sc.settings().routing.llm.runner) } }, mcp: { base: `${sc.publicUrl()}/mcp/<taskId>` }, busyTasks: sc.db.listWorkingTasks("gate").map(({ id, title, status }) => ({ id, title, status })), promotionDrain: sc.drainView(), uplinkSkipped: listSkipped(sc.db).map(({ machine, theirs, ours }) => ({ machine, theirs, ours })), uplinkRefused: [...listRefusedDeltas(sc.db).map(({ machine, key, reason, at }) => ({ machine, key, reason, at })), ...listRefused(sc.db).slice(-20).map(({ machine, key, reason, at }) => ({ machine: machine ?? null, key, reason, at }))] });
    },
  };
}
