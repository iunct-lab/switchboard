import { CliUpdateRunner, type RunnerId } from "@switchboard/protocol";
import type { Routes, ServerContext } from "../server/context.ts";
import { RunnerCommandsError, runnerCommands } from "../server/runner-commands.ts";

/** The routes under /api/runners. */
export function runnersRoutes(sc: Pick<ServerContext, "adapters" | "db" | "runnerLogins" | "json" | "bad" | "loginTarget" | "logoutTarget" | "runnerCliEnv" | "loginExpired" | "loginCheck" | "loginCheckedAt" | "refreshLogins" | "cliUpdateState" | "requestCliRollback" | "strong">): Routes {
  return {
    // Settings the UI can change. A saved default mode must be one the runner offers and must not skip
    // approvals (danger modes are a per-task choice, never a default — schedules run unattended on the default);
    // null clears it, also for a runner that is no longer detected.
    // A runner's own login, from the screen. The pasted code goes to the CLI's stdin only.
    // The host CLIs' versions: where each stands, and the record of what was put in, kept out or put back.
    "/api/runners/updates": {
      GET: () => sc.json(sc.cliUpdateState()),
    },
    // Puts the CLI back to the version rollbackTarget names (done when no Task runs; 202 = it waits for that). Recorded as a
    // person's, so it takes the same fresh check as the Settings PATCH.
    "/api/runners/:id/rollback": {
      POST: sc.strong(async (req) => {
        const runner = CliUpdateRunner.safeParse(req.params.id);
        if (!runner.success) return sc.bad(`runner "${req.params.id}" has no CLI to put back`, 404);
        const r = await sc.requestCliRollback(runner.data);
        return sc.json(r.body, r.status);
      }),
    },
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
    // What the request and reply boxes offer after "/": read from the runner, kept in the daemon's memory.
    "/api/runners/:id/commands": {
      GET: async (req) => {
        try {
          return sc.json(await runnerCommands(sc, req.params.id ?? "", new URL(req.url).searchParams.get("workspaceId") ?? ""));
        } catch (e) {
          if (e instanceof RunnerCommandsError) return sc.bad(e.message, e.status);
          throw e;
        }
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
