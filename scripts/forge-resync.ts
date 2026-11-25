/**
 * Sends the local main to GitHub after it was away: `bun scripts/forge-resync.ts [--pbi <n>]`, in a
 * worktree of the repository, with BACKLOG_URL (the app's Task has it). GitHub's main (G, after `git fetch origin main`)
 * and the local main (L: the branch `main`, or its landing ref where local merges landed — packages/core/src/landing.ts):
 * - L = G, or L behind G: nothing to send
 * - G behind L: L is pushed to the sync branch `sb/sync-main-<7>` and a PR to main is opened (exit 5)
 * - both moved: G merged into L with a merge commit in a throwaway worktree under ~/.cache, L moved to it, then the
 *   same sync branch and PR
 * - that merge conflicts: nothing pushed, L unchanged, a `## 判断待ち` on the PBI (`--pbi`) with label needs-decision
 * - origin is not GitHub's repository: nothing pushed (exit 2) — no other forge is sent to
 * GitHub's main takes no direct push from here, whether or not it is protected (no read of its protection, no push to
 * main to be refused): the sync PR is the only way in.
 * Before anything is merged or pushed, L is checked (`verifyLocal`): it must be GitHub's main plus only the commits a
 * local merge that passed the gate recorded on its change (`[local-merge] merged <tip> base=<base>`, scripts/local-merge.ts)
 * and this script's own clean merges of GitHub's main. Any other commit — one made on main by hand, a merge resolved by
 * hand — stops it: nothing is pushed, the ref and the commits are listed (exit 1), and how they go in is the person's
 * to decide. It does not stay stuck there: the person runs one of two commands in a terminal, each naming the tip it
 * saw (a tip that moved since is refused) — `--adopt-landing <tip>` accepts the unrecorded commits of that tip for this
 * run and goes on (always through the sync PR), `--drop-landing <tip>` deletes the landing ref
 * (the branch `main` is never deleted or moved back by this script). Neither is ever run by the script itself, and
 * both are refused without a terminal or inside a Task (`SWITCHBOARD_TASK_ID`) — a check against a slip, not a
 * boundary: a Task runs as the same user.
 * Never `--force` / `--force-with-lease` / a `+` refspec (they drop the commits only GitHub's main has), never a rebase
 * (the tags and the promoted version's sha would change). No work tree is ever moved: where main is checked out (the
 * main work tree, which a running daemon may read), L is kept on the landing ref and the work tree is updated afterwards
 * by `ops-kit pull-main`, the step that is the person's to allow where a dev daemon runs; a main checked out nowhere is
 * moved as a ref, only from where it was.
 * `--merge-sync <PR>` merges the sync PR only when merge-gate's `readPr` + `judge` say merge, with a Merge commit
 * (`gh pr merge --merge`: Squash / Rebase would change the sha); once it is in, `report` runs at once and its exit code is this
 * one's (the merge is done either way: a non-zero code then means run `--report` again, not `--merge-sync`).
 * The sync PR's body lists the app's changes merged here that the PR carries (`L<n>`, title, branch, merge commit); an app
 * that cannot be read does not stop the PR — the body says the list is missing.
 * `--report`: after GitHub is back and has the local main, what was done locally is left on GitHub once per change
 * (`report`): the review and judgement marks of a change merged here go on the PR it stood in for (closed when GitHub
 * did not take it as merged) or, with no PR, on the Task it closed; a change that stood in for a PR and was not merged
 * here is closed, its marks summed up on the PR, where the work goes on. Exit 0 = all left / 1 = one could not be /
 * 4 = GitHub not reachable yet (the rest waits for the next `--report`).
 * With `--merge-sync` the codes below are the merge's own up to the Merge commit; after it is on GitHub, the code is `report`'s
 * (1 / 2 / 4 there mean "the merge is done, the records are not": rerun only `--report`, never `--merge-sync`).
 * Exit: 0 = nothing to send or the sync PR merged (JSON `{ result: "nothing" | "synced", local, remote }`), or the landing
 * ref dropped (`{ result: "dropped", ref, was, remote, commits }`) /
 * 1 = conflict, a commit no local merge recorded (JSON `{ result: "unverified", ref, commits }`), the sync branch push or the PR failed, or the sync PR not merged / 2 = not run (usage, not a
 * repository, origin not GitHub's, the app not reached, a login or permission failure — stop and report —, another failure) / 4 = GitHub
 * not reachable yet (the network, a 5xx, a limit; nothing changed) / 5 = a sync PR opened (JSON
 * `{ result: "sync-pr", pr, branch, local, remote }`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { client, readRecords, runBacklog, type Detail } from "../ops-kit/src/backlog-client.ts";
import { githubHost, outageOf, responseOf, retryAtFromResponse } from "../ops-kit/src/gh.ts";
import { landedTip, landingRef } from "../packages/core/src/landing.ts";
import { landOn, LOCAL_MERGE, worktreeOf } from "./local-merge.ts";
import { judge, readPr, requestGate, type Judgement } from "./merge-gate.ts";
import { report } from "./forge-resync-report.ts";
import { originRepo } from "./repo.ts";

const USAGE = "usage: bun scripts/forge-resync.ts [--pbi <n>]\n       bun scripts/forge-resync.ts --merge-sync <PR> [--allow-large]\n       bun scripts/forge-resync.ts --report\n       bun scripts/forge-resync.ts --adopt-landing <tip sha> [--pbi <n>]   (the person, in a terminal)\n       bun scripts/forge-resync.ts --drop-landing <tip sha>              (the person, in a terminal)";
/** The merge commit's committer (local-ci's and local-merge's): the clone's settings do not decide it. */
const IDENTITY = ["-c", "user.name=forge-resync", "-c", "user.email=forge-resync@localhost", "-c", "commit.gpgSign=false"];
/** git's own words for a remote that did not answer or answered 5xx / 429 (no HTTP status line to classify). A 401 / 403 and a failed login are not here: waiting does not mend them. */
const UNREACHABLE = /could not resolve host|could not read from remote repository|connection (refused|reset|timed out)|operation timed out|failed to connect|the requested url returned error: (5\d\d|429)|early eof|remote end hung up/i;
/** A login or permission failure in git's or gh's words: not an outage. */
const DENIED = /authentication failed|permission denied|the requested url returned error: (401|403|404)|HTTP 40[134]|bad credentials/i;

export type Run = (cmd: string[], cwd?: string, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
/** A local merge as its change records it: the commits `base..tip` are change `number`'s. */
export interface MergedRange { number: number; tip: string; base: string }
export interface ResyncDeps {
  run?: Run;
  /** `ops-kit backlog <argv…>` (the PBI's comment and label); the app's API by default. */
  backlog?: (argv: string[]) => Promise<number>;
  /** Where the throwaway worktree goes (~/.cache; tests give their own). */
  cache?: string;
  /** owner/name of GitHub's repository: the checkout's origin (not GH_REPO: the PR must be origin's, which is fetched and pushed). */
  repo?: string;
  /** The local merges the app's changes record (`mergedRanges`); tests give their own. */
  merged?: () => Promise<MergedRange[]>;
  /** merge-gate's judgement of a PR (`readPr` + `judge`) and the head it judged. */
  judgePr?: (n: number, allowLarge: boolean) => Promise<Judgement & { head: string }>;
  now?: () => number;
  log?: (s: string) => void;
  err?: (s: string) => void;
  /** `--report`: the app (BACKLOG_URL, the workspace as the kit picks it) and, in tests, its fetch. */
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The app's changes of the checkout's workspace (the sync PR's list of local merges); the app's API by default. Tests give their own. */
  changes?: () => Promise<ListedChange[]>;
  /** Whether a person's terminal runs this (stdin and stdout are TTYs); `--adopt-landing` / `--drop-landing` need it. */
  tty?: boolean;
}

export const spawn: Run = async (cmd, cwd, env) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", ...(env ? { env: { ...process.env, ...env } } : {}) });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

/**
 * A failed call that says GitHub cannot be reached for now and is worth coming back for (the kit's classes, or git's own
 * words for the same): the network, a 5xx, a limit. A login or permission failure is not one — it is reported, not
 * waited for.
 */
export function unreachable(stderr: string, now: number): boolean {
  if (DENIED.test(stderr)) return false;
  const response = responseOf("", stderr);
  // here the question is only whether to come back later: a limit counts with or without its end
  const kind = retryAtFromResponse(response, now)?.kind;
  return kind === "primary" || kind === "secondary" || outageOf(response, now) !== null || UNREACHABLE.test(stderr);
}

/**
 * Whether the local main `L` is GitHub's main `G` plus only commits that are accounted for, walking back from L until a
 * commit GitHub's main has: a tip a local merge recorded (`merged`: on to its base, when the range is a straight line of
 * commits with no merge in it), or a merge of GitHub's main this script made (two parents, the second in G's history,
 * and exactly the tree git's own clean merge of the two gives — a merge resolved or edited by hand is not that). `ok:
 * false`: `at` is the first commit that is neither, `commits` the first-parent log from there (newest first, 20 at most).
 */
export async function verifyLocal(run: Run, root: string, L: string, G: string, merged: MergedRange[]): Promise<{ ok: true } | { ok: false; at: string; commits: string[] }> {
  const git = async (...a: string[]) => run(["git", ...a], root);
  const inG = async (c: string) => (await git("merge-base", "--is-ancestor", c, G)).code === 0;
  let cur = L;
  for (let steps = 0; steps < 10_000; steps++) {
    if (await inG(cur)) return { ok: true };
    const range = merged.find((m) => m.tip === cur);
    if (range && (await git("merge-base", "--is-ancestor", range.base, cur)).code === 0 && (await git("rev-list", "--merges", `${range.base}..${cur}`)).stdout.trim() === "" && (await git("rev-list", "--count", `${range.base}..${cur}`)).stdout.trim() !== "0") {
      cur = range.base;
      continue;
    }
    const [, first, second, third] = (await git("rev-list", "--parents", "-n", "1", cur)).stdout.trim().split(" ");
    if (first && second && !third && (await inG(second))) {
      const clean = await git("merge-tree", "--write-tree", first, second);
      const tree = (await git("rev-parse", `${cur}^{tree}`)).stdout.trim();
      if (clean.code === 0 && tree !== "" && clean.stdout.trim().split("\n")[0] === tree) {
        cur = first;
        continue;
      }
    }
    break;
  }
  const commits = (await git("log", "--first-parent", "--format=%h %s", "-n", "20", cur, "--not", G)).stdout.trim().split("\n").filter(Boolean);
  return { ok: false, at: cur, commits };
}

/**
 * The local merges the app's changes of the checkout's workspace record: every closed change with a merge commit and the
 * `[local-merge]` record of that commit among its comments. The app not reached throws: nothing is verified, nothing pushed.
 */
export async function mergedRanges(cwd: string, env: Record<string, string | undefined>, f?: (url: string, init?: RequestInit) => Promise<Response>): Promise<MergedRange[]> {
  const api = client(env, f ?? fetch);
  const workspaceId = (await readRecords(env, { fresh: false, cwd, ...(f ? { fetch: f } : {}) })).workspaceId;
  const changes = (await listChanges(api, workspaceId)).filter((c) => c.mergeCommit !== null);
  const out: MergedRange[] = [];
  for (const c of changes) {
    const d = (await api("GET", `/${c.number}?workspaceId=${encodeURIComponent(workspaceId)}&change=1`)) as Detail;
    for (const x of d.comments) {
      const m = LOCAL_MERGE.exec(x.body);
      if (m && m[1] === c.mergeCommit) out.push({ number: c.number, tip: m[1]!, base: m[2]! });
    }
  }
  return out;
}

/** The app's changes of one workspace (`GET /api/backlog`'s `changes`): what `mergedRanges`, `--report` and the sync PR's list all read. */
export async function listChanges(api: ReturnType<typeof client>, workspaceId: string): Promise<ListedChange[]> {
  return ((await api("GET", "")) as { changes: ListedChange[] }).changes.filter((c) => c.workspaceId === workspaceId);
}

/** A local change as the app's list has it (`GET /api/backlog`'s `changes`). */
export interface ListedChange { workspaceId: string; number: number; title: string; state: "OPEN" | "CLOSED"; head: string; base: string; mergeCommit: string | null; pr: number | null; reportedAt: string | null }

/** The `## 判断待ち` for a merge of GitHub's main that conflicted (issue-workflow's form). */
export function conflictAsk(files: string[], local: string, remote: string): string {
  return [
    "## 判断待ち",
    `**問い**: GitHub の main（${remote.slice(0, 7)}）をローカルの main（${local.slice(0, 7)}）にマージすると競合した。どちらの変更を残すか`,
    `**競合したファイル**: ${files.map((f) => `\`${f}\``).join("、") || "（git が名を出さなかった）"}`,
    "**選択肢**:",
    "- A: 両方を残す形に手で解く（別の worktree で GitHub の main をマージして解消し、その枝を PR にしてマージ判定に通す。手で解いたマージコミットは判定を通っていないので、`bun scripts/forge-resync.ts` は main へ直接は送らない） — 影響: どちらの変更も残る",
    "- B: GitHub の main の側を残す（ローカルの変更を GitHub の main の上で作り直す） — 影響: ローカルでマージした変更をやり直す",
    "- C: ローカルの main の側を残す（GitHub の main の変更を打ち消すコミットを GitHub に入れてからやり直す） — 影響: GitHub だけにあった変更が戻る",
    "**推奨**: A — force push も rebase もせずに両方の履歴が残る",
    "**止めた場所**: scripts/forge-resync.ts（何も push していない。ローカルの main も GitHub の main も変えていない）",
  ].join("\n");
}

export async function main(args: string[], cwd: string, deps: ResyncDeps = {}): Promise<number> {
  const run = deps.run ?? spawn;
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;
  const now = deps.now ?? Date.now;
  const backlog = deps.backlog ?? ((argv: string[]) => runBacklog(argv, process.env, { out: log, err }, { cwd }));
  if (args[0] === "--report") {
    if (args.length !== 1) return err(USAGE), 2;
    return report(cwd, deps);
  }
  const i = args.indexOf("--pbi");
  const pbi = i >= 0 ? args[i + 1] : undefined;
  const ms = args.indexOf("--merge-sync");
  const sync = ms >= 0 ? args[ms + 1] : undefined;
  const allowLarge = args.includes("--allow-large");
  // the person's two ways out of a local main with commits no local merge recorded; each names the tip it is about
  const ad = args.indexOf("--adopt-landing");
  const dr = args.indexOf("--drop-landing");
  const adopt = ad >= 0 ? args[ad + 1] : undefined;
  const drop = dr >= 0 ? args[dr + 1] : undefined;
  const used = (i >= 0 ? 2 : 0) + (ms >= 0 ? 2 : 0) + (allowLarge ? 1 : 0) + (ad >= 0 ? 2 : 0) + (dr >= 0 ? 2 : 0);
  const sha40 = (x: string | undefined) => /^[0-9a-f]{40}$/.test(x ?? "");
  if ((i >= 0 && !/^\d+$/.test(pbi ?? "")) || (ms >= 0 && !/^\d+$/.test(sync ?? "")) || (allowLarge && ms < 0) || (ad >= 0 && !sha40(adopt)) || (dr >= 0 && !sha40(drop)) || (ad >= 0 && (dr >= 0 || ms >= 0)) || (dr >= 0 && args.length !== 2) || args.length !== used) {
    err(USAGE);
    return 2;
  }
  if (adopt || drop) {
    const tty = deps.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!tty || (deps.env ?? process.env).SWITCHBOARD_TASK_ID) {
      err(`${adopt ? "--adopt-landing" : "--drop-landing"} は利用者が端末で実行する（Task の中・端末の無い実行では動かない）。何も変えていない`);
      return 2;
    }
  }
  const git = async (...a: string[]) => {
    const r = await run(["git", ...a], root);
    if (r.code !== 0) throw new Error(`git ${a.slice(0, 2).join(" ")} failed: ${r.stderr.trim().split("\n")[0]}`);
    return r.stdout.trim();
  };
  let root = cwd;
  try {
    root = await git("rev-parse", "--show-toplevel");
  } catch (e) {
    err(`リポジトリの中で実行してください（${(e as Error).message}）`);
    return 2;
  }
  const fetched = await run(["git", "fetch", "-q", "origin", "main"], root);
  if (fetched.code !== 0) {
    const line = fetched.stderr.trim().split("\n")[0];
    if (unreachable(fetched.stderr, now())) {
      err(`まだ GitHub に届かない（${line}）。何も変えていない`);
      return 4;
    }
    err(`git fetch origin main が失敗した（${line}）。何も変えていない`);
    return 2;
  }
  const done = (result: string, local: string, remote: string) => (log(JSON.stringify({ result, local, remote })), 0);
  const ancestor = async (a: string, b: string) => (await run(["git", "merge-base", "--is-ancestor", a, b], root)).code === 0;
  let G: string;
  // the local main: the branch, or its landing ref where local merges wait (landing.ts)
  const landed = landedTip(root, "main");
  if (!landed) {
    err("ローカルの main が無い");
    return 2;
  }
  try {
    G = await git("rev-parse", "refs/remotes/origin/main");
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const L = landed.sha;
  const c: Ctx = { run, git, root, log, err, deps };
  if ((adopt ?? drop) && (adopt ?? drop) !== L) {
    err(`ローカルの main（${landed.ref}）の先端は ${L} で、指定の ${adopt ?? drop} ではない（その後に動いた）。何も変えていない。今の先端を確かめてからやり直す`);
    return 2;
  }
  if (drop) {
    if (landed.ref !== landingRef("main")) {
      err(`ローカルの main は枝 ${landed.ref} にある（着地の ref ではない）。このスクリプトは枝を消さず、戻しもしない。何も変えていない`);
      return 2;
    }
    const commits = (await run(["git", "log", "--first-parent", "--format=%h %s", "-n", "50", L, "--not", G], root)).stdout.trim().split("\n").filter(Boolean);
    const gone = await run(["git", "update-ref", "-d", landed.ref, L], root);
    if (gone.code !== 0) {
      err(`着地の ref ${landed.ref} を消せない（${gone.stderr.trim().split("\n")[0]}）。何も変えていない`);
      return 1;
    }
    err(`着地の ref ${landed.ref}（${L}）を捨てた。GitHub の main と枝 main は変えていない。捨てたコミット（git update-ref ${landed.ref} ${L} で戻せる。アプリの変更の記録は「マージ済み」のままなので、入れ直すものは変更を作り直す）:\n${commits.map((x) => `  ${x}`).join("\n")}`);
    log(JSON.stringify({ result: "dropped", ref: landed.ref, was: L, remote: G, commits }));
    return 0;
  }

  if (sync) return mergeSync(Number(sync), allowLarge, landed, c);
  if (L === G) return done("nothing", L, G);
  if (await ancestor(L, G)) {
    try {
      const where = await moveLocal(root, G, landed, true);
      if (where === "kept") {
        log(`main を checkout している作業ツリーは動かしていない（GitHub の main ${G.slice(0, 7)} へは ops-kit pull-main で進める）`);
        return done("nothing", L, G);
      }
    } catch (e) {
      err(`ローカルの main を GitHub の main へ進められない: ${(e as Error).message.split("\n")[0]}`);
      return 1;
    }
    return done("nothing", G, G);
  }

  // what is about to go to GitHub's main: only commits a local merge that passed the gate recorded, and this script's
  // own clean merges of GitHub's main. Anything else stops here, before a merge is made or a commit is pushed
  let merged: MergedRange[];
  try {
    merged = await (deps.merged ?? (() => mergedRanges(root, deps.env ?? process.env, deps.fetch)))();
  } catch (e) {
    err(`ローカルでマージした変更の記録をアプリから読めない（${(e as Error).message.split("\n")[0]}）。ローカルの main の中身を確かめられないので、何も push していない`);
    return 2;
  }
  const verified = await verifyLocal(run, root, L, G, merged);
  if (!verified.ok && adopt) {
    // the person named this tip in a terminal: its unrecorded commits go on as they are, said in the output
    err(`利用者の指定（--adopt-landing ${L}）で、ローカルのマージの記録が無いコミットを認めて進める（${landed.ref}、${verified.at.slice(0, 7)} から）:\n${verified.commits.map((x) => `  ${x}`).join("\n")}`);
  } else if (!verified.ok) {
    const ways = [
      `- 認めて送る: bun scripts/forge-resync.ts --adopt-landing ${L}（記録の無いコミットをこの先端のまま同期の枝へ push し、同期の PR にする。GitHub の main へは直接 push しない）`,
      ...(landed.ref === landingRef("main") ? [`- 着地を捨てる: bun scripts/forge-resync.ts --drop-landing ${L}（着地の ref を消す。枝 main と GitHub の main は変わらない）`] : []),
      "- 判定を通す: そのコミットを枝に置いて PR にする",
    ];
    err(`ローカルの main（${landed.ref}、${L.slice(0, 7)}）に、マージ判定を通ったローカルのマージの記録が無いコミットがある（${verified.at.slice(0, 7)} から）。何も push していない。ローカルの main も GitHub の main も変えていない。どう入れるかは利用者に確かめる:\n${verified.commits.map((x) => `  ${x}`).join("\n")}\n利用者ができること（--adopt-landing と --drop-landing は利用者が端末で実行する。このスクリプトも Task も自分では実行しない）:\n${ways.join("\n")}`);
    log(JSON.stringify({ result: "unverified", ref: landed.ref, local: L, remote: G, at: verified.at, commits: verified.commits }));
    return 1;
  }

  let tip = L;
  if (!(await ancestor(G, L))) {
    // both moved: GitHub's main merged into the local main, apart from every worktree of the person's
    const cache = deps.cache ?? join(homedir(), ".cache");
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(join(cache, `switchboard.forge-resync-${pbi ?? "main"}.`));
    let conflicted: string[] | null = null;
    try {
      await git("worktree", "add", "-q", "--detach", dir, L);
      const merged = await run(["git", "-C", dir, ...IDENTITY, "merge", "-q", "--no-ff", "-m", `Merge GitHub's main (${G.slice(0, 7)}) into the local main`, G]);
      if (merged.code !== 0) {
        conflicted = (await run(["git", "-C", dir, "diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
        await run(["git", "-C", dir, "merge", "--abort"]);
        // no unmerged path: the merge failed for another reason (a hook, the disk) — not a question for the user
        if (!conflicted.length) throw new Error(`git merge が失敗した: ${(merged.stderr.trim() || merged.stdout.trim()).split("\n")[0]}`);
      } else tip = (await run(["git", "-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    } catch (e) {
      err(`GitHub の main をマージできない（${(e as Error).message}）。何も変えていない`);
      return 2;
    } finally {
      await run(["git", "worktree", "remove", "--force", dir], root);
      rmSync(dir, { recursive: true, force: true });
    }
    if (conflicted) {
      err(`GitHub の main（${G.slice(0, 7)}）とローカルの main（${L.slice(0, 7)}）のマージが競合した: ${conflicted.join(", ")}。何も push していない`);
      if (pbi) {
        const file = `${dir}.ask.md`;
        writeFileSync(file, conflictAsk(conflicted, L, G));
        try {
          if ((await backlog(["comment", pbi, "--body-file", file])) !== 0 || (await backlog(["edit", pbi, "--add-label", "needs-decision"])) !== 0) err(`#${pbi} に判断待ちを書けなかった。上の競合を利用者に伝える`);
        } finally {
          rmSync(file, { force: true });
        }
      }
      log(JSON.stringify({ result: "conflict", local: L, remote: G, files: conflicted }));
      return 1;
    }
    try {
      await moveLocal(root, tip, landed, false);
    } catch (e) {
      err(`ローカルの main をマージコミットへ進められない: ${(e as Error).message.split("\n")[0]}。何も push していない`);
      return 1;
    }
  }

  // GitHub's main takes no direct push from here, protected or not: always the sync branch and a PR, which the gate judges
  const repo = deps.repo ?? githubOrigin(root);
  if (!repo) {
    err(`origin が GitHub のリポジトリでない。GitHub でない forge へは送らない。何も push していない。ローカルの main は ${tip.slice(0, 7)}`);
    return 2;
  }
  return syncPr(tip, G, repo, c);
}

/**
 * Moves the local main to `to` without touching a work tree: the landing ref when the local merges already wait there or
 * main is checked out somewhere (landing.ts; that work tree is `ops-kit pull-main`'s to update), else the branch's ref,
 * only from where it was. `behind`: `to` is GitHub's main that the local main is merely behind — a checked-out main is
 * then left as it is ("kept"), since nothing local needs a place.
 */
export async function moveLocal(root: string, to: string, from: NonNullable<ReturnType<typeof landedTip>>, behind: boolean): Promise<"landing" | "branch" | "kept"> {
  const onLanding = from.ref === landingRef("main");
  const tree = await worktreeOf(root, "main");
  if (behind && !onLanding && tree) return "kept";
  if (onLanding || tree) {
    await landOn(root, "main", to, from);
    return "landing";
  }
  const p = Bun.spawnSync(["git", "-C", root, "update-ref", "refs/heads/main", to, from.sha], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim().split("\n")[0] || "git update-ref が失敗した");
  return "branch";
}

interface Ctx {
  run: Run;
  git: (...a: string[]) => Promise<string>;
  root: string;
  log: (s: string) => void;
  err: (s: string) => void;
  deps: ResyncDeps;
}

/** owner/name of origin when origin is on GitHub's host (gh's: GH_HOST or github.com); undefined for another forge or a path. */
export function githubOrigin(root: string): string | undefined {
  const url = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { stderr: "pipe" }).stdout.toString().trim();
  const host = /^[a-z][a-z\d+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(url)?.[1] ?? /^[^/@]+@([^:]+):/.exec(url)?.[1];
  return host?.toLowerCase() === githubHost().toLowerCase() ? originRepo(root) : undefined;
}

const gh = async (c: Ctx, ...a: string[]) => {
  const r = await c.run(["gh", ...a], c.root);
  if (r.code !== 0) throw new Error(`gh ${a.slice(0, 2).join(" ")} failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout.trim();
};

/**
 * The lines of the sync PR's body naming the local changes whose merge commit is in `G..tip` (`L<n>`, title, branch, merge
 * commit's 7 characters). The app not reached does not fail the sync PR — the commit list below still says what goes in and
 * `--report` later leaves each change's marks on GitHub — so one line says the list could not be read.
 */
async function changeList(tip: string, G: string, c: Ctx): Promise<string[]> {
  try {
    const env = c.deps.env ?? process.env;
    const all = await (c.deps.changes ?? (async () => listChanges(client(env, c.deps.fetch ?? fetch), (await readRecords(env, { fresh: false, cwd: c.root, ...(c.deps.fetch ? { fetch: c.deps.fetch } : {}) })).workspaceId)))();
    const inRange = new Set((await c.git("rev-list", `${G}..${tip}`)).split("\n").filter(Boolean));
    const lines = all.filter((x) => x.mergeCommit !== null && inRange.has(x.mergeCommit)).sort((a, b) => a.number - b.number).map((x) => `- L${x.number} ${x.title}（枝 ${x.head}、マージコミット ${x.mergeCommit!.slice(0, 7)}）`);
    return ["ローカルでマージした変更（GitHub が使えなかった間）:", ...(lines.length ? lines : ["- （アプリの記録に、この範囲にマージした変更は無い）"]), ""];
  } catch (e) {
    return [`ローカルでマージした変更の一覧はアプリから読めなかった（${(e as Error).message.split("\n")[0]}）。下のコミットの一覧が入るものの全部で、変更ごとの記録は \`bun scripts/forge-resync.ts --report\` が GitHub に残す。`, ""];
  }
}

/** The same commit pushed to a sync branch (no force) and a PR to main opened in `repo`. Exit 5. */
async function syncPr(tip: string, G: string, repo: string, c: Ctx): Promise<number> {
  const branch = `sb/sync-main-${tip.slice(0, 7)}`;
  const pushed = await c.run(["git", "push", "-q", "origin", `${tip}:refs/heads/${branch}`], c.root);
  if (pushed.code !== 0) {
    c.err(`同期の枝 ${branch} の push が失敗した（${pushed.stderr.trim().split("\n")[0]}）。ローカルの main は ${tip.slice(0, 7)}`);
    return 1;
  }
  const commits = (await c.git("log", "--first-parent", "--format=- %h %s", `${G}..${tip}`)).split("\n").filter(Boolean);
  const body = [
    "GitHub の main へは直接 push しない（`scripts/forge-resync.ts`）。ローカルの main を同期の枝から入れる。",
    "Merge commit で入れる（Squash / Rebase はローカルの main・打ったタグ・昇格した版の sha を変える）: `bun scripts/forge-resync.ts --merge-sync <この PR>`。",
    "",
    ...(await changeList(tip, G, c)),
    "ローカルの main にだけあるコミット（first-parent）:",
    ...commits,
  ].join("\n");
  const file = join(c.deps.cache ?? join(homedir(), ".cache"), `switchboard.forge-resync-sync-${tip.slice(0, 7)}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  let out: string;
  try {
    const r = await c.run(["gh", "pr", "create", "-R", repo, "--base", "main", "--head", branch, "--title", `main の同期: ローカルでマージしたコミット ${commits.length} 件`, "--body-file", file], c.root);
    // a PR already open for the branch (a second run): gh names it on stderr
    out = r.code === 0 ? r.stdout : /already exists/i.test(r.stderr) ? r.stderr : "";
    if (!out) throw new Error(r.stderr.trim().split("\n")[0]);
  } catch (e) {
    c.err(`同期の枝 ${branch} は push した。PR を作れなかった（${(e as Error).message}）。ローカルの main は ${tip.slice(0, 7)}`);
    return 1;
  } finally {
    rmSync(file, { force: true });
  }
  const pr = Number(/\/pull\/(\d+)/.exec(out)?.[1]);
  c.log(JSON.stringify({ result: "sync-pr", pr: pr || null, branch, local: tip, remote: G }));
  return 5;
}

/** `--merge-sync <PR>`: merge-gate's rules, a Merge commit, then the local main fast-forwarded to GitHub's. */
async function mergeSync(n: number, allowLarge: boolean, landed: NonNullable<ReturnType<typeof landedTip>>, c: Ctx): Promise<number> {
  const L = landed.sha;
  const repo = c.deps.repo ?? githubOrigin(c.root);
  if (!repo) {
    c.err("origin が GitHub のリポジトリでない。判定していない");
    return 2;
  }
  const env = c.deps.env ?? process.env;
  if (env.SWITCHBOARD_TASK_ID) {
    // in a Task the verdict and the merge are the app's (a gate job, `--merge-sync`: a Merge commit, only for the branch this script makes); nothing here judges with the Task's own environment
    const code = await requestGate([String(n), "--merge-sync", "--repo", repo, ...(allowLarge ? ["--allow-large"] : [])], env, c.root, c.log, c.err, { fetch: c.deps.fetch });
    if (code !== 0) return code;
    try {
      await c.git("fetch", "-q", "origin", "main");
    } catch (e) {
      c.err(`同期の PR #${n} をマージできなかった: ${(e as Error).message}`);
      return 1;
    }
  } else {
    let j: Judgement & { head: string };
    try {
      j = await (c.deps.judgePr ?? (async (pr: number, allow: boolean) => {
        const facts = await readPr(pr, (a) => gh(c, ...a), repo, { root: c.root, url: `https://github.com/${repo}.git` });
        return { ...judge(facts, { allowLarge: allow }), head: facts.head! };
      }))(n, allowLarge);
    } catch (e) {
      c.err(`判定できなかった: ${(e as Error).message}`);
      return 2;
    }
    c.log(JSON.stringify(j, null, 2));
    if (j.verdict !== "merge") return 1;
    try {
      // a merge commit (the landing ref is the sync PR's second parent), which merge-gate's --merge (a rebase) is not. From a person's
      // terminal nothing stands in front of `gh`; a Task's merge goes through the app's gate job above
      const merged = await c.run(["gh", "pr", "merge", String(n), "-R", repo, "--merge", "--delete-branch", "--match-head-commit", j.head], c.root);
      if (merged.code !== 0) throw new Error(`gh pr merge failed: ${merged.stderr.trim().split("\n")[0]}`);
      await c.git("fetch", "-q", "origin", "main");
    } catch (e) {
      c.err(`同期の PR #${n} をマージできなかった: ${(e as Error).message}`);
      return 1;
    }
  }
  const G = await c.git("rev-parse", "refs/remotes/origin/main");
  try {
    // only a fast-forward: a local main that moved past the sync PR keeps its commits (run forge-resync again)
    if (L !== G && (await c.run(["git", "merge-base", "--is-ancestor", L, G], c.root)).code !== 0) throw new Error(`ローカルの main（${L.slice(0, 7)}）が GitHub の main の祖先でない（同期の後にローカルで進んだ）。forge-resync をもう一度`);
    if (L !== G && (await moveLocal(c.root, G, landed, true)) === "kept") c.log(`main を checkout している作業ツリーは動かしていない（GitHub の main ${G.slice(0, 7)} へは ops-kit pull-main で進める）`);
  } catch (e) {
    c.err(`同期の PR #${n} は入った。ローカルの main を GitHub の main（${G.slice(0, 7)}）へ進められない: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  const remote = (await c.git("ls-remote", "origin", "refs/heads/main")).split(/\s/)[0] ?? "";
  // in step: GitHub's main has everything the local main had (a checked-out main is behind it until pull-main)
  const local = landedTip(c.root, "main")?.sha ?? "";
  if (remote !== G || (local !== remote && (await c.run(["git", "merge-base", "--is-ancestor", local, remote], c.root)).code !== 0)) {
    c.err(`同期の PR #${n} の後も揃っていない（ローカル ${local.slice(0, 7)}、GitHub ${remote.slice(0, 7)}）`);
    return 1;
  }
  c.log(JSON.stringify({ result: "synced", pr: n, local, remote }));
  // GitHub has the commits now: what was done locally is left on it right away. The merge is done whatever this returns —
  // a failure here is the report's own code (4 = GitHub not reachable yet, 1 = one change could not be left, 2 = the app
  // not read), with the line that says to run only `--report` again, never `--merge-sync`
  const reported = await report(c.root, c.deps);
  if (reported !== 0) c.err(`同期の PR #${n} は入った（上の synced）。変更ごとの記録を残し終えていない（exit ${reported}）。--merge-sync はやり直さず、\`bun scripts/forge-resync.ts --report\` だけをもう一度`);
  return reported;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.cwd()));
