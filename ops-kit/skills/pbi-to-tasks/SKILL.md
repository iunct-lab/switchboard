---
name: pbi-to-tasks
description: PBI を開発可能な状態（Ready）にする型。PBI の書式を確かめ、コードを読んで触る場所を名指しし、シンプルさの設計チェックを通した Task に分解して sub-issue で親に紐づけ、受け入れ条件の被覆を確かめて Status を Ready にする。PBI に着手する前、/pbi-complete の最初、Task の粒度に迷ったときに読む。前は request-to-backlog、次は task-to-pr。
---

# PBI → Tasks（Ready 化）

目的: PBI の受け入れ条件を**全部**、実装者が迷わない Task に落とし、**Task が全部 Done なら PBI の受け入れ条件が全部満たされる**関係を作る。
Task の親は必ずその PBI（sub-issue）。Task は 1 PR で終わる大きさ。

## 手順

### 1. PBI を確かめる

`gh issue view <num>` で本文を読む（エージェント管理アプリの Task の中では `ops-kit backlog view <num> --fresh`。Task の作成・Project・Milestone も `ops-kit backlog create --parent <PBI> --milestone … --field …` / `set`。`issue-workflow` の「操作」）。無ければ**先に直す**（`request-to-backlog` の書式。決定ログに日付つきで「書き直し」）:
ユーザーストーリー / 検証つき受け入れ条件 / スコープ外 / `**Story Points**: N` / `## 元要望`。`scripts/setup/lint_backlog.sh`（`BACKLOG_URL` があれば `ops-kit lint --fresh`）が exit 0。

元要望（`## 元要望` の Issue）の原文も読む。PBI の解釈が原文からずれていたら PBI を直してから分解する。

### 2. コードを読む

受け入れ条件ごとに「今どこで何が起きているか」を確かめ、触る場所を `path:line` で控える。読むもの:
README の構成と設計ルール（場所は CLAUDE.md）、該当 `docs/design/*.md`、当該のソースと既存テスト（同型のテストをどう書いているか）、部品のあいだで共有する型の定義。
似た仕組みが既にあるか探す（`grep -rn` / `Explore` エージェント）。**あるなら同じ形で作る**（例: 新しい自動選択は、既にある自動選択の仕組みと同じ形の関数にする）。
画面の見た目・操作を変える PBI で、`**画面イメージ**:` の行が無い・その成果物が消えている・コードを読んで画面の決めた形が変わったなら、Ready にする前に `issue-workflow` の「画面イメージ」の「問いの無い PBI」で作り直して行を書く（差し替えたら 5 の決定ログに 1 行）。

### 3. 設計チェック（シンプルさ）

Task に書く前に、案を次で削る。**通らない項目は Task の本文に「設計チェック: 〜はしない（理由）」と 1 行残す**。

| 入れない | 代わりに |
|---|---|
| 後方互換の層（古い形式も読む、旧 API も残す、非推奨のまま置く） | 変える。データは 1 回の移行（DB の migration）。利用者と外部クライアントの前提は CLAUDE.md（書いていなければ互換層は入れない） |
| 一度しか使わない抽象（interface + 実装 1 つ、汎用ヘルパ、プラグイン機構） | 具体的な関数 1 つ。2 つ目が来たら抽象化する |
| 念のための設定・フラグ・環境変数 | 決める。利用者が切り替える理由が受け入れ条件に無いなら設定にしない |
| ランナー / アダプタなど実装先ごとの分岐 | 1 本の経路（例: ファイルはパスで渡す。アダプタは触らない） |
| 新しいテーブル・エンドポイント・画面 | 既存の表 / API / 部品に列・項目を足す。足せない理由があるときだけ新設 |
| 繰り返し呼ぶもの（定期・ポーリング・接続し直し・Task ごと）の、重さを見ない使い回し | 呼ぶ頻度 × 応答の大きさ（今の実データでの値と 3 か月後の見込み）を Task の本文に `負荷: <頻度> × <大きさ>（今 <値> / 3 か月後 <値>）` の 1 行で書く。既存の口の使い回しでも、その値が大きければ要るものだけを返す形（引数・列を足す）にするか新設する |
| 新しい依存パッケージ | 標準 API か既存の依存。足すならライセンス（リポジトリのライセンスと互換。CLAUDE.md）を確かめる |
| アプリが持つ可変の値を doc に写す DoD | 書かない（`issue-workflow` の「アプリが持つ可変の値を写さない」）。docs の完了条件を加える条件も同節に従う |
| 「あとで使うかも」の口 | 書かない。YAGNI |
| 頼まれていない OS・環境（別の OS、別のサービス管理）の対応・手順・検証 | 足さない。要望の各項目が利用者の言葉かエージェントの推測か（`request-to-backlog` の「誰の言葉」）を分け、利用者が名指ししていない環境はスコープ外に書くか落とす |
| 最初の実使用に要らない自動化（定期実行、偽の相手でのリハーサル） | 手動の手順を先に。自動化は別の Task に残し、節目（公開など）を過ぎたら着手する。手動を先にするのは節目を止めないためで、自動化をやめる意味ではない |
| 別 OS / 実機 / 課金でしか検証できない工程 | Task にしない。PBI のスコープ外か、受け入れ条件の行に `（利用者確認: …）`（`issue-workflow` の「利用者確認の項目」） |
| どのリポジトリにも要る仕組みを、このリポジトリの中だけに作る | 共通キットに置く（`request-to-backlog` の「どのリポジトリにも要る仕組み」）。PBI がこのリポジトリの中だけを前提にしていたら、決定ログに書いて `## 判断待ち` で止める（勝手に置き場所を変えない・個別に作らない） |

例: 2 秒ごとの状態表示が全件の Task 一覧（実データで MB 単位、件数とともに増える）を読む使い回しは、`負荷` の行を書いた時点で引っかかる。必要なのは running と waiting の Task だけ。

設計原則との衝突（承認を迂回する既定値、ベンダ CLI のコード取り込み、鍵やテレメトリ、ランナー必須化）は Task にしない。PBI の決定ログに書いて止める。

PBI のユーザーストーリーが CLAUDE.md（`AGENTS.md`）の前提（信頼モデル・使い勝手）と矛盾していたら（この手順より前に作られた PBI など）、Task にしない。PBI に `## 判断待ち`（ラベル `needs-decision`）を出し、Ready にしない。照らし方は `request-to-backlog` の「2.5 前提と照らす」。

### 4. Task を切る

触る場所はリポジトリからの相対パス（`src/db.ts`、ディレクトリなら末尾に `/`）で書く。並列ガード（CLAUDE.md。`pbi-complete` の「並列で動かす」）の `overlap` がこのパスで他のセッションとの重なりを見る（パスの無い Task は判定できず着手できない）。
粒度は `issue-workflow` の「Task 粒度チェック」6 項目（場所の名指し / 番号つき手順 / 満たす受け入れ条件 / コマンドで書ける検証 / 1 PR ≤ 500 行 / 利用者の判断点の明示）。
順番の目安: **共有の型 → 中核 → 周辺（アダプタなど）→ UI → 実構成での確認**。前の Task・ほかの PBI の成果を使うなら、本文に決まった 1 行 `**前提**: #N, #M`（PR のマージが動いている版に入るまで待つなら `#M（リリース）`、無ければ `**前提**: なし`）。並列ガードとデーモンが読むのはこの 1 行だけで、自由文の「前提: #K が Done」は読まれない。ほかの PBI の Task を待つ順、決定ログや `## 回答` で決まった順もこの行に書く。`## Tasks` の着手順の行や手順の自由文（「#K の後」「#K のマージ後」）だけに書かない — lint が warning で出す（#2149）。同じ PBI の Task の順は前提にしなくてよい（スタックの順）。
Spike が要るなら timebox と成果物（`docs/design/<name>.md`）を書いた Task にする。

被覆表を作ってから起票する（本文には書かないが、PBI の決定ログに残す）:

```
受け入れ条件 1 → Task A
受け入れ条件 2 → Task A, B
…
```

覆われない条件があれば Task を足す。**条件をスコープ外に移すのは利用者の判断**（要件の変更）: PBI の決定ログに理由を書き、`## 判断待ち`（ラベル `needs-decision`。`issue-workflow` の「判断待ちの出し方」）で利用者に聞き、返事があるまで Ready にしない（headless でも同じ。勝手に条件を削って Ready にしない）。画面に関わる問いは `issue-workflow` の「判断待ちの出し方」の画面イメージを添える。

```bash
gh issue create -t "Task: <触る場所 — 何をするか>" -l type:task -F "$W/task.md"     # W=$(mktemp -d /tmp/<リポジトリ名>.tasks<PBI>.XXXXXX)。固定の /tmp/task.md にしない
bash scripts/setup/triage_issue.sh <num> <area> <kind> <P0-P3> "Phase N" <PBI番号> Backlog     # 親 = PBI
gh issue edit <num> --milestone "<PBI と同じ Milestone>"
# BACKLOG_URL があれば（issue-workflow の「操作」）: 作成と親とフィールドと Milestone を ops-kit backlog で
#   ops-kit backlog create --title "Task: …" --label type:task --body-file "$W/task.md" --parent <PBI番号> --milestone "<PBI と同じ Milestone>"
#   ops-kit backlog triage <num> <area> <kind> <P0-P3> "Phase N" <PBI番号> Backlog
```

Task 本文（`.github/ISSUE_TEMPLATE/task.yml` の見出し。「やること」の末尾に設計チェックの 1 行）:

```
## 親 PBI            #N
## やること           1 段落。触るパッケージ / ファイル。満たす受け入れ条件: 親 PBI の n, m
**前提**: #K         （無ければ **前提**: なし。字下げせず行の頭に置く）
                     設計チェック: 〜はしない（理由）/ 既存の〜に足す
                     負荷: <頻度> × <大きさ>（今 / 3 か月後）。繰り返し呼ぶものが無ければ「負荷: なし」
## 手順              1. path: 何を（関数名・型名・エンドポイント・設定キーを決めて書く） 2. … （3〜6 ステップ）
## 検証              テストのコマンド（CLAUDE.md）で <file> の "<name>" が pass / curl … | jq .<key> / Chrome で <操作> → <結果>
## 完了条件 (DoD)     - [ ] テスト追加 - [ ] typecheck / test green - [ ] 実構成で確認 - [ ] 結果コメント
```

### 5. PBI を Ready にする

1. PBI の `## Tasks` に着手順を 1 行（`sub-issue 参照。順番: core → web`）
2. 決定ログに「YYYY-MM-DD: Task 分解（#a, #b, #c）。被覆: …。Story Points N → M（理由）」
3. `bash scripts/setup/set_project_field.sh <PBI> Status Ready`（`BACKLOG_URL` があれば `ops-kit backlog set <PBI> Status Ready`）
4. `bash scripts/setup/lint_backlog.sh`（`BACKLOG_URL` があれば `ops-kit lint --fresh`）→ exit 0

## 報告（利用者への返事の型）

```
PBI #<num> を Ready にしました（Task <n> 件）。
| Task | 触る場所 | 満たす条件 | 前提 |
| #..  | ..      | ..        | ..   |
設計で決めたこと: <入れなかったもの 1〜3 行>
利用者の判断が要る箇所: <あれば>
次: /task-to-pr #<最初の Task> または /pbi-complete #<num>
```

## やらないこと

- Task を 1 件作っただけで Ready にする（受け入れ条件の被覆が条件）
- 「適切な場所に」「必要に応じて」の手順。名前を決めて書く
- PBI の願望をそのまま Task にする（`issue-workflow` の「PBI と Task の境界」: 本文 1 行の Task が膨らんで Windows まで着手した）
- 実装しながら設計を決める。決めるのはここ。実装で変わったら Task と PBI の決定ログを直す
