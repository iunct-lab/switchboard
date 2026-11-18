import { useState } from "react";
import type { EvalStage, RequestEval } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { EVAL_STAGES, toggleStage } from "../evals.ts";
import { t } from "../i18n.ts";
import { insights as m } from "../i18n/insights.ts";

/** The key that resets the form when its request or its saved row changes. */
export const requestEvalKey = (workspaceId: string, number: number, human: RequestEval | null) => `${workspaceId}:${number}:${human?.ts ?? ""}`;

/**
 * The person's evaluation of a closed request with its PBIs as one unit: the stages that went wrong (several, or
 * 外れていない alone), a 1-5 rating and a note, saved in one PUT; a saved one can be changed or cleared. Never required:
 * nothing waits for it. The caller keys it with `requestEvalKey` and reads the summary again on `onSaved`.
 */
export function RequestEvalForm(props: { workspaceId: string; number: number; human: RequestEval | null; onSaved: (human: RequestEval | null) => void }) {
  const [stages, setStages] = useState<EvalStage[]>(props.human?.stages ?? []);
  const [rating, setRating] = useState<number | null>(props.human?.rating ?? null);
  const [comment, setComment] = useState(props.human?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<RequestEval | null>) => {
    setBusy(true);
    setErr(null);
    fn()
      .then(props.onSaved)
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };
  const chip = (on: boolean, label: string, onClick: () => void, aria?: string) => (
    <button key={label} className={on ? "pri" : "ghost"} disabled={busy} onClick={onClick} aria-label={aria} aria-pressed={on}>
      {label}
    </button>
  );
  return (
    <div className="human-eval-form">
      <div style={{ margin: "6px 0" }}>
        <div>{t(m.reqStagesQ)}</div>
        <div className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-start" }}>
          {EVAL_STAGES.map((s) => chip(stages.includes(s.value), s.label, () => setStages((cur) => toggleStage(cur, s.value))))}
        </div>
      </div>
      <div style={{ margin: "6px 0" }}>
        <div>{t(m.qRating)}</div>
        <div className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-start" }}>
          {[1, 2, 3, 4, 5].map((n) => chip(rating === n, String(n), () => setRating(n), t(m.formRatingN, { n })))}
        </div>
      </div>
      <div className="row" style={{ alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "flex-start" }}>
        <input value={comment} maxLength={1000} placeholder={t(m.formComment)} disabled={busy} onChange={(e) => setComment(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <button disabled={busy || rating === null || stages.length === 0} onClick={() => run(() => api.setRequestEval(props.workspaceId, props.number, { stages, rating: rating!, comment }))}>
          {t(m.formSave)}
        </button>
        {props.human && (
          <button className="ghost" disabled={busy} onClick={() => run(() => api.clearRequestEval(props.workspaceId, props.number).then(() => null))}>
            {t(m.formClear)}
          </button>
        )}
      </div>
      {err && <div className="hint warn">{err}</div>}
    </div>
  );
}
