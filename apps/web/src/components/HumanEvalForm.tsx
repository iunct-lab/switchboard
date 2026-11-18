import { useState } from "react";
import type { HumanAnswers, HumanEval, TaskEvals } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { HUMAN_QUESTIONS } from "../evals.ts";
import { t } from "../i18n.ts";
import { insights as m } from "../i18n/insights.ts";

/** The part of a saved `HumanEval` the form shows (`by` / `ts` are not its to read). */
export type HumanEvalValues = Pick<HumanEval, "rating" | "comment" | "intent" | "complexity" | "detour" | "value">;

/** The key that resets the form when its task or its saved row changes: one place, so a field added to `HumanEval` is added once. */
export const humanEvalKey = (taskId: string, human: HumanEvalValues | null) =>
  `${taskId}:${human?.rating ?? ""}:${human?.intent ?? ""}:${human?.complexity ?? ""}:${human?.detour ?? ""}:${human?.value ?? ""}:${human?.comment ?? ""}`;

/**
 * The person's own evaluation of a Task: the four value questions, a 1-5 rating, a note, saved in one PUT. Every answer
 * is optional; a saved one is shown selected, and tapping it again clears it. The caller keys it with `humanEvalKey`.
 */
export function HumanEvalForm(props: { taskId: string; human: HumanEvalValues | null; onSaved: (e: TaskEvals) => void }) {
  const [rating, setRating] = useState<number | null>(props.human?.rating ?? null);
  const [comment, setComment] = useState(props.human?.comment ?? "");
  const [answers, setAnswers] = useState<HumanAnswers>({ intent: props.human?.intent, complexity: props.human?.complexity, detour: props.human?.detour, value: props.human?.value });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<TaskEvals>) => {
    setBusy(true);
    setErr(null);
    fn()
      .then(props.onSaved)
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };
  const chip = (on: boolean, label: string, onClick: () => void, extra?: { title?: string; aria?: string }) => (
    <button key={label} className={on ? "pri" : "ghost"} disabled={busy} onClick={onClick} title={extra?.title} aria-label={extra?.aria} aria-pressed={on}>
      {label}
    </button>
  );
  return (
    <div className="human-eval-form">
      {HUMAN_QUESTIONS.map((q) => (
        <div key={q.key} style={{ margin: "6px 0" }}>
          <div>{q.question}</div>
          <div className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-start" }}>
            {q.options.map((o) => chip(answers[q.key] === o.value, o.label, () => setAnswers((a) => ({ ...a, [q.key]: a[q.key] === o.value ? undefined : o.value }))))}
          </div>
        </div>
      ))}
      <div style={{ margin: "6px 0" }}>
        <div>{t(m.qRating)}</div>
        <div className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-start" }}>
          {[1, 2, 3, 4, 5].map((n) => chip(rating === n, String(n), () => setRating(n), { title: `${n} / 5`, aria: t(m.formRatingN, { n }) }))}
        </div>
      </div>
      <div className="row" style={{ alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "flex-start" }}>
        <input value={comment} maxLength={1000} placeholder={t(m.formComment)} disabled={busy} onChange={(e) => setComment(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <button disabled={busy || rating === null} onClick={() => run(() => api.setHumanEval(props.taskId, { rating: rating!, comment, ...answers }))}>
          {t(m.formSave)}
        </button>
        {props.human && (
          <button className="ghost" disabled={busy} onClick={() => run(() => api.clearHumanEval(props.taskId))}>
            {t(m.formClear)}
          </button>
        )}
      </div>
      {err && <div className="hint warn">{err}</div>}
    </div>
  );
}
