/** What the automatic promotion decided that sb-rescue's history does not hold, and how it is counted. No daemon state is read here. */

import type { OpsPromotions, PromotionDecisionKind } from "@switchboard/protocol";
import { type Db, jstDayStart } from "./db.ts";
import { readReleaseHistory } from "./ops-stops.ts";

export type { PromotionDecisionKind };

const MAX_FILES = 5;
const MAX_FILE_CHARS = 300;
const RECENT = 20;

/** The files sb-rescue named in its answer that a restart is needed: the first 5 names (300 characters each) and how many there were. Anything that is not a list of strings is none. */
export function refusedFiles(body: unknown): { files: string[]; fileCount: number } {
  const b = body as { files?: unknown; fileCount?: unknown } | null;
  if (!b || !Array.isArray(b.files) || !b.files.every((f) => typeof f === "string")) return { files: [], fileCount: 0 };
  const files = (b.files as string[]).slice(0, MAX_FILES).map((f) => f.slice(0, MAX_FILE_CHARS));
  return { files, fileCount: typeof b.fileCount === "number" && Number.isFinite(b.fileCount) ? b.fileCount : files.length };
}

/** The decisions of the last `days` JST days (as `opsStops`): each kind's rows by their last time, the switches sb-rescue's history says went in without a restart, and the newest rows. */
export function promotionCounts(db: Db, home: string, days: number, now = Date.now()): OpsPromotions {
  const since = jstDayStart(now, days - 1);
  const rows = db.promotionDecisions(since);
  const count = (kind: PromotionDecisionKind) => rows.filter((r) => r.kind === kind).length;
  return {
    noRestartAsked: count("no-restart"),
    noRestartSwitched: readReleaseHistory(home).filter((h) => h.action === "promote-web" && h.ts >= since).length,
    waited: count("waited"),
    refused: count("refused"),
    recent: rows.slice(0, RECENT),
  };
}
