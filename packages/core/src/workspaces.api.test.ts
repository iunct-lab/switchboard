// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { NO_GH, NO_HISTORY, SCRIPT, base, fakeAdapter, home, j, startServer, useCoreDaemon } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("GET /api/workspaces/:id/brief writes the improvement prefix per workspace: Switchboard's map for meta, the repository itself otherwise", async () => {
    const list = (await fetch(`${base}/api/workspaces`).then(j)) as Array<{ id: string; kind: string; name: string; path: string }>;
    const meta = list.find((w) => w.kind === "meta")!;
    const metaBrief = await fetch(`${base}/api/workspaces/${meta.id}/brief`).then(j);
    expect(metaBrief.workspaceId).toBe(meta.id);
    expect(metaBrief.text.startsWith("あなたは Switchboard（このアプリ自身）のリポジトリで作業しています。")).toBe(true);
    expect(metaBrief.text.endsWith("やってほしいこと:\n")).toBe(true);

    // under `home` (removed in afterAll): later tests list workspaces and expect every path to exist
    const other = join(home, "Decentralized-Agent-Kit");
    mkdirSync(other);
    {
      writeFileSync(join(other, "docker-compose.yml"), "services: {}\n");
      const r = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: other, name: "Decentralized-Agent-Kit" }) });
      expect(r.status).toBe(201);
      const added = (await r.json()) as { id: string };
      const brief = await fetch(`${base}/api/workspaces/${added.id}/brief`).then(j);
      expect(brief.text.startsWith(`あなたは Decentralized-Agent-Kit（${other}）のリポジトリで作業しています。`)).toBe(true);
      expect(brief.text).not.toContain("Switchboard");
      expect(brief.text).toContain("起動: `docker compose up`。");
    }
    expect((await fetch(`${base}/api/workspaces/ws_nope/brief`)).status).toBe(404);
  });

  test("workspace issueArtifacts: off by default, turned on only where GitHub is synced, on its own, survives reopening the DB", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-issue-artifacts-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const list = () => fetch(`${b}/api/workspaces`).then((r) => r.json() as Promise<Array<{ id: string; issueArtifacts: boolean }>>);
      const ws = (await list())[0]!;
      expect(ws.issueArtifacts).toBe(false);
      const patch = (body: unknown, id = ws.id) => fetch(`${b}/api/workspaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const github = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
      // a workspace not imported from GitHub yet, one kept here only, and one whose sync is off: nothing to attach to
      expect((await patch({ issueArtifacts: true })).status).toBe(409);
      c.db.setWorkspaceBacklogSource(ws.id, { service: "switchboard", host: "local", repository: ws.id, project: { owner: "switchboard", number: 0 } });
      expect((await patch({ issueArtifacts: true })).status).toBe(409);
      c.db.setWorkspaceBacklogSource(ws.id, { ...github, disabled: true });
      expect((await patch({ issueArtifacts: true })).status).toBe(409);
      expect((await list()).find((w) => w.id === ws.id)!.issueArtifacts).toBe(false);
      c.db.setWorkspaceBacklogSource(ws.id, github);
      expect((await patch({ issueArtifacts: true }).then(j)).issueArtifacts).toBe(true);
      expect((await list()).find((w) => w.id === ws.id)!.issueArtifacts).toBe(true);
      for (const bad of ["true", 1, null]) expect((await patch({ issueArtifacts: bad })).status).toBe(400);
      expect((await patch({ issueArtifacts: false, sweep: { plan: 1 } })).status).toBe(400);
      expect((await patch({ issueArtifacts: true }, "ws_none")).status).toBe(404);
      expect((await list()).find((w) => w.id === ws.id)!.issueArtifacts).toBe(true);
    } finally {
      await c.stop();
    }
    const db = new Db(join(h, "switchboard.db"));
    try {
      expect(db.listWorkspaces()[0]!.issueArtifacts).toBe(true);
      expect(db.setWorkspaceIssueArtifacts(db.listWorkspaces()[0]!.id, false)!.issueArtifacts).toBe(false);
    } finally {
      db.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("workspace sweep: PATCH one side keeps the other, 0〜3 only, survives reopening the DB", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-sweep-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const list = () => fetch(`${b}/api/workspaces`).then((r) => r.json() as Promise<Array<{ id: string; sweep: unknown }>>);
      const ws = (await list())[0]!;
      expect(ws.sweep).toEqual({ implement: 1, plan: 1 });
      const patch = (body: unknown) => fetch(`${b}/api/workspaces/${ws.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await patch({ sweep: { implement: 2 } }).then(j)).sweep).toEqual({ implement: 2, plan: 1 });
      expect((await patch({ sweep: { plan: 0 } })).status).toBe(200);
      for (const bad of [{ implement: 4 }, { plan: -1 }, { implement: 1.5 }, { implement: "2" }, { other: 1 }, null]) expect((await patch({ sweep: bad })).status).toBe(400);
      expect((await patch({ sweep: { plan: 1 }, projectVar: "X" })).status).toBe(400);
      expect((await fetch(`${b}/api/workspaces/ws_none`, { method: "PATCH", body: JSON.stringify({ sweep: { plan: 1 } }) })).status).toBe(404);
      expect((await list()).find((w) => w.id === ws.id)!.sweep).toEqual({ implement: 2, plan: 0 });
    } finally {
      await c.stop();
    }
    const db = new Db(join(h, "switchboard.db"));
    try {
      expect(db.listWorkspaces()[0]!.sweep).toEqual({ implement: 2, plan: 0 });
    } finally {
      db.close();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
