import { z } from "zod";
import { TaskOrigin } from "./shared.ts";

/** One session log the daemon follows: which task it feeds and how far it has been read. */
export const HistorySession = z.object({
  sessionId: z.string(),
  taskId: z.string(),
  origin: TaskOrigin,
  /** Absolute path of the `.jsonl` under the Claude projects folder. */
  path: z.string(),
  /** The same with the daemon user's home shortened to `~` (the browser does not know homedir()). */
  pathDisplay: z.string(),
  /** Bytes of the file already imported. */
  offset: z.number(),
  importedAt: z.number(),
});
export type HistorySession = z.infer<typeof HistorySession>;

export const HistoryScanResult = z.object({
  ts: z.number(),
  /** `.jsonl` files seen. */
  files: z.number(),
  /** Terminal sessions that became new tasks. */
  created: z.number(),
  /** Files whose new records were appended to an existing task. */
  appended: z.number(),
  /** Files whose cwd is under no registered workspace (add the workspace and they come in on the next pass). */
  skippedForeign: z.number(),
  /** Files written only by an SDK host (Switchboard or another program) that no task claims. */
  skippedOtherHost: z.number(),
  errors: z.array(z.string()),
});
export type HistoryScanResult = z.infer<typeof HistoryScanResult>;

export const HistoryStatus = z.object({
  dir: z.string(),
  /** The folder exists (Claude Code has been used on this machine). */
  enabled: z.boolean(),
  /** Interval between passes; 0 = only at boot and on request. */
  pollMs: z.number(),
  lastScanAt: z.number().nullable(),
  lastResult: HistoryScanResult.nullable(),
  sessions: z.array(HistorySession),
});
export type HistoryStatus = z.infer<typeof HistoryStatus>;
