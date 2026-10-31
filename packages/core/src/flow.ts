/**
 * How long a closed PBI took, stage by stage (#650). Pure: it takes the times of the Issues and comments the app stores
 * (#3070) and of the merged PRs GitHub holds (`createdAt`), and cuts them at the marks the skills leave. The Project's Status history is not read — a Status changed
 * through the API leaves no timeline event. A stage whose mark is missing is null, never guessed. docs/design/flow-metrics.md.
 */
import { FlowStage, type CreatedIssue, type FlowPbi, type FlowStageSummary, type FlowSummary, type FlowView, type FlowWeek } from "@switchboard/protocol";
import type { Database } from "bun:sqlite";
import { deferredTasksSince, tasksOfIssues, type Db } from "./db.ts";
import { readStoredRecords, type GhRunner } from "./backlog.ts";
import { closesOf } from "./backlog-sync.ts";
import type { StoredRecords } from "../../../ops-kit/src/backlog-client.ts";

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
const CLAIM_TOKEN = /^<!-- parallel-guard:task-claim (\S+) -->/m;
const WITHDRAW = /<!-- parallel-guard:withdraw (\S+) -->/; // a Task that yielded takes its claim back: it had not started
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
  const claims = tasks.flatMap((t) => {
    const back = new Set(t.comments.flatMap((c) => WITHDRAW.exec(c.body)?.[1] ?? []));
    return t.comments.filter((c) => CLAIM.test(c.body) && !back.has(CLAIM_TOKEN.exec(c.body)?.[1] ?? "")).map((c) => ms(c.createdAt));
  });
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

/** The PBIs and requests opened and closed in one week (#1878), from the stored times. */
export type GrowthCounts = { weekStart: string; pbiOpened: number; pbiClosed: number; requestOpened: number; requestClosed: number };

const DAY = 86_400_000;
/** The Monday 00:00 UTC that starts the week of `ms`. */
export const weekStartOf = (ms: number): number => {
  const day = Math.floor(ms / DAY) * DAY;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
};
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** The Monday of every week from the one `days` days before `now` to `now`'s. */
const weekStarts = (days: number, now: number): number[] => {
  const out: number[] = [];
  for (let w = weekStartOf(now - days * DAY); w <= weekStartOf(now); w += 7 * DAY) out.push(w);
  return out;
};
type GqlComments = { comments: { totalCount: number; nodes: RawComment[] } };

/** The Issue a PBI came from: the first `#N` in its `## 元要望` section (null when it says "なし"). */
export function requestOf(body: string): number | null {
  const section = /^## 元要望\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body)?.[1] ?? "";
  const n = /#(\d+)/.exec(section)?.[1];
  return n ? Number(n) : null;
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

/** A merged PR with the Tasks it closes (closesOf: the parallel guard's rule, from its body and branch). */
export type StoredFlowPr = RawPr & { closes: number[] };

const PR_QUERY = `query($q: String!, $after: String) { rateLimit { cost remaining }
  search(query: $q, type: ISSUE, first: 50, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { number createdAt mergedAt body headRefName ${comments} } } } }`;

/** GitHub's search answers this many results at the most, however many pages are read. */
const SEARCH_MAX = 1000;

/**
 * The PRs of `repo` merged on or after `since` (a UTC day), with their comments: the only thing the flow reads from GitHub
 * (#3070; the Issues come from the app's stored values). Each 7 days from `since` is one search (`merged:<day>..<day + 6>`),
 * so the search's 1,000-result cap is per 7 days; a week over it stops the read (FlowError), never a count
 * cut silently. Reads the remaining budget first and nothing under MIN_REMAINING; stops before a page that would take the
 * run over `maxCost`. `cutPrs`: PRs with more comments than one read holds.
 */
export async function fetchMergedPrs(gh: GhRunner, cwd: string, repo: string, since: string, maxCost = MAX_COST, now = Date.now()): Promise<{ prs: StoredFlowPr[]; spent: number; cutPrs: number[] }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new FlowError(`リポジトリ名の形が違います: ${repo}`);
  const first = (await graphql(gh, cwd, "{ rateLimit { remaining cost } }")).rateLimit as { remaining: number; cost?: number } | undefined;
  if (typeof first?.remaining !== "number") throw new FlowError("GitHub の API の使用量を読めませんでした（rateLimit がありません）");
  if (first.remaining < MIN_REMAINING) throw new FlowError(`GitHub の API の残りが少ない（残り ${first.remaining}）`);
  let spent = first.cost ?? 1;
  let pageCost = 10;
  const prs = new Map<number, StoredFlowPr>();
  const cutPrs = new Set<number>();
  for (let w = Date.parse(`${since}T00:00:00Z`); w <= now; w += 7 * DAY) {
    const q = `repo:${repo} is:pr is:merged merged:${ymd(w)}..${ymd(w + 6 * DAY)}`;
    for (let after = ""; ; ) {
      if (spent + pageCost > maxCost) throw new FlowError(`読むのに ${maxCost} ポイントを超えそうです（ここまで ${spent}、次は約 ${pageCost}）。--days を減らしてください`);
      const d = await graphql(gh, cwd, PR_QUERY, after ? { q, after } : { q });
      pageCost = d.rateLimit.cost;
      spent += pageCost;
      if (d.search.issueCount > SEARCH_MAX) throw new FlowError(`${ymd(w)} からの 1 週間にマージされた PR が ${d.search.issueCount} 件あり、GitHub の検索の上限 ${SEARCH_MAX} 件を超えます`);
      type Node = { number: number; createdAt: string; mergedAt: string | null; body: string | null; headRefName: string | null } & GqlComments;
      for (const n of d.search.nodes as Node[]) {
        if (!n?.mergedAt) continue;
        if (n.comments.totalCount > n.comments.nodes.length) cutPrs.add(n.number);
        prs.set(n.number, { number: n.number, createdAt: n.createdAt, mergedAt: n.mergedAt, comments: n.comments.nodes, closes: closesOf(n.body, n.headRefName) });
      }
      if (!d.search.pageInfo.hasNextPage) break;
      after = d.search.pageInfo.endCursor;
    }
  }
  return { prs: [...prs.values()], spent, cutPrs: [...cutPrs] };
}

type StoredIssue = StoredRecords["issues"][number];
const isType = (i: StoredIssue, type: string) => i.labels.includes(`type:${type}`);

/** The stored PBIs closed in the last `days` days. */
export const closedPbis = (records: StoredRecords, days: number, now: number): StoredIssue[] =>
  records.issues.filter((i) => isType(i, "pbi") && i.state === "CLOSED" && i.closedAt !== null && ms(i.closedAt) >= now - days * DAY && ms(i.closedAt) <= now);

/**
 * The PBIs closed in the last `days` days, each cut into stages, from the app's stored Issues, comments and Story Points
 * (#3070: a PBI kept in the app only counts too), with the merged PRs read from the code host (`prs`: their Tasks by
 * `closes`); and each week's PBIs and requests opened and closed, from the stored times.
 */
export function flowOfStored(records: StoredRecords, prs: StoredFlowPr[], days: number, now: number): { reads: FlowRead[]; growth: GrowthCounts[] } {
  const byNumber = new Map(records.issues.map((i) => [i.number, i]));
  const said = new Map<number, RawComment[]>();
  for (const c of records.comments) said.set(c.issue, [...(said.get(c.issue) ?? []), { createdAt: c.createdAt, body: c.body }]);
  const commentsOf = (n: number) => said.get(n) ?? [];
  const reads = closedPbis(records, days, now).map((p): FlowRead => {
    const points = p.fields?.["Story Points"];
    const raw: RawPbi = {
      number: p.number, title: p.title, createdAt: p.createdAt, closedAt: p.closedAt!, body: p.body,
      storyPoints: typeof points === "number" ? points : null,
      comments: commentsOf(p.number),
      subIssues: p.subIssues.flatMap((n) => {
        const t = byNumber.get(n);
        // only merged PRs: a closed-unmerged one is not a way the PBI got built
        return t ? [{ number: n, createdAt: t.createdAt, closedAt: t.closedAt, comments: commentsOf(n), pullRequests: prs.filter((pr) => pr.mergedAt && pr.closes.includes(n)).map(({ closes: _, ...pr }) => pr) }] : [];
      }),
    };
    const req = requestOf(p.body);
    const f = flowOfPbi(raw, req === null ? null : (byNumber.get(req)?.createdAt ?? null));
    const url = records.service === "github" ? `https://github.com/${records.repository}/issues/${p.number}` : p.url;
    return { pbi: { ...f, repo: records.repository, url, tasks: null }, issues: [p.number, ...p.subIssues] };
  });
  const weeks = weekStarts(days, now);
  const growth = weeks.map((w): GrowthCounts => ({ weekStart: ymd(w), pbiOpened: 0, pbiClosed: 0, requestOpened: 0, requestClosed: 0 }));
  const bump = (at: string | null, key: keyof Omit<GrowthCounts, "weekStart">) => {
    const g = at === null ? undefined : growth[(weekStartOf(ms(at)) - weeks[0]!) / (7 * DAY)];
    if (g) g[key]++;
  };
  for (const i of records.issues) {
    if (isType(i, "pbi")) bump(i.createdAt, "pbiOpened"), bump(i.state === "CLOSED" ? i.closedAt : null, "pbiClosed");
    else if (isType(i, "request")) bump(i.createdAt, "requestOpened"), bump(i.state === "CLOSED" ? i.closedAt : null, "requestClosed");
  }
  return { reads, growth };
}

/** The GitHub repository whose PRs a workspace's flow reads: its backlog's own (GitHub), else its checkout's `origin` (a backlog kept in the app only); null = none to read. */
export function prRepoOf(records: StoredRecords, path: string): string | null {
  if (records.service === "github") return records.repository;
  if (records.service !== "switchboard") return null;
  const r = Bun.spawnSync(["git", "-C", path, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? repoOfRemote(r.stdout.toString()) : null;
}

/**
 * The PBIs closed in the last `days` days, each cut into stages, and each week's PBIs and requests opened and closed, for
 * the command (scripts/flow-report.ts): the Issues from the app's stored values (`records`), the merged PRs of `repo` from
 * GitHub (fetchMergedPrs, under `maxCost`; null = none read, the PR stages unknown). `cutPbis`: PBIs with a PR whose comments were cut (their numbers come out low).
 */
export async function fetchFlow(gh: GhRunner, cwd: string, repo: string | null, days: number, records: StoredRecords, now = Date.now(), maxCost = MAX_COST): Promise<{ reads: FlowRead[]; spent: number; cutPbis: number[]; growth: GrowthCounts[] }> {
  const read = closedPbis(records, days, now);
  const since = read.length ? ymd(Math.min(...read.map((p) => ms(p.createdAt)))) : null;
  const { prs, spent, cutPrs } = repo && since ? await fetchMergedPrs(gh, cwd, repo, since, maxCost, now) : { prs: [], spent: 0, cutPrs: [] };
  const { reads, growth } = flowOfStored(records, prs, days, now);
  const cut = new Set(prs.filter((p) => cutPrs.includes(p.number)).flatMap((p) => p.closes));
  return { reads, spent, cutPbis: reads.filter((r) => r.issues.some((n) => cut.has(n))).map((r) => r.pbi.number), growth };
}

const WEEK_COUNTS = ["pbiOpened", "pbiClosed", "requestOpened", "requestClosed", "net", "deferredTasks", "deferredIssues"] as const;

/**
 * The weeks from the one `days` days ago to this one (#1878), an empty week as zeros: the PBIs and requests of the stored values
 * (`counts`, by `weekStart`), `net` = opened − closed, and the deferred Tasks by when their last turn ended, with the Issues of
 * `repo` they opened.
 */
export function backlogGrowth(counts: GrowthCounts[], deferred: Array<{ endedAt: number; issues: CreatedIssue[] }>, repo: string, days: number, now: number): FlowWeek[] {
  const starts = weekStarts(days, now);
  const weeks = starts.map((w): FlowWeek => {
    const c = counts.find((x) => x.weekStart === ymd(w));
    return { weekStart: ymd(w), pbiOpened: c?.pbiOpened ?? 0, pbiClosed: c?.pbiClosed ?? 0, requestOpened: c?.requestOpened ?? 0, requestClosed: c?.requestClosed ?? 0, net: 0, deferredTasks: 0, deferredIssues: 0 };
  });
  for (const t of deferred) {
    const w = t.endedAt < starts[0]! || t.endedAt > now ? undefined : weeks[(weekStartOf(t.endedAt) - starts[0]!) / (7 * DAY)];
    if (!w) continue;
    w.deferredTasks++;
    w.deferredIssues += t.issues.filter((i) => i.repo === repo.toLowerCase()).length;
  }
  for (const w of weeks) w.net = w.pbiOpened + w.requestOpened - w.pbiClosed - w.requestClosed;
  return weeks;
}

/** Fills `tasks` with the Switchboard Tasks of the PBI or one of its Tasks in these workspaces (stage Task or title `#N `). `db` null = not read. */
export function withSwitchboardTasks(read: FlowRead, db: Database | null, workspaceIds: string[]): FlowPbi {
  if (!db) return read.pbi;
  const rows = tasksOfIssues(db, read.issues, workspaceIds);
  const implementLaunches = rows.filter((r) => r.stageIssue === read.pbi.number && r.stageAction === "complete").length;
  return { ...read.pbi, tasks: { count: rows.length, runMs: rows.reduce((s, r) => s + r.durationMs, 0), costUsd: rows.reduce((s, r) => s + r.costUsd, 0), implementLaunches } };
}

/** Of the PBIs whose Switchboard Tasks were read (`known`), how many had 実装 started 3 times or more (`repeated`). */
export function launchShare(pbis: FlowPbi[]): { repeated: number; known: number } {
  const known = pbis.filter((p) => p.tasks !== null);
  return { repeated: known.filter((p) => p.tasks!.implementLaunches >= 3).length, known: known.length };
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

/** The API reads two periods at once, so it is allowed more than the command. */
export const FLOW_VIEW_MAX_COST = 200;
const SLOWEST = 5;
const total = (p: FlowPbi): number => FlowStage.options.reduce((s, st) => s + (p.stages[st] ?? 0), 0);

/** A workspace's repository as the import stored it (`owner/name`; a backlog kept in the app only: its id); null when it was never imported — the Backlog screen says so, and there is nothing to read. */
export type FlowWorkspace = { id: string; name: string; path: string; repository: string | null };

/**
 * The last `days` days and the `days` before, over the stored backlogs of these workspaces (one read per backlog; Switchboard
 * Tasks count from the workspaces of that backlog). The PRs come from the code host: a backlog whose PRs cannot be read is
 * in `errors` (once per workspace), the rest are answered. One with no GitHub repository to read PRs from is answered
 * without them (the PR stages unknown).
 */
export async function flowView(gh: GhRunner, workspaces: FlowWorkspace[], db: Db | null, days = 30, now = Date.now()): Promise<FlowView> {
  const errors: FlowView["errors"] = [];
  const unread: string[] = [];
  const byRepo = new Map<string, FlowWorkspace[]>();
  for (const w of workspaces) {
    if (w.repository) byRepo.set(w.repository.toLowerCase(), [...(byRepo.get(w.repository.toLowerCase()) ?? []), w]);
  }
  const pbis: FlowPbi[] = [];
  let weeks = backlogGrowth([], [], "", days, now);
  for (const w of workspaces) if (!w.repository) unread.push(w.name);
  for (const [, ws] of byRepo) {
    const records = db ? readStoredRecords(db, ws[0]!) : null;
    if (!records) {
      unread.push(...ws.map((w) => w.name));
      continue;
    }
    try {
      const prRepo = prRepoOf(records, ws[0]!.path);
      const read = closedPbis(records, days * 2, now);
      const since = read.length ? ymd(Math.min(...read.map((p) => ms(p.createdAt)))) : null;
      const prs = prRepo && since ? (await fetchMergedPrs(gh, ws[0]!.path, prRepo, since, FLOW_VIEW_MAX_COST, now)).prs : [];
      const { reads, growth } = flowOfStored(records, prs, days * 2, now);
      const deferred = db ? deferredTasksSince(db.sqlite, ws.map((w) => w.id), weekStartOf(now - days * DAY)) : [];
      const mine = backlogGrowth(growth, deferred, records.repository, days, now);
      for (const [i, w] of mine.entries()) for (const k of WEEK_COUNTS) weeks[i]![k] += w[k];
      pbis.push(...reads.map((r) => withSwitchboardTasks(r, db?.sqlite ?? null, ws.map((w) => w.id))));
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      for (const w of ws) errors.push({ workspace: w.name, message: e.message });
    }
  }
  const edge = now - days * 86_400_000;
  const current = pbis.filter((p) => Date.parse(p.closedAt) >= edge);
  const previous = pbis.filter((p) => Date.parse(p.closedAt) < edge);
  const slowest = [...current].sort((a, b) => total(b) - total(a)).slice(0, SLOWEST);
  return { days, fetchedAt: now, current: summarize(current), previous: summarize(previous), slowest, errors, unread, weeks };
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
