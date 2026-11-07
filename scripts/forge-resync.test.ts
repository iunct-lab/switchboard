// test-reads: scripts/forge-resync.ts scripts/local-merge.ts
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubOrigin, main, unreachable, type Run } from "./forge-resync.ts";

// The local main sent back to GitHub (#2705) against a bare repository standing in for GitHub: what both mains are after
// it, and that no push ever forces.

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

const ENV = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false"];

/** origin.git (GitHub), `local` (the clone with the local main) and `other` (a clone that moves GitHub's main), both at `a`. */
function setup() {
  home = mkdtempSync(join(tmpdir(), "sb-forge-resync-"));
  const at = (dir: string) => (...a: string[]) => execFileSync("git", ["-C", dir, ...ID, ...a], { encoding: "utf8", env: ENV }).trim();
  const origin = join(home, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(home, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "a.txt"), "a\n");
  at(seed)("add", "-A");
  at(seed)("commit", "-q", "-m", "a");
  at(seed)("push", "-q", origin, "main");
  const clone = (name: string) => (execFileSync("git", ["clone", "-q", origin, join(home!, name)]), join(home!, name));
  const local = clone("local");
  const other = clone("other");
  const commit = (dir: string, file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    at(dir)("add", "-A");
    at(dir)("commit", "-q", "-m", `${file}: ${text.trim()}`);
  };
  const pushes: string[][] = [];
  const recording: Run = async (cmd, cwd) => {
    if (cmd[0] === "git" && cmd.includes("push")) pushes.push(cmd);
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: ENV });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  };
  const backlog: string[][] = [];
  const asks: string[] = [];
  const run = async (args: string[] = [], o: { run?: Run } = {}) => {
    const out: string[] = [];
    const code = await main(args, local, {
      run: o.run ?? recording,
      backlog: async (argv) => (backlog.push(argv), argv[0] === "comment" && asks.push(readFileSync(argv[3]!, "utf8")), 0),
      cache: home!,
      log: (s) => out.push(s),
      err: (s) => out.push(s),
    });
    return { code, out: out.join("\n"), json: (() => { try { return JSON.parse(out.find((l) => l.startsWith("{")) ?? "null"); } catch { return null; } })() };
  };
  const remoteMain = () => at(origin)("rev-parse", "main");
  const localMain = () => at(local)("rev-parse", "main");
  return { origin, local, other, git: at, commit, pushes, backlog, asks, run, remoteMain, localMain };
}

/** No push may drop a commit only GitHub has. */
function noForce(pushes: string[][]) {
  for (const p of pushes) {
    expect(p.some((a) => a === "-f" || a === "--force" || a.startsWith("--force") || a.startsWith("+"))).toBe(false);
  }
}

test("(a) only the local main moved: a fast-forward push, both mains the same", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  const L = s.localMain();
  const r = await s.run();
  expect(r.code).toBe(0);
  expect(r.json).toEqual({ result: "fast-forward", local: L, remote: L });
  expect(s.remoteMain()).toBe(L);
  expect(s.pushes).toHaveLength(1);
  noForce(s.pushes);
});

test("(b) both moved, other files: GitHub's main merged into the local one (L first parent, G second), pushed, the same", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  s.commit(s.other, "c.txt", "c");
  s.git(s.other)("push", "-q", "origin", "main");
  const L = s.localMain();
  const G = s.remoteMain();
  const r = await s.run(["--pbi", "9"]);
  expect(r.code).toBe(0);
  expect(r.json.result).toBe("merged");
  const M = s.localMain();
  expect(s.git(s.local)("rev-parse", `${M}^1`, `${M}^2`).split("\n")).toEqual([L, G]);
  expect(s.remoteMain()).toBe(M);
  expect(r.json).toEqual({ result: "merged", local: M, remote: M });
  // the throwaway worktree is gone
  expect(s.git(s.local)("worktree", "list").split("\n")).toHaveLength(1);
  expect(s.backlog).toEqual([]);
  noForce(s.pushes);
});

test("(c) both changed the same line: a conflict — origin's and the local main unchanged, a 判断待ち with needs-decision on the PBI", async () => {
  const s = setup();
  s.commit(s.local, "a.txt", "local\n");
  s.commit(s.other, "a.txt", "github\n");
  s.git(s.other)("push", "-q", "origin", "main");
  const L = s.localMain();
  const G = s.remoteMain();
  const r = await s.run(["--pbi", "9"]);
  expect(r.code).toBe(1);
  expect(r.json).toEqual({ result: "conflict", local: L, remote: G, files: ["a.txt"] });
  expect(s.localMain()).toBe(L);
  expect(s.remoteMain()).toBe(G);
  expect(s.pushes).toEqual([]);
  expect(s.backlog.map((a) => a[0] === "comment" ? ["comment", a[1]] : a)).toEqual([["comment", "9"], ["edit", "9", "--add-label", "needs-decision"]]);
  expect(s.asks[0]).toStartWith("## 判断待ち\n**問い**:");
  expect(s.asks[0]).toContain("`a.txt`");
  expect(s.git(s.local)("worktree", "list").split("\n")).toHaveLength(1);
  expect(s.git(s.local)("status", "--porcelain")).toBe("");
});

test("a merge that fails without a conflicting file (a hook refuses it): exit 2 with git's reason, no 判断待ち, nothing changed", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  s.commit(s.other, "c.txt", "c");
  s.git(s.other)("push", "-q", "origin", "main");
  const hook = join(s.local, ".git", "hooks", "pre-merge-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const L = s.localMain();
  const G = s.remoteMain();
  const r = await s.run(["--pbi", "9"]);
  expect(r.code).toBe(2);
  expect(r.out).toContain("hook says no");
  expect(s.backlog).toEqual([]);
  expect(s.pushes).toEqual([]);
  expect(s.localMain()).toBe(L);
  expect(s.remoteMain()).toBe(G);
  expect(s.git(s.local)("worktree", "list").split("\n")).toHaveLength(1);
});

test("(d) the fetch fails (GitHub not reachable): exit 4, nothing changed", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  const L = s.localMain();
  const G = s.remoteMain();
  for (const stderr of ["fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502", "remote: API rate limit exceeded", "fatal: Authentication failed for 'https://github.com/o/r.git/'"]) {
    const failing: Run = async (cmd, cwd) => (cmd.includes("fetch") ? { code: 128, stdout: "", stderr } : (s.pushes.push(cmd), { code: 0, stdout: execFileSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8" }), stderr: "" }));
    const r = await s.run([], { run: failing });
    expect(r.code).toBe(4);
    expect(r.out).toContain("まだ GitHub に届かない");
  }
  expect(s.pushes.filter((p) => p.includes("push"))).toEqual([]);
  expect(s.localMain()).toBe(L);
  expect(s.remoteMain()).toBe(G);
});

test("the local main behind GitHub's: nothing sent, the local main fast-forwarded; in step: nothing at all", async () => {
  const s = setup();
  s.commit(s.other, "c.txt", "c");
  s.git(s.other)("push", "-q", "origin", "main");
  const G = s.remoteMain();
  // the local clone has main checked out and clean: its worktree is fast-forwarded
  expect(await s.run()).toMatchObject({ code: 0, json: { result: "nothing", local: G, remote: G } });
  expect(s.localMain()).toBe(G);
  expect(s.git(s.local)("status", "--porcelain")).toBe("");
  expect(await s.run()).toMatchObject({ code: 0, json: { result: "nothing", local: G, remote: G } });
  expect(s.pushes).toEqual([]);
});

test("a failure that is not GitHub being away is not counted as one", () => {
  expect(unreachable("fatal: 'origin' does not appear to be a git repository", 0)).toBe(false);
  expect(unreachable("fatal: couldn't find remote ref main", 0)).toBe(false);
  expect(unreachable("ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.", 0)).toBe(true);
});

/** origin.git refuses a push to main as GitHub's protected branch does (GH006), unless ALLOW=1 (the fake `gh pr merge`). */
function protect(s: ReturnType<typeof setup>) {
  const hook = join(s.origin, "hooks", "pre-receive");
  writeFileSync(hook, '#!/bin/sh\n[ "$ALLOW" = 1 ] && exit 0\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && { echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2; exit 1; }; done\nexit 0\n');
  chmodSync(hook, 0o755);
  const gh: string[][] = [];
  const run: Run = async (cmd, cwd) => {
    if (cmd[0] !== "gh") {
      if (cmd.includes("push")) s.pushes.push(cmd);
      const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: ENV });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    }
    gh.push(cmd.slice(1));
    if (cmd[1] === "pr" && cmd[2] === "create") return { code: 0, stdout: "https://github.com/o/r/pull/77\n", stderr: "" };
    if (cmd[1] === "pr" && cmd[2] === "merge") {
      // GitHub's Merge commit, made on the bare side through a clone the hook lets through
      const head = cmd[cmd.indexOf("--match-head-commit") + 1]!;
      const g = s.git(s.other);
      g("fetch", "-q", "origin");
      g("checkout", "-q", "-B", "main", "origin/main");
      g("merge", "-q", "--no-ff", "-m", "Merge pull request #77", head);
      execFileSync("git", ["-C", s.other, "push", "-q", "origin", "main"], { env: { ...ENV, ALLOW: "1" } });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${cmd.join(" ")}` };
  };
  return { gh, run };
}

const judgeAs = (verdict: "merge" | "stop", head: () => string) => async () => ({ verdict, impact: "small", reasons: verdict === "stop" ? ["CI: 未完了"] : [], ask: [], recheck: [], head: head() }) as never;

test("protected: main refuses the push — the same commit to sb/sync-main-<7> (no force), a PR to main, exit 5", async () => {
  const s = setup();
  const p = protect(s);
  s.commit(s.local, "b.txt", "b");
  const L = s.localMain();
  const G = s.remoteMain();
  const out: string[] = [];
  const code = await main([], s.local, { run: p.run, repo: "o/r", cache: home!, log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(5);
  const branch = `sb/sync-main-${L.slice(0, 7)}`;
  expect(JSON.parse(out.find((l) => l.startsWith("{"))!)).toEqual({ result: "sync-pr", pr: 77, branch, local: L, remote: G });
  expect(s.git(s.origin)("rev-parse", branch)).toBe(L);
  expect(s.remoteMain()).toBe(G);
  const create = p.gh.find((a) => a[1] === "create")!;
  expect(create.slice(create.indexOf("--base"), create.indexOf("--base") + 4)).toEqual(["--base", "main", "--head", branch]);
  expect(create[create.indexOf("--title") + 1]).toBe("main の同期: ローカルでマージしたコミット 1 件");
  expect(s.pushes.map((a) => a.at(-1))).toEqual([`${L}:refs/heads/main`, `${L}:refs/heads/${branch}`]);
  noForce(s.pushes);
});

test("protected: --merge-sync with a merge verdict — gh pr merge --merge at the judged head, the local main fast-forwarded to GitHub's", async () => {
  const s = setup();
  const p = protect(s);
  s.commit(s.local, "b.txt", "b");
  const L = s.localMain();
  expect(await main([], s.local, { run: p.run, repo: "o/r", cache: home!, log: () => {}, err: () => {} })).toBe(5);
  const out: string[] = [];
  const code = await main(["--merge-sync", "77"], s.local, { run: p.run, repo: "o/r", judgePr: judgeAs("merge", () => L), cache: home!, log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(0);
  const merge = p.gh.find((a) => a[1] === "merge")!;
  expect(merge).toEqual(["pr", "merge", "77", "-R", "o/r", "--merge", "--delete-branch", "--match-head-commit", L]);
  expect(merge.some((a) => a === "--rebase" || a === "--squash")).toBe(false);
  const M = s.remoteMain();
  expect(s.git(s.origin)("rev-parse", `${M}^2`)).toBe(L);
  expect(s.localMain()).toBe(M);
  expect(s.git(s.local)("status", "--porcelain")).toBe("");
  expect(out.at(-1)).toBe(JSON.stringify({ result: "synced", pr: 77, local: M, remote: M }));
  noForce(s.pushes);
});

test("protected: --merge-sync with a stop verdict — gh pr merge is not called, nothing moves", async () => {
  const s = setup();
  const p = protect(s);
  s.commit(s.local, "b.txt", "b");
  const L = s.localMain();
  const G = s.remoteMain();
  const out: string[] = [];
  const code = await main(["--merge-sync", "77"], s.local, { run: p.run, repo: "o/r", judgePr: judgeAs("stop", () => L), cache: home!, log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(1);
  expect(p.gh.filter((a) => a[1] === "merge")).toEqual([]);
  expect(s.localMain()).toBe(L);
  expect(s.remoteMain()).toBe(G);
});

test("the PR is origin's repository, not GH_REPO's: an origin that is not GitHub's is not judged", async () => {
  const s = setup();
  const saved = process.env.GH_REPO;
  process.env.GH_REPO = "other/repo";
  try {
    const out: string[] = [];
    const judged: number[] = [];
    const code = await main(["--merge-sync", "77"], s.local, { judgePr: async (n) => (judged.push(n), null as never), cache: home!, log: (x) => out.push(x), err: (x) => out.push(x) });
    expect(code).toBe(2);
    expect(judged).toEqual([]);
    expect(out.join("\n")).toContain("origin が GitHub のリポジトリでない");
  } finally {
    if (saved === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = saved;
  }
});

test("origin on another host (GitLab) or a path is not GitHub's: no repository to open or merge a PR in", () => {
  const s = setup();
  const set = (url: string) => (s.git(s.local)("remote", "set-url", "origin", url), githubOrigin(s.local));
  expect(set("https://gitlab.example.com/o/r.git")).toBeUndefined();
  expect(set("git@gitlab.example.com:o/r.git")).toBeUndefined();
  expect(set(s.origin)).toBeUndefined();
  expect(set("https://github.com/o/r.git")).toBe("o/r");
  expect(set("git@github.com:o/r.git")).toBe("o/r");
});
