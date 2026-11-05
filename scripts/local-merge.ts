/**
 * Merges a local change (#2489): `bun scripts/local-merge.ts <n> [--allow-large]`, in the checkout the change's branches
 * are in, with BACKLOG_URL and BACKLOG_WORKSPACE (the app's Task has them). The change is judged again here by
 * merge-gate's rules (`readChange` + `judge`: what moved since the judgement is caught), and only a merge verdict merges.
 * The merge is GitHub's Rebase and merge: the branch's commits rebased one by one onto the base's tip (no merge commit,
 * author dates kept) in a throwaway worktree under ~/.cache, then the base fast-forwarded to them, the branch deleted (only at the judged head),
 * the change closed with its merge commit and the Tasks it closes (`Closes #n`, `Backlog-Task: n`, the branch `sb/<n>-`)
 * closed. A conflict, a stop, a dirty worktree of the base or a base that moved changes nothing (exit 1). Once the base
 * moved, a failure of the app is said with what is left (exit 1); the base is not moved back. No fetch, no push, no gh.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { client } from "../ops-kit/src/backlog-client.ts";
import { sh } from "./local-ci.ts";
import { judge, readChange, readChangeDetail } from "./merge-gate.ts";
import { linkedIssues } from "./task-paths.ts";

const USAGE = "usage: bun scripts/local-merge.ts <n> [--allow-large]";
const BACKLOG_TASK = /^Backlog-Task: (\d+)\s*$/gm;
/** The identity the rebase commits as (local-ci's): the clone's settings do not decide it; the author stays the commit's. */
const IDENTITY = ["-c", "user.name=local-merge", "-c", "user.email=local-merge@localhost", "-c", "commit.gpgSign=false"];

export interface MergeOpts {
  env: Record<string, string | undefined>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Where the throwaway worktree goes (~/.cache; tests give their own). */
  cache?: string;
  log?: (s: string) => void;
  err?: (s: string) => void;
  now?: () => Date;
}

/** The Issues a change closes (#2489): its body's `Closes #n` and `Backlog-Task: n`, and its branch `sb/<n>-`; not itself. */
export function closedBy(n: number, body: string, head: string): number[] {
  const all = [...linkedIssues({ body, headRefName: head }), ...[...body.matchAll(BACKLOG_TASK)].map((m) => Number(m[1]))];
  return [...new Set(all)].filter((x) => x !== n).sort((a, b) => a - b);
}

/** The worktree that has `branch` checked out, or undefined (`git worktree list --porcelain`). */
async function worktreeOf(root: string, branch: string): Promise<string | undefined> {
  let path: string | undefined;
  for (const line of (await sh(["git", "-C", root, "worktree", "list", "--porcelain"])).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/** The command: 0 = merged and every state written / 1 = stopped (nothing changed), or the app's update failed after the merge / 2 = not judged. */
export async function main(args: string[], cwd: string, o: MergeOpts): Promise<number> {
  const log = o.log ?? console.log;
  const err = o.err ?? console.error;
  const n = Number(args[0]);
  if (!/^\d+$/.test(args[0] ?? "") || args.slice(1).some((a) => a !== "--allow-large")) {
    err(USAGE);
    return 2;
  }
  let root: string;
  let detail: Awaited<ReturnType<typeof readChangeDetail>>;
  let facts: Awaited<ReturnType<typeof readChange>>;
  try {
    root = (await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    detail = await readChangeDetail(n, o.env, { fetch: o.fetch, cwd });
    facts = await readChange(detail, root);
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  log(JSON.stringify(j, null, 2));
  if (j.verdict !== "merge") return 1;

  const git = (...a: string[]) => sh(["git", "-C", root, ...a]);
  const { head: headName, base: baseName } = detail.issue.change;
  const { head, base } = detail.changeRefs as { head: string; base: string };
  const workspace = detail.workspaceId;
  if (!workspace) {
    err(`判定できなかった: #${n} の workspace が分からない（アプリの答えに workspaceId が無い）`);
    return 2;
  }
  const baseTree = await worktreeOf(root, baseName);
  if (baseTree && (await sh(["git", "-C", baseTree, "status", "--porcelain", "--untracked-files=no"])).trim()) {
    err(`${baseName} を checkout している作業ツリー（${baseTree}）に未コミットの変更がある。何も変えていない`);
    return 1;
  }

  // the rebase, apart from every worktree of the person's
  const cache = o.cache ?? join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, `switchboard.local-merge-${workspace.replace(/[^\w.-]/g, "_")}-${n}.`));
  let tip: string;
  try {
    const added = await git("worktree", "add", "-q", "--detach", dir, head).then(() => true, (e: unknown) => (err(`作業用の worktree を作れない（${(e as Error).message.split("\n")[0]}）。何も変えていない`), false));
    if (!added) return 1;
    const rebased = await sh(["git", "-C", dir, ...IDENTITY, "rebase", "-q", base]).then(() => true, () => false);
    if (!rebased) {
      await sh(["git", "-C", dir, "rebase", "--abort"]).catch(() => undefined);
      err(`${headName} を ${baseName}（${base.slice(0, 7)}）の上に rebase できない（衝突）。何も変えていない`);
      return 1;
    }
    tip = (await sh(["git", "-C", dir, "rev-parse", "HEAD"])).trim();
  } finally {
    await git("worktree", "remove", "--force", dir).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }

  // the base to the new tip: only from the base that was judged (one that moved since is not overwritten)
  try {
    if (baseTree) {
      const now = (await sh(["git", "-C", baseTree, "rev-parse", "HEAD"])).trim();
      if (now !== base) throw new Error(`${baseName} が判定の後に動いた（${base.slice(0, 7)} → ${now.slice(0, 7)}）`);
      await sh(["git", "-C", baseTree, "merge", "-q", "--ff-only", tip]);
    } else await git("update-ref", `refs/heads/${baseName}`, tip, base);
  } catch (e) {
    err(`${baseName} を進められない: ${(e as Error).message.split("\n")[0]}。何も変えていない（判定し直す）`);
    return 1;
  }
  log(`${baseName}: ${base.slice(0, 7)} → ${tip.slice(0, 7)}（${headName} のコミットを rebase で並べた）`);

  // from here the base has moved: what fails is said with what is left, and the base stays
  const left: string[] = [];
  try {
    // only the judged head: a commit made on the branch since stays on it, and so does its checkout (said, not lost)
    const now = (await git("rev-parse", "--verify", "-q", `refs/heads/${headName}`).catch(() => "")).trim();
    if (now !== head) throw new Error(`判定の後に動いた（${head.slice(0, 7)} → ${now.slice(0, 7) || "無し"}）。枝と作業ツリーはそのまま`);
    const headTree = await worktreeOf(root, headName);
    if (headTree) await sh(["git", "-C", headTree, "switch", "-q", "--detach"]);
    await git("update-ref", "-d", `refs/heads/${headName}`, head);
  } catch (e) {
    left.push(`枝 ${headName} の削除（${(e as Error).message.split("\n")[0]}）`);
  }
  const api = client(o.env, o.fetch ?? fetch);
  const mergedAt = (o.now ?? (() => new Date()))().toISOString();
  try {
    await api("PATCH", `/${n}`, { workspaceId: workspace, state: "CLOSED", change: { mergeCommit: tip, mergedAt } });
  } catch (e) {
    left.push(`変更 #${n} をマージ済みにする（${(e as Error).message}）`);
  }
  for (const t of closedBy(n, detail.issue.body, headName)) {
    try {
      await api("PATCH", `/${t}`, { workspaceId: workspace, state: "CLOSED" });
      log(`#${t} を閉じた`);
    } catch (e) {
      left.push(`#${t} を閉じる（${(e as Error).message}）`);
    }
  }
  if (left.length) {
    err(`${baseName} は入った。状態の更新が残った: ${left.join(" / ")}`);
    return 1;
  }
  log(`変更 #${n} をマージした（${tip}）`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.cwd(), { env: process.env }));
