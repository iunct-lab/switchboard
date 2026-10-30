import { useEffect, useState } from "react";
import type { AutoStartKind, Backlog, JudgeSettings, LlmRoutingSettings, ModelOption, Preset, RunnerId, RunnerInfo, Settings as SettingsData, SettingsPrice, Task, Workspace } from "@switchboard/protocol";
import { api, type Health, type SettingsResponse, type WorkspaceClone } from "../api.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { ClaudeLoginRow } from "./ClaudeLoginRow.tsx";
import { ReleasePanel } from "./ReleasePanel.tsx";
import { PolicySettings } from "./PolicySettings.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { notifyPermission } from "../notify.ts";
import { EMPTY_PRICE_FORM, parsePriceForm, priceFormOf, type PriceForm } from "../priceForm.ts";
import { addModel, moveModel, removeModel } from "../modelList.ts";
import { countriesUrl, logoutPath } from "../login.ts";
import { presetRow } from "../presets.ts";
import { listedRunners } from "../runners.ts";
import { githubSyncText } from "../backlogSync.ts";
import { WorkspaceCard } from "./WorkspaceCard.tsx";

/** The kinds of Task that start by themselves (#1337), in the order of the 既定 card: the feedback modes, then the backlog stages. */
const AUTO_START_KINDS: Array<[AutoStartKind, string]> = [["fix", "すぐ直す"], ["request", "要望として登録"], ["to-pbi", "PBI にする"], ["to-tasks", "Task に分解"], ["complete", "実装"], ["check", "状況確認"], ["close", "閉じる"], ["new-repo", "新しいリポジトリ"]];

/**
 * 設定 (#832): every default the daemon keeps in its settings, in one screen. Each control saves as soon as it
 * changes (a partial PATCH /api/settings), so a value takes effect on the next use. The per-Task choices (mode, model,
 * budget, shadow for one Task) stay on the Home form; what is saved here is only what they start from.
 */
export function Settings(props: { focusRelease?: number; health: Health | null; workspaces: Workspace[]; clones: WorkspaceClone[]; onAddWorkspaceFromGithub: (repo: string, backlog: "github" | "switchboard") => Promise<void>; onAddWorkspace: (path: string, backlog: "github" | "switchboard") => Promise<void>; onTaskStarted: (task: Task) => void; runnerOk: Set<RunnerId>; onRunners: (runners: RunnerInfo[]) => void; onError: (msg: string) => void }) {
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  // 端末通知 (#1138): the browser's permission is the only switch; asked for only from the button
  const [perm, setPerm] = useState(() => notifyPermission(typeof Notification === "undefined" ? undefined : Notification));
  const runners = props.health?.runners ?? [];
  const info = (id: RunnerId) => runners.find((r) => r.id === id);
  useEffect(() => {
    api.settings().then(setS).catch((e) => props.onError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Saves one partial patch; the answer carries the whole saved settings and the runner list with the effective defaults. True when it was saved. */
  const trySave = async (patch: Parameters<typeof api.updateSettings>[0]) => {
    setSaving(true);
    try {
      const r = await api.updateSettings(patch);
      setS(r);
      props.onRunners(r.runners);
      return true;
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async (patch: Parameters<typeof api.updateSettings>[0]) => {
    await trySave(patch);
  };
  // after a login or logout: the runners' status commands are asked again now (#2528)
  const refresh = () => api.health({ recheck: true }).then((h) => h.runners && props.onRunners(h.runners)).catch(() => undefined);
  // the header's 「新しい版 →」: the section exists only once the settings have loaded
  const loaded = s !== null;
  useEffect(() => {
    if (loaded && props.focusRelease) document.getElementById("release")?.scrollIntoView();
  }, [loaded, props.focusRelease]);
  if (!s) return <main className="main settings"><section className="card"><div className="muted">読み込み中…</div></section></main>;
  const dakOk = props.runnerOk.has("dak");
  const listed = listedRunners(props.health?.runners, s.shadowRunner === "dak" ? "dak" : undefined);
  const runnerOptions = (current: RunnerId, label: string) =>
    listedRunners(props.health?.runners, current).filter((r) => props.runnerOk.has(r) || r === current).map((r) => (
      <option key={r} value={r}>
        {label}: {r}
      </option>
    ));
  const llm: LlmRoutingSettings = s.routing.llm;
  const judge: JudgeSettings = s.judge;
  const { quotaAndResume: qr, judgeAndChoice: jc, newDefaults: nd } = s;
  const d = s.defaults;
  return (
    <main className="main settings">
      <WorkspaceCard workspaces={props.workspaces} clones={props.clones} onAddWorkspaceFromGithub={props.onAddWorkspaceFromGithub} onAddWorkspace={props.onAddWorkspace} onTaskStarted={props.onTaskStarted} onError={props.onError} />
      <section className="card">
        <h5>自動で始まる Task の既定</h5>
        <div className="muted">バックログの工程ボタン・フィードバックボタンで始まる Task と、定期実行の新規作成フォームの初期値のランナー・モデル・思考の深さです。モデル・思考の深さが「CLI 既定」ならランナー自身の設定で動きます。種類ごとに変えられます。変えていない種類は共通の値で始まります（バックログを進めるはスケジュールの値）。</div>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          {/* a runner change goes back to that runner's CLI default: a model and an effort belong to one runner (the daemon does the same) */}
          <select className="mode" value={s.autoStart.runner} disabled={saving} aria-label="自動で始まる Task のランナー" onChange={(e) => void save({ autoStart: { runner: e.target.value as RunnerId } })}>
            {runnerOptions(s.autoStart.runner, "ランナー")}
          </select>
          <ModelSelect runner={info(s.autoStart.runner)} value={s.autoStart.model} onChange={(m) => void save({ autoStart: { model: m } })} label="モデル" disabled={saving} title="自動で始まる Task を動かすモデル。「CLI 既定」はランナー自身の設定（かっこ内）で動きます" />
          <EffortSelect runner={info(s.autoStart.runner)} value={s.autoStart.effort} onChange={(effort) => void save({ autoStart: { effort } })} label="思考の深さ" disabled={saving} title="自動で始まる Task の思考の深さ。「CLI 既定」はランナー自身の設定で動きます" />
        </div>
        {/* one line per kind (#1337): a kind on 共通 is one word, so the card stays short; only a changed kind shows its selects */}
        {([["フィードバック", AUTO_START_KINDS.slice(0, 2)], ["バックログの工程", AUTO_START_KINDS.slice(2)]] as const).map(([heading, kinds]) => (
          <div key={heading} className="auto-start-kinds">
            <div className="hint">{heading}</div>
            {kinds.map(([kind, label]) => (
              <KindRow key={kind} kind={kind} label={label} auto={s.autoStart} info={info} runnerOptions={runnerOptions} disabled={saving} save={save} />
            ))}
          </div>
        ))}
        {/* 上限のときの代わり (#834): the order is replaced whole; × removes one, the select appends a detected one not in it yet */}
        <div className="auto-start-kinds">
          <div className="hint">上限のときの代わり</div>
          <div className="muted">既定のランナーが上限（使用率がこの値以上で、まだ戻っていない）のとき、工程ボタン・フィードバック・定期実行で始まる Task は順の次の使えるランナーで、CLI 既定のモデルで始まります。どれも上限なら既定のランナーで始めます。手で作る Task と実行中の Task は切り替えません。</div>
          <div className="row" style={{ alignItems: "center", gap: 6, justifyContent: "flex-start" }}>
            {s.autoStart.fallback.length === 0 && <span className="muted">なし（切り替えない）</span>}
            {s.autoStart.fallback.map((r, i) => (
              <span key={r}>
                {i + 1}. {r}{" "}
                <button className="ghost" disabled={saving} aria-label={`上限のときの代わりから ${r} を外す`} onClick={() => void save({ autoStart: { fallback: s.autoStart.fallback.filter((x) => x !== r) } })}>
                  ×
                </button>
              </span>
            ))}
            {listed.some((r) => props.runnerOk.has(r) && !s.autoStart.fallback.includes(r)) && (
              <select className="mode" value="" disabled={saving} aria-label="上限のときの代わりを追加" onChange={(e) => e.target.value && void save({ autoStart: { fallback: [...s.autoStart.fallback, e.target.value as RunnerId] } })}>
                <option value="">追加…</option>
                {listed.filter((r) => props.runnerOk.has(r) && !s.autoStart.fallback.includes(r)).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
          </div>
          <NumberField label="切り替える使用率" hint="既定のランナーの使用量のどれかの窓がこれ以上なら切り替えます（0.5〜1）" value={s.autoStart.fallbackAt} def={0.9} step={0.05} min={0.5} max={1} disabled={saving} onSave={(v) => save({ autoStart: { fallbackAt: v } })} />
        </div>
      </section>

      {/* The tunables (#835): one card per group, saved on blur / Enter; 既定に戻す puts the whole group back (PATCH null) */}
      <section className="card tunables">
        <h5>使用量と自動再開</h5>
        <div className="muted">運用中に変えたくなる値です。変えると次に使うときから効きます（デーモンの再起動は要りません）。</div>
        <NumberField label="バックログを進めるときの使用量の閾値" hint="工程 Task を始めるランナー（上限のときの代わりを通した後）の使用量がこれ以上なら、工程 Task は全体で 1 件まで（0〜1）" value={qr.backlogQuotaLimit} def={d.quotaAndResume.backlogQuotaLimit} step={0.05} disabled={saving} onSave={(v) => save({ quotaAndResume: { backlogQuotaLimit: v } })} />
        <NumberField label="自動再開: 再開時刻が分からないときの待ち" unit="分" scale={60_000} hint="止まるたびに倍になります" value={qr.retryDelayMs} def={d.quotaAndResume.retryDelayMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { retryDelayMs: v } })} />
        <NumberField label="自動再開: 待ちの上限" unit="分" scale={60_000} value={qr.retryMaxDelayMs} def={d.quotaAndResume.retryMaxDelayMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { retryMaxDelayMs: v } })} />
        <NumberField label="自動再開: 続けて止まったら諦める回数" unit="回" value={qr.maxLimitStops} def={d.quotaAndResume.maxLimitStops} disabled={saving} onSave={(v) => save({ quotaAndResume: { maxLimitStops: v } })} />
        <TextField label="自動再開: 再開するときに送る文" hint="頭に [Switchboard 自動再開] が付きます（自動再開の見分けに使うので外せません）" value={qr.resumePrompt} def={d.quotaAndResume.resumePrompt} multiline disabled={saving} onSave={(v) => save({ quotaAndResume: { resumePrompt: v } })} />
        <NumberField label="デーモン停止で止まった Task を再開する回数" unit="回" value={qr.maxStopResumes} def={d.quotaAndResume.maxStopResumes} disabled={saving} onSave={(v) => save({ quotaAndResume: { maxStopResumes: v } })} />
        <NumberField label="ランナー比較で記録が少ないとみなす件数" unit="件" hint="Ledger のランナーごとの表で、これ未満の行は比べない" value={qr.thinSample} def={d.quotaAndResume.thinSample} disabled={saving} onSave={(v) => save({ quotaAndResume: { thinSample: v } })} />
        <ResetButton disabled={saving} onClick={() => save({ quotaAndResume: null })} />
      </section>

      <section className="card tunables">
        <h5>判定と自動選択</h5>
        <div className="muted">判定のランナーが動かないときの代わりは、2 つの判定（ターン終了時の自動判定とルーブリック判定）の両方に使います。</div>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          <span className="hint">判定の代わり</span>
          {/* a model belongs to one runner: a runner change goes back to that runner's CLI default */}
          <select className="mode" value={jc.judgeFallbackRunner} disabled={saving} aria-label="判定の代わりのランナー" onChange={(e) => void save({ judgeAndChoice: { judgeFallbackRunner: e.target.value as RunnerId, judgeFallbackModel: "" } })}>
            {runnerOptions(jc.judgeFallbackRunner, "代わり")}
          </select>
          <ModelSelect runner={info(jc.judgeFallbackRunner)} value={jc.judgeFallbackModel} onChange={(m) => void save({ judgeAndChoice: { judgeFallbackModel: m } })} label="代わりのモデル" disabled={saving} title="判定の代わりの 1 ターンだけに使うモデルです" />
          <span className="muted">既定 {d.judgeAndChoice.judgeFallbackRunner} / {d.judgeAndChoice.judgeFallbackModel}</span>
        </div>
        <NumberField label="判定のタイムアウト" unit="秒" scale={1000} hint="ターン終了時の自動判定の 1 ターン" value={jc.judgeTimeoutMs} def={d.judgeAndChoice.judgeTimeoutMs} disabled={saving} onSave={(v) => save({ judgeAndChoice: { judgeTimeoutMs: v } })} />
        <NumberField label="Workspace の自動選択のタイムアウト" unit="秒" scale={1000} hint="Workspace を「自動」で作るとき、これを過ぎたら作らずに選び直してもらいます" value={jc.workspaceChoiceTimeoutMs} def={d.judgeAndChoice.workspaceChoiceTimeoutMs} disabled={saving} onSave={(v) => save({ judgeAndChoice: { workspaceChoiceTimeoutMs: v } })} />
        <ResetButton disabled={saving} onClick={() => save({ judgeAndChoice: null })} />
      </section>

      <section className="card tunables">
        <h5>新規作成の既定</h5>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          <span className="hint">Home の新規作成のランナー</span>
          <select className="mode" value={nd.taskRunner} disabled={saving} aria-label="Home の新規作成のランナー" onChange={(e) => void save({ newDefaults: { taskRunner: e.target.value as RunnerId } })}>
            {runnerOptions(nd.taskRunner, "ランナー")}
          </select>
          <span className="muted">既定 {d.newDefaults.taskRunner}</span>
        </div>
        <TextField label="定期実行の新規作成の cron" value={nd.scheduleCron} def={d.newDefaults.scheduleCron} mono disabled={saving} onSave={(v) => save({ newDefaults: { scheduleCron: v } })} />
        <ResetButton disabled={saving} onClick={() => save({ newDefaults: null })} />
      </section>

      <section className="card">
        <h5>モデルの選択肢</h5>
        <div className="muted">Home・Brief・自動で始まる Task のモデルの選択肢です。保存していないランナーは同梱の一覧です。</div>
        {/* dak has no list of its own; on Bedrock the list is the adapter's Bedrock one, not the saved one (#1400) */}
        {runners.filter((r) => r.models.length > 0 && r.loginKind !== "bedrock").map((r) => (
          <ModelChoices key={r.id} runner={r.id} list={r.models} saved={!!s.models[r.id]} disabled={saving} save={trySave} />
        ))}
      </section>

      <section className="card">
        <h5>承認モードの既定</h5>
        <div className="muted">新しい Task が承認モードを選ばずに作られたときのモード（Home で Task ごとに変えられます）。「確認を飛ばす」モードは既定にできません。</div>
        {runners.filter((r) => r.permissionModes.length > 0).map((r) => (
          <div key={r.id} className="row" style={{ alignItems: "center", gap: 6 }}>
            <span className="t">{r.id}</span>
            <select className="mode" value={r.defaultPermissionMode ?? ""} disabled={saving} aria-label={`${r.id} の承認モードの既定`} onChange={(e) => void save({ defaultPermissionMode: { [r.id]: e.target.value } })}>
              {r.permissionModes.filter((m) => !m.danger || m.value === r.defaultPermissionMode).map((m) => (
                <option key={m.value} value={m.value} title={m.description}>
                  承認: {m.label}
                </option>
              ))}
            </select>
            {s.defaultPermissionMode[r.id] && (
              <button className="ghost" disabled={saving} onClick={() => void save({ defaultPermissionMode: { [r.id]: null } })} title="保存した既定を消し、ランナー本来の既定（Terminal と同じ）に戻します">
                保存した既定を解除
              </button>
            )}
          </div>
        ))}
      </section>

      <PolicySettings onError={props.onError} />

      <section className="card">
        <h5>使用上限での自動再開</h5>
        <div className="muted">ランナーが 5 時間 / 7 日の使用上限で止まったとき、枠が戻った時点で同じセッションに「続きを」と送ります（Task ごとに Brief から取り消せます）。</div>
        {runners.filter((r) => r.id !== "dak").map((r) => (
          <div key={r.id} className="row" style={{ alignItems: "center", gap: 6 }}>
            <label className="hint toggle">
              <input type="checkbox" checked={!!r.autoResume} disabled={saving} onChange={(e) => void save({ autoResume: { [r.id]: e.target.checked } })} />
              {r.id}: 使用上限で止まったら自動再開
            </label>
            <ClaudeLoginRow runner={r} region={s.bedrock?.[r.id]?.region} onBedrock={(next) => void save({ bedrock: { [r.id]: next } })} onChanged={refresh} onError={props.onError} />
          </div>
        ))}
      </section>

      {(listed.includes("dak") || s.shadowRunner === "dak") && (
      <section className="card">
        <h5>並走（DAK）の既定</h5>
        <label className={`hint toggle ${!dakOk && s.shadowRunner !== "dak" ? "off" : ""}`} title={dakOk ? "同じ依頼を DAK（DAK に設定したモデル。ローカルモデルなら API 料金なし）でも同時に実行し、並走 Task として並べます" : "DAK の agent（http://127.0.0.1:8000、SWITCHBOARD_DAK_URL で変更）に到達できません"}>
          <input type="checkbox" checked={s.shadowRunner === "dak"} disabled={saving || (!dakOk && s.shadowRunner !== "dak")} onChange={(e) => void save({ shadowRunner: e.target.checked ? "dak" : null })} />
          新しい Task を DAK にも同時に流す
          {!dakOk && s.shadowRunner === "dak" && <span className="hint">（DAK 未検出のため今は並走しません）</span>}
        </label>
      </section>
      )}

      <section className="card">
        <h5>LLM 提案</h5>
        <div className="muted">Task を作るときに「どのランナー向きか」を 1 ターンだけ聞き、ルール表の推奨の横に並べます（提案のみ）。Workspace を「自動」にしたときに、どの Workspace かを選ぶのも同じランナー・モデルです。そのランナーの使用枠を使います。</div>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          <label className="hint toggle">
            <input type="checkbox" checked={llm.enabled} disabled={saving} onChange={(e) => void save({ routing: { llm: { enabled: e.target.checked } } })} />
            LLM にも提案させる
            {llm.enabled && props.health?.routing?.llm.available === false && <span className="warn">（{llm.runner} が未検出のため提案は出ません）</span>}
          </label>
          <select className="mode" value={llm.runner} disabled={saving} aria-label="LLM 提案のランナー" onChange={(e) => void save({ routing: { llm: { runner: e.target.value as RunnerId } } })}>
            {runnerOptions(llm.runner, "提案 / 自動選択")}
          </select>
          <ModelSelect runner={info(llm.runner)} value={llm.model} onChange={(m) => void save({ routing: { llm: { model: m } } })} label="提案のモデル" disabled={saving} title="提案と Workspace の自動選択の 1 ターンだけに使うモデルです（安いモデルで足ります）" />
          <select className="mode" value={llm.timeoutMs} disabled={saving} aria-label="LLM 提案の待ち時間" title="Task 作成がこの時間だけ提案を待ちます。間に合わなければルール表の推奨だけで作ります（claude の 1 ターンは実測 10 秒前後）" onChange={(e) => void save({ routing: { llm: { timeoutMs: Number(e.target.value) } } })}>
            {[5000, 10000, 15000, 30000].map((ms) => (
              <option key={ms} value={ms}>
                待ち時間: {ms / 1000} 秒
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="card">
        <h5>ターン終了時の自動判定</h5>
        <div className="muted">終わったターンの最後の返答を 1 ターンで読み、完了 / 要対応を付けます。ターンごとにそのランナーの使用枠を 1 回使います。動かないときは Claude Haiku で判定します。</div>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          <label className="hint toggle">
            <input type="checkbox" checked={judge.enabled} disabled={saving} onChange={(e) => void save({ judge: { enabled: e.target.checked } })} />
            ターン終了時の自動判定
          </label>
          {(judge.enabled || s.evals.judge.enabled) && (
            <>
              {!judge.enabled && <span className="hint">（下のルーブリック判定が使う）</span>}
              {/* a model belongs to one runner: the old one would make every judgement fail on the new runner first and fall back to Haiku. Shown while either judge (#493 / #1219) uses them */}
              <select className="mode" value={judge.runner} disabled={saving} aria-label="自動判定のランナー" onChange={(e) => void save({ judge: { runner: e.target.value as RunnerId, model: "" } })}>
                {runnerOptions(judge.runner, "判定")}
              </select>
              <ModelSelect runner={info(judge.runner)} value={judge.model} onChange={(m) => void save({ judge: { model: m } })} label="判定のモデル" disabled={saving} title="判定の 1 ターンだけに使うモデルです" />
            </>
          )}
        </div>
      </section>

      <section className="card">
        <h5>タスク名の自動付与</h5>
        <div className="muted">最初のターンの後に 1 回、短い名前を付けます。使用枠を 1 回使います。</div>
        <label className="hint toggle">
          <input type="checkbox" checked={s.titles.auto} disabled={saving} onChange={(e) => void save({ titles: { auto: e.target.checked } })} />
          最初のターンの後に名前を付ける
        </label>
      </section>

      <section className="card">
        <h5>ルーブリック判定</h5>
        <div className="muted">done で終わったターンのあと、会話の要約とルール指標をルーブリック（5 観点、1〜5 点）で採点します。ランナーとモデルは上の自動判定と同じで、ターンごとにその使用枠を 1 回使います（上の自動判定を切っていても、これが入っていれば動きます）。ルーブリックは SWITCHBOARD_HOME/evals/rubric.json で上書きできます（デーモンの起動時に 1 回読むので、直したら再起動）。</div>
        <label className="hint toggle">
          <input type="checkbox" checked={s.evals.judge.enabled} disabled={saving} onChange={(e) => void save({ evals: { judge: { enabled: e.target.checked } } })} />
          ターンの終わりにルーブリックで採点する（ランナー・モデルは自動判定と同じ）
        </label>
      </section>

      <section className="card">
        <h5>端末通知</h5>
        {perm === "default" && (
          <>
            <div className="muted">承認待ち（ツール承認・要対応）を OS の通知で知らせます。この画面を開いているときだけ届きます</div>
            <div className="row">
              <button className="pri" onClick={() => void Notification.requestPermission().then(setPerm)}>
                通知を許可する
              </button>
            </div>
          </>
        )}
        {perm === "granted" && <div className="muted">許可済み。承認待ちが来ると通知します</div>}
        {perm === "denied" && <div className="muted">ブラウザが拒否しています。サイトの設定で許可に変えると次の承認待ちから通知します。一覧とバッジはそのまま使えます</div>}
        {perm === "unsupported" && <div className="muted">このブラウザでは端末通知を使えません（一覧とバッジで確認できます）</div>}
      </section>

      <section className="card">
        <h5>モデルの価格</h5>
        <div className="muted">USD / 1M tokens。公式の価格ページの値を入れます。同梱の価格表の同じモデルより優先され、次の使用から台帳の換算に使われます（過去の行は変わりません）。</div>
        <ModelPrices prices={s.prices} disabled={saving} save={trySave} />
      </section>

      <section className="card" id="release">
        <h5>動いている版</h5>
        <ReleasePanel />
      </section>

      <section className="card">
        <h5>バックログを進める</h5>
        <SweepSlots onError={props.onError} />
      </section>

      <section className="card">
        <h5>GitHub 同期</h5>
        <GithubSync />
      </section>

      <section className="card presets">
        <h5>定型の指示</h5>
        <div className="muted">新規依頼と返信で選べる指示です。本文の {"{{target}}"} に選んだ Issue / PR が入ります。承認モードは含みません</div>
        <PresetSettings onError={props.onError} />
      </section>

      {countriesUrl(props.health?.login) && (
        <section className="card">
          <h5>海外から使う</h5>
          <div className="muted">出発前に、許可する国と期間を設定します。期間が過ぎると自動で元の国の制限に戻ります。保存にはパスキーの確認が要ります。</div>
          <a href={countriesUrl(props.health?.login)!}>国の一時許可を設定する</a>
        </section>
      )}
      {logoutPath(props.health?.login) && (
        <section className="card">
          <h5>ログイン</h5>
          <button onClick={() => void logout(logoutPath(props.health?.login)!, props.onError)}>ログアウト</button>
        </section>
      )}
    </main>
  );
}

/**
 * Each workspace's GitHub sync (#2266): its state and the button that turns it off or on — only by this press. One kept
 * here only names the Project it is to read (its stored variable to begin with). A press that failed says why and can be pressed again (it goes on from
 * where it stopped); while Issues are being made on GitHub the state is read again every few seconds.
 */
export function GithubSync() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [syncs, setSyncs] = useState<Backlog["syncs"]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [vars, setVars] = useState<Record<string, string>>({});
  const load = () =>
    Promise.all([api.workspaces(), api.backlog()])
      .then(([w, b]) => {
        setWorkspaces(w);
        setSyncs(b.syncs);
      })
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);
  const moving = syncs.some((x) => x.enabling);
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [moving]);
  const press = async (w: Workspace, to: "github" | "switchboard", local: boolean) => {
    setBusy(w.id);
    setErrors((e) => ({ ...e, [w.id]: "" }));
    try {
      await api.setWorkspaceBacklog(w.id, to, to === "github" && local ? (vars[w.id] ?? w.projectVar ?? "").trim() || null : undefined);
    } catch (e) {
      setErrors((x) => ({ ...x, [w.id]: String((e as Error).message ?? e) }));
    } finally {
      setBusy(null);
      void load();
    }
  };
  if (!workspaces) return null;
  return (
    <>
      {workspaces.map((w) => {
        const s = syncs.find((x) => x.workspaceId === w.id);
        if (!s) return null;
        const t = githubSyncText(s);
        // kept here only (#2265): its stored backlog is under its own id, and it reads no Project yet
        const local = s.backlog === "switchboard" && s.repository === w.id;
        const to = s.enabling || s.backlog === "switchboard" ? "github" : "switchboard";
        return (
          <div key={w.id} className="row github-sync" data-workspace={w.id} style={{ alignItems: "center", gap: 6 }}>
            <span>{w.name}</span>
            <span className="hint" data-sync={t.state}>
              {[t.label, ...t.parts].join(" · ")}
            </span>
            {local && <input aria-label={`${w.name} の Project の URL を持つリポジトリ変数`} placeholder="SWITCHBOARD_PROJECT_URL" value={vars[w.id] ?? w.projectVar ?? ""} onChange={(e) => setVars((v) => ({ ...v, [w.id]: e.target.value }))} />}
            <button className={to === "github" ? "pri" : "ghost"} disabled={busy !== null} onClick={() => void press(w, to, local)}>
              {s.enabling ? "続ける" : to === "github" ? "有効にする" : "無効にする"}
            </button>
            {errors[w.id] && <span className="warn">{errors[w.id]}</span>}
          </div>
        );
      })}
      <div className="hint">無効の間の編集は、有効にしたときに GitHub へ送ります。</div>
    </>
  );
}

async function logout(path: string, onError: (msg: string) => void) {
  try {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
    if (r.ok) location.assign("/_auth/");
    else onError(`ログアウトできませんでした (${r.status})`);
  } catch (e) {
    onError(`ログアウトできませんでした (${(e as Error).message ?? e})`);
  }
}

/** backlog-next's slots of each workspace (#561, #2656): what each firing reads, so a save applies from the next one. */
export function SweepSlots(props: { onError: (msg: string) => void }) {
  const [saved, setSaved] = useState<Workspace[] | null>(null);
  const [draft, setDraft] = useState<Record<string, { implement: string; plan: string }>>({});
  const [busy, setBusy] = useState(false);
  const show = (list: Workspace[]) => {
    setSaved(list);
    setDraft(Object.fromEntries(list.map((w) => [w.id, { implement: String(w.sweep.implement), plan: String(w.sweep.plan) }])));
  };
  useEffect(() => {
    api.workspaces().then(show).catch((e) => props.onError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = async () => {
    if (!saved) return;
    // an emptied box would be Number("") = 0, which switches the slot off: only a typed digit counts
    const bad = saved.find((w) => ![draft[w.id]!.implement, draft[w.id]!.plan].every((x) => /^\s*[0-3]\s*$/.test(x)));
    if (bad) {
      props.onError(`枠の数は 0〜3 の整数で入力してください: ${bad.name} 実装 "${draft[bad.id]!.implement}" / 計画 "${draft[bad.id]!.plan}"`);
      return;
    }
    setBusy(true);
    try {
      for (const w of saved) {
        const v = { implement: Number(draft[w.id]!.implement), plan: Number(draft[w.id]!.plan) };
        if (v.implement !== w.sweep.implement || v.plan !== w.sweep.plan) await api.setWorkspaceSweep(w.id, v);
      }
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      // what was saved, also when one of them failed
      await api.workspaces().then(show).catch(() => undefined);
      setBusy(false);
    }
  };
  const box = (w: Workspace, slot: "implement" | "plan", label: string) => (
    <>
      <span className="hint">{label}</span>
      <input
        type="number"
        min={0}
        max={3}
        step={1}
        aria-label={`${w.name} の${label}の枠`}
        value={draft[w.id]?.[slot] ?? ""}
        onChange={(e) => setDraft((d) => ({ ...d, [w.id]: { ...d[w.id]!, [slot]: e.target.value } }))}
        style={{ width: 56 }}
      />
    </>
  );
  return (
    <div className="backlog-sweep" style={{ gridColumn: "1 / -1" }}>
      {saved?.map((w) => (
        <div key={w.id} className="row" data-workspace={w.id} style={{ alignItems: "center", gap: 6 }}>
          <span className="t">{w.name}</span>
          {box(w, "implement", "実装")}
          {box(w, "plan", "計画")}
        </div>
      ))}
      <div className="row" style={{ alignItems: "center", gap: 6 }}>
        <button className="ghost" disabled={busy || !saved} onClick={() => void save()}>
          保存
        </button>
        <span className="hint">0 = 自動で進めない</span>
      </div>
    </div>
  );
}

/**
 * 定型の指示 (#940): the saved instructions, newest first, each edited or deleted in its row; a new one from the form
 * at the end. Kept by the daemon (/api/presets), so a reload shows the same list.
 */
export function PresetSettings(props: { onError: (msg: string) => void }) {
  const [list, setList] = useState<Preset[] | null>(null);
  const [edit, setEdit] = useState<{ id: string; name: string; text: string; error: string | null } | null>(null);
  const [draft, setDraft] = useState({ name: "", text: "", error: null as string | null });
  const [busy, setBusy] = useState(false);
  const { onError } = props;
  const load = () => api.presets().then((r) => setList(r.presets)).catch((e) => onError(`定型の指示を読めませんでした: ${String(e.message ?? e)}`));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (fn: () => Promise<unknown>, fail: (msg: string) => void) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      fail(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  // the answer closes or marks only the edit it was for: another row opened meanwhile keeps its typing (the saving row is read-only)
  const saveEdit = () => {
    if (!edit) return;
    const id = edit.id;
    void run(async () => { await api.updatePreset(id, { name: edit.name, text: edit.text }); setEdit((cur) => (cur?.id === id ? null : cur)); }, (error) => setEdit((cur) => (cur?.id === id ? { ...cur, error } : cur)));
  };
  const remove = (p: Preset) => confirm(`「${p.name}」を削除しますか`) && void run(() => api.deletePreset(p.id), (msg) => onError(`削除できませんでした: ${msg}`));
  // the form is read-only while it saves (below), so what is cleared is what was saved
  const add = () => void run(async () => { await api.createPreset({ name: draft.name, text: draft.text }); setDraft({ name: "", text: "", error: null }); }, (error) => setDraft((cur) => ({ ...cur, error })));
  return (
    <>
      {list && list.length === 0 && <div className="muted">保存した指示はありません</div>}
      {list?.map((p) => {
        const row = presetRow(p);
        const editing = edit?.id === p.id ? edit : null;
        return (
          <div key={p.id} className="policy-row preset-row" data-preset={p.id}>
            <div className="policy-main">
              <span className="t">{row.name}</span>
              <span className="hint">{row.head}</span>
              <span className="hint">{row.target}</span>
            </div>
            {editing ? (
              <div className="policy-edit">
                <input aria-label="名前" readOnly={busy} value={editing.name} onChange={(e) => setEdit({ ...editing, name: e.target.value })} />
                <textarea aria-label="本文" rows={4} readOnly={busy} value={editing.text} onChange={(e) => setEdit({ ...editing, text: e.target.value })} />
                {editing.error && <div className="hint warn">{editing.error}</div>}
                <div className="policy-actions">
                  <button className="pri" disabled={busy} onClick={saveEdit}>
                    保存
                  </button>
                  <button className="ghost" onClick={() => setEdit(null)}>
                    やめる
                  </button>
                </div>
              </div>
            ) : (
              <div className="policy-actions">
                <button className="ghost" onClick={() => setEdit({ id: p.id, name: p.name, text: p.text, error: null })}>
                  編集
                </button>
                <button className="ghost" disabled={busy} onClick={() => remove(p)}>
                  削除
                </button>
              </div>
            )}
          </div>
        );
      })}
      <div className="policy-edit preset-new">
        <input aria-label="新しい指示の名前" readOnly={busy} placeholder="名前（例: レビュー対応からマージまで）" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <textarea aria-label="新しい指示の本文" rows={4} readOnly={busy} placeholder="本文（例: PR {{target}} のレビュー指摘に対応してマージまで進めてください）" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        {draft.error && <div className="hint warn">{draft.error}</div>}
        <div className="policy-actions">
          <button className="pri" disabled={busy || !draft.name.trim() || !draft.text.trim()} onClick={add}>
            保存
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * One number of the tunables (#835), shown in its unit (`scale` ms per unit) and saved on blur / Enter. What is typed
 * stays local until then, so a half-typed value is never saved; a value the daemon refuses (400) is shown as an error
 * and the box goes back to the saved one.
 */
function NumberField(props: { label: string; unit?: string; scale?: number; step?: number; min?: number; max?: number; hint?: string; value: number; def: number; disabled: boolean; onSave: (v: number) => Promise<void> }) {
  const scale = props.scale ?? 1;
  const shown = (v: number) => String(v / scale);
  const [text, setText] = useState<string | null>(null);
  // reads the box itself, not `text`: a blur right after the last keystroke must not see the state before it
  const commit = (typed: string) => {
    setText(null);
    const n = Number(typed);
    const v = scale === 1 ? n : Math.round(n * scale);
    if (typed.trim() === "" || v === props.value) return;
    void props.onSave(v);
  };
  return (
    <label className="row" style={{ alignItems: "center", gap: 6 }} title={props.hint}>
      <span className="hint">{props.label}</span>
      <input type="number" step={props.step ?? 1} min={props.min} max={props.max} aria-label={props.label} value={text ?? shown(props.value)} disabled={props.disabled} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)} style={{ width: 88 }} />
      {props.unit && <span className="hint">{props.unit}</span>}
      <span className="muted">既定 {shown(props.def)}{props.unit ? ` ${props.unit}` : ""}</span>
    </label>
  );
}

/** One text of the tunables (#835), saved on blur (Enter too, for one line). */
function TextField(props: { label: string; hint?: string; value: string; def: string; multiline?: boolean; mono?: boolean; disabled: boolean; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const commit = (typed: string) => {
    setText(null);
    if (typed.trim() === props.value) return;
    void props.onSave(typed);
  };
  const common = { "aria-label": props.label, value: text ?? props.value, disabled: props.disabled, onBlur: (e: { currentTarget: { value: string } }) => commit(e.currentTarget.value), className: props.mono ? "mono" : undefined };
  return (
    <div className="row" style={{ alignItems: "center", gap: 6 }} title={props.hint}>
      <span className="hint">{props.label}</span>
      {props.multiline ? (
        <textarea rows={2} {...common} onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
      ) : (
        <input {...common} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)} style={{ width: 140 }} />
      )}
      <span className="muted">既定 {props.def}</span>
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

/** モデルの価格 (#1402): the saved rows with 直す / 消す, and a form under them; the daemon refuses a bad row with 400 too. */
/** One runner's model choices (#1400): every edit saves the whole list at once; the last one cannot be removed (null goes back instead). */
function ModelChoices(props: { runner: RunnerId; list: ModelOption[]; saved: boolean; disabled: boolean; save: (patch: { models: Record<string, ModelOption[] | null> }) => Promise<boolean> }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const put = (list: ModelOption[] | null) => props.save({ models: { [props.runner]: list } });
  const add = async () => {
    const next = addModel(props.list, id, label);
    if (typeof next === "string") return setWhy(next);
    setWhy(null);
    // a refused save (400, network) keeps what was typed
    if (await put(next)) {
      setId("");
      setLabel("");
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="t">{props.runner}</span>
      {props.list.map((m, i) => (
        <div key={m.value} className="row" style={{ alignItems: "center", justifyContent: "flex-start", gap: 6 }}>
          <span>
            {m.label}（<span className="mono">{m.value}</span>）
          </span>
          <button className="ghost" disabled={props.disabled || i === 0} onClick={() => void put(moveModel(props.list, m.value, -1))}>
            上へ
          </button>
          <button className="ghost" disabled={props.disabled || i === props.list.length - 1} onClick={() => void put(moveModel(props.list, m.value, 1))}>
            下へ
          </button>
          <button className="ghost" disabled={props.disabled || props.list.length === 1} onClick={() => void put(removeModel(props.list, m.value))}>
            外す
          </button>
        </div>
      ))}
      <div className="row" style={{ alignItems: "center", justifyContent: "flex-start", gap: 6, flexWrap: "wrap" }}>
        <input className="mono" aria-label={`${props.runner} に足すモデルの id`} placeholder="id" value={id} disabled={props.disabled} onChange={(e) => setId(e.target.value)} style={{ width: 200 }} />
        <input aria-label={`${props.runner} に足すモデルの表示名`} placeholder="表示名" value={label} disabled={props.disabled} onChange={(e) => setLabel(e.target.value)} style={{ width: 140 }} />
        <button className="btn" disabled={props.disabled} onClick={() => void add()}>
          足す
        </button>
        {props.saved && (
          <button className="ghost" disabled={props.disabled} onClick={() => void put(null)}>
            同梱の一覧に戻す
          </button>
        )}
      </div>
      {why && <div className="warn">{why}</div>}
    </div>
  );
}

function ModelPrices(props: { prices: Record<string, SettingsPrice>; disabled: boolean; save: (patch: { prices: Record<string, SettingsPrice | null> }) => Promise<boolean> }) {
  const [form, setForm] = useState<PriceForm>(EMPTY_PRICE_FORM);
  const [why, setWhy] = useState<string | null>(null);
  const submit = async () => {
    const parsed = parsePriceForm(form);
    if (typeof parsed === "string") return setWhy(parsed);
    setWhy(null);
    // a refused save (400, network) keeps what was typed
    if (await props.save({ prices: { [parsed.model]: parsed.price } })) setForm(EMPTY_PRICE_FORM);
  };
  const boxes: Array<[keyof PriceForm, string]> = [["input", "input"], ["output", "output"], ["cacheRead", "cache read"], ["cacheWrite", "cache write"], ["cacheWrite1h", "cache write 1h"]];
  const rows = Object.entries(props.prices);
  return (
    <>
      {rows.length > 0 && (
        <table className="pricing">
          <thead>
            <tr>
              <th>モデル</th>
              {boxes.map(([k, label]) => (
                <th key={k}>{label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(([m, p]) => (
              <tr key={m}>
                <td className="mono">{m}</td>
                <td className="num">${p.input}</td>
                <td className="num">${p.output}</td>
                <td className="num">${p.cacheRead}</td>
                <td className="num">${p.cacheWrite}</td>
                <td className="num">{p.cacheWrite1h === undefined ? "—" : `$${p.cacheWrite1h}`}</td>
                <td>
                  <button className="ghost" disabled={props.disabled} onClick={() => setForm(priceFormOf(m, p))}>
                    直す
                  </button>
                  <button className="ghost" disabled={props.disabled} onClick={() => void props.save({ prices: { [m]: null } })}>
                    消す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <input className="mono" aria-label="モデル名" placeholder="モデル名" value={form.model} disabled={props.disabled} onChange={(e) => setForm({ ...form, model: e.target.value })} style={{ width: 200 }} />
        {boxes.map(([k, label]) => (
          <input key={k} type="number" min={0} step="any" aria-label={label} placeholder={label} value={form[k]} disabled={props.disabled} onChange={(e) => setForm({ ...form, [k]: e.target.value })} style={{ width: 112 }} />
        ))}
        <button className="btn" disabled={props.disabled} onClick={() => void submit()}>
          保存
        </button>
      </div>
      {why && <div className="warn">{why}</div>}
      <div className="hint">cache read / cache write は空なら 0、cache write 1h は空なら cache write の値で換算します。</div>
    </>
  );
}

/**
 * One kind of the 自動で始まる Task の既定 (#1337). Without its own choice it reads 共通; 変える opens the selects
 * (opening saves nothing) starting from the common values, and the first change saves the kind's own choice.
 * 共通に戻す removes it (PATCH null).
 */
function KindRow(props: {
  kind: AutoStartKind;
  label: string;
  auto: SettingsData["autoStart"];
  info: (id: RunnerId) => RunnerInfo | undefined;
  runnerOptions: (current: RunnerId, label: string) => React.ReactNode;
  disabled: boolean;
  save: (patch: Parameters<typeof api.updateSettings>[0]) => Promise<void>;
}) {
  const own = props.auto.byKind[props.kind];
  const [open, setOpen] = useState(false);
  const name = <span style={{ minWidth: "8em" }}>{props.label}</span>;
  if (!own && !open)
    return (
      <div className="row" style={{ alignItems: "center", gap: 6, justifyContent: "flex-start" }}>
        {name}
        <span className="muted">共通</span>
        <button className="ghost" disabled={props.disabled} onClick={() => setOpen(true)} title="この種類だけ別のランナー・モデル・思考の深さにします">
          変える
        </button>
      </div>
    );
  const c = own ?? props.auto;
  const pick = (choice: { runner?: RunnerId; model?: string; effort?: string } | null) => props.save({ autoStart: { byKind: { [props.kind]: choice } } });
  return (
    <div className="row" style={{ alignItems: "center", gap: 6, justifyContent: "flex-start" }}>
      {name}
      {/* a runner change goes back to that runner's CLI default, as for the common values */}
      <select className="mode" value={c.runner} disabled={props.disabled} aria-label={`${props.label} のランナー`} onChange={(e) => void pick({ runner: e.target.value as RunnerId })}>
        {props.runnerOptions(c.runner, "ランナー")}
      </select>
      <ModelSelect runner={props.info(c.runner)} value={c.model} onChange={(model) => void pick({ model })} label="モデル" disabled={props.disabled} title={`${props.label}の Task を動かすモデル`} />
      <EffortSelect runner={props.info(c.runner)} value={c.effort} onChange={(effort) => void pick({ effort })} label="思考の深さ" disabled={props.disabled} title={`${props.label}の Task の思考の深さ`} />
      <button className="ghost" disabled={props.disabled} onClick={() => void pick(null).then(() => setOpen(false))} title="この種類の値を消し、共通の値で始まるようにします">
        共通に戻す
      </button>
    </div>
  );
}

function ResetButton(props: { disabled: boolean; onClick: () => Promise<void> }) {
  return (
    <div className="row">
      <button className="ghost" disabled={props.disabled} onClick={() => void props.onClick()} title="この節の値をすべて既定に戻します">
        既定に戻す
      </button>
    </div>
  );
}
