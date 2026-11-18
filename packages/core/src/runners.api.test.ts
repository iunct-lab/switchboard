import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCommand, RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { NO_GH, NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon } from "./api-test-harness.ts";

useCoreDaemon();

const TWO: RunnerCommand[] = [
  { name: "review", description: "review a PR", argumentHint: "<pr>", insert: "/review" },
  { name: "init", description: "write CLAUDE.md", insert: "/init" },
];

/** A fake runner that also lists commands: each call is recorded with its cwd and answered by `answer`. */
function withCommands(calls: string[], answer: (cwd: string) => Promise<RunnerCommand[]>): RunnerAdapter {
  return { ...fakeAdapter(SCRIPT), listCommands: (cwd) => (calls.push(cwd), answer(cwd)) };
}

async function boot(adapters: RunnerAdapter[]) {
  const h = mkdtempSync(join(tmpdir(), "switchboard-test-runner-commands-"));
  const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), adapters, { port: 0, selfdevChecks: false, gh: NO_GH, judge: undefined, titleSuggester: undefined });
  return { c, h, b: `http://127.0.0.1:${c.server.port}`, done: async () => (await c.stop(), rmSync(h, { recursive: true, force: true })) };
}

describe("runner commands", () => {
  test("commands of a workspace with no Task come from the adapter", async () => {
    const calls: string[] = [];
    const { c, h, b, done } = await boot([withCommands(calls, async () => TWO)]);
    try {
      const ws = c.db.upsertWorkspace({ name: "lab", path: join(h, "lab"), kind: "repo" });
      const r = await fetch(`${b}/api/runners/claude/commands?workspaceId=${ws.id}`);
      expect(r.status).toBe(200);
      expect((await j(r)).commands).toEqual(TWO);
      expect(calls).toEqual([ws.path]);
      expect((await fetch(`${b}/api/runners/claude/commands?workspaceId=ws_none`)).status).toBe(404);
      expect((await fetch(`${b}/api/runners/nope/commands`)).status).toBe(404);
    } finally {
      await done();
    }
  });

  test("without workspaceId the list is read in the home directory", async () => {
    const calls: string[] = [];
    const { b, done } = await boot([withCommands(calls, async () => TWO)]);
    try {
      expect((await fetch(`${b}/api/runners/claude/commands`).then(j)).commands).toHaveLength(2);
      expect(calls).toEqual([homedir()]);
    } finally {
      await done();
    }
  });

  test("a runner without listCommands answers an empty list", async () => {
    const { b, done } = await boot([fakeAdapter(SCRIPT)]);
    try {
      expect(await fetch(`${b}/api/runners/claude/commands`).then(j)).toEqual({ commands: [] });
    } finally {
      await done();
    }
  });

  test("a failed read answers 502 with the reason", async () => {
    const { b, done } = await boot([withCommands([], async () => Promise.reject(new Error("the runner did not start")))]);
    try {
      const r = await fetch(`${b}/api/runners/claude/commands`);
      expect(r.status).toBe(502);
      expect((await j(r)).error).toBe("the runner did not start");
    } finally {
      await done();
    }
  });

  test("a read that throws before it returns a promise keeps the last list, and with none answers 502", async () => {
    let throws = true;
    const { b, done } = await boot([withCommands([], () => {
      if (throws) throw new Error("no binary");
      return Promise.resolve(TWO);
    })]);
    try {
      const r = await fetch(`${b}/api/runners/claude/commands`);
      expect(r.status).toBe(502);
      expect((await j(r)).error).toBe("no binary");
      throws = false;
      await fetch(`${b}/api/runners/claude/commands`).then(j);
      throws = true;
      const again = await fetch(`${b}/api/runners/claude/commands`);
      expect(again.status).toBe(200);
      expect((await j(again)).commands).toEqual(TWO);
    } finally {
      await done();
    }
  });

  test("two requests at once start one read", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { b, done } = await boot([withCommands(calls, async () => (await gate, TWO))]);
    try {
      const both = Promise.all([fetch(`${b}/api/runners/claude/commands`).then(j), fetch(`${b}/api/runners/claude/commands`).then(j)]);
      while (calls.length === 0) await Bun.sleep(5);
      await Bun.sleep(30); // the second request has arrived while the read is still open
      release();
      const [x, y] = await both;
      expect(x.commands).toEqual(TWO);
      expect(y.commands).toEqual(TWO);
      expect(calls).toHaveLength(1);
    } finally {
      await done();
    }
  });

  test("a list read before is answered at once while one read refreshes it, and a failed refresh keeps it", async () => {
    const calls: string[] = [];
    let fail = false;
    const { b, done } = await boot([withCommands(calls, async () => (fail ? Promise.reject(new Error("gone")) : TWO))]);
    try {
      await fetch(`${b}/api/runners/claude/commands`).then(j);
      fail = true;
      const again = await fetch(`${b}/api/runners/claude/commands`);
      expect(again.status).toBe(200);
      expect((await j(again)).commands).toEqual(TWO);
      await waitCalls(calls, 2);
      expect((await fetch(`${b}/api/runners/claude/commands`).then(j)).commands).toEqual(TWO);
    } finally {
      await done();
    }
  });
});

async function waitCalls(calls: string[], n: number): Promise<void> {
  for (let i = 0; i < 200 && calls.length < n; i++) await Bun.sleep(5);
  expect(calls.length).toBeGreaterThanOrEqual(n);
}
