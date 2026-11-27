import { Fragment, useEffect, useState, type ReactNode } from "react";
import { lang, setLang, t, type Lang, type Msg } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";
import type { CustomRunner, AutoStartKind, Backlog, BacklogAllocation, HistoryStatus, JudgeSettings, LlmRoutingSettings, ModelCandidates, ModelOption, Preset, RunnerId, RunnerInfo, Settings as SettingsData, SettingsPrice, Task, TaskSummary, Workspace, WorkspaceMode } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { type Health } from "../api/daemon.ts";
import { type SettingsResponse } from "../api/settings.ts";
import { type WorkspaceClone } from "../api/workspaces.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { optionText, taskModelOptions } from "../modelOptions.ts";
import { AutoDirectToggle, DevelopSelfToggle } from "./SettingsToggles.tsx";
import { LoginSettings } from "./LoginSettings.tsx";
import { ReleasePanel } from "./ReleasePanel.tsx";
import { ReleaseAutoFields } from "./ReleaseAutoFields.tsx";
import { PolicySettings } from "./PolicySettings.tsx";
import { CliUpdateSettings } from "./CliUpdateSettings.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { isReviewRow, ReviewJobCells } from "./ReviewJobCells.tsx";
import { notifyPermission } from "../notify.ts";
import { EMPTY_PRICE_FORM, parsePriceForm, priceFormOf, type PriceForm } from "../priceForm.ts";
import { addModel, hideModel, moveModel, removeModel, unhideModel } from "../modelList.ts";
import { countriesUrl } from "../login.ts";
import { forgetPresets, presetRow } from "../presets.ts";
import { aguiNotices, customRunnerFromDraft, PORT_LABEL, isAdkRunner, listedRunners, sendsOffHost, shadowCandidates, type CustomRunnerDraft } from "../runners.ts";
import { githubSyncText, issueArtifactsShown } from "../backlogSync.ts";
import { Knowledge } from "./Knowledge.tsx";
import { ShadowDefaultCard } from "./ShadowDefaultCard.tsx";
import { WorkspaceCard } from "./WorkspaceCard.tsx";
import { jstTime } from "../time.ts";
import { SETTINGS_GROUPS, settingsGroup } from "../settingsGroups.ts";
import { RESETTABLE_CARDS, resetCard, type ResettableCard } from "../settingsDefaults.ts";
import { AUTO_START_KINDS, jobPatchOf, jobRows, runnerDefaultLabel, candidatesOf, kindChoice, kindPick, modelsRowView, resetPatch, runnerRows, type JobRowId } from "../runnerSettings.ts";
import { allocationCells, parseShare, saveOrder, shareText } from "../allocation.ts";
import { flowLimitRows, flowNumbers } from "../flowLimit.ts";

const groupTitle = (id: string) => t(settingsGroup(id).title);

/**
 * 設定: every default the daemon keeps in its settings, in one screen. Each control saves as soon as it
 * changes (a partial PATCH /api/settings), so a value takes effect on the next use. The per-Task choices (mode, model,
 * budget, shadow for one Task) stay on the Home form; what is saved here is only what they start from.
 */
export function Settings(props: { tasks: TaskSummary[]; focus?: { id: string; n: number } | null; health: Health | null; workspaces: Workspace[]; clones: WorkspaceClone[]; onAddWorkspaceFromGithub: (repo: string, backlog: "github" | "switchboard", ownCopy: boolean, ownCopyOwner: string) => Promise<void>; onAddWorkspace: (path: string, backlog: "github" | "switchboard") => Promise<void>; onTaskStarted: (task: Task) => void; knowledgeRev: number; runnerOk: Set<RunnerId>; onRunners: (runners: RunnerInfo[]) => void; onError: (msg: string) => void }) {
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  // 端末通知: the browser's permission is the only switch; asked for only from the button
  const [perm, setPerm] = useState(() => notifyPermission(typeof Notification === "undefined" ? undefined : Notification));
  const runners = props.health?.runners ?? [];
  const info = (id: RunnerId) => runners.find((r) => r.id === id);
  /** The detected runners a review job runs on (claude, codex): each gets a 「レビューで使うモデル」 row. */
  const reviewers = runners.filter((r) => r.available && (r.id === "claude" || r.id === "codex")).map((r) => r.id);
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
  // after a login or logout: the runners' status commands are asked again now
  const refresh = () => api.health({ recheck: true }).then((h) => h.runners && props.onRunners(h.runners)).catch(() => undefined);
  // the header's 「新しい版 →」 and Home's 「設定で追加 →」: the section exists only once the settings have loaded
  const loaded = s !== null;
  useEffect(() => {
    if (!loaded || !props.focus) return;
    const el = document.getElementById(props.focus.id);
    // the cards are folded: open the one the link points at before showing it
    const folded = el?.closest("details");
    if (folded) folded.open = true;
    el?.scrollIntoView();
  }, [loaded, props.focus]);
  if (!s) return <main className="main settings"><section className="card"><div className="muted">{t(settings.loading)}</div></section></main>;
  const listed = listedRunners(props.health?.runners, s.shadowRunner ?? undefined);
  const runnerOptions = (current: RunnerId, label: string) =>
    listedRunners(props.health?.runners, current).filter((r) => props.runnerOk.has(r) || r === current).map((r) => (
      <option key={r} value={r}>
        {optionText(label, r)}
      </option>
    ));
  const llm: LlmRoutingSettings = s.routing.llm;
  const judge: JudgeSettings = s.judge;
  const { quotaAndResume: qr, judgeAndChoice: jc, newDefaults: nd } = s;
  const d = s.defaults;
  /** One job row's runner / model / effort, as the PATCH of the place that keeps it; a runner change puts the model and effort back to the runner's default (the daemon does that). */
  const jobPatch = (id: JobRowId, p: { runner?: RunnerId; model?: string; effort?: string }) => save(jobPatchOf(id, p));
  /** A card's 既定に戻す: the same button on every card that holds a value with a default, sending what RESETTABLE_CARDS names for it. */
  const reset = Object.fromEntries((Object.keys(RESETTABLE_CARDS) as ResettableCard[]).map((card) => [card, <ResetButton key={card} disabled={saving} onClick={() => save(resetCard(card, d))} />])) as Record<ResettableCard, ReactNode>;
  return (
    <main className="main settings">
      <SettingsToc />
      <SettingsGroupHeading id="settings-login" />
      <section className="card">
        <h5>{t(settings.login)}</h5>
        <LoginSettings health={props.health} tasks={props.tasks} bedrock={s.bedrock} onBedrock={(runner, next) => void save({ bedrock: { [runner]: next } })} onChanged={refresh} onError={props.onError} />
      </section>

      <SettingsGroupHeading id="settings-runner" />
      {/* the runner values: one block per runner, the same rows in the same order (runnerRows); the approval mode is a safety setting, so the card is not folded and the block's title keeps the current value when the block is folded */}
      <section className="card">
        <h5>{t(settings.runnerDefaults)}</h5>
        <div className="muted">{t(settings.runnerDefaultsHint)}</div>
        {runners.map((r) => {
          const mode = r.permissionModes.find((m) => m.value === r.defaultPermissionMode);
          return (
            <details key={r.id} className="runner-block" open>
              <summary>
                <b>{t(settings.runnerDefaultOf, { runner: r.id })}</b>{" "}
                <span className="muted">— {r.permissionModes.length > 0 ? t(settings.runnerApprovalNow, { mode: mode?.label ?? r.defaultPermissionMode ?? "—" }) : t(settings.runnerApprovalUnset)}</span>
              </summary>
              {runnerRows(r).map((row) =>
                // the row is never dropped (modelsRowView): a list the runner cannot edit says so; on Bedrock the list edited is the original-id one (listModels)
                row.key === "models" && modelsRowView(r).folded ? (
                  <details key={row.key} className="runner-models">
                    <summary>{t(row.label)}</summary>
                    {modelsRowView(r).list ? <><ModelChoices runner={r.id} list={r.listModels ?? r.models} saved={!!s.models[r.id]} disabled={saving} save={trySave} />{r.loginKind === "bedrock" && <div className="muted">{t(settings.bedrockModelsHint)}</div>}</> : <div className="muted">{t(settings.notChangeable)}</div>}
                    {modelsRowView(r).candidates && <CliModelCandidates runners={[r]} hidden={(runner) => s.hiddenModels[runner] ?? s.defaults.hiddenModels[runner] ?? []} disabled={saving} save={trySave} onError={props.onError} />}
                  </details>
                ) : (
                  <div key={row.key} className="runner-row">
                    <span className="runner-row-name">{t(row.label)}</span>
                    <div className="runner-row-control">
                      {!row.editable ? (
                        <span className="muted">{t(settings.notChangeable)}</span>
                      ) : row.key === "model" ? (
                        <ModelSelect runner={r} value={s.defaultModel[r.id] ?? ""} onChange={(m) => void save({ defaultModel: { [r.id]: m || null } })} label={t(settings.rowModel)} bare disabled={saving} />
                      ) : row.key === "effort" ? (
                        <EffortSelect runner={r} value={s.defaultEffort[r.id] ?? ""} onChange={(e) => void save({ defaultEffort: { [r.id]: e || null } })} label={t(settings.rowEffort)} bare disabled={saving} />
                      ) : row.key === "permissionMode" ? (
                        <>
                          <select className="mode" value={r.defaultPermissionMode ?? ""} disabled={saving} aria-label={t(settings.approvalDefaultLabel, { runner: r.id })} onChange={(e) => void save({ defaultPermissionMode: { [r.id]: e.target.value } })}>
                            {r.permissionModes.filter((m) => !m.danger || m.value === r.defaultPermissionMode).map((m) => (
                              <option key={m.value} value={m.value} title={m.description}>
                                {t(settings.approvalOption, { label: m.label })}
                              </option>
                            ))}
                          </select>
                          {s.defaultPermissionMode[r.id] && (
                            <button className="ghost" disabled={saving} onClick={() => void save({ defaultPermissionMode: { [r.id]: null } })} title={t(settings.clearSavedDefaultTitle)}>
                              {t(settings.clearSavedDefault)}
                            </button>
                          )}
                        </>
                      ) : row.key === "subagentModel" ? (
                        <ModelSelect runner={r} value={s.subagentModel[r.id] ?? ""} onChange={(m) => void save({ subagentModel: { [r.id]: m || null } })} label={t(settings.rowSubagentModel)} emptyLabel={t(settings.subagentModelSame)} bare disabled={saving} />
                      ) : row.key === "subagentEffort" ? (
                        <EffortSelect runner={r} value={s.subagentEffort[r.id] ?? ""} onChange={(e) => void save({ subagentEffort: { [r.id]: e || null } })} label={t(settings.rowSubagentEffort)} emptyLabel={t(settings.subagentEffortSame)} bare disabled={saving} />
                      ) : (
                        <label className="hint toggle" title={t(settings.autoResumeHint)}>
                          <input type="checkbox" checked={!!r.autoResume} disabled={saving} onChange={(e) => void save({ autoResume: { [r.id]: e.target.checked } })} />
                          {t(settings.autoResumeOn)}
                        </label>
                      )}
                    </div>
                  </div>
                ),
              )}
              <ResetButton
                disabled={saving}
                onClick={() => save(resetPatch({ runner: r.id }))}
              />
            </details>
          );
        })}
      </section>
      <SettingsCard title={t(settings.jobsCard)} className="jobs">
        <div className="muted">{t(settings.jobsHint)}</div>
        <div className="muted">{t(settings.autoStartHint)}</div>
        {jobRows(s, reviewers).filter((j) => !j.id.startsWith("kind:")).map((j) => (
          <Fragment key={j.id}>
            <div className="job-row">
              <span className="job-name">
                {t(j.label, { runner: j.runner })}
                {j.id === "judge" && !judge.enabled && s.evals.judge.enabled && <span className="hint"> {t(settings.usedByRubric)}</span>}
                <span className="muted" style={{ display: "block" }}>{j.id.startsWith("reviewModel:") ? t(settings.jobReviewModelScope) : !isReviewRow(j) && t(settings.defaultValue, { value: jobRows(d, reviewers).find((r) => r.id === j.id)?.runner ?? "" })}</span>
              </span>
              {isReviewRow(j) ? (
                <ReviewJobCells row={j} s={s} d={d} info={info} saving={saving} save={save} />
              ) : (
                <>
                  <select className="mode" value={j.runner} disabled={saving} aria-label={`${t(j.label)}: ${t(settings.runner)}`} onChange={(e) => void jobPatch(j.id, { runner: e.target.value as RunnerId })}>
                    {runnerOptions(j.runner as RunnerId, "")}
                  </select>
                  <ModelSelect runner={info(j.runner as RunnerId)} value={j.model} onChange={(model) => void jobPatch(j.id, { model })} label={t(settings.rowModel)} bare emptyLabel={runnerDefaultLabel("model", info(j.runner as RunnerId))} disabled={saving} title={`${t(j.label)}: ${t(settings.rowModel)}`} />
                  <EffortSelect runner={info(j.runner as RunnerId)} value={j.effort} onChange={(effort) => void jobPatch(j.id, { effort })} label={t(settings.rowEffort)} bare emptyLabel={runnerDefaultLabel("effort", info(j.runner as RunnerId))} disabled={saving} title={`${t(j.label)}: ${t(settings.rowEffort)}`} />
                </>
              )}
            </div>
            {/* one line per kind: a kind on 共通 is one word, so the card stays short; only a changed kind shows its selects */}
            {j.id === "autoStart" &&
              ([[t(settings.feedback), AUTO_START_KINDS.slice(0, 2)], [t(settings.backlogStages), AUTO_START_KINDS.slice(2)]] as const).map(([heading, kinds]) => (
                <div key={heading} className="auto-start-kinds">
                  <div className="hint">{heading}</div>
                  {kinds.map(([kind, label]) => (
                    <KindRow key={kind} kind={kind} label={t(label)} auto={s.autoStart} info={info} runnerOptions={runnerOptions} listed={listed} runnerOk={props.runnerOk} defaultBudget={qr.defaultBudgetUsd} disabled={saving} save={save} />
                  ))}
                </div>
              ))}
          </Fragment>
        ))}
        {/* 上限のときの代わり: the order is replaced whole; × removes one, the select appends a detected one not in it yet */}
        <div className="auto-start-kinds">
          <div className="hint">{t(settings.fallback)}</div>
          <div className="muted">{t(settings.fallbackHint)}</div>
          <div className="row" style={{ alignItems: "center", gap: 6, justifyContent: "flex-start" }}>
            {s.autoStart.fallback.length === 0 && <span className="muted">{t(settings.fallbackNone)}</span>}
            {s.autoStart.fallback.map((r, i) => (
              <span key={r}>
                {i + 1}. {r}{" "}
                <button className="ghost" disabled={saving} aria-label={t(settings.fallbackRemove, { runner: r })} onClick={() => void save({ autoStart: { fallback: s.autoStart.fallback.filter((x) => x !== r) } })}>
                  ×
                </button>
              </span>
            ))}
            {listed.some((r) => props.runnerOk.has(r) && !s.autoStart.fallback.includes(r)) && (
              <select className="mode" value="" disabled={saving} aria-label={t(settings.fallbackAdd)} onChange={(e) => e.target.value && void save({ autoStart: { fallback: [...s.autoStart.fallback, e.target.value as RunnerId] } })}>
                <option value="">{t(settings.addOption)}</option>
                {listed.filter((r) => props.runnerOk.has(r) && !s.autoStart.fallback.includes(r)).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
          </div>
          <NumberField label={t(settings.fallbackAt)} hint={t(settings.fallbackAtHint)} value={s.autoStart.fallbackAt} def={d.autoStart.fallbackAt} step={0.05} min={0.5} max={1} disabled={saving} onSave={(v) => save({ autoStart: { fallbackAt: v } })} />
        </div>
        {reset.jobsCard}
      </SettingsCard>
      <CustomRunnersSection onError={props.onError} />

      <SettingsCard title={t(settings.shadowDefault)}>
        <ShadowDefaultCard value={s.shadowRunner} listed={listed} runnerOk={props.runnerOk} disabled={saving} onChange={(runner) => void save({ shadowRunner: runner })} note={<DefaultNote on={d.shadowRunner !== null} />} reset={reset.shadowDefault} />
      </SettingsCard>
      <CliUpdateSettings value={s.cliUpdate} def={d.cliUpdate} disabled={saving} Field={NumberField} onSave={(v) => save({ cliUpdate: v })} onError={props.onError} />

      <SettingsGroupHeading id="settings-auto" />
      <SettingsCard title={t(settings.developSelfCard)}>
        <DevelopSelfToggle checked={s.developSelf} disabled={saving} onChange={(on) => void save({ developSelf: on })} />
        <DefaultNote on={d.developSelf} />
        {reset.developSelfCard}
      </SettingsCard>

      <SettingsCard title={t(settings.sweep)} className="tunables">
        <SweepSlots onError={props.onError} flowLimit={qr.flowShareLimit} defaultFlowLimit={d.quotaAndResume.flowShareLimit} onSettings={setS} />
        {/* the limit of Tasks running at once: over it a Task waits for a run slot; the daemon starts the waiting ones as soon as it is raised */}
        <NumberField label={t(settings.maxRunnersLabel)} hint={t(settings.maxRunnersHint)} value={s.maxRunners} def={d.maxRunners} min={1} max={8} disabled={saving} onSave={(v) => save({ maxRunners: v })} />
        <div className="muted">{t(settings.maxRunnersHint)}</div>
        <AutoDirectToggle checked={s.autoDirect} disabled={saving} onChange={(on) => void save({ autoDirect: on })} />
        <DefaultNote on={d.autoDirect} />
        {reset.sweep}
      </SettingsCard>
      {/* the tunables: saved on blur / Enter; 既定に戻す puts back the values this card shows (RESETTABLE_CARDS) */}
      <SettingsCard title={t(settings.usage)} className="tunables">
        <div className="hint">{t(settings.usageWait)}</div>
        <div className="muted">{t(settings.usageHint)}</div>
        <NumberField label={t(settings.backlogQuotaLimit)} hint={t(settings.backlogQuotaLimitHint)} value={qr.backlogQuotaLimit} def={d.quotaAndResume.backlogQuotaLimit} step={0.05} disabled={saving} onSave={(v) => save({ quotaAndResume: { backlogQuotaLimit: v } })} />
        <NumberField label={t(settings.retryDelay)} unit={t(settings.unitMinutes)} scale={60_000} hint={t(settings.retryDelayHint)} value={qr.retryDelayMs} def={d.quotaAndResume.retryDelayMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { retryDelayMs: v } })} />
        <NumberField label={t(settings.retryMaxDelay)} unit={t(settings.unitMinutes)} scale={60_000} value={qr.retryMaxDelayMs} def={d.quotaAndResume.retryMaxDelayMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { retryMaxDelayMs: v } })} />
        <NumberField label={t(settings.maxLimitStops)} unit={t(settings.unitTimes)} value={qr.maxLimitStops} def={d.quotaAndResume.maxLimitStops} disabled={saving} onSave={(v) => save({ quotaAndResume: { maxLimitStops: v } })} />
        <TextField label={t(settings.resumePrompt)} hint={t(settings.resumePromptHint)} value={qr.resumePrompt} def={d.quotaAndResume.resumePrompt} multiline disabled={saving} onSave={(v) => save({ quotaAndResume: { resumePrompt: v } })} />
        <NumberField label={t(settings.maxStopResumes)} unit={t(settings.unitTimes)} value={qr.maxStopResumes} def={d.quotaAndResume.maxStopResumes} disabled={saving} onSave={(v) => save({ quotaAndResume: { maxStopResumes: v } })} />
        <NumberField label={t(settings.silentAfter)} unit={t(settings.unitMinutes)} scale={60_000} hint={t(settings.silentAfterHint)} value={qr.silentAfterMs} def={d.quotaAndResume.silentAfterMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { silentAfterMs: v } })} />
        <NumberField label={t(settings.waitLimit)} unit={t(settings.unitMinutes)} scale={60_000} hint={t(settings.waitLimitHint)} value={qr.waitLimitMs} def={d.quotaAndResume.waitLimitMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { waitLimitMs: v } })} />
        <NumberField label={t(settings.queueStall)} unit={t(settings.unitMinutes)} scale={60_000} min={1} max={1440} hint={t(settings.queueStallHint)} value={qr.queueStallMs} def={d.quotaAndResume.queueStallMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { queueStallMs: v } })} />
        <NumberField label={t(settings.dependsLimit)} unit={t(settings.unitMinutes)} scale={60_000} hint={t(settings.dependsLimitHint)} value={qr.dependsLimitMs} def={d.quotaAndResume.dependsLimitMs} disabled={saving} onSave={(v) => save({ quotaAndResume: { dependsLimitMs: v } })} />
        <NumberField label={t(settings.thinSample)} unit={t(settings.unitItems)} hint={t(settings.thinSampleHint)} value={qr.thinSample} def={d.quotaAndResume.thinSample} disabled={saving} onSave={(v) => save({ quotaAndResume: { thinSample: v } })} />
        <NumberField label={t(settings.flowLimit)} unit={t(settings.unitItems)} min={0} hint={t(settings.flowLimitHint)} value={qr.flowLimit} def={d.quotaAndResume.flowLimit} disabled={saving} onSave={(v) => save({ quotaAndResume: { flowLimit: v } })} />
        <FlowLimitState limit={qr.flowLimit} workspaces={props.workspaces} />
        {reset.usage}
      </SettingsCard>

      <PolicySettings onError={props.onError} />

      <SettingsCard title={t(settings.newSchedule)} className="tunables">
        <TextField label={t(settings.scheduleCron)} value={nd.scheduleCron} def={d.newDefaults.scheduleCron} mono disabled={saving} onSave={(v) => save({ newDefaults: { scheduleCron: v } })} />
        {reset.newSchedule}
      </SettingsCard>

      <SettingsCard title={t(settings.presets)} className="presets">
        <div className="muted">{t(settings.presetsHint)}</div>
        <PresetSettings onError={props.onError} />
      </SettingsCard>

      <SettingsGroupHeading id="settings-judge" />
      <SettingsCard title={t(settings.judgeAndChoice)} className="tunables">
        <div className="hint">{t(settings.turnJudge)}</div>
        <div className="muted">{t(settings.turnJudgeHint)}</div>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          <label className="hint toggle">
            <input type="checkbox" checked={judge.enabled} disabled={saving} onChange={(e) => void save({ judge: { enabled: e.target.checked } })} />
            {t(settings.turnJudge)}
          </label>
          <DefaultNote on={d.judge.enabled} />
        </div>
        <div className="hint">{t(settings.rubric)}</div>
        <div className="muted">{t(settings.rubricHint)}</div>
        <label className="hint toggle">
          <input type="checkbox" checked={s.evals.judge.enabled} disabled={saving} onChange={(e) => void save({ evals: { judge: { enabled: e.target.checked } } })} />
          {t(settings.rubricToggle)}
        </label>
        <DefaultNote on={d.evals.judge.enabled} />
        <div className="hint">{t(settings.judgeFallbackAndTimeout)}</div>
        <div className="muted">{t(settings.judgeAndChoiceHint)}</div>
        <NumberField label={t(settings.judgeTimeout)} unit={t(settings.unitSeconds)} scale={1000} hint={t(settings.judgeTimeoutHint)} value={jc.judgeTimeoutMs} def={d.judgeAndChoice.judgeTimeoutMs} disabled={saving} onSave={(v) => save({ judgeAndChoice: { judgeTimeoutMs: v } })} />
        <NumberField label={t(settings.workspaceChoiceTimeout)} unit={t(settings.unitSeconds)} scale={1000} hint={t(settings.workspaceChoiceTimeoutHint)} value={jc.workspaceChoiceTimeoutMs} def={d.judgeAndChoice.workspaceChoiceTimeoutMs} disabled={saving} onSave={(v) => save({ judgeAndChoice: { workspaceChoiceTimeoutMs: v } })} />
        {reset.judgeAndChoice}
      </SettingsCard>

      <SettingsCard title={t(settings.llm)}>
        <div className="muted">{t(settings.llmHint)}</div>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          <label className="hint toggle">
            <input type="checkbox" checked={llm.enabled} disabled={saving} onChange={(e) => void save({ routing: { llm: { enabled: e.target.checked } } })} />
            {t(settings.llmToggle)}
            {llm.enabled && props.health?.routing?.llm.available === false && <span className="warn">{t(settings.llmUnavailable, { runner: llm.runner })}</span>}
          </label>
          <select className="mode" value={llm.timeoutMs} disabled={saving} aria-label={t(settings.llmWait)} title={t(settings.llmWaitTitle)} onChange={(e) => void save({ routing: { llm: { timeoutMs: Number(e.target.value) } } })}>
            {[5000, 10000, 15000, 30000].map((ms) => (
              <option key={ms} value={ms}>
                {t(settings.llmWaitOption, { seconds: ms / 1000 })}
              </option>
            ))}
          </select>
          <span className="muted">{t(settings.defaultValue, { value: `${t(d.routing.llm.enabled ? settings.defaultOn : settings.defaultOff)} · ${t(settings.llmWaitOption, { seconds: d.routing.llm.timeoutMs / 1000 })}` })}</span>
        </div>
        {reset.llm}
      </SettingsCard>

      <SettingsCard title={t(settings.titles)}>
        <div className="muted">{t(settings.titlesHint)}</div>
        <label className="hint toggle">
          <input type="checkbox" checked={s.titles.auto} disabled={saving} onChange={(e) => void save({ titles: { auto: e.target.checked } })} />
          {t(settings.titlesToggle)}
        </label>
        <DefaultNote on={d.titles.auto} />
        {reset.titles}
      </SettingsCard>

      <SettingsGroupHeading id="settings-model" />
      <SettingsCard title={t(settings.prices)}>
        <div className="muted">{t(settings.pricesHint)}</div>
        <ModelPrices prices={s.prices} disabled={saving} save={trySave} />
      </SettingsCard>

      <SettingsCard title={t(settings.budgetCard)} className="tunables">
        <BudgetField label={t(settings.fableBudget)} hint={t(settings.fableBudgetHint)} value={qr.fableBudgetUsd} def={d.quotaAndResume.fableBudgetUsd} disabled={saving} onSave={(v) => save({ quotaAndResume: { fableBudgetUsd: v } })} />
        {reset.budgetCard}
      </SettingsCard>

      <SettingsGroupHeading id="settings-workspace" />
      <WorkspaceCard workspaces={props.workspaces} clones={props.clones} onAddWorkspaceFromGithub={props.onAddWorkspaceFromGithub} onAddWorkspace={props.onAddWorkspace} onTaskStarted={props.onTaskStarted} onError={props.onError} />

      <SettingsCard title={t(settings.githubSync)}>
        <GithubSync />
      </SettingsCard>

      <McpCard tasks={props.tasks} onError={props.onError} />

      <SettingsCard title={t(settings.knowledge)} id="knowledge" lazy>
        <Knowledge refreshKey={props.knowledgeRev} workspaces={props.workspaces} onError={props.onError} />
      </SettingsCard>

      <SettingsGroupHeading id="settings-app" />
      <SettingsCard title={t(settings.language)}>
        <div className="row" style={{ alignItems: "center", gap: 6 }}>
          <select className="mode" value={lang} aria-label={t(settings.language)} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ja">{t(settings.japanese)}</option>
            <option value="en">{t(settings.english)}</option>
          </select>
          <span className="hint">{t(settings.languageHint)}</span>
        </div>
      </SettingsCard>

      <SettingsCard title={t(settings.notifications)}>
        {perm === "default" && (
          <>
            <div className="muted">{t(settings.notifyAsk)}</div>
            <div className="row">
              <button className="pri" onClick={() => void Notification.requestPermission().then(setPerm)}>
                {t(settings.notifyAllow)}
              </button>
            </div>
          </>
        )}
        {perm === "granted" && <div className="muted">{t(settings.notifyGranted)}</div>}
        {perm === "denied" && <div className="muted">{t(settings.notifyDenied)}</div>}
        {perm === "unsupported" && <div className="muted">{t(settings.notifyUnsupported)}</div>}
      </SettingsCard>

      <SettingsCard title={t(settings.release)} id="release" className="tunables">
        <ReleasePanel />
        {/* how a new version is found and how far it goes by itself: saved like the other tunables, 既定に戻す puts the three back */}
        <NumberField label={t(settings.releaseCheckMinutes)} unit={t(settings.unitMinutes)} hint={t(settings.releaseCheckMinutesHint)} value={s.release.checkMinutes} def={d.release.checkMinutes} min={1} max={1440} disabled={saving} onSave={(v) => save({ release: { checkMinutes: v } })} />
        <ReleaseAutoFields release={s.release} defaults={d.release} disabled={saving} onSave={(release) => void save({ release })} />
        <NumberField label={t(settings.releaseDrainMinutes)} unit={t(settings.unitMinutes)} hint={t(settings.releaseDrainMinutesHint)} value={s.release.drainMinutes} def={d.release.drainMinutes} min={5} max={1440} disabled={saving} onSave={(v) => save({ release: { drainMinutes: v } })} />
        {reset.release}
      </SettingsCard>

      {countriesUrl(props.health?.login) && (
        <SettingsCard title={t(settings.abroad)}>
          <div className="muted">{t(settings.abroadHint)}</div>
          <a href={countriesUrl(props.health?.login)!}>{t(settings.abroadLink)}</a>
        </SettingsCard>
      )}

      <SettingsCard title={t(settings.outbound)}>
        <div className="muted">{t(settings.outboundHint)}</div>
        <label className="hint toggle">
          <input type="checkbox" checked={s.outbound.classifierLog} disabled={saving} onChange={(e) => void save({ outbound: { classifierLog: e.target.checked } })} />
          {t(settings.classifierLogToggle)}
        </label>
        <DefaultNote on={d.outbound.classifierLog} />
        <div className="muted">{t(settings.classifierLogHint)}</div>
        <label className="hint toggle">
          <input type="checkbox" checked={s.outbound.runnerTelemetry} disabled={saving} onChange={(e) => void save({ outbound: { runnerTelemetry: e.target.checked } })} />
          {t(settings.runnerTelemetryToggle)}
        </label>
        <DefaultNote on={d.outbound.runnerTelemetry} />
        <div className="muted">{t(settings.runnerTelemetryHint)}</div>
        {reset.outbound}
      </SettingsCard>

      <SettingsCard title={t(settings.terminalHistory)}>
        <TerminalHistory onError={props.onError} />
      </SettingsCard>
    </main>
  );
}

/** The Tasks a Workspace MCP endpoint can be issued for: not ended and not a cloud Task (the cases where `GET /api/tasks/:id/mcp` answers 409 or has no local scope), not archived, newest first. */
export function mcpTaskChoices(tasks: TaskSummary[]): TaskSummary[] {
  return tasks
    .filter((x) => x.status !== "done" && x.status !== "error" && x.status !== "aborted" && x.executionMode !== "cloud" && !x.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

type McpIssued = { id: string; url: string; token: string };

/** The selected Task (the pick while it is a choice, else the newest) and the issued endpoint shown for it: only one issued for that same Task. */
export function mcpSelection(choices: TaskSummary[], picked: string, issued: McpIssued | null): { id: string; shown: McpIssued | null } {
  const id = choices.some((x) => x.id === picked) ? picked : (choices[0]?.id ?? "");
  return { id, shown: issued && issued.id === id ? issued : null };
}

/** The folded Workspace MCP card of the 「Workspace と GitHub」 group. */
export function McpCard(props: { tasks: TaskSummary[]; onError: (msg: string) => void }) {
  return (
    <SettingsCard title="Workspace MCP">
      <McpEndpoint tasks={props.tasks} onError={props.onError} />
      <div className="hint" style={{ marginTop: 6 }}>{t(settings.mcpHint)}</div>
    </SettingsCard>
  );
}

/** Issues, copies and rotates the Workspace MCP endpoint of one running Task chosen from the list. */
export function McpEndpoint(props: { tasks: TaskSummary[]; onError: (msg: string) => void }) {
  const choices = mcpTaskChoices(props.tasks);
  const [picked, setPicked] = useState("");
  const [issued, setIssued] = useState<McpIssued | null>(null);
  const { id, shown: mcp } = mcpSelection(choices, picked, issued);
  // The call goes to the Task chosen when pressed, and pins the pick so a reorder of the list does not move the selection.
  const run = (target: string, call: (id: string) => Promise<{ url: string; token: string }>) => {
    setPicked(target);
    return call(target).then((r) => setIssued({ id: target, ...r })).catch((e) => props.onError(String(e.message ?? e)));
  };
  if (choices.length === 0) return <div className="muted">{t(settings.mcpNoTask)}</div>;
  return (
    <>
      {/* A long Task title must not widen the select past the card on a phone: it shrinks, and the button wraps below it. */}
      <div className="actions" style={{ flexWrap: "wrap" }}>
        <select className="model-select" value={id} onChange={(e) => setPicked(e.target.value)}>
          {choices.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
        </select>
        {!mcp && <button onClick={() => void run(id, api.mcpEndpoint)} title={t(settings.mcpIssueTitle)}>{t(settings.mcpIssue)}</button>}
      </div>
      {mcp && (
        <div className="kv">
          <span>URL</span>
          <span className="mono" style={{ wordBreak: "break-all" }}>{mcp.url}</span>
          <span>{t(settings.mcpToken)}</span>
          <span className="mono" style={{ wordBreak: "break-all" }}>{mcp.token}</span>
          <span />
          <span>
            <button className="ghost" onClick={() => void navigator.clipboard?.writeText(`${mcp.url}?token=${mcp.token}`)}>{t(settings.mcpCopy)}</button>{" "}
            <button className="ghost" onClick={() => void run(mcp.id, api.mcpRotate)} title={t(settings.mcpRotateTitle)}>{t(settings.mcpRotate)}</button>
          </span>
        </div>
      )}
    </>
  );
}

/**
 * A folded card of the Settings screen: only its title shows until pressed. React is not given `open`, so a save's
 * re-render leaves an opened card open. A `lazy` card draws its body from the first time it is opened (a closed
 * <details> body is still rendered by React, and a body that fetches would fetch on every visit to Settings). 承認モードの既定 is not one of these (a safety setting stays unfolded).
 */
function SettingsCard(props: { title: string; id?: string; className?: string; lazy?: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className={`card ${props.className ?? ""}`.trim()} id={props.id} onToggle={props.lazy ? (e) => e.currentTarget.open && setOpened(true) : undefined}>
      <summary>
        <h5>{props.title}</h5>
      </summary>
      {(!props.lazy || opened) && props.children}
    </details>
  );
}

/** The table of contents: one link per group; a press scrolls to the group's heading and leaves the URL as it is. */
export function SettingsToc() {
  return (
    <nav className="settings-toc" aria-label={t(settings.tocLabel)}>
      {SETTINGS_GROUPS.map((g) => (
        <a
          key={g.id}
          href={`#${g.id}`}
          onClick={(e) => {
            e.preventDefault();
            const heading = document.getElementById(g.id);
            heading?.scrollIntoView();
            heading?.focus({ preventScroll: true }); // the next Tab goes on inside the group, as a fragment link would
          }}
        >
          {groupTitle(g.id)}
        </a>
      ))}
    </nav>
  );
}

/** A group's title above its cards; the id is where the table of contents moves to. */
export function SettingsGroupHeading(props: { id: string }) {
  return (
    <h4 className="settings-group" id={props.id} tabIndex={-1}>
      {groupTitle(props.id)}
    </h4>
  );
}

/**
 * Each workspace's GitHub sync: its state and the button that turns it off or on — only by this press. One kept
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
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
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
  const attach = async (w: Workspace, on: boolean) => {
    setBusy(w.id);
    setErrors((e) => ({ ...e, [w.id]: "" }));
    try {
      await api.setWorkspaceIssueArtifacts(w.id, on);
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
        const text = githubSyncText(s);
        // kept here only: its stored backlog is under its own id, and it reads no Project yet
        const local = s.backlog === "switchboard" && s.repository === w.id;
        const to = s.enabling || s.backlog === "switchboard" ? "github" : "switchboard";
        return (
          <div key={w.id} className="row github-sync" data-workspace={w.id} style={{ alignItems: "center", gap: 6 }}>
            <span>{w.name}</span>
            <span className="hint" data-sync={text.state}>
              {[text.label, ...text.parts].join(" · ")}
            </span>
            {local && <input aria-label={t(settings.projectVar, { name: w.name })} placeholder="SWITCHBOARD_PROJECT_URL" value={vars[w.id] ?? w.projectVar ?? ""} onChange={(e) => setVars((v) => ({ ...v, [w.id]: e.target.value }))} />}
            <button className={to === "github" ? "pri" : "ghost"} disabled={busy !== null} onClick={() => void press(w, to, local)}>
              {s.enabling ? t(settings.syncContinue) : to === "github" ? t(settings.turnOn) : t(settings.turnOff)}
            </button>
            {/* only where the sync is on and has read GitHub: otherwise there is no Issue on GitHub to attach to */}
            {issueArtifactsShown(s, w.issueArtifacts) && (
              <label className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={w.issueArtifacts} disabled={busy !== null} onChange={(e) => void attach(w, e.target.checked)} />
                {t(settings.issueArtifacts)}
              </label>
            )}
            {errors[w.id] && <span className="warn">{errors[w.id]}</span>}
          </div>
        );
      })}
      <div className="hint">{t(settings.syncHint)}</div>
    </>
  );
}

/** backlog-next's slots of each workspace: what each firing reads, so a save applies from the next one. */
export function SweepSlots(props: { onError: (msg: string) => void; flowLimit: number; defaultFlowLimit: number; onSettings: (s: SettingsResponse) => void }) {
  const [saved, setSaved] = useState<Workspace[] | null>(null);
  const [alloc, setAlloc] = useState<BacklogAllocation | null>(null);
  const [draft, setDraft] = useState<Record<string, { implement: string; plan: string; share: string; mode: WorkspaceMode }>>({});
  const [flowDraft, setFlowDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const show = (list: Workspace[], a: BacklogAllocation | null) => {
    setSaved(list);
    setAlloc(a);
    setDraft(Object.fromEntries(list.map((w) => [w.id, { implement: String(w.sweep.implement), plan: String(w.sweep.plan), share: shareText(w.allocation.share), mode: w.allocation.mode }])));
    if (a) setFlowDraft(shareText(a.flow.limit));
  };
  // the actuals are read when the card opens and after each save, not on a timer
  const load = () => Promise.all([api.workspaces(), api.backlogAllocation().catch(() => null)]).then(([list, a]) => show(list, a));
  useEffect(() => {
    load().catch((e) => props.onError(String(e.message ?? e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void (alloc && setFlowDraft(shareText(props.flowLimit))), [props.flowLimit]); // eslint-disable-line react-hooks/exhaustive-deps -- the card's 既定に戻す saves through the parent: only the cap's box follows, so unsaved slot edits stay
  const save = async () => {
    if (!saved) return;
    // an emptied box would be Number("") = 0, which switches the slot off: only a typed digit counts
    const bad = saved.find((w) => ![draft[w.id]!.implement, draft[w.id]!.plan].every((x) => /^\s*[0-3]\s*$/.test(x)));
    if (bad) {
      props.onError(t(settings.slotsInvalid, { name: bad.name, implement: draft[bad.id]!.implement, plan: draft[bad.id]!.plan }));
      return;
    }
    const badShare = saved.find((w) => parseShare(draft[w.id]!.share) === "invalid");
    if (badShare) {
      props.onError(t(settings.allocShareInvalid, { name: badShare.name, value: draft[badShare.id]!.share }));
      return;
    }
    const flow = parseShare(flowDraft);
    if (alloc && (flow === "invalid" || flow === null)) {
      props.onError(t(settings.allocFlowInvalid, { value: flowDraft }));
      return;
    }
    setBusy(true);
    try {
      for (const w of saved) {
        const d = draft[w.id]!;
        const v = { implement: Number(d.implement), plan: Number(d.plan) };
        if (v.implement !== w.sweep.implement || v.plan !== w.sweep.plan) await api.setWorkspaceSweep(w.id, v);
      }
      const changed = saved
        .map((w) => ({ w, from: w.allocation.share, to: parseShare(draft[w.id]!.share) as number | null, mode: draft[w.id]!.mode }))
        .filter((c) => c.to !== c.from || c.mode !== c.w.allocation.mode);
      for (const c of saveOrder(changed)) await api.setWorkspaceAllocation(c.w.id, { share: c.to, mode: c.mode });
      if (alloc && typeof flow === "number" && flow !== props.flowLimit) props.onSettings(await api.updateSettings({ quotaAndResume: { flowShareLimit: flow } }));
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      // what was saved, also when one of them failed
      await load().catch(() => undefined);
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
        aria-label={t(settings.slotLabel, { name: w.name, slot: label })}
        value={draft[w.id]?.[slot] ?? ""}
        onChange={(e) => setDraft((d) => ({ ...d, [w.id]: { ...d[w.id]!, [slot]: e.target.value } }))}
        style={{ width: 56 }}
      />
    </>
  );
  const modeName: Record<WorkspaceMode, string> = { new: t(settings.allocModeNew), continuing: t(settings.allocModeContinuing), maintenance: t(settings.allocModeMaintenance) };
  return (
    <div className="backlog-sweep" style={{ gridColumn: "1 / -1" }}>
      {/* ui-strings: value "implement" "plan" — the slot's key */}
      {saved?.map((w) => {
        const a = alloc?.workspaces.find((x) => x.workspaceId === w.id);
        return (
          <div key={w.id} className="row" data-workspace={w.id} style={{ alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="t">{w.name}</span>
            {box(w, "implement", t(settings.slotImplement))}
            {box(w, "plan", t(settings.slotPlan))}
            <select aria-label={t(settings.allocModeLabel, { name: w.name })} value={draft[w.id]?.mode ?? "continuing"} onChange={(e) => setDraft((d) => ({ ...d, [w.id]: { ...d[w.id]!, mode: e.target.value as WorkspaceMode } }))}>
              {(["new", "continuing", "maintenance"] as const).map((m) => (
                <option key={m} value={m}>
                  {modeName[m]}
                </option>
              ))}
            </select>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="hint">{t(settings.allocShare)}</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label={t(settings.allocShareLabel, { name: w.name })}
                value={draft[w.id]?.share ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [w.id]: { ...d[w.id]!, share: e.target.value } }))}
                style={{ width: 56 }}
              />
            </span>
            {a && (
              <span className="hint">
                {t(settings.allocActual)} {allocationCells(a).actual}
              </span>
            )}
          </div>
        );
      })}
      {alloc && (
        <div className="row" data-flow-limit style={{ alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span className="t">{t(settings.allocFlow)}</span>
          <input type="text" inputMode="decimal" aria-label={t(settings.allocFlowLabel)} value={flowDraft} onChange={(e) => setFlowDraft(e.target.value)} style={{ width: 56 }} /><span className="muted">{t(settings.defaultValue, { value: shareText(props.defaultFlowLimit) })}</span>
          <span className="hint">
            {t(settings.allocActual)} {Math.round(alloc.flow.actual * 100)}%
          </span>
          <span className="hint">{t(settings.allocFlowHint)}</span>
        </div>
      )}
      <div className="row" style={{ alignItems: "center", gap: 6 }}>
        <button className="ghost" disabled={busy || !saved} onClick={() => void save()}>
          {t(settings.save)}
        </button>
        <span className="hint">{t(settings.slotsHint)}</span>
      </div>
      <div className="hint">{t(settings.allocHint)}</div>
    </div>
  );
}

/**
 * 定型の指示: the saved instructions, newest first, each edited or deleted in its row; a new one from the form
 * at the end. Kept by the daemon (/api/presets), so a reload shows the same list.
 */
export function PresetSettings(props: { onError: (msg: string) => void }) {
  const [list, setList] = useState<Preset[] | null>(null);
  const [edit, setEdit] = useState<{ id: string; name: string; text: string; error: string | null } | null>(null);
  const [draft, setDraft] = useState({ name: "", text: "", error: null as string | null });
  const [busy, setBusy] = useState(false);
  const { onError } = props;
  const load = () => api.presets().then((r) => setList(r.presets)).catch((e) => onError(t(settings.presetsUnreadable, { error: String(e.message ?? e) })));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (fn: () => Promise<unknown>, fail: (msg: string) => void) => {
    setBusy(true);
    try {
      await fn();
      forgetPresets(); // the request and reply boxes read the list again
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
  const remove = (p: Preset) => confirm(t(settings.presetDeleteConfirm, { name: p.name })) && void run(() => api.deletePreset(p.id), (msg) => onError(t(settings.deleteFailed, { error: msg })));
  // the form is read-only while it saves (below), so what is cleared is what was saved
  const add = () => void run(async () => { await api.createPreset({ name: draft.name, text: draft.text }); setDraft({ name: "", text: "", error: null }); }, (error) => setDraft((cur) => ({ ...cur, error })));
  return (
    <>
      {list && list.length === 0 && <div className="muted">{t(settings.noPresets)}</div>}
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
                <input aria-label={t(settings.name)} readOnly={busy} value={editing.name} onChange={(e) => setEdit({ ...editing, name: e.target.value })} />
                <textarea aria-label={t(settings.presetText)} rows={4} readOnly={busy} value={editing.text} onChange={(e) => setEdit({ ...editing, text: e.target.value })} />
                {editing.error && <div className="hint warn">{editing.error}</div>}
                <div className="policy-actions">
                  <button className="pri" disabled={busy} onClick={saveEdit}>
                    {t(settings.save)}
                  </button>
                  <button className="ghost" onClick={() => setEdit(null)}>
                    {t(settings.cancel)}
                  </button>
                </div>
              </div>
            ) : (
              <div className="policy-actions">
                <button className="ghost" onClick={() => setEdit({ id: p.id, name: p.name, text: p.text, error: null })}>
                  {t(settings.edit)}
                </button>
                <button className="ghost" disabled={busy} onClick={() => remove(p)}>
                  {t(settings.delete)}
                </button>
              </div>
            )}
          </div>
        );
      })}
      <div className="policy-edit preset-new">
        <input aria-label={t(settings.newPresetName)} readOnly={busy} placeholder={t(settings.newPresetNamePlaceholder)} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <textarea aria-label={t(settings.newPresetText)} rows={4} readOnly={busy} placeholder={t(settings.newPresetTextPlaceholder)} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        {draft.error && <div className="hint warn">{draft.error}</div>}
        <div className="policy-actions">
          <button className="pri" disabled={busy || !draft.name.trim() || !draft.text.trim()} onClick={add}>
            {t(settings.save)}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Under the flow limit's field: what the number limits (shown, not only a tooltip: a phone has none), and which PBIs are
 * counted against it and which Ready ones it holds back now. Read when the card opens and again when the saved limit
 * changes, not on a timer; a read that fails leaves the lines out (the field still works).
 */
function FlowLimitState(props: { limit: number; workspaces: Workspace[] }) {
  const [flow, setFlow] = useState<BacklogAllocation["flowLimit"] | null>(null);
  useEffect(() => {
    let live = true;
    api.backlogAllocation().then((a) => live && setFlow(a.flowLimit), () => live && setFlow(null));
    return () => { live = false; };
  }, [props.limit]);
  const rows = flow ? flowLimitRows(flow, new Map(props.workspaces.map((w) => [w.id, w.name]))) : [];
  return (
    <>
      <div className="hint">{t(settings.flowLimitHint)}</div>
      {flow && (rows.length ? (
        <ul className="flow-state hint">
          {rows.map((r) => <li key={`${r.ws}:${r.kind}`}>{t(r.kind === "counted" ? settings.flowCounted : settings.flowHeld, { ws: r.ws, numbers: flowNumbers(r.numbers) })}</li>)}
        </ul>
      ) : <div className="flow-state muted">{t(settings.flowNone)}</div>)}
    </>
  );
}

/**
 * One number of the tunables, shown in its unit (`scale` ms per unit) and saved on blur / Enter. What is typed
 * stays local until then, so a half-typed value is never saved; a value the daemon refuses (400) is shown as an error
 * and the box goes back to the saved one.
 */
export function NumberField(props: { label: string; unit?: string; scale?: number; step?: number; min?: number; max?: number; hint?: string; value: number; def: number; disabled: boolean; onSave: (v: number) => Promise<void> }) {
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
    <label className="num-field" title={props.hint}>
      <span className="hint">{props.label}</span>
      <input type="number" step={props.step ?? 1} min={props.min} max={props.max} aria-label={props.label} value={text ?? shown(props.value)} disabled={props.disabled} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)} style={{ width: 88 }} />
      <span className="hint">{props.unit ?? ""}</span>
      <span className="muted">{t(settings.defaultValue, { value: `${shown(props.def)}${props.unit ? ` ${props.unit}` : ""}` })}</span>
    </label>
  );
}

/** A budget in USD that may be empty (= none): an emptied box saves null, a positive number saves itself, anything else is not saved. */
function BudgetField(props: { label: string; unit?: string; hint?: string; value: number | null; def: number | null; disabled: boolean; onSave: (v: number | null) => Promise<void> }) {
  const shown = (v: number | null) => (v === null ? "" : String(v));
  const [text, setText] = useState<string | null>(null);
  const commit = (typed: string) => {
    setText(null);
    const n = typed.trim() === "" ? null : Number(typed);
    if (n === props.value || (n !== null && !(n > 0))) return;
    void props.onSave(n);
  };
  return (
    <>
      <label className="num-field">
        <span className="hint">{props.label}</span>
        <input type="number" step={1} min={0} aria-label={props.label} value={text ?? shown(props.value)} disabled={props.disabled} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)} style={{ width: 88 }} />
        <span className="hint">{props.unit ?? ""}</span>
        <span className="muted">{t(settings.defaultValue, { value: props.def === null ? t(settings.noBudget) : `$${props.def}` })}</span>
      </label>
      {props.hint && <div className="hint">{props.hint}</div>}
    </>
  );
}

/** One text of the tunables, saved on blur (Enter too, for one line). */
function TextField(props: { label: string; hint?: string; value: string; def: string; multiline?: boolean; mono?: boolean; disabled: boolean; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const commit = (typed: string) => {
    setText(null);
    if (typed.trim() === props.value) return;
    void props.onSave(typed);
  };
  const common = { "aria-label": props.label, value: text ?? props.value, disabled: props.disabled, onBlur: (e: { currentTarget: { value: string } }) => commit(e.currentTarget.value), className: props.mono ? "mono" : undefined };
  return (
    <div className="text-field" title={props.hint}>
      <span className="hint">{props.label}</span>
      {props.multiline ? (
        <textarea rows={2} {...common} onChange={(e) => setText(e.target.value)} />
      ) : (
        <input {...common} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)} style={{ width: 140 }} />
      )}
      <span className="muted">{t(settings.defaultValue, { value: props.def })}</span>
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

/** モデルの価格: the saved rows with 直す / 消す, and a form under them; the daemon refuses a bad row with 400 too. */
/** One runner's model choices: every edit saves the whole list at once; the last one cannot be removed (null goes back instead). */
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
            {m.label}
            {t(settings.parenOpen)}
            <span className="mono">{m.value}</span>
            {t(settings.parenClose)}
          </span>
          <button className="ghost" disabled={props.disabled || i === 0} onClick={() => void put(moveModel(props.list, m.value, -1))}>
            {t(settings.moveUp)}
          </button>
          <button className="ghost" disabled={props.disabled || i === props.list.length - 1} onClick={() => void put(moveModel(props.list, m.value, 1))}>
            {t(settings.moveDown)}
          </button>
          <button className="ghost" disabled={props.disabled || props.list.length === 1} onClick={() => void put(removeModel(props.list, m.value))}>
            {t(settings.remove)}
          </button>
        </div>
      ))}
      <div className="row" style={{ alignItems: "center", justifyContent: "flex-start", gap: 6, flexWrap: "wrap" }}>
        <input className="mono" aria-label={t(settings.addModelId, { runner: props.runner })} placeholder="id" value={id} disabled={props.disabled} onChange={(e) => setId(e.target.value)} style={{ width: 200 }} />
        <input aria-label={t(settings.addModelLabel, { runner: props.runner })} placeholder={t(settings.displayName)} value={label} disabled={props.disabled} onChange={(e) => setLabel(e.target.value)} style={{ width: 140 }} />
        <button className="btn" disabled={props.disabled} onClick={() => void add()}>
          {t(settings.add)}
        </button>
        {props.saved && (
          <button className="ghost" disabled={props.disabled} onClick={() => void put(null)}>
            {t(settings.bundledList)}
          </button>
        )}
      </div>
      {why && <div className="warn">{why}</div>}
    </div>
  );
}

/**
 * 「CLI の表を読む」: the installed CLIs' models that are neither listed nor hidden, each to 足す (at the end of the
 * list) or 載せない; the 載せない list folded below with 取り消し. Read only on the button: the claude table is about 240 MB.
 */
export function CliModelCandidates(props: { runners: RunnerInfo[]; hidden: (runner: RunnerId) => string[]; disabled: boolean; save: (patch: { models?: Record<string, ModelOption[]>; hiddenModels?: Record<string, string[]> }) => Promise<boolean>; onError: (msg: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [found, setFound] = useState<ModelCandidates | null>(null);
  const read = async () => {
    setLoading(true);
    try {
      // a block shows its own runners' candidates only (a runner's block passes just that runner)
      setFound(candidatesOf(await api.modelCandidates(), props.runners));
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };
  const drop = (runner: RunnerId, value: string) => setFound((f) => f?.map((r) => (r.runner === runner && "candidates" in r ? { ...r, candidates: r.candidates.filter((m) => m.value !== value) } : r)) ?? null);
  // the list 足す appends to: the runner's own login list, as モデルの選択肢 above edits it (listModels on Bedrock)
  const listOf = (runner: RunnerId) => props.runners.filter((r) => r.id === runner && (r.listModels ?? r.models).length > 0).map((r) => r.listModels ?? r.models)[0];
  const add = async (runner: RunnerId, m: ModelOption) => {
    const list = listOf(runner);
    if (!list) return;
    const next = addModel(list, m.value, m.label);
    // already in the list (added by hand above since the read): nothing to save, the row goes
    if (typeof next === "string") return drop(runner, m.value);
    if (await props.save({ models: { [runner]: next } })) drop(runner, m.value);
  };
  const hide = async (runner: RunnerId, value: string) => {
    if (await props.save({ hiddenModels: { [runner]: hideModel(props.hidden(runner), value) } })) drop(runner, value);
  };
  const catalogRunners = props.runners.filter((r) => (r.id === "claude" || r.id === "codex") && (r.listModels ?? r.models).length > 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="row" style={{ alignItems: "center", justifyContent: "flex-start", gap: 6 }}>
        <button className="btn" disabled={props.disabled || loading} onClick={() => void read()} title={t(settings.readCliTitle)}>
          {loading ? t(settings.loading) : t(settings.readCli)}
        </button>
      </div>
      {found?.map((r) => (
        <div key={r.runner} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="t">{t(settings.candidates, { runner: r.runner })}</span>
          {"error" in r ? (
            <div className="muted">{r.error}</div>
          ) : r.candidates.length === 0 ? (
            <div className="muted">{t(settings.noCandidates)}</div>
          ) : (
            r.candidates.map((m) => (
              <div key={m.value} className="row" style={{ alignItems: "center", justifyContent: "flex-start", gap: 6 }}>
                <span>
                  {m.label}
                  {t(settings.parenOpen)}
                  <span className="mono">{m.value}</span>
                  {t(settings.parenClose)}
                </span>
                <button className="ghost" disabled={props.disabled || !listOf(r.runner)} aria-label={t(settings.addCandidate, { runner: r.runner, model: m.value })} title={t(settings.addCandidateTitle)} onClick={() => void add(r.runner, m)}>
                  {t(settings.add)}
                </button>
                <button className="ghost" disabled={props.disabled} aria-label={t(settings.hideCandidate, { runner: r.runner, model: m.value })} title={t(settings.hideTitle)} onClick={() => void hide(r.runner, m.value)}>
                  {t(settings.hide)}
                </button>
              </div>
            ))
          )}
        </div>
      ))}
      <details>
        <summary>{t(settings.hiddenModels)}</summary>
        {catalogRunners.map((r) => (
          <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="t">{r.id}</span>
            {props.hidden(r.id).length === 0 && <div className="muted">{t(settings.none)}</div>}
            {props.hidden(r.id).map((id) => (
              <div key={id} className="row" style={{ alignItems: "center", justifyContent: "flex-start", gap: 6 }}>
                <span className="mono">{id}</span>
                <button className="ghost" disabled={props.disabled} aria-label={t(settings.unhide, { runner: r.id, model: id })} onClick={() => void props.save({ hiddenModels: { [r.id]: unhideModel(props.hidden(r.id), id) } })}>
                  {t(settings.undo)}
                </button>
              </div>
            ))}
          </div>
        ))}
      </details>
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
        <div className="table-scroll">
        <table className="pricing">
          <thead>
            <tr>
              <th>{t(settings.model)}</th>
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
                    {t(settings.fixPrice)}
                  </button>
                  <button className="ghost" disabled={props.disabled} onClick={() => void props.save({ prices: { [m]: null } })}>
                    {t(settings.erasePrice)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="row" style={{ alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <input className="mono" aria-label={t(settings.modelName)} placeholder={t(settings.modelName)} value={form.model} disabled={props.disabled} onChange={(e) => setForm({ ...form, model: e.target.value })} style={{ width: 200 }} />
        {boxes.map(([k, label]) => (
          <input key={k} type="number" min={0} step="any" aria-label={label} placeholder={label} value={form[k]} disabled={props.disabled} onChange={(e) => setForm({ ...form, [k]: e.target.value })} style={{ width: 112 }} />
        ))}
        <button className="btn" disabled={props.disabled} onClick={() => void submit()}>
          {t(settings.save)}
        </button>
      </div>
      {why && <div className="warn">{why}</div>}
      <div className="hint">{t(settings.priceFormHint)}</div>
    </>
  );
}

/**
 * One kind of the 自動で始まる Task の既定. Without its own choice it reads 共通; 変える opens the selects
 * (opening saves nothing) starting from the common values, and the first change saves the kind's own choice.
 * 共通に戻す removes it (PATCH null).
 */
function KindRow(props: {
  kind: AutoStartKind;
  label: string;
  auto: SettingsData["autoStart"];
  info: (id: RunnerId) => RunnerInfo | undefined;
  runnerOptions: (current: RunnerId, label: string) => React.ReactNode;
  listed: RunnerId[];
  runnerOk: Set<RunnerId>;
  /** what an empty kind budget falls back to on a button Task (バックログを進める: the schedule's first) */
  defaultBudget: number | null;
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
        <span className="muted">{t(settings.common)}</span>
        {/* the Task ごと model chosen while 実装 follows 共通 stays in sight; 変える opens its select */}
        {props.kind === "complete" && props.auto.runner === "claude" && props.auto.completeTaskModel && <span className="muted">{t(settings.taskModelChoice, { label: props.auto.completeTaskModel })}</span>}
        <button className="ghost" disabled={props.disabled} onClick={() => setOpen(true)} title={t(settings.changeTitle)}>
          {t(settings.change)}
        </button>
      </div>
    );
  const c = kindChoice(own, props.auto); // what the kind starts on, as the daemon decides it
  const cRunner = c.runner ?? props.auto.runner; // a kind without its own runner follows the common one
  const runnerInfo = props.info(cRunner);
  const modes = (runnerInfo?.permissionModes ?? []).filter((m) => !m.danger || m.value === runnerInfo?.defaultPermissionMode);
  // a saved value the runner no longer lists (or one not detected now) stays shown, so the box says what is saved
  const savedMode = own?.permissionMode && !modes.some((m) => m.value === own.permissionMode) ? own.permissionMode : null;
  const shadows = shadowCandidates(props.listed, props.runnerOk, cRunner);
  const savedShadow = own?.shadow && own.shadow !== "off" && !shadows.includes(own.shadow as RunnerId) ? own.shadow : null;
  const pick = (choice: { runner?: RunnerId; model?: string; effort?: string; permissionMode?: string | null; budgetUsd?: number | null; shadow?: string | null } | null) => props.save({ autoStart: { byKind: { [props.kind]: choice } } });
  return (
    <div className="row" style={{ alignItems: "center", gap: 6, justifyContent: "flex-start", flexWrap: "wrap" }}>
      {name}
      {/* a runner change goes back to that runner's CLI default, as for the common values */}
      {/* a kind that changed only its approval mode / budget / 並走 has no runner of its own: 共通 until one is chosen */}
      <select className="mode" value={c.runner ?? ""} disabled={props.disabled} aria-label={t(settings.kindRunner, { label: props.label })} onChange={(e) => e.target.value && void pick({ runner: e.target.value as RunnerId })}>
        {!c.runner && <option value="">{t(settings.common)}</option>}
        {props.runnerOptions(cRunner, t(settings.runner))}
      </select>
      <ModelSelect runner={props.info(cRunner)} value={c.model} onChange={(model) => void pick(kindPick(own, c, { model }, props.info(cRunner)))} label={t(settings.model)} emptyLabel={runnerDefaultLabel("model", props.info(cRunner))} disabled={props.disabled} title={t(settings.kindModelTitle, { label: props.label })} />
      <EffortSelect runner={props.info(cRunner)} value={c.effort} onChange={(effort) => void pick(kindPick(own, c, { effort }, props.info(cRunner)))} label={t(settings.effort)} emptyLabel={runnerDefaultLabel("effort", props.info(cRunner))} disabled={props.disabled} title={t(settings.kindEffortTitle, { label: props.label })} />
      {/* Task ごとのモデル: 実装 on claude only */}
      {props.kind === "complete" && cRunner === "claude" && (
        <select className="model-select" value={props.auto.completeTaskModel} disabled={props.disabled} aria-label={t(settings.taskModel)} title={t(settings.taskModelTitle)} onChange={(e) => void props.save({ autoStart: { completeTaskModel: e.target.value } })}>
          {taskModelOptions(props.info(cRunner), props.auto.completeTaskModel).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {/* approval mode / budget / 並走 on their own line: the budget box is a grid that needs room */}
      <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {/* the same choices as 承認モードの既定: a mode that skips confirmations is not offered */}
      {(modes.length > 0 || savedMode) && (
        <select className="mode" value={own?.permissionMode ?? ""} disabled={props.disabled} aria-label={t(settings.kindApproval, { label: props.label })} onChange={(e) => void pick({ permissionMode: e.target.value || null })}>
          <option value="">{t(settings.kindFollowDefault)}</option>
          {modes.map((m) => (
            <option key={m.value} value={m.value} title={m.description}>
              {t(settings.approvalOption, { label: m.label })}
            </option>
          ))}
          {savedMode && <option value={savedMode}>{t(settings.approvalOption, { label: savedMode })}</option>}
        </select>
      )}
      <div style={{ width: "min(100%, 24em)" }}>
        <BudgetField label={t(settings.kindBudget, { label: props.label })} unit={t(settings.unitUsd)} value={own?.budgetUsd ?? null} def={props.defaultBudget} disabled={props.disabled} onSave={(v) => props.save({ autoStart: { byKind: { [props.kind]: { budgetUsd: v } } } })} />
      </div>
      <select className="mode" value={own?.shadow ?? ""} disabled={props.disabled} aria-label={t(settings.kindShadow, { label: props.label })} onChange={(e) => void pick({ shadow: e.target.value || null })}>
        <option value="">{t(settings.kindShadowFollow)}</option>
        <option value="off">{t(settings.kindShadowOff)}</option>
        {shadows.map((r) => (
          <option key={r} value={r}>
            {t(settings.kindShadowRunner, { runner: r })}
          </option>
        ))}
        {savedShadow && <option value={savedShadow}>{t(settings.kindShadowRunner, { runner: savedShadow })}</option>}
      </select>
      </div>
      <button className="ghost" style={{ whiteSpace: "nowrap" }} disabled={props.disabled} onClick={() => void pick(null).then(() => setOpen(false))} title={t(settings.backToCommonTitle)}>
        {t(settings.backToCommon)}
      </button>
    </div>
  );
}

/** The default of an on / off value, next to its toggle: the same wording as the number and text boxes' 「既定 …」. */
function DefaultNote(props: { on: boolean }) {
  return <span className="muted">{t(settings.defaultValue, { value: t(props.on ? settings.defaultOn : settings.defaultOff) })}</span>;
}

function ResetButton(props: { disabled: boolean; onClick: () => Promise<void> }) {
  return (
    <div className="row">
      <button className="ghost" disabled={props.disabled} onClick={() => void props.onClick()} title={t(settings.resetTitle)}>
        {t(settings.reset)}
      </button>
    </div>
  );
}

/** Terminal の履歴 (moved here from Home): what the daemon imported from Claude Code's sessions, and a manual import. */
export function TerminalHistory(props: { onError: (msg: string) => void }) {
  // what the daemon imported from ~/.claude/projects
  const [history, setHistory] = useState<HistoryStatus | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  // The daemon's passes are silent when they only append or find nothing: poll while this section is open, and keep
  // retrying after a failed fetch.
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
  }, []);
  const importNow = async () => {
    setImporting(true);
    try {
      const r = await api.historyImport();
      setImportMsg(`${t(settings.importScanned, { files: r.files, created: r.created, appended: r.appended })}${r.skippedForeign ? t(settings.importForeign, { n: r.skippedForeign }) : ""}${r.errors.length ? t(settings.importErrors, { n: r.errors.length, first: r.errors[0]! }) : ""}`);
      setHistory(await api.history());
    } catch (e) {
      props.onError(String((e as Error).message ?? e));
    } finally {
      setImporting(false);
    }
  };
  const terminalSessions = history?.sessions.filter((s) => s.origin === "terminal").length ?? 0;
  return (
    <>
      {history?.enabled && (
        <div className="row head">
          <button className="ghost" disabled={importing} onClick={() => void importNow()} title={history.pollMs > 0 ? t(settings.importTitlePoll, { seconds: Math.round(history.pollMs / 1000) }) : t(settings.importTitleNoPoll)}>
            {importing ? t(settings.importing) : t(settings.importNow)}
          </button>
        </div>
      )}
      {!history && !historyErr && <div className="muted">{t(settings.historyLoading)}</div>}
      {historyErr && <div className="hint warn">{t(settings.historyError, { error: historyErr })}</div>}
      {history && !history.enabled && (
        <div className="muted">
          <span className="mono">{history.dir}</span>
          {t(settings.historyNoDir)}
        </div>
      )}
      {history?.enabled && (
        <div className="hint">
          {t(settings.historyImportedBefore)}
          <b>{terminalSessions}</b>
          {t(settings.historyImportedAfter)}
          {history.lastScanAt ? t(settings.historyLastScan, { at: jstTime(history.lastScanAt) }) : ""}
          {history.pollMs > 0 ? t(settings.historyEvery, { seconds: Math.round(history.pollMs / 1000) }) : t(settings.historyStartupOnly)}
          {history.lastResult && history.lastResult.skippedForeign > 0 && t(settings.historyForeign, { n: history.lastResult.skippedForeign })}
          {history.lastResult && history.lastResult.errors.length > 0 && <span className="warn">{t(settings.historyErrors, { n: history.lastResult.errors.length, first: history.lastResult.errors[0]! })}</span>}
        </div>
      )}
      {importMsg && <div className="hint">{importMsg}</div>}
      <div className="hint">
        {t(settings.historySourceBefore)}
        <span className="mono">{history?.dir ?? "~/.claude/projects"}</span>
        {t(settings.historySourceAfter)}
      </div>
    </>
  );
}

const EMPTY_DRAFT: CustomRunnerDraft = { port: "adk", sendWorkspaceMcp: false, name: "", label: "", url: "", app: "", tokenEnv: "" };

/** The ADK servers that run as `custom:<name>` (docs/design/custom-adapter.md). No edit: remove and add again. */
function CustomRunnersSection(props: { onError: (msg: string) => void }) {
  const [list, setList] = useState<CustomRunner[] | null>(null);
  const [draft, setDraft] = useState<CustomRunnerDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);
  const { onError } = props;
  useEffect(() => {
    api.customRunners().then(setList).catch((e) => onError(t(settings.adkUnreadable, { error: String(e.message ?? e) })));
  }, [onError]);
  const put = (next: CustomRunner[]) => {
    setSaving(true);
    return api
      .putCustomRunners(next)
      .then((saved) => {
        setList(saved);
        setChanged(true);
        return true;
      })
      .catch((e) => {
        setError(String(e.message ?? e));
        return false;
      })
      .finally(() => setSaving(false));
  };
  const add = () => {
    if (!list) return;
    const r = customRunnerFromDraft(draft, list);
    if ("error" in r) return setError(r.error);
    setError(null);
    void put([...list, r.entry]).then((ok) => ok && setDraft(EMPTY_DRAFT));
  };
  const field = (key: "name" | "label" | "url" | "app" | "tokenEnv", label: string, placeholder: string, size: number) => (
    <label className="hint">
      {label} <input value={draft[key]} size={size} placeholder={placeholder} disabled={saving} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </label>
  );
  const offHost = draft.url.trim() !== "" && sendsOffHost(draft.url.trim());
  return (
    <SettingsCard title={t(settings.adk)}>
      <div className="muted">{t(settings.adkHint)}</div>
      {list?.length ? (
        <div>
          {/* ui-strings: value "custom:" "/ app" — the runner id's prefix and ADK's word for the app */}
          {list.map((r) => (
            <div key={r.name} className="row" style={{ flexWrap: "wrap", gap: "2px 12px", padding: "4px 0", alignItems: "baseline" }}>
              <b>custom:{r.name}</b>
              <span>{r.label}</span>
              <span style={{ overflowWrap: "anywhere" }}>
                {PORT_LABEL[r.port]} {r.url}
                {r.port === "adk" ? <> / app {r.app}</> : r.sendWorkspaceMcp && <span className="hint">{t(settings.aguiSendsMcp)}</span>}
                {sendsOffHost(r.url) && <span className="hint">{t(settings.adkSentHere)}</span>}
              </span>
              <span>{r.tokenEnv ? t(settings.adkToken, { name: r.tokenEnv }) : t(settings.adkNoToken)}</span>
              <button className="ghost" disabled={saving} onClick={() => void put(list.filter((x) => x.name !== r.name))}>
                {t(settings.delete)}
              </button>
            </div>
          ))}
        </div>
      ) : (
        list && <div className="hint">{t(settings.nothingYet)}</div>
      )}
      {/* ui-strings: value "name" "label" "url" "app" "tokenEnv" "research" "Research agent" — the fields' keys and a sample runner */}
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        <label className="hint">
          {t(settings.runnerKind)}{" "}
          <select value={draft.port} disabled={saving} onChange={(e) => setDraft({ ...draft, port: e.target.value as CustomRunnerDraft["port"] })}>
            <option value="adk">{PORT_LABEL.adk}</option>
            <option value="agui">{PORT_LABEL.agui}</option>
          </select>
        </label>
        {field("name", t(settings.name), "research", 10)}
        {field("label", t(settings.displayName), "Research agent", 14)}
        {field("url", "URL", "http://127.0.0.1:8001", 24)}
        {draft.port === "adk" && field("app", t(settings.adkApp), "research_agent", 14)}
        {field("tokenEnv", t(settings.adkTokenEnv), "RESEARCH_TOKEN", 16)}
        <button disabled={saving || !list} onClick={add}>
          {t(settings.add)}
        </button>
      </div>
      {draft.port === "agui" && (
        <label className="hint">
          <input type="checkbox" checked={draft.sendWorkspaceMcp} disabled={saving} onChange={(e) => setDraft({ ...draft, sendWorkspaceMcp: e.target.checked })} /> {t(settings.aguiSendMcp)}
        </label>
      )}
      {draft.port === "adk" && offHost && <div className="hint">{t(settings.adkOffHost)}</div>}
      {draft.port === "agui" &&
        aguiNotices(draft).map((k) => (
          <div key={k} className="hint">
            {t(k === "request" ? settings.aguiNoticeRequest : k === "token" ? settings.aguiNoticeToken : settings.aguiNoticeConfirm)}
          </div>
        ))}
      {error && <div className="error">{error}</div>}
      {changed && <div className="hint">{t(settings.adkSaved)}</div>}
    </SettingsCard>
  );
}
