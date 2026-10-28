import { publicCopyRefusal } from "./config.ts";

/**
 * Every call to GitHub goes through one GhClient, so the commands can be tested with fakeGh and never touch GitHub.
 * realGh() runs the `gh` CLI (its login, its GH_HOST); nothing else is needed.
 */
export interface GhClient {
  /** A GraphQL request; resolves to `data`, rejects when GitHub answers with `errors` or no `data`. */
  graphql(query: string, vars: Record<string, unknown>): Promise<unknown>;
  /** A REST request (`gh api <path>`); resolves to the parsed JSON body. */
  api(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown>;
  /** Any other `gh` command; resolves to its stdout. */
  run(args: string[]): Promise<string>;
}

/** `kind`: a limit, an outage or an auth failure (#894) — not asked again by a retry loop; null = any other failure. */
export class GhError extends Error {
  constructor(message: string, readonly kind: GithubFailure | null = null) {
    super(message);
  }
}

/** What a failed GitHub answer says about the next call (#894): an auth / permission failure is never retried by itself. */
export type GithubFailure = "primary" | "secondary" | "transient" | "auth";

/** A GitHub answer as gh shows it: the status and headers (`--include`), the GraphQL errors, the message on stderr. */
export interface GithubResponse {
  status?: number;
  headers?: Record<string, string>;
  errors?: Array<{ type?: string; message?: string }>;
  message?: string;
}

/** Splits `gh api --include` output into status, headers and body; output without a status line is all body. */
export function parseIncluded(out: string): { status?: number; headers: Record<string, string>; body: string } {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(out);
  if (!m) return { headers: {}, body: out };
  const end = /\r?\n\r?\n/.exec(out.slice(m[0].length));
  const head = end ? out.slice(m[0].length, m[0].length + end.index) : out.slice(m[0].length);
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers, body: end ? out.slice(m[0].length + end.index + end[0].length) : "" };
}

/** The response of a failed gh call: its `--include` output (when there is one) and its stderr. */
export function responseOf(stdout: string, stderr: string): GithubResponse {
  const { status, headers, body } = parseIncluded(stdout);
  let errors: GithubResponse["errors"];
  try {
    const parsed = JSON.parse(body) as { errors?: unknown; message?: unknown };
    if (Array.isArray(parsed?.errors)) errors = parsed.errors as GithubResponse["errors"];
    else if (typeof parsed?.message === "string") errors = [{ message: parsed.message }];
  } catch {}
  return { status: status ?? (Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || undefined), headers, errors, message: stderr };
}

/**
 * The kind of a failed answer and, when GitHub tells it (Retry-After, X-RateLimit-Reset), the time (epoch ms) the next
 * call may go; `at` null = GitHub did not say. Null = not a limit, an outage or an auth failure (a usual error).
 */
export function retryAtFromResponse(r: GithubResponse, now: number): { kind: GithubFailure; at: number | null } | null {
  const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const text = [r.message ?? "", ...(r.errors ?? []).map((e) => `${e.type ?? ""} ${e.message ?? ""}`)].join(" ");
  const after = h["retry-after"] !== undefined && /^\d+$/.test(h["retry-after"]) ? now + Number(h["retry-after"]) * 1000 : null;
  const reset = h["x-ratelimit-remaining"] === "0" && /^\d+$/.test(h["x-ratelimit-reset"] ?? "") ? Number(h["x-ratelimit-reset"]) * 1000 : null;
  if (/secondary rate limit|abuse detection|submitted too quickly/i.test(text)) return { kind: "secondary", at: after ?? reset };
  if (reset !== null || r.status === 429 || /RATE_?LIMITED|rate limit exceeded/i.test(text)) return { kind: "primary", at: after ?? reset };
  if (after !== null && r.status === 403) return { kind: "secondary", at: after };
  if (r.status === 401 || r.status === 403 || /bad credentials|gh auth login|authentication|not accessible by|must have .*permission/i.test(text)) return { kind: "auth", at: null };
  // "Something went wrong while executing your query": GitHub's own failure, answered on GraphQL with 200 and no status
  if ((r.status ?? 0) >= 500 || /HTTP 50[0234]|timed? ?out|connection reset|ECONNRESET|\bEOF\b|TLS handshake|something went wrong while executing your query/i.test(text)) return { kind: "transient", at: after };
  return null;
}

/**
 * When the next call to GitHub may go, per key (a host): after a limit or an outage nothing is asked until the time
 * GitHub gave, else 60 s doubling per failure up to 15 min. An auth failure is not waited for — it is reported, and
 * asked again only when someone asks again. A success clears the key. The wait covers every call of the host, writes
 * too: GitHub's limits count per token, and a refused call has done nothing.
 */
export class GithubRetryState {
  private waits = new Map<string, { until: number; reason: GithubFailure; tries: number; at: number }>();
  constructor(private clock = () => Date.now(), private baseMs = 60_000, private maxMs = 15 * 60_000) {}

  /** The state's time: a call's start is taken from it, so `succeeded` compares like with like. */
  now(): number {
    return this.clock();
  }

  /** Null = call; else what is waited for and until when. */
  waiting(key: string): { until: number; reason: GithubFailure } | null {
    const w = this.waits.get(key);
    return w && this.clock() < w.until ? { until: w.until, reason: w.reason } : null;
  }

  /** Records a failed answer and returns its kind (null = a usual error, nothing recorded). */
  failed(key: string, r: GithubResponse): { kind: GithubFailure; until: number | null } | null {
    const now = this.clock();
    const c = retryAtFromResponse(r, now);
    if (!c || c.kind === "auth") return c && { kind: c.kind, until: null };
    const tries = (this.waits.get(key)?.tries ?? 0) + 1;
    const until = c.at !== null && c.at > now ? c.at : now + Math.min(this.maxMs, this.baseMs * 2 ** (tries - 1));
    this.waits.set(key, { until, reason: c.kind, tries, at: now });
    return { kind: c.kind, until };
  }

  /** `startedAt`: when the call that succeeded began — one begun before a failure was recorded (or in its millisecond) does not clear it. */
  succeeded(key: string, startedAt: number): void {
    const w = this.waits.get(key);
    if (w && w.at < startedAt) this.waits.delete(key);
  }
}

/** The message a call refused while waiting carries: the reason and the time, nothing of the request. */
export const waitMessage = (w: { until: number; reason: GithubFailure }) => `GitHub の${w.reason === "transient" ? "一時障害" : "利用制限"}（${w.reason}）のため ${new Date(w.until).toISOString()} まで照会しません`;

export const githubHost = () => process.env.GH_HOST || "github.com";

/**
 * One call to GitHub as measured (#895): what kind of call, on which repository, and what GitHub said about its limit —
 * never the arguments, the bodies or the credentials. `shared`: a backlog import that joined one under way (#885); `waited`: refused while
 * waiting for a limit (neither reached GitHub). `cost` is GraphQL's own count when the answer carries it, else null.
 */
export interface GithubCallMetric {
  op: string;
  kind: "call" | "shared" | "waited";
  host: string;
  repo: string | null;
  at: number;
  ok: boolean;
  failure: GithubFailure | null;
  cost: number | null;
  remaining: number | null;
  resource: string | null;
  resetAt: number | null;
}

/** `api graphql`, `api rest`, or the gh command and its verb (`issue comment`) — the values are left out. */
const opOf = (args: string[]) => (args[0] === "api" ? (args.includes("graphql") ? "api graphql" : "api rest") : args.slice(0, 2).join(" "));

/** The repository a call names: `-R`, the `o=` / `r=` (or `ro=` / `rn=`) fields, a `repos/<o>/<r>` path, or GraphQL variables. */
function repoOfCall(args: string[], vars: Record<string, unknown> = {}): string | null {
  const at = args.indexOf("-R");
  if (at >= 0 && args[at + 1]) return args[at + 1]!;
  const field = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? (typeof vars[k] === "string" ? (vars[k] as string) : undefined);
  const [o, r] = [field("o") ?? field("ro"), field("r") ?? field("rn")];
  if (o && r) return `${o}/${r}`;
  const m = args.map((a) => /^\/?repos\/([^/\s]+)\/([^/?\s]+)/.exec(a)).find(Boolean);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The measure of one gh call from its arguments and what it printed (`--include` headers when it has them). */
export function callMetric(args: string[], out: string, err: string, code: number, at: number, vars?: Record<string, unknown>): GithubCallMetric {
  const { headers, body } = parseIncluded(out);
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  let cost: number | null = null;
  try {
    const c = (JSON.parse(body) as { data?: { rateLimit?: { cost?: unknown } } })?.data?.rateLimit?.cost;
    if (typeof c === "number") cost = c;
  } catch {}
  const reset = num(headers["x-ratelimit-reset"]);
  return {
    op: opOf(args), kind: "call", host: githubHost(), repo: repoOfCall(args, vars), at, ok: code === 0,
    failure: code === 0 ? null : (retryAtFromResponse(responseOf(out, err), at)?.kind ?? null),
    cost, remaining: num(headers["x-ratelimit-remaining"]), resource: headers["x-ratelimit-resource"] ?? null, resetAt: reset === null ? null : reset * 1000,
  };
}

/**
 * A measure for what did not reach GitHub (a shared read, a refused call). `repo`: the repository the import reads
 * (`owner/name`), when the workspace has been imported once — never its path or name.
 */
export const noCall = (op: string, kind: "shared" | "waited", at: number, failure: GithubFailure | null = null, repo: string | null = null): GithubCallMetric =>
  ({ op, kind, host: githubHost(), repo, at, ok: kind === "shared", failure, cost: null, remaining: null, resource: null, resetAt: null });

export type MetricSink = (m: GithubCallMetric) => void;

async function spawn(state: GithubRetryState, sink: MetricSink | undefined, args: string[], stdin?: string, vars?: Record<string, unknown>): Promise<string> {
  const wait = state.waiting(githubHost());
  if (wait) {
    sink?.(noCall(opOf(args), "waited", state.now(), wait.reason));
    throw new GhError(waitMessage(wait), wait.reason);
  }
  const startedAt = state.now();
  const p = Bun.spawn(["gh", ...args], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  sink?.(callMetric(args, out, err, code, state.now(), vars));
  if (code !== 0) {
    const failure = state.failed(githubHost(), responseOf(out, err));
    throw new GhError(`gh ${args[0]} ${args[1] ?? ""} が失敗しました (exit ${code}): ${err.trim() || parseIncluded(out).body.trim()}`, failure?.kind ?? null);
  }
  state.succeeded(githubHost(), startedAt);
  return out;
}

/**
 * `state`: shared by the calls of one client, so a limit met by one call stops the next ones until GitHub's time.
 * `sink`: gets the measure of every call (#895).
 */
export function realGh(state = new GithubRetryState(), sink?: MetricSink): GhClient {
  return {
    async graphql(query, vars) {
      const res = JSON.parse(parseIncluded(await spawn(state, sink, ["api", "graphql", "--include", "--input", "-"], JSON.stringify({ query, variables: vars }), vars)).body) as { data?: unknown; errors?: Array<{ message: string }> };
      if (res.errors?.length) throw new GhError(`GraphQL: ${res.errors.map((e) => e.message).join(" / ")}`);
      if (res.data === undefined || res.data === null) throw new GhError("GraphQL: data がありません");
      return res.data;
    },
    async api(path, opts = {}) {
      const args = ["api", path, "--include", "--method", opts.method ?? "GET"];
      const out = parseIncluded(await spawn(state, sink, opts.body === undefined ? args : [...args, "--input", "-"], opts.body === undefined ? undefined : JSON.stringify(opts.body))).body;
      return out.trim() === "" ? null : JSON.parse(out);
    },
    run: (args) => spawn(state, sink, args),
  };
}

export type FakeCall = { kind: "graphql"; query: string; vars: Record<string, unknown> } | { kind: "api"; path: string; opts: { method?: string; body?: unknown } } | { kind: "run"; args: string[] };

/**
 * A GhClient that answers from a script, one response per call in order, and records every call. A response is a
 * function of the call (its return value is the answer; a throw is a gh failure).
 */
export function fakeGh(responses: Array<(call: FakeCall) => unknown>): GhClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const answer = async (call: FakeCall) => {
    calls.push(call);
    const next = responses[calls.length - 1];
    if (!next) throw new GhError(`fakeGh: 想定していない ${calls.length} 回目の呼び出し: ${JSON.stringify(call).slice(0, 200)}`);
    return next(call);
  };
  return {
    calls,
    graphql: (query, vars) => answer({ kind: "graphql", query, vars }),
    api: (path, opts = {}) => answer({ kind: "api", path, opts }),
    run: async (args) => String(await answer({ kind: "run", args })),
  };
}

/**
 * The repository the commands act on: `GH_REPO` (as gh reads it), else the remote `gh repo set-default` chose, else
 * the `origin` remote, else `gh repo view`. A clone whose target is its own public copy (`publicCopyRefusal`) stops.
 */
export async function repoOf(gh: GhClient, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Promise<{ owner: string; name: string }> {
  const r = await resolveRepo(gh, env, cwd);
  const refusal = publicCopyRefusal(`${r.owner}/${r.name}`, cwd);
  if (refusal) throw new GhError(refusal);
  return r;
}

async function resolveRepo(gh: GhClient, env: Record<string, string | undefined>, cwd: string): Promise<{ owner: string; name: string }> {
  const parse = (s: string) => /github\.com[:/]([^/]+)\/([^/\s]+?)(\.git)?\/?$/.exec(s.trim());
  const fromEnv = env.GH_REPO ? /^(?:[^/]+\/)?([^/]+)\/([^/]+)$/.exec(env.GH_REPO.replace(/^https?:\/\/[^/]+\//, "")) : null;
  if (fromEnv) return { owner: fromEnv[1]!, name: fromEnv[2]! };
  // env: the current process.env (Bun's spawn otherwise passes the env from start-up; the tests isolate git's config)
  const git = (args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString() : "";
  };
  // `gh repo set-default` marks its remote `remote.<name>.gh-resolved = base`
  const chosen = /^remote\.(.+)\.gh-resolved base$/m.exec(git(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]));
  for (const remote of chosen ? [chosen[1]!, "origin"] : ["origin"]) {
    const m = parse(git(["remote", "get-url", remote]));
    if (m) return { owner: m[1]!, name: m[2]! };
  }
  const [owner, name] = (await gh.run(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim().split("/");
  if (!owner || !name) throw new GhError("リポジトリが分かりません（GH_REPO を設定するか、origin のあるディレクトリで実行してください）");
  return { owner, name };
}
