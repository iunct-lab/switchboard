/**
 * bun scripts/github-api-bench.ts --fixture | --sample [--task <n>]   (#895)
 *
 * What the daily backlog operations cost on GitHub, per operation, as JSON (docs/design/github-api-budget.md).
 * --fixture: the same fixtures every time, nothing reaches GitHub — the backlog imported once (the baseline), listed
 *   ten times from what is stored (#885), imported ten times at once, imported ten times while a limit is waited for;
 *   lint; the overlap check.
 * --sample: each current operation once against GitHub, read-only (the backlog imported into a database in memory —
 *   the first import, then the next one, which asks for what changed since; lint; and with --task the overlap check
 *   without --claimed), with the time it was measured.
 * Only what the answers carry is used: GraphQL's cost is null unless the answer has it (never estimated, never the REST
 * rate_limit in its place). No arguments, bodies or credentials are kept — the operation, the repository and the limit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BacklogError, runGh, type GhRunner } from "../packages/core/src/backlog.ts";
import { BacklogSync } from "../packages/core/src/backlog-sync.ts";
import { Db } from "../packages/core/src/db.ts";
import { importing } from "../packages/core/fixtures/github-import.ts";
import { loadConfig, resolveProject } from "../ops-kit/src/config.ts";
import { callMetric, GhError, githubHost, GithubRetryState, retryAtFromResponse, realGh, repoOf, type GhClient, type GithubCallMetric, type MetricSink } from "../ops-kit/src/gh.ts";
import { lint } from "../ops-kit/src/lint.ts";
import { ghBoard, overlap } from "./parallel-guard.ts";

export interface ScenarioResult {
  name: string;
  /** Calls that reached GitHub, and what was answered without one. */
  calls: number;
  shared: number;
  waited: number;
  /** The calls of the same operation done once, alone (the baseline), when the scenario repeats one. */
  single: number | null;
  byOp: Record<string, number>;
  /** The sum of GraphQL's own cost when every GraphQL call carried it; null when any did not, or there was none. */
  cost: number | null;
  /** The last remaining points GitHub reported, and of which resource. */
  remaining: number | null;
  resource: string | null;
  /** Why calls failed or waited (primary / secondary / transient / auth). */
  waits: string[];
  /** Why the scenario did not finish: primary / secondary / transient / auth, else "failed" — never the message. */
  error?: string;
}

export interface BenchResult {
  mode: "fixture" | "sample";
  at: string;
  host: string;
  scenarios: ScenarioResult[];
}

export function summarize(name: string, ms: GithubCallMetric[], single: number | null = null): ScenarioResult {
  const calls = ms.filter((m) => m.kind === "call");
  const byOp: Record<string, number> = {};
  for (const m of calls) byOp[m.op] = (byOp[m.op] ?? 0) + 1;
  // GraphQL's cost, from the GraphQL calls only: REST and gh commands never carry one (#987 recheck)
  const costs = calls.filter((m) => m.op === "api graphql").map((m) => m.cost);
  const last = calls.filter((m) => m.remaining !== null).at(-1);
  return {
    name, calls: calls.length, shared: ms.filter((m) => m.kind === "shared").length, waited: ms.filter((m) => m.kind === "waited").length, single, byOp,
    cost: costs.length > 0 && costs.every((c) => c !== null) ? costs.reduce<number>((a, c) => a + c!, 0) : null,
    remaining: last?.remaining ?? null, resource: last?.resource ?? null,
    waits: [...new Set(ms.flatMap((m) => (m.failure ? [m.failure] : [])))],
  };
}

/**
 * The kind a scenario failed with: the kind the error carries (GhError.kind, BacklogError.response, the reason of a
 * refused call), else what its message says, else "failed" (#987 review).
 */
export function errorKind(e: unknown): string {
  if (e instanceof GhError && e.kind) return e.kind;
  const message = String((e as Error)?.message ?? e);
  const refused = /（(primary|secondary|transient)）のため .* まで照会しません/.exec(message)?.[1];
  if (refused) return refused;
  return retryAtFromResponse(e instanceof BacklogError && e.response ? e.response : { message }, Date.now())?.kind ?? "failed";
}

async function measure(name: string, fn: (sink: MetricSink) => Promise<unknown>, single: number | null = null): Promise<ScenarioResult> {
  const ms: GithubCallMetric[] = [];
  try {
    await fn((m) => ms.push(m));
    return summarize(name, ms, single);
  } catch (e) {
    // the kind of failure only: gh's message can quote a path or a body (#987 recheck)
    return { ...summarize(name, ms, single), error: errorKind(e) };
  }
}

/* ---------- --fixture ---------- */

const coreFixtures = join(import.meta.dir, "../packages/core/fixtures");
const opsFixtures = join(import.meta.dir, "../ops-kit/fixtures");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const LIMITED = { code: 1, stdout: 'HTTP/2.0 403 Forbidden\nRetry-After: 60\n\n{"message":"You have exceeded a secondary rate limit."}', stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)" };

/** gh answering the backlog import from core's fixtures, with the limit headers gh --include shows; `limited` answers 403 + Retry-After. */
function backlogGh(limited = () => false): GhRunner {
  const pages = json(join(coreFixtures, "backlog-graphql.json")) as unknown[];
  const decisions = json(join(coreFixtures, "backlog-decisions.json"));
  let remaining = 5000;
  return importing(async (args) => {
    if (args[0] === "repo") return ok("acme/app\n");
    if (args[0] === "variable") return ok("https://github.com/users/acme/projects/11\n");
    if (limited()) return LIMITED;
    const body = args.some((a) => a.includes("comments(last:")) ? decisions : args.includes("after=CURSOR1") ? pages[1] : pages[0];
    return ok(`HTTP/2.0 200 OK\nX-Ratelimit-Remaining: ${--remaining}\nX-Ratelimit-Resource: graphql\nX-Ratelimit-Reset: 1790000000\n\n${JSON.stringify(body)}`);
  });
}

/** A GhClient measured call by call (the fakes print no headers: no remaining, no cost); a throw is a failed call. */
export function measured(gh: GhClient, sink: MetricSink): GhClient {
  const one = async <T>(args: string[], call: () => Promise<T>, vars?: Record<string, unknown>): Promise<T> => {
    try {
      const r = await call();
      sink(callMetric(args, "", "", 0, Date.now(), vars));
      return r;
    } catch (e) {
      sink(callMetric(args, "", String((e as Error)?.message ?? e), 1, Date.now(), vars));
      throw e;
    }
  };
  return {
    graphql: (q, vars) => one(["api", "graphql"], () => gh.graphql(q, vars), vars),
    api: (path, opts) => one(["api", path], () => gh.api(path, opts)),
    run: (args) => one(args, () => gh.run(args)),
  };
}

/** gh answering parallel-guard's overlap check: one Task naming one file, no open PR, no other Task In progress. */
const overlapRun = (sink: MetricSink) => async (args: string[]) => {
  sink(callMetric(args, "", "", 0, Date.now()));
  if (args[1]?.endsWith("/contents")) return '{"name":"packages","dir":true}\n{"name":"ops-kit","dir":true}\n';
  if (args[0] === "pr") return "[]";
  if (args[0] === "variable") return "https://github.com/users/acme/projects/11\n";
  if (args.some((a) => a.includes("issue(number:"))) return JSON.stringify({ data: { repository: { issue: { body: "`packages/core/src/backlog.ts`", parent: null } } } });
  return "";
};

/**
 * The environment the commands read is pinned while the fixtures run, so every shell gets the same counts: GH_REPO names
 * the repository (else lint reads the checkout's origin), and without SWITCHBOARD_PROJECT_URL / GH_HOST the backlog
 * read and overlap ask for the Project variable on github.com (#987 recheck).
 */
const FIXTURE_ENV: Record<string, string | undefined> = { GH_REPO: "acme/app", SWITCHBOARD_PROJECT_URL: undefined, GH_HOST: undefined };

export async function runGithubApiBench(): Promise<BenchResult> {
  const saved = Object.fromEntries(Object.keys(FIXTURE_ENV).map((k) => [k, process.env[k]]));
  const put = (env: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  put(FIXTURE_ENV);
  try {
    return await fixtureRun();
  } finally {
    put(saved);
  }
}

async function fixtureRun(): Promise<BenchResult> {
  const ws = { id: "ws_app", name: "app", path: "/work/app" };
  // a database in memory per scenario: each starts with nothing stored
  const sync = (sink: MetricSink, limited?: () => boolean) => new BacklogSync(new Db(":memory:"), backlogGh(limited), () => 0, sink);
  const ten = <T>(f: () => Promise<T>) => Promise.all(Array.from({ length: 10 }, f));
  const one = await measure("backlog import (once)", (sink) => sync(sink).sync(ws));
  const scenarios = [
    one,
    await measure("backlog list x10", async (sink) => { const s = sync(sink); await s.sync(ws); for (let i = 0; i < 10; i++) s.read(ws); }, one.calls),
    await measure("backlog import x10 at once", (sink) => { const s = sync(sink); return ten(() => s.sync(ws)); }, one.calls),
    await measure("backlog import x10 while limited", async (sink) => {
      const s = sync(sink, () => true);
      await s.sync(ws).catch(() => undefined);
      await ten(() => s.sync(ws).catch(() => undefined));
    }),
    await measure("lint", (sink) => {
      const page = json(join(opsFixtures, "lint/ok.json"));
      const gh: GhClient = { graphql: async () => page, api: async () => null, run: async () => "acme/app\n" };
      return lint(measured(gh, sink), loadConfig(join(opsFixtures, "config-with-phase.json")), { sleep: async () => {} });
    }),
    await measure("overlap", (sink) => overlap(ghBoard("acme/app", overlapRun(sink)), 895, false, new Date(0))),
  ];
  return { mode: "fixture", at: new Date().toISOString(), host: githubHost(), scenarios };
}

/* ---------- --sample ---------- */

export async function sampleGithubApi(opts: { cwd: string; task?: number }): Promise<BenchResult> {
  const scenarios = [
    ...(await (async () => {
      // the first import reads every Issue; the next one only what changed since (the everyday one)
      const db = new Db(":memory:");
      const ws = { id: "sample", path: opts.cwd };
      const first = await measure("backlog import (first)", (sink) => new BacklogSync(db, runGh, Date.now, sink).sync(ws));
      return [first, await measure("backlog import (next)", (sink) => new BacklogSync(db, runGh, Date.now, sink).sync(ws))];
    })()),
    await measure("lint", async (sink) => {
      // as the CLI: the Project URL from the environment, the config or the repository variable (that read is counted too)
      const gh = realGh(new GithubRetryState(), sink);
      return lint(gh, await resolveProject(loadConfig(undefined, opts.cwd), gh));
    }),
  ];
  if (opts.task !== undefined) {
    scenarios.push(await measure("overlap", async (sink) => {
      // naming the repository may ask GitHub too (no GH_REPO, no github.com origin): it is counted with the check
      // the check's gh is realGh's, measured and refused during a wait like lint's; it reads with -q, so remaining stays null
      const gh = realGh(new GithubRetryState(), sink);
      const { owner, name } = await repoOf(gh, process.env, opts.cwd);
      return overlap(ghBoard(`${owner}/${name}`, gh.run), opts.task!, false);
    }));
  }
  return { mode: "sample", at: new Date().toISOString(), host: githubHost(), scenarios };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { fixture: { type: "boolean" }, sample: { type: "boolean" }, task: { type: "string" } } });
  const task = values.task === undefined ? undefined : Number(values.task);
  if (!!values.fixture === !!values.sample || (task !== undefined && !(Number.isInteger(task) && task > 0))) {
    console.error("usage: bun scripts/github-api-bench.ts --fixture | --sample [--task <n>]");
    process.exit(2);
  }
  console.log(JSON.stringify(values.fixture ? await runGithubApiBench() : await sampleGithubApi({ cwd: process.cwd(), task }), null, 2));
}
