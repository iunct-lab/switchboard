import { useEffect, useMemo, useRef, useState } from "react";
import type { CloudPreparation, ExecutionMode, CreateTaskInput, HistoryStatus, LedgerSummary, ReportRow, RoutingSuggestion, RunnerId, RunnerInfo, Task, Workspace } from "@switchboard/protocol";
import { api, type Health, type InboxNote } from "../api.ts";
import { fmtUsd, OriginTag, pct, ResumeTag, RunnerPill, ShadowTag } from "./ui.tsx";
import { AttachButton, AttachmentBar, useAttachments, useDropZone } from "./Attachments.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { attentionList, needsAttention, outcomeDotClass, outcomeLabel } from "../attention.ts";
import { reportMeta } from "../reports.ts";
import { quotaAsOf, quotaStale, resetLabel, windowLabel } from "../quota.ts";
import { jstTime } from "../time.ts";
import { noticeSource, splitInbox } from "../inbox.ts";
import { staleDraft } from "../presets.ts";
import { listedRunners } from "../runners.ts";
import { PresetPicker } from "./PresetPicker.tsx";

/** The prefix "改善 →" inserted: remembered so a Workspace switch can swap it for the new workspace's brief (and only it). */
type Brief = { wsId: string; text: string; title: string };
const briefTitle = (ws: Workspace) => (ws.kind === "meta" ? "Switchboard を改善: " : `${ws.name} を改善: `);

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
  /** The newest report's line (#1835): opens Insights with it. */
  onOpenReport: (id: string) => void;
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
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [inbox, setInbox] = useState<InboxNote[]>([]);
  const [promoteWs, setPromoteWs] = useState<Record<string, string>>({});
  const [promoting, setPromoting] = useState<string | null>(null);
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
        .catch(() => { if (seq === suggestSeq.current && cloud) setCloudPreparationError("Git状態は取得できません。内容を確認してから開始してください。"); });
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
  const shadowOn = runner !== "dak" && dakOk && (shadow ?? shadowDefault === "dak");
  // What the request says about the shadow. Untouched → omitted, so the daemon applies its saved default itself (also
  // one this page has not loaded yet, or a non-DAK one set through the API); a click → explicit. A DAK primary with
  // DAK as the default says null: the daemon would only note that the shadow equals the primary.
  const shadowRunnerField: RunnerId | null | undefined = runner === "dak" ? (shadowDefault === "dak" ? null : undefined) : shadow === null ? undefined : shadow && dakOk ? "dak" : null;
  // The newest report across Tasks (#1835), read once per visit to Home; no card at all when there is none.
  const [latestReport, setLatestReport] = useState<ReportRow | null>(null);
  useEffect(() => {
    let alive = true;
    api.reports(1).then((r) => alive && setLatestReport(r[0] ?? null), () => undefined);
    return () => {
      alive = false;
    };
  }, []);
  // Terminal history (#91): what the daemon imported from ~/.claude/projects; refreshed when the task list changes.
  const [history, setHistory] = useState<HistoryStatus | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  // The daemon's passes are silent when they only append or find nothing: poll while Home is open (and on any task
  // change), and keep retrying after a failed fetch.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .history()
        .then((h) => {
          if (!alive) return;
          setHistory(h);
          setHistoryErr(null);
        })
        .catch((e) => alive && setHistoryErr(String((e as Error).message ?? e)));
    void load();
    const timer = setInterval(() => {
      setImportMsg(null); // the card's own figures are current again
      void load();
    }, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [props.tasks]);
  const importNow = async () => {
    setImporting(true);
    try {
      const r = await api.historyImport();
      setImportMsg(`走査 ${r.files} ファイル: 新規 ${r.created} · 追記 ${r.appended}${r.skippedForeign ? ` · Workspace 外 ${r.skippedForeign}` : ""}${r.errors.length ? ` · エラー ${r.errors.length}（${r.errors[0]}）` : ""}`);
      setHistory(await api.history());
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      setImporting(false);
    }
  };
  const terminalSessions = history?.sessions.filter((s) => s.origin === "terminal").length ?? 0;
  const active = useMemo(() => props.tasks.filter((t) => t.status === "running" || t.status === "waiting"), [props.tasks]);
  const attention = useMemo(() => attentionList(props.tasks), [props.tasks]);
  const recent = useMemo(() => props.tasks.filter((t) => t.status !== "running" && t.status !== "waiting" && !needsAttention(t)).slice(0, 6), [props.tasks]);

  const submit = async () => {
    if (!prompt.trim() || (!cloud && attach.busy) || stale) return;
    if (cloud && !ws) { props.onError("Cloud は Workspace を明示選択してください"); wsSelect.current?.focus(); return; }
    if (!cloud && budget.trim() && !(Number(budget) > 0)) {
      props.onError("予算は正の数（USD）で入力してください");
      return;
    }
    setBusy(true);
    setChoosing(!ws);
    try {
      await props.onCreate({
        executionMode: cloud ? "cloud" : "local",
        workspaceId: ws?.id, // neither = 自動: the daemon chooses, or answers 409 and the person picks
        cwd: ws?.path,
        title: title.trim() || prompt.trim().slice(0, 48),
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
      if (!runner) throw new Error("実行できるランナーがありません（claude / codex をインストールしてください）");
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
  const { notices, drafts } = splitInbox(inbox);

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
      const t = titleRef.current;
      setTitle(brief && t.startsWith(brief.title) ? next.title + t.slice(brief.title.length) : t.trim() ? t : next.title);
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
            <span>Workspace がまだありません</span>
            <button onClick={props.onOpenSettings}>設定で追加 →</button>
          </div>
        </section>
      )}
      <section className="card compose">
        <div className="row head">
          <h5>新しいタスク · Inbox</h5>
          <span className="hint">⌘↵ で Inbox に保存 · ⌘⇧↵ で Task に</span>
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
              <option value="" disabled={cloud}>{cloud ? "Workspace を選択してください" : "自動（LLM が選ぶ）"}</option>
              {props.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.kind === "meta" ? "（自分自身）" : ""} — {w.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>タイトル</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="空なら本文の先頭から生成" />
          </label>
        </div>
        <PresetPicker
          workspaceId={ws?.id ?? null}
          onText={(text, t) => {
            setPrompt(text);
            setTitle(t);
            setBrief(null);
            setDraft({ workspaceId: ws?.id ?? null, text });
          }}
          onError={props.onError}
        />
        {stale && <div className="hint warn">Workspace を変えたので、本文に入れ直してください</div>}
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
            placeholder={cloud ? "Cloud に依頼する内容。Workspace と転送範囲を確認してから「開始」。" : "思いついたことを書く。リポジトリは後で決めてよい（⌘↵ で Inbox）。今すぐ動かすなら ⌘⇧↵ か「開始」。画像やファイルはここにドロップ / 貼り付け。"}
          />
          {!cloud && <AttachmentBar items={attach.items} onRemove={attach.remove} busy={attach.busy} />}
        </div>
        <div className="row">
          <div className="runners">
            {listedRunners(props.health?.runners).map((r) => {
              const ok = props.runnerOk.has(r);
              const info = props.health?.runners?.find((x) => x.id === r);
              const expired = ok && info?.login === "expired";
              const offTitle = info?.note ?? (r === "claude" ? "claude が PATH にありません" : r === "codex" ? "codex が PATH にありません（公式インストーラ: curl -fsSL https://chatgpt.com/codex/install.sh | sh）" : "DAK の agent（http://127.0.0.1:8000、SWITCHBOARD_DAK_URL で変更）に到達できません。DAK リポジトリで docker compose up");
              return (
                <label key={r} className={`runner-opt ${!ok ? "off" : ""} ${runner === r ? "sel" : ""}`} title={!ok ? offTitle : expired ? `ログインが切れています。Task の「ターミナル」tab で ${info.loginHint ?? r} を実行` : (info?.note ?? "")}>
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
                  {expired && <span className="hint">要ログイン</span>}
                  {runner === r && !runnerTouched && suggestion?.runner === r && <span className="hint">推奨</span>}
                </label>
              );
            })}
            {runner === "claude" && <label>実行場所 <select aria-label="実行場所" value={executionMode} onChange={e => { setExecutionMode(e.target.value as ExecutionMode); setRunnerTouched(true); }}><option value="local">ローカル</option><option value="cloud">クラウド</option></select></label>}
            {!cloud && runnerInfo && modes.length > 0 && (
              <select
                className="mode"
                value={selectedMode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setRunnerTouched(true); // a mode is chosen for this runner: the router must not swap it away
                }}
                title={selectedOpt ? `${selectedOpt.label}: ${selectedOpt.description}` : "承認モード"}
                aria-label="承認モード"
              >
                {modes.map((m) => (
                  <option key={m.value} value={m.value}>
                    承認: {m.label}
                    {m.value === defaultMode ? " ← 既定" : ""}
                  </option>
                ))}
              </select>
            )}
            {!cloud && runnerInfo && modes.length === 0 && (
              <span className="hint" title="DAK は agent 側の require_confirmation と Switchboard の mcp.yaml が確認の要否を決めます。承認は従来どおりここに届きます">
                承認: DAK 側の設定で決まる
              </span>
            )}
            {!cloud && runner !== "dak" && listedRunners(props.health?.runners).includes("dak") && (
              <label
                className={`hint toggle shadow ${!dakOk || shadowDefault === undefined ? "off" : ""}`}
                title={!dakOk ? "DAK の agent（http://127.0.0.1:8000、SWITCHBOARD_DAK_URL で変更）に到達できません。DAK リポジトリで docker compose up" : shadowDefault === undefined ? "保存した既定を読み込み中" : "同じ依頼を DAK（DAK に設定したモデル。ローカルモデルなら API 料金なし）でも同時に実行し、並走 Task として並べます。追加の返信も写されます"}
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
                DAK にも同時に流す
                {shadowOn && shadowDefault === "dak" && <span className="hint">既定</span>}
                {!dakOk && shadowDefault === "dak" && <span className="hint">既定は ON（DAK 未検出のため今は並走しません）</span>}
                {shadowDefault && shadowDefault !== "dak" && shadow === null && <span className="hint">既定の並走: {shadowDefault}</span>}
              </label>
            )}
            <button className="ghost" onClick={props.onOpenSettings} title="承認モード・並走・使用上限での自動再開・LLM 提案・自動判定の既定は 設定 画面で変えます">既定は 設定 で変える</button>
            {!cloud && <ModelSelect runner={runnerInfo} value={model} onChange={setModel} label="モデル" title="この Task を動かすモデル。「CLI 既定」はランナー自身の設定（かっこ内）で動きます。作成後も Brief から変えられます" />}
            {!cloud && <EffortSelect runner={runnerInfo} value={effort} onChange={(e) => { setEffort(e); setRunnerTouched(true); /* chosen for this runner: the router must not swap it away */ }} label="思考の深さ" title="この Task の思考の深さ。「CLI 既定」はランナー自身の設定で動きます。作成後は変えられません" />}
            {!cloud && <input className="model" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="予算 USD（API 換算・任意）" inputMode="decimal" title="超過したら確認して止まります" />}
          </div>
          <AttachButton onFiles={(files) => void attach.add(files)} disabled={busy || cloud} />
          <button disabled={busy || stale || !prompt.trim() || attach.items.length > 0} onClick={() => void saveToInbox()} title={attach.items.length ? "添付つきの依頼は Inbox に保存できません（メモは文章だけ）。「開始」で動かすか、添付を外してください" : "Knowledge の notes/ に保存"}>
            Inbox に保存
          </button>
          <button className="pri" disabled={busy || stale || (!cloud && attach.busy) || !prompt.trim() || !props.runnerOk.has(runner) || (cloud && !ws)} onClick={() => void submit()} title={!cloud && attach.busy ? "添付のアップロードが終わるまで待ってください" : ""}>
            {choosing ? "Workspace を選択中…" : busy ? "起動中…" : !cloud && attach.busy ? "アップロード中…" : "開始"}
          </button>
        </div>
        {!cloud && selectedOpt?.danger && <div className="hint warn">「{selectedOpt.label}」は確認なしで実行します — {selectedOpt.description}。このタスクだけに適用され、既定にはできません</div>}
        {cloud && <div className="cloud-preparation card" role="note">
          <p>Cloud を選んで開始すると、公式 CLI の自動 Bundle 転送を了承します。GitHub clone では未pushコミット・未コミット変更が反映されない場合があります。自動 Bundle では全ブランチの履歴・追跡ファイルの変更が送られ得ます。未追跡ファイルは含まれず、秘密情報が必ず除外される保証はありません。Switchboard は commit/push や強制 Bundle を行いません。</p>
          <p className="hint">モデル・承認・添付・予算・並走はここでは指定できません。Cloud側の操作は公式 Web で行ってください。</p>
          <div className="kv">
            <span>リポジトリ</span><span>{cloudPreparation?.repository ?? "判定不明"}</span>
            <span>ブランチ</span><span>{cloudPreparation?.branch ?? "判定不明"}</span>
            <span>未コミット変更</span><span>{cloudPreparation?.dirty === null || !cloudPreparation ? "判定不明" : cloudPreparation.dirty ? "あり" : "なし"}</span>
            <span>未pushコミット</span><span>{cloudPreparation?.unpushed === null || !cloudPreparation ? "判定不明" : cloudPreparation.unpushed ? "あり" : "なし"}</span>
          </div>
          {cloudPreparation?.warnings.slice(1).map(w => <p className="hint" key={w}>{w}</p>)}
          {cloudPreparationError && <p className="hint warn">{cloudPreparationError}</p>}
          {!ws && <p className="hint warn">Workspace を明示選択してください。</p>}
        </div>}
        <div className="row sub">
          <span className="hint suggestion" title={suggestion ? `ルール: ${suggestion.ruleId}` : ""}>
            {!cloud && suggestion ? (
              <>
                推奨: <RunnerPill runner={suggestion.runner} /> <span>{suggestion.reason}</span>
                {!suggestion.available && <span className="warn"> — 未インストール</span>}
                {suggestion.runner !== runner && props.runnerOk.has(suggestion.runner) && (
                  <button
                    className="ghost"
                    onClick={() => {
                      setRunner(suggestion.runner);
                      setRunnerTouched(false);
                    }}
                  >
                    推奨に戻す
                  </button>
                )}
              </>
            ) : (
              <>{cloud ? "Cloud は Claude を使います" : "推奨ランナー: 入力するとルール表（routing.yaml）から提案します"}</>
            )}
          </span>
          {ws && ws.kind !== "meta" && (
            <button className="ghost" onClick={() => void improve(ws)} title={`${ws.name} の構成・指示ファイル・テスト手順（デーモンがリポジトリから読む）を前置きにして改善依頼を書く。書きかけの本文は残る。Workspace を切り替えると前置きも切り替わる`}>
              {ws.name} を改善 →
            </button>
          )}
          {meta && (
            <button className="ghost" onClick={() => void improve(meta)} title="Switchboard 自身（meta workspace）を選び、構成とテスト手順を前置きにして改善依頼を書く。書きかけの本文は残る">
              このアプリを改善 →
            </button>
          )}
        </div>
      </section>

      {saved && <div className="banner ok">Inbox に保存しました: {saved}</div>}

      {notices.length > 0 && (
        <section className="card">
          <h5>お知らせ（定期の予定から）</h5>
          {notices.map((n) => (
            <div key={n.path} className="row inbox-row" title={n.path}>
              <details className="t">
                <summary>
                  {n.title} <span className="hint">{noticeSource(n)}</span>
                </summary>
                <pre className="wrap">{n.body}</pre>
              </details>
              <button onClick={() => void closeNote(n)}>閉じる</button>
            </div>
          ))}
        </section>
      )}

      {drafts.length > 0 && (
        <section className="card">
          <h5>Inbox（まだリポジトリに紐づかないメモ）</h5>
          {drafts.map((n) => (
            <div key={n.path} className="row inbox-row" title={n.path}>
              <span className="t">
                {n.title}
                {n.body.includes("\n") && <span className="hint"> …</span>}
              </span>
              <select value={promoteWs[n.path] ?? props.workspaces.find((w) => w.name === n.workspaceHint)?.id ?? promoteDefault} onChange={(e) => setPromoteWs((m) => ({ ...m, [n.path]: e.target.value }))}>
                {props.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {n.workspaceHint === w.name ? " ?" : ""}
                  </option>
                ))}
              </select>
              <button disabled={promoting !== null} onClick={() => void promote(n)}>
                {promoting === n.path ? "起動中…" : "Task に昇格"}
              </button>
              <button onClick={() => void closeNote(n)}>閉じる</button>
            </div>
          ))}
        </section>
      )}

      <div className="grid2">
        <section className="card">
          <h5>実行中 · 待ち</h5>
          {active.length === 0 && <div className="muted">なし</div>}
          {active.map((t) => (
            <button key={t.id} className="row link" onClick={() => props.onOpenTask(t.id)}>
              <span className={`dot ${t.status === "waiting" ? "wait" : "run"}`} />
              <span className="t">{t.title}</span>
              <RunnerPill runner={t.runner} />
              <ShadowTag task={t} />
              <span className="m">{t.status === "waiting" ? "承認待ち" : "実行中"}</span>
            </button>
          ))}
          <h5 style={{ marginTop: 14 }}>要対応 · {attention.length}</h5>
          {attention.length === 0 && <div className="muted">なし</div>}
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
          {recent.length > 0 && <h5 style={{ marginTop: 14 }}>最近</h5>}
          {recent.map((t) => (
            <button key={t.id} className="row link" onClick={() => props.onOpenTask(t.id)}>
              <span className={`dot ${t.status === "error" ? "err" : "idle"}`} />
              <span className="t">{t.title}</span>
              <RunnerPill runner={t.runner} />
              <OriginTag origin={t.origin} />
              <ResumeTag resumeAt={t.resumeAt} reason={t.resumeReason} />
              <ShadowTag task={t} />
              <span className="m">{t.executionMode === "cloud" ? "Cloud・状態未確認" : t.status}</span>
            </button>
          ))}
        </section>

        <section className="card">
          <h5>今日のコスト</h5>
          <div className="bigno">
            {fmtUsd(props.ledger?.todayUsd ?? 0)}
            <small>
              API 換算 · 実課金 {fmtUsd(props.ledger?.billedTodayUsd ?? 0)} · 今週 {fmtUsd(props.ledger?.weekUsd ?? 0)}
            </small>
          </div>
          <div className="kv" style={{ marginTop: 10 }}>
            {(props.ledger?.quota ?? []).map((q) => (
              <QuotaRow key={`${q.runner}-${q.window}`} label={`${q.runner} · ${windowLabel(q.window)}`} utilization={q.utilization} resetsAt={q.resetsAt} ts={q.ts} />
            ))}
            {(props.ledger?.quota ?? []).length === 0 && <span className="muted">枠の消費は最初のタスク実行後に表示されます</span>}
          </div>
          {props.ledger && props.ledger.topTasks.length > 0 && (
            <>
              <h5 style={{ marginTop: 14 }}>タスク別 · 今週</h5>
              {props.ledger.topTasks.map((t) => (
                <button key={t.taskId} className="row link" onClick={() => props.onOpenTask(t.taskId)}>
                  <span className="t">{t.title}</span>
                  <RunnerPill runner={t.runner} />
                  <span className="m num">
                    {fmtUsd(t.costUsd)} · {Math.round(t.tokens / 1000)}k トークン
                  </span>
                </button>
              ))}
            </>
          )}
          {latestReport && (
            <>
              <h5 style={{ marginTop: 14 }}>レポート</h5>
              <button className="row link" onClick={() => props.onOpenReport(latestReport.id)} title="Insights で開く">
                <span className="t">{latestReport.title}</span>
                <span className="m">{reportMeta(latestReport)}</span>
              </button>
            </>
          )}
        </section>
      </div>

      <section className="card">
        <div className="row head">
          <h5>Terminal の履歴（Claude Code）</h5>
          {history?.enabled && (
            <button className="ghost" disabled={importing} onClick={() => void importNow()} title={history.pollMs > 0 ? `~/.claude/projects を今すぐ走査する（普段は起動時と ${Math.round(history.pollMs / 1000)} 秒ごとに走る）` : "~/.claude/projects を今すぐ走査する（定期走査は無効: 起動時とこのボタンだけ）"}>
              {importing ? "取り込み中…" : "今すぐ取り込む"}
            </button>
          )}
        </div>
        {!history && !historyErr && <div className="muted">取り込み状況を読み込み中…</div>}
        {historyErr && <div className="hint warn">取り込み状況を取得できません: {historyErr}（15 秒ごとに再試行）</div>}
        {history && !history.enabled && (
          <div className="muted">
            <span className="mono">{history.dir}</span> がありません。Terminal で claude を使ったセッションがここに並びます。
          </div>
        )}
        {history?.enabled && (
          <div className="hint">
            Terminal で実行したセッション <b>{terminalSessions}</b> 件を Task として取り込み済み
            {history.lastScanAt ? ` · 最終走査 ${jstTime(history.lastScanAt)}` : ""}
            {history.pollMs > 0 ? ` · ${Math.round(history.pollMs / 1000)} 秒ごと` : " · 起動時と手動のみ"}
            {history.lastResult && history.lastResult.skippedForeign > 0 && <> · Workspace 外のセッション {history.lastResult.skippedForeign} 件は取り込まない（Workspace を追加すると次の走査で入る）</>}
            {history.lastResult && history.lastResult.errors.length > 0 && <span className="warn"> · エラー {history.lastResult.errors.length} 件（{history.lastResult.errors[0]}）</span>}
          </div>
        )}
        {importMsg && <div className="hint">{importMsg}</div>}
        <div className="hint">
          読み込み元: <span className="mono">{history?.dir ?? "~/.claude/projects"}</span>。取り込んだ Task には「Terminal」タグが付き、会話・差分・台帳は Switchboard から始めた Task と同じ見え方。Switchboard 自身が動かしたセッションは二重に入りません。
        </div>
      </section>
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
