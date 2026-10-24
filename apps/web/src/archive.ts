import type { Health } from "./api.ts";
import { jstStamp } from "./time.ts";

/** The top banner for a problem with the daily history archive (#1201). */
export function archiveBanner(p: NonNullable<Health["archive"]>): string {
  const at = jstStamp(p.at);
  if (p.kind === "failed") return `履歴のアーカイブが ${at} に失敗しました（終了コード ${p.detail ?? "不明"}）。sb-archive のログ（journalctl -u sb-archive）を確認してください`;
  if (p.kind === "stuck") return `履歴のアーカイブが ${at} に始まったまま終わっていません（メモリ不足などで止まった可能性）`;
  return `履歴のアーカイブが ${at} から上がっていません`;
}
