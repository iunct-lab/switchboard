import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";
import { Db } from "./db.ts";

const DAY = 86400;
const WEEK_A = 1_800_000_000 - (1_800_000_000 % 3600); // an hour boundary, epoch s
const WEEK_B = WEEK_A + 7 * DAY;

const withDb = (fn: (db: Db) => void) => {
  const h = mkdtempSync(join(tmpdir(), "switchboard-test-quota-windows-"));
  const db = new Db(join(h, "db.sqlite"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(h, { recursive: true, force: true });
  }
};

const task = (db: Db, id: string, workspaceId: string | null) => {
  const at = Date.now();
  db.insertTask({ id, workspaceId, title: "t", stage: null, runner: "claude", cwd: "/w", scope: ["/w"], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Task);
};
const spend = (db: Db, taskId: string, costUsd: number, tsSec: number) =>
  db.insertLedger({ taskId, runner: "claude", model: null, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd: 0, source: "reported", ts: tsSec * 1000 });

describe("quota_windows (#4900)", () => {
  test("a window keeps its peak after the quota resets into the next window", () =>
    withDb((db) => {
      db.upsertQuota("claude", "seven_day", 0.4, WEEK_A, 1_000);
      db.upsertQuota("claude", "seven_day", 1.0, WEEK_A, 2_000);
      db.upsertQuota("claude", "seven_day", 0.1, WEEK_B, 3_000);
      expect(db.quotaWindows()).toEqual([
        { runner: "claude", window: "seven_day", resetsAt: WEEK_B, peak: 0.1, firstTs: 3_000, lastTs: 3_000 },
        { runner: "claude", window: "seven_day", resetsAt: WEEK_A, peak: 1.0, firstTs: 1_000, lastTs: 2_000 },
      ]);
      expect(db.quotaFor("claude")).toEqual([{ window: "seven_day", utilization: 0.1, resetsAt: WEEK_B, ts: 3_000 }]);
    }));

  test("reports whose resets_at differ by 30 seconds are one window; lower later reports do not lower the peak", () =>
    withDb((db) => {
      db.upsertQuota("claude", "seven_day", 0.6, WEEK_A - 30, 1_000);
      db.upsertQuota("claude", "seven_day", 0.5, WEEK_A + 30, 2_000);
      expect(db.quotaWindows()).toEqual([{ runner: "claude", window: "seven_day", resetsAt: WEEK_A, peak: 0.6, firstTs: 1_000, lastTs: 2_000 }]);
    }));

  test("a reset time drifting across the half hour stays in the window already kept", () =>
    withDb((db) => {
      const half = WEEK_A + 1800; // rounds to WEEK_A one second before, to the next hour at it
      db.upsertQuota("codex", "seven_day", 0.3, half - 1, 1_000);
      db.upsertQuota("codex", "seven_day", 0.7, half + 2, 2_000); // 1802 s from the kept key
      expect(db.quotaWindows()).toEqual([{ runner: "codex", window: "seven_day", resetsAt: WEEK_A, peak: 0.7, firstTs: 1_000, lastTs: 2_000 }]);
    }));

  test("a report without a reset time keeps no window", () =>
    withDb((db) => {
      db.upsertQuota("codex", "seven_day", 0.2, 0, 1_000);
      expect(db.quotaWindows()).toEqual([]);
    }));

  test("only seven_day windows are kept", () =>
    withDb((db) => {
      db.upsertQuota("claude", "five_hour", 0.9, WEEK_A, 1_000);
      expect(db.quotaWindows()).toEqual([]);
    }));

  test("windowShares splits the window's spend by workspace, sums to 1, and leaves out other windows and runners", () =>
    withDb((db) => {
      task(db, "t1", "ws_a");
      task(db, "t2", "ws_b");
      spend(db, "t1", 3, WEEK_A - 6 * DAY);
      spend(db, "t2", 1, WEEK_A - DAY);
      spend(db, "t2", 50, WEEK_A); // the next window starts at resets_at
      spend(db, "t1", 50, WEEK_A - 8 * DAY); // before the window
      spend(db, "gone", 2, WEEK_A - 2 * DAY); // a Task no longer in tasks: kept as no workspace, not dropped
      const shares = db.windowShares("claude", WEEK_A);
      expect(shares).toEqual([
        { workspaceId: "ws_a", costUsd: 3, share: 3 / 6 },
        { workspaceId: null, costUsd: 2, share: 2 / 6 },
        { workspaceId: "ws_b", costUsd: 1, share: 1 / 6 },
      ]);
      expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1);
      expect(db.windowShares("codex", WEEK_A)).toEqual([]);
    }));
});
