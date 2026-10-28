/**
 * How long a closed PBI took, stage by stage (#650). Pure: it takes the times GitHub holds (Issue / PR / comment
 * `createdAt`) and cuts them at the marks the skills leave. The Project's Status history is not read — a Status changed
 * through the API leaves no timeline event. A stage whose mark is missing is null, never guessed. docs/design/flow-metrics.md.
 */
import { FlowStage, type FlowPbi, type FlowStageSummary, type FlowSummary, type FlowView } from "@switchboard/protocol";
import type { Database } from "bun:sqlite";
import { tasksOfIssues } from "./db.ts";
import type { GhRunner } from "./backlog.ts";

export type RawComment = { createdAt: string; body: string };
export type RawPr = { number: number; createdAt: string; mergedAt: string | null; comments: RawComment[] };
export type RawTask = { number: number; createdAt: string; closedAt: string | null; comments: RawComment[]; pullRequests: RawPr[] };
export type RawPbi = {
  number: number;
  title: string;
  createdAt: string;
  closedAt: string;
  body: string;
  storyPoints: number | null;
  comments: RawComment[];
  subIssues: RawTask[];
};

/** The same shape as merge-gate's review mark, plus DAK (the extra reviewer). */
const REVIEW = /^\[(codex|claude|dak)\] review/;
const CLAIM = /^(<!-- parallel-guard:task-claim -->|着手)/m; // a line of its own, not only the comment's first
const ASK = /^## 判断待ち/;
const ANSWER = /^## 回答/;

const ms = (iso: string): number => Date.parse(iso);
const sorted = <T extends { createdAt: string }>(xs: T[]): T[] => [...xs].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
const between = (from: number | null, to: number | null): number | null => (from === null || to === null || to < from ? null : to - from);

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** `## 判断待ち` → the next `## 回答` on one Issue, summed. An ask with no answer after it counts nothing (still open or lost). */
function userWait(comments: RawComment[]): number {
  let total = 0;
  let asked: number | null = null;
  for (const c of sorted(comments)) {
    if (ASK.test(c.body)) asked ??= ms(c.createdAt);
    else if (ANSWER.test(c.body) && asked !== null) {
      total += ms(c.createdAt) - asked;
      asked = null;
    }
  }
  return total;
}

export function flowOfPbi(raw: RawPbi, requestCreatedAt: string | null): Omit<FlowPbi, "tasks" | "repo" | "url"> {
  const tasks = raw.subIssues;
  // A PR can close several sibling Tasks; count it once.
  const prs = [...new Map(tasks.flatMap((t) => t.pullRequests).map((p) => [p.number, p])).values()];
  const claims = tasks.flatMap((t) => t.comments.filter((c) => CLAIM.test(c.body)).map((c) => ms(c.createdAt)));
  const firstPrAt = prs.length ? Math.min(...prs.map((p) => ms(p.createdAt))) : null;
  const firstClaim = claims.length ? Math.min(...claims) : null;
  const start = firstClaim ?? firstPrAt;
  // A Task added after the start (a review fix, an answer's follow-up) is building, not splitting (#2684).
  const splitTasks = tasks.map((t) => ms(t.createdAt)).filter((at) => start === null || at <= start);
  const splitEndAt = splitTasks.length ? Math.max(...splitTasks) : null;
  const merges = prs.flatMap((p) => (p.mergedAt ? [ms(p.mergedAt)] : []));
  const lastMerge = merges.length ? Math.max(...merges) : null;
  const firstReview = (p: RawPr): number | null => {
    const r = sorted(p.comments).find((c) => REVIEW.test(c.body));
    return r ? ms(r.createdAt) : null;
  };
  const perPr = (cut: (p: RawPr, review: number) => number | null): number | null =>
    median(prs.flatMap((p) => { const r = firstReview(p); const v = r === null ? null : cut(p, r); return v === null ? [] : [v]; }));
  const stages: Record<FlowStage, number | null> = {
    request: requestCreatedAt === null ? null : between(ms(requestCreatedAt), ms(raw.createdAt)),
    split: between(ms(raw.createdAt), splitEndAt),
    wait: between(splitEndAt, start),
    build: between(firstClaim, firstPrAt),
    "review-wait": perPr((p, r) => between(ms(p.createdAt), r)),
    review: perPr((p, r) => (p.mergedAt ? between(r, ms(p.mergedAt)) : null)),
    close: between(lastMerge, ms(raw.closedAt)),
  };
  return {
    number: raw.number,
    title: raw.title,
    storyPoints: raw.storyPoints,
    closedAt: raw.closedAt,
    stages,
    userWaitMs: [raw.comments, ...tasks.map((t) => t.comments)].reduce((sum, cs) => sum + userWait(cs), 0), // pair ask and answer within one Issue
    reviewRounds: prs.map((p) => p.comments.filter((c) => REVIEW.test(c.body)).length),
  };
}

/** Reading GitHub stops before it starts when the GraphQL budget is this low (the budget is shared by every Task on the host). */
export const MIN_REMAINING = 500;
/** ... and stops when one run has spent this many points. */
export const MAX_COST = 100;

export class FlowError extends Error {}

// A comment list costs nothing by its size (only its parents' count multiplies), so every one is read at the most a page holds.
const COMMENTS_MAX = 100;
const comments = `comments(first: ${COMMENTS_MAX}) { totalCount nodes { createdAt body } }`;
// The cost of a query is its count of connection requests, parents multiplied in: a PBI costs 3 + tasks × (2 + PRs). A page is
// read with few Tasks and PRs (about 0.3 point a PBI); a PBI that has more is read again alone, wider (see `fetchFlow`).
const pbiFields = (tasks: number, prs: number) => `number title createdAt closedAt body ${comments}
  projectItems(first: 5) { nodes { fieldValueByName(name: "Story Points") { ... on ProjectV2ItemFieldNumberValue { number } } } }
  subIssues(first: ${tasks}) { totalCount nodes { number createdAt closedAt ${comments}
    closedByPullRequestsReferences(first: ${prs}, includeClosedPrs: true) { totalCount nodes { number createdAt mergedAt ${comments} } } } }`;
export const FLOW_QUERY = `query($q: String!, $after: String) { rateLimit { cost remaining }
  search(query: $q, type: ISSUE, first: 25, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on Issue { ${pbiFields(10, 1)} } } } }`;
const WIDE = { tasks: 30, prs: 3 };
const wideQuery = (numbers: number[], owner: string, name: string) =>
  `{ rateLimit { cost } repository(owner: "${owner}", name: "${name}") { ${numbers.map((n) => `i${n}: issue(number: ${n}) { ${pbiFields(WIDE.tasks, WIDE.prs)} }`).join(" ")} } }`;

type Nodes<T> = { nodes: T[] };
type GqlComments = { comments: { totalCount: number } & Nodes<RawComment> };
type GqlPbi = GqlComments & Omit<RawPbi, "comments" | "subIssues" | "storyPoints"> & {
  projectItems: Nodes<{ fieldValueByName: { number?: number } | null }>;
  subIssues: { totalCount: number } & Nodes<GqlComments & Omit<RawTask, "comments" | "pullRequests"> & { closedByPullRequestsReferences: { totalCount: number } & Nodes<GqlComments & Omit<RawPr, "comments">> }>;
};

/** The Issue a PBI came from: the first `#N` in its `## 元要望` section (null when it says "なし"). */
export function requestOf(body: string): number | null {
  const section = /^## 元要望\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body)?.[1] ?? "";
  const n = /#(\d+)/.exec(section)?.[1];
  return n ? Number(n) : null;
}

/** Did the page cut off Tasks or PRs of this PBI? */
const cutOff = (g: GqlPbi): boolean => g.subIssues.totalCount > g.subIssues.nodes.length || g.subIssues.nodes.some((t) => t.closedByPullRequestsReferences.totalCount > t.closedByPullRequestsReferences.nodes.length);

/** How many of its lists (comments, Tasks, PRs) hold fewer than GitHub has: the numbers cut from them come out low. */
function cutLists(g: GqlPbi): number {
  const short = (c: { totalCount: number; nodes: unknown[] }): number => (c.totalCount > c.nodes.length ? 1 : 0);
  return short(g.comments) + short(g.subIssues) + g.subIssues.nodes.reduce((n, t) => n + short(t.comments) + short(t.closedByPullRequestsReferences) + t.closedByPullRequestsReferences.nodes.reduce((m, p) => m + short(p.comments), 0), 0);
}

/** A PBI as GitHub answers it → the plain shape `flowOfPbi` reads. Only merged PRs stay (a closed-unmerged PR is not a way the PBI got built). */
export function rawOfGql(g: GqlPbi): RawPbi {
  return {
    number: g.number, title: g.title, createdAt: g.createdAt, closedAt: g.closedAt, body: g.body,
    storyPoints: g.projectItems.nodes.map((i) => i.fieldValueByName?.number).find((n) => typeof n === "number") ?? null,
    comments: g.comments.nodes,
    subIssues: g.subIssues.nodes.map((t) => ({
      number: t.number, createdAt: t.createdAt, closedAt: t.closedAt, comments: t.comments.nodes,
      pullRequests: t.closedByPullRequestsReferences.nodes.filter((p) => p.mergedAt).map((p) => ({ number: p.number, createdAt: p.createdAt, mergedAt: p.mergedAt, comments: p.comments.nodes })),
    })),
  };
}

/** `o/r` of a GitHub remote URL (https, ssh, scp-like; with or without `.git`), lower-cased; null for another host. */
export function repoOfRemote(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export type FlowRead = { pbi: FlowPbi; issues: number[] };

async function graphql(gh: GhRunner, cwd: string, query: string, vars: Record<string, string> = {}): Promise<any> {
  const args = ["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
  const r = await gh(args, cwd);
  // gh exits 1 on any GraphQL error but still prints the data it got (an alias for a number that is not an Issue is one).
  let j: { data?: unknown; errors?: Array<{ message: string }> } = {};
  try { j = JSON.parse(r.stdout); } catch { /* not JSON: reported below */ }
  if (!j.data) throw new FlowError(`gh api graphql が失敗しました: ${j.errors?.[0]?.message ?? r.stderr.trim().split("\n")[0] ?? r.code}`);
  return j.data;
}

/**
 * The PBIs closed in the last `days` days, each cut into stages. Reads the remaining budget first and reads nothing when it
 * is under MIN_REMAINING; gives up when the pages spend more than MAX_COST.
 */
export async function fetchFlow(gh: GhRunner, cwd: string, repo: string, days: number, now = Date.now(), maxCost = MAX_COST): Promise<{ reads: FlowRead[]; spent: number; cutPbis: number[] }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new FlowError(`リポジトリ名の形が違います: ${repo}`);
  const first = (await graphql(gh, cwd, "{ rateLimit { remaining cost } }")).rateLimit as { remaining: number; cost?: number };
  const left = first.remaining;
  if (left < MIN_REMAINING) throw new FlowError(`GitHub の API の残りが少ない（残り ${left}）`);
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const q = `repo:${repo} is:issue label:type:pbi is:closed closed:>=${since} sort:closed-asc`;
  const gqls: GqlPbi[] = [];
  let spent = first.cost ?? 1;
  // Stops before a call that would take the run over MAX_COST (`estimate`: what the call is expected to cost), not after.
  const spend = async <T extends { rateLimit: { cost: number } }>(estimate: number, call: () => Promise<T>): Promise<T> => {
    if (spent + estimate > maxCost) throw new FlowError(`読むのに ${maxCost} ポイントを超えそうです（ここまで ${spent}、次は約 ${estimate}）。--days を減らしてください`);
    const d = await call();
    spent += d.rateLimit.cost;
    return d;
  };
  let pageCost = 10;
  for (let after = ""; ; ) {
    const before = spent;
    const d = await spend(pageCost, () => graphql(gh, cwd, FLOW_QUERY, after ? { q, after } : { q }));
    pageCost = spent - before;
    gqls.push(...(d.search.nodes as GqlPbi[]).filter((n) => n?.closedAt));
    if (!d.search.pageInfo.hasNextPage) break;
    after = d.search.pageInfo.endCursor;
  }
  const [owner, name] = repo.split("/");
  const wide = new Map<number, GqlPbi>();
  const cut = gqls.filter(cutOff).map((g) => g.number);
  for (let i = 0; i < cut.length; i += 5) {
    const d = await spend(10, () => graphql(gh, cwd, wideQuery(cut.slice(i, i + 5), owner!, name!)));
    for (const n of cut.slice(i, i + 5)) if (d.repository[`i${n}`]) wide.set(n, d.repository[`i${n}`]);
  }
  const final = gqls.map((g) => wide.get(g.number) ?? g);
  const raws = final.map(rawOfGql);
  // The request Issues' times, one query with an alias each.
  const requests = [...new Set(raws.flatMap((r) => requestOf(r.body) ?? []))];
  const at = new Map<number, string>();
  if (requests.length) {
    const d = await spend(1, () => graphql(gh, cwd, `{ rateLimit { cost } repository(owner: "${owner}", name: "${name}") { ${requests.map((n) => `r${n}: issue(number: ${n}) { createdAt }`).join(" ")} } }`));
    for (const n of requests) if (d.repository[`r${n}`]?.createdAt) at.set(n, d.repository[`r${n}`].createdAt);
  }
  const reads = raws.map((r) => {
    const req = requestOf(r.body);
    const f = flowOfPbi(r, req === null ? null : (at.get(req) ?? null));
    return { pbi: { ...f, repo, url: `https://github.com/${repo}/issues/${r.number}`, tasks: null }, issues: [r.number, ...r.subIssues.map((t) => t.number)] };
  });
  return { reads, spent, cutPbis: final.filter((g) => cutLists(g) > 0).map((g) => g.number) };
}

/** Fills `tasks` with the Switchboard Tasks of the PBI or one of its Tasks in these workspaces (stage Task or title `#N `). `db` null = not read. */
export function withSwitchboardTasks(read: FlowRead, db: Database | null, workspaceIds: string[]): FlowPbi {
  if (!db) return read.pbi;
  const rows = tasksOfIssues(db, read.issues, workspaceIds);
  return { ...read.pbi, tasks: { count: rows.length, runMs: rows.reduce((s, r) => s + r.durationMs, 0), costUsd: rows.reduce((s, r) => s + r.costUsd, 0) } };
}


/** Nearest rank. */
const percentile = (xs: number[], p: number): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1]! : null);

export function summarize(pbis: FlowPbi[]): FlowSummary {
  const stages = {} as Record<FlowStage, FlowStageSummary>;
  for (const st of FlowStage.options) {
    const xs = pbis.flatMap((p) => p.stages[st] ?? []);
    stages[st] = { p50: median(xs), p90: percentile(xs, 0.9), count: xs.length };
  }
  const known = FlowStage.options.filter((st) => stages[st].p50 !== null);
  const bottleneck = known.length ? known.reduce((a, b) => (stages[b].p50! > stages[a].p50! ? b : a)) : null;
  return { stages, bottleneck, closed: pbis.length, storyPoints: pbis.reduce((s, p) => s + (p.storyPoints ?? 0), 0) };
}

/** What `flowView` reads and leaves out for these workspaces — the cache's scope: an import that finishes later (a repository, or another workspace of one already read) is not left out for the hour. */
export const flowScope = (workspaces: FlowWorkspace[]): string => workspaces.map((w) => `${w.id}=${w.repository?.toLowerCase() ?? ""}`).sort().join(",");

/** The API reads two periods at once (60 days: about 120 points at the rate measured in docs/design/flow-metrics.md), so it is allowed more than the command. */
export const FLOW_VIEW_MAX_COST = 200;
const SLOWEST = 5;
const total = (p: FlowPbi): number => FlowStage.options.reduce((s, st) => s + (p.stages[st] ?? 0), 0);

/** A workspace's repository as the import stored it (`owner/name`); null when it was never imported — the Backlog screen says so, and there is no repository to read. */
export type FlowWorkspace = { id: string; name: string; path: string; repository: string | null };

/**
 * The last `days` days and the `days` before, over the repositories of these workspaces (one read per repository; Switchboard
 * Tasks count from the workspaces of that repository). A repository that cannot be read is in `errors` (once per workspace),
 * the rest are answered.
 */
export async function flowView(gh: GhRunner, workspaces: FlowWorkspace[], db: Database | null, days = 30, now = Date.now()): Promise<FlowView> {
  const errors: FlowView["errors"] = [];
  const unread = workspaces.filter((w) => !w.repository).map((w) => w.name);
  const byRepo = new Map<string, FlowWorkspace[]>();
  for (const w of workspaces) {
    if (w.repository) byRepo.set(w.repository.toLowerCase(), [...(byRepo.get(w.repository.toLowerCase()) ?? []), w]);
  }
  const pbis: FlowPbi[] = [];
  for (const [repo, ws] of byRepo) {
    try {
      const { reads } = await fetchFlow(gh, ws[0]!.path, repo, days * 2, now, FLOW_VIEW_MAX_COST);
      // the search cuts at the day (midnight), so the earliest PBIs read may be older than the previous period
      pbis.push(...reads.filter((r) => Date.parse(r.pbi.closedAt) >= now - days * 2 * 86_400_000).map((r) => withSwitchboardTasks(r, db, ws.map((w) => w.id))));
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      for (const w of ws) errors.push({ workspace: w.name, message: e.message });
    }
  }
  const edge = now - days * 86_400_000;
  const current = pbis.filter((p) => Date.parse(p.closedAt) >= edge);
  const previous = pbis.filter((p) => Date.parse(p.closedAt) < edge);
  const slowest = [...current].sort((a, b) => total(b) - total(a)).slice(0, SLOWEST);
  return { days, fetchedAt: now, current: summarize(current), previous: summarize(previous), slowest, errors, unread };
}

/**
 * `flowView` held for an hour: a read that left any workspace unread (`errors`) is not held, so the next look asks again; nor
 * is one held for a different `scope` (the repositories imported by then) than the look asks for. `refresh` reads again.
 * Calls at the same time share one read.
 */
export class FlowCache {
  private held: { view: FlowView; scope: string } | null = null;
  private reading: Promise<FlowView> | null = null;
  constructor(private readonly read: (now: number) => Promise<FlowView>, private readonly scope: () => string = () => "", private readonly ttlMs = 3_600_000, private readonly clock = () => Date.now()) {}

  async get(refresh = false): Promise<FlowView> {
    const now = this.clock();
    const scope = this.scope();
    if (!refresh && this.held && this.held.scope === scope && now - this.held.view.fetchedAt < this.ttlMs) return this.held.view;
    if (!this.reading) {
      const reading = this.read(now).then((v) => {
        this.held = v.errors.length ? null : { view: v, scope };
        return v;
      });
      this.reading = reading;
      void reading.then(() => undefined, () => undefined).finally(() => { if (this.reading === reading) this.reading = null; });
    }
    return this.reading;
  }
}
