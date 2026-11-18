// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type AgentEvent, REPLY_QUEUED, type RunnerAdapter, type RunnerId, type RunnerSession, type StartOptions, StopRecord, type Task } from "@switchboard/protocol";
import { abortOrphanedTasks, Db } from "./db.ts";
import { STOP_NOTE } from "./evals.ts";
import { isFableModel, type TurnEnd, versionAtLeast, stopArmedQueues } from "./tasks/state.ts";
import { kitPath, taskAllowRules } from "./tasks/sessions.ts";
import { TaskManager } from "./tasks/manager.ts";

/**
 * A lingering runner like `claude -p --input-format stream-json`: the first turn ends, the process stays, and the test
 * starts the next turn on the runner's own (what a background job's notification does) through `emit`.
 */
type Fake = { emit: (ev: AgentEvent) => void; closes: number; exit: (code: number | null) => void; sent: string[]; prompt?: string };
function fakeAdapter(fakes: Fake[]): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(opts, emit) {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const fake: Fake = { emit, closes: 0, exit: (c) => resolveExit(c), sent: [], prompt: opts.prompt };
      fakes.push(fake);
      queueMicrotask(() => {
        emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
        emit({ t: "session.end", status: "ok", summary: "待ちます" });
      });
      const session: RunnerSession = {
        send: (text) => void fake.sent.push(text),
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
  // a manager a test made and did not shut down would tick on this test's closed database
  stopArmedQueues();
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

describe("repeated thinking status", () => {
  const statuses = (id: string) => db.listEvents(id).map((e) => e.ev).filter((ev) => ev.t === "status");

  test("consecutive thinking status is recorded once", async () => {
    const t = await finishedTask();
    const fake = fakes[0]!;
    fake.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fake.emit({ t: "status", text: "permission mode → plan" });
    for (let i = 0; i < 100; i++) fake.emit({ t: "status", text: "thinking" });
    expect(statuses(t.id).filter((ev) => ev.text === "thinking")).toHaveLength(1);
    const before = db.listEvents(t.id).map((e) => e.ev);
    expect(before.filter((ev) => ev.t === "status").at(-1)).toEqual({ t: "status", text: "thinking" });
    fake.emit({ t: "message.delta", role: "assistant", text: "答え" });
    for (let i = 0; i < 3; i++) fake.emit({ t: "status", text: "thinking" });
    fake.emit({ t: "session.end", status: "ok" });
    expect(statuses(t.id).filter((ev) => ev.text === "thinking")).toHaveLength(2);
  });

  test("other repeated status texts are all recorded", async () => {
    const t = await finishedTask();
    const fake = fakes[0]!;
    fake.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fake.emit({ t: "status", text: "使用上限で止まりました" });
    fake.emit({ t: "status", text: "使用上限で止まりました" });
    expect(statuses(t.id).filter((ev) => ev.text === "使用上限で止まりました")).toHaveLength(2);
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
    expect(db.getTask(t.id)!.status).toBe("background");
    fakes[0]!.emit({ t: "background", count: 0 });
    expect(db.getTask(t.id)!.status).toBe("done");
    expect(tasks.backgroundJobs()).toBe(0);
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(1);
  });

  test("background work: a turn that ends with a job left does not arm the idle release", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "background", count: 2 });
    fakes[0]!.emit({ t: "session.end", status: "ok", summary: "待ちます" });
    expect(db.getTask(t.id)!.status).toBe("background");
    await sleep(IDLE_MS * 3);
    expect(fakes[0]!.closes).toBe(0);
    // the notification: the count drops, and the runner goes on in a turn of its own
    fakes[0]!.emit({ t: "background", count: 1 });
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    expect(db.getTask(t.id)!.status).toBe("running");
  });
});

describe("admission hold", () => {
  let hold: { wait: string; detail: string } | null;
  let held: TaskManager;
  let wsId: string;
  beforeEach(() => {
    hold = null;
    held = new TaskManager(db, new Map([["claude", fakeAdapter(fakes)]]), () => undefined, { idleMs: 10_000, admissionHold: () => hold, drainTickMs: 3_600_000 });
    wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
  });
  afterEach(async () => void (await held.shutdown()));
  const statusLines = (id: string) => db.listEvents(id).map((e) => e.ev).flatMap((ev) => (ev.t === "status" ? [ev.text] : []));

  test("a new Task waits in the queue while the hold stands and starts when it ends and resumeAdmission is called", async () => {
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    expect(db.getTask(t.id)).toMatchObject({ status: "idle" });
    expect(db.getTask(t.id)!.queuedAt).not.toBeNull();
    expect(fakes.length).toBe(0);
    expect(held.queueWait()).toBe("promotion");
    held.drain();
    expect(fakes.length).toBe(0);
    hold = null;
    expect(held.queueWait()).toBeNull();
    held.resumeAdmission();
    await sleep(0);
    expect(fakes.length).toBe(1);
    expect(db.getTask(t.id)!.queuedAt).toBeNull();
    expect(db.getTask(t.id)!.status).toBe("done");
  });

  test("a reply to a Task whose turn ended is queued with its text in the log, and its process is closed", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    expect(db.getTask(t.id)!.status).toBe("done");
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    const r = await held.send(t.id, "次の指示");
    expect(r.queuedAt).not.toBeNull();
    expect(fakes[0]!.sent).toEqual([]);
    expect(fakes[0]!.closes).toBe(1);
    expect(statusLines(t.id).some((l) => l.startsWith(REPLY_QUEUED) && l.includes("次の指示") && l.includes("昇格待ち"))).toBe(true);
    hold = null;
    held.resumeAdmission();
    await sleep(0);
    expect(db.getTask(t.id)!.queuedAt).toBeNull();
  });

  test("a new Cloud Task waits in the queue while the hold stands", async () => {
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude", executionMode: "cloud" });
    await sleep(0);
    expect(db.getTask(t.id)!.queuedAt).not.toBeNull();
    expect(fakes.length).toBe(0);
  });

  test("a reply to a turn in progress still reaches it", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    expect(db.getTask(t.id)!.status).toBe("running");
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    const r = await held.send(t.id, "追い打ち");
    expect(r.queuedAt).toBeNull();
    expect(fakes[0]!.sent).toEqual(["追い打ち"]);
  });

  test("a reply to a Task left on background jobs is held, keeps the process, and is queued when the jobs end", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "background", count: 1 });
    expect(db.getTask(t.id)!.status).toBe("background");
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    const r = await held.send(t.id, "次の指示");
    expect(r.status).toBe("background");
    expect(r.queuedAt).toBeNull();
    expect(fakes[0]!.sent).toEqual([]);
    expect(fakes[0]!.closes).toBe(0);
    expect(statusLines(t.id).some((l) => l.startsWith(REPLY_QUEUED) && l.includes("次の指示") && l.includes("裏の処理"))).toBe(true);
    fakes[0]!.emit({ t: "background", count: 0 });
    await sleep(0);
    expect(db.getTask(t.id)).toMatchObject({ status: "idle" });
    expect(db.getTask(t.id)!.queuedAt).not.toBeNull();
    expect(fakes.length).toBe(1);
    expect(fakes[0]!.closes).toBe(1);
    hold = null;
    held.resumeAdmission();
    await sleep(0);
    expect(db.getTask(t.id)!.queuedAt).toBeNull();
    expect(fakes.length).toBe(2);
    expect(fakes[1]!.prompt).toContain("次の指示");
  });

  test("a reply held on background jobs waits through a turn the runner starts itself, and is queued when that turn ends", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "background", count: 1 });
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    await held.send(t.id, "次の指示");
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    expect(db.getTask(t.id)!.status).toBe("running");
    fakes[0]!.emit({ t: "background", count: 0 });
    await sleep(0);
    expect(db.getTask(t.id)!.queuedAt).toBeNull();
    fakes[0]!.emit({ t: "session.end", status: "ok", summary: "済み" });
    await sleep(0);
    expect(db.getTask(t.id)!.queuedAt).not.toBeNull();
    expect(fakes[0]!.sent).toEqual([]);
    expect(fakes[0]!.closes).toBe(1);
  });

  test("a reply held on background jobs is dropped when the Task is aborted", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "background", count: 1 });
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    await held.send(t.id, "次の指示");
    await held.abort(t.id);
    await sleep(0);
    hold = null;
    held.resumeAdmission();
    await sleep(0);
    expect(db.getTask(t.id)).toMatchObject({ status: "aborted", queuedAt: null });
    expect(fakes.length).toBe(1);
    expect(fakes[0]!.sent).toEqual([]);
  });

  test("a reply held on background jobs is dropped when the daemon stops", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "background", count: 1 });
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    await held.send(t.id, "次の指示");
    await held.shutdown();
    await sleep(5);
    expect(db.getTask(t.id)!.queuedAt).toBeNull();
    expect(fakes.length).toBe(1);
    expect(statusLines(t.id).some((l) => l.includes("デーモンが止まるので"))).toBe(true);
  });

  test("a reply held through a turn the runner started itself is dropped when that turn is aborted", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "background", count: 1 });
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    await held.send(t.id, "次の指示");
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    await held.abort(t.id);
    await sleep(5);
    expect(db.getTask(t.id)).toMatchObject({ status: "aborted", queuedAt: null });
    expect(statusLines(t.id).some((l) => l.includes("中断したので"))).toBe(true);
  });

  test("a reply held through a turn the runner started itself is queued when the runner dies in that turn", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "background", count: 1 });
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    await held.send(t.id, "次の指示");
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "background", count: 0 });
    fakes[0]!.exit(137);
    await sleep(5);
    expect(db.getTask(t.id)!.queuedAt).not.toBeNull();
    hold = null;
    held.resumeAdmission();
    await sleep(0);
    expect(fakes.length).toBe(2);
    expect(fakes[1]!.prompt).toContain("次の指示");
  });

  test("a reply held on background jobs goes to the process when the hold ends before the jobs do", async () => {
    const t = held.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    fakes[0]!.emit({ t: "background", count: 1 });
    hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
    await held.send(t.id, "次の指示");
    hold = null;
    held.resumeAdmission();
    await sleep(0);
    expect(fakes[0]!.sent).toEqual(["次の指示"]);
    expect(fakes.length).toBe(1);
    expect(db.getTask(t.id)!.status).toBe("running");
  });
});

describe("daemon stop", () => {
  test("shutdown with background work plans a resume for the finished task", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "background", count: 1 });
    expect(await tasks.shutdown()).toEqual([t.id]);
    await sleep(5);
    expect(db.getTask(t.id)).toMatchObject({ status: "done", background: null });
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
    await sleep(5);
    expect(db.getTask(t.id)!.resumeAt).toBe(reset);
    expect(db.listEvents(t.id).map((e) => e.ev).some((ev) => ev.t === "status" && ev.text.startsWith(STOP_NOTE))).toBe(false);
  });

  test("shutdown without background work leaves the finished task as it is", async () => {
    const t = await finishedTask();
    expect(await tasks.shutdown()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
  });
});

describe("the checkout's origin", () => {
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

describe("a locked database under a runner's events", () => {
  const started = async () => {
    const wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
    const t = tasks.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(5);
    return t;
  };
  const lock = () => {
    db.sqlite.exec("PRAGMA busy_timeout = 0"); // the real SQLITE_BUSY at once, without the daemon's 5 s wait in the test
    const other = new Database(join(home, "db.sqlite"));
    other.exec("BEGIN IMMEDIATE");
    return other;
  };

  test("the events wait for the lock in order, the turn still ends, and a stop fence closing a reply is still read when the lock met its session.end", async () => {
    const t = await started();
    const other = lock();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "message.delta", role: "assistant", text: "一" } as never);
    fakes[0]!.emit({ t: "message.delta", role: "assistant", text: "二\n" } as never);
    const stop = { id: "x", op: "o", target: "t", reason: "transient", safety: "read-only", evidence: "e", state: "waiting", actions: [] };
    fakes[0]!.emit({ t: "message.delta", role: "assistant", text: `\`\`\`switchboard-stop\n${JSON.stringify(stop)}\n\`\`\`` } as never);
    fakes[0]!.emit({ t: "session.end", status: "ok", summary: "完了" });
    other.exec("COMMIT");
    other.close();
    await sleep(1200);
    expect(db.listEvents(t.id).filter((e) => e.ev.t === "message.delta" && e.ev.role === "assistant").map((e) => (e.ev as { text: string }).text).slice(0, 2)).toEqual(["一", "二\n"]);
    expect(db.listEvents(t.id).filter((e) => e.ev.t === "stop.record").length).toBe(1);
    expect(db.getTask(t.id)?.status).toBe("done");
  });

  test("a runner that exits under the lock ends after its held events, without throwing", async () => {
    const t = await started();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    const other = lock();
    fakes[0]!.emit({ t: "message.delta", role: "assistant", text: "遺言" } as never);
    fakes[0]!.exit(1);
    await sleep(5);
    other.exec("COMMIT");
    other.close();
    await sleep(1200);
    const evs = db.listEvents(t.id).map((e) => e.ev);
    const reply = evs.findIndex((ev) => ev.t === "message.delta" && ev.role === "assistant" && ev.text === "遺言");
    const end = evs.findIndex((ev) => ev.t === "session.end" && ev.summary === "runner exited (1)");
    expect(reply).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(reply);
    expect(db.getTask(t.id)?.status).toBe("error");
  });
});

test("a turn-end listener that throws does not take the end of the turn back", async () => {
  const t = await finishedTask();
  const seen: unknown[] = [];
  (tasks as unknown as { broadcast: (m: unknown) => void }).broadcast = (m) => seen.push(m);
  let after = 0;
  tasks.onTurnEnd(() => {
    throw new Error("broken");
  });
  tasks.onTurnEnd(() => after++);
  fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
  const error = console.error;
  console.error = () => undefined;
  fakes[0]!.emit({ t: "session.end", status: "ok", summary: "終わり" });
  console.error = error;
  const evs = db.listEvents(t.id).map((e) => e.ev);
  expect(db.getTask(t.id)?.status).toBe("done");
  expect(evs.some((ev) => ev.t === "session.end" && ev.summary === "終わり")).toBe(true);
  expect(evs.some((ev) => ev.t === "error" && ev.message.includes("broken"))).toBe(true);
  expect(after).toBe(1);
  expect(seen.some((m) => (m as { type: string; task?: Task }).type === "task.updated" && (m as { task: Task }).task.status === "done")).toBe(true);
});

test("an event that fails for any other reason shows in the transcript and the next one still comes in", async () => {
  const t = await finishedTask();
  const append = db.appendEvent.bind(db);
  db.appendEvent = ((id: string, ev: AgentEvent) => {
    if (ev.t === "tool.result") throw new Error("broken");
    return append(id, ev);
  }) as typeof db.appendEvent;
  const error = console.error;
  console.error = () => undefined;
  fakes[0]!.emit({ t: "tool.result", id: "x" } as never);
  fakes[0]!.emit({ t: "status", text: "次" });
  console.error = error;
  db.appendEvent = append;
  const evs = db.listEvents(t.id).map((e) => e.ev);
  expect(evs.some((ev) => ev.t === "error" && ev.message.includes("tool.result"))).toBe(true);
  expect(evs.some((ev) => ev.t === "status" && ev.text === "次")).toBe(true);
});

describe("background jobs of a task whose turn ended", () => {
  test("the task says what is running and since when, until the job ends", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "background", count: 1, jobs: ["local CI"] });
    expect(db.getTask(t.id)?.status).toBe("background");
    expect(db.getTask(t.id)?.background?.jobs).toEqual(["local CI"]);
    const since = db.getTask(t.id)!.background!.since;
    fakes[0]!.emit({ t: "background", count: 2, jobs: ["local CI", "review"] });
    expect(db.getTask(t.id)?.background).toEqual({ jobs: ["local CI", "review"], since });
    fakes[0]!.emit({ t: "background", count: 0, jobs: [] });
    expect(db.getTask(t.id)?.background).toBeNull();
    expect(db.getTask(t.id)?.status).toBe("done");
  });

  test("the turn's end decides the status: ok with a job left is background, error stays error with the mark kept, a reply runs it", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "background", count: 1, jobs: ["local CI"] });
    fakes[0]!.emit({ t: "session.end", status: "error", summary: "失敗" });
    expect(db.getTask(t.id)).toMatchObject({ status: "error", background: { jobs: ["local CI"] } });
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "session.end", status: "ok", summary: "待ちます" });
    expect(db.getTask(t.id)?.status).toBe("background");
    await tasks.send(t.id, "続けて");
    expect(db.getTask(t.id)?.status).toBe("running");
    fakes[0]!.emit({ t: "session.end", status: "ok", summary: "待ちます" });
    expect(db.getTask(t.id)?.status).toBe("background");
  });

  test("an abort while waiting on jobs aborts the task and tells the background-empty listeners once", async () => {
    const t = await finishedTask();
    const told: string[] = [];
    tasks.onBackgroundEmpty((id) => told.push(id));
    fakes[0]!.emit({ t: "background", count: 1, jobs: ["local CI"] });
    expect(db.getTask(t.id)?.status).toBe("background");
    await tasks.abort(t.id);
    await sleep(5);
    expect(db.getTask(t.id)).toMatchObject({ status: "aborted", background: null });
    expect(told).toEqual([t.id]);
  });

  test("a runner that exits while the task waits on jobs ends it as done and tells the listeners", async () => {
    const t = await finishedTask();
    const told: string[] = [];
    tasks.onBackgroundEmpty((id) => told.push(id));
    fakes[0]!.emit({ t: "background", count: 1, jobs: ["local CI"] });
    fakes[0]!.exit(137);
    await sleep(5);
    expect(db.getTask(t.id)).toMatchObject({ status: "done", background: null });
    expect(told).toEqual([t.id]);
  });

  test("a runner that exits mid turn with a job counted ends the turn done, not background", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
    fakes[0]!.emit({ t: "background", count: 1, jobs: ["local CI"] });
    expect(db.getTask(t.id)?.status).toBe("running");
    fakes[0]!.exit(0);
    await sleep(5);
    expect(db.getTask(t.id)).toMatchObject({ status: "done", background: null });
  });

  test("a runner that dies with a job says so and plans a resume", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "background", count: 1, jobs: ["local CI"] });
    fakes[0]!.exit(137);
    await sleep(5);
    expect(db.getTask(t.id)?.background).toBeNull();
    expect(db.getTask(t.id)?.resumeAt).not.toBeNull();
    expect(db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("local CI"))).toBe(true);
  });

  test("a daemon killed without its shutdown: the next start finds the done task, tells and plans a resume", async () => {
    const t = await finishedTask();
    fakes[0]!.emit({ t: "background", count: 1, jobs: ["local CI"] });
    const ids = abortOrphanedTasks(db);
    expect(ids).toContain(t.id);
    expect(db.getTask(t.id)?.background).toBeNull();
    expect(db.getTask(t.id)?.resumeAt).not.toBeNull();
    expect(db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("local CI"))).toBe(true);
  });
});

describe("skills by runner and review setting", () => {
  test("a Task's start renders the skills for its runner and the setting now, into its runner's place only", async () => {
    const meta = join(home, "meta");
    const repo = join(home, "repo");
    for (const d of [meta, repo]) {
      mkdirSync(d, { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: d });
    }
    mkdirSync(join(meta, "ops-kit/skills/demo"), { recursive: true });
    writeFileSync(join(meta, "ops-kit/skills/demo/SKILL.md"), ["# demo", "<!-- when review=other -->", "別のランナーに頼む", "<!-- end when -->", "<!-- when review=same -->", "同じランナーの新しいセッションに頼む", "<!-- end when -->", ""].join("\n"));
    db.upsertWorkspace({ name: "meta", path: meta, kind: "meta" });
    const wsId = db.upsertWorkspace({ name: "w", path: repo, kind: "repo" }).id;
    let review: "other" | "same" = "other";
    let env: Record<string, string> | undefined;
    const claude = fakeAdapter([]);
    const m = new TaskManager(db, new Map<RunnerId, RunnerAdapter>([["claude", { ...claude, start: (opts, emit) => ((env = opts.env), claude.start(opts, emit)) }], ["codex", { ...fakeAdapter([]), id: "codex" }]]), () => undefined, { idleMs: IDLE_MS, reviewRunner: () => review });
    const read = (target: string) => readFileSync(join(repo, target, "demo/SKILL.md"), "utf8");

    const first = m.create({ workspaceId: wsId, cwd: repo, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    expect(read(".claude/skills")).toContain("別のランナーに頼む");
    expect(read(".claude/skills")).not.toContain("同じランナー");
    expect(existsSync(join(repo, ".agents/skills"))).toBe(false);
    // the setting reaches a Task through the rendered text; the variable goes too, for a skill folder an earlier release left
    expect(env?.OPS_KIT_REVIEW_RUNNER).toBe("other");

    review = "same";
    m.create({ workspaceId: wsId, cwd: repo, title: "t", prompt: "p", runner: "codex" });
    await sleep(0);
    expect(read(".agents/skills")).toContain("同じランナーの新しいセッションに頼む");
    expect(read(".agents/skills")).not.toContain("別のランナー");
    expect(read(".claude/skills")).toContain("別のランナーに頼む"); // the Codex Task's start left the Claude copy alone

    await sleep(IDLE_MS * 3);
    await m.send(first.id, "続き");
    await sleep(0);
    expect(read(".claude/skills")).toContain("同じランナーの新しいセッションに頼む");
  });
});

describe("kitPath", () => {
  test("kitPath puts the kit's bin first and bun's folder last; without the meta workspace only PATH and bun's folder", () => {
    expect(kitPath("/m", "/a:/b")).toBe(["/m/ops-kit/bin", "/a:/b", dirname(process.execPath)].join(delimiter));
    expect(kitPath(null, "/a:/b")).toBe(["/a:/b", dirname(process.execPath)].join(delimiter));
  });
});

describe("task allow rules", () => {
  test("allow rules for stack pushes and backlog writes", () => {
    const rules = taskAllowRules("/meta", "/work");
    for (const r of ["Bash(gh stack submit:*)", "Bash(gh stack push:*)", "Bash(ops-kit pr push-rebased)", "Bash(ops-kit backlog:*)"]) expect(rules).toContain(r);
    // no bare push, no merge, no raw API: the merge stays with the gate and the rewrite push with its one command
    expect(rules.filter((r) => /git push|gh (pr|stack) merge|gh api/.test(r))).toEqual([]);
  });

  test("allow rules for promotion and guard release", () => {
    const rules = taskAllowRules("/meta", "/work");
    for (const r of ["Bash(bun scripts/promote.ts:*)", "Bash(bun /meta/scripts/promote.ts:*)", "Bash(bun scripts/parallel-guard.ts release:*)", "Bash(bun /meta/scripts/parallel-guard.ts release:*)"]) expect(rules).toContain(r);
    // no bare curl, and no claim / overlap / bare prefix of the guard
    expect(rules.filter((r) => /curl/.test(r))).toEqual([]);
    expect(rules.filter((r) => /parallel-guard\.ts(:\*| claim| overlap)/.test(r))).toEqual([]);
  });
});

describe("fable default budget", () => {
  let fableBudget: number | null;
  beforeEach(() => {
    fableBudget = 200;
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter(fakes)]]), () => undefined, { idleMs: IDLE_MS, defaultFableBudget: () => fableBudget });
  });
  const make = (extra: { model?: string; budgetUsd?: number } = {}) => {
    const wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
    return tasks.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude", ...extra });
  };
  const notes = (id: string) => db.listEvents(id).map((e) => e.ev).filter((ev) => ev.t === "status" && ev.text.includes("既定の予算"));

  test("fable default budget on create", async () => {
    expect(make({ model: "claude-fable-5-1" }).budgetUsd).toBe(200);
    expect(make({ model: "fable" }).budgetUsd).toBe(200);
    expect(make({ model: "claude-fable-5-2[1m]" }).budgetUsd).toBe(200);
    expect(make({ model: "claude-fable-5-1", budgetUsd: 5 }).budgetUsd).toBe(5);
    expect(make({ model: "claude-opus-5" }).budgetUsd).toBeNull();
    expect(make().budgetUsd).toBeNull();
    fableBudget = null; // the initial setting: no default
    expect(make({ model: "claude-fable-5-1" }).budgetUsd).toBeNull();
    await sleep(0);
  });

  test("fable default budget on model switch", async () => {
    const t = make({ model: "claude-opus-5" });
    await sleep(0);
    expect(t.budgetUsd).toBeNull();
    // the screen's switch
    expect((await tasks.setModel(t.id, "claude-fable-5-1")).budgetUsd).toBe(200);
    expect(db.getTask(t.id)!.budgetUsd).toBe(200);
    expect(notes(t.id)).toEqual([{ t: "status", text: "Fable のため既定の予算 $200 を付けました" }]);
    // the runner's report
    const r = make({ model: "claude-opus-5" });
    await sleep(0);
    fakes[1]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/", model: "global.anthropic.claude-fable-5-2" });
    expect(db.getTask(r.id)!.budgetUsd).toBe(200);
    expect(notes(r.id).length).toBe(1);
    // only the change to Fable adds it: a budget the user removed stays removed on the next turn's report
    tasks.setBudget(r.id, null);
    fakes[1]!.emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/", model: "global.anthropic.claude-fable-5-2" });
    expect(db.getTask(r.id)!.budgetUsd).toBeNull();
    expect(notes(r.id).length).toBe(1);
    // a budget already set is kept; no default sets nothing
    const k = make({ model: "claude-opus-5", budgetUsd: 5 });
    await sleep(0);
    expect((await tasks.setModel(k.id, "claude-fable-5-1")).budgetUsd).toBe(5);
    expect(notes(k.id)).toEqual([]);
    fableBudget = null;
    const n = make({ model: "claude-opus-5" });
    await sleep(0);
    expect((await tasks.setModel(n.id, "claude-fable-5-1")).budgetUsd).toBeNull();
  });

  test("isFableModel reads every Fable version, the context tag, the Bedrock form and the alias", () => {
    for (const m of ["claude-fable-5-1", "claude-fable-5-2", "claude-fable-5-1[1m]", "global.anthropic.claude-fable-5-2", "anthropic.claude-fable-5-1", "fable"]) expect(isFableModel(m)).toBe(true);
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "opus", "gpt-6", "", null, undefined]) expect(isFableModel(m)).toBe(false);
  });
});

describe("fork", () => {
  /** Every start is recorded; a start with `fork` opens a session of its own (`sess-fork`), the others `sess-parent`. */
  function forkAdapter(starts: StartOptions[], hasSession: (id: string) => boolean = () => true, parentSid: () => string = () => "sess-parent"): RunnerAdapter {
    return {
      id: "claude",
      forks: true,
      forkMinVersion: "2.1.314",
      hasSession,
      async detect() {
        return { available: true, version: "2.1.320" };
      },
      start(opts, emit) {
        starts.push(opts);
        queueMicrotask(() => {
          emit({ t: "session.start", runner: "claude", runnerSessionId: opts.fork ? "sess-fork" : parentSid(), cwd: "/" });
          emit({ t: "session.end", status: "ok", turn: `turn-${starts.length}` });
        });
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => undefined, close: async () => undefined, exited: Promise.resolve(0) };
      },
    };
  }
  const setup = async (hasSession?: (id: string) => boolean, parentSid?: () => string) => {
    const starts: StartOptions[] = [];
    const m = new TaskManager(db, new Map([["claude", forkAdapter(starts, hasSession, parentSid)]]), () => undefined, { idleMs: 0 });
    const parent = m.create({ cwd: home, title: "親", prompt: "p", runner: "claude" });
    await sleep(5);
    const seq = db.listEvents(parent.id).find((e) => e.ev.t === "session.end")!.seq;
    return { m, starts, parent, seq };
  };

  test("fork keeps the parent's session: the child's first reply forks it, the parent's next reply resumes the same session without fork", async () => {
    const { m, starts, parent, seq } = await setup();
    const child = m.forkTask(parent.id, seq);
    expect(starts).toHaveLength(1); // forking starts nothing
    expect(child).toMatchObject({ forkOf: parent.id, forkSeq: seq, forkTurn: "turn-1", status: "idle", runnerSessionId: null, cwd: parent.cwd });
    expect(db.listEvents(child.id).map((e) => e.ev)).toEqual([{ t: "status", text: "分岐元の Task の、分岐したターンまでの会話を引き継いでいます。ファイルは分岐元と同じ作業ツリーです" }]);

    await m.send(child.id, "child reply");
    await sleep(5);
    expect(starts[1]).toMatchObject({ resumeSessionId: "sess-parent", fork: { turn: "turn-1" } });
    expect(db.getTask(child.id)!.runnerSessionId).toBe("sess-fork");

    await m.send(parent.id, "parent reply");
    await sleep(5);
    expect(starts[2]!.resumeSessionId).toBe("sess-parent");
    expect(starts[2]!.fork).toBeUndefined();
    expect(db.getTask(parent.id)!.runnerSessionId).toBe("sess-parent");

    await m.send(child.id, "child again"); // the child has its own session now: a plain resume of it
    await sleep(5);
    expect(starts[3]!.resumeSessionId).toBe("sess-fork");
    expect(starts[3]!.fork).toBeUndefined();
  });

  test("a parent session that is not on this machine: no fork Task, and a child whose parent lost it fails to start instead of starting empty", async () => {
    let here = true;
    const { m, starts, parent, seq } = await setup((id) => here || id !== "sess-parent");
    const child = m.forkTask(parent.id, seq);
    here = false;
    expect(() => m.forkTask(parent.id, seq)).toThrow("セッション");
    await expect(m.send(child.id, "hi")).rejects.toThrow("分岐");
    expect(starts).toHaveLength(1);
    expect(db.getTask(child.id)!.status).toBe("error");
  });

  test("a fork resumes the session its turn ran in, not the session the parent has moved on to", async () => {
    let sid = "sess-parent";
    const { m, starts, parent, seq } = await setup(undefined, () => sid);
    sid = "sess-parent-2"; // the parent's next turn runs in another session (e.g. it came from another machine)
    await m.send(parent.id, "parent reply");
    await sleep(5);
    expect(db.getTask(parent.id)!.runnerSessionId).toBe("sess-parent-2");
    const child = m.forkTask(parent.id, seq);
    await m.send(child.id, "child reply");
    await sleep(5);
    expect(starts.at(-1)).toMatchObject({ resumeSessionId: "sess-parent", fork: { turn: "turn-1" } });
  });

  test("versionAtLeast: compares a.b.c numerically; an unknown version or minimum is not enough", () => {
    expect(versionAtLeast("2.1.314", "2.1.314")).toBe(true);
    expect(versionAtLeast("2.1.1000", "2.1.314")).toBe(true);
    expect(versionAtLeast("2.2.0", "2.1.314")).toBe(true);
    expect(versionAtLeast("2.1.99", "2.1.314")).toBe(false);
    expect(versionAtLeast("10.0.0", "9.9.9")).toBe(true);
    expect(versionAtLeast(undefined, "2.1.314")).toBe(false);
    expect(versionAtLeast("fake", "2.1.314")).toBe(false);
    expect(versionAtLeast("2.1.314", undefined)).toBe(false);
  });
});

describe("preamble", () => {
  /** Every start is recorded with what the adapter was given; each ends its turn at once, in the session `sess`. */
  function recording(id: "claude" | "codex", starts: StartOptions[], hasSession: (sid: string) => boolean = () => true): RunnerAdapter {
    return {
      id,
      hasSession,
      async detect() {
        return { available: true };
      },
      start(opts, emit) {
        starts.push(opts);
        queueMicrotask(() => {
          emit({ t: "session.start", runner: id, runnerSessionId: "sess", cwd: "/" });
          emit({ t: "message.delta", role: "assistant", text: "はい" });
          emit({ t: "session.end", status: "ok" });
        });
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => undefined, close: async () => undefined, exited: Promise.resolve(0) };
      },
    };
  }
  const HEAD = "[Switchboard: 止まったときの報告]";
  const ARTIFACT = "[Switchboard: 成果物の登録]";

  test("preamble goes into a session once: a process started again on the same session is told only the stops still open", async () => {
    const starts: StartOptions[] = [];
    const m = new TaskManager(db, new Map([["claude", recording("claude", starts)]]), () => undefined, { idleMs: 0 });
    const t = m.create({ cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(5);
    expect(starts[0]!.preamble).toContain(HEAD);
    expect(starts[0]!.preamble).toContain(ARTIFACT);
    // nothing open: the second process gets the reply alone
    await m.send(t.id, "続き");
    await sleep(5);
    expect(starts[1]).toMatchObject({ resumeSessionId: "sess", prompt: "続き" });
    expect(starts[1]!.preamble).toBeUndefined();
    // a stop of the Task's work still open: its line, and nothing of the report's instructions
    db.appendEvent(t.id, { t: "stop.record", stop: StopRecord.parse({ id: "ci", op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI が終わっていない", at: Date.now(), work: { workspaceId: null, issue: null, taskId: t.id } }) });
    await m.send(t.id, "もう一度");
    await sleep(5);
    expect(starts[2]!.preamble).toBe("この作業でまだ解けていない停止:\n- gh pr merge PR #12: depends（止まったのは 1 回、waiting）");
    m.shutdown();
  });

  test("preamble by conditions: a plain Task is told nothing of the Workspace MCP, a stage or plan mode; each is told where it holds", async () => {
    const starts: StartOptions[] = [];
    const adapter = { ...recording("claude", starts), permissionModes: [{ value: "plan", label: "計画のみ", description: "" }, { value: "default", label: "既定", description: "" }] };
    const plain = new TaskManager(db, new Map([["claude", adapter]]), () => undefined, { idleMs: 0 });
    plain.create({ cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(5);
    for (const w of ["Workspace MCP", "task.note", "exec.run", "占有の解放", "並列ガード", "計画モード"]) expect(starts[0]!.preamble).not.toContain(w);
    expect(starts[0]!.preamble).toContain("```switchboard-stop");
    plain.shutdown();

    const withAll = new TaskManager(db, new Map([["claude", adapter]]), () => undefined, { idleMs: 0, mcpServers: () => ({ workspace: { type: "http", url: "http://127.0.0.1:1/mcp" } }) });
    withAll.create({ cwd: home, title: "t", prompt: "p", runner: "claude", permissionMode: "plan", stage: { issue: 7, action: "complete" } });
    await sleep(5);
    const all = starts[1]!.preamble!;
    expect(all).toContain("Workspace MCP の task.note の引数 stop に書きます");
    expect(all).not.toContain("```switchboard-stop");
    expect(all).toContain("占有の解放の --after");
    expect(all).toContain("計画モードでの commit・push・マージ");
    withAll.shutdown();
  });

  test("preamble of a session whose record is not on this machine: the recap comes last and ends with the heading of the person's message", async () => {
    const starts: StartOptions[] = [];
    let here = true;
    const m = new TaskManager(db, new Map([["claude", recording("claude", starts, () => here)]]), () => undefined, { idleMs: 0 });
    const t = m.create({ cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(5);
    here = false;
    await m.send(t.id, "続けて");
    await sleep(5);
    const s = starts[1]!;
    expect(s.resumeSessionId).toBeUndefined();
    // a new session: the whole preamble again, then the recap, then the person's words
    expect(s.preamble!.startsWith(HEAD)).toBe(true);
    expect(s.preamble!.indexOf(ARTIFACT)).toBeLessThan(s.preamble!.indexOf("【Switchboard からの引き継ぎ】"));
    expect(s.preamble!.endsWith("利用者の今回のメッセージ:")).toBe(true);
    expect(s.prompt).toBe("続けて");
    m.shutdown();
  });

  test("preamble of the insights schedule's Task: /insights is the whole input, without the workspace's rules after it", async () => {
    const starts: StartOptions[] = [];
    const m = new TaskManager(db, new Map([["claude", recording("claude", starts)]]), () => undefined, { idleMs: 0 });
    const ws = db.upsertWorkspace({ name: "w", path: home, kind: "repo" });
    db.setWorkspaceRules(ws.id, "枝は main から切る");
    db.insertSchedule({ id: "sch_ins", title: "Insights", cron: "0 19 * * 0", workspaceId: ws.id, runner: "claude", model: "", effort: "", prompt: "", action: "insights", budgetUsd: null, enabled: true, lastRunAt: null, lastTaskId: null, nextRunAt: null, lastResult: null, stuck: null, createdAt: Date.now() });
    m.create({ workspaceId: ws.id, cwd: home, title: "Insights", prompt: "/insights", runner: "claude", scheduleId: "sch_ins" });
    m.create({ workspaceId: ws.id, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(5);
    expect(starts[0]).toMatchObject({ prompt: "/insights" });
    expect(starts[0]!.preamble).toBeUndefined();
    // any other Task of the workspace still gets them
    expect(starts[1]!.prompt).toContain("枝は main から切る");
    m.shutdown();
  });

  test("shadow of a Task the app wrote the prompt for gets the text written for its own runner; a person's prompt is copied as it is", async () => {
    const claude: StartOptions[] = [];
    const codex: StartOptions[] = [];
    const m = new TaskManager(db, new Map<RunnerId, RunnerAdapter>([["claude", recording("claude", claude)], ["codex", recording("codex", codex)]]), () => undefined, { idleMs: 0 });
    const ws = db.upsertWorkspace({ name: "w", path: home, kind: "repo" });
    db.setWorkspaceRules(ws.id, "枝は main から切る");
    const promptFor = (runner: string) => (runner === "claude" ? "/pbi-complete 9\n\nAgent ツールの model に `sonnet`" : ".agents/skills/pbi-complete/SKILL.md に従い、PBI #9 を完了させてください。");
    m.create({ workspaceId: ws.id, cwd: home, title: "t", prompt: promptFor("claude"), promptFor, runner: "claude", shadowRunner: "codex" });
    await sleep(5);
    expect(claude[0]!.prompt).toContain("/pbi-complete 9");
    expect(codex[0]!.prompt).toContain(".agents/skills/pbi-complete/SKILL.md に従い");
    for (const w of ["/pbi-complete 9", "Agent ツール"]) expect(codex[0]!.prompt).not.toContain(w);
    expect(codex[0]!.prompt).toContain("枝は main から切る"); // the workspace's rules follow it as they follow the primary's
    m.create({ cwd: home, title: "t", prompt: "/pbi-complete 9 を見て", runner: "claude", shadowRunner: "codex" });
    await sleep(5);
    expect(codex[1]!.prompt).toBe("/pbi-complete 9 を見て");
    m.shutdown();
  });
});
