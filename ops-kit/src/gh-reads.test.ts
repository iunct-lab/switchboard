// test-reads: ops-kit/bin/gh
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE_READ_ONLY_ENV, ghReadsOnly } from "./gh-reads.ts";

const dir = mkdtempSync(join(tmpdir(), "ops-kit-gh-reads-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ghReadsOnly", () => {
  test("what is known to read reads", () => {
    for (const argv of [
      [], ["--version"], ["help"], ["status"],
      ["pr", "view", "5", "--json", "state"], ["pr", "list"], ["pr", "diff", "5"], ["pr", "checks", "5"], ["-R", "o/r", "pr", "view", "5"], ["pr", "-R", "o/r", "view", "5"],
      ["issue", "view", "3"], ["issue", "list", "--label", "x"], ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], ["repo", "clone", "o/r"],
      ["run", "list", "--commit", "abc"], ["variable", "get", "X"], ["auth", "status"], ["search", "issues", "x"],
      ["api", "repos/o/r/pulls/5"], ["api", "-X", "GET", "repos/o/r/issues", "-f", "state=open"], ["api", "--method=GET", "rate_limit"], ["api", "rate_limit", "--jq", ".resources"],
      ["api", "graphql", "-f", "query=query($n:Int!){viewer{login}}", "-F", "n=5"], ["api", "graphql", "-f", "query={ viewer { login } }"],
    ]) expect([argv.join(" "), ghReadsOnly(argv)]).toEqual([argv.join(" "), true]);
  });

  test("everything else is a write: a write, and anything not known to read", () => {
    for (const argv of [
      ["pr", "create", "--title", "x"], ["pr", "comment", "5", "-b", "x"], ["pr", "merge", "5"], ["pr", "edit", "5"], ["pr", "close", "5"], ["pr", "review", "5", "--approve"], ["pr"],
      ["issue", "create"], ["issue", "comment", "3", "-b", "x"], ["issue", "close", "3"], ["-R", "o/r", "issue", "edit", "3"],
      ["repo", "create", "x"], ["repo", "delete", "o/r"], ["release", "create", "v1"], ["label", "create", "x"], ["variable", "set", "X"], ["secret", "set", "X"], ["workflow", "run", "ci.yml"], ["gist", "create", "f"], ["stack", "merge"], ["unknown-extension", "view"],
      ["api", "-X", "POST", "repos/o/r/issues"], ["api", "-XPATCH", "repos/o/r/issues/1"], ["api", "--method=DELETE", "repos/o/r/git/refs/heads/x"], ["api", "repos/o/r/issues", "-f", "title=x"], ["api", "repos/o/r/issues", "-ftitle=x"], ["api", "repos/o/r/contents/x", "--input", "f.json"], ["api", "--input=f.json", "repos/o/r/contents/x"], ["api"],
      ["api", "graphql", "-f", "query=mutation{addComment(input:{}){clientMutationId}}"], ["api", "graphql", "-F", "query=@q.graphql"], ["api", "graphql", "-f", "query=query{viewer{login}}", "-f", "query=mutation{x}"], ["api", "graphql", "--raw-field=query=mutation{x}"], ["api", "graphql", "-f", "query=query{x} mutation{y}"], ["api", "graphql"],
    ]) expect([argv.join(" "), ghReadsOnly(argv)]).toEqual([argv.join(" "), false]);
  });
});

describe("the check in front of gh on a machine that must not write to the forge", () => {
  // a `gh` that says what reached it
  const bin = join(dir, "bin");
  const reached = join(dir, "reached.txt");
  Bun.spawnSync(["mkdir", "-p", bin]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${reached}"\necho ok\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const guard = join(import.meta.dir, "..", "bin", "gh");
  const run = (argv: string[], env: Record<string, string>) => Bun.spawnSync([process.execPath, guard, ...argv], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });

  test("a write is stopped before it reaches gh, with what to do instead; a read goes through; without the variable nothing changes", () => {
    for (const argv of [["pr", "create", "--title", "x", "--body", "y"], ["pr", "comment", "5", "--body", "x"], ["pr", "merge", "5"], ["api", "-X", "PUT", "repos/o/r/contents/feedback/1.png", "--input", "/dev/null"], ["issue", "comment", "3", "--body", "x"]]) {
      const r = run(argv, { [FORGE_READ_ONLY_ENV]: "1" });
      expect([argv[1], r.exitCode]).toEqual([argv[1], 1]);
      expect(r.stderr.toString()).toContain("このマシン（作業場）からは GitHub に書き込みません");
    }
    expect(existsSync(reached)).toBe(false);
    expect(run(["pr", "view", "5"], { [FORGE_READ_ONLY_ENV]: "1" }).exitCode).toBe(0);
    expect(run(["pr", "comment", "5", "--body", "x"], {}).exitCode).toBe(0);
    expect(Bun.file(reached).text()).resolves.toBe("pr view 5\npr comment 5 --body x\n");
  });
});
