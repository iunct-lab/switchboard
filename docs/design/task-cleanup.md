# Task が切り離したプロセスの片付け（#1397）

Task が `setsid` / `nohup` で切り離して起こしたプロセス（テスト、dev サーバ、docker の CLI など）は、ランナーのプロセスの木からもプロセスグループからも外れる。Task が終わっても残り、ホストのメモリを使い続ける（#649）。

## 印

デーモンはランナーを起こすとき、環境に `SWITCHBOARD_TASK_ID=<task id>` を常に足す（`packages/core/src/tasks.ts`）。`setsid` も `nohup` も環境を受け継ぐので、切り離されたプロセスにも印が残る。併せて `SWITCHBOARD_DAEMON_HOME=<このデーモンの home>` も足し、別のデーモン（DB のコピーで起こした E2E など）の Task の印は止めない。印は `/proc/<pid>/environ` で読む。

## 止める契機

| 契機 | 対象 |
|---|---|
| Task の終わり（`onTaskEnd`: 終端の status でランナーのプロセスも無い。`resumeAt` があれば止めない） | その Task の印を持つプロセス |
| デーモンの起動時（1 回） | 終端の status（done / error / aborted）で `resumeAt` が無い Task の印を持つプロセス |

止めた件数は Task の記録に status の行として 1 行残る。定期の走査はしない（残骸ができるのは Task の終わりと、デーモンが止まっている間だけ）。

## 止め方

SIGTERM → 最大 2 秒待つ → 残ったものに SIGKILL（`packages/core/src/detached.ts`）。

## 止めないもの

- 別の Task の印を持つもの、印を持たないもの（利用者のターミナルタブ、ホストのシェル、`env -i` で環境を消したもの）
- デーモン自身とその祖先（sb-rescue、`scripts/dev.ts`）と、デーモンと同じセッションのプロセス（Task の中から起こされたデーモンが、環境の印を引き継いでいても外す）
- 続きの予定がある Task（`resumeAt` あり）と、終わっていない Task
- DB に無い Task ID の印

## 範囲

- Linux だけ（`/proc` が無ければ何も見つからず、何もしない）
- ランナーのプロセスグループの kill（setsid していない子孫）は #1136。こちらは setsid で抜けたものだけを印で追う
- docker のコンテナは dockerd の子で、Task のプロセスではない。印では追えない。下の「コンテナ」で別に扱う

## コンテナ（#1398）

`docker compose up -d` や `docker run -d` のコンテナは dockerd の子で、上の印では止まらない。Task が終わったら、その Task が起こしたものを止めて消す。

- **記録（共通キットの `ops-kit/bin/docker`、PATH の先頭）**: 環境に `DOCKER_MARK_LABEL=switchboard.task=<task id>` があれば、`docker run` / `create`（`container run` / `create` も）にその label を足す。`DOCKER_MARK_LABEL` と `DOCKER_MARK_LOG` の両方があれば、`compose up|run|create|start` が成功したときに、`compose config --format json` の `name` を `{"project","cwd","globals"}`（`globals` は `-f` などの compose 自身のオプション）の 1 行で足す。標準入力で渡した設定（`-f -`）は読み直せないので記録できず、標準エラーに 1 行出す。キットに固有語は置けないので、名前と値はデーモン（`tasks.ts` の `dockerEnv`）が渡す。ログは `<home>/docker/<task id>.jsonl`
- **片付け（`packages/core/src/containers.ts`）**: 止める契機は上の表の Task の終わり（`onTaskEnd`、`resumeAt` があれば止めない）。ログの各プロジェクトに `docker compose <globals> -p <name> down --remove-orphans`（cwd はログの `cwd`）、`label=switchboard.task=<id>` のコンテナに `docker rm -f`。最後にログを消す。docker の CLI を通すので、`DOCKER_HOST` とホストの dockerd の起動（`aws/host/docker.sh`）はそのまま使われる。Engine API は叩かない
- **消さないもの**: ボリューム・イメージ（`-v` / `--rmi` を付けない）、まだ終わっていない別の Task のログにも同じプロジェクトがあるときのそのプロジェクト、Task の外で起こしたコンテナ（label もログも無い）
- **docker が無い・dockerd が応答しない**: 片付けを飛ばし、Task の記録に「コンテナの片付けを飛ばしました（理由）」の 1 行。ログは残し、Task の終わりの処理は止めない。使っていない Task（ログも docker も無い）は何も書かない
- 記録は Task の status の行 1 行（「コンテナを片付けました（プロジェクト n 件、コンテナ m 件）」。down や rm が失敗したぶんは「、失敗 k 件」を足す。何も片付かず全部失敗したときは「コンテナの片付けを飛ばしました（片付けが k 件失敗しました）」）

### 実構成での確認（2026-10-15）

クラウドホストの rootless dockerd に向け、偽ランナーのデーモン（`mktemp -d` の `boot.ts`、ポート 47931）の Task から前段 `ops-kit/bin/docker` を通して起こし、Task を中断した:

| 起こし方 | 中断の前 | 中断の後（`docker ps -a --filter …`） | Task の記録 |
|---|---|---|---|
| `docker compose -f compose.yaml up -d`（busybox `sleep 300`、プロジェクト名 `sbcleanup…`） | `com.docker.compose.project=<name>` に 1 件 Up | 11 秒以内に空（ネットワークも消えた） | コンテナを片付けました（プロジェクト 1 件、コンテナ 0 件） |
| `docker run -d busybox sleep 300` | `label=switchboard.task=<id>` に 1 件 Up | 2 秒以内に空 | コンテナを片付けました（プロジェクト 0 件、コンテナ 1 件） |

イメージ（busybox）は残した。
