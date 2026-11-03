/**
 * The CI ratchet on the counts of `bun scripts/perf-bench.ts --json` (#638): the ceilings in scripts/perf-budget.json only
 * go down. The bundle has no ceiling (#3167): it is compared with main's tip, measured in the same run.
 *   bun scripts/perf-ratchet.ts base <ref> <out.json>   builds <ref> in a worktree next to this checkout and writes its
 *                                        bundle as `{ sha, bundle: { js, css } }` (CI: origin/main → perf-base.json)
 *   bun scripts/perf-ratchet.ts check <result.json> --base <base.json> [--env github|local]
 *                                        exit 1 if a count is over its ceiling, a count is better than its ceiling (lower
 *                                        it in the same PR), a ceiling is above main's, or the bundle (js or css, gzip) is
 *                                        BUNDLE_GROWTH_LIMIT or more above the base's (`grew:`); a `bundle:` line says the
 *                                        sizes and the difference either way
 *   bun scripts/perf-ratchet.ts update <result.json> [--env github|local]   lowers the ceilings the result beats; never
 *                                        raises one
 * The budget has one set of ceilings per environment (#644): `github` (Actions' ubuntu-latest Chrome) and `local` (the
 * host's Chromium, which local-ci uses). The same code draws a frame differently on a faster machine, so the counts differ
 * between the two by more than the bands. The environment is `github` when GITHUB_ACTIONS=true (local-ci sets CI=true but
 * not that), else `local`; --env picks it, e.g. to lower `github` from a result taken from Actions.
 * Times (msMedian / msP90) are never compared: they wobble on a shared machine (docs/design/perf.md). The one time with a
 * ceiling is `loaded.healthMaxMs`, the daemon's delay under load, in `local` only, with a band measured for it, judged on
 * the high side only (`HIGH_SIDE_ONLY`: a quiet host runs it far below its ceiling, so `improved` would fail there).
 * The type check's and bun test's seconds have ceilings too (`durations`, `local` only): perf-bench does not have them, so
 * local-ci compares its own seconds with `judgeDurations`, on the high side only (`improved` would fail on a quiet host).
 * The counts that wobble (requests / layoutCount / recalcStyleCount ±1, layoutShift in its low digits — as medians of
 * `--runs 5`; a single run moves more) carry a fixed band: a ceiling is a measured value + the band, a count is over above
 * the ceiling and better below ceiling − 2 × band (more than a band below the measured value: a new low of the same code's
 * wobble is not an improvement, or every run that finds one would fail an unrelated PR). Fixed per count, not a setting: the band is how much the same code moves,
 * not how much worse a change may be.
 * A count over its ceiling that the user accepted is a known exception (`exceptions` in the budget, #1890): it does not fail
 * while its Issue is open. Adding one fails like raising a ceiling, so the user merges it by hand.
 *   bun scripts/perf-ratchet.ts history [--repo <owner/name>] [--since YYYY-MM-DD]
 *                                        main's bundle as local-ci measured it, in time order, with the increase from the
 *                                        first row (#3169): one read of `bundle.tsv` on the `perf-records` branch; nothing
 *                                        is built again. A row is one measure, not one commit (docs/design/perf.md).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Budget {
  journeys: Record<string, { requests: number; layoutCount?: number; recalcStyleCount: number; layoutShift?: number }>;
  /** The daemon's delay under load and overlap (perf-bench's `loaded`); `local` only: a ceiling nobody measured would be a guess. */
  loaded?: { healthMaxMs: number };
  /** The type check's and bun test's seconds, compared by local-ci (`judgeDurations`); `local` only: Actions has no ceilings of its own. */
  durations?: { typecheck: number; test: number };
}
export interface Item { key: string; value: number; ceiling: number }
export const ENVS = ["github", "local"] as const;
export type Env = (typeof ENVS)[number];
/** `key`: `<env>.journeys.<name>.<count>`, as raisedAgainst writes it. */
export interface PerfException { key: string; issue: number }
export type Budgets = Record<Env, Budget> & { exceptions?: PerfException[] };

/** The environment whose ceilings apply: --env, else `github` in Actions, else `local`. */
export function envOf(flag: string | undefined, env: Record<string, string | undefined> = process.env): Env {
  if (flag === undefined) return env.GITHUB_ACTIONS === "true" ? "github" : "local";
  if (!(ENVS as readonly string[]).includes(flag)) throw new Error(`--env is one of ${ENVS.join(" / ")}, not ${flag}`);
  return flag as Env;
}

export const BUDGET_PATH = join(import.meta.dir, "perf-budget.json");
/** How much the same code moves from run to run (docs/design/perf.md の「数の意味」). */
const BAND: Record<string, number> = { requests: 1, layoutCount: 1, recalcStyleCount: 1, layoutShift: 0.03, healthMaxMs: 1750 };
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** The ceilings judged on the high side only: `over` above them, never `improved` below, so `update` never lowers them.
 * The load moves them by more than twice (a quiet host: 1,700–1,924 ms against 5,440 − 2 × 1,750 = 1,940, 2026-11-02),
 * the same reason as `judgeDurations` (a regression of #2822, #3574). */
const HIGH_SIDE_ONLY = new Set(["loaded.healthMaxMs"]);

/** Every ceiling as `journeys.<name>.<count>` / `loaded.healthMaxMs` → value. */
function flat(b: Budget): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, counts] of Object.entries(b.journeys)) for (const [k, v] of Object.entries(counts)) out.set(`journeys.${name}.${k}`, v);
  if (b.loaded) out.set("loaded.healthMaxMs", b.loaded.healthMaxMs);
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
    else if (!HIGH_SIDE_ONLY.has(key) && value < round4(ceiling - 2 * band(key))) improved.push({ key, value, ceiling });
  }
  return { over, improved };
}

/** The seconds over their ceilings; below never fails (the host's load moves them down too, and a ceiling is lowered by hand). */
export function judgeDurations(seconds: { typecheck: number; test: number }, budget: Budget): Item[] {
  return Object.entries(budget.durations ?? {}).flatMap(([k, ceiling]) => {
    const value = seconds[k as keyof typeof seconds];
    return value > ceiling ? [{ key: `durations.${k}`, value, ceiling }] : [];
  });
}

/** Every ceiling, the seconds local-ci compares included. */
function ceilings(b: Budget): Map<string, number> {
  const out = flat(b);
  for (const [k, v] of Object.entries(b.durations ?? {})) out.set(`durations.${k}`, v);
  return out;
}

/** The ceilings above main's, in every environment — not only the one measured, so a raise of `local` fails in Actions too
 * (a new key or environment is not a raise). Raising one is the user's call: CI fails and they merge by hand. */
export function raisedAgainst(budgets: Budgets, base: Partial<Budgets>): Item[] {
  return ENVS.flatMap((env) => {
    const was = base[env] ? ceilings(base[env]) : new Map<string, number>();
    return [...ceilings(budgets[env])].flatMap(([key, ceiling]) => {
      const prev = was.get(key);
      return prev !== undefined && ceiling > prev ? [{ key: `${env}.${key}`, value: ceiling, ceiling: prev }] : [];
    });
  });
}

/** Splits the counts over their ceilings: `known` are excepted by an Issue that is open, the rest stay `over`. */
export function knownExceptions(over: Item[], env: Env, exceptions: PerfException[], open: (issue: number) => boolean): { known: (Item & { issue: number })[]; over: Item[] } {
  const known: (Item & { issue: number })[] = [];
  const rest: Item[] = [];
  for (const item of over) {
    const issue = exceptions.find((e) => e.key === `${env}.${item.key}`)?.issue;
    if (issue !== undefined && open(issue)) known.push({ ...item, issue });
    else rest.push(item);
  }
  return { known, over: rest };
}

/** The exceptions main does not have. Excepting a count is the user's call, as raising its ceiling is: CI fails and they merge by hand. */
export function addedExceptions(budgets: Budgets, base: Partial<Budgets>): PerfException[] {
  const was = new Set((base.exceptions ?? []).map((e) => `${e.key} ${e.issue}`));
  return (budgets.exceptions ?? []).filter((e) => !was.has(`${e.key} ${e.issue}`));
}

/** Whether the Issue is open, by this checkout's default repository. An Issue that cannot be read excepts nothing. */
function issueOpen(issue: number): boolean {
  try {
    const p = Bun.spawnSync(["gh", "issue", "view", String(issue), "--json", "state", "-q", ".state"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0) return p.stdout.toString().trim() === "OPEN";
    console.log(`例外 #${issue} の Issue を読めない: ${p.stderr.toString().trim().split("\n")[0]}`);
  } catch (e) {
    console.log(`例外 #${issue} の Issue を読めない: ${(e as Error).message}`); // no gh on PATH
  }
  return false;
}

/** The budget with each beaten ceiling (`improved` of judge) lowered to the value + its band. Never raises one. */
export function lowered(improved: Item[], budget: Budget): Budget {
  const next = structuredClone(budget);
  for (const { key, value } of improved) {
    const [group, name, count] = key.split(".") as [string, string, string?];
    const v = round4(value + band(key));
    if (group === "loaded") next.loaded = { healthMaxMs: v };
    else next.journeys[name]![count as keyof Budget["journeys"][string]] = v;
  }
  return next;
}

/** The budgets with `env`'s beaten ceilings lowered; the exceptions and the other environment stay as they are. */
export function loweredBudgets(budgets: Budgets, env: Env, improved: Item[]): Budgets {
  return { ...budgets, [env]: lowered(improved, budgets[env]) };
}

export interface Bundle { js: number; css: number }

/** The gzip bytes of a web build's `assets/*.js` and `assets/*.css`, each summed (`dist` = apps/web/dist). */
export function bundleOf(dist: string): Bundle {
  const assets = join(dist, "assets");
  const size = (ext: string) => readdirSync(assets).filter((f) => f.endsWith(ext)).reduce((n, f) => n + Bun.gzipSync(readFileSync(join(assets, f))).length, 0);
  return { js: size(".js"), css: size(".css") };
}

/**
 * The bundle's growth over main's tip that fails the check: 1% of main's size, js and css each. The user's rule
 * (2026-10-30), to be looked at again (raised or dropped): change it here and in docs/design/perf.md の「ラチェット」.
 */
export const BUNDLE_GROWTH_LIMIT = 0.01;

const signed = (n: number, digits = 0) => `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(digits)}`;

/** The `bundle:` line (the merged sizes, main's, the difference) and a `grew:` line per size BUNDLE_GROWTH_LIMIT or more above main's. */
export function bundleGrowth(merged: Bundle, base: Bundle): { line: string; grew: string[] } {
  const keys = ["js", "css"] as const;
  const pct = (k: (typeof keys)[number]) => (base[k] ? ((merged[k] - base[k]) / base[k]) * 100 : merged[k] > base[k] ? Infinity : 0);
  const line = `bundle: ${keys.map((k) => `${k} ${merged[k]} B (main ${base[k]} B, ${signed(merged[k] - base[k])} B, ${signed(pct(k), 2)}%)`).join(" / ")}`;
  const grew = keys.filter((k) => pct(k) >= BUNDLE_GROWTH_LIMIT * 100).map((k) => `grew: bundle.${k} ${signed(pct(k), 2)}% (${base[k]} → ${merged[k]} B) ≥ ${BUNDLE_GROWTH_LIMIT * 100}%: merging is the user's call (docs/design/perf.md)`);
  return { line, grew };
}

/**
 * Builds `ref` in a worktree next to this checkout's top (not under /tmp, which is RAM: node_modules does not go there)
 * and writes `{ sha, bundle }` to `out`; the worktree goes whatever happens. Each command's output is printed.
 */
async function measureRef(ref: string, out: string): Promise<void> {
  const run = (cmd: string[], cwd?: string) => {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const text = `${p.stdout.toString()}${p.stderr.toString()}`;
    if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: exit ${p.exitCode}\n${text.trim()}`);
    return text;
  };
  // a measure that fails leaves no file: check must not compare with an older one
  rmSync(out, { force: true });
  const top = run(["git", "rev-parse", "--show-toplevel"]).trim();
  const sha = run(["git", "rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const dir = mkdtempSync(join(dirname(top), `${basename(top)}.perf-base.`));
  const started = Date.now();
  try {
    run(["git", "-C", top, "worktree", "add", "-q", "--detach", dir, sha]);
    console.log(run(["bun", "install", "--frozen-lockfile"], dir).trim());
    console.log(run(["bun", "run", "--cwd", "apps/web", "build"], dir).trim().split("\n").slice(-3).join("\n"));
    const bundle = bundleOf(join(dir, "apps/web/dist"));
    await Bun.write(out, `${JSON.stringify({ sha, bundle })}\n`);
    console.log(`base ${sha.slice(0, 7)}: js ${bundle.js} B, css ${bundle.css} B (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  } finally {
    Bun.spawnSync(["git", "-C", top, "worktree", "remove", "--force", dir], { stdout: "ignore", stderr: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where local-ci appends a row each time it measured main's bundle (`recordBundle`): a branch never merged, written by the contents API. */
export const RECORDS_BRANCH = "perf-records";
export const RECORDS_PATH = "bundle.tsv";
export const RECORDS_HEADER = "measured_at\tjs\tcss\tmain";
/** One measure of main's bundle: when (ISO), the gzip sizes, and main's sha (for reference: a row is a measure, not a commit). */
export interface Row { measuredAt: string; js: number; css: number; main: string }

export function recordRow(measuredAt: string, base: { sha: string; bundle: { js: number; css: number } }): string {
  return [measuredAt, base.bundle.js, base.bundle.css, base.sha].join("\t");
}

/** The rows of bundle.tsv; the header and a row that is not four fields with a time and two sizes are passed over. */
export function parseRows(tsv: string): Row[] {
  return tsv.split("\n").flatMap((l) => {
    const [measuredAt, js, css, main, ...rest] = l.split("\t");
    if (rest.length || !main || !/^\d+$/.test(js ?? "") || !/^\d+$/.test(css ?? "") || Number.isNaN(Date.parse(measuredAt!))) return [];
    return [{ measuredAt: measuredAt!, js: Number(js), css: Number(css), main }];
  });
}

const growth = (n: number, from: number) => {
  const d = n - from;
  const p = from ? (d / from) * 100 : 0;
  return `${d < 0 ? "-" : "+"}${Math.abs(d)} B (${p < 0 ? "-" : "+"}${Math.abs(p).toFixed(2)}%)`;
};

/** The rows from `since` (YYYY-MM-DD, UTC) in time order, each with its increase from the first of them, then the period's increase. */
export function historyTable(rows: Row[], since?: string): string[] {
  const kept = rows.filter((r) => !since || r.measuredAt.slice(0, 10) >= since).sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
  const first = kept[0];
  const last = kept.at(-1);
  if (!first || !last) return ["記録なし"];
  return [
    "| 測った日時 | js B | css B | js 初めから | css 初めから | main |",
    "|---|---|---|---|---|---|",
    ...kept.map((r) => `| ${r.measuredAt} | ${r.js} | ${r.css} | ${growth(r.js, first.js)} | ${growth(r.css, first.css)} | ${r.main.slice(0, 7)} |`),
    `期間の増加: js ${growth(last.js, first.js)} / css ${growth(last.css, first.css)}`,
  ];
}

/** bundle.tsv as it is on the records branch of `repo`; "" when the branch or the file is not there yet. */
async function readRecords(repo: string): Promise<string> {
  const p = Bun.spawn(["gh", "api", `repos/${repo}/contents/${RECORDS_PATH}?ref=${RECORDS_BRANCH}`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code === 0) {
    const f = JSON.parse(out) as { content: string; encoding?: string };
    // over 1 MB the API leaves the content out: say so, not 記録なし
    if (f.encoding !== "base64") throw new Error(`${RECORDS_BRANCH}/${RECORDS_PATH} を contents API で読めない（encoding ${f.encoding ?? "なし"}。1 MB を超えたら分ける）`);
    return Buffer.from(f.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (/HTTP 404/.test(err)) return "";
  throw new Error(`${RECORDS_BRANCH}/${RECORDS_PATH} を読めない: ${err.trim().split("\n")[0]}`);
}

/** main's budgets, or why there are none (no origin/main in a shallow checkout, or main has no budget yet). */
async function mainBudgets(): Promise<Partial<Budgets> | string> {
  const p = Bun.spawn(["git", "show", "origin/main:scripts/perf-budget.json"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return (await p.exited) === 0 ? (JSON.parse(out) as Partial<Budgets>) : err.trim().split("\n")[0]!;
}

if (import.meta.main && process.argv[2] === "history") {
  const args = process.argv.slice(3);
  const opt = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args.splice(at, 2)[1] ?? "";
  };
  const [repoFlag, since] = [opt("--repo"), opt("--since")];
  if (args.length || repoFlag === "" || (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since))) {
    console.error("usage: bun scripts/perf-ratchet.ts history [--repo <owner/name>] [--since YYYY-MM-DD]");
    process.exit(2);
  }
  // local-ci imports this file: read lazily, not at the top
  const { remoteRepo } = await import("./local-ci.ts");
  const origin = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: import.meta.dir, stdout: "pipe" }).stdout.toString();
  const repo = repoFlag ?? remoteRepo(origin);
  if (!repo) {
    console.error("origin is not a GitHub owner/name: give --repo");
    process.exit(2);
  }
  for (const l of historyTable(parseRows(await readRecords(repo)), since)) console.log(l);
} else if (import.meta.main && process.argv[2] === "base") {
  const [ref, out, ...rest] = process.argv.slice(3);
  if (!ref || !out || rest.length) {
    console.error("usage: bun scripts/perf-ratchet.ts base <ref> <out.json>");
    process.exit(2);
  }
  await measureRef(ref, out);
} else if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string): [boolean, string | undefined] => {
    const at = args.indexOf(name);
    return at < 0 ? [false, undefined] : [true, args.splice(at, 2)[1]];
  };
  const [envGiven, flag] = opt("--env");
  const [, baseFile] = opt("--base");
  const [cmd, file] = args;
  if ((cmd !== "check" && cmd !== "update") || !file || (envGiven && flag === undefined) || (cmd === "check" && !baseFile)) {
    console.error("usage: bun scripts/perf-ratchet.ts check <result.json> --base <base.json> [--env github|local] | update <result.json> [--env github|local] | base <ref> <out.json> | history [--repo <owner/name>] [--since YYYY-MM-DD]");
    process.exit(2);
  }
  const env = envOf(flag);
  const result = (await Bun.file(file).json()) as Budget & { bundle: Bundle };
  const budgets = (await Bun.file(BUDGET_PATH).json()) as Budgets;
  const budget = budgets[env];
  console.log(`ceilings: ${env}`);
  if (cmd === "update") {
    const changed = judge(result, budget).improved;
    await Bun.write(BUDGET_PATH, JSON.stringify(loweredBudgets(budgets, env, changed), null, 2) + "\n");
    for (const i of changed) console.log(`lowered ${i.key}: ${i.ceiling} → ${round4(i.value + band(i.key))}`);
    if (!changed.length) console.log("nothing to lower");
  } else {
    const { over: above, improved } = judge(result, budget);
    const { known, over } = knownExceptions(above, env, budgets.exceptions ?? [], issueOpen);
    const base = await mainBudgets();
    if (typeof base === "string") console.log(`ceilings are not compared with main's (origin/main:scripts/perf-budget.json: ${base})`);
    const raised = typeof base === "string" ? [] : raisedAgainst(budgets, base);
    const added = typeof base === "string" ? [] : addedExceptions(budgets, base);
    for (const i of known) console.log(`known exception: ${i.key} = ${i.value} > ceiling ${i.ceiling}（#${i.issue} が開いている）`);
    for (const i of over) console.log(`over: ${i.key} = ${i.value} > ceiling ${i.ceiling}`);
    for (const i of improved) console.log(`improved: ${i.key} = ${i.value} < ceiling ${i.ceiling} − 2 × ${band(i.key)}: lower it with \`bun scripts/perf-ratchet.ts update ${file} --env ${env}\``);
    for (const i of raised) console.log(`raised: ${i.key} ceiling ${i.value} > main's ${i.ceiling} (raising a ceiling is merged by hand)`);
    for (const e of added) console.log(`added exception: ${e.key} #${e.issue}（例外を足すのは手でマージ）`);
    const growth = bundleGrowth(result.bundle, ((await Bun.file(baseFile!).json()) as { bundle: Bundle }).bundle);
    console.log(growth.line);
    for (const l of growth.grew) console.log(l);
    if (over.length || improved.length || raised.length || added.length || growth.grew.length) process.exit(1);
    console.log("perf ratchet: ok");
  }
}
