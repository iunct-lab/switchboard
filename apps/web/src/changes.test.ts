// test-reads: scripts/merge-gate.ts
import { expect, test } from "bun:test";
import { changeMarks, changeStateLabel, LOCAL_CI_RESULT, RECHECK_PASS, REVIEW } from "./changes.ts";
import { LOCAL_CI_RESULT as SCRIPT_LOCAL_CI } from "../../../scripts/local-ci.ts";
import { RECHECK_PASS as SCRIPT_RECHECK } from "../../../scripts/merge-gate.ts";

const H = "a".repeat(40);
const B = "b".repeat(40);
const B2 = "c".repeat(40);
const at = (n: number) => `2026-11-04T00:00:0${n}Z`;

test("the marks are read by the scripts' own patterns (#2486)", async () => {
  expect(LOCAL_CI_RESULT.source).toBe(SCRIPT_LOCAL_CI.source);
  expect(RECHECK_PASS.source).toBe(SCRIPT_RECHECK.source);
  const gate = Bun.file(new URL("../../../scripts/merge-gate.ts", import.meta.url));
  expect(await gate.text()).toContain(`const REVIEW = ${REVIEW.toString()};`);
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

test("changeStateLabel: open, merged, closed without a merge", () => {
  expect(changeStateLabel({ state: "OPEN", mergeCommit: null })).toBe("開いている");
  expect(changeStateLabel({ state: "CLOSED", mergeCommit: H })).toBe("マージ済み");
  expect(changeStateLabel({ state: "CLOSED", mergeCommit: null })).toBe("閉じた");
});
