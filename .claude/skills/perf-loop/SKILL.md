---
name: perf-loop
description: Switchboard の速さを計測して改善を回すときに読む。perf-bench で遅いジャーニーを選び、ラボで再現して原因を 1 つに絞り、1 PR 1 改善で前後の表を本文に貼り、マージ後に実測を見て、タグが 3 つ続けて下回ってから perf-ratchet の上限を下げるまで。
---

# 速さの改善を回す（perf-loop）

一度速くした操作を、あとの変更で遅く戻さない（PBI #638）。計測の仕組みと数の意味は `docs/design/perf.md`。ここは**回し方**だけ。
ループを自動で回す仕組み（定期 Task で改善 PBI を起こす）は無い。人がこのスキルを起動して回す。

## 1. 計測して、遅いジャーニーを選ぶ

```bash
bun run --cwd apps/web build && bun scripts/perf-bench.ts --json perf-result.json   # 既定 --runs 5。1 回 30 秒前後
```

表（ジャーニー / ms の中央値・p90 / 揺れない数 / `bytes`）が出る。ジャーニーは 4 つと `open-task-huge`（実物の大きさ 20,000 件の Task を開く。印は `sb:open-task`）。大きな Task の遅さは `open-task-huge` の ms と `bytes`（ジャーニー中の `/api/` の応答のバイト数。揺れない。応答のパスごとの内訳は JSON の `responses`）で見る。`bytes` が `open-task` の何倍にもなっていたら、Task を開くときに全件を読んでいる。選ぶ基準は ms の中央値が大きいもの、または揺れない数（`requests` / `layoutCount` / `recalcStyleCount` / `layoutShift`）が多いもの。ms は共有マシンで揺れるので、同じマシンの前後でだけ比べる。
実際に使っているときの所要時間の台帳（#639）ができたら、その「速さ」も見て、利用者が待っている操作を優先する。

## 2. ラボで再現し、原因を 1 つに絞る

- perf-bench と同じ偽ランナーのデーモン + headless Chrome で、選んだジャーニーだけを動かす（作り方は `docs/design/perf.md` の「How to run」と CLAUDE.md のテストの表の「単体で書けない UI / 経路」）
- Chrome の Performance（CDP の `Tracing` / `Performance.getMetrics` の `LayoutCount` / `RecalcStyleCount`）で、どの描画・どのリクエストが効いているかを 1 つに絞る。絞れないうちは直さない
- 原因の仮説と、それを確かめた数を Task に書く

## 3. 1 PR 1 改善

1 つの原因だけを直し、PR 本文に前後の表を貼る（下の数は形の見本。launch の layoutShift を直した PR のつもり）。前と後は**同じマシンで続けて**測る（`--runs 5` を前後それぞれ。ms は揺れるので、効いたと言うのは揺れない数か、ms が前後の p90 を越えて動いたとき）。直した枝で build してから `--json` で残す:

```bash
bun run --cwd apps/web build && bun scripts/perf-bench.ts --json perf-result.json   # 後（直した枝）。前は main の worktree で同じコマンド
```

```markdown
## 前後（AWS ホスト、`bun scripts/perf-bench.ts --runs 5`、前 = main <sha>、後 = この枝 <sha>）

| journey | ms 中央値 前 → 後 | ms p90 前 → 後 | requests | layoutCount | recalcStyleCount | layoutShift | bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| launch | 620 → 410 | 860 → 500 | 12 → 12 | 4 → 4 | 5 → 5 | 0.1314 → 0.0021 | 5641 → 5641 |
| new-task | 300 → 300 | 410 → 400 | 13 → 13 | 8 → 8 | 8 → 8 | 0.0198 → 0.0198 | 35291 → 35291 |
| open-task | 380 → 380 | 560 → 550 | 5 → 5 | 3 → 3 | 3 → 3 | 0.047 → 0.047 | 35599 → 35599 |
| send | 570 → 560 | 740 → 750 | 5 → 5 | 4 → 4 | 4 → 4 | 0.0228 → 0.0228 | 3681 → 3681 |
| open-task-huge | 150 → 150 | 200 → 200 | 9 → 9 | 4 → 4 | 4 → 4 | 0.027 → 0.027 | 36108 → 36108 |
| bundle (gzip) | js 186608 → 186650 B、css 6031 → 6031 B | | | | | |
```

bundle には上限が無い（`scripts/perf-budget.json` に無い）。タグの CI の `perf-ratchet.ts check` が前のタグ（`PERF_BASE_REF`。最初のタグは `origin/main` の先端）との差を `bundle:` の行に出し（PR の local-ci は perf を測らないので、コメントには出ない）、js か css が 1% 以上増えたら `grew:` を出す（perf の手順は合否に数えず、`grew:` は Release の警告に残るだけでタグは pass。`docs/design/perf.md` の「Ratchet (the CI ceilings)」の Bundle）。表の bundle の行は前後の比較のために書く。

## 4. 上限を下げる（マージの後、タグが 3 つ続けて下回ってから）

改善の PR では上限を下げない。タグの CI は「良くなった」（`improved:`）では落ちず、Release の `## CI` に下げられる上限として残すだけ。1 回の低い値で下げると、同じコードの次の高い値が `over` になる（揺れ）ので、`update` は直近 3 タグ（`LOWER_AFTER`）が続けて `ceiling − 2 × 幅` を下回った数だけを、その 3 つの最大 + 幅に下げる。マージの後、タグが 3 つ付いて tag CI が測ってから回す（`perf-records` 枝の `counts.tsv` を読むので、結果ファイルは渡さない）:

```bash
bun scripts/perf-ratchet.ts update                  # このホストの上限（local）。タグが 3 つに満たない数は `waiting <key>: n/3` と出る
```

下がった `scripts/perf-budget.json` は別の PR で出す（上限を下げるだけの PR）。`update` は下げる方向にしか書き換えない。bundle と `bytes`（`open-task` / `open-task-huge`）は上限が無いので下げるものも無い（前のタグとの増分を `grew:` に出す。`docs/design/perf.md` の「Ratchet (the CI ceilings)」の冒頭）。`loaded.healthMaxMs` は下げない。上限は環境ごとに 2 組（`github` / `local`）ある。`counts.tsv` に行を書くのはタグの CI（`local`）だけなので、`update --env github` は `waiting` のままで `github` の上限は下がらない。`github` の上限は手で下げる（`docs/design/perf.md` の「Initial values」の末尾の by hand）。

**上限を上げたい**（機能を足して数が増えるなど）ときは、`scripts/perf-budget.json` を手で上げる（bundle と `bytes` は上限が無いので書き換えない。1% 未満の増えで利用者に聞かない・上限を上げる PR を出さない。止まらずに通り、推移は `bun scripts/perf-ratchet.ts history` で追う）。PR のローカル CI は perf を測らないので、上げた PR も 1% 以上増えた PR も PR では落ちない。タグの CI では、比べる相手は前のタグなので、そのタグが足した増えが `raised:` / `grew:` に出る（タグに複数のマージがあれば和。どのマージかは `history` と `git log` で追う。`docs/design/perf.md` の「Ratchet (the CI ceilings)」の冒頭）。`raised:` / `grew:` だけのタグは pass。bundle と `bytes` の増えはマージの前に聞かず、`bun scripts/perf-ratchet.ts history` で追い、直す要望を起票するか前のタグへ戻す。上限を手で上げるのは利用者の判断なので、上げる PR はマージの前に運用の確認として聞く（理由と前後の表を添える）。

## 5. マージ後に実測を見る

マージして動いている Switchboard に反映されたら（いつ昇格するかは CLAUDE.md の「Switchboard の Task と動いているコード」）、同じ操作を実際に使って速くなったかを見る。台帳（#639）があればその数、無ければ `verify-live-ui` の手順で画面を見る。ラボで速くなったのに実測が変わらないなら、ラボの再現がずれている — 2 に戻る。
