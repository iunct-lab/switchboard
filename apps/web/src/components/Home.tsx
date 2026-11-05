import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CloudPreparation, ExecutionMode, CreateTaskInput, LedgerSummary, ReportRow, RoutingSuggestion, RunnerId, RunnerInfo, Task, Workspace } from "@switchboard/protocol";
import { api, type Health, type InboxNote } from "../api.ts";
import { fmtUsd, OriginTag, pct, ResumeTag, RunnerPill, ShadowTag } from "./ui.tsx";
import { AttachButton, AttachmentBar, useAttachments, useDropZone } from "./Attachments.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { attentionList, needsAttention, outcomeDotClass, outcomeLabel } from "../attention.ts";
import { reportMeta } from "../reports.ts";
import { quotaAsOf, quotaStale, resetLabel, windowLabel } from "../quota.ts";
import { staleDraft } from "../presets.ts";
import { editChanged, toggleDraft, type DraftEdit } from "../inbox.ts";
import { isAdkRunner, listedRunners, runnerLabel } from "../runners.ts";
import { PresetPicker } from "./PresetPicker.tsx";
import { titleToSend } from "../taskTitle.ts";
import { detailsSummary, loadDetailsOpen, saveDetailsOpen } from "../composeDetails.ts";
import { startBlockedReason, unavailableNotice, unavailableNotices } from "../runnerNotice.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";

/** The prefix "改善 →" inserted: remembered so a Workspace switch can swap it for the new workspace's brief (and only it). */
type Brief = { wsId: string; text: string; title: string };
const briefTitle = (ws: Workspace) => (ws.kind === "meta" ? t(home.briefTitleSelf) : t(home.briefTitle, { name: ws.name }));

export function Home(props: {
  health: Health | null;
  workspaces: Workspace[];
  tasks: Task[];
  ledger: LedgerSummary | null;
  runnerOk: Set<RunnerId>;
  onCreate: (input: CreateTaskInput) => Promise<void>;
  onOpenTask: (id: string) => void;
  onError: (msg: string) => void;
  /** Bumped when the knowledge folder changes (inbox notes live there). */
  inboxRev: number;
  onOpenSettings: () => void;
  /** Settings scrolled to its Workspace card (the 「設定で追加 →」 when there is none yet). */
  onOpenWorkspaces: () => void;
  /** The newest report's line (#1835): opens Insights with it. */
  onOpenReport: (id: string) => void;
  /** Insights' レポート section with every artifact (#1833) */
  onOpenArtifacts: () => void;
}) {
  const [wsId, setWsId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  // Attachments (#125): uploaded as they are added, sent as ids with 開始. Not kept in the Inbox (a note is text).
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
  const [effort, setEffort] = useState(""); // "" = the CLI's own default (#833)
  const [budget, setBudget] = useState("");
  // Shadow run (#99): null = follow the saved default (Settings.shadowRunner); a click makes it explicit for this task.
  const [shadow, setShadow] = useState<boolean | null>(null);
  /** undefined = not loaded yet (the toggle waits; an untouched creation leaves the choice to the daemon). */
  const [shadowDefault, setShadowDefault] = useState<RunnerId | null | undefined>(undefined);
  /** 詳細 (#3354): the rarely set values, folded; open or closed as the person left it in this browser. */
  const [detailsOpen, setDetailsOpen] = useState(() => loadDetailsOpen(localStorage));
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [inbox, setInbox] = useState<InboxNote[]>([]);
  const [promoteWs, setPromoteWs] = useState<Record<string, string>>({});
  const [promoting, setPromoting] = useState<string | null>(null);
  /** The draft opened under its row to read and fix (#3032). */
  const [editing, setEditing] = useState<DraftEdit | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Only a workspace the user picked by hand is worth recording as a hint on the note. */
  const [wsTouched, setWsTouched] = useState(false);
  const [brief, setBrief] = useState<Brief | null>(null);
  /** The text a 定型の指示 put in (#940) and the workspace it was expanded for: sent only while that workspace is chosen. */
  const [draft, setDraft] = useState<{ workspaceId: string | null; text: string } | null>(null);
  const briefSeq = useRef(0);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const titleRef = useRef(title);
  titleRef.current = title;
  const wsIdRef = useRef(wsId);
  wsIdRef.current = wsId;
  const meta = props.workspaces.find((w) => w.kind === "meta");

  const loadInbox = () => api.inbox().then(setInbox).catch(() => undefined);
  useEffect(() => {
    void loadInbox();
  }, [props.inboxRev]);
  const [runnerTouched, setRunnerTouched] = useState(false);
  /** The model select was changed by hand: the rule table's model proposal no longer fills it. */
  const [modelTouched, setModelTouched] = useState(false);
  const runnerTouchedRef = useRef(false);
  /** 新規作成の既定 (#835): the runner the form starts on when the router has no reason to prefer one (its fallback); null = not changed from the default. */
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

  // "" = 自動 (#135), the default: the daemon asks the LLM to pick a registered Workspace when 開始 is pressed.
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
  // Permission mode (#58): options and the effective default come from the daemon per runner. `runners` is absent
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
  }, [runner]);
  // After the runner effect above (which empties the model): an untouched select takes the rule's model proposal, and
  // goes back to the CLI default when the proposal has none or is for another runner.
  useEffect(() => {
    if (!modelTouched) setModel(suggestion?.model && runner === suggestion.runner ? suggestion.model : "");
  }, [suggestion, runner, modelTouched]);
  useEffect(() => {
    if (props.health?.runners)
      api
        .settings()
        .then((s) => {
          setShadowDefault(s.shadowRunner);
          // only a runner the person saved: left at its default, the router's own fallback (routing.yaml) stands as before
          savedRunnerRef.current = s.newDefaults.taskRunner !== s.defaults.newDefaults.taskRunner ? s.newDefaults.taskRunner : null;
          const r = startRunner(suggestionRef.current);
          if (!runnerTouchedRef.current && r) setRunner(r);
        })
        .catch(() => undefined);
  }, [props.health]);
  const dakOk = props.runnerOk.has("dak");
  const shadowOn = !isAdkRunner(runner) && dakOk && (shadow ?? shadowDefault === "dak");
  // What 詳細 says while closed: what differs from an untouched form (the rule's model, the saved shadow). Cloud sends
  // none of model / effort / budget / shadow, so they are not shown as changed there. An untouched model is the rule's
  // (the effect below fills the select a render later): read so, the line does not flash 「モデル: CLI 既定」 meanwhile.
  const defaultModel = suggestion?.model && runner === suggestion.runner ? suggestion.model : "";
  const defaultShadow = !isAdkRunner(runner) && dakOk && shadowDefault === "dak";
  const summary = detailsSummary(
    cloud ? { title, executionMode: "cloud", model: defaultModel, effort: "", budget: "", shadow: defaultShadow } : { title, executionMode: "local", model: modelTouched ? model : defaultModel, effort, budget, shadow: shadowOn },
    { model: defaultModel, shadow: defaultShadow, briefTitle: brief?.title },
  );
  // What the request says about the shadow. Untouched → omitted, so the daemon applies its saved default itself (also
  // one this page has not loaded yet, or a non-DAK one set through the API); a click → explicit. A DAK primary with
  // DAK as the default says null: the daemon would only note that the shadow equals the primary. An ADK server added in
  // Settings offers no shadow toggle, so it says null too: the saved DAK default does not ride along unseen.
  const shadowRunnerField: RunnerId | null | undefined = runner.startsWith("custom:") ? null : runner === "dak" ? (shadowDefault === "dak" ? null : undefined) : shadow === null ? undefined : shadow && dakOk ? "dak" : null;
  // The newest report across Tasks (#1835), read once per visit to Home, and whether any artifact exists (#1833): the
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
  const active = useMemo(() => props.tasks.filter((t) => t.status === "running" || t.status === "waiting"), [props.tasks]);
  const attention = useMemo(() => attentionList(props.tasks), [props.tasks]);
  const recent = useMemo(() => props.tasks.filter((t) => t.status !== "running" && t.status !== "waiting" && !needsAttention(t)).slice(0, 6), [props.tasks]);

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
        // empty, or only the inserted prefix: no title, so the daemon names the task (#491)
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
      setShadow(null); // the click was for that task; the next one starts from the saved default again
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
      if (!ws && (e as { status?: number }).status === 409) wsSelect.current?.focus(); // 自動 could not choose: the next step is this select
    } finally {
      setChoosing(false);
      setBusy(false);
    }
  };

  /** ⌘↵: keep the thought without deciding the repository yet. */
  const saveToInbox = async () => {
    if (!prompt.trim() || busy || attach.items.length || attach.busy || stale) return; // a note is text; attachments go with 開始
    setBusy(true);
    try {
      const n = await api.inboxAdd(prompt.trim(), { title: title.trim() || undefined, workspaceHint: wsTouched ? ws?.name : undefined });
      setSaved(n.path);
      setModelTouched(false);
      setTitle("");
      setPrompt("");
      setBrief(null);
      setDraft(null);
      await loadInbox();
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(null), 4000);
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // Inbox promotion stays manual (#135 スコープ外): with the main select on 自動 it falls back to what used to be the default.
  const promoteDefault = wsId || (props.workspaces.find((w) => w.kind === "repo") ?? props.workspaces[0])?.id || "";
  const promote = async (n: InboxNote) => {
    const targetId = promoteWs[n.path] ?? props.workspaces.find((w) => w.name === n.workspaceHint)?.id ?? promoteDefault;
    const target = props.workspaces.find((w) => w.id === targetId);
    if (!target || promoting) return;
    setPromoting(n.path);
    try {
      const s = await api.suggest({ executionMode: "local", workspaceId: target.id, cwd: target.path, title: n.title, prompt: n.body }).catch(() => null);
      const installed = [...props.runnerOk];
      const runner = s && props.runnerOk.has(s.runner) ? s.runner : installed[0];
      if (!runner) throw new Error(t(home.noRunner));
      const r = await api.inboxPromote(n.path, target.id, runner);
      await loadInbox();
      props.onOpenTask(r.task.id);
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      setPromoting(null);
    }
  };

  const closeNote = async (n: InboxNote) => {
    try {
      await api.inboxClose(n.path);
      await loadInbox();
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    }
  };
  const saveEdit = async (e: DraftEdit) => {
    setSavingEdit(true);
    try {
      const n = await api.inboxEdit(e.path, e.title, e.text);
      // only while the editor still holds what was sent: typing more, やめる or another draft meanwhile wins
      setEditing((cur) => (cur === e ? { path: n.path, title: n.title, text: n.body } : cur));
      await loadInbox();
    } catch (err) {
      props.onError(String((err as Error).message ?? err));
    } finally {
      setSavingEdit(false);
    }
  };
  const drafts = inbox;

  /**
   * "改善 →": put a workspace's brief (from the daemon) in front of the request. What the user already typed is kept:
   * a prompt that starts with a previous brief has that prefix replaced, anything else gets the brief prepended.
   */
  const improve = async (target: Workspace) => {
    if (target.id !== wsId) {
      setWsId(target.id);
      setWsTouched(true);
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
                setWsTouched(true);
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
        <PresetPicker
          workspaceId={ws?.id ?? null}
          onText={(text, title) => {
            setPrompt(text);
            setTitle(title);
            setBrief(null);
            setDraft({ workspaceId: ws?.id ?? null, text });
          }}
          onError={props.onError}
        />
        {stale && <div className="hint warn">{t(home.staleDraft)}</div>}
        <div className={`dropzone ${drop.dropping ? "dropping" : ""}`} {...(cloud ? {} : drop.handlers)}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={cloud ? undefined : drop.onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (busy) return;
                if (e.shiftKey) void submit();
                else void saveToInbox();
              }
            }}
            rows={6}
            placeholder={cloud ? t(home.promptCloud) : t(home.promptLocal)}
          />
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
                <label key={r} className={`runner-opt ${!ok ? "off" : ""} ${runner === r ? "sel" : ""}`} title={!ok ? offTitle : expired ? t(home.loginExpiredTitle, { command: info.loginHint ?? r }) : (info?.note ?? "")}>
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
          <button disabled={busy || stale || !prompt.trim() || attach.items.length > 0} onClick={() => void saveToInbox()} title={attach.items.length ? t(home.inboxNoAttachments) : t(home.inboxSaveTitle)}>
            {t(home.saveToInbox)}
          </button>
          <button className="pri" disabled={busy || stale || (!cloud && attach.busy) || !prompt.trim() || !props.runnerOk.has(runner) || (cloud && !ws)} onClick={() => void submit()} title={!cloud && attach.busy ? t(home.waitUpload) : ""}>
            {choosing ? t(home.choosingWorkspace) : busy ? t(home.starting) : !cloud && attach.busy ? t(home.uploading) : t(home.start)}
          </button>
        </div>
        {/* why a runner or 開始 cannot be used, read without hovering (#3354); an empty prompt needs no words, a stale one is said above */}
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
            {!cloud && <ModelSelect runner={runnerInfo} value={model} onChange={(v) => { setModel(v); setModelTouched(true); setRunnerTouched(true); /* a model belongs to this runner: the router must not swap it away */ }} label={t(home.model)} title={t(home.modelTitle)} />}
            {!cloud && <EffortSelect runner={runnerInfo} value={effort} onChange={(e) => { setEffort(e); setRunnerTouched(true); /* chosen for this runner: the router must not swap it away */ }} label={t(home.effort)} title={t(home.effortTitle)} />}
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
          {ws && ws.kind !== "meta" && (
            <button className="ghost" onClick={() => void improve(ws)} title={t(home.improveTitle, { name: ws.name })}>
              {t(home.improve, { name: ws.name })}
            </button>
          )}
          {meta && (
            <button className="ghost" onClick={() => void improve(meta)} title={t(home.improveSelfTitle)}>
              {t(home.improveSelf)}
            </button>
          )}
        </div>
      </section>

      {saved && <div className="banner ok">{t(home.savedToInbox, { path: saved })}</div>}

      {drafts.length > 0 && (
        <section className="card">
          <h5>{t(home.inboxHeading)}</h5>
          {drafts.map((n) => {
            const open = editing?.path === n.path ? editing : null;
            return (
              <Fragment key={n.path}>
                <div className="row inbox-row" title={n.path}>
                  <DraftTitle note={n} open={!!open} onToggle={() => setEditing((cur) => toggleDraft(cur, n))} />
                  <select value={promoteWs[n.path] ?? props.workspaces.find((w) => w.name === n.workspaceHint)?.id ?? promoteDefault} onChange={(e) => setPromoteWs((m) => ({ ...m, [n.path]: e.target.value }))}>
                    {props.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                        {n.workspaceHint === w.name ? " ?" : ""}
                      </option>
                    ))}
                  </select>
                  <button disabled={promoting !== null} onClick={() => void promote(n)}>
                    {promoting === n.path ? t(home.starting) : t(home.promote)}
                  </button>
                  <button onClick={() => void closeNote(n)}>{t(home.close)}</button>
                </div>
                {open && <DraftEditor edit={open} note={n} saving={savingEdit} onChange={setEditing} onCancel={() => setEditing(null)} onSave={() => void saveEdit(open)} />}
              </Fragment>
            );
          })}
        </section>
      )}

      <div className="grid2">
        <section className="card">
          <h5>{t(home.activeHeading)}</h5>
          {active.length === 0 && <div className="muted">{t(home.none)}</div>}
          {active.map((x) => (
            <button key={x.id} className="row link" onClick={() => props.onOpenTask(x.id)}>
              <span className={`dot ${x.status === "waiting" ? "wait" : "run"}`} />
              <span className="t">{x.title}</span>
              <RunnerPill runner={x.runner} />
              <ShadowTag task={x} />
              <span className="m">{x.status === "waiting" ? t(home.waitingApproval) : t(home.running)}</span>
            </button>
          ))}
          <h5 style={{ marginTop: 14 }}>{t(home.attentionHeading, { count: attention.length })}</h5>
          {attention.length === 0 && <div className="muted">{t(home.none)}</div>}
          {attention.map((t) => (
            <button key={t.id} className="row link" onClick={() => props.onOpenTask(t.id)}>
              <span className={`dot ${outcomeDotClass(t.outcome)}`} />
              <span className="t">{t.title}</span>
              <RunnerPill runner={t.runner} />
              <OriginTag origin={t.origin} />
              <ShadowTag task={t} />
              <span className="m">{outcomeLabel(t.outcome)}</span>
            </button>
          ))}
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
              <QuotaRow key={`${q.runner}-${q.window}`} label={`${q.runner} · ${windowLabel(q.window)}`} utilization={q.utilization} resetsAt={q.resetsAt} ts={q.ts} />
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
  // the same words as the Ledger's 使用量（枠） (#1836); a window not reported for a day is faded
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

/** An Inbox draft's title on its row (#3032): pressing it opens or closes the draft; … marks a longer body while closed. */
export function DraftTitle(props: { note: InboxNote; open: boolean; onToggle: () => void }) {
  return (
    <button className="t" aria-expanded={props.open} onClick={props.onToggle}>
      {props.note.title}
      {!props.open && props.note.body.includes("\n") && <span className="hint"> …</span>}
    </button>
  );
}

/** The draft opened under its row (#3032): its title and whole body to fix, saved only by 保存 and only when changed. */
export function DraftEditor(props: { edit: DraftEdit; note: InboxNote; saving: boolean; onChange: (e: DraftEdit) => void; onCancel: () => void; onSave: () => void }) {
  const { edit } = props;
  return (
    <div className="inbox-edit">
      <input value={edit.title} onChange={(e) => props.onChange({ ...edit, title: e.target.value })} />
      <textarea value={edit.text} onChange={(e) => props.onChange({ ...edit, text: e.target.value })} />
      <div className="acts">
        <button onClick={props.onCancel}>{t(home.cancel)}</button>
        <button className="pri" disabled={props.saving || !editChanged(edit, props.note)} onClick={props.onSave}>
          {t(home.save)}
        </button>
      </div>
    </div>
  );
}
