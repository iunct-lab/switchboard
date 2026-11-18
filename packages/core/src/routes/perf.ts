import { PerfSamplesInput } from "@switchboard/protocol";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/perf. */
export function perfRoutes(sc: Pick<ServerContext, "bad" | "db" | "json">): Routes {
  return {
    "/api/perf": {
      POST: async (req) => {
        const parsed = PerfSamplesInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        sc.db.insertPerfSamples(parsed.data);
        return sc.json({ ok: true, count: parsed.data.length });
      },
    },
    "/api/perf/summary": () => sc.json(sc.db.perfSummary()),
  };
}
