import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScanCursors } from "@switchboard/protocol";
import { CONFIG_FILE, publicCopyOf } from "../../../ops-kit/src/config.ts";
import { type GhRunner, repoOf } from "./backlog-gh.ts";

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
const HIT_LINE = /^https:\/\/\S+: ([a-z-]+)（\d+ 行目）$/;

/**
 * How a hit is cleaned up, by what the value is: one that stays usable is revoked first (hiding the text does not
 * take back what was read), one that expires in minutes and a name that cannot be revoked are only hidden. A kind of
 * the kit's `SECRET_KINDS` missing here gets the cautious answer (`REMEDY_UNKNOWN`); the test keeps the two in step.
 */
const REVOKE = "長く使える値。先に失効させて作り直し、その後に本文を伏せ字に直す";
const EXPIRED = "数分で失効する値。失効・作り直しは要らず、本文を伏せ字に直すだけ";
const NAME = "識別子（失効はできない）。本文を伏せ字に直す";
export const REMEDY: Record<string, string> = {
  "aws-key": REVOKE,
  "github-token": REVOKE,
  "gitlab-token": REVOKE,
  "private-key": REVOKE,
  "bearer-token": REVOKE,
  "invite-secret": REVOKE,
  "device-code": EXPIRED,
  "approval-url": EXPIRED,
  "account-id": NAME,
  "sso-start-url": NAME,
  "aws-profile": NAME,
};
const REMEDY_UNKNOWN = "本物の値なら先に失効させて作り直し、その後に本文を伏せ字に直す";
const REMEDY_HOW = "直し方: コメントは値を伏せた文を新しいコメントとして書いて元のコメントを削除する（編集では履歴に元の文が残る）。Issue・PR の本文は伏せ字に直し、編集履歴から元の版を削除する";

/** The clean-up lines for hit lines (`<URL>: <kind>（<n> 行目）`): one per kind that was hit, then how a text is fixed. No value, no URL. */
export function remedyLines(hits: readonly string[]): string[] {
  const kinds = [...new Set(hits.map((h) => HIT_LINE.exec(h.trim())?.[1]).filter((k): k is string => k !== undefined))].sort();
  return kinds.length ? [...kinds.map((k) => `${k}: ${REMEDY[k] ?? REMEDY_UNKNOWN}`), REMEDY_HOW] : [];
}

/**
 * The counts of one firing: `repos` = repositories identified from the workspaces (a repository whose scan then
 * failed counts here too), `hits`, `failed` = scans that failed plus workspaces whose repository could not be identified.
 */
export interface ScanSummary {
  repos: number;
  hits: number;
  failed: number;
}

/**
 * The daily check of what is already written: every registered repository once (several checkouts of one
 * repository are one), and the public copy a registered repository publishes to (`publicSync.target` of the
 * `ops.config.json` at its checkout's root) — it need not be registered, and it is where a written value is read by
 * anyone. Each goes through the kit's `scan-issues` with the host's `gh` login. `lines` are the log of the
 * firing, one per repository, with the places and kinds of its hits only — of scan-issues' output it keeps the hit lines,
 * nothing else, and of a failure its exit code. 判断待ち's notice is read from them (asks-notices.ts `scanFindings`).
 * A repository with a cursor is read from its time on (`--since`) and its earlier hits read again (`--recheck`); the
 * time is taken before the scan starts, so what is written during it is read again next time, never missed. A
 * repository that was not checked this time (its scan failed, or its workspace's repository could not be identified)
 * keeps its old cursor; one without a cursor is read whole.
 */
export async function scanAllRepos(opts: { workspaces: Array<{ name: string; path: string }>; metaPath: string; gh: GhRunner; spawn?: Spawn; cursors?: ScanCursors; now?: () => number }): Promise<{ lines: string[]; summary: ScanSummary; cursors: ScanCursors }> {
  const spawn = opts.spawn ?? runSpawn;
  const now = opts.now ?? Date.now;
  const cursors: ScanCursors = { ...opts.cursors };
  const lines: string[] = [];
  const failed: string[] = [];
  const repos = new Set<string>();
  for (const ws of opts.workspaces) {
    try {
      repos.add((await repoOf(opts.gh, ws.path)).repo);
      // the checkout's own file only: one found further up belongs to another tree
      const target = existsSync(join(ws.path, CONFIG_FILE)) ? publicCopyOf(ws.path) : null;
      if (target) repos.add(target);
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
      cursors[repo] = { since: started, hits: [...new Set(at.map((l) => l.slice(0, l.indexOf(": "))))] };
    } else {
      // the exit code only: what a failure printed could quote anything (bash scripts/setup/scan_issues.sh <repo> shows it)
      const why = `${repo}: 検査できなかった（exit ${r.code}）`;
      lines.push(why);
      failed.push(why);
    }
  }
  const summary: ScanSummary = { repos: repos.size, hits, failed: failed.length };
  return { lines, summary, cursors };
}
