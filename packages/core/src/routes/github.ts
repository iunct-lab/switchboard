import { runGh } from "../backlog-gh.ts";
import { GITHUB_LOGIN_ARGS, GITHUB_LOGIN_HOSTS, GITHUB_LOGOUT_ARGS, githubStatus } from "../github-login.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/github. */
export function githubRoutes(sc: Pick<ServerContext, "json" | "opts" | "cfg" | "githubLogins" | "bad" | "ghBin" | "runnerCliEnv">): Routes {
  return {
    "/api/github/status": {
      GET: async () => sc.json(await githubStatus(sc.opts.gh ?? runGh, sc.cfg.repoRoot)),
    },
    "/api/github/login": {
      GET: () => {
        const v = sc.githubLogins.get("gh");
        return v ? sc.json(v) : sc.bad("no login in progress", 404);
      },
      POST: async () => {
        const bin = sc.ghBin();
        if (!bin) return sc.bad("gh is not installed here", 404);
        return sc.json(await sc.githubLogins.start("gh", [bin, ...GITHUB_LOGIN_ARGS], GITHUB_LOGIN_HOSTS));
      },
      DELETE: () => {
        const v = sc.githubLogins.cancel("gh");
        return v ? sc.json(v) : sc.bad("no login in progress", 404);
      },
    },
    "/api/github/logout": {
      POST: async () => {
        const bin = sc.ghBin();
        if (!bin) return sc.bad("gh is not installed here", 404);
        let code = -1;
        try {
          const proc = Bun.spawn([bin, ...GITHUB_LOGOUT_ARGS], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: sc.runnerCliEnv() });
          const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
          code = await proc.exited;
          clearTimeout(timer);
        } catch {
          // gh is gone or cannot run: the same answer as a command that failed
        }
        if (code !== 0) return sc.bad("github logout failed", 502);
        return sc.json({ ok: true });
      },
    },
  };
}
