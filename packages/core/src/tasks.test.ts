// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, Task } from "@switchboard/protocol";
import { abortOrphanedTasks, Db } from "./db.ts";
import { STOP_NOTE } from "./evals.ts";
import { kitPath, taskAllowRules, TaskManager, type TurnEnd } from "./tasks.ts";

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

describe("OPS_KIT_REVIEW_RUNNER", () => {
  /** The env the runner was started with, under a TaskManager given `reviewRunner` (or none). */
  async function startedEnv(reviewRunner?: () => "other" | "same"): Promise<Record<string, string> | undefined> {
    let seen: Record<string, string> | undefined;
    const inner = fakeAdapter([]);
    const adapter: RunnerAdapter = { ...inner, start: (opts, emit) => ((seen = opts.env), inner.start(opts, emit)) };
    const m = new TaskManager(db, new Map([["claude", adapter]]), () => undefined, { idleMs: IDLE_MS, ...(reviewRunner ? { reviewRunner } : {}) });
    const wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
    m.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
    await sleep(0);
    return seen;
  }

  test("OPS_KIT_REVIEW_RUNNER carries the setting's value at the start", async () => {
    expect((await startedEnv(() => "same"))?.OPS_KIT_REVIEW_RUNNER).toBe("same");
  });

  test("OPS_KIT_REVIEW_RUNNER is other without the setting", async () => {
    expect((await startedEnv())?.OPS_KIT_REVIEW_RUNNER).toBe("other");
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
