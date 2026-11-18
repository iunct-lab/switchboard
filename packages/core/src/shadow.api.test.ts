// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";
import { TaskSummary } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("shadow run: the same prompt on a second runner, as a task linked by shadowOf", () => {
  const post = (b: string, path: string, body?: unknown, method = "POST") => fetch(`${b}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const turn = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result" && e.t !== "quota");
  const dakTurn: AgentEvent[] = [{ t: "session.start", runner: "dak", runnerSessionId: "dak-1", cwd: "/tmp" }, { t: "message.delta", role: "assistant", text: "done (dak)" }, { t: "session.end", status: "ok", summary: "done" }];

  test("creation copies cwd / scope / title / prompt, follow-ups to the primary are mirrored, the shadow's own turns are not; the saved default and its escape hatch", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-shadow-"));
    const starts: StartOptions[] = [];
    const sends: string[] = [];
    const dakStarts: StartOptions[] = [];
    const dakSends: string[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn, { lingers: true, starts, sends, modes: ["auto", "plan"], defaultMode: "auto", efforts: ["high"] }), { ...fakeAdapter(dakTurn, { id: "dak", lingers: true, starts: dakStarts, sends: dakSends }), permissionModes: [] }], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(b, "/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak", budgetUsd: 1, effort: "high" }).then(j);
      expect(t).toMatchObject({ runner: "claude", shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, budgetUsd: 1, permissionMode: "auto", effort: "high" });
      const all = (await fetch(`${b}/api/tasks`).then(j)) as TaskSummary[];
      expect(all.length).toBe(2);
      const s = (await fetch(`${b}/api/tasks/${all.find((x) => x.shadowOf === t.id)!.id}`).then(j)).task as Task;
      // a normal task on the other runner, carrying the primary's request and budget but none of its bookkeeping
      expect(s).toMatchObject({ runner: "dak", title: "t", cwd: h, scope: [h], workspaceId: t.workspaceId, routing: null, budgetUsd: 1, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", shadowStopped: false });
      // the primary's transcript says the shadow started and with which mode (modes are runner-native, not inherited)
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("並走（dak）を開始") && e.ev.text.includes("主の auto は引き継がれない"))).toBe(true);
      expect(starts[0]).toMatchObject({ prompt: "p", cwd: h, permissionMode: "auto" });
      expect(dakStarts[0]).toMatchObject({ prompt: "p", cwd: h, scope: [h] });
      expect(dakStarts[0]!.effort).toBeUndefined(); // the primary's effort is claude's; the shadow keeps its CLI default
      expect(c.db.routingLog().map((r) => r.taskId)).not.toContain(s.id);
      expect(c.db.shadowTaskOf(t.id)?.id).toBe(s.id);
      // the router's "previous runner for this repo" is the primary's, not the shadow's (the shadow was created last)
      expect(c.db.lastRunnerFor(undefined, h)).toBe("claude");
      expect(await post(b, "/api/tasks/suggest", { cwd: h, title: "", prompt: "" }).then(j)).toMatchObject({ runner: "claude", ruleId: "previous" });
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      // a follow-up to the primary reaches both live processes with the same text
      expect((await post(b, `/api/tasks/${t.id}/send`, { text: "again" })).status).toBe(200);
      await waitFor(async () => dakSends.includes("again"));
      expect(sends).toEqual(["again"]);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "message.delta" && e.ev.role === "user" && e.ev.text === "again")).toBe(true);
      // a turn sent to the shadow stays there
      expect((await post(b, `/api/tasks/${s.id}/send`, { text: "only here" })).status).toBe(200);
      await waitFor(async () => dakSends.includes("only here"));
      expect(sends).toEqual(["again"]);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      // stopping the shadow (even one whose turn is over, which stays "done") means: no more copies — and both sides say so
      const stopped = await post(b, `/api/tasks/${s.id}/abort`).then(j);
      expect(stopped).toMatchObject({ status: "done", shadowStopped: true });
      await waitFor(async () => !c.tasks.isLive(s.id));
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("並走を停止"))).toBe(true);
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("並走（dak）を停止"))).toBe(true);
      await post(b, `/api/tasks/${t.id}/send`, { text: "after stop" });
      await waitFor(async () => sends.includes("after stop"));
      await new Promise((r) => setTimeout(r, 30));
      expect(dakSends).toEqual(["again", "only here"]);
      expect((await fetch(`${b}/api/tasks`).then(j)).length).toBe(2);
      // validation: the shadow must be another, detected runner
      expect((await post(b, "/api/tasks", { cwd: h, title: "x", prompt: "p", runner: "claude", shadowRunner: "claude" })).status).toBe(400);
      expect((await post(b, "/api/tasks", { cwd: h, title: "x", prompt: "p", runner: "claude", shadowRunner: "codex" })).status).toBe(400);
      expect((await fetch(`${b}/api/tasks`).then(j)).length).toBe(2);
      // the saved default: refused for an undetected runner, otherwise applied to creations that do not say
      expect((await post(b, "/api/settings", { shadowRunner: "codex" }, "PATCH")).status).toBe(400);
      expect((await post(b, "/api/settings", { shadowRunner: "dak" }, "PATCH").then(j)).shadowRunner).toBe("dak");
      expect((await fetch(`${b}/api/settings`).then(j)).shadowRunner).toBe("dak");
      const t2 = await post(b, "/api/tasks", { cwd: h, title: "t2", prompt: "q", runner: "claude" }).then(j);
      expect(c.db.shadowTaskOf(t2.id)).toMatchObject({ runner: "dak", title: "t2" });
      expect(dakStarts.at(-1)?.prompt).toBe("q");
      const s2 = c.db.shadowTaskOf(t2.id)!;
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t2.id}`).then(j)).task.status === "done");
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s2.id}`).then(j)).task.status === "done");
      // mirror: false (the resumer's 今すぐ再開) reaches the primary only
      const dakSendsBefore = dakSends.length;
      await c.tasks.send(t2.id, "resume now", { mirror: false });
      await waitFor(async () => sends.includes("resume now"));
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t2.id}`).then(j)).task.status === "done");
      expect(dakSends.length).toBe(dakSendsBefore);
      // stopping the primary cancels a resume the shadow had planned, and nothing else about it
      c.db.updateTask(s2.id, { resumeAt: Date.now() + 60_000 });
      await post(b, `/api/tasks/${t2.id}/abort`);
      expect(c.db.getTask(s2.id)).toMatchObject({ resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, status: "done" });
      expect(c.db.listEvents(s2.id).some((e) => e.ev.t === "status" && e.ev.text.includes("自動再開を取り消しました"))).toBe(true);
      // a schedule never shadows, default or not (unattended: nobody answers the shadow's asks; the run guard knows only the primary)
      const meta = ((await fetch(`${b}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
      const sched = await post(b, "/api/schedules", { title: "nightly", cron: "@nightly", workspaceId: meta.id, runner: "claude", prompt: "night" }).then(j);
      const ran = await post(b, `/api/schedules/${sched.id}/run`).then(j);
      expect(ran.scheduleId).toBe(sched.id);
      expect(c.db.shadowTaskOf(ran.id)).toBeNull();
      expect(starts.at(-1)?.prompt).toBe("night");
      // an explicit null opts out of the default
      const t3 = await post(b, "/api/tasks", { cwd: h, title: "t3", prompt: "q", runner: "claude", shadowRunner: null }).then(j);
      expect(c.db.shadowTaskOf(t3.id)).toBeNull();
      // a task on the default runner itself gets no shadow, and says so
      const t4 = await post(b, "/api/tasks", { cwd: h, title: "t4", prompt: "r", runner: "dak" }).then(j);
      expect(c.db.shadowTaskOf(t4.id)).toBeNull();
      expect(c.db.listEvents(t4.id).some((e) => e.ev.t === "status" && e.ev.text.includes("主ランナーと同じ"))).toBe(true);
      // a saved default whose runner is gone (stale row) skips the shadow with a note rather than failing the task
      c.db.setSetting("settings", { defaultPermissionMode: {}, shadowRunner: "codex" });
      const t5 = await post(b, "/api/tasks", { cwd: h, title: "t5", prompt: "r", runner: "claude" }).then(j);
      expect(c.db.shadowTaskOf(t5.id)).toBeNull();
      expect(c.db.listEvents(t5.id).some((e) => e.ev.t === "status" && e.ev.text.includes("未検出"))).toBe(true);
      expect((await post(b, "/api/settings", { shadowRunner: null }, "PATCH").then(j)).shadowRunner).toBeNull();
      const t6 = await post(b, "/api/tasks", { cwd: h, title: "t6", prompt: "r", runner: "claude" }).then(j);
      expect(c.db.shadowTaskOf(t6.id)).toBeNull();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a shadow waiting on an approval gets no copy (noted on both); a shadow turn that ends in error is noted on the primary", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-shadow3-"));
    const dakAsk: AgentEvent[] = [
      { t: "session.start", runner: "dak", runnerSessionId: "dak-1", cwd: "/tmp" },
      { t: "tool.call", id: "d1", name: "exec.run", input: { cmd: "make" }, summary: "make" },
      { t: "permission.ask", id: "dperm", kind: "exec", tool: "exec.run", input: { cmd: "make" }, detail: "make" },
      { t: "tool.result", id: "d1", ok: true, summary: "ok" },
      { t: "session.end", status: "ok", summary: "done" },
    ];
    const sends: string[] = [];
    const dakSends: string[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn, { lingers: true, sends }), { ...fakeAdapter(dakAsk, { id: "dak", lingers: true, sends: dakSends }), permissionModes: [] }], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(b, "/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak" }).then(j);
      const s = c.db.shadowTaskOf(t.id)!;
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "waiting");
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect((await post(b, `/api/tasks/${t.id}/send`, { text: "while waiting" })).status).toBe(200);
      await waitFor(async () => sends.includes("while waiting"));
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(dakSends).toEqual([]);
      expect((await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status).toBe("waiting"); // the ask is still open, not denied
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("承認待ちのため返信を写しませんでした"))).toBe(true);
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "status" && e.ev.text.includes("承認待ちです"))).toBe(true);
      // answering lets the shadow finish; later copies flow again
      await post(b, `/api/tasks/${s.id}/permission`, { id: "dperm", decision: "allow" });
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      await post(b, `/api/tasks/${t.id}/send`, { text: "after answer" });
      await waitFor(async () => dakSends.includes("after answer"));
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
    // a shadow whose turn ends in error: the primary says so
    const h2 = mkdtempSync(join(tmpdir(), "switchboard-shadow4-"));
    const dakFail: AgentEvent[] = [{ t: "session.start", runner: "dak", runnerSessionId: "dak-2", cwd: "/tmp" }, { t: "error", message: "session dak-2 not found (HTTP 404)" }, { t: "session.end", status: "error", summary: "session dak-2 not found (HTTP 404)" }];
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn), { ...fakeAdapter(dakFail, { id: "dak" }), permissionModes: [] }], { port: 0 });
    const b2 = `http://127.0.0.1:${c2.server.port}`;
    try {
      const t = await post(b2, "/api/tasks", { cwd: h2, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak" }).then(j);
      const s = c2.db.shadowTaskOf(t.id)!;
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${s.id}`).then(j)).task.status === "error");
      await waitFor(async () => c2.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("ターンがエラーで終わりました") && e.ev.text.includes("HTTP 404")));
    } finally {
      await c2.stop();
      rmSync(h2, { recursive: true, force: true });
    }
  });

  test("a shadow runner that will not start leaves the primary running and notes the failure on both", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-shadow2-"));
    const broken: RunnerAdapter = { ...fakeAdapter(dakTurn, { id: "dak" }), permissionModes: [], start: () => { throw new Error("boom"); } };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn), broken], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const r = await post(b, "/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak" });
      expect(r.status).toBe(201);
      const t = (await r.json()) as Task;
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const s = c.db.shadowTaskOf(t.id)!;
      expect(s).toMatchObject({ runner: "dak", status: "error" });
      expect(c.tasks.isLive(s.id)).toBe(false);
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "error" && e.ev.message === "boom")).toBe(true);
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("起動できませんでした") && e.ev.text.includes("boom"))).toBe(true);
      // the primary still takes follow-ups; the copy to the broken shadow fails quietly, noted on both transcripts
      expect((await post(b, `/api/tasks/${t.id}/send`, { text: "again" })).status).toBe(200);
      await waitFor(async () => c.db.listEvents(s.id).some((e) => e.ev.t === "status" && e.ev.text.includes("並走の返信を送れませんでした")));
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("並走（dak）に返信を写せませんでした") && e.ev.text.includes("boom"))).toBe(true);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // the same runner as the primary: the task is created, says why it never ran, and the route reports it
      const r2 = await post(b, "/api/tasks", { cwd: h, title: "direct", prompt: "p", runner: "dak", shadowRunner: null });
      expect(r2.status).toBe(409);
      expect(((await r2.json()) as { error: string }).error).toContain("boom");
      const failed = c.db.listTasks().find((x) => x.title === "direct")!;
      expect(failed.status).toBe("error");
      expect(c.db.listEvents(failed.id).some((e) => e.ev.t === "error" && e.ev.message === "boom")).toBe(true);
      expect(c.tasks.isLive(failed.id)).toBe(false);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
