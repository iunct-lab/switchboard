// test-reads: scripts/local-ci.ts scripts/merge-gate.ts
import { expect, test } from "bun:test";
import { changeMarks, changeStateLabel, mergedPair, LOCAL_CI_RESULT, RECHECK_PASS } from "./changes.ts";
import { t } from "./i18n.ts";
import { backlog as m } from "./i18n/backlog.ts";
import { LOCAL_CI_RESULT as SCRIPT_LOCAL_CI } from "../../../scripts/local-ci.ts";
import { RECHECK_KINDS } from "../../../scripts/merge-gate.ts";

const H = "a".repeat(40);
const B = "b".repeat(40);
const B2 = "c".repeat(40);
const at = (n: number) => `2026-11-04T00:00:0${n}Z`;

test("the local CI mark is read by the script's own pattern", () => {
  expect(LOCAL_CI_RESULT.source).toBe(SCRIPT_LOCAL_CI.source);
});

test("the screen's recheck mark names the same kinds as merge-gate's RECHECK_KINDS", () => {
  const kinds = /\^\\\[recheck\\\] \(([^)]*)\)/.exec(RECHECK_PASS.source)![1]!.split("|");
  expect(kinds).toEqual(RECHECK_KINDS);
});

test("changeMarks: none / the pass of the head and base now / a base moved since (stale) / a fail after the pass", () => {
  const refs = { head: H, base: B };
  expect(changeMarks([{ body: "plain", createdAt: at(1) }], refs)).toEqual({ review: null, localCi: null, rechecks: [] });
  const marked = [
    { body: "[claude] review\n\n### Intent", createdAt: at(1) },
    { body: `[local-ci] pass ${H} base=${B}\n\n表`, createdAt: at(2) },
    { body: `[recheck] size pass ${H}`, createdAt: at(3) },
    { body: `[recheck] responsibility pass ${B}`, createdAt: at(3) },
  ];
  expect(changeMarks(marked, refs)).toEqual({ review: { runner: "claude", at: at(1) }, localCi: "pass", rechecks: ["size"] });
  expect(changeMarks(marked, { head: H, base: B2 }).localCi).toBe("stale");
  expect(changeMarks([...marked, { body: `[local-ci] fail ${H} base=${B}`, createdAt: at(4) }], refs).localCi).toBe("fail");
  // a fail of an older base is a fail, as merge-gate says it
  expect(changeMarks([{ body: `[local-ci] fail ${H} base=${B2}`, createdAt: at(4) }], refs).localCi).toBe("fail");
  // a [dak] review is not a main review
  expect(changeMarks([{ body: "[dak] review", createdAt: at(1) }], refs).review).toBeNull();
});

test("changeMarks reads a gate-support recheck pass of the head, and not one of another head", () => {
  const refs = { head: H, base: B };
  expect(changeMarks([{ body: `[recheck] security:gate-support pass ${H}`, createdAt: at(1) }], refs).rechecks).toEqual(["security:gate-support"]);
  expect(changeMarks([{ body: `[recheck] security:gate-support pass ${B}`, createdAt: at(1) }], refs).rechecks).toEqual([]);
});

test("changeStateLabel: open, merged, closed without a merge", () => {
  expect(changeStateLabel({ state: "OPEN", mergeCommit: null })).toBe("開いている");
  expect(changeStateLabel({ state: "CLOSED", mergeCommit: H })).toBe("マージ済み");
  expect(changeStateLabel({ state: "CLOSED", mergeCommit: null })).toBe("閉じた");
});

test("mergedPair: reviewed → merged in 7 digits, なし for one merged before it was kept, null when not merged", () => {
  expect(mergedPair({ mergeCommit: B, reviewedHead: H })).toBe("aaaaaaa → bbbbbbb");
  expect(mergedPair({ mergeCommit: B, reviewedHead: null })).toBe("なし → bbbbbbb");
  expect(mergedPair({ mergeCommit: null, reviewedHead: null })).toBeNull();
});

test("mergedPair names the change's base", () => {
  const text = t(m.mergedPair, { pair: "aaaaaaa → bbbbbbb", base: "release" });
  expect(text).toContain("release");
  expect(text).not.toContain("main");
  expect(text).toContain("aaaaaaa → bbbbbbb");
});
