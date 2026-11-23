// test-reads: scripts/merge-gate.ts ops-kit/bin/gh
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { OWNER } from "./merge-grants.ts";
import { NO_GH, NO_HISTORY, fakeAdapter, j, startServer, waitFor } from "./api-test-harness.ts";

// A Task's merge verdict and merge are the app's: the real `scripts/merge-gate.ts` in the Task's shell asks the daemon, the daemon runs its own copy
// as a job through the real front of `gh` (`ops-kit/bin/gh`), and only a `gh` far down the PATH is fake. The daemon is the real one; nothing is
// faked between the Task's shell and the merge.

const ROOT = join(import.meta.dir, "../../..");
const GATE = join(ROOT, "scripts/merge-gate.ts");
const GUARD = join(ROOT, "ops-kit/bin/gh");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";

/** The fake `gh` the front reaches last: it answers the reads a verdict makes about PR 7 and keeps every call it gets. */
const FAKE_GH = `#!/usr/bin/env bun
const fs = require("node:fs");
const a = process.argv.slice(2);
const dir = process.env.FAKE_GH_DIR;
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(a) + "\\n");
const cfg = JSON.parse(fs.readFileSync(dir + "/cfg.json", "utf8"));
const out = (s) => { process.stdout.write(typeof s === "string" ? s : JSON.stringify(s)); process.exit(0); };
if (a[0] === "pr" && a[1] === "view") {
  if (a.includes("-q")) out(cfg.sha + " main\\n");
  out({ files: cfg.files, commits: [{ authoredDate: "2026-09-24T10:00:00Z" }], baseRefName: "main", baseRefOid: cfg.base, headRefName: "feat/x", headRefOid: cfg.sha, mergeStateStatus: "CLEAN", comments: [], body: "" });
}
if (a[0] === "api" && /\\/stacks\\/\\d+$/.test(a[1])) { process.stderr.write("gh: Not Found (HTTP 404)"); process.exit(1); }
if (a[0] === "api" && a[1].includes("/stacks?")) out([{ number: 100, base: { ref: "main" }, pull_requests: [{ number: 7, state: "open", draft: false, merged_at: null, head: { sha: cfg.sha, ref: "feat/x" } }] }]);
if (a[0] === "repo") out("main\\n");
if (a[0] === "pr" && a[1] === "list") out("[]");
if (a[0] === "pr" || a[0] === "stack") out("");
if (a[1] && a[1].includes("/actions/runs")) out({ workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "success", created_at: "2026-09-24T12:00:00Z" }] });
out({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } });
`;

describe("the app judges and merges for a Task", () => {
  const saved = process.env.PATH;
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    process.env.PATH = saved;
    delete process.env.FAKE_GH_DIR;
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /** A daemon with a Task in a clone whose origin is acme/app (its `ops.config.json` names the merge gate, so the front of `gh` is on), a fake `gh` far down the daemon's PATH and the app's records of PR 7's head. */
  const boot = async (files: Array<{ path: string; additions: number; deletions: number; changeType?: string }> = [{ path: "a.ts", additions: 1, deletions: 2, changeType: "MODIFIED" }]) => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-gate-job-"));
    const clone = join(h, "clone");
    const fakeDir = join(h, "fake-gh");
    mkdirSync(clone);
    mkdirSync(fakeDir);
    Bun.spawnSync(["git", "init", "-q"], { cwd: clone });
    Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: clone });
    writeFileSync(join(clone, "ops.config.json"), JSON.stringify({ mergeGate: "scripts/merge-gate.ts" }));
    writeFileSync(join(fakeDir, "gh"), FAKE_GH);
    chmodSync(join(fakeDir, "gh"), 0o755);
    writeFileSync(join(fakeDir, "cfg.json"), JSON.stringify({ sha: SHA, base: BASE, files }));
    process.env.PATH = `${fakeDir}:${saved}`;
    process.env.FAKE_GH_DIR = fakeDir;
    const task = fakeAdapter([{ t: "session.start", runner: "claude", runnerSessionId: "s1", cwd: "/tmp" }, { t: "session.end", status: "ok", turn: "t1", summary: "done" }]);
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [task], { port: 0, selfdevChecks: false, gh: NO_GH });
    cleanups.push(async () => {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    });
    const b = `http://127.0.0.1:${c.server.port}`;
    const t = (await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: clone, title: "t", prompt: "p" }) }).then(j)) as Task;
    await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
    const tokenFile = join(h, "token");
    expect(existsSync(tokenFile)).toBe(true);
    // the records a verdict at SHA reads: a passed main review, and an attacking review (the paths of an ask kind need one)
    for (const as of [null, "attack"] as const) {
      const job = c.db.insertJob({ kind: "review", taskId: t.id, pr: 7, runner: "claude", cwd: clone, startedAt: 1, repo: "acme/app", head: SHA, as, kinds: [] });
      c.db.finishJob(job.id, { status: "pass", exitCode: 0, summary: "pass", endedAt: 2 });
      c.db.setJobResult(job.id, { result: { review: { findings: [], firstLine: "[claude] review" } } });
    }
    // the Task's shell: its own address, key and id, and the front of gh first on its PATH (as the daemon gives a Task)
    const taskEnv = (extra: Record<string, string | undefined> = {}) => ({ ...process.env, GH_REPO: undefined, GH_HOST: undefined, OPS_MERGE_GATE_PR: undefined, OPS_PUBLIC_SYNC_PR: undefined, SWITCHBOARD_TASK_ID: t.id, OPS_KIT_TASK_ID: t.id, BACKLOG_URL: `${b}/api/backlog`, BACKLOG_TOKEN_FILE: tokenFile, SWITCHBOARD_GATE_POLL_MS: "100", SWITCHBOARD_GATE_WAIT_MS: "60000", PATH: `${join(ROOT, "ops-kit/bin")}:${fakeDir}:${saved}`, ...extra });
    const spawn = async (argv: string[], env: Record<string, string | undefined> = {}) => {
      const p = Bun.spawn(argv, { cwd: clone, env: taskEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = [await p.exited, await new Response(p.stdout).text(), await new Response(p.stderr).text()];
      return { code, out, err };
    };
    const calls = (): string[][] => (existsSync(join(fakeDir, "calls.jsonl")) ? readFileSync(join(fakeDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
    const merges = () => calls().filter((a) => (a[0] === "pr" && a[1] === "merge") || a[0] === "stack");
    const jobs = async () => (await fetch(`${b}/api/jobs`).then(j)) as Job[];
    return { b, c, t, clone, tokenFile, spawn, calls, merges, jobs };
  };

  test("a Task's merge-gate --merge is judged and merged by the app's copy; gh pr merge from the Task's shell with OPS_MERGE_GATE_PR stops", async () => {
    const x = await boot();
    // the Task's shell runs the gate: it merges, the one merge being the daemon's job through the front of gh (the Task's own gh was never asked)
    const r = await x.spawn(["bun", GATE, "7", "--merge"]);
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(JSON.parse(r.out)).toMatchObject({ verdict: "merge", impact: "small" });
    expect(x.merges()).toEqual([["pr", "merge", "7", "-R", "acme/app", "--rebase", "--delete-branch", "--match-head-commit", SHA]]);
    // the job is the Task's, run for PR 7 of acme/app, and its record says what the app judged and that it merged
    const gate = (await x.jobs()).filter((k) => k.kind === "gate");
    expect(gate).toHaveLength(1);
    expect(gate[0]).toMatchObject({ taskId: x.t.id, pr: 7, repo: "acme/app", head: SHA, status: "pass", exitCode: 0, result: { gate: { verdict: "merge", head: SHA, ask: [], recheck: [], reasons: [], allowLarge: false, reviewSkipped: false, merged: true } } });
    // the same job is read by id with what it printed; one that is not there, or not a number, is no job
    const one = await fetch(`${x.b}/api/jobs/${gate[0]!.id}`).then(j);
    expect(one.job.id).toBe(gate[0]!.id);
    expect(JSON.parse(one.out).verdict).toBe("merge");
    expect([(await fetch(`${x.b}/api/jobs/99999`)).status, (await fetch(`${x.b}/api/jobs/abc`)).status]).toEqual([404, 404]);

    // a stop is exit 1 with the reasons and no merge; with `--allow-large` it stops until the Task's own record holds the person's consent to that head
    const gated = { files: [{ path: "packages/core/src/auth.ts", additions: 1, deletions: 1, changeType: "MODIFIED" }] };
    writeFileSync(join(process.env.FAKE_GH_DIR!, "cfg.json"), JSON.stringify({ sha: SHA, base: BASE, ...gated }));
    const before = x.merges().length;
    const stop = await x.spawn(["bun", GATE, "7", "--merge", "--allow-large"]);
    expect(stop.code).toBe(1);
    expect(JSON.parse(stop.out)).toMatchObject({ verdict: "stop", ask: ["security:words"] });
    expect(x.merges()).toHaveLength(before);
    const stopped = (await x.jobs()).find((k) => k.kind === "gate" && k.id !== gate[0]!.id)!;
    expect(stopped.result!.gate).toMatchObject({ verdict: "stop", head: SHA, ask: ["security:words"], allowLarge: true, merged: false });
    // the consent of the Task that asked (a record the app holds for that Task and head) lifts the ask in the app's judgement, at the daemon's copy: the Task's shell has no say in it
    x.c.db.recordMergeGrant({ taskId: x.t.id, repo: "acme/app", kind: "answer", target: 7, by: OWNER, head: SHA });
    const lifted = await x.spawn(["bun", GATE, "7", "--merge", "--allow-large"]);
    expect([lifted.code, lifted.err]).toEqual([0, ""]);
    expect(x.merges()).toHaveLength(before + 1);
    // the consent that answers an ask is not the consent to merge outside the gate: a variable naming the PR does not make one
    const outside = await x.spawn([GUARD, "pr", "merge", "7", "-R", "acme/app", "--rebase", "--match-head-commit", SHA], { OPS_MERGE_GATE_PR: "7" });
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("merge-gate.ts");
    expect(x.merges()).toHaveLength(before + 1);
    for (const argv of [["stack", "merge", "7", "--rebase", "-y"], ["api", "-X", "PUT", "repos/acme/app/pulls/7/merge", "-f", `sha=${SHA}`]]) {
      expect([argv, (await x.spawn([GUARD, ...argv], { OPS_MERGE_GATE_PR: "7" })).code]).toEqual([argv, 1]);
    }
    expect(x.merges()).toHaveLength(before + 1);
    // the person's consent to this merge outside the gate, recorded for the Task and the head, is what lets the merge in that form through
    x.c.db.recordMergeGrant({ taskId: x.t.id, repo: "acme/app", kind: "merge", target: 7, by: OWNER, head: SHA });
    const granted = await x.spawn([GUARD, "pr", "merge", "7", "-R", "acme/app", "--rebase", "--match-head-commit", SHA], { OPS_MERGE_GATE_PR: "7" });
    expect(granted.code).toBe(0);
    expect(x.merges()).toHaveLength(before + 2);
  }, 120_000);

  test("a bunfig.toml (preload) and a .env in the Task's checkout are not read by the app's job", async () => {
    const x = await boot();
    const dir = process.env.FAKE_GH_DIR!;
    // Bun reads both from its working folder: a preload is code, and a `.env` is variables (here ones that would turn the front of gh on in the job)
    writeFileSync(join(x.clone, "evil.ts"), `require("node:fs").writeFileSync(${JSON.stringify(dir)} + (process.env.J ? "/pre-job" : "/pre-shell"), "x");\n`);
    writeFileSync(join(x.clone, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
    writeFileSync(join(x.clone, ".env"), `BACKLOG_URL=${x.b}/api/backlog\nBACKLOG_TOKEN_FILE=${x.tokenFile}\nMERGE_RECORDS_URL=http://127.0.0.1:1\n`);
    const r = await x.spawn(["bun", GATE, "7", "--merge"]);
    expect([r.code, r.err]).toEqual([0, ""]);
    // the Task's own shell is started in its checkout and does read them (that is the Task's own process); the job does not
    expect(existsSync(join(dir, "pre-shell"))).toBe(true);
    expect(existsSync(join(dir, "pre-job"))).toBe(false);
    expect(x.merges()).toHaveLength(1);
    // and it still judged and merged the checkout it was given: gh ran in it (gh stack acts on the working tree it is in)
    const stack = await x.spawn(["bun", GATE, "7", "--merge-stack"]);
    expect([stack.code, stack.err]).toEqual([0, ""]);
    expect(existsSync(join(dir, "pre-job"))).toBe(false);
  }, 120_000);

  test("a refusal to write marked on the Task's checkout (ops-kit.noWrite) stops the job's merge: gh runs in the checkout, where the front reads it", async () => {
    const x = await boot();
    Bun.spawnSync(["git", "config", "--add", "ops-kit.noWrite", "acme/app"], { cwd: x.clone });
    const r = await x.spawn(["bun", GATE, "7", "--merge"]);
    // the verdict was merge; the merge was refused by the front of gh, not made
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).verdict).toBe("merge");
    expect(r.err).toContain("noWrite");
    expect(x.merges()).toEqual([]);
    // without the mark the same run merges (the mark is what stopped it)
    Bun.spawnSync(["git", "config", "--unset-all", "ops-kit.noWrite"], { cwd: x.clone });
    expect((await x.spawn(["bun", GATE, "7", "--merge"])).code).toBe(0);
    expect(x.merges()).toHaveLength(1);
  }, 120_000);

  test("a Task's own environment does not move where the app's job reads its records, and a person's terminal judges for itself", async () => {
    const x = await boot();
    // the Task names another address and key for the records: the job runs in the daemon's environment and does not read them
    const r = await x.spawn(["bun", GATE, "7"], { MERGE_RECORDS_URL: "http://127.0.0.1:1", MERGE_RECORDS_TOKEN_FILE: "/nonexistent" });
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(JSON.parse(r.out).verdict).toBe("merge");
    // outside a Task (no Task's variable) the script judges in its own process, with the person's own flag as the consent: no job is asked for
    const jobsBefore = (await x.jobs()).filter((k) => k.kind === "gate").length;
    const own = await x.spawn(["bun", GATE, "7"], { SWITCHBOARD_TASK_ID: undefined, OPS_KIT_TASK_ID: undefined, BACKLOG_URL: undefined, BACKLOG_TOKEN_FILE: undefined, MERGE_RECORDS_URL: x.b, MERGE_RECORDS_TOKEN_FILE: x.tokenFile });
    expect([own.code, own.err]).toEqual([0, ""]);
    expect((await x.jobs()).filter((k) => k.kind === "gate")).toHaveLength(jobsBefore);
  }, 120_000);
});
