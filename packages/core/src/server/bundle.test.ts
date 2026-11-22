// The functions of a bundle's hold, called with a context made by hand: no daemon, port or runner.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { Scheduler } from "../scheduler.ts";
import type { TaskManager } from "../tasks/manager.ts";
import { BUNDLE_HOLD_KEY } from "@switchboard/protocol";
import { bundleHold, holdForBundle, releaseBundle } from "./bundle.ts";

let home: string;
let db: Db;
let scheduler: Scheduler;
let wsId: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchboard-test-bundle-"));
  db = new Db(join(home, "db.sqlite"));
  scheduler = new Scheduler(db, {} as TaskManager);
  wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const add = (title: string, enabled = true) => scheduler.create({ title, cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p", enabled });
const enabledOf = () => Object.fromEntries(scheduler.list().map((s) => [s.title, s.enabled]));

describe("a bundle's hold without a server", () => {
  test("hold stops every enabled schedule and records them", () => {
    const a = add("a");
    add("off", false);
    const c = add("c");
    const hold = holdForBundle({ db, scheduler }, "tsk_1", "abc123");
    expect(hold).toMatchObject({ taskId: "tsk_1", base: "abc123", schedules: [a.id, c.id] });
    expect(enabledOf()).toEqual({ a: false, off: false, c: false });
    expect(bundleHold({ db })).toEqual(hold);
    expect(db.getSetting<unknown>(BUNDLE_HOLD_KEY, null)).toEqual(hold);
  });

  test("release restores only the held schedules", () => {
    const a = add("a");
    const b = add("b");
    add("off", false);
    const d = add("d");
    holdForBundle({ db, scheduler }, "tsk_1", null);
    // meanwhile the person turned `a` on again, deleted `b`, and a schedule made later stays as it is
    scheduler.update(a.id, { enabled: true });
    db.deleteSchedule(b.id);
    add("later", false);
    expect(releaseBundle({ db, scheduler })).toEqual({ released: true, restored: [d.id] });
    expect(enabledOf()).toEqual({ a: true, off: false, d: true, later: false });
    expect(bundleHold({ db })).toBeNull();
  });

  test("a second release does nothing", () => {
    add("a");
    holdForBundle({ db, scheduler }, "tsk_1", null);
    expect(releaseBundle({ db, scheduler }).released).toBe(true);
    // turned off by the person after the release: a second release must not turn it back on
    scheduler.update(scheduler.list()[0]!.id, { enabled: false });
    expect(releaseBundle({ db, scheduler })).toEqual({ released: false, restored: [] });
    expect(enabledOf()).toEqual({ a: false });
  });

  test("a second hold throws", () => {
    add("a");
    holdForBundle({ db, scheduler }, "tsk_1", null);
    expect(() => holdForBundle({ db, scheduler }, "tsk_2", null)).toThrow(/tsk_1/);
    expect(bundleHold({ db })?.taskId).toBe("tsk_1");
  });

  test("a stored value that is not a hold still holds, and its release turns nothing on", () => {
    add("off", false);
    db.setSetting(BUNDLE_HOLD_KEY, { taskId: "tsk_1" });
    expect(bundleHold({ db })).toEqual({ taskId: "不明", since: 0, schedules: [], base: null });
    expect(releaseBundle({ db, scheduler })).toEqual({ released: true, restored: [] });
    expect(bundleHold({ db })).toBeNull();
    expect(enabledOf()).toEqual({ off: false });
  });
});
