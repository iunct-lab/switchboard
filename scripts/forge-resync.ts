/**
 * Sends the local main to GitHub after it was away (#2705, PBI #2464): `bun scripts/forge-resync.ts [--pbi <n>]`, in a
 * worktree of the repository. GitHub's main (G, after `git fetch origin main`) and the local main (L):
 * - L = G, or L behind G: nothing to send (L is fast-forwarded to G)
 * - G behind L: `git push origin <L>:refs/heads/main` — a fast-forward on GitHub
 * - both moved: G merged into L with a merge commit in a throwaway worktree under ~/.cache, L moved to it, then pushed
 * - that merge conflicts: nothing pushed, L unchanged, a `## 判断待ち` on the PBI (`--pbi`) with label needs-decision
 * Never `--force` / `--force-with-lease` / a `+` refspec (they drop the commits only GitHub's main has), never a rebase
 * (the tags and the promoted version's sha would change). L is moved with local-merge's `advanceBranch` (the worktree
 * that has main, only when clean; else the ref, only from where it was).
 * - the push refused by a protected branch (#2707): the same commit pushed to `sb/sync-main-<7>` and a PR to main opened
 *   (exit 5). `--merge-sync <PR>` merges it only when merge-gate's `readPr` + `judge` say merge, with a Merge commit
 *   (`gh pr merge --merge`: Squash / Rebase would change the sha), then fast-forwards the local main to GitHub's.
 * Exit: 0 = in step (JSON `{ result, local, remote }`) / 1 = conflict, the push was refused, or the sync PR not merged /
 * 2 = not run (usage, not a repository, another failure) / 4 = GitHub not reachable yet (outage, limit, auth; nothing
 * changed) / 5 = a sync PR opened (JSON `{ result: "sync-pr", pr, local, remote }`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runBacklog } from "../ops-kit/src/backlog-client.ts";
import { githubHost, responseOf, retryAtFromResponse } from "../ops-kit/src/gh.ts";
import { advanceBranch } from "./local-merge.ts";
import { judge, readPr, type Judgement } from "./merge-gate.ts";
import { originRepo } from "./repo.ts";

const USAGE = "usage: bun scripts/forge-resync.ts [--pbi <n>]\n       bun scripts/forge-resync.ts --merge-sync <PR> [--allow-large]";
/** GitHub refusing a push to a protected branch or a ruleset (the push's stderr). */
export const PROTECTED_REJECT = /GH006|GH013|protected branch|Repository rule violations/i;
/** The merge commit's committer (local-ci's and local-merge's): the clone's settings do not decide it. */
const IDENTITY = ["-c", "user.name=forge-resync", "-c", "user.email=forge-resync@localhost", "-c", "commit.gpgSign=false"];
/** git's own words for a remote it could not reach (no HTTP status to classify). */
const UNREACHABLE = /could not resolve host|unable to access|could not read from remote repository|connection (refused|reset|timed out)|operation timed out|failed to connect|the requested url returned error: (5\d\d|429|401|403)|authentication failed|early eof|remote end hung up/i;

export type Run = (cmd: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface ResyncDeps {
  run?: Run;
  /** `ops-kit backlog <argv…>` (the PBI's comment and label); the app's API by default. */
  backlog?: (argv: string[]) => Promise<number>;
  /** Where the throwaway worktree goes (~/.cache; tests give their own). */
  cache?: string;
  /** owner/name of GitHub's repository: the checkout's origin (not GH_REPO: the PR must be origin's, which is fetched and pushed). */
  repo?: string;
  /** merge-gate's judgement of a PR (`readPr` + `judge`) and the head it judged. */
  judgePr?: (n: number, allowLarge: boolean) => Promise<Judgement & { head: string }>;
  now?: () => number;
  log?: (s: string) => void;
  err?: (s: string) => void;
}

const spawn: Run = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

/** A failed fetch that says GitHub is not reachable now (outage, limit, auth): gh's classification, or git's own words. */
export function unreachable(stderr: string, now: number): boolean {
  return retryAtFromResponse(responseOf("", stderr), now) !== null || UNREACHABLE.test(stderr);
}

/** The `## 判断待ち` for a merge of GitHub's main that conflicted (issue-workflow's form). */
export function conflictAsk(files: string[], local: string, remote: string): string {
  return [
    "## 判断待ち",
    `**問い**: GitHub の main（${remote.slice(0, 7)}）をローカルの main（${local.slice(0, 7)}）にマージすると競合した。どちらの変更を残すか`,
    `**競合したファイル**: ${files.map((f) => `\`${f}\``).join("、") || "（git が名を出さなかった）"}`,
    "**選択肢**:",
    "- A: 両方を残す形に手で解く（ローカルの main で `git merge origin/main` → 解消 → `bun scripts/forge-resync.ts` をやり直す） — 影響: どちらの変更も残る",
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
  const i = args.indexOf("--pbi");
  const pbi = i >= 0 ? args[i + 1] : undefined;
  const ms = args.indexOf("--merge-sync");
  const sync = ms >= 0 ? args[ms + 1] : undefined;
  const allowLarge = args.includes("--allow-large");
  const used = (i >= 0 ? 2 : 0) + (ms >= 0 ? 2 : 0) + (allowLarge ? 1 : 0);
  if ((i >= 0 && !/^\d+$/.test(pbi ?? "")) || (ms >= 0 && !/^\d+$/.test(sync ?? "")) || (allowLarge && ms < 0) || args.length !== used) {
    err(USAGE);
    return 2;
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
  let L: string;
  let G: string;
  try {
    L = await git("rev-parse", "refs/heads/main");
    G = await git("rev-parse", "refs/remotes/origin/main");
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  if (sync) return mergeSync(Number(sync), allowLarge, L, { run, git, root, log, err, deps });
  if (L === G) return done("nothing", L, G);
  if (await ancestor(L, G)) {
    try {
      await advanceBranch(root, "main", G, L);
    } catch (e) {
      err(`ローカルの main を GitHub の main へ進められない: ${(e as Error).message.split("\n")[0]}`);
      return 1;
    }
    return done("nothing", G, G);
  }

  let tip = L;
  let result = "fast-forward";
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
      await advanceBranch(root, "main", tip, L);
    } catch (e) {
      err(`ローカルの main をマージコミットへ進められない: ${(e as Error).message.split("\n")[0]}。何も push していない`);
      return 1;
    }
    result = "merged";
  }

  // a fast-forward on GitHub: never --force, never a + refspec
  const pushed = await run(["git", "push", "-q", "origin", `${tip}:refs/heads/main`], root);
  if (pushed.code !== 0 && PROTECTED_REJECT.test(pushed.stderr)) return syncPr(tip, G, { run, git, root, log, err, deps });
  if (pushed.code !== 0) {
    err(`GitHub が push を断った（${pushed.stderr.trim().split("\n")[0]}）。ローカルの main は ${tip.slice(0, 7)}`);
    return 1;
  }
  const remote = (await git("ls-remote", "origin", "refs/heads/main")).split(/\s/)[0] ?? "";
  const local = await git("rev-parse", "refs/heads/main");
  if (remote !== local) {
    err(`送ったあとも揃っていない（ローカル ${local.slice(0, 7)}、GitHub ${remote.slice(0, 7)}）`);
    return 1;
  }
  return done(result, local, remote);
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

/** The protected main refused the push (#2707): the same commit to a sync branch (no force) and a PR to main. Exit 5. */
async function syncPr(tip: string, G: string, c: Ctx): Promise<number> {
  const branch = `sb/sync-main-${tip.slice(0, 7)}`;
  const pushed = await c.run(["git", "push", "-q", "origin", `${tip}:refs/heads/${branch}`], c.root);
  if (pushed.code !== 0) {
    c.err(`GitHub が main への push を断り（保護枝）、同期の枝 ${branch} の push も失敗した（${pushed.stderr.trim().split("\n")[0]}）。ローカルの main は ${tip.slice(0, 7)}`);
    return 1;
  }
  const commits = (await c.git("log", "--first-parent", "--format=- %h %s", `${G}..${tip}`)).split("\n").filter(Boolean);
  const body = [
    "GitHub の main が直接の push を断ったので（保護枝）、ローカルの main を同期の枝から入れる（`scripts/forge-resync.ts`）。",
    "Merge commit で入れる（Squash / Rebase はローカルの main・打ったタグ・昇格した版の sha を変える）: `bun scripts/forge-resync.ts --merge-sync <この PR>`。",
    "",
    "ローカルの main にだけあるコミット（first-parent）:",
    ...commits,
  ].join("\n");
  const repo = c.deps.repo ?? githubOrigin(c.root);
  if (!repo) {
    c.err(`origin が GitHub のリポジトリでない。同期の枝 ${branch} は push した。ローカルの main は ${tip.slice(0, 7)}`);
    return 1;
  }
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

/** `--merge-sync <PR>` (#2707): merge-gate's rules, a Merge commit, then the local main fast-forwarded to GitHub's. */
async function mergeSync(n: number, allowLarge: boolean, L: string, c: Ctx): Promise<number> {
  const repo = c.deps.repo ?? githubOrigin(c.root);
  if (!repo) {
    c.err("origin が GitHub のリポジトリでない。判定していない");
    return 2;
  }
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
    await gh(c, "pr", "merge", String(n), "-R", repo, "--merge", "--delete-branch", "--match-head-commit", j.head);
    await c.git("fetch", "-q", "origin", "main");
  } catch (e) {
    c.err(`同期の PR #${n} をマージできなかった: ${(e as Error).message}`);
    return 1;
  }
  const G = await c.git("rev-parse", "refs/remotes/origin/main");
  try {
    // only a fast-forward: a local main that moved past the sync PR keeps its commits (run forge-resync again)
    if (L !== G && (await c.run(["git", "merge-base", "--is-ancestor", L, G], c.root)).code !== 0) throw new Error(`ローカルの main（${L.slice(0, 7)}）が GitHub の main の祖先でない（同期の後にローカルで進んだ）。forge-resync をもう一度`);
    if (L !== G) await advanceBranch(c.root, "main", G, L);
  } catch (e) {
    c.err(`同期の PR #${n} は入った。ローカルの main を GitHub の main（${G.slice(0, 7)}）へ進められない: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  const local = await c.git("rev-parse", "refs/heads/main");
  const remote = (await c.git("ls-remote", "origin", "refs/heads/main")).split(/\s/)[0] ?? "";
  if (local !== remote) {
    c.err(`同期の PR #${n} の後も揃っていない（ローカル ${local.slice(0, 7)}、GitHub ${remote.slice(0, 7)}）`);
    return 1;
  }
  c.log(JSON.stringify({ result: "synced", pr: n, local, remote }));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.cwd()));
