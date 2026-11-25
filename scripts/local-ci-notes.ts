/**
 * The lines local-ci and the tag CI add to a result that do not decide it: the seconds of the type check and of bun test
 * (`stepSeconds`, the pass mark's `local-ci-seconds` line), the tests that ran (`local-ci-tests`), perf-ratchet's verdict
 * as printed, the seconds over the `local` ceilings, and the line of a build off the host that could not be started.
 * The pass or fail, the mark's head and base and what is subtracted stay in scripts/local-ci.ts (merge-gate's
 * `security:gates`); this file is a support file (`security:gate-support`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { judgeDurations, type Budgets } from "./perf-ratchet.ts";
import type { StepResult } from "./local-ci.ts";

/** A pass's line after the first line: the type check's and bun test's seconds as JSON, hidden in GitHub's view. */
export const LOCAL_CI_SECONDS = /^<!-- local-ci-seconds (\{.*\}) -->$/m;

/** The type check's and bun test's seconds of a run. */
export interface StepSeconds { typecheck: number; test: number }

/** The steps whose seconds a pass carries, by their name (a narrowed `bun test` has another `run`). */
export const SECONDS_STEPS: Record<keyof StepSeconds, string> = { typecheck: "bun run typecheck", test: "bun test" };

/** The seconds of the two steps, to one decimal; either missing throws (the CI changed them: the seconds would silently go). */
export function stepSeconds(results: StepResult[]): StepSeconds {
  const of = (run: string) => {
    const r = results.find((x) => x.name === run);
    if (!r) throw new Error(`CI の手順に \`${run}\` が無い（stepSeconds）`);
    return Math.round(r.seconds * 10) / 10;
  };
  return { typecheck: of(SECONDS_STEPS.typecheck), test: of(SECONDS_STEPS.test) };
}

/** The seconds a result's body carries, or undefined when it has none. */
export function markerSeconds(body: string): StepSeconds | undefined {
  const m = LOCAL_CI_SECONDS.exec(body);
  if (!m) return undefined;
  const v = JSON.parse(m[1]!) as Partial<StepSeconds>;
  return typeof v.typecheck === "number" && typeof v.test === "number" ? { typecheck: v.typecheck, test: v.test } : undefined;
}

/** A result's machine line of its tests: how many files ran, null = all of them, of how many. */
export const LOCAL_CI_TESTS = /^<!-- local-ci-tests (\{.*\}) -->$/m;

/** The tests a result's body carries, or undefined when it has none (a run from before the tests were narrowed, `--all`). */
export function testsOf(body: string): { ran: number | null; total: number } | undefined {
  const m = LOCAL_CI_TESTS.exec(body);
  if (!m) return undefined;
  const v = JSON.parse(m[1]!) as { ran?: unknown; total?: unknown };
  return (typeof v.ran === "number" || v.ran === null) && typeof v.total === "number" ? { ran: v.ran, total: v.total } : undefined;
}

/** What perf-ratchet's check said: its `ceilings:` environment and its over / improved / raised / grew lines as printed (grew = the bundle 1% or more above main's tip). `unknown` = none of the four (the bench failed, or the check stopped before judging). */
export interface PerfVerdict { env: string | null; over: string[]; improved: string[]; raised: string[]; grew: string[]; unknown: boolean }

export function perfVerdict(output: string): PerfVerdict {
  const lines = output.split("\n");
  const of = (kind: string) => lines.filter((l) => l.startsWith(`${kind}: `));
  const [over, improved, raised, grew] = [of("over"), of("improved"), of("raised"), of("grew")];
  const env = lines.map((l) => /^ceilings: (\S+)$/.exec(l)?.[1]).find(Boolean) ?? null;
  return { env, over, improved, raised, grew, unknown: over.length + improved.length + raised.length + grew.length === 0 };
}

/** The lines of a build that could not be started, for the log: what happened, then what sb-offload printed. */
export const notStartedLines = (n: { code: number; output: string }): string => `外のビルドを始められなかった（exit ${n.code}）${n.output.trim() ? `\n${n.output.trim()}` : ""}`;

/** The seconds over the `local` ceilings of the budget in `dir`, as `over:` lines (failLines' form); none without that budget. */
export async function durationOver(dir: string, seconds: StepSeconds): Promise<string[]> {
  const path = join(dir, "scripts/perf-budget.json");
  if (!existsSync(path)) return [];
  const { local } = (await Bun.file(path).json()) as Partial<Budgets>;
  return judgeDurations(seconds, local ?? { journeys: {} }).map((i) => `over: ${i.key} = ${i.value} > ceiling ${i.ceiling}`);
}
