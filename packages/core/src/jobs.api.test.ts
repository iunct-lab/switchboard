// test-reads: none
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { NO_HISTORY, j, startServer } from "./api-test-harness.ts";

// The recheck of a review job through the daemon's own route: the settings PATCH decides which runner the app picks for
// `as: "recheck"` with no runner named. Only the job's command is fake (it runs `true`).

let root: string;
let repo: string;
let task: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "switchboard-jobs-api-"));
  repo = join(root, "repo");
  task = join(root, "task");
  mkdirSync(repo);
  const sh = (...argv: string[]) => {
    const r = Bun.spawnSync(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr}`);
  };
  sh("git", "init", "-q");
  sh("git", "remote", "add", "origin", "https://github.com/acme/app.git");
  sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  // the Task works in its own worktree; `repo` is the review's separate checkout
  sh("git", "worktree", "add", "-q", "--detach", task);
  writeFileSync(join(repo, "prompt.md"), "review");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const claudeTask = (id: string): Task => {
  const at = Date.now();
  return { id, workspaceId: null, title: "t", stage: null, runner: "claude", cwd: task, scope: [task], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Task;
};

describe("/api/jobs recheck", () => {
  test("recheck follows the review setting when unset; a saved recheck setting wins", async () => {
    const home = join(root, "home");
    const core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [], { port: 0, selfdevChecks: false, dryRunRestart: true, jobCommand: () => ({ argv: ["true"], tail: "" }) });
    try {
      core.db.insertTask(claudeTask("t-claude"));
      // a recheck follows a review of the PR that has ended
      const first = core.db.insertJob({ kind: "review", taskId: "t-claude", pr: 5, runner: "codex", cwd: repo, startedAt: Date.now(), repo: "", head: null, as: null, kinds: [] });
      core.db.finishJob(first.id, { status: "pass", exitCode: 0, summary: "", endedAt: Date.now() });
      const base = `http://127.0.0.1:${core.server.port}`;
      const patch = async (body: unknown) => expect((await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
      const recheck = async () => {
        const r = await fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "review", taskId: "t-claude", pr: 5, as: "recheck", cwd: repo, promptFile: "prompt.md", outFile: "out.md" }) });
        expect(r.status).toBe(202);
        const job = (await j(r)) as Job;
        for (let i = 0; i < 100 && core.db.getJob(job.id)!.status === "running"; i++) await Bun.sleep(20);
        return job.runner;
      };
      // nothing saved: the review setting is other (the main reviewer is codex), so the recheck is not the main reviewer's: claude
      expect(await recheck()).toBe("claude");
      // review setting same only: the main reviewer is claude, and the recheck follows it — the runner that implemented, not codex
      await patch({ reviewRunner: "same" });
      expect(await recheck()).toBe("claude");
      // a saved recheck setting wins over the review setting: other than the main reviewer (claude) is codex
      await patch({ recheckRunner: "other" });
      expect(await recheck()).toBe("codex");
    } finally {
      await core.stop();
    }
  }, 20000);
});
