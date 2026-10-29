import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, Task } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { STOP_NOTE } from "./evals.ts";
import { TaskManager, type TurnEnd } from "./tasks.ts";

/**
 * A lingering runner like `claude -p --input-format stream-json`: the first turn ends, the process stays, and the test
 * starts the next turn on the runner's own (what a background job's notification does) through `emit`.
 */
type Fake = { emit: (ev: AgentEvent) => void; closes: number; exit: (code: number | null) => void };
function fakeAdapter(fakes: Fake[]): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(_opts, emit) {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const fake: Fake = { emit, closes: 0, exit: (c) => resolveExit(c) };
      fakes.push(fake);
      queueMicrotask(() => {
        emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
        emit({ t: "session.end", status: "ok", summary: "待ちます" });
      });
      const session: RunnerSession = {
        send: () => undefined,
        respondPermission: () => undefined,
        abort: async () => resolveExit(null),
        close: async () => {
          fake.closes++;
          resolveExit(0);
        },
        exited,
      };
      return session;
    },
  };
}

const IDLE_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let home: string;
let db: Db;
let tasks: TaskManager;
let fakes: Fake[];
let ends: { task: Task; turn: TurnEnd }[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-tasks-"));
  db = new Db(join(home, "db.sqlite"));
  fakes = [];
  ends = [];
  tasks = new TaskManager(db, new Map([["claude", fakeAdapter(fakes)]]), () => undefined, { idleMs: IDLE_MS });
  tasks.onTurnEnd((_id, task, turn) => ends.push({ task, turn }));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function finishedTask(): Promise<Task> {
  const wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
  const t = tasks.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
  await sleep(0);
  expect(db.getTask(t.id)!.status).toBe("done");
  return t;
}

describe("a turn the runner starts on its own", () => {
  test("runner-started turn is in flight: running, and the idle release does not close it", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    expect(db.getTask(t.id)!.status).toBe("running");
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(0);
    expect(db.getTask(t.id)!.status).toBe("running");
  });

  test("runner-started turn ends like a sent turn: done, turn-end listeners, idle release again", async () => {
    const t = await finishedTask();
    ends.length = 0;
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "session.end", status: "ok", summary: "CI は通りました" });
    expect(db.getTask(t.id)!.status).toBe("done");
    expect(ends.map((e) => e.turn.end.summary)).toEqual(["CI は通りました"]);
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(1);
  });

  test("runner-started turn after an error ends as error", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "session.end", status: "error", summary: "boom" });
    expect(db.getTask(t.id)!.status).toBe("error");
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    expect(db.getTask(t.id)!.status).toBe("running");
  });

  test("process lost mid runner-started turn: the task ends in error, not a silent done", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.exit(137);
    await sleep(0);
    expect(db.getTask(t.id)!.status).toBe("error");
    const evs = db.listEvents(t.id).map((e) => e.ev);
    expect(evs.at(-1)).toMatchObject({ t: "session.end", status: "error", summary: "runner exited (137)" });
  });

  test("a released process's late session.start does not reopen the task", async () => {
    const t = await finishedTask();
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(1);
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    expect(db.getTask(t.id)!.status).toBe("done");
  });
});

describe("background work", () => {
  test("background work left after the turn keeps the process; the last job gone starts the idle clock", async () => {
    const t = await finishedTask();
    // the runner reported a job during the turn that just ended, as Claude does before its result
    fakes[0]!.emit({ t: "background", count: 1 });
    expect(tasks.backgroundJobs()).toBe(1);
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(0);
    expect(db.getTask(t.id)!.status).toBe("done");
    fakes[0]!.emit({ t: "background", count: 0 });
    expect(tasks.backgroundJobs()).toBe(0);
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(1);
  });

  test("background work: a turn that ends with a job left does not arm the idle release", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "background", count: 2 });
    fakes[0]!.emit({ t: "session.end", status: "ok", summary: "待ちます" });
    expect(db.getTask(t.id)!.status).toBe("done");
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(0);
    // the notification: the count drops, and the runner goes on in a turn of its own
    fakes[0]!.emit({ t: "background", count: 1 });
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    expect(db.getTask(t.id)!.status).toBe("running");
  });
});

describe("daemon stop", () => {
  test("shutdown with background work plans a resume for the finished task", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "background", count: 1 });
    expect(await tasks.shutdown()).toEqual([t.id]);
    expect(db.getTask(t.id)).toMatchObject({ status: "done" });
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull();
    const notes = db.listEvents(t.id).map((e) => e.ev).filter((ev) => ev.t === "status" && ev.text.startsWith(STOP_NOTE));
    expect(notes).toHaveLength(1);
  });

  test("shutdown with background work keeps a limit's resume plan", async () => {
    const t = await finishedTask();
    const reset = Date.now() + 60 * 60_000;
    tasks.setResumeAt(t.id, reset);
    fakes[0]!.emit({ t: "background", count: 1 });
    expect(await tasks.shutdown()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBe(reset);
    expect(db.listEvents(t.id).map((e) => e.ev).some((ev) => ev.t === "status" && ev.text.startsWith(STOP_NOTE))).toBe(false);
  });

  test("shutdown without background work leaves the finished task as it is", async () => {
    const t = await finishedTask();
    expect(await tasks.shutdown()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
  });
});

describe("the checkout's origin (#2799)", () => {
  const git = (...args: string[]) => expect(spawnSync("git", ["-C", home, ...args]).status).toBe(0);
  const registered = { service: "github" as const, host: "github.com", repository: "acme/app-dev", project: { owner: "acme", number: 1 } };

  test("a task does not start in a checkout whose origin is not the registered repository", async () => {
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/acme/app.git");
    const wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
    db.setWorkspaceBacklogSource(wsId, registered);
    expect(() => tasks.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" })).toThrow("登録は acme/app-dev");
    expect(fakes).toHaveLength(0);
    const [t] = db.listTasks();
    expect(t!.status).toBe("error");
    const said = db.listEvents(t!.id).map((e) => e.ev).filter((ev) => ev.t === "status").map((ev) => (ev as { text: string }).text);
    expect(said.some((s) => s.includes("origin は acme/app") && s.includes("git remote set-url origin https://github.com/acme/app-dev.git"))).toBe(true);

    // a resume after the origin moved off the registration stops the same way
    git("remote", "set-url", "origin", "git@github.com:acme/app-dev.git");
    const ok = tasks.create({ workspaceId: wsId, cwd: home, title: "t2", prompt: "p", runner: "claude" });
    await sleep(IDLE_MS * 3);
    expect(fakes).toHaveLength(1);
    git("remote", "set-url", "origin", "https://github.com/acme/app.git");
    await expect(tasks.send(ok.id, "next")).rejects.toThrow("登録は acme/app-dev");
    expect(fakes).toHaveLength(1);
  });

  test("a workspace with no GitHub registration starts as before", async () => {
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/acme/app.git");
    const wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
    db.setWorkspaceBacklogSource(wsId, { service: "switchboard", host: "local", repository: wsId, project: { owner: "switchboard", number: 0 } });
    tasks.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    expect(fakes).toHaveLength(1);
  });
});
