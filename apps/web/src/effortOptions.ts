import type { RunnerInfo } from "@switchboard/protocol";
import type { ModelChoice } from "./modelOptions.ts";

/**
 * The choices of a thinking-effort select (#833): the CLI's own default first, then the runner's list, then the current
 * value when it is not on the list (saved by a version that listed it), so it still shows what is saved.
 */
export function effortOptions(runner: Pick<RunnerInfo, "efforts"> | undefined, current: string): ModelChoice[] {
  const efforts = runner?.efforts ?? [];
  const out: ModelChoice[] = [{ value: "", label: "CLI 既定" }, ...efforts.map((e) => ({ value: e.value, label: e.label }))];
  if (current && !efforts.some((e) => e.value === current)) out.push({ value: current, label: current });
  return out;
}

/** How a task's effort reads (#833): empty is the CLI default; a listed one by its label; anything else as it is. */
export function effortLabel(effort: string | null, runner?: Pick<RunnerInfo, "efforts">): string {
  if (!effort) return "CLI 既定";
  return runner?.efforts.find((e) => e.value === effort)?.label ?? effort;
}
