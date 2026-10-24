import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sh } from "./release-tag";
import { plan, run } from "./rollback-pr";

/** A fake git / gh: answers by command prefix, records every call and its stdin. */
function fake(answers: Record<string, { ok?: boolean; out?: string }>) {
  const calls: string[] = [];
  const inputs: (string | undefined)[] = [];
  const sh: Sh = (cmd, input) => {
    const c = cmd.join(" ");
    calls.push(c);
    inputs.push(input);
    const key = Object.keys(answers).find((k) => c.startsWith(k));
    const a = key ? answers[key]! : {};
    return { ok: a.ok ?? true, out: a.out ?? "" };
  };
  return { sh, calls, inputs };
}

const ok = {
  "git remote get-url": { out: "https://github.com/x/y.git" },
  "git log": { out: "b2\tfeat: b (#5)\na1\tfix: a (#4)" },
  "git commit-tree": { out: "c3" },
  "gh pr create": { out: "https://github.com/x/y/pull/6" },
};

describe("rollback-pr plan", () => {
  test("fetches main and the tags, and lists the commits after the tag", () => {
    const f = fake(ok);
    expect(plan(f.sh, "v0.2.0", "x/y")).toEqual({ commits: ["b2\tfeat: b (#5)", "a1\tfix: a (#4)"] });
    expect(f.calls).toContain("git fetch origin --tags main");
    expect(f.calls).toContain("git merge-base --is-ancestor refs/tags/v0.2.0 origin/main");
    expect(f.calls).toContain("git log --format=%h%x09%s refs/tags/v0.2.0..origin/main");
  });

  test("a missing tag throws", () => {
    const f = fake({ ...ok, "git rev-parse": { ok: false } });
    expect(() => plan(f.sh, "v9.9.9", "x/y")).toThrow("v9.9.9");
  });

  test("a tag that is not an ancestor of main throws", () => {
    const f = fake({ ...ok, "git merge-base": { ok: false } });
    expect(() => plan(f.sh, "v0.2.0", "x/y")).toThrow("origin/main");
  });

  test("main already at the tag throws: nothing to roll back", () => {
    const f = fake({ ...ok, "git log": { out: "" } });
    expect(() => plan(f.sh, "v0.2.0", "x/y")).toThrow("nothing");
  });

  test("a clone of another repository throws before fetching", () => {
    const f = fake({ ...ok, "git remote get-url": { out: "https://github.com/a/b.git" } });
    expect(() => plan(f.sh, "v0.2.0", "x/y")).toThrow("x/y");
    expect(f.calls.some((c) => c.startsWith("git fetch"))).toBe(false);
  });
});

describe("rollback-pr run", () => {
  test("one commit whose tree is the tag's on top of main, pushed to rollback/<tag>, and a PR listing the commits", () => {
    const f = fake(ok);
    expect(run(f.sh, "v0.2.0", "x/y")).toBe("https://github.com/x/y/pull/6");
    const tree = f.calls.find((c) => c.startsWith("git commit-tree"))!;
    expect(tree).toStartWith("git commit-tree refs/tags/v0.2.0^{tree} -p origin/main -m revert: v0.2.0 に戻す");
    expect(f.calls).toContain("git push origin +c3:refs/heads/rollback/v0.2.0");
    const pr = f.calls.findIndex((c) => c.startsWith("gh pr create"));
    expect(f.calls[pr]).toBe("gh pr create -R x/y --head rollback/v0.2.0 --base main --title revert: v0.2.0 に戻す --body-file -");
    expect(f.inputs[pr]).toContain("- b2 feat: b (#5)\n- a1 fix: a (#4)");
    expect(f.inputs[pr]).toContain("merge-gate");
  });

  test("a rerun replaces the branch it pushed before and returns the PR already open on it", () => {
    const f = fake({ ...ok, "gh pr list": { out: "https://github.com/x/y/pull/5" } });
    expect(run(f.sh, "v0.2.0", "x/y")).toBe("https://github.com/x/y/pull/5");
    expect(f.calls).toContain("git push origin +c3:refs/heads/rollback/v0.2.0");
    expect(f.calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
    const edit = f.calls.indexOf("gh pr edit https://github.com/x/y/pull/5 -R x/y --body-file -");
    expect(f.inputs[edit]).toContain("- b2 feat: b (#5)\n- a1 fix: a (#4)");
  });

  test("nothing is pushed when the plan fails", () => {
    const f = fake({ ...ok, "git merge-base": { ok: false } });
    expect(() => run(f.sh, "v0.2.0", "x/y")).toThrow();
    expect(f.calls.some((c) => c.startsWith("git commit-tree") || c.startsWith("git push") || c.startsWith("gh pr"))).toBe(false);
  });
});

describe("rollback-pr CLI", () => {
  const cli = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "rollback-pr.ts"), ...args], { cwd, env: { ...process.env, ...env }, stdout: "ignore", stderr: "pipe" });

  test("bad arguments → usage, exit 2", () => {
    for (const args of [[], ["v0.1.0"], ["v0.1.0", "--repo", "bad"], ["--repo", "x/y"], ["-v0.1.0", "--repo", "x/y"]]) {
      const p = cli(args, import.meta.dir);
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain("usage");
    }
  });

  test("a check that fails (here: no git repository, so no origin) → its reason, exit 2, nothing pushed", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.rollback-cli."));
    try {
      // GIT_DIR: even when the temp directory is inside some clone, git finds no repository here
      const p = cli(["v0.1.0", "--repo", "x/y"], dir, { GIT_DIR: join(dir, "none") });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain("git remote get-url origin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
