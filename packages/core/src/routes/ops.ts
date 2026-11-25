import { homedir } from "node:os";
import { opsLatency } from "../ops-latency.ts";
import { opsLoad, readCgroup } from "../ops-load.ts";
import { opsResources } from "../ops-resources.ts";
import { opsStops } from "../ops-stops.ts";
import { promotionCounts } from "../promotion-log.ts";
import type { Routes, ServerContext } from "../server/context.ts";
import { clampDays } from "./shared.ts";

/** The routes under /api/ops. */
export function opsRoutes(sc: Pick<ServerContext, "json" | "db" | "bad" | "tasks" | "cfg">): Routes {
  return {
    "/api/ops/latency": (req) => sc.json(opsLatency(sc.db, clampDays(new URL(req.url).searchParams.get("days")))),
    "/api/ops/stops": (req) => {
      const raw = new URL(req.url).searchParams.get("days");
      const days = raw === null ? 7 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 90) return sc.bad("days must be an integer 1..90");
      return sc.json({ ...opsStops(sc.db, days), promotions: promotionCounts(sc.db, sc.cfg.home, days) });
    },
    "/api/ops/load": (req) => {
      const sp = new URL(req.url).searchParams;
      const raw = sp.get("days");
      const days = raw === null ? 7 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 90) return sc.bad("days must be an integer 1..90");
      return sc.json(opsLoad(sc.db, days, { taskId: sp.get("task") ?? undefined, available: readCgroup() !== null }));
    },
    // now, for the resources screen: read when asked; the screen asks every 5 s only while it is shown
    "/api/ops/resources": () => sc.json(opsResources(sc.db, { home: homedir(), queueWait: () => sc.tasks.queueWait() })),
  };
}
