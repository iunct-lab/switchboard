// test-reads: scripts/merge-gate.ts
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, type Job, type JobRequest, type RunnerId, type Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { mergeRecordsOf } from "./merge-records.ts";
import { DAEMON_MERGE_GATE, deliverReview, spawnCollectPending, jobCommand, JobError, reviewResult, auditResult, arbiterResult, JOBS_KEEP_MS, type JobDeps, type ResolvedJobRequest, jobUsage, pruneJobDirs, localCiPendingDir, recoverJobs, requestJob, sameRepository } from "./jobs.ts";
import { fakeAdapter } from "./api-test-harness.ts";
import { startServer } from "./server.ts";
import { runnerChoice } from "./server/routing.ts";
import { setupJobs } from "./server/setup.ts";
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
  // the Task works in a worktree of its own; `repo` stands for a review's separate checkout (a reviewer may write there)
  sh(repo, "git", "worktree", "add", "-q", "--detach", join(root, "task"));
  db = new Db(join(root, "db.sqlite"));
  db.insertTask(mkTask("t1", join(root, "task")));
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A database whose registered workspace (a clone of the repository above) has stored PR `pr` in `state`; `put` replaces what is stored. */
function dbWithStoredPr(file: string, pr: number) {
  const db2 = new Db(join(root, file));
  db2.insertTask(mkTask("t1", join(root, "task")));
  const clone = join(root, `${file}-clone`);
  mkdirSync(clone);
  sh(clone, "git", "init", "-q");
  sh(clone, "git", "remote", "add", "origin", ORIGIN);
  const source = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } } as const;
  const ws = db2.upsertWorkspace({ name: "app", path: clone, kind: "repo" });
  db2.setWorkspaceBacklogSource(ws.id, source);
  let at = 1000;
  const put = (state: "OPEN" | "MERGED") => db2.putBacklogSnapshot(source, { records: [{ objectKind: "pull-request", externalId: `PR_${pr}`, fetchState: "fetched", remote: { number: pr, state, isDraft: false, labels: [], closes: [], mergeCommit: null, updatedAt: "2026-10-02T00:00:00Z", files: [], closedAt: null, mergedAt: state === "MERGED" ? "2026-10-02T00:00:00Z" : null, head: null } }], cursor: null, syncedAt: (at += 1000) });
  return { db: db2, put };
}

/** Deps whose command is `script` and whose finish resolves `ended`. */
function fake(script: string) {
  let done!: (j: Job) => void;
  const ended = new Promise<Job>((r) => (done = r));
  const deps: JobDeps = { db, dir: join(root, "jobs"), env: { ...process.env, SWITCHBOARD_TASK_ID: "t1", SWITCHBOARD_SUPERVISED: "1" }, command: () => ({ argv: ["sh", "-c", script], tail: "" }), onFinish: done, pollMs: 50, claudeSandbox: () => true };
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

  test("a gate job runs the daemon's own merge-gate and records the judgement", async () => {
    const H = "d".repeat(40);
    const gate = (over: Partial<Extract<JobRequest, { kind: "gate" }>> = {}): Extract<JobRequest, { kind: "gate" }> => ({ kind: "gate", taskId: "t1", cwd: repo, pr: 7, ...over });
    // the command is the daemon's own script (inside the code this daemon runs, not the Task's checkout), the number and the flags only; the verdict goes to $J/out
    expect(DAEMON_MERGE_GATE.startsWith(join(import.meta.dir, "../../.."))).toBe(true);
    expect(DAEMON_MERGE_GATE.startsWith(repo)).toBe(false);
    expect(jobCommand({ ...gate(), cwd: repo })).toEqual({ argv: ["bun", "--no-env-file", DAEMON_MERGE_GATE, "7", "--cwd", repo], tail: ' > "$J/out"' });
    expect(jobCommand({ ...gate({ repo: "acme/lib", allowLarge: true, merge: "merge-stack" }), cwd: repo }).argv).toEqual(["bun", "--no-env-file", DAEMON_MERGE_GATE, "7", "--repo", "acme/lib", "--allow-large", "--merge-stack", "--cwd", repo]);
    expect(jobCommand({ ...gate({ change: true, scope: true }), cwd: repo }).argv).toEqual(["bun", "--no-env-file", DAEMON_MERGE_GATE, "--change", "7", "--scope", "--cwd", repo]);
    expect(jobCommand({ ...gate({ viewpoints: true }), cwd: repo }).argv).toEqual(["bun", "--no-env-file", DAEMON_MERGE_GATE, "7", "--viewpoints", "--cwd", repo]);

    // a run in the job's environment: the daemon's own place for its records, nothing of the Task's or of the shell's that reaches the front of gh
    const run = async (script: string, req = gate(), env: Record<string, string> = {}) => {
      const { deps, ended } = fake(script);
      deps.app = () => ({ url: "http://127.0.0.1:47000", tokenFile: join(root, "daemon-token") });
      deps.env = { ...deps.env, ...env };
      const job = requestJob(deps, req);
      return { job, end: await ended };
    };
    const poison = { MERGE_RECORDS_URL: "http://evil.test", MERGE_RECORDS_TOKEN_FILE: "/evil/key", BACKLOG_URL: "http://evil.test/api/backlog", BACKLOG_TOKEN_FILE: "/evil/key", OPS_MERGE_GATE_PR: "7", GH_REPO: "evil/repo" };
    const { job, end } = await run(`env > "$J/env"; printf '{"head":"${H}","verdict":"stop","ask":["security:gates"],"recheck":["size"],"required":["size","rescue"],"reasons":["a","b"],"allowLarge":false,"reviewSkipped":true,"merged":false}' > "$J/result.json"; echo verdict > "$J/out"; exit 1`, gate(), poison);
    // the request had no head to record (the checkout's HEAD is not the PR's); the run's is
    expect(job).toMatchObject({ kind: "gate", pr: 7, head: null, runner: null, repo: "acme/app" });
    expect(end).toMatchObject({ status: "fail", exitCode: 1, head: H, result: { gate: { verdict: "stop", head: H, ask: ["security:gates"], recheck: ["size"], required: ["size", "rescue"], reasons: ["a", "b"], allowLarge: false, reviewSkipped: true, merged: false } } });
    const env = readFileSync(join(root, "jobs", String(job.id), "env"), "utf8");
    expect(env).toContain("MERGE_RECORDS_URL=http://127.0.0.1:47000\n");
    expect(env).toContain(`MERGE_RECORDS_TOKEN_FILE=${join(root, "daemon-token")}\n`);
    expect(env).toContain("OPS_KIT_TASK_ID=t1\n");
    for (const k of ["BACKLOG_URL", "BACKLOG_TOKEN_FILE", "OPS_MERGE_GATE_PR", "GH_REPO", "SWITCHBOARD_TASK_ID", "SWITCHBOARD_SUPERVISED"]) expect(env).not.toMatch(new RegExp(`^${k}=`, "m"));
    expect(readFileSync(join(root, "jobs", String(job.id), "out"), "utf8")).toBe("verdict\n");
    // a PR of another repository is recorded under it (lower case, as the records are read); a run that judged nothing (exit 2) leaves no result
    const none = await run("exit 2", gate({ repo: "Acme/Lib" }));
    expect(none.job.repo).toBe("acme/lib");
    expect(none.end).toMatchObject({ status: "fail", exitCode: 2, head: null, result: null });
    expect((await run(`echo '{"head":"short"}' > "$J/result.json"`)).end).toMatchObject({ head: null, result: null });
    // a gate job the release before this one started: its record has no `required`, and is kept with none (absent, so the audit reads its reasons)
    const older = await run(`printf '{"head":"${H}","verdict":"merge","ask":[],"recheck":[],"reasons":[],"allowLarge":false,"reviewSkipped":false,"merged":true}' > "$J/result.json"`);
    expect(older.end.result!.gate).toMatchObject({ verdict: "merge" });
    expect("required" in older.end.result!.gate!).toBe(false);
    // the reasons kept are bounded
    const long = await run(`printf '{"head":"${H}","verdict":"merge","ask":[],"recheck":[],"required":[],"reasons":["%s"],"allowLarge":true,"reviewSkipped":false,"merged":true}' "$(head -c 900 /dev/zero | tr '\\0' x)" > "$J/result.json"`);
    expect(long.end.result!.gate!.reasons[0]!.length).toBe(500);
    expect(long.end.result!.gate).toMatchObject({ verdict: "merge", allowLarge: true, merged: true });

    // a change is read from the app as `ops-kit backlog view --change` reads it: that is the one place the daemon's backlog address goes (it only judges)
    const dir = join(root, "gate-ws");
    mkdirSync(dir);
    sh(dir, "git", "init", "-q");
    sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
    sh(dir, "git", "remote", "add", "origin", "https://github.com/acme/gate-ws.git");
    const db4 = new Db(join(root, "db4.sqlite"));
    try {
      const ws = db4.upsertWorkspace({ name: "gate-ws", path: dir, kind: "repo" });
      db4.insertTask(mkTask("g1", dir));
      const f = fake(`env > "$J/env"`);
      const deps: JobDeps = { ...f.deps, db: db4, app: () => ({ url: "http://127.0.0.1:47000", tokenFile: "/daemon/key" }) };
      const ch = requestJob(deps, { kind: "gate", taskId: "g1", cwd: dir, pr: 3, change: true });
      await f.ended;
      expect(ch.repo).toBe(`local:${ws.id}`);
      const chEnv = readFileSync(join(root, "jobs", String(ch.id), "env"), "utf8");
      expect(chEnv).toContain("BACKLOG_URL=http://127.0.0.1:47000/api/backlog\n");
      expect(chEnv).toContain("BACKLOG_TOKEN_FILE=/daemon/key\n");
      expect(chEnv).toContain(`BACKLOG_WORKSPACE=${ws.id}\n`);
      // a change takes no repository and no merge; a daemon that cannot say where its records are runs none
      for (const bad of [{ change: true, repo: "acme/lib" }, { change: true, merge: "merge" as const }, { scope: true, merge: "merge" as const }]) {
        expect(() => requestJob(deps, { kind: "gate", taskId: "g1", cwd: dir, pr: 3, ...bad })).toThrow(JobError);
      }
      expect(() => requestJob({ ...deps, app: undefined }, { kind: "gate", taskId: "g1", cwd: dir, pr: 3 })).toThrow("記録の場所");
    } finally {
      db4.close();
    }
  });

  test("a local-ci job records the outcome, the head and the base its run wrote", async () => {
    const H = "a".repeat(40);
    const B = "b".repeat(40);
    // the run leaves the file in its own folder as scripts/local-ci.ts does; a fail exits 1 and still records its outcome
    const run = async (script: string) => {
      const { deps, ended } = fake(script);
      requestJob(deps, local());
      return ended;
    };
    const pass = await run(`printf '{"head":"${H}","base":"${B}","ci":{"outcome":"pass","stepsHash":"h1"}}' > "$J/result.json"`);
    expect(pass).toMatchObject({ status: "pass", head: H, base: B, result: { ci: { outcome: "pass", stepsHash: "h1" } } });
    const fail = await run(`printf '{"head":"${H}","base":"${B}","ci":{"outcome":"fail"}}' > "$J/result.json"; exit 1`);
    expect(fail).toMatchObject({ status: "fail", head: H, base: B, result: { ci: { outcome: "fail" } } });
    // a run that wrote nothing (it never reached the post, or the head moved) has no result; a file that cannot be read gives none either
    expect(await run("exit 0")).toMatchObject({ status: "pass", head: null, base: null, result: null });
    expect(await run(`echo 'not json' > "$J/result.json"`)).toMatchObject({ result: null });
  });

  test("a result collected after the daemon restarted is taken into the aborted job", () => {
    const dir = join(root, "jobs-late");
    rmSync(dir, { recursive: true, force: true });
    // the collect is a detached process the daemon does not wait for: it tells when it has ended
    let collected: (() => void) | null = null;
    const deps: JobDeps = { db, dir, env: {}, bootId: () => "boot-now", pollMs: 60_000, pendingDir: join(root, "no-pending"), collectPending: (done) => { collected = done; } };
    const ask = (kind: "local-ci" | "review") => {
      const j = db.insertJob({ kind, taskId: "t1", pr: 1, runner: kind === "review" ? "claude" : null, cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
      db.setJobPid(j.id, 999_999_999, "boot-now");
      return j;
    };
    const ci = ask("local-ci");
    const review = ask("review");
    recoverJobs(deps);
    // the build outlived the daemon: both ended aborted, with no result
    expect(db.getJob(ci.id)).toMatchObject({ status: "aborted", result: null, head: null });
    expect(collected).not.toBeNull();
    // `--collect` writes the result to the job's own folder after the daemon has started, and ends: no restart is needed
    const write = (id: number, head: string, outcome: string) => {
      mkdirSync(join(dir, String(id)), { recursive: true });
      writeFileSync(join(dir, String(id), "result.json"), JSON.stringify({ head, base: "d".repeat(40), ci: { outcome } }));
    };
    write(ci.id, "c".repeat(40), "pass");
    write(review.id, "c".repeat(40), "pass");
    collected!();
    expect(db.getJob(ci.id)).toMatchObject({ status: "aborted", head: "c".repeat(40), base: "d".repeat(40), result: { ci: { outcome: "pass" } } });
    expect(db.getJob(review.id)!.result).toBeNull();
    // a job that already has its result keeps it
    write(ci.id, "e".repeat(40), "fail");
    collected!();
    expect(db.getJob(ci.id)!.head).toBe("c".repeat(40));
  });

  test("spawnCollectPending tells when the collect process has ended", async () => {
    const empty = mkdtempSync(join(root, "no-script-"));
    const ended = new Promise<void>((r) => spawnCollectPending(empty, { PATH: process.env.PATH }, join(root, "collect.log"), r));
    await ended;
  });

  test("a result whose head or base is not a commit id is no result", async () => {
    const run = async (head: string, base: string) => {
      const { deps, ended } = fake(`printf '{"head":"${head}","base":"${base}","ci":{"outcome":"pass"}}' > "$J/result.json"`);
      requestJob(deps, local());
      return ended;
    };
    expect(await run("a".repeat(40), "b".repeat(40))).toMatchObject({ result: { ci: { outcome: "pass" } } });
    for (const [h, b] of [["main", "b".repeat(40)], ["a".repeat(40), "../x"], ["A".repeat(40), "b".repeat(40)], ["a".repeat(39), "b".repeat(40)]]) expect(await run(h!, b!)).toMatchObject({ head: null, base: null, result: null });
  });

  test("the tag CI job's argv is Switchboard's scripts/tag-ci.ts run for the head it was asked for, with --repo for another repository's checkout; the app's job needs a registered workspace and the reserved taskId is no request's", () => {
    const req = { kind: "tag-ci", taskId: "app", cwd: repo } as const;
    const head = "a".repeat(40);
    expect(jobCommand({ ...req, head, other: { script: "/sb/scripts/tag-ci.ts", repo: "" } }).argv).toEqual(["bun", "/sb/scripts/tag-ci.ts", "--sha", head]);
    expect(jobCommand({ ...req, head, other: { script: "/sb/scripts/tag-ci.ts", repo: "acme/other" } }).argv).toEqual(["bun", "/sb/scripts/tag-ci.ts", "--sha", head, "--repo", "acme/other"]);
    // the repository above is not a registered workspace of `db`
    expect(() => requestJob(fake("true").deps, req, { app: true })).toThrow("not a checkout");
    expect(() => requestJob(fake("true").deps, req)).toThrow("予約");
  });

  test("a change's repository is recorded in lower case, as the records are read, so a workspace id with capitals still finds its jobs", () => {
    const dir = join(root, "chg-upper");
    mkdirSync(dir);
    sh(dir, "git", "init", "-q");
    sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
    sh(dir, "git", "remote", "add", "origin", "https://github.com/acme/switchboard.git");
    const db4 = new Db(join(root, "db4.sqlite"));
    try {
      const ws = db4.upsertWorkspace({ name: "switchboard", path: dir, kind: "meta", id: "ws_UpperCase" });
      db4.insertTask(mkTask("c-up", dir));
      const job = requestJob({ ...fake("true").deps, db: db4, command: () => ({ argv: ["true"], tail: "" }) }, { kind: "local-ci", taskId: "c-up", pr: 7, cwd: dir, change: true });
      expect(job.repo).toBe("local:ws_uppercase");
      expect(mergeRecordsOf(db4, { repo: `local:${ws.id}`, prs: [7] }).jobs.map((j) => j.id)).toEqual([job.id]);
    } finally {
      db4.close();
    }
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

  test("a review job records the head of its checkout and the findings of its output", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    const out = ["[codex] review", "", "### Findings", "- [blocker] `a/b.ts:12` — x.", "- [should-fix] `c.ts:3-9` — y.", "- [nit] `d.ts:1` — z.", "", "### Verdict", "- [blocker] `not/counted.ts:1` — after the section"].join("\n");
    const { deps, ended } = fake(`printf '%s\n' "$FINDINGS" > "$JOB_OUT"`);
    deps.env = { ...deps.env, FINDINGS: out };
    const job = requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "prompt.md", outFile: "out-findings.md" });
    expect(job).toMatchObject({ repo: "acme/app", head, as: null, kinds: [], result: null });
    await ended;
    expect(db.getJob(job.id)).toMatchObject({
      head,
      result: { review: { firstLine: "[codex] review", findings: [{ severity: "blocker", path: "a/b.ts", line: 12 }, { severity: "should-fix", path: "c.ts", line: 3 }, { severity: "nit", path: "d.ts", line: 1 }] } },
    });
    // a job's row is how a verdict finds it: by repository and PR, and by when it started
    expect(db.jobsOf("acme/app", [12]).map((j) => j.id)).toContain(job.id);
    expect(db.jobsOf("acme/app", [13])).toEqual([]);
    expect(db.jobsOf("other/app", [12]).map((j) => j.id)).not.toContain(job.id);
    expect(db.jobsSince("acme/app", 0).map((j) => j.id)).toContain(job.id);
    expect(db.jobsSince("acme/app", Date.now() + 60_000)).toEqual([]);
  });

  test("a recheck job records its kind and the head of its checkout", async () => {
    // a checkout of its own: the shared one holds the files other tests left
    const repo = join(root, "recheck-repo");
    mkdirSync(repo);
    sh(repo, "git", "init", "-q");
    sh(repo, "git", "remote", "add", "origin", ORIGIN);
    sh(repo, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
    db.insertTask(mkTask("t-recheck", repo));
    const rev = () => Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    const ask = () => requestJob(deps, { kind: "recheck", taskId: "t-recheck", pr: 12, cwd: repo, recheck: "migration" });
    const { deps, ended } = fake("true");
    // the repository has no scripts/recheck.ts: refused, nothing recorded
    const before = db.listJobs(0).length;
    expect(ask).toThrow("scripts/recheck.ts");
    expect(db.listJobs(0).length).toBe(before);
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts/recheck.ts"), "");
    try {
      // an untracked or modified file would make the code that runs differ from the head that is recorded: refused
      expect(ask).toThrow("未コミット");
      expect(db.listJobs(0).length).toBe(before);
      sh(repo, "git", "add", "scripts/recheck.ts");
      sh(repo, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "recheck script");
      const head = rev();
      const job = ask();
      expect(job).toMatchObject({ kind: "recheck", repo: "acme/app", head, as: null, kinds: ["migration"] });
      await ended;
      writeFileSync(join(repo, "scripts/recheck.ts"), "// changed");
      expect(ask).toThrow("未コミット");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    // the argv is the app's: the kind and the recorded head, in a heavy slot
    expect(jobCommand({ kind: "recheck", taskId: "t1", pr: 12, cwd: repo, recheck: "security:lockfile", head: "abc" }).argv).toEqual(["ops-kit", "heavy", "--", "bun", "scripts/recheck.ts", "security:lockfile", "--head", "abc"]);
  });

  test("a recheck of a workspace that takes in someone else's updates is refused", () => {
    const dir = join(root, "theirs-recheck");
    mkdirSync(dir);
    sh(dir, "git", "init", "-q");
    sh(dir, "git", "remote", "add", "origin", "https://github.com/acme/theirs-recheck.git");
    const db2 = new Db(join(root, "db-recheck.sqlite"));
    try {
      db2.upsertWorkspace({ name: "theirs-recheck", path: dir, kind: "repo", upstream: "https://github.com/else/theirs-recheck.git" });
      db2.insertTask(mkTask("t-rc", dir));
      expect(() => requestJob({ ...fake("true").deps, db: db2 }, { kind: "recheck", taskId: "t-rc", pr: 7, cwd: dir, recheck: "migration" })).toThrow("他者のリポジトリ");
    } finally {
      db2.close();
    }
  });

  test("a review whose output has no Findings section records no result", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const { deps, ended } = fake(`echo "looks fine" > "$JOB_OUT"`);
    const job = requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "prompt.md", outFile: "out-none.md" });
    await ended;
    expect(db.getJob(job.id)).toMatchObject({ status: "pass", result: null });
    expect(reviewResult("a\n### Verdict\nok")).toBeNull();
    expect(reviewResult("a\n### Findings\n- none\n")).toEqual({ findings: [], firstLine: "a" });
  });

  test("an audit job (as audit) keeps the first line of its output, which has no Findings section; another review's such output records none", async () => {
    writeFileSync(join(repo, "prompt.md"), "audit");
    const audits = dbWithStoredPr("audit-first-line.sqlite", 12);
    audits.put("MERGED");
    const run = async (extra: { as?: "audit"; runner: "claude" | "codex" }, name: string) => {
      const { deps, ended } = fake(`printf '\\npass\\n' > "$JOB_OUT"`);
      const job = requestJob({ ...deps, db: audits.db }, { kind: "review", taskId: "t1", pr: 12, cwd: repo, promptFile: "prompt.md", outFile: name, ...extra });
      await ended;
      return audits.db.getJob(job.id)!;
    };
    expect((await run({ as: "audit", runner: "claude" }, "out-audit.md")).result).toEqual({ review: { findings: [], firstLine: "pass" } });
    expect((await run({ runner: "codex" }, "out-plain.md")).result).toBeNull();
    audits.db.close();
    expect(auditResult("\n  finding  \n- a.ts:1 x")).toEqual({ findings: [], firstLine: "finding" });
    expect(auditResult("\n \n")).toBeNull();
  });

  test("a failed review records no result, and a recheck without kinds is recorded with none while a word that is not a recheck kind is refused", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const { deps, ended } = fake(`printf '### Findings\n- [blocker] \`a.ts:1\` — x\n' > "$JOB_OUT"; exit 1`);
    const job = requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "prompt.md", outFile: "out-fail.md" });
    await ended;
    expect(db.getJob(job.id)).toMatchObject({ status: "fail", result: null });
    const recheck = (kinds?: string[]) => requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "claude", as: "recheck", kinds, cwd: repo, promptFile: "prompt.md", outFile: "out-r.md" });
    expect(recheck()).toMatchObject({ as: "recheck", kinds: [] });
    expect(recheck(["size"])).toMatchObject({ as: "recheck", kinds: ["size"] });
    expect(() => recheck(["no-such-kind"])).toThrow("知らない種類");
    expect(() => requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", kinds: ["size"], cwd: repo, promptFile: "prompt.md", outFile: "out-r.md" })).toThrow("as: recheck");
  });

  test("a request for a change the app holds records the workspace as its repository and runs the checkout's script with --change; --local and a checkout no workspace owns are refused; another registered repository's checkout runs Switchboard's script in its folder", async () => {
    const mk = (name: string, origin: string | null) => {
      const dir = join(root, name);
      mkdirSync(dir);
      sh(dir, "git", "init", "-q");
      sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
      if (origin) sh(dir, "git", "remote", "add", "origin", origin);
      return dir;
    };
    const reviewTree = (dir: string) => {
      const tree = `${dir}-review`;
      sh(dir, "git", "worktree", "add", "-q", "--detach", tree);
      writeFileSync(join(tree, "prompt.md"), "review");
      return tree;
    };
    const [metaDir, libDir, freeDir] = [mk("chg-meta", "https://github.com/acme/switchboard.git"), mk("chg-lib", "git@github.com:acme/lib.git"), mk("chg-free", "https://github.com/acme/free.git")];
    const db3 = new Db(join(root, "db3.sqlite"));
    try {
      const metaWs = db3.upsertWorkspace({ name: "switchboard", path: metaDir, kind: "meta" });
      const libWs = db3.upsertWorkspace({ name: "lib", path: libDir, kind: "repo" });
      for (const [id, cwd] of [["c-meta", metaDir], ["c-lib", libDir], ["c-free", freeDir]] as const) db3.insertTask(mkTask(id, cwd));
      const got: Parameters<NonNullable<JobDeps["command"]>>[0][] = [];
      const deps: JobDeps = { ...fake("true").deps, db: db3, command: (req) => (got.push(req), { argv: ["true"], tail: "" }) };
      const ci = requestJob(deps, { kind: "local-ci", taskId: "c-meta", pr: 7, cwd: metaDir, change: true });
      expect(ci.repo).toBe(`local:${metaWs.id}`);
      expect(jobCommand(got.at(-1)!).argv).toEqual(["bun", "scripts/local-ci.ts", "--change", "7"]);
      // a review reads a worktree of its own, not the workspace's checkout (the reviewer may write in it)
      const review = requestJob(deps, { kind: "review", taskId: "c-meta", pr: 7, runner: "codex", cwd: reviewTree(metaDir), promptFile: "prompt.md", outFile: "out.md", change: true });
      expect(review.repo).toBe(`local:${metaWs.id}`);
      const refused = (req: JobRequest) => {
        try {
          requestJob(deps, req);
        } catch (e) {
          return e as JobError;
        }
        throw new Error("was not refused");
      };
      const localCi = refused({ kind: "local-ci", taskId: "c-meta", pr: 7, cwd: metaDir, change: true, local: true });
      expect([localCi.status, localCi.message]).toEqual([400, expect.stringContaining("--local")]);
      // another registered repository's checkout: it has no script of its own, so Switchboard's runs from its folder in that checkout, as a person runs it by hand (no --repo), and the record is that workspace's
      const lib = requestJob(deps, { kind: "local-ci", taskId: "c-lib", pr: 7, cwd: libDir, change: true });
      expect(lib.repo).toBe(`local:${libWs.id.toLowerCase()}`);
      expect(jobCommand(got.at(-1)!).argv).toEqual(["bun", join(metaDir, "scripts/local-ci.ts"), "--change", "7"]);
      expect(got.at(-1)!.cwd).toBe(libDir);
      // a review of a change in a checkout no workspace owns has no repository to record
      const free = refused({ kind: "review", taskId: "c-free", pr: 7, runner: "codex", cwd: reviewTree(freeDir), promptFile: "prompt.md", outFile: "out.md", change: true });
      expect([free.status, free.message]).toEqual([400, expect.stringContaining("workspace")]);
    } finally {
      db3.close();
    }
  });

  test("every severity-marked line of the Findings section is kept, one whose place cannot be read with an empty path and line 0", () => {
    expect(reviewResult(["x", "### Findings", "- [should-fix] `a.ts:4` — ok", "- [blocker] the place is not named", "- [nit] `no-line.ts` — y", "- none"].join("\n"))).toEqual({
      findings: [{ severity: "should-fix", path: "a.ts", line: 4 }, { severity: "blocker", path: "", line: 0 }, { severity: "nit", path: "", line: 0 }],
      firstLine: "x",
    });
    expect(reviewResult("x\n### Findings\n- none")!.findings).toEqual([]);
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
    const codex = jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "/p.md", outFile: "/o.md", tmpDir: "/t" });
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
    const claude = jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "claude", cwd: repo, promptFile: "/p.md", outFile: "/o.md", tmpDir: "/t" });
    expect(claude.argv).toContain("stream-json");
    expect(claude.tail).toContain('> "$JOB_OUT"');
    expect(claude.argv.slice(0, 3)).toEqual(["ops-kit", "heavy", "--memory-only"]);
    expect(jobCommand({ kind: "local-ci", taskId: "t1", pr: 12, cwd: repo, local: true }).argv).toEqual(["bun", "scripts/local-ci.ts", "12", "--local"]);
    expect(jobCommand(local()).argv).toEqual(["bun", "scripts/local-ci.ts", "12"]); // local CI takes its own slot: no --memory-only
    // a saved model / effort go to the CLI; empty ones leave the CLI's own
    const argvOf = (runner: "claude" | "codex", choice?: { model?: string; effort?: string }) => jobCommand({ kind: "review", taskId: "t1", pr: 12, runner, cwd: repo, promptFile: "/p.md", outFile: "/o.md", tmpDir: "/t" }, 900, choice).argv;
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
    expect(jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "claude", cwd: repo, promptFile: "/p.md", outFile: "/o.md", tmpDir: "/t" }, 1800).argv.slice(6, 10)).toEqual(["ops-kit", "idle-run", "--idle", "1800"]);
  });

  test("a review's checkout is neither the Task's own folder, a registered workspace's checkout nor another live Task's folder, nor a folder in them, by their real paths", () => {
    const dir = join(root, "own");
    mkdirSync(join(dir, "sub"), { recursive: true });
    sh(dir, "git", "init", "-q");
    sh(dir, "git", "remote", "add", "origin", ORIGIN);
    sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
    const ws = join(root, "own-ws");
    sh(dir, "git", "worktree", "add", "-q", "--detach", ws);
    mkdirSync(join(ws, "deep"));
    symlinkSync(dir, join(root, "own-link"));
    const db6 = new Db(join(root, "db6.sqlite"));
    try {
      db6.insertTask(mkTask("t-own", dir));
      db6.upsertWorkspace({ name: "own", path: ws, kind: "repo" });
      const deps = { ...fake("true").deps, db: db6 };
      const ask = (cwd: string) => {
        writeFileSync(join(cwd, "prompt.md"), "review");
        return () => requestJob(deps, { kind: "review", taskId: "t-own", pr: 12, runner: "codex", cwd, promptFile: "prompt.md", outFile: "out.md" });
      };
      for (const cwd of [dir, join(dir, "sub"), join(root, "own-link"), ws, join(ws, "deep")]) {
        expect(ask(cwd)).toThrow("--cwd");
        expect(existsSync(join(cwd, "_review"))).toBe(false);
      }
      // a separate checkout of the same repository is the reviewer's to write in
      expect(ask(repo)().runner).toBe("codex");
      // unless a Task not ended works there; one that has ended does not keep it
      db6.insertTask({ ...mkTask("t-other", repo), status: "waiting" });
      expect(ask(repo)).toThrow("--cwd");
      db6.updateTask("t-other", { status: "done" });
      expect(ask(repo)().runner).toBe("codex");
      // a live Task in a folder in no git working tree (a broad folder holding the checkout) does not refuse it
      db6.insertTask({ ...mkTask("t-broad", root), status: "idle" });
      expect(ask(repo)().runner).toBe("codex");
      // one in a git working tree that holds the checkout does
      const outer = join(root, "outer");
      const nested = join(outer, "rv");
      mkdirSync(nested, { recursive: true });
      sh(outer, "git", "init", "-q");
      sh(nested, "git", "init", "-q");
      sh(nested, "git", "remote", "add", "origin", ORIGIN);
      sh(nested, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
      expect(ask(nested)().runner).toBe("codex");
      // a live Task in a folder below a working tree's top protects that whole working tree
      mkdirSync(join(nested, "pkg"));
      db6.insertTask({ ...mkTask("t-pkg", join(nested, "pkg")), status: "running" });
      expect(ask(nested)).toThrow("--cwd");
      db6.updateTask("t-pkg", { status: "done" });
      expect(ask(nested)().runner).toBe("codex");
      db6.insertTask({ ...mkTask("t-outer", outer), status: "running" });
      expect(ask(nested)).toThrow("--cwd");
    } finally {
      db6.close();
    }
  });

  test("a reviewer writes its output in the job's folder; the daemon copies it to outFile at the end, not through a link or a hard link put there meanwhile", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const victim = join(root, "victim-out.md");
    const run = async (name: string, meanwhile: string) => {
      writeFileSync(victim, "keep\n");
      rmSync(join(repo, name), { force: true });
      const { deps, ended } = fake(`printf 'the review\n' > "$JOB_OUT"; ${meanwhile}`);
      let got: ResolvedJobRequest | undefined;
      const job = requestJob({ ...deps, env: { ...deps.env, VICTIM: victim }, command: (r) => ((got = r), { argv: ["sh", "-c", `printf 'the review\n' > "$JOB_OUT"; ${meanwhile}`], tail: "" }) }, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "prompt.md", outFile: name });
      const end = await ended;
      const J = join(root, "jobs", String(job.id));
      expect(got!.kind === "review" && got!.outFile).toBe(join(J, "out.md")); // what Codex's -o names: a file the reviewer cannot write
      return { end, J, log: readFileSync(join(J, "log"), "utf8") };
    };
    const plain = await run("out-plain.md", "true");
    expect(readFileSync(join(repo, "out-plain.md"), "utf8")).toBe("the review\n");
    expect(plain.log).not.toContain("not copied");
    // the reviewer made the place a link to a file outside the checkout: the copy replaces the link, nothing is written through it
    await run("out-linked.md", `ln -sf "$VICTIM" out-linked.md`);
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
    expect(lstatSync(join(repo, "out-linked.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(repo, "out-linked.md"), "utf8")).toBe("the review\n");
    // a hard link to that file: the copy replaces the name, the file outside stays as it was
    await run("out-hard.md", `ln -f "$VICTIM" out-hard.md`);
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
    expect(readFileSync(join(repo, "out-hard.md"), "utf8")).toBe("the review\n");
    expect(readdirSync(repo).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a folder on the way to outFile swapped for a link to outside the checkout is not written through", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const outside = join(root, "outside-dir");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(repo, "swap"), { recursive: true });
    const { deps, ended } = fake(`printf 'the review\n' > "$JOB_OUT"; rm -rf swap; ln -s "$OUTSIDE" swap`);
    const job = requestJob({ ...deps, env: { ...deps.env, OUTSIDE: outside } }, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "prompt.md", outFile: "swap/out.md" });
    const end = await ended;
    expect(readdirSync(outside)).toEqual([]);
    expect(end.status).toBe("pass");
    expect(readFileSync(join(root, "jobs", String(job.id), "log"), "utf8")).toContain("not inside the checkout");
    rmSync(join(repo, "swap"));
  });

  test("the copy reads where the folder it entered really is: a link to a folder outside is refused, one to a folder inside is followed", () => {
    const outside = join(root, "outside-direct");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(repo, "inner"), { recursive: true });
    symlinkSync(outside, join(repo, "to-outside"));
    symlinkSync(join(repo, "inner"), join(repo, "to-inner"));
    const J = join(root, "deliver-direct");
    mkdirSync(J, { recursive: true });
    writeFileSync(join(J, "out.md"), "the review\n");
    const job = { id: 999, cwd: repo } as Job;
    try {
      writeFileSync(join(J, "out-path"), join(repo, "to-outside", "out.md"));
      deliverReview(job, J);
      expect(readdirSync(outside)).toEqual([]);
      expect(readFileSync(join(J, "log"), "utf8")).toContain("not inside the checkout");
      writeFileSync(join(J, "out-path"), join(repo, "to-inner", "out.md"));
      deliverReview(job, J);
      expect(readFileSync(join(repo, "inner", "out.md"), "utf8")).toBe("the review\n");
    } finally {
      for (const f of ["to-outside", "to-inner", "inner"]) rmSync(join(repo, f), { recursive: true, force: true });
    }
  });

  test("the copy does not read a bunfig.toml (a preload is code) or a .env left in the folder of outFile", () => {
    const folder = join(repo, "planted");
    mkdirSync(folder, { recursive: true });
    const marker = join(root, "planted-preload-ran");
    // were they read, the preload would run outside any sandbox and write outside the checkout, with the .env's variable
    writeFileSync(join(folder, "x.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.env.PLANTED));\n`);
    writeFileSync(join(folder, "bunfig.toml"), 'preload = ["./x.js"]\n');
    writeFileSync(join(folder, ".env"), "PLANTED=from-env\n");
    const J = join(root, "deliver-planted");
    mkdirSync(J, { recursive: true });
    writeFileSync(join(J, "out.md"), "the review\n");
    writeFileSync(join(J, "out-path"), join(folder, "out.md"));
    try {
      deliverReview({ id: 998, cwd: repo } as Job, J);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(folder, "out.md"), "utf8")).toBe("the review\n");
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  });

  test("a folder already at the copy's temporary name leaves the folder, says so in the log and still ends the job", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const { deps, ended } = fake(`printf 'the review\n' > "$JOB_OUT"; mkdir ".out-taken.md.job$(basename "$J").tmp"`);
    const job = requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: repo, promptFile: "prompt.md", outFile: "out-taken.md" });
    const end = await ended;
    const tmpName = join(repo, `.out-taken.md.job${job.id}.tmp`);
    expect(end.status).toBe("pass");
    expect(db.getJob(job.id)!.status).toBe("pass");
    expect(lstatSync(tmpName).isDirectory()).toBe(true);
    expect(existsSync(join(repo, "out-taken.md"))).toBe(false);
    expect(readFileSync(join(root, "jobs", String(job.id), "log"), "utf8")).toContain("the output was not copied");
    rmSync(tmpName, { recursive: true });
  });

  test("whether Claude Code's sandbox can start is read on the PATH the job itself gets", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const { deps, ended } = fake('printf %s "$PATH" > "$J/path"');
    let seen: string | undefined;
    const job = requestJob({ ...deps, env: { ...deps.env, PATH: `/sandbox-probe:${deps.env.PATH}` }, reviewRunner: () => "same", claudeSandbox: (path) => ((seen = path), true) }, { kind: "review", taskId: "t1", pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
    await ended;
    expect(seen).toStartWith("/sandbox-probe:");
    expect(seen).toBe(readFileSync(join(root, "jobs", String(job.id), "path"), "utf8"));
  });

  test("a refused review makes nothing in its checkout; the sandbox's paths are real paths", () => {
    const empty = join(root, "no-head");
    mkdirSync(empty);
    sh(empty, "git", "init", "-q");
    sh(empty, "git", "remote", "add", "origin", ORIGIN);
    writeFileSync(join(empty, "prompt.md"), "review");
    expect(() => requestJob(fake("true").deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", cwd: empty, promptFile: "prompt.md", outFile: "out.md" })).toThrow("HEAD");
    expect(existsSync(join(empty, "_review"))).toBe(false);
    // a checkout reached through a link still has its `.git` denied to the reviewer's test
    symlinkSync(repo, join(root, "repo-link"));
    const settings = (cwd: string) => JSON.parse(jobCommand({ kind: "review", taskId: "t1", pr: 12, runner: "claude", cwd, promptFile: "/p.md", outFile: "/o.md", tmpDir: "/t" }).argv.find((a) => a.startsWith('{"sandbox"'))!);
    expect(settings(join(root, "repo-link")).sandbox.filesystem.denyWrite).toEqual([join(realpathSync(repo), ".git")]);
  });

  test("review: the reviewer reads neither CLAUDE.md / AGENTS.md nor the user's MCP and skills", () => {
    const argvOf = (runner: "claude" | "codex") => jobCommand({ kind: "review", taskId: "t1", pr: 12, runner, cwd: repo, promptFile: "/p.md", outFile: "/o.md", tmpDir: "/t" }).argv;
    const claude = argvOf("claude");
    // the variables go in front of the command, the flags after `-p`
    expect(claude.slice(claude.indexOf("env"), claude.indexOf("claude") + 1)).toEqual(["env", "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", "claude"]);
    expect(claude).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--strict-mcp-config", "--disable-slash-commands"]));
    expect(claude).not.toContain("--bare"); // it would drop the sign-in the host uses
    const codex = argvOf("codex").join(" ");
    for (const part of ["--sandbox workspace-write", "-c project_doc_max_bytes=0", "-c mcp_servers={}", "--disable plugins", "--disable apps"]) expect(codex).toContain(part);
    expect(codex).not.toContain("--ignore-user-config"); // the user's model choice stays
    expect(argvOf("codex").at(-1)).toBe("-");
  });

  test("a review job may write only in its checkout and runs tests through the heavy slot", async () => {
    // the runners are fakes on PATH; `ops-kit heavy` / `ops-kit idle-run` in front of them and the one the reviewer calls are the kit's own,
    // with a home of the test's (its slots, its history; no memory floor, so the test does not wait on this machine's free memory)
    const home = mkdtempSync(join(tmpdir(), "jobs.review-home."));
    const bin = join(home, "bin");
    mkdirSync(bin);
    mkdirSync(join(home, ".config", "ops-kit"), { recursive: true });
    writeFileSync(join(home, ".config", "ops-kit", "heavy.json"), JSON.stringify({ max: 1, minFreeMb: 0 }));
    // a fake runner records where it runs and its arguments, then runs a test as the note tells the reviewer to
    for (const runner of ["codex", "claude"]) writeFileSync(join(bin, runner), `#!/bin/sh\ncat > /dev/null\npwd > "$J/runner-cwd"\necho "$TMPDIR" > "$J/runner-tmp"\nprintf '%s\\n' "$@" > "$J/runner-args"\nops-kit heavy -- bun test _review/tests/probe.test.ts > "$J/runner-test" 2>&1\n`, { mode: 0o755 });
    mkdirSync(join(repo, "_review", "tests"), { recursive: true });
    // the test makes a folder in tmpdir(), as this repository's tests do: it is in the job's own folder
    writeFileSync(join(repo, "_review", "tests", "probe.test.ts"), 'import { expect, test } from "bun:test";\nimport { mkdtempSync, realpathSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\ntest("probe", () => expect(realpathSync(mkdtempSync(join(tmpdir(), "p.")))).toStartWith(join(realpathSync(process.env.J!), "tmp")));\n');
    writeFileSync(join(repo, "prompt.md"), "Review this PR.\n");
    const slots = join(home, ".local", "state", "ops-kit", "heavy");
    const kit = join(import.meta.dir, "../../../ops-kit/bin");
    try {
      const run = async (runner: "codex" | "claude") => {
        const { deps, ended } = fake("true");
        const job = requestJob({ ...deps, command: undefined, reviewRunner: () => (runner === "claude" ? "same" : "other"), env: { ...deps.env, HOME: home, PATH: `${bin}:${kit}:${process.env.PATH}` } }, { kind: "review", taskId: "t1", pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
        await ended;
        const J = join(root, "jobs", String(job.id));
        return { J, cwd: readFileSync(join(J, "runner-cwd"), "utf8").trim(), tmp: readFileSync(join(J, "runner-tmp"), "utf8").trim(), args: readFileSync(join(J, "runner-args"), "utf8").trimEnd().split("\n"), test: readFileSync(join(J, "runner-test"), "utf8") };
      };
      const codex = await run("codex");
      const claude = await run("claude");
      for (const r of [codex, claude]) {
        expect(r.cwd).toBe(realpathSync(repo)); // the runner's own folder is the checkout
        expect(r.tmp).toBe(join(realpathSync(r.J), "tmp")); // its temporary files go to the job's own folder
        expect(r.test).toContain("1 pass");
        expect(r.test).not.toContain("heavy:"); // it neither ran without a slot nor inside the review's own memory-only run
      }
      // Codex: its sandbox writes in the checkout, the job's TMPDIR and the slots' folder only (not /tmp, not whatever $TMPDIR says), with no network
      const value = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
      expect(value(codex.args, "--sandbox")).toEqual(["workspace-write"]);
      expect(value(codex.args, "-c")).toEqual(expect.arrayContaining(["sandbox_workspace_write.network_access=false", "sandbox_workspace_write.exclude_slash_tmp=true", "sandbox_workspace_write.exclude_tmpdir_env_var=true"]));
      expect(value(codex.args, "--add-dir")).toEqual([slots, codex.tmp]);
      expect(codex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      // Claude Code: what the rules do not allow is refused; it edits and writes under `_review/tests/` only (not `.git/config`), and
      // the one command it may run is a test in a heavy slot. `--allowedTools` takes every word up to the next flag: an unscoped Edit / Write
      // there would allow them outside the checkout
      expect(value(claude.args, "--permission-mode")).toEqual(["dontAsk"]);
      const allowed = claude.args.slice(claude.args.indexOf("--allowedTools") + 1);
      expect(allowed.slice(0, allowed.findIndex((a) => a.startsWith("-")))).toEqual(["Bash(ops-kit heavy -- bun test:*)", "Edit(_review/tests/**)", "Write(_review/tests/**)"]);
      expect(claude.args).not.toContain("--add-dir");
      expect(claude.args).not.toContain("--dangerously-skip-permissions");
      // and that test, code the reviewer wrote, runs in Claude Code's sandbox: it writes in the checkout and the slots' folder (not the checkout's
      // `.git`), with no network; no command leaves it, and a sandbox that cannot start ends the run rather than running the test unsandboxed
      expect(value(claude.args, "--settings").map((v) => JSON.parse(v))).toEqual([{ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: [slots], denyWrite: [join(realpathSync(repo), ".git")] }, network: { allowedDomains: [] } } }]);
      // both tests took a slot of the test's home and gave it back
      expect(readFileSync(join(slots, "history.jsonl"), "utf8").split("\n").filter((l) => l.includes('"name":"bun test _review/tests/probe.test.ts"'))).toHaveLength(2);
      expect(readdirSync(slots).filter((f) => f.startsWith("slot"))).toEqual([]);
      // without bubblewrap / socat Claude Code would run the test unsandboxed: the reviewer is started read-only, told so, and the job's log says so
      const { deps, ended } = fake("true");
      let gone: ResolvedJobRequest | undefined;
      const job = requestJob({ ...deps, command: (r) => ((gone = r), { argv: ["sh", "-c", 'cp "$JOB_PROMPT" "$J/seen"'], tail: "" }), claudeSandbox: () => false, reviewRunner: () => "same" }, { kind: "review", taskId: "t1", pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
      await ended;
      const readOnly = jobCommand(gone!).argv;
      expect(value(readOnly, "--permission-mode")).toEqual(["plan"]);
      for (const flag of ["--settings", "--allowedTools"]) expect(readOnly).not.toContain(flag);
      expect(readFileSync(join(root, "jobs", String(job.id), "seen"), "utf8")).toContain("no test was run because the sandbox is unavailable");
      expect(readFileSync(join(root, "jobs", String(job.id), "log"), "utf8")).toContain("the reviewer only reads and runs no tests");
      // Codex has its own sandbox: no bubblewrap does not change its launch
      const other = fake("true");
      expect(requestJob({ ...other.deps, command: (r) => ((gone = r), { argv: ["true"], tail: "" }), claudeSandbox: () => false }, { kind: "review", taskId: "t1", pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md" }).runner).toBe("codex");
      await other.ended;
      expect(gone!.kind === "review" && gone!.readOnly).toBeFalsy();
      // a `_review` that leads out of the checkout is refused before anything is made through it
      rmSync(join(repo, "_review"), { recursive: true, force: true });
      symlinkSync(home, join(repo, "_review"));
      expect(() => requestJob(fake("true").deps, { kind: "review", taskId: "t1", pr: 12, runner: "codex", as: "fallback", cwd: repo, promptFile: "prompt.md", outFile: "out.md" })).toThrow("_review must be inside cwd");
      expect(existsSync(join(home, "tmp"))).toBe(false);
    } finally {
      rmSync(join(repo, "_review"), { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a review's TMPDIR is the job's own folder: short enough for Claude Code's sockets whatever the checkout's path, and gone with the job", async () => {
    // a checkout whose own `_review/tmp` would leave no room in a socket's address (108 bytes with its NUL) for Claude Code's sockets
    const long = join(root, "c".repeat(110));
    sh(repo, "git", "worktree", "add", "-q", "--detach", long);
    writeFileSync(join(long, "prompt.md"), "Review this PR.\n");
    expect(Buffer.byteLength(join(long, "_review", "tmp"))).toBeGreaterThan(107);
    try {
      for (const runner of ["claude", "codex"] as const) {
        // what it leaves includes a folder it made read-only (a test cut before it put the mode back)
        const { deps, ended } = fake('echo "$TMPDIR" > "$J/tmp-seen"; touch "$TMPDIR/left"; mkdir -p "$TMPDIR/d/e"; touch "$TMPDIR/d/e/f"; chmod 500 "$TMPDIR/d/e" "$TMPDIR/d"');
        let got: ResolvedJobRequest | undefined;
        const job = requestJob({ ...deps, command: (r) => ((got = r), deps.command!(r)), reviewRunner: () => (runner === "claude" ? "same" : "other") }, { kind: "review", taskId: "t1", pr: 12, cwd: long, promptFile: "prompt.md", outFile: "out.md" });
        await ended;
        expect(job.runner).toBe(runner);
        expect(db.getJob(job.id)!.status).toBe("pass"); // the review's end and result are recorded
        const J = join(root, "jobs", String(job.id));
        const tmp = readFileSync(join(J, "tmp-seen"), "utf8").trim();
        expect(tmp).toBe(join(realpathSync(J), "tmp"));
        expect(got!.kind === "review" && got!.tmpDir).toBe(tmp); // the folder the runner's sandbox is told of is the one it gets
        // the longest name Claude Code gives a socket there (`claude-socks-<16 hex>.sock`) still fits
        expect(Buffer.byteLength(join(tmp, "claude-socks-0123456789abcdef.sock"))).toBeLessThanOrEqual(107);
        // what the reviewer left there goes with the job, and nothing was made in the checkout for it
        expect(existsSync(tmp)).toBe(false);
        expect(existsSync(join(long, "_review"))).toBe(false);
      }
    } finally {
      sh(repo, "git", "worktree", "remove", "--force", long);
    }
  });

  describe("review runner from the setting", () => {
    const ask = (setting: "same" | "other", extra: { runner?: "codex" | "claude"; as?: "fallback" | "recheck" | "audit" | "attack"; pr?: number } = {}, taskId = "t1", database: Db = db) => {
      writeFileSync(join(repo, "prompt.md"), "review");
      const { deps, ended } = fake("true");
      const job = requestJob({ ...deps, db: database, reviewRunner: () => setting }, { kind: "review", taskId, pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md", ...extra });
      return { job, ended };
    };

    test("same: the Task's own runner reviews; another runner is refused unless the request says why", async () => {
      const none = ask("same");
      expect(none.job.runner).toBe("claude");
      await none.ended;
      const before = db.listJobs(Number.MAX_SAFE_INTEGER).length;
      expect(() => ask("same", { runner: "codex" })).toThrow("主レビュアーは claude です");
      expect(db.listJobs(Number.MAX_SAFE_INTEGER).length).toBe(before); // refused before a job is recorded
      // a fallback needs the main reviewer's window at its limit on record
      db.upsertQuota("claude", "five_hour", 0.95, Math.floor(Date.now() / 1000) + 3600, Date.now(), "same-test");
      try {
        const fallback = ask("same", { runner: "codex", as: "fallback" });
        expect(fallback.job.runner).toBe("codex");
        await fallback.ended;
      } finally {
        db.upsertQuota("claude", "five_hour", 0, 0, Date.now(), "same-test");
      }
    });

    const endedJob = (pr: number, over: { runner?: "codex" | "claude"; cwd?: string; repo?: string; status?: "pass" | "fail"; summary?: string; as?: "attack" | "audit" | "recheck" | "fallback" }, database: Db = db) => {
      const j = database.insertJob({ kind: "review", taskId: "t1", pr, runner: over.runner ?? "claude", cwd: over.cwd ?? repo, startedAt: Date.now(), repo: over.repo ?? "acme/app", head: null, as: over.as ?? null, kinds: [] });
      database.finishJob(j.id, { status: over.status ?? "pass", exitCode: 0, summary: over.summary ?? "", endedAt: Date.now() });
    };
    const refusedWith = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(JobError);
        expect((e as JobError).status).toBe(400);
        return (e as JobError).message;
      }
      throw new Error("not refused");
    };

    test("fallback: refused without a usage-limit record of the main reviewer; taken with a window at 0.9 or a main review job of the same PR that ended at its limit", async () => {
      const soon = () => Math.floor(Date.now() / 1000) + 3600;
      const before = db.listJobs(Number.MAX_SAFE_INTEGER).length;
      try {
        db.upsertQuota("claude", "five_hour", 0.5, soon(), Date.now(), "fb-test");
        expect(refusedWith(() => ask("same", { runner: "codex", as: "fallback", pr: 31 }))).toContain("claude");
        // a window of the other runner at its limit says nothing of the main reviewer
        db.upsertQuota("codex", "five_hour", 0.99, soon(), Date.now(), "fb-test");
        refusedWith(() => ask("same", { runner: "codex", as: "fallback", pr: 31 }));
        expect(db.listJobs(Number.MAX_SAFE_INTEGER).length).toBe(before); // refused before a job is recorded
        db.upsertQuota("claude", "five_hour", 0.95, soon(), Date.now(), "fb-test");
        const taken = ask("same", { runner: "codex", as: "fallback", pr: 31 });
        expect(taken.job).toMatchObject({ runner: "codex", as: "fallback" });
        await taken.ended;
        // a window that has come back is no record of a limit now
        db.upsertQuota("claude", "five_hour", 0.95, Math.floor(Date.now() / 1000) - 60, Date.now(), "fb-test");
        refusedWith(() => ask("same", { runner: "codex", as: "fallback", pr: 31 }));
        // a main review of another repository's PR with the same number is no record of this one's
        endedJob(31, { status: "fail", summary: "You've hit your session limit · resets 4:10am (Asia/Tokyo)", repo: "acme/elsewhere", cwd: join(root, "gone-elsewhere") });
        refusedWith(() => ask("same", { runner: "codex", as: "fallback", pr: 31 }));
        // an ended job of this PR that did not end at the limit is not one either; the one that did is
        endedJob(31, { status: "fail", summary: "exit 1" });
        refusedWith(() => ask("same", { runner: "codex", as: "fallback", pr: 31 }));
        endedJob(31, { status: "fail", summary: "You've hit your session limit · resets 4:10am (Asia/Tokyo)" });
        const byJob = ask("same", { runner: "codex", as: "fallback", pr: 31 });
        expect(byJob.job.runner).toBe("codex");
        await byJob.ended;
      } finally {
        for (const r of ["claude", "codex"] as const) db.upsertQuota(r, "five_hour", 0, 0, Date.now(), "fb-test");
      }
    });

    test("recheck: refused until a main review job of the same PR has ended", async () => {
      const first = refusedWith(() => ask("other", { as: "recheck", pr: 32 }));
      expect(first).toContain("codex");
      expect(first).toContain("主レビュー");
      endedJob(32, { repo: "acme/elsewhere", cwd: join(root, "gone-elsewhere") });
      refusedWith(() => ask("other", { as: "recheck", pr: 32 }));
      // an attacking-side review that ended is not the main review
      endedJob(32, { as: "attack" });
      refusedWith(() => ask("other", { as: "recheck", pr: 32 }));
      // a running review has not ended
      const running = db.insertJob({ kind: "review", taskId: "t1", pr: 32, runner: "codex", cwd: repo, startedAt: Date.now(), repo: "acme/app", head: null, as: null, kinds: [] });
      refusedWith(() => ask("other", { as: "recheck", pr: 32 }));
      db.finishJob(running.id, { status: "pass", exitCode: 0, summary: "", endedAt: Date.now() });
      const taken = ask("other", { as: "recheck", pr: 32 });
      expect(taken.job).toMatchObject({ runner: "claude", as: "recheck" });
      await taken.ended;
    });

    test("audit: refused while the PR is open; taken once it is stored as merged", async () => {
      const { db: db2, put } = dbWithStoredPr("audit.sqlite", 40);
      try {
        put("OPEN");
        const open = refusedWith(() => ask("other", { runner: "claude", as: "audit", pr: 40 }, "t1", db2));
        expect(open).toContain("マージの記録がまだ");
        expect(open).toContain("同期の後に頼み直");
        // a number the store does not hold has no merge record either
        refusedWith(() => ask("other", { runner: "claude", as: "audit", pr: 41 }, "t1", db2));
        put("MERGED");
        const taken = ask("other", { runner: "claude", as: "audit", pr: 40 }, "t1", db2);
        expect(taken.job).toMatchObject({ runner: "claude", as: "audit", pr: 40 });
        await taken.ended;
      } finally {
        db2.close();
      }
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
      // an audit is read by a runner that is not the main reviewer, and says so (its record is checked in the audit test below)
      expect(refusedWith(() => ask("other", { runner: "claude", as: "audit" }))).toContain("audit");
    });

    test("attack takes either runner under either setting, so one runner's usage limit does not stop it, and still needs one named", async () => {
      // the Task's runner is claude: attackReviewer names codex under other and claude under same; the other one stands in at a usage limit
      for (const setting of ["other", "same"] as const) {
        for (const runner of ["codex", "claude"] as const) {
          const accepted = ask(setting, { runner, as: "attack" });
          expect(accepted.job.runner).toBe(runner);
          expect(accepted.job.as).toBe("attack");
          await accepted.ended;
        }
        const before = db.listJobs(Number.MAX_SAFE_INTEGER).length;
        expect(() => ask(setting, { as: "attack" })).toThrow("runner の名指し");
        expect(db.listJobs(Number.MAX_SAFE_INTEGER).length).toBe(before); // refused before a job is recorded
      }
    });

    test("attack for a Task whose runner reviews nothing cannot be decided", () => {
      db.insertTask({ ...mkTask("t-adk2", join(root, "task")), runner: "dak" });
      expect(() => ask("other", { runner: "claude", as: "attack" }, "t-adk2")).toThrow("決められません");
    });

    test("a Task whose runner reviews nothing must name the reviewer", async () => {
      db.insertTask({ ...mkTask("t-adk", join(root, "task")), runner: "dak" });
      expect(() => ask("other", {}, "t-adk")).toThrow("主レビュアーを決められません");
      const named = ask("other", { runner: "claude" }, "t-adk");
      expect(named.job.runner).toBe("claude");
      await named.ended;
    });
  });

  describe("recheck runner from the setting", () => {
    // the Task t1 is claude's; under the review setting other its main reviewer is codex
    const ask = (recheck: "same" | "other", extra: { runner?: "codex" | "claude"; as?: "recheck" } = { as: "recheck" }) => {
      writeFileSync(join(repo, "prompt.md"), "review");
      const { deps, ended } = fake("true");
      const resolved: ResolvedJobRequest[] = [];
      const job = requestJob({ ...deps, reviewRunner: () => "other", recheckRunner: () => recheck, command: (r) => (resolved.push(r), deps.command!(r)) }, { kind: "review", taskId: "t1", pr: 12, cwd: repo, promptFile: "prompt.md", outFile: "out.md", ...extra });
      return { job, ended, resolved };
    };
    const refusal = (f: () => unknown) => {
      const before = db.listJobs(Number.MAX_SAFE_INTEGER).length;
      try {
        f();
      } catch (e) {
        expect(db.listJobs(Number.MAX_SAFE_INTEGER).length).toBe(before); // refused before a job is recorded
        expect(e).toBeInstanceOf(JobError);
        expect((e as JobError).status).toBe(400);
        return (e as JobError).message;
      }
      throw new Error("not refused");
    };
    // a recheck is a new session whatever the setting: neither its request nor its argv resumes a conversation
    const fresh = (r: ResolvedJobRequest) => {
      const argv = jobCommand(r).argv;
      expect(argv.filter((a) => a === "resume" || a.startsWith("--resume") || a === "--continue")).toEqual([]);
    };

    test("other: the runner that is not the main reviewer reads it without being named, and naming the main reviewer is refused", async () => {
      const none = ask("other");
      expect(none.job.runner).toBe("claude");
      expect(none.job.as).toBe("recheck");
      fresh(none.resolved[0]!);
      await none.ended;
      expect(refusal(() => ask("other", { runner: "codex", as: "recheck" }))).toContain("再チェックは claude");
    });

    test("same: the main reviewer's runner reads it in a new session; naming the other runner is refused; the main review is asked as before", async () => {
      const none = ask("same");
      expect(none.job.runner).toBe("codex");
      expect(none.resolved[0]).toMatchObject({ runner: "codex", as: "recheck" });
      fresh(none.resolved[0]!);
      await none.ended;
      expect(refusal(() => ask("same", { runner: "claude", as: "recheck" }))).toContain("再チェックは codex");
      const main = ask("same", { runner: "codex" });
      expect(main.job).toMatchObject({ runner: "codex", as: null });
      await main.ended;
    });
  });

  test("review model from the setting: the saved review model / effort go to the CLI, an empty one falls to the runner's Task default", () => {
    const argvOf = (runner: "claude" | "codex", choice: { model?: string; effort?: string }) => jobCommand({ kind: "review", taskId: "t1", pr: 12, runner, cwd: repo, promptFile: "/p.md", outFile: "/o.md", tmpDir: "/t", as: "recheck" }, 900, choice).argv;
    expect(argvOf("codex", { model: "m1", effort: "high" })).toEqual(expect.arrayContaining(["-m", "m1", "-c", 'model_reasoning_effort="high"']));
    expect(argvOf("claude", { model: "m1", effort: "high" })).toEqual(expect.arrayContaining(["--model", "m1", "--effort", "high"]));
    // the daemon's own wiring (setupJobs): settings → runnerChoice, read on every request
    let saved = Settings.parse({ defaultModel: { codex: "task-m" }, defaultEffort: { codex: "low" }, reviewModel: { codex: "m1" }, reviewEffort: { codex: "high" } });
    const sc = { db, tasks: {}, savedAutoResume: () => false, settings: () => saved, githubBudget: { get: () => undefined }, cfg: { candidate: true, home: root, jobReviewIdleS: 900 }, opts: {}, localUrl: () => "http://127.0.0.1:1" } as unknown as Parameters<typeof setupJobs>[0];
    const choice = (r: RunnerId, m: string, e: string) => runnerChoice({ settings: () => saved, tasks: { checkEffort: () => undefined } } as never, r, m, e);
    Object.assign(sc, { runnerChoice: choice });
    setupJobs(sc);
    expect(sc.jobDeps.reviewChoice!("codex")).toMatchObject({ model: "m1", effort: "high" });
    saved = Settings.parse({ defaultModel: { codex: "task-m" }, defaultEffort: { codex: "low" } });
    expect(sc.jobDeps.reviewChoice!("codex")).toMatchObject({ model: "task-m", effort: "low" });
    // the recheck setting it hands the jobs: unset follows the review setting, a saved one wins
    expect(sc.jobDeps.recheckRunner!()).toBe("other");
    saved = Settings.parse({ reviewRunner: "same" });
    expect(sc.jobDeps.recheckRunner!()).toBe("same");
    saved = Settings.parse({ reviewRunner: "same", recheckRunner: "other" });
    expect(sc.jobDeps.recheckRunner!()).toBe("other");
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
      expect(seen.codex).toContain("workspace-write sandbox");
      expect(seen.codex).not.toContain("dontAsk");
      expect(seen.claude).toContain("dontAsk mode");
      expect(seen.claude).not.toContain("workspace-write");
      // the rules every review is told reach the runner whole, the use of a comparison with main included
      for (const text of Object.values(seen)) expect(text).toContain("`_review/compared.md`");
    });
  });

  test("a Claude review on the CLI default records the model it ran on; a model it was given, and a Codex review's none, stay", async () => {
    writeFileSync(join(repo, "prompt.md"), "review");
    const system = `printf '%s\n' '{"type":"system","model":"x"}' > "$J/claude.jsonl"`;
    const run = async (runner: "claude" | "codex", choice: { model?: string; effort?: string }) => {
      const { deps, ended } = fake(system);
      deps.reviewChoice = () => choice;
      const job = requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner, as: "attack", cwd: repo, promptFile: "prompt.md", outFile: "out-model.md" });
      expect(job).toMatchObject({ model: choice.model || null, effort: choice.effort || null });
      return (await ended).model;
    };
    expect(await run("claude", {})).toBe("x");
    expect(await run("claude", { model: "", effort: "" })).toBe("x"); // empty is the CLI's own
    expect(await run("claude", { model: "m1" })).toBe("m1");
    expect(await run("codex", {})).toBeNull();
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
      requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner, as: "attack", cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
      await ended;
    }
    const peek = new Database(join(root, "db.sqlite"), { readonly: true });
    const ledger = () => peek.query("SELECT runner, source, input_tokens, cost_usd FROM ledger WHERE task_id = 't1' ORDER BY id").all() as { runner: string; source: string; input_tokens: number; cost_usd: number }[];
    const rows = ledger();
    expect(rows.map((r) => [r.runner, r.source, r.input_tokens])).toEqual([["claude", "job", 100], ["codex", "job", 6]]);
    expect(rows[0]!.cost_usd).toBe(0.5);
    // a review that left nothing readable books nothing and still ends
    const { deps, ended } = fake("true");
    requestJob(deps, { kind: "review", taskId: "t1", pr: 12, runner: "claude", as: "attack", cwd: repo, promptFile: "prompt.md", outFile: "out.md" });
    expect((await ended).status).toBe("pass");
    expect(ledger()).toHaveLength(2);
    peek.close();
  });

  test("recoverJobs ends a job by its exit file, watches one still running, and aborts one whose process is gone or that started in another boot", async () => {
    const dir = join(root, "jobs-recover");
    const ended: Job[] = [];
    const deps: JobDeps = { db, dir, env: {}, onFinish: (j) => ended.push(j), pollMs: 50, bootId: () => "boot-now" };
    const mk = () => db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
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

  test("a job whose end cannot be recorded is ended as aborted, and recoverJobs goes on to the next job", () => {
    const dir = join(root, "jobs-recover-throw");
    const ended: Job[] = [];
    let calls = 0;
    // the first end's clock fails, as any step of one job's end could
    const deps: JobDeps = { db, dir, env: {}, onFinish: (j) => ended.push(j), bootId: () => "boot-now", now: () => (++calls === 1 ? (() => { throw new Error("clock"); })() : Date.now()) };
    const mk = () => db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
    const first = mk();
    const second = mk();
    for (const j of [first, second]) db.setJobPid(j.id, 999_999_999, "boot-now");
    expect(() => recoverJobs(deps)).not.toThrow();
    // both ended: the one whose end failed says why
    expect([first, second].map((j) => db.getJob(j.id)!.status)).toEqual(["aborted", "aborted"]);
    expect([first, second].filter((j) => db.getJob(j.id)!.summary?.includes("終了を記録できませんでした: clock"))).toHaveLength(1);
    expect(ended.map((j) => j.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  test("a job whose end was recorded before a later step threw is still told to the Task, once", () => {
    const dir = join(root, "jobs-recover-late-throw");
    const ended: Job[] = [];
    let armed = false;
    // the read after the end is recorded fails, as any step after `finishJob` could
    const flaky = new Proxy(db, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (typeof v !== "function") return v;
        if (k === "finishJob") return (...a: unknown[]) => ((armed = true), v.apply(t, a));
        if (k === "getJob") return (...a: unknown[]) => {
          if (armed) {
            armed = false;
            throw new Error("read after end");
          }
          return v.apply(t, a);
        };
        return v.bind(t);
      },
    });
    const deps: JobDeps = { db: flaky, dir, env: {}, onFinish: (j) => ended.push(j), bootId: () => "boot-now" };
    const job = db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
    // its process is gone and it left no folder (so no step between the end and that read reads the job)
    db.setJobPid(job.id, 999_999_999, "boot-now");
    expect(() => recoverJobs(deps)).not.toThrow();
    expect(db.getJob(job.id)!.status).toBe("aborted");
    expect(ended.filter((j) => j.id === job.id).map((j) => j.status)).toEqual(["aborted"]);
  });

  test("a Task's handler that throws at a job's end is not called again", () => {
    const dir = join(root, "jobs-recover-handler-throw");
    let calls = 0;
    const deps: JobDeps = { db, dir, env: {}, onFinish: () => {
      calls++;
      throw new Error("handler");
    }, bootId: () => "boot-now" };
    const job = db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
    db.setJobPid(job.id, 999_999_999, "boot-now");
    expect(() => recoverJobs(deps)).not.toThrow();
    expect(db.getJob(job.id)!.status).toBe("aborted");
    expect(calls).toBe(1);
  });
});

test("the list keeps a job for 7 days after it ended, and every running one", () => {
  const d = new Db(join(root, "list.sqlite"));
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const mk = () => d.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: now - 9 * day, repo: "", head: null, as: null, kinds: [] });
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
  const mk = () => d.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: now - 9 * day, repo: "", head: null, as: null, kinds: [] });
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
    const j = db.insertJob({ kind, taskId: "t1", pr: 1, runner: kind === "review" ? "claude" : null, cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
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
  const live = db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
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
    const j = db.insertJob({ kind: "local-ci", taskId: "t1", pr: 1, runner: null, cwd: repo, startedAt: Date.now() - 9 * day, repo: "", head: null, as: null, kinds: [] });
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
      // the app's own taskId is reserved: a request body cannot say it is the app (it would skip the Task and checkout checks)
      expect((await post({ kind: "tag-ci", taskId: "app", cwd: repo })).status).toBe(400);
      expect((await post({ kind: "local-ci", taskId: "app", pr: 5, cwd: repo })).status).toBe(400);
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

  test("a review job records its model and effort from the setting, and why it is not the main review", async () => {
    const home = join(root, "home-model");
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    // a Claude adapter that is installed and lists the efforts (the settings PATCH and runnerChoice check them); only the job's process is a fake
    const core = await startServer(cfg, [fakeAdapter([], { id: "claude", models: ["m1", "task-m"], efforts: ["low", "high"] })], { port: 0, selfdevChecks: false, dryRunRestart: true, jobCommand: () => ({ argv: ["true"], tail: "" }) });
    try {
      // the Task works in its own worktree; the review reads the separate checkout
      core.db.insertTask(mkTask("t7", join(root, "task")));
      writeFileSync(join(repo, "prompt.md"), "review");
      const base = `http://127.0.0.1:${core.server.port}`;
      const patch = async (body: unknown) => {
        const r = await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify(body) });
        expect([r.status, r.status === 200 ? "" : await r.text()]).toEqual([200, ""]);
      };
      const review = async (extra: Record<string, unknown> = {}) => {
        const r = await fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "review", taskId: "t7", pr: 21, cwd: repo, promptFile: "prompt.md", outFile: "out-model.md", ...extra }) });
        expect(r.status).toBe(202);
        const id = ((await r.json()) as Job).id;
        return ((await fetch(`${base}/api/jobs`).then((x) => x.json())) as Job[]).find((j) => j.id === id)!;
      };
      // the main reviewer is the Task's own runner (claude), with the review's own model / effort
      await patch({ reviewRunner: "same", reviewModel: { claude: "m1" }, reviewEffort: { claude: "high" } });
      expect(await review()).toMatchObject({ kind: "review", runner: "claude", model: "m1", effort: "high", as: null });
      expect(await review({ as: "recheck" })).toMatchObject({ runner: "claude", model: "m1", effort: "high", as: "recheck" });
      // none saved for the review: the runner's Task default is what it ran with
      await patch({ reviewModel: null, reviewEffort: null, defaultModel: { claude: "task-m" } });
      expect(await review()).toMatchObject({ runner: "claude", model: "task-m", as: null });
    } finally {
      await core.stop();
    }
  });

  test("an arbiter job runs on the recheck runner of the setting and records its rulings and viewpoints", async () => {
    const home = join(root, "home-arbiter");
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    const out = [
      "### Rulings",
      "- [reviewer] `a.ts:3` — rule: README Design rules",
      "- [reviewer] `b.ts:4` — rule: none",
      "- [implementer] `c.ts:5` — rule: none",
      "",
      "### Viewpoints",
      "- error paths — covered",
      "- old callers — missing",
    ].join("\n");
    const argvs: string[][] = [];
    // the real settings route and job request; only the runner's process is a fake (it writes the arbiter's output)
    const core = await startServer(cfg, [fakeAdapter([], { id: "claude", models: [], efforts: [] })], { port: 0, selfdevChecks: false, dryRunRestart: true, jobCommand: (r) => ((argvs.push(jobCommand(r as ResolvedJobRequest).argv), { argv: ["sh", "-c", `printf '%s\\n' "$ARBITER_OUT" > "$JOB_OUT"`], tail: "" })) });
    process.env.ARBITER_OUT = out;
    try {
      core.db.insertTask(mkTask("t9", join(root, "task")));
      writeFileSync(join(repo, "prompt.md"), "arbiter");
      const base = `http://127.0.0.1:${core.server.port}`;
      const patch = async (body: unknown) => {
        const r = await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify(body) });
        expect([r.status, r.status === 200 ? "" : await r.text()]).toEqual([200, ""]);
      };
      const ask = (extra: Record<string, unknown> = {}) => fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "review", taskId: "t9", pr: 77, cwd: repo, promptFile: "prompt.md", outFile: "out-arbiter.md", as: "arbiter", ...extra }) });
      // setting other: the runner that is not the main reviewer (claude for a claude Task's codex review), and only once a main review of the PR has ended
      await patch({ reviewRunner: "other", recheckRunner: "other" });
      const early = await ask();
      expect([early.status, ((await early.json()) as { error: string }).error]).toEqual([400, expect.stringContaining("主レビュー")]);
      const main = core.db.insertJob({ kind: "review", taskId: "t9", pr: 77, runner: "codex", cwd: repo, startedAt: Date.now(), repo: "acme/app", head: null, as: null, kinds: [] });
      core.db.finishJob(main.id, { status: "pass", exitCode: 0, summary: "", endedAt: Date.now() });
      const done = async (r: Response) => {
        expect(r.status).toBe(202);
        const id = ((await r.json()) as Job).id;
        for (let i = 0; i < 100 && core.db.getJob(id)!.status === "running"; i++) await Bun.sleep(50);
        return core.db.getJob(id)!;
      };
      const other = await done(await ask());
      expect(other).toMatchObject({ runner: "claude", as: "arbiter", kinds: [], status: "pass" });
      expect(other.result?.review).toMatchObject({ rulings: { reviewerSide: ["- [reviewer] `a.ts:3` — rule: README Design rules"], missing: ["- old callers — missing"], unreadable: [] } });
      const wrong = await ask({ runner: "codex" });
      expect([wrong.status, ((await wrong.json()) as { error: string }).error]).toEqual([400, expect.stringContaining("監督者は claude")]);
      // setting same: the main reviewer's own runner, in a new session
      await patch({ recheckRunner: "same" });
      const same = await done(await ask());
      expect(same).toMatchObject({ runner: "codex", as: "arbiter" });
      expect(argvs.length).toBe(2);
      for (const argv of argvs) expect(argv.filter((a) => a === "resume" || a.startsWith("--resume") || a === "--continue")).toEqual([]);
      // kinds belong to a recheck only
      expect((await ask({ kinds: ["size"] })).status).toBe(400);
    } finally {
      delete process.env.ARBITER_OUT;
      await core.stop();
    }
    // an output that cannot be read is on record as unreadable, so it is not taken for a ruling that found nothing
    expect(arbiterResult("looks fine").rulings).toEqual({ reviewerSide: [], missing: [], unreadable: ["no `### Rulings` section", "no `### Viewpoints` section"] });
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
