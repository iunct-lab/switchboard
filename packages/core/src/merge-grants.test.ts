// test-reads: ops-kit/bin/gh ops-kit/src/backlog-client.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { findGrantSentences, parseMergeGrants } from "./merge-grants.ts";

/** The allowing sentence of the older release (no longer read): split so a search for it finds only the code that would read it. */
const OLD = "[merge-answer] yes" + " を投稿してよい";

// the sentence that let a Task add a path to its body: built in two parts so that a search for the sentence finds no live one
const GONE = (n: number, repo = "") => `${repo}Task #${n} の本文に` + "名指しのパスを" + "足してよい";

describe("parseMergeGrants", () => {
  test("reads the two fixed forms, also on a line of a longer message", () => {
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: null }]);
    expect(parseMergeGrants("PR #7 をマージしてよい。")).toEqual([{ kind: "answer", target: 7, repo: null }]);
    // the sentence that let a Task add a path to its body is not read any more
    expect(parseMergeGrants(`よろしく\n${GONE(4372)}\n以上`)).toEqual([]);
    expect(parseMergeGrants("B — 許可: PR #3 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 3, repo: null }]);
  });

  test("the ask reason has its own sentence for a PR and for a change of the workspace; the older sentence that asked for a posted mark is not read", () => {
    expect(parseMergeGrants("PR #12 をマージしてよい")).toEqual([{ kind: "answer", target: 12, repo: null }]);
    expect(parseMergeGrants("o/b の PR #12 をマージしてよい")).toEqual([{ kind: "answer", target: 12, repo: "o/b" }]);
    // the ask sentence is everyday wording, so it is read only as a whole line (a list mark before it is fine): with words
    // before it, a condition among them, the line is left to the reader of the person's own words
    for (const line of ["必須のチェックが通ったら PR #12 をマージしてよい", "CI が緑なら、PR #12 をマージしてよい。", "PR #11 は待って。PR #12 をマージしてよい", "テストが通ったら 変更 L3 をマージしてよい"]) expect([line, parseMergeGrants(line)]).toEqual([line, []]);
    expect(parseMergeGrants("- PR #12 をマージしてよい")).toEqual([{ kind: "answer", target: 12, repo: null }]);
    // after the words of a free answer it is not read by letters (a chosen option's sentence comes as a structure instead)
    expect(parseMergeGrants("はい — 許可: PR #12 をマージしてよい")).toEqual([]);
    expect(parseMergeGrants("変更 L3 をマージしてよい。")).toEqual([{ kind: "answer", target: 3, repo: null, change: true }]);
    // a change names no repository, and has no merge-outside-the-gate sentence
    expect(parseMergeGrants("o/b の 変更 L3 をマージしてよい")).toEqual([]);
    expect(parseMergeGrants("変更 L3 を判定の外でマージしてよい")).toEqual([]);
    // the merge outside the gate is not read as the ask reason's sentence, nor the other way round
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: null }]);
    // the sentence that offered to post the gate's mark is read as nothing, a whole line or not, and a stop's wording of it too
    for (const old of [`PR #12 に ${OLD}`, `o/b の PR #12 に ${OLD}。`, `A — 許可: PR #12 に ${OLD}`]) expect([old, parseMergeGrants(old)]).toEqual([old, []]);
    expect(findGrantSentences(`\`PR #5 に ${OLD}\` で通ります`)).toEqual([]);
    expect(findGrantSentences("`変更 L3 をマージしてよい` と `PR #4 をマージしてよい` で通ります")).toEqual([{ kind: "answer", target: 4, repo: null }, { kind: "answer", target: 3, repo: null, change: true }]);
  });

  test("the ask sentence is read only when the whole message is fixed sentences (quoted and empty lines aside)", () => {
    const ask = (n: number) => ({ kind: "answer" as const, target: n, repo: null });
    for (const text of ["CI が通った場合だけ、次の許可を出します\nPR #12 をマージしてよい", "PR #12 をマージしてよい\nただし明日以降", "条件: テスト\n- PR #12 をマージしてよい\n- PR #13 をマージしてよい"]) expect([text, parseMergeGrants(text)]).toEqual([text, []]);
    expect(parseMergeGrants("PR #12 をマージしてよい")).toEqual([ask(12)]);
    expect(parseMergeGrants("- PR #12 をマージしてよい\n- PR #13 をマージしてよい")).toEqual([ask(12), ask(13)]);
    expect(parseMergeGrants("> 前の文\n\nPR #12 をマージしてよい\n")).toEqual([ask(12)]);
    // the merge sentence and the ask sentence together are still only fixed sentences
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい\nPR #12 をマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: null }, ask(12)]);
    // the two forms from before are read as they were, a condition line or not
    expect(parseMergeGrants("条件あり\nPR #12 を判定の外でマージしてよい")).toEqual([{ kind: "merge", target: 12, repo: null }]);
  });

  test("a message with several grant sentences gives each of them", () => {
    expect(parseMergeGrants("PR #12 を判定の外でマージしてよい\nPR #12 をマージしてよい")).toEqual([
      { kind: "merge", target: 12, repo: null },
      { kind: "answer", target: 12, repo: null },
    ]);
    expect(parseMergeGrants("- マージしてよいか: A, B — 許可: PR #12 を判定の外でマージしてよい — 許可: PR #13 を判定の外でマージしてよい")).toEqual([
      { kind: "merge", target: 12, repo: null },
      { kind: "merge", target: 13, repo: null },
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
    expect(parseMergeGrants("> PR #12 を判定の外でマージしてよい\n\nPR #13 を判定の外でマージしてよい\n>> PR #14 をマージしてよい")).toEqual([{ kind: "merge", target: 13, repo: null }]);
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
    // these refusing sides (the check in front of gh, the backlog command) print only the sentence of the merge outside the gate; the ask reason's sentence is printed by the gate itself
    expect([...kinds].sort()).toEqual(["merge"]);
  });
});

test("the ask consent is answered by a record of the merge outside the gate at the same head, and the merge only by its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-grant-kinds-"));
  const db = new Db(join(dir, "switchboard.db"));
  const H = "a".repeat(40);
  const M = "b".repeat(40);
  const ask = (kind: string, target: number, head = H, repo = "o/a") => db.hasMergeGrant("t_k", repo, kind, target, head);
  // a record of the merge answers both questions, for its own PR, repository and head
  db.recordMergeGrant({ taskId: "t_k", repo: "o/a", kind: "merge", target: 12, by: "owner", head: H });
  expect([ask("merge", 12), ask("answer", 12), ask("answer", 12, M), ask("answer", 13), ask("answer", 12, H, "o/b")]).toEqual([true, true, false, false, false]);
  // a record of the ask consent answers only that question: it never lets the merge outside the gate through
  db.recordMergeGrant({ taskId: "t_k", repo: "o/a", kind: "answer", target: 14, by: "owner", head: H });
  expect([ask("answer", 14), ask("merge", 14)]).toEqual([true, false]);
  // a change of the workspace is kept under the workspace's name and is as exact
  db.recordMergeGrant({ taskId: "t_k", repo: "local:ws_1", kind: "answer", target: 3, by: "owner", head: H });
  expect([ask("answer", 3, H, "local:ws_1"), ask("answer", 3, M, "local:ws_1"), ask("answer", 3, H, "local:ws_2"), ask("merge", 3, H, "local:ws_1")]).toEqual([true, false, false, false]);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
