# Actions が始まらないときの local-ci 相当検証

通常は `bun scripts/local-ci.ts <PR>` を実行する。Actions がステップ0件で失敗した場合に、CI の全工程をローカルで実行する入口である。マージ判定の手順と印は [docs/merge-gate.md](../merge-gate.md)、性能検査は [perf.md](perf.md) を参照する。

別のリポジトリの PR は `bun <Switchboard の clone>/scripts/local-ci.ts <PR> --repo <owner/name>` を、そのリポジトリの作業ツリーから実行する（#1203）。head と base の読み取り・取得・worktree・結果の投稿はすべてそのリポジトリ（実行した作業ツリーの root の clone と、その PR）に対して行い、手順はその clone の `.github/workflows/ci.yml` の `run:` から読む（そのリポジトリに `scripts/ci.ts` は無いので、`run:` がそのまま手順。下の「手順」）。`--repo` が `owner/name` の形でない、実行した場所が git の作業ツリーでない、作業ツリーの `origin` が `--repo` と違うときは、何も投稿せず理由を出して exit 2。`--repo` を付けなければ、スクリプトのある clone とその origin のリポジトリを使う（`GH_REPO` は見ない。origin が無い・GitHub の owner/name として読めなければ何も投稿せず exit 2）。印は `bun scripts/merge-gate.ts <PR> --repo <owner/name>` が数える。

## 対象と環境

- main の作業ツリーでは実行しない。対象リポジトリの専用 worktree から実行する。
- 検証対象は、PR の最新の head を base の枝の最新の先端にマージした内容である（#913）。`gh pr view` の `headRefOid` と `baseRefName` を読み、`refs/heads/<base>` と `refs/pull/<PR>/head`（GitHub がすべての PR に置く。fork の PR も）を fetch し、後者が `headRefOid` と一致することを確かめる（push の直後で違えば、何も実行せず少し待ってやり直す）。worktree を base で作り、その中で head を `--no-ff` でマージする。GitHub の `pull/<PR>/merge` は使わない（無い・古いときも検証できる）。マージの名前と署名は local-ci が固定する（`-c user.name/user.email`、`commit.gpgSign=false`。clone の設定に左右されない）。マージが衝突した（未解決のパスが残った）ら手順は実行せず、失敗の結果として通知する。衝突以外のマージの失敗はエラーで、何も投稿しない。
- `localCi` は使い捨て worktree を `~/.cache` に、TMPDIR を OS の一時ディレクトリ（`tmpdir()`。このホストでは RAM の `/tmp`）に作り、PATH / HOME / CI=true / TMPDIR だけの環境で実行する。デーモンの SWITCHBOARD_*、実認証の値、実 Cloud セッションを持ち込まない。例外は呼び出し元が明示した録画の置き場所 `SWITCHBOARD_FIXTURES` で、その値だけを引き継ぎ、不足していれば再生のテストが落ちる。未指定なら渡さず、録画が無いテストは skip として数える。Actions・公開 clone / fork でも同じで、録画を必須にはしない。既存の録画は配布しないため、再生を検証するときは [.claude/skills/runner-adapter-recording/SKILL.md](../../.claude/skills/runner-adapter-recording/SKILL.md) に従って自分のランナーで Git の外に録画し、`SWITCHBOARD_FIXTURES=<録画のディレクトリ> bun scripts/local-ci.ts <PR>` と実行する。
- Chrome と Noto フォントを使用する。性能測定は5回で、他の性能測定と並行しない。
- CI の全工程を実行する。パス検査、frozen install、ライセンス、型検査、全体テスト、Web build、main fetch、フォント、性能測定、性能判定を省略しない。工程の一覧は固定で複製せず、worktree の中のものを読む（下の「手順」）。

## 手順（Actions と同じもの、#912）

手順の正本は `scripts/ci.ts` の `ciSteps`（名前と `bash -e -c` で走らせるスクリプトの列）。Actions の `ci.yml` は checkout と setup-bun の後に `run: bun scripts/ci.ts` を 1 つだけ持ち、`scripts/ci.ts` が `ciSteps` を順に走らせて、最初に落ちた手順の exit で終わる（環境は runner のまま。`GITHUB_ACTIONS` が perf-ratchet の上限 `github` を選ぶ）。local-ci は worktree の `ci.yml` の `run:` を読み（`workflowSteps`）、`bun scripts/ci.ts` の手順をその worktree の `scripts/ci.ts` の `ciSteps` に展開して（`checkoutSteps`。PR のコードなので local-ci のプロセスには import せず、worktree で `bun scripts/ci.ts --list` を手順と同じ環境で走らせて JSON で受け取る）1 つずつ上の環境で走らせる。手順を回して最初の失敗で止める部分（`runCi`）と exit（`ciExit`: どれかが落ちたら 1、全部通れば 0。落ちた手順自身の code は `✗ <手順>: exit <code>` の行。tsc の 2 が local-ci の「何も実行しなかった」の 2 と紛れないよう、手順の code をそのまま exit にしない）は両方で同じ。PR が手順を変えれば、その PR の手順が回る。`scripts/ci.ts` の無いリポジトリ（`--repo`）は `ci.yml` の `run:` がそのまま手順。

## 結果の通知（#913）

Actions の run があってもなくても、結果は PR に forge の `verification`（GitHub では PR コメント。`reportResult`）として投稿する。1 行目が印で、そのあとに対象（head と base の 40 桁）と、走った手順ごとの結果の表が続く:

| 結果 | 1 行目 | 本文 |
|---|---|---|
| 全手順が合格 | `[local-ci] pass <head sha> base=<base sha>` | 2 行目にスタックの行 `stack #<n>=<patch-id> …`（スタックの一番下からこの PR まで、各 PR の `gh pr diff \| git patch-id --verbatim`。今の head がテストした head に入っていない下の PR（修正を上へ rebase していない）は、それより下と一緒に外す。`LOCAL_CI_STACK` / `stackOf`。GitHub の PR だけ。読めなければ行を付けずに投稿する）、手順の表 |
| 手順が落ちた | `[local-ci] fail <head sha> base=<base sha>` | 落ちた手順と exit、その全文から拾った `(fail)` / `over:` の行（最大 20 行）、手順の表。全文は実行したホストの記録（パスは書かない） |
| head が base にマージできない | `[local-ci] fail <head sha> base=<base sha>` | 衝突。手順は実行していない |

投稿の直前に head と base を同じ方法で読み直し（`notify`）、どちらかが実行中に変わっていたら何も投稿せず exit 1（テストしていない head や base の結果を書かない。回し直す）。投稿した後に base が進んだこと、下の PR のマージ後の自動 rebase で head が変わったことでは回し直さない（差分が同じなら 2 行目の patch-id で数えられる。いつ回し、merge-gate がどう数えるかは [docs/merge-gate.md](../merge-gate.md) の「ローカル CI を回す時と数え方」）。読み直せなかったときも投稿しない。投稿する文はキットの認証の値の検査（`runForgeOperation`）を通る。投稿が認証・権限で失敗したら、理由を出して exit 1 で止まる（別の経路で投稿しない。Task なら会話で確認する）。結果の印の読み方は `LOCAL_CI_RESULT`（pass か fail、head、続けて `base=`。マージ判定での扱いは [docs/merge-gate.md](../merge-gate.md)）。

### タグの CI

マージ後の main に付いたタグの CI（`bun scripts/tag-ci.ts [--repo <owner/name>]`）は、この文書の手順を同じ環境で回す（worktree で手順を回して失敗の全文を `~/.cache` に残す部分 `runCheckout` を `localCi` と共有する。対象は PR のマージではなく、タグのコミットそのもの）。印は PR の `[local-ci]` ではなく、そのタグの GitHub Release の本文の `[tag-ci] pass|fail <sha>`。最新のタグから回し、落ちたら遡る規則と読み方は [releases-and-rescue.md](releases-and-rescue.md) の「Tag CI」。

## 全文と測定値を残す実行手順

落ちた工程は `local-ci.ts` が全文を `~/.cache/switchboard.local-ci-<owner>_<name>-<PR>-log.*` に残し、`(fail)` と `over:` の行・最後の 30 行・そのパスを出す（#1232。通った工程は残さない。同じ PR の前の失敗のディレクトリは次の失敗で消え、PR ごとに最新 1 件）。

性能の工程（`perf-bench.ts` / `perf-ratchet.ts check`）が落ちたときは、同じディレクトリに `perf-result.json`（あれば）と `summary.md` も残し、`summary.md` と同じ文を出す（#1056、#1184）。`summary.md` の形:

```
head <head sha> / base <base sha>          ← base = 実行を始めたときの base の枝の先端（その時点の main）
手順 <工程>: exit <code>
環境: ceilings <local|github|?>, TMPDIR <dir>, CI=true
超過（over）:                               ← check が出した行をそのまま。種類ごとに、ある種類だけ
改善による予算更新要求（improved）:
main より予算引上げ（raised）:
原因不明（判定の行が無い）:                  ← 3 種類のどれも無いとき（perf-bench の失敗を含む）。出力の最後の 10 行が続く
main（<base7>）との比較:                    ← over があるときだけ（下）
<key>: main でも超過（PR の変更によらない） | <key>: PR 固有の悪化   ← PR の over のキーごと
main の計測に失敗（原因不明）                 ← main の install / build / bench が落ちたとき（キーごとの行の代わり）
main の over:                               ← main の over の行をそのまま
```

check が `over` を出したときだけ、base（実行を始めたときの base の枝の先端 = その時点の main）を別の worktree に出し、同じ環境（`TMPDIR` も同じ）で PR の手順の `bun install --frozen-lockfile` と `bun run --cwd apps/web build` から check までの手順（`perfSteps`）を回して比べる（#1191）。記録は同じディレクトリの `perf-result.base.json` と `base-<n>-<手順>.log`。`improved` / `raised` / 原因不明だけなら main は測らない。`over` のときはローカル CI が 3〜5 分伸びる。

どの判定でも失敗のままで、PR には合格印の無い失敗の結果を投稿する（下の「結果の通知」）。長い JSON（check の後の `cat perf-result.json`）で判定の行が押し出されることはない。

以下は、通った工程の全文や `perf-result.json` も要るとき（#1083）の手順で、同じ `localCi` エンジン・環境・コマンドを使用し、各工程の全文と測定値を cleanup 前に保存する。工程の成否や判定規則は変更せず、PR への合格印も自動投稿しない。

専用 worktree で、`PR` に対象番号を指定して実行する。

```bash
PR=1116
CI_EVIDENCE=$(mktemp -d /tmp/switchboard.ci-evidence.XXXXXX)
cat > "$CI_EVIDENCE/run.ts" <<'TS'
import { existsSync } from "node:fs";
import { join } from "node:path";
const [prArg, root, evidence] = process.argv.slice(2);
const { localCi, remoteRepo } = await import(join(root, "scripts/local-ci.ts"));
let sequence = 0;
const sh = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (exit ${code})`);
  return out;
};
const step = async (script: string, cwd: string, env: Record<string, string>) => {
  const p = Bun.spawn(["bash", "-e", "-c", script], {
    cwd, env, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  const output = out + err;
  await Bun.write(join(evidence, `step-${++sequence}.log`), output);
  // local-ci measures main in a second worktree (`-base.`) when perf is over: keep the two results apart
  if (existsSync(join(cwd, "perf-result.json"))) {
    const name = cwd.includes("-base.") ? "perf-result.base.json" : "perf-result.json";
    await Bun.write(join(evidence, name), Bun.file(join(cwd, "perf-result.json")));
  }
  return { code, output };
};
// the PR's repository is this worktree's origin, as local-ci.ts without --repo (GH_REPO is not read)
const repo = remoteRepo(await sh(["git", "-C", root, "remote", "get-url", "origin"]));
if (!repo) throw new Error("origin is not a GitHub owner/name");
const result = await localCi(Number(prArg), root, { sh, step, log: () => {} }, repo);
await Bun.write(join(evidence, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ sha: result.sha, ok: result.ok, steps: result.results.length }));
process.exitCode = result.ok ? 0 : 1;
TS
bun "$CI_EVIDENCE/run.ts" "$PR" "$PWD" "$CI_EVIDENCE"
```

exit 0 は全工程合格、exit 1 は不合格である（この手順は PR に投稿しない）。失敗した実行に `[local-ci] pass` を付けない。ログを公開する前に読み、認証値・実 Cloud セッション参照・個人情報を含む生の出力を貼らない。

## 性能検査だけが不合格の場合の代替記録

同じ失敗の再実行を繰り返さず、記録のディレクトリの `summary.md` と `perf-result.json`（上の「全文と測定値を残す実行手順」）を読む。通常工程が1件でも不合格、性能測定そのものが失敗、結果や対象 SHA が不明なら、相当検証済みにはしない。

`over` のときは `summary.md` の「main との比較」がキーごとに「main でも超過」「PR 固有の悪化」「main の計測に失敗（原因不明）」を言う（local-ci が同じ環境で main を測る。上）。main でも超えるなら main の SHA と外れた指標を既存 Issue に記録する。main が赤であるだけで、PR の新しい悪化を認めることにはならない（「PR 固有の悪化」のキーは個別に調べる）。

上限を上げた PR は、測定値が新上限内でも `raisedAgainst` により意図的に exit 1 になる。利用者の上限調整の許可と、変更項目・実測値・main の上限を記録する。上限を上げただけで CI 合格と記載しない。

利用者が相当検証での代替を指示した場合、PR に次を記録する。

- 対象 head SHA、実行した全工程と成否。
- 不合格の指標・値・上限、`summary.md` の判定（main でも超過 / PR 固有の悪化 / 原因不明）、既知 Issue。
- 代替を認めた利用者指示と、その対象範囲。
- 「local-ci 相当検証済み（性能例外あり）」という事実。通常の `[local-ci] pass` と区別する。

これは自動マージ判定を変更する印ではない。利用者が認めた代替の範囲で手動判断する。セキュリティ等のマージ確認、未解決レビュー、競合、実機確認は別に満たす。相当検証での代替を未確認の実機結果に広げない。

この記録は印ではないので patch-id では数えない。修正・下位 PR のマージで head が変わったら、旧 SHA の検証を新 SHA に付け替えず、新 head の全工程を実行し直す。通信等の再試行はその作業の停止・再試行指示に従い、上記手順に自動再試行ループは設けない。

## 型検査（tsc と bun check）

`bun run typecheck` が 9 つのパッケージで走らせる `tsc --noEmit -p tsconfig.json` を `bun check` に置き換えられるかを、同じ tsconfig で比べた（#1572、#1577）。2026-10-22、Bun 1.4.3、TypeScript 5.9.3、ホストは 2 コア・3.8 GB。

| パッケージ | main のまま（tsc / bun check） | 誤り 1 行（tsc / bun check） | 誤りを入れたファイル | エラーの一致 | 判定 |
|---|---|---|---|---|---|
| packages/protocol | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/adapter.ts` | 同じ | 置き換える |
| packages/adapters/claude | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/cloud.ts` | 同じ | 置き換える |
| packages/adapters/codex | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/generated/AbsolutePathBuf.ts`（当時は Git にあった。今は typecheck が入っている Codex から生成する） | 同じ | 置き換える |
| packages/adapters/dak | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/artifacts.ts` | 同じ | 置き換える |
| packages/core | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/accesslog.ts` | 同じ | 置き換える |
| apps/web | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/App.tsx`（と除外したテストのファイル） | 同じ | 置き換える |
| rescue | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/agent.ts` | 同じ | 置き換える |
| aws | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `starter.ts` | 同じ | 置き換える |
| ops-kit | 0 件 / 0 件 | exit 2・1 件 / exit 1・1 件 | `src/backlog-client.ts` | 同じ | 置き換える |

- main のままは両方とも exit 0。誤りは各パッケージの tsconfig の対象の 1 ファイルの末尾に `export const __typeErr: number = "s";` を足した。エラーの行（`<file>(<line>,<col>): error TS2322: …`）は全パッケージで 1 文字まで同じ
- 違うのは終了コードだけ（tsc は 2、`bun check` は 1）。どちらも 0 以外なので `bun run typecheck` と CI の成否は変わらない
- apps/web の tsconfig の `exclude`（`src/**/*.test.ts`）: テストのファイル（`bun:test` を使う）にも同じ誤りを入れたが、両方ともそれを数えず、`src/App.tsx` の 1 件だけを出した。`bun check` も `exclude` に従う
- 差の残ったパッケージは無いので、9 つとも置き換える。TypeScript の依存はエディタのために残す

使ったコマンド（各パッケージのディレクトリで）:

```bash
../../node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false   # 深さは場所に合わせる
bun check -p tsconfig.json --no-pretty --all
```

`bun check` は `-p` で tsconfig を指定し、誤りがあれば exit 1 で `<file>(<line>,<col>): error TS…` の行を出す（パイプの先では `--no-pretty` が既定。端末ではまわりのコードも出す）。`--all` は同じエラーが 50 件を超えてもまとめない。

### 置き換えの前後（#1578）

9 つのパッケージの `package.json` の `scripts.typecheck` を `bun check -p tsconfig.json` にした（root の `bun run typecheck` と CI の型検査の段はそのまま。CI の Bun は `setup-bun` の `latest`）。`/usr/bin/time -v bun run typecheck` を前後で 3 回ずつ（2026-10-22、空きメモリ 2 GB 前後で、ほかの重い処理と重ねずに）:

| | 所要時間（3 回） | 中央値 | 最大メモリ（3 回） | 中央値 |
|---|---|---|---|---|
| 前（tsc） | 88.9 / 77.3 / 75.0 s | 77.3 s | 734 / 744 / 789 MB | 744 MB |
| 後（bun check） | 9.3 / 8.6 / 9.7 s | 9.3 s | 216 / 213 / 213 MB | 213 MB |

型の誤りを 1 行入れたパッケージごとに、`bun run typecheck` は exit 1 で止まり、そのファイルと行を出す（9 パッケージとも確かめた。戻すと exit 0）。出力の形は環境で変わる: CI と local-ci の環境（`CI=true`、エージェントの変数なし）とパイプの先では tsc と同じ `<file>(<line>,<col>): error TS…` の 1 行、端末ではまわりのコードつき、エージェント（`CLAUDECODE` などがある）の中では `<error file="…" line="…" column="…" code="TS…">`。どれもファイルと行を出す。
