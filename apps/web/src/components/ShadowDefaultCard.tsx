import type { ReactNode } from "react";
import type { RunnerId } from "@switchboard/protocol";
import { t } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";
import { runnerLabel, shadowCandidates } from "../runners.ts";

/**
 * The body of the 並走の既定 card: the runner a new Task also runs on at the same time, or しない. The choices come from `shadowCandidates`, the
 * same function the per-kind 並走 select uses; a saved runner that is not a candidate now (not detected) stays, named as such.
 */
export function ShadowDefaultCard(props: { value: RunnerId | null; listed: RunnerId[]; runnerOk: Set<RunnerId>; disabled: boolean; onChange: (runner: RunnerId | null) => void; note: ReactNode; reset: ReactNode}) {
  const candidates = shadowCandidates(props.listed, props.runnerOk);
  const missing = props.value && !candidates.includes(props.value) ? props.value : null;
  return (
    <>
      <select className="mode" value={props.value ?? ""} disabled={props.disabled} aria-label={t(settings.shadowDefault)} onChange={(e) => props.onChange((e.target.value || null) as RunnerId | null)}>
        <option value="">{t(settings.shadowDefaultOff)}</option>
        {candidates.map((r) => (
          <option key={r} value={r}>
            {runnerLabel(r)}
          </option>
        ))}
        {missing && <option value={missing}>{t(settings.shadowUndetected, { runner: runnerLabel(missing) })}</option>}
      </select>
      <div className="muted">{t(settings.shadowDefaultHint)}</div>
      {props.note}
      {props.reset}
    </>
  );
}
