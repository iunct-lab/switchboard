# スクリーンショットつきフィードバック

Rail 下部の「フィードバック」はどの画面（Home / Task / Knowledge / Ledger / Insights / Backlog / Schedules）からも開ける。送り方を「要望として登録」（既定。開くたびにこれに戻る）か「すぐ直す」（下の節。送信ボタンは「直す」になり、要望 Issue は作らない）から選び、本文を入力し、「画面を撮る」でブラウザが共有を許可した画面の 1 フレームを PNG にする。現在のタブを候補にし、撮影の間はダイアログを閉じて（ダイアログと暗い背景が写らないように）、撮影後に同じ本文・添付のまま開き直し、画像のサムネイルを表示する。ダイアログには「送信元: <画面名>」（Home / Task「<題名>」(<id>) / Knowledge / Ledger / Insights / 定期タスク / Backlog）が出て、送ると要望の `## 出典` に「画面: <画面名>」の行が入る（#262）。`## 出典` の 1 行目は `- 誰の言葉: 利用者`（要望の文は利用者が書いたもの。評価から開いた下書きも利用者が直して送る。値の決まりは request-to-backlog の「誰の言葉」、#1818）。Task の評価から開いたとき（「改善要望にする」、#1221、`docs/design/evals.md`）は本文に下書きが入って開き、`source: { kind: "eval", taskId }` で `## 出典` に「評価から: Task <id>」の行も入る。撮影を拒否した場合や非対応のブラウザでは、貼り付け・ドロップ・「添付」を案内する。本文だけでも送信できる。

送信すると次の経路を通る。

1. UI が添付を既存の `POST /api/attachments` にアップロードする。
2. `POST /api/feedback` に `{ text, attachmentIds, workspaceId }` を送り、登録先の workspace の Task を作る（下の「登録先」）。題は「要望: 」と本文の先頭 40 文字（改行は空白）。本文は必須、上限 20,000 文字。
3. Task 作成時に添付を既存の Task ディレクトリへ移し、ランナーの prompt にパスを付加する。送信成功でダイアログを閉じ、作成した Task を開く。失敗時は本文と添付を保持する。
4. ランナーが `.claude/skills/request-to-backlog/SKILL.md` で要望 Issue を作り、`.claude/skills/pbi-to-tasks/SKILL.md` で PBI を Task に分解して Ready にする。原文・出典と派生先は Issue に記録する。

prompt の正本は [`buildFeedbackPrompt`](../../packages/core/src/feedback.ts)。原文を text フェンスに保持し、フィードバックボタンからの送信日時を ISO 形式で付ける。本文にバッククォートがあれば、外側のフェンスを長くする。作った PBI / Task の実装には着手しない。

### 登録先

ダイアログの「登録先」（workspace が 2 つ以上のとき）で、要望を作るリポジトリを選ぶ。バックログの「要望を登録」から開けば絞り込み中の workspace（App の一覧がまだ知らない workspace でも選択肢に足して選ぶ）、ほかの画面からは meta workspace が初期値。`workspaceId` を省くと meta workspace。

meta 以外の workspace なら、Task はその workspace で始まり、`buildFeedbackPrompt` の `other` が要望 Issue・PBI・Task をそのリポジトリとその Project（リポジトリ変数 `projectVar`、無ければ `SWITCHBOARD_PROJECT_URL`）に作らせる。スキル・スクリプトの読み替えはバックログの工程ボタンと同じ `otherRepoRules`（[backlog.ts](../../packages/core/src/backlog.ts)）。画像の置き場はそのリポジトリの CLAUDE.md に従い、書かれていなければ保留する（`feedback-assets` は Switchboard のもの）。すぐ直す は登録先を使わず、常に Switchboard を直す。

### すぐ直す（#263）

`POST /api/feedback` の `mode`（`request` 既定 / `fix`）。`fix` は要望 Issue を作らず、その場で直す Task を始める: 題は「直す: 」と本文の先頭 40 文字、prompt は [`buildFixPrompt`](../../packages/core/src/feedback.ts) — meta workspace の構成（`workspaceBrief()`、Home の「このアプリを改善 →」と同じ前置き。末尾の「やってほしいこと:」の直後に本文）、`## 出典`（フィードバックボタン「すぐ直す」、日時、画面）。`request-to-backlog` は呼ばない。添付・ランナーの選び方は要望と同じ。直した記録は Task と PR に残る。

prompt の末尾の `## 進め方`（`FIX_SCOPE`）で、Task は直した PR を main にマージするところまで進める（PR を出したまま、レビューも無いまま止まっていたため）: 別のランナーのレビュー（`cross-runner-review`）、指摘の処理とマージ（`review-triage-and-merge`。Issue が無いので、スキルが Issue から作るレビューの材料は PR 本文に引用した利用者の言葉で代え、Issue に書く記録は PR に書く。範囲外の指摘の Issue 化はスキルどおり。枝 `sb/fix-<topic>` は Issue に結び付けない）、CI とマージ判定（CLAUDE.md の「マージ判定とローカル CI」、`[再チェック]` は [merge-gate.md](merge-gate.md) の「再チェック」）。範囲はバックログの「実装」の `COMPLETE_SCOPE`（[backlog.ts](../../packages/core/src/backlog.ts)）と同じ: merge-gate が merge を返せば聞き直さずにマージし、`[聞く]` の停止・昇格・デーモンの再起動・認証は Task の会話で聞く。

### 新しいリポジトリ（#1447）

`POST /api/new-repo`（`{ name, purpose }`）が meta workspace に「新しいリポジトリ: <名前>」の Task を 1 つ始める（種類 `new-repo`）。prompt は [`buildNewRepoPrompt`](../../packages/core/src/feedback.ts) で、`.claude/skills/new-repo/SKILL.md` に従うこと・残りの決めることは Task の会話で聞くこと・終わったら登録の結果と手作業で残るもの（Project のビュー 2 つ）を報告すること、の 3 文と、名前・用途（データのフェンス）・出典だけ。リポジトリの作成・雛形の展開・登録の手順はスキルが持ち、デーモンは持たない。画面の入口は設定の先頭の「Workspace」カードの「追加」→「新しく作る」（名前と用途 → 「作成を頼む」で Task の画面へ）。同じカードの「ホストのパス」が既存のディレクトリの登録（以前は Home）で、repo の Workspace が 0 件のときだけ Home に「設定で追加 →」の 1 行が出る。ランナー・モデル・思考の深さは下の「ランナーと設定」と同じ（種類ごとの既定 `byKind["new-repo"]` を持てる）。

## ランナーと設定

`Settings.autoStart`（設定画面の「自動で始まる Task の既定」、#832）のランナーとモデルを使い、ランナーが未検出なら Claude（モデルは CLI の既定）にフォールバックする。共通のランナーと Claude が両方とも未検出、または meta workspace が存在しない場合は 409。LLM 提案用の `routing.llm.runner` とは別の設定。「すぐ直す」（`fix`）・「要望として登録」（`request`）・「新しいリポジトリ」（`new-repo`）は種類ごとの既定（`autoStart.byKind`、#1337）を持てて、あってそのランナーが検出済みならそれで始まり、無い・未検出なら上の共通の値の決め方に進む。

通常の Task と同様、提案とその使用量の記録を経て作成する。`routing.llm.model` は継承しない。承認モードも既存の Task の既定値に従う。

実ランナーでのバックログ化の検証対象は Claude Code。API は `Settings.autoStart` に従い Codex / DAK も選べるが、それらによるスキル実行はこの PBI の検証対象外。

## 画像の置き場

GitHub の Issue API には画像添付のアップロード経路がないため、Switchboard の要望ではバックログ化スキルが `feedback-assets` ブランチに画像を置き、要望 Issue 本文へ画像 URL を埋める。これは成果物用の独立したブランチで、main へマージしない。画像のパスは `feedback/<要望 Issue 番号>-<連番>.png`。アップロード前に個人情報が写っていないかをスキルに従って確認し、問題があれば公開を保留する。

ローカルの添付保存と認証・容量制限は [attachments.md](attachments.md) に従う。要望は保存データの Issue（GitHub の Issue と同期）に、実行経過は Task に残る。

## 検証

- `bun test packages/core/src/feedback.test.ts`: 原文・出典・スキル、meta cwd、添付パス、ランナー選択、400 / 409 を検証。
- `bun run typecheck`、`bun test`: 既存の検証。
- `bun run --cwd apps/web build` → `bun scripts/feedback-e2e.ts`: 偽ランナー、隔離 DB、専用 Chrome プロファイルで撮影・拒否後の貼り付け / ドロップ・送信を通す。撮影の呼び出し時と最初のフレームでダイアログが閉じていること（`dialogOpenAtCapture` / `dialogOpenAtFrame` が false）、撮影後に開き直して本文が残ることも確かめる。`CAPTURED=<file.png>` で撮った画像を保存する。`CHROME_BIN` で Chrome のパスを指定できる。

撮影成功は `--auto-select-tab-capture-source-by-title=Switchboard` を使う。拒否テストは CDP でドキュメント応答に `Permissions-Policy: display-capture=()` を付け、ブラウザに拒否させる。headless の自動拒否フラグが選択待ちのままになるケースを再現したため、この決定的な拒否に置き換えた。getDisplayMedia 自体はモックしていない。

## 制限・スコープ外

スクショの注釈・トリミング・合成、オフライン送信保留、フィードバック専用一覧、作成した PBI / Task への自動着手は含まない。撮影はブラウザの画面共有機能に依存し、利用者が選択した画面を撮る。Issue の作成完了は Task の応答で確認する（API の 201 は Task の作成完了）。

## 実ランナー確認（2026-09-20、#144）

隔離デーモンの Claude Code（Sonnet）で、テスト用の本文と PNG から要望 #171、PBI #172、運用 Task #173 を作成した。最初の「テスト: フィードバック経路の確認（この Issue は閉じてよい）」だけでは開発価値がないと判断され、要望 Issue だけが作成された。同じ Task に「要望から PBI・Task までの関連を追って再確認する」という検証用の価値を補足し、PBI と Task の分解を確認した。入力によってはバックログ化する価値がなく、常に PBI が作られるとは限らない。

画像は `feedback-assets` の PNG が送信した 279 bytes と一致し、GitHub の Issue 本文 HTML に画像要素があることを確認。非公開リポジトリの画像はログイン権限が必要。Issue 画面上での表示確認の結果と生成したテスト Issue の後始末は #144 に記録する。
