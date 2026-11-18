// test-reads: apps/web/src/i18n.ts apps/web/src/i18n/task.ts
import { expect, test } from "bun:test";
import { readOnlyReason, uplinkSkippedBanner } from "./machine.ts";

test("a Task that ran on another machine says why it is read only, in the API's words; this instance's own has no reason", () => {
  expect(readOnlyReason({ machine: "pc1" })).toBe("この Task は pc1 で動きました。返信は pc1 の Switchboard から行います。");
  expect(readOnlyReason({ machine: null })).toBeNull();
  expect(readOnlyReason({})).toBeNull();
});

test("the band names each machine once with both database levels, and there is none when nothing waits", () => {
  expect(uplinkSkippedBanner(undefined)).toBeNull();
  expect(uplinkSkippedBanner([])).toBeNull();
  expect(uplinkSkippedBanner([{ machine: "pc1", theirs: 300, ours: 297 }, { machine: "pc1", theirs: 301, ours: 297 }, { machine: "pc2", theirs: 299, ours: 297 }])).toBe(
    "pc1 の記録を取り込めていません: pc1 の DB の版 301 が、このインスタンスの版 297 より新しいためです。このインスタンスを更新すると取り込みます / pc2 の記録を取り込めていません: pc2 の DB の版 299 が、このインスタンスの版 297 より新しいためです。このインスタンスを更新すると取り込みます",
  );
});
