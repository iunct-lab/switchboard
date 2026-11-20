// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerId, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { AttachmentStore } from "./attachments.ts";
import { TaskManager } from "./tasks/manager.ts";
import { NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("maxRunners: 既定 3、PATCH で 1〜8 だけ受ける（0 / 9 は 400）、sqlite に残る、/api/queue は空の queued を返す", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-max-runners-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0 });
    const b = `http://${"127.0.0.1"}:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const saved = async () => (await fetch(`${b}/api/settings`).then(j)).maxRunners;
    try {
      expect(await saved()).toBe(3);
      expect((await fetch(`${b}/api/queue`).then(j)).queued).toEqual([]);
      expect((await patch({ maxRunners: 2 }).then(j)).maxRunners).toBe(2);
      expect(await saved()).toBe(2);
      expect((c.db.getSetting("settings", {}) as { maxRunners?: number }).maxRunners).toBe(2);
      for (const bad of [0, 9, 1.5]) expect((await patch({ maxRunners: bad })).status).toBe(400);
      expect(await saved()).toBe(2);
      expect((await patch({ maxRunners: 8 })).status).toBe(200);
      expect(await saved()).toBe(8);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 20000);

  describe("maxRunners の待ち列", () => {
    const post = (b: string, path: string, body?: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const patchRunners = (b: string, n: number) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxRunners: n }) });
    const create = (b: string, cwd: string, title: string, runner = "claude") => post(b, "/api/tasks", { cwd, title, prompt: title, runner }).then(j);
    const statusOf = async (b: string, id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)).task.status as string;
    const queueOf = async (b: string) => (await fetch(`${b}/api/queue`).then(j)).queued as Array<{ taskId: string; position: number }>;
    const allow = async (b: string, id: string) => {
      const ask = (await fetch(`${b}/api/tasks/${id}`).then(j)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
      await post(b, `/api/tasks/${id}/permission`, { id: ask.id, decision: "allow" });
    };
    const boot = async (adapters: RunnerAdapter[], home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-"))) => {
      const c = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), adapters, { port: 0 });
      return { c, home, b: `http://127.0.0.1:${c.server.port}` };
    };

    test("maxRunners (a)(b) 上限 1: 2 件目は待ち列に入り、1 件目が終わると createdAt 順に 1 件ずつ始まる", async () => {
      const starts: StartOptions[] = [];
      const { c, home, b } = await boot([fakeAdapter(SCRIPT, { lingers: true, slowMs: 150, starts })]);
      try {
        await patchRunners(b, 1);
        const t1 = await create(b, home, "t1");
        const t2 = await create(b, home, "t2");
        const t3 = await create(b, home, "t3");
        expect(t1.status).toBe("running");
        expect(t2.status).toBe("idle");
        expect(typeof t2.queuedAt).toBe("number");
        expect(starts).toHaveLength(1);
        expect((await queueOf(b)).map((q) => [q.taskId, q.position])).toEqual([[t2.id, 1], [t3.id, 2]]);
        expect((await fetch(`${b}/api/tasks/${t2.id}`).then(j)).events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text.includes("実行枠が埋まっている"))).toBe(true);
        await waitFor(async () => (await statusOf(b, t1.id)) === "waiting");
        await allow(b, t1.id); // t1 done → the oldest waiting Task starts, the other stays
        await waitFor(async () => starts.length === 2);
        expect(starts[1]!.prompt).toBe("t2");
        expect((await queueOf(b)).map((q) => q.taskId)).toEqual([t3.id]);
        expect(c.db.getTask(t2.id)!.queuedAt).toBeNull();
        await waitFor(async () => (await statusOf(b, t2.id)) === "waiting");
        await allow(b, t2.id);
        await waitFor(async () => starts.length === 3);
        expect(starts.map((s) => s.prompt)).toEqual(["t1", "t2", "t3"]);
        expect(await queueOf(b)).toEqual([]);
      } finally {
        await c.stop();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners (c) 待ち列のまま再起動すると、前のデーモンが切った Task の枠が空き、待っていた Task が始まる", async () => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-"));
      const starts: StartOptions[] = [];
      const first = await boot([fakeAdapter(SCRIPT, { lingers: true, starts })], home);
      let second: Awaited<ReturnType<typeof boot>> | undefined;
      try {
        await patchRunners(first.b, 1);
        const t1 = await create(first.b, home, "t1");
        const t2 = await create(first.b, home, "t2");
        expect(t2.queuedAt).not.toBeNull();
        expect(first.c.db.sqlite.query("SELECT queued_prompt FROM tasks WHERE id = ?").get(t2.id)).toEqual({ queued_prompt: "t2" });
        await first.c.stop(); // shutdown closes the live processes only: the wait stays in the row
        starts.length = 0;
        second = await boot([fakeAdapter(SCRIPT, { lingers: true, starts })], home);
        await waitFor(async () => starts.length === 1);
        expect(starts[0]!.prompt).toBe("t2");
        expect(second.c.db.getTask(t1.id)!.status).toBe("aborted");
        expect(await statusOf(second.b, t2.id)).toMatch(/running|waiting/);
        expect(second.c.db.getTask(t2.id)!.queuedAt).toBeNull();
        expect(second.c.db.sqlite.query("SELECT queued_prompt FROM tasks WHERE id = ?").get(t2.id)).toEqual({ queued_prompt: null });
      } finally {
        await (second?.c ?? first.c).stop().catch(() => undefined);
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners (d) 待ち列の Task を中断すると列から外れ、枠が空いても始まらない", async () => {
      const starts: StartOptions[] = [];
      const { c, home, b } = await boot([fakeAdapter(SCRIPT, { lingers: true, starts })]);
      try {
        await patchRunners(b, 1);
        const t1 = await create(b, home, "t1");
        const t2 = await create(b, home, "t2");
        const aborted = await post(b, `/api/tasks/${t2.id}/abort`).then(j);
        expect(aborted.status).toBe("aborted");
        expect(await queueOf(b)).toEqual([]);
        await waitFor(async () => (await statusOf(b, t1.id)) === "waiting");
        await allow(b, t1.id);
        await waitFor(async () => (await statusOf(b, t1.id)) === "done");
        await Bun.sleep(100);
        expect(starts).toHaveLength(1);
        expect(await statusOf(b, t2.id)).toBe("aborted");
      } finally {
        await c.stop();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners (e) 返信: 枠が埋まっているとき、プロセスの無い Task への返信は断らず待ち列に入り、枠が空くと前のセッションで返信から始まる", async () => {
      const fast = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
      const starts: StartOptions[] = [];
      const { c, home, b } = await boot([fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(fast, { id: "codex", starts })]);
      try {
        const done = await create(b, home, "done", "codex");
        await waitFor(async () => (await statusOf(b, done.id)) === "done");
        await patchRunners(b, 1);
        const busy = await create(b, home, "busy");
        await waitFor(async () => (await statusOf(b, busy.id)) === "waiting");
        await c.tasks.releaseAndWait(done.id);
        c.db.updateTask(done.id, { outcome: "finished", reviewedAt: Date.now(), archivedAt: Date.now() }); // 確認済み and archived before the reply
        const reply = `again\n${"long ".repeat(40).trim()}`; // longer than a line, with a break: the log keeps it whole
        const r = await post(b, `/api/tasks/${done.id}/send`, { text: reply });
        expect(r.status).toBe(200);
        const queued = c.db.getTask(done.id)!;
        expect(queued.status).toBe("idle");
        expect(queued.queuedAt).not.toBeNull();
        // through the transition table: written as a coming turn (unknown, 確認済み off), and the Task shows again
        expect(queued).toMatchObject({ outcome: "unknown", reviewedAt: null, archivedAt: null });
        expect(c.db.listEvents(done.id).some((e) => e.ev.t === "status" && e.ev.text === `実行枠待ちに返信を入れました（実行枠が埋まっているため待機、実行中 1 / 上限 1、待ち 1 番目）: 「${reply}」`)).toBe(true);
        expect(starts).toHaveLength(1); // not started: the slot is full
        await patchRunners(b, 2); // a slot is free: the queue starts the reply
        await waitFor(async () => starts.length === 2);
        expect(starts[1]!.resumeSessionId).toBe("sess-1");
        expect(starts[1]!.prompt).toBe(reply);
        expect(c.db.getTask(done.id)!.queuedAt).toBeNull();
      } finally {
        await c.stop();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners 予算: 待ち列から始まる返信も予算の確認を通り、超えていれば待ち列に残して理由を 1 回だけ記録し、後ろの Task は始まり、予算を上げると始まる", async () => {
      const fast = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
      const starts: StartOptions[] = [];
      const { c, home, b } = await boot([fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(fast, { id: "codex", starts })]);
      try {
        const done = await create(b, home, "done", "codex");
        await waitFor(async () => (await statusOf(b, done.id)) === "done");
        await patchRunners(b, 1);
        const busy = await create(b, home, "busy");
        await waitFor(async () => (await statusOf(b, busy.id)) === "waiting");
        await c.tasks.releaseAndWait(done.id);
        expect((await post(b, `/api/tasks/${done.id}/send`, { text: "again" })).status).toBe(200);
        const behind = await create(b, home, "behind", "codex");
        expect(c.db.listQueuedTasks().map((t) => t.id)).toEqual([done.id, behind.id]);
        c.db.updateTask(done.id, { budgetUsd: 1e-9 }); // below what the first turn cost
        expect(c.tasks.isOverBudget(done.id)).toBe(true);
        expect(starts).toHaveLength(1);
        await patchRunners(b, 2); // a slot is free: the reply is refused, the Task behind it starts
        await waitFor(async () => starts.length === 2);
        expect(starts[1]!.prompt).toBe("behind");
        c.tasks.drain();
        c.tasks.drain();
        expect(starts).toHaveLength(2);
        expect(c.db.getTask(done.id)!.queuedAt).not.toBeNull();
        const refused = () => c.db.listEvents(done.id).filter((e) => e.ev.t === "status" && e.ev.text.startsWith("実行枠が空きましたが、この返信はまだ始めません（budget exceeded"));
        expect(refused()).toHaveLength(1);
        // aborted while every slot is taken, queued again under a raised budget, refused again once the budget is
        // lowered: the new reply's refusal is written again
        await patchRunners(b, 1);
        expect((await post(b, `/api/tasks/${done.id}/abort`, {})).status).toBe(200);
        expect(c.db.getTask(done.id)!.queuedAt).toBeNull();
        c.db.updateTask(done.id, { budgetUsd: 1000 });
        expect((await post(b, `/api/tasks/${done.id}/send`, { text: "again" })).status).toBe(200);
        expect(c.db.getTask(done.id)!.queuedAt).not.toBeNull();
        c.db.updateTask(done.id, { budgetUsd: 1e-9 });
        await patchRunners(b, 2);
        await waitFor(async () => (c.tasks.drain(), refused().length === 2));
        expect(starts).toHaveLength(2);
        c.db.updateTask(done.id, { budgetUsd: 1000 }); // raised: the next drain starts it, with --resume
        await waitFor(async () => (c.tasks.drain(), starts.length === 3));
        expect(starts[2]!.resumeSessionId).toBe("sess-1");
        expect(starts[2]!.prompt).toBe("again");
        expect(c.db.getTask(done.id)!.queuedAt).toBeNull();
      } finally {
        await c.stop();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners 返信: 待ち列の Task への返信は待ちの prompt の後ろに足され、添付は返信ぶんだけが渡り、中断すれば待ちごと消える", async () => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-reply-"));
      const starts: StartOptions[] = [];
      const db = new Db(join(home, "t.sqlite"));
      const store = new AttachmentStore(db, join(home, "attachments"));
      const hold = new Promise<never>(() => undefined);
      const adapters = new Map<RunnerId, RunnerAdapter>([
        ["claude", fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { lingers: true, starts })],
        ["codex", fakeAdapter(SCRIPT, { id: "codex", lingers: true, gate: hold })], // its turn stays in flight: it holds a slot
      ]);
      const tm = new TaskManager(db, adapters, () => undefined, { maxRunners: () => 2, attachments: store });
      const upload = (name: string) => store.save({ name, bytes: new TextEncoder().encode(name) }).id;
      try {
        const input = (title: string, runner: RunnerId, attachmentIds?: string[]) => ({ cwd: home, title, prompt: title, runner, attachmentIds });
        const t1 = tm.create(input("t1", "claude", [upload("first.txt")]));
        await waitFor(async () => !["running", "waiting"].includes(db.getTask(t1.id)!.status));
        await tm.releaseAndWait(t1.id);
        const busy1 = tm.create(input("busy1", "codex"));
        tm.create(input("busy2", "codex")); // two run: the limit
        await tm.send(t1.id, "reply one", { attachmentIds: [upload("second.txt")] });
        await tm.send(t1.id, "reply two");
        expect(db.listQueuedTasks().map((t) => t.id)).toEqual([t1.id]); // one place in the queue, not two
        expect(starts).toHaveLength(1);
        // a slot opens: one start with both replies; first.txt went with the first turn and is not sent again
        const second = store.listForTask(t1.id).find((a) => a.name === "second.txt")!;
        await tm.abort(busy1.id);
        await waitFor(async () => starts.length === 2);
        expect(starts[1]!.resumeSessionId).toBe("sess-1");
        expect(starts[1]!.prompt).toBe(`reply one\n\n添付ファイル（このマシン上のパス。必要なら読んでください）:\n- ${second.path} (${second.mime}, ${second.size} B)\n\nreply two`);
        expect(starts[1]!.attachments?.map((a) => a.name)).toEqual(["second.txt"]);
        // 中断 of a Task waiting with a reply takes the reply out of the queue
        await waitFor(async () => !["running", "waiting"].includes(db.getTask(t1.id)!.status));
        await tm.releaseAndWait(t1.id);
        tm.create(input("busy3", "codex")); // the limit again
        await tm.send(t1.id, "never sent");
        expect(db.getTask(t1.id)!.queuedAt).not.toBeNull();
        await tm.abort(t1.id);
        expect(db.getTask(t1.id)!.queuedAt).toBeNull();
        expect(db.listQueuedTasks()).toEqual([]);
        tm.drain();
        expect(starts).toHaveLength(2);
      } finally {
        await tm.shutdown();
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners (f) 上限を上げると待っていた Task がすぐ始まる", async () => {
      const starts: StartOptions[] = [];
      const { c, home, b } = await boot([fakeAdapter(SCRIPT, { lingers: true, starts })]);
      try {
        await patchRunners(b, 1);
        await create(b, home, "t1");
        const t2 = await create(b, home, "t2");
        expect(starts).toHaveLength(1);
        await patchRunners(b, 2);
        await waitFor(async () => starts.length === 2);
        expect(starts[1]!.prompt).toBe("t2");
        expect(await queueOf(b)).toEqual([]);
        expect(c.db.getTask(t2.id)!.queuedAt).toBeNull();
      } finally {
        await c.stop();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners 空きメモリ: free < safety なら待ち列に入り（安全弁が文に出る）、safety ≤ free < floor は警告だけで始まる。何も動いていなければ待たせない", async () => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-mem-"));
      const starts: StartOptions[] = [];
      const MB = 1048576;
      let headroom: { free: number; floor: number; safety: number } | null = { free: 100 * MB, floor: 500 * MB, safety: 200 * MB };
      const db = new Db(join(home, "t.sqlite"));
      const tm = new TaskManager(db, new Map([["claude", fakeAdapter(SCRIPT, { lingers: true, starts })]]), () => undefined, { maxRunners: () => 8, memoryHeadroom: () => headroom });
      const warnings = (id: string) => db.listEvents(id).filter((e) => e.ev.t === "status" && e.ev.text.includes("空きメモリが少ない")).length;
      try {
        const input = (title: string) => ({ cwd: home, title, prompt: title, runner: "claude" as const });
        const t1 = tm.create(input("t1"));
        expect(t1.status).toBe("running"); // nothing ran: not held for memory (no event would call drain again)
        expect(warnings(t1.id)).toBe(0);
        // (a) below the safety valve: queued, the reason names the valve
        const t2 = tm.create(input("t2"));
        expect(t2.status).toBe("idle");
        expect(t2.queuedAt).not.toBeNull();
        expect(db.listEvents(t2.id).some((e) => e.ev.t === "status" && e.ev.text.includes("空きメモリ不足のため待機（空き 100 MB / 安全弁 200 MB"))).toBe(true);
        expect(tm.freeSlots()).toBe(0);
        // (b) between the valve and the floor: starts at once with one warning line
        headroom = { free: 300 * MB, floor: 500 * MB, safety: 200 * MB };
        tm.drain(); // the queued t2 starts now (a free slot and above the valve)
        expect(starts.map((s) => s.prompt)).toEqual(["t1", "t2"]);
        expect(warnings(t2.id)).toBe(1); // a start from the queue warns the same way
        const t3 = tm.create(input("t3"));
        expect(t3.queuedAt).toBeNull();
        expect(starts.map((s) => s.prompt)).toEqual(["t1", "t2", "t3"]);
        expect(warnings(t3.id)).toBe(1);
        expect(db.listEvents(t3.id).some((e) => e.ev.t === "status" && e.ev.text === "空きメモリが少ない（空き 300 MB / 下限 500 MB）が、安全弁（200 MB）以上なので続けます")).toBe(true);
        // (c) a reply that needs a new process goes ahead with the same line
        await tm.abort(t3.id);
        await tm.send(t3.id, "reply");
        expect(starts.map((s) => s.prompt)).toEqual(["t1", "t2", "t3", "reply"]);
        expect(warnings(t3.id)).toBe(2);
        // (d) below the valve the reply waits in the queue, the line naming the value
        await tm.abort(t3.id);
        headroom = { free: 100 * MB, floor: 500 * MB, safety: 200 * MB };
        await tm.send(t3.id, "again");
        expect(db.getTask(t3.id)!.queuedAt).not.toBeNull();
        expect(db.listEvents(t3.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("実行枠待ちに返信を入れました（空きメモリ不足のため待機、空き 100 MB / 安全弁 200 MB、待ち 1 番目）"))).toBe(true);
        expect(starts.map((s) => s.prompt)).toEqual(["t1", "t2", "t3", "reply"]);
        // (e) unreadable: the count alone
        headroom = null;
        expect(tm.freeSlots()).toBe(6);
      } finally {
        await tm.shutdown();
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);
    test("maxRunners 待ち列の再確認: メモリ不足で待つ Task は空きが戻れば drain() を呼ばずに始まり、待ち列が空ならメモリを読まない", async () => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-tick-"));
      const starts: StartOptions[] = [];
      const MB = 1048576;
      let free = 100 * MB;
      let reads = 0;
      const db = new Db(join(home, "t.sqlite"));
      const hold = new Promise<never>(() => undefined); // keeps t1's turn in flight: something runs, so the memory is read
      const tm = new TaskManager(db, new Map([["claude", fakeAdapter(SCRIPT, { lingers: true, starts, gate: hold })]]), () => undefined, {
        maxRunners: () => 8,
        memoryHeadroom: () => (reads++, { free, floor: 500 * MB, safety: 200 * MB }),
        drainTickMs: 20,
      });
      try {
        const input = (title: string) => ({ cwd: home, title, prompt: title, runner: "claude" as const });
        tm.create(input("t1"));
        const t2 = tm.create(input("t2"));
        expect(t2.queuedAt).not.toBeNull();
        await new Promise((r) => setTimeout(r, 80)); // several ticks: still short of memory, still waiting
        expect(db.getTask(t2.id)!.queuedAt).not.toBeNull();
        free = 400 * MB;
        await waitFor(async () => db.getTask(t2.id)!.queuedAt === null); // no drain() call from here
        expect(starts.map((s) => s.prompt)).toEqual(["t1", "t2"]);
        // the queue is empty now: the ticks read nothing
        const before = reads;
        await new Promise((r) => setTimeout(r, 100));
        expect(reads).toBe(before);
      } finally {
        await tm.shutdown();
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);

    test("maxRunners 待ち列の空きメモリ: ターンの終わった Task のプロセスが残るときは先に閉じ、続けて待ち列の Task が始まる", async () => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-idle-"));
      const starts: StartOptions[] = [];
      const MB = 1048576;
      const db = new Db(join(home, "t.sqlite"));
      const hold = new Promise<never>(() => undefined);
      const adapters = new Map<RunnerId, RunnerAdapter>([
        ["claude", fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { lingers: true, starts })],
        ["codex", fakeAdapter(SCRIPT, { id: "codex", lingers: true, starts, gate: hold })], // its turn stays in flight
      ]);
      let idleId = "";
      // the memory is back once the idle Task's process is gone
      const tm = new TaskManager(db, adapters, () => undefined, {
        maxRunners: () => 8,
        memoryHeadroom: () => ({ free: idleId && tm.holdsProcess(idleId) ? 100 * MB : 400 * MB, floor: 500 * MB, safety: 200 * MB }),
        drainTickMs: 3_600_000, // no tick: only the release can start the queue
      });
      try {
        const input = (title: string, runner: RunnerId) => ({ cwd: home, title, prompt: title, runner });
        const t1 = tm.create(input("t1", "claude"));
        idleId = t1.id;
        await waitFor(async () => !["running", "waiting"].includes(db.getTask(t1.id)!.status)); // the turn ended; the process stays open
        expect(tm.holdsProcess(t1.id)).toBe(true);
        tm.create(input("running", "codex"));
        const t3 = tm.create(input("t3", "claude"));
        expect(t3.queuedAt).not.toBeNull(); // short of memory: queued, and the idle process is closed at once
        await waitFor(async () => db.getTask(t3.id)!.queuedAt === null);
        expect(tm.holdsProcess(t1.id)).toBe(false);
        expect(starts.map((s) => s.prompt)).toEqual(["t1", "running", "t3"]);
      } finally {
        await tm.shutdown();
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);
    test("maxRunners 返信の空きメモリ: ターンの終わった Task のプロセスが残るときは先に閉じ、待ち列に入った返信が前のセッションで始まる", async () => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-reply-idle-"));
      const starts: StartOptions[] = [];
      const MB = 1048576;
      const db = new Db(join(home, "t.sqlite"));
      const hold = new Promise<never>(() => undefined);
      const adapters = new Map<RunnerId, RunnerAdapter>([
        ["claude", fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { lingers: true, starts })],
        ["codex", fakeAdapter(SCRIPT, { id: "codex", lingers: true, starts, gate: hold })], // its turn stays in flight
      ]);
      let idleId = "";
      // the memory is back once the idle Task's process is gone
      const tm = new TaskManager(db, adapters, () => undefined, {
        maxRunners: () => 8,
        memoryHeadroom: () => ({ free: idleId && tm.holdsProcess(idleId) ? 100 * MB : 400 * MB, floor: 500 * MB, safety: 200 * MB }),
        drainTickMs: 3_600_000, // no tick: only the release can start the queue
      });
      try {
        const input = (title: string, runner: RunnerId) => ({ cwd: home, title, prompt: title, runner });
        const ended = (id: string) => !["running", "waiting"].includes(db.getTask(id)!.status);
        const t0 = tm.create(input("t0", "claude"));
        await waitFor(async () => ended(t0.id));
        await tm.releaseAndWait(t0.id); // its process is closed: a reply needs a new one
        const t1 = tm.create(input("t1", "claude"));
        idleId = t1.id;
        await waitFor(async () => ended(t1.id)); // the turn ended; the process stays open
        expect(tm.holdsProcess(t1.id)).toBe(true);
        tm.create(input("running", "codex"));
        const r = await tm.send(t0.id, "again");
        expect(r.queuedAt).not.toBeNull(); // short of memory: queued, and the idle process is closed at once
        await waitFor(async () => db.getTask(t0.id)!.queuedAt === null);
        expect(tm.holdsProcess(t1.id)).toBe(false);
        expect(starts.map((s) => s.prompt)).toEqual(["t0", "t1", "running", "again"]);
        expect(starts[3]!.resumeSessionId).toBe("sess-1");
      } finally {
        await tm.shutdown();
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);
    test("maxRunners holdQueue（候補のデーモン）: 枠が空いても待ち列を始めず、待ち列の Task への返信は待ちに足されて始めない", async () => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-hold-"));
      const starts: StartOptions[] = [];
      const db = new Db(join(home, "t.sqlite"));
      const tm = new TaskManager(db, new Map([["claude", fakeAdapter(SCRIPT, { lingers: true, starts })]]), () => undefined, { maxRunners: () => 1, holdQueue: true });
      try {
        const input = (title: string) => ({ cwd: home, title, prompt: title, runner: "claude" as const });
        const t1 = tm.create(input("t1"));
        const t2 = tm.create(input("t2"));
        expect(t2.queuedAt).not.toBeNull();
        await tm.send(t2.id, "reply"); // goes after the queued prompt
        expect(db.getTask(t2.id)!.queuedAt).not.toBeNull(); // the reply did not start it nor take it out of the queue
        await tm.abort(t1.id); // a slot is free, but a candidate leaves the live daemon's queue alone
        tm.drain();
        expect(starts.map((s) => s.prompt)).toEqual(["t1"]);
        expect(db.listQueuedTasks().map((t) => t.id)).toEqual([t2.id]);
      } finally {
        await tm.shutdown();
        db.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);
  });
});
