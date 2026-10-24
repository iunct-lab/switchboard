import { useEffect, useState } from "react";
import type { FlowView } from "@switchboard/protocol";
import { api } from "../api.ts";
import { bottleneckLine, flowRows, slowRow } from "../flow.ts";
import { jstTime } from "../time.ts";

/**
 * 流れ（直近 30 日）(#651): how long the PBIs closed in the last 30 days took, stage by stage, against the 30 days
 * before. Read apart from the list, so that GitHub being unreadable leaves the list as it is — only this section says why.
 */
export function Flow() {
  const [view, setView] = useState<FlowView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh: boolean) => {
    setBusy(true);
    api
      .flow(refresh)
      .then((v) => {
        setView(v);
        setFailure(null);
      })
      .catch((e) => setFailure(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(false), []);

  const bottleneck = view ? bottleneckLine(view) : null;
  return (
    <section className="card flow" data-flow>
      <div className="row head">
        <h5>流れ（直近 30 日）</h5>
        <span className="hint">{view ? `${jstTime(view.fetchedAt)} に集計${busy ? " · 読み込み中…" : ""}` : busy ? "読み込み中…" : ""}</span>
        <button className="ghost" disabled={busy} onClick={() => load(true)}>
          読み直す
        </button>
      </div>
      {failure && <div className="muted">流れを読めませんでした: {failure}</div>}
      {view?.errors.map((e) => (
        <div key={e.workspace} className="muted" data-flow-error>
          {e.workspace}: {e.message}
        </div>
      ))}
      {view && view.unread.length > 0 && (
        <div className="muted" data-flow-unread>
          取り込み前で、数に入っていません: {view.unread.join("、")}
        </div>
      )}
      {view && view.current.closed + view.previous.closed > 0 && (
        <>
          <div className="hint">
            閉じた PBI {view.current.closed} 件（前の 30 日 {view.previous.closed} 件）· Story Points {view.current.storyPoints}
            {bottleneck && <> · 一番時間を食った段: <b data-flow-bottleneck>{bottleneck}</b></>}
          </div>
          <table className="pricing flow-table">
            <thead>
              <tr>
                <th>段</th>
                <th>中央値</th>
                <th>p90</th>
                <th>前の 30 日</th>
                <th>変化</th>
              </tr>
            </thead>
            <tbody>
              {flowRows(view).map((r) => (
                <tr key={r.stage} data-stage={r.stage} data-tone={r.tone}>
                  <td>{r.label}</td>
                  <td>{r.now}</td>
                  <td>{r.p90}</td>
                  <td>{r.before}</td>
                  <td>{r.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint">時間がかかった PBI</div>
          {view.slowest.map((p) => {
            const r = slowRow(p);
            return (
              <div key={`${p.repo}#${p.number}`} className="row" data-flow-pbi>
                <span className="t">
                  <a href={r.url} target="_blank" rel="noreferrer">
                    #{r.number}
                  </a>{" "}
                  {r.title}
                </span>
                <span className="m num">{r.total}</span>
                <span className="m">{r.longest}</span>
              </div>
            );
          })}
        </>
      )}
      {view && view.current.closed + view.previous.closed === 0 && !view.errors.length && <div className="muted">この期間に閉じた PBI はありません</div>}
    </section>
  );
}
