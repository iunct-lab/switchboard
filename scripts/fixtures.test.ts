// test-reads: none
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchVault, saveVault, VAULT_BRANCH, VaultError } from "./fixtures.ts";

// #3532: the recordings' second copy is a branch of the repository, written and read with git's plumbing.
let root: string;
let clone: string;
let origin: string;
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const branchFiles = () => git(origin, "ls-tree", "-r", "--name-only", VAULT_BRANCH).split("\n").filter(Boolean);
const show = (rel: string) => git(origin, "show", `${VAULT_BRANCH}:${rel}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fixtures.test."));
  origin = join(root, "origin.git");
  clone = join(root, "clone");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", clone);
  git(clone, "config", "user.name", "t");
  git(clone, "config", "user.email", "t@example.com");
  git(clone, "remote", "add", "origin", origin);
  // main's tree: the branch must not touch it
  put(clone, "README.md", "main\n");
  git(clone, "add", "README.md");
  git(clone, "commit", "-q", "-m", "main");
  git(clone, "push", "-q", "origin", "HEAD:refs/heads/main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("fixtures: save without the branch stops unless --create (a public clone or fork would publish them)", () => {
  const vault = join(root, "vault");
  put(vault, "packages/a/fixtures/x.jsonl", "x\n");
  expect(() => saveVault(clone, vault)).toThrow(VaultError);
  expect(git(origin, "branch", "--list", VAULT_BRANCH)).toBe("");
  expect(saveVault(clone, vault, { create: true })).toMatch(/^[0-9a-f]{40}$/);
  expect(branchFiles()).toEqual(["packages/a/fixtures/x.jsonl"]);
  // main and the working tree are untouched
  expect(git(origin, "ls-tree", "-r", "--name-only", "main")).toBe("README.md");
  expect(git(clone, "status", "--porcelain")).toBe("");
});

test("fixtures: save sends new and changed recordings, keeps the branch's others, and pushes nothing when the same", () => {
  const vault = join(root, "vault");
  put(vault, "a/x.jsonl", "x1\n");
  put(vault, "a/y.jsonl", "y\n");
  saveVault(clone, vault, { create: true });
  const other = join(root, "vault2");
  put(other, "a/x.jsonl", "x2\n");
  put(other, "b/z.sse", "z\n");
  const commit = saveVault(clone, other);
  expect(commit).not.toBeNull();
  expect(branchFiles()).toEqual(["a/x.jsonl", "a/y.jsonl", "b/z.sse"]);
  expect(show("a/x.jsonl")).toBe("x2");
  expect(git(origin, "rev-parse", `${VAULT_BRANCH}^`)).not.toBe("");
  expect(saveVault(clone, other)).toBeNull();
  expect(git(origin, "rev-parse", VAULT_BRANCH)).toBe(commit!);
});

test("fixtures: fetch writes every file into an empty folder and does not overwrite one there", () => {
  const vault = join(root, "vault");
  put(vault, "a/x.jsonl", "x\n");
  put(vault, "b/z.sse", "z\n");
  saveVault(clone, vault, { create: true });
  const empty = join(root, "empty");
  expect(fetchVault(clone, empty).sort()).toEqual(["a/x.jsonl", "b/z.sse"]);
  expect(readFileSync(join(empty, "b/z.sse"), "utf8")).toBe("z\n");
  const kept = join(root, "kept");
  put(kept, "a/x.jsonl", "local\n");
  expect(fetchVault(clone, kept)).toEqual(["b/z.sse"]);
  expect(readFileSync(join(kept, "a/x.jsonl"), "utf8")).toBe("local\n");
});

test("fixtures: fetch does not write through a name already taken, even by a dangling link", () => {
  const vault = join(root, "vault");
  put(vault, "a/x.jsonl", "x\n");
  saveVault(clone, vault, { create: true });
  const dir = join(root, "linked");
  mkdirSync(join(dir, "a"), { recursive: true });
  const target = join(root, "elsewhere.jsonl");
  symlinkSync(target, join(dir, "a/x.jsonl"));
  expect(fetchVault(clone, dir)).toEqual([]);
  expect(existsSync(target)).toBe(false);
});

test("fixtures: fetch on a clone whose origin has no branch says so and writes nothing", () => {
  const empty = join(root, "empty");
  expect(() => fetchVault(clone, empty)).toThrow(/recordings-vault/);
  expect(existsSync(empty)).toBe(false);
});

test("fixtures: a refused push is a VaultError, not a crash", () => {
  const vault = join(root, "vault");
  put(vault, "a/x.jsonl", "x\n");
  saveVault(clone, vault, { create: true });
  // a pre-receive hook refuses every push, as a fork without write access does
  const hook = join(origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  put(vault, "a/y.jsonl", "y\n");
  expect(() => saveVault(clone, vault)).toThrow(VaultError);
});
