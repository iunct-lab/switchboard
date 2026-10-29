import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CheckRun, Footprint, LedgerSummary, OpsLoad, RunnerInfo, StagedChange, Task, TaskEvals, Workspace } from "@switchboard/protocol";
import { taskLoadLine } from "../ops.ts";
import { api, type TaskDetail } from "../api.ts";
import type { ReleaseStatus } from "../release.ts";
import { ReleasePanel } from "./ReleasePanel.tsx";
import { fmtClock, fmtUsd, githubBudgetLabel, githubBudgetLow, pct, RunnerPill } from "./ui.tsx";
import { windowLabel } from "../quota.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { AttachmentGallery } from "./Attachments.tsx";
import { firstInstruction, foldTranscript } from "../transcript.ts";
import { effortLabel } from "../effortOptions.ts";
import { humanLabel, judgeAverage, judgeRows, metricRows, modelsLabel } from "../evals.ts";
import { jstDateTime } from "../time.ts";

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
  const loadLine = load ? (load.available ? taskLoadLine(load.groups) : "この環境では測れません") : null;

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
        setRestartMsg(r.restarting ? (r.supervised ? "再起動中（dev.ts が再起動します）… UI は再接続を待ちます" : "再起動中… 新しいデーモンが起動するまで UI は再接続を待ちます（ログ: ~/.switchboard/daemon.log）") : "再起動は実行されませんでした");
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
  const busy = props.task.status === "running" || props.task.status === "waiting";
  const contextWindow = 200_000;
  const instruction = useMemo(() => firstInstruction(foldTranscript(props.detail?.events ?? []).items), [props.detail?.events]);

  return (
    <aside className={`side ${props.open ? "open" : ""}`}>
      {/* Phones only (#369): the Brief is laid over the chat there. */}
      <button className="ghost brief-close" onClick={props.onClose}>
        閉じる
      </button>
      <div className="blk">
        <h5>Task の概要</h5>
        {/* The instruction the task was started with (#1314): read here, beside the end of a long conversation. */}
        {instruction && (
          <div className="blk brief-instruction">
            <h5>指示</h5>
            <div className="tx">{instruction.text}</div>
            {instruction.attachments && <AttachmentGallery items={instruction.attachments} />}
          </div>
        )}
        {props.detail?.sourceCloudTask && <p><button className="ghost" onClick={() => props.onOpenTask?.(props.detail!.sourceCloudTask!.id)}>元Cloud Task</button> — Localで続行中・Cloudへ自動同期なし <span className="hint">作業コピー: {props.task.cwd}</span></p>}
        {props.detail?.localContinuations.map(t => <p key={t.id}><button className="ghost" onClick={() => props.onOpenTask?.(t.id)}>ローカルの Task: {t.title}</button> <span className="hint">作業コピー: {t.cwd}</span></p>)}
        {props.noTerminal && <div className="hint">この配布ではターミナルは使えません</div>}
        <div className="kv">
          {props.task.workspaceReason && (
            <>
              <span>Workspace</span>
              <span>
                {props.workspaces?.find((w) => w.id === props.task.workspaceId)?.name ?? props.task.cwd}
                <span className="hint">（自動: {props.task.workspaceReason}）</span>
              </span>
            </>
          )}
          <span>ランナー</span>
          <span>
            <RunnerPill runner={props.task.runner} />{" "}
            {props.task.routing ? (
              props.task.routing.overridden ? (
                <span className="hint" title={`ルール: ${props.task.routing.ruleId}`}>
                  手動で上書き（推奨は {props.task.routing.suggested}: {props.task.routing.reason}）
                </span>
              ) : (
                <span className="hint" title={`ルール: ${props.task.routing.ruleId}`}>
                  推奨どおり — {props.task.routing.reason}
                </span>
              )
            ) : (
              <span className="hint">手動選択</span>
            )}
            {/* LLM の提案（#25）は助言で、ランナーは決めない。ルール表の理由の隣に並べる */}
            {props.task.routing?.llm && (
              <span className="hint llm-suggest" title="このタスクを作ったときの LLM の提案です。ランナーはルール表と利用者が決めています">
                {" · "}LLM の提案: {props.task.routing.llm.runner} — {props.task.routing.llm.reason}
              </span>
            )}
          </span>
          <span>モデル</span>
          <span>
            {cloud ? <span>公式 Web で操作してください</span> : <ModelSelect runner={runnerInfo} value={props.task.model ?? ""} onChange={changeModel} label="モデル" disabled={modelBusy} />}
            {!cloud && runnerInfo && runnerInfo.models.length > 0 && <div className="hint">{props.task.status === "running" || props.task.status === "waiting" ? "変更は次のターンから（今のターンを止めるなら中断してから返信）" : "変更は次の返信から。同じセッションを新しいモデルで再開します"}</div>}
            {modelErr && <div className="hint warn">{modelErr}</div>}
          </span>
          <span>思考の深さ</span>
          <span className="brief-effort" title="作成時に決まり、途中では変えられません">{effortLabel(props.task.effort, runnerInfo)}</span>
          <span>承認</span>
          <span>
            {cloud ? <span>公式 Web で承認・権限を操作してください</span> : modes.length > 0 ? (
              <>
                <select value={props.task.permissionMode ?? ""} disabled={modeBusy} onChange={(e) => changeMode(e.target.value)} aria-label="承認モード" title={modes.find((m) => m.value === props.task.permissionMode)?.description ?? ""}>
                  {props.task.permissionMode === null && <option value="">（未設定 — 再開時にランナー既定で解決）</option>}
                  {props.task.permissionMode && !modes.some((m) => m.value === props.task.permissionMode) && <option value={props.task.permissionMode}>{props.task.permissionMode}</option>}
                  {modes.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  {props.task.runner === "claude" ? "変更は実行中でも即時に反映" : "変更は次のターンから反映"}
                  {reportedMode ? ` · ランナー報告: ${reportedMode}` : ""}
                  。Knowledge の rules に approval があれば allow / confirm も適用
                </div>
                {modeErr && <div className="hint warn">{modeErr}</div>}
              </>
            ) : (
              <span>DAK 側の設定（require_confirmation / mcp.yaml）で決まる。Knowledge の rules に approval があれば allow / confirm を適用</span>
            )}
          </span>
          <span>セッション</span>
          <span className="mono" title={props.task.runnerSessionId ?? ""}>
            {cloud ? props.task.cloudSession?.id ?? "未確認" : props.task.runnerSessionId ? props.task.runnerSessionId.slice(0, 8) + "…" : "—"}
          </span>
          <span>実行導線</span>
          <span>
            {props.task.origin === "terminal" ? (
              <>
                Terminal で開始（Claude Code のログから取り込み）
                <div className="hint">返信すると Switchboard 側で同じセッションを再開します。Terminal で開いたままなら先に閉じてください</div>
              </>
            ) : (
              <>Switchboard{props.task.scheduleId ? "（スケジュール）" : ""}</>
            )}
            {props.detail?.history && (
              <div className="hint mono" title={props.detail.history.path} style={{ wordBreak: "break-all" }}>
                {props.task.origin === "terminal" ? `取り込み元 ${props.detail.history.pathDisplay} · 取り込み ${jstDateTime(props.detail.history.importedAt)}` : `ログ ${props.detail.history.pathDisplay}`}
              </div>
            )}
          </span>
          {(shadowTask || props.task.shadowOf) && (
            <>
              <span>並走</span>
              <span>
                {shadowTask ? (
                  <>
                    <button className="ghost" onClick={() => props.onOpenTask?.(shadowTask.id)} title={shadowTask.title}>
                      <RunnerPill runner={shadowTask.runner} /> の Task を開く
                    </button>
                    <div className="hint">
                      {shadowTask.shadowStopped
                        ? `同じ依頼を ${shadowTask.runner} でも実行したが停止済み。ここへの返信はもう写されません。`
                        : shadowTask.status === "waiting"
                          ? `同じ依頼を ${shadowTask.runner} でも実行中。向こうは承認待ちなので、今の返信は写されません。`
                          : `同じ依頼を ${shadowTask.runner} でも実行中。ここへの返信は向こうにも写されます（向こうからは戻りません）。`}
                      承認・差分・台帳は別々
                    </div>
                  </>
                ) : (
                  <>
                    {primaryTask ? (
                      <button className="ghost" onClick={() => props.onOpenTask?.(primaryTask.id)} title={primaryTask.title}>
                        並走元 <RunnerPill runner={primaryTask.runner} /> を開く
                      </button>
                    ) : (
                      <span className="mono">{props.task.shadowOf}</span>
                    )}
                    <div className="hint">
                      {props.task.shadowStopped
                        ? "この Task は並走元と同じ依頼の写し（停止済み）。並走元への返信はもう届きません。ここへ直接送ることはできます"
                        : "この Task は並走元と同じ依頼の写し。並走元への返信がここにも届きます（承認待ちの間は除く）。ここへの返信は並走元に戻りません"}
                    </div>
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="blk">
        <h5>スコープ</h5>
        <div className="tree">
          {props.task.scope.map((d) => (
            <div key={d} className={d === props.task.cwd ? "on" : ""} title={d}>
              {shorten(d)}
            </div>
          ))}
        </div>
        <div className="kv" style={{ marginTop: 8 }}>
          <span>コンテキストの量</span>
          <span className="num">{fp ? `${fp.files.toLocaleString()} ファイル · 約 ${Math.round(fp.estTokens / 1000)}k トークン${fp.truncated ? "+" : ""}` : "計測中…"}</span>
        </div>
        <div className={`meter ${fp && fp.estTokens > contextWindow * 0.6 ? "warn" : ""}`}>
          <i style={{ width: `${fp ? Math.min(100, (fp.estTokens / contextWindow) * 100) : 0}%` }} />
        </div>
        <div className="hint">全部読んだ場合の目安。200k コンテキスト比</div>
        {loadLine && (
          <div className="kv" data-brief-load>
            <span>負荷</span>
            <span className="num">{loadLine}</span>
          </div>
        )}
      </div>

      <div className="blk evals">
        <h5>評価</h5>
        {evals && modelsLabel(evals) && (
          <div className="kv">
            <span>モデル</span>
            <span title={evals.models.length >= 2 ? evals.models.join(" → ") : undefined}>{modelsLabel(evals)}</span>
          </div>
        )}
        {cloud ? (
          <div className="hint">Cloud の Task はルール指標とルーブリックを出しません（イベントが手元に無いため）。自分の評価は付けられます。</div>
        ) : evals === null ? (
          <div className="hint">読み込み中…</div>
        ) : !evals.rules ? (
          <div className="hint">ターンが終わると集計します。</div>
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
              <span>ルーブリック</span>
              <span className="num">
                {judging ? "判定中…" : evals.judge ? `平均 ${judgeAverage(evals) ?? "-"} / 5 · ${evals.judge.by} · ${evals.judge.rubric}` : "まだ判定していません"}{" "}
                <button className="ghost" disabled={busy || judging} onClick={rejudge} title="今の会話でルーブリックの採点をやり直します（判定のランナーの 1 ターン）">
                  再評価
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
              <span>自分の評価</span>
              <span className="num">
                {humanLabel(evals) ?? "なし"}{" "}
                {evals.human && (
                  <button className="ghost" disabled={humanBusy} onClick={() => saveHuman(() => api.clearHumanEval(props.task.id))}>
                    消す
                  </button>
                )}
              </span>
            </div>
            <div className="row" style={{ alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={rating === n ? "pri" : "ghost"} disabled={humanBusy} onClick={() => setRating(n)} title={`${n} / 5`} aria-label={`自分の評価 ${n}`}>
                  {n}
                </button>
              ))}
              <input value={comment} maxLength={1000} placeholder="一言（任意）" disabled={humanBusy} onChange={(e) => setComment(e.target.value)} style={{ flex: 1, minWidth: 80 }} />
              <button disabled={humanBusy || rating === null} onClick={() => saveHuman(() => api.setHumanEval(props.task.id, { rating: rating!, comment }))}>
                保存
              </button>
            </div>
            {humanErr && <div className="hint warn">{humanErr}</div>}
            {props.onImprove && (
              <div className="row" style={{ marginTop: 6 }}>
                <button className="ghost" onClick={() => props.onImprove?.(props.task.id)} title="この Task の評価を下書きにして、改善の要望を登録するダイアログを開きます">
                  改善要望にする
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="blk">
        <h5>コスト</h5>
        {cloud ? <div className="hint">Cloud の費用・使用量はここでは取得していません。公式 Web で確認してください。</div> : <div className="kv">
          <span>このタスク（API 換算）</span>
          <span className="num">{fmtUsd(props.detail?.cost.costUsd ?? 0)}</span>
          <span>トークン</span>
          <span className="num">{((props.detail?.cost.tokens ?? 0) / 1000).toFixed(1)}k</span>
          <span>予算</span>
          <span className="num">
            {props.task.budgetUsd === null ? (
              <span className="hint">なし</span>
            ) : (
              <>
                {fmtUsd(props.detail?.cost.costUsd ?? 0)} / {fmtUsd(props.task.budgetUsd)}
                {(props.detail?.cost.costUsd ?? 0) > props.task.budgetUsd && <span className="warn"> 超過 — 次のターンは予算を上げるまで送れません</span>}{" "}
                <button className="ghost" onClick={() => api.setBudget(props.task.id, props.task.budgetUsd! * 2).catch((e) => setBudgetErr(String(e.message ?? e)))} title="予算を 2 倍にする">
                  ×2
                </button>
                {(props.detail?.cost.costUsd ?? 0) > props.task.budgetUsd && busy && (
                  <button className="ghost" onClick={props.onAbort} title="このタスクを中断する">
                    中断
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
              <span>GitHub API 残量</span>
              <span className={`num ${githubBudgetLow(props.ledger.github) ? "warn" : ""}`}>{githubBudgetLabel(props.ledger.github)}</span>
            </>
          )}
        </div>}
      </div>

      {!cloud && props.task.resumeAt !== null && (
        <div className="blk">
          <h5>{props.task.resumeReason === "github" ? "GitHub の API 上限" : "使用上限"}</h5>
          <div className="hint">
            {props.task.resumeReason === "github" ? "GitHub の API 上限で待っています。" : "ランナーの使用上限で止まりました。"}
            {!props.task.runnerSessionId ? (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b> に枠が戻る見込みですが、再開できるセッションがありません。返信すると新しいセッションで始まります。
              </>
            ) : autoResumeOn === true ? (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b> に同じセッションで自動再開します。
              </>
            ) : autoResumeOn === false ? (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b> 以降に再開できます。自動再開は OFF（Home のランナー設定で ON にできます）。
              </>
            ) : (
              <>
                <b>{fmtClock(props.task.resumeAt)}</b> に枠が戻る見込み。自動再開の設定はデーモンに接続すると表示されます。
              </>
            )}
          </div>
          <div className="actions" style={{ marginTop: 6 }}>
            <button className="pri" disabled={resumeBusy || busy || !props.task.runnerSessionId} onClick={() => resumeCall(() => api.resumeNow(props.task.id))} title={props.task.resumeReason === "github" ? "待たずに今すぐ「続きを」と送る。GitHub の枠がまだ戻っていなければコマンドがまた上限に当たり、次の時刻で待ち直します" : "待たずに今すぐ「続きを」と送る。枠がまだ戻っていなければまた止まり、次の時刻で待ち直します"}>
              今すぐ再開
            </button>
            <button disabled={resumeBusy} onClick={() => resumeCall(() => api.cancelResume(props.task.id))} title="自動再開をやめる。返信すればいつでも再開できます">
              取り消す
            </button>
          </div>
          {resumeErr && <div className="hint warn">{resumeErr}</div>}
        </div>
      )}

      <div className="blk">
        <h5>操作</h5>
        <div className="actions">
          <button disabled={cloud || !busy} onClick={props.onAbort}>
            中断
          </button>
          <a className="btn" href={`vscode://file${props.task.cwd}`} title="VS Code で開く">
            エディタで開く
          </a>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {cloud ? "Cloudの続行・設定・停止は公式 Web で操作してください。ローカル中断ではCloud作業を止められません。" : "変更したファイルは「差分」タブに。PR 作成は Phase 3"}
        </div>
      </div>

      {!cloud && checks?.meta && (
        <div className="blk">
          <h5>Self-dev · このアプリ自身</h5>
          {!checks.run && !checks.running && <div className="hint">ターン完了後に bun run typecheck / bun test を自動実行します。</div>}
          {checks.running && <div className="hint">チェック実行中…</div>}
          {checks.run && !checks.current && !checks.running && <div className="hint warn">このチェック以降にツリーが変わっています。再実行してください。</div>}
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
              チェック実行
            </button>
            {managed ? null : (
              <>
                <button className="pri" disabled={busy || checks.running || !checks.run?.ok || !checks.current} onClick={() => void restart(false)} title="デーモンを今のコードで再起動します。UI は再接続します">
                  適用してデーモン再起動
                </button>
                {checks.run && !checks.run.ok && (
                  <button className="ghost" disabled={busy} onClick={() => void restart(true)} title="チェックが失敗していても再起動する">
                    強制再起動
                  </button>
                )}
              </>
            )}
          </div>
          {managed && <ReleasePanel disabled={busy} />}
          {release && !release.managed && release.error && <div className="hint warn">{release.error}</div>}
          {restartMsg && <div className="hint">{restartMsg}</div>}
          <div className="hint">apps/web の変更は Vite の HMR で即反映。packages/core の変更は再起動で反映。再起動中も UI は保持されます。</div>
        </div>
      )}

      {staged.length > 0 && (
        <div className="blk">
          <h5>ステージング（未適用の書き込み）</h5>
          {stagedErr && <div className="hint warn">{stagedErr}</div>}
          {staged.map((c) => (
            <div key={c.id} className="staged">
              <button className="row link" onClick={() => setOpenDiff(openDiff === c.id ? null : c.id)} title={c.path}>
                <span className="t mono">{c.rel}</span>
                <span className="tag">{c.kind}</span>
                <span className={`m ${c.status}`}>{c.status === "pending" ? "承認待ち" : c.status === "applied" ? "適用済み" : "却下"}</span>
              </button>
              {openDiff === c.id && <pre className="diff">{c.diff || "(差分なし)"}</pre>}
              {c.status === "pending" && (
                <div className="actions">
                  <button className="pri" onClick={() => void decide(c.id, "apply")}>
                    適用
                  </button>
                  <button onClick={() => void decide(c.id, "reject")}>却下</button>
                </div>
              )}
            </div>
          ))}
          <div className="hint">エージェントの fs.write / fs.patch はここに積まれ、適用するまで実ファイルは変わりません。</div>
        </div>
      )}

      {!cloud && <div className="blk">
        <h5>Workspace MCP</h5>
        {props.task.runner === "claude" && props.detail && (
          <div className="kv">
            <span>渡す MCP</span>
            <span title="mcp.yaml の servers から。ユーザー全体の ~/.claude.json の MCP は Task に渡さない（#2090）">{props.detail.mcpServers?.length ? props.detail.mcpServers.join("、") : "なし（ユーザー全体の MCP は渡さない）"}</span>
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
              title="このタスクのスコープに封じ込めた MCP エンドポイントを発行する（タスク終了で失効）"
            >
              エンドポイントを発行
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
            <span>トークン</span>
            <span className="mono" style={{ wordBreak: "break-all" }}>
              {mcp.token}
            </span>
            <span />
            <span>
              <button className="ghost" onClick={() => void navigator.clipboard?.writeText(`${mcp.url}?token=${mcp.token}`)}>
                URL+token をコピー
              </button>{" "}
              <button
                className="ghost"
                onClick={() =>
                  api
                    .mcpRotate(props.task.id)
                    .then(setMcp)
                    .catch((e) => setMcpErr(String(e.message ?? e)))
                }
                title="今のトークンを失効させて新しく発行する"
              >
                失効して再発行
              </button>
            </span>
          </div>
        )}
        <div className="hint" style={{ marginTop: 6 }}>
          fs.list / fs.read / fs.grep はスコープ内のみ。fs.write / fs.patch はステージングに積まれ、ここで適用。exec.run は読み取り系だけ即時、他はここで承認。タスク終了で失効。
        </div>
      </div>}
    </aside>
  );
}

function QuotaKv(props: { window: string; utilization: number }) {
  return (
    <>
      <span>{windowLabel(props.window)}の枠</span>
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
