import { Fragment, useEffect, useState } from "react";
import type { LedgerDaily, LedgerModelRow, LedgerSummary, LedgerTaskRow, PricingTable, RoutingStats, RunnerId, RunnerInfo } from "@switchboard/protocol";
import { api } from "../api.ts";
import { quotaAsOf, quotaByRunner, quotaStale, resetLabel, windowLabel } from "../quota.ts";
import { countLabel, fmtMedianDuration, runnerRows } from "../runnerStats.ts";
import { fmtUsd, OriginTag, pct, RunnerPill } from "./ui.tsx";
import { jstDay } from "../time.ts";
import { ledgerRunners, listedRunners } from "../runners.ts";

/** Screen D: the cost ledger. API-equivalent and actually-billed figures side by side; the price table is data. */
export function Ledger(props: { ledger: LedgerSummary | null; runners: RunnerInfo[]; onOpenTask: (id: string) => void; onOpenInsights: () => void; onError: (msg: string) => void }) {
  const [days, setDays] = useState(7);
  const [daily, setDaily] = useState<LedgerDaily[]>([]);
  const [tasks, setTasks] = useState<LedgerTaskRow[]>([]);
  const [pricing, setPricing] = useState<(PricingTable & { fromSettings: string[]; source: string; problems: string[] }) | null>(null);
  /** Routing agreement (#25): how often each suggester named the runner that was actually used. */
  const [routing, setRouting] = useState<RoutingStats | null>(null);
  /** The setting's count below which a runner's row is too thin to compare (#835); undefined = the default. */
  const [thinSample, setThinSample] = useState<number | undefined>(undefined);
  /** Usage per runner × model in the period (#1836); null until read, [] when the read failed. */
  const [models, setModels] = useState<LedgerModelRow[] | null>(null);

  const { onError } = props;
  // Refetch on every summary change (the summary object is replaced whenever the daemon records usage); pricing once.
  useEffect(() => {
    let alive = true;
    api
      .ledgerDaily(days)
      .then((d) => alive && setDaily(d))
      .catch((e) => alive && onError(String(e.message ?? e)));
    api
      .ledgerTasks(days)
      .then((t) => alive && setTasks(t))
      .catch(() => undefined);
    // On failure the card is cleared rather than left showing the previous window's numbers under the new label.
    api
      .routingStats(days)
      .then((r) => alive && setRouting(r))
      .catch(() => alive && setRouting(null));
    setModels(null); // the heading names the new period at once: no old rows under it while the read is in flight
    api
      .ledgerModels(days)
      .then((m) => alive && setModels(m))
      .catch((e) => {
        if (!alive) return;
        setModels([]);
        onError(String(e.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [days, props.ledger, onError]);
  useEffect(() => {
    api.pricing().then(setPricing).catch(() => undefined);
    api.settings().then((s) => setThinSample(s.quotaAndResume.thinSample)).catch(() => undefined);
  }, []);
  const periodApi = daily.reduce((a, r) => a + r.costUsd, 0);
  const periodBilled = daily.reduce((a, r) => a + r.billedUsd, 0);

  const dayList = [...Array(days)].map((_, i) => jstDay(Date.now() - (days - 1 - i) * 86_400_000));
  const RUNNERS = ledgerRunners(listedRunners(props.runners), daily.map((r) => r.runner));
  const cell = (day: string, runner: RunnerId) => daily.find((r) => r.day === day && r.runner === runner);
  const max = Math.max(0.01, ...dayList.map((day) => RUNNERS.reduce((a, r) => a + (cell(day, r)?.costUsd ?? 0), 0)));

  return (
    <main className="main ledger">
      <section className="card">
        <div className="row head">
          <h5>期間合計</h5>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} 日
              </option>
            ))}
          </select>
        </div>
        <div className="ledger-head">
          <div>
            <div className="hint">API 換算（{days} 日）</div>
            <div className="bigno">{fmtUsd(periodApi)}</div>
          </div>
          <div>
            <div className="hint">実課金（{days} 日）</div>
            <div className="bigno">{fmtUsd(periodBilled)}</div>
          </div>
          <div>
            <div className="hint">今日</div>
            <div className="bigno">{fmtUsd(props.ledger?.todayUsd ?? 0)}</div>
          </div>
        </div>
      </section>

      <section className="card usage">
        <div className="row head">
          <h5>使用量（枠）</h5>
          <span className="hint">ランナーが最後に報告した値。24 時間より前のものは薄く出ます</span>
        </div>
        {(props.ledger?.quota ?? []).length === 0 && <div className="muted">枠の消費は最初のタスク実行後に表示されます</div>}
        {quotaByRunner(props.ledger?.quota ?? []).map((g) => (
          <div key={g.runner}>
            <div className="row sub">
              <RunnerPill runner={g.runner as RunnerId} />
            </div>
            <div className="kv">
              {g.rows.map((q) => {
                const stale = quotaStale(q.ts);
                return (
                  <Fragment key={q.window}>
                    <span className={stale ? "stale" : undefined}>{windowLabel(q.window)}</span>
                    <span className={`num${stale ? " stale" : ""}`}>
                      {pct(q.utilization)}
                      <span className={`meter ${q.utilization > 0.8 ? "warn" : ""}`}>
                        <i style={{ width: `${Math.min(100, q.utilization * 100)}%` }} />
                      </span>
                      <span className="hint">
                        {resetLabel(q.resetsAt)} · {quotaAsOf(q.ts)}
                      </span>
                    </span>
                  </Fragment>
                );
              })}
            </div>
          </div>
        ))}
        <div className="row head" style={{ marginTop: 14 }}>
          <h5>モデル別（{days} 日）</h5>
          <span className="hint">件数はそのモデルを使った Task の数</span>
        </div>
        {models === null && <div className="muted">読み込み中…</div>}
        {models && models.length === 0 && <div className="muted">この期間の記録はありません</div>}
        {models && models.length > 0 && (
          <table className="pricing">
            <thead>
              <tr>
                <th>ランナー</th>
                <th>モデル</th>
                <th>件数</th>
                <th>トークン</th>
                <th>API 換算</th>
                <th>実課金</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={`${m.runner}-${m.model ?? ""}`}>
                  <td>
                    <RunnerPill runner={m.runner} />
                  </td>
                  <td className="mono">{m.model ?? "（不明）"}</td>
                  <td className="num">{m.tasks}</td>
                  <td className="num">{Math.round(m.tokens / 1000)}k</td>
                  <td className="num">{m.unpriced ? <span className="warn">価格表に無い</span> : fmtUsd(m.costUsd)}</td>
                  <td className="num">{fmtUsd(m.billedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h5>日別 · ランナー別（API 換算 USD）</h5>
        <div className="bars">
          {dayList.map((day) => {
            const total = RUNNERS.reduce((a, r) => a + (cell(day, r)?.costUsd ?? 0), 0);
            return (
              <div key={day} className="bar-col" title={`${day}: ${fmtUsd(total)}`}>
                <div className="bar">
                  {RUNNERS.map((r) => {
                    const v = cell(day, r)?.costUsd ?? 0;
                    return v > 0 ? <i key={r} className={r} style={{ height: `${(v / max) * 100}%` }} title={`${r} ${fmtUsd(v)}`} /> : null;
                  })}
                </div>
                <div className="lbl">{day.slice(5).replace("-", "/")}</div>
              </div>
            );
          })}
        </div>
        <div className="legend">
          {RUNNERS.map((r) => (
            <span key={r}>
              <i className={r} /> {r}
            </span>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="row head">
          <h5>ルーティング一致率</h5>
          {/* The window comes from the payload, not the local selector: a failed refetch must not relabel old numbers. */}
          <span className="hint">提案どおりのランナーで動いた割合（{routing ? `${routing.days} 日` : "読み込み中"}）</span>
        </div>
        {routing && routing.rule.total + routing.llm.total === 0 && <div className="muted">まだ提案の記録がありません{routing.otherTotal > 0 && `（ほかの提案元の記録が ${routing.otherTotal} 件あります）`}</div>}
        {routing && routing.rule.total + routing.llm.total > 0 && (
          <div className="ledger-head">
            {([
              ["ルール表", routing.rule],
              ["LLM", routing.llm],
            ] as const).map(([label, v]) => (
              <div key={label}>
                <div className="hint">{label}</div>
                {/* The counts are shown next to the percentage: 1/1 and 180/200 are both "100%" and mean very different things. */}
                <div className="bigno">{v.total === 0 ? "—" : pct(v.agreed / v.total)}</div>
                <div className="hint">
                  {v.agreed} / {v.total} 件
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="hint">
          提案は助言です。一致率が低いこと自体は問題ではなく、ルール表を直す手がかりになります。
          <strong>2 つの割合は分母が違うので優劣の比較には使えません</strong>: ルール表は全 Task に提案を出しますが、LLM は設定（Home）で ON にしていて、かつ待ち時間内に答えられた Task だけです（間に合わなかった提案は「外れ」ではなく記録なしになります）。スケジュールと Inbox からの Task は LLM に聞きません。
        </div>
        {routing && (
          <>
            <div className="row head">
              <h5>ランナーごとの結末（{routing.days} 日）</h5>
              <span className="hint">1 Task 1 件。件数の少ないランナーは薄く出します</span>
            </div>
            <table className="pricing runner-stats">
              <thead>
                <tr>
                  <th>ランナー</th>
                  <th>件数</th>
                  <th>完了</th>
                  <th>要対応</th>
                  <th>失敗</th>
                  <th>未判定</th>
                  <th>費用の中央値</th>
                  <th>所要の中央値</th>
                </tr>
              </thead>
              <tbody>
                {runnerRows(routing, RUNNERS, thinSample).map((r) => (
                  <tr key={r.runner} className={r.thin ? "thin" : undefined}>
                    <td>
                      <RunnerPill runner={r.runner} />
                    </td>
                    <td className="num">{countLabel(r)}</td>
                    <td className="num">{r.outcomes.done}</td>
                    <td className="num">{r.outcomes.needs_action}</td>
                    <td className="num">{r.outcomes.failed}</td>
                    <td className="num">{r.outcomes.unknown}</td>
                    <td className="num">{r.medianCostUsd === null ? "—" : fmtUsd(r.medianCostUsd)}</td>
                    <td className="num">{fmtMedianDuration(r.medianDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <div className="hint" data-ledger-speed>
        速さ（ふだんの操作と API の所要時間）は{" "}
        <button className="ghost link" onClick={props.onOpenInsights}>
          Insights の「運用」
        </button>
        へ
      </div>

      <section className="card">
        <h5>タスク別 · 上位</h5>
        {tasks.length === 0 && <div className="muted">この期間の記録はありません</div>}
        {tasks.map((t) => (
          <button key={t.taskId} className="row link" onClick={() => props.onOpenTask(t.taskId)}>
            <span className="t">{t.title}</span>
            <RunnerPill runner={t.runner} />
            <OriginTag origin={t.origin} />
            <span className="hint mono">{t.model ?? "—"}</span>
            <span className="m num">
              {fmtUsd(t.costUsd)}
              {t.billedUsd > 0 && ` (実 ${fmtUsd(t.billedUsd)})`} · {Math.round(t.tokens / 1000)}k トークン{t.unpriced && <span className="warn"> · 価格不明</span>}
            </span>
          </button>
        ))}
      </section>

      <section className="card">
        <div className="row head">
          <h5>価格表（データ）</h5>
          <span className="hint mono">{pricing?.source.replace(/^\/Users\/[^/]+/, "~") ?? ""}</span>
        </div>
        {pricing?.problems.map((p) => (
          <div key={p} className="warn">
            {p}
          </div>
        ))}
        <table className="pricing">
          <thead>
            <tr>
              <th>モデル</th>
              <th>入力</th>
              <th>出力</th>
              <th>キャッシュ読み込み</th>
              <th>キャッシュ書き込み</th>
            </tr>
          </thead>
          <tbody>
            <PriceRows models={pricing?.models ?? {}} fromSettings={pricing?.fromSettings ?? []} />
          </tbody>
        </table>
        <div className="hint">
          USD / 1M tokens。実課金は billing（{Object.entries(pricing?.billing ?? {}).map(([r, b]) => `${r}: ${b}`).join(" · ")}、未記載のランナーは api 扱い）で判定。日付はデーモンのローカル暦。~/.switchboard/pricing.json で上書きできます（ファイル全体を置き換えるので billing も書くこと）。新しいモデルの価格は設定画面の「モデルの価格」で入れられます（再起動は要りません。「設定」の印の行）。
        </div>
      </section>
    </main>
  );
}

/** The price table's rows; a row entered on the settings screen (#1402) carries the 設定 tag. */
export function PriceRows(props: { models: PricingTable["models"]; fromSettings: string[] }) {
  return (
    <>
      {Object.entries(props.models).map(([m, p]) => (
        <tr key={m}>
          <td className="mono">
            {m}
            {props.fromSettings.includes(m) && <span className="tag">設定</span>}
          </td>
          <td className="num">${p.input}</td>
          <td className="num">${p.output}</td>
          <td className="num">${p.cacheRead}</td>
          <td className="num">${p.cacheWrite}</td>
        </tr>
      ))}
    </>
  );
}
