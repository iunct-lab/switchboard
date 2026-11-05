/**
 * Kernel report (docs/design/process-kernel.md, K2 first step): the Tasks of a window grouped by their provenance — the
 * process candidate and the skills bundle they were started with — with, per group, how many, and the medians of their
 * duration, cost, the person's interventions and the instruction size. Observational: it shows n and leaves the judgement
 * to the reader; Tasks from before provenance was recorded are their own group.
 *
 *   bun scripts/kernel-report.ts [--days N] [--db <path>] [--json]
 *
 * Reads the Switchboard database read-only (`--db`, else `$SWITCHBOARD_HOME/switchboard.db`, else `~/.switchboard/switchboard.db`).
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provenance } from "../packages/protocol/src/index.ts";

export const NO_PROVENANCE = "記録なし";
/** Provenance recorded, but no process candidate named (a Task typed on Home): not the same as no record. */
export const NO_PROCESS = "候補なし";
export const SKILLS_PREFIX = 8;

export type Stratum = {
  /** `<process id, 候補なし or 記録なし>@<skills hash prefix or ->` */
  key: string;
  process: string;
  skills: string;
  n: number;
  /** Done Tasks only (`status_at - created_at`); null when none is done. */
  durationMsMedian: number | null;
  /** Sum of the ledger's `cost_usd` per Task; null when no Task has a row. */
  costUsdMedian: number | null;
  /** `userInstructions + asks` of the Task's rules eval; null when no Task has one. */
  interventionsMedian: number | null;
  instructionBytesMedian: number | null;
};

export type Report = { days: number; since: number; tasks: number; strata: Stratum[] };

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

type Row = { id: string; status: string; created_at: number; status_at: number; provenance: string | null };

export function kernelReport(db: Database, opts: { days: number; now?: number }): Report {
  const now = opts.now ?? Date.now();
  const since = now - opts.days * 86_400_000;
  // a database an older daemon still owns has no provenance column yet (the read-only report never migrates it): every Task is then 記録なし
  const hasProvenance = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some((c) => c.name === "provenance");
  const rows = db.query(`SELECT id, status, created_at, status_at, ${hasProvenance ? "provenance" : "NULL AS provenance"} FROM tasks WHERE created_at >= ? AND shadow_of IS NULL`).all(since) as Row[];
  const cost = new Map((db.query("SELECT task_id, SUM(cost_usd) AS c FROM ledger GROUP BY task_id").all() as Array<{ task_id: string; c: number }>).map((r) => [r.task_id, r.c]));
  const evals = new Map<string, number>();
  for (const r of db.query("SELECT task_id, json FROM task_evals WHERE source = 'rules'").all() as Array<{ task_id: string; json: string }>) {
    try {
      const m = (JSON.parse(r.json) as { metrics?: { userInstructions?: number; asks?: number } }).metrics;
      if (m && typeof m.userInstructions === "number" && typeof m.asks === "number") evals.set(r.task_id, m.userInstructions + m.asks);
    } catch {
      /* an unreadable eval counts as none */
    }
  }
  const groups = new Map<string, { process: string; skills: string; duration: number[]; cost: number[]; interventions: number[]; bytes: number[]; n: number }>();
  for (const r of rows) {
    let p: Provenance | null = null;
    if (r.provenance) {
      try {
        p = JSON.parse(r.provenance) as Provenance;
      } catch {
        p = null;
      }
    }
    // a record without its bundle (a hand-edited or future shape) is not a record this report can read: 記録なし, like an unreadable row
    if (p && (typeof p !== "object" || !p.bundle || typeof p.bundle !== "object")) p = null;
    const processId = p ? p.process?.id ?? NO_PROCESS : NO_PROVENANCE;
    const skills = p?.bundle.skills ? p.bundle.skills.slice(0, SKILLS_PREFIX) : "-";
    const key = `${processId}@${skills}`;
    const g = groups.get(key) ?? { process: processId, skills, duration: [], cost: [], interventions: [], bytes: [], n: 0 };
    g.n++;
    if (r.status === "done") g.duration.push(r.status_at - r.created_at);
    const c = cost.get(r.id);
    if (c !== undefined) g.cost.push(c);
    const i = evals.get(r.id);
    if (i !== undefined) g.interventions.push(i);
    if (p && typeof p.instructionBytes === "number") g.bytes.push(p.instructionBytes);
    groups.set(key, g);
  }
  const strata = [...groups.entries()]
    .map(([key, g]) => ({ key, process: g.process, skills: g.skills, n: g.n, durationMsMedian: median(g.duration), costUsdMedian: median(g.cost), interventionsMedian: median(g.interventions), instructionBytesMedian: median(g.bytes) }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  return { days: opts.days, since, tasks: rows.length, strata };
}

const fmtMs = (ms: number | null) => (ms === null ? "-" : `${(ms / 60_000).toFixed(1)} 分`);
const fmtUsd = (x: number | null) => (x === null ? "-" : `$${x.toFixed(2)}`);
const fmtNum = (x: number | null) => (x === null ? "-" : String(Math.round(x * 10) / 10));
const fmtBytes = (x: number | null) => (x === null ? "-" : `${Math.round(x / 1024)} KB`);

export function renderReport(r: Report): string {
  const lines = [`# カーネルの報告 — 直近 ${r.days} 日の Task ${r.tasks} 件（${new Date(r.since).toISOString().slice(0, 10)} 以降、shadow を除く）`, "", "| プロセス | スキルの束 | n | 所要時間の中央値（done） | 費用の中央値 | 介入の中央値 | 命令の大きさの中央値 |", "|---|---|---:|---:|---:|---:|---:|"];
  for (const s of r.strata) lines.push(`| ${s.process} | ${s.skills} | ${s.n} | ${fmtMs(s.durationMsMedian)} | ${fmtUsd(s.costUsdMedian)} | ${fmtNum(s.interventionsMedian)} | ${fmtBytes(s.instructionBytesMedian)} |`);
  lines.push("", `層別は観察で、決着ではない（n と幅を見る。費用は API 相当の見積、介入は rules の評価がある Task だけ。${NO_PROVENANCE} = 由来の記録が無い Task、${NO_PROCESS} = 記録はあるが候補を名指ししていない Task）。`);
  return lines.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const days = Number(arg("--days") ?? 30);
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive number");
    process.exit(1);
  }
  const dbPath = arg("--db") ?? join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "switchboard.db");
  if (!existsSync(dbPath)) {
    console.error(`no database at ${dbPath}`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const report = kernelReport(db, { days });
    console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : renderReport(report));
  } finally {
    db.close();
  }
}
