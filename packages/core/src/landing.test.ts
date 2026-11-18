// test-reads: packages/core/src/landing.ts
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landedTip, landingRef } from "./landing.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test("landedTip: the branch until merges land beside it, the landing ref while it has commits the branch lacks, the branch again once it has them", () => {
  dir = mkdtempSync(join(tmpdir(), "sb-landing-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir!, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...a], { encoding: "utf8" }).trim();
  const commit = (name: string) => (writeFileSync(join(dir!, name), name), git("add", "-A"), git("commit", "-q", "-m", name), git("rev-parse", "HEAD"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  expect(landedTip(dir, "main")).toBeNull();
  const a = commit("a");
  expect(landedTip(dir, "main")).toEqual({ ref: "refs/heads/main", sha: a, landing: null });
  // a merge lands: a commit on top of main, kept on the landing ref — main and its work tree stay
  const b = git("commit-tree", `${a}^{tree}`, "-p", a, "-m", "landed");
  git("update-ref", landingRef("main"), b);
  expect(landedTip(dir, "main")).toEqual({ ref: "refs/switchboard/landed/main", sha: b, landing: b });
  expect([git("rev-parse", "main"), git("status", "--porcelain")]).toEqual([a, ""]);
  // the work tree is given the commits (pull-main after they went to GitHub): the landing ref counts for nothing
  git("merge", "-q", "--ff-only", b);
  const c = commit("c");
  expect(landedTip(dir, "main")).toEqual({ ref: "refs/heads/main", sha: c, landing: b });
  // main moved on without them (GitHub's other commits pulled first): the landed merges are still the local tip
  git("reset", "-q", "--hard", a);
  const d = commit("d");
  expect(landedTip(dir, "main")).toEqual({ ref: "refs/switchboard/landed/main", sha: b, landing: b });
  expect(d).not.toBe(b);
  // the ref is outside refs/heads: no checkout can be on it
  expect(landingRef("main").startsWith("refs/heads/")).toBe(false);
});
