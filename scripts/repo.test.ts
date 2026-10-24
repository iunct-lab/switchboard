import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentRepo } from "./repo.ts";

const saved = process.env.GH_REPO;
const dirs: string[] = [];
afterEach(() => {
  if (saved === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = saved;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function repository(origin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "repo-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git/objects"), { recursive: true });
  mkdirSync(join(dir, ".git/refs"), { recursive: true });
  writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git/config"), "[core]\nrepositoryformatversion = 0\n" + (origin ? `[remote "origin"]\nurl = ${origin}\n` : ""));
  return dir;
}
test("GH_REPO forms take precedence over origin", () => {
  for (const value of ["owner/name", "github.com/owner/name", "https://github.com/owner/name.git", "git@github.com:owner/name.git", "ssh://git@github.com/owner/name.git"]) {
    process.env.GH_REPO = value;
    expect(currentRepo("/missing")).toBe("owner/name");
  }
});
for (const [kind, url] of [["https", "https://github.com/owner/name.git"], ["ssh", "git@github.com:owner/name.git"]]) {
  test(`${kind} origin`, () => {
    delete process.env.GH_REPO;
    expect(currentRepo(repository(url))).toBe("owner/name");
  });
}
test("missing repository has a clear error", () => {
  delete process.env.GH_REPO;
  expect(() => currentRepo(repository())).toThrow("set GH_REPO");
});
