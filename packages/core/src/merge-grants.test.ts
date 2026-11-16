import { describe, expect, test } from "bun:test";
import { parseMergeGrants } from "./merge-grants.ts";

describe("parseMergeGrants", () => {
  test("reads the three fixed forms, also on a line of a longer message", () => {
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12 }]);
    expect(parseMergeGrants("PR #7 に [merge-answer] yes を投稿してよい。")).toEqual([{ kind: "answer", target: 7 }]);
    expect(parseMergeGrants("よろしく\nTask #4372 の本文に名指しのパスを足してよい\n以上")).toEqual([{ kind: "scope", target: 4372 }]);
    expect(parseMergeGrants("B — 許可: PR #3 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 3 }]);
  });

  test("a message with several grant sentences gives each of them", () => {
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい\nPR #12 に [merge-answer] yes を投稿してよい")).toEqual([
      { kind: "merge", target: 12 },
      { kind: "answer", target: 12 },
    ]);
    expect(parseMergeGrants("- マージしてよいか: A, B — 許可: PR #12 を判定の外でマージしてよい — 許可: PR #12 に [merge-answer] yes を投稿してよい")).toEqual([
      { kind: "merge", target: 12 },
      { kind: "answer", target: 12 },
    ]);
  });

  test("similar sentences are not grants", () => {
    for (const s of ["PR #12 を判定の外でマージしない", "PR を判定の外でマージしてよい", "PR #x を判定の外でマージしてよい", "PR #12 を判定でマージしてよい", "PR #12 を判定の外でマージしてよいか", "PR #7 に [merge-answer] no を投稿してよい", "Task #4 の本文に名指しのパスを足す", "PR #4 の本文に名指しのパスを足してよい", "Task #4 を判定の外でマージしてよい", "continue", ""]) expect(parseMergeGrants(s)).toEqual([]);
  });
});
