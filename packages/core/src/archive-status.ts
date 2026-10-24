import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The daily archive (aws/host/archive.sh) writes one line to <home>/archive.status: `running <epoch>`, then
 * `ok <epoch> <S3 key>` or `failed <epoch> <exit code>` (#1201). Only a problem is reported; no file (a Mac, a local
 * daemon) or a line that does not parse is no problem — a broken line must not turn the screen red.
 */
export interface ArchiveProblem {
  /** failed: the run ended with an error. stuck: started and never ended (oom-kill skips the trap). stale: no success for too long. */
  kind: "failed" | "stuck" | "stale";
  /** When that run started or ended, epoch ms. */
  at: number;
  /** failed: the exit code. */
  detail?: string;
}

const STUCK_MS = 2 * 3600_000;
const STALE_MS = 48 * 3600_000;

export function archiveProblem(home: string, now = Date.now()): ArchiveProblem | null {
  let line: string;
  try {
    line = readFileSync(join(home, "archive.status"), "utf8").split("\n")[0] ?? "";
  } catch {
    return null;
  }
  // Each state with exactly its own fields: failed <epoch> <exit code> / running <epoch> / ok <epoch> <key>
  const m = /^(?:failed (\d+) (\d+)|running (\d+)|ok (\d+) \S+)\s*$/.exec(line);
  if (!m) return null;
  const at = Number(m[1] ?? m[3] ?? m[4]) * 1000;
  if (!Number.isFinite(new Date(at).getTime())) return null; // a number no date can show
  if (m[1]) return { kind: "failed", at, detail: m[2] };
  if (m[3]) return now - at > STUCK_MS ? { kind: "stuck", at } : null;
  return now - at > STALE_MS ? { kind: "stale", at } : null;
}
