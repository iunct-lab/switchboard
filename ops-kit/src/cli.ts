#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BACKLOG_USAGE, readRecords, repoName, repoTop, runBacklog, triageUsage } from "./backlog-client.ts";
import { JOB_USAGE, runJob } from "./job-client.ts";
import { runTask, TASK_USAGE } from "./task-client.ts";
import { bootstrap } from "./bootstrap.ts";
import { defaultConfig, findConfig, loadConfig, loadPublicSync, projectOf, publicCopyRefusal, resolveProject, sectionName, type OpsConfig } from "./config.ts";
import { realGh, repoOf, type GhClient } from "./gh.ts";
import { exportCopy } from "./export-copy.ts";
import { resolveReviewThread } from "./forge-github.ts";
import { forgeTargetOf, originOf, remoteOf } from "./forge.ts";
import { createGitlabMr, gitlabMrDiscussions, resolveGitlabDiscussion, runGlab, startGitlabDiscussion, viewGitlabMr, type Sh } from "./forge-gitlab.ts";
import { withHeavySlot } from "./heavy.ts";
import { IDLE_KILLED_LINE, IDLE_SECONDS_MAX, runIdle } from "./idle-run.ts";
import { parseWaitArgs, runWait, WAIT_USAGE } from "./wait.ts";
import { checkCompared, comparePrompt, leftoverRequests, parseCompared } from "./review-compare.ts";
import { attackPrompt } from "./review-attack.ts";
import { arbiterPrompt, checkRulings } from "./review-arbiter.ts";
import { isReviewer, REVIEW_RULES, REVIEWER_NOTE, type Reviewer } from "./review-note.ts";
import { addedLines, handledFindings, oldPathHits, oldPathsItem, oldPathsReport, type Hit, type InlineComment } from "./review-material.ts";
import { formatLint, lint } from "./lint.ts";
import { KNOWN_FAILURES_FILE, parseKnownFailures } from "./known-failures.ts";
import { findIssueRefs, publicFiles } from "./issue-refs.ts";
import { pullMain } from "./pull-main.ts";
import { gitIn, pushRebased } from "./push-rebased.ts";
import { depsCheck } from "./deps-check.ts";
import { realDepsCheckDeps } from "./deps-check-io.ts";
import { check, spawnRun, sync, withStaleNote } from "./public-sync.ts";
import { checkRequestBody, createRequest } from "./request.ts";
import { scanIssues } from "./scan.ts";
import { findSecrets, hostAws } from "./secrets.ts";
import { setField, UsageError } from "./set.ts";
import { parseLabels, syncLabels } from "./labels.ts";
import { reconcileProject, triage } from "./triage.ts";

const SCAN_TEXT_USAGE = `  scan-text <file|->
      文（ファイル、- は標準入力）に認証に使える値（device code、承認 URL、トークン、鍵、アカウント ID、ホストの AWS の設定のプロファイル名・SSO のセッション名など）が無いか検査する
      出力は <file>:<行>: <種類>。値は出さない。exit 0 = 無い、1 = ある、2 = 読めなかった。設定ファイルは要らない`;

const ISSUE_REFS_USAGE = `  issue-refs [<path>...]
      コードのコメント（//・/* */・SQL の --・シェルや YAML の #・HTML の <!-- -->）とテストの名前（test / it / describe の第 1 引数。test.skipIf(x)(…)・test.each(rows)(…) のような修飾子の後ろの呼び出しなら、その呼び出しの第 1 引数）にある Issue 番号 #N を出す。文字列のデータ・色コード・URL の # は見ない。*.md と画像などは見ない
      <path>（リポジトリの top からのファイルかディレクトリ）を渡せばその下の git のファイル、渡さなければ設定の publicSync の include / exclude が選ぶファイル
      出力は <path>:<行>: <行の文>、最後に hits: <当たり> / files: <読んだファイル>。exit 0 = 無い、1 = ある、2 = 読めなかった（設定・git の失敗）`;

const DEPS_CHECK_USAGE = `  deps-check [--file-request]
      依存の脆弱性（bun audit / pip-audit）・major の遅れ・現在の版の公開から 90 日以上（bun outdated・bun info / uv lock --upgrade --dry-run・PyPI）を検査して表にする。bun.lock のあるリポジトリと、uv.lock のあるディレクトリ（root に限らない）向け。両方あれば表は 1 つで、場所の列で分ける
      既出（開いた PR のうち bun.lock / package.json / uv.lock / pyproject.toml を変えるものが扱っている依存）は表から除く。「## 更新の条件」は道具の既定の文に、設定の depsCheck.extraConditions を足す
      --file-request: 当たれば題「依存の更新: <YYYY-MM>」の要望を 1 件起票し（同じ題の開いた要望があればコメントで足し、送信待ちで番号が無ければ足さない）、最後に「要望: …」の 1 行を出す
      exit 0 = 当たらない、1 = 当たった、2 = 道具が走らなかった・要望を出せなかった`;

const USAGE = `使い方: bun ops-kit/src/cli.ts <command> [--config <ops.config.json>] ...

  set <issue> <field> <value>
      Issue 1 件の Project フィールドを 1 つ設定する（単一選択 / 数値 / テキスト / 日付）。Project に無ければ追加する
      例: set 16 Status Ready / set 16 "Story Points" 5
      BACKLOG_URL がある（アプリの Task の中）なら GitHub に書かずアプリに保存する（backlog set / backlog triage と同じ。triage も）
  ${triageUsage(true)}
      Issue を Project に入れ、Priority /（Phase）/ Status と親（Task の親 PBI）を設定する
      <phase> は設定に fields.phase があるときだけ渡す。<parent> を飛ばすなら "" を渡す。<status> の既定は Backlog
  reconcile-project [--dry-run]
      open の Issue / PR のうち Project に無いものだけを追加する（フィールドは付けない。既にある item は触らない）。
      Actions の project-autoadd が動かないときの代わり。--dry-run は追加するものを出すだけ
      BACKLOG_URL がある（アプリの Task の中）なら GitHub を読み書きせず exit 1（--dry-run も）。取り込み済みの要望・PBI・Task 1 件なら backlog triage、ほかは Task の外で回す

  lint [--no-project] [--fresh]
      open の PBI / Task / 要望が記載規約（設定の sections とキットの Story Points の尺度）を満たすか検査する。1 つのクエリ（100 件ずつ）で読む
      BACKLOG_URL がある（アプリの Task の中）なら GitHub ではなくアプリの保存値を読む（Project はアプリがその workspace に読むもの）。
      --fresh: その前にアプリに送信と取込みをさせる。アプリが GitHub に届かなければ保存値を検査し「GitHub 未同期」を出す。
      アプリに届かない・未取得は 2（gh には切り替えない）
      exit 0 = 合格、1 = 違反あり、2 = 検査できなかった（取得の失敗、形の違い、Project が見つからない）
      --no-project: Project（Story Points / Status）を見ない。gh に project の権限が無い環境用
      GitHub 連携の無い workspace（BACKLOG_WORKSPACE があり GH_REPO が無い）で ops.config.json が無ければ、雛形 ops-kit/template/ops.config.json の値で検査する

  bootstrap <title> [--dry-run]
      Project を用意する（設定の Project、無ければ同じ題の Project、それも無ければ作る）。設定の Priority /
      （Phase）の単一選択と数値の Story Points のうち、無いフィールドを作る。何度実行してもよい
      Status の選択肢は、この実行で作った Project にだけ Backlog / Ready / In progress / In review / Done を入れる（既存の
      Project の Status を書き換えると全 item の Status が消えるので、足りない選択肢を出すだけ）。ビューは UI で作る
      BACKLOG_URL がある（アプリの Task の中）なら GitHub を読み書きせず exit 1（--dry-run も）。Task の外で回す（新しいリポジトリは new-repo スキルの手順）
  request <title> <body-file>
      要望 Issue（type:request）を本文のファイルから作り、Project に Status Backlog で入れる。設定の sections.request の
      節が本文に無ければ作らない。BACKLOG_URL がある（アプリの Task の中）なら gh で作らず backlog create でアプリに保存する

${BACKLOG_USAGE}
${JOB_USAGE}
${TASK_USAGE}

  pull-main
      main の作業ツリー（git worktree list の最初）を upstream に fast-forward する。fast-forward できない・未コミットの変更が取り込むファイルと重なる・detached・upstream 無しは何も変えず理由を出して exit 1、fetch できない・Git でないは exit 2。設定ファイルは要らない
  sync-labels [<file>] [--dry-run]
      リポジトリのラベルを <file>（既定 .github/labels.yml）に合わせる。無いものを作り、色・説明が違うものを直す。
      <file> に無いラベルは消さない。--dry-run は変えるものを出すだけ。設定ファイルは要らない
      BACKLOG_URL がある（アプリの Task の中）なら GitHub を読み書きせず exit 1（--dry-run も）。Task の中で反映するなら env -u BACKLOG_URL ops-kit sync-labels
${SCAN_TEXT_USAGE}
${ISSUE_REFS_USAGE}
  scan-issues [<owner/name>] [--since <ISO 8601>] [--recheck <URL>]...
      リポジトリの Issue・PR の題と本文、コメント、PR のレビューコメントとレビュー本文を全部、同じ検査に通す。出力は <URL>: <種類>（<行> 行目）と、最後に hits: <当たり> / scanned: <読んだ文の数>
      --since はその時刻より後に更新されたものだけを読む。--recheck は前回の当たりの場所（URL）を差分の外でも読み直す（何回でも）
      exit 0 = 無い、1 = ある、2 = 検査できなかった（取得の失敗）。<owner/name> を省くと GH_REPO、無ければ origin。設定ファイルは要らない

  public-sync [--source <ref>] [--dry-run] [--adopted] [--adopt-baseline] [--target-url <url>]
      main のツリーだけを（履歴なしで）公開リポジトリへ送る。公開先・送るもの・外すファイル・書き換えるファイルは設定の publicSync だけを読む
      設定は送るツリー（--source）のものを読む。初回は main へ根のコミット、2 回目からは sync/<タグ> の PR を開いて自分でマージし、題が版なら Release を付ける。
      Private のリポジトリ名・ホームパス・個人のメールアドレス・秘密の形の値（変わる行）があれば送らない。前回より古い --source は送らない。--dry-run は送らず結果だけ出す
      --adopted: 公開側だけの変更を Private に取り込み済みとして、置き換えて送る。--source の既定は origin/main
      --adopt-baseline: independent で、公開済みで台帳の無い公開先の今の公開 main を、変えずに v0.1.0 にする（--source は公開 main のツリーの元のタグ。設定は origin/main のものを読む）
      exit 0 = 送った / 送るものが無い / dry-run、1 = 止まった（理由は stderr）、2 = 使い方の誤り
  public-sync --check [--source <ref>]
      送らずに、公開に出すツリーを同期と同じに組み立てて、Private のリポジトリ名・ホームパス・個人のメールアドレス・秘密の形の値（全ファイル。ホストの AWS のプロファイル名・アカウントは、ホストの設定があるときだけ）を検査する（CI 用。公開側に触らない）。--source の既定は HEAD
      exit 0 = 無い（origin が publicSync.target の公開側の写しでは検査しない）、1 = ある、2 = 使い方の誤り

${DEPS_CHECK_USAGE}

  mr create --source <branch> --target <branch> --title <t> --body-file <f|->
  mr view <iid> | mr discussions <iid>
  mr note <iid> --body-file <f|-> [--path <file> --line <n>]
  mr resolve <iid> <discussion id>...
      ops.config.json の forge が gitlab のリポジトリで、GitLab の標準の MR・discussion を glab で使う（ブランチは git で push しておく）。
      view / discussions は JSON を出す。note は --path / --line があれば差分のその行に discussion を始める。本文に認証に使える値があれば送らない。
      github のリポジトリでは何もせず exit 2（PR は gh を使う）。exit 0 = できた、1 = GitLab が断った・resolve にならなかった、2 = 使い方の誤り
  pr resolve-thread <thread id>...
      PR のレビュースレッドを resolve する（GraphQL の resolveReviewThread だけ。id は PRRT_ で始まるもの）。
      id の形が違えば何もせず exit 1。resolve にならなかったスレッドがあれば exit 1。設定ファイルは要らない
  pr push-rebased
      自動の rebase が解けなかった枝を手で rebase した後、今の枝だけを origin の同名の枝へ --force-with-lease で push する（引数なし）。
      今の枝が既定の枝（origin/HEAD。読めなければ main と master）か枝の無い HEAD なら push せずに exit 1。push が断られても exit 1
  heavy [--memory-only] [--name <名前>] -- <コマンド…>
      重い処理（ローカル CI、全テスト、偽のデーモン + headless Chrome など）の枠をマシンで 1 つ取ってから
      コマンドを動かす。枠が全部埋まっている間と、空きメモリ（MemAvailable）が下限を下回る間は待ち、理由（枠を持つ処理の名前・cwd・
      開始時刻、空きメモリ）を 1 行出す。上限は ~/.config/ops-kit/heavy.json（{ "max": 1, "minFreeMb": 1536 }。無ければこの既定値）、
      枠は ~/.local/state/ops-kit/heavy/ で、どのリポジトリから呼んでも同じ枠を取り合う。--name の既定はコマンドの先頭 3 語。
      --memory-only は枠を取らず、空きメモリが下限を下回る間だけ待つ（レビューのセッションなど、短くて枠を待たせたくない処理）。
      設定ファイル（ops.config.json）は要らない。exit = コマンドの exit、127 = 起動できない、2 = 使い方の誤りか heavy.json の誤り
  review-note <codex|claude|rules>
      レビュアーとして起動するランナーに、レビューの指示の後ろに足す文（そのランナーの動き方: 読み取り専用のサンドボックス / plan モード。続けて、
      どのレビューにも共通の決まり: 指摘の重さの定義・処理済みの指摘の扱い・古い前提の一覧の使い方）を出す。rules は共通の決まりだけ（サブエージェントのレビュー用）。
      アプリに仕事として頼むレビューにはアプリが同じ文を足すので、直接走らせるときだけ使う。設定ファイルは要らない。exit 2 = 使い方の誤り
  review-attack prompt
      攻める側のレビュー（実装したのとは別のランナーが、差分が変えた入口ごとに認証・認可・宛先・形式・利用者の承認のどの検査が無いかを読む）の指示を出す。
      攻撃の手順（シナリオの列・ペイロード・コマンドの全文）は書かせず、無い検査・入れる場所・既存の防御を書かせる。出力は ### Findings / ### Entries read / ### Verdict。設定ファイルは要らない。exit 2 = 使い方の誤り
  review-arbiter prompt [--follow-up]
  review-arbiter check <ファイル>
      対立した指摘を 1 回で裁定する監督者のサブエージェントのための道具。prompt は指示（材料 _review/ だけを読み PR を読み直さない・観点が見られたか・指摘ごとに書かれたルールで裁定・拠れるルールが無ければ実装者の側）を出し、
      --follow-up は裁定の後の修正の差分と裁定した指摘だけを見る 2 回目の指示を出す。出力は ### Rulings（- [implementer|reviewer] path:line — rule: <path:line か節の名前|none>）と ### Viewpoints（観点ごとに covered|missing）。
      check は出力を読み、rule が none の reviewer の行は implementer として読む。reviewer の側の行か missing の観点があればその行を出して exit 1、無ければ exit 0、節が無い・読めない行があれば exit 2（使い方の誤りも 2）。設定ファイルは要らない
  review-compare prompt
  review-compare check <ファイル>
  review-compare leftovers <ファイル> --source <経路> --out <ディレクトリ>
      収束しないレビューで、残る指摘を 1 件ずつ main と読み比べる回のための道具。prompt は主レビュアーに渡す指示（5 つの分類 REGRESSION / NEW-FEATURE-GAP /
      IMPROVED-BUT-INCOMPLETE / SAME / OWNER-DECIDED、1 指摘 1 行の形、末尾の判定）を出す。check は出力の「### Compared with main」の節を読み、
      後退があれば後退の行を出して exit 1、無ければ exit 0、節が無い・分類の読めない行があれば exit 2（使い方の誤りも 2）。設定ファイルは要らない
      leftovers は後退でない行を触る場所の領域ごとの要望の本文 <n>.md と題の一覧 titles.tsv にして --out に書く（Issue は作らない）。
      --out が新しいか空のディレクトリでなければ（ファイルも）書かずに exit 2。後退でない行が無ければ何も書かず exit 0
  review-handled <PR> [--kind review|recheck]
      前の回までの指摘と、それぞれの処理（スレッドの返信と「## レビュー対応」の要約）を Markdown で出す。修正後の見直しと再チェックのレビュアーに渡す材料。
      処理した指摘がまだ無ければ何も出さない。--kind recheck は、前の再チェックの要約が PR にあるとき（2 回目以降）だけ出す。設定ファイルは要らない
  old-paths list <base> <語>...
  old-paths check <base> <PR 本文のファイル>
      変更が意味を変える語（関数・値・記録の鍵の名前）を使う既存の箇所を、<base>...HEAD の差分が足した行を除いて挙げる（git grep。語は固定の文字列）。
      list は PR 本文に貼る「古い前提を持つ既存の箇所」の項目を出す（base を HEAD にすれば差分なしで全部。Task を切るとき・修正が値の意味を変えたとき）。
      check は本文の項目の語で探し直し、一覧に無い箇所を出す（レビュアーに渡す材料）。設定ファイルは要らない
      exit 0 = 出した / 一覧が揃っている（「なし」も）、1 = 一覧に無い箇所がある・項目が無い、2 = 使い方の誤りか git の失敗
  idle-run --idle <秒> [--] <コマンド…>
      コマンドを自分のプロセスグループで動かし、stdout / stderr のどちらにも <秒> 出力が無ければグループごと切る。総時間の上限は無い。
      出力はそのまま流す。設定ファイルは要らない。exit = コマンドの exit、124 = 切った（理由を stderr に出す）、127 = 起動できない、2 = 使い方の誤り
  ${WAIT_USAGE}
      判定コマンドが exit 0 になるまで --interval 秒（既定 5）おきに繰り返して待つ。何を待つか（--for）・上限（--timeout）・切れたときの動作（--on-timeout）は
      必須で、無ければ動かない。--progress のコマンドの出力が --stall 秒変わらなければ（相手が止まっている）、上限より前に切る。
      アプリの Task の中では待っている内容と上限がアプリの画面に出て、fail で切れた待ちは利用者に知らされる。設定ファイルは要らない。
      exit 0 = 判定が成功した / proceed で切れた（理由を stderr に出す）、124 = fail で切れた、127 = 判定コマンドを起動できない、2 = 使い方の誤り
  export-copy <dest> --words-file <file>
      キットを読めないリポジトリ（公開リポジトリなど）が同梱するコピーを <dest> に作る（テストを除くコード、skills、bin、
      README。<dest>/KIT_VERSION に元のコミットと日時）。--words-file で指定した固有語のリスト（キットの外）の語が 1 件でもあればコピーを消して exit 1
      <dest> は無い・空・前のコピー（KIT_VERSION がある）のどれか。前のコピーは置き換える。設定ファイルは要らない

--config を省くと、今のディレクトリから上へ ops.config.json を探す。見つからなければ、環境変数 OPS_KIT_CONFIG が指すファイル（同じ形）を使う: リポジトリに設定を置かないときに、キットを呼ぶ側がファイルの場所を渡す。
リポジトリに ops.config.json があればそれだけを使い、2 つをキーごとに混ぜない。publicSync はリポジトリのファイルからだけ読む。
Project URL は環境変数 <envPrefix>_PROJECT_URL、設定の省略可能な projectUrl、同名のリポジトリ変数（gh variable get）の順で読む（持ち主もその URL から）。<envPrefix>_PROJECT_OWNER は持ち主だけを変える。リポジトリは GH_REPO、無ければ origin。

設定ファイルの例（ops.config.json）:
`;

const IN_TASK_WAY = {
  "reconcile-project": "Project への追加はアプリの送信（addProjectV2ItemById）が行います。取り込み済みの要望・PBI・Task なら 1 件ずつ ops-kit backlog triage で入れられます。type ラベルの無い Issue（取り込まれない）と open の全部は Task の外で reconcile-project を回してください",
  bootstrap: "Project の用意は Task の外で実行してください（まだ workspace の無い新しいリポジトリは new-repo スキルの手順で BACKLOG_URL を外して回します）",
  "sync-labels": "ラベルはアプリの保存値と関係なくリポジトリを直接直すものなので、BACKLOG_URL を外して回してください: env -u BACKLOG_URL ops-kit sync-labels",
};
const IN_TASK_REFUSED = (cmd: keyof typeof IN_TASK_WAY) => `${cmd}: アプリの Task の中（BACKLOG_URL あり）では GitHub に直接書きません。${IN_TASK_WAY[cmd]}`;

/**
 * The repository `public-sync --check` looks for: GH_REPO, else origin. Not gh's chosen remote nor gh itself (as `repoOf`
 * reads): a default pointed at the public copy would make the check skip a private tree.
 */
function checkedRepo(env: Record<string, string | undefined>): string {
  const fromEnv = env.GH_REPO?.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "").split("/").slice(-2);
  if (fromEnv?.length === 2) return fromEnv.join("/");
  const url = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(\.git)?\/?$/.exec(url);
  if (!m) throw new Error("リポジトリが分かりません（GH_REPO を設定するか、origin が GitHub の clone で実行してください）");
  return `${m[1]}/${m[2]}`;
}

export async function main(argv: string[], gh: GhClient = realGh(), out: (s: string) => void = console.log, err: (s: string) => void = console.error, sleep: (ms: number) => Promise<void> = Bun.sleep, env: Record<string, string | undefined> = process.env, glab: Sh = runGlab): Promise<number> {
  const args = [...argv];
  let configPath: string | undefined;
  const at = args.indexOf("--config");
  if (at >= 0) {
    configPath = args[at + 1];
    if (!configPath) return usage(err, "--config にパスを渡してください");
    args.splice(at, 2);
  }
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    out(USAGE + readFileSync(join(import.meta.dir, "../fixtures/config-with-phase.json"), "utf8"));
    return command ? 0 : 1;
  }
  if (command === "export-copy") {
    const [dest, flag, wordsFile, ...extra] = rest;
    if (!dest || (flag !== undefined && (flag !== "--words-file" || !wordsFile)) || extra.length) return usage(err, "export-copy <dest> --words-file <file>");
    try {
      const r = exportCopy({ dest, wordsFile });
      out(`${r.dest} に書きました\n${r.version.trimEnd()}`);
      return 0;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
  }
  // in the app's Task, the backlog is read and written through the app: these three would go to GitHub's Project and
  // labels directly, so they stop before any gh call (--dry-run too: GitHub is not the backlog read there)
  if ((command === "reconcile-project" || command === "bootstrap" || command === "sync-labels") && env.BACKLOG_URL) {
    err(IN_TASK_REFUSED(command));
    return 1;
  }
  // in the app's Task, gh-guard refuses `gh issue create`: the request is stored in the app like backlog create, and the
  // line callers read (要望を作成: #N, scripts/file-request.ts) is kept when the app numbers it at once (a backlog kept
  // in the app only; one sent to GitHub has no number until then)
  if (command === "request" && env.BACKLOG_URL) {
    const [title, bodyFile, ...extra] = rest;
    if (!title || !bodyFile || extra.length) return usage(err, "request <title> <body-file>");
    try {
      checkRequestBody(loadConfig(configPath), bodyFile);
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const created = (s: string) => {
      const m = /^#(\d+) を作りました/.exec(s);
      out(m ? `>> 要望を作成: #${m[1]}（アプリに保存）` : s);
    };
    return runBacklog(["create", "--title", title, "--body-file", bodyFile, "--label", "type:request", "--field", "Status=Backlog"], env, { out: created, err });
  }
  // in the app's Task, set / triage are stored in the app like backlog set / triage: written to GitHub here, the
  // next edit stored in the app starts from the value before it and is sent as a conflict
  if (command === "backlog" || ((command === "set" || command === "triage") && env.BACKLOG_URL)) {
    // the configuration only tells whether triage takes a phase; none is needed to read or edit
    let phase = false;
    try {
      phase = !!loadConfig(configPath).fields.phase;
    } catch {
      /* no ops.config.json: triage takes no phase */
    }
    // without BACKLOG_URL, the commands go to GitHub: the configured Project gives list / view their Status (none
    // configured: Status `-`) and set / triage / --field their fields (none: refused)
    const config = async () => resolveProject(loadConfig(configPath), gh, env);
    const project = async () => {
      try {
        return projectOf(await config(), env);
      } catch {
        return null;
      }
    };
    // the PBI's required sections, for an edit's check (none when the configuration cannot be read: null and Story Points only)
    const pbiSections = () => {
      try {
        return loadConfig(configPath).sections.pbi.map(sectionName);
      } catch {
        return [];
      }
    };
    return runBacklog(command === "backlog" ? rest : args, env, { out, err }, { phase, gh, project, config, pbiSections });
  }
  if (command === "job") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      out(JOB_USAGE);
      return 0;
    }
    return runJob(rest, env, { out, err });
  }
  if (command === "task") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      out(TASK_USAGE);
      return 0;
    }
    return runTask(rest, env, { out, err });
  }
  if (command === "pull-main") {
    if (rest.length) return usage(err, "pull-main", 2);
    return pullMain(process.cwd(), out, err);
  }
  if (command === "heavy") {
    const HEAVY_USAGE = "heavy [--memory-only] [--name <名前>] -- <コマンド…>";
    let name: string | undefined;
    let memoryOnly = false;
    let i = 0;
    for (;;) {
      if (rest[i] === "--memory-only" && !memoryOnly) {
        memoryOnly = true;
        i += 1;
      } else if (rest[i] === "--name" && name === undefined) {
        name = rest[i + 1];
        if (!name) return usage(err, HEAVY_USAGE, 2);
        i += 2;
      } else break;
    }
    const cmd = rest[i] === "--" ? rest.slice(i + 1) : rest.slice(i);
    if (!cmd.length) return usage(err, HEAVY_USAGE, 2);
    let interrupted: NodeJS.Signals | undefined;
    let code: number;
    try {
      code = await withHeavySlot(name ?? cmd.slice(0, 3).join(" "), async () => {
        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
        } catch (e) {
          err(`${cmd[0]} を起動できません: ${(e as Error).message}`);
          return 127;
        }
        // a stopped wrapper passes the signal on and gives the slot back when the command has ended
        const forward = (signal: NodeJS.Signals) => {
          interrupted = signal;
          proc.kill(signal);
        };
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        for (const s of signals) process.on(s, forward);
        try {
          return await proc.exited;
        } finally {
          for (const s of signals) process.off(s, forward);
        }
      }, { log: err, memoryOnly });
    } catch (e) {
      err((e as Error).message);
      return 2;
    }
    if (interrupted) {
      process.kill(process.pid, interrupted);
      await new Promise(() => {}); // the signal's default action ends this process
    }
    return code;
  }
  if (command === "review-note") {
    if (rest.length !== 1 || (rest[0] !== "rules" && !isReviewer(rest[0]))) return usage(err, "review-note <codex|claude|rules>", 2);
    out(rest[0] === "rules" ? REVIEW_RULES : REVIEWER_NOTE[rest[0] as Reviewer]);
    return 0;
  }
  if (command === "review-attack") {
    if (rest.length !== 1 || rest[0] !== "prompt") return usage(err, "review-attack prompt", 2);
    out(attackPrompt());
    return 0;
  }
  if (command === "review-arbiter") {
    const [sub, ...args] = rest;
    if (sub === "prompt" && (args.length === 0 || (args.length === 1 && args[0] === "--follow-up"))) {
      out(arbiterPrompt(args.length === 1));
      return 0;
    }
    if (sub !== "check" || args.length !== 1) return usage(err, "review-arbiter prompt [--follow-up] | review-arbiter check <ファイル>", 2);
    let text: string;
    try {
      text = readFileSync(args[0]!, "utf8");
    } catch (e) {
      err((e as Error).message);
      return 2;
    }
    const r = checkRulings(text);
    if (r.unreadable.length) {
      for (const u of r.unreadable) err(`unreadable: ${u}`);
      return 2;
    }
    for (const l of [...r.reviewerSide, ...r.missing]) out(l);
    return r.reviewerSide.length || r.missing.length ? 1 : 0;
  }
  if (command === "review-compare") {
    const [sub, file, ...extra] = rest;
    if (sub === "prompt" && !file) {
      out(comparePrompt());
      return 0;
    }
    const leftoversUsage = "review-compare leftovers <ファイル> --source <経路> --out <ディレクトリ>";
    if (sub === "leftovers") {
      const sourceAt = extra.indexOf("--source");
      const outAt = extra.indexOf("--out");
      const source = sourceAt < 0 ? undefined : extra[sourceAt + 1];
      const outDir = outAt < 0 ? undefined : extra[outAt + 1];
      if (!file || !source || !outDir || extra.length !== 4) return usage(err, leftoversUsage, 2);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        err((e as Error).message);
        return 2;
      }
      const parsed = parseCompared(text);
      if (parsed.bad.length) {
        for (const b of parsed.bad) err(`unreadable: ${b}`);
        return 2;
      }
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const requests = leftoverRequests(parsed.rows, source, today);
      if (!requests.length) return 0;
      // a body left from an earlier run would be read as this run's
      if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length)) {
        err(`${outDir} is not an empty directory: write into a new directory`);
        return 2;
      }
      mkdirSync(outDir, { recursive: true });
      requests.forEach((r, i) => writeFileSync(join(outDir, `${i + 1}.md`), r.body));
      writeFileSync(join(outDir, "titles.tsv"), requests.map((r, i) => `${i + 1}\t${r.title}`).join("\n") + "\n");
      return 0;
    }
    if (sub !== "check" || !file || extra.length) return usage(err, `review-compare prompt | review-compare check <ファイル> | ${leftoversUsage}`, 2);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      err((e as Error).message);
      return 2;
    }
    const r = checkCompared(text);
    for (const l of r.lines) (r.code === 2 ? err : out)(l);
    return r.code;
  }
  if (command === "review-handled") {
    const kindAt = rest.indexOf("--kind");
    const kind = kindAt < 0 ? "review" : rest[kindAt + 1];
    const [pr, ...extra] = kindAt < 0 ? rest : rest.filter((_, i) => i !== kindAt && i !== kindAt + 1);
    if (!/^[1-9]\d*$/.test(pr ?? "") || extra.length || (kind !== "review" && kind !== "recheck")) return usage(err, "review-handled <PR> [--kind review|recheck]", 2);
    try {
      const pages = JSON.parse(await gh.run(["api", "--paginate", "--slurp", `repos/{owner}/{repo}/pulls/${pr}/comments`])) as InlineComment[][];
      const view = JSON.parse(await gh.run(["pr", "view", pr!, "--json", "comments"])) as { comments: Array<{ body: string }> };
      const text = handledFindings(pages.flat(), view.comments.map((c) => c.body), kind);
      if (text) out(text);
      return 0;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
  }
  if (command === "old-paths") {
    const [sub, base, ...tail] = rest;
    if ((sub !== "list" && sub !== "check") || !base || base.startsWith("-") || !tail.length || (sub === "check" && tail.length !== 1)) return usage(err, "old-paths list <base> <語>... | old-paths check <base> <PR 本文のファイル>", 2);
    const git = (args: string[], okCodes = [0]) => {
      const p = Bun.spawnSync(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      if (!okCodes.includes(p.exitCode)) throw new Error(`git ${args[0]}: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`);
      return p.stdout.toString();
    };
    try {
      const added = addedLines(git(["diff", "-U0", "--no-color", "--no-ext-diff", `${base}...HEAD`]));
      // git grep exits 1 when nothing matches
      const hitsFor = (words: string[]): Hit[] => oldPathHits(git(["grep", "-n", "-I", "-F", "--no-color", ...words.flatMap((w) => ["-e", w])], [0, 1]), added);
      if (sub === "list") {
        out(oldPathsItem(tail, hitsFor(tail)));
        return 0;
      }
      const report = oldPathsReport(readFileSync(tail[0]!, "utf8"), hitsFor);
      out(report.text);
      return report.ok ? 0 : 1;
    } catch (e) {
      err((e as Error).message);
      return 2;
    }
  }
  if (command === "idle-run") {
    const IDLE_USAGE = "idle-run --idle <秒> [--] <コマンド…>";
    const [flag, seconds, ...tail] = rest;
    const cmd = tail[0] === "--" ? tail.slice(1) : tail;
    const idleSeconds = Number(seconds);
    if (flag !== "--idle" || !/^[1-9]\d*$/.test(seconds ?? "") || idleSeconds > IDLE_SECONDS_MAX || !cmd.length) return usage(err, IDLE_USAGE, 2);
    try {
      const r = await runIdle(cmd, { idleSeconds, stdin: "inherit", onData: (chunk, stream) => process[stream].write(chunk) });
      if (r.idleKilled) err(IDLE_KILLED_LINE(idleSeconds));
      return r.code;
    } catch (e) {
      err(`${cmd[0]} を起動できません: ${(e as Error).message}`);
      return 127;
    }
  }
  if (command === "wait") {
    const o = parseWaitArgs(rest);
    if (!o) return usage(err, WAIT_USAGE, 2);
    try {
      return (await runWait(o)).code;
    } catch (e) {
      err(`${o.check[0]} を起動できません: ${(e as Error).message}`);
      return 127;
    }
  }
  if (command === "deps-check") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      out(DEPS_CHECK_USAGE);
      return 0;
    }
    if (rest.some((a) => a !== "--file-request") || rest.length > 1) return usage(err, "deps-check [--file-request]", 2);
    let extraConditions: string[] = [];
    try {
      extraConditions = loadConfig(configPath).depsCheck?.extraConditions ?? [];
    } catch (e) {
      // no ops.config.json is fine for a check that only reads; one that is there and does not read is not
      if (configPath || hasConfig() || rest.length) {
        err((e as Error).message);
        return 2;
      }
    }
    // the kit's own commands (backlog, request) run in process; what they print is kept for the caller
    const kit = async (argv: string[]) => {
      const lines: string[] = [];
      const code = await main([...(configPath ? ["--config", configPath] : []), ...argv], gh, (s) => lines.push(s), err, sleep, env, glab);
      return { code, out: lines.join("\n") };
    };
    return depsCheck({ fileRequest: rest.length === 1, extraConditions }, realDepsCheckDeps(gh, env, kit, { out, err }));
  }
  if (command === "public-sync") {
    const flags = new Set(["--dry-run", "--adopted", "--adopt-baseline", "--check"]);
    const valued = new Set(["--source", "--target-url"]);
    const given: Record<string, string> = {};
    const on = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (flags.has(a)) on.add(a);
      else if (valued.has(a) && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) given[a] = rest[++i]!;
      else return usage(err, "public-sync [--source <ref>] [--dry-run] [--adopted] [--adopt-baseline] [--target-url <url>] | public-sync --check [--source <ref>]", 2);
    }
    if (on.has("--check") && (on.size > 1 || given["--target-url"])) return usage(err, "public-sync --check [--source <ref>]", 2);
    const adoptUsage = "public-sync --adopt-baseline --source <vX.Y.Z> [--dry-run] [--target-url <url>] (publicSync.versioning: independent)";
    if (on.has("--adopt-baseline") && !given["--source"]) return usage(err, adoptUsage, 2);
    if (on.has("--check")) {
      try {
        const cfg = loadPublicSync(configPath, undefined, given["--source"] ?? "HEAD");
        const repo = checkedRepo(env);
        // the public copy's own CI: its origin is publicSync.target, and there is no private name to look for
        if (publicCopyRefusal(repo)) {
          out(`public check: skipped (${repo} is publicSync.target, the public copy)`);
          return 0;
        }
        out(check({ host: hostAws(), privateRepo: repo, target: cfg.target, include: cfg.include, exclude: cfg.exclude, allowRefs: cfg.allowRefs, rewrite: cfg.rewrite, source: given["--source"] }, spawnRun));
        return 0;
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
    }
    let privateRepo = "";
    try {
      // the migration sends no tree: it reads the current setting (origin/main), as the --source tag predates versioning
      const cfg = loadPublicSync(configPath, undefined, on.has("--adopt-baseline") ? "origin/main" : (given["--source"] ?? "origin/main"));
      if (on.has("--adopt-baseline") && cfg.versioning !== "independent") return usage(err, adoptUsage, 2);
      const r = await repoOf(gh);
      privateRepo = `${r.owner}/${r.name}`;
      out(sync({ host: hostAws(), privateRepo, target: cfg.target, versioning: cfg.versioning, prerelease: cfg.prerelease, include: cfg.include, exclude: cfg.exclude, allowRefs: cfg.allowRefs, rewrite: cfg.rewrite, serviceUsers: cfg.serviceUsers, source: given["--source"], targetUrl: given["--target-url"], dryRun: on.has("--dry-run"), adopted: on.has("--adopted"), adoptBaseline: on.has("--adopt-baseline") }, spawnRun));
      return 0;
    } catch (e) {
      const message = (e as Error).message;
      // a --source tag stopped by the tree check: whether origin/main, by its own publicSync, has the hits fixed
      const main = () => ({ ...loadPublicSync(configPath, undefined, "origin/main"), privateRepo });
      err(given["--source"] && privateRepo ? withStaleNote(message, main, spawnRun) : message);
      return 1;
    }
  }
  if (command === "sync-labels") {
    const dryRun = rest.includes("--dry-run");
    const files = rest.filter((a) => a !== "--dry-run");
    if (files.length > 1 || files[0]?.startsWith("--")) return usage(err, "sync-labels [<file>] [--dry-run]", 2);
    try {
      const want = parseLabels(readFileSync(files[0] ?? ".github/labels.yml", "utf8"));
      const r = await repoOf(gh);
      await syncLabels(gh, `${r.owner}/${r.name}`, want, { dryRun }, out);
      return 0;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
  }
  if (command === "mr") return mr(rest, glab, out, err);
  if (command === "pr") {
    const [sub, ...ids] = rest;
    if (sub === "push-rebased") {
      if (ids.length) return usage(err, "pr push-rebased（引数は取りません）", 2);
      const r = pushRebased(gitIn(process.cwd()));
      (r.ok ? out : err)(r.message);
      return r.ok ? 0 : 1;
    }
    if (sub !== "resolve-thread" || ids.length === 0) return usage(err, "pr resolve-thread <thread id>... | pr push-rebased");
    const bad = ids.filter((id) => !/^PRRT_[\w-]+$/.test(id));
    if (bad.length) return usage(err, `レビュースレッドの id ではありません（PRRT_ で始まるもの）: ${bad.join(" ")}`);
    let failed = 0;
    for (const id of ids) {
      try {
        await resolveReviewThread(gh, id);
        out(`${id} resolved`);
      } catch (e) {
        err(`${id}: ${(e as Error).message}`);
        failed++;
      }
    }
    return failed ? 1 : 0;
  }
  if (command === "issue-refs") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      out(ISSUE_REFS_USAGE);
      return 0;
    }
    if (rest.some((a) => a.startsWith("-"))) return usage(err, "issue-refs [<path>...]", 2);
    try {
      const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
      if (top.exitCode !== 0) throw new Error(`git rev-parse: ${top.stderr.toString().trim()}`);
      const cwd = top.stdout.toString().trim();
      // a path is read from the current directory, as the repository's top-relative path git lists; `.` at the top names every file
      const named = rest.map((a) => relative(cwd, resolve(a)));
      const outside = named.find((a) => a === ".." || a.startsWith("../") || isAbsolute(a));
      if (outside !== undefined) throw new Error(`outside the repository: ${outside}`);
      const cfg = named.length ? undefined : loadPublicSync(configPath);
      const files = named.length
        ? publicFiles(named.includes("") ? undefined : named.map((a) => (statSync(join(cwd, a), { throwIfNoEntry: false })?.isDirectory() ? `${a}/` : a)), [], cwd)
        : publicFiles(cfg!.include, cfg!.exclude, cwd);
      let hits = 0;
      for (const f of files) {
        for (const r of findIssueRefs(f, readFileSync(join(cwd, f), "utf8"))) {
          out(`${f}:${r.line}: ${r.text.trim()}`);
          hits++;
        }
      }
      out(`hits: ${hits} / files: ${files.length}`);
      return hits > 0 ? 1 : 0;
    } catch (e) {
      err(`issue-refs: ${(e as Error).message}`);
      return 2;
    }
  }
  // The two checks read no configuration: they run in any directory, with or without an ops.config.json
  if (command === "scan-text" || command === "scan-issues") {
    try {
      if (command === "scan-text") {
        if (rest[0] === "--help" || rest[0] === "-h") {
          out(SCAN_TEXT_USAGE);
          return 0;
        }
        const [file, ...extra] = rest;
        if (!file || extra.length) return usage(err, "scan-text <file|->", 2);
        const hits = findSecrets(file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8"), hostAws());
        for (const h of hits) out(`${file}:${h.line}: ${h.kind}`);
        return hits.length > 0 ? 1 : 0;
      }
      const SCAN_USAGE = "scan-issues [<owner/name>] [--since <ISO 8601>] [--recheck <URL>]...";
      const positional: string[] = [];
      const recheck: string[] = [];
      let since: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--since" || a === "--recheck") {
          const v = rest[++i];
          if (v === undefined) return usage(err, SCAN_USAGE, 2);
          if (a === "--since") since = v;
          else recheck.push(v);
        } else positional.push(a);
      }
      const [named, ...extra] = positional;
      if (extra.length || (named !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(named))) return usage(err, SCAN_USAGE, 2);
      if (since !== undefined && Number.isNaN(Date.parse(since))) return usage(err, SCAN_USAGE, 2);
      let repo = named;
      if (repo === undefined) {
        const r = await repoOf(gh);
        repo = `${r.owner}/${r.name}`;
      }
      const mine = `https://github.com/${repo}/`.toLowerCase(); // names on GitHub do not tell case
      if (recheck.some((u) => !u.toLowerCase().startsWith(mine))) return usage(err, SCAN_USAGE, 2);
      const { hits, scanned } = await scanIssues(gh, repo, sleep, hostAws(), { since, recheck });
      for (const h of hits) out(`${h.url}: ${h.kind}（${h.line} 行目）`);
      out(`hits: ${hits.length} / scanned: ${scanned}`);
      return hits.length > 0 ? 1 : 0;
    } catch (e) {
      err((e as Error).message);
      return 2;
    }
  }
  let cfg: OpsConfig;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    // a workspace kept in the app without GitHub is linted with the kit's template when it has no file of its own
    if (command === "lint" && !configPath && env.BACKLOG_URL && env.BACKLOG_WORKSPACE && !env.GH_REPO && !hasConfig()) {
      err("ops.config.json が無いので既定の選択肢（ops-kit/template/ops.config.json）で検査");
      cfg = defaultConfig();
    } else {
      err((e as Error).message);
      return command === "lint" ? 2 : 1;
    }
  }
  try {
    const stored = command === "lint" && !!env.BACKLOG_URL;
    if (["set", "triage", "reconcile-project", "bootstrap", "request"].includes(command) || (command === "lint" && !stored && !rest.includes("--no-project"))) cfg = await resolveProject(cfg, gh);
    switch (command) {
      case "set": {
        const [issue, field, value] = rest;
        if (!issue || !field || value === undefined || rest.length !== 3) return usage(err, "set <issue> <field> <value>");
        await setField(gh, cfg, issueNumber(issue), field, value, out);
        return 0;
      }
      case "triage": {
        const [issue, priority, ...tail] = rest;
        // a repository without a Phase: "" in its place means none; <parent> and <status> follow
        if (!cfg.fields.phase && tail[0] === "" && tail.length > 2) tail.shift();
        const phase = cfg.fields.phase ? tail.shift() : undefined;
        const [parent, status, ...extra] = tail;
        if (!issue || !priority || (cfg.fields.phase && !phase) || extra.length) {
          return usage(err, triageUsage(!!cfg.fields.phase));
        }
        await triage(gh, cfg, issueNumber(issue), { priority, phase, parent: parent ? issueNumber(parent) : undefined, status: status || undefined }, out);
        return 0;
      }
      case "reconcile-project": {
        if (rest.some((a) => a !== "--dry-run")) return usage(err, "reconcile-project [--dry-run]");
        await reconcileProject(gh, cfg, { dryRun: rest.includes("--dry-run") }, out);
        return 0;
      }
      case "lint": {
        if (rest.some((a) => a !== "--no-project" && a !== "--fresh") || new Set(rest).size !== rest.length) return usage(err, "lint [--no-project] [--fresh]", 2);
        const records = stored ? await readRecords(env, { fresh: rest.includes("--fresh") }) : undefined;
        if (records) err(`アプリの保存値を検査（${records.repository}、最終取得 ${new Date(records.fetchedAt).toISOString()}${rest.includes("--fresh") && !records.unsynced ? "、取込み済み" : ""}）`);
        if (records?.unsynced) err(records.unsynced);
        // the registry sits next to ops.config.json; a repository without one is not checked for it. Its numbers are this
        // checkout's Issues, so it is read only when the linted repository is this checkout's own (not GH_REPO / --workspace elsewhere)
        const dir = configPath || hasConfig() ? dirname(findConfig(configPath)) : null;
        const remote = dir && existsSync(join(dir, KNOWN_FAILURES_FILE)) ? originOf(dir) : null;
        const own = remote ? remoteOf(remote)?.path ?? null : null;
        const target = !dir ? null : records?.repository ?? (await repoName(env, dir).catch(() => null));
        const registry = dir && own && target && own.toLowerCase() === target.toLowerCase() ? join(dir, KNOWN_FAILURES_FILE) : null;
        if (dir && !registry && existsSync(join(dir, KNOWN_FAILURES_FILE))) err(`${KNOWN_FAILURES_FILE} は検査しない（検査する ${target ?? "リポジトリ不明"} がこの checkout の origin ${own ?? "不明"} と違う）`);
        const knownFailures = registry && existsSync(registry) ? parseKnownFailures(readFileSync(registry, "utf8")) : undefined;
        // the paths a question names are read against this checkout's top level only when it is the linted repository's
        const here = dir ? (() => { try { const origin = originOf(dir); return origin ? (remoteOf(origin)?.path ?? null) : null; } catch { return null; } })() : null;
        const mine = !!dir && !!here && !!target && here.toLowerCase() === target.toLowerCase();
        const { violations, warnings } = await lint(gh, cfg, { withProject: !rest.includes("--no-project"), records, knownFailures, ...(mine ? { top: repoTop(dir!) } : {}) });
        for (const line of formatLint(violations, warnings)) out(line);
        return violations.length > 0 ? 1 : 0;
      }
      case "bootstrap": {
        const dryRun = rest.includes("--dry-run");
        const words = rest.filter((a) => a !== "--dry-run");
        if (words.length !== 1 || !words[0]) return usage(err, "bootstrap <title> [--dry-run]");
        await bootstrap(gh, cfg, { title: words[0], dryRun }, out);
        return 0;
      }
      case "request": {
        const [title, bodyFile, ...extra] = rest;
        if (!title || !bodyFile || extra.length) return usage(err, "request <title> <body-file>");
        await createRequest(gh, cfg, { title, bodyFile }, out);
        return 0;
      }
      default:
        return usage(err, `知らないコマンドです: ${command}`);
    }
  } catch (e) {
    err((e as Error).message);
    // lint: anything but a finished check is "could not check", never a pass or a violation count
    return command === "lint" ? 2 : 1;
  }
}

function hasConfig(): boolean {
  try {
    findConfig(undefined);
    return true;
  } catch {
    return false;
  }
}

function issueNumber(s: string): number {
  if (!/^#?[0-9]+$/.test(s)) throw new UsageError(`Issue 番号ではありません: ${s}`);
  return Number(s.replace(/^#/, ""));
}

/** `mr …`: GitLab's MR and discussions through glab, on the checkout's GitLab project. */
async function mr(rest: string[], glab: Sh, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const [sub, ...args] = rest;
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const text = (f: string | undefined) => (f === "-" ? Bun.stdin.text() : f ? Bun.file(f).text() : Promise.resolve(undefined));
  const usageMr = (m: string) => usage(err, m, 2);
  let target;
  try {
    target = forgeTargetOf(process.cwd(), originOf(process.cwd()));
  } catch (e) {
    return usageMr((e as Error).message);
  }
  if (target.service !== "gitlab") return usageMr(`このリポジトリは ${target.service} です。PR は gh を使ってください`);
  try {
    if (sub === "create") {
      const [source, into, title, body] = [flag("source"), flag("target"), flag("title"), await text(flag("body-file"))];
      if (!source || !into || !title || body === undefined || args.length) return usageMr("mr create --source <branch> --target <branch> --title <t> --body-file <f|->");
      const m = await createGitlabMr(glab, target, { source, target: into, title, description: body }, hostAws());
      out(`!${m.iid} ${m.url}`);
      return 0;
    }
    const iid = Number(args.shift());
    if (!Number.isInteger(iid) || iid <= 0) return usageMr(`mr ${sub ?? "<create|view|discussions|note|resolve>"} <iid> …`);
    if (sub === "view" && !args.length) return out(JSON.stringify(await viewGitlabMr(glab, target, iid), null, 2)), 0;
    if (sub === "discussions" && !args.length) return out(JSON.stringify(await gitlabMrDiscussions(glab, target, iid), null, 2)), 0;
    if (sub === "note") {
      const [body, path, line] = [await text(flag("body-file")), flag("path"), flag("line")];
      if (body === undefined || args.length || (path === undefined) !== (line === undefined) || (line !== undefined && !/^[1-9]\d*$/.test(line))) return usageMr("mr note <iid> --body-file <f|-> [--path <file> --line <n>]");
      out(await startGitlabDiscussion(glab, target, iid, body, path ? { path, line: Number(line) } : undefined, hostAws()));
      return 0;
    }
    if (sub === "resolve" && args.length) {
      let failed = 0;
      for (const id of args) {
        try {
          await resolveGitlabDiscussion(glab, target, iid, id);
          out(`${id} resolved`);
        } catch (e) {
          err(`${id}: ${(e as Error).message}`);
          failed++;
        }
      }
      return failed ? 1 : 0;
    }
    return usageMr("mr <create|view|discussions|note|resolve> …");
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}

function usage(err: (s: string) => void, msg: string, code = 1): number {
  err(`${msg}\n（bun ops-kit/src/cli.ts --help で使い方）`);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
