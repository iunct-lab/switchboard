import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response) => r.json() as Promise<any>;
const NO_GH = async () => ({ code: 1, stdout: "", stderr: "no gh in this test" });
const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const seen: Record<string, string>[] = [];
/** Stands in for the runner whose task ran `docker compose up -d` through the kit's front: writes the project to the task's log. */
function composeAdapter(): RunnerAdapter {
  return {
    id: "claude",
    async detect() { return { available: true, version: "fake" }; },
    start(o: StartOptions, emit): RunnerSession {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      seen.push(o.env ?? {});
      const log = o.env?.DOCKER_MARK_LOG;
      if (log) appendFileSync(log, `${JSON.stringify({ project: "demo", cwd: o.cwd })}\n`);
      queueMicrotask(() => emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: o.cwd, model: "m" } as AgentEvent));
      return {
        send() {},
        respondPermission() {},
        abort: async () => { emit({ t: "session.end", status: "aborted", summary: "aborted" }); resolveExit(null); },
        close: async () => resolveExit(0),
        exited,
      };
    },
  };
}

let bin: string;
let calls: string;
const oldPath = process.env.PATH;
beforeEach(() => {
  seen.length = 0;
  bin = mkdtempSync(join(tmpdir(), "switchboard.containers.bin."));
  calls = join(bin, "calls");
  writeFileSync(calls, "");
  const fake = join(bin, "docker");
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$1" in\n  ps) echo c1 ;;\nesac\nexit 0\n`);
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
});
afterEach(() => { process.env.PATH = oldPath; });

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "switchboard.containers."));
  const c = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_RUNNER_IDLE_MS: "60" }), [composeAdapter()], { port: 0, selfdevChecks: false, gh: NO_GH });
  const base = `http://127.0.0.1:${c.server.port}`;
  const create = async (cwd = mkdtempSync(join(home, "cwd-"))) => {
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, title: "t", prompt: "p", runner: "claude" }) }).then(j);
    return { id: t.id as string, events: async () => JSON.stringify((await fetch(`${base}/api/tasks/${t.id}`).then(j)).events) };
  };
  const abort = (id: string) => fetch(`${base}/api/tasks/${id}/abort`, { method: "POST" });
  return { c, home, create, abort };
}
const callLines = () => readFileSync(calls, "utf8").split("\n").filter(Boolean);

describe("containers of an ended task (#1418)", () => {
  test("compose projects and labelled containers of an ended task are removed", async () => {
    const { c, create, abort } = await boot();
    try {
      const a = await create();
      await abort(a.id);
      await waitFor(async () => (await a.events()).includes("コンテナを片付けました"));
      const lines = callLines();
      expect(lines).toContain("compose -p demo down --remove-orphans");
      expect(lines).toContain(`ps -aq --filter label=switchboard.task=${a.id}`);
      expect(lines).toContain("rm -f c1");
      expect(lines.join("\n")).not.toMatch(/ -v|--rmi|volume|image/);
    } finally { await c.stop(); }
  });

  test("a project started with an explicit compose file is taken down with it", async () => {
    const { c, create, abort } = await boot();
    try {
      const a = await create();
      writeFileSync(seen[0]!.DOCKER_MARK_LOG!, `${JSON.stringify({ project: "demo", cwd: tmpdir(), globals: ["-f", "custom.yml"] })}\n`);
      await abort(a.id);
      await waitFor(async () => (await a.events()).includes("コンテナを片付けました"));
      expect(callLines()).toContain("compose -f custom.yml -p demo down --remove-orphans");
    } finally { await c.stop(); }
  });

  test("a failed removal is reported, not hidden", async () => {
    const { c, create, abort } = await boot();
    try {
      writeFileSync(join(bin, "docker"), `#!/bin/sh\ncase "$1" in\n  ps) echo c1 ;;\n  rm) exit 1 ;;\nesac\nexit 0\n`);
      const a = await create();
      await abort(a.id);
      await waitFor(async () => (await a.events()).includes("失敗 1 件"));
    } finally { await c.stop(); }
  });

  test("a project another open task still uses is kept", async () => {
    const { c, create, abort } = await boot();
    try {
      const a = await create();
      const b = await create();
      await abort(a.id);
      await waitFor(async () => (await a.events()).includes("コンテナを片付けました"));
      expect(callLines().some((l) => l.startsWith("compose -p demo down"))).toBe(false);
      await abort(b.id);
      await waitFor(() => callLines().some((l) => l.startsWith("compose -p demo down")));
    } finally { await c.stop(); }
  });

  test("a task that started nothing is left alone", async () => {
    const { c, create, abort } = await boot();
    try {
      const a = await create();
      // the runner of this test wrote a project; one without a log is the case of a task that never used docker
      const log = seen[0]!.DOCKER_MARK_LOG!;
      writeFileSync(log, "");
      await abort(a.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(callLines().some((l) => l.startsWith("compose "))).toBe(false);
    } finally { await c.stop(); }
  });

  test("no docker does not stop the end", async () => {
    const { c, create, abort } = await boot();
    try {
      process.env.PATH = "/nonexistent";
      const a = await create();
      await abort(a.id);
      await waitFor(async () => (await a.events()).includes("コンテナの片付けを飛ばしました"));
      expect(callLines()).toEqual([]);
      expect(existsSync(seen[0]!.DOCKER_MARK_LOG!)).toBe(true);
    } finally { process.env.PATH = `${bin}${delimiter}${oldPath}`; await c.stop(); }
  });

  test("another repository's task is cleaned up the same", async () => {
    const { c, home, create, abort } = await boot();
    try {
      const other = mkdtempSync(join(tmpdir(), "switchboard.containers.repo."));
      mkdirSync(join(other, ".git"));
      const a = await create(other);
      await abort(a.id);
      await waitFor(async () => (await a.events()).includes("コンテナを片付けました"));
      expect(callLines()).toContain("compose -p demo down --remove-orphans");
      expect(home).not.toBe(other);
    } finally { await c.stop(); }
  });

  test("the runner's environment carries the label and the log", async () => {
    const { c, create } = await boot();
    try {
      const a = await create();
      await waitFor(() => seen.length > 0);
      expect(seen[0]!.DOCKER_MARK_LABEL).toBe(`switchboard.task=${a.id}`);
      expect(seen[0]!.DOCKER_MARK_LOG).toMatch(new RegExp(`/docker/${a.id}\\.jsonl$`));
      expect(seen[0]!.SWITCHBOARD_TASK_ID).toBe(a.id);
    } finally { await c.stop(); }
  });
});
