import { Fragment, useEffect, useRef, useState } from "react";
import type { Queue, RunnerId, RunnerInfo, Schedule, Workspace } from "@switchboard/protocol";
import { api } from "../api.ts";
import { fmtUsd, RunnerPill } from "./ui.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";
import { effortLabel } from "../effortOptions.ts";
import { NIGHTLY_SHOWN, scheduledFacts, scheduleResultLine } from "../scheduleResult.ts";
import { claudeOnlyAction, SCHEDULE_ACTIONS, scheduleActionLabel } from "../scheduleActions.ts";
import { scheduleCreateInput, scheduleDraft, scheduleEditPatch, type ScheduleDraft } from "../scheduleEdit.ts";
import { jstDateTime } from "../time.ts";
import { listedRunners } from "../runners.ts";
import { t } from "../i18n.ts";
import { backlog as m } from "../i18n/backlog.ts";

/** Scheduler screen (#20): DAK-style nightly jobs, and the morning queue of what needs a person. */
export function Schedules(props: { workspaces: Workspace[]; runners: RunnerInfo[]; runnerOk: Set<RunnerId>; onOpenTask: (id: string) => void; onOpenSettings: () => void; onError: (msg: string) => void }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null); // a manual backlog-next that only asked for a promotion (#2479)
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [cron, setCron] = useState("0 3 * * *");
  // #4058: the newest nightly results first, the rest on a press (a phone showed 20 before the schedules)
  const [showAllNightly, setShowAllNightly] = useState(false);
  const savedCron = useRef("0 3 * * *");
  const [wsId, setWsId] = useState("");
  // A new schedule starts from 自動で始まる Task の既定 (設定, #832); empty model = the runner's CLI default
  const [runner, setRunner] = useState<RunnerId>("claude");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState(""); // #833, the same two levels as the model
  const [prompt, setPrompt] = useState("");
  const [action, setAction] = useState<Schedule["action"]>("prompt");
  const meta = props.workspaces.find((w) => w.kind === "meta");
  // backlog-next, secret-scan, insights, approval-window and ui-layers work on the meta workspace and take no prompt (#267, #775, #1838, #2046, #3353)
  const metaOnly = action !== "prompt";
  // insights runs Claude Code's own command, ui-layers a fixed instruction: the runner is claude whatever the form shows elsewhere (#1838, #3353)
  const insights = action === "insights";
  const onClaude = claudeOnlyAction(action);
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
        const bare = claudeOnlyAction(actionRef.current);
        savedDefaults.current = { runner: st.autoStart.runner, model: st.autoStart.model, effort: st.autoStart.effort };
        setRunner(bare ? "claude" : st.autoStart.runner);
        setModel(bare ? "" : st.autoStart.model);
        setEffort(bare ? "" : st.autoStart.effort);
        savedCron.current = st.newDefaults.scheduleCron; // 新規作成の既定 (#835)
        setCron(st.newDefaults.scheduleCron);
        setDefaultsReady(true);
      })
      .catch((e) => props.onError(t(m.defaultsReadFailed, { error: String(e.message ?? e) })));
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
        props.onError(t(m.budgetNonNegative, { budget }));
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
        setNotice("promotion" in t ? t.promotion : null);
      })
      .catch((e) => {
        load(); // a skipped backlog-next firing says why in the log
        props.onError(String(e.message ?? e));
      });

  return (
    <main className="main schedules">
      <section className="card">
        <div className="row head">
          <h5>{t(m.queueHeading)}</h5>
        </div>
        {queue && queue.waiting.length === 0 && queue.staged.length === 0 && queue.queued.length === 0 && <div className="muted">{t(m.noApprovals)}</div>}
        {queue?.waiting.map((w) => (
          <button key={w.taskId} className="row link" onClick={() => props.onOpenTask(w.taskId)}>
            <RunnerPill runner={w.runner} />
            <span className="t">{w.title}</span>
            <span className="m">{w.ask}</span>
          </button>
        ))}
        {queue?.queued.map((q) => (
          <button key={q.taskId} className="row link" onClick={() => props.onOpenTask(q.taskId)}>
            <RunnerPill runner={q.runner} />
            <span className="t">{q.title}</span>
            <span className="m">{t(m.queuedPosition, { n: q.position })}</span>
          </button>
        ))}
        {queue?.staged.map((s) => (
          <button key={s.taskId} className="row link" onClick={() => props.onOpenTask(s.taskId)}>
            <span className="t">{s.title}</span>
            <span className="m">{t(m.stagedWrites, { n: s.pending })}</span>
          </button>
        ))}
        {queue && queue.scheduled.length > 0 && (
          <>
            <h5 style={{ marginTop: 14 }}>{t(m.nightlyResults)}</h5>
            {(showAllNightly ? queue.scheduled : queue.scheduled.slice(0, NIGHTLY_SHOWN)).map((s) => (
              <button key={s.taskId} className="schedule-row nightly link" onClick={() => props.onOpenTask(s.taskId)}>
                <RunnerPill runner={s.runner} />
                <span className="schedule-body">
                  <span className="schedule-title">{s.title}</span>
                  <span className="schedule-facts">{scheduledFacts(s, fmtUsd(s.costUsd))}</span>
                </span>
              </button>
            ))}
            {queue.scheduled.length > NIGHTLY_SHOWN && (
              <button className="ghost link" onClick={() => setShowAllNightly(!showAllNightly)}>
                {showAllNightly ? t(m.nightlyFewer) : t(m.nightlyMore, { n: queue.scheduled.length - NIGHTLY_SHOWN })}
              </button>
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="row head">
          <h5>{t(m.schedulesHeading)}</h5>
          <button className="ghost" onClick={() => setShowNew((v) => !v)}>
            {showNew ? t(m.cancel) : t(m.add)}
          </button>
        </div>
        {showNew && (
          <div className="fields" style={{ marginBottom: 10 }}>
            <label>
              <span>{t(m.kind)}</span>
              <select
                value={action}
                onChange={(e) => {
                  const next = e.target.value as Schedule["action"];
                  const was = action;
                  setAction(next);
                  if (claudeOnlyAction(next)) {
                    setRunner("claude");
                    setModel("");
                    setEffort("");
                  } else if (claudeOnlyAction(was) && savedDefaults.current) {
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
              <span>{t(m.title)}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              <span>{t(m.cron)}</span>
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
              <span>{t(m.runner)}</span>
              <select
                value={defaultsReady ? (onClaude ? "claude" : runner) : ""}
                disabled={!defaultsReady || onClaude}
                onChange={(e) => {
                  setRunner(e.target.value as RunnerId);
                  setModel(""); // a model belongs to one runner
                  setEffort(""); // so does an effort
                }}
              >
                {!defaultsReady && <option value="">{t(m.loading)}</option>}
                {listedRunners(props.runners, runner).map((r) => (
                  <option key={r} value={r} disabled={!props.runnerOk.has(r)}>
                    {r}
                    {props.runnerOk.has(r) ? "" : t(m.notInstalled)}
                  </option>
                ))}
              </select>
            </label>
            <div className="row" style={{ alignItems: "center" }}>
              <ModelSelect runner={props.runners.find((r) => r.id === runner)} value={model} onChange={setModel} disabled={!defaultsReady} label={t(m.model)} title={t(m.modelTitle)} />
              <EffortSelect runner={props.runners.find((r) => r.id === runner)} value={effort} onChange={setEffort} disabled={!defaultsReady} label={t(m.effort)} title={t(m.effortTitle)} />
            </div>
            <label>
              <span>{t(m.budgetOptional)}</span>
              <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
            </label>
            {insights ? (
              <div className="muted" style={{ gridColumn: "1 / -1" }}>
                {t(m.insightsBefore)}
                <code>/insights</code>
                {t(m.insightsAfter)}
              </div>
            ) : action === "ui-layers" ? (
              <div className="muted" style={{ gridColumn: "1 / -1" }}>
                {t(m.uiLayersHint)}
              </div>
            ) : action === "secret-scan" ? (
              <div className="muted" style={{ gridColumn: "1 / -1" }}>
                {t(m.secretScanHint)}
              </div>
            ) : action === "backlog-next" ? (
              <>
                <div className="muted backlog-next-hint" style={{ gridColumn: "1 / -1" }}>
                  {t(m.backlogNextHint)}
                </div>
                <button className="ghost" onClick={props.onOpenSettings} style={{ gridColumn: "1 / -1" }}>{t(m.openSettings)}</button>
              </>
            ) : action === "prompt" ? (
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder={t(m.promptPlaceholder)} style={{ gridColumn: "1 / -1" }} />
            ) : null}
            <button className="pri" disabled={busy || !defaultsReady || !title.trim() || (metaOnly ? !meta : !prompt.trim()) || (onClaude && !props.runnerOk.has("claude"))} title={onClaude && !props.runnerOk.has("claude") ? t(m.claudeMissing) : undefined} onClick={() => void create()} style={{ gridColumn: "1 / -1" }}>
              {t(m.create)}
            </button>
          </div>
        )}
        {schedules.length === 0 && !showNew && <div className="muted">{t(m.noSchedules)}</div>}
        {schedules.map((s) => (
          <Fragment key={s.id}>
          <div className="schedule-row" data-schedule={s.id}>
            <RunnerPill runner={s.runner} />
            <span className="schedule-body">
              <span className="schedule-title">{s.title}</span>
              <span className="schedule-facts">
                {/* outside the title's two-line clip, so a long title does not hide it */}
                {!s.enabled && <span className="tag warn">{t(m.paused).trim()}</span>}
                {s.action !== "prompt" && <span className="tag">{scheduleActionLabel(s.action)}</span>}
                <span>{s.model || t(m.cliDefault)}</span>
                <span>{t(m.effortLine, { effort: effortLabel(s.effort, props.runners.find((r) => r.id === s.runner)) })}</span>
                <span className="mono">{s.cron}</span>
                <span>{s.nextRunAt ? t(m.nextRun, { at: jstDateTime(s.nextRunAt) }) : t(m.noNextRun)}</span>
                {scheduleResultLine(s) && <span>{scheduleResultLine(s)}</span>}
              </span>
            </span>
            {/* #4058: the same buttons in the same order on every row; 削除 looks like what it does */}
            <span className="schedule-actions">
              <button className="small" onClick={() => void runNow(s)}>
                {t(m.runNow)}
              </button>
              <button className="small" onClick={() => void toggle(s)}>
                {s.enabled ? t(m.pause) : t(m.resume)}
              </button>
              <button
                className="small"
                disabled={busy} // a pending save would otherwise close the form opened meanwhile
                onClick={() => {
                  setEditingId(s.id);
                  setDraft(scheduleDraft(s));
                }}
              >
                {t(m.edit)}
              </button>
              <button className="small danger" onClick={() => void remove(s)}>
                {t(m.delete)}
              </button>
            </span>
          </div>
          {editingId === s.id && draft && (
            <div className="fields schedule-edit" style={{ marginBottom: 10 }}>
              <div className="muted" style={{ gridColumn: "1 / -1" }}>
                {t(m.editKind)}
                <span className="tag">{scheduleActionLabel(s.action)}</span>
                {t(m.editKindAfter)}
              </div>
              <label>
                <span>{t(m.title)}</span>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label>
                <span>{t(m.cron)}</span>
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
                <span>{t(m.runner)}</span>
                <select value={draft.runner} disabled={claudeOnlyAction(s.action)} title={claudeOnlyAction(s.action) ? t(m.runsOnClaude, { kind: scheduleActionLabel(s.action) }) : undefined} onChange={(e) => setDraft({ ...draft, runner: e.target.value as RunnerId, model: "", effort: "" })}>
                  {listedRunners(props.runners, s.runner).map((r) => (
                    <option key={r} value={r} disabled={!props.runnerOk.has(r) && r !== s.runner}>
                      {r}
                      {props.runnerOk.has(r) ? "" : t(m.notInstalled)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row" style={{ alignItems: "center" }}>
                <ModelSelect runner={props.runners.find((r) => r.id === draft.runner)} value={draft.model} onChange={(v) => setDraft({ ...draft, model: v })} label={t(m.model)} title={t(m.modelTitle)} />
                <EffortSelect runner={props.runners.find((r) => r.id === draft.runner)} value={draft.effort} onChange={(v) => setDraft({ ...draft, effort: v })} label={t(m.effort)} title={t(m.effortTitle)} />
              </div>
              <label>
                <span>{t(m.budgetEmptyNone)}</span>
                <input value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: e.target.value })} inputMode="decimal" />
              </label>
              {s.action === "prompt" && <textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} rows={3} placeholder={t(m.promptPlaceholder)} style={{ gridColumn: "1 / -1" }} />}
              <button className="pri" disabled={busy} onClick={() => void save(s)}>
                {t(m.save)}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setEditingId(null);
                  setDraft(null);
                }}
              >
                {t(m.cancel)}
              </button>
            </div>
          )}
          </Fragment>
        ))}
      </section>

      {notice && <div className="muted">{notice}</div>}
      {log.length > 0 && (
        <section className="card">
          <h5>{t(m.log)}</h5>
          <pre className="diff">{log.join("\n")}</pre>
        </section>
      )}
    </main>
  );
}
