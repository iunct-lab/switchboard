import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { stopEndedTasksProcesses, taskProcesses } from "./detached.ts";
import { startServer } from "./server.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response) => r.json() as Promise<any>;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const NO_GH = async () => ({ code: 1, stdout: "", stderr: "no gh in this test" });
const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
});

/** A runner that detaches `sleep 300` (setsid nohup) from the task's environment, writes its pid to <cwd>/pid, and lingers. */
function detachingAdapter(finish: boolean): RunnerAdapter {
  return {
    id: "claude",
    async detect() { return { available: true, version: "fake" }; },
    start(o: StartOptions, emit): RunnerSession {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      Bun.spawn(["setsid", "nohup", "sh", "-c", 'sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "$0"', join(o.cwd, "pid")], { env: { ...process.env, ...o.env }, stdio: ["ignore", "ignore", "ignore"] });
      queueMicrotask(() => {
        const evs: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: o.cwd, model: "m" }];
        if (finish) evs.push({ t: "session.end", status: "ok", summary: "done" });
        for (const e of evs) emit(e);
      });
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

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const pidOf = async (dir: string) => {
  await waitFor(() => existsSync(join(dir, "pid")) && readFileSync(join(dir, "pid"), "utf8").trim() !== "");
  const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
  leftovers.push(pid);
  return pid;
};

async function boot(finish: boolean) {
  const home = mkdtempSync(join(tmpdir(), "switchboard.detached."));
  const c = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_RUNNER_IDLE_MS: "60" }), [detachingAdapter(finish)], { port: 0, selfdevChecks: false, gh: NO_GH });
  const base = `http://127.0.0.1:${c.server.port}`;
  const create = async () => {
    const cwd = mkdtempSync(join(home, "cwd-"));
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, title: "t", prompt: "p", runner: "claude" }) }).then(j);
    return { id: t.id as string, cwd, task: async () => (await fetch(`${base}/api/tasks/${t.id}`).then(j)).task, events: async () => (await fetch(`${base}/api/tasks/${t.id}`).then(j)).events as { t: string; text?: string }[] | undefined };
  };
  return { c, base, create };
}

describe("detached processes of a task (#1397)", () => {
  test("a detached process of an aborted task is stopped, others are left", async () => {
    const { c, base, create } = await boot(false);
    try {
      const a = await create();
      const b = await create();
      const pa = await pidOf(a.cwd);
      const pb = await pidOf(b.cwd);
      const outside = Bun.spawn(["setsid", "sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
      leftovers.push(outside.pid);
      expect(alive(pa) && alive(pb)).toBe(true);
      await fetch(`${base}/api/tasks/${a.id}/abort`, { method: "POST" });
      await waitFor(() => !alive(pa), 5000);
      expect(alive(pb)).toBe(true); // another task, still running
      expect(alive(outside.pid)).toBe(true); // started outside any task
      await waitFor(async () => JSON.stringify(await fetch(`${base}/api/tasks/${a.id}`).then(j)).includes("切り離されたプロセスを 1 件止めました"));
    } finally {
      await c.stop();
    }
  });

  test("a detached process of a finished task is stopped once the runner is released", async () => {
    const { c, create } = await boot(true);
    try {
      const a = await create();
      const pa = await pidOf(a.cwd);
      await waitFor(async () => (await a.task()).status === "done");
      await waitFor(() => !alive(pa), 5000);
      expect(c.tasks.isLive(a.id)).toBe(false);
    } finally {
      await c.stop();
    }
  });
});

describe("taskProcesses", () => {
  const fake = (root: string, pid: number, ppid: number, id?: string, sid = pid, home?: string) => {
    mkdirSync(join(root, String(pid)), { recursive: true });
    writeFileSync(join(root, String(pid), "stat"), `${pid} (a b) S ${ppid} ${pid} ${sid} 0`);
    writeFileSync(join(root, String(pid), "environ"), `A=1\0${id ? `SWITCHBOARD_TASK_ID=${id}\0` : ""}${home ? `SWITCHBOARD_DAEMON_HOME=${home}\0` : ""}B=2\0`);
  };

  test("the daemon and its ancestors are never picked; only the exact task id is", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard.procroot."));
    fake(root, process.pid, 4242, "T1"); // self, marked
    fake(root, 4242, 1, "T1"); // parent, marked (sb-rescue)
    fake(root, 5001, 1, "T1");
    fake(root, 5002, 1, "T10"); // a different task whose id starts the same
    fake(root, 5003, 1);
    expect(taskProcesses("T1", root)).toEqual([5001]);
    expect(taskProcesses("T10", root)).toEqual([5002]);
    expect(taskProcesses("T1", join(root, "missing"))).toEqual([]);
  });

  test("the daemon's own session and another daemon's tasks are left", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard.procroot."));
    fake(root, process.pid, 1, undefined, process.pid);
    fake(root, 6001, process.pid, "T1", process.pid); // a sibling in the daemon's session (dev.ts's vite)
    fake(root, 6002, 1, "T1", 6002, "/home/a");
    fake(root, 6003, 1, "T1", 6003, "/home/b"); // a daemon on a copy of the database
    expect(taskProcesses("T1", root, "/home/a")).toEqual([6002]);
  });
});

describe("leftovers at the next start (#1397)", () => {
  test("leftovers of ended tasks are stopped at the next start; a task with a resume planned keeps its process", async () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard.detached."));
    const env = { SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY };
    const c1 = await startServer(loadConfig(env), [detachingAdapter(false)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const ws = c1.db.listWorkspaces()[0];
    const now = Date.now();
    const task = (id: string, status: "done" | "running", resumeAt: number | null) => c1.db.insertTask({ id, workspaceId: ws?.id ?? null, title: id, runner: "claude", cwd: home, scope: [home], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt, resumeReason: resumeAt ? "usage-limit" : null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: now, createdAt: now, updatedAt: now } as never);
    task("tsk_ended", "done", null);
    task("tsk_planned", "done", now + 3_600_000);
    await c1.stop();
    const spawn = (id: string) => {
      const p = Bun.spawn(["setsid", "sleep", "300"], { env: { ...process.env, SWITCHBOARD_TASK_ID: id, SWITCHBOARD_DAEMON_HOME: home }, stdio: ["ignore", "ignore", "ignore"] });
      leftovers.push(p.pid);
      return p.pid;
    };
    const ended = spawn("tsk_ended");
    const planned = spawn("tsk_planned");
    const unknown = spawn("tsk_unknown");
    await waitFor(() => taskProcesses("tsk_ended").length === 1 && taskProcesses("tsk_planned").length === 1 && taskProcesses("tsk_unknown").length === 1);
    const c2 = await startServer(loadConfig(env), [detachingAdapter(false)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      await waitFor(() => !alive(ended), 5000);
      expect(alive(planned)).toBe(true);
      expect(alive(unknown)).toBe(true);
    } finally {
      await c2.stop();
    }
  });

  test("stopEndedTasksProcesses reports a count per ended task", async () => {
    const p = Bun.spawn(["setsid", "sleep", "300"], { env: { ...process.env, SWITCHBOARD_TASK_ID: "tsk_count" }, stdio: ["ignore", "ignore", "ignore"] });
    leftovers.push(p.pid);
    await waitFor(() => taskProcesses("tsk_count").length === 1);
    const out = await stopEndedTasksProcesses((id) => id === "tsk_count", { graceMs: 500 });
    expect(out.get("tsk_count")).toBe(1);
  });
});
