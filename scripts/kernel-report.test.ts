// test-reads: packages/core/src/db.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../packages/core/src/db.ts";
import { kernelReport, median, NO_PROCESS, NO_PROVENANCE, reasonGroup, reasonKind, renderReport, reworkOf, type GitCommit } from "./kernel-report.ts";

const prov = (process: string | null, skills: string, bytes: number | null, reason: string | null = null) => JSON.stringify({ v: 1, process: process ? { id: process, version: 1 } : null, processReason: reason, bundle: { skills, repoSkills: null, claudeMd: null, processes: null }, repo: { head: null }, runner: "claude", model: null, effort: null, permissionMode: null, instructionBytes: bytes, recordedAt: 1 });

test("a database without the provenance column (an older daemon's) reports every Task as 記録なし instead of failing", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT, status TEXT, created_at INTEGER, status_at INTEGER, shadow_of TEXT); CREATE TABLE ledger (task_id TEXT, cost_usd REAL); CREATE TABLE task_evals (task_id TEXT, source TEXT, json TEXT)");
  db.query("INSERT INTO tasks VALUES ('t', 'done', 100, 160, NULL)").run();
  const r = kernelReport(db, { days: 1, now: 1000 });
  expect(r.strata).toEqual([{ key: NO_PROVENANCE, process: NO_PROVENANCE, skills: "-", n: 1, reasons: { button: 0, auto: 0, returned: 0, other: 0, none: 1 }, durationMsMedian: 60, costUsdMedian: null, interventionsMedian: null, instructionBytesMedian: null }]);
  db.close();
});

test("median", () => {
  expect(median([])).toBeNull();
  expect(median([3])).toBe(3);
  expect(median([1, 5, 3])).toBe(3);
  expect(median([1, 2, 3, 4])).toBe(2.5);
});

test("kernelReport groups the window's Tasks by process and skills hash, with 記録なし for those without provenance, and medians per group", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-kernel-report-"));
  try {
    const path = join(dir, "switchboard.db");
    new Db(path).close(); // the schema, as the daemon creates it
    const raw = new Database(path);
    const now = 10_000_000_000;
    const day = 86_400_000;
    const task = (id: string, created: number, status: string, statusAt: number, provenance: string | null, shadowOf: string | null = null) =>
      raw.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, status_at, created_at, updated_at, provenance, shadow_of) VALUES (?, ?, 'claude', '/w', '[]', ?, ?, ?, ?, ?, ?)").run(id, id, status, statusAt, created, created, provenance, shadowOf);
    const skillsA = "a".repeat(64);
    const skillsB = "b".repeat(64);
    task("t1", now - day, "done", now - day + 60_000, prov("p0-pipeline", skillsA, 1000));
    task("t2", now - day, "done", now - day + 180_000, prov("p0-pipeline", skillsA, 3000));
    task("t3", now - day, "running", now - day, prov("p0-pipeline", skillsA, null)); // not done: no duration
    task("t4", now - day, "done", now - day + 600_000, prov("p1-direct", skillsB, 500));
    task("t5", now - day, "done", now - day + 120_000, null); // from before provenance
    task("t8", now - day, "done", now - day + 30_000, prov(null, skillsA, 100)); // recorded, no candidate named (typed on Home)
    task("t9", now - day, "done", now - day + 30_000, JSON.stringify({ v: 1, process: null })); // a row without bundle: counted as 記録なし, never a throw
    task("t6", now - day, "done", now - day + 1, prov("p0-pipeline", skillsA, 1), "t1"); // a shadow: left out
    task("t7", now - 40 * day, "done", now - 40 * day + 1, prov("p0-pipeline", skillsA, 1)); // outside the window
    const ledger = (id: string, usd: number) => raw.query("INSERT INTO ledger (task_id, runner, input_tokens, output_tokens, cache_read, cache_write, cost_usd, source, ts) VALUES (?, 'claude', 0, 0, 0, 0, ?, 'reported', ?)").run(id, usd, now);
    ledger("t1", 1); ledger("t1", 2); ledger("t2", 7); ledger("t4", 0.5);
    const rules = (id: string, userInstructions: number, asks: number) => raw.query("INSERT INTO task_evals (task_id, source, by, rubric, json, ts) VALUES (?, 'rules', 'rules@3', NULL, ?, ?)").run(id, JSON.stringify({ metrics: { userInstructions, asks } }), now);
    rules("t1", 2, 1); rules("t2", 0, 0); rules("t5", 4, 0);
    raw.close();

    const db = new Database(path, { readonly: true });
    try {
      const r = kernelReport(db, { days: 30, now });
      expect(r.tasks).toBe(7);
      // by candidate only: n descending, then the key (the Latin key sorts before the Japanese one); one row per candidate whatever the bundle
      expect(r.strata.map((s) => s.key)).toEqual(["p0-pipeline", NO_PROVENANCE, "p1-direct", NO_PROCESS]);
      const [p0, none, p1, noProc] = r.strata;
      expect(noProc).toMatchObject({ process: NO_PROCESS, skills: "-", n: 1, durationMsMedian: 30_000, instructionBytesMedian: 100 });
      expect(p0).toMatchObject({ process: "p0-pipeline", n: 3, durationMsMedian: 120_000, costUsdMedian: 5, interventionsMedian: 1.5, instructionBytesMedian: 2000 });
      expect(p1).toMatchObject({ process: "p1-direct", n: 1, durationMsMedian: 600_000, costUsdMedian: 0.5, interventionsMedian: null, instructionBytesMedian: 500 });
      expect(none).toMatchObject({ process: NO_PROVENANCE, skills: "-", n: 2, durationMsMedian: 75_000, costUsdMedian: null, interventionsMedian: 4, instructionBytesMedian: null });
      const text = renderReport(r);
      expect(text).toContain("Task 7 件");
      expect(text).not.toContain("スキルの束 |");
      expect(text).toContain("| p0-pipeline | 3 | ボタン 0 / 自動 0 / 戻した 0 | 2.0 分 | $5.00 | 1.5 | 2 KB |");
      expect(text).toContain(`| ${NO_PROVENANCE} | 2 |`);
      expect(text).toContain(`| ${NO_PROCESS} | 1 |`);
      expect(text).toContain("層別は観察で、決着ではない");

      // --by-bundle: the earlier stratification by candidate and skills bundle (two bundles here)
      const b = kernelReport(db, { days: 30, now, byBundle: true });
      expect(b.strata.map((s) => s.key)).toEqual([`p0-pipeline@${"a".repeat(8)}`, `${NO_PROVENANCE}@-`, `p1-direct@${"b".repeat(8)}`, `${NO_PROCESS}@${"a".repeat(8)}`]);
      const bt = renderReport(b);
      expect(bt).toContain("| プロセス | スキルの束 | n |");
      expect(bt).toContain(`| p0-pipeline | ${"a".repeat(8)} | 3 | ボタン 0 / 自動 0 / 戻した 0 | 2.0 分 | $5.00 | 1.5 | 2 KB |`);
      expect(bt).toContain(`| ${NO_PROCESS} | ${"a".repeat(8)} | 1 |`);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reasonKind reads the words the choosers write", () => {
  expect(reasonKind("direct button")).toBe("button");
  expect(reasonKind("backlog stage to-pbi")).toBe("button");
  expect(reasonKind("auto direct: 本文 120 字 ≤ 400")).toBe("auto");
  expect(reasonKind("auto pipeline: 本文が長い")).toBe("auto");
  expect(reasonKind("direct returned")).toBe("returned");
  expect(reasonKind("something else")).toBe("other");
  expect(reasonKind(null)).toBe("none");
  expect(reasonKind("")).toBe("none");
});

test("p0-pipeline and p1-direct are separate rows, each with its Tasks counted by the kind of reason", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT, status TEXT, created_at INTEGER, status_at INTEGER, shadow_of TEXT, provenance TEXT, workspace_id TEXT, stage_issue INTEGER, stage_action TEXT); CREATE TABLE ledger (task_id TEXT, cost_usd REAL); CREATE TABLE task_evals (task_id TEXT, source TEXT, json TEXT); CREATE TABLE workspaces (id TEXT, backlog_source TEXT); CREATE TABLE backlog_records (repository TEXT, object_kind TEXT, remote TEXT)");
  const skills = "c".repeat(64);
  const rows: Array<[string, string | null]> = [
    ["t1", prov("p0-pipeline", skills, 1, "backlog stage to-pbi")],
    ["t2", prov("p0-pipeline", "d".repeat(64), 1, "direct returned")], // the same candidate under another skills bundle
    ["t3", prov("p1-direct", skills, 1, "direct button")],
    ["t4", prov("p1-direct", skills, 1, "auto direct: 本文 100 字")],
    ["t5", prov("p1-direct", skills, 1, "auto direct: 本文 90 字")],
    ["t6", prov("p1-direct", skills, 1, "hand-written")],
  ];
  for (const [id, p] of rows) db.query("INSERT INTO tasks (id, status, created_at, status_at, shadow_of, provenance) VALUES (?, 'done', 100, 160, NULL, ?)").run(id, p);
  const r = kernelReport(db, { days: 1, now: 1000 });
  const p0 = r.strata.find((s) => s.process === "p0-pipeline")!;
  const p1 = r.strata.find((s) => s.process === "p1-direct")!;
  expect(p0.reasons).toEqual({ button: 1, auto: 0, returned: 1, other: 0, none: 0 });
  expect(p1.reasons).toEqual({ button: 1, auto: 2, returned: 0, other: 1, none: 0 });
  const text = renderReport(r);
  expect(text).toContain(`| p0-pipeline | 2 | ボタン 1 / 自動 0 / 戻した 1 |`);
  expect(text).toContain(`| p1-direct | 4 | ボタン 1 / 自動 2 / 戻した 0 / その他 1 |`);
  // two bundles of one candidate: one row by default, one row per bundle with byBundle
  expect(r.strata.filter((s) => s.process === "p0-pipeline")).toHaveLength(1);
  const b = kernelReport(db, { days: 1, now: 1000, byBundle: true });
  expect(b.strata.filter((s) => s.process === "p0-pipeline").map((s) => [s.skills, s.n]).sort()).toEqual([["c".repeat(8), 1], ["d".repeat(8), 1]]);
  db.close();
});

test("reasonGroup keeps the criterion's limit and drops the body's actual size", () => {
  expect(reasonGroup("direct button")).toBe("ボタン");
  expect(reasonGroup("backlog stage to-tasks")).toBe("ボタン");
  expect(reasonGroup("auto direct: 本文 152 字 ≤ 600")).toBe("自動 direct: 本文 ≤ 600");
  expect(reasonGroup("auto direct: 本文 90 字 ≤ 600")).toBe("自動 direct: 本文 ≤ 600");
  expect(reasonGroup("auto direct: 本文 100 字")).toBe("自動 direct");
  expect(reasonGroup("auto pipeline: p1-direct: 本文 740 字 > 600")).toBe("自動 pipeline");
  expect(reasonGroup("direct returned")).toBe("戻した");
  expect(reasonGroup("schedule sch_x")).toBe("その他");
  expect(reasonGroup(null)).toBe("理由なし");
});

test("the choice scores count chosen, returned and merged per kind of reason, the merge read in the workspace's own repository", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (id TEXT, status TEXT, created_at INTEGER, status_at INTEGER, shadow_of TEXT, provenance TEXT, workspace_id TEXT, stage_issue INTEGER, stage_action TEXT);
    CREATE TABLE ledger (task_id TEXT, cost_usd REAL); CREATE TABLE task_evals (task_id TEXT, source TEXT, json TEXT);
    CREATE TABLE workspaces (id TEXT, backlog_source TEXT);
    CREATE TABLE backlog_records (repository TEXT, object_kind TEXT, remote TEXT)`);
  db.query("INSERT INTO workspaces VALUES ('w1', ?), ('w2', ?)").run(JSON.stringify({ repository: "o/one" }), JSON.stringify({ repository: "o/two" }));
  const task = (id: string, created: number, ws: string, issue: number | null, action: string, reason: string | null) =>
    db.query("INSERT INTO tasks VALUES (?, 'done', ?, ?, NULL, ?, ?, ?, ?)").run(id, created, created, prov("p1-direct", "s".repeat(64), 1, reason), ws, issue, action);
  task("a", 100, "w1", 10, "direct", "auto direct: 本文 152 字 ≤ 600"); // sent back by r below, never merged
  task("r", 200, "w1", 10, "to-pbi", "direct returned");
  task("b", 100, "w1", 11, "direct", "auto direct: 本文 90 字 ≤ 600"); // merged in o/one
  task("c", 100, "w1", 12, "to-tasks", "backlog stage to-tasks"); // #12 merged only in o/two: not this workspace's
  task("d", 100, "w1", null, "", "direct button"); // no issue: not counted
  task("e", 100, "w1", 13, "complete", "backlog stage complete"); // a PBI whose Task #14 merged: merged
  task("f", 100, "w1", 15, "complete", "backlog stage complete"); // a PBI whose Task is open: not merged
  task("s", 100, "w1", 11, "direct", "direct button"); // a shadow: left out
  db.query("UPDATE tasks SET shadow_of = 'b' WHERE id = 's'").run();
  task("old", -90_000_000, "w1", 11, "direct", "direct button"); // before the window: left out
  const pr = (repo: string, state: string, closes: unknown) => db.query("INSERT INTO backlog_records VALUES (?, 'pull-request', ?)").run(repo, JSON.stringify({ state, closes }));
  pr("o/one", "MERGED", [11]);
  pr("o/one", "OPEN", [10]);
  pr("o/two", "MERGED", [12]);
  pr("o/one", "MERGED", [14]);
  const issue = (repo: string, number: number, parent: number | null) => db.query("INSERT INTO backlog_records VALUES (?, 'issue', ?)").run(repo, JSON.stringify({ number, parent }));
  issue("o/one", 14, 13);
  issue("o/one", 16, 15);
  issue("o/two", 12, 99); // the parent of a merge in another repository: not counted in o/one
  // one level only, in either row order: #21 merged, #21's parent #20 counts, #20's parent #19 does not
  pr("o/one", "MERGED", [21]);
  issue("o/one", 21, 20);
  issue("o/one", 20, 19);
  task("g", 100, "w1", 19, "complete", "backlog stage complete");
  const r = kernelReport(db, { days: 1, now: 1000 });
  expect(r.choices).toEqual([
    { group: "ボタン", chosen: 4, returned: 0, merged: 1 },
    { group: "自動 direct: 本文 ≤ 600", chosen: 2, returned: 1, merged: 1 },
    { group: "戻した", chosen: 1, returned: 0, merged: 0 },
  ]);
  const text = renderReport(r);
  expect(text).toContain("| 自動 direct: 本文 ≤ 600 | 2 | 1 | 1 |");
  expect(text).toContain("見直す材料であって決着ではない");
  db.close();
});

const outcomeDb = () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (id TEXT, status TEXT, created_at INTEGER, status_at INTEGER, shadow_of TEXT, provenance TEXT, workspace_id TEXT, stage_issue INTEGER, stage_action TEXT);
    CREATE TABLE ledger (task_id TEXT, cost_usd REAL); CREATE TABLE task_evals (task_id TEXT, source TEXT, json TEXT);
    CREATE TABLE workspaces (id TEXT, backlog_source TEXT);
    CREATE TABLE backlog_records (repository TEXT, object_kind TEXT, remote TEXT)`);
  db.query("INSERT INTO workspaces VALUES ('w1', ?)").run(JSON.stringify({ repository: "o/one" }));
  return db;
};
const dayMs = 86_400_000;
const at = (date: string) => Date.parse(`${date}T12:00:00Z`);
const task = (db: Database, id: string, created: number, bytes: number | null, shadow: string | null = null) =>
  db.query("INSERT INTO tasks (id, status, created_at, status_at, shadow_of, provenance) VALUES (?, 'done', ?, ?, ?, ?)").run(id, created, created, shadow, prov("p1-direct", "s".repeat(64), bytes));
const request = (db: Database, repo: string, createdAt: string, closedAt: string | null, labels = ["type:request"]) =>
  db.query("INSERT INTO backlog_records VALUES (?, 'issue', ?)").run(repo, JSON.stringify({ state: closedAt ? "CLOSED" : "OPEN", labels, createdAt, closedAt }));

test("the outcome rows hold the medians of the 28 days up to the baseline date and of the 28 days up to now", () => {
  const db = outcomeDb();
  const now = at("2026-12-01");
  // bytes: the baseline window is 2026-10-07 .. 2026-11-03 (inclusive), the recent one 2026-11-03 12:00 .. now
  task(db, "b1", at("2026-10-20"), 1000);
  task(db, "b2", at("2026-10-21"), 3000);
  task(db, "b3", at("2026-10-22"), 5000);
  task(db, "b4", at("2026-10-22"), 99_999, "b1"); // a shadow: left out
  task(db, "b5", at("2026-09-01"), 77_777); // before both windows
  task(db, "r1", at("2026-11-20"), 8000);
  task(db, "r2", at("2026-11-25"), 4000);
  task(db, "r3", at("2026-11-25"), null); // no instruction size recorded
  // closeDays: requests of this workspace's repository, by the day they closed
  request(db, "o/one", "2026-10-10T12:00:00Z", "2026-10-20T12:00:00Z"); // 10 days, baseline
  request(db, "o/one", "2026-10-01T12:00:00Z", "2026-10-26T12:00:00Z"); // 25 days, baseline
  request(db, "o/one", "2026-11-10T12:00:00Z", "2026-11-12T12:00:00Z"); // 2 days, recent
  request(db, "o/one", "2026-11-10T12:00:00Z", "2026-11-18T12:00:00Z"); // 8 days, recent
  request(db, "o/one", "2026-11-10T12:00:00Z", "2026-11-19T12:00:00Z", ["type:pbi"]); // not a request
  request(db, "o/one", "2026-11-10T12:00:00Z", null); // still open
  request(db, "o/mirror", "2026-11-10T12:00:00Z", "2026-11-11T12:00:00Z"); // a repository no workspace points at
  const r = kernelReport(db, { days: 30, now });
  expect(r.baselineDate).toBe("2026-11-03");
  expect(r.outcomes).toEqual([
    { key: "bytes", baseline: { n: 3, value: 3000 }, recent: { n: 2, value: 6000 } },
    { key: "closeDays", baseline: { n: 2, value: 17.5 }, recent: { n: 2, value: 5 } },
    { key: "rework", baseline: { n: 0, value: null }, recent: { n: 0, value: null } },
  ]);
  const text = renderReport(r);
  expect(text).toContain("## 成果の条件");
  expect(text).toContain("| b. Task が読み始める命令の大きさ（中央値） | 3 KB | 6 KB | 3 / 2 |");
  expect(text).toContain("| c. 要望が閉じるまでの日数（中央値） | 17.5 日 | 5 日 | 2 / 2 |");
  expect(/良い|悪い|改善した|悪化/.test(text)).toBe(false);
  // --baseline moves the first window
  expect(kernelReport(db, { days: 30, now, baseline: "2026-12-01" }).outcomes[0]!.baseline.n).toBe(2);
  db.close();
});

test("a side with no records reads 記録なし, not 0", () => {
  const db = outcomeDb();
  task(db, "r1", at("2026-11-20"), 2048);
  request(db, "o/one", "2026-11-10T12:00:00Z", "2026-11-12T12:00:00Z");
  const r = kernelReport(db, { days: 30, now: at("2026-12-01") });
  expect(r.outcomes[0]).toEqual({ key: "bytes", baseline: { n: 0, value: null }, recent: { n: 1, value: 2048 } });
  const text = renderReport(r);
  expect(text).toContain("| b. Task が読み始める命令の大きさ（中央値） | 記録なし | 2 KB | 0 / 1 |");
  expect(text).toContain("| c. 要望が閉じるまでの日数（中央値） | 記録なし | 2 日 | 0 / 1 |");
  expect(text).toContain("| a. 再作業（直した後にまた直す） | 記録なし | 記録なし | 0 / 0 |");
  db.close();
});

const pr = (number: number, mergedAt: string, files: string[], mergeCommit?: string) => ({ number, mergedAt, files, mergeCommit });
const commit = (at: string, subject: string, files: string[], sha?: string): GitCommit => ({ at, subject, files, sha });

test("reworkOf: a fix or revert touching the same file within 7 days after the merge is a rework", () => {
  const prs = [pr(1, "2026-11-01T00:00:00Z", ["a.ts", "b.ts"])];
  expect([...reworkOf(prs, [commit("2026-11-03T00:00:00Z", "fix(core): x", ["b.ts"])])]).toEqual([1]);
  expect([...reworkOf(prs, [commit("2026-11-03T00:00:00Z", 'Revert "feat: y"', ["a.ts"])])]).toEqual([1]);
  expect([...reworkOf(prs, [commit("2026-11-03T00:00:00Z", "fix(core): x", ["c.ts"])])]).toEqual([]); // no file in common
  expect([...reworkOf(prs, [commit("2026-11-08T00:00:01Z", "fix: late", ["a.ts"])])]).toEqual([]); // after 7 days
  expect([...reworkOf(prs, [commit("2026-11-08T00:00:00Z", "fix: on the day", ["a.ts"])])]).toEqual([1]);
  expect([...reworkOf(prs, [commit("2026-10-31T00:00:00Z", "fix: before the merge", ["a.ts"])])]).toEqual([]);
  expect([...reworkOf(prs, [commit("2026-11-03T00:00:00Z", "feat(core): not a fix", ["a.ts"]), commit("2026-11-03T00:00:00Z", "prefix: nor this", ["a.ts"])])]).toEqual([]); // the subject must start with fix / revert
});

test("reworkOf: the PR's own merge commit is not its rework", () => {
  const prs = [pr(1, "2026-11-01T00:00:00Z", ["a.ts"], "abc")];
  expect([...reworkOf(prs, [commit("2026-11-01T00:00:01Z", "fix(core): the PR itself", ["a.ts"], "abc")])]).toEqual([]);
  expect([...reworkOf(prs, [commit("2026-11-01T00:00:01Z", "fix(core): another PR", ["a.ts"], "def")])]).toEqual([1]);
});

test("the rework row splits the window's merged PRs into p0-pipeline's and the rest's, and a side with no pull request reads 記録なし", () => {
  const db = outcomeDb();
  const taskOn = (id: string, process: string | null, issue: number, withProvenance = true) =>
    db.query("INSERT INTO tasks (id, status, created_at, status_at, provenance, workspace_id, stage_issue) VALUES (?, 'done', 1, 1, ?, 'w1', ?)").run(id, withProvenance ? prov(process, "s".repeat(64), 1) : null, issue);
  taskOn("p", "p0-pipeline", 10);
  taskOn("q", "p0-pipeline", 20);
  taskOn("d", "p1-direct", 30);
  taskOn("e", null, 40); // recorded, no candidate named: the rest
  taskOn("f", "p1-direct", 50, false); // no provenance: its PR is in neither group
  taskOn("g", "p1-direct", 60); // a PBI: its Task's PR closes #61, parent #60
  const prRec = (repo: string, number: number, closes: number[], mergedAt: string | null, files: string[] | null, state = "MERGED") =>
    db.query("INSERT INTO backlog_records VALUES (?, 'pull-request', ?)").run(repo, JSON.stringify({ number, state, closes, mergedAt, files, mergeCommit: `sha${number}` }));
  prRec("o/one", 1, [10], "2026-11-20T00:00:00Z", ["a.ts"]); // p0, reworked
  prRec("o/one", 2, [20], "2026-11-21T00:00:00Z", ["b.ts"]); // p0, not reworked
  prRec("o/one", 3, [30], "2026-11-22T00:00:00Z", ["c.ts"]); // rest, reworked
  prRec("o/one", 4, [40], "2026-11-23T00:00:00Z", ["d.ts"]); // rest, reworked
  prRec("o/one", 5, [50], "2026-11-23T00:00:00Z", ["d.ts"]); // no provenance: left out
  prRec("o/one", 6, [61], "2026-11-24T00:00:00Z", ["e.ts"]); // rest through the parent, not reworked
  prRec("o/one", 7, [10], null, ["a.ts"]); // no mergedAt: cannot be dated
  prRec("o/one", 8, [10], "2026-11-20T00:00:00Z", ["a.ts"], "OPEN"); // not merged
  prRec("o/two", 9, [10], "2026-11-20T00:00:00Z", ["a.ts"]); // another repository
  prRec("o/one", 10, [30], "2026-10-20T00:00:00Z", ["c.ts"]); // baseline window, rest, not reworked
  prRec("o/one", 11, [20], "2026-11-21T00:00:00Z", null); // no file list: unknown, left out (not counted as unreworked)
  db.query("INSERT INTO backlog_records VALUES ('o/one', 'issue', ?)").run(JSON.stringify({ number: 61, parent: 60 }));
  const commits = [
    commit("2026-11-21T00:00:00Z", "fix(core): a", ["a.ts"], "x1"),
    commit("2026-11-23T00:00:00Z", "fix(core): c", ["c.ts"], "x2"),
    commit("2026-11-25T00:00:00Z", "Revert \"feat: d\"", ["d.ts"], "x3"),
    commit("2026-11-23T00:00:00Z", "fix(core): d itself", ["d.ts"], "sha5"), // a fix by another PR on d.ts (PR 5 is left out of the groups, so its commit only matters to PR 4)
  ];
  const r = kernelReport(db, { days: 30, now: at("2026-12-01"), git: { repository: "o/one", commits } });
  const rework = r.outcomes.find((o) => o.key === "rework")!;
  expect(rework.recent.split).toEqual({ p0: { n: 2, reworked: 1 }, other: { n: 3, reworked: 2 } });
  expect(rework.recent.n).toBe(5);
  expect(rework.baseline.split).toEqual({ p0: { n: 0, reworked: 0 }, other: { n: 1, reworked: 0 } });
  const text = renderReport(r);
  expect(text).toContain("| p0-pipeline 記録なし / それ以外 0% | p0-pipeline 50% / それ以外 67% | 0 + 1 / 2 + 3 |");
  expect(/良い|悪い|改善した|悪化/.test(text)).toBe(false);
  db.close();
});

test("without git history the rework row reads 記録なし", () => {
  const db = outcomeDb();
  const r = kernelReport(db, { days: 30, now: at("2026-12-01"), git: null });
  expect(r.outcomes.find((o) => o.key === "rework")).toEqual({ key: "rework", baseline: { n: 0, value: null }, recent: { n: 0, value: null } });
  expect(renderReport(r)).toContain("| 記録なし | 記録なし | 0 / 0 |");
  db.close();
});
