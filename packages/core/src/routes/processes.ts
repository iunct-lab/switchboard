import { listProcesses } from "../process-defs.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/processes. */
export function processesRoutes(sc: Pick<ServerContext, "json" | "metaWorkspace">): Routes {
  return {
    // The process candidates (docs/design/process-kernel.md, K4), as the meta checkout defines them.
    "/api/processes": {
      GET: () => sc.json(listProcesses(sc.metaWorkspace()?.path).map((d) => ({ id: d.id, version: d.version, title: d.title, fits: d.fits }))),
    },
  };
}
