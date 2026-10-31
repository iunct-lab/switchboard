/**
 * bun scripts/flow-report.ts [--days 30] [--repo <owner/name>] [--json <file>] — how long each PBI closed in the period took,
 * stage by stage (PBI #650, docs/design/flow-metrics.md), and the backlog's growth week by week (#1878). Reads the app's
 * stored values (the Issues, comments and Story Points, through BACKLOG_URL as `ops-kit lint` does; a PBI kept in the app
 * only counts too) and GitHub's merged PRs (one GraphQL query per 50 PRs, 100 points at most; it reads nothing when the
 * budget is under 500; none when no GitHub repository is known: the PR stages are unknown), and the Switchboard DB (SWITCHBOARD_HOME, read-only) for each PBI's Tasks.
 * `--repo` chooses the workspace whose stored values are read and the repository whose PRs are read; a repository the app
 * has not imported finds no workspace (exit 2). A backlog kept in the app only has no repository to name: leave it out.
 * Exit 0 = printed / 1 = stopped (FlowError: budget low, a read over 100 points, gh failed…) / 2 = bad arguments, or the stored values could
 * not be read (no BACKLOG_URL — outside the app's Task —, the app not reached, not imported, no workspace for `--repo`).
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FlowStage } from "../packages/protocol/src/index.ts";
import { runGh } from "../packages/core/src/backlog.ts";
import { backlogGrowth, fetchFlow, FlowError, launchShare, prRepoOf, summarize, weekStartOf, withSwitchboardTasks } from "../packages/core/src/flow.ts";
import { deferredTasksSince } from "../packages/core/src/db.ts";
import { readRecords, type StoredRecords } from "../ops-kit/src/backlog-client.ts";

const dur = (ms: number | null): string => {
  if (ms === null) return "不明";
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 120) return `${m}m`;
  return m < 2880 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  const days = Number(arg("--days") ?? 30);
  if (!Number.isInteger(days) || days < 1) {
    console.error("usage: bun scripts/flow-report.ts [--days 30] [--repo <owner/name>] [--json <file>]\n--repo はアプリに取り込まれたリポジトリだけ（それ以外は exit 2）");
    return 2;
  }
  const cwd = process.cwd();
  let records: StoredRecords;
  try {
    // the workspace as `ops-kit lint` finds it (GH_REPO, else BACKLOG_WORKSPACE — a backlog kept in the app only —, else
    // origin); `--repo` takes GH_REPO's place, ahead of BACKLOG_WORKSPACE
    records = await readRecords(process.env, { fresh: false, repo: arg("--repo"), cwd });
  } catch (e) {
    console.error(`アプリの保存値を読めません: ${(e as Error).message}`);
    return 2;
  }
  // the PRs' repository: --repo, else as the screen reads it (flowView); none = no PR is read
  const repo = arg("--repo") ?? prRepoOf(records, cwd);
  if (!repo) console.error("GitHub のリポジトリが無いので PR は読みません（PR の段は不明）");
  const name = repo ?? records.repository;
  const dbPath = join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "switchboard.db");
  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;
  try {
    const { reads: read, spent, cutPbis, growth } = await fetchFlow(runGh, cwd, repo, days, records);
    // the workspace whose stored values were read: Issue numbers repeat across repositories, so a Task counts only from it
    const workspaces = [records.workspaceId];
    const pbis = read.map((r) => withSwitchboardTasks(r, db, workspaces));
    const sum = summarize(pbis);
    console.log(`${name}: 直近 ${days} 日に閉じた PBI ${sum.closed} 件、Story Points 合計 ${sum.storyPoints}`);
    console.log("\n段\t中央値\tp90\t件数");
    for (const st of FlowStage.options) console.log(`${st}\t${dur(sum.stages[st].p50)}\t${dur(sum.stages[st].p90)}\t${sum.stages[st].count}`);
    console.error(`GraphQL の消費: ${spent} ポイント`);
    if (cutPbis.length) console.error(`PR のコメントの一覧が GitHub の 1 回の上限で切れた PBI（表で * を付けた。その行の数は少なく出る）: ${cutPbis.map((n) => `#${n}`).join(" ")}`);
    console.log(`一番時間を食った段（中央値）: ${sum.bottleneck ?? "不明"}`);
    console.log(`\nPBI\t${FlowStage.options.join("\t")}\t返事待ち\tレビュー回数\tTask\t費用`);
    for (const p of pbis) {
      const t = p.tasks ? `${p.tasks.count} 件 ${dur(p.tasks.runMs)}\t$${p.tasks.costUsd.toFixed(2)}` : "-\t-";
      console.log(`#${p.number}${cutPbis.includes(p.number) ? "*" : ""}\t${FlowStage.options.map((st) => dur(p.stages[st] ?? null)).join("\t")}\t${dur(p.userWaitMs)}\t${p.reviewRounds.join("/") || "-"}\t${t}`);
    }
    const share = launchShare(pbis);
    console.log(`\n実装を 3 回以上起動した PBI: ${share.known ? `${share.repeated}/${share.known}（${Math.round((share.repeated / share.known) * 100)}%）` : "不明"}`);
    console.log(`段 wait の中央値: ${dur(sum.stages.wait.p50)}`);
    // the backlog's growth (#1878): without the DB the deferred columns are not known
    const known = !!db;
    const now = Date.now();
    const weeks = backlogGrowth(growth, known ? deferredTasksSince(db!, workspaces, weekStartOf(now - days * 86_400_000)) : [], records.repository, days, now);
    console.log("\n週\tPBI 起票\tPBI 閉鎖\t要望 起票\t要望 閉鎖\t純増\t先送り Task\tそこからの起票");
    for (const w of weeks) console.log(`${w.weekStart}\t${w.pbiOpened}\t${w.pbiClosed}\t${w.requestOpened}\t${w.requestClosed}\t${w.net > 0 ? "+" : ""}${w.net}\t${known ? w.deferredTasks : "-"}\t${known ? w.deferredIssues : "-"}`);
    const json = arg("--json");
    if (json) writeFileSync(json, JSON.stringify({ repo: name, days, cutPbis, stages: sum.stages, bottleneck: sum.bottleneck, closed: sum.closed, storyPoints: sum.storyPoints, pbis, weeks }, null, 2));
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
