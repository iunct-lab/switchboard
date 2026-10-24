import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OpsStops, OpsStopsRow, StopReason } from "@switchboard/protocol";
import type { CoreConfig } from "./config.ts";
import { type Db, jstDay, jstDayStart } from "./db.ts";

/**
 * One row per daemon start (#2085, docs/design/ops-metrics.md): when it started and ended, why it ended, and which
 * tasks it cut mid-turn. The stopping daemon writes what it knows (its own exit, the tasks its shutdown cut); the next
 * start decides the cause from local records only — its own clean exit, the version, sb-rescue's history.jsonl,
 * systemd's journal, the boot id. Nothing is sent anywhere.
 */
export type { StopReason };

/** What the stopping daemon wrote: `restart` = it exited 75 for /api/daemon/restart, `shutdown` = a signal it handled. */
export type CleanExit = "restart" | "shutdown";

export interface DaemonRun {
  id: number;
  started_at: number;
  ended_at: number | null;
  end_reason: StopReason | null;
  end_detail: string | null;
  clean_exit: CleanExit | null;
  version: string | null;
  boot_id: string | null;
  interrupted_task_ids: string;
}

export interface StopInput {
  now: number;
  /** The version this start runs; a different one than the previous row's means a release was switched. */
  version: string | null;
  bootId: string | null;
  /** `journalctl -u switchboard.service` lines since the previous start (`short-unix`); null where there is no journal. */
  journal: string[] | null;
  history: Array<{ ts: number; action: string }>;
}

const SWITCHES = new Set(["promote", "rollback", "auto-rollback", "restore-db"]);

/**
 * sb-rescue writes a promotion's line after it confirmed the new daemon (confirm + settle, up to 70 s,
 * rescue/src/promote.ts): a line that early in a run is about how the run began, not how it ended.
 */
export const HISTORY_GRACE_MS = 90_000;

/** `1792501259.542994 host systemd[1]: …` → ms, or null for a line without the short-unix stamp. */
function lineTime(line: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s/.exec(line);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/**
 * Why `prev` ended; the first rule that fits wins (docs/design/ops-metrics.md). sb-rescue writes a promotion to
 * history.jsonl only after the new daemon is confirmed, so a start right after one finds no line yet (a changed
 * version stands for it), and the line falls in the first moments of the next run (HISTORY_GRACE_MS).
 */
export function classifyStop(prev: DaemonRun, input: StopInput): { reason: StopReason; detail: string; endedAt: number } {
  const fallback = prev.ended_at ?? input.now;
  const at = (reason: StopReason, detail: string, endedAt = fallback) => ({ reason, detail, endedAt });
  if (prev.clean_exit === "restart") return at("restart", "the daemon exited 75 for a restart");
  const switched = input.history.find((h) => h.ts >= prev.started_at + HISTORY_GRACE_MS && h.ts <= input.now && (SWITCHES.has(h.action) || h.action === "restart"));
  if (switched && SWITCHES.has(switched.action)) return at("promote", `history.jsonl: ${switched.action}`);
  if (prev.version && input.version && prev.version !== input.version) return at("promote", `version ${prev.version} → ${input.version}`);
  if (switched) return at("restart", "history.jsonl: restart");
  // a daemon that wrote its own exit was not killed, whatever oomd did to its runners meanwhile
  const oomd = prev.clean_exit === null ? input.journal?.find((l) => l.includes("systemd-oomd killed")) : undefined;
  if (oomd) return at("oomd", "journal: systemd-oomd killed the unit", lineTime(oomd) ?? fallback);
  if (prev.boot_id && input.bootId && prev.boot_id !== input.bootId) return at("host-stop", "boot id changed");
  const tempfail = input.journal?.find((l) => l.includes("status=75"));
  if (tempfail) return at("restart", "journal: exited 75", lineTime(tempfail) ?? fallback);
  if (input.journal === null) return at("unknown", "no journal to read");
  if (prev.clean_exit === "shutdown") return at("restart", "the daemon stopped on a signal");
  return at("crash", "no clean exit and nothing in the journal");
}

/** The unit's journal since `sinceMs`; null where journalctl is missing or fails (macOS, no permission). */
export function readJournal(sinceMs: number): string[] | null {
  try {
    const r = Bun.spawnSync(["journalctl", "-u", "switchboard.service", "--since", `@${Math.floor(sinceMs / 1000)}`, "-o", "short-unix", "--no-pager", "-q"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return r.exitCode === 0 ? r.stdout.toString().split("\n").filter(Boolean) : null;
  } catch {
    return null;
  }
}

export function readBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** `ts` and `action` of sb-rescue's history.jsonl (rescue/src/releases.ts); a broken line is skipped. */
export function readReleaseHistory(home: string): Array<{ ts: number; action: string }> {
  const file = join(home, "releases", "history.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const e = JSON.parse(line) as { ts?: unknown; action?: unknown };
        return typeof e.ts === "number" && typeof e.action === "string" ? [{ ts: e.ts, action: e.action }] : [];
      } catch {
        return [];
      }
    });
}

/** The release directory's name under sb-rescue, the short HEAD of a checkout otherwise. */
export function daemonVersion(cfg: Pick<CoreConfig, "rescueUrl" | "codeRoot">): string | null {
  if (cfg.rescueUrl) return basename(cfg.codeRoot);
  try {
    const r = Bun.spawnSync(["git", "-C", cfg.codeRoot, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}

const merge = (json: string, ids: string[]) => JSON.stringify([...new Set([...(JSON.parse(json) as string[]), ...ids])]);

/**
 * Close the previous start's row (if it is still open) with its cause and the tasks found orphaned, then open this
 * start's row. The journal is read only when there is a row to close, from that row's start.
 */
export function startDaemonRun(
  db: Db,
  input: Omit<StopInput, "journal"> & { journal: (sinceMs: number) => string[] | null; orphaned: string[] },
): number {
  const sql = db.sqlite;
  const prev = sql.query("SELECT * FROM daemon_runs WHERE ended_at IS NULL OR end_reason IS NULL ORDER BY id DESC LIMIT 1").get() as DaemonRun | null;
  const stop = prev ? classifyStop(prev, { ...input, journal: input.journal(prev.started_at) }) : null;
  return sql.transaction(() => {
    if (prev && stop) {
      sql.query("UPDATE daemon_runs SET ended_at = ?, end_reason = ?, end_detail = ?, interrupted_task_ids = ? WHERE id = ?").run(stop.endedAt, stop.reason, stop.detail, merge(prev.interrupted_task_ids, input.orphaned), prev.id);
    }
    sql.query("UPDATE daemon_runs SET ended_at = COALESCE(ended_at, ?), end_reason = 'unknown', end_detail = 'left open by an older start' WHERE (ended_at IS NULL OR end_reason IS NULL) AND id != ?").run(input.now, prev?.id ?? -1);
    return (sql.query("INSERT INTO daemon_runs (started_at, version, boot_id) VALUES (?, ?, ?) RETURNING id").get(input.now, input.version, input.bootId) as { id: number }).id;
  })();
}

/** The stopping daemon's own part: how it exits, when, and the tasks its shutdown cut. The cause is left to the next start. */
export function endDaemonRun(db: Db, id: number, end: { cleanExit: CleanExit; endedAt: number; taskIds: string[] }): void {
  const row = db.sqlite.query("SELECT interrupted_task_ids FROM daemon_runs WHERE id = ?").get(id) as { interrupted_task_ids: string } | null;
  if (!row) return;
  db.sqlite.query("UPDATE daemon_runs SET clean_exit = ?, ended_at = ?, interrupted_task_ids = ? WHERE id = ?").run(end.cleanExit, end.endedAt, merge(row.interrupted_task_ids, end.taskIds), id);
}

/**
 * `GET /api/ops/stops` (#2092): the runs that ended within the last `days` JST days (as `ledgerDaily`), per day of the
 * end × cause. `turns` adds up each run's cut tasks; `taskIds` is the distinct tasks.
 */
export function opsStops(db: Db, days: number, now = Date.now()): OpsStops {
  const rows = db.sqlite.query("SELECT ended_at, end_reason, interrupted_task_ids FROM daemon_runs WHERE end_reason IS NOT NULL AND ended_at >= ? ORDER BY ended_at").all(jstDayStart(now, days - 1)) as Array<{ ended_at: number; end_reason: StopReason; interrupted_task_ids: string }>;
  const acc = new Map<string, OpsStopsRow>();
  for (const r of rows) {
    const day = jstDay(r.ended_at);
    const key = `${day}|${r.end_reason}`;
    const cur = acc.get(key) ?? { day, reason: r.end_reason, stops: 0, turns: 0, taskIds: [] };
    const ids = JSON.parse(r.interrupted_task_ids) as string[];
    cur.stops++;
    cur.turns += ids.length;
    cur.taskIds = [...new Set([...cur.taskIds, ...ids])];
    acc.set(key, cur);
  }
  const running = db.sqlite.query("SELECT started_at, version FROM daemon_runs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as { started_at: number; version: string | null } | null;
  return { days, rows: [...acc.values()].sort((a, b) => a.day.localeCompare(b.day) || a.reason.localeCompare(b.reason)), running: running && { startedAt: running.started_at, version: running.version } };
}
