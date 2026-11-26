import { useEffect, useMemo, useState } from "react";
import { type Ask, type CreateTaskInput, type LedgerSummary, type ReportRow, type RunnerId, type Schedule, type Task, type TaskStopMark, type TaskSummary, type Workspace } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { type Health } from "../api/daemon.ts";
import { fmtUsd, OriginTag, pct, ResumeTag, RunnerPill, ShadowTag, WorkspaceTag } from "./ui.tsx";
import { workspaceTag } from "../taskList.ts";
import { activeLabel, attentionGroups, isActive, type AttentionGroup, outcomeDotClass, outcomeLabel } from "../attention.ts";
import { reportMeta } from "../reports.ts";
import { accountMark, quotaAsOf, quotaStale, resetLabel, windowLabel } from "../quota.ts";
import { PresetReplies } from "./PresetReplies.tsx";
import { repliesFor } from "../presetReplies.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";
import { ago } from "../inProgress.ts";
import { REASON_LABEL } from "../interventions.ts";
import { stuckLine, stuckSchedules } from "../stuck.ts";
import { readStall } from "../queueStall.ts";
import { StallRows } from "./Approvals.tsx";
import { Compose } from "./Compose.tsx";

/** How many 要対応 rows (groups) show before すべて. */
const ATTENTION_SHOWN = 8;

export function Home(props: {
  health: Health | null;
  workspaces: Workspace[];
  tasks: TaskSummary[];
  ledger: LedgerSummary | null;
  runnerOk: Set<RunnerId>;
  onCreate: (input: CreateTaskInput) => Promise<void>;
  onOpenTask: (id: string) => void;
  onError: (msg: string) => void;
  /** Moves on each stop record: the stuck schedules are read again. */
  stopRev: number;
  /** The last stop of each Task; null until read. Home draws the marks from it. */
  stopMarks: Record<string, TaskStopMark> | null;
  onOpenSettings: () => void;
  /** The screen the instruction is sent from, by the name `screenLabel` gives. */
  screen: string;
  /** A Task that 「バックログに積む」 or 「要望にしてすぐ直す」 started: shown and opened. */
  onSent: (task: Task) => void;
  /** Settings scrolled to its Workspace card (the 「設定で追加 →」 when there is none yet). */
  onOpenWorkspaces: () => void;
  /** The newest report's line: opens Insights with it. */
  onOpenReport: (id: string) => void;
  /** Insights' レポート section with every artifact */
  onOpenArtifacts: () => void;
}) {
  // The newest report across Tasks, read once per visit to Home, and whether any artifact exists: the
  // レポート heading and its link to every artifact show when either does; nothing at all when neither does.
  const [latestReport, setLatestReport] = useState<ReportRow | null>(null);
  const [anyArtifact, setAnyArtifact] = useState(false);
  useEffect(() => {
    let alive = true;
    api.reports({ limit: 1 }).then((r) => alive && setLatestReport(r[0] ?? null), () => undefined);
    api.allArtifacts({ limit: 1 }).then((r) => alive && setAnyArtifact(r.length > 0), () => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const active = useMemo(() => props.tasks.filter(isActive), [props.tasks]);
  const sendReply = (id: string) => async (text: string) => { await api.send(id, text); };
  const { needs, waiting } = useMemo(() => attentionGroups(props.tasks, props.stopMarks), [props.tasks, props.stopMarks]);
  // 確認済み of a group: the existing setOutcome for each Task, not a new API; the rows leave with the tasks' events
  const reviewGroup = async (g: AttentionGroup) => {
    try {
      await Promise.all(g.tasks.map((x) => api.setOutcome(x.id, { reviewed: true })));
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    }
  };
  // Schedules whose Tasks stopped the same way in a row: read on arriving, when any Task's row changed (a reply, the
  // next Task ending), on each stop record (a stop or one resolved within a turn moves no row) and when a stall reaches its
  // limit, not on other events; on the same signals, the backlog queue: only while it is stalled are the questions read,
  // for its one notice, and only while that notice is not there yet is the limit read
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [stall, setStall] = useState<Ask | null>(null);
  const tasksAt = useMemo(() => props.tasks.reduce((m, x) => Math.max(m, x.updatedAt), 0), [props.tasks]);
  // a stall that reaches its limit (Settings) while Home stays open raises its notice with no event, so the queue is read
  // again at that time (`stallTick` moves the effect); the limit is read only then, so a changed limit is seen
  const [stallTick, setStallTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    api.schedules().then((r) => alive && setSchedules(r), () => undefined);
    // the time before the requests: the daemon judges the notice when it takes them, so a read that crosses the limit
    // on its way back still sets a clock
    const at = Date.now();
    readStall(api, at).then(({ ask, wait }) => {
      if (!alive) return;
      if (wait !== null) timer = setTimeout(() => setStallTick((n) => n + 1), wait);
      setStall(ask);
    }, () => undefined);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tasksAt, props.tasks.length, props.stopRev, stallTick]);
  const stuck = useMemo(() => stuckSchedules(schedules), [schedules]);
  // the first ones: 60 rows pushed the cost and the reports five screens down on a phone
  const [allAttention, setAllAttention] = useState(false);
  const recent = useMemo(() => {
    const listed = new Set([...needs.flatMap((g) => g.tasks), ...waiting.map((w) => w.task)].map((t) => t.id));
    return props.tasks.filter((t) => !isActive(t) && !listed.has(t.id)).slice(0, 6);
  }, [props.tasks, needs, waiting]);

  return (
    <main className="main home">
      {!props.workspaces.some((w) => w.kind === "repo") && (
        <section className="card">
          <div className="row">
            <span>{t(home.noWorkspace)}</span>
            <button onClick={props.onOpenWorkspaces}>{t(home.addInSettings)}</button>
          </div>
        </section>
      )}
      <Compose health={props.health} workspaces={props.workspaces} runnerOk={props.runnerOk} onCreate={props.onCreate} onError={props.onError} onOpenSettings={props.onOpenSettings} screen={props.screen} onSent={props.onSent} />

      {stuck.length > 0 && (
        <section className="card stuck-schedules">
          <h5>{t(home.stuckHeading, { count: stuck.length })}</h5>
          {stuck.map((s) => (
            <button key={s.id} className="row link stuck" onClick={() => props.onOpenTask(s.stuck.taskId)}>
              <span className="dot err" />
              <span className="t">
                {s.title}
                <br />
                <span className="why">{stuckLine(s, Date.now())}</span>
              </span>
              <span className="m">{t(home.stuckOpen)}</span>
            </button>
          ))}
        </section>
      )}

      <div className="grid2">
        <section className="card">
          <h5>{t(home.activeHeading)}</h5>
          {active.length === 0 && <div className="muted">{t(home.none)}</div>}
          {active.map((x) => (
            <button key={x.id} className="row link" onClick={() => props.onOpenTask(x.id)}>
              <span className={`dot ${x.status === "waiting" ? "wait" : x.status === "idle" ? "idle" : "run"}`} />
              <span className="t">{x.title}</span>
              <WorkspaceTag name={workspaceTag(props.workspaces, x.workspaceId)} />
              <RunnerPill runner={x.runner} />
              <ShadowTag task={x} />
              <span className="m">{activeLabel(x)}</span>
            </button>
          ))}
          <h5 style={{ marginTop: 14 }}>{t(home.attentionHeading, { count: needs.length + (stall ? 1 : 0) })}</h5>
          {stall && (
            <div className="stall-card" data-ask={stall.id}>
              <div className="stall-q">⚠ {stall.question}</div>
              {stall.reason && <div className="stall-sub">{stall.reason}</div>}
              <StallRows ask={stall} onOpenTask={props.onOpenTask} />
            </div>
          )}
          {needs.length === 0 && !stall && <div className="muted">{t(home.none)}</div>}
          {(allAttention ? needs : needs.slice(0, ATTENTION_SHOWN)).map((g) => {
            const x = g.tasks[0]!;
            return (
              <div key={g.key} className="attn-group">
                <button className="row link" onClick={() => props.onOpenTask(x.id)}>
                  <span className={`dot ${outcomeDotClass(x.outcome)}`} />
                  <span className="t">{x.title}</span>
                  <WorkspaceTag name={workspaceTag(props.workspaces, x.workspaceId)} />
                  <RunnerPill runner={x.runner} />
                  <OriginTag origin={x.origin} />
                  <ShadowTag task={x} />
                  {/* when it last moved: two Tasks of the same stage of one PBI have the same title */}
                  <span className="m">
                    {outcomeLabel(x.outcome)} · {ago(x.updatedAt, Date.now())}
                  </span>
                </button>
                <PresetReplies taskId={x.id} replies={repliesFor(x.status, props.stopMarks?.[x.id])} onSend={sendReply(x.id)} onError={props.onError} />
                {g.count > 1 && (
                  <div className="row sub same-cause">
                    <span className="m">{t(home.sameCause, { n: g.count })}</span>
                    <button onClick={() => void reviewGroup(g)}>{t(home.reviewGroup, { n: g.count })}</button>
                  </div>
                )}
              </div>
            );
          })}
          {needs.length > ATTENTION_SHOWN && (
            <button className="ghost link" onClick={() => setAllAttention(!allAttention)}>
              {allAttention ? t(home.attentionFewer) : t(home.attentionAll, { n: needs.length })}
            </button>
          )}
          {waiting.length > 0 && (
            <details className="waiting-folded">
              <summary>{t(home.waitingFolded, { n: waiting.length })}</summary>
              {waiting.map((w) => (
                <div key={w.task.id}>
                  <button className="row link" onClick={() => props.onOpenTask(w.task.id)}>
                    <span className="dot idle" />
                    <span className="t">{w.task.title}</span>
                    <WorkspaceTag name={workspaceTag(props.workspaces, w.task.workspaceId)} />
                    <RunnerPill runner={w.task.runner} />
                    <span className="m">
                      {w.reason === "depends" && w.conditions.length > 0 ? w.conditions.map((c) => `${c.key}:${c.value}`).join(" ") : w.reason ? REASON_LABEL[w.reason] : outcomeLabel(w.task.outcome)} · {ago(w.task.updatedAt, Date.now())}
                    </span>
                  </button>
                  <PresetReplies taskId={w.task.id} replies={repliesFor(w.task.status, props.stopMarks?.[w.task.id])} onSend={sendReply(w.task.id)} onError={props.onError} />
                </div>
              ))}
            </details>
          )}
          {recent.length > 0 && <h5 style={{ marginTop: 14 }}>{t(home.recentHeading)}</h5>}
          {recent.map((x) => (
            <button key={x.id} className="row link" onClick={() => props.onOpenTask(x.id)}>
              <span className={`dot ${x.status === "error" ? "err" : "idle"}`} />
              <span className="t">{x.title}</span>
              <WorkspaceTag name={workspaceTag(props.workspaces, x.workspaceId)} />
              <RunnerPill runner={x.runner} />
              <OriginTag origin={x.origin} />
              <ResumeTag resumeAt={x.resumeAt} reason={x.resumeReason} plannedAt={x.resumePlannedAt} />
              <ShadowTag task={x} />
              <span className="m">{x.executionMode === "cloud" ? t(home.cloudUnchecked) : x.status}</span>
            </button>
          ))}
        </section>

        <section className="card">
          <h5>{t(home.costToday)}</h5>
          <div className="bigno">
            {fmtUsd(props.ledger?.todayUsd ?? 0)}
            <small>
              {t(home.costLine, { billed: fmtUsd(props.ledger?.billedTodayUsd ?? 0), week: fmtUsd(props.ledger?.weekUsd ?? 0) })}
            </small>
          </div>
          <div className="kv" style={{ marginTop: 10 }}>
            {(props.ledger?.quota ?? []).map((q) => (
              <QuotaRow key={`${q.runner}-${q.account}-${q.window}`} label={[q.runner, accountMark(props.ledger!.quota, q), windowLabel(q.window)].filter(Boolean).join(" · ")} utilization={q.utilization} resetsAt={q.resetsAt} ts={q.ts} />
            ))}
            {(props.ledger?.quota ?? []).length === 0 && <span className="muted">{t(home.quotaEmpty)}</span>}
          </div>
          {props.ledger && props.ledger.topTasks.length > 0 && (
            <>
              <h5 style={{ marginTop: 14 }}>{t(home.byTaskHeading)}</h5>
              {props.ledger.topTasks.map((x) => (
                <button key={x.taskId} className="row link" onClick={() => props.onOpenTask(x.taskId)}>
                  <span className="t">{x.title}</span>
                  <RunnerPill runner={x.runner} />
                  <span className="m num">
                    {fmtUsd(x.costUsd)} · {t(home.tokens, { count: Math.round(x.tokens / 1000) })}
                  </span>
                </button>
              ))}
            </>
          )}
          {(latestReport || anyArtifact) && (
            <>
              <div className="row head" style={{ marginTop: 14 }}>
                <h5>{t(home.reportsHeading)}</h5>
                <button className="ghost" onClick={props.onOpenArtifacts}>
                  {t(home.allArtifacts)}
                </button>
              </div>
              {latestReport && (
                <button className="row link" onClick={() => props.onOpenReport(latestReport.id)} title={t(home.openInInsights)}>
                  <span className="t">{latestReport.title}</span>
                  <span className="m">{reportMeta(latestReport)}</span>
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function QuotaRow(props: { label: string; utilization: number; resetsAt: number; ts: number }) {
  // the same words as the Ledger's 使用量（枠）; a window not reported for a day is faded
  const stale = quotaStale(props.ts);
  return (
    <>
      <span className={stale ? "stale" : undefined}>{props.label}</span>
      <span className={`num${stale ? " stale" : ""}`} title={`${resetLabel(props.resetsAt)} · ${quotaAsOf(props.ts)}`}>
        {pct(props.utilization)}
        <span className={`meter ${props.utilization > 0.8 ? "warn" : ""}`}>
          <i style={{ width: `${Math.min(100, props.utilization * 100)}%` }} />
        </span>
      </span>
    </>
  );
}
