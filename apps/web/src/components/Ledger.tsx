import { Fragment, useEffect, useState } from "react";
import type { LedgerDaily, LedgerModelRow, LedgerSummary, LedgerTaskRow, PricingTable, RoutingStats, RunnerId, RunnerInfo } from "@switchboard/protocol";
import { api } from "../api.ts";
import { quotaAsOf, quotaByRunner, quotaStale, resetLabel, windowLabel } from "../quota.ts";
import { countLabel, fmtMedianDuration, runnerRows } from "../runnerStats.ts";
import { fmtUsd, OriginTag, pct, RunnerPill } from "./ui.tsx";
import { jstDay } from "../time.ts";
import { ledgerRunners, listedRunners } from "../runners.ts";
import { t } from "../i18n.ts";
import { insights as m } from "../i18n/insights.ts";

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
      .then((r) => alive && setModels(r))
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
          <h5>{t(m.periodTotal)}</h5>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {t(m.days, { n: d })}
              </option>
            ))}
          </select>
        </div>
        <div className="ledger-head">
          <div>
            <div className="hint">{t(m.apiDays, { days })}</div>
            <div className="bigno">{fmtUsd(periodApi)}</div>
          </div>
          <div>
            <div className="hint">{t(m.billedDays, { days })}</div>
            <div className="bigno">{fmtUsd(periodBilled)}</div>
          </div>
          <div>
            <div className="hint">{t(m.today)}</div>
            <div className="bigno">{fmtUsd(props.ledger?.todayUsd ?? 0)}</div>
          </div>
        </div>
      </section>

      <section className="card usage">
        <div className="row head">
          <h5>{t(m.usageHeading)}</h5>
          <span className="hint">{t(m.usageHint)}</span>
        </div>
        {(props.ledger?.quota ?? []).length === 0 && <div className="muted">{t(m.quotaEmpty)}</div>}
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
          <h5>{t(m.byModel, { days })}</h5>
          <span className="hint">{t(m.byModelHint)}</span>
        </div>
        {models === null && <div className="muted">{t(m.loading)}</div>}
        {models && models.length === 0 && <div className="muted">{t(m.noRecords)}</div>}
        {models && models.length > 0 && (
          <div className="table-scroll">
          <table className="pricing">
            <thead>
              <tr>
                <th>{t(m.runner)}</th>
                <th>{t(m.model)}</th>
                <th>{t(m.count)}</th>
                <th>{t(m.tokens)}</th>
                <th>{t(m.apiEquivalent)}</th>
                <th>{t(m.billed)}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((row) => (
                <tr key={`${row.runner}-${row.model ?? ""}`}>
                  <td>
                    <RunnerPill runner={row.runner} />
                  </td>
                  <td className="mono">{row.model ?? t(m.unknownModel)}</td>
                  <td className="num">{row.tasks}</td>
                  <td className="num">{Math.round(row.tokens / 1000)}k</td>
                  <td className="num">{row.unpriced ? <span className="warn">{t(m.notInPriceTable)}</span> : fmtUsd(row.costUsd)}</td>
                  <td className="num">{fmtUsd(row.billedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="card">
        <h5>{t(m.byDayRunner)}</h5>
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
          <h5>{t(m.routingHeading)}</h5>
          {/* The window comes from the payload, not the local selector: a failed refetch must not relabel old numbers. */}
          <span className="hint">{t(m.routingHint, { period: routing ? t(m.days, { n: routing.days }) : t(m.loadingShort) })}</span>
        </div>
        {routing && routing.rule.total + routing.llm.total === 0 && <div className="muted">{t(m.noSuggestions)}{routing.otherTotal > 0 && t(m.otherSuggesters, { n: routing.otherTotal })}</div>}
        {routing && routing.rule.total + routing.llm.total > 0 && (
          <div className="ledger-head">
            {([
              [t(m.ruleTable), routing.rule],
              ["LLM", routing.llm],
            ] as const).map(([label, v]) => (
              <div key={label}>
                <div className="hint">{label}</div>
                {/* The counts are shown next to the percentage: 1/1 and 180/200 are both "100%" and mean very different things. */}
                <div className="bigno">{v.total === 0 ? "—" : pct(v.agreed / v.total)}</div>
                <div className="hint">{t(m.agreedOf, { agreed: v.agreed, total: v.total })}</div>
              </div>
            ))}
          </div>
        )}
        <div className="hint">
          {t(m.routingNoteBefore)}
          <strong>{t(m.routingNoteStrong)}</strong>
          {t(m.routingNoteAfter)}
        </div>
        {routing && (
          <>
            <div className="row head">
              <h5>{t(m.outcomesByRunner, { days: routing.days })}</h5>
              <span className="hint">{t(m.outcomesHint)}</span>
            </div>
            <div className="table-scroll">
            <table className="pricing runner-stats">
              <thead>
                <tr>
                  <th>{t(m.runner)}</th>
                  <th>{t(m.count)}</th>
                  <th>{t(m.done)}</th>
                  <th>{t(m.needsAction)}</th>
                  <th>{t(m.failed)}</th>
                  <th>{t(m.notJudged)}</th>
                  <th>{t(m.medianCost)}</th>
                  <th>{t(m.medianDuration)}</th>
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
            </div>
          </>
        )}
      </section>

      <div className="hint" data-ledger-speed>
        {t(m.speedBefore)}{" "}
        <button className="ghost link" onClick={props.onOpenInsights}>
          {t(m.speedLink)}
        </button>
        {t(m.speedAfter)}
      </div>

      <section className="card">
        <h5>{t(m.topTasks)}</h5>
        {tasks.length === 0 && <div className="muted">{t(m.noRecords)}</div>}
        {tasks.map((row) => (
          <button key={row.taskId} className="row link" onClick={() => props.onOpenTask(row.taskId)}>
            <span className="t">{row.title}</span>
            <RunnerPill runner={row.runner} />
            <OriginTag origin={row.origin} />
            <span className="hint mono">{row.model ?? "—"}</span>
            <span className="m num">
              {fmtUsd(row.costUsd)}
              {row.billedUsd > 0 && t(m.billedShort, { usd: fmtUsd(row.billedUsd) })} · {t(m.kTokens, { n: Math.round(row.tokens / 1000) })}
              {row.unpriced && <span className="warn">{t(m.priceUnknown)}</span>}
            </span>
          </button>
        ))}
      </section>

      <section className="card">
        <div className="row head">
          <h5>{t(m.priceTable)}</h5>
          <span className="hint mono">{pricing?.source.replace(/^\/Users\/[^/]+/, "~") ?? ""}</span>
        </div>
        {pricing?.problems.map((p) => (
          <div key={p} className="warn">
            {p}
          </div>
        ))}
        <div className="table-scroll">
        <table className="pricing">
          <thead>
            <tr>
              <th>{t(m.model)}</th>
              <th>{t(m.input)}</th>
              <th>{t(m.output)}</th>
              <th>{t(m.cacheRead)}</th>
              <th>{t(m.cacheWrite)}</th>
            </tr>
          </thead>
          <tbody>
            <PriceRows models={pricing?.models ?? {}} fromSettings={pricing?.fromSettings ?? []} />
          </tbody>
        </table>
        </div>
        <div className="hint">
          {t(m.priceNote, { billing: Object.entries(pricing?.billing ?? {}).map(([r, b]) => `${r}: ${b}`).join(" · ") })}
        </div>
      </section>
    </main>
  );
}

/** The price table's rows; a row entered on the settings screen (#1402) carries the 設定 tag. */
export function PriceRows(props: { models: PricingTable["models"]; fromSettings: string[] }) {
  return (
    <>
      {Object.entries(props.models).map(([model, p]) => (
        <tr key={model}>
          <td className="mono">
            {model}
            {props.fromSettings.includes(model) && <span className="tag">{t(m.fromSettings)}</span>}
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
