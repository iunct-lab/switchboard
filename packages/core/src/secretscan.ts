import { join } from "node:path";
import type { ScanCursors } from "@switchboard/protocol";
import { type GhRunner, repoOf } from "./backlog.ts";

/** Runs a command to the end; a command that cannot start answers like a failed one. */
export type Spawn = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runSpawn: Spawn = async (cmd) => {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: `起動できません: ${(e as Error).message}` };
  }
};

/** A hit as scan-issues prints it: the place and the kind (`<URL>: <kind>（<n> 行目）`), never the value. */
const HIT_LINE = /^https:\/\/\S+: [a-z-]+（\d+ 行目）$/;

/**
 * The counts of one firing (#1274): `repos` = repositories identified from the workspaces (a repository whose scan then
 * failed counts here too), `hits`, `failed` = scans that failed plus workspaces whose repository could not be identified.
 */
export interface ScanSummary {
  repos: number;
  hits: number;
  failed: number;
}

/**
 * The daily check of what is already written (#775): every registered repository once (several checkouts of one
 * repository are one), each through the kit's `scan-issues` with the host's `gh` login. `lines` are the log of the
 * firing, one per repository; `note` is there only when a repository has hits or could not be checked, and carries the
 * places and kinds only — of scan-issues' output it keeps the hit lines, nothing else, and of a failure its exit code.
 * A repository with a cursor is read from its time on (`--since`) and its earlier hits read again (`--recheck`); the
 * time is taken before the scan starts, so what is written during it is read again next time, never missed. A
 * repository that was not checked this time (its scan failed, or its workspace's repository could not be identified)
 * keeps its old cursor; one without a cursor is read whole.
 */
export async function scanAllRepos(opts: { workspaces: Array<{ name: string; path: string }>; metaPath: string; gh: GhRunner; spawn?: Spawn; cursors?: ScanCursors; now?: () => number }): Promise<{ lines: string[]; summary: ScanSummary; cursors: ScanCursors; note?: { title: string; body: string } }> {
  const spawn = opts.spawn ?? runSpawn;
  const now = opts.now ?? Date.now;
  const cursors: ScanCursors = { ...opts.cursors };
  const lines: string[] = [];
  const found: string[] = [];
  const failed: string[] = [];
  const repos = new Set<string>();
  for (const ws of opts.workspaces) {
    try {
      repos.add((await repoOf(opts.gh, ws.path)).repo);
    } catch {
      const why = `${ws.name}: 検査できなかった（リポジトリを特定できない）`;
      lines.push(why);
      failed.push(why);
    }
  }
  let hits = 0;
  for (const repo of repos) {
    const last = opts.cursors?.[repo];
    const started = new Date(now()).toISOString();
    const from = last ? ["--since", last.since, ...[...new Set(last.hits)].flatMap((u) => ["--recheck", u])] : [];
    const r = await spawn([process.execPath, join(opts.metaPath, "ops-kit/src/cli.ts"), "scan-issues", ...from, repo]);
    // scan-issues ends with its count line; without it the exit code is not its answer (bun itself exits 1 on a
    // missing file, a kit too old to print it is no answer either)
    const scanned = /^hits: \d+ \/ scanned: (\d+)$/m.exec(r.stdout)?.[1];
    if (scanned !== undefined && r.code === 0) {
      lines.push(`${repo}: 0 件（scanned ${scanned}）`);
      cursors[repo] = { since: started, hits: [] };
    } else if (scanned !== undefined && r.code === 1) {
      const at = r.stdout.split("\n").filter((l) => HIT_LINE.test(l));
      hits += at.length;
      lines.push(`${repo}: 当たり ${at.length} 件（scanned ${scanned}）`, ...at.map((l) => `  ${l}`));
      found.push(`### ${repo}`, ...at.map((l) => `- ${l}`), "");
      cursors[repo] = { since: started, hits: [...new Set(at.map((l) => l.slice(0, l.indexOf(": "))))] };
    } else {
      // the exit code only: what a failure printed could quote anything (bash scripts/setup/scan_issues.sh <repo> shows it)
      const why = `${repo}: 検査できなかった（exit ${r.code}）`;
      lines.push(why);
      failed.push(why);
    }
  }
  const summary: ScanSummary = { repos: repos.size, hits, failed: failed.length };
  if (!found.length && !failed.length) return { lines, summary, cursors };
  const body = [
    "1. 下の URL を開いて、当たりが本物の値か見る",
    "2. 本物なら、先にその値を無効にして（作り直して）から、コメントを削除する",
    "3. 誤検知なら、このお知らせを閉じる",
    "",
    "認証に使える値が既に書かれている場所（URL と種類だけ。値は書かない）。消すかどうかは利用者が決める（docs/design/secret-guard.md）。",
    "",
    ...found,
    ...(failed.length ? ["### 検査できなかった", ...failed.map((l) => `- ${l}`), "", "理由は `bash scripts/setup/scan_issues.sh <owner/name>` を手で走らせて見る。"] : []),
  ].join("\n");
  return { lines, summary, cursors, note: { title: `認証の値の検査: 当たり ${hits} 件 / 検査できなかった ${failed.length} リポジトリ`, body } };
}
