import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { NewDefaultsSettings, Settings, type CloudPreparation, type ExecutionMode, type CreateTaskInput, type RoutingSuggestion, type RunnerId, type Task, type Workspace } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { type Health } from "../api/daemon.ts";
import { RunnerPill } from "./ui.tsx";
import { AttachButton, AttachmentBar, useAttachments, useDropZone } from "./Attachments.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { staleDraft } from "../presets.ts";
import { listedRunners, runnerLabel } from "../runners.ts";
import { shownWorkspaces } from "../workspaceList.ts";
import { afterFailedRead, composeShadow } from "../composeShadow.ts";
import { homeEmptyLabel, initialChoice } from "../runnerSettings.ts";
import { PresetPicker } from "./PresetPicker.tsx";
import { SlashPicker } from "./SlashPicker.tsx";
import { titleToSend } from "../taskTitle.ts";
import { detailsSummary, loadDetailsOpen, loadDevelopSelf, saveDetailsOpen, saveDevelopSelf } from "../composeDetails.ts";
import { backlogTargetName, feedbackArgs, selectValue } from "../compose.ts";
import { loadNewIssueDraft, newIssueDraftKey } from "../backlogSync.ts";
import { SaveIssue } from "./SaveIssue.tsx";
import { feedbackModes, startWorkspace, type FeedbackTarget } from "../feedbackTarget.ts";
import { FeedbackUpstreamBox, type FeedbackPrefill } from "./Feedback.tsx";
import { type FeedbackUpstream } from "../api/feedback.ts";
import { panels as feedbackText } from "../i18n/panels.ts";
import { startBlockedReason, unavailableNotice, unavailableNotices } from "../runnerNotice.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";
import { runnerLoginLabel } from "../login.ts";

/** Before the settings are read: no saved model / effort for any runner. */
const ND_NONE: NewDefaultsSettings = NewDefaultsSettings.parse({});
/** What the setting is when no one saved it (the schema's default), so the form is drawn with it until the settings are read. */
const DEVELOP_SELF_DEFAULT: boolean = Settings.shape.developSelf.parse(undefined);

/** The prefix "改善 →" inserted: remembered so a Workspace switch can swap it for the new workspace's brief (and only it). */
type Brief = { wsId: string; text: string; title: string };
const briefTitle = (ws: Workspace) => (ws.kind === "meta" ? t(home.briefTitleSelf) : t(home.briefTitle, { name: ws.name }));

/** The instruction form: Home draws it as it is, and every other screen draws the same component inside the feedback dialog. */
export function Compose(props: {
  health: Health | null;
  workspaces: Workspace[];
  runnerOk: Set<RunnerId>;
  onCreate: (input: CreateTaskInput) => Promise<void>;
  onError: (msg: string) => void;
  onOpenSettings: () => void;
  /** The screen it is sent from, by the name `screenLabel` gives (goes into `POST /api/feedback`'s `screen`). */
  screen: string;
  /** A Task that 「バックログに積む」 or 「要望にしてすぐ直す」 started. */
  onSent: (task: Task) => void;
  /** The repository the form starts on when it is opened for one (the Backlog's narrowed repository); listed even when `workspaces` has not caught up with it. */
  initialWorkspace?: FeedbackTarget;
  /** A draft with where it came from (改善要望にする, 要望にする): its `source` goes with 「バックログに積む」; its text starts the form unless `draft` holds the text. */
  prefill?: FeedbackPrefill;
  /** The text kept outside, so a closed dialog does not lose it. */
  draft?: { text: string; onText: (v: string) => void };
  /** The attachments kept outside, for the same reason. */
  attach?: ReturnType<typeof useAttachments>;
  /** Takes a picture of the screen (the dialog steps aside while it does); with it a 「画面を撮る」 button is drawn. */
  capture?: () => Promise<File>;
  /** With it a 「やめる」 button is drawn at the left of the buttons. */
  onCancel?: () => void;
  /** Told whether a send or a capture is under way (the dialog is not closed by Esc meanwhile). */
  onBusy?: (busy: boolean) => void;
  /** Where it was opened from, one line under the hints. */
  note?: ReactNode;
}) {
  const start = startWorkspace(props.workspaces, props.initialWorkspace);
  const [wsId, setWsId] = useState<string>(start.initial);
  const [title, setTitle] = useState("");
  const [ownPrompt, setOwnPrompt] = useState(props.prefill?.text ?? "");
  const prompt = props.draft ? props.draft.text : ownPrompt;
  const setPrompt = props.draft ? props.draft.onText : setOwnPrompt;
  // Attachments: uploaded as they are added, sent as ids with 今すぐ始める.
  const ownAttach = useAttachments(props.onError);
  const attach = props.attach ?? ownAttach;
  const drop = useDropZone((files) => void attach.add(files), props.onError);
  /** 「バックログに積む」 / 「要望にしてすぐ直す」 under way. */
  const [sending, setSending] = useState<"request" | "fix" | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The answer of a request for Switchboard itself on an instance that does not develop it: a link or the text, no Task. */
  const [upstream, setUpstream] = useState<FeedbackUpstream["upstream"] | null>(null);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("local");
  const [cloudPreparation, setCloudPreparation] = useState<CloudPreparation | null>(null);
  const [cloudPreparationError, setCloudPreparationError] = useState<string | null>(null);
  const [runner, setRunner] = useState<RunnerId>("claude");
  const cloud = runner === "claude" && executionMode === "cloud";
  /** "" = follow the runner's saved default (shown selected); anything else is sent explicitly. */
  const [mode, setMode] = useState("");
  /** What the person picked: read only while `modelTouched` / `effortTouched`; an untouched select shows `initial` (below), so no effect fills it. */
  const [modelPick, setModelPick] = useState("");
  const [effortPick, setEffortPick] = useState(""); // "" = the CLI's own default
  const [budget, setBudget] = useState("");
  // Shadow run: null = follow the saved default (Settings.shadowRunner); a click makes it explicit for this task.
  const [shadow, setShadow] = useState<boolean | null>(null);
  // Settings 「Switchboard 自体を開発する」: read with the other defaults below. Until it is read the form is drawn with the last
  // value this browser saw (the setting's default, `DEVELOP_SELF_DEFAULT`, when none was kept): kept when the settings are read here
  // and when Settings saves them in this browser. A visit after the first therefore gets its final form from the first draw, on or
  // off; what is not covered is a change made from another browser or device, seen late (the form changes when the answer
  // comes) on the first draw after it, and the first visit of an instance that turned it off. A failed request leaves what is drawn.
  const [developSelf, setDevelopSelf] = useState(() => loadDevelopSelf(localStorage, DEVELOP_SELF_DEFAULT));
  /** The saved shadow default: undefined = not loaded yet, "unread" = the first read failed. Both draw the row off and send `null`. */
  const [shadowDefault, setShadowDefault] = useState<RunnerId | null | undefined | "unread">(undefined);
  /** 詳細: the rarely set values, folded; open or closed as the person left it in this browser. */
  const [detailsOpen, setDetailsOpen] = useState(() => loadDetailsOpen(localStorage));
  /** The keep-as-Issue form inside 詳細 is mounted once 詳細 has been open (from the first draw when it was left open), and stays; it reads its draft from storage when it mounts. */
  const [everOpen, setEverOpen] = useState(detailsOpen);
  // What a SaveIssue mounted when the Workspace list arrived would have started with, handed to one mounted later (when 詳細 is first
  // opened): the Workspace the form had then (it decides whether the draft section starts expanded) and the last one chosen.
  const [firstWs, setFirstWs] = useState<string | undefined>(undefined);
  const [rememberedWs, setRememberedWs] = useState<string | undefined>(undefined);
  if (firstWs === undefined && props.workspaces.length > 0) setFirstWs(wsId || props.workspaces[0]!.id);
  if (wsId && wsId !== rememberedWs) setRememberedWs(wsId);
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
    setModelPick(""); // a model belongs to one runner
    setEffortPick(""); // so does an effort
    setEffortTouched(false);
  }, [runner]);
  // An untouched select takes the rule's model proposal, else the saved default for this runner, and goes back to the CLI
  // default when there is none. Read in the render, not filled by an effect after a runner change: a response that changes
  // the runner is one commit with the final selects.
  const initial = initialChoice(runner, runnerInfo, newDefaults ?? ND_NONE, suggestion ?? undefined);
  const model = selectValue(modelTouched, modelPick, initial.model);
  const effort = selectValue(effortTouched, effortPick, initial.effort);
  useEffect(() => {
    if (props.health?.runners)
      api
        .settings()
        .then((s) => {
          setShadowDefault(s.shadowRunner);
          setDevelopSelf(s.developSelf);
          saveDevelopSelf(localStorage, s.developSelf);
          setNewDefaults(s.newDefaults);
          // only a runner the person saved: left at its default, the router's own fallback (routing.yaml) stands as before
          savedRunnerRef.current = s.newDefaults.taskRunner !== s.defaults.newDefaults.taskRunner ? s.newDefaults.taskRunner : null;
          const r = startRunner(suggestionRef.current);
          if (!runnerTouchedRef.current && r) setRunner(r);
        })
        .catch(() => setShadowDefault(afterFailedRead));
  }, [props.health]);
  const dakListed = listedRunners(props.health?.runners).includes("dak");
  const shadowRow = composeShadow({ runner, shadowDefault, touched: shadow, runnerOk: props.runnerOk, dakListed });
  const shadowRowDefault = composeShadow({ runner, shadowDefault, touched: null, runnerOk: props.runnerOk, dakListed });
  // What 詳細 says while closed: what differs from an untouched form (the initial model and effort, the saved shadow). Cloud sends
  // none of model / effort / budget / shadow, so they are not shown as changed there. An untouched model is the rule's
  // (the select shows it too): read so, the line does not flash 「モデル: CLI 既定」 meanwhile.
  const defaultModel = initial.model;
  const defaultShadow = shadowRowDefault.checked ? shadowRowDefault.runner : null;
  const summary = detailsSummary(
    cloud ? { title, executionMode: "cloud", model: defaultModel, effort: "", budget: "", shadow: defaultShadow } : { title, executionMode: "local", model: modelTouched ? model : defaultModel, effort: effort === initial.effort ? "" : effort, budget, shadow: shadowRow.checked ? shadowRow.runner : null },
    { model: defaultModel, shadow: defaultShadow, briefTitle: brief?.title },
  );
  // What the request says about the shadow: the row's own result. Checked → the named runner; unchecked → null; omitted (the
  // daemon's saved default then decides) only for a DAK primary, which has no row; loading and unread say null.
  const shadowRunnerField: RunnerId | null | undefined = shadowRow.field;

  // runners not listed yet (loading, unreachable, no token): no runner reason is given, the button stays disabled as before
  const offRunners = unavailableNotices(props.health?.runners);
  const runnersKnown = !!props.health?.runners;
  const blocked = startBlockedReason({ prompt, stale, attachBusy: attach.busy, runnerOk: !runnersKnown || props.runnerOk.has(runner), cloud, ws: !!ws, anyRunnerOk: !runnersKnown || props.runnerOk.size > 0 });
  // the setting is read with the other defaults above; unread, it holds the last value read in this browser (else the default)
  const offer = feedbackModes(developSelf, wsId ? { id: wsId, name: ws?.name ?? "" } : undefined, props.workspaces);
  const locked = busy || sending !== null || capturing;
  useEffect(() => {
    props.onBusy?.(locked);
    return () => props.onBusy?.(false);
  }, [locked]);
  const targetName = backlogTargetName(props.workspaces, wsId) || t(home.targetFallback);
  // 自分で書いて保存 keeps its draft in this browser: a closed 詳細 says one waits (the repository the form would save to)
  const savedDraft = props.workspaces.length > 0 && loadNewIssueDraft(localStorage, newIssueDraftKey(wsId || props.workspaces[0]!.id)) !== null;
  const canFile = !!prompt.trim() && !attach.busy && !stale && !locked;
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** 「バックログに積む」 (`request`: filed in the chosen repository) and 「要望にしてすぐ直す」 (`fix`): the same call the feedback dialog made. */
  const file = async (how: "request" | "fix") => {
    if (!canFile) return;
    setSending(how);
    setMessage(null);
    try {
      const sent = await api.feedback(...feedbackArgs(how, { text: prompt, attachmentIds: attach.ids, screen: props.screen, workspaceId: wsId || null, source: props.prefill?.source }));
      attach.clear();
      if ("upstream" in sent) {
        // no Task: the text stays to be copied, with where to file it
        setUpstream(sent.upstream);
        return;
      }
      setTitle("");
      setPrompt("");
      setBrief(null);
      setDraft(null);
      props.onSent(sent);
    } catch (e) {
      const error = String((e as Error).message ?? e);
      setMessage(error);
      props.onError(error);
    } finally {
      setSending(null);
    }
  };
  /** 画面を撮る: the dialog steps aside while the screen is taken; the picture joins the attachments. */
  const capture = async () => {
    if (!props.capture) return;
    setCapturing(true);
    setMessage(null);
    try {
      await attach.add([await props.capture()]);
    } catch {
      setMessage(t(feedbackText.captureFailed));
    } finally {
      setCapturing(false);
      // the form is still locked until that state renders: focus the text once it has
      requestAnimationFrame(() => textarea.current?.focus());
    }
  };
  const submit = async () => {
    if (!prompt.trim() || (!cloud && attach.busy) || stale || sending !== null || capturing) return;
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
    <section className="card compose" data-compose>
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
            {shownWorkspaces(props.workspaces, props.health?.releaseOnly ?? false).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.kind === "meta" ? t(home.selfSuffix) : ""} — {w.path}
              </option>
            ))}
            {start.extra && <option value={start.extra.id}>{start.extra.name}</option>}
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
          <SlashPicker runner={cloud ? null : runner} workspaceId={ws?.id ?? null} text={prompt} onText={setPrompt}>
            <textarea
              ref={textarea}
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setUpstream(null); }}
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
          </SlashPicker>
        </PresetPicker>
        {!cloud && <AttachmentBar items={attach.items} onRemove={attach.remove} busy={attach.busy} />}
        {props.capture && !cloud && <CaptureRow disabled={locked} onCapture={() => void capture()} />}
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
                  name={props.onCancel ? "runner-dialog" : "runner"} // the dialog can open over Home: two forms on one page must not share one radio group
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
        {props.onCancel && <CancelButton disabled={locked} onCancel={props.onCancel} />}
        <AttachButton onFiles={(files) => void attach.add(files)} disabled={locked || cloud} />
        <button data-compose-backlog disabled={!canFile} onClick={() => void file("request")} title={attach.busy ? t(home.waitUpload) : ""}>
          {sending === "request" ? t(home.sendingRequest) : t(home.addToBacklog)}
        </button>
        <button className="pri" data-compose-start disabled={locked || stale || (!cloud && attach.busy) || !prompt.trim() || !props.runnerOk.has(runner) || (cloud && !ws)} onClick={() => void submit()} title={!cloud && attach.busy ? t(home.waitUpload) : ""}>
          {choosing ? t(home.choosingWorkspace) : busy ? t(home.starting) : !cloud && attach.busy ? t(home.uploading) : t(home.start)}
        </button>
      </div>
      <div className="hint compose-hint" data-compose-hint>{t(home.composeHint, { target: targetName })}</div>
      {offer.upstream && <div className="hint">{t(feedbackText.requestHintUpstream)}</div>}
      {props.note && <div className="hint feedback-screen">{props.note}</div>}
      {upstream && <FeedbackUpstreamBox upstream={upstream} onCopyError={setMessage} />}
      {capturing && <p role="status">{t(feedbackText.capturing)}</p>}
      {message && <p className="error" role="alert">{message}</p>}
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
      <details className="compose-details" open={detailsOpen} onToggle={(e) => { const open = e.currentTarget.open; setDetailsOpen(open); if (open) setEverOpen(true); saveDetailsOpen(localStorage, open); }}>
        <summary>
          {t(home.details)}{!detailsOpen && summary && <span className="hint"> · {summary}</span>}{!detailsOpen && savedDraft && <span className="hint" data-compose-saved-draft> · {t(home.savedDraft)}</span>}
        </summary>
        <div className="runners">
          <label>
            <span>{t(home.title)}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t(home.titlePlaceholder)} />
          </label>
          {runner === "claude" && <label>{t(home.runLocation)} <select aria-label={t(home.runLocation)} value={executionMode} onChange={e => { setExecutionMode(e.target.value as ExecutionMode); setRunnerTouched(true); }}><option value="local">{t(home.local)}</option><option value="cloud">{t(home.cloud)}</option></select></label>}
          {!cloud && <ModelSelect runner={runnerInfo} value={model} onChange={(v) => { setModelPick(v); setModelTouched(true); setRunnerTouched(true); /* a model belongs to this runner: the router must not swap it away */ }} label={t(home.model)} title={t(home.modelTitle)} emptyLabel={homeEmptyLabel("model", runnerInfo)} />}
          {!cloud && <EffortSelect runner={runnerInfo} value={effort} onChange={(e) => { setEffortPick(e); setEffortTouched(true); setRunnerTouched(true); /* chosen for this runner: the router must not swap it away */ }} label={t(home.effort)} title={t(home.effortTitle)} emptyLabel={homeEmptyLabel("effort", runnerInfo)} />}
          {!cloud && <input className="model" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t(home.budgetPlaceholder)} inputMode="decimal" title={t(home.budgetTitle)} />}
          {!cloud && shadowRow.show && (
            <label
              className={`hint toggle shadow ${shadowRow.disabled ? "off" : ""}`}
              title={shadowRow.note === "loading" ? t(home.loadingDefault) : shadowRow.note === "unread" ? t(home.shadowUnread) : t(home.shadowTitle, { runner: runnerLabel(shadowRow.runner ?? "") })}
            >
              <input
                type="checkbox"
                disabled={shadowRow.disabled}
                checked={shadowRow.checked}
                onChange={(e) => {
                  setShadow(e.target.checked);
                  setRunnerTouched(true); // the pair was chosen for this runner: the router must not swap the primary
                }}
              />
              {shadowRow.runner ? t(home.shadow, { runner: runnerLabel(shadowRow.runner) }) : t(home.shadowLabel)}
              {shadowRow.checked && shadowRow.saved && <span className="hint">{t(home.defaultTag)}</span>}
              {shadowRow.note === "unread" && <span className="hint">{t(home.shadowUnread)}</span>}
              {shadowRow.note === "same" && <span className="hint">{t(home.shadowSame)}</span>}
              {shadowRow.note === "missing" && <span className="hint">{shadowRow.runner === "dak" ? t(home.dakUnreachable) : t(home.shadowMissing, { runner: runnerLabel(shadowRow.runner ?? "") })}</span>}
            </label>
          )}
          <button className="ghost" onClick={props.onOpenSettings} title={t(home.defaultsInSettingsTitle)}>{t(home.defaultsInSettings)}</button>
        </div>
        {/* the improve preambles are for an improvement request only, not every request: folded with the rest */}
        <ImproveButtons ws={ws} meta={meta} developSelf={developSelf} onImprove={(w) => void improve(w)} />
        {offer.fix && (
          <div className="compose-fix">
            <button data-compose-fix disabled={!canFile} onClick={() => void file("fix")}>{sending === "fix" ? t(home.sendingRequest) : t(home.fixNow)}</button>
            <span className="hint">{t(feedbackText.fixHint, { target: targetName })}</span>
          </div>
        )}
        {everOpen && props.workspaces.length > 0 && <SaveIssue workspaces={props.workspaces} current={wsId} first={firstWs} remembered={rememberedWs} />}
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

/** The dialog's own controls, drawn only when the form sits in it (Home has neither), so they are not part of what Home's form shows. */
function CaptureRow({ disabled, onCapture }: { disabled: boolean; onCapture: () => void }) {
  return (
    <div className="compose-capture">
      <button type="button" data-compose-capture disabled={disabled} onClick={onCapture}>{t(feedbackText.capture)}</button>
      <span className="hint">{t(feedbackText.pasteHint)}</span>
    </div>
  );
}

function CancelButton({ disabled, onCancel }: { disabled: boolean; onCancel: () => void }) {
  return <button type="button" className="ghost" data-compose-cancel disabled={disabled} onClick={onCancel}>{t(home.cancelCompose)}</button>;
}
