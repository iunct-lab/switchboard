import { useEffect, useState } from "react";
import type { BalanceView } from "@switchboard/protocol";
import { api } from "../api.ts";
import { balanceCells, capacityText, kindShares, type KindKey } from "../balance.ts";
import { fmtClock, pct } from "./ui.tsx";
import { t } from "../i18n.ts";
import { insights as m } from "../i18n/insights.ts";

const KIND_LABEL: Record<KindKey, typeof m.balanceKindBuild> = { build: m.balanceKindBuild, maintain: m.balanceKindMaintain, selfImprove: m.balanceKindSelfImprove, unlinked: m.balanceKindUnlinked };

const COLS = [m.balanceTasks, m.balanceCost, m.balanceShare, m.balanceBilled, m.balanceInterventions, m.balanceDelivered, m.balanceCostPer, m.balanceIntPer, m.balanceNet];

/** リポジトリ横断: each workspace's spend, interventions and delivered PBIs over 7 or 30 days, and what the quota leaves. Read when Insights opens and when the period changes; it does not reload by itself. */
export function Balance(props: { onError: (msg: string) => void }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [view, setView] = useState<BalanceView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true; // a slow answer for the period switched away from must not replace the current one
    setView(null);
    setFailed(false);
    api
      .balance(days)
      .then((v) => live && setView(v))
      .catch((e) => {
        if (!live) return;
        setFailed(true);
        props.onError(String(e.message ?? e));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is App's stable setter
  }, [days]);
  const cap = view?.capacity;
  return (
    <section className="card balance" data-balance>
      <div className="row head">
        <h5>{t(m.balanceHeading, { n: days })}</h5>
        <nav className="subtabs">
          {([7, 30] as const).map((d) => (
            <button key={d} className={days === d ? "on" : ""} data-days={d} onClick={() => setDays(d)}>
              {t(m.days, { n: d })}
            </button>
          ))}
        </nav>
      </div>
      {failed ? <div className="muted">{t(m.balanceFailed)}</div> : !view && <div className="muted">{t(m.loading)}</div>}
      {view && view.rows.length === 0 && <div className="muted">{t(m.balanceEmpty)}</div>}
      {view && view.rows.length > 0 && (
        <div className="balance-scroll">
          <table className="pricing balance-table">
            <thead>
              <tr>
                <th>{t(m.balanceRepo)}</th>
                {COLS.map((c, i) => (
                  <th key={i}>{t(c)}</th>
                ))}
              </tr>
            </thead>
            {view.rows.map((r) => (
              <tbody key={r.workspaceId} data-balance-row={r.workspaceId}>
                <tr>
                  <td data-label={t(m.balanceRepo)}>{r.name}</td>
                  {balanceCells(r).map((c, i) => (
                    <td key={i} data-label={t(COLS[i]!)}>
                      {c}
                    </td>
                  ))}
                </tr>
                <tr className="balance-kinds">
                  <td colSpan={COLS.length + 1}>
                    <b>{t(m.balanceKinds)}</b>:{" "}
                    {kindShares(r.kinds)
                      .map((k) => `${t(KIND_LABEL[k.key])} ${k.share}%`)
                      .join(" ／ ")}
                  </td>
                </tr>
              </tbody>
            ))}
          </table>
        </div>
      )}
      {cap && (
        <div className="balance-capacity" data-balance-capacity>
          <b>{t(m.balanceCapacity)}</b>:{" "}
          {cap.runners.map((r) => (
            <div key={r.runner}>
              {t(m.balanceWindow, { runner: r.runner, use: r.utilization === null ? "-" : pct(r.utilization) })}
              {r.resetsAt !== null && t(m.balanceResets, { at: fmtClock(r.resetsAt * 1000) })}
              {r.saturated && t(m.balanceSaturated)}
            </div>
          ))}
          <div>
            {t(m.balancePerDay, { n: Math.round(cap.interventionsPerDay) })} ／ {capacityText(cap)}
          </div>
        </div>
      )}
    </section>
  );
}
