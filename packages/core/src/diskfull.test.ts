import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, StopRecord } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { DISK_CHECK_MS, DISK_FREE_MIN_BYTES, diskFreeBytes, diskFullHit } from "./diskfull.ts";
import { stopHeld } from "./backlog.ts";
import { STOP_NOTE } from "./evals.ts";
import { lastStopWasDaemon } from "./interrupted.ts";
import { DISK_RESUME_PROMPT, MAX_CONSECUTIVE_STOPS, RateLimitResumer } from "./ratelimit.ts";
import { TaskManager } from "./tasks.ts";

const GIB = DISK_FREE_MIN_BYTES;
const NOW = Date.parse("2026-10-30T10:00:00Z");

function fakeAdapter(turns: AgentEvent[][], sends: string[]): RunnerAdapter {
  let n = 0;
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(_opts, emit) {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const play = () => {
        const script = turns[Math.min(n++, turns.length - 1)] ?? [];
        queueMicrotask(() => {
          for (const ev of script) emit(ev);
        });
      };
      play();
      const session: RunnerSession = {
        send: (text) => {
          sends.push(text);
          emit({ t: "message.delta", role: "user", text });
          play();
        },
        respondPermission: () => undefined,
        abort: async () => resolveExit(null),
        close: async () => resolveExit(0),
        exited,
      };
      return session;
    },
  } as RunnerAdapter;
}

const start: AgentEvent = { t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" };
const call = (name: string, summary: string, ok = false): AgentEvent[] => [
  { t: "tool.call", id: "c1", name, input: { command: "x" }, summary: name },
  { t: "tool.result", id: "c1", ok, summary },
];
const end = (status: "ok" | "error" | "aborted" = "ok", summary = "stopped"): AgentEvent[] => [{ t: "session.end", status, summary }];
const CLAUDE_TURN = [start, ...call("Bash", "The disk is full: nothing was run."), ...end()];
const CODEX_TURN = [start, ...call("exec", "tar: x: Cannot write: No space left on device", false), ...end()];
const OK_TURN = [start, ...end("ok", "done")];

describe("a turn that says the disk is full (#2234)", () => {
  let home: string;
  let db: Db;
  let tasks: TaskManager;
  let sends: string[];
  let free: number;
  let reads: number[];
  let now: number;
  let enabled: boolean;
  let resumer: RateLimitResumer;
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const boot = (turns: AgentEvent[][]) => {
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter(turns, sends)]]), () => undefined, { idleMs: -1 });
    resumer = new RateLimitResumer(db, tasks, { enabled: () => enabled, now: () => now, diskFree: () => reads.shift() ?? free });
    resumer.start(3_600_000);
  };
  const run = async (turns: AgentEvent[][]) => {
    boot(turns);
    const t = tasks.create({ title: "t", prompt: "go", runner: "claude", cwd: home });
    await settle();
    return t.id;
  };
  const stopsOf = (id: string) => db.listEvents(id).map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "stop.record" }> => e.t === "stop.record").map((e) => e.stop as StopRecord);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-diskfull-"));
    db = new Db(join(home, "db.sqlite"));
    sends = [];
    free = GIB / 2;
    reads = [];
    now = NOW;
    enabled = true;
  });
  afterEach(async () => {
    resumer.stop();
    await tasks.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("Claude's Bash result: a disk-full stop and the wait for space", async () => {
    const id = await run([CLAUDE_TURN]);
    const t = db.getTask(id)!;
    expect(t.resumeReason).toBe("disk");
    expect(t.resumeAt).toBe(NOW + DISK_CHECK_MS);
    const [stop] = stopsOf(id);
    expect(stop).toMatchObject({ reason: "disk-full", state: "waiting", evidence: "disk is full", conditions: [{ key: "diskFree", value: "0.5 GiB", met: false }] });
  });

  test("Codex's command result: the same stop, with only the words as its evidence", async () => {
    const id = await run([CODEX_TURN]);
    expect(db.getTask(id)!.resumeReason).toBe("disk");
    expect(stopsOf(id)[0]).toMatchObject({ reason: "disk-full", evidence: "No space left on device" });
  });

  test("an error of the turn counts; the reply of a turn that ended well does not", async () => {
    const id = await run([[start, ...end("error", "ENOSPC: write failed")]]);
    expect(db.getTask(id)!.resumeReason).toBe("disk");
    resumer.stop();
    await tasks.shutdown();
    const other = await run([[start, ...end("ok", "直しました: ENOSPC を見分けます")]]);
    expect(db.getTask(other)!.resumeReason).toBeNull();
    expect(stopsOf(other)).toEqual([]);
  });

  test("a read tool's result is a quote: no stop, no wait", async () => {
    const id = await run([[start, ...call("Read", "12\tconst t = /ENOSPC/;", true), ...end()]]);
    expect(db.getTask(id)!.resumeReason).toBeNull();
    expect(stopsOf(id)).toEqual([]);
  });

  test("the words on a disk with room are not a stop: a printed log, a full /tmp", async () => {
    free = GIB * 4;
    const id = await run([CLAUDE_TURN]);
    expect(db.getTask(id)!.resumeReason).toBeNull();
    expect(stopsOf(id)).toEqual([]);
  });

  test("a command that succeeded and printed the words is not a stop, even on a low disk", async () => {
    const id = await run([[start, ...call("Bash", "src/x.ts:3: ENOSPC", true), ...end()]]);
    expect(db.getTask(id)!.resumeReason).toBeNull();
    expect(stopsOf(id)).toEqual([]);
  });

  test("a disk stop after a daemon stop is not read as the daemon's", async () => {
    const id = await run([CLAUDE_TURN]);
    const text = db.listEvents(id).map((e) => e.ev).filter((e) => e.t === "status").map((e) => e.text).at(-1)!;
    expect(lastStopWasDaemon([{ t: "status", text: STOP_NOTE }, { t: "status", text }])).toBe(false);
  });

  test("a turn the person cut is theirs", async () => {
    const id = await run([[start, ...call("Bash", "No space left on device"), ...end("aborted")]]);
    expect(db.getTask(id)!.resumeReason).toBeNull();
  });

  test("free: 0.5 GiB keeps waiting and moves the check on; 2 GiB sends the follow-up once and closes the stop", async () => {
    const id = await run([CLAUDE_TURN, OK_TURN]);
    now += DISK_CHECK_MS;
    expect(await resumer.tick()).toEqual([]);
    expect(sends).toEqual([]);
    expect(db.getTask(id)!.resumeAt).toBe(now + DISK_CHECK_MS);

    free = GIB * 2;
    now += DISK_CHECK_MS;
    expect(await resumer.tick()).toEqual([id]);
    await settle();
    expect(sends).toEqual([DISK_RESUME_PROMPT]);
    expect(db.getTask(id)!.resumeAt).toBeNull();
    const stops = stopsOf(id);
    expect(stops.at(-1)).toMatchObject({ reason: "disk-full", state: "resolved", conditions: [{ key: "diskFree", value: "2.0 GiB", met: true }] });

    now += DISK_CHECK_MS;
    expect(await resumer.tick()).toEqual([]);
    expect(sends).toHaveLength(1);
  });

  test("free: not before the check is due, and not with auto-resume off", async () => {
    await run([CLAUDE_TURN, OK_TURN]);
    free = GIB * 2;
    expect(await resumer.tick()).toEqual([]);
    enabled = false;
    now += DISK_CHECK_MS;
    expect(await resumer.tick()).toEqual([]);
    expect(sends).toEqual([]);
  });

  test("free: a turn that fills the disk again waits again, with a new open stop", async () => {
    const id = await run([CLAUDE_TURN, CLAUDE_TURN]);
    reads = [GIB * 2]; // the tick sees room; the turn it starts ends on a full disk
    now += DISK_CHECK_MS;
    await resumer.tick();
    await settle();
    expect(db.getTask(id)!.resumeReason).toBe("disk");
    expect(stopsOf(id).at(-1)).toMatchObject({ state: "waiting" });
  });

  test("resumeNow ends the wait with its own words, whatever the disk says", async () => {
    const id = await run([CLAUDE_TURN, OK_TURN]);
    await resumer.resumeNow(id);
    await settle();
    expect(sends).toEqual([DISK_RESUME_PROMPT]);
    expect(stopsOf(id).at(-1)).toMatchObject({ state: "resolved", conditions: [{ key: "diskFree", value: "0.5 GiB", met: false }] });
    expect(db.listEvents(id).some((e) => e.ev.t === "status" && e.ev.text === "空き待ちを打ち切って今すぐ再開します")).toBe(true);
  });

  test("free: with auto-resume off nothing is sent, yet the stop ends once the space is back", async () => {
    const id = await run([CLAUDE_TURN, OK_TURN]);
    enabled = false;
    free = GIB * 2;
    now += DISK_CHECK_MS;
    expect(await resumer.tick()).toEqual([]);
    expect(sends).toEqual([]);
    expect(stopsOf(id).at(-1)).toMatchObject({ state: "resolved", conditions: [{ key: "diskFree", met: true }] });
  });

  test("free: a cancel or a reply closes the stop, so the backlog is not held by a wait nobody keeps", async () => {
    const id = await run([CLAUDE_TURN, OK_TURN]);
    resumer.cancel(id);
    expect(stopsOf(id).at(-1)).toMatchObject({ state: "resolved" });
    const other = await run([CLAUDE_TURN, OK_TURN]);
    await tasks.send(other, "空けました");
    await settle();
    expect(stopsOf(other).at(-1)).toMatchObject({ state: "resolved" });
  });

  test("free: a turn that keeps filling the disk is not resumed without end", async () => {
    const id = await run([CLAUDE_TURN]);
    let n = 0;
    while (db.getTask(id)!.resumeAt !== null && n++ < 30) {
      reads = [GIB * 2];
      now += DISK_CHECK_MS;
      await resumer.tick();
      await settle();
    }
    expect(sends.length).toBe(MAX_CONSECUTIVE_STOPS);
    expect(stopsOf(id).at(-1)).toMatchObject({ state: "exhausted" });
  });

  test("free: the look every 5 minutes does not count as a change of the task", async () => {
    const id = await run([CLAUDE_TURN]);
    const before = db.getTask(id)!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    now += DISK_CHECK_MS;
    await resumer.tick();
    expect(db.getTask(id)!.updatedAt).toBe(before);
  });

  test("free: backlog-next leaves an item whose last Task waits for space, and takes it once the stop is closed", async () => {
    const id = await run([CLAUDE_TURN, OK_TURN]);
    const item = (state: string, met: boolean) => ({ stage: "in-progress", waits: [], prereqs: [], answeredAt: null, lastTask: db.getTask(id), stopSummary: [{ work: { taskId: id }, lastAt: 1, state, count: 1, changes: met ? [{ kind: "condition-met" }] : [], conditions: [{ key: "diskFree", value: "0.5 GiB", met }] }] }) as unknown as Parameters<typeof stopHeld>[0];
    expect(stopHeld(item("waiting", false))).toBe(true);
    expect(stopHeld(item("resolved", true))).toBe(false);
  });

  test("the words of one turn do not carry to the next", async () => {
    free = GIB * 4; // the first turn plans nothing
    const id = await run([CLAUDE_TURN, OK_TURN]);
    free = GIB / 2;
    await tasks.send(id, "続けて", { mirror: false });
    await settle();
    expect(db.getTask(id)!.resumeReason).toBeNull();
  });
});

describe("diskfull helpers (#2234)", () => {
  test("diskFullHit: the words, nothing around them; a read tool sees none", () => {
    expect(diskFullHit("Bash", "/x/secret-path: No space left on device\n")).toBe("No space left on device");
    expect(diskFullHit("Bash", "all good")).toBeUndefined();
    for (const tool of ["Read", "Grep", "Glob"]) expect(diskFullHit(tool, "ENOSPC")).toBeUndefined();
  });

  test("diskFreeBytes reads the real filesystem", () => {
    expect(diskFreeBytes(tmpdir())).toBeGreaterThan(0);
  });
});
