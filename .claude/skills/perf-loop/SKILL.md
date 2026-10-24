---
name: perf-loop
description: Switchboard の速さを計測して改善を回すときに読む。perf-bench で遅いジャーニーを選び、ラボで再現して原因を 1 つに絞り、1 PR 1 改善で前後の表を本文に貼り、同じ PR で perf-ratchet の上限を下げ、マージ後に実測を見るまで。
---

# 速さの改善を回す（perf-loop）

一度速くした操作を、あとの変更で遅く戻さない（PBI #638）。計測の仕組みと数の意味は `docs/design/perf.md`。ここは**回し方**だけ。
ループを自動で回す仕組み（定期 Task で改善 PBI を起こす）は無い。人がこのスキルを起動して回す。

## 1. 計測して、遅いジャーニーを選ぶ

```bash
bun run --cwd apps/web build && bun scripts/perf-bench.ts --json perf-result.json   # 既定 --runs 5。1 回 30 秒前後
```

表（ジャーニー / ms の中央値・p90 / 揺れない数）が出る。選ぶ基準は ms の中央値が大きいもの、または揺れない数（`requests` / `layoutCount` / `recalcStyleCount` / `layoutShift`）が多いもの。ms は共有マシンで揺れるので、同じマシンの前後でだけ比べる。
実際に使っているときの所要時間の台帳（#639）ができたら、その「速さ」も見て、利用者が待っている操作を優先する。

## 2. ラボで再現し、原因を 1 つに絞る

- perf-bench と同じ偽ランナーのデーモン + headless Chrome で、選んだジャーニーだけを動かす（作り方は `docs/design/perf.md` の「回し方」と CLAUDE.md のテストの表の「単体で書けない UI / 経路」）
- Chrome の Performance（CDP の `Tracing` / `Performance.getMetrics` の `LayoutCount` / `RecalcStyleCount`）で、どの描画・どのリクエストが効いているかを 1 つに絞る。絞れないうちは直さない
- 原因の仮説と、それを確かめた数を Task に書く

## 3. 1 PR 1 改善

1 つの原因だけを直し、PR 本文に前後の表を貼る（下の数は形の見本。launch の layoutShift を直した PR のつもり）。前と後は**同じマシンで続けて**測る（`--runs 5` を前後それぞれ。ms は揺れるので、効いたと言うのは揺れない数か、ms が前後の p90 を越えて動いたとき）。後の結果は 4 で使うので、直した枝で build してから `--json` で残す:

```bash
bun run --cwd apps/web build && bun scripts/perf-bench.ts --json perf-result.json   # 後（直した枝）。前は main の worktree で同じコマンド
```

```markdown
## 前後（AWS ホスト、`bun scripts/perf-bench.ts --runs 5`、前 = main <sha>、後 = この枝 <sha>）

| journey | ms 中央値 前 → 後 | ms p90 前 → 後 | requests | layoutCount | recalcStyleCount | layoutShift |
|---|---:|---:|---:|---:|---:|---:|
| launch | 620 → 410 | 860 → 500 | 12 → 12 | 4 → 4 | 5 → 5 | 0.1314 → 0.0021 |
| new-task | 300 → 300 | 410 → 400 | 13 → 13 | 8 → 8 | 8 → 8 | 0.0198 → 0.0198 |
| open-task | 380 → 380 | 560 → 550 | 5 → 5 | 3 → 3 | 3 → 3 | 0.047 → 0.047 |
| send | 570 → 560 | 740 → 750 | 5 → 5 | 4 → 4 | 4 → 4 | 0.0228 → 0.0228 |
| bundle (gzip) | js 186608 → 186650 B、css 6031 → 6031 B | | | | | |
```

## 4. 上限を下げる（マージの前に、同じ PR で）

改善の PR では CI のラチェットが「良くなった」で落ちる（両側のゲート）ので、マージの前に同じ PR で上限を下げる。`perf-result.json` は 3 の「後」の結果（1 の前の結果を渡すと何も下がらない）:

```bash
bun scripts/perf-ratchet.ts update perf-result.json                  # このホストの上限（local）を下げる
bun scripts/perf-ratchet.ts update <Actions の結果>.json --env github  # Actions の上限。check が落ちた run の log の最後に出る JSON をファイルにして渡す
```

`update` は下げる方向にしか書き換えない。上限は環境ごとに 2 組（`github` / `local`）あり、片方だけ下げると、もう片方は次の CI で「良くなった」と出る — 両方下げる。

**上限を上げたい**（機能を足して数が増えるなど）ときは、`scripts/perf-budget.json` を手で上げる。`check` が main より上げた項目で exit 1 になるので CI は落ち、マージするかは利用者の判断（運用の確認として聞く。理由と前後の表を添える）。

## 5. マージ後に実測を見る

マージして動いている Switchboard に反映されたら（昇格は利用者の OK の後。CLAUDE.md）、同じ操作を実際に使って速くなったかを見る。台帳（#639）があればその数、無ければ `verify-live-ui` の手順で画面を見る。ラボで速くなったのに実測が変わらないなら、ラボの再現がずれている — 2 に戻る。
