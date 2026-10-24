import { expect, test } from "bun:test";
import { archiveBanner } from "./archive.ts";

test("the archive banner says when it failed, stopped or last succeeded (#1201)", () => {
  const at = Date.parse("2026-10-11T00:01:00+09:00");
  expect(archiveBanner({ kind: "failed", at, detail: "137" })).toBe("履歴のアーカイブが 10/11 00:01 に失敗しました（終了コード 137）。sb-archive のログ（journalctl -u sb-archive）を確認してください");
  expect(archiveBanner({ kind: "stuck", at })).toBe("履歴のアーカイブが 10/11 00:01 に始まったまま終わっていません（メモリ不足などで止まった可能性）");
  expect(archiveBanner({ kind: "stale", at })).toBe("履歴のアーカイブが 10/11 00:01 から上がっていません");
});
