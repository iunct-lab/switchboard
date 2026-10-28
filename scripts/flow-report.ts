/**
 * bun scripts/flow-report.ts [--days 30] [--repo <owner/name>] [--json <file>] — how long each PBI closed in the period took,
 * stage by stage (PBI #650, docs/design/flow-metrics.md). Reads GitHub (one GraphQL query per 10 PBIs, 100 points at most;
 * it reads nothing when the budget is under 500) and the Switchboard DB (SWITCHBOARD_HOME, read-only) for each PBI's Tasks.
 * Exit 0 = printed / 1 = stopped (budget, gh) / 2 = bad arguments.
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { FlowStage } from "../packages/protocol/src/index.ts";
import { runGh } from "../packages/core/src/backlog.ts";
import { fetchFlow, FlowError, launchShare, repoOfRemote, summarize, withSwitchboardTasks } from "../packages/core/src/flow.ts";

const dur = (ms: number | null): string => {
  if (ms === null) return "不明";
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 120) return `${m}m`;
  return m < 2880 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
};

/** The workspaces whose `origin` is this repository: Issue numbers repeat across repositories, so a Task counts only from these. */
function workspacesOf(db: Database, repo: string): string[] {
  const rows = db.query("SELECT id, path FROM workspaces").all() as Array<{ id: string; path: string }>;
  return rows
    .filter((w) => repoOfRemote(spawnSync("git", ["-C", w.path, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout) === repo.toLowerCase())
    .map((w) => w.id);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  const days = Number(arg("--days") ?? 30);
  if (!Number.isInteger(days) || days < 1) {
    console.error("usage: bun scripts/flow-report.ts [--days 30] [--repo <owner/name>] [--json <file>]");
    return 2;
  }
  const cwd = process.cwd();
  let repo = arg("--repo");
  if (!repo) {
    const r = await runGh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd);
    if (r.code !== 0) {
      console.error("リポジトリが分かりません。--repo <owner/name> を付けてください");
      return 1;
    }
    repo = r.stdout.trim();
  }
  const dbPath = join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "switchboard.db");
  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;
  try {
    const { reads: read, spent, cutPbis } = await fetchFlow(runGh, cwd, repo, days);
    const workspaces = db ? workspacesOf(db, repo) : [];
    if (db && workspaces.length === 0) console.error(`${repo} の workspace が DB に無いので、Task の列は出しません`);
    const pbis = read.map((r) => withSwitchboardTasks(r, workspaces.length ? db : null, workspaces));
    const sum = summarize(pbis);
    console.log(`${repo}: 直近 ${days} 日に閉じた PBI ${sum.closed} 件、Story Points 合計 ${sum.storyPoints}`);
    console.log("\n段\t中央値\tp90\t件数");
    for (const st of FlowStage.options) console.log(`${st}\t${dur(sum.stages[st].p50)}\t${dur(sum.stages[st].p90)}\t${sum.stages[st].count}`);
    console.error(`GraphQL の消費: ${spent} ポイント`);
    if (cutPbis.length) console.error(`コメント・Task・PR の一覧が GitHub の 1 回の上限で切れた PBI（表で * を付けた。その行の数は少なく出る）: ${cutPbis.map((n) => `#${n}`).join(" ")}`);
    console.log(`一番時間を食った段（中央値）: ${sum.bottleneck ?? "不明"}`);
    console.log(`\nPBI\t${FlowStage.options.join("\t")}\t返事待ち\tレビュー回数\tTask\t費用`);
    for (const p of pbis) {
      const t = p.tasks ? `${p.tasks.count} 件 ${dur(p.tasks.runMs)}\t$${p.tasks.costUsd.toFixed(2)}` : "-\t-";
      console.log(`#${p.number}${cutPbis.includes(p.number) ? "*" : ""}\t${FlowStage.options.map((st) => dur(p.stages[st] ?? null)).join("\t")}\t${dur(p.userWaitMs)}\t${p.reviewRounds.join("/") || "-"}\t${t}`);
    }
    const share = launchShare(pbis);
    console.log(`\n実装を 3 回以上起動した PBI: ${share.known ? `${share.repeated}/${share.known}（${Math.round((share.repeated / share.known) * 100)}%）` : "不明"}`);
    console.log(`段 wait の中央値: ${dur(sum.stages.wait.p50)}`);
    const json = arg("--json");
    if (json) writeFileSync(json, JSON.stringify({ repo, days, cutPbis, stages: sum.stages, bottleneck: sum.bottleneck, closed: sum.closed, storyPoints: sum.storyPoints, pbis }, null, 2));
    return 0;
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    console.error(e.message);
    return 1;
  } finally {
    db?.close();
  }
}

process.exit(await main());
