import { describe, expect, test } from "bun:test";
import { pushRebased, type GitRun } from "./push-rebased.ts";

// a fake git: answers by the first arguments, records every call
function fakeGit(answers: { head?: string; originHead?: string; pushFails?: string }) {
  const calls: string[][] = [];
  const git: GitRun = (...args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "symbolic-ref -q HEAD") return answers.head ? { ok: true, stdout: `refs/heads/${answers.head}`, stderr: "" } : { ok: false, stdout: "", stderr: "" };
    if (key === "symbolic-ref refs/remotes/origin/HEAD")
      return answers.originHead ? { ok: true, stdout: `refs/remotes/${answers.originHead}`, stderr: "" } : { ok: false, stdout: "", stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref" };
    if (args[0] === "push") return answers.pushFails ? { ok: false, stdout: "", stderr: answers.pushFails } : { ok: true, stdout: "", stderr: "" };
    throw new Error(`unexpected git ${key}`);
  };
  return { git, pushes: () => calls.filter((c) => c[0] === "push") };
}

describe("pr push-rebased", () => {
  test("refuses the default branch", () => {
    const f = fakeGit({ head: "main", originHead: "origin/main" });
    const r = pushRebased(f.git);
    expect(r).toEqual({ ok: false, message: "既定の枝 main は書き直しません" });
    expect(f.pushes()).toEqual([]);
    const trunk = fakeGit({ head: "trunk", originHead: "origin/trunk" });
    expect(pushRebased(trunk.git).ok).toBe(false);
    expect(trunk.pushes()).toEqual([]);
  });

  test("refuses a detached HEAD", () => {
    const f = fakeGit({ originHead: "origin/main" });
    const r = pushRebased(f.git);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("枝の無い HEAD");
    expect(f.pushes()).toEqual([]);
  });

  test("falls back to main and master when origin/HEAD is unknown", () => {
    for (const head of ["main", "master"]) {
      const f = fakeGit({ head });
      expect(pushRebased(f.git)).toEqual({ ok: false, message: `既定の枝 ${head} は書き直しません` });
      expect(f.pushes()).toEqual([]);
    }
    const f = fakeGit({ head: "dak/12-x" });
    expect(pushRebased(f.git).ok).toBe(true);
  });

  test("pushes only the current branch with force-with-lease", () => {
    const f = fakeGit({ head: "sb/1-x", originHead: "origin/main" });
    expect(pushRebased(f.git)).toEqual({ ok: true, message: "sb/1-x を push しました（--force-with-lease）" });
    expect(f.pushes()).toEqual([["push", "--force-with-lease", "--no-follow-tags", "origin", "HEAD:refs/heads/sb/1-x"]]);
    const failing = fakeGit({ head: "sb/1-x", originHead: "origin/main", pushFails: "! [rejected] (stale info)" });
    expect(pushRebased(failing.git)).toEqual({ ok: false, message: "! [rejected] (stale info)" });
  });
});
