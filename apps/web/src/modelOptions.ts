import type { RunnerInfo } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";

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
