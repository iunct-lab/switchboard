import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n.ts";
import { app } from "./i18n/app.ts";
import { home } from "./i18n/home.ts";
import type { DeviceAuthView, EventEnvelope, LedgerSummary, PendingApproval, ServerMessage, Task, TeleportProgress, TerminalStatus, Workspace } from "@switchboard/protocol";
import { applyApprovalEvent, mergeFetched } from "./approvals.ts";
import { mergeEvents, taskReader } from "./catchup.ts";
import { noticesFor, showNotice } from "./notify.ts";
import { Approvals } from "./components/Approvals.tsx";
import { api, connectEvents, getToken, setToken, type Health, type TaskDetail, type WorkspaceClone } from "./api.ts";
import { journeyCancel, journeyEnd, journeyStart } from "./perf.ts";
import { loginRoute, sessionLabel, sessionRefreshDelay, STUCK_MESSAGE, STUCK_LOGIN, STUCK_RESCUE, withoutFromAuth } from "./login.ts";
import { newVersionLink, rescueLink, type ReleaseStatus } from "./release.ts";
import { archiveBanner } from "./archive.ts";
import { watchHealth } from "./healthWatch.ts";
import { Backlog } from "./components/Backlog.tsx";
import { Brief } from "./components/Brief.tsx";
import { Home } from "./components/Home.tsx";
import { Knowledge } from "./components/Knowledge.tsx";
import { Ledger } from "./components/Ledger.tsx";
import { Evals } from "./components/Evals.tsx";
import { Resources } from "./components/Resources.tsx";
import { Schedules } from "./components/Schedules.tsx";
import { FeedbackDialog, type FeedbackPrefill } from "./components/Feedback.tsx";
import { Rail } from "./components/Rail.tsx";
import { RunnerLogin } from "./components/RunnerLogin.tsx";
import { Settings } from "./components/Settings.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { RecentCheck } from "./components/RecentCheck.tsx";
import { usePageDropGuard } from "./components/Attachments.tsx";
import { screenLabel, type View } from "./screen.ts";
import { pathToWrite, viewFromPath } from "./route.ts";
import { rememberRunnerLabels } from "./runners.ts";
import type { FeedbackTarget } from "./feedbackTarget.ts";

/** The screen the URL names (#3355; /approvals is the phone app's start, #26), else Home. */
const screenAt = (): View => viewFromPath(location.pathname) ?? { name: "home" };

/** How often an open page reads /api/health again (#1600). */
const HEALTH_REFRESH_MS = 5 * 60_000;
const HEALTH_RETRY_MS = 3_000;

export function App() {
  usePageDropGuard(); // a file dropped outside a dropzone must not navigate the tab away (#125)
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // the workspace a request is filed for: the backlog's narrowed one when opened there, else the meta workspace
  const [feedbackWorkspace, setFeedbackWorkspace] = useState<FeedbackTarget | undefined>();
  // 改善要望にする (#1221): the draft the dialog opens with, from a task's evaluations
  const [feedbackPrefill, setFeedbackPrefill] = useState<FeedbackPrefill | undefined>();
  const [health, setHealth] = useState<Health | null>(null);
  // a pill anywhere shows a custom runner by its label: read from the last health before the children render
  rememberRunnerLabels(health?.runners);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [clones, setClones] = useState<WorkspaceClone[]>([]);
  // an older answer must not overwrite a newer one (a clone that finished while the earlier read was still on the wire)
  const clonesSeq = useRef(0);
  const refreshClones = useCallback(() => {
    const n = ++clonesSeq.current;
    return api.workspaceClones().then((c) => {
      if (n === clonesSeq.current) setClones(c);
    }).catch(() => undefined);
  }, []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listed, setListed] = useState(false); // the first task list came back
  const [ledger, setLedger] = useState<LedgerSummary | null>(null);
  const [details, setDetails] = useState<Record<string, TaskDetail>>({});
  // approval waits by Task (#662): from the WebSocket and the Task's first load, never stored
  const [deviceAuths, setDeviceAuths] = useState<Record<string, DeviceAuthView | null>>({});
  // "continue locally" by Cloud Task (#1306): from the WebSocket; the open Task's first load brings the current one
  const [teleports, setTeleports] = useState<Record<string, TeleportProgress | null>>({});
  // Claude Code in each Task's terminal tab (#1574): task.terminals after hello replaces them all, task.terminal changes one
  const [terminals, setTerminals] = useState<Record<string, TerminalStatus>>({});
  const [view, setView] = useState<View>(screenAt);
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
  // Tasks whose read answered 404 (#3427): a Task URL with no Task shows so, instead of 読み込み中… for good
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const reader = useMemo(
    () =>
      taskReader({
        read: api.task,
        held: () => detailsRef.current,
        update: setDetails,
        failed: (e, id) => {
          if ((e as Error & { status?: number }).status === 404) setMissing((m) => new Set(m).add(id));
          else setError(String(e.message ?? e));
        },
      }),
    [],
  );
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
    if (dropped.current) {
      Promise.all([api.tasks(), archivedShown.current ? api.tasks({ archived: true }) : []])
        .then(([list, archived]) => setTasks([...list, ...archived]))
        .catch(() => undefined);
      // workspaces.updated sent while away (#1447)
      api.workspaces().then(setWorkspaces).catch(() => undefined);
      refreshClones();
    }
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

  const readHealth = useCallback(() => void api.health().then(setHealth).catch(() => undefined), []);
  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(t(home.coreUnreachable, { error: e.message })));
  }, [authRev]);
  // No answer yet (the daemon restarting under the page): nothing else is sent until it says who we are, so it is asked
  // again here; health through the edge is the one read the failure limit does not count
  useEffect(() => {
    if (health) return;
    const t = setInterval(() => void api.health().then((h) => { setHealth(h); setError(null); }).catch(() => undefined), HEALTH_RETRY_MS);
    return () => clearInterval(t);
  }, [health]);
  // the banners (a failed archive, a runner's login) follow the daemon while the page stays open (#1600); a failed read keeps the last
  useEffect(() => watchHealth(document, readHealth, HEALTH_REFRESH_MS), [readHealth]);

  // The cloud login's end (#498): read again when it is reached: it shows the renewed cookie's later time, or the refusal, which sends the page to the passkey login below
  const sessionEnd = health?.session ? Math.min(health.session.idleUntil, health.session.expiresAt) : undefined;
  useEffect(() => {
    if (sessionEnd === undefined) return;
    const t = setTimeout(readHealth, sessionRefreshDelay(sessionEnd, Date.now()));
    return () => clearTimeout(t);
  }, [sessionEnd, readHealth]);

  // The daemon answers health with the runner list only to an authorized caller (a token, or the cloud login cookie).
  const login = health?.authRequired ? loginRoute({ authorized: health.runners !== undefined, hasToken: !!getToken(), mode: health.login, path: location.pathname + location.search }) : { kind: "none" as const };
  const needsToken = login.kind === "token";
  // The rescue page's link (#399) and the new-version mark (#1660) come from one read, asked once the daemon lets us in and
  // again each time the connection changes (a promotion ends in a restart), but for the first connection, which follows the login's read (#1851). A failed ask keeps the last one: the link is for when the
  // daemon is in trouble, so "daemon offline" must not take it away.
  const authorized = health?.runners !== undefined;
  const firstUp = useRef(true);
  useEffect(() => {
    if (!authorized) return;
    if (connected && firstUp.current) {
      firstUp.current = false;
      return;
    }
    api.release().then((r) => { setRelease(r); setRescueHref(rescueLink(r)); }).catch(() => undefined);
  }, [authorized, connected]);
  // Nothing but health before the daemon says we are in: each refused read counts toward the failure limit (#1851, #1492)
  useEffect(() => {
    if (!authorized) return;
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
  }, [authorized, refreshLedger, refreshApprovals, authRev]);
  // read where it is shown (not at launch: one request more there, perf budget)
  useEffect(() => {
    if (authorized && view.name === "settings") void refreshClones();
  }, [authorized, view.name, refreshClones]);
  // Settings scrolls to one section once it has loaded (the section is not drawn before that): the release one from the
  // header, the Workspace one from Home (it is no longer the first card, #3356). n tells a second press from the first.
  const [settingsFocus, setSettingsFocus] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (view.name !== "settings") setSettingsFocus(null); // the next visit by the tab does not scroll
  }, [view.name]);
  const openSettingsAt = (id: string) => {
    setView({ name: "settings" });
    setSettingsFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  };
  const openRelease = () => openSettingsAt("release");
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
  // 評価をお願い (#1877): the Task with its Brief open at 自分の評価. The mark is read by the view effect below, which
  // otherwise closes the Brief on every view change.
  const [briefFocus, setBriefFocus] = useState<"human" | null>(null);
  const rateMark = useRef(false);
  const rateTask = useCallback((id: string) => {
    rateMark.current = true;
    setView({ name: "task", id });
  }, []);
  // The Local Task "ローカルで続ける" just switched to (#1634): its head says so until another screen opens. Memory only.
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  useEffect(() => {
    if (switchedTo !== null && !(view.name === "task" && view.id === switchedTo)) setSwitchedTo(null);
  }, [view, switchedTo]);

  useEffect(() => {
    if (!authorized) return;
    const onMessage = (m: ServerMessage) => {
      for (const notice of noticesFor(m, tasksRef.current, notified.current))
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
      } else if (m.type === "workspaces.updated") {
        void api.workspaces().then(setWorkspaces);
        void refreshClones();
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
      } else if (m.type === "task.terminal") {
        const { taskId, status } = m;
        setTerminals(({ [taskId]: _, ...rest }) => (status === null ? rest : { ...rest, [taskId]: status }));
      } else if (m.type === "task.terminals") {
        setTerminals(m.terminals);
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
  }, [authorized, refreshTaskMeta, refreshLedger, refreshApprovals, openTask, catchUp, reader]);

  // Each screen has its URL (#3355): a new screen is a history entry, so back / forward walk the screens. The first
  // screen and one popstate brought back only correct the address (a path that is no screen), never add an entry.
  const replaceNext = useRef(true);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const path = pathToWrite(view, location.pathname);
    const replace = replaceNext.current;
    replaceNext.current = false;
    if (path === null) return;
    if (replace) history.replaceState(history.state, "", path + location.search + location.hash);
    else history.pushState(null, "", path);
  }, [view]);
  useEffect(() => {
    // the same screen keeps its state (全画面's own entry, an open artifact): only another path changes the view
    const onPop = () => {
      if (pathToWrite(viewRef.current, location.pathname) === null) return;
      replaceNext.current = true;
      setView(screenAt());
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    setRailListOpen(false); // a task picked from the phone's list replaces the list (#359)
    setBriefOpen(rateMark.current); // and another task does not open with the last one's Brief over it (#369), unless 評価をお願い opened it
    setBriefFocus(rateMark.current ? "human" : null);
    rateMark.current = false;
  }, [view]);

  useEffect(() => {
    // not before the page is let in (#3427): a Task URL opened logged out reads it after the login, not into a 401 banner
    if (authorized && view.name === "task" && !details[view.id] && !missing.has(view.id)) void loadTask(view.id);
  }, [authorized, view, details, missing, loadTask]);
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
  // a Task the daemon answered 404 for is gone even while the list still has it (removed from the database meanwhile)
  const currentTask = view.name === "task" && !missing.has(view.id) ? tasks.find((t) => t.id === view.id) ?? current?.task : undefined;
  const runnerOk = useMemo(() => new Set((health?.runners ?? []).filter((r) => r.available).map((r) => r.id)), [health]);

  return (
    <div className="app">
      <RecentCheck />
      <header className="chrome">
        <span className="brand">Switchboard</span>
        <nav className="tabs">
          <button className={view.name === "home" ? "on" : ""} onClick={() => setView({ name: "home" })}>
            {t(app.home)}
          </button>
          <button className={view.name === "task" ? "on" : ""} disabled={view.name !== "task"}>
            {t(app.task)}
          </button>
          <button className={view.name === "knowledge" ? "on" : ""} onClick={() => setView({ name: "knowledge" })}>
            {t(app.knowledge)}
          </button>
          <button className={view.name === "ledger" ? "on" : ""} onClick={() => setView({ name: "ledger" })}>
            {t(app.ledger)}
          </button>
          <button className={view.name === "evals" ? "on" : ""} onClick={() => setView({ name: "evals" })}>
            {t(app.insights)}
          </button>
          <button className={view.name === "backlog" ? "on" : ""} onClick={() => setView({ name: "backlog" })}>
            {t(app.backlog)}
          </button>
          <button className={view.name === "resources" ? "on" : ""} onClick={() => setView({ name: "resources" })}>
            {t(app.resources)}
          </button>
          <button className={view.name === "schedules" ? "on" : ""} onClick={() => setView({ name: "schedules" })}>
            {t(app.schedules)}
          </button>
          <button className={view.name === "settings" ? "on" : ""} onClick={() => setView({ name: "settings" })}>
            {t(app.settings)}
          </button>
        </nav>
        <span className={`conn ${connected ? "ok" : "off"}`}>{connected ? t(app.connected) : t(app.offline)}</span>
        {/* Until the answer comes the slot is held by an invisible copy, so the tabs do not shrink under a tap (#1485). */}
        {rescueHref === undefined && (
          <span className="rescue-link" aria-hidden="true" style={{ visibility: "hidden" }}>
            {t(app.rescue)}
          </span>
        )}
        {newVersion && (
          <button className="new-version" onClick={openRelease}>
            {newVersion}
          </button>
        )}
        {rescueHref && (
          <a className="rescue-link" href={rescueHref}>
            {t(app.rescue)}
          </a>
        )}
      </header>

      {login.kind === "stuck" && (
        <div className="banner error" role="alert">
          {STUCK_MESSAGE} <a href={STUCK_RESCUE}>{t(home.openRescue)}</a> <a href={STUCK_LOGIN}>{t(home.logout)}</a>
        </div>
      )}

      {needsToken && (
        <div className="banner" role="alert">
          <span>
            {t(home.tokenNeeded)}<code>~/.switchboard/token</code>{t(home.tokenPaste)}
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
              {t(home.save)}
            </button>
          </span>
        </div>
      )}

      {restarting && <div className="banner">{t(home.restarting)}</div>}

      {health?.homeIsTemp && (
        <div className="banner error" role="alert">
          <span>
            {t(home.tempHomeBefore)}<code>{health.home}</code>{t(home.tempHomeLost)}<code>SWITCHBOARD_HOME</code>{t(home.tempHomeHidden)}<code>~/.switchboard</code>{t(home.tempHomeAfter)}
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
            <span>{t(home.loginExpired, { runner: r.id })}</span>
            <RunnerLogin runner={r.id} onDone={() => api.health({ recheck: true }).then(setHealth).catch(() => undefined)} onError={setError} />
            <button className="ghost" onClick={() => api.health({ recheck: true }).then(setHealth).catch((e) => setError(t(home.coreUnreachable, { error: e.message })))}>
              {t(home.recheck)}
            </button>
          </div>
        ))}

      {error && (
        <div className="banner error" role="alert">
          {error}
          <button className="ghost" onClick={() => setError(null)}>
            {t(home.close)}
          </button>
        </div>
      )}

      {/* the screens read on mount: they wait with the rest (#1851) */}
      <div className="body">
        {authorized && (
          <>
        <Rail onFeedback={() => openFeedback()} workspaces={workspaces} tasks={tasks} currentTaskId={view.name === "task" ? view.id : undefined} approvals={approvals.length} approvalsOpen={view.name === "approvals"} onApprovals={() => setView({ name: "approvals" })} listOpen={railListOpen} onToggleList={() => setRailListOpen((o) => !o)} onOpenTask={openTaskFromRail} onHome={() => setView({ name: "home" })} onShowArchived={showArchived} terminals={terminals} />

        {view.name === "home" && (
          <Home
            health={health}
            workspaces={workspaces}
            tasks={live}
            ledger={ledger}
            runnerOk={runnerOk}
            onCreate={createTask}
            onOpenTask={openTask}
            onError={setError}
            inboxRev={knowledgeRev}
            onOpenSettings={() => setView({ name: "settings" })}
            onOpenWorkspaces={() => openSettingsAt("workspace")}
            onOpenReport={(id) => setView({ name: "evals", report: id })}
            onOpenArtifacts={() => setView({ name: "evals", artifacts: true })}
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
              onContinuedLocally={(id) => { setSwitchedTo(id); openTask(id); }}
              switchedFromCloud={switchedTo === currentTask.id}
              openArtifact={view.artifact}
              onArchive={(archived) => archiveTask(currentTask.id, archived)}
              onLoadOlder={() => loadOlder(currentTask.id)}
            />
            <Brief open={briefOpen} onClose={() => setBriefOpen(false)} focus={briefFocus ?? undefined} onFocused={() => setBriefFocus(null)} task={currentTask} detail={current} ledger={ledger} onAbort={() => api.abort(currentTask.id).catch((e) => setError(e.message))} checksRev={checksRev} evalsRev={evalsRev[currentTask.id] ?? 0} onImprove={improveFromEvals} onRestarting={() => setRestarting(true)} runners={health?.runners} noTerminal={health?.features?.pty === false} onTask={upsertTask} tasks={tasks} onOpenTask={openTask} workspaces={workspaces} />
          </>
        )}
        {view.name === "task" && !currentTask && (
          <main className="main">
            {missing.has(view.id) ? (
              <div className="task-missing" role="alert">
                <p>{t(home.taskMissing, { id: view.id })}</p>
                <button onClick={() => setView({ name: "home" })}>{t(home.backHome)}</button>
              </div>
            ) : (
              t(home.loading)
            )}
          </main>
        )}
        {view.name === "knowledge" && <Knowledge refreshKey={knowledgeRev} workspaces={workspaces} onError={setError} />}
        {view.name === "ledger" && <Ledger ledger={ledger} runners={health?.runners ?? []} onOpenTask={openTask} onOpenInsights={() => setView({ name: "evals" })} onError={setError} />}
        {view.name === "evals" && <Evals workspaces={workspaces} runners={health?.runners} onOpenTask={openTask} onRateTask={rateTask} onError={setError} rev={evalsAnyRev} onImprove={improveFromEvals} openReport={view.report} scope={view.artifacts ? "all" : "reports"} onScope={(s) => setView({ name: "evals", artifacts: s === "all" })} onOpenArtifact={(taskId, artifactId) => setView({ name: "task", id: taskId, artifact: artifactId })} />}
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
        {view.name === "resources" && <Resources onOpenTask={openTask} />}
        {view.name === "schedules" && <Schedules workspaces={workspaces} runners={health?.runners ?? []} runnerOk={runnerOk} onOpenTask={openTask} onOpenSettings={() => setView({ name: "settings" })} onError={setError} />}
        {view.name === "settings" && <Settings
            focus={settingsFocus}
            health={health}
            workspaces={workspaces}
            clones={clones}
            onAddWorkspaceFromGithub={async (repo, backlog) => {
              await api.addWorkspaceFromGithub(repo, backlog);
              await refreshClones();
            }}
            onAddWorkspace={async (path, backlog) => {
              const ws = await api.addWorkspace(path, backlog);
              setWorkspaces((prev) => [...prev.filter((w) => w.id !== ws.id), ws]);
            }}
            onTaskStarted={(task) => {
              upsertTask(task);
              openTask(task.id);
            }} runnerOk={runnerOk} onRunners={(runners) => setHealth((h) => (h ? { ...h, runners } : h))} onError={setError} />}
          </>
        )}
      </div>

      <FeedbackDialog open={feedbackOpen} screen={screenLabel(view, currentTask)} workspaces={workspaces} workspace={feedbackWorkspace} prefill={feedbackPrefill} onClose={() => setFeedbackOpen(false)} onSent={(task) => { upsertTask(task); openTask(task.id); }} onError={setError} />

      <footer className="statusbar">
        {health?.session && (
          <span title={sessionLabel(health.session, Date.now()).title}>
            <b>{sessionLabel(health.session, Date.now()).text}</b>
          </span>
        )}
        <span>
          {t(home.daemon)} <b>{health ? "OK" : "…"}</b>
          {health && t(home.protocol, { version: health.protocol })}
        </span>
        {(health?.runners ?? []).map((r) => (
          <span key={r.id}>
            {r.id} <b>{r.available ? r.version ?? "OK" : t(home.unavailable)}</b>
          </span>
        ))}
        {health && (
          <span title={health.home}>
            {t(home.data)} <b className={health.homeIsTemp ? "warn" : ""}>{health.homeDisplay ?? health.home}</b>
          </span>
        )}
      </footer>
    </div>
  );
}
