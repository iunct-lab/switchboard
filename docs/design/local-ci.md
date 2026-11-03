# Actions が始まらないときの local-ci 相当検証

通常は `bun scripts/local-ci.ts <PR>` を実行する（`--all` runs every test）。Actions がステップ0件で失敗した場合に、CI の全工程をローカルで実行する入口である。マージ判定の手順と印は [docs/merge-gate.md](../merge-gate.md)、性能検査は [perf.md](perf.md) を参照する。

別のリポジトリの PR は `bun <Switchboard の clone>/scripts/local-ci.ts <PR> --repo <owner/name>` を、そのリポジトリの作業ツリーから実行する（#1203）。head と base の読み取り・取得・worktree・結果の投稿はすべてそのリポジトリ（実行した作業ツリーの root の clone と、その PR）に対して行い、手順はその clone の `.github/workflows/ci.yml` の `run:` から読む（そのリポジトリに `scripts/ci.ts` は無いので、`run:` がそのまま手順。下の「手順」）。`--repo` が `owner/name` の形でない、実行した場所が git の作業ツリーでない、作業ツリーの `origin` が `--repo` と違うときは、何も投稿せず理由を出して exit 2。`--repo` を付けなければ、スクリプトのある clone とその origin のリポジトリを使う（`GH_REPO` は見ない。origin が無い・GitHub の owner/name として読めなければ何も投稿せず exit 2）。印は `bun scripts/merge-gate.ts <PR> --repo <owner/name>` が数える。

## 対象と環境

- main の作業ツリーでは実行しない。対象リポジトリの専用 worktree から実行する。
- 検証対象は、PR の最新の head を base の枝の最新の先端にマージした内容である（#913）。`gh pr view` の `headRefOid` と `baseRefName` を読み、`refs/heads/<base>` と `refs/pull/<PR>/head`（GitHub がすべての PR に置く。fork の PR も）を fetch し、後者が `headRefOid` と一致することを確かめる（push の直後で違えば、何も実行せず少し待ってやり直す）。worktree を base で作り、その中で head を `--no-ff` でマージする。GitHub の `pull/<PR>/merge` は使わない（無い・古いときも検証できる）。マージの名前と署名は local-ci が固定する（`-c user.name/user.email`、`commit.gpgSign=false`。clone の設定に左右されない）。マージが衝突した（未解決のパスが残った）ら手順は実行せず、失敗の結果として通知する。衝突以外のマージの失敗はエラーで、何も投稿しない。
- `localCi` は使い捨て worktree を `~/.cache` に、TMPDIR を OS の一時ディレクトリ（`tmpdir()`。このホストでは RAM の `/tmp`）に作り、PATH / HOME / CI=true / TMPDIR だけの環境で実行する。デーモンの SWITCHBOARD_*、実認証の値、実 Cloud セッションを持ち込まない。例外は呼び出し元が明示した録画の置き場所 `SWITCHBOARD_FIXTURES` で、その値だけを引き継ぎ、不足していれば再生のテストが落ちる。未指定なら渡さず、録画が無いテストは skip として数える。Actions・公開 clone / fork でも同じで、録画を必須にはしない。既存の録画は配布しないため、再生を検証するときは [.claude/skills/runner-adapter-recording/SKILL.md](../../.claude/skills/runner-adapter-recording/SKILL.md) に従って自分のランナーで Git の外に録画し、`SWITCHBOARD_FIXTURES=<録画のディレクトリ> bun scripts/local-ci.ts <PR>` と実行する。
- 1 回の実行全体（head と base の読み取りから、性能の上限を超えたときの base の計測、worktree の片づけまで）で、重い処理の枠（`ops-kit heavy` と同じ `withHeavySlot`。上限と空きメモリの下限はマシンの設定 `~/.config/ops-kit/heavy.json`。`ops-kit --help` の heavy）を 1 つ取ってから始める。枠が空くまで待つあいだは、待っている理由の行を出す。`--repo` で別のリポジトリの PR を回すときも同じマシンの枠を取る。
- Chrome と Noto フォントを使用する。性能測定は5回で、他の性能測定と並行しない。
- CI の全工程を実行する。パス検査、frozen install、ライセンス、型検査、Web build、main fetch、フォント、性能測定、性能判定、テストを省略しない。By default `bun test` runs the affected tests only (see "Narrowing `bun test`" below).工程の一覧は固定で複製せず、worktree の中のものを読む（下の「手順」）。
- pass の印は、2 行目に型検査と bun test の所要秒を `<!-- local-ci-seconds {"typecheck":51.2,"test":43} -->` の 1 行で持つ（#1886。`LOCAL_CI_SECONDS` / `markerSeconds`。GitHub の表示には出ない。秒は手順の表と同じ計測で、名前が `bun run typecheck` / `bun test` の手順のもの（絞った `bun test` は `run` が変わるので名前で引く）。`scripts/ci.ts` を持つ checkout（このリポジトリ）でどちらかの手順が無ければエラーで止まり、`scripts/ci.ts` の無いリポジトリ（`--repo`）では行を付けない）。比べるのは perf-ratchet（[perf.md](perf.md)）。
- A result says what ran in its `テスト:` line and carries a machine line, `<!-- local-ci-tests {"ran":<number or null>,"total":<number>} -->` (`LOCAL_CI_TESTS` / `testsOf`). `ran` other than null means a narrowed run: do not read that run's `local-ci-seconds` `test` as the seconds of all tests, and it is not compared with the `test` ceiling below. A `--all` run has no total, so it has no such line.
- After every step passed, those two seconds are compared with the `local.durations` ceilings of the worktree's `scripts/perf-budget.json` (`judgeDurations` in `scripts/perf-ratchet.ts`, see [perf.md](perf.md)). A value over its ceiling fails the run: the comment names the check as a step of its own, with its `over:` line, and there is no pass mark. A checkout without that file or those ceilings is not compared.

## Reusing a pass

Before anything else, a run reads this PR's own comments. When the newest result there is a pass of the current head and `localCiOf`, with this PR as its own top, counts it (the pass is of this head, so its commits are the PR's as they are), the run prints `既に pass（<URL>）` and exits 0: no worktree, no fetch, no post. Anything else runs as usual. This check does not look at PRs above this one; which result merge-gate takes in a stack is in [docs/merge-gate.md](../merge-gate.md). `--force` runs regardless, and so does `--all`, because a narrowed pass is not what it asks for. An unreadable comment list means a normal run, and GitLab MRs always run.

## Narrowing `bun test`

- What changed since HEAD's fork from the default branch (a rename counts as both paths) goes to the worktree's `scripts/test-select.ts`, and only the files it selects run, as `bun test ./<path>`. A stacked PR's base is the branch below it, so a diff from that base would leave out the PRs below; from the fork it is the sum of every PR in the stack.
- A change it cannot judge, a selection that does not run or cannot be read, and `--all` run every test. Only local-ci narrows: the tag CI runs every test.
- Why a selection failed goes to local-ci's log, not to the result comment: the text holds host paths.

## 手順（Actions と同じもの、#912）

手順の正本は `scripts/ci.ts` の `ciSteps`（名前と `bash -e -c` で走らせるスクリプトの列）。Actions の `ci.yml` は checkout と setup-bun の後に `run: bun scripts/ci.ts` を 1 つだけ持ち、`scripts/ci.ts` が `ciSteps` を順に走らせて、最初に落ちた手順（`keepGoing` の手順を除く。下）で止まる（環境は runner のまま。`GITHUB_ACTIONS` が perf-ratchet の上限 `github` を選ぶ）。local-ci は worktree の `ci.yml` の `run:` を読み（`workflowSteps`）、`bun scripts/ci.ts` の手順をその worktree の `scripts/ci.ts` の `ciSteps` に展開して（`checkoutSteps`。PR のコードなので local-ci のプロセスには import せず、worktree で `bun scripts/ci.ts --list` を手順と同じ環境で走らせて JSON で受け取る）1 つずつ上の環境で走らせる。手順を回して最初の失敗（`keepGoing` の手順を除く）で止める部分（`runCi`）と exit（`ciExit`: どれかが落ちたら 1、全部通れば 0。落ちた手順自身の code は `✗ <手順>: exit <code>` の行。tsc の 2 が local-ci の「何も実行しなかった」の 2 と紛れないよう、手順の code をそのまま exit にしない）は両方で同じ。PR が手順を変えれば、その PR の手順が回る。`scripts/ci.ts` の無いリポジトリ（`--repo`）は `ci.yml` の `run:` がそのまま手順。

The perf steps (`perf-bench.ts` and `perf-ratchet.ts check`) run before `bun test`, so a perf result does not wait for the whole test run (about five minutes). They carry `keepGoing: true` in `ciSteps`: when one of them fails, `runCi` does not stop there, `bun test` still runs, and the run fails at the end (`ciExit`). One run therefore reports both the perf result and the test result, and a fix for one does not reveal a red in the other on the next run. Every other step still stops the run at its first failure. Actions prints one `✗ <step>: exit <code>` line per failed step. The steps stay one list for Actions and local-ci, and they never run in parallel: perf-bench is not measured next to another load. A repository without `scripts/ci.ts` (`--repo`) has no `keepGoing` and stops at the first failing `run:` as before.

## 結果の通知（#913）

Actions の run があってもなくても、結果は PR に forge の `verification`（GitHub では PR コメント。`reportResult`）として投稿する。1 行目が印で、そのあとに対象（head と base の 40 桁）と、走った手順ごとの結果の表が続く:

| 結果 | 1 行目 | 本文 |
|---|---|---|
| 全手順が合格 | `[local-ci] pass <head sha> base=<base sha>` | 手順の表。スタックのどの PR をこの pass が含むかは書かない（merge-gate が git で判定する） |
| 手順が落ちた | `[local-ci] fail <head sha> base=<base sha>` | Every failed step (the perf check and `bun test` can both fail in one run), each with its exit and the lines picked from its whole output: `(fail)` / `over:` / `raised:` / `improved:` / `grew:` / `無進捗で打ち切り` (up to 20 lines per step), then the table of steps. 全文は実行したホストの記録（パスは書かない） |
| head が base にマージできない | `[local-ci] fail <head sha> base=<base sha>` | 衝突。手順は実行していない |

When the perf check ran and printed a `bundle:` line, pass or fail, the comment has a part `bundle（gzip、マージ後と main の先端の差）:` after the lines of what was tested: the check's `bundle:` line (js / css, the merged size, main's tip, the difference in B and %) and its `grew:` lines when one of them grew 1% or more. A conflict has none (nothing ran).

投稿の直前に head と base を同じ方法で読み直し（`notify`）、どちらかが実行中に変わっていたら何も投稿せず exit 1（テストしていない head や base の結果を書かない。回し直す）。投稿した後に base が進んだこと、下の PR のマージ後の自動 rebase で head が変わったことでは回し直さない（コミットごとの差分が同じなら、merge-gate が `git cherry` で pass の head に入っていると数える。印は 1 行目だけで、ほかのリポジトリの local-ci の写しに書式を求めないため（2026-10-29 の決定。前は 2 行目に各 PR の patch-id を書いていた）。いつ回し、merge-gate がどう数えるかは [docs/merge-gate.md](../merge-gate.md) の「ローカル CI を回す時と数え方」）。読み直せなかったときも投稿しない。投稿する文はキットの認証の値の検査（`runForgeOperation`）を通る。投稿が認証・権限で失敗したら、理由を出して exit 1 で止まる（別の経路で投稿しない。Task なら会話で確認する）。結果の印の読み方は `LOCAL_CI_RESULT`（pass か fail、head、続けて `base=`。マージ判定での扱いは [docs/merge-gate.md](../merge-gate.md)）。

### タグの CI

マージ後の main に付いたタグの CI（`bun scripts/tag-ci.ts [--repo <owner/name>]`）は、この文書の手順を同じ環境で回す（worktree で手順を回して失敗の全文を `~/.cache` に残す部分 `runCheckout` を `localCi` と共有する。対象は PR のマージではなく、タグのコミットそのもの）。印は PR の `[local-ci]` ではなく、そのタグの GitHub Release の本文の `[tag-ci] pass|fail <sha>`。`SWITCHBOARD_FIXTURES` を付けて録画が足りないと、タグの CI は手順を回さず印も書かずに exit 2 で止まる（ホストの不足で、タグの結果ではない）。最新のタグから回し、落ちたら遡る規則と読み方は [releases-and-rescue.md](releases-and-rescue.md) の「Tag CI」。

## 全文と測定値を残す実行手順

手順は `ops-kit/src/idle-run.ts` の `runIdle` で回す。15 分（`scripts/ci.ts` の `STEP_IDLE_SECONDS`）出力が無い手順はプロセスグループごと切り、exit 124 と理由の行 `無進捗で打ち切り: 900 秒出力がなかった` で落ちた手順として扱う。総時間の上限は無い。手順が背景で起動したプロセスはその手順の終わりに消える（Actions と違い、次の手順まで残らない）。local-ci 自身がシグナルで止められたら手順の失敗にせず、何も投稿しないで終わる。

落ちた工程は `local-ci.ts` が全文を `~/.cache/switchboard.local-ci-<owner>_<name>-<PR>-log.*` に残し、`(fail)`・`over:`・`raised:`・`improved:`・`grew:`・`無進捗で打ち切り` の行、最後の 30 行・そのパスを出す（#1232。通った工程は残さない。同じ PR の前の失敗のディレクトリは次の失敗で消え、PR ごとに最新 1 件）。When more than one step failed in a run (a perf step and `bun test`), each one's whole output is a file `<n>-<step>.log` in that same directory, `<n>` being the step's place in the run.

性能の工程（`perf-bench.ts` / `perf-ratchet.ts check`）が落ちたときは、同じディレクトリに `perf-result.json`（あれば）と `summary.md` も残し、`summary.md` と同じ文を出す（#1056、#1184）。`summary.md` の形:

```
head <head sha> / base <base sha>          ← base = 実行を始めたときの base の枝の先端（その時点の main）
手順 <工程>: exit <code>
環境: ceilings <local|github|?>, TMPDIR <dir>, CI=true
超過（over）:                               ← check が出した行をそのまま。種類ごとに、ある種類だけ
改善による予算更新要求（improved）:
main より予算引上げ（raised）:
1% 以上の増加（grew）:                       ← bundle が main の先端より 1% 以上大きい
原因不明（判定の行が無い）:                  ← 4 種類のどれも無いとき（perf-bench の失敗を含む）。出力の最後の 10 行が続く
main（<base7>）との比較:                    ← over があるときだけ（下）
<key>: main でも超過（PR の変更によらない） | <key>: PR 固有の悪化   ← PR の over のキーごと
main の計測に失敗（原因不明）                 ← main の install / build / bench が落ちたとき（キーごとの行の代わり）
main の over:                               ← main の over の行をそのまま
```

check が `over` を出したときだけ、base（実行を始めたときの base の枝の先端 = その時点の main）を別の worktree に出し、同じ環境（`TMPDIR` も同じ）で PR の手順の `bun install --frozen-lockfile` と `bun run --cwd apps/web build` から check までの手順（`perfSteps`）を回して比べる（#1191）。記録は同じディレクトリの `perf-result.base.json` と `base-<n>-<手順>.log`。`improved` / `raised` / `grew` / 原因不明だけなら main はここでは測らない（`grew` は check が main の先端と比べた結果）。`over` のときはローカル CI が 10 分ほど伸びる。

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

## 性能検査だけが不合格の場合

A count the user accepted goes in `exceptions` of `scripts/perf-budget.json`: it holds only while its Issue is open, and adding one is merged by hand ([perf.md](perf.md)). An exception is not the answer to anything else:

- `over`: `summary.md` says per key whether main is over too, the PR made it worse, or main could not be measured. When main is over too, record main's SHA and the count in the existing Issue. main being red does not accept a new regression in the PR: look at each key marked as the PR's own.
- `raised`: `raisedAgainst` exits 1 on purpose, even when the measured value is within the new ceiling. Record the user's permission, the item, the measured value and main's ceiling, and do not call it a CI pass. The bundle has no ceiling, so it is never `raised`.
- `grew`: the check found the bundle (js or css, gzip) 1% or more above main's tip, measured in the same run (`perf-ratchet.ts base`). Under 1% the check passes, and only the `bundle:` line shows the growth in the comment. At 1% or more, merging is the user's call ([perf.md](perf.md)); record the user's permission and the `grew:` line, and do not call it a CI pass.

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
