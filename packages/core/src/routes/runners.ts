import type { RunnerId } from "@switchboard/protocol";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/runners. */
export function runnersRoutes(sc: Pick<ServerContext, "runnerLogins" | "json" | "bad" | "loginTarget" | "logoutTarget" | "runnerCliEnv" | "loginExpired" | "loginCheck" | "loginCheckedAt" | "refreshLogins">): Routes {
  return {
    // Settings the UI can change. A saved default mode must be one the runner offers and must not skip
    // approvals (danger modes are a per-task choice, never a default — schedules run unattended on the default);
    // null clears it, also for a runner that is no longer detected.
    // A runner's own login, from the screen. The pasted code goes to the CLI's stdin only.
    "/api/runners/:id/login": {
      GET: (req) => {
        const v = sc.runnerLogins.get(req.params.id as RunnerId);
        return v ? sc.json(v) : sc.bad("no login in progress", 404);
      },
      POST: async (req) => {
        const t = sc.loginTarget(req.params.id ?? "", new URL(req.url).searchParams.get("billing") === "api");
        if (!t) return sc.bad(`runner "${req.params.id}" has no login here`, 404);
        return sc.json(await sc.runnerLogins.start(t.runner, t.argv, t.hosts));
      },
      DELETE: (req) => {
        const v = sc.runnerLogins.cancel(req.params.id as RunnerId);
        return v ? sc.json(v) : sc.bad("no login in progress", 404);
      },
    },
    "/api/runners/:id/logout": {
      POST: async (req) => {
        const t = sc.logoutTarget(req.params.id ?? "");
        if (!t) return sc.bad(`runner "${req.params.id}" has no logout here`, 404);
        let code = -1;
        try {
          const proc = Bun.spawn(t.argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: sc.runnerCliEnv() });
          const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
          code = await proc.exited;
          clearTimeout(timer);
        } catch {
          // the executable detected at boot is gone or cannot run: the same answer as a command that failed
        }
        if (code !== 0) return sc.bad(`${t.runner} logout failed`, 502);
        sc.loginExpired.add(t.runner);
        await (sc.loginCheck ?? Promise.resolve());
        sc.loginCheckedAt = 0;
        await sc.refreshLogins();
        return sc.json({ ok: true });
      },
    },
    "/api/runners/:id/login/code": {
      POST: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { code?: unknown };
        if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 2000) return sc.bad("code must be a non-empty string");
        const v = await sc.runnerLogins.submit(req.params.id as RunnerId, body.code);
        return v ? sc.json(v) : sc.bad("no login in progress", 404);
      },
    },
  };
}
