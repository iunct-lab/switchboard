import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isWorkingStatus, type Ask, AskAnswer, DeviceAuthView, PolicyInput, StopSummary, EventEnvelope, Task, TaskDiffFile, TaskOutcome, TaskSummary, TeleportProgress } from "@switchboard/protocol";
import { api, OLDER_PAGE, type TaskDetail } from "../api.ts";
import { journeyCancel, journeyEnd, journeyStart } from "../perf.ts";
import { eventsArchiveNotice } from "../events-archive.ts";
import { foldTranscript, itemText, spanText, toolInputText, toolResultText, transcriptMarkdown, turnReply, type Item, type PermissionAsk } from "../transcript.ts";
import { CloudSessionNotice, CloudSourceTag, CopyButton, OriginTag, BackgroundTag, ResumeTag, RunnerPill, ShadowTag } from "./ui.tsx";
import { Terminal } from "./Terminal.tsx";
import { DeviceAuth } from "./DeviceAuth.tsx";
import { Stops } from "./Stops.tsx";
import { activeLabel, judgementNote, outcomeLabel } from "../attention.ts";
import { SINCE, taskTimes } from "../inProgress.ts";
import { Artifacts } from "./Artifacts.tsx";
import { artifactsLabel } from "../artifacts.ts";
import { AttachButton, AttachmentBar, AttachmentGallery, useAttachments, useDropZone } from "./Attachments.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { jstDateTime, jstTime } from "../time.ts";
import { titleToSave } from "../taskTitle.ts";
import { continuationPrompt, overBudget } from "../budgetChoice.ts";
import { AnswerArea } from "./Approvals.tsx";
import { Markdown, MdViewToggle } from "./Markdown.tsx";
import { useMdView } from "../mdView.ts";
import { KIND_LABEL, STATE_LABEL, taskAsks } from "../asks.ts";
import { diffRows, diffTag } from "../diffView.ts";
import { abortNote } from "../runners.ts";
import { t } from "../i18n.ts";
import { task as m } from "../i18n/task.ts";

export function TaskView(props: {
  task: Task;
  onOpenTask?: (id: string) => void;
  /** "ローカルで続ける" finished and opens the imported Local Task (#1634); falls back to `onOpenTask`. */
  onContinuedLocally?: (localTaskId: string) => void;
  /** This Local Task was just switched to by "ローカルで続ける" (#1634): the head says so. */
  switchedFromCloud?: boolean;
  detail?: TaskDetail;
  /** Resolves once the daemon took the turn; rejects (after showing the error) otherwise — the composer keeps its text and chips then. */
  onSend: (text: string, attachmentIds?: string[]) => Promise<void>;
  onPermission: (id: string, decision: "allow" | "deny") => void;
  onError: (msg: string) => void;
  shadowTask?: TaskSummary;
  /** health.features.pty: the daemon can open a shell. False = no terminal tab. */
  pty?: boolean;
  /** Phones only (#369): the Brief is not beside the chat there; this lays it over the screen. */
  onBrief: () => void;
  /** The Task's approval wait elsewhere (#662), if any. */
  deviceAuth?: DeviceAuthView | null;
  /** "Continue locally" for this Cloud Task (#1306), from the WebSocket; the detail has the one from the first load. */
  teleport?: TeleportProgress | null;
  /** An artifact to show first when the 成果物 tab opens (#1778 links to it from the conversation). */
  openArtifact?: string;
  /** Hide a stopped Task from the list, or bring it back (#1142). */
  onArchive: (archived: boolean) => void;
  /** 「以前の会話を読む」 (#1142): reads the page before the first event held; resolves with that page. */
  onLoadOlder: () => Promise<EventEnvelope[]>;
}) {
  const cloud = props.task.executionMode === "cloud";
  const archiveNotice = eventsArchiveNotice(props.detail?.eventsArchive);
  const transcript = useMemo(() => foldTranscript(props.detail?.events ?? []), [props.detail?.events]);
  // The last assistant row of each turn with two or more of them: that row also copies the whole reply (#695).
  const turnEnds = useMemo(() => {
    const ends = new Set<string>();
    let last: string | undefined;
    let rows = 0;
    for (const it of [...transcript.items, undefined]) {
      if (!it || it.kind === "user") {
        if (last && rows >= 2) ends.add(last);
        last = undefined;
        rows = 0;
      } else if (it.kind === "assistant" && it.text) {
        last = it.key;
        rows++;
      }
    }
    return ends;
  }, [transcript.items]);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  // 最新へ (#1315): shown only while the conversation's end is below the view; 48px of slack counts as the end. Measured
  // at `endRef`, not at the bottom of `.main`: the composer under the conversation is not part of "the latest".
  const mainRef = useRef<HTMLElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const checkEnd = () => {
    const el = mainRef.current, end = endRef.current;
    if (el && end) setAtEnd(end.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 48);
  };
  const [showInput, setShowInput] = useState<Record<string, boolean>>({});
  // Attachments (#125) for the next reply; a reply may be attachments only (the daemon adds a fixed sentence).
  const attach = useAttachments(props.onError);
  const drop = useDropZone((files) => void attach.add(files), props.onError);
  const [sending, setSending] = useState(false);

  // Follows the newest event, not the row count: an older page added above (#1142) must not jump to the end
  const lastSeq = props.detail?.events.at(-1)?.seq;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
    checkEnd();
    if (props.detail && transcript.items.length) {
      journeyEnd("new-task");
      journeyEnd("open-task", { taskId: props.detail.task.id, events: props.detail.events.at(-1)?.seq ?? 0 });
    }
  }, [lastSeq, transcript.pending.length]);

  // 「以前の会話を読む」 (#1142): the Task opens on its last events. The button stays until a page comes back short (the
  // seqs can have holes — events moved to S3 — so a count of what is left is not shown); that end is the first seq it was
  // seen at, so a detail read again from its tail (a failed catch-up drops it) has the button again. The view keeps its
  // place: the distance to the bottom is the same after the page is drawn above.
  const firstSeq = props.detail?.events[0]?.seq ?? 1;
  const [olderEndAt, setOlderEndAt] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const fromBottom = useRef<number | null>(null);
  const loadOlder = () => {
    const el = mainRef.current;
    fromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    const from = firstSeq;
    setLoadingOlder(true);
    props
      .onLoadOlder()
      .then((page) => {
        if (page.length < OLDER_PAGE) setOlderEndAt(page[0]?.seq ?? from);
      })
      .catch((e) => props.onError(String((e as Error).message ?? e)))
      .finally(() => setLoadingOlder(false));
  };
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (el && fromBottom.current !== null) el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [firstSeq]);

  // `send` ends once a session.end newer than the send is drawn; null = no send being timed
  const sentAfter = useRef<number | null>(null);
  useEffect(() => {
    const after = sentAfter.current;
    if (after === null || !props.detail?.events.some((e) => e.seq > after && e.ev.t === "session.end")) return;
    sentAfter.current = null;
    journeyEnd("send", { taskId: props.detail.task.id, events: props.detail.events.at(-1)?.seq ?? 0 });
  }, [props.detail?.events]);

  const send = async () => {
    if (cloud) return;
    const body = text.trim();
    if ((!body && !attach.items.length) || attach.busy || sending) return; // ⌘↵ and the button share this guard
    journeyStart("send");
    sentAfter.current = Math.max(0, ...(props.detail?.events ?? []).map((e) => e.seq));
    setSending(true);
    try {
      await props.onSend(body, attach.ids.length ? attach.ids : undefined);
      setText("");
      attach.clear();
    } catch (e) {
      sentAfter.current = null;
      journeyCancel("send");
      // The daemon refused: text and chips stay for a retry. Ids it says were already sent (a turn that failed after
      // taking the files) are dropped — they are in the transcript now and cannot go again.
      const msg = String((e as Error).message ?? e);
      const sent = attach.ids.filter((id) => msg.includes(id));
      if (sent.length) attach.dropSent(sent);
    } finally {
      setSending(false);
    }
  };

  const busy = isWorkingStatus(props.task.status);
  // 予算を超えた (llm-routing.md): the choice shows between turns, never over a running one. The cost is the one the Brief's 予算 row shows.
  const showBudgetChoice = !cloud && !busy && overBudget(props.task, props.detail?.cost.costUsd ?? 0);
  const [budgetChoosing, setBudgetChoosing] = useState(false);
  const continueBudget = () => {
    setBudgetChoosing(true);
    api.setBudget(props.task.id, props.task.budgetUsd! * 2).catch((e) => props.onError(String((e as Error).message ?? e))).finally(() => setBudgetChoosing(false));
  };
  const cutNewTask = () => {
    setBudgetChoosing(true);
    api.createTask({ executionMode: "local", workspaceId: props.task.workspaceId ?? undefined, runner: props.task.runner, model: props.task.model ?? undefined, prompt: continuationPrompt(props.task) })
      .then((created) => props.onOpenTask?.(created.id))
      .catch((e) => props.onError(String((e as Error).message ?? e)))
      .finally(() => setBudgetChoosing(false));
  };
  // 結果 / 確認済み (#492): the answer comes back as task.updated too, which is what the lists redraw from
  const [outcomeErr, setOutcomeErr] = useState<string | null>(null);
  const setOutcome = (body: { outcome?: TaskOutcome; reviewed?: boolean }) => {
    setOutcomeErr(null);
    api.setOutcome(props.task.id, body).catch((e) => setOutcomeErr(String((e as Error).message ?? e)));
  };
  const [tab, setTab] = useState<"chat" | "diff" | "terminal" | "artifacts">("chat");
  // The 成果物 tab's count (#1777), known before the tab is opened; the tab itself reports changes, and an agent's own
  // registration (#1778, an artifact.saved row in the conversation) reads it again so the label keeps up with the row.
  const [artifactCount, setArtifactCount] = useState(0);
  // Mounted at the first open and then only hidden, so the opened report and a pending 元に戻す survive a switch to 会話.
  const [artifactsOpened, setArtifactsOpened] = useState(false);
  const savedRows = transcript.items.filter((it) => it.kind === "artifact").length;
  useEffect(() => {
    let live = true;
    api.listArtifacts(props.task.id).then((l) => live && setArtifactCount(l.length), () => {});
    return () => {
      live = false;
    };
  }, [props.task.id, savedRows]);
  // A hidden conversation measures as "at the end"; back on 会話, measure it again (#1315 review).
  useEffect(() => {
    if (tab === "chat") checkEnd();
  }, [tab]);
  // The shell starts when the tab is first opened, not for every task looked at; after that it stays mounted (hidden).
  const [terminalOpened, setTerminalOpened] = useState(false);
  // Each Teleport attempt gets its own terminal socket: the last one was closed by the daemon when that attempt ended.
  const [terminalEpoch, setTerminalEpoch] = useState(0);
  const lastPhase = useRef<string | undefined>(undefined);
  const [importDetail, setImportDetail] = useState<TaskDetail | null>(null);
  const teleportReason = (!props.task.cloudSession || !/^session_[A-Za-z0-9_-]+$/.test(props.task.cloudSession.id) || props.task.cloudSession.url !== `https://claude.ai/code/${props.task.cloudSession.id}`) ? t(m.teleportNoId) : isWorkingStatus(props.task.status) ? t(m.teleportRunning) : !props.pty ? t(m.teleportNoPty) : undefined;
  // The terminal is only for the CLI's own questions (#1306); starting does not leave the screen.
  // The title is edited in place (#491): Enter / blur saves, Esc drops, an empty or unchanged one is not sent
  const [editingTitle, setEditingTitle] = useState(false);
  const escaped = useRef(false);
  const saveTitle = (value: string) => {
    setEditingTitle(false);
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    const next = titleToSave(value, props.task.title);
    if (next === null) return;
    api.renameTask(props.task.id, next).catch((e) => props.onError(String((e as Error).message ?? e)));
  };
  // "使用中" is compared with the daemon's error text
  const startTeleport = () => { teleportPressed.current = true; api.startTeleport(props.task.id).catch(e => { const m = String((e as Error).message ?? e); if (!m.includes("使用中")) teleportPressed.current = false; props.onError(m); }); }; // a press refused because one already runs (a double press) keeps the mark
  const answerInTerminal = () => { setTerminalOpened(true); setTab("terminal"); };
  const teleportProgress = props.teleport !== undefined ? props.teleport : props.detail?.teleport ?? null;
  // Open the Local Task only for a start pressed on this screen: a `done` left over from before (or a reload) stays put.
  const teleportPressed = useRef(false), teleportSawActive = useRef(false);
  useEffect(() => {
    const phase = teleportProgress?.phase;
    const wasActive = lastPhase.current === "teleporting" || lastPhase.current === "needs-input" || lastPhase.current === "exiting" || lastPhase.current === "importing";
    if (phase === "teleporting" && !wasActive) setTerminalEpoch(n => n + 1);
    lastPhase.current = phase;
    if (!teleportPressed.current) return;
    if (phase === "teleporting" || phase === "needs-input" || phase === "exiting" || phase === "importing") teleportSawActive.current = true;
    else if (teleportSawActive.current && phase === "done" && teleportProgress?.localTaskId) {
      teleportPressed.current = false; teleportSawActive.current = false;
      (props.onContinuedLocally ?? props.onOpenTask)?.(teleportProgress.localTaskId);
    } else if (teleportSawActive.current && phase === "unconfirmed") { teleportPressed.current = false; teleportSawActive.current = false; }
  }, [teleportProgress]);
  const importEnded = () => { if (cloud) api.task(props.task.id).then(setImportDetail).catch(e => props.onError(e.message)); };
  const [diff, setDiff] = useState<TaskDiffFile[] | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  // Re-collect only when a write landed (artifact) or the task ended — never on every tool result while it streams.
  const diffKey = (props.detail?.events ?? []).filter((e) => e.ev.t === "artifact" || e.ev.t === "session.end").length;
  const diffSeq = useRef(0);
  useEffect(() => {
    setDiff(null);
    setOpenFile(null);
    setImportDetail(null);
    setTab("chat"); setTerminalOpened(false);
  }, [props.task.id]);
  // The artifact to show on the 成果物 tab: from Insights' report list (#1835, the effect below) or a row of the
  // conversation (#1778). The sequence makes the same artifact open again on a second press, after another one was picked on the tab.
  const [artifactOpen, setArtifactOpen] = useState<{ id: string; seq: number }>();
  const openArtifact = (id: string) => {
    setArtifactOpen((o) => ({ id, seq: (o?.seq ?? 0) + 1 }));
    setArtifactsOpened(true);
    setTab("artifacts");
  };
  // Opened for one artifact: straight to the 成果物 tab with it selected. After the reset above, so it wins on mount.
  useEffect(() => {
    if (props.openArtifact) openArtifact(props.openArtifact);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.openArtifact]);
  useEffect(() => {
    if (cloud || tab !== "diff") return; // only fetch while the tab is open; the badge shows the last known count
    const seq = ++diffSeq.current;
    api
      .taskDiff(props.task.id)
      .then((d) => {
        if (seq !== diffSeq.current) return;
        setDiff(d);
        setDiffErr(null);
      })
      .catch((e) => {
        if (seq === diffSeq.current) setDiffErr(String(e.message ?? e));
      });
  }, [props.task.id, diffKey, tab, cloud]);
  const judgement = judgementNote(props.task);
  const headStatus = cloud ? (props.task.status === "running" ? t(m.cloudStarting) : t(m.cloudStatusUnchecked)) : (activeLabel(props.task) ?? SINCE[props.task.status]);
  // a Cloud Task's times line does not name a state its head says is not known (#2030)
  const times = taskTimes(props.task, Date.now(), cloud ? (props.task.status === "running" ? t(m.startingWord) : t(m.statusUncheckedWord)) : (activeLabel(props.task) ?? undefined));
  const diffShown = useMemo(() => diffRows(diff ?? []), [diff]);
  const diffCount = new Set(diffShown.files.filter((f) => f.stat !== "").map((f) => f.path)).size;

  return (
    <main className="main task" ref={mainRef} onScroll={checkEnd}>
      <div className="task-head">
        {editingTitle ? (
          <input
            className="task-title-edit"
            autoFocus
            defaultValue={props.task.title}
            aria-label={t(m.titleLabel)}
            maxLength={200}
            onBlur={(e) => saveTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur(); // Enter that confirms a conversion is not a save
              else if (e.key === "Escape") {
                escaped.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <h2 title={t(m.clickToEdit)} style={{ cursor: "text" }} onClick={() => setEditingTitle(true)}>{props.task.title}</h2>
        )}
        <span className={`status ${props.task.status}`}>{headStatus}</span>
        <span className="hint task-times">{`${times.started} · ${times.since}`}</span>
        <OriginTag origin={props.task.origin} />
        <ResumeTag resumeAt={props.task.resumeAt} reason={props.task.resumeReason} plannedAt={props.task.resumePlannedAt} />
        <BackgroundTag background={props.task.background} />
        <ShadowTag task={props.task} />
        {props.detail?.sourceCloudTask && <CloudSourceTag source={props.detail.sourceCloudTask} switched={!!props.switchedFromCloud} onOpen={() => props.onOpenTask?.(props.detail!.sourceCloudTask!.id)} />}
        <select className="outcome" value={props.task.outcome} disabled={busy} onChange={(e) => setOutcome({ outcome: e.target.value as TaskOutcome })} title={t(m.outcomeTitle)}>
          {(["needs_action", "failed", "done", "unknown"] as const).map((o) => (
            <option key={o} value={o}>
              {outcomeLabel(o)}
            </option>
          ))}
        </select>
        <button className="ghost review-toggle" disabled={busy} onClick={() => setOutcome({ reviewed: props.task.reviewedAt === null })}>
          {props.task.reviewedAt === null ? t(m.markReviewed) : t(m.unmarkReviewed)}
        </button>
        {(props.task.status === "done" || props.task.status === "error" || props.task.status === "aborted") && (
          <button className="ghost archive-toggle" onClick={() => props.onArchive(props.task.archivedAt === null)}>
            {props.task.archivedAt === null ? t(m.archive) : t(m.unarchive)}
          </button>
        )}
        {judgement && (
          // one line on a phone (#4066); a tap shows the whole reason
          <span className={`hint judged${reasonOpen ? " open" : ""}`} title={judgement.title} onClick={() => setReasonOpen(!reasonOpen)}>
            {judgement.text}
          </span>
        )}
        {outcomeErr && <span className="hint" role="alert">{outcomeErr}</span>}
        {transcript.lastStatus && busy && <span className="hint">{transcript.lastStatus}</span>}
        {tab === "chat" && <CopyButton label={t(m.copyConversation)} text={() => transcriptMarkdown(transcript.items, props.task.runner)} partial={busy} onError={props.onError} />}
        <button className="ghost brief-toggle" onClick={props.onBrief}>
          {t(m.details)}
        </button>
        {/* the switch rides with the tabs (#3677): one item of the wrapping head, so a run's status line and the 完了-only
            buttons coming and going break the head's first line as before and do not push the switch to a line of its own */}
        <div className="task-tabs">
          {tab === "chat" && <MdViewToggle />}
          <nav className="subtabs">
            <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
              {t(m.tabChat)}
            </button>
            {!cloud && <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>
              {t(m.tabDiff)}{diffCount > 0 ? t(m.diffFiles, { count: diffCount }) : ""}
            </button>}
            <button className={tab === "artifacts" ? "on" : ""} onClick={() => { setArtifactsOpened(true); setTab("artifacts"); }}>
              {artifactsLabel(artifactCount)}
            </button>
            {props.pty && (
              <button
                className={tab === "terminal" ? "on" : ""}
                onClick={() => {
                  setTerminalOpened(true);
                  setTab("terminal");
                }}
              >
                {t(m.tabTerminal)}
              </button>
            )}
          </nav>
        </div>
      </div>

      {tab === "diff" && (
        <div className="diffs">
          {diffErr && <div className="warn">{diffErr}</div>}
          {diff === null && !diffErr && <div className="muted">{t(m.counting)}</div>}
          {diff && diffShown.notes.map((n) => <div key={n} className="muted">{n}</div>)}
          {diffShown.files.map((f) => (
            <div key={`${f.source}:${f.path}`} className="diff-file">
              <button className="row link" onClick={() => setOpenFile(openFile === f.path ? null : f.path)} title={f.path}>
                <span className="t mono">{f.rel}</span>
                <span className="tag">{diffTag(f)}</span>
                <span className="m num">{f.stat}</span>
              </button>
              {openFile === f.path && <pre className="diff">{f.diff || t(m.noDiff)}</pre>}
            </div>
          ))}
        </div>
      )}

      {artifactsOpened && <Artifacts taskId={props.task.id} openId={artifactOpen?.id} openSeq={artifactOpen?.seq} hidden={tab !== "artifacts"} onCount={setArtifactCount} />}

      {terminalOpened && (
        <div className="terminal-pane" hidden={tab !== "terminal"}>
          <Terminal key={`${props.task.id}:${terminalEpoch}`} taskId={props.task.id} teleport={cloud} onEnded={importEnded} />
        </div>
      )}

      <div className="transcript" hidden={tab !== "chat"}>
        {archiveNotice && <div className="hint" data-testid="events-archive-notice">{archiveNotice}</div>}
        {props.detail && firstSeq > 1 && firstSeq !== olderEndAt && (
          <button className="ghost older" disabled={loadingOlder} onClick={loadOlder}>
            {t(m.loadOlder)}
          </button>
        )}
        {transcript.items.map((it) => (
          <TranscriptItem
            key={it.key}
            item={it}
            runner={props.task.runner}
            showInput={!!showInput[it.key]}
            onToggle={() => setShowInput((s) => ({ ...s, [it.key]: !s[it.key] }))}
            partial={busy}
            onError={props.onError}
            turn={turnEnds.has(it.key) ? () => turnReply(transcript.items, it.key).text : undefined}
            onOpenArtifact={openArtifact}
          />
        ))}
        {props.detail === undefined && <div className="muted">{t(m.loading)}</div>}
        {!atEnd && tab === "chat" && (
          <button className="ghost jump-latest" onClick={() => endRef.current?.scrollIntoView({ block: "end" })}>
            {t(m.jumpLatest)}
          </button>
        )}
        <div ref={endRef} />
      </div>

      {cloud && <CloudSessionNotice session={props.task.cloudSession} onTeleport={startTeleport} onRefresh={importEnded} teleportReason={teleportReason} progress={teleportProgress} onAnswerInTerminal={answerInTerminal} localTasks={(importDetail ?? props.detail)?.localContinuations} onOpenTask={props.onOpenTask} />}
      {cloud && transcript.lastStatus && <p className="hint" role="status">{transcript.lastStatus}</p>}
      {props.detail?.stopSummary && props.detail.stopSummary.length > 0 && <Stops stops={props.detail.stopSummary} issue={props.task.id} />}
      {!cloud && <DeviceAuth auth={props.deviceAuth} onError={props.onError} />}
      {!cloud && <TaskAsks task={props.task} stops={props.detail?.stopSummary ?? []} onError={props.onError} />}
      {transcript.pending.map((p) => {
        return (
          <div key={p.id} className="perm" role="alertdialog">
            <div>
              <b>{permLabel(p.kind)}</b>
              <span className="tool-name">{p.tool}</span>
              <code>{p.detail}</code>
              {p.rule && (
                <div className="hint">
                  {p.rule.source.startsWith("policy:") ? t(m.rulePolicy) : t(m.ruleRule)} <span className="mono">{p.rule.source.replace(/^policy:/, "")}</span>{t(m.ruleMatched, { pattern: p.rule.pattern, mode: p.rule.mode === "confirm" ? t(m.modeConfirm) : t(m.modeAllow) })}
                </div>
              )}
            </div>
            <div className="actions">
              <button className="pri" onClick={() => props.onPermission(p.id, "allow")}>
                {t(m.allow)}
              </button>
              <button onClick={() => props.onPermission(p.id, "deny")}>{t(m.deny)}</button>
            </div>
          </div>
        );
      })}

      {showBudgetChoice && (
        <div className="budget-choice" role="group" aria-label={t(m.budgetChoiceLabel)}>
          <span className="hint">{t(m.budgetChoiceHint, { budget: props.task.budgetUsd! })}</span>
          <button disabled={budgetChoosing} onClick={continueBudget} title={t(m.budgetContinueTitle, { budget: props.task.budgetUsd! * 2 })}>{t(m.budgetContinue)}</button>
          <button disabled={budgetChoosing} onClick={cutNewTask} title={t(m.budgetCutTitle)}>{t(m.budgetCut)}</button>
        </div>
      )}
      {!cloud && <PresetPicker workspaceId={props.task.workspaceId} onText={(s) => setText(s)} onError={props.onError} />}
      {!cloud && <div className="composer">
        <div className={`dropzone ${drop.dropping ? "dropping" : ""}`} {...drop.handlers}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={drop.onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            rows={2}
            placeholder={busy ? t(m.placeholderBusy) : props.task.origin === "terminal" ? t(m.placeholderTerminal) : t(m.placeholderReply)}
          />
          <AttachmentBar items={attach.items} onRemove={attach.remove} busy={attach.busy} />
        </div>
        <AttachButton onFiles={(files) => void attach.add(files)} />
        <button className="pri" disabled={(!text.trim() && !attach.items.length) || attach.busy || sending} onClick={() => void send()} title={attach.busy ? t(m.waitUpload) : ""}>
          {attach.busy ? t(m.uploading) : t(m.send)}
        </button>
      </div>}
      {props.shadowTask && !props.shadowTask.shadowStopped && (
        <div className="hint composer-hint">
          {props.shadowTask.status === "waiting" ? t(m.shadowWaiting, { runner: props.shadowTask.runner }) : t(m.shadowCopies, { runner: props.shadowTask.runner })}
        </div>
      )}
    </main>
  );
}

/** A runner's reply: Markdown preview or the plain text (#3677). Only this subscribes to the switch, so switching redraws the
 *  replies and not the tool rows around them. */
function ReplyText(props: { text: string }) {
  const [view] = useMdView();
  return view === "preview" ? <div className="tx"><Markdown text={props.text} /></div> : <div className="tx">{props.text}</div>;
}

function TranscriptItem(props: {
  item: Item;
  runner: Task["runner"];
  showInput: boolean;
  /** An artifact row (#1778): open it on the 成果物 tab. */
  onOpenArtifact: (id: string) => void;
  onToggle: () => void;
  /** The task is running: what is copied is the text so far. */
  partial: boolean;
  onError: (msg: string) => void;
  /** Set on the last assistant row of a turn with two or more: the turn's whole reply. */
  turn?: () => string;
}) {
  const it = props.item;
  const copy = (label: string | undefined, text: () => string) => <CopyButton label={label} text={text} partial={props.partial} onError={props.onError} />;
  switch (it.kind) {
    case "user":
      return (
        <div className="msg user">
          <div className="who">
            {t(m.you)}
            {it.at !== undefined && <span className="at" title={jstDateTime(it.at)}>{jstTime(it.at)}</span>}
            {it.text && copy(undefined, () => itemText(it))}
          </div>
          {it.text && <div className="tx">{it.text}</div>}
          {it.attachments && <AttachmentGallery items={it.attachments} />}
        </div>
      );
    case "assistant":
      return (
        <div className="msg assistant">
          <div className="who">
            <RunnerPill runner={props.runner} />
            {it.at !== undefined && <span className="at" title={jstDateTime(it.at)}>{jstTime(it.at)}</span>}
            {it.text && copy(undefined, () => itemText(it))}
            {props.turn && copy(t(m.copyTurn), props.turn)}
          </div>
          {it.text && <ReplyText text={it.text} />}
          {it.attachments && <AttachmentGallery items={it.attachments} />}
        </div>
      );
    case "tool": {
      const name = it.call?.name ?? it.ask?.tool ?? "tool";
      const summary = it.call?.summary ?? it.ask?.detail ?? "";
      const state = it.result ? (it.result.ok ? "ok" : "fail") : it.ask && !it.decision ? "asking" : it.decision === "deny" ? "denied" : "run";
      const byRule = it.decidedBy === "rule";
      return (
        <div className={`tool ${state}`}>
          <button className="tool-row" onClick={props.onToggle} title={t(m.showIO)}>
            <span className="n">{name}</span>
            <span className="s">{summary}</span>
            {byRule && (
              <span className="tag" title={it.ask?.rule ? `${it.ask.rule.source}: ${it.ask.rule.pattern}` : ""}>
                {it.ask?.rule?.source.startsWith("policy:") ? t(m.allowedByPolicy) : t(m.allowedByRule)}
              </span>
            )}
            {it.call && it.at !== undefined && it.endAt !== undefined && (
              <span className="dur" title={t(m.toolSpan, { start: jstTime(it.at), end: jstTime(it.endAt) })}>
                {spanText(it.endAt - it.at)}
              </span>
            )}
            <span className="st">{state === "ok" ? "✓" : state === "fail" ? "✕" : state === "asking" ? t(m.statusWaiting) : state === "denied" ? t(m.denied) : "…"}</span>
          </button>
          {props.showInput && (
            <div className="tool-detail">
              {it.call && copy(t(m.copyInput), () => toolInputText(it))}
              {it.call && <pre>{JSON.stringify(it.call.input, null, 2)}</pre>}
              {it.result && copy(t(m.copyResult), () => toolResultText(it))}
              {it.result && <pre className={it.result.ok ? "" : "err"}>{it.result.summary}</pre>}
            </div>
          )}
        </div>
      );
    }
    case "end":
      return (
        <div className={`end ${it.status}`}>
          {it.status === "ok" ? t(m.statusDone) : it.status === "aborted" ? t(m.statusAborted) : t(m.sinceError)}
          {it.at !== undefined && t(m.endTime, { time: jstTime(it.at), span: spanText(it.durationMs) })}
          {it.summary && it.status !== "ok" && <span> — {it.summary}</span>}
          {abortNote(props.runner, it.status) && <span> — {abortNote(props.runner, it.status)}</span>}
        </div>
      );
    case "note":
      return <div className={it.tone === "info" ? "hint" : "note"}>{it.text}</div>;
    case "artifact":
      return (
        <div className="hint artifact-row" data-artifact={it.id}>
          {t(m.artifactLine, { title: it.title })}
          <button className="ghost" aria-label={t(m.openNamed, { title: it.title })} onClick={() => props.onOpenArtifact(it.id)}>
            {t(m.open)}
          </button>
        </div>
      );
  }
}

function permLabel(k: "exec" | "write" | "network" | "other") {
  return { exec: t(m.permExec), write: t(m.permWrite), network: t(m.permNetwork), other: t(m.permOther) }[k];
}

/**
 * The Task's open operational checks and the stops a person answers (#2745), with the 判断待ち screen's buttons: a choice
 * or a grant goes as the person's reply, as it does there. Read again whenever the Task changes and after an answer —
 * only while it can have one (stopped 要対応, or a stop a person decides), so an ordinary Task's screen asks nothing more.
 */
function TaskAsks(props: { task: Task; stops: StopSummary[]; onError: (msg: string) => void }) {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [busy, setBusy] = useState(false);
  const id = props.task.id;
  // only the newest read is shown: an older one answering late would bring back a list from before the Task changed
  const reads = useRef(0);
  const load = () => {
    const n = ++reads.current;
    api.asks().then(
      (l) => n === reads.current && setAsks(taskAsks(l.asks, id)),
      () => {},
    );
  };
  const cur = props.task;
  const may = (cur.outcome === "needs_action" && (cur.status === "waiting" || !isWorkingStatus(cur.status)) && cur.status !== "idle") || props.stops.some((s) => s.next === "decide");
  useEffect(() => {
    if (may) load();
    else {
      reads.current++;
      setAsks([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cur.updatedAt, cur.status, may]);
  const answer = (x: Ask, a: AskAnswer, policy?: PolicyInput) => {
    if (busy) return;
    setBusy(true);
    api
      .answerAsk(x.id, a, policy)
      // a reply the Task refused (its budget) is a 200 whose resume failed: said, as the 判断待ち screen's badge says it
      .then((r) => r.ask?.resume?.state === "failed" && props.onError(r.ask.resume.reason ? t(m.resumeFailedWhy, { reason: r.ask.resume.reason }) : t(m.resumeFailed)))
      .catch((e) => props.onError(String((e as Error).message ?? e)))
      .finally(() => {
        setBusy(false);
        load();
      });
  };
  if (!asks.length) return null;
  return (
    <div className="task-asks">
      {asks.map((x) => (
        <section key={x.id} className="card ask" data-ask={x.id}>
          <div className="ask-tags">
            <span className={`badge ask-kind ask-kind-${x.kind}`}>{KIND_LABEL[x.kind]}</span>
            <span className={`badge ask-state ask-state-${x.state}`}>{STATE_LABEL[x.state]}</span>
          </div>
          <b>{x.question ?? x.reason}</b>
          <AnswerArea key={x.id} ask={x} busy={busy} onAnswer={(a, policy) => answer(x, a, policy)} />
        </section>
      ))}
    </div>
  );
}
