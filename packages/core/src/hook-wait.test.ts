// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { TaskManager } from "./tasks/manager.ts";
import { checkWaits, waitsDirOf, type WaitBounds } from "./waits.ts";

const MIN = 60_000;
const BOUNDS: WaitBounds = { silentMs: 10 * MIN, ownMs: 6 * 3600_000, othersMs: 3 * 86_400_000, graceMs: 30 * MIN };

describe("a hook's heartbeats: a hook wait while they come, 応答なし again when they stop", () => {
  let home: string;
  let db: Db;
  let tasks: TaskManager;
  let emit: (ev: AgentEvent) => void;
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const look = (now: number) => checkWaits({ db, tasks, dir: waitsDirOf(home), bounds: () => BOUNDS, broadcastTask: () => undefined }, now);
  const kinds = (id: string) => (db.getTask(id)!.waits ?? []).map((w) => w.kind);

  // the runner process alone is fake: it starts a turn and stays in it
  const adapter = (): RunnerAdapter =>
    ({
      id: "claude",
      async detect() {
        return { available: true };
      },
      start(_opts, e) {
        emit = e;
        queueMicrotask(() => e({ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }));
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => undefined, close: async () => undefined, exited: new Promise<number | null>(() => undefined) } as RunnerSession;
      },
    }) as RunnerAdapter;

  const begin = async () => {
    tasks = new TaskManager(db, new Map([["claude", adapter()]]), () => undefined, { idleMs: -1 });
    const t = tasks.create({ title: "t", prompt: "go", runner: "claude", cwd: home });
    await settle();
    return t.id;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-hook-wait-"));
    db = new Db(join(home, "db.sqlite"));
  });
  afterEach(async () => {
    await tasks.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("20 heartbeats add no event to the transcript but move the last event; the watch shows hook, not output", async () => {
    const id = await begin();
    const before = db.listEvents(id).length;
    const lastBefore = tasks.lastEvents().get(id)!;
    await new Promise((r) => setTimeout(r, 5));
    emit({ t: "hook.progress", hook: "Stop", startedAt: null });
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 1; i < 20; i++) emit({ t: "hook.progress", hook: "Stop", startedAt: null });
    await settle();
    expect(db.listEvents(id).length).toBe(before);
    expect(tasks.lastEvents().get(id)!).toBeGreaterThan(lastBefore);
    const beat = tasks.lastEvents().get(id)!;
    await look(beat + MIN);
    expect(db.getTask(id)!.waits).toMatchObject([{ kind: "hook", key: "hook", label: "Stop", until: beat + BOUNDS.silentMs }]);
    // the first heartbeat is where the hook began, and later ones do not move it
    expect(db.getTask(id)!.waits![0]!.since).toBe(tasks.lastHooks().get(id)!.since);
    expect(tasks.lastHooks().get(id)!.since).toBeLessThan(beat);
  });

  test("守る条件: heartbeats that stop for silentAfterMs leave the stored wait as output, never hook", async () => {
    const id = await begin();
    emit({ t: "hook.progress", hook: "Stop", startedAt: null });
    await settle();
    const beat = tasks.lastEvents().get(id)!;
    await look(beat + MIN);
    expect(kinds(id)).toEqual(["hook"]);
    await look(beat + BOUNDS.silentMs);
    expect(kinds(id)).toEqual(["output"]);
  });

  test("a heartbeat takes a stored output wait away, and any other event takes the hook wait away", async () => {
    const id = await begin();
    const t0 = tasks.lastEvents().get(id)!;
    await look(t0 + BOUNDS.silentMs);
    expect(kinds(id)).toEqual(["output"]);
    emit({ t: "hook.progress", hook: "Stop", startedAt: null });
    await settle();
    expect(kinds(id)).toEqual([]);
    await look(tasks.lastEvents().get(id)! + MIN);
    expect(kinds(id)).toEqual(["hook"]);
    emit({ t: "status", text: "hook done" });
    await settle();
    expect(kinds(id)).toEqual([]);
    expect(tasks.lastHooks().has(id)).toBe(false);
  });

  test("no heartbeat: the wait is the same output as before", async () => {
    const id = await begin();
    const t0 = tasks.lastEvents().get(id)!;
    await look(t0 + MIN);
    expect(kinds(id)).toEqual([]);
    await look(t0 + BOUNDS.silentMs);
    expect(kinds(id)).toEqual(["output"]);
  });
});
