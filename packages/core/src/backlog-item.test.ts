import { describe, expect, test } from "bun:test";
import { POST_MERGE_KINDS } from "@switchboard/protocol";
import { POST_MERGE_KINDS as LINT_POST_MERGE_KINDS } from "../../../ops-kit/src/lint.ts";
import { pbiFactsOf, postMergeOf } from "./backlog-item.ts";
import { pbiProgress } from "./pbi-progress.ts";

const pbi = (...rows: string[]) => `## ユーザーストーリー\nx\n\n## 到達点 / 受け入れ条件\n${rows.join("\n")}\n\n## スコープ外\n- [ ] 数えない（マージの後: 画面）\n`;
const due = "2026-12-01T00:00:00+09:00";

describe("postMergeOf", () => {
  test("the kinds the app reads are the kinds the kit's lint checks", () => {
    expect([...POST_MERGE_KINDS]).toEqual([...LINT_POST_MERGE_KINDS]);
  });

  test("reads the four kinds of an unchecked line, numbered as the criteria are", () => {
    const body = pbi("- [x] 1. 済み", "- [ ] 2. a（マージの後: 画面）", "- [ ] 3. b（マージの後: E2E 回す）", "- [ ] 4. c（マージの後: 実ランナー）", `- [ ] 5. d（マージの後: 観測 期日 ${due} 以降）`);
    expect(postMergeOf(body).map(({ n, kind, after }) => ({ n, kind, after }))).toEqual([
      { n: 2, kind: "画面", after: null }, { n: 3, kind: "E2E", after: null }, { n: 4, kind: "実ランナー", after: null }, { n: 5, kind: "観測", after: due },
    ]);
    expect(postMergeOf(body)[0]!.text).toBe("2. a（マージの後: 画面）");
  });

  test("an 観測 without a time, or with one afterTime cannot read, has no date", () => {
    const body = pbi("- [ ] 1. a（マージの後: 観測 7 日）", "- [ ] 2. b（マージの後: 観測 期日 2026-12-01 以降）", "- [ ] 3. c（マージの後: 観測）");
    expect(postMergeOf(body).map((c) => [c.kind, c.after])).toEqual([["観測", null], ["観測", null], ["観測", null]]);
  });

  test("a mark inside inline code, a checked line, a line without a mark and another kind are not read", () => {
    const body = pbi("- [ ] 1. 書き方の説明 `（マージの後: 画面）` の形", "- [x] 2. 済み（マージの後: 画面）", "- [ ] 3. ただの行", "- [ ] 4. 手動（マージの後: 手動）", "- [ ] 5. 利用者（利用者確認: 見る）");
    expect(postMergeOf(body)).toEqual([]);
  });
});

describe("pbiFactsOf with after-merge lines", () => {
  const facts = (body: string, done = 2) => pbiFactsOf({ labels: ["type:pbi"], body, status: "In progress", tasks: { total: 2, done } });

  test("after-merge lines are not other criteria, and only they make the PBI checking and not closable", () => {
    const f = facts(pbi("- [x] 1. 済み", "- [ ] 2. a（マージの後: 画面）", "- [ ] 3. b（マージの後: E2E）"));
    expect(f).toMatchObject({ others: 0, confirms: [], postMerge: [2, 3] });
    expect(pbiProgress(f)).toMatchObject({ checking: true, closable: false, closableByApi: true, prereqMet: true, closesOnAnswer: null });
  });

  test("another unchecked criterion, or an open Task, is not checking", () => {
    const body = pbi("- [ ] 1. 直す（検証: テスト）", "- [ ] 2. a（マージの後: 画面）");
    expect(facts(body)).toMatchObject({ others: 1, postMerge: [2] });
    expect(pbiProgress(facts(body)).checking).toBe(false);
    expect(pbiProgress(facts(pbi("- [ ] 1. a（マージの後: 画面）"), 1)).checking).toBe(false);
  });

  test("a line with both marks stays the user's check", () => {
    const f = facts(pbi("- [ ] 1. a（マージの後: 画面）（利用者確認: 見る）"));
    expect(f).toMatchObject({ others: 0, confirms: [1], postMerge: [] });
    expect(pbiProgress(f).checking).toBe(false);
  });
});

describe("pbiFactsOf reads the body through a memo", () => {
  const facts = (body: string, over: { labels?: string[]; done?: number } = {}) => pbiFactsOf({ labels: over.labels ?? ["type:pbi"], body, status: "In progress", tasks: { total: 2, done: over.done ?? 2 } });

  test("a body edited between two reads is read again, and the same body again answers the same", () => {
    const before = pbi("- [ ] 1. a（マージの後: 画面）", "- [ ] 2. 直す");
    expect(facts(before)).toMatchObject({ others: 1, confirms: [], postMerge: [1] });
    const after = pbi("- [x] 1. a（マージの後: 画面）", "- [ ] 2. 直す（利用者確認: 見る）");
    expect(facts(after)).toMatchObject({ others: 0, confirms: [2], postMerge: [] });
    expect(facts(before)).toMatchObject({ others: 1, confirms: [], postMerge: [1] });
  });

  test("the parts that are not the body's (labels, Tasks) are not kept with it, and a caller changing an array does not change the next read", () => {
    const body = pbi("- [ ] 1. a（マージの後: 画面）");
    const first = facts(body, { labels: ["type:pbi", "needs-decision"], done: 1 });
    expect(first).toMatchObject({ pbi: true, decision: true, tasks: { total: 2, done: 1 } });
    first.postMerge.push(99);
    first.confirms.push(98);
    expect(facts(body, { labels: [], done: 2 })).toMatchObject({ pbi: false, decision: false, tasks: { total: 2, done: 2 }, confirms: [], postMerge: [1] });
  });

  test("past the limit the oldest are dropped and a dropped body is read again to the same answer", () => {
    const first = pbi("- [ ] 1. c（マージの後: 画面）");
    const expected = facts(first);
    for (let i = 0; i < 4100; i++) facts(pbi(`- [ ] 1. b${i}（利用者確認: 見る）`));
    expect(facts(first)).toEqual(expected);
  });
});
