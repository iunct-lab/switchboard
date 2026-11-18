import { CustomRunnerList } from "@switchboard/protocol";
import { LOOPBACK_HOSTNAMES } from "../auth.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/custom-runners. */
export function customRunnersRoutes(sc: Pick<ServerContext, "json" | "db" | "strong" | "bad" | "cfg" | "logOp">): Routes {
  return {
    /**
     * The ADK servers added in Settings (docs/design/custom-adapter.md). PUT replaces the whole list; the daemon reads
     * it at start, so a change takes effect after a restart. A token's value has no field (strict: refused).
     */
    "/api/custom-runners": {
      GET: () => sc.json(sc.db.getCustomRunners()),
      PUT: sc.strong(async (req, srv) => {
        const parsed = CustomRunnerList.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const names = parsed.data.map((r) => r.name);
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) return sc.bad(`name "${dup}" is used twice`);
        // With passkey login a Task's token counts only from loopback, so the credential of a non-local agent would leave and open nothing.
        const away = sc.cfg.sessionPublicKey ? parsed.data.find((r) => r.port === "agui" && r.sendWorkspaceMcp && !LOOPBACK_HOSTNAMES.has(new URL(r.url).hostname)) : undefined;
        if (away) return sc.bad(`"${away.name}" sends the Workspace MCP token, but this host uses passkey login, where a Task's token counts only from this machine: use a local URL or turn the setting off`);
        sc.db.setCustomRunners(parsed.data);
        sc.logOp(req, srv, "settings.customRunners", { detail: { names } });
        return sc.json(parsed.data);
      }),
    },
  };
}
