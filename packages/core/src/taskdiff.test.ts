import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, StagedChange, Task } from "@switchboard/protocol";
import { collectTaskDiff, touchedPaths } from "./taskdiff.ts";

let root: string;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv });
const env = (ev: EventEnvelope["ev"], seq: number): EventEnvelope => ({ taskId: "t", seq, ts: 0, ev });
const task = (cwd: string, scope: string[] = [cwd]): Task => ({ id: "t", workspaceId: null, title: "", runner: "claude", cwd, scope, status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 0, createdAt: 0, updatedAt: 0 });

beforeAll(() => {
  // tmpdir() is a symlink on macOS (/var → /private/var): the collector must canonicalize roots and paths alike
  root = mkdtempSync(join(tmpdir(), "sb-diff-"));
  git(root, ["init", "-q"]);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "pkg", "sub"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "one\ntwo\n");
  writeFileSync(join(root, "src", "日本 語.ts"), "こんにちは\n");
  writeFileSync(join(root, "pkg", "sub", "x.ts"), "x\n");
  writeFileSync(join(root, "README.md"), "# r\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "init"]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("task diff (#12)", () => {
  test("touchedPaths collects write-class tool calls (incl. NotebookEdit) and artifacts, resolving relative paths against the scope root", () => {
    const paths = touchedPaths(
      [
        env({ t: "tool.call", id: "1", name: "Write", input: { file_path: join(root, "x.ts") }, summary: "" }, 1),
        env({ t: "tool.call", id: "2", name: "Read", input: { file_path: join(root, "ignored.ts") }, summary: "" }, 2),
        env({ t: "tool.call", id: "3", name: "fileChange", input: { changes: [{ path: "rel/y.ts" }] }, summary: "" }, 3),
        env({ t: "tool.call", id: "4", name: "NotebookEdit", input: { notebook_path: "nb.ipynb" }, summary: "" }, 4),
        env({ t: "artifact", kind: "diff", path: "src/a.ts" }, 5),
      ],
      [root],
    );
    const real = realpathSync(root);
    expect([...paths].sort()).toEqual([join(real, "nb.ipynb"), join(real, "rel/y.ts"), join(real, "src/a.ts"), join(real, "x.ts")].sort());
  });

  test("collects working-tree changes of touched files (modified, new, non-ASCII names) and pending staged writes, with editor-ready absolute paths", async () => {
    writeFileSync(join(root, "src", "a.ts"), "one\nTWO\nthree\n");
    writeFileSync(join(root, "src", "new.ts"), "fresh\n");
    writeFileSync(join(root, "src", "日本 語.ts"), "さようなら\n");
    writeFileSync(join(root, "README.md"), "# changed but not touched by the task\n");
    const events = [env({ t: "artifact", kind: "diff", path: join(root, "src", "a.ts") }, 1), env({ t: "tool.call", id: "w", name: "Write", input: { file_path: "src/new.ts" }, summary: "" }, 2), env({ t: "artifact", kind: "diff", path: "src/日本 語.ts" }, 3)];
    const staged: StagedChange[] = [{ id: "stg_1", taskId: "t", path: join(root, "src", "b.ts"), rel: "src/b.ts", kind: "write", before: null, after: "b\n", status: "pending", ts: 0, decidedAt: null, diff: "--- staged ---", stat: "+1 −0" }];
    const files = await collectTaskDiff(task(root), events, staged);
    expect(files.map((f) => [f.source, f.rel])).toEqual([
      ["staging", "src/b.ts"],
      ["worktree", "src/a.ts"],
      ["worktree", "src/日本 語.ts"],
      ["worktree", "src/new.ts"],
    ]);
    expect(files[1]!.stat).toBe("+2 −1");
    expect(files[1]!.diff).toContain("-two\n+TWO\n+three");
    expect(files[2]!.diff).toContain("+さようなら");
    expect(files[3]!.stat).toBe("new");
    expect(files[3]!.diff).toContain("+fresh");
    expect(files[1]!.path).toBe(join(realpathSync(root), "src", "a.ts"));
    // nothing named in the transcript → everything changed in the tree, README included
    const all = await collectTaskDiff(task(root), [], []);
    expect(all.map((f) => f.rel).sort()).toEqual(["README.md", "src/a.ts", "src/new.ts", "src/日本 語.ts"].sort());
  });

  test("a scope root that is a subdirectory of the repository sees only its own changes, with paths relative to the root", async () => {
    writeFileSync(join(root, "pkg", "sub", "x.ts"), "x\ny\n");
    const sub = join(root, "pkg");
    const files = await collectTaskDiff(task(sub), [], []);
    expect(files.map((f) => f.rel)).toEqual(["sub/x.ts"]);
    expect(files[0]!.stat).toBe("+1 −0");
    expect(files[0]!.diff).toContain("+y");
  });

  test("a repository without commits diffs against the empty tree; a non-git root contributes nothing", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "sb-fresh-"));
    try {
      git(fresh, ["init", "-q"]);
      writeFileSync(join(fresh, "a.txt"), "hello\n");
      git(fresh, ["add", "a.txt"]);
      const files = await collectTaskDiff(task(fresh), [], []);
      expect(files.map((f) => f.rel)).toEqual(["a.txt"]);
      expect(files[0]!.diff).toContain("+hello");
      const plain = mkdtempSync(join(tmpdir(), "sb-plain-"));
      try {
        expect(await collectTaskDiff(task(plain), [], [])).toEqual([]);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
