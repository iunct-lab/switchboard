import { useEffect, useMemo, useState } from "react";
import type { EvalsListRow, RunnerId, RunnerInfo, Workspace } from "@switchboard/protocol";
import { api } from "../api.ts";
import { evalCells, evalFilterOptions, evalRowWarn, filterEvalRows, firstSortDir, sortEvalRows, type EvalsSortKey } from "../evals.ts";
import { fmtClock, fmtUsd, RunnerPill } from "./ui.tsx";
import { outcomeLabel } from "../attention.ts";
import { Reports } from "./Reports.tsx";
import { Ops } from "./Ops.tsx";

const COLUMNS: Array<{ key: EvalsSortKey | null; label: string; title?: string }> = [
  { key: null, label: "Task" },
  { key: null, label: "ランナー" },
  { key: null, label: "モデル" },
  { key: null, label: "思考の深さ" },
  { key: null, label: "状態" },
  { key: "toolCalls", label: "ツール" },
  { key: "toolFailures", label: "失敗" },
  { key: "errors", label: "エラー" },
  { key: "userInstructions", label: "追加指示" },
  { key: "stops", label: "停止" },
  { key: null, label: "終わり方" },
  { key: "judge", label: "ルーブリック", title: "観点の平均（1〜5）" },
  { key: "human", label: "自分の評価" },
  { key: "costUsd", label: "費用" },
  { key: "updatedAt", label: "更新" },
  { key: null, label: "", title: "操作" },
];

/**
 * The Insights screen: the reports across Tasks on top (#1835), then every task's evaluations side by side (#1221) — the
 * daemon filters, the screen sorts; a row opens the Task.
 */
export function Evals(props: { workspaces: Workspace[]; runners?: RunnerInfo[]; onOpenTask: (id: string) => void; onError: (msg: string) => void; /** bumped on every evals.updated: a judge or a rating that finished while the screen is open */ rev?: number; /** 改善要望にする (#1221) */ onImprove?: (taskId: string) => void; /** the report to open first (Home's line, #1835) */ openReport?: string; /** the レポート section's list: the HTML ones or every artifact (#1833) */ scope: "reports" | "all"; onScope: (scope: "reports" | "all") => void; /** a report's Task, with that artifact selected on its 成果物 tab (#1835) */ onOpenArtifact: (taskId: string, artifactId: string) => void }) {
  const [rows, setRows] = useState<EvalsListRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [runner, setRunner] = useState("");
  const [limit, setLimit] = useState(100);
  // the model and effort are filtered on the rows read, not by the daemon (#1801)
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [sort, setSort] = useState<{ key: EvalsSortKey; dir: "asc" | "desc" }>({ key: "updatedAt", dir: "desc" });
  useEffect(() => {
    let live = true;
    api
      .evalsList({ workspaceId: workspaceId || undefined, runner: runner || undefined, limit })
      .then((r) => {
        if (!live) return;
        setRows(r);
        setFailed(false); // a failed read stays on screen until a later one succeeds or fails again
      })
      .catch((e) => {
        if (!live) return;
        setRows([]);
        setFailed(true);
        props.onError(String(e.message ?? e));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is App's stable setter; rev re-reads after a judge or a rating lands
  }, [workspaceId, runner, limit, props.rev]);
  const sorted = useMemo(() => (rows ? sortEvalRows(filterEvalRows(rows, { model, effort }), sort.key, sort.dir) : []), [rows, sort, model, effort]);
  const options = useMemo(() => evalFilterOptions(rows ?? []), [rows]);
  const withCurrent = (values: string[], current: string) => (current && !values.includes(current) ? [...values, current] : values);
  // the first click on a score column shows the weak tasks first (ascending); on a count, the heavy ones first (descending)
  const sortBy = (key: EvalsSortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: firstSortDir(key) }));
  const wsName = (id: string | null) => (id ? (props.workspaces.find((w) => w.id === id)?.name ?? id) : "");
  return (
    <main className="main ledger evals-screen">
      <Reports openId={props.openReport} scope={props.scope} onScope={props.onScope} onOpenTask={props.onOpenArtifact} onError={props.onError} />
      <Ops onOpenTask={props.onOpenTask} />
      <section className="card">
        <h5>Insights · Task ごとの評価</h5>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="mode" value={workspaceId} aria-label="Workspace" onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">すべての Workspace</option>
            {props.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select className="mode" value={runner} aria-label="ランナー" onChange={(e) => setRunner(e.target.value)}>
            <option value="">すべてのランナー</option>
            {(props.runners ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
          <select className="mode" value={model} aria-label="モデル" onChange={(e) => setModel(e.target.value)}>
            <option value="">すべてのモデル</option>
            {withCurrent(options.models, model).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select className="mode" value={effort} aria-label="思考の深さ" onChange={(e) => setEffort(e.target.value)}>
            <option value="">すべての思考の深さ</option>
            {withCurrent(options.efforts, effort).map((v) => (
              <option key={v} value={v}>
                {v === "-" ? "CLI 既定" : v}
              </option>
            ))}
          </select>
          <select className="mode" value={limit} aria-label="件数" onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n} 件
              </option>
            ))}
          </select>
          <span className="hint">見出しを押すと並べ替え（もう一度で逆順）。失敗・エラー・停止、平均 2.5 以下、自分の評価 2 以下は amber。</span>
        </div>
        {rows === null && <div className="muted">読み込み中…</div>}
        {rows && rows.length === 0 && <div className="muted">{failed ? "読み込めませんでした" : "Task がありません"}</div>}
        {rows && rows.length > 0 && sorted.length === 0 && <div className="muted">条件に合う Task がありません</div>}
        {rows && sorted.length > 0 && (
          <table className="pricing evals-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.label || c.title} title={c.title} aria-label={c.label ? undefined : c.title} aria-sort={c.key && sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {c.key ? (
                      <button className="ghost sort" onClick={() => sortBy(c.key!)}>
                        {c.label}
                        {sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const cells = evalCells(r, props.runners?.find((x) => x.id === r.runner));
                const warn = evalRowWarn(r);
                return (
                  <tr key={r.taskId} className={warn ? "warn" : undefined}>
                    <td>
                      <button className="ghost open" onClick={() => props.onOpenTask(r.taskId)} title={`${r.taskId}${r.workspaceId ? ` · ${wsName(r.workspaceId)}` : ""}`}>
                        {r.title}
                      </button>
                    </td>
                    <td>
                      <RunnerPill runner={r.runner as RunnerId} />
                    </td>
                    <td>
                      {cells.model}
                      {cells.mixed && (
                        <>
                          {" "}
                          <span className="tag" title={`途中でモデルを変えた Task: ${cells.model}`}>
                            混在
                          </span>
                        </>
                      )}
                    </td>
                    <td>{cells.effort}</td>
                    <td>
                      {r.status} · {outcomeLabel(r.outcome)}
                    </td>
                    <td className="num">{r.rules ? r.rules.toolCalls : "-"}</td>
                    <td className={`num${r.rules && r.rules.toolFailures > 0 ? " warn" : ""}`}>{r.rules ? r.rules.toolFailures : "-"}</td>
                    <td className={`num${r.rules && r.rules.errors > 0 ? " warn" : ""}`}>{r.rules ? r.rules.errors : "-"}</td>
                    <td className="num">{r.rules ? r.rules.userInstructions : "-"}</td>
                    <td className={`num${r.rules && r.rules.stops > 0 ? " warn" : ""}`}>{r.rules ? r.rules.stops : "-"}</td>
                    <td>{cells.end}</td>
                    <td className={`num${r.judge && r.judge.average <= 2.5 ? " warn" : ""}`} title={r.judge ? `${r.judge.by} · ${r.judge.rubric}` : undefined}>
                      {cells.judge}
                    </td>
                    <td className={`num${r.human && r.human.rating <= 2 ? " warn" : ""}`} title={r.human?.comment || undefined}>
                      {cells.human}
                    </td>
                    <td className="num">{fmtUsd(r.costUsd)}</td>
                    <td className="num">{fmtClock(r.updatedAt)}</td>
                    <td>
                      {props.onImprove && (
                        <button className="ghost" onClick={() => props.onImprove?.(r.taskId)} title="この Task の評価を下書きにして、改善の要望を登録するダイアログを開きます">
                          改善要望にする
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="hint">新しい順に {limit} 件まで。評価の無い Task は「-」。</div>
      </section>
    </main>
  );
}
