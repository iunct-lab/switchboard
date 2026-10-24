import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// What goes public is named (ops.config.json publicSync.include, #1961 / #1962): every top-level entry of the tree is
// either named there or private/. A new top-level entry fails here until someone decides which of the two it is.
// A tree that is not a git checkout (a ZIP download) has no HEAD to list: skipped there, with the reason.
const root = join(import.meta.dir, "..");
const ls = Bun.spawnSync(["git", "ls-tree", "HEAD"], { cwd: root, stderr: "pipe" });
if (ls.exitCode !== 0) console.warn(`public-include.test.ts: skipped — not a git checkout (git ls-tree HEAD: ${ls.stderr.toString().trim()})`);
test.skipIf(ls.exitCode !== 0)("publicSync.include names every top-level entry of the tree but private/", () => {
  const include: string[] = JSON.parse(readFileSync(join(root, "ops.config.json"), "utf8")).publicSync.include;
  const top = ls.stdout.toString().trim().split("\n").map((line) => {
    const [meta, name] = line.split("\t");
    return meta!.includes(" tree ") ? `${name}/` : name!;
  });
  expect(top.filter((entry) => entry !== "private/" && !include.includes(entry))).toEqual([]);
  expect(include).not.toContain("private/");
});
