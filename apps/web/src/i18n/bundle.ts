import { msgs } from "../i18n.ts";

/** The Backlog's bundle button and confirmation, and the line shown while a bundle holds the daemon: `components/BundleSection.tsx`, `bundle.ts`. */
export const bundle = msgs({
  button: { ja: "1 本の枝でまとめて実装…", en: "Implement together on one branch…" },
  confirmTitle: { ja: "1 本の枝でまとめて実装", en: "Implement together on one branch" },
  confirmWarn: { ja: "始めると、有効な定期実行を全部止め、入れ切るまで昇格を止めます。", en: "Starting stops every enabled schedule and holds promotion until it is all in." },
  confirmNote: {
    ja: "向かないもの（判断待ち・保留・外の関門）は Task が外して理由を PBI に書きます。",
    en: "Ones that do not fit (waiting for a decision, on hold, behind an outside gate) are left out by the Task, with the reason written on the PBI.",
  },
  cancel: { ja: "やめる", en: "Cancel" },
  gateOther: {
    ja: "まとめて実装は、Switchboard 自身の PBI を 2 件以上選んだときだけ使えます（{workspace} の #{n} が入っています）",
    en: "Implementing together works only with two or more PBIs of Switchboard itself ({workspace} #{n} is in the selection)",
  },
  gateOne: {
    ja: "まとめて実装は、Switchboard 自身の PBI を 2 件以上選んだときだけ使えます（1 件だけ選んでいます）",
    en: "Implementing together works only with two or more PBIs of Switchboard itself (only one is selected)",
  },
  gateHeld: { ja: "束の作業中は始められません", en: "Cannot start while a bundle is under way" },
  gateHoldUnread: {
    ja: "束の作業中かどうかを読めなかったため始められません。「再読込」で読み直してください",
    en: "Cannot start: whether a bundle is under way could not be read. Read again with Reload",
  },
  gateWorkspacesUnread: {
    ja: "リポジトリの一覧を読めなかったため始められません。「再読込」で読み直してください",
    en: "Cannot start: the list of repositories could not be read. Read again with Reload",
  },
  closedHeld: { ja: "束の作業中になったため確認を閉じました", en: "The confirmation was closed because a bundle is now under way" },
  closedChanged: { ja: "選んだ行が変わったため確認を閉じました", en: "The confirmation was closed because the selected rows changed" },
  closedThen: { ja: "{closed}。{next}", en: "{closed}. {next}" },
  reopen: { ja: "選び直した行で開き直してください", en: "Open it again with the rows as chosen now" },
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
