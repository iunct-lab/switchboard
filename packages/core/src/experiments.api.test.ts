import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Experiment } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon } from "./api-test-harness.ts";

useCoreDaemon();

describe("experiments", () => {
  test("register → list → record the outcome once; the same branch is 400, an unknown id 404, a second record 409", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-experiments-api-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const input = { question: "Does a fixed kernel pick better?", branchA: "fixed kernel", branchB: "explore 10%", metric: "decision changed", windowDays: 14 };
    try {
      expect(await fetch(`${b}/api/experiments`).then(j)).toEqual([]);
      const reg = await post("/api/experiments", input);
      expect(reg.status).toBe(201);
      const e: Experiment = (await reg.json()) as Experiment;
      expect(e).toMatchObject({ ...input, decidedAt: null, changed: null, note: null });
      expect(typeof e.registeredAt).toBe("number");
      expect(await fetch(`${b}/api/experiments`).then(j)).toEqual([e]);

      // both branches the same once whitespace and case are folded; nothing is stored
      expect((await post("/api/experiments", { ...input, branchA: "Both  A", branchB: " both a " })).status).toBe(400);
      expect((await post("/api/experiments", { ...input, windowDays: 0 })).status).toBe(400);
      expect((await post("/api/experiments", { ...input, metric: "  " })).status).toBe(400);
      expect(await fetch(`${b}/api/experiments`).then(j)).toHaveLength(1);

      expect((await post("/api/experiments/exp_nope/outcome", { changed: true })).status).toBe(404);
      expect((await post(`/api/experiments/${e.id}/outcome`, { changed: "yes" })).status).toBe(400);
      const done = await post(`/api/experiments/${e.id}/outcome`, { changed: true, note: "picked B" });
      expect(done.status).toBe(200);
      const decided: Experiment = (await done.json()) as Experiment;
      expect(decided).toMatchObject({ id: e.id, changed: true, note: "picked B" });
      expect(typeof decided.decidedAt).toBe("number");
      // the first record stands
      expect((await post(`/api/experiments/${e.id}/outcome`, { changed: false })).status).toBe(409);
      expect(await fetch(`${b}/api/experiments`).then(j)).toEqual([decided]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
