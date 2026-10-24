import { useEffect, useState } from "react";
import type { OpsLatency, OpsLoad, OpsStops } from "@switchboard/protocol";
import { api } from "../api.ts";
import { fmtBytes, latencyRows, loadDays, reasonLabel, stopsTable, topGroups, type StopsDay } from "../ops.ts";
import { perfRows, type PerfRow } from "../perf.ts";
import { fmtClock } from "./ui.tsx";

/**
 * 運用 (#2085): the host's own numbers, apart from the per-Task evaluations. デーモンの停止 = how often the daemon
 * stopped and why, and the turns it cut; ホストの負荷 (#2086) = the unit's daily peaks and the heaviest task × kind
 * (docs/design/ops-metrics.md); 速さ (#2104) = the everyday journeys, the last 7 days against the 7 before them, and
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
      <h5>運用</h5>
      <div className="row head">
        <h5>デーモンの停止</h5>
        <nav className="subtabs">
          {([7, 30] as const).map((d) => (
            <button key={d} className={days === d ? "on" : ""} data-days={d} onClick={() => setDays(d)}>
              {d} 日
            </button>
          ))}
        </nav>
      </div>
      {failure && <div className="muted" data-ops-error>停止の記録を読めませんでした: {failure}</div>}
      {stops?.running && (
        <div className="hint" data-ops-running>
          いまの起動: {fmtClock(stops.running.startedAt)}
          {stops.running.version ? `（${stops.running.version}）` : ""}
        </div>
      )}
      {table && table.days.length === 0 && <div className="muted">この期間の停止はありません</div>}
      {table && table.days.length > 0 && (
        <table className="pricing ops-stops-table">
          <thead>
            <tr>
              <th>日</th>
              {table.reasons.map((r) => (
                <th key={r}>{reasonLabel[r]}</th>
              ))}
              <th>中断ターン</th>
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
      )}
      <h5>ホストの負荷</h5>
      {loadFailure && <div className="muted" data-ops-load-error>負荷の記録を読めませんでした: {loadFailure}</div>}
      {load && !load.available && <div className="muted" data-ops-load-unavailable>この環境では測れません（cgroup と /proc が読めない環境）</div>}
      {load?.available && load.hours.length === 0 && load.groups.length === 0 && <div className="muted">この期間の記録はありません</div>}
      {load?.available && load.hours.length > 0 && (
        <table className="pricing ops-load-days">
          <thead>
            <tr>
              <th>日</th>
              <th>最大メモリ</th>
              <th>上限到達</th>
              <th>最大スワップ</th>
            </tr>
          </thead>
          <tbody>
            {loadDays(load.hours).map((d) => (
              <tr key={d.day} data-ops-load-day={d.day}>
                <td>{d.day}</td>
                <td className="num">
                  {fmtBytes(d.maxMem)}
                  {d.ratio !== null ? `（${Math.round(d.ratio * 100)}%）` : ""}
                </td>
                <td className="num">{d.limitHits}</td>
                <td className="num">{fmtBytes(d.maxSwap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {load?.available && load.groups.length > 0 && (
        <table className="pricing ops-load-top">
          <thead>
            <tr>
              <th>負荷を上げたもの</th>
              <th>最大 RSS</th>
              <th>CPU 時間</th>
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
                <td className="num">{Math.round(g.cpuMs / 1000)} 秒</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row head">
        <h5>速さ</h5>
        <span className="hint">直近 7 日 vs その前の 7 日。中央値が 20% 以上遅いと赤</span>
      </div>
      {perfFailure && <div className="muted" data-ops-perf-error>速さの記録を読めませんでした: {perfFailure}</div>}
      {perf && perf.length === 0 && <div className="muted">この期間の記録はありません</div>}
      {perf && perf.length > 0 && (
        <table className="pricing perf" data-ops-perf>
          <thead>
            <tr>
              <th>ジャーニー</th>
              <th>端末</th>
              <th>大きさ</th>
              <th>直近 7 日（中央値 / p90）</th>
              <th>その前の 7 日</th>
              <th>変化</th>
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
      )}
      <div className="row head">
        <h5>API の所要時間</h5>
        <span className="hint">p90 の遅い順に 10 件。記録は 7 日分まで。route を開くと日ごと</span>
      </div>
      {latencyFailure && <div className="muted" data-ops-latency-error>API の所要時間を読めませんでした: {latencyFailure}</div>}
      {latency && latency.total.length === 0 && <div className="muted">この期間の記録はありません</div>}
      {latency && latency.total.length > 0 && (
        <table className="pricing ops-latency" data-ops-latency>
          <thead>
            <tr>
              <th>メソッド</th>
              <th>経路</th>
              <th>件数</th>
              <th>中央値</th>
              <th>p90</th>
              <th>バイト（中央値）</th>
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
                        {d.day}: {d.p50} / {d.p90}（{d.count} 件）
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
      )}
      <div className="hint">記録はこのデーモンの DB にだけあり（速さは 30 日、API は 7 日）、外には送りません。</div>
    </section>
  );
}
