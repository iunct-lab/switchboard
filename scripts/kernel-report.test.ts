// test-reads: packages/core/src/db.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../packages/core/src/db.ts";
import { kernelReport, median, NO_PROCESS, NO_PROVENANCE, renderReport } from "./kernel-report.ts";

const prov = (process: string | null, skills: string, bytes: number | null) => JSON.stringify({ v: 1, process: process ? { id: process, version: 1 } : null, processReason: null, bundle: { skills, repoSkills: null, claudeMd: null, processes: null }, repo: { head: null }, runner: "claude", model: null, effort: null, permissionMode: null, instructionBytes: bytes, recordedAt: 1 });

test("a database without the provenance column (an older daemon's) reports every Task as 記録なし instead of failing", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT, status TEXT, created_at INTEGER, status_at INTEGER, shadow_of TEXT); CREATE TABLE ledger (task_id TEXT, cost_usd REAL); CREATE TABLE task_evals (task_id TEXT, source TEXT, json TEXT)");
  db.query("INSERT INTO tasks VALUES ('t', 'done', 100, 160, NULL)").run();
  const r = kernelReport(db, { days: 1, now: 1000 });
  expect(r.strata).toEqual([{ key: `${NO_PROVENANCE}@-`, process: NO_PROVENANCE, skills: "-", n: 1, durationMsMedian: 60, costUsdMedian: null, interventionsMedian: null, instructionBytesMedian: null }]);
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
      // n descending, then the key (the Latin key sorts before the Japanese one)
      expect(r.strata.map((s) => s.key)).toEqual([`p0-pipeline@${"a".repeat(8)}`, `${NO_PROVENANCE}@-`, `p1-direct@${"b".repeat(8)}`, `${NO_PROCESS}@${"a".repeat(8)}`]);
      const [p0, none, p1, noProc] = r.strata;
      expect(noProc).toMatchObject({ process: NO_PROCESS, skills: "a".repeat(8), n: 1, durationMsMedian: 30_000, instructionBytesMedian: 100 });
      expect(p0).toMatchObject({ process: "p0-pipeline", n: 3, durationMsMedian: 120_000, costUsdMedian: 5, interventionsMedian: 1.5, instructionBytesMedian: 2000 });
      expect(p1).toMatchObject({ process: "p1-direct", n: 1, durationMsMedian: 600_000, costUsdMedian: 0.5, interventionsMedian: null, instructionBytesMedian: 500 });
      expect(none).toMatchObject({ process: NO_PROVENANCE, skills: "-", n: 2, durationMsMedian: 75_000, costUsdMedian: null, interventionsMedian: 4, instructionBytesMedian: null });
      const text = renderReport(r);
      expect(text).toContain("Task 7 件");
      expect(text).toContain(`| p0-pipeline | ${"a".repeat(8)} | 3 | 2.0 分 | $5.00 | 1.5 | 2 KB |`);
      expect(text).toContain(`| ${NO_PROVENANCE} | - | 2 |`);
      expect(text).toContain(`| ${NO_PROCESS} | ${"a".repeat(8)} | 1 |`);
      expect(text).toContain("層別は観察で、決着ではない");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
