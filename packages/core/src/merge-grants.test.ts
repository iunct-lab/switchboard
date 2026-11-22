// test-reads: ops-kit/bin/gh ops-kit/src/backlog-client.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMergeGrants } from "./merge-grants.ts";

// the sentence that let a Task add a path to its body: built in two parts so that a search for the sentence finds no live one
const GONE = (n: number, repo = "") => `${repo}Task #${n} の本文に` + "名指しのパスを" + "足してよい";

describe("parseMergeGrants", () => {
  test("reads the two fixed forms, also on a line of a longer message", () => {
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: null }]);
    expect(parseMergeGrants("PR #7 に [merge-answer] yes を投稿してよい。")).toEqual([{ kind: "answer", target: 7, repo: null }]);
    // the sentence that let a Task add a path to its body is not read any more
    expect(parseMergeGrants(`よろしく\n${GONE(4372)}\n以上`)).toEqual([]);
    expect(parseMergeGrants("B — 許可: PR #3 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 3, repo: null }]);
  });

  test("a message with several grant sentences gives each of them", () => {
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい\nPR #12 に [merge-answer] yes を投稿してよい")).toEqual([
      { kind: "merge", target: 12, repo: null },
      { kind: "answer", target: 12, repo: null },
    ]);
    expect(parseMergeGrants("- マージしてよいか: A, B — 許可: PR #12 を判定の外でマージしてよい — 許可: PR #12 に [merge-answer] yes を投稿してよい")).toEqual([
      { kind: "merge", target: 12, repo: null },
      { kind: "answer", target: 12, repo: null },
    ]);
  });

  test("a sentence may name its repository; without a name the repository is left to the task's", () => {
    expect(parseMergeGrants("o/b の PR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: "o/b" }]);
    expect(parseMergeGrants(`A — 許可: ${GONE(5, "iunct-lab/dak.x の ")}。`)).toEqual([]);
    // only the fixed head names a repository: other words before the sentence are not read, as before
    expect(parseMergeGrants("o/b では PR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: null }]);
    expect(parseMergeGrants("o/b のPR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: null }]);
  });

  test("a quoted line is not read; the same text's own lines are", () => {
    expect(parseMergeGrants("> PR #12 を判定の外でマージしてよい")).toEqual([]);
    expect(parseMergeGrants("  > A — 許可: PR #12 を判定の外でマージしてよい")).toEqual([]);
    expect(parseMergeGrants("> PR #12 を判定の外でマージしてよい\n\nPR #13 を判定の外でマージしてよい\n>> PR #14 に [merge-answer] yes を投稿してよい")).toEqual([{ kind: "merge", target: 13, repo: null }]);
  });

  test("similar sentences are not grants", () => {
    for (const s of ["PR #12 を判定の外でマージしない", "PR を判定の外でマージしてよい", "PR #x を判定の外でマージしてよい", "PR #12 を判定でマージしてよい", "PR #12 を判定の外でマージしてよいか", "PR #7 に [merge-answer] no を投稿してよい", "Task #4 の本文に名指しのパスを足す", GONE(4).replace("Task", "PR"), "Task #4 を判定の外でマージしてよい", "continue", ""]) expect(parseMergeGrants(s)).toEqual([]);
  });

  test("the sentence each refusing side prints is one grant of its kind: what the stop report tells a Task to copy", () => {
    const root = join(import.meta.dir, "../../..");
    // the sentences in 「…」 that the front of gh and the kit's backlog print when they refuse, with a number filled in
    const printed = ["ops-kit/bin/gh", "ops-kit/src/backlog-client.ts"].flatMap((f) => [...readFileSync(join(root, f), "utf8").matchAll(/「((?:PR|Task) #[^」]*してよい)」/g)].map((m) => m[1]!.replace(/<番号>|\$\{[^}]*\}/g, "12")));
    const kinds = new Set(printed.map((line) => {
      const grants = parseMergeGrants(line);
      expect({ line, grants: grants.length }).toEqual({ line, grants: 1 });
      return grants[0]!.kind;
    }));
    expect([...kinds].sort()).toEqual(["answer", "merge"]);
  });
});
