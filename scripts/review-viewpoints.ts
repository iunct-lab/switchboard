/**
 * The viewpoints a reviewer reads a PR from, one per recheck kind a reader decides: the text added to the review's
 * instructions. This is the one place the texts are kept. `bun scripts/merge-gate.ts <PR> --viewpoints` prints the ones
 * the PR asks for (the kinds of its `[再チェック <kind>]` reasons), for the main review right after the PR is opened. The
 * recheck of every kind here but `size` adds the same text to its instructions (docs/merge-gate.md, "Recheck").
 */
export type ViewpointKind = "size" | "responsibility" | "design-rules" | "security:docs" | "security:tests";

export const VIEWPOINTS: Record<ViewpointKind, string> = {
  size: "PR 全体を、変更の大きさから来る見落とし（境界・状態の組み合わせ・古い前提）の観点で読む",
  responsibility: "責務のファイル（`[再チェック responsibility]` の理由のパス）の変更が、`_review/pbi.md` の受け入れ条件と `_review/request.md`（元要望）の求める範囲か。範囲外の変更を 1 行ずつ `[should-fix]` で挙げる",
  "design-rules": "変わった規則が README のほかの規則・既存の設計文書と矛盾しないか、`_review/request.md`（元要望）の求める範囲か。矛盾と範囲外を 1 行ずつ `[should-fix]` で挙げる",
  "security:docs": "`[再チェック security:docs]` の理由のパスの変更が文書だけか（手順・コマンド・設定の値を変えて、読んだ人や Task がしてよいことを広げていないか）、`_review/pbi.md` の受け入れ条件と `_review/request.md`（元要望）の求める範囲か。広げる変更と範囲外を 1 行ずつ `[should-fix]` で挙げる",
  "security:tests": "`[再チェック security:tests]` の理由のパスの変更がテスト・fixture か、`aws/host/**` のコメント・空行だけか。認証・承認・サンドボックスを守るテストの期待を消す・弱めていないか。コメントに見えて実行される行（行末継続の続き・here-document の中身など）を隠していないか。秘密の値を含まないか。当たるものを 1 行ずつ `[should-fix]` で挙げる",
};

/** The viewpoints of the given kinds, each under `## 観点: <kind>`, in the order given; a kind with no viewpoint is left out. Empty when none is left. */
export function viewpointsOf(kinds: readonly string[]): string {
  const known = kinds.filter((k): k is ViewpointKind => Object.hasOwn(VIEWPOINTS, k));
  return known.map((k) => `## 観点: ${k}\n\n${VIEWPOINTS[k]}\n`).join("\n");
}
