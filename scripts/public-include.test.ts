// test-reads: ./
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { underEntry } from "../ops-kit/src/public-sync.ts";
import { parseReads } from "./test-select.ts";

// What goes public is named (ops.config.json publicSync.include): every top-level entry of the tree is
// either named there (a directory counts when a file under it is named) or private/. A new top-level entry fails here until someone decides which of the two it is.
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
  expect(top.filter((entry) => entry !== "private/" && !include.some((named) => underEntry(named, entry)))).toEqual([]);
  expect(include).not.toContain("private/");
});

// A document is public only when its file is named: a directory in include (code, `ops-kit/`, `.claude/`) is published as it is,
// so a Markdown / HTML file under one must be in include (public) or in exclude (decided private); docs/, which include no longer
// names, sends only the files include names, so every file under it must be named either way. A document added later then fails
// here, and cannot be merged, until someone decides. test-reads above declares the whole tree, so the
// affected-tests selection runs this check whenever a file or directory is added anywhere, a document included. How the kit sends directories and named files: ops-kit/README.md,
// "Syncing to the public repository".
test.skipIf(ls.exitCode !== 0)("a document under an included directory is named file by file", () => {
  const { include, exclude }: { include: string[]; exclude: string[] } = JSON.parse(readFileSync(join(root, "ops.config.json"), "utf8")).publicSync;
  const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0").filter(Boolean);
  const dirs = include.filter((entry) => entry.endsWith("/"));
  const isDocument = (file: string) => /\.(md|html)$/.test(file);
  const unnamed = files.filter(
    (file) =>
      !file.startsWith("private/") &&
      (file.startsWith("docs/") || (isDocument(file) && dirs.some((dir) => underEntry(file, dir)))) &&
      !include.includes(file) &&
      !exclude.some((entry) => underEntry(file, entry)),
  );
  expect(unnamed).toEqual([]);
  // The affected-tests selection finds this check only through test-reads: it must declare the whole tree, so a new root entry is found too.
  const reads = parseReads(readFileSync(import.meta.path, "utf8"));
  expect(reads).toEqual(["./"]);
});
