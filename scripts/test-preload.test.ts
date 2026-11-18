// test-reads: none
import { expect, test } from "bun:test";
import { queueWatch } from "./test-preload.ts";

const armed = (): Set<{ stopQueue(): void }> => (globalThis as unknown as Record<symbol, Set<{ stopQueue(): void }>>)[Symbol.for("switchboard.armed-queue-timers")]!;

test("a queue timer left armed across test files is stopped and reported with the file and line that made it", () => {
  // a set and a watch of their own: the run's (the preload's) does not see these
  const set = new Set<{ stopQueue(): void }>();
  let file = "a.test.ts";
  const w = queueWatch(set, () => file);
  w.watch();
  let stopped = 0;
  const q = { stopQueue: () => void stopped++ };
  set.add(q);
  // the file that made it may keep it between its own tests (a server shared by a beforeAll)
  w.sweep();
  expect(stopped).toBe(0);
  expect(set.has(q)).toBe(true);
  file = "b.test.ts";
  const mine = { stopQueue: () => void stopped++ };
  set.add(mine);
  w.sweep();
  expect(stopped).toBe(1);
  expect([set.has(q), set.has(mine)]).toEqual([false, true]);
  const lines = w.report();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("a.test.ts: TaskManager のキューのタイマーを 1 個止めずに終わった（shutdown() か startServer の stop() を呼ぶ）。作った行: test-preload.test.ts:");
  expect(w.report()).toEqual([]);
  // the last sweep also takes what the current file left
  w.sweep(true);
  expect(stopped).toBe(2);
  expect(w.report()).toHaveLength(1);
});

test("a TaskManager is in the armed set until its queue is stopped, and never with holdQueue", async () => {
  const { stopArmedQueues } = await import("../packages/core/src/tasks/state.ts");
  const { TaskManager } = await import("../packages/core/src/tasks/manager.ts");
  const { Db } = await import("../packages/core/src/db.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "switchboard.preload-test."));
  const db = new Db(join(home, "t.db"));
  try {
    const before = armed().size;
    const held = new TaskManager(db, new Map(), () => undefined, { holdQueue: true });
    expect(armed().size).toBe(before);
    const tm = new TaskManager(db, new Map(), () => undefined);
    expect(armed().has(tm)).toBe(true);
    await tm.shutdown();
    expect(armed().has(tm)).toBe(false);
    // the test helper: every queue a file's tests left armed, at once
    const a = new TaskManager(db, new Map(), () => undefined);
    const b = new TaskManager(db, new Map(), () => undefined);
    expect(stopArmedQueues()).toBe(2);
    expect([armed().has(a), armed().has(b)]).toEqual([false, false]);
    await held.shutdown();
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
