// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { NO_GH, NO_HISTORY, base, fakeAdapter, home, j, startServer, useCoreDaemon } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("Cloud preparation: explicit directory adds notice; Local unchanged; missing Workspace is 404", async () => {
    const send = (body: object) => fetch(`${base}/api/tasks/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const local = await send({ cwd: home, title: "task", prompt: "explain" }).then(j);
    expect(local.cloudPreparation).toBeUndefined();
    const cloud = await send({ cwd: home, executionMode: "cloud", title: "task", prompt: "explain" }).then(j);
    expect(cloud.cloudPreparation.warnings.join(" ")).toContain("Bundle");
    const missing = await send({ executionMode: "cloud" }).then(j);
    expect(missing.cloudPreparation.warnings.join(" ")).toContain("Workspace");
    expect((await send({ workspaceId: "missing", executionMode: "cloud" })).status).toBe(404);
  });

  test("Cloud API rejects unsupported inputs before starting and refuses Local follow-ups", async () => {
    const post = (body: object) => fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Cloud", prompt: "explain", executionMode: "cloud", ...body }) });
    for (const body of [{}, { cwd: home, runner: "codex" }, { cwd: home, model: "model" }, { cwd: home, budgetUsd: 1 }, { cwd: home, permissionMode: "default" }, { cwd: home, effort: "high" }, { cwd: home, shadowRunner: "codex" }, { cwd: home, attachmentIds: ["missing"] }, { cwd: home, scheduleId: "missing" }]) expect((await post(body)).status).toBe(400);
    expect((await post({ cwd: home, workspaceId: "missing" })).status).toBe(404);
    const workspaces = await fetch(`${base}/api/workspaces`).then(j);
    const meta = workspaces.find((w: { kind: string }) => w.kind === "meta");
    expect((await post({ cwd: home, workspaceId: meta.id })).status).toBe(400);
    const r = await post({ cwd: home }); expect(r.status).toBe(201); const t = await j(r); await Bun.sleep(20);
    const detail = await fetch(`${base}/api/tasks/${t.id}`).then(j);
    expect(detail.task).toMatchObject({ executionMode: "cloud", status: "running", outcome: "unknown", runnerSessionId: null, resumeAt: null });
    expect(detail.history).toBeNull();
    const send = await fetch(`${base}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "continue" }) });
    expect(send.status).toBe(409);
    await fetch(`${base}/api/tasks/${t.id}/abort`, { method: "POST" });
  });

  test("Cloud API stores official reference and never invokes automatic completion judge", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-cloud-api-"));
    const ref = { id: "session_0123456789abcdefghijklmn", url: "https://claude.ai/code/session_0123456789abcdefghijklmn" };
    let judges = 0;
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "cloud.session.created", ...ref }])], { port: 0, selfdevChecks: false, gh: NO_GH, judge: async () => { judges++; throw new Error("unexpected judge"); } });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const r = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Cloud", prompt: "explain", cwd: h, executionMode: "cloud" }) });
      expect(r.status).toBe(201); const t = await j(r); await Bun.sleep(30);
      const detail = await fetch(`${b}/api/tasks/${t.id}`).then(j);
      expect(detail.task).toMatchObject({ cloudSession: ref, status: "idle", outcome: "unknown", runnerSessionId: null, resumeAt: null });
      expect(detail.history).toBeNull(); expect(judges).toBe(0);
    } finally { await c.stop(); rmSync(h, { recursive: true, force: true }); }
  });
});
