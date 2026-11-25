import type { ReviewRunnerChoice, RunnerId, RunnerInfo, Settings, SettingsPatch } from "@switchboard/protocol";
import { t, type Msg } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";
import { runnerDefaultLabel, type JobRow } from "../runnerSettings.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { EffortSelect } from "./EffortSelect.tsx";

/** The choices of レビューのランナー, in the order shown: the default first. */
const REVIEW_RUNNER_LABELS: Record<ReviewRunnerChoice, Msg> = { other: settings.reviewRunnerOther, same: settings.reviewRunnerSame };

/** The choices of 再チェック・マージ後の監査, in the order shown: "" (unset, the default) follows the review setting. */
const RECHECK_RUNNER_LABELS: Record<ReviewRunnerChoice | "", Msg> = { "": settings.recheckRunnerReview, other: settings.recheckRunnerOther, same: settings.recheckRunnerSame };

/** A row of the review's in 「どの仕事を」: its runner, the recheck's runner, a runner's review model. Each saves its own key, not by `jobPatchOf`, and says its own default. */
export const isReviewRow = (j: JobRow) => j.id === "review" || j.id === "recheck" || j.id.startsWith("reviewModel:");

/** The cells right of a review row's name (`isReviewRow`), in the job row's grid. */
export function ReviewJobCells(props: { row: JobRow; s: Settings; d: Settings; info: (id: RunnerId) => RunnerInfo | undefined; saving: boolean; save: (patch: SettingsPatch) => Promise<void> }) {
  const { row: j, s, d, saving, save } = props;
  if (j.id === "review" || j.id === "recheck") {
    const review = j.id === "review";
    const labels = (review ? REVIEW_RUNNER_LABELS : RECHECK_RUNNER_LABELS) as Record<string, Msg>;
    return (
      <>
        {/* the recheck's "" = unset (it follows the review setting): choosing it sends null */}
        <select className="mode" value={review ? s.reviewRunner : (s.recheckRunner ?? "")} disabled={saving} aria-label={`${t(j.label)}: ${t(settings.runner)}`} onChange={(e) => void (review ? save({ reviewRunner: e.target.value as ReviewRunnerChoice }) : save({ recheckRunner: (e.target.value || null) as ReviewRunnerChoice | null }))}>
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
        <span className="muted" style={{ gridColumn: "span 2" }}>
          {t(settings.defaultValue, { value: t(labels[review ? d.reviewRunner : (d.recheckRunner ?? "")]!) })}
          <span style={{ display: "block" }}>{t(review ? settings.reviewModelBelow : settings.recheckSeparate)}</span>
        </span>
      </>
    );
  }
  // a runner's review model: the runner is the row's own, only its model and effort change
  const runner = props.info(j.runner as RunnerId);
  const name = t(j.label, { runner: j.runner });
  return (
    <>
      <span className="muted">{j.runner}</span>
      <ModelSelect runner={runner} value={j.model} onChange={(m) => void save({ reviewModel: { [j.runner]: m || null } })} label={t(settings.rowModel)} bare emptyLabel={runnerDefaultLabel("model", runner)} disabled={saving} title={`${name}: ${t(settings.rowModel)}`} />
      <EffortSelect runner={runner} value={j.effort} onChange={(e) => void save({ reviewEffort: { [j.runner]: e || null } })} label={t(settings.rowEffort)} bare emptyLabel={runnerDefaultLabel("effort", runner)} disabled={saving} title={`${name}: ${t(settings.rowEffort)}`} />
    </>
  );
}
