import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { isWorkingStatus, type CheckRun, Footprint, LedgerSummary, OpsLoad, RunnerInfo, StagedChange, Task, TaskEvals, Workspace } from "@switchboard/protocol";
import { outcomeLabel } from "../attention.ts";
import { taskLoadLine } from "../ops.ts";
import { api, type TaskDetail } from "../api.ts";
import type { ReleaseStatus } from "../release.ts";
import { ReleasePanel } from "./ReleasePanel.tsx";
import { fmtClock, fmtUsd, githubBudgetLabel, githubBudgetLow, pct, RunnerPill } from "./ui.tsx";
import { windowLabel } from "../quota.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { AttachmentGallery } from "./Attachments.tsx";
import { firstInstruction, foldTranscript } from "../transcript.ts";
import { humanLabel, judgeAverage, judgeRows, metricRows, modelsLabel } from "../evals.ts";
import { jstDateTime } from "../time.ts";
import { t } from "../i18n.ts";
import { brief as m } from "../i18n/brief.ts";

/** How long 再評価 shows 判定中 without word from the daemon: the judge's 90 s, a fallback turn, and slack. */
const JUDGING_WAIT_MS = 200_000;

export function Brief(props: { task: Task; detail?: TaskDetail; ledger: LedgerSummary | null; onAbort: () => void; checksRev?: number; evalsRev?: number; /** 改善要望にする (#1221): opens the feedback dialog with a draft from this task's evaluations. */ onImprove?: (taskId: string) => void; onRestarting?: () => void; runners?: RunnerInfo[]; noTerminal?: boolean; onTask?: (t: Task) => void; tasks?: Task[]; onOpenTask?: (id: string) => void; workspaces?: Workspace[]; open: boolean; onClose: () => void; /** 評価をお願い (#1877): scroll to 自分の評価 once the evals are read, then onFocused */ focus?: "human"; onFocused?: () => void }) {
  // Shadow run (#99): the linked task, whichever side this one is. Derived from the task list so no extra fetch is needed.
  const shadowTask = props.task.shadowOf ? undefined : props.tasks?.find((t) => t.shadowOf === props.task.id);
  const primaryTask = props.task.shadowOf ? props.tasks?.find((t) => t.id === props.task.shadowOf) : undefined;
  const [fp, setFp] = useState<Footprint | null>(null);
  // Permission mode (#58): the daemon's list for this runner; a change applies live (Claude) or from the next turn (Codex).
  const runnerInfo = props.runners?.find((r) => r.id === props.task.runner);
  const modes = runnerInfo?.permissionModes ?? [];
  const [modeErr, setModeErr] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  // What the runner itself last reported: session.start.permissionMode, or the `permission mode: X` status echo after a live switch.
  const events = props.detail?.events;
  const reportedMode = useMemo(() => {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
      const ev = events![i]!.ev;
      if (ev.t === "session.start" && ev.permissionMode) return ev.permissionMode;
      if (ev.t === "status" && ev.text.startsWith("permission mode: ")) return ev.text.slice("permission mode: ".length);
    }
    return undefined;
  }, [events]);
  useEffect(() => setModeErr(null), [props.task.id]);
  // Model (#155): stored now, used from the next turn (the daemon resumes the session with it).
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  useEffect(() => setModelErr(null), [props.task.id]);
  const changeModel = (model: string) => {
    setModelBusy(true);
    api
      .setTaskModel(props.task.id, model || null)
      .then((t) => {
        setModelErr(null);
        props.onTask?.(t);
      })
      .catch((e) => setModelErr(String(e.message ?? e)))
      .finally(() => setModelBusy(false));
  };
  // Thinking effort (#1802): same as the model — stored now, used from the next turn.
  const [effortErr, setEffortErr] = useState<string | null>(null);
  const [effortBusy, setEffortBusy] = useState(false);
  useEffect(() => setEffortErr(null), [props.task.id]);
  const changeEffort = (effort: string) => {
    setEffortBusy(true);
    api
      .setTaskEffort(props.task.id, effort || null)
      .then((t) => {
        setEffortErr(null);
        props.onTask?.(t);
      })
      .catch((e) => setEffortErr(String(e.message ?? e)))
      .finally(() => setEffortBusy(false));
  };
  const changeMode = (mode: string) => {
    setModeBusy(true);
    api
      .setPermissionMode(props.task.id, mode)
      .then((t) => {
        setModeErr(null);
        props.onTask?.(t); // do not wait for the WebSocket (it may be reconnecting)
      })
      .catch((e) => setModeErr(String(e.message ?? e)))
      .finally(() => setModeBusy(false));
  };
  useEffect(() => {
    setFp(null);
    api.footprint(props.task.id).then(setFp).catch(() => undefined);
  }, [props.task.id]);
  // the host's load this task caused (#2086): one line under the footprint
  const [load, setLoad] = useState<OpsLoad | null>(null);
  useEffect(() => {
    setLoad(null);
    api.opsLoad(7, props.task.id).then(setLoad).catch(() => undefined);
  }, [props.task.id]);
  const loadLine = load ? (load.available ? taskLoadLine(load.groups) : t(m.loadUnavailable)) : null;

  const quota = (props.ledger?.quota ?? []).filter((q) => q.runner === props.task.runner);
  const [mcp, setMcp] = useState<{ url: string; token: string } | null>(null);
  const [mcpErr, setMcpErr] = useState<string | null>(null);
  const [staged, setStaged] = useState<Array<Omit<StagedChange, "before" | "after">>>([]);
  const [stagedErr, setStagedErr] = useState<string | null>(null);
  const [budgetErr, setBudgetErr] = useState<string | null>(null);
  // Usage-limit resume (#102): the plan is on the task; whether the daemon acts on it is the runner's setting.
  const autoResumeOn = props.runners?.find((r) => r.id === props.task.runner)?.autoResume;
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeErr, setResumeErr] = useState<string | null>(null);
  useEffect(() => setResumeErr(null), [props.task.id]);
  const resumeCall = (fn: () => Promise<Task>) => {
    setResumeBusy(true);
    fn()
      .then((t) => {
        setResumeErr(null);
        props.onTask?.(t);
      })
      .catch((e) => setResumeErr(String(e.message ?? e)))
      .finally(() => setResumeBusy(false));
  };
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const stagingSeq = useRef(0);
  // artifact = something was staged or applied; the reject status note also bumps this counter
  const artifacts = props.detail?.events.filter((e) => e.ev.t === "artifact" || (e.ev.t === "status" && e.ev.text.startsWith("staged change rejected"))).length ?? 0;
  // Self-dev (#18): checks of this repository after a task on the meta workspace
  const [checks, setChecks] = useState<{ run: CheckRun | null; running: boolean; meta: boolean; current: boolean } | null>(null);
  const [checkOpen, setCheckOpen] = useState<string | null>(null);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);
  const ended = props.detail?.events.filter((e) => e.ev.t === "session.end").length ?? 0;
  // Evals (#1218): the rule counts, read again when a turn ends (the daemon counts them then); the previous ones stay up while a turn runs.
  // Another task's counts never show under this one: cleared on a task change, and a response for an earlier request is dropped.
  const [evals, setEvals] = useState<TaskEvals | null>(null);
  const evalsSeq = useRef(0);
  // 再評価 (#1219): asked in the background; this task's evals.updated (→ evalsRev) brings the new row — also after a
  // failed scoring, which the daemon announces the same way. The timer is the way out if that message never comes.
  const [judging, setJudging] = useState(false);
  const [judgeErr, setJudgeErr] = useState<string | null>(null);
  useEffect(() => {
    setEvals(null);
    setJudging(false);
    setJudgeErr(null);
  }, [props.task.id]);
  useEffect(() => {
    const seq = ++evalsSeq.current;
    api
      .taskEvals(props.task.id)
      .then((e) => {
        if (seq !== evalsSeq.current) return;
        setEvals(e);
        if (props.evalsRev) setJudging(false); // this task's row changed (or its scoring failed): the wait is over
      })
      .catch(() => undefined);
  }, [props.task.id, ended, props.evalsRev]);
  useEffect(() => {
    if (!judging) return;
    const timer = setTimeout(() => setJudging(false), JUDGING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [judging]);
  const rejudge = () => {
    setJudging(true);
    setJudgeErr(null);
    api.judgeEvals(props.task.id).catch((e) => {
      setJudging(false);
      setJudgeErr(String(e.message ?? e));
    });
  };
  useEffect(() => {
    if (props.focus !== "human" || !props.open || !evals) return;
    document.getElementById("brief-human-eval")?.scrollIntoView({ block: "center" });
    props.onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onFocused is a fresh closure on every render; the scroll is for this focus request
  }, [props.focus, props.open, evals]);
  // 自分の評価 (#1220): a rating and a note the person saves in one go; optional, nothing prompts for it
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [humanBusy, setHumanBusy] = useState(false);
  const [humanErr, setHumanErr] = useState<string | null>(null);
  useEffect(() => {
    setRating(null);
    setComment("");
    setHumanErr(null);
    setHumanBusy(false);
  }, [props.task.id]);
  // which task is open, for an answer that arrives later (a save's own evals.updated bumps evalsSeq before the PUT answers, so that counter cannot be the gate here)
  const openTaskId = useRef(props.task.id);
  openTaskId.current = props.task.id;
  const saveHuman = (fn: () => Promise<TaskEvals>) => {
    // the answer belongs to the task it was sent for; one that lands after a switch is dropped
    const id = props.task.id;
    setHumanBusy(true);
    setHumanErr(null);
    fn()
      .then((e) => {
        if (openTaskId.current !== id) return;
        setEvals(e);
        setRating(null);
        setComment("");
      })
      .catch((e) => {
        if (openTaskId.current === id) setHumanErr(String(e.message ?? e));
      })
      .finally(() => {
        if (openTaskId.current === id) setHumanBusy(false);
      });
  };
  useEffect(() => {
    setChecks(null);
    setRestartMsg(null);
  }, [props.task.id]);
  useEffect(() => {
    api.checks(props.task.id).then(setChecks).catch(() => undefined);
  }, [props.task.id, props.checksRev, ended]);
  // Releases (#178): under sb-rescue new code arrives by promoting a commit (ReleasePanel); sb-rescue checks it and goes back by itself.
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const managed = release?.managed === true;
  const isMeta = checks?.meta === true;
  useEffect(() => {
    if (!isMeta) return setRelease(null);
    const load = () => api.release().then(setRelease).catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000); // a read that failed once (sb-rescue restarting) is tried again; a promotion ends in a restart
    return () => clearInterval(timer);
  }, [isMeta, props.task.id]);
  const restart = (force = false) =>
    api
      .restartDaemon(props.task.id, force)
      .then((r) => {
        setRestartMsg(r.restarting ? (r.supervised ? t(m.restartingSupervised) : t(m.restarting)) : t(m.restartNotRun));
        if (r.restarting) props.onRestarting?.();
      })
      .catch((e) => setRestartMsg(String(e.message ?? e)));
  useEffect(() => {
    setMcp(null);
    setMcpErr(null);
    setStaged([]);
    setStagedErr(null);
    setOpenDiff(null);
  }, [props.task.id]);
  const loadStaged = () => {
    const seq = ++stagingSeq.current;
    return api
      .staging(props.task.id)
      .then((s) => {
        if (seq === stagingSeq.current) setStaged(s);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    void loadStaged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.task.id, artifacts]);
  const decide = (sid: string, action: "apply" | "reject") =>
    (action === "apply" ? api.stagingApply(props.task.id, sid) : api.stagingReject(props.task.id, sid))
      .then(() => setStagedErr(null))
      .catch((e) => setStagedErr(String(e.message ?? e)))
      .then(loadStaged);
  const cloud = props.task.executionMode === "cloud";
  const busy = isWorkingStatus(props.task.status);
  const contextWindow = 200_000;
  const instruction = useMemo(() => firstInstruction(foldTranscript(props.detail?.events ?? []).items), [props.detail?.events]);

  return (
    <aside className={`side ${props.open ? "open" : ""}`}>
      {/* Phones only (#369): the Brief is laid over the chat there. */}
      <button className="ghost brief-close" onClick={props.onClose}>
        {t(m.close)}
      </button>
      <div className="blk">
        <h5>{t(m.overviewHeading)}</h5>
        {/* The instruction the task was started with (#1314): read here, beside the end of a long conversation. */}
        {instruction && (
          <div className="blk brief-instruction">
            <h5>{t(m.instructionHeading)}</h5>
            <div className="tx">{instruction.text}</div>
            {instruction.attachments && <AttachmentGallery items={instruction.attachments} />}
          </div>
        )}
        {props.detail?.sourceCloudTask && <p><button className="ghost" onClick={() => props.onOpenTask?.(props.detail!.sourceCloudTask!.id)}>{t(m.sourceCloudTask)}</button>{t(m.continuingLocally)}<span className="hint">{t(m.workingCopy, { cwd: props.task.cwd })}</span></p>}
        {props.detail?.localContinuations.map((lt) => <p key={lt.id}><button className="ghost" onClick={() => props.onOpenTask?.(lt.id)}>{t(m.localTask, { title: lt.title })}</button> <span className="hint">{t(m.workingCopy, { cwd: lt.cwd })}</span></p>)}
        {props.noTerminal && <div className="hint">{t(m.noTerminal)}</div>}
        <div className="kv">
          {props.task.workspaceReason && (
            <>
              <span>Workspace</span>
              <span>
                {props.workspaces?.find((w) => w.id === props.task.workspaceId)?.name ?? props.task.cwd}
                <span className="hint">{t(m.workspaceAuto, { reason: props.task.workspaceReason })}</span>
              </span>
            </>
          )}
          <span>{t(m.runner)}</span>
          <span>
            <RunnerPill runner={props.task.runner} />{" "}
            {props.task.routing ? (
              props.task.routing.overridden ? (
                <span className="hint" title={t(m.ruleTitle, { rule: props.task.routing.ruleId })}>
                  {t(m.overridden, { suggested: props.task.routing.suggested, reason: props.task.routing.reason })}
                </span>
              ) : (
                <span className="hint" title={t(m.ruleTitle, { rule: props.task.routing.ruleId })}>
                  {t(m.asRecommended, { reason: props.task.routing.reason })}
                </span>
              )
            ) : (
              <span className="hint">{t(m.manualChoice)}</span>
            )}
            {/* LLM の提案（#25）は作成後に届く助言で、ランナーは決めない。提案と実際を並べるだけで、どちらが良かったかは言わない */}
            {props.task.routing?.llm && (
              <span className="hint llm-suggest" title={t(m.llmTitle)}>
                {" · "}{t(m.llmSuggest, { runner: props.task.routing.llm.runner, reason: props.task.routing.llm.reason, actual: props.task.runner, outcome: outcomeLabel(props.task.outcome) })}
              </span>
            )}
          </span>
          <span>{t(m.model)}</span>
          <span>
            {cloud ? <span>{t(m.cloudModel)}</span> : <ModelSelect runner={runnerInfo} value={props.task.model ?? ""} onChange={changeModel} label={t(m.model)} disabled={modelBusy} />}
            {!cloud && runnerInfo && runnerInfo.models.length > 0 && <div className="hint">{isWorkingStatus(props.task.status) ? t(m.modelNextTurn) : t(m.modelNextReply)}</div>}
            {modelErr && <div className="hint warn">{modelErr}</div>}
          </span>
          <span>{t(m.effort)}</span>
          <span>
            {cloud ? <span>{t(m.cloudModel)}</span> : <EffortSelect runner={runnerInfo} value={props.task.effort ?? ""} onChange={changeEffort} label={t(m.effort)} disabled={effortBusy} />}
            {!cloud && runnerInfo && runnerInfo.efforts.length > 0 && <div className="hint">{isWorkingStatus(props.task.status) ? t(m.modelNextTurn) : t(m.effortNextReply)}</div>}
            {effortErr && <div className="hint warn">{effortErr}</div>}
          </span>
          <span>{t(m.approval)}</span>
          <span>
            {cloud ? <span>{t(m.cloudApproval)}</span> : modes.length > 0 ? (
              <>
                <select value={props.task.permissionMode ?? ""} disabled={modeBusy} onChange={(e) => changeMode(e.target.value)} aria-label={t(m.modeLabel)} title={modes.find((pm) => pm.value === props.task.permissionMode)?.description ?? ""}>
                  {props.task.permissionMode === null && <option value="">{t(m.modeUnset)}</option>}
                  {props.task.permissionMode && !modes.some((pm) => pm.value === props.task.permissionMode) && <option value={props.task.permissionMode}>{props.task.permissionMode}</option>}
                  {modes.map((pm) => (
                    <option key={pm.value} value={pm.value}>
                      {pm.label}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  {props.task.runner === "claude" ? t(m.modeLive) : t(m.modeNextTurn)}
                  {reportedMode ? t(m.modeReported, { mode: reportedMode }) : ""}
                  {t(m.modeRules)}
                </div>
                {modeErr && <div className="hint warn">{modeErr}</div>}
              </>
            ) : (
              <span>{t(m.modeDak)}</span>
            )}
          </span>
          <span>{t(m.session)}</span>
          <span className="mono" title={props.task.runnerSessionId ?? ""}>
            {cloud ? props.task.cloudSession?.id ?? t(m.unconfirmed) : props.task.runnerSessionId ? props.task.runnerSessionId.slice(0, 8) + "…" : "—"}
          </span>
          <span>{t(m.origin)}</span>
          <span>
            {props.task.origin === "terminal" ? (
              <>
                {t(m.originTerminal)}
                <div className="hint">{t(m.originTerminalHint)}</div>
              </>
            ) : (
              <>Switchboard{props.task.scheduleId ? t(m.originSchedule) : ""}</>
            )}
            {props.detail?.history && (
              <div className="hint mono" title={props.detail.history.path} style={{ wordBreak: "break-all" }}>
                {props.task.origin === "terminal" ? t(m.historyImported, { path: props.detail.history.pathDisplay, at: jstDateTime(props.detail.history.importedAt) }) : t(m.historyLog, { path: props.detail.history.pathDisplay })}
              </div>
            )}
          </span>
          {(shadowTask || props.task.shadowOf) && (
            <>
              <span>{t(m.shadow)}</span>
              <span>
                {shadowTask ? (
                  <>
                    <button className="ghost" onClick={() => props.onOpenTask?.(shadowTask.id)} title={shadowTask.title}>
                      <RunnerPill runner={shadowTask.runner} />{t(m.openShadow)}
                    </button>
                    <div className="hint">
                      {shadowTask.shadowStopped
                        ? t(m.shadowStopped, { runner: shadowTask.runner })
                        : shadowTask.status === "waiting"
                          ? t(m.shadowWaiting, { runner: shadowTask.runner })
                          : t(m.shadowRunning, { runner: shadowTask.runner })}
                      {t(m.shadowSeparate)}
                    </div>
                  </>
                ) : (
                  <>
                    {primaryTask ? (
                      <button className="ghost" onClick={() => props.onOpenTask?.(primaryTask.id)} title={primaryTask.title}>
                        {t(m.openPrimaryBefore)}<RunnerPill runner={primaryTask.runner} />{t(m.openPrimaryAfter)}
                      </button>
                    ) : (
                      <span className="mono">{props.task.shadowOf}</span>
                    )}
                    <div className="hint">
                      {props.task.shadowStopped
                        ? t(m.copyStopped)
                        : t(m.copyRunning)}
                    </div>
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="blk">
        <h5>{t(m.scopeHeading)}</h5>
        <div className="tree">
          {props.task.scope.map((d) => (
            <div key={d} className={d === props.task.cwd ? "on" : ""} title={d}>
              {shorten(d)}
            </div>
          ))}
        </div>
        <div className="kv" style={{ marginTop: 8 }}>
          <span>{t(m.contextSize)}</span>
          <span className="num">{fp ? t(m.footprint, { files: fp.files.toLocaleString(), k: Math.round(fp.estTokens / 1000), more: fp.truncated ? "+" : "" }) : t(m.measuring)}</span>
        </div>
        <div className={`meter ${fp && fp.estTokens > contextWindow * 0.6 ? "warn" : ""}`}>
          <i style={{ width: `${fp ? Math.min(100, (fp.estTokens / contextWindow) * 100) : 0}%` }} />
        </div>
        <div className="hint">{t(m.footprintHint)}</div>
        {loadLine && (
          <div className="kv" data-brief-load>
            <span>{t(m.load)}</span>
            <span className="num">{loadLine}</span>
          </div>
        )}
      </div>

      <div className="blk evals">
        <h5>{t(m.evalsHeading)}</h5>
        {evals && modelsLabel(evals) && (
          <div className="kv">
            <span>{t(m.model)}</span>
            <span title={evals.models.length >= 2 ? evals.models.join(" → ") : undefined}>{modelsLabel(evals)}</span>
          </div>
        )}
        {cloud ? (
          <div className="hint">{t(m.cloudEvals)}</div>
        ) : evals === null ? (
          <div className="hint">{t(m.loading)}</div>
        ) : !evals.rules ? (
          <div className="hint">{t(m.evalsAfterTurn)}</div>
        ) : (
          <>
            <div className="kv">
              {metricRows(evals).map((r) => (
                <Fragment key={r.label}>
                  <span>{r.label}</span>
                  <span className={`num${r.warn ? " warn" : ""}`}>{r.value}</span>
                </Fragment>
              ))}
            </div>
            <div className="kv" style={{ marginTop: 8 }}>
              <span>{t(m.rubric)}</span>
              <span className="num">
                {judging ? t(m.judging) : evals.judge ? t(m.judgeAverage, { avg: judgeAverage(evals) ?? "-", by: evals.judge.by, rubric: evals.judge.rubric }) : t(m.notJudged)}{" "}
                <button className="ghost" disabled={busy || judging} onClick={rejudge} title={t(m.rejudgeTitle)}>
                  {t(m.rejudge)}
                </button>
              </span>
              {judgeRows(evals).map((r) => (
                <Fragment key={r.id}>
                  <span>{r.title}</span>
                  {/* two children per criterion keep the grid's label / value parity: the reason sits inside the value cell */}
                  <span className={`num${r.warn ? " warn" : ""}`}>
                    {r.score} / 5
                    <span className="hint" style={{ display: "block", whiteSpace: "normal" }}>
                      {r.reason}
                    </span>
                  </span>
                </Fragment>
              ))}
            </div>
            {evals.judge?.summary && <div className="hint">{evals.judge.summary}</div>}
            {judgeErr && <div className="hint warn">{judgeErr}</div>}
          </>
        )}
        {evals && (
          <>
            <div className="kv" id="brief-human-eval" style={{ marginTop: 8 }}>
              <span>{t(m.humanEval)}</span>
              <span className="num">
                {humanLabel(evals) ?? t(m.none)}{" "}
                {evals.human && (
                  <button className="ghost" disabled={humanBusy} onClick={() => saveHuman(() => api.clearHumanEval(props.task.id))}>
                    {t(m.clear)}
                  </button>
                )}
              </span>
            </div>
            <div className="row" style={{ alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={rating === n ? "pri" : "ghost"} disabled={humanBusy} onClick={() => setRating(n)} title={`${n} / 5`} aria-label={t(m.humanEvalN, { n })}>
                  {n}
                </button>
              ))}
              <input value={comment} maxLength={1000} placeholder={t(m.commentPlaceholder)} disabled={humanBusy} onChange={(e) => setComment(e.target.value)} style={{ flex: 1, minWidth: 80 }} />
              <button disabled={humanBusy || rating === null} onClick={() => saveHuman(() => api.setHumanEval(props.task.id, { rating: rating!, comment }))}>
                {t(m.save)}
              </button>
            </div>
            {humanErr && <div className="hint warn">{humanErr}</div>}
            {props.onImprove && (
              <div className="row" style={{ marginTop: 6 }}>
                <button className="ghost" onClick={() => props.onImprove?.(props.task.id)} title={t(m.improveTitle)}>
                  {t(m.improve)}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="blk">
        <h5>{t(m.costHeading)}</h5>
        {cloud ? <div className="hint">{t(m.cloudCost)}</div> : <div className="kv">
          <span>{t(m.taskCost)}</span>
          <span className="num">{fmtUsd(props.detail?.cost.costUsd ?? 0)}</span>
          <span>{t(m.tokens)}</span>
          <span className="num">{((props.detail?.cost.tokens ?? 0) / 1000).toFixed(1)}k</span>
          <span>{t(m.budget)}</span>
          <span className="num">
            {props.task.budgetUsd === null ? (
              <span className="hint">{t(m.none)}</span>
            ) : (
              <>
                {fmtUsd(props.detail?.cost.costUsd ?? 0)} / {fmtUsd(props.task.budgetUsd)}
                {(props.detail?.cost.costUsd ?? 0) > props.task.budgetUsd && <span className="warn">{t(m.overBudget)}</span>}{" "}
                <button className="ghost" onClick={() => api.setBudget(props.task.id, props.task.budgetUsd! * 2).catch((e) => setBudgetErr(String(e.message ?? e)))} title={t(m.doubleBudget)}>
                  ×2
                </button>
                {(props.detail?.cost.costUsd ?? 0) > props.task.budgetUsd && busy && (
                  <button className="ghost" onClick={props.onAbort} title={t(m.abortTitle)}>
                    {t(m.abort)}
                  </button>
                )}
                {budgetErr && <span className="warn"> {budgetErr}</span>}
              </>
            )}
          </span>
          {quota.map((q) => (
            <QuotaKv key={q.window} window={q.window} utilization={q.utilization} />
          ))}
          {/* not shown while it cannot be read: unknown is not 0 (#549) */}
          {props.ledger?.github && (
            <>
              <span>{t(m.githubBudget)}</span>
              <span className={`num ${githubBudgetLow(props.ledger.github) ? "warn" : ""}`}>{githubBudgetLabel(props.ledger.github)}</span>
            </>
          )}
        </div>}
      </div>

      {!cloud && props.task.resumeAt !== null && (
        <div className="blk">
          <h5>{props.task.resumeReason === "disk" ? t(m.resumeDiskHeading) : props.task.resumeReason === "github" ? t(m.resumeGithubHeading) : t(m.resumeLimitHeading)}</h5>
          <div className="hint">
            {props.task.resumeReason === "disk" ? t(m.resumeDiskStopped) : props.task.resumeReason === "github" ? t(m.resumeGithubWaiting) : t(m.resumeLimitStopped)}
            {props.task.resumeReason === "disk" ? (
              !props.task.runnerSessionId ? (
                t(m.resumeNoSession)
              ) : autoResumeOn === false ? (
                t(m.diskAutoOff)
              ) : autoResumeOn === true ? (
                <>
                  {t(m.diskAutoOnBefore)}<b>{fmtClock(props.task.resumeAt)}</b>{t(m.diskAutoOnAfter)}
                </>
              ) : (
                t(m.diskAutoUnknown)
              )
            ) : !props.task.runnerSessionId ? (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b>{t(m.limitNoSession)}
              </>
            ) : autoResumeOn === true && props.task.resumePlannedAt !== null ? (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b>{t(m.limitTryOnce)}<b>{fmtClock(props.task.resumePlannedAt)}</b>{t(m.limitTryOnceAfter)}
              </>
            ) : autoResumeOn === true ? (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b>{t(m.limitAutoOn)}
              </>
            ) : autoResumeOn === false ? (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b>{t(m.limitAutoOff)}
              </>
            ) : (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b>{t(m.limitAutoUnknown)}
              </>
            )}
          </div>
          <div className="actions" style={{ marginTop: 6 }}>
            <button className="pri" disabled={resumeBusy || busy || !props.task.runnerSessionId} onClick={() => resumeCall(() => api.resumeNow(props.task.id))} title={props.task.resumeReason === "disk" ? t(m.resumeNowDiskTitle) : props.task.resumeReason === "github" ? t(m.resumeNowGithubTitle) : t(m.resumeNowLimitTitle)}>
              {t(m.resumeNow)}
            </button>
            <button disabled={resumeBusy} onClick={() => resumeCall(() => api.cancelResume(props.task.id))} title={t(m.cancelResumeTitle)}>
              {t(m.cancelResume)}
            </button>
          </div>
          {resumeErr && <div className="hint warn">{resumeErr}</div>}
        </div>
      )}

      <div className="blk">
        <h5>{t(m.actionsHeading)}</h5>
        <div className="actions">
          <button disabled={cloud || !busy} onClick={props.onAbort}>
            {t(m.abort)}
          </button>
          <a className="btn" href={`vscode://file${props.task.cwd}`} title={t(m.openInVsCode)}>
            {t(m.openInEditor)}
          </a>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {cloud ? t(m.cloudActions) : t(m.diffTabHint)}
        </div>
      </div>

      {!cloud && checks?.meta && (
        <div className="blk">
          <h5>{t(m.selfDevHeading)}</h5>
          {!checks.run && !checks.running && <div className="hint">{t(m.checksAuto)}</div>}
          {checks.running && <div className="hint">{t(m.checksRunning)}</div>}
          {checks.run && !checks.current && !checks.running && <div className="hint warn">{t(m.checksStale)}</div>}
          {checks.run && (
            <div className="kv">
              {checks.run.results.map((r) => (
                <span key={r.kind} className="fm-row" style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
                  <button className="row link" onClick={() => setCheckOpen(checkOpen === r.kind ? null : r.kind)} style={{ flex: 1 }}>
                    <span className="t">{r.kind}</span>
                    <span className={`m ${r.ok ? "ok" : "fail"}`}>
                      {r.ok ? "✓" : "✕"} {r.summary} · {(r.durationMs / 1000).toFixed(1)}s
                    </span>
                  </button>
                </span>
              ))}
              {checkOpen && <pre className="diff" style={{ gridColumn: "1 / -1" }}>{checks.run.results.find((r) => r.kind === checkOpen)?.output || "(no output)"}</pre>}
            </div>
          )}
          <div className="actions" style={{ marginTop: 6 }}>
            <button disabled={checks.running || busy} onClick={() => api.runChecks(props.task.id).then(setChecks).catch(() => undefined)}>
              {t(m.runChecks)}
            </button>
            {managed ? null : (
              <>
                <button className="pri" disabled={busy || checks.running || !checks.run?.ok || !checks.current} onClick={() => void restart(false)} title={t(m.restartTitle)}>
                  {t(m.restart)}
                </button>
                {checks.run && !checks.run.ok && (
                  <button className="ghost" disabled={busy} onClick={() => void restart(true)} title={t(m.forceRestartTitle)}>
                    {t(m.forceRestart)}
                  </button>
                )}
              </>
            )}
          </div>
          {managed && <ReleasePanel disabled={busy} />}
          {release && !release.managed && release.error && <div className="hint warn">{release.error}</div>}
          {restartMsg && <div className="hint">{restartMsg}</div>}
          <div className="hint">{t(m.selfDevHint)}</div>
        </div>
      )}

      {staged.length > 0 && (
        <div className="blk">
          <h5>{t(m.stagingHeading)}</h5>
          {stagedErr && <div className="hint warn">{stagedErr}</div>}
          {staged.map((c) => (
            <div key={c.id} className="staged">
              <button className="row link" onClick={() => setOpenDiff(openDiff === c.id ? null : c.id)} title={c.path}>
                <span className="t mono">{c.rel}</span>
                <span className="tag">{c.kind}</span>
                <span className={`m ${c.status}`}>{c.status === "pending" ? t(m.stagedPending) : c.status === "applied" ? t(m.stagedApplied) : t(m.reject)}</span>
              </button>
              {openDiff === c.id && <pre className="diff">{c.diff || t(m.noDiff)}</pre>}
              {c.status === "pending" && (
                <div className="actions">
                  <button className="pri" onClick={() => void decide(c.id, "apply")}>
                    {t(m.apply)}
                  </button>
                  <button onClick={() => void decide(c.id, "reject")}>{t(m.reject)}</button>
                </div>
              )}
            </div>
          ))}
          <div className="hint">{t(m.stagingHint)}</div>
        </div>
      )}

      {!cloud && <div className="blk">
        <h5>Workspace MCP</h5>
        {props.task.runner === "claude" && props.detail && (
          <div className="kv">
            <span>{t(m.mcpServers)}</span>
            <span title={t(m.mcpServersTitle)}>{props.detail.mcpServers?.length ? props.detail.mcpServers.join(t(m.mcpSeparator)) : t(m.mcpNone)}</span>
          </div>
        )}
        {!mcp && (
          <div className="actions">
            <button
              disabled={!busy}
              onClick={() =>
                api
                  .mcpEndpoint(props.task.id)
                  .then(setMcp)
                  .catch((e) => setMcpErr(String(e.message ?? e)))
              }
              title={t(m.issueEndpointTitle)}
            >
              {t(m.issueEndpoint)}
            </button>
          </div>
        )}
        {mcpErr && <div className="hint warn">{mcpErr}</div>}
        {mcp && (
          <div className="kv">
            <span>URL</span>
            <span className="mono" style={{ wordBreak: "break-all" }}>
              {mcp.url}
            </span>
            <span>{t(m.token)}</span>
            <span className="mono" style={{ wordBreak: "break-all" }}>
              {mcp.token}
            </span>
            <span />
            <span>
              <button className="ghost" onClick={() => void navigator.clipboard?.writeText(`${mcp.url}?token=${mcp.token}`)}>
                {t(m.copyUrlToken)}
              </button>{" "}
              <button
                className="ghost"
                onClick={() =>
                  api
                    .mcpRotate(props.task.id)
                    .then(setMcp)
                    .catch((e) => setMcpErr(String(e.message ?? e)))
                }
                title={t(m.rotateTitle)}
              >
                {t(m.rotate)}
              </button>
            </span>
          </div>
        )}
        <div className="hint" style={{ marginTop: 6 }}>
          {t(m.mcpHint)}
        </div>
      </div>}
    </aside>
  );
}

function QuotaKv(props: { window: string; utilization: number }) {
  return (
    <>
      <span>{t(m.quotaWindow, { window: windowLabel(props.window) })}</span>
      <span className="num">{pct(props.utilization)}</span>
    </>
  );
}

function shorten(p: string) {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split("/").slice(1).join("/");
    return `~/${rest}`;
  }
  return p;
}
