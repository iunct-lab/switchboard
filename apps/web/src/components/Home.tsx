import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { NewDefaultsSettings, type CloudPreparation, type ExecutionMode, type CreateTaskInput, type LedgerSummary, type ReportRow, type RoutingSuggestion, type RunnerId, type RunnerInfo, type Schedule, type TaskStopMark, type TaskSummary, type Workspace } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { type Health } from "../api/daemon.ts";
import { fmtUsd, OriginTag, pct, ResumeTag, RunnerPill, ShadowTag } from "./ui.tsx";
import { AttachButton, AttachmentBar, useAttachments, useDropZone } from "./Attachments.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { activeLabel, attentionGroups, isActive, type AttentionGroup, outcomeDotClass, outcomeLabel } from "../attention.ts";
import { reportMeta } from "../reports.ts";
import { accountMark, quotaAsOf, quotaStale, resetLabel, windowLabel } from "../quota.ts";
import { staleDraft } from "../presets.ts";
import { isAdkRunner, listedRunners, runnerLabel } from "../runners.ts";
import { homeEmptyLabel, initialChoice } from "../runnerSettings.ts";
import { PresetPicker } from "./PresetPicker.tsx";
import { PresetReplies } from "./PresetReplies.tsx";
import { repliesFor } from "../presetReplies.ts";
import { titleToSend } from "../taskTitle.ts";
import { detailsSummary, loadDetailsOpen, saveDetailsOpen } from "../composeDetails.ts";
import { startBlockedReason, unavailableNotice, unavailableNotices } from "../runnerNotice.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";
import { runnerLoginLabel } from "../login.ts";
import { ago } from "../inProgress.ts";
import { REASON_LABEL } from "../interventions.ts";
import { stuckLine, stuckSchedules } from "../stuck.ts";

/** Before the settings are read: no saved model / effort for any runner. */
const ND_NONE: NewDefaultsSettings = NewDefaultsSettings.parse({});
/** How many 要対応 rows (groups) show before すべて. */
const ATTENTION_SHOWN = 8;

/** The prefix "改善 →" inserted: remembered so a Workspace switch can swap it for the new workspace's brief (and only it). */
type Brief = { wsId: string; text: string; title: string };
const briefTitle = (ws: Workspace) => (ws.kind === "meta" ? t(home.briefTitleSelf) : t(home.briefTitle, { name: ws.name }));

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
  /** Settings scrolled to its Workspace card (the 「設定で追加 →」 when there is none yet). */
  onOpenWorkspaces: () => void;
  /** The newest report's line: opens Insights with it. */
  onOpenReport: (id: string) => void;
  /** Insights' レポート section with every artifact */
  onOpenArtifacts: () => void;
}) {
  const [wsId, setWsId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  // Attachments: uploaded as they are added, sent as ids with 開始.
  const attach = useAttachments(props.onError);
  const drop = useDropZone((files) => void attach.add(files), props.onError);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("local");
  const [cloudPreparation, setCloudPreparation] = useState<CloudPreparation | null>(null);
  const [cloudPreparationError, setCloudPreparationError] = useState<string | null>(null);
  const [runner, setRunner] = useState<RunnerId>("claude");
  const cloud = runner === "claude" && executionMode === "cloud";
  /** "" = follow the runner's saved default (shown selected); anything else is sent explicitly. */
  const [mode, setMode] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState(""); // "" = the CLI's own default
  const [budget, setBudget] = useState("");
  // Shadow run: null = follow the saved default (Settings.shadowRunner); a click makes it explicit for this task.
  const [shadow, setShadow] = useState<boolean | null>(null);
  /** undefined = not loaded yet (the toggle waits; an untouched creation leaves the choice to the daemon). */
  // Settings 「Switchboard 自体を開発する」: read with the other defaults below; unread = off, so 「このアプリを改善 →」 never shows for a moment and goes
  const [developSelf, setDevelopSelf] = useState(false);
  const [shadowDefault, setShadowDefault] = useState<RunnerId | null | undefined>(undefined);
  /** 詳細: the rarely set values, folded; open or closed as the person left it in this browser. */
  const [detailsOpen, setDetailsOpen] = useState(() => loadDetailsOpen(localStorage));
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  /** The text a 定型の指示 put in and the workspace it was expanded for: sent only while that workspace is chosen. */
  const [draft, setDraft] = useState<{ workspaceId: string | null; text: string } | null>(null);
  const briefSeq = useRef(0);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const titleRef = useRef(title);
  titleRef.current = title;
  const wsIdRef = useRef(wsId);
  wsIdRef.current = wsId;
  const meta = props.workspaces.find((w) => w.kind === "meta");

  const [runnerTouched, setRunnerTouched] = useState(false);
  /** The model select was changed by hand: the rule table's model proposal no longer fills it. */
  const [modelTouched, setModelTouched] = useState(false);
  const [effortTouched, setEffortTouched] = useState(false);
  /** The saved 新規作成の既定 (runner / model / effort): where an untouched form's model and effort start. */
  const [newDefaults, setNewDefaults] = useState<NewDefaultsSettings | null>(null);
  const runnerTouchedRef = useRef(false);
  /** 新規作成の既定: the runner the form starts on when the router has no reason to prefer one (its fallback); null = not changed from the default. */
  const savedRunnerRef = useRef<RunnerId | null>(null);
  const suggestionRef = useRef<RoutingSuggestion | null>(null);
  /** The runner an untouched form shows for `s`: the router's, except its fallback, where the saved default stands. */
  const startRunner = (s: RoutingSuggestion | null): RunnerId | null => {
    const saved = savedRunnerRef.current;
    if ((!s || s.ruleId === "fallback") && saved && runnerOkRef.current.has(saved)) return saved;
    return s && runnerOkRef.current.has(s.runner) ? s.runner : null;
  };
  runnerTouchedRef.current = runnerTouched;
  const runnerOkRef = useRef(props.runnerOk);
  runnerOkRef.current = props.runnerOk;
  const suggestSeq = useRef(0);

  // "" = 自動, the default: the daemon asks the LLM to pick a registered Workspace when 開始 is pressed.
  const ws = props.workspaces.find((w) => w.id === wsId);
  const stale = staleDraft(draft, { workspaceId: ws?.id ?? null, text: prompt });
  const wsSelect = useRef<HTMLSelectElement>(null);
  const [choosing, setChoosing] = useState(false); // 開始 under 自動: the daemon is asking which Workspace (a runner turn, several seconds)

  // Ask the rule table for a recommendation as the user types (debounced). The user can always override with one click.
  useEffect(() => {
    const seq = ++suggestSeq.current;
    setCloudPreparation(null);
    setCloudPreparationError(null);
    const h = setTimeout(() => {
      api
        .suggest({ executionMode: cloud ? "cloud" : "local", workspaceId: ws?.id, cwd: ws?.path, title, prompt })
        .then((s) => {
          if (seq !== suggestSeq.current) return;
          if (cloud) { setCloudPreparation(s.cloudPreparation ?? null); return; }
          setSuggestion(s);
          suggestionRef.current = s;
          const r = startRunner(s);
          if (!runnerTouchedRef.current && r) setRunner(r);
        })
        .catch(() => { if (seq === suggestSeq.current && cloud) setCloudPreparationError(t(home.gitStateUnknown)); });
    }, 250);
    return () => clearTimeout(h);
  }, [ws, title, prompt, executionMode, cloud]);

  // A new workspace means a new conversation about which runner fits; forget the manual override.
  useEffect(() => {
    setRunnerTouched(false);
  }, [wsId]);
  // The brief follows the Workspace select: while the prompt still starts with the inserted prefix, a switch replaces
  // that prefix with the new workspace's brief and keeps what the user wrote after it. Once the user has edited the
  // prefix itself, the text is theirs and is left alone.
  useEffect(() => {
    if (!brief || brief.wsId === wsId || !ws) return;
    const seq = ++briefSeq.current;
    const old = brief;
    api
      .workspaceBrief(ws.id)
      .then((b) => {
        if (seq !== briefSeq.current) return;
        const next: Brief = { wsId: ws.id, text: b.text, title: briefTitle(ws) };
        // The title prefix is swapped whenever it is still ours, independently of the prompt: a task must not be named
        // after the wrong repository.
        const t = titleRef.current;
        if (t.startsWith(old.title)) setTitle(next.title + t.slice(old.title.length));
        const cur = promptRef.current;
        if (!cur.startsWith(old.text)) {
          setBrief(null); // the prefix was edited by hand: it is the user's text now
          return;
        }
        setPrompt(next.text + cur.slice(old.text.length));
        setBrief(next);
      })
      .catch((e) => {
        setBrief(null); // do not keep re-fetching (and re-toasting) on every dependency change; the text stays as it is
        props.onError(String((e as Error).message ?? e));
      });
    // A workspace change (or unmount) while the fetch is in flight invalidates it: a brief for a workspace the user
    // already left must never be applied.
    return () => {
      briefSeq.current++;
    };
  }, [ws, wsId, brief]);
  // Permission mode: options and the effective default come from the daemon per runner. `runners` is absent
  // from /api/health until the token is accepted (off-loopback), so nothing mode-related renders until it is there.
  const runnerInfo = props.health?.runners?.find((r) => r.id === runner);
  const modes = runnerInfo?.permissionModes ?? [];
  const defaultMode = runnerInfo?.defaultPermissionMode;
  const selectedMode = mode || defaultMode || "";
  const selectedOpt = modes.find((m) => m.value === selectedMode);
  useEffect(() => {
    if (runner !== "claude") setExecutionMode("local");
    setMode("");
    setModel(""); // a model belongs to one runner
    setEffort(""); // so does an effort
    setEffortTouched(false);
  }, [runner]);
  // After the runner effect above (which empties them): an untouched select takes the rule's model proposal, else the
  // saved default for this runner, and goes back to the CLI default when there is none.
  const initial = initialChoice(runner, runnerInfo, newDefaults ?? ND_NONE, suggestion ?? undefined);
  useEffect(() => {
    if (!modelTouched) setModel(initial.model);
    if (!effortTouched) setEffort(initial.effort);
  }, [initial.model, initial.effort, runner, modelTouched, effortTouched]);
  useEffect(() => {
    if (props.health?.runners)
      api
        .settings()
        .then((s) => {
          setShadowDefault(s.shadowRunner);
          setDevelopSelf(s.developSelf);
          setNewDefaults(s.newDefaults);
          // only a runner the person saved: left at its default, the router's own fallback (routing.yaml) stands as before
          savedRunnerRef.current = s.newDefaults.taskRunner !== s.defaults.newDefaults.taskRunner ? s.newDefaults.taskRunner : null;
          const r = startRunner(suggestionRef.current);
          if (!runnerTouchedRef.current && r) setRunner(r);
        })
        .catch(() => undefined);
  }, [props.health]);
  const dakOk = props.runnerOk.has("dak");
  const shadowOn = !isAdkRunner(runner) && dakOk && (shadow ?? shadowDefault === "dak");
  // What 詳細 says while closed: what differs from an untouched form (the initial model and effort, the saved shadow). Cloud sends
  // none of model / effort / budget / shadow, so they are not shown as changed there. An untouched model is the rule's
  // (the effect below fills the select a render later): read so, the line does not flash 「モデル: CLI 既定」 meanwhile.
  const defaultModel = initial.model;
  const defaultShadow = !isAdkRunner(runner) && dakOk && shadowDefault === "dak";
  const summary = detailsSummary(
    cloud ? { title, executionMode: "cloud", model: defaultModel, effort: "", budget: "", shadow: defaultShadow } : { title, executionMode: "local", model: modelTouched ? model : defaultModel, effort: effort === initial.effort ? "" : effort, budget, shadow: shadowOn },
    { model: defaultModel, shadow: defaultShadow, briefTitle: brief?.title },
  );
  // What the request says about the shadow. Untouched → omitted, so the daemon applies its saved default itself (also
  // one this page has not loaded yet, or a non-DAK one set through the API); a click → explicit. A DAK primary with
  // DAK as the default says null: the daemon would only note that the shadow equals the primary. An ADK server added in
  // Settings offers no shadow toggle, so it says null too: the saved DAK default does not ride along unseen.
  const shadowRunnerField: RunnerId | null | undefined = runner.startsWith("custom:") ? null : runner === "dak" ? (shadowDefault === "dak" ? null : undefined) : shadow === null ? undefined : shadow && dakOk ? "dak" : null;
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
  // next Task ending) and on each stop record (a stop or one resolved within a turn moves no row), not on other events
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const tasksAt = useMemo(() => props.tasks.reduce((m, x) => Math.max(m, x.updatedAt), 0), [props.tasks]);
  useEffect(() => {
    let alive = true;
    api.schedules().then((r) => alive && setSchedules(r), () => undefined);
    return () => {
      alive = false;
    };
  }, [tasksAt, props.tasks.length, props.stopRev]);
  const stuck = useMemo(() => stuckSchedules(schedules), [schedules]);
  // the first ones: 60 rows pushed the cost and the reports five screens down on a phone
  const [allAttention, setAllAttention] = useState(false);
  const recent = useMemo(() => {
    const listed = new Set([...needs.flatMap((g) => g.tasks), ...waiting.map((w) => w.task)].map((t) => t.id));
    return props.tasks.filter((t) => !isActive(t) && !listed.has(t.id)).slice(0, 6);
  }, [props.tasks, needs, waiting]);

  // runners not listed yet (loading, unreachable, no token): no runner reason is given, the button stays disabled as before
  const offRunners = unavailableNotices(props.health?.runners);
  const runnersKnown = !!props.health?.runners;
  const blocked = startBlockedReason({ prompt, stale, attachBusy: attach.busy, runnerOk: !runnersKnown || props.runnerOk.has(runner), cloud, ws: !!ws, anyRunnerOk: !runnersKnown || props.runnerOk.size > 0 });
  const submit = async () => {
    if (!prompt.trim() || (!cloud && attach.busy) || stale) return;
    if (cloud && !ws) { props.onError(t(home.cloudNeedsWorkspace)); wsSelect.current?.focus(); return; }
    if (!cloud && budget.trim() && !(Number(budget) > 0)) {
      props.onError(t(home.budgetInvalid));
      return;
    }
    setBusy(true);
    setChoosing(!ws);
    try {
      await props.onCreate({
        executionMode: cloud ? "cloud" : "local",
        workspaceId: ws?.id, // neither = 自動: the daemon chooses, or answers 409 and the person picks
        cwd: ws?.path,
        // empty, or only the inserted prefix: no title, so the daemon names the task
        title: titleToSend(title, brief?.title),
        prompt: prompt.trim(),
        runner,
        ...(!cloud ? {
          model: model.trim() || undefined,
          effort: effort || undefined,
          budgetUsd: budget.trim() ? Number(budget) : undefined,
          permissionMode: modes.length && mode ? mode : undefined,
          shadowRunner: shadowRunnerField,
          attachmentIds: attach.ids.length ? attach.ids : undefined,
        } : {}),
      });
      setTitle("");
      setPrompt("");
      attach.clear();
      setBrief(null);
      setDraft(null);
      setRunnerTouched(false);
      setModelTouched(false);
      setEffortTouched(false);
      setShadow(null); // the click was for that task; the next one starts from the saved default again
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
      if (!ws && (e as { status?: number }).status === 409) wsSelect.current?.focus(); // 自動 could not choose: the next step is this select
    } finally {
      setChoosing(false);
      setBusy(false);
    }
  };

  /**
   * "改善 →": put a workspace's brief (from the daemon) in front of the request. What the user already typed is kept:
   * a prompt that starts with a previous brief has that prefix replaced, anything else gets the brief prepended.
   */
  const improve = async (target: Workspace) => {
    if (target.id !== wsId) {
      setWsId(target.id);
    }
    const seq = ++briefSeq.current;
    try {
      const b = await api.workspaceBrief(target.id);
      if (seq !== briefSeq.current || wsIdRef.current !== target.id) return; // the select moved on meanwhile
      const next: Brief = { wsId: target.id, text: b.text, title: briefTitle(target) };
      const cur = promptRef.current;
      const rest = brief && cur.startsWith(brief.text) ? cur.slice(brief.text.length) : cur;
      setPrompt(next.text + rest);
      const curTitle = titleRef.current;
      setTitle(brief && curTitle.startsWith(brief.title) ? next.title + curTitle.slice(brief.title.length) : curTitle.trim() ? curTitle : next.title);
      setBrief(next);
      if (target.kind === "meta") setRunner("claude");
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    }
  };

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
      <section className="card compose">
        <div className="row head">
          <h5>{t(home.newTaskHeading)}</h5>
          <span className="hint">{t(home.shortcutsHint)}</span>
        </div>
        <div className="fields">
          <label>
            <span>Workspace</span>
            <select
              ref={wsSelect}
              value={wsId}
              onChange={(e) => {
                setWsId(e.target.value);
              }}
            >
              <option value="" disabled={cloud}>{cloud ? t(home.chooseWorkspace) : t(home.autoWorkspace)}</option>
              {props.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.kind === "meta" ? t(home.selfSuffix) : ""} — {w.path}
                </option>
              ))}
            </select>
          </label>
        </div>
        {stale && <div className="hint warn">{t(home.staleDraft)}</div>}
        <div className={`dropzone ${drop.dropping ? "dropping" : ""}`} {...(cloud ? {} : drop.handlers)}>
          <PresetPicker
            scene="home"
            workspaceId={ws?.id ?? null}
            text={prompt}
            onText={(text, title) => {
              setPrompt(text);
              setTitle(title);
              setBrief(null);
              setDraft({ workspaceId: ws?.id ?? null, text });
            }}
            onError={props.onError}
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={cloud ? undefined : drop.onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (busy) return;
                  if (e.shiftKey) void submit();
                }
              }}
              rows={6}
              placeholder={`${t(home.presetHint)}${cloud ? t(home.promptCloud) : t(home.promptLocal)}`}
            />
          </PresetPicker>
          {!cloud && <AttachmentBar items={attach.items} onRemove={attach.remove} busy={attach.busy} />}
        </div>
        <div className="row">
          <div className="runners">
            {listedRunners(props.health?.runners).map((r) => {
              const ok = props.runnerOk.has(r);
              const info = props.health?.runners?.find((x) => x.id === r);
              const expired = ok && info?.login === "expired";
              const offTitle = unavailableNotice(info, r) ?? "";
              return (
                <label key={r} className={`runner-opt ${!ok ? "off" : ""} ${runner === r ? "sel" : ""}`} title={!ok ? offTitle : expired ? t(home.loginExpiredTitle, { command: info.loginHint ?? r }) : ((info && runnerLoginLabel(info, Date.now())?.title) ?? info?.note ?? "")}>
                  <input
                    type="radio"
                    name="runner"
                    value={r}
                    disabled={!ok}
                    checked={runner === r}
                    onChange={() => {
                      setRunner(r);
                      setRunnerTouched(true);
                    }}
                  />
                  <RunnerPill runner={r} />
                  {expired && <span className="hint">{t(home.needsLogin)}</span>}
                  {runner === r && !runnerTouched && suggestion?.runner === r && <span className="hint">{t(home.suggestedTag)}</span>}
                </label>
              );
            })}
            {!cloud && runnerInfo && modes.length > 0 && (
              <select
                className="mode"
                value={selectedMode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setRunnerTouched(true); // a mode is chosen for this runner: the router must not swap it away
                }}
                title={selectedOpt ? `${selectedOpt.label}: ${selectedOpt.description}` : t(home.approvalMode)}
                aria-label={t(home.approvalMode)}
              >
                {modes.map((m) => (
                  <option key={m.value} value={m.value}>
                    {t(home.approvalOption, { label: m.label })}
                    {m.value === defaultMode ? t(home.defaultSuffix) : ""}
                  </option>
                ))}
              </select>
            )}
            {!cloud && runnerInfo && modes.length === 0 && (
              <span className="hint" title={t(home.approvalByRunnerTitle, { runner: runnerLabel(runner, runnerInfo) })}>
                {t(home.approvalByRunner, { runner: runnerLabel(runner, runnerInfo) })}
              </span>
            )}
          </div>
          <AttachButton onFiles={(files) => void attach.add(files)} disabled={busy || cloud} />
          <button className="pri" disabled={busy || stale || (!cloud && attach.busy) || !prompt.trim() || !props.runnerOk.has(runner) || (cloud && !ws)} onClick={() => void submit()} title={!cloud && attach.busy ? t(home.waitUpload) : ""}>
            {choosing ? t(home.choosingWorkspace) : busy ? t(home.starting) : !cloud && attach.busy ? t(home.uploading) : t(home.start)}
          </button>
        </div>
        {/* why a runner or 開始 cannot be used, read without hovering; an empty prompt needs no words, a stale one is said above */}
        {offRunners.length > 0 && (
          <div className="hint">
            {offRunners.map((n, i) => (
              <Fragment key={n.id}>
                {i > 0 && " · "}
                <RunnerPill runner={n.id} /> {n.text}
              </Fragment>
            ))}
          </div>
        )}
        {blocked && prompt.trim() && !stale && <div className="hint warn">{t(home.cannotStart, { reason: blocked })}</div>}
        {!cloud && selectedOpt?.danger && <div className="hint warn">{t(home.dangerMode, { label: selectedOpt.label, description: selectedOpt.description })}</div>}
        <details className="compose-details" open={detailsOpen} onToggle={(e) => { const open = e.currentTarget.open; setDetailsOpen(open); saveDetailsOpen(localStorage, open); }}>
          <summary>
            {t(home.details)}{!detailsOpen && summary && <span className="hint"> · {summary}</span>}
          </summary>
          <div className="runners">
            <label>
              <span>{t(home.title)}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t(home.titlePlaceholder)} />
            </label>
            {runner === "claude" && <label>{t(home.runLocation)} <select aria-label={t(home.runLocation)} value={executionMode} onChange={e => { setExecutionMode(e.target.value as ExecutionMode); setRunnerTouched(true); }}><option value="local">{t(home.local)}</option><option value="cloud">{t(home.cloud)}</option></select></label>}
            {!cloud && <ModelSelect runner={runnerInfo} value={model} onChange={(v) => { setModel(v); setModelTouched(true); setRunnerTouched(true); /* a model belongs to this runner: the router must not swap it away */ }} label={t(home.model)} title={t(home.modelTitle)} emptyLabel={homeEmptyLabel("model", runnerInfo)} />}
            {!cloud && <EffortSelect runner={runnerInfo} value={effort} onChange={(e) => { setEffort(e); setEffortTouched(true); setRunnerTouched(true); /* chosen for this runner: the router must not swap it away */ }} label={t(home.effort)} title={t(home.effortTitle)} emptyLabel={homeEmptyLabel("effort", runnerInfo)} />}
            {!cloud && <input className="model" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t(home.budgetPlaceholder)} inputMode="decimal" title={t(home.budgetTitle)} />}
            {!cloud && !isAdkRunner(runner) && listedRunners(props.health?.runners).includes("dak") && (
              <label
                className={`hint toggle shadow ${!dakOk || shadowDefault === undefined ? "off" : ""}`}
                title={!dakOk ? t(home.dakUnreachable) : shadowDefault === undefined ? t(home.loadingDefault) : t(home.dakShadowTitle)}
              >
                <input
                  type="checkbox"
                  disabled={!dakOk || shadowDefault === undefined}
                  checked={shadowOn}
                  onChange={(e) => {
                    setShadow(e.target.checked);
                    setRunnerTouched(true); // the pair was chosen for this runner: the router must not swap the primary to DAK
                  }}
                />
                {t(home.dakShadow)}
                {shadowOn && shadowDefault === "dak" && <span className="hint">{t(home.defaultTag)}</span>}
                {!dakOk && shadowDefault === "dak" && <span className="hint">{t(home.shadowDefaultOff)}</span>}
                {shadowDefault && shadowDefault !== "dak" && shadow === null && <span className="hint">{t(home.shadowDefault, { runner: shadowDefault })}</span>}
              </label>
            )}
            <button className="ghost" onClick={props.onOpenSettings} title={t(home.defaultsInSettingsTitle)}>{t(home.defaultsInSettings)}</button>
          </div>
          {/* the improve preambles are for an improvement request only, not every request: folded with the rest */}
          <ImproveButtons ws={ws} meta={meta} developSelf={developSelf} onImprove={(w) => void improve(w)} />
        </details>
        {cloud && <div className="cloud-preparation card" role="note">
          <p>{t(home.cloudConsent)}</p>
          <p className="hint">{t(home.cloudNotHere)}</p>
          <div className="kv">
            <span>{t(home.repository)}</span><span>{cloudPreparation?.repository ?? t(home.unknown)}</span>
            <span>{t(home.branch)}</span><span>{cloudPreparation?.branch ?? t(home.unknown)}</span>
            <span>{t(home.uncommitted)}</span><span>{cloudPreparation?.dirty === null || !cloudPreparation ? t(home.unknown) : cloudPreparation.dirty ? t(home.present) : t(home.absent)}</span>
            <span>{t(home.unpushed)}</span><span>{cloudPreparation?.unpushed === null || !cloudPreparation ? t(home.unknown) : cloudPreparation.unpushed ? t(home.present) : t(home.absent)}</span>
          </div>
          {cloudPreparation?.warnings.slice(1).map(w => <p className="hint" key={w}>{w}</p>)}
          {cloudPreparationError && <p className="hint warn">{cloudPreparationError}</p>}
          {!ws && <p className="hint warn">{t(home.cloudChooseWorkspace)}</p>}
        </div>}
        <div className="row sub">
          <span className="hint suggestion" title={suggestion ? t(home.rule, { rule: suggestion.ruleId }) : ""}>
            {!cloud && suggestion ? (
              <>
                {t(home.suggested)} <RunnerPill runner={suggestion.runner} />
                {suggestion.model && <span> / {t(home.suggestedModel, { model: props.health?.runners?.find((r) => r.id === suggestion.runner)?.models?.find((m) => m.value === suggestion.model)?.label ?? suggestion.model })}</span>}{" "}
                <span>{suggestion.reason}</span>
                {!suggestion.available && <span className="warn"> — {t(home.notInstalled)}</span>}
                {(suggestion.runner !== runner || model !== (suggestion.model ?? "")) && props.runnerOk.has(suggestion.runner) && (
                  <button
                    className="ghost"
                    onClick={() => {
                      setRunner(suggestion.runner);
                      setRunnerTouched(false);
                      setModelTouched(false);
                    }}
                  >
                    {t(home.backToSuggested)}
                  </button>
                )}
              </>
            ) : (
              <>{cloud ? t(home.cloudUsesClaude) : t(home.suggestHint)}</>
            )}
          </span>
        </div>
      </section>

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
              <RunnerPill runner={x.runner} />
              <ShadowTag task={x} />
              <span className="m">{activeLabel(x)}</span>
            </button>
          ))}
          <h5 style={{ marginTop: 14 }}>{t(home.attentionHeading, { count: needs.length })}</h5>
          {needs.length === 0 && <div className="muted">{t(home.none)}</div>}
          {(allAttention ? needs : needs.slice(0, ATTENTION_SHOWN)).map((g) => {
            const x = g.tasks[0]!;
            return (
              <div key={g.key} className="attn-group">
                <button className="row link" onClick={() => props.onOpenTask(x.id)}>
                  <span className={`dot ${outcomeDotClass(x.outcome)}`} />
                  <span className="t">{x.title}</span>
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

/** 「<name> を改善 →」 for the chosen workspace, and 「このアプリを改善 →」 only while Switchboard itself is developed. */
export function ImproveButtons({ ws, meta, developSelf, onImprove }: { ws: Workspace | undefined; meta: Workspace | undefined; developSelf: boolean; onImprove: (w: Workspace) => void }) {
  const own = ws && ws.kind !== "meta" ? ws : undefined;
  const self = developSelf ? meta : undefined;
  if (!own && !self) return null;
  return (
    <div className="compose-improve">
      {own && (
        <button className="ghost" onClick={() => onImprove(own)} title={t(home.improveTitle, { name: own.name })}>
          {t(home.improve, { name: own.name })}
        </button>
      )}
      {self && (
        <button className="ghost" onClick={() => onImprove(self)} title={t(home.improveSelfTitle)}>
          {t(home.improveSelf)}
        </button>
      )}
    </div>
  );
}
