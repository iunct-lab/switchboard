// test-reads: none
// A reply held for a Task's background jobs, answered through the real answer route (`submitAnswer` → `answerAsk` →
// `answerTask`) and handed over by the real TaskManager: only the runner is a fake.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Ask, RunnerAdapter, RunnerSession } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { TaskManager } from "./tasks/manager.ts";
import { stopAskId } from "./asks.ts";
import { reduceStops } from "./stops.ts";
import { answerAsk, answerTask, nowOf, submitAnswer, failed } from "./server/asks.ts";
import { grantRecorder } from "./server/task-hooks.ts";

type Fake = { emit: (ev: AgentEvent) => void; sent: string[]; closeGate: Promise<void> | null };
let fakes: Fake[];
const adapter: RunnerAdapter = {
  id: "claude",
  async detect() {
    return { available: true };
  },
  start(_opts, emit) {
    let done!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (done = r));
    const fake: Fake = { emit, sent: [], closeGate: null };
    fakes.push(fake);
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" });
      emit({ t: "session.end", status: "ok", summary: "待ちます" });
    });
    const session: RunnerSession = {
      send: (text) => void fake.sent.push(text),
      respondPermission: () => undefined,
      abort: async () => done(null),
      close: async () => {
        await fake.closeGate;
        done(0);
      },
      exited,
    };
    return session;
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [GA, GB] = ["PR #12 を判定の外でマージしてよい", "PR #13 を判定の外でマージしてよい"];

let home: string;
let db: Db;
let hold: { wait: string; detail: string } | null;
let tasks: TaskManager;
let wsId: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-held-reply-"));
  db = new Db(join(home, "db.sqlite"));
  fakes = [];
  hold = null;
  tasks = new TaskManager(db, new Map([["claude", adapter]]), () => undefined, { idleMs: 10_000, admissionHold: () => hold, drainTickMs: 3_600_000 });
  wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
});
afterEach(async () => {
  await tasks.shutdown();
  rmSync(home, { recursive: true, force: true });
});

const stopRecord = (taskId: string, id: string, op: string, grant: string) =>
  db.appendEvent(taskId, { t: "stop.record", stop: { id, work: { workspaceId: wsId, issue: 306, taskId }, op, target: "PR", reason: "permission", evidence: "refused", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", grant, at: Date.now() } });
const stopOf = (taskId: string, op = "gh pr merge") => reduceStops(db.listStopRecords([taskId])).find((s) => s.op === op)!;
const lines = (taskId: string) => db.listEvents(taskId).map((e) => e.ev).flatMap((ev) => (ev.t === "status" ? [ev.text] : []));
const grantRows = () => (db.sqlite.query("SELECT count(*) AS n FROM task_grants").get() as { n: number }).n;

/** A Task left on background jobs with a permission stop, under the hold. */
async function heldTask() {
  const t = tasks.create({ workspaceId: wsId, cwd: home, title: "t", prompt: "p", runner: "claude" });
  await sleep(0);
  fakes[0]!.emit({ t: "background", count: 1 });
  stopRecord(t.id, "s1", "gh pr merge", GA);
  hold = { wait: "昇格待ち", detail: "デーモンを入れ替えます" };
  return t;
}

/** The real answer route (`submitAnswer` → `answerAsk` → `answerTask`) for the Task's stop question. */
function answerRoute(taskId: string) {
  const ask = { id: stopAskId(stopOf(taskId)), kind: "stop", state: "open", needs: "person", grant: GA, answers: ["grant", "text"], choices: [], blockers: [], questions: [], task: { id: taskId, title: "t", stageIssue: null }, issue: null, subject: null, resume: null } as unknown as Ask;
  const sc: any = {
    db,
    tasks,
    answering: new Map(),
    currentAsks: async () => ({ asks: [ask], batches: [] }),
    policyGone: () => null,
    basisLine: () => "",
    taskGrantHeads: async () => ({}),
    grantRecorder: (id: string, text: string, from: any) => grantRecorder({ db, originRepoOf: () => "o/r" } as any, id, text, from),
  };
  sc.failed = (id: string) => failed(sc, id);
  sc.nowOf = (r: any) => nowOf(sc, r);
  sc.answerTask = (...a: [string, Ask, any, any, any]) => answerTask(sc, ...a);
  sc.answerAsk = (...a: [string, any, any, any, any, any]) => answerAsk(sc, ...a);
  const press = () => submitAnswer(sc, ask.id, { kind: "grant", grant: GA }, undefined, null, null, false, "screen");
  return { ask, press };
}

describe("held reply through the answer route", () => {
  test("the line of a screen answer that is not handed over names the reason", async () => {
    const t = await heldTask();
    await answerRoute(t.id).press();
    stopRecord(t.id, "s1", "gh pr merge", GB);
    hold = null;
    tasks.resumeAdmission();
    await sleep(5);
    const line = lines(t.id).find((l) => l.includes("保留した返信は渡しません"))!;
    expect(line).not.toContain("（）");
  });

  test("a screen answer dropped on 中断 can be pressed again (it is not answered 'already')", async () => {
    const t = await heldTask();
    const { press } = answerRoute(t.id);
    await press();
    await tasks.abort(t.id);
    await sleep(5);
    hold = null;
    expect(stopOf(t.id)).toMatchObject({ next: "decide" });
    expect(grantRows()).toBe(0);
    const again = await press();
    expect(again.body).toMatchObject({ already: false });
  });

  test("a held conversation reply does not mark a stop that came after it was typed", async () => {
    const t = await heldTask();
    await tasks.send(t.id, "進めて");
    await sleep(2);
    stopRecord(t.id, "s2", "git push", GB);
    fakes[0]!.emit({ t: "background", count: 0 });
    await sleep(5);
    expect(stopOf(t.id, "git push").answered).toBeFalsy();
  });

  test("a held conversation reply does not mark a stop reported again under the same id with another grant", async () => {
    const t = await heldTask();
    await tasks.send(t.id, "進めて");
    await sleep(2);
    stopRecord(t.id, "s1", "gh pr merge", GB);
    fakes[0]!.emit({ t: "background", count: 0 });
    await sleep(5);
    expect(stopOf(t.id)).toMatchObject({ next: "decide" });
    expect(stopOf(t.id).answered).toBeFalsy();
  });

  test("a grant whose stop moves while the process closes at hand-over is not handed over or recorded", async () => {
    const t = await heldTask();
    await answerRoute(t.id).press();
    let open!: () => void;
    fakes[0]!.closeGate = new Promise<void>((r) => (open = r));
    // the jobs end under the standing hold: flush → dispatch closes the process, then queues the reply
    fakes[0]!.emit({ t: "background", count: 0 });
    await sleep(2);
    stopRecord(t.id, "s1", "gh pr merge", GB);
    open();
    await sleep(5);
    expect(db.getTask(t.id)!.queuedAt).toBeNull();
    expect(grantRows()).toBe(0);
  });

  test("of two held answers to one stop, the second is not handed over", async () => {
    const t = await heldTask();
    await tasks.send(t.id, "マージはまだしないで");
    await answerRoute(t.id).press();
    hold = null;
    tasks.resumeAdmission();
    await sleep(5);
    expect(fakes[0]!.sent).toEqual(["マージはまだしないで"]);
    expect(grantRows()).toBe(0);
  });
});
