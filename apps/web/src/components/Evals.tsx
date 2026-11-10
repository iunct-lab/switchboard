import { useEffect, useMemo, useState } from "react";
import type { EvalsListRow, EvalsSummary, RunnerId, RunnerInfo, Workspace } from "@switchboard/protocol";
import { api } from "../api.ts";
import { evalCells, evalFilterOptions, evalRowWarn, filterEvalRows, firstSortDir, gapLabel, sortEvalRows, type EvalsSortKey } from "../evals.ts";
import { fmtClock, fmtUsd, RunnerPill } from "./ui.tsx";
import { outcomeLabel } from "../attention.ts";
import { Reports } from "./Reports.tsx";
import { Ops } from "./Ops.tsx";
import { t } from "../i18n.ts";
import { insights as m } from "../i18n/insights.ts";

const COLUMNS: Array<{ key: EvalsSortKey | null; label: string; title?: string }> = [
  { key: null, label: "Task" },
  { key: null, label: t(m.runner) },
  { key: null, label: t(m.model) },
  { key: null, label: t(m.colEffort) },
  { key: null, label: t(m.colSubagentEffort) },
  { key: null, label: t(m.colStatus) },
  { key: "toolCalls", label: t(m.colTools) },
  { key: "toolFailures", label: t(m.failures) },
  { key: "errors", label: t(m.errors) },
  { key: "userInstructions", label: t(m.userInstructions) },
  { key: "stops", label: t(m.stops) },
  { key: "daemonStops", label: t(m.daemonStopsShort) },
  { key: null, label: t(m.ending) },
  { key: "judge", label: t(m.colRubric), title: t(m.colRubricTitle) },
  { key: "human", label: t(m.colHuman) },
  { key: "costUsd", label: t(m.colCost) },
  { key: "updatedAt", label: t(m.colUpdated) },
  { key: null, label: "", title: t(m.colActions) },
];

/**
 * The Insights screen: the reports across Tasks on top (#1835), then every task's evaluations side by side (#1221) — the
 * daemon filters, the screen sorts; a row opens the Task.
 */
export function Evals(props: { workspaces: Workspace[]; runners?: RunnerInfo[]; onOpenTask: (id: string) => void; /** 評価をお願い (#1877): the Task with its Brief open at 自分の評価 */ onRateTask: (id: string) => void; onError: (msg: string) => void; /** bumped on every evals.updated: a judge or a rating that finished while the screen is open */ rev?: number; /** 改善要望にする (#1221) */ onImprove?: (taskId: string) => void; /** the report to open first (Home's line, #1835) */ openReport?: string; /** the レポート section's list: the HTML ones or every artifact (#1833) */ scope: "reports" | "all"; onScope: (scope: "reports" | "all") => void; /** a report's Task, with that artifact selected on its 成果物 tab (#1835) */ onOpenArtifact: (taskId: string, artifactId: string) => void }) {
  const [rows, setRows] = useState<EvalsListRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [runner, setRunner] = useState("");
  const [limit, setLimit] = useState(100);
  // the model and effort are filtered on the rows read, not by the daemon (#1801)
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [subagentEffort, setSubagentEffort] = useState("");
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
  // 評価をお願い (#1877): read with the list's workspace and again on evals.updated; a failure shows in the section only
  const [summary, setSummary] = useState<EvalsSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .evalsSummary({ workspaceId: workspaceId || undefined })
      .then((r) => {
        if (!live) return;
        setSummary(r);
        setSummaryFailed(false);
      })
      .catch(() => {
        if (live) setSummaryFailed(true);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, props.rev]);
  const sorted = useMemo(() => (rows ? sortEvalRows(filterEvalRows(rows, { model, effort, subagentEffort }), sort.key, sort.dir) : []), [rows, sort, model, effort, subagentEffort]);
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
        <h5>{t(m.askHeading)}</h5>
        {summaryFailed ? (
          <div className="muted">{t(m.loadFailedShort)}</div>
        ) : summary === null ? (
          <div className="muted">{t(m.loading)}</div>
        ) : (
          <>
            {summary.sample.length === 0 ? (
              <div className="muted">{t(m.noneJudgedLastWeek)}</div>
            ) : (
              <div className="table-scroll">
              <table className="pricing evals-table evals-ask">
                <tbody>
                  {summary.sample.map((r) => (
                    <tr key={r.taskId}>
                      <td>
                        <button className="ghost open" onClick={() => props.onRateTask(r.taskId)} title={r.taskId}>
                          {r.title}
                        </button>
                      </td>
                      <td>
                        <RunnerPill runner={r.runner as RunnerId} />
                      </td>
                      <td className="num">{r.judge ? r.judge.average.toFixed(1) : "-"}</td>
                      <td className="num">{r.human ? `${r.human.rating} / 5` : t(m.notYet)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <div className="hint">{t(m.gapLine, { gap: gapLabel(summary.gap) })}</div>
          </>
        )}
      </section>
      <section className="card">
        <h5>{t(m.listHeading)}</h5>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="mode" value={workspaceId} aria-label="Workspace" onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">{t(m.allWorkspaces)}</option>
            {props.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select className="mode" value={runner} aria-label={t(m.runner)} onChange={(e) => setRunner(e.target.value)}>
            <option value="">{t(m.allRunners)}</option>
            {(props.runners ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
          <select className="mode" value={model} aria-label={t(m.model)} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t(m.allModels)}</option>
            {withCurrent(options.models, model).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select className="mode" value={effort} aria-label={t(m.colEffort)} onChange={(e) => setEffort(e.target.value)}>
            <option value="">{t(m.allEfforts)}</option>
            {withCurrent(options.efforts, effort).map((v) => (
              <option key={v} value={v}>
                {v === "-" ? t(m.cliDefault) : v}
              </option>
            ))}
          </select>
          <select className="mode" value={subagentEffort} aria-label={t(m.colSubagentEffort)} onChange={(e) => setSubagentEffort(e.target.value)}>
            <option value="">{t(m.allSubagentEfforts)}</option>
            {withCurrent(options.subagentEfforts, subagentEffort).map((v) => (
              <option key={v} value={v}>
                {v === "-" ? "—" : v}
              </option>
            ))}
          </select>
          <select className="mode" value={limit} aria-label={t(m.count)} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {t(m.rows, { n })}
              </option>
            ))}
          </select>
          <span className="hint">{t(m.sortHint)}</span>
        </div>
        {rows === null && <div className="muted">{t(m.loading)}</div>}
        {rows && rows.length === 0 && <div className="muted">{failed ? t(m.loadFailedShort) : t(m.noTasks)}</div>}
        {rows && rows.length > 0 && sorted.length === 0 && <div className="muted">{t(m.noMatch)}</div>}
        {rows && sorted.length > 0 && (
          <div className="table-scroll">
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
                          <span className="tag" title={t(m.mixedTitle, { model: cells.model })}>
                            {t(m.mixed)}
                          </span>
                        </>
                      )}
                    </td>
                    <td>
                      {cells.effort}
                      {cells.effortMixed && (
                        <>
                          {" "}
                          <span className="tag" title={t(m.mixedEffortTitle, { effort: cells.effort })}>
                            {t(m.mixed)}
                          </span>
                        </>
                      )}
                    </td>
                    <td>{cells.subagentEffort}</td>
                    <td>
                      {r.status} · {outcomeLabel(r.outcome)}
                    </td>
                    <td className="num">{r.rules ? r.rules.toolCalls : "-"}</td>
                    <td className={`num${r.rules && r.rules.toolFailures > 0 ? " warn" : ""}`}>{r.rules ? r.rules.toolFailures : "-"}</td>
                    <td className={`num${r.rules && r.rules.errors > 0 ? " warn" : ""}`}>{r.rules ? r.rules.errors : "-"}</td>
                    <td className="num">{r.rules ? r.rules.userInstructions : "-"}</td>
                    <td className={`num${r.rules && r.rules.stops > 0 ? " warn" : ""}`}>{r.rules ? r.rules.stops : "-"}</td>
                    <td className={`num${r.rules && r.rules.daemonStops > 0 ? " warn" : ""}`}>{r.rules ? r.rules.daemonStops : "-"}</td>
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
                        <button className="ghost" onClick={() => props.onImprove?.(r.taskId)} title={t(m.improveTitle)}>
                          {t(m.improve)}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        <div className="hint">{t(m.listFooter, { limit })}</div>
      </section>
    </main>
  );
}
