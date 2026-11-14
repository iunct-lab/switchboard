import { useEffect, useState } from "react";
import type { OpsResources } from "@switchboard/protocol";
import { api } from "../api.ts";
import { atLabel, consumerRows, jobRow, latestAnswer, memoryLine, runOwner, since, slotsSummary, taskWaitLine, typicalLabel, verdictLabel, waitLine, watchResources } from "../resources.ts";
import { t } from "../i18n.ts";
import { common as m } from "../i18n/common.ts";

/**
 * Resources (#3333, docs/design/ops-metrics.md): now — the free memory against the floor, the machine's heavy-process
 * slots, who waits for what, what runs (against the usual time of its kind, #3336), when all of it would be done, and
 * what used the memory at the sampler's last minute. Read every 5 s only
 * while this screen is open and in front. Only what goes through `ops-kit heavy` is a run here.
 */
export function Resources(props: { onOpenTask: (id: string) => void }) {
  const [r, setR] = useState<OpsResources | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    const order = latestAnswer();
    const stop = watchResources(document, () => {
      // an answer that comes after a newer one is dropped: the screen never goes back to an older state
      const mine = order.ask();
      api
        .opsResources()
        .then((x) => {
          if (!live || !order.take(mine)) return;
          setR(x);
          setNow(Date.now());
          setFailure(null);
        })
        .catch((e) => live && order.take(mine) && setFailure(String(e.message ?? e)));
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  const task = (x: { taskId: string | null; taskTitle: string | null }) =>
    x.taskId ? (
      <button className="ghost link" data-resources-task={x.taskId} onClick={() => props.onOpenTask(x.taskId!)}>
        {runOwner(x)}
      </button>
    ) : (
      <span className="muted">{runOwner(x)}</span>
    );
  const mem = r && memoryLine(r.memory);
  const summary = r && slotsSummary(r);
  const eta = summary && summary.eta;
  return (
    <main className="main resources">
      <section className="card">
        <div className="row head">
          <h5>Resources</h5>
          <span className="hint">{t(m.resPolling)}</span>
        </div>
        {failure && <div className="muted" data-resources-error>{t(m.resFailed, { error: failure })}</div>}
        {r && (
          <>
            <div className="resources-stats">
              <div className="resources-stat" data-resources-memory>
                <div className="label">{t(m.resFreeMemory)}{mem ? t(m.resFloor, { floor: mem.floor }) : ""}</div>
                {mem ? (
                  <>
                    <div className={`value${mem.below ? " warn" : ""}`}>{mem.free}</div>
                    <span className={`meter${mem.below ? " warn" : ""}`}>
                      <i style={{ width: `${Math.round(mem.usedRatio * 100)}%` }} />
                    </span>
                    <div className="hint">
                      {mem.below ? t(m.resBelowFloor) : ""}
                      {mem.detail}
                    </div>
                  </>
                ) : (
                  <div className="hint">{t(m.resNoMeminfo)}</div>
                )}
              </div>
              <div className="resources-stat" data-resources-slots>
                <div className="label">{t(m.resSlots)}</div>
                <div className="value">
                  {r.slots.running.length} / {r.slots.max}
                </div>
                <div className="hint">
                  {summary!.waiting}
                </div>
              </div>
              <div className="resources-stat" data-resources-eta>
                <div className="label">{t(m.resEta)}</div>
                <div className="value">{eta!.value}</div>
                <div className="hint">
                  {eta!.note ? `${eta!.note} · ` : ""}{t(m.resEtaExcludes)}
                </div>
              </div>
            </div>
            <h5>{t(m.resWaitingHeading)}</h5>
            {r.slots.waiting.length + r.taskWaits.length === 0 ? (
              <div className="muted">{t(m.resNone)}</div>
            ) : (
              <div className="table-scroll">
              <table className="pricing" data-resources-waiting>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>{t(m.resColRun)}</th>
                    <th>{t(m.resColWaitsFor)}</th>
                    <th>{t(m.resColWaited)}</th>
                    <th>{t(m.resColTypical)}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.slots.waiting.map((w) => (
                    <tr key={`${w.pid}/${w.queuedAt}`} data-resources-wait={w.name}>
                      <td>{task(w)}</td>
                      <td>{w.name}</td>
                      <td>{waitLine(w, r.slots.running, r.memory)}</td>
                      <td className="num">{since(w.queuedAt, now)}</td>
                      <td className="num" data-resources-typical>{typicalLabel(w)}</td>
                    </tr>
                  ))}
                  {r.taskWaits.map((w) => (
                    <tr key={`task/${w.taskId}/${w.queuedAt}`} data-resources-task-wait={w.taskId}>
                      <td>{task(w)}</td>
                      <td>{t(m.resTaskStart)}</td>
                      <td>{taskWaitLine(r.memory)}</td>
                      <td className="num">{since(w.queuedAt, now)}</td>
                      <td className="num" data-resources-typical>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <h5>{t(m.resRunningHeading)}</h5>
            {r.slots.running.length + r.slots.beside.length === 0 ? (
              <div className="muted">{t(m.resNone)}</div>
            ) : (
              <div className="table-scroll">
              <table className="pricing" data-resources-running>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>{t(m.resColRun)}</th>
                    <th>{t(m.resColCwd)}</th>
                    <th>{t(m.resColElapsed)}</th>
                    <th>{t(m.resColTypicalMedian)}</th>
                    <th>{t(m.resColVerdict)}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.slots.running.map((x) => ({ x, beside: false })), ...r.slots.beside.map((x) => ({ x, beside: true }))].map(({ x, beside }) => (
                    <tr key={`${x.pid}/${x.startedAt}`} data-resources-run={x.name}>
                      <td>{task(x)}</td>
                      <td>
                        {x.name}
                        {beside && <span className="hint" data-resources-beside> {t(m.resBeside)}</span>}
                      </td>
                      <td className="mono">{x.cwd}</td>
                      <td className="num">{since(x.startedAt, now)}</td>
                      <td className="num" data-resources-typical>{typicalLabel(x)}</td>
                      <td data-resources-verdict={x.verdict}>
                        {x.verdict === "long" ? <span className="hint warn">▲ {verdictLabel(x)}</span> : <span className="muted">{verdictLabel(x)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <div className="row head">
              <h5>{t(m.resJobsHeading)}</h5>
              <span className="hint">{t(m.resJobsHint)}</span>
            </div>
            {r.jobs.length === 0 ? (
              <div className="muted">{t(m.resNone)}</div>
            ) : (
              <div className="table-scroll">
              <table className="pricing" data-resources-jobs>
                <thead>
                  <tr>
                    <th>id</th>
                    <th>{t(m.resColKind)}</th>
                    <th>PR</th>
                    <th>Task</th>
                    <th>{t(m.resColStatus)}</th>
                    <th>{t(m.resColElapsed)}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.jobs.map((j) => {
                    const row = jobRow(j, now);
                    return (
                      <tr key={j.id} data-resources-job={j.id}>
                        <td className="mono">job#{j.id}</td>
                        <td>{row.kind}</td>
                        <td className="num">#{j.pr}</td>
                        <td>{task(j)}</td>
                        <td data-resources-job-status={j.status}>{j.status === "fail" || j.status === "aborted" ? <span className="hint warn">{row.status}</span> : row.status}</td>
                        <td className="num">{row.elapsed}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
            <div className="row head">
              <h5>{t(m.resConsumersHeading)}</h5>
              {r.consumers && <span className="hint">{atLabel(r.consumers.at)}{t(m.resPerMinute)}</span>}
            </div>
            {!r.consumers ? (
              <div className="muted">{t(m.resNoRecord)}</div>
            ) : (
              <div className="table-scroll">
              <table className="pricing" data-resources-consumers>
                <thead>
                  <tr>
                    <th>{t(m.resColWhat)}</th>
                    <th>{t(m.resColKind)}</th>
                    <th>RSS</th>
                    <th>{t(m.resColProcs)}</th>
                  </tr>
                </thead>
                <tbody>
                  {consumerRows(r.consumers).map((g) => (
                    <tr key={g.key}>
                      <td>{g.taskId ? task(g) : g.label}</td>
                      <td>{g.kind}</td>
                      <td className="num">{g.rss}</td>
                      <td className="num">{g.procs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <div className="hint">{t(m.resFooter)}</div>
          </>
        )}
      </section>
    </main>
  );
}
