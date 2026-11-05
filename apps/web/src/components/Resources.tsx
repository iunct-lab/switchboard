import { useEffect, useState } from "react";
import type { OpsResources } from "@switchboard/protocol";
import { api } from "../api.ts";
import { atLabel, consumerRows, etaLine, latestAnswer, memoryLine, runOwner, since, typicalLabel, verdictLabel, waitLine, watchResources } from "../resources.ts";

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
  const task = (t: { taskId: string | null; taskTitle: string | null }) =>
    t.taskId ? (
      <button className="ghost link" data-resources-task={t.taskId} onClick={() => props.onOpenTask(t.taskId!)}>
        {runOwner(t)}
      </button>
    ) : (
      <span className="muted">{runOwner(t)}</span>
    );
  const mem = r && memoryLine(r.memory);
  const eta = r && etaLine(r.eta, r.slots.running.length + r.slots.waiting.length);
  return (
    <main className="main resources">
      <section className="card">
        <div className="row head">
          <h5>Resources</h5>
          <span className="hint">5 秒ごとに更新（この画面を表に出している間だけ）</span>
        </div>
        {failure && <div className="muted" data-resources-error>読めませんでした: {failure}</div>}
        {r && (
          <>
            <div className="resources-stats">
              <div className="resources-stat" data-resources-memory>
                <div className="label">空きメモリ{mem ? `（下限 ${mem.floor}）` : ""}</div>
                {mem ? (
                  <>
                    <div className={`value${mem.below ? " warn" : ""}`}>{mem.free}</div>
                    <span className={`meter${mem.below ? " warn" : ""}`}>
                      <i style={{ width: `${Math.round(mem.usedRatio * 100)}%` }} />
                    </span>
                    <div className="hint">
                      {mem.below ? "下限を下回っています · " : ""}
                      {mem.detail}
                    </div>
                  </>
                ) : (
                  <div className="hint">この環境では測れません（/proc/meminfo が無い）</div>
                )}
              </div>
              <div className="resources-stat" data-resources-slots>
                <div className="label">重い処理の枠</div>
                <div className="value">
                  {r.slots.running.length} / {r.slots.max}
                </div>
                <div className="hint">
                  待ち {r.slots.waiting.length} 件
                  {r.slots.waiting.length > 0 &&
                    `（枠 ${r.slots.waiting.filter((w) => w.reason === "slot").length} · メモリ ${r.slots.waiting.filter((w) => w.reason === "memory").length}）`}
                </div>
              </div>
              <div className="resources-stat" data-resources-eta>
                <div className="label">全部終わるまでの目安</div>
                <div className="value">{eta!.value}</div>
                <div className="hint">
                  {eta!.note ? `${eta!.note} · ` : ""}空きメモリの回復にかかる時間は含まない
                </div>
              </div>
            </div>
            <h5>待っている実行</h5>
            {r.slots.waiting.length === 0 ? (
              <div className="muted">ありません</div>
            ) : (
              <table className="pricing" data-resources-waiting>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>実行</th>
                    <th>何を待っているか</th>
                    <th>待ち時間</th>
                    <th>普段</th>
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
                </tbody>
              </table>
            )}
            <h5>いま走っている実行</h5>
            {r.slots.running.length === 0 ? (
              <div className="muted">ありません</div>
            ) : (
              <table className="pricing" data-resources-running>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>実行</th>
                    <th>作業フォルダ</th>
                    <th>経過</th>
                    <th>普段（中央値）</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  {r.slots.running.map((x) => (
                    <tr key={`${x.pid}/${x.startedAt}`} data-resources-run={x.name}>
                      <td>{task(x)}</td>
                      <td>{x.name}</td>
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
            )}
            <div className="row head">
              <h5>メモリを使っているもの</h5>
              {r.consumers && <span className="hint">{atLabel(r.consumers.at)}（毎分の記録）</span>}
            </div>
            {!r.consumers ? (
              <div className="muted">記録がありません</div>
            ) : (
              <table className="pricing" data-resources-consumers>
                <thead>
                  <tr>
                    <th>もの</th>
                    <th>種類</th>
                    <th>RSS</th>
                    <th>プロセス</th>
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
            )}
            <div className="hint">ops-kit heavy を通った実行だけが「待っている」「走っている」に出ます。</div>
          </>
        )}
      </section>
    </main>
  );
}
