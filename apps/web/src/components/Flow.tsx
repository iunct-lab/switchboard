import { useEffect, useState } from "react";
import type { BacklogItem, FlowView } from "@switchboard/protocol";
import { api } from "../api.ts";
import { waitSummary } from "../backlogView.ts";
import { bottleneckLine, flowRows, slowRow } from "../flow.ts";
import { t } from "../i18n.ts";
import { panels as m } from "../i18n/panels.ts";
import { jstStamp, jstTime } from "../time.ts";

/**
 * 流れ（直近 30 日）(#651): how long the PBIs closed in the last 30 days took, stage by stage, against the 30 days
 * before. Read apart from the list, so that GitHub being unreadable leaves the list as it is — only this section says why.
 */
export function Flow(props: { items: BacklogItem[]; now: number }) {
  const wait = waitSummary(props.items, props.now);
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
        <h5>{t(m.flowHeading)}</h5>
        <span className="hint">{view ? `${t(m.tallied, { time: jstTime(view.fetchedAt) })}${busy ? t(m.loadingSuffix) : ""}` : busy ? t(m.loading) : ""}</span>
        <button className="ghost" disabled={busy} onClick={() => load(true)}>
          {t(m.reread)}
        </button>
      </div>
      {(wait.until.count > 0 || wait.confirm.count > 0) && (
        <div className="hint" data-flow-wait>
          {t(m.waitNow)}
          {wait.until.count > 0 && wait.until.next !== null && <span data-flow-wait-until>{t(m.waitUntil, { n: wait.until.count, at: jstStamp(wait.until.next) })}</span>}
          {wait.until.count > 0 && wait.confirm.count > 0 && t(m.waitSep)}
          {wait.confirm.count > 0 && (
            <span data-flow-wait-confirm>
              {t(m.waitConfirm, { n: wait.confirm.count })}
              {wait.confirm.longest && (
                <>
                  {t(m.waitLongestPre)}
                  <a href={wait.confirm.longest.url} target="_blank" rel="noreferrer">
                    #{wait.confirm.longest.number}
                  </a>
                  {t(m.waitLongestPost, { days: wait.confirm.longest.days })}
                </>
              )}
            </span>
          )}
        </div>
      )}
      {failure && <div className="muted">{t(m.flowFailed, { error: failure })}</div>}
      {view?.errors.map((e) => (
        <div key={e.workspace} className="muted" data-flow-error>
          {e.workspace}: {e.message}
        </div>
      ))}
      {view && view.unread.length > 0 && (
        <div className="muted" data-flow-unread>
          {t(m.unread, { list: view.unread.join(t(m.listSep)) })}
        </div>
      )}
      {view && view.current.closed + view.previous.closed > 0 && (
        <>
          <div className="hint">
            {t(m.closedLine, { now: view.current.closed, before: view.previous.closed, points: view.current.storyPoints })}
            {bottleneck && <>{t(m.bottleneck)}<b data-flow-bottleneck>{bottleneck}</b></>}
          </div>
          <div className="table-scroll">
          <table className="pricing flow-table">
            <thead>
              <tr>
                <th>{t(m.stage)}</th>
                <th>{t(m.median)}</th>
                <th>p90</th>
                <th>{t(m.previous30)}</th>
                <th>{t(m.change)}</th>
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
          </div>
          <div className="hint">{t(m.slowest)}</div>
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
      {view && view.current.closed + view.previous.closed === 0 && !view.errors.length && <div className="muted">{t(m.noClosed)}</div>}
    </section>
  );
}
