---
name: issue-workflow
description: Issue 運用ルール。要望（type:request、要望の正本）→ PBI → Task の階層（Phase は Milestone、Epic は置かない）、PBI の書き方（ユーザーストーリー・検証つき受け入れ条件・Story Points）、Task の書き方（実装者が迷わない粒度）、PBI が Ready になる条件、着手・逸脱・完了時に Issue へ何を記録するか、gh / Project の操作コマンドと lint。Issue を作る・着手する・閉じる・Project を触るときに必ず読む。
---

# Issue workflow（PBI → Task、Phase は Milestone）

Scrum の基本に沿う。ただし **Sprint / Sprint Backlog は置かない**（一人開発 + LLM が実装する前提では、計画単位としての Sprint に意味がない。
Product Backlog を Priority 順に上から取るだけ）。
**PBI は Task に分解され sub-issue が揃った時点で Ready**。Ready の PBI を優先度順に上から取る。

## 使う側のリポジトリが持つもの

このスキル群はいくつものリポジトリで共有する。リポジトリごとの値はスキルに書かず、各リポジトリが持つ。
スキルに「CLAUDE.md の〜」とあれば、作業しているリポジトリの root の `CLAUDE.md`（Codex は `AGENTS.md`。中身は CLAUDE.md を指す）を読む。
スキルと CLAUDE.md が食い違えば CLAUDE.md に従う。

- `ops.config.json`（root）: Project の URL（`projectUrl`）、フィールドの選択肢（Area / Kind / Priority / Phase）、Milestone の名前の形、
  種類ごとの必須の節（PBI / Task / 要望）、元要望の節の名前と形、Story Points の値、環境変数の接頭辞（`envPrefix`）。バックログの道具はここを読む
- `scripts/setup/` の入口: `lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `bootstrap_project.sh` / `request_issue.sh`。
  中身は共有のキットで、入口はそのリポジトリの `ops.config.json` を渡して呼ぶだけの薄いもの
- 設定を読まないもの（`scan-issues` / `scan-text` / `pull-main`）の入口は求めない（あっても使わない）。キットの `bin` の `ops-kit <command>` で呼ぶ（Task とホストのシェルでは PATH にある）
- `CLAUDE.md` / `AGENTS.md` が書く値（チェックリスト。無い項目は、その工程を使わないという意味）:
  - [ ] リポジトリの `owner/name`。`gh` の書き込み（issue / pr の作成・コメント・編集・マージ・クローズ）に `-R <owner/name>` が要るか。
        要るなら、このスキル群の `gh` の書き込みには全部 `-R <owner/name>` を付ける（スキルの例では省いている）
  - [ ] 共通キットを持つリポジトリの `owner/name`（そのリポジトリ自身なら不要。`request-to-backlog` の「どのリポジトリにも要る仕組み」の起票先）
  - [ ] テストのコマンド（型検査、全体、1 件だけ）。変更の種類ごとのテストの型（単体 / E2E）
  - [ ] worktree と枝の規則（worktree の場所、枝の名前）、作業ファイルの置き場
  - [ ] 画像の置き場（要望・PBI に貼るもの）
  - [ ] ランナーの利用上限の見方
  - [ ] 動いている実物で変更を確かめる方法（live check）
  - [ ] マージ判定のコマンド、ローカル CI のコマンド（あれば）、再チェックの手順（あれば。マージ判定が `[再チェック]` の理由を出すとき）
  - [ ] 並列ガードのコマンド（あれば。PBI を別々のセッションで同時に進めるとき）
  - [ ] 追加のレビュアー（任意。例: ローカルモデル）とその呼び方
  - [ ] main の作業ツリーの更新（`ops-kit pull-main`）の既定を変える点（pull が動いているサービスを再起動するので OK を取る、など）。無ければ既定どおり pull する
  - [ ] エージェント管理アプリの Task として起動されたことの見分け方、動いているコードの更新のしかた（誰の OK が要るか）
  - [ ] Story Points の基準にする閉じた PBI、設計ルールの置き場、ライセンス、互換層についての前提（利用者・外部クライアントの有無）
  - [ ] 要望を PBI にする前に照らす前提（信頼モデル・使い勝手。1 行 1 前提で根拠つき。`request-to-backlog` の「前提と照らす」）。無ければ照らさずに進む

## 階層（要望は正本、PBI → Task の 2 層が作業単位。Project のビューと一致させる）

| 階層 | ラベル | 親 | 何を書くか | 閉じる条件 |
|---|---|---|---|---|
| 要望 | `type:request` | **無し** | 利用者の要望を**意図を変えずに整えた文**、出典、添付、派生 PBI の一覧。`request-to-backlog` スキルが作る | 派生 PBI が全部 Done か「やらない」。公開側の Issue から来たものは公開側の Issue も閉じる（`pbi-complete` の 6-5） |
| PBI | `type:pbi` | **無し** | **ユーザーストーリー**、背景、**検証方法つきの受け入れ条件**、スコープ外、**Story Points**、**元要望**（要望 Issue の番号）。実装方法は書かない | 受け入れ条件を 1 つずつ検証した記録がある |
| Task | `type:task` | PBI | 実装可能な単位。触るファイル・**手順**・検証コマンド・完了条件（DoD） | PR がマージされ、結果コメントがある |

- **要望と PBI は 1 対 1 ではない。** 1 通の要望から価値ごとに複数の PBI を切り、要望 Issue の `## 派生 PBI` と PBI の `## 元要望` で互いを指す。要望 Issue にも親を付けない
- **PBI に親 Issue を付けない。Task の親は必ず PBI。** Project（`ops.config.json` の `projectUrl`）の Backlog ビューは `no:parent-issue`、
  Task Board は `has:parent-issue`（親でグループ化）なので、この 2 層にすると Backlog = PBI、Task Board = PBI ごとの Task になる。
  親を付けた PBI は Task Board に落ちて Backlog から消える（Epic を親にすると、Backlog には Epic しか出ない）。
- **Epic 層は置かない。** Phase（リポジトリの計画の到達点）は GitHub **Milestone**（`Phase 1 — …` / `Phase 2 — …` …）と
  Project の Phase フィールドで束ねる。到達点と進捗は Milestone の説明に書く。前に Epic を置いていたなら、Milestone に移して close する（閉じた PBI は履歴として旧 Epic の子のままでよい）。
- Ready の PBI は Backlog ビューで Status=Ready を見る。
- **1 Task = 1 PR**。1 つの PR が複数 Task を閉じるなら、それは分解が粗かったということ。PBI 側の決定ログに残す。
  例外は「運用 Task」（Issue の書き直し、DB の取り込み、Public 切替など PR を伴わない作業）。本文に「運用作業、PR なし」と書き、結果コメントで閉じる。
- バグ修正も Task を切る（`type:task` + `bug`）。hotfix でも Issue なしの PR は作らない。

## PBI の書き方（Definition of Ready の前半）

**ユーザーストーリーが書けない PBI は Backlog に入れない。** 形は固定:

```
<誰> として、<何ができる> ようにしたい。<何のため> に。
```

- 「誰」は利用者の立場（そのリポジトリの利用者 / 公開者 / 一人で Scrum を回す開発者 …）。「LLM」や「デーモン」は主語にしない
- 「何ができる」は成果。「〜を実装する」「〜を追加する」は手段なので書かない
- 「何のため」は今困っていること。書けないなら、その PBI は要らないかもしれない

受け入れ条件は 1 行 1 条件で、**行ごとに検証方法（コマンド・テスト名・画面操作と期待結果）を併記**する。
「動く」「使える」だけの行は検証できないので書かない。見本は CLAUDE.md が挙げる基準の PBI。

### 利用者確認の項目

利用者が自分の目・実機・お金で確かめる行（ホストでの実機確認、画面の目視、採否の決定）は、行末に `（利用者確認: <何を見て何を確かめるか>）` を付ける:

```
- [ ] <条件>（検証: …）（利用者確認: <何を見て何を確かめるか>）
```

エージェントが検証できる行（grep・テスト・headless の画面）には付けない。形はこの 1 つだけ（自由文の「利用者の確認」は拾われない）。`## 到達点 / 受け入れ条件` 節の中、フェンスの外の `- [ ]` 行で、`（利用者確認:` がインラインコードの外にあるものだけを、エージェント管理アプリが利用者確認として拾い、利用者がその画面で答える。「確認した」でその行が `- [x]` になり `## 回答` に確認した旨が書かれ、「違う」は理由が `## 回答` に書かれてチェックは付かない。この行はエージェントがチェックしない。

### Story Points

- Project の **Story Points** フィールド（数値）に入れ、本文にも `**Story Points**: N` を 1 行置く。lint は本文の N を読み、
  Project の値と**同じ**であること、N が **1 / 2 / 3 / 5 / 8** のどれかであることを検査する（小数・13・不一致は違反）
- 尺度はフィボナッチ **1 / 2 / 3 / 5 / 8 / 13**。相対見積り（工数の時間ではない）。**13 は「大きすぎる」の印で、分割してから Backlog に入れる**（lint が弾く）
- 基準（中身の目安。リポジトリの閉じた PBI で基準にするものは CLAUDE.md に番号で挙げる）:

  | SP | 中身 |
  |---|---|
  | 2 | 一次資料を読んで doc を 1 本書く。コード変更なし |
  | 3 | API 1 本 + 画面の 1 箇所 + docs。Task 2〜3 件、1 日 |
  | 5 | 運用作業 + 中核の起動時処理 + UI 表示 + 起動ログ。Task 3〜4 件 |
  | 8 | 複数の部品（アダプタ 2 つ + 中核 + UI + docs など）を横断。Task 4 件以上、未知の挙動あり |

- 付けるタイミング: **PBI を作ったとき**（Backlog に入れる時点で必須）。Task に分解して見積りが変わったら更新し、決定ログに理由を書く
- Task には Story Points を付けない。Task の大きさは「1 PR で終わる（差分 500 行以内、テスト込み）」で縛る。超えるなら Task を割る

### PBI 本文（テンプレ: `.github/ISSUE_TEMPLATE/pbi.yml`）

```
## ユーザーストーリー      <誰> として、<何ができる> ようにしたい。<何のため> に。
## 背景 / 課題            何が今できず困るか。既存の仕組みのどこが足りないか（ファイル・Issue 番号で名指し）
## 到達点 / 受け入れ条件   - [ ] 条件（検証: コマンド / テスト名 / 画面操作と期待結果）
## スコープ外             やらないと決めたこと・理由。この環境で検証できないもの（他 OS・GUI・実機依存）はここか、受け入れ条件の行に `（利用者確認: …）`（「利用者確認の項目」）
## 元要望               #<要望 Issue>（要望のどの部分か）。要望 Issue が無い過去のものは「なし（理由）」
**Story Points**: N
**前提**: #N, #M（リリース）   ほかの PBI・PR が先に要るとき（無ければ **前提**: なし）。並列ガードとデーモンはこの 1 行だけを読む
## Tasks                  sub-issue で紐づける（本文には書かない）。着手順だけ 1 行書く
## 決定ログ               日付 / 決めたこと / 理由（着手後に追記していく）
## 結果                   閉じるときに: 受け入れ条件ごとの検証結果、残したもの
```

## Task の書き方（Definition of Ready の後半）

**「実装者が迷わない」= 次の Task 粒度チェックを全部通す。** 通らないものは Task ではなく PBI の願望なので、PBI に戻して考え直す。

1. **触る場所が名指しできる**: パッケージとファイルを書く（`src/foo.ts`（新規）、`server.ts` の `/ws` ルート …）。「適切な場所に」は不可
2. **手順が番号つきで並ぶ**: 3〜6 ステップ。各ステップに触るファイルと、関数名・型名・エンドポイント・設定キーなど**名前を決めて書く**。実装者が命名で迷わないように
3. **満たす受け入れ条件を指す**: 親 PBI のどの条件（番号）をこの Task で満たすか書く。PBI の全条件がいずれかの Task で覆われていることを確認する
4. **検証がコマンドと期待出力で書ける**: テストのコマンド（CLAUDE.md）で `<file>` の `<name>` が pass、`curl … | jq` に `<key>` が出る、Chrome で `<操作>` → `<結果>`。この環境で実行できないなら Task にしない
5. **1 PR で終わる**: 差分 500 行以内（テスト込み）。前提となる Task・PR があれば本文に `**前提**: #N, #M（リリース）` の 1 行（並列ガードとデーモンが読む。自由文の「前提: #N が Done」は読まれない）
6. **利用者の判断が要る箇所は明示**: お金（定額枠の消費）、他 OS、破壊的操作（Public 切替、削除）、要件の解釈が絡むなら「着手前に確認してコメントで止める」と手順に書く

Spike（方式を決めるための調査）も Task にできる。ただし timebox（時間）、成果物（`docs/design/<name>.md` に試した組み合わせ・コマンド・出力・採用案）、
決めることを明記する。コードは捨てる前提。

### Task 本文（テンプレ: `.github/ISSUE_TEMPLATE/task.yml`）

```
## 親 PBI               #N
## やること              1 段落。触るパッケージ / ファイル。満たす受け入れ条件: 親 PBI の n, m
## 手順                  1. ファイル: やること（名前を決めて書く） 2. … 3. …
## 検証                  何を実行して何が出れば良いか（テスト名、curl、画面操作）
## 完了条件 (DoD)         - [ ] テスト追加 - [ ] typecheck/test green - [ ] 実構成で確認 - [ ] docs 更新 - [ ] 結果コメント
```

## Ready の判定（PBI）

次の 4 つ全部で Ready。**Task を 1 件作っただけでは Ready ではない。**

1. ユーザーストーリー・検証つき受け入れ条件・スコープ外・元要望・Story Points が本文にあり、Project の Story Points が入っている
2. 受け入れ条件の各行が、少なくとも 1 つの Task sub-issue の「満たす受け入れ条件」で覆われている
3. 各 Task が上の「Task 粒度チェック」6 項目を通る
4. この環境で検証できないものは Task にせず、PBI の「スコープ外」に理由つきで書くか、受け入れ条件の行に `（利用者確認: …）` が付いている

`scripts/setup/lint_backlog.sh` が機械的に見られる分（節の有無、`## 元要望`、Story Points の値と本文 / Project の一致、親、Ready なのに Task なし、要望 Issue の `## 要望` / `## 出典`、要望の `## 出典` の `- 誰の言葉:` が 3 つの値のどれか（`request-to-backlog` の「誰の言葉」。`request_issue.sh` もこの行の無い本文では要望を作らない））を検査する。
exit 0 = 合格、1 = 違反あり、2 = 検査できなかった（gh や Project の取得失敗。0 件で合格にはしない）。
**PBI や Task を作った・書き直したら必ず走らせ、`violations: 0` と exit 0 を確認する**（2 と 3 は目視）。

## PBI と Task の境界（過去の失敗）

ある Task「単一バイナリ化」は本文が 1 行（「Tauri サイドカー用の単一バイナリ。3 OS のビルドマトリクスを CI に」）で、
PBI レベルの願望を Task として扱った。結果:
- 何が完了条件か決まらないまま実装が膨らんだ（Windows 用 CI、Tauri シェルまで着手）。
- 検証できない環境（Windows / デスクトップ）向けの作業を、判断点なしに進めた。
- Issue に途中経過が一切残らず、PR の説明だけが記録になった。

オープンの PBI のほとんどが本文 1 行（ユーザーストーリー・受け入れ条件・Story Points なし）で、Task に分解されていなかったことがある（あとで全部書き直した）。
**Issue は作った時点で規約を満たす**。「あとで書く」は書かれない。

ルール: **「検証」と「完了条件 (DoD)」が書けないものは Task ではない**（受け入れ条件は PBI の言葉。Task は「何を実行して何が出れば良いか」まで落ちている）。
Task に落とせるまで PBI のままにし、「何を作るか」ではなく「何ができたら終わりか」から書く。ローカルで検証できない成果（他 OS、GUI、実機依存）は
Task にせず PBI の決定ログで「やらない / 保留」を明記する。

## Issue・PR・コメントに書かない値

Issue と PR は、リポジトリを読める全員が読む。公開リポジトリなら全世界が読む。**認証に使える値は、Issue・PR の題と本文、コメント、レビューコメントに書かない。失効済みでも、非公開リポジトリでも書かない**（無人の実行のエージェントは、管理者権限の一時セッション用の device code と承認 URL を Issue コメントに書くことがある。失効していて非公開なら実害は無いが、それは偶然）。

| 書かない値 | 代わりに書くもの |
|---|---|
| device code、`user_code` 付きの承認 URL | 「承認が要る」という事実だけ |
| トークン、API の鍵、秘密鍵、`Bearer` の値、Cookie | 種類の名前（「GitHub のトークン」） |
| 招待リンクや共有リンクの秘密（URL の `#k=` の値など） | `#k=…`。リンクはファイルに書き、その場所を伝える |
| クラウドのアカウント ID、プロファイル名・SSO のセッション名（アカウント ID を含まないものも。ホストの AWS の設定にある名前を前段が当てる） | `<account-id>`、`<profile>`、`<sso-session>` |
| SSO の開始 URL、内部のホスト名 | 「SSO の開始 URL」 |

- **ログやコマンドの出力を貼る前に読む。** エラーの文や `--debug` の出力に値が混ざる。貼るのは必要な行だけ
- **認証切れと判断する前に**: 「GitHub の接続・認証の切り分け」（下の「操作」）を行う。接続制限だけで再ログインを求めない。
- **無人の実行で承認が要るとき**（SSO が切れた、ログインが要る）: 値を作らず、出さない。Task を動かしているアプリが `DEVICE_AUTH_URL` を渡していれば、承認のコードを出すコマンドを `device-auth -- <command>`（キットの `bin`）で包んで動かす。URL とコードはその Task の画面に出て、自分が読む出力からは伏せられ、利用者が承認するとコマンドが終わる。Issue・PR に書くのは結果（終了コード。124 は期限切れ）だけ。`DEVICE_AUTH_URL` が無い（`device-auth` が exit 2）か、渡せなかったときは、運用の確認（「判断待ちの出し方」）として Task の会話で聞いて止める。書くのは「何の承認が要るか」「何が止まっているか」だけ。device code は、利用者が居合わせる対話のセッションの画面と、`device-auth` が渡す Task の画面にだけ出す
- **利用者に結果を書いてもらうとき**（実機の確認、利用者の端末での配置）: 頼む文に「アカウント ID・URL・リンク・QR の画像は書かない。pass / fail と件数、エラーの文言だけ」と書く
- **機械の歯止め**: エージェント管理アプリが起動したランナーでは、`gh` の前段が書き込みの本文を検査し、値があれば（ホストの AWS の設定のプロファイル名・SSO のセッション名も `aws-profile` として）投稿せずに exit 1 で止める（`gh-guard: 投稿を止めました`）。止まったら値を伏せて書き直す。前段を避ける経路（API を直接叩くなど）で投稿しない
- **書いてしまったとき**: すぐ利用者に知らせ、値を失効させる（できるなら）。片づけは利用者の OK を取ってから（利用者の書いた文もあるので、自分で消したり直したりしない）: 編集では履歴に元の文が残るので、コメントは値を伏せた文を新しいコメントとして書き、**元のコメント**を削除する。Issue や PR の本文は削除できないので、伏せ字に直したうえで利用者に履歴の削除を頼む
- **後からの検査**: `ops-kit scan-issues` が、リポジトリの Issue・コメント・PR のレビューコメントを全部検査する（exit 0 = 無い、1 = ある、2 = 検査できなかった。出力は場所と種類で、値は出ない）。PBI を閉じるときに 1 回走らせる（`pbi-complete` の 6）。`ops-kit` が PATH に無い（`command -v ops-kit` が空）ときだけ走らせず、報告に「検査していない（キットが PATH に無い）」と書く

## 記録の義務（Issue に残すもの）

Issue は「何をやったか」の正本。PR の説明は補助。**本文 1 行のまま閉じない**。

1. **着手時**: Status を In progress にし、コメントで「ブランチ名 / 進め方 / 想定する検証」を 3 行以内で書く。
2. **逸脱時**: スコープを削る・増やす・別案にする、検証できないと分かった、依存が壊れていた — その都度コメント。
   「なぜ」を必ず書く。判断が利用者に属する（お金・他 OS・破壊的変更・要件の解釈）なら、**止めて聞く**。マージ判定が merge を返した PR のマージは依頼の範囲なので聞かない（`pbi-complete` の「この依頼が含む範囲」）。聞く場所は問いの種類で分ける（「判断待ちの出し方」。実装の判断は Issue、運用の確認は Task の会話）。

3. **完了時（Task）**: PR の `Closes #N` でマージ時に自動 close される（それで良い）。**マージ直後に結果コメント**（下のテンプレ、マージ日入り）
   を書き、Project の Status を Done にする。結果コメントの無い Task は「閉じているが未完了」として扱う。
4. **完了時（PBI）**: 受け入れ条件のチェックボックスを検証結果つきで埋め、「結果」節を書いてから**手動で** close（PR から Closes しない）。
5. **Milestone**: PBI が閉じるたびに Milestone の説明を更新する（残り / やらないと決めたもの）。全 PBI が Done か「やらない」なら Milestone を close。

### 判断待ちの出し方

利用者への問いは 2 種類。種類で聞く場所を分ける:

| 種類 | 例 | どこで聞くか |
|---|---|---|
| 実装の判断 | 要件の読み、設計の選択、受け入れ条件の変更、スコープ外への移動 | Issue（PBI か Task）の `## 判断待ち`（下の形） |
| 運用の確認 | マージ判定が止めた PR のマージ（`[聞く]`、直せない stop、exit 2。merge を返した PR は `pbi-complete` の「この依頼が含む範囲」で聞かずに進む）、昇格・デプロイ・デーモンを再起動する `git pull`、認証・ログインなど利用者がその場でする操作、実行のタイミング | その Task の会話（下の「運用の確認」）。**Issue にもラベルにも書かない** |

運用の確認を Issue に書かないのは、Issue を実装に要ることだけの記録にするため（運用のやり取りが積もると、後のエージェントが古い問いや回答を拾う）。

実装の判断で止めて聞くときは、Issue（PBI か Task）に次のコメントを書き、ラベル `needs-decision` を付けてその作業を終える（例外: 要望を PBI にする作業は、解釈メモの前提で PBI 化まで続けてよい — `request-to-backlog`。止めるのはその前提に依存する実装。ただし前提と矛盾する価値（`request-to-backlog` の「2.5 前提と照らす」）があれば、その要望は（ほかの価値も）PBI にしないで止める）:

```markdown
## 判断待ち
**問い**: <1 文>
**選択肢**:
- A: <内容> — 影響: <何が起きるか>
- B: <内容> — 影響: <…>
**推奨**: <A / B> — <理由>
**止めた場所**: <ブランチ / PR #n / Task #n>
**画面イメージ**: <この Task の id>（任意。下の「画面イメージ」）
```

```bash
gh issue edit <n> --add-label needs-decision
```

選択肢に「値を Issue に出す」案を書かない（device code や承認 URL をこの Issue に書く、利用者にトークンを書いてもらう、など。「Issue・PR・コメントに書かない値」）。利用者がその案を回答で選んでも、値は書かずに理由を返信する。

回答は `## 回答` で始まるコメントで来る。続けるときは最新の `## 回答` を読み、ラベルが外れていることを確かめてから再開する。`## 保留` で始まるコメントは回答ではない（ラベルは付いたまま。続けるのは `## 回答` が来てから）。

#### 運用の確認（Task の会話で聞く）

その Task の最後の返答に次を書いて、ターンを終える（Issue コメント・ラベル・新しい目印は付けない）:

```markdown
**確認**: <1 文。例: PR #n をマージしてよいか>
**選択肢**:
- A: <内容> — 影響: <何が起きるか>
- B: <内容> — 影響: <…>
**推奨**: <A / B> — <理由>
**止めた場所**: <ブランチ / PR #n / Task #n>
**画面イメージ**: <この Task の id>（任意。下の「画面イメージ」）
```

マージ判定で止めたときは、`reasons` の行と PR の `+add/-del` を **止めた場所** の下にそのまま貼る。値を出す案を選択肢に書かないのは実装の判断と同じ。

返事は同じ会話で来る。続けるときは、止めた工程の前提をやり直してから進める（マージならマージ判定をもう一度通す。止めている間に CI・レビュー・main が変わりうる）。

#### 画面イメージ（画面の見た目・操作に関わる問い）

選択肢が画面の見た目・操作に関わる問いは（`## 判断待ち` と運用の確認の `**確認**` の両方）、文だけで聞かない。選択肢ごとに 1 枚（2〜3 案）の画面イメージを HTML で作り、成果物に登録してから聞く:

1. 作業ファイルの置き場（`W=$(mktemp -d …)`）に、選択肢ごとの HTML を書く。1 枚には、その案の画面（実際の部品の並び・文言）と、受け入れ条件に操作数などの目標があればその案での値を書く
2. エージェント管理アプリの成果物として登録する（登録のしかた（指示文が示すフェンス）は CLAUDE.md）。題は `画面イメージ <選択肢の記号>: <案の名前>`（例 `画面イメージ A: 欄の上に並べる`）。選択肢との対応はこの題の頭で読む
3. 問いに `**画面イメージ**: <この Task の id>` の行を書く（成果物を登録したその Task の id。アプリが環境に渡す値で、変数の名前は CLAUDE.md。認証の値ではないので Issue に書いてよい）。判断待ちの画面と Backlog の回答欄が、この Task の HTML の成果物をボタンで開く

エージェント管理アプリの外（Task の id が無い）では行を書かず、HTML を作業ファイルに置いて場所を問いに書く。画面を変えない問い（マージ・費用・要件の文の読みなど）には作らない。

Status 遷移（Project の Status。設定するのは作業者 = このワークフローを実行する LLM）:
- PBI: Backlog →（Task が揃った）Ready →（最初の Task に着手）In progress →（結果節を書いた）Done
- Task: Backlog →（着手コメント）In progress →（PR を作った）In review →（マージ + 結果コメント）Done

結果コメントのテンプレ（Task）:
```
## 結果
- PR: #NN（マージ日）
- 変更: 1〜3 行
- 検証: 実行したこと（テスト名 / コマンド / 画面）と結果。実ブラウザ・実ランナーで見たなら明記
- レビュー指摘と対応: 件数と主なもの
- 残したもの / 次: 
```

## 操作

手順そのものはスキルにある: 要望 → PBI は `request-to-backlog`、PBI → Task と Ready 化は `pbi-to-tasks`、Task → PR は `task-to-pr`、
レビューは `cross-runner-review` → `review-triage-and-merge`、PBI 単位の一気通貫は `pbi-complete`。ここはコマンドの控え。

**エージェント管理アプリの Task の中**（環境に `BACKLOG_URL` がある）では、Issue・Project の照会と編集は、アプリの保存値を使う `ops-kit backlog`（`--help`）と `ops-kit lint --fresh` で完結する: 作成・編集・コメント・判断待ちと回答（`--add-label needs-decision` とコメント、回答は `## 回答` のコメントと `--remove-label needs-decision`）・閉じる（`--state closed`）・sub-issue の付け替え（`edit --parent <PBI>` / `--no-parent`）・Project のフィールド（`set` / `triage`）・Milestone。照会のたびに GitHub へは行かず、編集はアプリに保存されてアプリが GitHub に送る（画面と同じ経路。認証に使える値は送らない）。GitHub 連携の無い workspace（アプリが `BACKLOG_WORKSPACE` を渡す。Issue と Project はアプリの中だけ）では、作成で番号が付き、編集はその場で確定する。GitHub 同期を無効にした workspace も同じ（`gh issue` / `scripts/setup/*` を使わない）。GitHub の Issue・Project を直接触る操作（下の「`BACKLOG_URL` の無い環境だけ」のブロック）はこの Task では使わない。PR・レビュー・マージ判定は workspace によらず GitHub（リポジトリの forge）のまま。

```bash
ops-kit backlog view <num> [--fresh]          # 本文・コメント・Project のフィールドと「最終取得 … 同期 …」
ops-kit backlog list [--fresh]
ops-kit backlog create --title "Task: <題>" --body-file "$W/task.md" --label type:task --parent <PBI> --milestone "Phase N — …" --field Status=Backlog
ops-kit backlog edit <num> --body-file "$W/body.md" | --add-label needs-decision | --state closed
ops-kit backlog edit <num> --parent <PBI> | --no-parent   # sub-issue の付け替え
ops-kit backlog comment <num> --body-file "$W/comment.md"
ops-kit backlog set <num> Status Ready         # フィールドを 1 つ。5 フィールドをまとめて: backlog triage <num> <area> <kind> <P0-P3> …
ops-kit lint --fresh                           # 規約の検査（作った・書き直したら必ず。violations: 0 かつ exit 0 で合格）
```

- **`--fresh` が要るとき**: 最新の `## 回答` を読むとき（工程の開始・再開）、着手・マージ・閉じるの判断の前。アプリに送信と取込みを済ませてから答える。正本はアプリの保存データで、GitHub は同期先: アプリが GitHub に届かない（上限・障害）ときは保存値と「GitHub 未同期」（最終同期の時刻つき、stderr）で答えて exit 0 なので、その値でそのまま進める。exit 2 はアプリに届かない・未取得だけで「判定できない」（下の「GitHub の接続・認証の切り分け」をしてから止める）。PR・レビュー・マージ判定は GitHub が正のまま（`merge-gate` は毎回 GitHub を読む）
- lint と並列ガードの `overlap` は、`BACKLOG_URL` があれば自分でアプリの保存値を読む（`overlap` はいつも先に取込み、lint は `--fresh` で。GitHub に届かなければ保存値で判定し「GitHub 未同期」を出す）。占有（claim / release）と着手の印の先着はコメントの順で決める: GitHub の workspace は GitHub に書いて GitHub のコメント id で、GitHub 連携の無い workspace はアプリの保存データのコメントの順で（並列ガードは `--repo` を付けずに実行する。譲るときは取り下げの印を書く）

```bash
# BACKLOG_URL の無い環境だけ（アプリの Task の外）。gh の書き込みに -R <owner/name> が要るリポジトリでは付ける（CLAUDE.md。「使う側のリポジトリが持つもの」）
# 作成。非対話（LLM はこちら）: テンプレの見出し構成で本文ファイルを書き、ラベルを明示する
gh issue create -t "要望: <題>" -l type:request -F body.md   # 要望は 4 バッククォートの text フェンスに
gh issue create -t "PBI: <題>"  -l type:pbi  -F body.md
gh issue create -t "Task: <題>" -l type:task -F body.md
#   対話で issue form を使うなら --template はファイル名ではなく form の name: で指定し、--body とは併用できない
#   gh issue create --template "PBI (Product Backlog Item)"   /   --template "Task"
# Project フィールド + 親の紐づけ（Area/Kind/Priority/Phase/Status/親）。親は Task のときだけ（PBI に親を付けない）
bash scripts/setup/triage_issue.sh <num> <area> <kind> <P0-P3> "Phase N" [parent-PBI] [Status]
gh issue edit <num> --milestone "Phase N — …"      # PBI と Task の両方に Phase の Milestone
#   注意: このスクリプトは毎回 5 フィールド全部を上書きする。Status だけ変えたいときは下の set_project_field.sh を使う
#   （未知の選択肢は黙ってスキップされる）。例: bash scripts/setup/triage_issue.sh 56 infra chore P1 "Phase 2" "" "In review"
# フィールドを 1 つだけ（Story Points / Status など）
bash scripts/setup/set_project_field.sh <num> "Story Points" 5
bash scripts/setup/set_project_field.sh <num> Status Ready
# 規約の検査（作った・書き直したら必ず）
bash scripts/setup/lint_backlog.sh            # violations: 0 かつ exit 0 で合格（exit 2 は取得失敗）
# 親子だけ付け替える（親が既にあるとエラー: 先に removeSubIssue）
gh api graphql -f query='mutation($p:ID!,$c:ID!){ addSubIssue(input:{issueId:$p, subIssueId:$c}){ issue{number} } }' \
  -F p="$(gh issue view <parent> --json id -q .id)" -F c="$(gh issue view <child> --json id -q .id)"
# 記録
gh issue comment <num> --body-file /path/to/comment.md
```

```bash
# どの環境でも
ops-kit pull-main                             # マージ後の main の作業ツリーを fast-forward（pulled / up to date / not pulled: <理由>。「pbi-complete」の 6）
ops-kit scan-issues                           # Issue・コメントに認証の値が無いか（hits: 0 かつ exit 0。「Issue・PR・コメントに書かない値」）
# マージ前の判定（CLAUDE.md のコマンド。exit 0 = merge / 1 = stop / 2 = 判定不能）。[再チェック] の理由は再チェックの印で外れ、--allow-large は利用者が認めたときだけ（pbi-complete の 5）
<マージ判定> <PR> [--allow-large]
```

GitHub API の注意（GraphQL の 1 時間の枠は 1 ユーザー 5,000 ポイントで、ホストの全 Task が共有する）:
- `gh project item-list` は使わない（Project 全件を読み 1 回 約 400 ポイント）。Issue 側の `projectItems`（`fieldValueByName(name:"Status")`）か、ラベル・状態で絞った `issues(...)` のクエリで引く。
- 残量は GraphQL の `rateLimit { remaining resetAt }` で見る（`gh api graphql -f query='{rateLimit{remaining resetAt}}'`）。`gh api rate_limit` の `resources.graphql` は GraphQL の残量に使わない（実際の消費と合わない）。
- 短時間に十数回叩くと secondary rate limit（毎分）で GraphQL が全部 403 になる。当たったら数分待つ。

Project: `ops.config.json` の `projectUrl`（Status: Backlog / Ready / In progress / In review / Done。Story Points: 数値）。
Ready は「Task が全部 sub-issue で揃った PBI」にだけ付ける。Task 自身は Backlog → In progress → In review（PR あり）→ Done。

### GitHub の接続・認証の切り分け

`gh auth status` の失敗や「token is invalid」だけで、認証切れと断定して止めない。ネットワーク制限下では、有効な既存認証でもその表示になることがある。

1. `gh api user --silent` と `gh api repos/<owner>/<repo>/issues/<番号> --silent`（応答の本文とアカウント名を出さず、失敗の理由は標準エラーの文で見る）で、接続できるか確認する。両方成功したら元の作業を続ける。HTTP の応答（`401` / `403` / `404` / `429`）が返ったら接続はできているので 3 へ（非公開のリポジトリでは権限不足が `404` で返る。`<owner>/<repo>` と番号が正しいことを確かめたうえで、`404` は 3 の権限不足として扱う）。DNS・接続失敗・タイムアウトなら、認証の成否はまだ判定できない。実行環境のネットワーク制限と、提供されている承認・許可の手段を確認する。
2. 制限が原因なら、**ランナーが提供する許可されたネットワーク実行で、同じ既存認証の読み取りを再試行する**。承認が要るならその承認機構を使う（例: Codex の `require_escalated`）。再ログイン、トークンの再発行、permission mode の変更はしない。許可が利用できない・拒否された場合は迂回せず、接続制限として Task の会話で理由を説明して止める。認証切れとは報告しない。
3. 許可された実行で認証と対象 Issue の読み取りが成功したら、元の作業を続ける。接続できたうえで `401` / `Bad credentials` など認証拒否が確認された場合にだけ、認証の運用確認として Task の会話で止める。`403` は応答の理由から権限不足・SSO・レート制限を区別し（レート制限は `429` のこともある）、権限不足やレート制限だけでトークン失効と決めない。権限不足は、別の経路で同じデータを取りに行かず、必要な権限を Task の会話で説明して止める。SSO の追加承認が必要なら同じく運用の確認で止める。レート制限は案内された待機時間が数分以内ならそれを守って読み取りを 1 回再試行し、成功なら続行する。待機がそれより長い、または解消しなければ、制限として報告して止める。

診断に認証値の表示は要らない。「Issue・PR・コメントに書かない値」に従い、エラーの文も値を含めずに報告する。

## 着手前チェック（LLM 向け）

- 渡された番号は 要望 / PBI / Task のどれか。要望なら `request-to-backlog` で PBI にする。PBI なら**まず Task に分解して sub-issue を作り、Ready にしてから**着手する（`pbi-to-tasks`）。
- PBI の `## 元要望` の要望 Issue を一度読む。PBI の解釈が要望からずれていたら PBI を直す。
- PBI にユーザーストーリー・検証つき受け入れ条件・Story Points が無ければ、**先に本文を書き直す**（lint を通す）。書き直しは決定ログに日付つきで残す。
- 分解した Task に、この環境で検証できないものが混じっていないか。混じるなら PBI に「やらない/保留」と書いて利用者に確認。
- Task の手順に「利用者に確認して止める」と書かれた箇所があれば、そこで止める。
- Priority は Project の Priority フィールドで見る。PBI が P0 でも子 Task が全部 P0 とは限らない。
