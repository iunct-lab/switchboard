import { Fragment, useEffect, useRef, useState } from "react";
import type { Queue, RunnerId, RunnerInfo, Schedule, Workspace } from "@switchboard/protocol";
import { api } from "../api.ts";
import { fmtUsd, RunnerPill } from "./ui.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { effortLabel } from "../effortOptions.ts";
import { scheduleResultLine } from "../scheduleResult.ts";
import { SCHEDULE_ACTIONS, scheduleActionLabel } from "../scheduleActions.ts";
import { scheduleCreateInput, scheduleDraft, scheduleEditPatch, type ScheduleDraft } from "../scheduleEdit.ts";
import { jstDateTime } from "../time.ts";
import { listedRunners } from "../runners.ts";

/** Scheduler screen (#20): DAK-style nightly jobs, and the morning queue of what needs a person. */
export function Schedules(props: { workspaces: Workspace[]; runners: RunnerInfo[]; runnerOk: Set<RunnerId>; onOpenTask: (id: string) => void; onOpenSettings: () => void; onError: (msg: string) => void }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [cron, setCron] = useState("0 3 * * *");
  const savedCron = useRef("0 3 * * *");
  const [wsId, setWsId] = useState("");
  // A new schedule starts from 自動で始まる Task の既定 (設定, #832); empty model = the runner's CLI default
  const [runner, setRunner] = useState<RunnerId>("claude");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState(""); // #833, the same two levels as the model
  const [prompt, setPrompt] = useState("");
  const [action, setAction] = useState<Schedule["action"]>("prompt");
  const meta = props.workspaces.find((w) => w.kind === "meta");
  // backlog-next, secret-scan, insights and approval-window work on the meta workspace and take no prompt (#267, #775, #1838, #2046)
  const metaOnly = action !== "prompt";
  // insights runs Claude Code's own command: the runner is claude whatever the form shows elsewhere (#1838)
  const insights = action === "insights";
  const actionRef = useRef(action); // read when the saved defaults arrive: a kind chosen meanwhile must not be overwritten
  actionRef.current = action;
  const savedDefaults = useRef<{ runner: RunnerId; model: string; effort: string } | null>(null); // put back when the kind leaves insights
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  // The row being edited (#1480): its own state, apart from the create form's
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);

  const load = () => {
    api.schedules().then(setSchedules).catch((e) => props.onError(String(e.message ?? e)));
    api.queue().then(setQueue).catch(() => undefined);
    api.scheduleLog().then(setLog).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Creating waits for the saved defaults: a form created before they arrive would start from claude / the CLI default.
  // The runner and model are locked until then (no choice to overwrite); a failed read is shown and tried again when the form is reopened.
  const [defaultsReady, setDefaultsReady] = useState(false);
  useEffect(() => {
    if (defaultsReady || !showNew) return;
    api
      .settings()
      .then((st) => {
        // the defaults may land after the kind was chosen: insights keeps claude and the CLI defaults (#1838)
        const bare = actionRef.current === "insights";
        savedDefaults.current = { runner: st.autoStart.runner, model: st.autoStart.model, effort: st.autoStart.effort };
        setRunner(bare ? "claude" : st.autoStart.runner);
        setModel(bare ? "" : st.autoStart.model);
        setEffort(bare ? "" : st.autoStart.effort);
        savedCron.current = st.newDefaults.scheduleCron; // 新規作成の既定 (#835)
        setCron(st.newDefaults.scheduleCron);
        setDefaultsReady(true);
      })
      .catch((e) => props.onError(`自動で始まる Task の既定を読めませんでした: ${String(e.message ?? e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNew, defaultsReady]);
  // Every new schedule starts from the saved cron (#835), not from the one the last form was left with
  useEffect(() => {
    if (showNew && defaultsReady) setCron(savedCron.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNew]);
  useEffect(() => {
    if (!wsId && props.workspaces.length) setWsId(props.workspaces[0]!.id);
  }, [props.workspaces, wsId]);

  const create = async () => {
    if (!title.trim() || (metaOnly ? !meta : !wsId || !prompt.trim())) return;
    // A typo (e.g. "1o") makes Number(...) NaN; JSON silently turns NaN into null, which passes the server's
    // nullable() budget check as "no limit" instead of erroring — validate here so a typo can't produce an
    // unbounded-budget schedule with no feedback to the user.
    let budgetUsd: number | undefined;
    if (budget.trim()) {
      const n = Number(budget);
      if (!Number.isFinite(n) || n < 0) {
        props.onError(`予算は0以上の数値で入力してください: "${budget}"`);
        return;
      }
      budgetUsd = n;
    }
    setBusy(true);
    try {
      // backlog-next works on the meta workspace (the stage skills live in .claude/skills, #265), secret-scan and insights too
      await api.createSchedule(scheduleCreateInput({ title, cron, wsId, metaId: meta?.id, runner, model, effort, prompt, action, budgetUsd }));
      setTitle("");
      setPrompt("");
      setBudget("");
      setShowNew(false);
      load();
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (s: Schedule) => api.updateSchedule(s.id, { enabled: !s.enabled }).then(load).catch((e) => props.onError(String(e.message ?? e)));
  const save = async (s: Schedule) => {
    if (!draft) return;
    const r = scheduleEditPatch(s, draft);
    if ("error" in r) return props.onError(r.error);
    if (Object.keys(r.patch).length > 0) {
      setBusy(true);
      try {
        await api.updateSchedule(s.id, r.patch);
      } catch (e) {
        props.onError(String((e as Error).message ?? e)); // the form stays open with what was typed
        return;
      } finally {
        setBusy(false);
      }
    }
    setEditingId(null);
    setDraft(null);
    load();
  };
  const remove = (s: Schedule) => api.deleteSchedule(s.id).then(load).catch((e) => props.onError(String(e.message ?? e)));
  const runNow = (s: Schedule) =>
    api
      .runSchedule(s.id)
      .then((t) => {
        load();
        if ("id" in t) props.onOpenTask(t.id);
      })
      .catch((e) => {
        load(); // a skipped backlog-next firing says why in the log
        props.onError(String(e.message ?? e));
      });

  return (
    <main className="main schedules">
      <section className="card">
        <div className="row head">
          <h5>承認待ち・キュー（朝まとめて）</h5>
        </div>
        {queue && queue.waiting.length === 0 && queue.staged.length === 0 && <div className="muted">承認待ちはありません</div>}
        {queue?.waiting.map((w) => (
          <button key={w.taskId} className="row link" onClick={() => props.onOpenTask(w.taskId)}>
            <RunnerPill runner={w.runner} />
            <span className="t">{w.title}</span>
            <span className="m">{w.ask}</span>
          </button>
        ))}
        {queue?.staged.map((s) => (
          <button key={s.taskId} className="row link" onClick={() => props.onOpenTask(s.taskId)}>
            <span className="t">{s.title}</span>
            <span className="m">{s.pending} 件の未適用の書き込み</span>
          </button>
        ))}
        {queue && queue.scheduled.length > 0 && (
          <>
            <h5 style={{ marginTop: 14 }}>夜間の実行結果（36h）</h5>
            {queue.scheduled.map((s) => (
              <button key={s.taskId} className="row link" onClick={() => props.onOpenTask(s.taskId)}>
                <RunnerPill runner={s.runner} />
                <span className="t">{s.title}</span>
                <span className="hint">{s.scheduleTitle}</span>
                <span className="m num">
                  {s.status} · {fmtUsd(s.costUsd)}
                </span>
              </button>
            ))}
          </>
        )}
      </section>

      <section className="card">
        <div className="row head">
          <h5>定期タスク</h5>
          <button className="ghost" onClick={() => setShowNew((v) => !v)}>
            {showNew ? "やめる" : "+ 追加"}
          </button>
        </div>
        {showNew && (
          <div className="fields" style={{ marginBottom: 10 }}>
            <label>
              <span>種類</span>
              <select
                value={action}
                onChange={(e) => {
                  const next = e.target.value as Schedule["action"];
                  const was = action;
                  setAction(next);
                  if (next === "insights") {
                    setRunner("claude");
                    setModel("");
                    setEffort("");
                  } else if (was === "insights" && savedDefaults.current) {
                    // back to the saved defaults the form started from
                    setRunner(savedDefaults.current.runner);
                    setModel(savedDefaults.current.model);
                    setEffort(savedDefaults.current.effort);
                  }
                }}
              >
                {SCHEDULE_ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>タイトル</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              <span>cron（分 時 日 月 曜日、または @nightly など）</span>
              <input value={cron} onChange={(e) => setCron(e.target.value)} className="mono" />
            </label>
            <label>
              <span>Workspace</span>
              <select value={metaOnly ? (meta?.id ?? "") : wsId} disabled={metaOnly} onChange={(e) => setWsId(e.target.value)}>
                {props.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>ランナー</span>
              <select
                value={defaultsReady ? (insights ? "claude" : runner) : ""}
                disabled={!defaultsReady || insights}
                onChange={(e) => {
                  setRunner(e.target.value as RunnerId);
                  setModel(""); // a model belongs to one runner
                  setEffort(""); // so does an effort
                }}
              >
                {!defaultsReady && <option value="">読み込み中…</option>}
                {listedRunners(props.runners, runner).map((r) => (
                  <option key={r} value={r} disabled={!props.runnerOk.has(r)}>
                    {r}
                    {props.runnerOk.has(r) ? "" : "（未インストール）"}
                  </option>
                ))}
              </select>
            </label>
            <div className="row" style={{ alignItems: "center" }}>
              <ModelSelect runner={props.runners.find((r) => r.id === runner)} value={model} onChange={setModel} disabled={!defaultsReady} label="モデル" title="このスケジュールの Task を動かすモデル。「CLI 既定」はランナー自身の設定で動きます" />
              <EffortSelect runner={props.runners.find((r) => r.id === runner)} value={effort} onChange={setEffort} disabled={!defaultsReady} label="思考の深さ" title="このスケジュールの Task の思考の深さ。「CLI 既定」はランナー自身の設定で動きます" />
            </div>
            <label>
              <span>予算 USD（任意）</span>
              <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
            </label>
            {insights ? (
              <div className="muted" style={{ gridColumn: "1 / -1" }}>
                Claude Code の <code>/insights</code> を meta workspace で走らせ、できたレポート（最近のセッションの傾向・つまずき・改善案）を Insights の画面の「レポート」に載せます。ランナーは claude、prompt はありません。Claude の 7 日枠が設定の閾値（使用量と自動再開）以上のときは飛ばします。1 回の対象は 200 セッションまでなので、週 2 回が目安です。
              </div>
            ) : action === "secret-scan" ? (
              <div className="muted" style={{ gridColumn: "1 / -1" }}>
                登録したリポジトリを全部（同じリポジトリの作業フォルダは 1 回）、Issue・PR・コメント・レビューに認証に使える値が書かれていないか検査します。ランナーは使いません（ホストの gh のログインで読む）。当たりか検査できなかったリポジトリがあれば判断待ちに出します（場所と種類だけ）。スケジュールは meta に置きます。
              </div>
            ) : action === "backlog-next" ? (
              <>
                <div className="muted backlog-next-hint" style={{ gridColumn: "1 / -1" }}>
                  登録したリポジトリごとに、実装の枠（Ready → 実装）と計画の枠（分解待ち → 要望）に空きがあれば 1 件ずつ選んで始めます（枠の数は 設定 画面で変える。判断待ち・実行中の項目は飛ばす。Claude の使用量 80% 以上のときは全体で同時に 1 件まで）。スケジュールは meta に置きます。無人で始めた実装は、各 PR を merge-gate が通したときだけマージし、それ以外は判断待ちで止まります。
                </div>
                <button className="ghost" onClick={props.onOpenSettings} style={{ gridColumn: "1 / -1" }}>設定 を開く</button>
              </>
            ) : action === "prompt" ? (
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="毎回渡すプロンプト" style={{ gridColumn: "1 / -1" }} />
            ) : null}
            <button className="pri" disabled={busy || !defaultsReady || !title.trim() || (metaOnly ? !meta : !prompt.trim()) || (insights && !props.runnerOk.has("claude"))} title={insights && !props.runnerOk.has("claude") ? "claude がインストールされていません" : undefined} onClick={() => void create()} style={{ gridColumn: "1 / -1" }}>
              作成
            </button>
          </div>
        )}
        {schedules.length === 0 && !showNew && <div className="muted">定期タスクはまだありません</div>}
        {schedules.map((s) => (
          <Fragment key={s.id}>
          <div className="row" style={{ alignItems: "center" }}>
            <span className="t">
              {s.title}
              {!s.enabled && <span className="hint"> （停止中）</span>}
            </span>
            {s.action !== "prompt" && <span className="tag">{scheduleActionLabel(s.action)}</span>}
            <RunnerPill runner={s.runner} />
            <span className="hint">{s.model || "CLI 既定"}</span>
            <span className="hint">思考の深さ: {effortLabel(s.effort, props.runners.find((r) => r.id === s.runner))}</span>
            <span className="mono hint">{s.cron}</span>
            <span className="hint">{s.nextRunAt ? `次回 ${jstDateTime(s.nextRunAt)}` : "次回なし"}</span>
            {scheduleResultLine(s) && <span className="hint">{scheduleResultLine(s)}</span>}
            <button className="ghost" onClick={() => void runNow(s)}>
              今すぐ実行
            </button>
            <button className="ghost" onClick={() => void toggle(s)}>
              {s.enabled ? "停止" : "再開"}
            </button>
            <button
              className="ghost"
              disabled={busy} // a pending save would otherwise close the form opened meanwhile
              onClick={() => {
                setEditingId(s.id);
                setDraft(scheduleDraft(s));
              }}
            >
              編集
            </button>
            <button className="ghost" onClick={() => void remove(s)}>
              削除
            </button>
          </div>
          {editingId === s.id && draft && (
            <div className="fields schedule-edit" style={{ marginBottom: 10 }}>
              <div className="muted" style={{ gridColumn: "1 / -1" }}>
                種類: <span className="tag">{scheduleActionLabel(s.action)}</span>（変えられません。変えたいときは作り直す）。変更は次の発火から効きます
              </div>
              <label>
                <span>タイトル</span>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label>
                <span>cron（分 時 日 月 曜日、または @nightly など）</span>
                <input value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} className="mono" />
              </label>
              <label>
                <span>Workspace</span>
                <select value={draft.workspaceId} disabled={s.action !== "prompt"} onChange={(e) => setDraft({ ...draft, workspaceId: e.target.value })}>
                  {props.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>ランナー</span>
                <select value={draft.runner} disabled={s.action === "insights"} title={s.action === "insights" ? "Claude Code Insights は claude で動きます" : undefined} onChange={(e) => setDraft({ ...draft, runner: e.target.value as RunnerId, model: "", effort: "" })}>
                  {listedRunners(props.runners, s.runner).map((r) => (
                    <option key={r} value={r} disabled={!props.runnerOk.has(r) && r !== s.runner}>
                      {r}
                      {props.runnerOk.has(r) ? "" : "（未インストール）"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row" style={{ alignItems: "center" }}>
                <ModelSelect runner={props.runners.find((r) => r.id === draft.runner)} value={draft.model} onChange={(v) => setDraft({ ...draft, model: v })} label="モデル" title="このスケジュールの Task を動かすモデル。「CLI 既定」はランナー自身の設定で動きます" />
                <EffortSelect runner={props.runners.find((r) => r.id === draft.runner)} value={draft.effort} onChange={(v) => setDraft({ ...draft, effort: v })} label="思考の深さ" title="このスケジュールの Task の思考の深さ。「CLI 既定」はランナー自身の設定で動きます" />
              </div>
              <label>
                <span>予算 USD（空なら予算なし）</span>
                <input value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: e.target.value })} inputMode="decimal" />
              </label>
              {s.action === "prompt" && <textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} rows={3} placeholder="毎回渡すプロンプト" style={{ gridColumn: "1 / -1" }} />}
              <button className="pri" disabled={busy} onClick={() => void save(s)}>
                保存
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setEditingId(null);
                  setDraft(null);
                }}
              >
                やめる
              </button>
            </div>
          )}
          </Fragment>
        ))}
      </section>

      {log.length > 0 && (
        <section className="card">
          <h5>ログ</h5>
          <pre className="diff">{log.join("\n")}</pre>
        </section>
      )}
    </main>
  );
}
