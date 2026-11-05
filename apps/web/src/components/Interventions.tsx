import { useEffect, useState } from "react";
import type { InterventionView } from "@switchboard/protocol";
import { api } from "../api.ts";
import { interventionRows, populationLine, reasonRows, unknownLine } from "../interventions.ts";
import { t } from "../i18n.ts";
import { panels as m } from "../i18n/panels.ts";

/**
 * 介入（直近 7 日 / 30 日）(#651): how often a person had to step in (approve, decide, restart), against the period before, and
 * what made work stop. Read apart from the list and the 流れ section, so that this failing leaves them as they are.
 */
export function Interventions(props: { inView: (workspaceId: string | null) => boolean; onOpenTask: (id: string) => void }) {
  const [view, setView] = useState<InterventionView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState<7 | 30>(7);
  const load = () => {
    setBusy(true);
    api
      .interventions()
      .then((v) => {
        setView(v);
        setFailure(null);
      })
      .catch((e) => setFailure(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  const pair = view?.windows.find((w) => w.current.days === days);
  const unknown = pair ? unknownLine(pair.current) : null;
  return (
    <section className="card interventions" data-interventions>
      <div className="row head">
        <h5>{t(m.interventionsHeading)}</h5>
        <nav className="subtabs">
          {([7, 30] as const).map((d) => (
            <button key={d} className={days === d ? "on" : ""} data-days={d} onClick={() => setDays(d)}>
              {t(m.days, { n: d })}
            </button>
          ))}
        </nav>
        <button className="ghost" disabled={busy} onClick={load}>
          {t(m.reread)}
        </button>
      </div>
      {failure && <div className="muted" data-interventions-error>{t(m.interventionsFailed, { error: failure })}</div>}
      {pair && (
        <>
          <div className="hint" data-population>
            {t(m.recentLine, { line: populationLine(pair.current) })}
          </div>
          <div className="hint" data-population-before>
            {t(m.beforeLine, { line: populationLine(pair.previous) })}
          </div>
          {unknown && <div className="muted" data-unknown>{unknown}</div>}
          <table className="pricing intervention-table">
            <thead>
              <tr>
                <th>{t(m.days, { n: days })}</th>
                <th>{t(m.recent)}</th>
                <th>{t(m.before)}</th>
                <th>{t(m.difference)}</th>
              </tr>
            </thead>
            <tbody>
              {interventionRows(pair.current, pair.previous).map((r) => (
                <tr key={r.key} data-row={r.key}>
                  <td>{r.label}</td>
                  <td>{r.now}</td>
                  <td>{r.before}</td>
                  <td>{r.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint">{t(m.reasonsHint)}</div>
          {reasonRows(pair.current, pair.previous, props.inView).length === 0 && <div className="muted">{t(m.noStops)}</div>}
          {reasonRows(pair.current, pair.previous, props.inView).map((r) => (
            <div key={r.reason} className="row" data-reason={r.reason}>
              <span className="t">{r.label}</span>
              <span className="m num">
                {t(m.reasonCount, { count: r.count, before: r.before, change: r.change })}
              </span>
              <span className="m">
                {t(m.notAutoResumed, { n: r.notAutoResumed, before: r.notAutoResumedBefore })}
              </span>
              {[...r.links.map((l) => ({ l, period: "now" })), ...r.linksBefore.map((l) => ({ l, period: "before" }))].map(({ l, period }) => (
                <span key={`${period}:${l.taskId}:${l.at}`} className="m" data-evidence={period}>
                  {period === "before" ? t(m.evidenceBefore) : ""}
                  {l.url && l.issue !== null && (
                    <a href={l.url} target="_blank" rel="noreferrer">
                      #{l.issue}
                    </a>
                  )}{" "}
                  <button className="ghost link" title={l.evidence} onClick={() => props.onOpenTask(l.taskId)}>
                    Task
                  </button>
                </span>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
