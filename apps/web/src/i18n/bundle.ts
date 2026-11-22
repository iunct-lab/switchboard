import { msgs } from "../i18n.ts";

/** The Backlog's bundle section and the line shown while a bundle holds the daemon: `components/BundleSection.tsx`, `bundle.ts`. */
export const bundle = msgs({
  sectionTitle: { ja: "まとめて入れる（複数の PBI を 1 本の枝で）", en: "Put in together (several PBIs on one branch)" },
  sectionHeld: { ja: "束の作業中は始められません", en: "cannot start while a bundle is under way" },
  hint: {
    ja: "重なりで後回しが続く PBI の束や構造の変更を、1 つの Task が 1 本の枝で並行に実装し、レビュー（安全に関わるまとまりは別ランナーが攻める側から）を通してスタックで入れます。始めると、有効な定期実行を全部止め、入れ切るまで昇格を止めます。",
    en: "A Task implements PBIs that keep being deferred by overlap, or a structural change, in parallel on one branch, passes review (another runner reads the safety-marked groups as an attacker) and puts them in as a stack. Starting stops every enabled schedule and holds promotion until it is all in.",
  },
  inputLabel: { ja: "PBI の番号", en: "PBI numbers" },
  inputHint: {
    ja: "PBI の番号を 2 つ以上（カンマか空白で区切る）。向かないもの（判断待ち・保留・外の関門）は Task が外して理由を PBI に書きます。",
    en: "Two or more PBI numbers (separated by commas or spaces). Ones that do not fit (waiting for a decision, on hold, behind an outside gate) are left out by the Task, with the reason written on the PBI.",
  },
  start: { ja: "まとめて始める", en: "Start the bundle" },
  startFailed: { ja: "束を始められませんでした: {error}", en: "Could not start the bundle: {error}" },
  holdLine: {
    ja: "束の作業中: 定期実行 {n} 件と昇格を止めています（{since} から、戻す先 {base}）",
    en: "Bundle under way: {n} schedules and promotion are stopped (since {since}, going back to {base})",
  },
  holdUnreadable: {
    ja: "束の作業中: 止めの記録が読めないため、定期実行と昇格を止めたものとして扱っています",
    en: "Bundle under way: the hold's record cannot be read, so schedules and promotion are treated as stopped",
  },
  baseNone: { ja: "なし", en: "none" },
  openTask: { ja: "Task を開く", en: "Open the Task" },
  release: { ja: "止めを解く", en: "Release the hold" },
  releaseConfirm: {
    ja: "止めた定期実行 {n} 件を有効に戻し、昇格を通常に戻します。束のスタックが入り切っていなければ、途中の版が昇格することがあります。",
    en: "This turns the {n} stopped schedules back on and returns promotion to normal. If the bundle's stack is not all in, a half-way version may be promoted.",
  },
  releaseFailed: { ja: "止めを解けませんでした: {error}", en: "Could not release the hold: {error}" },
});
