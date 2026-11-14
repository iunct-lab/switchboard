// test-reads: none
import { describe, expect, test } from "bun:test";
import type { CreatedIssue } from "@switchboard/protocol";
import type { StoredRecords } from "../../../ops-kit/src/backlog-client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backlogGrowth } from "./flow.ts";
import type { SourceRow, SourceView } from "@switchboard/protocol";
import { mainCommits, REWORK_DAYS, reworkOf, routeLineOf, SOURCE_CACHE_KEYS, SourceCache, sourceRows, STALE_DAYS, type MainCommit } from "./sources.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-03-01T00:00:00Z");
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();
type Issue = StoredRecords["issues"][number];
const issue = (number: number, labels: string[], body: string, over: Partial<Issue> = {}): Issue => ({
  number, title: `t${number}`, url: "", state: "OPEN", stateReason: null, body, labels, parent: null, subIssues: [], createdAt: ago(5), updatedAt: ago(1), closedAt: null, fields: null, ...over,
});
const request = (number: number, speaker: string | null, over: Partial<Issue> = {}, extra = "") =>
  issue(number, ["type:request"], `## 要望\nx\n\n## 出典\n${speaker ? `- 誰の言葉: ${speaker}\n` : ""}${extra}`, over);
const pbi = (number: number, req: number, over: Partial<Issue> = {}) => issue(number, ["type:pbi"], `## 元要望\n#${req}`, over);
const done = { state: "CLOSED", stateReason: "COMPLETED", closedAt: ago(1) } as const;
const records = (issues: Issue[]): StoredRecords => ({ workspaceId: "w", service: "github", repository: "o/r", project: { owner: "o", number: 1 }, fetchedAt: NOW, top: [], issues, comments: [], unread: [], pulls: [] });
const rowOf = (rows: ReturnType<typeof sourceRows>, speaker: string, route: string | null = null) => rows.find((r) => r.speaker === speaker && r.route === route)!;

describe("sourceRows", () => {
  const fixture = records([
    // 利用者: 1 delivered (3 days to deliver), 1 planned but PBI still open, 1 dropped, 1 stale, 1 fresh and unplanned
    request(1, "利用者", { createdAt: ago(10), state: "CLOSED", stateReason: "COMPLETED", closedAt: ago(7) }), pbi(101, 1, done),
    request(2, "利用者"), pbi(102, 2),
    request(3, "利用者", { createdAt: ago(20), state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: ago(18) }),
    request(4, "利用者", { createdAt: ago(STALE_DAYS + 1) }),
    request(5, "利用者", { createdAt: ago(STALE_DAYS - 1) }),
    // 定期の検査: a schedule's route, and a route read from the line (cut at the parenthesis)
    request(6, "定期の検査", { createdAt: ago(STALE_DAYS + 3) }),
    request(7, "定期の検査", { createdAt: ago(2) }, "- 経路: タグの CI（週次）\n"),
    request(8, "定期の検査", { createdAt: ago(2) }),
    // エージェント with no route at all
    request(9, "エージェント"),
    // unreadable speaker; and one outside the period
    request(10, null),
    request(11, "利用者", { createdAt: ago(40) }),
    // a request whose PBIs are not all completed is not delivered
    request(12, "利用者", { createdAt: ago(9), state: "CLOSED", closedAt: ago(8), stateReason: "COMPLETED" }), pbi(112, 12, done), pbi(113, 12, { state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: ago(8) }),
  ]);
  const routes: Record<string, string> = { "o/r#6": "動向からの案", "o/r#8": "動向からの案" };
  const deferred: Array<{ endedAt: number; issues: CreatedIssue[] }> = [
    { endedAt: NOW - 2 * DAY, issues: [{ repo: "o/r", number: 200 }, { repo: "x/y", number: 1 }] },
    { endedAt: NOW - 40 * DAY, issues: [{ repo: "o/r", number: 201 }] },
  ];
  const rows = sourceRows(fixture, (repo, n) => routes[`${repo}#${n}`] ?? null, deferred, 30, NOW, []);

  test("the user's requests are sorted into delivered, planned, dropped and stale", () => {
    expect(rowOf(rows, "利用者")).toEqual({ repo: "o/r", speaker: "利用者", route: null, opened: 6, planned: 3, dropped: 2, delivered: 1, daysToDeliver: 3, stale: 1, reverted: 0, followUpBugs: 0 });
  });

  test("a scheduled check is split by its route: the schedule that opened it first, then the 経路 line, and its parent row is the total", () => {
    expect(rowOf(rows, "定期の検査").opened).toBe(3);
    expect(rowOf(rows, "定期の検査", "動向からの案")).toMatchObject({ opened: 2, stale: 1 });
    expect(rowOf(rows, "定期の検査", "タグの CI")).toMatchObject({ opened: 1, stale: 0 });
    expect(rowOf(rows, "エージェント", "不明").opened).toBe(1);
  });

  test("a request with no readable speaker has its own row, and one outside the period is not counted", () => {
    expect(rowOf(rows, "読めない").opened).toBe(1);
    expect(rowOf(rows, "利用者").opened).toBe(6);
  });

  test("the derived row counts the Issues of this repository that deferred Tasks opened in the period, as backlogGrowth does", () => {
    expect(rowOf(rows, "派生")).toMatchObject({ opened: 1, planned: 0, dropped: 0, delivered: 0, stale: 0 });
    const weeks = backlogGrowth([], deferred.slice(0, 1), "o/r", 30, NOW);
    expect(weeks.reduce((s, w) => s + w.deferredIssues, 0)).toBe(rowOf(rows, "派生").opened);
  });
});

describe("routeLineOf", () => {
  test("cuts the line before the first parenthesis and returns null without one", () => {
    expect(routeLineOf("- 経路: 既存Issue #5（https://x/y）\n- z")).toBe("既存Issue #5");
    expect(routeLineOf("- 経路: Claude Code のセッション\n")).toBe("Claude Code のセッション");
    expect(routeLineOf("- 出典: x")).toBeNull();
  });
});

describe("SourceCache", () => {
  test("holds a view for an hour per days and reads again after it or when the scope changes", async () => {
    let clock = 1_000, scope = "a", reads = 0;
    const cache = new SourceCache(async (days, now): Promise<SourceView> => (reads++, { days, now, staleDays: STALE_DAYS, reworkDays: REWORK_DAYS, rows: [], unread: [] }), () => scope, 3_600_000, () => clock);
    await cache.get(30), await cache.get(30);
    expect(reads).toBe(1);
    await cache.get(90);
    expect(reads).toBe(2);
    clock += 3_600_001;
    await cache.get(30);
    expect(reads).toBe(3);
    scope = "b";
    await cache.get(30);
    expect(reads).toBe(4);
  });

  test("asks during a read share it, and at most SOURCE_CACHE_KEYS values of days are held", async () => {
    const reads: number[] = [];
    const cache = new SourceCache(async (days, now): Promise<SourceView> => (reads.push(days), await Bun.sleep(1), { days, now, staleDays: STALE_DAYS, reworkDays: REWORK_DAYS, rows: [], unread: [] }), () => "a");
    await Promise.all([cache.get(30), cache.get(30)]);
    expect(reads).toEqual([30]);
    let scope = "a";
    const scoped = new SourceCache(async (days, now): Promise<SourceView> => {
      const at = scope;
      await Bun.sleep(1);
      return { days, now, staleDays: STALE_DAYS, reworkDays: REWORK_DAYS, rows: [{ repo: at } as SourceRow], unread: [] };
    }, () => scope);
    const before = scoped.get(30);
    scope = "b";
    expect((await scoped.get(30)).rows[0]?.repo).toBe("b");
    await before;
    for (let d = 1; d <= SOURCE_CACHE_KEYS; d++) await cache.get(d);
    await cache.get(30);
    expect(reads).toEqual([30, ...Array.from({ length: SOURCE_CACHE_KEYS }, (_, i) => i + 1), 30]);
    await cache.get(SOURCE_CACHE_KEYS);
    expect(reads.length).toBe(SOURCE_CACHE_KEYS + 2);
  });
});

describe("rework", () => {
  const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
  const closedAt = ago(30);
  const delivered = (n: number, task: number, pbiNo: number) => [
    request(n, "利用者", { createdAt: ago(40), state: "CLOSED", stateReason: "COMPLETED", closedAt }),
    pbi(pbiNo, n, { state: "CLOSED", stateReason: "COMPLETED", closedAt, subIssues: [task] }),
    issue(task, ["type:task"], "x", { parent: pbiNo, state: "CLOSED", stateReason: "COMPLETED", closedAt }),
  ];
  const bug = (n: number, body: string, daysAfterClose: number, labels = ["bug"]) => issue(n, labels, body, { createdAt: new Date(Date.parse(closedAt) + daysAfterClose * DAY).toISOString() });
  const pull = (number: number, closes: number[], mergeCommit: string | null) => ({ number, state: "MERGED" as const, isDraft: false, labels: [], closes, mergeCommit, updatedAt: closedAt, files: null });
  const fixture = (): StoredRecords => ({
    ...records([
      ...delivered(20, 121, 120), ...delivered(30, 131, 130), ...delivered(40, 141, 140), ...delivered(50, 151, 150),
      bug(301, "#140 が壊れた", 3), bug(302, "#140 が壊れた", REWORK_DAYS + 1), bug(303, "#1400 の話", 3), bug(304, "PR #910 の回帰", REWORK_DAYS),
      bug(305, "#140 の確認", 3, ["type:task", "bug"]), bug(306, "関係のない bug", 3), bug(307, "#140 の話（bug ラベル無し）", 3, ["enhancement"]),
    ]),
    pulls: [pull(900, [121], A), pull(910, [141], C)],
  });
  const at = (d: number) => NOW - d * DAY;
  const commits: MainCommit[] = [
    { sha: A, message: "feat: a\n", at: at(35) },
    { sha: "r".repeat(40), message: `Revert "feat: a"\n\nThis reverts commit ${A}.\n`, at: at(20) },
    // the same PR taken back twice is one
    { sha: "s".repeat(40), message: `Revert "Revert"\n\nThis reverts commit ${A}.\n`, at: at(10) },
    // a rebase merge: no stored mergeCommit, the subject ends with the Task; taken back by rollback-pr's short sha
    { sha: B, message: "feat: b (#131)\n", at: at(35) },
    { sha: "t".repeat(40), message: `revert: v1 に戻す\n\nv1..origin/main:\n- ${B.slice(0, 7)} feat: b (#131)\n`, at: at(15) },
    { sha: C, message: "feat: c (#141)\n", at: at(35) },
  ];

  test("a delivered PBI counts the PRs taken back by git revert (stored mergeCommit) and by rollback-pr (the subject's Task), once each", () => {
    const m = reworkOf(fixture(), commits, [120, 130, 140, 150], NOW);
    expect(m.get(120)?.reverted).toBe(1);
    expect(m.get(130)?.reverted).toBe(1);
    expect(m.get(140)?.reverted).toBe(0);
    expect(m.get(150)?.reverted).toBe(0);
  });

  test("follow-up bugs are those named by the PBI or its PR within the rework days of its close, not a Task, not another number, not another label", () => {
    const m = reworkOf(fixture(), commits, [120, 130, 140, 150], NOW);
    expect(m.get(140)?.followUpBugs).toBe(2);
    expect(m.get(150)?.followUpBugs).toBe(0);
  });

  test("the rework of the delivered PBIs is added to the row of the speaker", () => {
    const rows = sourceRows(fixture(), () => null, [], 90, NOW, commits);
    expect(rowOf(rows, "利用者")).toMatchObject({ delivered: 4, reverted: 2, followUpBugs: 2 });
  });

  test("a PBI not delivered has no rework counted", () => {
    expect(reworkOf(fixture(), commits, [], NOW).size).toBe(0);
  });

  test("a revert of a commit not on main (a PR branch's own) or of a short sha two commits on main share is not counted", () => {
    const D = "d".repeat(39) + "1", E = "d".repeat(39) + "2";
    const more: MainCommit[] = [
      ...commits,
      { sha: "u".repeat(40), message: `Revert "x"\n\nThis reverts commit ${"9".repeat(40)}.\n`, at: at(5) },
      { sha: D, message: "feat: d (#141)\n", at: at(30) },
      { sha: E, message: "feat: e (#141)\n", at: at(30) },
      { sha: "v".repeat(40), message: `revert: v2 に戻す\n\nv2..origin/main:\n- ${"d".repeat(7)} feat: d (#141)\n`, at: at(4) },
    ];
    expect(reworkOf(fixture(), more, [120, 130, 140, 150], NOW).get(140)?.reverted).toBe(0);
  });

  test("mainCommits reads origin/main when origin/HEAD is not set, the branch origin/HEAD names when it is, and is null when git cannot read either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sources-git-"));
    try {
      const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "feat: one (#7)");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const got = await mainCommits(dir, 0);
      expect(got?.map((c) => c.message.trim())).toEqual(["feat: one (#7)"]);
      // a default branch other than main: origin/HEAD names it and there is no origin/main
      git("commit", "-q", "--allow-empty", "-m", "feat: two (#8)");
      git("update-ref", "refs/remotes/origin/master", "HEAD");
      git("update-ref", "-d", "refs/remotes/origin/main");
      git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
      expect((await mainCommits(dir, 0))?.map((c) => c.message.trim())).toEqual(["feat: two (#8)", "feat: one (#7)"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await mainCommits("/nonexistent-path-for-rework", 0)).toBeNull();
  });
});
