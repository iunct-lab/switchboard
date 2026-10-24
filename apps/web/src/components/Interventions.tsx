import { useEffect, useState } from "react";
import type { InterventionView } from "@switchboard/protocol";
import { api } from "../api.ts";
import { interventionRows, populationLine, reasonRows, unknownLine } from "../interventions.ts";

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
        <h5>介入（直近 7 日 / 30 日）</h5>
        <nav className="subtabs">
          {([7, 30] as const).map((d) => (
            <button key={d} className={days === d ? "on" : ""} data-days={d} onClick={() => setDays(d)}>
              {d} 日
            </button>
          ))}
        </nav>
        <button className="ghost" disabled={busy} onClick={load}>
          読み直す
        </button>
      </div>
      {failure && <div className="muted" data-interventions-error>介入を読めませんでした: {failure}</div>}
      {pair && (
        <>
          <div className="hint" data-population>
            直近: {populationLine(pair.current)}
          </div>
          <div className="hint" data-population-before>
            その前: {populationLine(pair.previous)}
          </div>
          {unknown && <div className="muted" data-unknown>{unknown}</div>}
          <table className="pricing intervention-table">
            <thead>
              <tr>
                <th>{days} 日</th>
                <th>直近</th>
                <th>その前</th>
                <th>差</th>
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
          <div className="hint">止まった理由（直近の多い順、その前との比較）</div>
          {reasonRows(pair.current, pair.previous, props.inView).length === 0 && <div className="muted">この 2 つの期間に止まった記録はありません</div>}
          {reasonRows(pair.current, pair.previous, props.inView).map((r) => (
            <div key={r.reason} className="row" data-reason={r.reason}>
              <span className="t">{r.label}</span>
              <span className="m num">
                {r.count} 回（その前 {r.before} 回、{r.change}）
              </span>
              <span className="m">
                自動再開できなかった {r.notAutoResumed}（その前 {r.notAutoResumedBefore}）
              </span>
              {[...r.links.map((l) => ({ l, period: "now" })), ...r.linksBefore.map((l) => ({ l, period: "before" }))].map(({ l, period }) => (
                <span key={`${period}:${l.taskId}:${l.at}`} className="m" data-evidence={period}>
                  {period === "before" ? "前: " : ""}
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
