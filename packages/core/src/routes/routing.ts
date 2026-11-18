import type { RoutingLogRow } from "@switchboard/protocol";
import type { Routes, ServerContext } from "../server/context.ts";
import { clampLimit, clampDays } from "./shared.ts";

/** The routes under /api/routing. */
export function routingRoutes(sc: Pick<ServerContext, "db" | "json">): Routes {
  return {
    // Decision log. JSON for the UI; `?format=jsonl` is the training-data export — one example per line,
    // newest first, so `| head -n` is a valid (if newest-biased) sample and the whole body never has to be parsed.
    "/api/routing/log": (req) => {
      const q = new URL(req.url).searchParams;
      const rows = sc.db.routingLog(clampLimit(q.get("limit")));
      if (q.get("format") !== "jsonl") return sc.json(rows);
      // U+2028 / U+2029 survive JSON.stringify as themselves; consumers that split on Unicode line breaks
      // (Python's str.splitlines(), some stream parsers) would see one record as several lines.
      const line = (r: RoutingLogRow) => JSON.stringify(r).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      return new Response(rows.map(line).join("\n") + (rows.length ? "\n" : ""), { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    },
    // Agreement rate per suggester: the Ledger's ルーティング一致率 card.
    "/api/routing/stats": (req) => sc.json(sc.db.routingStats(clampDays(new URL(req.url).searchParams.get("days")))),
  };
}
