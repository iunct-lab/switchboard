import { useEffect, useState } from "react";
import type { OpsLatency, OpsLoad, OpsStops } from "@switchboard/protocol";
import { api } from "../api.ts";
import { fmtBytes, latencyRows, loadDays, reasonLabel, stopsTable, topGroups, type StopsDay } from "../ops.ts";
import { perfRows, type PerfRow } from "../perf.ts";
import { fmtClock } from "./ui.tsx";
import { t } from "../i18n.ts";
import { insights as m } from "../i18n/insights.ts";

/**
 * 運用 (#2085): the host's own numbers, apart from the per-Task evaluations. デーモンの停止 = how often the daemon
 * stopped and why, and the turns it cut; ホストの負荷 (#2086) = the unit's daily peaks and the heaviest task × kind;
 * 速さ (#2104) = the everyday journeys, the last 7 days against the 7 before them, and
 * API の所要時間 = the slowest routes by p90 (docs/design/perf.md). Each is read on its own, so a failure in one leaves the rest.
 */
export function Ops(props: { onOpenTask: (id: string) => void }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [stops, setStops] = useState<OpsStops | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api
      .opsStops(days)
      .then((s) => {
        setStops(s);
        setFailure(null);
      })
      .catch((e) => setFailure(String(e.message ?? e)));
  }, [days]);
  const [load, setLoad] = useState<OpsLoad | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  useEffect(() => {
    api
      .opsLoad(days)
      .then((l) => {
        setLoad(l);
        setLoadFailure(null);
      })
      .catch((e) => setLoadFailure(String(e.message ?? e)));
  }, [days]);

  // the speed table compares fixed 7-day periods, so it does not follow the 7 / 30 day switch
  const [perf, setPerf] = useState<PerfRow[] | null>(null);
  const [perfFailure, setPerfFailure] = useState<string | null>(null);
  useEffect(() => {
    api
      .perfSummary()
      .then((p) => {
        setPerf(perfRows(p));
        setPerfFailure(null);
      })
      .catch((e) => setPerfFailure(String(e.message ?? e)));
  }, []);
  const [latency, setLatency] = useState<OpsLatency | null>(null);
  const [latencyFailure, setLatencyFailure] = useState<string | null>(null);
  useEffect(() => {
    // a slow answer for the period switched away from must not replace the current one
    let alive = true;
    api
      .opsLatency(days)
      .then((l) => {
        if (!alive) return;
        setLatency(l);
        setLatencyFailure(null);
      })
      .catch((e) => alive && setLatencyFailure(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [days]);

  const table = stops ? stopsTable(stops.rows) : null;
  const tasks = (d: StopsDay) =>
    d.taskIds.length === 0 ? (
      "0"
    ) : (
      <details>
        <summary>{d.taskIds.length}</summary>
        {d.taskIds.map((id) => (
          <button key={id} className="ghost link" data-ops-task={id} onClick={() => props.onOpenTask(id)}>
            {id}
          </button>
        ))}
      </details>
    );
  return (
    <section className="card ops" data-ops>
      <h5>{t(m.opsHeading)}</h5>
      <div className="row head">
        <h5>{t(m.daemonStops)}</h5>
        <nav className="subtabs">
          {([7, 30] as const).map((d) => (
            <button key={d} className={days === d ? "on" : ""} data-days={d} onClick={() => setDays(d)}>
              {t(m.days, { n: d })}
            </button>
          ))}
        </nav>
      </div>
      {failure && <div className="muted" data-ops-error>{t(m.stopsFailed, { error: failure })}</div>}
      {stops?.running && (
        <div className="hint" data-ops-running>
          {t(m.runningSince, { time: fmtClock(stops.running.startedAt) })}
          {stops.running.version ? t(m.paren, { text: stops.running.version }) : ""}
        </div>
      )}
      {table && table.days.length === 0 && <div className="muted">{t(m.noStops)}</div>}
      {table && table.days.length > 0 && (
        <div className="table-scroll">
        <table className="pricing ops-stops-table">
          <thead>
            <tr>
              <th>{t(m.day)}</th>
              {table.reasons.map((r) => (
                <th key={r}>{reasonLabel[r]}</th>
              ))}
              <th>{t(m.cutTurns)}</th>
              <th>Task</th>
            </tr>
          </thead>
          <tbody>
            {[...table.days, table.total].map((d) => (
              <tr key={d.day} data-ops-day={d.day}>
                <td>{d.day}</td>
                {table.reasons.map((r) => (
                  <td key={r} className="num">
                    {d.counts[r]}
                  </td>
                ))}
                <td className="num">{d.turns}</td>
                <td className="num">{tasks(d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <h5>{t(m.hostLoad)}</h5>
      {loadFailure && <div className="muted" data-ops-load-error>{t(m.loadFailed, { error: loadFailure })}</div>}
      {load && !load.available && <div className="muted" data-ops-load-unavailable>{t(m.loadUnavailable)}</div>}
      {load?.available && load.hours.length === 0 && load.groups.length === 0 && <div className="muted">{t(m.noRecords)}</div>}
      {load?.available && load.hours.length > 0 && (
        <div className="table-scroll">
        <table className="pricing ops-load-days">
          <thead>
            <tr>
              <th>{t(m.day)}</th>
              <th>{t(m.peakMemory)}</th>
              <th>{t(m.limitHits)}</th>
              <th>{t(m.peakSwap)}</th>
            </tr>
          </thead>
          <tbody>
            {loadDays(load.hours).map((d) => (
              <tr key={d.day} data-ops-load-day={d.day}>
                <td>{d.day}</td>
                <td className="num">
                  {fmtBytes(d.maxMem)}
                  {d.ratio !== null ? t(m.percentParen, { pct: Math.round(d.ratio * 100) }) : ""}
                </td>
                <td className="num">{d.limitHits}</td>
                <td className="num">{fmtBytes(d.maxSwap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {load?.available && load.groups.length > 0 && (
        <div className="table-scroll">
        <table className="pricing ops-load-top">
          <thead>
            <tr>
              <th>{t(m.heaviest)}</th>
              <th>{t(m.peakRss)}</th>
              <th>{t(m.cpuTime)}</th>
            </tr>
          </thead>
          <tbody>
            {topGroups(load.groups).map((g) => (
              <tr key={g.key} data-ops-load-group={g.label}>
                <td>
                  {g.taskId ? (
                    <button className="ghost link" data-ops-load-task={g.taskId} onClick={() => props.onOpenTask(g.taskId!)}>
                      {g.label}
                    </button>
                  ) : (
                    g.label
                  )}
                </td>
                <td className="num">{fmtBytes(g.maxRss)}</td>
                <td className="num">{t(m.seconds, { n: Math.round(g.cpuMs / 1000) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="row head">
        <h5>{t(m.speed)}</h5>
        <span className="hint">{t(m.speedHint)}</span>
      </div>
      {perfFailure && <div className="muted" data-ops-perf-error>{t(m.speedFailed, { error: perfFailure })}</div>}
      {perf && perf.length === 0 && <div className="muted">{t(m.noRecords)}</div>}
      {perf && perf.length > 0 && (
        <div className="table-scroll">
        <table className="pricing perf" data-ops-perf>
          <thead>
            <tr>
              <th>{t(m.journey)}</th>
              <th>{t(m.device)}</th>
              <th>{t(m.size)}</th>
              <th>{t(m.last7)}</th>
              <th>{t(m.prev7)}</th>
              <th>{t(m.change)}</th>
            </tr>
          </thead>
          <tbody>
            {perf.map((r) => (
              <tr key={`${r.journey}-${r.device}-${r.size}`} className={r.slower ? "slower" : undefined}>
                <td className="mono">{r.journey}</td>
                <td>{r.device}</td>
                <td>{r.size}</td>
                <td className="num">{r.now}</td>
                <td className="num">{r.before}</td>
                <td className="num">{r.change}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="row head">
        <h5>{t(m.apiTimes)}</h5>
        <span className="hint">{t(m.apiTimesHint)}</span>
      </div>
      {latencyFailure && <div className="muted" data-ops-latency-error>{t(m.apiTimesFailed, { error: latencyFailure })}</div>}
      {latency && latency.total.length === 0 && <div className="muted">{t(m.noRecords)}</div>}
      {latency && latency.total.length > 0 && (
        <div className="table-scroll">
        <table className="pricing ops-latency" data-ops-latency>
          <thead>
            <tr>
              <th>{t(m.method)}</th>
              <th>{t(m.route)}</th>
              <th>{t(m.count)}</th>
              <th>{t(m.median)}</th>
              <th>p90</th>
              <th>{t(m.bytesMedian)}</th>
            </tr>
          </thead>
          <tbody>
            {latencyRows(latency).map((r) => (
              <tr key={r.key} data-ops-latency-route={r.key}>
                <td className="mono">{r.method}</td>
                <td className="mono">
                  <details>
                    <summary>{r.route}</summary>
                    {r.days.map((d) => (
                      <div key={d.day} className="hint" data-ops-latency-day={d.day}>
                        {t(m.latencyDay, { day: d.day, p50: d.p50, p90: d.p90, count: d.count })}
                      </div>
                    ))}
                  </details>
                </td>
                <td className="num">{r.count}</td>
                <td className="num">{r.p50}</td>
                <td className="num">{r.p90}</td>
                <td className="num">{r.bytes}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="hint">{t(m.opsFooter)}</div>
    </section>
  );
}
