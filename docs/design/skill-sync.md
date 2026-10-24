# skill-sync（開発標準のスキルを各リポジトリへ置く）

Task のランナーを起動する直前（`packages/core/src/tasks.ts` の `startSession`、`adapter.start` の前）に、`packages/core/src/skillsync.ts` の `syncSkills()` が、meta workspace の開発標準のスキルを Task の作業フォルダのリポジトリへ置く（PBI #451、Task #469）。
どの経路で始めた Task（工程ボタン、手で作った Task、スケジュール、並走、再開）にも同じ 1 か所で効く。

## 置き方

- 正本: meta workspace の `ops-kit/skills/<name>`（`SKILL_SOURCE`、共通の運用キットの 10 本）のうち `SKILL.md` があるもの。Switchboard 専用の 5 本（bun-compile-notes / flow-loop / perf-loop / runner-adapter-recording / verify-live-ui）は `.claude/skills` に Git 管理で置いたままで、正本に無いので置かれない（#239）
- 置き先: リポジトリの root の `.claude/skills/<name>`（Claude Code）と `.agents/skills/<name>`（Codex）（`SKILL_TARGETS`）。ランナーの種類で分けず、どの Task でも両方に置く
- 中身: 正本のディレクトリの**コピー**（実ファイル。正本の中のリンクはファイルもフォルダも実体を写す）と、その中の印のファイル `.switchboard-skill`（`SKILL_MARKER`。写した時の正本の内容のハッシュ）。リンクにしないのは、Claude Code の許可の判定がリンクを実体のパスで見るため。リンクだとほかのリポジトリでは実体が「ワークスペース外」になり、スキル本文を Bash（`sed` / `cat`）で読むと承認が出る（2026-10-01 に `claude -p` で確認、#846）。正本を直したら、次の起動で写し直す
- Git の管理対象にしない: `git rev-parse --git-path info/exclude` のファイルの管理ブロック（`# >>> switchboard skills (managed)` 〜 `# <<< switchboard skills`）に、置いたコピーを `/<置き先>/<name>` の行で書く。ブロックの外と `.gitignore` は触らない。`info/exclude` はリポジトリの全 worktree で 1 つなので、ブロックは `git worktree list` の全 worktree を見て、どれかに Switchboard のコピー（正本から消えたスキルのものも、その worktree の次の起動で消えるまで含む）か旧リンクがある置き場所の行にする（ここでは `skipped` でも別の worktree ではコピー、ということがある）。どの worktree にも無い行は消す（利用者がコピーを自分のフォルダに置き換えたら、それは Git に見える）。0 件ならブロックを消す。ブロックの中に利用者が書いた行はブロックの外に残す。終わりの印が消されていたら、ブロックは最初の管理対象でない行で終わったとみなす
- meta のリポジトリ（とその worktree）にも同じようにコピーを置く（専用の 4 本は Git 管理の実体で、印が無く正本に同じ名前も無いので触らない）。ほかのリポジトリを同期するときは、先に meta のチェックアウトを同期する。置き先が正本のディレクトリそのもの（そこへのリンク）なら、その置き先は飛ばす
- 何もしない: 作業フォルダが Git でない

## 見分け方（Switchboard が置いたもの）

印のファイル `.switchboard-skill` を持つ実ディレクトリを、Switchboard が置いたコピーとみなす。印の無い実ディレクトリはリポジトリ自身のもの（Git 管理のものを含む）で、触らない。
コピーより前に置いていたシンボリックリンク（旧リンク）は、次の起動で 1 回だけコピーに置き換える。旧リンクは「正本の中を指すリンク」「別のリンクを経て正本の中に着くリンク」「meta の `.claude/skills/<name>`（今は meta 自身のコピー）を指すリンク」の 3 通り（3 つ目は正本が meta の `.claude/skills` だったとき（#469）に置いたもの）。旧リンクを読み続ける層は作らない。

| 置き先にあるもの | 扱い |
|---|---|
| 無い | コピーを置く（`linked`。結果の名前はリンクだったころのまま） |
| 印つきのコピーで、印のハッシュと中身が正本と同じ | 書き換えない（`unchanged`） |
| 印つきのコピーで、正本と違う（正本の変更・削除、コピーの手直し） | 消して置き直す（`linked`）。正本から消えたファイルもコピーから消える |
| 旧リンク | 消してコピーを置く（`linked`）。リンク先（正本）は変えない |
| 印の無い実ディレクトリ、ファイル、別の場所へのリンク | 触らない（`skipped`）。Task のログに「スキル <name> はリポジトリにあるもの（<path>）を使います。Switchboard の正本は置いていません」 |
| 印つきのコピーか旧リンクで、置く名前に無いもの（正本から消した） | 消す（`removed`） |

`syncSkills` が失敗しても Task は止めず、「スキルを置けませんでした: <理由>」をログに残してランナーを起動する。

## 運用ツール（scripts/setup）の写し

スキルと違い、`scripts/setup/` の入口は**配らず、写しを知らせるだけ**にする（#557）。入口は各リポジトリの Git 管理のファイルで、`ops.config.json` とともにそのリポジトリの設定の一部。リンクや書き換えに置き換えると追跡されるファイルを変えることになり、上の「追跡されるファイルを変えない」方針に反する。移行（キットを呼ぶ入口への置き換え）は各リポジトリの PBI が行う。

- 写しの定義: リポジトリの `scripts/setup/` のファイルで、meta の `scripts/setup/` の入口と同じ名前（拡張子を除く）なのに、中身に `src/cli.ts` を含まないもの（`setupScripts()` の `copies`）。キットそのもの（`$K/src/cli.ts`）も公開リポジトリが同梱したコピー（`<同梱先>/src/cli.ts`）も、この 1 つの規則で「キットを呼ぶ」側（`kit`）に入る。meta に無い名前（DAK の `install_hooks.sh` など）はそのリポジトリ固有のスクリプトで、数えない
- 検出は `startSession` のスキル同期の直後。写し 1 件ごとに Task の status に「`scripts/setup/<名前>` は共通キットを呼ばない写しです。検査の結果が共通スキルとずれることがあります」を残す
- 止めない: 写しがあっても、`scripts/setup` を読めなかったとき（「scripts/setup を調べられませんでした: <理由>」を残す）も、ランナーは起動する

## 一次資料（2026-09-28 に確認）

- Claude Code — https://code.claude.com/docs/en/skills
  - 「Claude Code loads project skills from `.claude/skills/` in the directory where you start it and in every parent directory up to the repository root」
  - 「**Symlinked folders**: a `<skill-name>` entry in the enterprise, personal, or project location can be a symlink to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target and loads the skill once even if several locations point at the same target.」
- Codex — https://learn.chatgpt.com/docs/build-skills（旧 https://developers.openai.com/codex/skills からの転送先）
  - リポジトリのスキルは、作業フォルダからリポジトリの root までの各ディレクトリの `.agents/skills`（と `$REPO_ROOT/.agents/skills`）。ユーザーのスキルは `$HOME/.agents/skills`
  - 「Codex supports symlinked skill folders and follows the symlink target when scanning these locations.」

## やらないこと

- ユーザーレベル（`~/.claude/skills`、`~/.agents/skills`）に置く（#451 の回答で各リポジトリへの同期に置き換えた）
- スキル本文の書き換え（汎用化は #239）
- 設定・フラグ・環境変数での切り替え、ランナーごとの分岐
- 承認の設定（`additionalDirectories`）で正本を通す — ほかのリポジトリの設定に Switchboard のパスを書くことになり、リポジトリの境界に反する（#846）
- デーモンが hook の登録を各リポジトリに書く（`shared-tmp-guard.md`。デーモンは `--settings` で渡す。リポジトリが自分の設定に登録するのは別）
