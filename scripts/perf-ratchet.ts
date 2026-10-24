/**
 * The CI ratchet on the counts of `bun scripts/perf-bench.ts --json` (#638): the ceilings in scripts/perf-budget.json only
 * go down.
 *   bun scripts/perf-ratchet.ts check <result.json> [--env github|local]    exit 1 if a count is over its ceiling, a count
 *                                        is better than its ceiling (lower it in the same PR), or a ceiling is above main's
 *   bun scripts/perf-ratchet.ts update <result.json> [--env github|local]   lowers the ceilings the result beats; never
 *                                        raises one
 * The budget has one set of ceilings per environment (#644): `github` (Actions' ubuntu-latest Chrome) and `local` (the
 * host's Chromium, which local-ci uses). The same code draws a frame differently on a faster machine, so the counts differ
 * between the two by more than the bands. The environment is `github` when GITHUB_ACTIONS=true (local-ci sets CI=true but
 * not that), else `local`; --env picks it, e.g. to lower `github` from a result taken from Actions.
 * Times (msMedian / msP90) are never compared: they wobble on a shared machine (docs/design/perf.md).
 * The counts that wobble (requests / layoutCount / recalcStyleCount ±1, layoutShift in its low digits — as medians of
 * `--runs 5`; a single run moves more) carry a fixed band: a ceiling is a measured value + the band, a count is over above
 * the ceiling and better below ceiling − 2 × band (more than a band below the measured value: a new low of the same code's
 * wobble is not an improvement, or every run that finds one would fail an unrelated PR). Fixed per count, not a setting: the band is how much the same code moves,
 * not how much worse a change may be.
 */
import { join } from "node:path";

export interface Budget {
  journeys: Record<string, { requests: number; layoutCount?: number; recalcStyleCount: number; layoutShift?: number }>;
  bundle: { js: number; css: number };
}
export interface Item { key: string; value: number; ceiling: number }
export const ENVS = ["github", "local"] as const;
export type Env = (typeof ENVS)[number];
export type Budgets = Record<Env, Budget>;

/** The environment whose ceilings apply: --env, else `github` in Actions, else `local`. */
export function envOf(flag: string | undefined, env: Record<string, string | undefined> = process.env): Env {
  if (flag === undefined) return env.GITHUB_ACTIONS === "true" ? "github" : "local";
  if (!(ENVS as readonly string[]).includes(flag)) throw new Error(`--env is one of ${ENVS.join(" / ")}, not ${flag}`);
  return flag as Env;
}

export const BUDGET_PATH = join(import.meta.dir, "perf-budget.json");
/** How much the same code moves from run to run (docs/design/perf.md の「数の意味」). */
const BAND: Record<string, number> = { requests: 1, layoutCount: 1, recalcStyleCount: 1, layoutShift: 0.03, js: 0, css: 0 };
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Every ceiling as `journeys.<name>.<count>` / `bundle.<js|css>` → value. */
function flat(b: Budget): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, counts] of Object.entries(b.journeys)) for (const [k, v] of Object.entries(counts)) out.set(`journeys.${name}.${k}`, v);
  for (const [k, v] of Object.entries(b.bundle)) out.set(`bundle.${k}`, v);
  return out;
}
const band = (key: string) => {
  const b = BAND[key.split(".").at(-1)!];
  if (b === undefined) throw new Error(`no band for ${key}`);
  return b;
};

/** Compares a perf-bench result with the ceilings. A ceiling with no value in the result throws (a renamed journey or count). */
export function judge(result: Budget, budget: Budget): { over: Item[]; improved: Item[] } {
  const values = flat(result);
  const over: Item[] = [];
  const improved: Item[] = [];
  for (const [key, ceiling] of flat(budget)) {
    const value = values.get(key);
    if (value === undefined) throw new Error(`the result has no ${key}`);
    if (value > ceiling) over.push({ key, value, ceiling });
    else if (value < round4(ceiling - 2 * band(key))) improved.push({ key, value, ceiling });
  }
  return { over, improved };
}

/** The ceilings above main's, in every environment — not only the one measured, so a raise of `local` fails in Actions too
 * (a new key or environment is not a raise). Raising one is the user's call: CI fails and they merge by hand. */
export function raisedAgainst(budgets: Budgets, base: Partial<Budgets>): Item[] {
  return ENVS.flatMap((env) => {
    const was = base[env] ? flat(base[env]) : new Map<string, number>();
    return [...flat(budgets[env])].flatMap(([key, ceiling]) => {
      const prev = was.get(key);
      return prev !== undefined && ceiling > prev ? [{ key: `${env}.${key}`, value: ceiling, ceiling: prev }] : [];
    });
  });
}

/** The budget with each beaten ceiling (`improved` of judge) lowered to the value + its band. Never raises one. */
export function lowered(improved: Item[], budget: Budget): Budget {
  const next = structuredClone(budget);
  for (const { key, value } of improved) {
    const [group, name, count] = key.split(".") as [string, string, string?];
    const v = round4(value + band(key));
    if (group === "journeys") next.journeys[name]![count as keyof Budget["journeys"][string]] = v;
    else next.bundle[name as keyof Budget["bundle"]] = v;
  }
  return next;
}

/** main's budgets, or why there are none (no origin/main in a shallow checkout, or main has no budget yet). */
async function mainBudgets(): Promise<Partial<Budgets> | string> {
  const p = Bun.spawn(["git", "show", "origin/main:scripts/perf-budget.json"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return (await p.exited) === 0 ? (JSON.parse(out) as Partial<Budgets>) : err.trim().split("\n")[0]!;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--env");
  const flag = at < 0 ? undefined : args.splice(at, 2)[1];
  const [cmd, file] = args;
  if ((cmd !== "check" && cmd !== "update") || !file || (at >= 0 && flag === undefined)) {
    console.error("usage: bun scripts/perf-ratchet.ts check|update <result.json> [--env github|local]");
    process.exit(2);
  }
  const env = envOf(flag);
  const result = (await Bun.file(file).json()) as Budget;
  const budgets = (await Bun.file(BUDGET_PATH).json()) as Budgets;
  const budget = budgets[env];
  console.log(`ceilings: ${env}`);
  if (cmd === "update") {
    const changed = judge(result, budget).improved;
    await Bun.write(BUDGET_PATH, JSON.stringify({ ...budgets, [env]: lowered(changed, budget) }, null, 2) + "\n");
    for (const i of changed) console.log(`lowered ${i.key}: ${i.ceiling} → ${round4(i.value + band(i.key))}`);
    if (!changed.length) console.log("nothing to lower");
  } else {
    const { over, improved } = judge(result, budget);
    const base = await mainBudgets();
    if (typeof base === "string") console.log(`ceilings are not compared with main's (origin/main:scripts/perf-budget.json: ${base})`);
    const raised = typeof base === "string" ? [] : raisedAgainst(budgets, base);
    for (const i of over) console.log(`over: ${i.key} = ${i.value} > ceiling ${i.ceiling}`);
    for (const i of improved) console.log(`improved: ${i.key} = ${i.value} < ceiling ${i.ceiling} − 2 × ${band(i.key)}: lower it with \`bun scripts/perf-ratchet.ts update ${file} --env ${env}\``);
    for (const i of raised) console.log(`raised: ${i.key} ceiling ${i.value} > main's ${i.ceiling} (raising a ceiling is merged by hand)`);
    if (over.length || improved.length || raised.length) process.exit(1);
    console.log("perf ratchet: ok");
  }
}
