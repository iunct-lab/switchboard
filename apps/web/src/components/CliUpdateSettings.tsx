import { useCallback, useEffect, useState } from "react";
import type { CliRollbackResult, CliUpdateOutcome, CliUpdateRow, CliUpdateRunner, CliUpdateRunnerState, CliUpdateSettings as CliUpdateValues, CliUpdateState } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { jstStamp } from "../time.ts";
import { t } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";
import type { NumberField } from "./Settings.tsx";

const OUTCOME = {
  installed: { text: settings.cliOutInstalled, tone: "ok" },
  refused: { text: settings.cliOutRefused, tone: "bad" },
  waiting: { text: settings.cliOutWaiting, tone: "wait" },
  untested: { text: settings.cliOutUntested, tone: "bad" },
  "rolled-back": { text: settings.cliOutRolledBack, tone: "ok" },
} as const satisfies Record<CliUpdateOutcome, { text: { ja: string; en: string }; tone: string }>;

/** The first 8 characters of a sha256 (the whole value is in the record's title), or nothing when the row has none. */
export const shaHead = (sha: string | null): string => (sha ? sha.slice(0, 8) : "—");

/** When the runner's current version went in: the newest installed / rolled-back row that names it, else null (the installer's own). */
export function currentSince(records: CliUpdateRow[], runner: CliUpdateRunner, current: string | null): number | null {
  const row = records.find((r) => r.runner === runner && r.toVersion === current && (r.outcome === "installed" || r.outcome === "rolled-back"));
  return row ? row.at : null;
}

/** The record, newest first: one block per row (the columns side by side on a wide screen, the lines stacked on a narrow one). */
export function CliUpdateRecords(props: { records: CliUpdateRow[] }) {
  if (props.records.length === 0) return <div className="muted">{t(settings.cliNoRecords)}</div>;
  return (
    <div className="cli-records" role="table" aria-label={t(settings.cliRecordHead)}>
      {props.records.map((r) => {
        const o = OUTCOME[r.outcome];
        return (
          <div key={r.id} className="cli-record" role="row" data-outcome={r.outcome}>
            <span className="cli-rec-at hint" role="cell">{jstStamp(r.at)}</span>
            <span className="cli-rec-runner" role="cell">{r.runner}</span>
            <span className="cli-rec-version" role="cell">{r.fromVersion && r.fromVersion !== r.toVersion ? `${r.fromVersion} → ${r.toVersion}` : r.toVersion}</span>
            <span className={`cli-rec-out cli-out-${o.tone}`} role="cell">{t(o.text)}</span>
            <code className="cli-rec-sha" role="cell" title={r.sha256 ?? undefined}>{shaHead(r.sha256)}</code>
            <span className="cli-rec-reason hint" role="cell">{r.by === "person" ? `${t(settings.cliByPerson)}。${r.reason}` : r.reason}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One runner's line: the version it runs now, the one before, and the button that goes back to it. */
export function CliRunnerRow(props: { state: CliUpdateRunnerState; since: number | null; busy: boolean; onRollback: () => void }) {
  const s = props.state;
  return (
    <div className="cli-runner" data-runner={s.runner}>
      <div className="cli-runner-main">
        <b>{s.runner}</b>
        <span>{s.current === null ? t(settings.cliCurrentUnknown) : s.current}</span>
        {props.since !== null && <span className="hint">{t(settings.cliSince, { at: jstStamp(props.since) })}</span>}
        {s.previous !== null ? (
          <>
            <span className="hint">{t(settings.cliPrevious, { version: s.previous })}</span>
            {!s.previousGone && (
              <button disabled={props.busy || s.rollbackWaiting} onClick={props.onRollback}>
                {t(settings.cliRollbackTo, { version: s.previous })}
              </button>
            )}
          </>
        ) : (
          s.current !== null && <span className="hint">{t(settings.cliNoPrevious)}</span>
        )}
      </div>
      {s.previous !== null && s.previousGone && <div className="hint">{t(settings.cliPreviousGone, { version: s.previous })}</div>}
      {s.rollbackWaiting && <div className="hint">{t(settings.cliRollbackWaiting)}</div>}
      {s.waiting && <div className="hint">{t(settings.cliWaiting, { version: s.waiting.version, reason: s.waiting.reason })}</div>}
      {s.note && <div className="hint">{s.note}</div>}
      {s.checkedAt !== null && <div className="hint">{t(settings.cliChecked, { at: jstStamp(s.checkedAt) })}</div>}
    </div>
  );
}

/** The text a rollback's answer is shown as. */
export function rollbackNotice(runner: string, r: CliRollbackResult): string {
  if (r.ok && r.waiting) return t(settings.cliRollbackQueued, { runner, version: r.to ?? "—" });
  if (r.ok) return t(settings.cliRollbackDone, { runner, version: r.to ?? "—" });
  return t(settings.cliRollbackRefused, { runner, reason: r.reason });
}

/**
 * Settings → ランナー → CLI の更新: where each host CLI stands (with the button back to its previous version), the four values of
 * the update, and the record of what went in or was kept out. Read when the card opens and after a rollback, never polled.
 */
export function CliUpdateSettings(props: { value: CliUpdateValues; def: CliUpdateValues; disabled: boolean; Field: typeof NumberField; onSave: (patch: Partial<CliUpdateValues>) => Promise<void>; onError: (msg: string) => void }) {
  const [state, setState] = useState<CliUpdateState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const { onError } = props;
  const load = useCallback(
    () =>
      api
        .cliUpdates()
        .then((s) => (setState(s), setUnreadable(null)))
        .catch((e) => {
          const msg = t(settings.cliUpdateUnreadable, { error: String(e.message ?? e) });
          setUnreadable(msg);
          onError(msg);
        }),
    [onError],
  );
  useEffect(() => void load(), [load]);
  const rollback = async (s: CliUpdateRunnerState) => {
    if (s.previous === null || !confirm(t(settings.cliRollbackConfirm, { runner: s.runner, version: s.previous }))) return;
    setBusy(true);
    try {
      setNotice(rollbackNotice(s.runner, await api.rollbackCli(s.runner)));
    } catch (e) {
      // a refusal (409) carries its reason in the body
      const reason = (e as { body?: { reason?: string } }).body?.reason;
      setNotice(reason ? rollbackNotice(s.runner, { ok: false, waiting: false, to: null, reason }) : t(settings.cliRollbackFailed, { error: String((e as Error).message ?? e) }));
    } finally {
      setBusy(false);
    }
    await load();
  };
  const { Field, value: v, def: d } = props;
  return (
    <section className="card cli-update">
      <h5>{t(settings.cliUpdate)}</h5>
      <div className="muted">{t(settings.cliUpdateHint)}</div>
      {!state ? (
        <div className="muted">{unreadable ?? t(settings.cliUpdateLoading)}</div>
      ) : !state.enabled ? (
        <div className="muted">{t(settings.cliUpdateOff)}</div>
      ) : (
        <>
          {state.runners.map((s) => (
            <CliRunnerRow key={s.runner} state={s} since={currentSince(state.records, s.runner, s.current)} busy={busy} onRollback={() => void rollback(s)} />
          ))}
          <div className="hint">{t(settings.cliRollbackNote)}</div>
          {notice && <div role="status">{notice}</div>}
        </>
      )}
      <Field label={t(settings.cliCheckMinutes)} unit={t(settings.unitMinutes)} hint={t(settings.cliCheckMinutesHint)} value={v.checkMinutes} def={d.checkMinutes} min={1} max={1440} disabled={props.disabled} onSave={(n) => props.onSave({ checkMinutes: n })} />
      <Field label={t(settings.cliWaitHours)} unit={t(settings.unitHours)} hint={t(settings.cliWaitHoursHint)} value={v.waitHours} def={d.waitHours} min={0} max={720} disabled={props.disabled} onSave={(n) => props.onSave({ waitHours: n })} />
      <div className="runner-row">
        <span className="runner-row-name">{t(settings.cliMissingSignature)}</span>
        <div className="runner-row-control">
          <select className="mode" value={v.missingSignature} disabled={props.disabled} aria-label={t(settings.cliMissingSignature)} onChange={(e) => void props.onSave({ missingSignature: e.target.value as CliUpdateValues["missingSignature"] })}>
            <option value="refuse">{t(settings.cliMissingRefuse)}</option>
            <option value="allow">{t(settings.cliMissingAllow)}</option>
          </select>
          <span className="hint">{t(settings.cliMissingSignatureHint)}</span>
        </div>
      </div>
      <div className="runner-row">
        <span className="runner-row-name">{t(settings.cliSmoke)}</span>
        <div className="runner-row-control">
          <select className="mode" value={v.smoke} disabled={props.disabled} aria-label={t(settings.cliSmoke)} onChange={(e) => void props.onSave({ smoke: e.target.value as CliUpdateValues["smoke"] })}>
            <option value="turn">{t(settings.cliSmokeTurn)}</option>
            <option value="version">{t(settings.cliSmokeVersion)}</option>
          </select>
        </div>
      </div>
      <h5>{t(settings.cliRecords)}</h5>
      {state && <CliUpdateRecords records={state.records} />}
    </section>
  );
}
