import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceAuthView, EventEnvelope, LedgerSummary, PendingApproval, ServerMessage, Task, TeleportProgress, Workspace } from "@switchboard/protocol";
import { applyApprovalEvent, mergeFetched } from "./approvals.ts";
import { mergeEvents, taskReader } from "./catchup.ts";
import { noticeFor, showNotice } from "./notify.ts";
import { Approvals } from "./components/Approvals.tsx";
import { api, connectEvents, getToken, setToken, type Health, type TaskDetail } from "./api.ts";
import { journeyCancel, journeyEnd, journeyStart } from "./perf.ts";
import { loginRoute, STUCK_MESSAGE, STUCK_RESCUE, withoutFromAuth } from "./login.ts";
import { newVersionLink, rescueLink, type ReleaseStatus } from "./release.ts";
import { archiveBanner } from "./archive.ts";
import { watchHealth } from "./healthWatch.ts";
import { Backlog } from "./components/Backlog.tsx";
import { Brief } from "./components/Brief.tsx";
import { Home } from "./components/Home.tsx";
import { Knowledge } from "./components/Knowledge.tsx";
import { Ledger } from "./components/Ledger.tsx";
import { Evals } from "./components/Evals.tsx";
import { Schedules } from "./components/Schedules.tsx";
import { FeedbackDialog, type FeedbackPrefill } from "./components/Feedback.tsx";
import { Rail } from "./components/Rail.tsx";
import { RunnerLogin } from "./components/RunnerLogin.tsx";
import { Settings } from "./components/Settings.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { RecentCheck } from "./components/RecentCheck.tsx";
import { usePageDropGuard } from "./components/Attachments.tsx";
import { screenLabel, type View } from "./screen.ts";
import type { FeedbackTarget } from "./feedbackTarget.ts";

/** /approvals is the one screen with its own URL: the phone app (PWA) starts there (#26). */
const initialView = (): View => (location.pathname === "/approvals" ? { name: "approvals" } : { name: "home" });

/** How often an open page reads /api/health again (#1600). */
const HEALTH_REFRESH_MS = 5 * 60_000;

export function App() {
  usePageDropGuard(); // a file dropped outside a dropzone must not navigate the tab away (#125)
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // the workspace a request is filed for: the backlog's narrowed one when opened there, else the meta workspace
  const [feedbackWorkspace, setFeedbackWorkspace] = useState<FeedbackTarget | undefined>();
  // 改善要望にする (#1221): the draft the dialog opens with, from a task's evaluations
  const [feedbackPrefill, setFeedbackPrefill] = useState<FeedbackPrefill | undefined>();
  const [health, setHealth] = useState<Health | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listed, setListed] = useState(false); // the first task list came back
  const [ledger, setLedger] = useState<LedgerSummary | null>(null);
  const [details, setDetails] = useState<Record<string, TaskDetail>>({});
  // approval waits by Task (#662): from the WebSocket and the Task's first load, never stored
  const [deviceAuths, setDeviceAuths] = useState<Record<string, DeviceAuthView | null>>({});
  // "continue locally" by Cloud Task (#1306): from the WebSocket; the open Task's first load brings the current one
  const [teleports, setTeleports] = useState<Record<string, TeleportProgress | null>>({});
  const [view, setView] = useState<View>(initialView);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [railListOpen, setRailListOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [knowledgeRev, setKnowledgeRev] = useState(0);
  const [tokenDraft, setTokenDraft] = useState("");
  const [checksRev, setChecksRev] = useState(0);
  // Evals (#1219): per task, how many times its judge row changed; the open task's Brief reads its evals again on its own count only
  const [evalsRev, setEvalsRev] = useState<Record<string, number>>({});
  // and how many of them in all, for the Evals screen's re-read
  const [evalsAnyRev, setEvalsAnyRev] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [authRev, setAuthRev] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rescueHref, setRescueHref] = useState<string | null | undefined>(undefined);
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  // OS notices for approval waits (#1138): the list as of the last render names the task; `notified` keeps a reconnect quiet
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const notified = useRef(new Set<string>());

  // the list is read again: the backlog may name a workspace registered since App last read it
  const openFeedback = (workspace?: FeedbackTarget, prefill?: FeedbackPrefill) => {
    setFeedbackWorkspace(workspace);
    setFeedbackPrefill(prefill);
    setFeedbackOpen(true);
    api.workspaces().then(setWorkspaces).catch(() => undefined);
  };
  // 改善要望にする (#1221): the daemon drafts the request from the task's evaluations; the dialog opens with it
  const improveFromEvals = (taskId: string) => {
    api
      .evalsDraft(taskId)
      .then((d) => openFeedback(undefined, { text: d.text, source: { kind: "eval", taskId } }))
      .catch((e) => setError(String(e.message ?? e)));
  };
  const refreshLedger = useCallback(() => api.ledger().then(setLedger).catch(() => undefined), []);
  const refreshApprovals = useCallback(() => {
    const since = Date.now();
    api
      .approvals()
      .then((fetched) => setApprovals((prev) => mergeFetched(fetched, prev, since)))
      .catch(() => undefined);
  }, []);
  // Task details read whole on open and caught up through ?after= on each connect (#1137, taskReader in catchup.ts)
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const reader = useMemo(() => taskReader({ read: api.task, held: () => detailsRef.current, update: setDetails, failed: (e) => setError(String(e.message ?? e)) }), []);
  const loadTask = reader.load;
  // After a turn (usage / session.end / a stop record): the rest of the detail only (?limit=0, #1142). The events came
  // over the WebSocket already; reading them again would read the whole conversation each turn.
  const refreshTaskMeta = useCallback((id: string) => {
    api.taskMeta(id).then((d) => setDetails((prev) => (prev[id] ? { ...prev, [id]: { ...d, events: prev[id]!.events } } : prev))).catch(() => undefined);
  }, []);
  // 「以前の会話を読む」 (#1142): the page before the first event held, merged by seq; resolves with the page
  const loadOlder = useCallback(async (id: string) => {
    const first = detailsRef.current[id]?.events[0]?.seq;
    if (!first || first <= 1) return [];
    const older = await api.taskEvents(id, first);
    setDetails((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id]!, events: mergeEvents(prev[id]!.events, older) } } : prev));
    return older;
  }, []);
  // and, after a drop, the list again (task.updated sent while away; the first connect follows the launch's own read)
  const dropped = useRef(false);
  // the archived ones too once the rail has shown them (#1142): archived or brought back while away, from another tab
  const archivedShown = useRef(false);
  const catchUp = useCallback(() => {
    if (dropped.current)
      Promise.all([api.tasks(), archivedShown.current ? api.tasks({ archived: true }) : []])
        .then(([list, archived]) => setTasks([...list, ...archived]))
        .catch(() => undefined);
    dropped.current = false;
    reader.connected();
  }, [reader]);
  const loadDeviceAuth = useCallback(
    (id: string) =>
      api
        .deviceAuth(id)
        // a message that came over the WebSocket while this was asked is newer: it stays
        .then((a) => setDeviceAuths((prev) => (id in prev ? prev : { ...prev, [id]: a })))
        .catch(() => undefined),
    [],
  );

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(`core に接続できません: ${e.message}`));
    api.workspaces().then(setWorkspaces).catch(() => undefined);
    api
      .tasks()
      .then((t) => {
        setTasks(t);
        setListed(true);
      })
      .catch(() => undefined);
    refreshApprovals();
    void refreshLedger();
  }, [refreshLedger, refreshApprovals, authRev]);
  // the banners (a failed archive, a runner's login) follow the daemon while the page stays open (#1600); a failed read keeps the last
  useEffect(() => watchHealth(document, () => void api.health().then(setHealth).catch(() => undefined), HEALTH_REFRESH_MS), []);

  // The daemon answers health with the runner list only to an authorized caller (a token, or the cloud login cookie).
  const login = health?.authRequired ? loginRoute({ authorized: health.runners !== undefined, hasToken: !!getToken(), mode: health.login, path: location.pathname + location.search }) : { kind: "none" as const };
  const needsToken = login.kind === "token";
  // The rescue page's link (#399) and the new-version mark (#1660) come from one read, asked once the daemon lets us in and
  // again each time the connection changes (a promotion ends in a restart). A failed ask keeps the last one: the link is for when the
  // daemon is in trouble, so "daemon offline" must not take it away.
  const authorized = health?.runners !== undefined;
  useEffect(() => {
    if (authorized) api.release().then((r) => { setRelease(r); setRescueHref(rescueLink(r)); }).catch(() => undefined);
  }, [authorized, connected]);
  // Settings scrolls to its release section once it has loaded (the section is not drawn before that)
  const [releaseFocus, setReleaseFocus] = useState(0);
  useEffect(() => {
    if (view.name !== "settings") setReleaseFocus(0); // the next visit by the tab does not scroll
  }, [view.name]);
  const openRelease = () => {
    setView({ name: "settings" });
    setReleaseFocus((n) => n + 1);
  };
  const newVersion = newVersionLink(release);
  // in: the passkey page's mark has done its job; a later refusal must go back to the passkey page, not read as stuck (#709)
  useEffect(() => {
    const clean = authorized && withoutFromAuth(location.pathname + location.search);
    if (clean) history.replaceState(history.state, "", clean + location.hash);
  }, [authorized]);
  // `launch` ends once the list is in and health is (the composer's runner and 開始 wait for it)
  useEffect(() => {
    if (health && listed) journeyEnd("launch");
  }, [health, listed]);
  const passkeyUrl = login.kind === "passkey" ? login.url : null;
  useEffect(() => {
    if (passkeyUrl) location.assign(passkeyUrl);
  }, [passkeyUrl]);

  const openTask = useCallback((id: string) => setView({ name: "task", id }), []);

  useEffect(() => {
    const onMessage = (m: ServerMessage) => {
      const notice = noticeFor(m, tasksRef.current, notified.current);
      if (notice)
        showNotice(notice, typeof Notification === "undefined" ? undefined : Notification, (id) => {
          window.focus();
          openTask(id);
        });
      // a task's ask can come before the render that lists it: the next notice names it all the same
      if (m.type === "task.updated") tasksRef.current = [m.task, ...tasksRef.current.filter((t) => t.id !== m.task.id)];
      if (m.type === "event") {
        const env: EventEnvelope = m.env;
        setApprovals((prev) => applyApprovalEvent(prev, env));
        if (env.ev.t === "session.end") refreshApprovals(); // the daemon decides whether the turn's asks are still open
        if (!detailsRef.current[env.taskId]) reader.missed(env.taskId); // a whole read on its way follows past its snapshot
        setDetails((prev) => {
          const d = prev[env.taskId];
          if (!d) return prev;
          const events = mergeEvents(d.events, [env]);
          return events === d.events ? prev : { ...prev, [env.taskId]: { ...d, events } };
        });
        if (env.ev.t === "stop.record") refreshTaskMeta(env.taskId); // the stop series (#939) is derived from the records
        if (env.ev.t === "usage" || env.ev.t === "quota" || env.ev.t === "session.end") {
          void refreshLedger();
          if (env.ev.t !== "quota") refreshTaskMeta(env.taskId);
        }
      } else if (m.type === "knowledge.updated") {
        setKnowledgeRev((n) => n + 1);
      } else if (m.type === "checks.updated") {
        setChecksRev((n) => n + 1);
      } else if (m.type === "evals.updated") {
        setEvalsRev((r) => ({ ...r, [m.taskId]: (r[m.taskId] ?? 0) + 1 }));
        setEvalsAnyRev((n) => n + 1);
      } else if (m.type === "daemon.restarting") {
        setRestarting(true);
        // If nothing comes back, stop pretending: the user needs to look at the daemon log.
        setTimeout(() => setRestarting((r) => (r ? false : r)), 45_000);
      } else if (m.type === "error") {
        setError(m.message);
      } else if (m.type === "task.updated") {
        upsertTask(m.task);
      } else if (m.type === "task.teleport") {
        setTeleports((prev) => ({ ...prev, [m.taskId]: m.progress }));
      } else if (m.type === "task.deviceAuth") {
        setDeviceAuths((prev) => ({ ...prev, [m.taskId]: m.auth }));
      }
    };
    return connectEvents(onMessage, (c) => {
      setConnected(c);
      if (!c) dropped.current = true;
      if (c) setRestarting(false);
      // events missed while disconnected (a locked phone) are read again by catchUp through ?after= (#1137); the approvals
      // list and the approval waits are read again on their own (the open Task's wait is asked again)
      if (c) refreshApprovals();
      if (c) setDeviceAuths({});
      if (c) {
        // "continue locally" progress: what was cached may be older than what happened while away. Forget it (a message
        // from now on is newer); catchUp brings each held Task's current one with its detail.
        setTeleports({});
        catchUp();
      }
    });
  }, [refreshTaskMeta, refreshLedger, refreshApprovals, openTask, catchUp, reader]);

  useEffect(() => {
    const path = view.name === "approvals" ? "/approvals" : "/";
    if (location.pathname !== path) history.replaceState(null, "", path);
  }, [view]);

  useEffect(() => {
    setRailListOpen(false); // a task picked from the phone's list replaces the list (#359)
    setBriefOpen(false); // and another task does not open with the last one's Brief over it (#369)
  }, [view]);

  useEffect(() => {
    if (view.name === "task" && !details[view.id]) void loadTask(view.id);
  }, [view, details, loadTask]);
  // A wait exists only while a command of a turn runs: asked once for a running Task (the WebSocket brings the rest),
  // never for a finished one (opening it costs no extra request).
  const openStatus = view.name === "task" ? tasks.find((t) => t.id === view.id)?.status : undefined;
  useEffect(() => {
    if (view.name === "task" && (openStatus === "running" || openStatus === "waiting") && !(view.id in deviceAuths)) void loadDeviceAuth(view.id);
  }, [view, openStatus, deviceAuths, loadDeviceAuth]);

  // only a pick in the rail is the `open-task` journey; the other ways in (Ledger, approvals, …) are not timed
  // (the task already open is not a journey: nothing is drawn again; it still navigates, closing the phone's list)
  const openTaskFromRail = useCallback(
    (id: string) => {
      if (!(view.name === "task" && view.id === id)) journeyStart("open-task");
      openTask(id);
    },
    [openTask, view],
  );
  /** A task as the daemon now has it — from the socket or from a request's response — into the list and the open detail. */
  const upsertTask = useCallback((task: Task) => {
    setTasks((prev) => {
      const i = prev.findIndex((t) => t.id === task.id);
      if (i < 0) return [task, ...prev];
      const next = [...prev];
      next[i] = task;
      return next;
    });
    setDetails((prev) => (prev[task.id] ? { ...prev, [task.id]: { ...prev[task.id]!, task } } : prev));
  }, []);
  // Archived Tasks (#1142) are read only when the rail asks to show them; Home leaves them out
  const live = useMemo(() => tasks.filter((t) => t.archivedAt === null), [tasks]);
  const showArchived = useCallback(() => {
    archivedShown.current = true;
    api.tasks({ archived: true }).then((list) => list.forEach(upsertTask)).catch((e) => setError(String(e.message ?? e)));
  }, [upsertTask]);
  const archiveTask = useCallback((id: string, archived: boolean) => {
    api.setArchived(id, archived).then(upsertTask).catch((e) => setError(String(e.message ?? e)));
  }, [upsertTask]);

  const createTask = useCallback(
    async (input: Parameters<typeof api.createTask>[0]) => {
      journeyStart("new-task");
      setError(null);
      const t = await api.createTask(input).catch((e) => {
        journeyCancel("new-task");
        throw e;
      });
      setTasks((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
      openTask(t.id);
    },
    [openTask],
  );

  const current = view.name === "task" ? details[view.id] : undefined;
  const currentTask = view.name === "task" ? tasks.find((t) => t.id === view.id) ?? current?.task : undefined;
  const runnerOk = useMemo(() => new Set((health?.runners ?? []).filter((r) => r.available).map((r) => r.id)), [health]);

  return (
    <div className="app">
      <RecentCheck />
      <header className="chrome">
        <span className="brand">Switchboard</span>
        <nav className="tabs">
          <button className={view.name === "home" ? "on" : ""} onClick={() => setView({ name: "home" })}>
            Home
          </button>
          <button className={view.name === "task" ? "on" : ""} disabled={view.name !== "task"}>
            Task
          </button>
          <button className={view.name === "knowledge" ? "on" : ""} onClick={() => setView({ name: "knowledge" })}>
            Knowledge
          </button>
          <button className={view.name === "ledger" ? "on" : ""} onClick={() => setView({ name: "ledger" })}>
            Ledger
          </button>
          <button className={view.name === "evals" ? "on" : ""} onClick={() => setView({ name: "evals" })}>
            Insights
          </button>
          <button className={view.name === "backlog" ? "on" : ""} onClick={() => setView({ name: "backlog" })}>
            Backlog
          </button>
          <button className={view.name === "schedules" ? "on" : ""} onClick={() => setView({ name: "schedules" })}>
            Schedules
          </button>
          <button className={view.name === "settings" ? "on" : ""} onClick={() => setView({ name: "settings" })}>
            Settings
          </button>
        </nav>
        <span className={`conn ${connected ? "ok" : "off"}`}>{connected ? "daemon connected" : "daemon offline"}</span>
        {/* Until the answer comes the slot is held by an invisible copy, so the tabs do not shrink under a tap (#1485). */}
        {rescueHref === undefined && (
          <span className="rescue-link" aria-hidden="true" style={{ visibility: "hidden" }}>
            Rescue
          </span>
        )}
        {newVersion && (
          <button className="new-version" onClick={openRelease}>
            {newVersion}
          </button>
        )}
        {rescueHref && (
          <a className="rescue-link" href={rescueHref}>
            Rescue
          </a>
        )}
      </header>

      {login.kind === "stuck" && (
        <div className="banner error" role="alert">
          {STUCK_MESSAGE} <a href={STUCK_RESCUE}>救援画面を開く</a>
        </div>
      )}

      {needsToken && (
        <div className="banner" role="alert">
          <span>
            このデーモンは loopback 以外で listen しているためトークンが必要です。<code>~/.switchboard/token</code> の内容を貼り付けてください。
          </span>
          <span className="row">
            <input value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder="sb_…" className="mono" />
            <button
              className="pri"
              disabled={!tokenDraft.trim()}
              onClick={() => {
                setToken(tokenDraft.trim());
                setTokenDraft("");
                setAuthRev((n) => n + 1);
                location.reload();
              }}
            >
              保存
            </button>
          </span>
        </div>
      )}

      {restarting && <div className="banner">デーモンを再起動しています… 再接続するまでお待ちください（45 秒経っても戻らなければ ~/.switchboard/daemon.log を確認）。</div>}

      {health?.homeIsTemp && (
        <div className="banner error" role="alert">
          <span>
            保存先が一時ディレクトリです: <code>{health.home}</code> — ここに記録した Task・台帳は OS に消され、<code>SWITCHBOARD_HOME</code> を付けずに起動し直すと見えなくなります。変数を外す（既定 <code>~/.switchboard</code>）か、恒久的な場所にしてください。
          </span>
        </div>
      )}
      {health?.archive && (
        <div className="banner error archive-failed" role="alert">
          <span>{archiveBanner(health.archive)}</span>
        </div>
      )}

      {health?.runners
        ?.filter((r) => r.login === "expired")
        .map((r) => (
          <div key={r.id} className="banner error login-expired" role="alert">
            <span>{r.id} のログインが切れています。</span>
            <RunnerLogin runner={r.id} onDone={() => api.health({ recheck: true }).then(setHealth).catch(() => undefined)} onError={setError} />
            <button className="ghost" onClick={() => api.health({ recheck: true }).then(setHealth).catch((e) => setError(`core に接続できません: ${e.message}`))}>
              再確認
            </button>
          </div>
        ))}

      {error && (
        <div className="banner error" role="alert">
          {error}
          <button className="ghost" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}

      <div className="body">
        <Rail onFeedback={() => openFeedback()} workspaces={workspaces} tasks={tasks} currentTaskId={view.name === "task" ? view.id : undefined} approvals={approvals.length} approvalsOpen={view.name === "approvals"} onApprovals={() => setView({ name: "approvals" })} listOpen={railListOpen} onToggleList={() => setRailListOpen((o) => !o)} onOpenTask={openTaskFromRail} onHome={() => setView({ name: "home" })} onShowArchived={showArchived} />

        {view.name === "home" && (
          <Home
            health={health}
            workspaces={workspaces}
            tasks={live}
            ledger={ledger}
            runnerOk={runnerOk}
            onCreate={createTask}
            onOpenTask={openTask}
            onAddWorkspace={async (path, backlog) => {
              const ws = await api.addWorkspace(path, backlog);
              setWorkspaces((prev) => [...prev.filter((w) => w.id !== ws.id), ws]);
            }}
            onError={setError}
            inboxRev={knowledgeRev}
            onOpenSettings={() => setView({ name: "settings" })}
            onOpenReport={(id) => setView({ name: "evals", report: id })}
          />
        )}

        {view.name === "task" && currentTask && (
          <>
            <TaskView
              key={currentTask.id}
              task={currentTask}
              shadowTask={tasks.find((t) => t.shadowOf === currentTask.id)}
              pty={health?.features?.pty}
              detail={current}
              deviceAuth={deviceAuths[currentTask.id]}
              teleport={teleports[currentTask.id]}
              onSend={(text, attachmentIds) =>
                api.send(currentTask.id, text, attachmentIds).then(
                  () => undefined,
                  (e) => {
                    setError(e.message);
                    throw e;
                  },
                )
              }
              onPermission={(id, decision, answers) => api.permission(currentTask.id, id, decision, answers).catch((e) => setError(e.message))}
              onError={setError}
              onBrief={() => setBriefOpen(true)}
              onOpenTask={openTask}
              openArtifact={view.artifact}
              onArchive={(archived) => archiveTask(currentTask.id, archived)}
              onLoadOlder={() => loadOlder(currentTask.id)}
            />
            <Brief open={briefOpen} onClose={() => setBriefOpen(false)} task={currentTask} detail={current} ledger={ledger} onAbort={() => api.abort(currentTask.id).catch((e) => setError(e.message))} checksRev={checksRev} evalsRev={evalsRev[currentTask.id] ?? 0} onImprove={improveFromEvals} onRestarting={() => setRestarting(true)} runners={health?.runners} noTerminal={health?.features?.pty === false} onTask={upsertTask} tasks={tasks} onOpenTask={openTask} workspaces={workspaces} />
          </>
        )}
        {view.name === "task" && !currentTask && <main className="main">読み込み中…</main>}
        {view.name === "knowledge" && <Knowledge refreshKey={knowledgeRev} workspaces={workspaces} onError={setError} />}
        {view.name === "ledger" && <Ledger ledger={ledger} onOpenTask={openTask} onOpenInsights={() => setView({ name: "evals" })} onError={setError} />}
        {view.name === "evals" && <Evals workspaces={workspaces} runners={health?.runners} onOpenTask={openTask} onError={setError} rev={evalsAnyRev} onImprove={improveFromEvals} openReport={view.report} onOpenArtifact={(taskId, artifactId) => setView({ name: "task", id: taskId, artifact: artifactId })} />}
        {view.name === "backlog" && <Backlog onFeedback={openFeedback} onError={setError} onStarted={(task) => { upsertTask(task); openTask(task.id); }} onOpenTask={openTask} onOpenSchedules={() => setView({ name: "schedules" })} />}
        {view.name === "approvals" && (
          <Approvals
            approvals={approvals.map((a) => ({ ...a, taskTitle: tasks.find((t) => t.id === a.taskId)?.title ?? a.taskTitle }))}
            onAnswered={(a) => setApprovals((prev) => prev.filter((x) => !(x.taskId === a.taskId && x.id === a.id)))}
            onOpenTask={openTask}
            onOpenBacklog={() => setView({ name: "backlog" })}
            onError={setError}
          />
        )}
        {view.name === "schedules" && <Schedules workspaces={workspaces} runners={health?.runners ?? []} runnerOk={runnerOk} onOpenTask={openTask} onOpenSettings={() => setView({ name: "settings" })} onError={setError} />}
        {view.name === "settings" && <Settings focusRelease={releaseFocus} health={health} runnerOk={runnerOk} onRunners={(runners) => setHealth((h) => (h ? { ...h, runners } : h))} onError={setError} />}
      </div>

      <FeedbackDialog open={feedbackOpen} screen={screenLabel(view, currentTask)} workspaces={workspaces} workspace={feedbackWorkspace} prefill={feedbackPrefill} onClose={() => setFeedbackOpen(false)} onSent={(task) => { upsertTask(task); openTask(task.id); }} onError={setError} />

      <footer className="statusbar">
        <span>
          デーモン <b>{health ? "OK" : "…"}</b>
          {health && ` · プロトコル ${health.protocol}`}
        </span>
        {(health?.runners ?? []).map((r) => (
          <span key={r.id}>
            {r.id} <b>{r.available ? r.version ?? "OK" : "使えません"}</b>
          </span>
        ))}
        {health && (
          <span title={health.home}>
            データ <b className={health.homeIsTemp ? "warn" : ""}>{health.homeDisplay ?? health.home}</b>
          </span>
        )}
      </footer>
    </div>
  );
}
