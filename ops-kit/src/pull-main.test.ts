import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pullMain } from "./pull-main.ts";

let root: string;
let main: string;
let other: string;

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
// a commit in `dir` that writes <file>, pushed when asked
function commit(dir: string, file: string, text: string, push = false) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", `edit ${file}`);
  if (push) git(dir, "push", "-q");
}
function run(cwd: string) {
  const lines: string[] = [];
  const errs: string[] = [];
  const code = pullMain(cwd, (s) => lines.push(s), (s) => errs.push(s));
  return { code, out: lines.join("\n"), err: errs.join("\n") };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ops-kit-pull-"));
  const origin = join(root, "origin.git");
  main = join(root, "main");
  other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, main);
  commit(main, "a.txt", "one\n");
  git(main, "branch", "-M", "main");
  git(main, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", origin, other);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pull-main", () => {
  test("pulls the main worktree when it can fast-forward", () => {
    commit(other, "b.txt", "two\n", true);
    const before = git(main, "rev-parse", "HEAD");
    const r = run(main);
    const after = git(main, "rev-parse", "HEAD");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`pulled ${before.slice(0, 7)}..${after.slice(0, 7)} (main <- origin/main)`);
    expect(after).toBe(git(other, "rev-parse", "HEAD"));
  });

  test("from a linked worktree: main is pulled and the worktree is left", () => {
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "topic");
    const topic = git(wt, "rev-parse", "HEAD");
    commit(other, "b.txt", "two\n", true);
    const r = run(wt);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("pulled ");
    expect(git(main, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
    expect(git(wt, "rev-parse", "HEAD")).toBe(topic);
  });

  test("up to date", () => {
    const r = run(main);
    expect(r).toEqual({ code: 0, out: `up to date ${git(main, "rev-parse", "HEAD").slice(0, 7)}`, err: "" });
  });

  test("pulls when an uncommitted change does not overlap", () => {
    commit(other, "b.txt", "two\n", true);
    writeFileSync(join(main, "a.txt"), "edited\n");
    writeFileSync(join(main, "new.txt"), "untracked\n");
    expect(run(main).code).toBe(0);
    expect(readFileSync(join(main, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(main, "b.txt"), "utf8")).toBe("two\n");
  });

  test("leaves the tree when local commits are ahead", () => {
    commit(main, "local.txt", "x\n");
    commit(other, "b.txt", "two\n", true);
    const head = git(main, "rev-parse", "HEAD");
    const r = run(main);
    expect(r.code).toBe(1);
    expect(r.out).toStartWith("not pulled: cannot fast-forward");
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
  });

  test("leaves the tree when an uncommitted change overlaps", () => {
    commit(other, "a.txt", "from origin\n");
    commit(other, "c.txt", "untracked here\n", true);
    writeFileSync(join(main, "a.txt"), "mine\n");
    writeFileSync(join(main, "c.txt"), "mine too\n");
    const head = git(main, "rev-parse", "HEAD");
    const status = git(main, "status", "--porcelain");
    const r = run(main);
    expect(r.code).toBe(1);
    expect(r.out).toBe("not pulled: uncommitted changes overlap: a.txt c.txt");
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
    expect(git(main, "status", "--porcelain")).toBe(status);
  });

  test("an overlap is found for a path git would quote, and for a renamed file", () => {
    commit(other, "e.txt", "e\n", true);
    expect(run(main).code).toBe(0);
    commit(other, "café.txt", "from origin\n");
    commit(other, "d.txt", "from origin\n", true);
    writeFileSync(join(main, "café.txt"), "mine\n");
    git(main, "add", "café.txt");
    git(main, "mv", "e.txt", "d.txt"); // a staged rename: the status line names d.txt and, after it, e.txt
    const head = git(main, "rev-parse", "HEAD");
    const status = git(main, "status", "--porcelain");
    const r = run(main);
    expect(r.code).toBe(1);
    expect(r.out).toContain("café.txt");
    expect(r.out).toContain("d.txt");
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
    expect(git(main, "status", "--porcelain")).toBe(status);
  });

  test("leaves the tree on a detached HEAD or with no upstream", () => {
    commit(other, "b.txt", "two\n", true);
    const head = git(main, "rev-parse", "HEAD");
    git(main, "branch", "--unset-upstream");
    expect(run(main)).toEqual({ code: 1, out: "not pulled: no upstream for main", err: "" });
    git(main, "checkout", "-q", "--detach");
    expect(run(main)).toEqual({ code: 1, out: "not pulled: detached HEAD", err: "" });
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
  });

  test("exit 2 when the fetch fails or outside a repository", () => {
    git(main, "remote", "set-url", "origin", join(root, "missing.git"));
    const r = run(main);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith("fetch failed:");
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(run(plain)).toMatchObject({ code: 2, err: `not a git repository: ${plain}` });
  });

  test("ops-kit pull-main on PATH runs from a linked worktree", () => {
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "topic");
    commit(other, "b.txt", "two\n", true);
    const PATH = [join(import.meta.dir, "../bin"), dirname(process.execPath), dirname(Bun.which("git")!)].join(":");
    const p = Bun.spawnSync(["ops-kit", "pull-main"], { cwd: wt, env: { PATH }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toStartWith("pulled ");
    expect(git(main, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
  });
});
