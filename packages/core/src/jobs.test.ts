// test-reads: none
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobRequest, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { jobCommand, JobError, JOBS_KEEP_MS, type JobDeps, jobUsage, pruneJobDirs, localCiPendingDir, recoverJobs, requestJob, sameRepository } from "./jobs.ts";
import { startServer } from "./server.ts";
import { workspaceConfigFile, writeWorkspaceConfigs } from "./workspace-config.ts";

// Jobs a Task asks the daemon to run: the daemon's child, not the Task's; its end is recorded once.

const mkTask = (id: string, cwd: string): Task => {
  const at = Date.now();
  return { id, workspaceId: null, title: "t", stage: null, runner: "claude", cwd, scope: [cwd], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Task;
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
const local = (cwd = repo): Extract<JobRequest, { kind: "local-ci" }> => ({ kind: "local-ci", taskId: "t1", pr: 12, cwd });

describe("jobs", () => {
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

  test("a job's environment drops Claude Code's session markers and OTEL_* as childEnv does, and the Task's mark and SWITCHBOARD_SUPERVISED", async () => {
    const { deps, ended } = fake('env > "$J/env"');
    deps.env = { ...deps.env, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", CLAUDE_PID: "1", CLAUDE_EFFORT: "high", OTEL_EXPORTER_OTLP_ENDPOINT: "x" };
    const job = requestJob(deps, local());
    await ended;
    const env = readFileSync(join(root, "jobs", String(job.id), "env"), "utf8");
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID", "CLAUDE_EFFORT", "OTEL_EXPORTER_OTLP_ENDPOINT", "SWITCHBOARD_SUPERVISED"]) expect(env).not.toMatch(new RegExp(`^${k}=`, "m"));
    expect(env).toContain("OPS_KIT_TASK_ID=t1");
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

  test("a local-ci job with fixtures runs with SWITCHBOARD_FIXTURES set to it; one without has none", async () => {
    const run = async (req: JobRequest) => {
      const { deps, ended } = fake('env > "$J/env"');
      delete deps.env.SWITCHBOARD_FIXTURES;
      const job = requestJob(deps, req);
      await ended;
      return readFileSync(join(root, "jobs", String(job.id), "env"), "utf8");
    };
    expect(await run({ kind: "local-ci", taskId: "t1", pr: 12, cwd: repo, fixtures: "/srv/recordings" })).toContain("SWITCHBOARD_FIXTURES=/srv/recordings\n");
    expect(await run(local())).not.toContain("SWITCHBOARD_FIXTURES=");
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

  test("cwd of a registered workspace's clone is accepted / an unknown origin is refused", () => {
    const other = join(root, "other-ws");
    mkdirSync(other);
    sh(other, "git", "init", "-q");
    sh(other, "git", "remote", "add", "origin", "https://github.com/acme/capsule.git");
    const clone = join(root, "capsule-clone");
    mkdirSync(clone);
    sh(clone, "git", "init", "-q");
    sh(clone, "git", "remote", "add", "origin", "git@github.com:acme/capsule.git");
    const { deps } = fake("true");
    expect(() => requestJob(deps, local(clone))).toThrow("not a checkout"); // not registered yet
    db.upsertWorkspace({ name: "capsule", path: other, kind: "repo" });
    expect(requestJob(deps, local(clone)).status).toBe("running");
    sh(clone, "git", "remote", "set-url", "origin", "https://github.com/acme/unknown.git");
    expect(() => requestJob(deps, local(clone))).toThrow("not a checkout");
  });

  test("local CI of a repository that is not Switchboard's runs Switchboard's script with --repo from that repository's folder and gets the workspace's saved settings as OPS_KIT_CONFIG; Switchboard's own PR runs its checkout's script", async () => {
    const mk = (name: string, origin: string | null) => {
      const dir = join(root, name);
      mkdirSync(dir);
      sh(dir, "git", "init", "-q");
      if (origin) sh(dir, "git", "remote", "add", "origin", origin);
      return dir;
    };
    const [metaDir, libDir, bare] = [mk("meta-ws", "https://github.com/acme/switchboard.git"), mk("lib-ws", "git@github.com:acme/lib.git"), mk("no-origin-ws", null)];
    // a database of its own: a meta workspace would change what the other tests' checkouts are
    const db2 = new Db(join(root, "db2.sqlite"));
    try {
      db2.upsertWorkspace({ name: "switchboard", path: metaDir, kind: "meta" });
      const lib = db2.upsertWorkspace({ name: "lib", path: libDir, kind: "repo" });
      db2.upsertWorkspace({ name: "bare", path: bare, kind: "repo" });
      for (const [id, cwd] of [["t-meta", metaDir], ["t-lib", libDir], ["t-bare", bare]] as const) db2.insertTask(mkTask(id, cwd));
      // the settings saved for lib (nothing is in its repository), written where the daemon keeps them
      db2.recordConfigChange({ workspaceId: lib.id, at: 1, source: "person", after: JSON.stringify({ ci: { steps: [{ run: "make check" }] } }), keys: ["ci"], state: "confirmed" });
      // a change that only waits for the person is not what a job runs with
      db2.recordConfigChange({ workspaceId: lib.id, at: 2, source: "call", after: JSON.stringify({ ci: { steps: [{ run: "true" }] } }), keys: ["ci"], state: "pending" });
      const home = join(root, "home-ws");
      writeWorkspaceConfigs(home, db2.listWorkspaces());
      const run = async (taskId: string, cwd: string) => {
        const f = fake("true");
        const got: Parameters<NonNullable<JobDeps["command"]>>[0][] = [];
        const deps: JobDeps = { ...f.deps, db: db2, command: (req) => (got.push(req), { argv: ["sh", "-c", 'env > "$J/env"'], tail: "" }) };
        const job = requestJob(deps, { kind: "local-ci", taskId, pr: 7, cwd });
        await f.ended;
        return { argv: jobCommand(got[0]!).argv, env: readFileSync(join(root, "jobs", String(job.id), "env"), "utf8") };
      };
      const other = await run("t-lib", libDir);
      expect(other.argv).toEqual(["bun", join(metaDir, "scripts/local-ci.ts"), "7", "--repo", "acme/lib"]);
      expect(other.env).toContain(`OPS_KIT_CONFIG=${workspaceConfigFile(home, lib.id)}\n`);
      expect(JSON.parse(readFileSync(workspaceConfigFile(home, lib.id), "utf8"))).toEqual({ ci: { steps: [{ run: "make check" }] } });
      // Switchboard's own PR: the checkout's script (the PR's own), no settings handed over
      const own = await run("t-meta", metaDir);
      expect(own.argv).toEqual(["bun", "scripts/local-ci.ts", "7"]);
      expect(own.env).not.toContain("OPS_KIT_CONFIG=");
      // a checkout whose origin names no GitHub repository has no PR to run: refused with the way to run a local change
      expect(() => requestJob({ ...fake("true").deps, db: db2 }, { kind: "local-ci", taskId: "t-bare", pr: 7, cwd: bare })).toThrow("owner/name を読めません");
      // someone else's repository: its PR's steps would run here as the host's user, so the job is refused unless the
      // machine builds off the host; --local (run here) is refused there too
      const theirs = mk("theirs-ws", "https://github.com/acme/theirs.git");
      db2.upsertWorkspace({ name: "theirs", path: theirs, kind: "repo", upstream: "https://github.com/else/theirs.git" });
      db2.insertTask(mkTask("t-theirs", theirs));
      const ask = (offHost: boolean, local = false) => requestJob({ ...fake("true").deps, db: db2, offHost: () => offHost, command: () => ({ argv: ["true"], tail: "" }) }, { kind: "local-ci", taskId: "t-theirs", pr: 7, cwd: theirs, ...(local ? { local: true } : {}) });
      expect(() => ask(false)).toThrow("外のビルド（sb-offload）があるマシンでだけ");
      expect(() => ask(true, true)).toThrow("外のビルド（sb-offload）があるマシンでだけ");
      expect(ask(true).id).toBeGreaterThan(0);
      // the settings taken away: the file goes and the next job gets none
      db2.recordConfigChange({ workspaceId: lib.id, at: 3, source: "person", after: null, keys: ["ci"], state: "confirmed" });
      writeWorkspaceConfigs(home, db2.listWorkspaces());
      expect(existsSync(workspaceConfigFile(home, lib.id))).toBe(false);
      expect((await run("t-lib", libDir)).env).not.toContain("OPS_KIT_CONFIG=");
    } finally {
      db2.close();
    }
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
    expect(codex.argv.slice(0, 3)).toEqual(["ops-kit", "heavy", "--memory-only"]); // no slot, only the memory floor
    expect(codex.argv).toContain("/o.md");
    expect(codex.argv).toContain("--json"); // its events are what the usage is read from
    expect(codex.tail).toStartWith(' < "$JOB_PROMPT" | tee "$J/codex.jsonl" | jq ');
    // the tail keeps every event in codex.jsonl and writes only codex's error events to the job log; a non-JSON line does not fail it
    const j = mkdtempSync(join(tmpdir(), "jobs.codex-tail."));
    writeFileSync(join(j, "events"), '{"type":"thread.started"}\nnot json\n{"type":"turn.failed","error":{"message":"usage limit"}}\n');
    const tailRun = Bun.spawnSync(["bash", "-c", `set -o pipefail; cat${codex.tail}`], { env: { ...process.env, J: j, JOB_PROMPT: join(j, "events") } });
    expect(tailRun.exitCode).toBe(0);
    expect(tailRun.stdout.toString()).toBe("codex: usage limit\n");
    expect(readFileSync(join(j, "codex.jsonl"), "utf8")).toContain("thread.started");
    rmSync(j, { recursive: true, force: true });
    const claude = jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "claude", cwd: repo, promptFile: "/p.md", outFile: "/o.md" });
    expect(claude.argv).toContain("stream-json");
    expect(claude.tail).toContain('> "$JOB_OUT"');
    expect(claude.argv.slice(0, 3)).toEqual(["ops-kit", "heavy", "--memory-only"]);
    expect(jobCommand({ kind: "local-ci", taskId: "t1", pr: 12, cwd: repo, local: true }).argv).toEqual(["bun", "scripts/local-ci.ts", "12", "--local"]);
    expect(jobCommand(local()).argv).toEqual(["bun", "scripts/local-ci.ts", "12"]); // local CI takes its own slot: no --memory-only
    // a saved model / effort go to the CLI; empty ones leave the CLI's own
    const argvOf = (runner: "claude" | "codex", choice?: { model?: string; effort?: string }) => jobCommand({ kind: "review", taskId: "t1", pr: 12, runner, cwd: repo, promptFile: "/p.md", outFile: "/o.md" }, 900, choice).argv;
    expect(argvOf("claude", { model: "m1", effort: "high" })).toEqual(expect.arrayContaining(["--model", "m1", "--effort", "high"]));
    expect(argvOf("codex", { model: "m2", effort: "low" })).toEqual(expect.arrayContaining(["-m", "m2", "-c", 'model_reasoning_effort="low"']));
    expect(argvOf("codex", { model: "m2", effort: "low" }).at(-1)).toBe("-"); // stdin stays last
    for (const argv of [argvOf("claude"), argvOf("claude", { model: "", effort: "" }), argvOf("codex"), argvOf("codex", { model: "", effort: "" })]) {
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("--effort");
      expect(argv).not.toContain("-m");
      expect(argv.some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
    }
    expect(codex.argv.slice(6, 10)).toEqual(["ops-kit", "idle-run", "--idle", "900"]);
    // the host may need longer (SWITCHBOARD_JOB_REVIEW_IDLE_S)
    expect(jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "claude", cwd: repo, promptFile: "/p.md", outFile: "/o.md" }, 1800).argv.slice(6, 10)).toEqual(["ops-kit", "idle-run", "--idle", "1800"]);
  });

  test("review: the reviewer reads neither CLAUDE.md / AGENTS.md nor the user's MCP and skills", () => {
    const argvOf = (runner: "claude" | "codex") => jobCommand({ kind: "review", taskId: "t1", pr: 12, runner, cwd: repo, promptFile: "/p.md", outFile: "/o.md" }).argv;
    const claude = argvOf("claude");
    // the variables go in front of the command, the flags after `-p`
    expect(claude.slice(claude.indexOf("env"), claude.indexOf("claude") + 1)).toEqual(["env", "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", "claude"]);
    expect(claude).toEqual(expect.arrayContaining(["--permission-mode", "plan", "--strict-mcp-config", "--disable-slash-commands"]));
    expect(claude).not.toContain("--bare"); // it would drop the sign-in the host uses
    const codex = argvOf("codex").join(" ");
    for (const part of ["--sandbox read-only", "-c project_doc_max_bytes=0", "-c mcp_servers={}", "--disable plugins", "--disable apps"]) expect(codex).toContain(part);
    expect(codex).not.toContain("--ignore-user-config"); // the user's model choice stays
    expect(argvOf("codex").at(-1)).toBe("-");
  });

  describe("review runner from the setting", () => {
    const ask = (setting: "same" | "other", extra: { runner?: "codex" | "claude"; as?: "fallback" | "recheck" | "audit" } = {}, taskId = "t1") => {
      writeFileSync(join(repo, "prompt.md"), "review");
      const { deps, ended } = fake("true");
      const job = requestJob({ ...deps, reviewRunner: () => setting }, { kind: "review", taskId, pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md", ...extra });
      return { job, ended };
    };

    test("same: the Task's own runner reviews; another runner is refused unless the request says why", async () => {
      const none = ask("same");
      expect(none.job.runner).toBe("claude");
      await none.ended;
      const before = db.listJobs(Number.MAX_SAFE_INTEGER).length;
      expect(() => ask("same", { runner: "codex" })).toThrow("主レビュアーは claude です");
      expect(db.listJobs(Number.MAX_SAFE_INTEGER).length).toBe(before); // refused before a job is recorded
      const fallback = ask("same", { runner: "codex", as: "fallback" });
      expect(fallback.job.runner).toBe("codex");
      await fallback.ended;
    });

    test("other: the runner that did not implement reviews, and the refusal names it", async () => {
      const none = ask("other");
      expect(none.job.runner).toBe("codex");
      await none.ended;
      let refusal: unknown;
      try {
        ask("other", { runner: "claude" });
      } catch (e) {
        refusal = e;
      }
      expect(refusal).toBeInstanceOf(JobError);
      expect((refusal as JobError).status).toBe(400);
      expect((refusal as JobError).message).toContain("--runner codex");
      expect(() => ask("other", { as: "fallback" })).toThrow("runner の名指し");
      // a recheck or an audit is read by a runner that is not the main reviewer, and says so
      const audit = ask("other", { runner: "claude", as: "audit" });
      expect(audit.job.runner).toBe("claude");
      await audit.ended;
    });

    test("a Task whose runner reviews nothing must name the reviewer", async () => {
      db.insertTask({ ...mkTask("t-adk", repo), runner: "dak" });
      expect(() => ask("other", {}, "t-adk")).toThrow("主レビュアーを決められません");
      const named = ask("other", { runner: "claude" }, "t-adk");
      expect(named.job.runner).toBe("claude");
      await named.ended;
    });
  });

  describe("review prompt by runner", () => {
    test("the job reads the Task's instructions followed by the note of the runner that reviews; the Task's file stays", async () => {
      const seen: Record<string, string> = {};
      for (const runner of ["codex", "claude"] as const) {
        writeFileSync(join(repo, "prompt.md"), "Review this PR.\n");
        const { deps, ended } = fake(`cat "$JOB_PROMPT" > "$J/seen"`);
        const job = requestJob({ ...deps, reviewRunner: () => (runner === "claude" ? "same" : "other") }, { kind: "review", taskId: "t1", pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
        await ended;
        seen[runner] = readFileSync(join(root, "jobs", String(job.id), "seen"), "utf8");
        expect(readFileSync(join(repo, "prompt.md"), "utf8")).toBe("Review this PR.\n");
      }
      expect(seen.codex).toStartWith("Review this PR.\n\n");
      expect(seen.codex).toContain("read-only sandbox");
      expect(seen.codex).not.toContain("plan mode");
      expect(seen.claude).toContain("plan mode");
      expect(seen.claude).not.toContain("sandbox");
      // the rules every review is told reach the runner whole, the use of a comparison with main included
      for (const text of Object.values(seen)) expect(text).toContain("`_review/compared.md`");
    });
  });

  test("review job usage goes to the ledger under the task", async () => {
    const claudeResult = { type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.5 } } };
    const codexTurn = (i: number, c: number, o: number) => ({ type: "turn.completed", usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } });
    const jsonl = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
    const dir = join(root, "usage-dirs");
    mkdirSync(join(dir, "c"), { recursive: true });
    mkdirSync(join(dir, "x"), { recursive: true });
    writeFileSync(join(dir, "c", "claude.jsonl"), "not json\n" + jsonl({ type: "system", model: "m" }, claudeResult));
    writeFileSync(join(dir, "x", "codex.jsonl"), jsonl({ type: "thread.started" }, codexTurn(1000, 400, 50), codexTurn(500, 100, 25)));
    expect(jobUsage("claude", join(dir, "c"))).toEqual([{ t: "usage", source: "reported", model: "claude-opus-5", inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40, costUsd: 0.5 }]);
    expect(jobUsage("codex", join(dir, "x"))).toEqual([{ t: "usage", source: "reported", inputTokens: 1000, outputTokens: 75, cacheReadTokens: 500, cacheWriteTokens: 0 }]);
    expect(jobUsage("codex", join(dir, "none"))).toEqual([]);
    // through a real job: the review script leaves its events where the daemon looks; the row is the Task's, source job
    writeFileSync(join(repo, "prompt.md"), "review");
    for (const [runner, file, body] of [["claude", "claude.jsonl", jsonl(claudeResult)], ["codex", "codex.jsonl", jsonl(codexTurn(10, 4, 2))]] as const) {
      const { deps, ended } = fake(`printf '%s' '${body.replace(/'/g, "")}' > "$J/${file}"`);
      requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner, as: "fallback", cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
      await ended;
    }
    const peek = new Database(join(root, "db.sqlite"), { readonly: true });
    const ledger = () => peek.query("SELECT runner, source, input_tokens, cost_usd FROM ledger WHERE task_id = 't1' ORDER BY id").all() as { runner: string; source: string; input_tokens: number; cost_usd: number }[];
    const rows = ledger();
    expect(rows.map((r) => [r.runner, r.source, r.input_tokens])).toEqual([["claude", "job", 100], ["codex", "job", 6]]);
    expect(rows[0]!.cost_usd).toBe(0.5);
    // a review that left nothing readable books nothing and still ends
    const { deps, ended } = fake("true");
    requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "claude", as: "fallback", cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
    expect((await ended).status).toBe("pass");
    expect(ledger()).toHaveLength(2);
    peek.close();
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
  expect(d.listJobs(now - JOBS_KEEP_MS).map((j) => j.id)).toEqual([endedNow.id, running.id]);
  d.close();
});

test("pruneJobDirs removes the folders of jobs that ended more than 7 days ago; running and recent ones stay", () => {
  const d = new Db(join(root, "prune.sqlite"));
  const dir = join(root, "prune-jobs");
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const mk = () => d.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: now - 9 * day });
  const old = mk();
  d.finishJob(old.id, { status: "pass", exitCode: 0, summary: "", endedAt: now - 8 * day });
  const recent = mk();
  d.finishJob(recent.id, { status: "pass", exitCode: 0, summary: "", endedAt: now - 6 * day });
  const running = mk();
  const orphan = running.id + 100;
  for (const id of [old.id, recent.id, running.id, orphan]) {
    mkdirSync(join(dir, String(id)), { recursive: true });
    writeFileSync(join(dir, String(id), "log"), "x");
  }
  const deps = { db: d, dir, env: {}, now: () => now } as JobDeps;
  expect(pruneJobDirs(deps)).toBe(1);
  expect(existsSync(join(dir, String(old.id)))).toBe(false);
  for (const id of [recent.id, running.id, orphan]) expect(existsSync(join(dir, String(id)))).toBe(true);
  expect(d.getJob(old.id)).not.toBeNull();
  expect(pruneJobDirs({ ...deps, dir: join(root, "no-such") })).toBe(0);
  d.close();
});

test("recoverJobs collects the results left by local CI once: a local-ci job left running or a pending record, not a review or nothing", () => {
  const pendingDir = join(root, "pending-collect");
  rmSync(pendingDir, { recursive: true, force: true });
  let calls = 0;
  const deps = (): JobDeps => ({ db, dir: join(root, "jobs-collect"), env: {}, bootId: () => "boot-now", pollMs: 60_000, pendingDir, collectPending: () => { calls++; } });
  const leave = (kind: "local-ci" | "review") => {
    const j = db.insertJob({ kind, taskId: "t1", pr: 1, runner: kind === "review" ? "claude" : null, cwd: repo, startedAt: Date.now() });
    db.setJobPid(j.id, 999_999_999, "boot-now");
    return j;
  };
  const ends = (id: number) => db.finishJob(id, { status: "aborted", exitCode: null, summary: "", endedAt: Date.now() });
  // nothing left, no pending directory
  recoverJobs(deps());
  expect(calls).toBe(0);
  // a review alone does not
  const review = leave("review");
  recoverJobs(deps());
  expect(calls).toBe(0);
  ends(review.id);
  // a local-ci job left running does, once (even with a review beside it)
  const ci = leave("local-ci");
  leave("review");
  recoverJobs(deps());
  expect(calls).toBe(1);
  expect(db.getJob(ci.id)!.status).toBe("aborted");
  // a local-ci job still alive in this boot (a restart while it waits on its build) writes its own result: no collect
  const live = db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now() });
  db.setJobPid(live.id, process.pid, "boot-now");
  recoverJobs(deps());
  expect(calls).toBe(1);
  expect(db.getJob(live.id)!.status).toBe("running");
  ends(live.id);
  // an empty pending directory does not; a record in it does
  mkdirSync(pendingDir, { recursive: true });
  recoverJobs(deps());
  expect(calls).toBe(1);
  writeFileSync(join(pendingDir, "123.json"), "{}");
  recoverJobs(deps());
  expect(calls).toBe(2);
  // the path is one place for the collector to share
  expect(localCiPendingDir("/h")).toBe("/h/.cache/switchboard.local-ci-pending");
});

test("a job's end and recoverJobs prune the folder of a job that ended more than 7 days ago", async () => {
  const day = 24 * 3600 * 1000;
  const { deps, ended } = fake("exit 0");
  const oldFolder = () => {
    const j = db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now() - 9 * day });
    db.finishJob(j.id, { status: "pass", exitCode: 0, summary: "", endedAt: Date.now() - 8 * day });
    mkdirSync(join(deps.dir, String(j.id)), { recursive: true });
    return join(deps.dir, String(j.id));
  };
  const atEnd = oldFolder();
  const job = requestJob(deps, local());
  await ended;
  expect(existsSync(atEnd)).toBe(false);
  expect(existsSync(join(deps.dir, String(job.id)))).toBe(true);
  const atStart = oldFolder();
  recoverJobs(deps);
  expect(existsSync(atStart)).toBe(false);
});

describe("/api/jobs", () => {
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

  test("POST with a relative fixtures folder answers 400", async () => {
    const home = join(root, "home-fixtures");
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    const core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, jobCommand: () => ({ argv: ["true"], tail: "" }) });
    try {
      core.db.insertTask(mkTask("t8", repo));
      const r = await fetch(`http://127.0.0.1:${core.server.port}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "local-ci", taskId: "t8", pr: 5, cwd: repo, fixtures: "recordings" }) });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain("fixtures must be absolute");
    } finally {
      await core.stop();
    }
  });
});
