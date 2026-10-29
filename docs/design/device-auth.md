# device-auth（無人の実行の承認を画面で受ける）

無人の実行の Task が、クラウドの承認（SSO の device code など）を必要としたとき、その URL とコードを Task の画面に出し、利用者が自分のブラウザで承認すると Task が続きを進める（PBI #662）。値は Issue・PR・保存された記録に残らない。

理由: 無人の実行のエージェントが利用者に知らせる手段が Issue だけだと、device code と承認 URL を Issue コメントに書いてしまう（[secret-guard.md](secret-guard.md)）。値を書かない決まりだけでは、承認が要る Task は利用者が対話のセッションで再開するまで止まる。

ランナー自身のログイン（#354、`packages/core/src/runnerlogin.ts`）とは別の経路。あちらはデーモンがランナーのログインのコマンドを動かす。こちらは Task の中でエージェントが動かすコマンドが出すコード。

## 経路

```
エージェント ──(シェル)──> device-auth -- <command>          ops-kit/bin/device-auth（ops-kit/src/device-auth.ts）
                              │  出力から URL とコードを取り出す。エージェントに返す出力からは伏せる
                              │  POST / DELETE  $DEVICE_AUTH_URL（鍵は $DEVICE_AUTH_TOKEN_FILE の中身）
                              v
デーモン   /api/tasks/:id/device-auth                       packages/core/src/deviceauth.ts（メモリの Map とタイマー）
                              │  WS: { type: "task.deviceAuth", taskId, auth | null }（イベントではない）
                              v
画面       Task の画面のカード                              apps/web/src/components/DeviceAuth.tsx
```

| 部品 | 場所 | 役割 |
|---|---|---|
| 補助コマンド | `ops-kit/bin/device-auth [--expires-in <秒>] -- <command...>` | コマンドを子プロセスで動かし、出力を行ごとに読む。URL とコード（`runnerlogin.ts` と同じ規則: URL の外の `XXXX-XXXX(X)`、または URL の `user_code=`）が出たら POST。見つけた値はコマンドが終わるまで出力から `[画面に表示]` に置き換え、`findSecrets` が当たる行も伏せる。コマンドが終われば DELETE してその終了コード、期限なら止めて DELETE して exit 124 |
| 宛先 | `packages/core/src/tasks.ts` の `startSession` | ランナーの環境に `DEVICE_AUTH_URL=http://127.0.0.1:<port>/api/tasks/<id>/device-auth` と `DEVICE_AUTH_TOKEN_FILE=<API の鍵のファイル>` を足す（`StartOptions.env`。`gh` の前段の `PATH` と同じ口） |
| 入れ物 | `packages/core/src/deviceauth.ts` の `DeviceAuths` | Task ごとに 1 件。`https:` でない URL、64 文字を超えるコード、1〜900 秒の外の期限は 400。期限、DELETE、Task の終了（`onTaskEnd`）で消え、画面に `auth: null` を送る |
| API | `GET / POST / DELETE /api/tasks/:id/device-auth` | POST はランナーが動いている Task だけ（終わった Task は 409）。エラーの応答に本文の値を入れない |
| 画面 | `apps/web/src/components/DeviceAuth.tsx` | 「<ホスト> で承認してください」、承認ページのリンク、コードとコピー、残り時間、コマンド。`expiresAt` で自分で消える。取得は running / waiting の Task を開いたときと、WS の再接続のあと |

承認のボタンは置かない。承認は利用者が自分のブラウザで行い、Switchboard はクラウドの資格情報を持たない（README の Design rules「No keys」）。

## まとめてログインする（#2046）

SSO のログイン待ちで止まった Task が複数あるとき、判断待ちの画面のまとまりのカード（[asks.md](asks.md) の「SSO・配備のまとまり」）から 1 回だけログインする。「ログインする」で一番古い Task だけに続きを送り、その Task の `device-auth` のコードを Task の画面と同じ部品（`DeviceAuth.tsx`）でまとまりのカードにも出す。その Task が進んだら、残りの Task には続きだけを送り、ログインは繰り返させない。

前提: ランナーはデーモンと同じ OS ユーザー・同じ環境で動くので、1 つの Task のログインがホストの SSO のキャッシュに残り、その期限までは他の Task も同じキャッシュを使う。アダプタはデーモンの環境をそのまま子に渡し（`childEnv`、[`packages/adapters/claude/src/index.ts`](../../packages/adapters/claude/src/index.ts) と [`codex`](../../packages/adapters/codex/src/index.ts)。外すのは Claude Code の自分の印の変数だけで、`HOME` も `AWS_*` も変えない）、Task の環境に足すのは `startSession` の `StartOptions.env`（`DEVICE_AUTH_URL` など）だけ。ランナーが `HOME` や `AWS_*` を Task ごとに変える構成（別のユーザー・コンテナ）では、この前提は成り立たず、残りの Task は自分でもう一度止まる（まとまりに戻るので、もう一度押せる）。Switchboard は AWS の認証情報を持たず、代わりにログインもしない。

## 値が残らない理由

- **エージェントは値を見ない**: コマンドの出力は `device-auth` が伏せてから返す。エージェントの会話・ツールの結果（DB のイベント）・Issue に書く文のどれにも、値が入る元が無い
- **DB に入れない**: デーモンはメモリだけに持つ。テーブルも migration も無い。再起動で消えてよい（コードは 10〜15 分で失効する）
- **WS のメッセージは保存されない**: `task.deviceAuth` はイベントではないので `events` に入らず、`task.updated` にも載らない。画面も `localStorage` や Service Worker に入れない
- **鍵を増やさない**: Task ごとのトークンは作らない。ランナーはデーモンと同じユーザーで API の鍵のファイルを既に読めるので、渡すのはファイルの場所だけ

## 期限

- 既定 600 秒。CLI が別の期限を示すときだけ `--expires-in`（1〜900）。期限はコマンドの出力からは読まない（形が CLI ごとに違う）
- 期限はコマンドの起動から数え、POST の `expiresInSec` は残りの秒数（画面の残り時間と `device-auth` の期限がそろう）
- 期限・中断・引き渡しの失敗では、コマンドとそれが起動した子孫（`pgrep -P`）を止める（#992）
- URL だけが出てコードが 1 秒来なければ URL だけで送る（ページが自分でコードを出す流れ）。後からコードが来たら、コードつきで送り直す

## 止めないもの

- **`device-auth` を使わずにコマンドを直接動かした場合**: 値はエージェントの出力に入る。そこから Issue・PR に書こうとすると `gh` の前段が止め、既に書かれたものは `scan-issues` が見つける（[secret-guard.md](secret-guard.md)）。決まりは共通スキル `issue-workflow` の「Issue・PR・コメントに書かない値」
- **偽の URL を画面に出せること**: URL はエージェントが動かしたコマンドが出したもの。デーモンは `https:` だけを受けるが、行き先は選べない。そのためカードはホスト名を見出しにし、元のコマンドも出す。利用者は、知っているログインのページかどうかで承認を判断する
- **送り先がループバックかどうか**: `device-auth` は `DEVICE_AUTH_URL` の宛先へ、コードとデーモンの鍵（`DEVICE_AUTH_TOKEN_FILE` の中身）を送る。宛先がループバックかは確かめない。値を渡すのはデーモンで（自分のループバックのアドレス）、書き換えられるのは同じ OS ユーザーの Task だけ。その Task は鍵のファイルも直接読めるので、確かめても守れるものが増えない（CLAUDE.md の「前提」のループバックの信頼）。デーモンが昇格のときに鍵を付けて呼ぶ sb-rescue の宛先（`SWITCHBOARD_RESCUE_URL`）も同じで、sb-rescue がデーモンを起動するときに渡す
- **`DEVICE_AUTH_URL` が無い場合**（Switchboard の外で動かした、デーモンが古い）: `device-auth` はコマンドを動かさずに exit 2。エージェントは値を出さずに Task の会話で聞いて止める

## 確かめ方

`packages/core/src/deviceauth.e2e.test.ts`: 偽ランナーが `device-auth` で偽のログインを動かし、画面（API と WS）に値が来ること、承認で Task が進み `gh` に終了コードだけが届くこと、期限で `auth: null` と exit 124、DB の全テーブルと他の WS メッセージに値が無いことを確かめる。単体は `deviceauth.test.ts`（デーモン）、`ops-kit/src/device-auth.test.ts`（補助コマンド）、`apps/web/src/deviceAuth.test.ts`（画面）。
