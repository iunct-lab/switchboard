import { expect, test } from "bun:test";
import { scheduleResultLine } from "./scheduleResult.ts";

const at = Date.parse("2026-10-12T03:10:00+09:00"); // JST 10/12 03:10

test("scheduleResultLine: a clean firing, hits, repositories it could not check, a failed scan", () => {
  expect(scheduleResultLine({ action: "secret-scan", lastResult: { at, repos: 3, hits: 0, failed: 0, lines: [] } })).toBe("最後の検査 10/12 03:10: 3 リポジトリ / 当たり 0 件");
  expect(scheduleResultLine({ action: "secret-scan", lastResult: { at, repos: 4, hits: 2, failed: 0, lines: [] } })).toBe("最後の検査 10/12 03:10: 4 リポジトリ / 当たり 2 件");
  expect(scheduleResultLine({ action: "secret-scan", lastResult: { at, repos: 4, hits: 2, failed: 3, lines: [] } })).toBe("最後の検査 10/12 03:10: 4 リポジトリ / 当たり 2 件 / 検査できなかった 3");
  expect(scheduleResultLine({ action: "secret-scan", lastResult: { at, repos: 0, hits: 0, failed: 1, lines: ["検査が失敗した（Error。理由は scan_issues.sh を手で走らせて見る）"] } })).toBe("最後の検査 10/12 03:10: 失敗（検査が失敗した（Error。理由は scan_issues.sh を手で走らせて見る））");
  // two checkouts the scanner could not place, no repository checked: a result with its count, not "the scan failed"
  expect(scheduleResultLine({ action: "secret-scan", lastResult: { at, repos: 0, hits: 0, failed: 2, lines: ["a: 検査できなかった（リポジトリを特定できない）", "b: 検査できなかった（リポジトリを特定できない）"] } })).toBe("最後の検査 10/12 03:10: 0 リポジトリ / 当たり 0 件 / 検査できなかった 2");
});

test("scheduleResultLine: nothing for the other actions and before the first firing", () => {
  expect(scheduleResultLine({ action: "secret-scan", lastResult: null })).toBeNull();
  expect(scheduleResultLine({ action: "prompt", lastResult: null })).toBeNull();
  expect(scheduleResultLine({ action: "backlog-next", lastResult: { at, repos: 1, hits: 0, failed: 0, lines: [] } })).toBeNull();
});
