---
name: public-release-gate
description: 公開リポジトリを Public にする前に 1 回、公開に出すツリー（`ops-kit public-sync --dry-run` の tree）を Claude Code と Codex の 2 ランナーに互いの結果を見せずに別々に網羅的に検査させ、観点の種に無い観点も広げさせ、報告をランナーごとに公開の PBI に残し、指摘を「直す / 公開側から外す / 受け入れる」に振り分け、新しい観点を種に足すまでの型。前は public-sync の dry-run、次は公開の Task。公開前のフェーズゲートを回すとき、2 回目以降のリポジトリで回すとき、観点を足すときに読む。
---

# Public release gate（2 ランナーの公開前チェック）

目的: 公開は元に戻しにくい（fork・キャッシュ・検索の索引に残る）。決めた観点だけの検査（ホームパス・メールアドレス・認証の値・依存のライセンス）では漏れるので、Public にする前に 1 回、**公開されるものの全部**を 2 つのランナーに別々に読ませ、観点の種に無いものも探させる。見つかった観点は次のリポジトリの種になる。

- 入力は公開に出すツリー（dry-run の tree。履歴は入れない）と、公開範囲（Issue / PR を公開するか）
- 出力はランナーごとの報告（実行したモデル・観点・場所・重さ・直し方・種の外の観点）と合否
- 2 ランナーは互いの結果を見ない。片方が利用上限でももう片方で代替しない（`cross-runner-review` の 0 とは違う。2 つの目で見るのがこの型の目的）
- 実行の道具は無い。この手順をそのまま回す。種は下の表で、足すのもこのファイルの差分

## 入力

公開に出すツリーは `ops-kit public-sync --dry-run` が作る tree（設定は `ops.config.json` の `publicSync`。除外・書き換え・ホームパスとメールアドレスの検査を通ったもの）。dry-run が exit 1 なら先にその理由を直す。

```bash
NAME=<リポジトリ名>; W=$(mktemp -d /tmp/$NAME.gate.XXXXXX); echo "$W"   # 表示されたパスを以後そのまま使う（Bash の呼び出しをまたぐと変数は消える）
git fetch -q origin --tags
ops-kit public-sync --dry-run > "$W/dry-run.txt" 2>&1 || { tail -1 "$W/dry-run.txt"; echo "STOP: dry-run が止まった。先にその理由を直す（この先へ進まない）"; }
T=$(grep -oE 'with tree [0-9a-f]{40}' "$W/dry-run.txt" | awk '{print $3}')
grep -q '^nothing to sync' "$W/dry-run.txt" && T=$(git rev-parse 'refs/public-sync/main^{tree}')   # 公開側の main が既にこのツリー（初回を push した後の回し直し）: dry-run が fetch した公開側の main のツリー。これ以外で T が空なら止まる
[ -n "$T" ] && echo "tree $T" || echo "STOP: tree が取れない（dry-run の出力を読む）"
for r in claude codex; do                                           # (a) 2 ランナーに別々のディレクトリ。git の履歴は入れない（公開されるのはツリーだけ）
  mkdir -p "$W/$r/tree" "$W/$r/_gate"
  git archive "$T" | tar -x -C "$W/$r/tree"
done
find "$W/claude/tree" -name .git                                    # 何も出ない
diff <(git ls-tree -r --name-only "$T" | sort) <(cd "$W/claude/tree" && find . \( -type f -o -type l \) | sed 's#^\./##' | sort)   # 空
awk '/^dry-run: would/{f=1; next} f' "$W/dry-run.txt" | sed '1{/^$/d}' > "$W/commit-message.txt"   # (b) 同期のコミットの本文（Private のコミットの題が載る）
grep -q '^nothing to sync' "$W/dry-run.txt" && git log -1 --format=%B refs/public-sync/main > "$W/commit-message.txt"   # 「nothing to sync」のときは公開側の main の（既に公開側にある）コミットの本文
```

(c) 公開範囲 `$W/scope.md`。新しい履歴で別リポジトリへ送る形（Private の Issue・PR は公開しない）なら 2 行:

```
Issues and pull requests: not published. What becomes public is the tree and the commit message in `_gate/commit-message.txt`.
Repository name after publishing: <owner/name>
```

Issue / PR も公開する形（今のリポジトリをそのまま Public にする）なら、`gh issue list --state all --limit 1000 --json number,title,body` と `gh pr list --state all --limit 1000 --json number,title,body` の題と本文を `$W/issues.md` に書き、`scope.md` にその旨を 1 行書く（1000 件を超えるなら `--limit` を増やす。切れても何も出ない）。

(d) 観点の種 `$W/seeds.md` は下の「観点の種」の表の写し（`## 追記の記録` まで）、指示 `$W/prompt.md` は下の「指示」の原文。

```bash
for r in claude codex; do cp "$W/commit-message.txt" "$W/scope.md" "$W/seeds.md" "$W/prompt.md" "$W/$r/_gate/"; [ -f "$W/issues.md" ] && cp "$W/issues.md" "$W/$r/_gate/"; done
```

## 観点の種

各観点は「何を見るか」まで含めて `seeds.md` に写す。ランナーはこの表の全部を見たうえで、表に無い観点を自分で広げる（「指示」）。観点は見る場所の一覧で、当たった指摘が公開を止めるかは「報告と振り分け」の基準で決める（「ブロッカー」「Issue で足りる」と書いた行はその目安）。

| 観点 | 何を見るか |
|---|---|
| 鍵と認証の値 | API キー・トークン・パスワード・秘密鍵・署名の秘密・Cookie やセッションの値。コードと設定、fixture、ログの写し、`.env` の例、URL のクエリ、画像の中の文字 |
| 個人情報 | 個人の名前・メールアドレス・利用者名を含むホームパス・ホスト名・アカウント名・セッション ID・IP アドレス・生活の記録（位置・旅行・予定）。検査の置き換え名（`dev` / `example`）は通す |
| ライセンスと NOTICE | root の `LICENSE` と README のライセンスの節が一致する。取り込んだ第三者のコード・生成された型・雛形の帰属が `NOTICE` にある。ライセンスの無いファイルや、別のライセンスのヘッダを持つファイルの混入 |
| 各ランナーと LLM 提供者の規約 | CLI・API・定額の認証を道具から使う形、出力の再配布、自動化の制限が各提供者の規約の範囲か。判定でなく一次資料の引用と読み取りまで（法的助言はしない）。未確認の提供者は「未確認」と書く |
| 商標と名前 | 製品名・社名・ロゴ・モデル名の使い方。他社の商標と紛らわしい名前、「公式」「提携」と読める表現、提供者の名前をリポジトリ名や配布物の名前に含めること |
| 依存のライセンス | 依存の一覧と許可リスト（`bun pm licenses` などの検査）、copyleft の混入、ロックファイルにしか無い依存、vendored copy とその帰属 |
| Git で管理するファイルか | 実行の録画・実データの写し・作り直せる生成物は、値を洗う前に Git で管理するかを判断する |
| 録画 fixture とテストデータ | 実ランナーの録画・実データの写し・実在のリポジトリや Issue の本文の写しに残る値（パス・ID・URL・本文・日時）。置き換え名に洗ったつもりで残ったもの |
| 内部のホスト名・URL・クラウドの ID | アカウント ID・ARN・リージョンの資源名・バケット名・スタック名・内部ドメイン・ポート・社内の URL・個人のサーバの名前。雛形の値（`123456789012` など）は通す |
| secrets を使う workflow | 公開側で動く workflow が参照する secrets と `permissions`、`pull_request_target` と fork からの PR でそれが動くか、自動で外へ投稿・デプロイするもの、Private の Project や token を前提にするもの |
| コンテナ像と配布物 | Dockerfile・イメージ名・レジストリ・リリースの成果物・単一バイナリの中身（埋め込んだ設定・パス）、ビルドに内部の資源が要るか |
| Issue 番号の参照 | 公開側から読めない Issue / PR / Project / Discussion への参照が、読者を迷わせないか（存在しない参照、非公開の情報を示唆する文脈、他リポジトリの番号） |
| 既定の設定の安全性 | 既定で外へ開くポート・認証の無い経路・危険な既定（承認を飛ばす、自動で許可する）、初回起動で作る資源、サンプル設定の値、`localhost` の前提が崩れる設定 |
| 同期のコミットの本文 | `_gate/commit-message.txt` に Private のコミットの題がそのまま載る。個人情報・内部の名前・秘密・公開側から読めない番号が題に無いか |
| 検査済みでも見る | `public-sync` のホームパスとメールアドレスの検査、`ops-kit scan-issues`（認証に使える値）、依存ライセンスの検査が通っていても、その検査の漏れ（別の形のパス、別のドメインのアドレス、検査の対象外のファイル、バイナリ）を探す |
| 外部への通信 | 画面や文書（HTML）が読み込む外部の資源（フォント・スクリプト・画像の CDN）、起動時や使用中に外へ送る通信（更新の確認・テレメトリ）。読む人の IP が第三者に渡るもの、同梱に替えられるもの |
| 検査の一覧そのもの | 禁止語の一覧・除外の設定・許可リスト・`.gitignore` のような「出してはいけないもの」を列挙したファイルが、その語や名前（ディスク名・Project の番号・別リポジトリの名前・個人の名前）を公開してしまわないか |
| 運用の記録と発言の転載 | 利用者自身の運用の記録（使用時間・時刻入りの経緯・請求や契約の事情）と、非公開の Issue・会話からの発言の逐語の転記。名前や連絡先が無くても、公開してよい意思を確かめる |
| 配布経路の固定 | インストーラー（`curl \| sh`）・Action のタグ・ベースイメージのうち版や検証値で固定していないもの。公開後は読者がそのまま実行する |
| 公開側で自動で動く投稿 | 公開側の workflow が自動で作るもの（タグ・Release・コメント・ラベル・Issue）。読むだけの写しに要るか、Private のものと重ならないか、リンクが Private を指していないか |
| 製品の表示の正確さ | 料金・データの処理場所・安全性を無条件に言う表示（「無料」「ローカル」「送らない」）が、設定や接続先で変わる実際と合っているか |
| 伏せ字の痕跡 | 値や名前を抜いた跡（`, ,`、主語の抜けた文、不自然な空白、`<redacted>`）が残り、抜いたことや抜いた場所を示していないか |
| 隠れた内容 | 双方向の制御文字・ゼロ幅文字、符号化した文字列（base64・16 進）の中身、シンボリックリンクの行き先、画像のチャンク |
| ブラウザに残るデータ | service worker のキャッシュ・localStorage・IndexedDB に、会話・認証の値・利用者のデータを残す処理が無いか |
| 公開側の CI が確かめる範囲 | 公開側に無いもの（録画・秘密の値・私的な資源）に頼るテストを飛ばしたとき、公開側の CI の成功が何を確かめたことになるか。読む人に誤解させないか |
| Actions のログの公開 | 公開側の workflow のログは誰でも読める。ログに出る値（環境・パス・設定の中身・API の応答）。秘密や人の情報が出るならブロッカー |
| ホストの安全姿勢の開示 | 所有者のホストの守り（開いている口・権限・更新の仕組み・弱いと書いた箇所）の説明が、実際のホスト名・ID・エンドポイントと結びついて、その環境を外から狙いやすくするか。結びつけばブロッカー、一般の設計の説明なら Issue で足りる |
| コードに埋め込んだプロンプト | コードや設定に埋め込んだ指示文に、秘密・人の情報・権利の無い第三者の文章・所有者の内部の事情が入っていないか。入っていればブロッカー、言い回しや正確さは Issue で足りる |
| 第三者について公に述べる値 | 第三者（人・会社・サービス）のアカウント・Issue・発言・性能や価格について断定する記述。人の情報や権利に当たればブロッカー、出典や正確さは Issue で足りる |
| 利用者の会話・履歴の取り込みと保管 | 会話や履歴を取り込む機能の説明と、ツリーに実際の取り込み結果（会話・履歴の写し）が残っていないか。写しが残っていればブロッカー、保管の仕方は Issue で足りる |
| 実行可能な成果物の通信 | エージェントが作った HTML・スクリプトを画面で開くとき、外へ通信できるか、アプリの origin や token に届くか（Issue で足りる） |
| 通知による二次開示 | 通知・タイトル・バッジに会話や Task の題が出て、端末の通知の履歴や画面共有で他人に見えるか（Issue で足りる） |
| バックアップの保持と削除 | バックアップ・アーカイブの保持期間と消し方、消したデータがバックアップや復元で戻るか（Issue で足りる） |
| 移行・バックアップの完全性 | migration・書き出し・復元で欠ける・壊れるデータが無いか、失敗したとき元に戻るか（Issue で足りる） |
| 書き出すデータの境界 | 書き出し・共有・成果物の写しに、利用者が意図しないデータ（別の Task・認証の値・パス）が混ざらないか（Issue で足りる） |
| 二次処理と提供者間のデータ共有 | 会話や成果物を評価・判定・要約のために別のランナーや提供者へ送る経路と、その説明があるか（Issue で足りる） |
| 他アプリのデータの不可逆な削除 | 片付け・掃除の処理が、自分のものと確かめずに同じ利用者の他のアプリのファイルを消さないか、確かめられないときに消さないか（Issue で足りる） |
| 利用者側に残る識別子 | 利用者の端末や設定に残す識別子（端末 ID・固定のトークン・追跡に使える値）とその消し方（Issue で足りる） |

### 追記の記録

| 日付 | リポジトリ | 足した観点 |
|---|---|---|
| 2026-10-18 | キットの親のリポジトリ（公開の PBI の決定ログ） | Git で管理するファイルか（利用者の指摘: 値を洗う前に、管理すべきファイルかを判断する） |
| 2026-10-18 | 初回のリポジトリ（公開の PBI の決定ログに振り分け表） | 外部への通信 / 検査の一覧そのもの / 運用の記録と発言の転載 / 配布経路の固定 / 公開側で自動で動く投稿（2 ランナーの「種の外の観点」から） |
| 2026-10-19 | 初回のリポジトリ（公開の PBI の決定ログ、回し直しの 2 回目） | 製品の表示の正確さ / 伏せ字の痕跡 / 隠れた内容 / ブラウザに残るデータ / 公開側の CI が確かめる範囲（2 ランナーの「種の外の観点」から） |
| 2026-10-21 | 初回のリポジトリ（公開の PBI の決定ログ、回し直しの 3〜6 回目） | ブロッカーになりうる: Actions のログの公開 / ホストの安全姿勢の開示 / コードに埋め込んだプロンプト / 第三者について公に述べる値 / 利用者の会話・履歴の取り込みと保管。Issue で足りる: 実行可能な成果物の通信 / 通知による二次開示 / バックアップの保持と削除 / 移行・バックアップの完全性 / 書き出すデータの境界 / 二次処理と提供者間のデータ共有 / 他アプリのデータの不可逆な削除 / 利用者側に残る識別子（2 ランナーの「種の外の観点」から） |

## 指示

`$W/prompt.md` の原文（英語。`cross-runner-review` の prompt と同じ書き方。会話の文脈は渡さない）:

````bash
cat > "$W/prompt.md" <<'PROMPT'
You are checking a repository tree that is about to be published as a public repository. You have no prior context: do
not assume anything about the authors beyond what the files say. Under the current directory, `tree/` is every file that
will be published, exactly as it will appear; `_gate/scope.md` says what else becomes public (issues, pull requests) or
that nothing else does (`_gate/issues.md` holds them when they do); `_gate/commit-message.txt` is the message of the
commit that will carry the tree (it lists private commit subjects); `_gate/seeds.md` lists the viewpoints that must each
be examined. Publishing cannot be undone: a secret, a person's data or an infringing file stays in forks, caches and
search indexes.

Do this:
1. Examine every viewpoint in `_gate/seeds.md` against the whole tree (code, docs, fixtures, workflows, configuration,
   lock files, binaries, images) and against `_gate/commit-message.txt`. Read files; do not stop at file names. What a
   tool already checked may still have slipped through in another form.
2. Then widen beyond the seeds: look for anything else that cannot be taken back once public, or that concerns a third
   party (a person, a company, a service, a licence). Name each extra viewpoint you examined and what you found, even
   when it found nothing.
3. Never write a value itself (a key, a token, an address, a person's name) into your output: give the place
   (`path:line`) and the kind.
4. Do not change any file.

Output exactly this, nothing else:

model: <the model id you are running as>

### Findings
| # | viewpoint | place | severity | fix |
|---|---|---|---|---|
| 1 | <seed or extra viewpoint> | `path:line` | high / medium / low | <what to change, or remove from the public tree, or accept and why> |
(one row per finding; `high` = must not be published as is; one row `| - | none | - | - | - |` when there are none)

### 種の外の観点
- <viewpoint not in the seeds>: <what you looked at and what you found>
(one line per extra viewpoint; if you examined nothing beyond the seeds, write exactly: 種の外は無し)

verdict: pass
(`verdict: fail` instead when at least one finding is high)
PROMPT
````

## 回し方

モデルは利用者の指定（2026-10-17、公開の整理の要望: Claude Code は Fable 5.1、Codex は Astra 6）。CLI の名前は `claude-fable-5-1` と `gpt-6-astra`。変えるのは利用者の指定でこのファイルを直す（設定は足さない）。

2 つは別のディレクトリで同時に回し、片方の出力をもう片方の材料に入れない。ランナーごとの違いはこの 2 行だけ（材料と指示は同じ `_gate/`）:

```bash
rm -f "$W/claude.jsonl" "$W/claude.md" "$W/claude.log" "$W/codex.md" "$W/codex.log" "$W"/*.post.md   # 前の回の出力を残さない（古い報告が形の確認を通る。Codex の sandbox は $W を読めるので、相手の報告も残さない）
( cd "$W/claude" && claude -p --model claude-fable-5-1 --permission-mode plan --output-format stream-json --verbose "$(cat _gate/prompt.md)" ) > "$W/claude.jsonl" 2> "$W/claude.log" & P1=$!
( cd "$W/codex" && codex exec -m gpt-6-astra --sandbox read-only --skip-git-repo-check --ephemeral -o "$W/codex.md" - < _gate/prompt.md ) > "$W/codex.log" 2>&1 & P2=$!
wait $P1; C1=$?; wait $P2; C2=$?; echo "claude exit=$C1 codex exit=$C2"   # 0 でないランナーの出力は使わない（下の利用上限・やり直し）
jq -r 'select(.type=="result") | .result' "$W/claude.jsonl" > "$W/claude.md"
jq -r 'select(.type=="assistant" and .parent_tool_use_id==null) | .message.model' "$W/claude.jsonl" | sort -u   # Claude Code が実行したモデル（本文を書いたターンの model。サブエージェント（parent_tool_use_id あり）は別のモデルで動くので除く。指定の 1 つだけであること）
grep -m1 -E '^model: ' "$W/codex.log"              # Codex が実行したモデル（ログの冒頭の model: の行）
```

- エージェント管理アプリの Task の中から回していて、入れ子の `claude -p` が拒まれたら `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p …` にする（そのランナーの環境変数を外すだけ。ほかは同じ）
- **実行したモデルの確かめ方**: Claude Code は `claude.jsonl` の assistant のメッセージの `message.model`（本文を書いたターンのモデル。`parent_tool_use_id` の無い assistant だけ。`sort -u` が指定の 1 つだけ）。`result` の `modelUsage` は補助のモデルも載り、短い返答は別のモデルに回ることがある（2026-10-18 に `reply ok` が指定と別のモデルで返った）ので、キーだけでは確かめない。Codex はログの冒頭の `model:` の行。報告の 1 行目（`model:`）はランナー自身の申告で、確かめるのは CLI の記録の方
- CLI が名前を受け付けない（`-m` / `--model` がエラー）、または実行したモデルが指定と違うときは、**そのランナーの報告を使わずに止め**、公開の PBI に `## 判断待ち`（`issue-workflow` の「判断待ちの出し方」。ラベル `needs-decision`。選択肢は「そのランナーで選べる別のモデルの名前」と「待つ」、推奨は「待つ」）
- 利用上限で止まったら（出力に上限の文、終了コードが 0 でない）、もう片方で代替せず止まる（停止の報告 `usage-limit`。枠が戻ってから同じ材料で回す）。もう片方の結果は捨てず `$W` に置いたまま
- `### Findings` か `verdict:` が無い出力は、ログ（`claude.log` / `codex.log`）を読んで一度だけやり直す（sandbox で止まった、形式を守らなかった）。それでも無ければ止めて報告する
- **Claude Code の `-p` はバックグラウンドのサブエージェントの戻りを待たずに終わることがある**（初回のリポジトリで 6 回のうち 2 回）。`claude.md`（最後の `result`）が `verdict:` の行で終わっているかを見る。途中で終わっていたら、やり直す前に同じセッションを再開して前景で続けさせる: `S=$(jq -r 'select(.type=="result") | .session_id' "$W/claude.jsonl")`、`( cd "$W/claude" && claude -p --resume "$S" --model claude-fable-5-1 --permission-mode plan --output-format stream-json --verbose "Finish the audits that did not return, in the foreground (no background agents), then output the full report in the format of the original instructions." ) > "$W/claude.jsonl"`。終わったら上の `jq` の 2 行（`claude.md` の作り直しと実行したモデル）と終了コード・形の確認をやり直してから転記する（前の `claude.md` は途中までの報告のまま）。報告の `note:` の行に再開したことを書く
- **ホストのメモリが小さいとき**（4 GB 程度）は 2 ランナーを同時でなく順に回してよい（同時に回すとメモリ不足でサービスごと止まった）。順に回すときは、後の方が走っている間、先に終えた方の出力（`$W/<runner>.*`）を `$W` の外の `mktemp -d` に移しておく（Codex の sandbox は `$W` を読める）。後の方が終わってから戻す

## 報告と振り分け

1. 報告は公開の PBI へのコメント 2 件（ランナーごと）。1 行目 `[public-release-gate] <runner> <model>`（`<runner>` は `claude` / `codex`、`<model>` は CLI の記録から確かめたモデル id）、2 行目に tree の sha、本文は出力のまま。投稿の前に `ops-kit scan-text` に通す（`gh` の前段があればそれも止める。値が出ていたらその行を場所と種類だけに直す）:

   ```bash
   { echo "[public-release-gate] claude claude-fable-5-1"; echo "tree: <tree sha>"; echo; cat "$W/claude.md"; } > "$W/claude.post.md"   # <tree sha> は「入力」で控えた T（Bash の呼び出しをまたぐと変数は消える）
   ops-kit scan-text "$W/claude.post.md" && gh issue comment <公開の PBI> -R <owner/name> --body-file "$W/claude.post.md"
   ```

   Codex も同じ（`codex.md` → `codex.post.md`）。
2. 指摘を 1 件ずつ、まず**公開のブロッカーか**で分ける。ブロッカーは、公開した時点で取り返しがつかないか、公開で害が増えるものだけ:
   1. 秘密・認証の値
   2. 公開すると決めていない人の情報（住まい・アカウント・予定など、人について知られる情報）と、第三者のデータ。所有者の運用の記録や数値（時刻入りの経緯・使用量・回数）はここに入れない
   3. 権利の無い第三者のコンテンツ
   4. 所有者の動いている環境を外から狙いやすくする情報（実際のホスト名・ID・エンドポイント、外から届く穴）

   それ以外（製品のバグ、手元で動かした人に起きる不具合、手元のエージェントからしか届かない穴、文書の正確さ、運用の記録、依存の固定など）は、**ランナーが付けた重さによらず**ブロッカーにしない。ランナーの `high` は「そのまま公開しない」の申告で、この基準ではない。セキュリティの弱さは要望にして残さず直すが、公開の条件にはしない。2 ランナーで同じ指摘は 1 行にまとめ、ランナーの欄に両方を書く:

   | 振り分け | いつ | やること |
   |---|---|---|
   | **直す** | ブロッカーで、公開側に出すものを変える必要がある（値を消す・置き換える・文を直す） | 公開の PBI の下に Task を起こし（`type:task`。この型の中では直さない）、公開の Task の `**前提**:` の行に番号を足す |
   | **公開側から外す** | ブロッカーで、ファイルごと公開側に要らない（Private だけで意味を持つ） | `ops.config.json` の `publicSync.exclude` に足す PR（理由はそのリポジトリの公開の doc の除外の表に 1 行） |
   | **Issue（公開を止めない）** | ブロッカーではないが直したい（バグ・穴・文書の正確さ・運用の記録） | 要望か公開の後の片付けの Task に起こす。公開の Task の `**前提**:` には足さない |
   | **受け入れる** | 指摘が当たらない（置き換え名、雛形の値、公開してよい情報）か、直す必要が無い | 理由を 1 行。**ランナーが `high` と付けた指摘をブロッカーでないと振り分ける（Issue か受け入れる）のは利用者の判断**: Task の会話か公開の PBI の `## 判断待ち` で確かめ（選択肢は「ブロッカーとして直す」「公開を止めない」、推奨を書く）、回答まで合格にしない。ブロッカーに当たりうるのに確かめられないもの（例の値が所有者の実際の設定と同じかどうか）も同じく確かめる |

3. 振り分け表を公開の PBI の決定ログに貼る（日付、tree の sha）:

   ```markdown
   - YYYY-MM-DD: public-release-gate 初回（tree <sha>）。振り分け:
     | # | ランナー | 観点 | 場所 | 振り分け | Task / PR / 理由 |
     |---|---|---|---|---|---|
     | 1 | claude, codex | 個人情報 | `docs/x.md:12` | 直す | #<Task> |
   ```

4. 合格 = 「直す」と「公開側から外す」が全部 Done で、もう一度 dry-run した tree を **新しい `W` で（「入力」から）2 ランナーとも回し直し**（前の回の報告を材料に混ぜない）、ブロッカーが 0 件であること（ランナーの `verdict: fail` は、その `high` を利用者がブロッカーでないと認めれば合格を止めない）。回し直しの報告も 1 と同じ形で公開の PBI に残す。合格したら決定ログに 1 行 `public-release-gate: pass <tree sha>`（回し直した tree の sha）。公開の Task は、**初回の push の前**（push した後にツリーを直すと、直す前のツリーが公開側の履歴の祖先に残る）と Public にする直前の 2 回、公開側へ送る tree（dry-run の `with tree`、push 済みなら公開側の main のツリー）がその sha と同じことを確かめる（違えばツリーが変わっているので回し直す）
5. 2 回目以降のリポジトリも同じ（初回で足した種で回す）。報告の 1 行目の `<model>` が指定と違う報告は合格の根拠にしない

## 観点の追記

報告の `### 種の外の観点` と振り分けで見つかった新しい観点を、「観点の種」の表に足す。足すのは観点の名前と何を見るかだけ（リポジトリ固有の場所・値は書かない。キットは固有の語を持てない）。同時に「追記の記録」に 1 行 `YYYY-MM-DD | <リポジトリ名>（<公開の PBI>） | <足した観点>`。無ければ `追記なし（種の外は無し）` と 1 行。「公開側から外す」の PR と同じ PR か直後の PR で入れ、公開の PBI の決定ログにも足した観点を 1 行。次のリポジトリは追記後の種で回す。

## 報告（利用者への返事の型）

```
public-release-gate <リポジトリ名>（tree <sha 短縮>）: claude <model> <k> 件（high a / medium b / low c、種の外 n）、codex <model> <k'> 件（…）
振り分け: ブロッカー <n>（直す #.. / 公開側から外す PR #..）/ Issue <n>（#..）/ 受け入れる <n>（ブロッカーでないとした high は確認待ち）
合格: <public-release-gate: pass <sha> / まだ（ブロッカーの Task #.. が残り）>
次: <公開の Task / 直す Task>
```

## やらないこと

- 片方の出力をもう片方の材料に入れる。会話の文脈・公開の PBI の議論・自分の判断をランナーに渡す
- 利用上限で片方のランナーを別のランナーで代替する（待つ。`cross-runner-review` の 0 とは違う）
- 報告に値そのもの（鍵・メールアドレス・個人の名前）を書く。ランナーが書いていたら場所と種類だけに直してから転記する
- 「直す」をこの型の中で直す（Task に落とす）。ランナーの `high` を利用者に確かめずにブロッカーでないとする（Issue・受け入れる）
- 指定と違うモデルの報告を合格の根拠にする
- 観点の種を外部ファイルや設定にする（表はこのファイル。追記もこのファイルの差分）
