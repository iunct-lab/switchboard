// test-reads: docs/design/pbi-progress.md
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pbiFactsOf } from "./backlog-item.ts";
import { pbiProgress } from "./pbi-progress.ts";
import { readProgressTable } from "./pbi-progress.table.ts";

describe("pbiProgress", () => {
  const table = readProgressTable();

  test("every row of the table in docs/design/pbi-progress.md gives the answers the table says", () => {
    // a table cut short (a broken row ends it) would pass with nothing checked
    expect(table.length).toBeGreaterThanOrEqual(20);
    expect(new Set(table.map((r) => r.row)).size).toBe(table.length);
    for (const r of table) expect({ row: r.row, ...pbiProgress(r.facts) }).toEqual({ row: r.row, ...r.want });
  });

  test("the table has a row for each answer being given and not given", () => {
    for (const k of ["closableByApi", "closable", "prereqMet", "checking"] as const) expect(new Set(table.map((r) => r.want[k])).size, k).toBe(2);
    expect(table.some((r) => r.want.asked.length > 1) && table.some((r) => r.want.asked.length === 0)).toBe(true);
    expect(table.some((r) => r.want.closesOnAnswer !== null) && table.some((r) => r.want.closesOnAnswer === null && r.want.closableByApi)).toBe(true);
    expect(table.some((r) => r.facts.held) && table.some((r) => r.facts.decision) && table.some((r) => r.facts.status === null) && table.some((r) => !r.facts.pbi)).toBe(true);
  });

  test("pbiFactsOf reads the user-check lines and the other unchecked criteria from the body", () => {
    const body = ["## 到達点 / 受け入れ条件", "- [x] 1. 済み", "- [ ] 2. まだ（検証: テスト）", "- [ ] 3. 見た目（利用者確認: 画面で見る）", "- [ ] 4. 書き方の説明 `（利用者確認: …）` の形", "", "## スコープ外", "- [ ] 数えない"].join("\n");
    expect(pbiFactsOf({ labels: ["type:pbi"], body, status: "In progress", tasks: { total: 2, done: 2 } })).toEqual({ pbi: true, decision: false, status: "In progress", tasks: { total: 2, done: 2 }, others: 2, confirms: [3], postMerge: [], decided: [], held: false });
    const only = ["## 到達点 / 受け入れ条件", "- [x] 1. 済み", "- [ ] 2. 見た目（利用者確認: 画面で見る）"].join("\n");
    expect(pbiFactsOf({ labels: ["type:pbi", "needs-decision"], body: only, status: null, tasks: { total: 1, done: 1 } })).toMatchObject({ decision: true, status: null, others: 0, confirms: [2] });
    expect(pbiProgress(pbiFactsOf({ labels: ["type:pbi"], body: only, status: null, tasks: { total: 1, done: 1 } })).prereqMet).toBe(true);
    expect(pbiProgress(pbiFactsOf({ labels: ["type:pbi"], body, status: null, tasks: { total: 2, done: 2 } })).prereqMet).toBe(false);
  });
});

describe("no PBI judgment written beside pbiProgress", () => {
  // The forms of "are this PBI's Tasks all closed / still open / none" written out by hand. A new one reads pbiProgress's answer
  // (BacklogItem.closable / progress / confirmations) instead.
  const FORMS = String.raw`tasks\??\.done ===|tasks\??\.done <|tasks\??\.total === 0|\.closed < .*\.total|\.total === 0 \|\|`;
  // One entry per place that may keep a form: file, the one line that must contain `has` (a second such line fails), and why.
  const ALLOWED: Array<{ file: string; has: string; why: string }> = [
    { file: "packages/core/src/pbi-progress.ts", has: "const allDone =", why: "the rule itself" },
    { file: "packages/core/src/pbi-progress.ts", has: "(f.tasks.total === 0 || allDone)", why: "the rule itself: a PBI with no Tasks is asked its checks" },
    { file: "packages/core/src/backlog-pick.ts", has: "const isStalled =", why: "the in-progress row's 'stalled' (a Task is still open and nothing runs): which PBI to resume, not an answer about the PBI" },
    { file: "apps/web/src/inProgress.ts", has: "t(m.stoppedAllDone)", why: "the wording of a stopped row (every Task closed), shown beside the answers and deciding nothing" },
  ];
  const hits = () => {
    const r = Bun.spawnSync(["git", "grep", "--untracked", "-nE", FORMS, "--", "packages/*.ts", "apps/*.ts", "apps/*.tsx", "scripts/parallel-guard.ts", ":!*.test.ts", ":!*.test.tsx"], { cwd: join(import.meta.dir, "../../..") });
    return r.stdout.toString().split("\n").filter(Boolean);
  };

  test("no file outside tests and the allow list compares a PBI's Task counts", () => {
    const stray = hits().filter((h) => {
      const [file, , ...rest] = h.split(":");
      return !ALLOWED.some((a) => a.file === file && rest.join(":").includes(a.has));
    });
    expect(stray).toEqual([]);
  });

  test("every allow-list entry matches exactly one line", () => {
    const all = hits();
    for (const a of ALLOWED) expect(all.filter((h) => h.startsWith(`${a.file}:`) && h.includes(a.has)).length, a.file + " " + a.why).toBe(1);
  });
});
