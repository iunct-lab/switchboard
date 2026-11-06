import type { RunnerInfo } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";
import { settings } from "./i18n/settings.ts";

export interface ModelChoice {
  /** "" = leave the model to the CLI. */
  value: string;
  label: string;
}

/**
 * The choices of a model select (#155): the CLI's own default first — named, so an empty model is never a surprise —
 * then the runner's list, then the current value when it is not on the list (typed by hand, or the full id the runner
 * reported for a running task).
 */
export function modelOptions(runner: Pick<RunnerInfo, "models" | "cliDefaultModel"> | undefined, current: string): ModelChoice[] {
  const models = runner?.models ?? [];
  const out: ModelChoice[] = [{ value: "", label: runner?.cliDefaultModel ? t(home.cliDefaultNamed, { model: runner.cliDefaultModel }) : t(home.cliDefault) }];
  for (const m of models) out.push({ value: m.value, label: t(home.modelChoice, { label: m.label, value: m.value }) });
  if (current && !models.some((m) => m.value === current)) out.push({ value: current, label: current });
  return out;
}

/**
 * The choices of 実装's Task ごとのモデル（試験, #2769): 同じ ("" = the Task's own model does each Task) first, then the
 * runner's list; a saved value no longer on the list stays, marked so.
 */
export function taskModelOptions(runner: Pick<RunnerInfo, "models"> | undefined, current: string): ModelChoice[] {
  const models = runner?.models ?? [];
  const out: ModelChoice[] = [{ value: "", label: t(settings.taskModelSame) }];
  for (const m of models) out.push({ value: m.value, label: t(settings.taskModelChoice, { label: m.label }) });
  if (current && !models.some((m) => m.value === current)) out.push({ value: current, label: t(settings.taskModelMissing, { value: current }) });
  return out;
}
