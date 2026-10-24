import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DeviceAuthView, EventEnvelope, Task, TaskDiffFile, TaskOutcome, TeleportProgress } from "@switchboard/protocol";
import { api, OLDER_PAGE, type TaskDetail } from "../api.ts";
import { journeyCancel, journeyEnd, journeyStart } from "../perf.ts";
import { eventsArchiveNotice } from "../events-archive.ts";
import { foldTranscript, itemText, spanText, toolInputText, toolResultText, transcriptMarkdown, turnReply, type Item, type PermissionAsk } from "../transcript.ts";
import { answerOf, answersOf, questionsOf, type AskQuestion, type QuestionChoice } from "../questions.ts";
import { CloudSessionNotice, CopyButton, OriginTag, ResumeTag, RunnerPill, ShadowTag } from "./ui.tsx";
import { Terminal } from "./Terminal.tsx";
import { DeviceAuth } from "./DeviceAuth.tsx";
import { Stops } from "./Stops.tsx";
import { judgementNote, outcomeLabel } from "../attention.ts";
import { SINCE, taskTimes } from "../inProgress.ts";
import { Artifacts } from "./Artifacts.tsx";
import { artifactsLabel } from "../artifacts.ts";
import { AttachButton, AttachmentBar, AttachmentGallery, useAttachments, useDropZone } from "./Attachments.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { jstDateTime, jstTime } from "../time.ts";

export function TaskView(props: {
  task: Task;
  onOpenTask?: (id: string) => void;
  detail?: TaskDetail;
  /** Resolves once the daemon took the turn; rejects (after showing the error) otherwise — the composer keeps its text and chips then. */
  onSend: (text: string, attachmentIds?: string[]) => Promise<void>;
  /** `answers` comes with an allow of a question card (AskUserQuestion). */
  onPermission: (id: string, decision: "allow" | "deny", answers?: Record<string, string>) => void;
  onError: (msg: string) => void;
  shadowTask?: Task;
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
    const t = text.trim();
    if ((!t && !attach.items.length) || attach.busy || sending) return; // ⌘↵ and the button share this guard
    journeyStart("send");
    sentAfter.current = Math.max(0, ...(props.detail?.events ?? []).map((e) => e.seq));
    setSending(true);
    try {
      await props.onSend(t, attach.ids.length ? attach.ids : undefined);
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

  const busy = props.task.status === "running" || props.task.status === "waiting";
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
  const teleportReason = (!props.task.cloudSession || !/^session_[A-Za-z0-9_-]+$/.test(props.task.cloudSession.id) || props.task.cloudSession.url !== `https://claude.ai/code/${props.task.cloudSession.id}`) ? "Cloud IDが未確認です。公式Webで確認してください。" : (props.task.status === "running" || props.task.status === "waiting") ? "Cloud開始プロセスの終了後に操作できます。" : !props.pty ? "この環境ではPTYを利用できません。対応環境の公式CLIを使ってください。" : undefined;
  // The terminal is only for the CLI's own questions (#1306); starting does not leave the screen.
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
      props.onOpenTask?.(teleportProgress.localTaskId);
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
  const headStatus = cloud ? (props.task.status === "running" ? "Cloud 開始中" : "Cloud・状態未確認") : SINCE[props.task.status];
  // a Cloud Task's times line does not name a state its head says is not known (#2030)
  const times = taskTimes(props.task, Date.now(), cloud ? (props.task.status === "running" ? "開始中" : "状態未確認") : undefined);
  const diffCount = diff ? new Set(diff.filter((f) => f.stat !== "").map((f) => f.path)).size : 0;

  return (
    <main className="main task" ref={mainRef} onScroll={checkEnd}>
      <div className="task-head">
        <h2>{props.task.title}</h2>
        <span className={`status ${props.task.status}`}>{headStatus}</span>
        <span className="hint task-times">{`${times.started} · ${times.since}`}</span>
        <OriginTag origin={props.task.origin} />
        <ResumeTag resumeAt={props.task.resumeAt} reason={props.task.resumeReason} />
        <ShadowTag task={props.task} />
        <select className="outcome" value={props.task.outcome} disabled={busy} onChange={(e) => setOutcome({ outcome: e.target.value as TaskOutcome })} title="結果（要対応のまとまりの並びに使う）">
          {(["needs_action", "failed", "done", "unknown"] as const).map((o) => (
            <option key={o} value={o}>
              {outcomeLabel(o)}
            </option>
          ))}
        </select>
        <button className="ghost review-toggle" disabled={busy} onClick={() => setOutcome({ reviewed: props.task.reviewedAt === null })}>
          {props.task.reviewedAt === null ? "確認済みにする" : "確認済みを取り消す"}
        </button>
        {(props.task.status === "done" || props.task.status === "error" || props.task.status === "aborted") && (
          <button className="ghost archive-toggle" onClick={() => props.onArchive(props.task.archivedAt === null)}>
            {props.task.archivedAt === null ? "アーカイブ" : "アーカイブを戻す"}
          </button>
        )}
        {judgement && (
          <span className="hint judged" title={judgement.title}>
            {judgement.text}
          </span>
        )}
        {outcomeErr && <span className="hint" role="alert">{outcomeErr}</span>}
        {transcript.lastStatus && busy && <span className="hint">{transcript.lastStatus}</span>}
        {tab === "chat" && <CopyButton label="会話をコピー" text={() => transcriptMarkdown(transcript.items, props.task.runner)} partial={busy} onError={props.onError} />}
        <button className="ghost brief-toggle" onClick={props.onBrief}>
          詳細
        </button>
        <nav className="subtabs">
          <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
            会話
          </button>
          {!cloud && <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>
            差分{diffCount > 0 ? `（${diffCount} ファイル）` : ""}
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
              ターミナル
            </button>
          )}
        </nav>
      </div>

      {tab === "diff" && (
        <div className="diffs">
          {diffErr && <div className="warn">{diffErr}</div>}
          {diff === null && !diffErr && <div className="muted">集計中…</div>}
          {diff && diff.length === 0 && <div className="muted">このタスクによる変更はまだありません（スコープ内の git 作業ツリーとステージングを見ています）。</div>}
          {(diff ?? []).map((f) => (
            <div key={`${f.source}:${f.path}`} className="diff-file">
              <button className="row link" onClick={() => setOpenFile(openFile === f.path ? null : f.path)} title={f.path}>
                <span className="t mono">{f.rel}</span>
                <span className="tag">{f.source === "staging" ? "ステージング" : "作業ツリー"}</span>
                <span className="m num">{f.stat}</span>
              </button>
              <span className="editor-links">
                {f.source === "worktree" && (
                  <>
                    <a className="btn ghost" href={`vscode://file${encodeURI(f.path)}`} title="VS Code で開く">
                      VS Code
                    </a>
                    <a className="btn ghost" href={`cursor://file${encodeURI(f.path)}`} title="Cursor で開く">
                      Cursor
                    </a>
                  </>
                )}
              </span>
              {openFile === f.path && <pre className="diff">{f.diff || "(差分なし)"}</pre>}
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
            以前の会話を読む
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
        {props.detail === undefined && <div className="muted">読み込み中…</div>}
        {!atEnd && tab === "chat" && (
          <button className="ghost jump-latest" onClick={() => endRef.current?.scrollIntoView({ block: "end" })}>
            最新へ ↓
          </button>
        )}
        <div ref={endRef} />
      </div>

      {cloud && <CloudSessionNotice session={props.task.cloudSession} onTeleport={startTeleport} onRefresh={importEnded} teleportReason={teleportReason} progress={teleportProgress} onAnswerInTerminal={answerInTerminal} localTasks={(importDetail ?? props.detail)?.localContinuations} onOpenTask={props.onOpenTask} />}
      {cloud && transcript.lastStatus && <p className="hint" role="status">{transcript.lastStatus}</p>}
      {props.detail?.sourceCloudTask && <div className="card"><p>Cloudから取り込んだLocalセッションです。このTaskへの返信で再開します。Cloudへ自動同期しません。</p><button className="btn" onClick={() => props.onOpenTask?.(props.detail!.sourceCloudTask!.id)}>元Cloud Taskを開く</button></div>}
      {props.detail?.stopSummary && props.detail.stopSummary.length > 0 && <Stops stops={props.detail.stopSummary} issue={props.task.id} />}
      {!cloud && <DeviceAuth auth={props.deviceAuth} onError={props.onError} />}
      {transcript.pending.map((p) => {
        const questions = questionsOf(p.tool, p.input);
        if (questions) return <QuestionCard key={p.id} ask={p} questions={questions} onPermission={props.onPermission} />;
        return (
          <div key={p.id} className="perm" role="alertdialog">
            <div>
              <b>{permLabel(p.kind)}</b>
              <span className="tool-name">{p.tool}</span>
              <code>{p.detail}</code>
              {p.rule && (
                <div className="hint">
                  {p.rule.source.startsWith("policy:") ? "方針" : "ルール"} <span className="mono">{p.rule.source.replace(/^policy:/, "")}</span>「{p.rule.pattern}」に一致（{p.rule.mode === "confirm" ? "都度確認" : "許可"}）
                </div>
              )}
            </div>
            <div className="actions">
              <button className="pri" onClick={() => props.onPermission(p.id, "allow")}>
                許可
              </button>
              <button onClick={() => props.onPermission(p.id, "deny")}>拒否</button>
            </div>
          </div>
        );
      })}

      {!cloud && <PresetPicker workspaceId={props.task.workspaceId} onText={(t) => setText(t)} onError={props.onError} />}
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
            placeholder={busy ? "実行中でも追加指示を送れます（⌘↵）。画像やファイルはドロップ / 貼り付け" : props.task.origin === "terminal" ? "返信すると Switchboard 側で同じセッションを再開します（⌘↵）。Terminal で開いたままなら先に閉じてください" : "返信を書く（⌘↵）。プロセスが終了していれば同じセッションを再開します。画像やファイルはドロップ / 貼り付け"}
          />
          <AttachmentBar items={attach.items} onRemove={attach.remove} busy={attach.busy} />
        </div>
        <AttachButton onFiles={(files) => void attach.add(files)} />
        <button className="pri" disabled={(!text.trim() && !attach.items.length) || attach.busy || sending} onClick={() => void send()} title={attach.busy ? "添付のアップロードが終わるまで待ってください" : ""}>
          {attach.busy ? "アップロード中…" : "送信"}
        </button>
      </div>}
      {props.shadowTask && !props.shadowTask.shadowStopped && (
        <div className="hint composer-hint">
          {props.shadowTask.status === "waiting" ? `並走 Task（${props.shadowTask.runner}）は承認待ちのため、この返信は写されません（答えたあと並走に直接送れます）` : `並走 Task（${props.shadowTask.runner}）にも同じ返信を送ります`}
        </div>
      )}
    </main>
  );
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
            あなた
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
            {props.turn && copy("ターンの返答をコピー", props.turn)}
          </div>
          {it.text && <div className="tx">{it.text}</div>}
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
          <button className="tool-row" onClick={props.onToggle} title="入力と結果を表示">
            <span className="n">{name}</span>
            <span className="s">{summary}</span>
            {byRule && (
              <span className="tag" title={it.ask?.rule ? `${it.ask.rule.source}: ${it.ask.rule.pattern}` : ""}>
                {it.ask?.rule?.source.startsWith("policy:") ? "方針で許可" : "ルールで許可"}
              </span>
            )}
            {it.call && it.at !== undefined && it.endAt !== undefined && (
              <span className="dur" title={`開始 ${jstTime(it.at)} → 終了 ${jstTime(it.endAt)}`}>
                {spanText(it.endAt - it.at)}
              </span>
            )}
            <span className="st">{state === "ok" ? "✓" : state === "fail" ? "✕" : state === "asking" ? "承認待ち" : state === "denied" ? "拒否" : "…"}</span>
          </button>
          {props.showInput && (
            <div className="tool-detail">
              {it.call && copy("入力をコピー", () => toolInputText(it))}
              {it.call && <pre>{JSON.stringify(it.call.input, null, 2)}</pre>}
              {it.result && copy("結果をコピー", () => toolResultText(it))}
              {it.result && <pre className={it.result.ok ? "" : "err"}>{it.result.summary}</pre>}
            </div>
          )}
        </div>
      );
    }
    case "end":
      return (
        <div className={`end ${it.status}`}>
          {it.status === "ok" ? "完了" : it.status === "aborted" ? "中断" : "エラー"}
          {it.at !== undefined && ` ${jstTime(it.at)} · 所要 ${spanText(it.durationMs)}`}
          {it.summary && it.status !== "ok" && <span> — {it.summary}</span>}
        </div>
      );
    case "note":
      return <div className={it.tone === "info" ? "hint" : "note"}>{it.text}</div>;
    case "artifact":
      return (
        <div className="hint artifact-row" data-artifact={it.id}>
          成果物: {it.title}
          <button className="ghost" aria-label={`${it.title} を開く`} onClick={() => props.onOpenArtifact(it.id)}>
            開く
          </button>
        </div>
      );
  }
}

function permLabel(k: "exec" | "write" | "network" | "other") {
  return { exec: "コマンド実行の許可", write: "書き込みの許可", network: "ネットワークアクセスの許可", other: "ツール実行の許可" }[k];
}

/**
 * A pending AskUserQuestion: the agent is not asking for permission but for an answer. Options are radios
 * (checkboxes for multiSelect) plus a free-text field, as in the terminal's 「Other」; 回答する sends the allow with
 * `answers`, 答えない is the deny.
 */
function QuestionCard(props: { ask: PermissionAsk; questions: AskQuestion[]; onPermission: (id: string, decision: "allow" | "deny", answers?: Record<string, string>) => void }) {
  const [choices, setChoices] = useState<(QuestionChoice | undefined)[]>([]); // indexed like props.questions
  const answers = answersOf(props.questions, choices);
  const update = (i: number, fn: (c: QuestionChoice) => QuestionChoice) => setChoices((s) => Object.assign([...s], { [i]: fn(s[i] ?? { labels: [], other: "" }) }));
  return (
    <div className="perm question" role="alertdialog" aria-label="エージェントからの質問">
      <div className="questions">
        <b>質問</b>
        {props.questions.map((q, i) => (
          <fieldset key={i}>
            <legend>
              {q.header && <span className="tag">{q.header}</span>}
              {q.question}
              {q.multiSelect && <span className="hint">（複数選択可）</span>}
            </legend>
            {q.options.map((o) => (
              <label key={o.label} className="opt">
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`${props.ask.id}:${i}`}
                  checked={(choices[i]?.labels ?? []).includes(o.label)}
                  onChange={(e) =>
                    update(i, (c) => (q.multiSelect ? { ...c, labels: e.target.checked ? [...c.labels, o.label] : c.labels.filter((l) => l !== o.label) } : { labels: [o.label], other: "" }))
                  }
                />
                <span>
                  {o.label}
                  {o.description && <span className="hint"> — {o.description}</span>}
                </span>
              </label>
            ))}
            <input
              type="text"
              className="other"
              placeholder={q.options.length ? "その他（自由記述）" : "回答を書く"}
              value={choices[i]?.other ?? ""}
              onChange={(e) => update(i, (c) => (q.multiSelect ? { ...c, other: e.target.value } : { labels: e.target.value ? [] : c.labels, other: e.target.value }))}
            />
            {answerOf(q, choices[i]) && <div className="hint">回答: {answerOf(q, choices[i])}</div>}
          </fieldset>
        ))}
      </div>
      <div className="actions">
        <button className="pri" disabled={!answers} title={answers ? "" : "すべての質問に答えると送れます"} onClick={() => answers && props.onPermission(props.ask.id, "allow", answers)}>
          回答する
        </button>
        <button onClick={() => props.onPermission(props.ask.id, "deny")}>答えない</button>
      </div>
    </div>
  );
}
