/**
 * Merges a local change: `bun scripts/local-merge.ts <n> [--allow-large]`, in the checkout the change's branches
 * are in, with BACKLOG_URL and BACKLOG_WORKSPACE (the app's Task has them). The change is judged again here by
 * merge-gate's rules (`readChange` + `judge`: what moved since the judgement is caught), and only a merge verdict merges.
 * The merge is GitHub's Rebase and merge: the branch's commits rebased one by one onto the base's tip (no merge commit,
 * author dates kept) in a throwaway worktree under ~/.cache. Where it lands:
 * - a workspace that keeps its changes itself by design (no service behind its Issues): the base branch is
 *   fast-forwarded, in the worktree that has it checked out when there is one — that checkout is where its code lives;
 * - a workspace whose Issues are GitHub's (the change stands in for a pull request while GitHub cannot be used): on the
 *   base's landing ref (packages/core/src/landing.ts), never on the branch — no work tree is touched, so the main work tree
 *   a daemon may be running from does not move; it is updated by `ops-kit pull-main` after forge-resync, as after any
 *   merge. Such a change is merged only while the app still sees GitHub out of use (`GET /api/backlog/outage`): once
 *   GitHub answers, the work goes on as a pull request.
 * Then the branch is deleted (only at the judged head), the merge is recorded on the change (`[local-merge] merged <tip>
 * base=<base>`: forge-resync sends only commits such a record names) and the change closed with its merge commit. The
 * Tasks it closes (`Closes #n`, `Backlog-Task: n`, the branch `sb/<n>-`) are closed with their Status Done — at once
 * where the workspace keeps its changes itself; in a GitHub workspace by `forge-resync.ts --report`, once GitHub's main
 * has the commits (a Task is not Done on GitHub before its code is there).
 * A conflict, a stop, a dirty worktree of the base or a base that moved changes nothing (exit 1). Once the merge landed,
 * a failure of the app is said with what is left (exit 1); it is not taken back. No fetch, no push, no gh.
 * `<n> --record <tip> --reviewed <head>` (both 40 hex) only writes that record again, for a merge that landed but whose record
 * the app refused: no judgement, no rebase, no base move, no branch deleted. It writes only while the change is still open
 * and `tip` is on the base (its landing ref where the merge lands there); otherwise it exits 1 and writes nothing.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { client, runBacklog, type Detail } from "../ops-kit/src/backlog-client.ts";
import { sh } from "./local-ci.ts";
import { judge, readChange, readChangeDetail, readChangeRecords } from "./merge-gate.ts";
import type { StoredRecords } from "../ops-kit/src/backlog-client.ts";
import { linkedIssues } from "./task-paths.ts";
import { landedTip, landingRef } from "../packages/core/src/landing.ts";

const USAGE = "usage: bun scripts/local-merge.ts <n> [--allow-large] | bun scripts/local-merge.ts <n> --record <tip> --reviewed <head>";
const BACKLOG_TASK = /^Backlog-Task: (\d+)\s*$/gm;
/** The record local-merge leaves on a change it merged: the commits `base..tip` are that change's, as judged. */
export const LOCAL_MERGE = /^\[local-merge\] merged ([0-9a-f]{40}) base=([0-9a-f]{40})\b/;
export const localMergeMark = (tip: string, base: string) => `[local-merge] merged ${tip} base=${base}`;
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

/** The Issues a change closes: its body's `Closes #n` and `Backlog-Task: n`, and its branch `sb/<n>-`; not itself. */
export function closedBy(n: number, body: string, head: string): number[] {
  const all = [...linkedIssues({ body, headRefName: head }), ...[...body.matchAll(BACKLOG_TASK)].map((m) => Number(m[1]))];
  return [...new Set(all)].filter((x) => x !== n).sort((a, b) => a - b);
}

/** The worktree that has `branch` checked out, or undefined (`git worktree list --porcelain`). */
export async function worktreeOf(root: string, branch: string): Promise<string | undefined> {
  let path: string | undefined;
  for (const line of (await sh(["git", "-C", root, "worktree", "list", "--porcelain"])).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/**
 * Moves `branch` of the repository at `root` from `expected` to `to` (forge-resync moves main the same way). The
 * worktree that has it checked out, if any, is fast-forwarded only when it is clean and still at `expected`; with none, the
 * ref is updated only from `expected`. A branch that moved since is not overwritten: it throws, and nothing changed.
 */
export async function advanceBranch(root: string, branch: string, to: string, expected: string): Promise<void> {
  const tree = await worktreeOf(root, branch);
  if (!tree) {
    await sh(["git", "-C", root, "update-ref", `refs/heads/${branch}`, to, expected]);
    return;
  }
  if ((await sh(["git", "-C", tree, "status", "--porcelain", "--untracked-files=no"])).trim()) throw new Error(`${branch} を checkout している作業ツリー（${tree}）に未コミットの変更がある`);
  const now = (await sh(["git", "-C", tree, "rev-parse", "HEAD"])).trim();
  if (now !== expected) throw new Error(`${branch} が判定の後に動いた（${expected.slice(0, 7)} → ${now.slice(0, 7)}）`);
  await sh(["git", "-C", tree, "merge", "-q", "--ff-only", to]);
}

/**
 * Lands a merge of `branch` on its landing ref (landing.ts) without touching any work tree: `from` is what `landedTip`
 * read when the base was judged. The ref is written only from the value it had then (none: it must not exist), so two
 * merges at once do not both land.
 */
export async function landOn(root: string, branch: string, to: string, from: { landing: string | null }): Promise<void> {
  await sh(["git", "-C", root, "update-ref", landingRef(branch), to, from.landing ?? "0".repeat(40)]);
}

/** What `recordMerge` writes about a merge that landed: `base` is the tip it was rebased onto, `head` the head that was judged. */
interface MergeRecord {
  n: number;
  workspace: string;
  tip: string;
  base: string;
  head: string;
  mergedAt: string;
  apart: boolean;
  detail: { issue: { body: string } };
  headName: string;
  log: (s: string) => void;
  /** the mark is on the change already (a record retried after only the PATCH was refused) */
  marked?: boolean;
}

/** Records a landed merge on its change (the mark, the closed state) and closes the Tasks it closes; returns what could not be written. */
async function recordMerge(api: ReturnType<typeof client>, r: MergeRecord): Promise<string[]> {
  const { n, workspace, tip, base, head, mergedAt, apart, detail, headName, log, marked } = r;
  const left: string[] = [];
  try {
    // which commits are this change's: forge-resync sends the local merges only when every commit is named by such a record
    if (!marked) await api("POST", `/${n}/comment?change=1`, { workspaceId: workspace, text: localMergeMark(tip, base) });
    await api("PATCH", `/${n}?change=1`, { workspaceId: workspace, state: "CLOSED", change: { mergeCommit: tip, mergedAt, reviewedHead: head } });
  } catch (e) {
    // without this record forge-resync stops at this commit (it sends only recorded merges) and says what the person can do
    left.push(`変更 #${n} をマージ済みにする（${(e as Error).message}）。デーモンを昇格してから bun scripts/local-merge.ts ${n} --record ${tip} --reviewed ${head} で記録だけやり直せる。記録が無いと bun scripts/forge-resync.ts はこのコミットで止まる（止まったときの出力に、利用者が端末で実行する --adopt-landing ${tip} / --drop-landing ${tip} が出る）`);
  }
  // in a GitHub workspace the Tasks are closed once GitHub's main has the commits (forge-resync.ts --report): a close
  // kept here would be sent as soon as GitHub is back, before the code
  if (apart) log(`閉じる Task（${closedBy(0, detail.issue.body, headName).map((t) => `#${t}`).join(", ") || "無し"}）は、GitHub の main に入ってから forge-resync.ts --report が閉じる`);
  for (const t of apart ? [] : closedBy(n, detail.issue.body, headName)) {
    try {
      // its Status with it: a closed Task left In review on the board reads as not done
      await api("PATCH", `/${t}`, { workspaceId: workspace, state: "CLOSED", fields: { Status: "Done" } });
      log(`#${t} を閉じた`);
    } catch (e) {
      left.push(`#${t} を閉じる（${(e as Error).message}）`);
    }
  }
  return left;
}

/** Whether `base..tip` holds the commits of `head` (since it left `base`'s line) and no others, compared by patch (a rebase changes the ids). A commit git cannot read counts as not the same. */
async function sameCommits(root: string, base: string, tip: string, head: string): Promise<boolean> {
  try {
    const at = ["git", "-C", root];
    const from = (await sh([...at, "merge-base", base, head])).trim();
    const extra = (out: string) => out.split("\n").some((l) => l.startsWith("+ "));
    // a commit of tip that head does not have, and a commit of head that tip does not have
    return !extra(await sh([...at, "cherry", head, tip, base])) && !extra(await sh([...at, "cherry", tip, head, from]));
  } catch {
    return false;
  }
}

/**
 * `--record`: writes the record of a merge that landed but was not recorded. The change must still be open and `tip` on the
 * base (the landing ref where merges land there); the base it was rebased onto is the one its `[local-ci] pass` for `head`
 * names (the judgement only passes at the base's tip). Anything else: exit 1, nothing written.
 */
async function recordOnly(n: number, r: { tip: string; head: string }, cwd: string, o: MergeOpts, log: (s: string) => void, err: (s: string) => void): Promise<number> {
  const stop = (why: string) => (err(`${why}。何も書いていない`), 1);
  let root: string;
  let detail: Detail;
  let apart: boolean;
  try {
    root = (await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    const out: string[] = [];
    const code = await runBacklog(["view", String(n), "--change", "--json"], o.env, { out: (s) => out.push(s), err: (s) => out.push(s) }, { fetch: o.fetch, cwd });
    if (code !== 0) throw new Error(`#${n} を読めない: ${out.join(" ").trim() || `exit ${code}`}`);
    detail = JSON.parse(out.join("\n")) as Detail;
    apart = (await readChangeRecords(detail as Parameters<typeof readChangeRecords>[0], o.env, o.fetch)).service !== "switchboard";
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  const change = detail.issue.change;
  const workspace = detail.workspaceId;
  if (!change || !workspace) return stop(`#${n} は変更ではないか、workspace が分からない`);
  if (detail.issue.state !== "OPEN") return stop(`変更 #${n} は開いていない（もう記録されている）`);
  const landed = landedTip(root, change.base);
  const onBase = landed ? await sh(["git", "-C", root, "merge-base", "--is-ancestor", r.tip, landed.sha]).then(() => true, () => false) : false;
  if (!onBase) return stop(`${r.tip.slice(0, 7)} は ${change.base} に入っていない`);
  const judged = detail.comments.map((c) => new RegExp(`^\\[local-ci\\] pass ${r.head} base=([0-9a-f]{40})\\b`).exec(c.body)?.[1]).filter(Boolean).pop();
  if (!judged || !(await sh(["git", "-C", root, "merge-base", "--is-ancestor", judged, r.tip]).then(() => true, () => false))) return stop(`${r.head.slice(0, 7)} の判定（[local-ci] pass）が変更に無いか、その base が ${r.tip.slice(0, 7)} の祖先でない`);
  // the record names judged..tip as this change's commits, and forge-resync sends what a record names: they must be the
  // judged head's commits and nothing else (a commit that landed after it waits for the person's --adopt-landing)
  if (!(await sameCommits(root, judged, r.tip, r.head))) return stop(`${judged.slice(0, 7)}..${r.tip.slice(0, 7)} の中身が判定した ${r.head.slice(0, 7)} のコミットと同じでない`);
  const api = client(o.env, o.fetch ?? fetch);
  // when the base moved, not when the record was written again: the rebased tip's committer date
  const mergedAt = new Date((await sh(["git", "-C", root, "log", "-1", "--format=%cI", r.tip])).trim()).toISOString();
  const marked = detail.comments.some((c) => c.body.trim() === localMergeMark(r.tip, judged).trim());
  const left = await recordMerge(api, { n, workspace, tip: r.tip, base: judged, head: r.head, mergedAt, apart, detail, headName: change.head, log, marked });
  if (left.length) {
    err(`記録が残った: ${left.join(" / ")}`);
    return 1;
  }
  log(`変更 #${n} の記録を書いた（${r.tip}）`);
  return 0;
}

/** The command: 0 = merged and every state written / 1 = stopped (nothing changed), or the app's update failed after the merge / 2 = not judged. */
export async function main(args: string[], cwd: string, o: MergeOpts): Promise<number> {
  const log = o.log ?? console.log;
  const err = o.err ?? console.error;
  const n = Number(args[0]);
  const rest = args.slice(1);
  const record = rest[0] === "--record" && rest[2] === "--reviewed" && rest.length === 4 && rest.slice(1).every((a, i) => i % 2 === 1 || /^[0-9a-f]{40}$/.test(a)) ? { tip: rest[1]!, head: rest[3]! } : undefined;
  if (!/^\d+$/.test(args[0] ?? "") || (!record && rest.some((a) => a !== "--allow-large"))) {
    err(USAGE);
    return 2;
  }
  if (record) return recordOnly(n, record, cwd, o, log, err);
  let root: string;
  let detail: Awaited<ReturnType<typeof readChangeDetail>>;
  let facts: Awaited<ReturnType<typeof readChange>>;
  let records: StoredRecords;
  try {
    root = (await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    detail = await readChangeDetail(n, o.env, { fetch: o.fetch, cwd });
    records = await readChangeRecords(detail, o.env, o.fetch);
    facts = await readChange(detail, root, records);
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  log(JSON.stringify(j, null, 2));
  if (j.verdict !== "merge") return 1;
  // a workspace whose Issues are a service's numbers its changes apart: the change's own number may be a Task's there
  const apart = records.service !== "switchboard";

  const git = (...a: string[]) => sh(["git", "-C", root, ...a]);
  const { head: headName, base: baseName } = detail.issue.change;
  const { head, base } = detail.changeRefs as { head: string; base: string };
  const workspace = detail.workspaceId;
  if (!workspace) {
    err(`判定できなかった: #${n} の workspace が分からない（アプリの答えに workspaceId が無い）`);
    return 2;
  }
  const api = client(o.env, o.fetch ?? fetch);
  // a change that stands in for a pull request is merged here only while GitHub cannot be used, as the app sees it now
  if (apart) {
    let outage: { unusable?: boolean; detail?: string; reason?: string };
    try {
      outage = (await api("GET", `/outage?workspaceId=${encodeURIComponent(workspace)}`)) as typeof outage;
    } catch (e) {
      err(`判定できなかった: GitHub が使えないかをアプリに確かめられない（${(e as Error).message}）`);
      return 2;
    }
    if (outage.unusable !== true) {
      err(outage.reason === "usable"
        ? "GitHub は使えます（アプリが今確かめた）。ローカルではマージしない。何も変えていない。forge-resync.ts でローカルのマージを送り、この枝は PR で進める"
        : `GitHub が一時的に使えないとは確かめられない（${outage.detail ?? "理由なし"}）。ローカルではマージしない。何も変えていない。止まって利用者に報告する`);
      return 1;
    }
  }
  // the tip the change was judged on must still be where local work is based (the branch, or its landing ref)
  const landed = landedTip(root, baseName);
  if (!landed || landed.sha !== base) {
    err(`${baseName} が判定の後に動いた（${base.slice(0, 7)} → ${landed?.sha.slice(0, 7) ?? "無し"}）。何も変えていない（判定し直す）`);
    return 1;
  }
  // a GitHub workspace's merge never moves a work tree; one that keeps its changes itself moves its branch, unless its
  // merges already wait on the landing ref (forge-resync put a merge of GitHub's main there)
  const toLanding = apart || landed.ref === landingRef(baseName);
  const baseTree = toLanding ? undefined : await worktreeOf(root, baseName);
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
    if (toLanding) await landOn(root, baseName, tip, landed);
    else await advanceBranch(root, baseName, tip, base);
  } catch (e) {
    err(`${baseName} を進められない: ${(e as Error).message.split("\n")[0]}。何も変えていない（判定し直す）`);
    return 1;
  }
  log(`${baseName}: ${base.slice(0, 7)} → ${tip.slice(0, 7)}（${headName} のコミットを rebase で並べた）`);
  if (toLanding) log(`${landingRef(baseName)} に置いた。枝 ${baseName} とその作業ツリーは動かしていない（GitHub へは forge-resync.ts、作業ツリーはそのあと ops-kit pull-main）`);

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
  const mergedAt = (o.now ?? (() => new Date()))().toISOString();
  left.push(...(await recordMerge(api, { n, workspace, tip, base, head, mergedAt, apart, detail, headName, log })));
  if (left.length) {
    err(`${baseName} は入った。状態の更新が残った: ${left.join(" / ")}`);
    return 1;
  }
  log(`変更 #${n} をマージした（${tip}）`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.cwd(), { env: process.env }));
