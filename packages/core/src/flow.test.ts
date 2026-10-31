import { describe, expect, test } from "bun:test";
import { Db } from "./db.ts";
import { backlogGrowth, fetchFlow, fetchMergedPrs, FlowCache, FlowError, flowOfPbi, flowOfStored, flowScope, flowView, launchShare, weekStartOf, repoOfRemote, requestOf, summarize, withSwitchboardTasks, type RawComment, type RawPbi, type RawPr } from "./flow.ts";
import type { StoredRecords } from "../../../ops-kit/src/backlog-client.ts";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import type { BacklogSource, FlowView } from "@switchboard/protocol";
import { createStoredIssue, type GhRunner } from "./backlog.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";

const MIN = 60_000;
/** Made-up round times on one day (UTC), not a real PBI's. */
const at = (hm: string) => `2026-01-05T${hm}:00Z`;
const comment = (hm: string, body: string): RawComment => ({ createdAt: at(hm), body });

/**
 * A made-up closed PBI #10: three Tasks with one merged PR each, both forms of the claim mark, reviews by three reviewers
 * among PR comments that are not reviews, the PBI's own pbi-complete claim, and one ask answered on the PBI. With
 * `marks = false` the claims, the reviews and the ask / answer are left out, as when the skills left none.
 */
function madeUpPbi(marks = true): RawPbi {
  const c = comment;
  const m = (...cs: RawComment[]) => (marks ? cs : []);
  const pr = (number: number, created: string, merged: string, comments: RawComment[]): RawPr => ({ number, createdAt: at(created), mergedAt: at(merged), comments });
  return {
    number: 10, title: "PBI: x", createdAt: at("09:00"), closedAt: at("12:08"), body: "", storyPoints: 5,
    comments: [c("10:03", "<!-- pbi-complete:claim -->\n着手（/pbi-complete）"), // a line a Task claim also starts with: read only on Tasks
      ...m(c("10:50", "## 判断待ち"), c("11:15", "## 回答")), c("11:30", "## 状況")],
    subIssues: [
      { number: 11, createdAt: at("09:58"), closedAt: at("11:01"), comments: [...m(c("10:05", "<!-- parallel-guard:task-claim -->"), c("10:06", "着手（/pbi-complete #10）")), c("10:16", "PR: #21")],
        pullRequests: [pr(21, "10:15", "11:00", [c("10:19", "[claude] - [nit] x"), ...m(c("10:20", "[claude] review")), c("10:25", "[claude] の nit に返信"), ...m(c("10:30", "[claude] review（見直し）")), c("10:40", "## レビュー対応")])] },
      { number: 12, createdAt: at("09:59"), closedAt: at("11:18"), comments: [...m(c("10:20", "着手（/pbi-complete #10）")), c("10:26", "PR: #22")],
        pullRequests: [pr(22, "10:25", "11:17", [...m(c("10:27", "[codex] review"), c("10:35", "[codex] review（見直し）")), c("10:45", "## レビュー対応")])] },
      { number: 13, createdAt: at("10:00"), closedAt: at("11:49"), comments: [...m(c("10:40", "<!-- parallel-guard:task-claim -->")), c("10:46", "PR: #23")],
        pullRequests: [pr(23, "10:45", "11:48", [...m(c("10:48", "[dak] review"), c("11:00", "[claude] review（見直し）"), c("11:10", "[claude] review（見直し）")), c("11:12", "## レビュー対応")])] },
    ],
  };
}

describe("flow", () => {
  test("stages of a closed PBI", () => {
    const f = flowOfPbi(madeUpPbi(), at("08:50"));
    expect(f.stages).toEqual({
      request: 10 * MIN, // 08:50 → PBI 09:00
      split: 60 * MIN, // PBI → last Task (#13) 10:00
      wait: 5 * MIN, // 10:00 → first Task claim (#11) 10:05, not the PBI's pbi-complete claim at 10:03
      build: 10 * MIN, // 10:05 → first PR (#21) 10:15
      "review-wait": 3 * MIN, // PR 21 5m / 22 2m / 23 3m → median
      review: 50 * MIN, // PR 21 40m / 22 50m / 23 60m → median
      close: 20 * MIN, // last merge (#23) 11:48 → closed 12:08
    });
    expect(f.reviewRounds).toEqual([2, 2, 3]);
    expect(f.storyPoints).toBe(5);
  });

  test("missing markers are unknown", () => {
    const f = flowOfPbi(madeUpPbi(false), null);
    expect(f.stages.request).toBeNull(); // no request time given
    expect(f.stages.build).toBeNull(); // no claim comment
    expect(f.stages["review-wait"]).toBeNull();
    expect(f.stages.review).toBeNull();
    expect(f.stages.wait).toBe(15 * MIN); // falls back to the first PR: 10:00 → 10:15
    expect(f.stages.close).toBe(20 * MIN); // PR times are still there
    expect(f.reviewRounds).toEqual([0, 0, 0]);
  });

  test("user wait sums decision to answer", () => {
    expect(flowOfPbi(madeUpPbi(), null).userWaitMs).toBe(25 * MIN); // 判断待ち 10:50 → 回答 11:15
    const raw = madeUpPbi();
    raw.comments = raw.comments.filter((c) => !c.body.startsWith("## 回答"));
    expect(flowOfPbi(raw, null).userWaitMs).toBe(0); // an unanswered ask counts nothing
  });

  test("pairs ask and answer within each Issue", () => {
    const raw = madeUpPbi();
    raw.comments = [comment("10:00", "## 判断待ち"), comment("10:30", "## 回答")];
    raw.subIssues[0]!.comments = [comment("10:10", "## 判断待ち"), comment("10:20", "## 回答")];
    raw.subIssues[1]!.comments = [];
    raw.subIssues[2]!.comments = [];
    expect(flowOfPbi(raw, null).userWaitMs).toBe(40 * MIN); // 30 + 10, not the 20 a merged timeline gives
  });

  test("a PR that closes several Tasks counts once", () => {
    const raw = madeUpPbi();
    raw.subIssues[1]!.pullRequests = raw.subIssues[0]!.pullRequests;
    raw.subIssues[2]!.pullRequests = raw.subIssues[0]!.pullRequests;
    const f = flowOfPbi(raw, null);
    expect(f.reviewRounds).toEqual([2]);
    expect(f.stages["review-wait"]).toBe(5 * MIN);
  });

  test("a claim line after other text still marks the start", () => {
    const raw = madeUpPbi();
    for (const t of raw.subIssues) t.comments = t.comments.filter((c) => !/^(<!-- parallel-guard|着手)/.test(c.body));
    raw.subIssues[0]!.comments.push(comment("10:07", "進捗\n着手（Task #11）"));
    expect(flowOfPbi(raw, null).stages.build).toBe(8 * MIN); // 10:07 → 10:15
  });

  test("tasks added after the start", () => {
    const late = { number: 14, createdAt: at("11:00"), closedAt: at("11:30"), comments: [], pullRequests: [] };
    const raw = madeUpPbi();
    raw.subIssues.push(late);
    const f = flowOfPbi(raw, null);
    expect(f.stages.split).toBe(60 * MIN); // #14 came after the first claim (10:05): the split still ends at #13 10:00
    expect(f.stages.wait).toBe(5 * MIN);
    const bare = madeUpPbi(false);
    for (const t of bare.subIssues) t.pullRequests = [];
    bare.subIssues.push(late);
    const g = flowOfPbi(bare, null);
    expect(g.stages.split).toBe(120 * MIN); // no claim, no PR: the last Task (#14) 11:00
    expect(g.stages.wait).toBeNull();
  });
});

test("a claim taken back by a Task that yielded is not the start (#3069)", () => {
  const raw = madeUpPbi();
  const first = flowOfPbi(raw, null);
  raw.subIssues[0]!.comments.push(comment("09:59", "<!-- parallel-guard:task-claim t1 -->\n着手（parallel-guard）"), comment("10:00", "<!-- parallel-guard:withdraw t1 -->\n取り下げ（parallel-guard）"));
  expect(flowOfPbi(raw, null)).toEqual(first);
  raw.subIssues[0]!.comments.pop();
  expect(flowOfPbi(raw, null)).not.toEqual(first); // a claim that stands counts
});

const call = (calls: string[], reply: (q: string) => unknown): GhRunner => async (args) => {
  const q = args.find((a) => a.startsWith("query="))!;
  calls.push(`${q} ${args.filter((a) => a.startsWith("q=")).join(" ")}`);
  return { code: 0, stdout: JSON.stringify({ data: reply(q) }), stderr: "" };
};

/** Stored records (StoredRecords) of made-up Issues and comments: the shape GET /api/backlog/records answers. */
const storedOf = (issues: Array<Partial<StoredRecords["issues"][number]> & { number: number }>, comments: StoredRecords["comments"] = []): StoredRecords => ({
  workspaceId: "w", service: "github", repository: "o/r", project: { owner: "o", number: 1 }, fetchedAt: 1, top: [], unread: [], pulls: [], comments,
  issues: issues.map((i) => ({ title: `#${i.number}`, url: "", state: "OPEN", stateReason: null, body: "", labels: [], parent: null, subIssues: [], createdAt: "", updatedAt: "", closedAt: null, fields: null, ...i })),
});

describe("budget guard", () => {
  test("reads nothing when the remaining budget is under 500", async () => {
    const calls: string[] = [];
    const gh = call(calls, () => ({ rateLimit: { remaining: 100 } }));
    await expect(fetchMergedPrs(gh, ".", "o/r", "2026-10-01")).rejects.toThrow(FlowError);
    expect(calls).toHaveLength(1); // only the rateLimit check, no search
    expect(calls[0]).not.toContain("search");
  });

  test("stops when the pages spend more than 100 points", async () => {
    const calls: string[] = [];
    const gh = call(calls, (q) => (q.includes("search") ? { rateLimit: { cost: 60 }, search: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [] } } : { rateLimit: { remaining: 4000 } }));
    await expect(fetchMergedPrs(gh, ".", "o/r", "2026-10-01")).rejects.toThrow("100 ポイント");
    expect(calls.filter((q) => q.includes("search"))).toHaveLength(1); // the second page would have taken it to 121: not read
  });

  test("an answer without rateLimit is a FlowError, not a TypeError", async () => {
    const calls: string[] = [];
    const gh = call(calls, () => ({ search: {} }));
    await expect(fetchMergedPrs(gh, ".", "o/r", "2026-10-01")).rejects.toThrow(FlowError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("search");
  });
});

describe("fetchFlow", () => {
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  test("the Issues from the stored values, merged PRs only from GitHub, Story Points, the request's time", async () => {
    const c = (issue: number, createdAt: string, body: string) => ({ issue, createdAt, body });
    const records = storedOf([
      { number: 7, labels: ["type:pbi"], state: "CLOSED", createdAt: "2026-10-01T00:10:00Z", closedAt: "2026-10-01T05:00:00Z", body: "## 元要望\n#3（意図）\n**Story Points**: 3", subIssues: [8], fields: { "Story Points": 3 } },
      { number: 8, labels: ["type:task"], state: "CLOSED", createdAt: "2026-10-01T00:20:00Z", closedAt: "2026-10-01T04:00:00Z", parent: 7 },
      { number: 3, labels: ["type:request"], createdAt: "2026-10-01T00:00:00Z" },
    ], [c(8, "2026-10-01T01:00:00Z", "着手")]);
    const calls: string[] = [];
    const pr = (number: number, mergedAt: string | null, comments: unknown[], totalCount = comments.length) => ({ number, createdAt: "2026-10-01T02:00:00Z", mergedAt, body: "Closes #8", headRefName: `sb/8-x`, comments: { totalCount, nodes: comments } });
    const gh = call(calls, (q) => (q.includes("search") ? { rateLimit: { cost: 1 }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pr(9, "2026-10-01T04:00:00Z", [{ createdAt: "2026-10-01T02:30:00Z", body: "[codex] review 1" }], 101), pr(10, null, [])] } } : { rateLimit: { remaining: 4000, cost: 1 } }));
    const { reads: [r], spent, cutPbis } = await fetchFlow(gh, ".", "o/r", 30, records, NOW);
    expect(spent).toBe(4); // the budget check 1 + one page for each 7 days from the PBI's creation (10-01, 10-08, 10-15)
    expect(calls.find((q) => q.includes("search"))).toContain("q=repo:o/r is:pr is:merged merged:2026-10-01..2026-10-07"); // from the PBI's creation
    expect(calls.some((q) => /label:type:|is:issue/.test(q))).toBe(false); // no Issue is read from GitHub
    expect(r!.issues).toEqual([7, 8]);
    expect(r!.pbi.storyPoints).toBe(3);
    expect(r!.pbi.url).toBe("https://github.com/o/r/issues/7");
    expect(r!.pbi.stages.request).toBe(10 * MIN);
    expect(r!.pbi.stages.build).toBe(60 * MIN); // the stored claim 01:00 → the PR 02:00
    expect(r!.pbi.reviewRounds).toEqual([1]); // PR 10 was not merged
    expect(cutPbis).toEqual([7]); // PR 9 had more comments than one read holds
  });

  test("no GitHub repository known (a backlog kept in the app only): the PBI is answered with no PR read", async () => {
    const calls: string[] = [];
    const records = storedOf([{ number: 7, labels: ["type:pbi"], state: "CLOSED", createdAt: "2026-10-01T00:10:00Z", closedAt: "2026-10-01T05:00:00Z" }]);
    const { reads, spent } = await fetchFlow(call(calls, () => ({})), ".", null, 30, records, NOW);
    expect([reads.map((r) => r.pbi.number), spent, calls]).toEqual([[7], 0, []]);
  });

  test("no PBI closed in the period: GitHub is not read", async () => {
    const calls: string[] = [];
    const { reads, spent } = await fetchFlow(call(calls, () => ({})), ".", "o/r", 30, storedOf([{ number: 7, labels: ["type:pbi"] }]), NOW);
    expect([reads, spent, calls]).toEqual([[], 0, []]);
  });

  test("repoOfRemote reads GitHub remotes of every form and no other host", () => {
    for (const u of ["https://github.com/O/r.git", "https://github.com/o/r", "git@github.com:o/r", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "https://x-access-token@github.com/o/r.git\n"]) expect(repoOfRemote(u)).toBe("o/r");
    for (const u of ["git@example.invalid:o/r.git", "https://example.com/github.com/o/r", ""]) expect(repoOfRemote(u)).toBeNull();
  });

  test("requestOf reads the first number of the section", () => {
    expect(requestOf("## 背景\n#1\n## 元要望\n#636（x）\n#2\n**Story Points**: 5")).toBe(636);
    expect(requestOf("## 元要望\nなし（理由）\n## 結果\n#9")).toBeNull();
  });
});

describe("switchboard tasks", () => {
  const task = (id: string, title: string, stage: number | null, workspaceId = "w", action = "implement"): Task =>
    ({ id, workspaceId, title, runner: "claude", cwd: "/x", scope: { read: [], write: [] }, status: "done", runnerSessionId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "default", effort: null, origin: "user", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, statusAt: 1000, createdAt: 1000, updatedAt: 9000, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, stage: stage === null ? null : { issue: stage, action }, judgingAt: null }) as unknown as Task;

  test("counts the PBI's and its Tasks' Switchboard Tasks, with run time and cost", () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), "switchboard.flow.")), "s.db"));
    db.insertTask(task("a", "#7 PBI を分解", null));
    db.insertTask(task("b", "#8 実装", null));
    db.insertTask(task("c", "stage task", 8));
    db.insertTask(task("d", "#70 別の PBI", null)); // `#70 ` must not match `#7 `
    db.insertTask(task("e", "#9 別", null));
    db.insertTask(task("f", "#7 another repository", null, "other")); // the same number in a repository that is not read
    const led = (taskId: string, costUsd: number) => db.insertLedger({ taskId, runner: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd: costUsd, source: "api", ts: 2000 } as never);
    led("a", 1.5); led("b", 0.25); led("d", 100);
    db.appendEventAt("a", { type: "log", text: "x" } as never, 5000);
    const read = { pbi: { repo: "o/r", number: 7, title: "", url: "", storyPoints: 3, closedAt: "", stages: {}, userWaitMs: 0, reviewRounds: [], tasks: null } as never, issues: [7, 8] };
    const p = withSwitchboardTasks(read, db.sqlite, ["w"]);
    expect(p.tasks).toEqual({ count: 3, runMs: 4000 + 8000 + 8000, costUsd: 1.75, implementLaunches: 0 }); // a: last event 5000, b / c: updated_at 9000
    expect(withSwitchboardTasks(read, null, ["w"]).tasks).toBeNull();
    expect(withSwitchboardTasks(read, db.sqlite, []).tasks).toEqual({ count: 0, runMs: 0, costUsd: 0, implementLaunches: 0 }); // no workspace of the repository: nothing is anyone's
  });

  test("implement launches: the PBI's stage Tasks of 実装 (complete), not its other stages nor its Tasks'", () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), "switchboard.flow.")), "s.db"));
    for (const id of ["i1", "i2", "i3"]) db.insertTask(task(id, "#7 実装: PBI", 7, "w", "complete"));
    db.insertTask(task("t1", "#7 Task に分解: PBI", 7, "w", "to-tasks"));
    db.insertTask(task("c1", "#8 実装: Task", 8, "w", "complete")); // a Task's number, not the PBI's
    const read = { pbi: { repo: "o/r", number: 7, title: "", url: "", storyPoints: 3, closedAt: "", stages: {}, userWaitMs: 0, reviewRounds: [], tasks: null } as never, issues: [7, 8] };
    const p = withSwitchboardTasks(read, db.sqlite, ["w"]);
    expect(p.tasks).toMatchObject({ count: 5, implementLaunches: 3 });
    const once = { ...p, number: 9, tasks: { ...p.tasks!, implementLaunches: 1 } };
    expect(launchShare([p, once, { ...p, number: 10, tasks: null }])).toEqual({ repeated: 1, known: 2 });
  });
});

describe("summarize", () => {
  test("median, p90, bottleneck, totals; unknown stages are not counted", () => {
    const pbi = (n: number, build: number | null, sp: number | null) => ({ number: n, storyPoints: sp, stages: { build, close: 60_000 } }) as never;
    const s = summarize([pbi(1, 10 * MIN, 3), pbi(2, 30 * MIN, 5), pbi(3, null, null)]);
    expect(s.stages.build).toEqual({ p50: 20 * MIN, p90: 30 * MIN, count: 2 });
    expect(s.stages.close.count).toBe(3);
    expect(s.stages.split).toEqual({ p50: null, p90: null, count: 0 });
    expect(s.bottleneck).toBe("build");
    expect(s.closed).toBe(3);
    expect(s.storyPoints).toBe(8);
    expect(summarize([]).bottleneck).toBeNull();
  });
});

describe("flow view", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const iso = (t: number) => new Date(t).toISOString();
  /** A PBI #n closed `agoDays` days before `now`, its Task #n+1, and its PR #n+2 (merged `closeMin` before the close): the only measurable stage is `close`. */
  type Spec = { n: number; agoDays: number; closeMin: number; request?: { n: number; hoursBefore: number } };
  const spec = (n: number, agoDays: number, closeMin: number): Spec => ({ n, agoDays, closeMin });
  const at = (s: Spec, now: number) => now - s.agoDays * DAY;
  /** The fake code host's merged PR of a spec (the body names its Task). */
  const prOf = (s: Spec, now: number) => ({ number: s.n + 2, createdAt: iso(at(s, now) - 3 * 3600_000), mergedAt: iso(at(s, now) - s.closeMin * MIN), body: `Closes #${s.n + 1}`, headRefName: `sb/${s.n + 1}-x`, comments: { totalCount: 0, nodes: [] } });
  /** The stored records of the specs, as an import (or the app, for a backlog kept here) leaves them. */
  function store(db: Db, source: BacklogSource, specs: Spec[], now: number) {
    const issue = (number: number, labels: string[], created: number, closed: number | null, extra: object = {}) =>
      ({ objectKind: "issue", externalId: `I${number}`, fetchState: "fetched", remote: { number, title: `#${number}`, url: "", state: closed === null ? "OPEN" : "CLOSED", stateReason: null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: iso(created), updatedAt: iso(created), closedAt: closed === null ? null : iso(closed), ...extra } });
    const records = specs.flatMap((s) => {
      const closed = at(s, now);
      return [
        issue(s.n, ["type:pbi"], closed - 5 * 3600_000, closed, { subIssues: [s.n + 1], body: s.request ? `## 元要望\n#${s.request.n}` : "## 元要望\nなし" }),
        issue(s.n + 1, ["type:task"], closed - 4 * 3600_000, closed, { parent: s.n }),
        { objectKind: "project-item", externalId: `P${s.n}`, fetchState: "fetched", remote: { issue: s.n, owner: source.project.owner, project: source.project.number, fields: { "Story Points": 3 } } },
        ...(s.request ? [issue(s.request.n, ["type:request"], closed - (5 + s.request.hoursBefore) * 3600_000, null)] : []),
      ];
    });
    db.putBacklogSnapshot(source, { records: records as never, cursor: null, syncedAt: now });
  }
  /**
   * A fake GitHub: the budget, and the merged PRs of `specs` (`fail` answers every call with a refusal). An Issue search
   * (`label:type:pbi` / `type:request`) is recorded in `issueSearches`: the flow must not make one.
   */
  const fake = (calls: string[], specs: Spec[], now: number, fail: (cwd: string) => boolean = () => false): GhRunner => async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query="))!;
    const vars = args.filter((a) => a.startsWith("q=")).join(" ");
    calls.push(`${q} ${vars}`);
    if (fail(cwd)) return { code: 1, stdout: "", stderr: "HTTP 502" };
    return { code: 0, stdout: JSON.stringify({ data: q.includes("search") ? { rateLimit: { cost: 1 }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: specs.map((s) => prOf(s, now)) } } : { rateLimit: { remaining: 4000, cost: 1 } } }), stderr: "" };
  };
  const issueSearches = (calls: string[]) => calls.filter((c) => /label:type:|is:issue/.test(c));
  const SRC = (repository: string): BacklogSource => ({ service: "github", host: "github.com", repository, project: { owner: "o", number: 1 } });
  const SPECS = [spec(10, 3, 10), spec(20, 10, 90), spec(30, 40, 5), spec(40, 50, 15)];

  /** A database with these workspaces (name → stored backlog and its specs; null = never imported), and their FlowWorkspace rows. */
  function stored(backlogs: Record<string, { source: BacklogSource; specs: Spec[] } | null>, now = NOW) {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.flow."));
    const db = new Db(join(dir, "s.db"));
    const list = Object.entries(backlogs).map(([name, b]) => {
      // a checkout of its own (a workspace is one per path), with no origin
      const path = join(dir, name);
      mkdirSync(path);
      const ws = db.upsertWorkspace({ name, path, kind: "repo" });
      if (b) {
        db.setWorkspaceBacklogSource(ws.id, b.source);
        store(db, b.source, b.specs, now);
      }
      return { id: ws.id, name, path, repository: b?.source.repository ?? null };
    });
    return { db, list, done: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
  }

  /** A daemon whose database has these workspaces (name → stored backlog) and the fake GitHub. */
  async function boot(gh: GhRunner, backlogs: Record<string, { source: BacklogSource; specs: Spec[] } | null>) {
    const home = mkdtempSync(join(tmpdir(), "switchboard.flow."));
    const seed = new Db(join(home, "switchboard.db"));
    for (const [name, b] of Object.entries(backlogs)) {
      const ws = seed.upsertWorkspace({ name, path: home, kind: "repo" });
      if (b) {
        seed.setWorkspaceBacklogSource(ws.id, b.source);
        store(seed, b.source, b.specs, Date.now());
      }
    }
    seed.close();
    const core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
    const get = async (q = ""): Promise<FlowView> => (await fetch(`http://127.0.0.1:${core.server.port}/api/flow${q}`)).json() as Promise<FlowView>;
    return { get, port: core.server.port, done: async () => { await core.stop(); rmSync(home, { recursive: true, force: true }); } };
  }

  test("api flow", async () => {
    const calls: string[] = [];
    // the daemon's clock is the real one: the specs' ages count back from now
    const now = Date.now();
    const specs = [...SPECS, { ...spec(50, 1, 10), request: { n: 60, hoursBefore: 2 } }];
    const d = await boot(fake(calls, specs, now), { app: { source: SRC("o/r"), specs } });
    try {
      const v = await d.get();
      expect(v.days).toBe(30);
      expect(v.errors).toEqual([]);
      expect(v.unread).toHaveLength(1); // the daemon's own checkout (meta), which has no imported repository
      // where the 30-day window splits them moves with the hour the test runs: only the totals are the same at any time
      expect(v.current.closed + v.previous.closed).toBe(5);
      expect(v.current.storyPoints + v.previous.storyPoints).toBe(15);
      expect(v.slowest.length).toBeLessThanOrEqual(5);
      // #1878: the weeks of the 30 days (5 or 6, by the weekday), the request opened this week (or last) counted from the stored values
      expect(v.weeks.length).toBeGreaterThanOrEqual(5);
      expect(v.weeks.reduce((n, w) => n + w.requestOpened, 0)).toBe(1);
      expect(issueSearches(calls)).toEqual([]);
      expect(calls.some((c) => c.includes("is:pr is:merged"))).toBe(true);
    } finally {
      await d.done();
    }
  });

  test("a PBI stored only in the app is counted", async () => {
    // #900 is in the app's stored values only: GitHub's Issue search would never answer it, and it is not asked
    const calls: string[] = [];
    const only = spec(900, 2, 30);
    const s = stored({ app: { source: SRC("o/r"), specs: [...SPECS, only] } });
    try {
      const v = await flowView(fake(calls, [...SPECS, only], NOW), s.list, s.db, 30, NOW);
      expect(issueSearches(calls)).toEqual([]);
      expect(v.current.closed).toBe(3); // 2, 3 and 10 days ago
      expect(v.slowest.map((p) => p.number)).toContain(900);
      expect(v.slowest.find((p) => p.number === 900)!.stages.close).toBe(30 * MIN);
      const week = v.weeks.find((w) => w.weekStart === new Date(weekStartOf(NOW - 2 * DAY)).toISOString().slice(0, 10))!;
      expect(week.pbiClosed).toBeGreaterThanOrEqual(1);
    } finally {
      s.done();
    }
  });

  test("a backlog kept in the app only, with no GitHub checkout, is read without PRs: request, split and wait are there", async () => {
    const calls: string[] = [];
    const local: Spec = { ...spec(5, 2, 10), request: { n: 4, hoursBefore: 1 } };
    const s = stored({ mine: { source: { service: "switchboard", host: "local", repository: "ws_local", project: { owner: "switchboard", number: 0 } }, specs: [local] } });
    try {
      s.db.putBacklogSnapshot(s.db.getWorkspaceBacklogSource(s.list[0]!.id)!, { records: [{ objectKind: "comment", externalId: "C1", fetchState: "fetched", remote: { issue: 6, body: "<!-- parallel-guard:task-claim -->", createdAt: iso(NOW - 2 * DAY - 3.5 * 3600_000) } }] as never, cursor: null, syncedAt: NOW });
      const v = await flowView(fake(calls, [], NOW), s.list, s.db, 30, NOW);
      expect(calls).toEqual([]); // no repository to read PRs from
      expect(v.errors).toEqual([]);
      const [p] = v.slowest;
      expect(p!.number).toBe(5);
      expect(p!.stages.request).toBe(3600_000);
      expect(p!.stages.split).toBe(3600_000);
      expect(p!.stages.wait).toBe(30 * MIN);
      expect(p!.stages["review-wait"]).toBeNull();
    } finally {
      s.done();
    }
  });

  test("a backlog kept in the app only counts its deferred Tasks' Issues by the backlog, not by the checkout's GitHub repository", async () => {
    const source: BacklogSource = { service: "switchboard", host: "local", repository: "ws_local", project: { owner: "switchboard", number: 0 } };
    const s = stored({ mine: { source, specs: [] } });
    try {
      const [w] = s.list;
      // its checkout's origin is a GitHub repository (whose PRs would be read)
      Bun.spawnSync(["git", "init", "-q", w!.path]);
      Bun.spawnSync(["git", "-C", w!.path, "remote", "add", "origin", "https://github.com/o/r.git"]);
      const ended = NOW - 2 * DAY;
      const { localId } = createStoredIssue(s.db, source, { title: "残した", body: "", labels: ["type:request"], milestone: null, parent: null, fields: null } as never, ended - 5);
      s.db.sqlite.run("UPDATE backlog_records SET local = json_set(local, '$.number', 7) WHERE external_id = ?", [`local:${localId}`]);
      s.db.sqlite.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, origin, shadow_stopped, outcome, created_at, updated_at, status_at) VALUES ('t', ?, 't', 'claude', '/x', '[]', 'done', 'user', 0, 'done', 1, 1, 1)").run(w!.id);
      s.db.appendEventAt("t", { t: "tool.call", id: "c", name: "Bash", input: { command: "ops-kit backlog create --title 残した" }, summary: "ops-kit" }, ended - 10);
      s.db.appendEventAt("t", { t: "tool.result", id: "c", ok: true, summary: `#7 を作りました（localId ${localId}）` }, ended - 1);
      s.db.appendEventAt("t", { t: "session.end", status: "ok", summary: "完了。別 Issue に残した: #7" }, ended);
      const v = await flowView(fake([], [], NOW), s.list, s.db, 30, NOW);
      expect(v.weeks.reduce((n, x) => n + x.deferredTasks, 0)).toBe(1);
      expect(v.weeks.reduce((n, x) => n + x.deferredIssues, 0)).toBe(1);
    } finally {
      s.done();
    }
  });

  test("the merged PRs are searched 7 days at a time, and 7 days over the search's 1,000-result cap stop the read", async () => {
    const calls: string[] = [];
    const gh = (count: number): GhRunner => async (args) => {
      const q = args.find((a) => a.startsWith("query="))!;
      calls.push(args.filter((a) => a.startsWith("q=")).join(" "));
      return { code: 0, stdout: JSON.stringify({ data: q.includes("search") ? { rateLimit: { cost: 1 }, search: { issueCount: count, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } : { rateLimit: { remaining: 4000, cost: 1 } } }), stderr: "" };
    };
    const { spent } = await fetchMergedPrs(gh(3), ".", "o/r", "2026-10-01", 100, NOW);
    expect(calls.filter((c) => c)).toEqual(["q=repo:o/r is:pr is:merged merged:2026-10-01..2026-10-07", "q=repo:o/r is:pr is:merged merged:2026-10-08..2026-10-14", "q=repo:o/r is:pr is:merged merged:2026-10-15..2026-10-21"]);
    expect(spent).toBe(4);
    await expect(fetchMergedPrs(gh(1001), ".", "o/r", "2026-10-01", 100, NOW)).rejects.toThrow("上限 1000 件");
  });

  test("api flow: a GitHub answer without rateLimit is the repository's error, not a 500", async () => {
    const calls: string[] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args.find((a) => a.startsWith("query="))!);
      return { code: 0, stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }), stderr: "" };
    };
    const d = await boot(gh, { app: { source: SRC("o/r"), specs: [spec(10, 3, 10)] } });
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/flow`);
      expect(res.status).toBe(200);
      const v = (await res.json()) as FlowView;
      expect(v.errors).toHaveLength(1);
      expect(v.errors[0]!.workspace).toBe("app");
      expect(v.errors[0]!.message).toContain("rateLimit");
    } finally {
      await d.done();
    }
  });

  test("periods and slowest", async () => {
    const s = stored({ app: { source: SRC("o/r"), specs: SPECS } });
    try {
      const v = await flowView(fake([], SPECS, NOW), s.list, s.db, 30, NOW);
      expect(v.current.closed).toBe(2); // 3 and 10 days ago
      expect(v.previous.closed).toBe(2); // 40 and 50 days ago
      expect(v.current.stages.close).toEqual({ p50: 50 * MIN, p90: 90 * MIN, count: 2 });
      expect(v.previous.stages.close.p50).toBe(10 * MIN);
      expect(v.slowest.map((p) => p.number)).toEqual([20, 10]); // longest first, current period only
      expect(v.slowest[0]!.url).toBe("https://github.com/o/r/issues/20");
    } finally {
      s.done();
    }
  });

  test("flow cache", async () => {
    const calls: string[] = [];
    const d = await boot(fake(calls, SPECS, Date.now()), { app: { source: SRC("o/r"), specs: SPECS } });
    try {
      await d.get();
      const first = calls.length;
      expect(first).toBeGreaterThan(0);
      await d.get();
      expect(calls.length).toBe(first); // held: GitHub is not read
      await d.get("?refresh=1");
      expect(calls.length).toBe(first * 2);
    } finally {
      await d.done();
    }
  });

  test("flow cache expires after the hour and does not hold a failed read", async () => {
    let t = 0;
    let reads = 0;
    let failing = true;
    const view = (errors: FlowView["errors"]): FlowView => ({ days: 30, fetchedAt: t, current: summarize([]), previous: summarize([]), slowest: [], errors, unread: [], weeks: [] });
    const cache = new FlowCache(async () => { reads++; return view(failing ? [{ workspace: "app", message: "x" }] : []); }, () => "", 3_600_000, () => t);
    await cache.get();
    await cache.get();
    expect(reads).toBe(2); // the failure was not held
    failing = false;
    await cache.get();
    await cache.get();
    expect(reads).toBe(3);
    t = 3_599_000;
    await cache.get();
    expect(reads).toBe(3);
    t = 3_600_001;
    await cache.get();
    expect(reads).toBe(4);
  });

  test("the previous period starts at 60 days exactly", async () => {
    // 59.9 days ago is in; 60.1 days ago is out
    const specs = [spec(10, 59.9, 10), spec(11 + 10, 60.1, 10)];
    const s = stored({ app: { source: SRC("o/r"), specs } });
    try {
      const v = await flowView(fake([], specs, NOW), s.list, s.db, 30, NOW);
      expect(v.previous.closed).toBe(1);
      expect(v.current.closed).toBe(0);
    } finally {
      s.done();
    }
  });

  test("a second workspace of a repository already read is told at the next look, not after the hour", async () => {
    const calls: string[] = [];
    const s = stored({ a: { source: SRC("o/a"), specs: SPECS }, b: null });
    try {
      const src = new Map(s.list.map((w) => [w.id, w.repository]));
      const list = () => s.list.map((w) => ({ ...w, repository: src.get(w.id) ?? null }));
      const cache = new FlowCache((now) => flowView(fake(calls, SPECS, NOW), list(), s.db, 30, now), () => flowScope(list()));
      expect((await cache.get()).unread).toEqual(["b"]);
      const b = s.list.find((w) => w.name === "b")!;
      s.db.setWorkspaceBacklogSource(b.id, SRC("o/a")); // its import finished: the same repository, so its Tasks now count
      src.set(b.id, "o/a");
      expect((await cache.get()).unread).toEqual([]);
    } finally {
      s.done();
    }
  });

  test("a workspace imported after the first look is read at the next, not after the hour", async () => {
    const calls: string[] = [];
    const s = stored({ a: { source: SRC("o/a"), specs: SPECS }, b: null });
    try {
      const src = new Map(s.list.map((w) => [w.id, w.repository]));
      const list = () => s.list.map((w) => ({ ...w, repository: src.get(w.id) ?? null }));
      const cache = new FlowCache((now) => flowView(fake(calls, SPECS, NOW), list(), s.db, 30, now), () => flowScope(list()));
      await cache.get();
      const first = calls.length;
      await cache.get();
      expect(calls.length).toBe(first); // held
      const b = s.list.find((w) => w.name === "b")!;
      s.db.setWorkspaceBacklogSource(b.id, SRC("o/b")); // its import finished
      store(s.db, SRC("o/b"), SPECS, NOW);
      src.set(b.id, "o/b");
      await cache.get();
      expect(calls.length).toBeGreaterThan(first);
    } finally {
      s.done();
    }
  });

  test("flow error", async () => {
    // a repository whose PRs cannot be read is in `errors`, the other answers; a workspace never imported has none to read
    const calls: string[] = [];
    const s = stored({ good: { source: SRC("o/good"), specs: SPECS }, bad: { source: SRC("o/bad"), specs: SPECS }, fresh: null });
    try {
      const list = s.list.map((w) => ({ ...w, path: `/${w.name}` }));
      const v = await flowView(fake(calls, SPECS, NOW, (cwd) => cwd === "/bad"), list, s.db, 30, NOW);
      expect(v.current.closed).toBe(2); // the good repository's
      expect(v.errors.map((e) => e.workspace)).toEqual(["bad"]);
      expect(v.unread).toEqual(["fresh"]); // named, not silently left out
      expect(v.errors.find((e) => e.workspace === "bad")!.message).toContain("失敗");
    } finally {
      s.done();
    }
  });
});

describe("backlog net growth", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-10-17T12:00:00Z"); // a Saturday
  const pbi = (createdAt: string, closedAt: string | null = null) => ({ kind: "pbi" as const, createdAt, closedAt });
  const req = (createdAt: string, closedAt: string | null = null) => ({ kind: "request" as const, createdAt, closedAt });

  test("weeks start on Monday 00:00 UTC", () => {
    expect(new Date(weekStartOf(Date.parse("2026-10-05T00:00:00Z"))).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(new Date(weekStartOf(Date.parse("2026-10-04T23:59:59.999Z"))).toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(new Date(weekStartOf(NOW)).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  test("the counts by their week, empty weeks as 0, net = opened − closed; deferred Tasks by their end, this repository's Issues only", () => {
    const weeks = backlogGrowth(
      [
        { weekStart: "2026-09-28", pbiOpened: 1, pbiClosed: 0, requestOpened: 0, requestClosed: 0 },
        { weekStart: "2026-10-05", pbiOpened: 0, pbiClosed: 1, requestOpened: 0, requestClosed: 0 },
        { weekStart: "2026-10-12", pbiOpened: 0, pbiClosed: 1, requestOpened: 2, requestClosed: 1 },
        { weekStart: "2026-09-14", pbiOpened: 9, pbiClosed: 9, requestOpened: 9, requestClosed: 9 }, // before the period
      ],
      [
        { endedAt: Date.parse("2026-10-06T10:00:00Z"), issues: [{ repo: "o/r", number: 5 }, { repo: "other/x", number: 6 }] },
        { endedAt: Date.parse("2026-10-11T23:59:59Z"), issues: [] }, // Sunday: still the week of 10-05
        { endedAt: Date.parse("2026-10-15T10:00:00Z"), issues: [] },
        { endedAt: Date.parse("2026-09-01T10:00:00Z"), issues: [{ repo: "o/r", number: 1 }] }, // before the period
      ],
      "O/R",
      21,
      NOW,
    );
    const row = (w: (typeof weeks)[number]) => [w.weekStart, w.pbiOpened, w.pbiClosed, w.requestOpened, w.requestClosed, w.net, w.deferredTasks, w.deferredIssues];
    expect(weeks.map(row)).toEqual([
      ["2026-09-21", 0, 0, 0, 0, 0, 0, 0],
      ["2026-09-28", 1, 0, 0, 0, 1, 0, 0],
      ["2026-10-05", 0, 1, 0, 0, -1, 2, 1],
      ["2026-10-12", 0, 1, 2, 1, 0, 1, 0],
    ]);
  });

  test("each week's PBIs and requests opened and closed are counted from the stored times, by UTC days from Monday to Sunday", () => {
    const records = storedOf([
      { number: 1, labels: ["type:pbi"], createdAt: "2026-10-12T00:00:00Z" },
      { number: 2, labels: ["type:pbi"], createdAt: "2026-10-18T23:59:59Z" }, // Sunday: still the week of 10-12
      { number: 3, labels: ["type:pbi"], createdAt: "2026-10-11T23:59:59Z" }, // the week before
      { number: 4, labels: ["type:request"], state: "CLOSED", createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-09-30T00:00:00Z" },
      { number: 5, labels: ["type:request"], state: "CLOSED", createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-10-01T00:00:00Z" },
      { number: 6, labels: ["type:task"], createdAt: "2026-10-13T00:00:00Z" }, // a Task is neither
    ]);
    const { growth } = flowOfStored(records, [], 14, NOW);
    expect(growth.map((w) => [w.weekStart, w.pbiOpened, w.requestClosed])).toEqual([["2026-09-28", 0, 2], ["2026-10-05", 1, 0], ["2026-10-12", 2, 0]]);
  });

  test("flowView counts the deferred Tasks of the repository's workspaces from the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.flow."));
    const db = new Db(join(dir, "s.db"));
    const w = db.upsertWorkspace({ name: "app", path: ".", kind: "repo" });
    const src: BacklogSource = { service: "github", host: "github.com", repository: "o/r", project: { owner: "o", number: 1 } };
    db.setWorkspaceBacklogSource(w.id, src);
    db.putBacklogSnapshot(src, { records: [], cursor: null, syncedAt: NOW });
    const task = (id: string, workspace: string, summary: string, endedAt: number) => {
      db.sqlite.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, origin, shadow_stopped, outcome, created_at, updated_at, status_at) VALUES (?, ?, 't', 'claude', '/x', '[]', 'done', 'user', 0, 'done', 1, 1, 1)").run(id, workspace);
      db.appendEventAt(id, { t: "tool.call", id: "c", name: "Bash", input: { command: "gh issue create --title x" }, summary: "gh" }, endedAt - 2);
      db.appendEventAt(id, { t: "tool.result", id: "c", ok: true, summary: "https://github.com/o/r/issues/9" }, endedAt - 1);
      db.appendEventAt(id, { t: "session.end", status: "ok", summary }, endedAt);
    };
    task("a", w.id, "完了。別 Issue に残した: #9", NOW - 2 * DAY);
    task("b", w.id, "全部できた", NOW - 2 * DAY);
    task("c", "other", "後回し", NOW - 2 * DAY); // another repository's workspace
    const gh: GhRunner = async () => ({ code: 1, stdout: "", stderr: "no PBI closed: nothing is read" });
    const v = await flowView(gh, [{ id: w.id, name: "app", path: ".", repository: "o/r" }], db, 14, NOW);
    expect(v.weeks.map((x) => [x.weekStart, x.deferredTasks, x.deferredIssues])).toEqual([["2026-09-28", 0, 0], ["2026-10-05", 0, 0], ["2026-10-12", 1, 1]]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
