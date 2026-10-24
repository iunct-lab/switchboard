# main-pull（マージ後の main の作業ツリーの更新）

`pbi-complete` の 6-6 は、PBI を閉じたあと main の作業ツリーを更新する。以前は「CLAUDE.md の手順で」と任せていたため、手順の無いリポジトリでは毎回 pull されずに止まった（#829。PBI #1244）。
どのリポジトリでも同じ既定として、キットの CLI `ops-kit pull-main` が行う。

## 部品

| 部品 | 役割 |
|---|---|
| `ops-kit pull-main`（`ops-kit/src/pull-main.ts`） | main の作業ツリー（`git worktree list` の最初）を upstream に fast-forward する。設定を読まない。どの worktree の中からでも呼べる |
| `pbi-complete` 6-6 | マージ後にこのコマンドを呼ぶ。出力の 1 行を報告の `main:` に書く |
| 使う側の `CLAUDE.md` | 既定を変える点だけ（例: pull が動いているサービスを再起動するので利用者の OK を取る） |

## 判定

| 状態 | 出力 | exit | 変えるもの |
|---|---|---|---|
| fast-forward できる | `pulled <old>..<new> (<branch> <- <upstream>)` | 0 | 作業ツリーとブランチ |
| すでに同じ | `up to date <sha>` | 0 | 無し |
| ローカルのコミットが先行・分岐 | `not pulled: cannot fast-forward (…)` | 1 | 無し |
| 未コミットの変更（untracked を含む）が取り込むファイルと重なる | `not pulled: uncommitted changes overlap: <パス>` | 1 | 無し |
| detached HEAD | `not pulled: detached HEAD` | 1 | 無し |
| upstream 無し | `not pulled: no upstream for <branch>` | 1 | 無し |
| fetch できない | `fetch failed: …`（標準エラー） | 2 | 無し |
| Git でない | `not a git repository: <dir>`（標準エラー） | 2 | 無し |

## やらないこと

- rebase / merge / stash（別のセッションの作業を壊さない。止めて理由を出す）
- 設定・環境変数・オプション（既定を変えたいリポジトリは CLAUDE.md に書く）
- `scripts/setup/` の入口（#969 の方針）
- 依存の更新やビルド、動いているコードの更新（昇格・再起動）の自動化
