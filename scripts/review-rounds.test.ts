import { describe, expect, test } from "bun:test";
import { prRecordOf, type PrRecord, type Revert } from "./merge-audit";
import { RECHECK_KINDS } from "./merge-gate";
import { afterMergeRows, format, main } from "./review-rounds";

const SHA = (n: number) => String(n).padStart(40, "0");
const period = { since: "2026-10-01T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" };
const at = "2026-10-10T00:00:00Z";

/** A PR merged by the responsibility recheck: ask → answer-less recheck pass on the merged head. */
const rechecked = (number: number, audit?: "pass" | "finding"): PrRecord => ({
  number, mergedAt: at, headSha: SHA(number), reviewed: false,
  marks: [
    { kind: "ask", kinds: ["responsibility"], sha: SHA(number), at: "2026-10-09T00:00:00Z" },
    { kind: "recheck", kinds: ["responsibility"], sha: SHA(number), at },
    ...(audit ? [{ kind: "post-audit" as const, kinds: [], sha: SHA(number), at: "2026-10-12T00:00:00Z", verdict: audit }] : []),
  ],
});
const plain = (number: number, reviewed: boolean, audit?: "pass" | "finding"): PrRecord => ({
  number, mergedAt: at, headSha: SHA(number), reviewed,
  marks: audit ? [{ kind: "post-audit", kinds: [], sha: SHA(number), at: "2026-10-12T00:00:00Z", verdict: audit }] : [],
});

const prs = [rechecked(1, "finding"), rechecked(2, "pass"), rechecked(3), plain(4, true, "finding"), plain(5, true, "pass"), plain(6, false, "pass")];
const reverts: Revert[] = [{ sha: "abc", at: "2026-10-15T00:00:00Z", reverted: [2] }];

describe("afterMergeRows", () => {
  const rows = afterMergeRows(prs, reverts, period);
  const row = (rule: string) => rows.find((r) => r.rule === rule)!;

  test("a recheck kind's row counts auto-merged, reverted and the audit over those PRs only", () => {
    expect(row("responsibility")).toEqual({ rule: "responsibility", autoMerged: 3, reverted: 1, audited: 2, findings: 1 });
    expect(row("size")).toEqual({ rule: "size", autoMerged: 0, reverted: 0, audited: 0, findings: 0 });
  });

  test("one row per recheck kind; a kind only a user's answer lifts has none", () => {
    expect(rows.filter((r) => r.autoMerged !== null).map((r) => r.rule).sort()).toEqual([...RECHECK_KINDS].sort());
    expect(row("limits")).toBeUndefined();
  });

  test("from a PR's comments, through merge-audit's prRecordOf, to the kind's row", async () => {
    const sha = "a".repeat(40);
    const c = (body: string, created_at: string) => ({ body, created_at, author_association: "OWNER" });
    const comments = [
      c(`[merge-ask] responsibility ${sha}\n\nPR をマージしてよいか`, "2026-10-09T00:00:00Z"),
      c(`[recheck] responsibility pass ${sha}`, "2026-10-09T01:00:00Z"),
      c(`[post-audit] finding ${sha}`, "2026-10-12T00:00:00Z"),
    ];
    const run = async () => JSON.stringify({ merged_at: at, head: { sha } });
    const pr = (await prRecordOf(5864, comments, run, "o/r"))!;
    expect(afterMergeRows([pr], [], period).find((r) => r.rule === "responsibility")).toEqual({ rule: "responsibility", autoMerged: 1, reverted: 0, audited: 1, findings: 1 });
    const answered = (await prRecordOf(5864, [...comments, c(`[merge-answer] yes responsibility ${sha}`, "2026-10-09T02:00:00Z")], run, "o/r"))!;
    expect(afterMergeRows([answered], [], period).find((r) => r.rule === "responsibility")).toMatchObject({ autoMerged: 0, audited: 0 });
  });

  test("review and direct rows are the audit of that route, without auto-merge or revert counts", () => {
    expect(row("review")).toEqual({ rule: "review", autoMerged: null, reverted: null, audited: 2, findings: 1 });
    expect(row("direct")).toEqual({ rule: "direct", autoMerged: null, reverted: null, audited: 1, findings: 0 });
  });

  test("an audit outside the period is not counted", () => {
    const old = { ...plain(7, true), marks: [{ kind: "post-audit" as const, kinds: [], sha: SHA(7), at: "2026-09-01T00:00:00Z", verdict: "finding" as const }] };
    expect(afterMergeRows([old], [], period).find((r) => r.rule === "review")).toMatchObject({ audited: 0, findings: 0 });
  });
});

describe("format", () => {
  test("a group line, the column names and one tab-separated line per rule", () => {
    const lines = format(afterMergeRows(prs, reverts, period));
    expect(lines[0]).toContain("拾った問題");
    expect(lines[1]!.split("\t")).toHaveLength(6);
    expect(lines.find((l) => l.startsWith("responsibility\t"))).toBe("responsibility\t3\t1\t2\t1\t50%");
    expect(lines.find((l) => l.startsWith("direct\t"))).toBe("direct\t-\t-\t1\t0\t0%");
    expect(lines.find((l) => l.startsWith("size\t"))).toBe("size\t0\t0\t0\t0\t-");
  });
});

describe("main", () => {
  test("bad arguments exit 2", async () => {
    expect(await main(["--days", "0"])).toBe(2);
    expect(await main(["--repo", "nope"])).toBe(2);
    expect(await main(["--json"])).toBe(2);
  });
});
