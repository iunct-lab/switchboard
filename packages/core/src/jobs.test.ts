// test-reads: none
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobRequest, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { jobCommand, JobError, type JobDeps, recoverJobs, requestJob, sameRepository } from "./jobs.ts";
import { startServer } from "./server.ts";

// Jobs a Task asks the daemon to run (#3992): the daemon's child, not the Task's; its end is recorded once.

const mkTask = (id: string, cwd: string): Task => {
  const at = Date.now();
  return { id, workspaceId: null, title: "t", stage: null, runner: "claude", cwd, scope: [cwd], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Task;
};
const sh = (cwd: string, ...argv: string[]) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr}`);
};
const ppid = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);

let root: string;
let repo: string;
let db: Db;
const ORIGIN = "https://github.com/acme/app.git";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "switchboard-jobs-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  sh(repo, "git", "init", "-q");
  sh(repo, "git", "remote", "add", "origin", ORIGIN);
  sh(repo, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  db = new Db(join(root, "db.sqlite"));
  db.insertTask(mkTask("t1", repo));
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Deps whose command is `script` and whose finish resolves `ended`. */
function fake(script: string) {
  let done!: (j: Job) => void;
  const ended = new Promise<Job>((r) => (done = r));
  const deps: JobDeps = { db, dir: join(root, "jobs"), env: { ...process.env, SWITCHBOARD_TASK_ID: "t1", SWITCHBOARD_SUPERVISED: "1" }, command: () => ({ argv: ["sh", "-c", script], tail: "" }), onFinish: done, pollMs: 50 };
  return { deps, ended };
}
const local = (cwd = repo): JobRequest => ({ kind: "local-ci", taskId: "t1", pr: 12, cwd });

describe("jobs (#3992)", () => {
  test("a job is the daemon's child and its end is recorded with the log's tail", async () => {
    const { deps, ended } = fake("echo hello; sleep 0.3; exit 3");
    const job = requestJob(deps, local());
    expect(job.status).toBe("running");
    const pid = db.jobPid(job.id).pid!;
    expect(ppid(pid)).toBe(process.pid);
    const end = await ended;
    expect(end).toMatchObject({ id: job.id, status: "fail", exitCode: 3 });
    expect(end.summary).toContain("hello");
    expect(end.summary).toContain(join(root, "jobs", String(job.id), "log"));
    expect(db.getJob(job.id)!.status).toBe("fail");
  });

  test("the job goes on after the Task's process is gone, without the Task's mark", async () => {
    const taskProc = Bun.spawn(["sleep", "30"]);
    const { deps, ended } = fake('env > "$J/env"; sleep 0.3');
    const job = requestJob(deps, local());
    taskProc.kill();
    await taskProc.exited;
    expect((await ended).status).toBe("pass");
    const env = readFileSync(join(root, "jobs", String(job.id), "env"), "utf8");
    expect(env).toContain("OPS_KIT_TASK_ID=t1");
    expect(env).not.toContain("SWITCHBOARD_TASK_ID=");
    expect(env).not.toContain("SWITCHBOARD_SUPERVISED=");
  });

  test("a folder outside the Task's repository is refused; a worktree and a clone of the same origin are not", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const { deps } = fake("true");
    expect(() => requestJob(deps, local(outside))).toThrow(JobError);
    try {
      requestJob(deps, local(outside));
    } catch (e) {
      expect((e as JobError).status).toBe(400);
    }
    expect(() => requestJob(deps, { ...local(), taskId: "nope" })).toThrow("task not found");
    const wt = join(root, "wt");
    sh(repo, "git", "worktree", "add", "-q", "--detach", wt);
    expect(sameRepository(repo, wt)).toBe(true);
    const clone = join(root, "clone");
    mkdirSync(clone);
    sh(clone, "git", "init", "-q");
    sh(clone, "git", "remote", "add", "origin", "git@github.com:acme/app.git");
    expect(sameRepository(repo, clone)).toBe(true);
    sh(clone, "git", "remote", "set-url", "origin", "https://github.com/acme/other.git");
    expect(sameRepository(repo, clone)).toBe(false);
    expect(sameRepository(repo, outside)).toBe(false);
  });

  test("a folder left by an earlier job of the same id starts empty; a relative cwd and a folder that cannot be made are refused", async () => {
    const { deps, ended } = fake('test -e "$J/exit" && echo stale; true');
    const next = (db.listJobs(0)[0]?.id ?? 0) + 1;
    mkdirSync(join(root, "jobs", String(next)), { recursive: true });
    writeFileSync(join(root, "jobs", String(next), "exit"), "0\n");
    writeFileSync(join(root, "jobs", String(next), "log"), "old log\n");
    const job = requestJob(deps, local());
    expect(job.id).toBe(next);
    const end = await ended;
    expect(end.summary).not.toContain("stale");
    expect(end.summary).not.toContain("old log");
    expect(() => requestJob(deps, local("."))).toThrow("cwd must be absolute");
    writeFileSync(join(root, "not-a-folder"), "");
    const broken = { ...fake("true").deps, dir: join(root, "not-a-folder") };
    expect(() => requestJob(broken, local())).toThrow("could not start the job");
    expect(db.listJobs(0)[0]!.status).toBe("aborted"); // not left running
  });

  test("a review's prompt must exist; its command reads the prompt and writes the out file", () => {
    const { deps } = fake("true");
    expect(() => requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "missing.md", outFile: "out.md" })).toThrow("promptFile not found");
    // the prompt is read and the output written only inside the checkout: not through `..`, not through a link
    writeFileSync(join(repo, "prompt.md"), "review");
    const review = (outFile: string, promptFile = "prompt.md") => () => requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile, outFile });
    expect(review("../victim.md")).toThrow("inside cwd");
    expect(review("out.md", "../db.sqlite")).toThrow("inside cwd");
    symlinkSync(join(root, "victim.md"), join(repo, "link.md"));
    expect(review("link.md")).toThrow("inside cwd");
    expect(review("_review/missing-dir/out.md")).toThrow("inside cwd");
    const codex = jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "/p.md", outFile: "/o.md" });
    expect(codex.argv.slice(0, 2)).toEqual(["ops-kit", "heavy"]);
    expect(codex.argv).toContain("/o.md");
    expect(codex.tail).toBe(' < "$JOB_PROMPT"');
    const claude = jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "claude", cwd: repo, promptFile: "/p.md", outFile: "/o.md" });
    expect(claude.argv).toContain("stream-json");
    expect(claude.tail).toContain('> "$JOB_OUT"');
    expect(jobCommand(local()).argv).toEqual(["bun", "scripts/local-ci.ts", "12"]);
    expect(codex.argv.slice(5, 9)).toEqual(["ops-kit", "idle-run", "--idle", "900"]);
    // the host may need longer (SWITCHBOARD_JOB_REVIEW_IDLE_S)
    expect(jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "claude", cwd: repo, promptFile: "/p.md", outFile: "/o.md" }, 1800).argv.slice(5, 9)).toEqual(["ops-kit", "idle-run", "--idle", "1800"]);
  });

  test("recoverJobs ends a job by its exit file, watches one still running, and aborts one whose process is gone or that started in another boot", async () => {
    const dir = join(root, "jobs-recover");
    const ended: Job[] = [];
    const deps: JobDeps = { db, dir, env: {}, onFinish: (j) => ended.push(j), pollMs: 50, bootId: () => "boot-now" };
    const mk = () => db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now() });
    const exited = mk();
    mkdirSync(join(dir, String(exited.id)), { recursive: true });
    writeFileSync(join(dir, String(exited.id), "exit"), "0\n");
    db.setJobPid(exited.id, 999_999_999, "boot-now");
    const gone = mk();
    db.setJobPid(gone.id, 999_999_999, "boot-now");
    const live = mk();
    const proc = Bun.spawn(["sleep", "30"]);
    db.setJobPid(live.id, proc.pid, "boot-now");
    // started before a reboot: its pid now names another (live) process — this test's own
    const rebooted = mk();
    db.setJobPid(rebooted.id, process.pid, "boot-before");
    recoverJobs(deps);
    expect(db.getJob(rebooted.id)!.status).toBe("aborted");
    expect(db.getJob(exited.id)!.status).toBe("pass");
    expect(db.getJob(gone.id)!.status).toBe("aborted");
    expect(db.getJob(live.id)!.status).toBe("running");
    mkdirSync(join(dir, String(live.id)), { recursive: true });
    writeFileSync(join(dir, String(live.id), "exit"), "1\n");
    await Bun.sleep(200);
    expect(db.getJob(live.id)).toMatchObject({ status: "fail", exitCode: 1 });
    expect(ended.map((j) => j.id).sort()).toEqual([exited.id, gone.id, live.id, rebooted.id].sort());
    proc.kill();
  });
});

test("the list keeps a job for 7 days after it ended, and every running one", () => {
  const d = new Db(join(root, "list.sqlite"));
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const mk = () => d.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: now - 9 * day });
  const running = mk();
  const endedNow = mk();
  d.finishJob(endedNow.id, { status: "pass", exitCode: 0, summary: "", endedAt: now });
  const endedLong = mk();
  d.finishJob(endedLong.id, { status: "pass", exitCode: 0, summary: "", endedAt: now - 8 * day });
  expect(d.listJobs(now - 7 * day).map((j) => j.id)).toEqual([endedNow.id, running.id]);
  d.close();
});

describe("/api/jobs (#3992)", () => {
  test("POST answers 400 outside the repository and 202 with the job; GET lists it", async () => {
    const home = join(root, "home");
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    const core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, jobCommand: () => ({ argv: ["true"], tail: "" }) });
    try {
      core.db.insertTask(mkTask("t9", repo));
      const base = `http://127.0.0.1:${core.server.port}`;
      const post = (body: unknown) => fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify(body) });
      expect((await post({ kind: "local-ci", taskId: "t9", pr: 5, cwd: root })).status).toBe(400);
      expect((await post({ kind: "shell", taskId: "t9", pr: 5, cwd: repo })).status).toBe(400);
      const r = await post({ kind: "local-ci", taskId: "t9", pr: 5, cwd: repo });
      expect(r.status).toBe(202);
      const job = (await r.json()) as Job;
      expect(job).toMatchObject({ kind: "local-ci", taskId: "t9", pr: 5, status: "running" });
      const list = (await fetch(`${base}/api/jobs`).then((x) => x.json())) as Job[];
      expect(list.map((j) => j.id)).toContain(job.id);
      for (let i = 0; i < 50 && core.db.getJob(job.id)!.status === "running"; i++) await Bun.sleep(20);
      expect(core.db.getJob(job.id)!.status).toBe("pass");
    } finally {
      await core.stop();
    }
  });
});
