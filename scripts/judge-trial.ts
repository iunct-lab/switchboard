/**
 * Try the automatic judgement (#493) on past tasks, once, with the real runners: `bun scripts/judge-trial.ts
 * [--db <path>] <taskId>…` prints a Markdown table to paste into PBI #493's decision log, where the person marks
 * which rows are right. The database is opened read-only (the daemon may be running on it) and nothing is written
 * back; each row spends one judging turn of the configured runner (Codex gpt-6-luna by default, Claude Haiku when
 * it cannot).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { JudgeSettings, type RunnerAdapter, type RunnerId } from "../packages/protocol/src/index.ts";
import { createClaudeAdapter } from "../packages/adapters/claude/src/index.ts";
import { createCodexAdapter } from "../packages/adapters/codex/src/index.ts";
import { judgeTurn, type JudgeInput } from "../packages/core/src/judge.ts";

export type TrialInput = ({ id: string } & JudgeInput) | { id: string; error: string };

/**
 * Per task: its title, the first thing asked, and the reply its last turn ended with — the same inputs the daemon
 * gives the judge (`Db.firstUserText` and the turn's `session.end.summary`); keep the first query in step with it.
 */
export function trialInputs(db: Database, ids: string[]): TrialInput[] {
  const first = db.query("SELECT json_extract(json, '$.text') AS text FROM events WHERE task_id = ? AND json_extract(json, '$.t') = 'message.delta' AND json_extract(json, '$.role') = 'user' ORDER BY seq LIMIT 1");
  const last = db.query("SELECT json_extract(json, '$.summary') AS text FROM events WHERE task_id = ? AND json_extract(json, '$.t') = 'session.end' ORDER BY seq DESC LIMIT 1");
  return ids.map((id) => {
    const t = db.query("SELECT title FROM tasks WHERE id = ?").get(id) as { title: string } | null;
    if (!t) return { id, error: "no such task" };
    const reply = ((last.get(id) as { text: string | null } | null)?.text ?? "").trim();
    if (!reply) return { id, error: "the last turn has no reply" };
    return { id, title: t.title, prompt: (first.get(id) as { text: string | null } | null)?.text ?? "", lastReply: reply };
  });
}

const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "／").trim();

/** Judges each task in turn and returns the table: `| task | title | 判定 | 理由 | 判定したランナー | 秒 |`. */
export async function runTrial(db: Database, ids: string[], opts: { adapters: Map<RunnerId, RunnerAdapter>; settings: JudgeSettings; cwd: string }): Promise<string> {
  const rows = ["| task | title | 判定 | 理由 | 判定したランナー | 秒 |", "| --- | --- | --- | --- | --- | --- |"];
  for (const input of trialInputs(db, ids)) {
    if ("error" in input) {
      rows.push(`| ${input.id} | — | 失敗 | ${input.error} | — | — |`);
      continue;
    }
    const started = Date.now();
    const secs = () => ((Date.now() - started) / 1000).toFixed(1);
    try {
      const j = await judgeTurn(input, { adapters: opts.adapters, settings: opts.settings, cwd: opts.cwd, log: (m) => console.error(m) });
      rows.push(`| ${input.id} | ${cell(input.title)} | ${j.result === "done" ? "完了" : "要対応"} | ${cell(j.reason)} | ${j.runner}:${j.model || "CLI 既定"} | ${secs()} |`);
    } catch (e) {
      rows.push(`| ${input.id} | ${cell(input.title)} | 失敗 | ${cell(String((e as Error).message ?? e)).slice(0, 120)} | — | ${secs()} |`);
    }
  }
  return rows.join("\n");
}

/** `[--db <path>] <taskId>…` → the database (default `~/.switchboard/switchboard.db`) and the ids; null = nothing to run. */
export function parseArgs(args: string[], home: string): { dbPath: string; ids: string[] } | null {
  const at = args.indexOf("--db");
  const dbPath = at >= 0 ? args[at + 1] : join(home, ".switchboard", "switchboard.db");
  const ids = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  return dbPath && ids.length ? { dbPath, ids } : null;
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2), homedir());
  if (!parsed) {
    console.error("usage: bun scripts/judge-trial.ts [--db <path>] <taskId>…");
    process.exit(2);
  }
  const { dbPath, ids } = parsed;
  // Only the runners that are there; the judge falls back to Claude Haiku on its own.
  const adapters = new Map<RunnerId, RunnerAdapter>();
  for (const a of [createClaudeAdapter(), createCodexAdapter()]) if ((await a.detect()).available) adapters.set(a.id, a);
  const cwd = mkdtempSync(join(tmpdir(), "switchboard.judge-trial."));
  const db = new Database(dbPath, { readonly: true });
  try {
    console.log(await runTrial(db, ids, { adapters, settings: JudgeSettings.parse(undefined), cwd }));
  } finally {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}
