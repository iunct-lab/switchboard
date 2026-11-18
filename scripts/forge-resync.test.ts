// test-reads: scripts/forge-resync.ts scripts/local-merge.ts
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubOrigin, main, unreachable, verifyLocal, type MergedRange, type Run } from "./forge-resync.ts";

// The local main sent back to GitHub against a bare repository standing in for GitHub: what both mains are after
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
  // every gh call; the sync PR's `gh pr create` is answered as GitHub would (the PR is number 77), anything else fails
  const gh: string[][] = [];
  const recording: Run = async (cmd, cwd) => {
    if (cmd[0] === "git" && cmd.includes("push")) pushes.push(cmd);
    if (cmd[0] === "gh") {
      gh.push(cmd.slice(1));
      return cmd[1] === "pr" && cmd[2] === "create" ? { code: 0, stdout: "https://github.com/o/r/pull/77\n", stderr: "" } : { code: 1, stdout: "", stderr: `unexpected gh ${cmd.join(" ")}` };
    }
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: ENV });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  };
  const backlog: string[][] = [];
  const asks: string[] = [];
  // what local-merge recorded on its changes: `landed()` records the local main's newest commit as one change's merge
  const merges: MergedRange[] = [];
  const landed = () => merges.push({ number: merges.length + 1, tip: at(local)("rev-parse", "main"), base: at(local)("rev-parse", "main~1") });
  // the app's changes the sync PR's list reads (`changes`); none by default
  const listed: Array<{ workspaceId: string; number: number; title: string; head: string; mergeCommit: string | null }> = [];
  const run = async (args: string[] = [], o: { run?: Run } = {}) => {
    const out: string[] = [];
    const code = await main(args, local, {
      run: o.run ?? recording,
      repo: "o/r",
      merged: async () => merges,
      changes: async () => listed as never,
      backlog: async (argv) => (backlog.push(argv), argv[0] === "comment" && asks.push(readFileSync(argv[3]!, "utf8")), 0),
      cache: home!,
      log: (s) => out.push(s),
      err: (s) => out.push(s),
    });
    return { code, out: out.join("\n"), json: (() => { try { return JSON.parse(out.find((l) => l.startsWith("{")) ?? "null"); } catch { return null; } })() };
  };
  const remoteMain = () => at(origin)("rev-parse", "main");
  const localMain = () => at(local)("rev-parse", "main");
  /** Where the local merges wait when main is checked out (the landing ref); "" = none. */
  const landing = () => { try { return at(local)("rev-parse", "--verify", "-q", "refs/switchboard/landed/main"); } catch { return ""; } };
  return { origin, local, other, git: at, commit, pushes, gh, backlog, asks, run, remoteMain, localMain, landing, merges, landed, recording, listed };
}

/** No push may drop a commit only GitHub has. */
function noForce(pushes: string[][]) {
  for (const p of pushes) {
    expect(p.some((a) => a === "-f" || a === "--force" || a.startsWith("--force") || a.startsWith("+"))).toBe(false);
  }
}

test("(a) only the local main moved: no push to main — the same commit to sb/sync-main-<7> (no force), a PR to main, exit 5", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  s.landed();
  const L = s.localMain();
  const G = s.remoteMain();
  const r = await s.run();
  const branch = `sb/sync-main-${L.slice(0, 7)}`;
  expect(r.code).toBe(5);
  expect(r.json).toEqual({ result: "sync-pr", pr: 77, branch, local: L, remote: G });
  expect(s.remoteMain()).toBe(G);
  expect(s.git(s.origin)("rev-parse", branch)).toBe(L);
  expect(s.pushes.map((a) => a.at(-1))).toEqual([`${L}:refs/heads/${branch}`]);
  // no read of main's protection: the PR is the only call to GitHub
  expect(s.gh.map((a) => a.slice(0, 2))).toEqual([["pr", "create"]]);
  const create = s.gh[0]!;
  expect(create.slice(create.indexOf("--base"), create.indexOf("--base") + 4)).toEqual(["--base", "main", "--head", branch]);
  expect(create[create.indexOf("--title") + 1]).toBe("main の同期: ローカルでマージしたコミット 1 件");
  noForce(s.pushes);
});

test("(b) both moved, other files: GitHub's main merged into the local one (L first parent, G second), that sent as the sync PR, main untouched on GitHub", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  s.landed();
  s.commit(s.other, "c.txt", "c");
  s.git(s.other)("push", "-q", "origin", "main");
  const L = s.localMain();
  const G = s.remoteMain();
  const r = await s.run(["--pbi", "9"]);
  expect(r.code).toBe(5);
  // main is checked out in the clone: the merge waits on the landing ref, and the work tree and its branch did not move
  const M = s.landing();
  const branch = `sb/sync-main-${M.slice(0, 7)}`;
  expect([s.localMain(), s.git(s.local)("status", "--porcelain")]).toEqual([L, ""]);
  expect(s.git(s.local)("rev-parse", `${M}^1`, `${M}^2`).split("\n")).toEqual([L, G]);
  expect(r.json).toEqual({ result: "sync-pr", pr: 77, branch, local: M, remote: G });
  expect(s.remoteMain()).toBe(G);
  expect(s.git(s.origin)("rev-parse", branch)).toBe(M);
  expect(s.pushes.map((a) => a.at(-1))).toEqual([`${M}:refs/heads/${branch}`]);
  // a second run makes no second merge and moves no work tree: it sends the same sync branch again
  expect(await s.run()).toMatchObject({ code: 5, json: { result: "sync-pr", local: M, remote: G } });
  expect([s.landing(), s.localMain()]).toEqual([M, L]);
  // the throwaway worktree is gone
  expect(s.git(s.local)("worktree", "list").split("\n")).toHaveLength(1);
  expect(s.backlog).toEqual([]);
  noForce(s.pushes);
});

test("(c) both changed the same line: a conflict — origin's and the local main unchanged, a 判断待ち with needs-decision on the PBI", async () => {
  const s = setup();
  s.commit(s.local, "a.txt", "local\n");
  s.landed();
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
  s.landed();
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
  const failing = (stderr: string): Run => async (cmd, cwd) => (cmd.includes("fetch") ? { code: 128, stdout: "", stderr } : (s.pushes.push(cmd), { code: 0, stdout: execFileSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8" }), stderr: "" }));
  for (const stderr of ["fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502", "remote: API rate limit exceeded"]) {
    const r = await s.run([], { run: failing(stderr) });
    expect(r.code).toBe(4);
    expect(r.out).toContain("まだ GitHub に届かない");
  }
  // a login or permission failure is not GitHub being away: it is not waited for (2), and nothing changed either
  for (const stderr of ["fatal: Authentication failed for 'https://github.com/o/r.git/'", "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403", "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found"]) {
    const r = await s.run([], { run: failing(stderr) });
    expect([stderr, r.code, r.out.includes("まだ GitHub に届かない")]).toEqual([stderr, 2, false]);
  }
  expect(s.pushes.filter((p) => p.includes("push"))).toEqual([]);
  expect(s.localMain()).toBe(L);
  expect(s.remoteMain()).toBe(G);
});

test("the local main behind GitHub's: nothing sent, a checked-out main left to pull-main and a bare ref moved; in step: nothing at all", async () => {
  const s = setup();
  s.commit(s.other, "c.txt", "c");
  s.git(s.other)("push", "-q", "origin", "main");
  const G = s.remoteMain();
  // the local clone has main checked out: its work tree is not moved (that is `ops-kit pull-main`'s step), and no ref is made
  const L = s.localMain();
  const r = await s.run();
  expect(r).toMatchObject({ code: 0, json: { result: "nothing", local: L, remote: G } });
  expect(r.out).toContain("ops-kit pull-main");
  expect([s.localMain(), s.landing(), s.git(s.local)("status", "--porcelain")]).toEqual([L, "", ""]);
  // a main checked out nowhere is a ref only: it is moved to GitHub's
  s.git(s.local)("checkout", "-q", "--detach");
  expect(await s.run()).toMatchObject({ code: 0, json: { result: "nothing", local: G, remote: G } });
  expect(s.localMain()).toBe(G);
  expect(await s.run()).toMatchObject({ code: 0, json: { result: "nothing", local: G, remote: G } });
  expect(s.pushes).toEqual([]);
});

test("a failure that is not GitHub being away is not counted as one", () => {
  expect(unreachable("fatal: 'origin' does not appear to be a git repository", 0)).toBe(false);
  expect(unreachable("fatal: couldn't find remote ref main", 0)).toBe(false);
  expect(unreachable("ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.", 0)).toBe(true);
  // a login or permission failure is the token's or the configuration's: reported, not waited for
  for (const denied of ["fatal: Authentication failed for 'https://github.com/o/r.git/'", "HTTP 401: Bad credentials (https://api.github.com/graphql)", "HTTP 403: Resource not accessible by personal access token", "HTTP 404: Not Found (https://api.github.com/repos/o/r/branches/main)", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."]) expect([denied, unreachable(denied, 0)]).toEqual([denied, false]);
});

test("a commit on the local main that no local merge recorded is not sent: nothing pushed, nothing moved, the commits listed (1)", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  s.landed(); // change 1, merged by local-merge
  s.commit(s.local, "x.txt", "by hand"); // a commit made on main directly: no gate judged it
  s.commit(s.local, "c.txt", "c");
  s.landed(); // change 2, merged on top of it
  const L = s.localMain();
  const G = s.remoteMain();
  const r = await s.run();
  expect(r.code).toBe(1);
  expect(r.json).toMatchObject({ result: "unverified", local: L, remote: G });
  expect(r.json.commits.some((c: string) => c.endsWith("x.txt: by hand"))).toBe(true);
  expect(r.out).toContain("何も push していない");
  expect([s.pushes, s.remoteMain(), s.localMain(), s.landing()]).toEqual([[], G, L, ""]);
  // the same when GitHub's main moved too: checked before any merge commit is made
  s.commit(s.other, "d.txt", "d");
  s.git(s.other)("push", "-q", "origin", "main");
  const again = await s.run();
  expect([again.code, again.json.result, s.pushes, s.landing()]).toEqual([1, "unverified", [], ""]);
  // the app cannot be asked for the records: not verified, not pushed (2)
  const out: string[] = [];
  const blind = await main([], s.local, { run: s.recording, merged: async () => { throw new Error("app down"); }, cache: home!, log: (x) => out.push(x), err: (x) => out.push(x) });
  expect([blind.valueOf(), s.pushes, out.join("\n").includes("何も push していない")]).toEqual([2, [], true]);
});

test("a landed ref with a commit no record names does not stay stuck: the stop names the ref and the person's two commands; --adopt-landing sends that tip, --drop-landing deletes the landing ref; neither runs without a terminal, in a Task, or for a tip that moved", async () => {
  const s = setup();
  // main is checked out in `local`, so a local merge lands on the landing ref: two commits there, the second without a record
  const land = (file: string) => {
    const from = s.landing() || s.localMain();
    s.git(s.local)("switch", "-q", "--detach", from);
    s.commit(s.local, file, file);
    const tip = s.git(s.local)("rev-parse", "HEAD");
    s.git(s.local)("update-ref", "refs/switchboard/landed/main", tip);
    s.git(s.local)("switch", "-q", "main");
    return { tip, base: from };
  };
  const one = land("b.txt");
  s.merges.push({ number: 1, tip: one.tip, base: one.base });
  const two = land("c.txt"); // landed, and its [local-merge] record was never written
  const G = s.remoteMain();
  const person = async (args: string[], o: { tty?: boolean; env?: Record<string, string> } = {}) => {
    const out: string[] = [];
    const code = await main(args, s.local, { run: s.recording, repo: "o/r", merged: async () => s.merges, cache: home!, log: (x) => out.push(x), err: (x) => out.push(x), tty: o.tty ?? true, env: o.env ?? {} });
    return { code, out: out.join("\n") };
  };
  const stuck = await s.run();
  expect(stuck.code).toBe(1);
  expect(stuck.json).toMatchObject({ result: "unverified", ref: "refs/switchboard/landed/main", local: two.tip });
  expect(stuck.out).toContain(`refs/switchboard/landed/main`);
  expect(stuck.out).toContain(`bun scripts/forge-resync.ts --adopt-landing ${two.tip}`);
  expect(stuck.out).toContain(`bun scripts/forge-resync.ts --drop-landing ${two.tip}`);
  expect(stuck.out).toContain("利用者が端末で実行する");
  // never by itself: without a terminal, inside a Task, for another tip, or with a short sha nothing changes
  for (const [args, o] of [
    [["--adopt-landing", two.tip], { tty: false }],
    [["--drop-landing", two.tip], { tty: false }],
    [["--adopt-landing", two.tip], { env: { SWITCHBOARD_TASK_ID: "task_1" } }],
    [["--drop-landing", two.tip], { env: { SWITCHBOARD_TASK_ID: "task_1" } }],
    [["--adopt-landing", one.tip], {}],
    [["--drop-landing", one.tip], {}],
    [["--adopt-landing", two.tip.slice(0, 7)], {}],
    [["--drop-landing"], {}],
  ] as const) expect([args.join(" "), (await person([...args], o)).code, s.pushes, s.landing(), s.remoteMain()]).toEqual([args.join(" "), 2, [], two.tip, G]);
  // the person adopts the tip: it is sent as it is on the sync branch, no force, GitHub's main not pushed to
  const adopted = await person(["--adopt-landing", two.tip]);
  expect(adopted.code).toBe(5);
  expect(adopted.out).toContain("記録が無いコミットを認めて進める");
  expect(adopted.out).toContain("c.txt: c.txt");
  expect(s.remoteMain()).toBe(G);
  expect(s.git(s.origin)("rev-parse", `sb/sync-main-${two.tip.slice(0, 7)}`)).toBe(two.tip);
  noForce(s.pushes);

  // the other way out, on a fresh pair: the landing ref is deleted, nothing is pushed, the branch stays
  const d = setup();
  d.git(d.local)("switch", "-q", "--detach");
  d.commit(d.local, "x.txt", "x");
  const tip = d.git(d.local)("rev-parse", "HEAD");
  d.git(d.local)("update-ref", "refs/switchboard/landed/main", tip);
  d.git(d.local)("switch", "-q", "main");
  const before = [d.localMain(), d.remoteMain()];
  expect((await d.run()).json).toMatchObject({ result: "unverified", local: tip });
  const out: string[] = [];
  const code = await main(["--drop-landing", tip], d.local, { run: d.recording, merged: async () => [], cache: home!, log: (x) => out.push(x), err: (x) => out.push(x), tty: true, env: {} });
  expect([code, d.landing(), d.pushes, d.localMain(), d.remoteMain()]).toEqual([0, "", [], ...before]);
  expect(JSON.parse(out.find((l) => l.startsWith("{"))!)).toMatchObject({ result: "dropped", ref: "refs/switchboard/landed/main", was: tip });
  expect(out.join("\n")).toContain(`git update-ref refs/switchboard/landed/main ${tip}`);
  // in step again: the next run has nothing to send
  expect((await d.run()).json).toMatchObject({ result: "nothing" });
});

test("verifyLocal: recorded merges and this script's own clean merge of GitHub's main pass; a merge made or edited by hand does not", async () => {
  const s = setup();
  const g = s.git(s.local);
  s.commit(s.local, "b.txt", "b");
  s.landed();
  s.commit(s.other, "c.txt", "c");
  s.git(s.other)("push", "-q", "origin", "main");
  g("fetch", "-q", "origin", "main");
  const G = s.remoteMain();
  const L = s.localMain();
  // the merge forge-resync itself makes: clean, GitHub's main as the second parent
  g("merge", "-q", "--no-ff", "-m", "Merge GitHub's main", G);
  const clean = s.localMain();
  expect(await verifyLocal(s.recording, s.local, clean, G, s.merges)).toEqual({ ok: true });
  // the same parents with a file changed in the merge commit itself: not git's own merge of the two
  writeFileSync(join(s.local, "b.txt"), "edited in the merge\n");
  g("commit", "-q", "-a", "--amend", "--no-edit");
  const evil = s.localMain();
  expect(await verifyLocal(s.recording, s.local, evil, G, s.merges)).toMatchObject({ ok: false, at: evil });
  // a range with no record, and a record whose base is not under its tip
  expect(await verifyLocal(s.recording, s.local, L, G, [])).toMatchObject({ ok: false, at: L });
  expect(await verifyLocal(s.recording, s.local, L, G, [{ number: 1, tip: L, base: clean }])).toMatchObject({ ok: false, at: L });
  // a merge of a branch that is not GitHub's main
  g("reset", "-q", "--hard", L);
  g("checkout", "-q", "-b", "side", `${L}~1`);
  s.commit(s.local, "s.txt", "s");
  g("checkout", "-q", "main");
  g("merge", "-q", "--no-ff", "-m", "side", "side");
  expect(await verifyLocal(s.recording, s.local, s.localMain(), G, s.merges)).toMatchObject({ ok: false });
});

/** origin.git refuses a push to main as GitHub's protected branch does (GH006), unless ALLOW=1 (the fake `gh pr merge`). */
function protect(s: ReturnType<typeof setup>) {
  const hook = join(s.origin, "hooks", "pre-receive");
  writeFileSync(hook, '#!/bin/sh\n[ "$ALLOW" = 1 ] && exit 0\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && { echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2; exit 1; }; done\nexit 0\n');
  chmodSync(hook, 0o755);
  const gh: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const run: Run = async (cmd, cwd, env) => {
    if (cmd[0] === "gh") envs.push(env);
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
  return { gh, run, envs };
}

const judgeAs = (verdict: "merge" | "stop", head: () => string) => async () => ({ verdict, impact: "small", reasons: verdict === "stop" ? ["CI: 未完了"] : [], ask: [], recheck: [], head: head() }) as never;

test("whether GitHub protects main or would take the push makes no difference: the sync PR, no push to main, no read of the protection; an origin that is not GitHub's gets nothing (2)", async () => {
  for (const hook of [true, false]) {
    const s = setup();
    // with the hook origin.git refuses a push to main as a protected branch does; without it the token could bypass and the push would go in
    if (hook) protect(s);
    s.commit(s.local, "b.txt", "b");
    s.landed();
    const L = s.localMain();
    const G = s.remoteMain();
    const r = await s.run();
    expect([hook, r.code, s.remoteMain()]).toEqual([hook, 5, G]);
    expect(s.pushes.map((a) => a.at(-1))).toEqual([`${L}:refs/heads/sb/sync-main-${L.slice(0, 7)}`]);
    expect(s.gh.some((a) => a[0] === "api")).toBe(false);
    rmSync(home!, { recursive: true, force: true });
  }
  // origin that is not GitHub's (here a path, as a clone of another forge would be): nothing is pushed anywhere, with a reason
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  s.landed();
  const out: string[] = [];
  const code = await main([], s.local, { run: s.recording, merged: async () => s.merges, cache: home!, log: (x) => out.push(x), err: (x) => out.push(x) });
  expect([code, s.pushes, s.gh]).toEqual([2, [], []]);
  expect(out.join("\n")).toContain("GitHub でない forge へは送らない");
});

test("--merge-sync with a merge verdict — gh pr merge --merge at the judged head with the gate's mark, the checked-out main left to pull-main", async () => {
  const s = setup();
  const p = protect(s);
  s.commit(s.local, "b.txt", "b");
  s.landed();
  const L = s.localMain();
  expect(await main([], s.local, { run: p.run, repo: "o/r", merged: async () => s.merges, changes: async () => [], cache: home!, log: () => {}, err: () => {} })).toBe(5);
  const out: string[] = [];
  // the app: one change merged here, no PR (so the report needs no gh) — left on its Task right after the sync PR is merged
  const app = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: L, pr: null, body: "Closes #5", comments: MARKS }]);
  const code = await main(["--merge-sync", "77"], s.local, { ...app.deps(), repo: "o/r", run: p.run, judgePr: judgeAs("merge", () => L), log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(0);
  expect(app.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /5/comment", "PATCH /5", "PATCH /1?change=1"]);
  const merge = p.gh.find((a) => a[1] === "merge")!;
  expect(merge).toEqual(["pr", "merge", "77", "-R", "o/r", "--merge", "--delete-branch", "--match-head-commit", L]);
  expect(merge.some((a) => a === "--rebase" || a === "--squash")).toBe(false);
  // the gate judged it: the merge carries the gate's mark of this PR, so the check in front of `gh` lets it through in a Task
  expect(p.envs[p.gh.indexOf(merge)]).toEqual({ OPS_MERGE_GATE_PR: "77" });
  const M = s.remoteMain();
  expect(s.git(s.origin)("rev-parse", `${M}^2`)).toBe(L);
  // main is checked out here: its work tree is not moved (ops-kit pull-main does that), and it is behind GitHub's only
  expect([s.localMain(), s.landing(), s.git(s.local)("status", "--porcelain")]).toEqual([L, "", ""]);
  expect(out.join("\n")).toContain("ops-kit pull-main");
  expect(out).toContain(JSON.stringify({ result: "synced", pr: 77, local: L, remote: M }));
  expect(out.at(-1)).toBe(JSON.stringify({ result: "reported", reported: [1] }));
  noForce(s.pushes);
});

test("--merge-sync: the merge is done but the report cannot be left (GitHub down): the report's exit 4, and the output says to run --report only", async () => {
  const s = setup();
  const p = protect(s);
  s.commit(s.local, "b.txt", "b");
  s.landed();
  const L = s.localMain();
  expect(await main([], s.local, { run: p.run, repo: "o/r", merged: async () => s.merges, changes: async () => [], cache: home!, log: () => {}, err: () => {} })).toBe(5);
  const app = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: L, pr: 70, comments: MARKS }]);
  const down: Run = async (cmd, cwd, env) => (cmd[0] === "gh" && cmd[2] === "view" ? { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" } : p.run(cmd, cwd, env));
  const out: string[] = [];
  const code = await main(["--merge-sync", "77"], s.local, { ...app.deps(), repo: "o/r", run: down, judgePr: judgeAs("merge", () => L), log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(4);
  // GitHub has the commits (the merge happened) and nothing was marked reported
  expect(s.git(s.origin)("rev-parse", `${s.remoteMain()}^2`)).toBe(L);
  expect(app.changes[0]!.reportedAt).toBeNull();
  expect(out.join("\n")).toContain('"result":"synced"');
  expect(out.join("\n")).toContain("--merge-sync はやり直さず");
  expect(out.join("\n")).toContain("--report");
});

test("--merge-sync: the merge is done but the app cannot be read afterwards: the report's exit 2, and the output says to run --report only", async () => {
  const s = setup();
  const p = protect(s);
  s.commit(s.local, "b.txt", "b");
  s.landed();
  const L = s.localMain();
  expect(await main([], s.local, { run: p.run, repo: "o/r", merged: async () => s.merges, changes: async () => [], cache: home!, log: () => {}, err: () => {} })).toBe(5);
  const app = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: L, pr: null, body: "Closes #5", comments: MARKS }]);
  // the app answers until the sync PR is merged, then is gone
  let merged = false;
  const run: Run = async (cmd, cwd, env) => (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "merge" ? ((merged = true), p.run(cmd, cwd, env)) : p.run(cmd, cwd, env));
  const fetch = async (url: string, init?: RequestInit) => {
    if (merged) throw new Error("connect ECONNREFUSED");
    return app.deps().fetch(url, init);
  };
  const out: string[] = [];
  const code = await main(["--merge-sync", "77"], s.local, { ...app.deps(), fetch, repo: "o/r", run, judgePr: judgeAs("merge", () => L), log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(2);
  expect(s.git(s.origin)("rev-parse", `${s.remoteMain()}^2`)).toBe(L);
  expect(app.writes).toEqual([]);
  expect(out.join("\n")).toContain('"result":"synced"');
  expect(out.join("\n")).toContain("exit 2");
  expect(out.join("\n")).toContain("--merge-sync はやり直さず");
});

test("--merge-sync: the merge is done but one change cannot be left: the report's exit 1, and the output says to run --report only", async () => {
  const s = setup();
  const p = protect(s);
  s.commit(s.local, "b.txt", "b");
  s.landed();
  const L = s.localMain();
  expect(await main([], s.local, { run: p.run, repo: "o/r", merged: async () => s.merges, changes: async () => [], cache: home!, log: () => {}, err: () => {} })).toBe(5);
  // the PR comment is refused for a reason that is not an outage
  const app = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: L, pr: 70, comments: MARKS }], { gh: (a) => (a[1] === "comment" ? { code: 1, stdout: "", stderr: "HTTP 422: Validation Failed" } : undefined) });
  const run: Run = async (cmd, cwd, env) => (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "merge" ? p.run(cmd, cwd, env) : app.deps().run(cmd, cwd, env));
  const out: string[] = [];
  const code = await main(["--merge-sync", "77"], s.local, { ...app.deps(), run, repo: "o/r", judgePr: judgeAs("merge", () => L), log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(1);
  expect(s.git(s.origin)("rev-parse", `${s.remoteMain()}^2`)).toBe(L);
  expect(app.changes[0]!.reportedAt).toBeNull();
  expect(out.join("\n")).toContain('"result":"synced"');
  expect(out.join("\n")).toContain('"result":"partial"');
  expect(out.join("\n")).toContain("exit 1");
  expect(out.join("\n")).toContain("--merge-sync はやり直さず");
});

test("report (g): the sync PR's body lists the changes whose merge commit is in G..tip — L<n>, title, branch, merge commit — and not one outside it; an unreadable app does not fail the PR", async () => {
  const s = setup();
  s.commit(s.local, "b.txt", "b");
  s.landed();
  const inside = s.localMain();
  const outside = s.git(s.origin)("rev-parse", "main");
  // the body file is removed after the PR is made: read it through the recording run
  let body = "";
  const run: Run = async (cmd, cwd) => {
    if (cmd[0] === "gh" && cmd[2] === "create") body = readFileSync(cmd[cmd.indexOf("--body-file") + 1]!, "utf8");
    return s.recording(cmd, cwd);
  };
  s.listed.push({ workspaceId: "ws1", number: 4, title: "ローカルの変更", head: "sb/9-in", mergeCommit: inside }, { workspaceId: "ws1", number: 3, title: "もう GitHub にある変更", head: "sb/8-out", mergeCommit: outside }, { workspaceId: "ws1", number: 6, title: "未マージ", head: "sb/7-open", mergeCommit: null });
  expect((await s.run([], { run })).code).toBe(5);
  expect(body).toContain(`- L4 ローカルの変更（枝 sb/9-in、マージコミット ${inside.slice(0, 7)}）`);
  expect(body).not.toContain("L3");
  expect(body).not.toContain("L6");
  // the changes come before the commit list
  expect(body.indexOf("L4")).toBeLessThan(body.indexOf("ローカルの main にだけあるコミット"));
  // the app cannot be read: the PR is still made, with a line saying the list is missing
  const t = setup();
  t.commit(t.local, "b.txt", "b");
  t.landed();
  let body2 = "";
  const out: string[] = [];
  const code = await main([], t.local, { run: async (cmd, cwd) => (cmd[0] === "gh" && cmd[2] === "create" && (body2 = readFileSync(cmd[cmd.indexOf("--body-file") + 1]!, "utf8")), t.recording(cmd, cwd)), repo: "o/r", merged: async () => t.merges, changes: async () => { throw new Error("app down"); }, cache: home!, log: (x) => out.push(x), err: (x) => out.push(x) });
  expect(code).toBe(5);
  expect(body2).toContain("一覧はアプリから読めなかった（app down）");
});

test("--merge-sync with a stop verdict — gh pr merge is not called, nothing moves", async () => {
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

// `--report`: what was done locally is left on GitHub once per change. A fake app (the changes, their comments) and a
// fake gh; origin is the bare repository of `setup`, so "GitHub's main has the commit" is git's own answer.
import { changeSummary } from "./forge-resync.ts";

type Listed = { number: number; title?: string; state?: "OPEN" | "CLOSED"; head: string; mergeCommit: string | null; pr: number | null; reportedAt?: string | null; body?: string; comments?: string[] };

function reporting(s: ReturnType<typeof setup>, listed: Listed[], o: { prState?: Record<number, string>; gh?: (args: string[]) => { code: number; stdout: string; stderr: string } | undefined } = {}) {
  const changes = listed.map((c) => ({ workspaceId: "ws1", title: c.title ?? `変更 ${c.number}`, state: c.state ?? "CLOSED", base: "main", mergedAt: null, updatedAt: "", reportedAt: c.reportedAt ?? null, ...c }));
  const writes: Array<{ method: string; path: string; body: any }> = [];
  const ghCalls: string[][] = [];
  const prComments: Record<number, string[]> = {};
  const fetch = async (url: string, init: RequestInit = {}) => {
    const path = url.replace("http://app/api/backlog", "");
    const method = init.method ?? "GET";
    if (method !== "GET") {
      const body = JSON.parse(String(init.body));
      writes.push({ method, path, body });
      const m = /^\/(\d+)\?change=1$/.exec(path);
      const c = m && changes.find((x) => x.number === Number(m[1]));
      if (c && body.change?.reportedAt) c.reportedAt = body.change.reportedAt;
      if (c && body.state) c.state = body.state;
      return new Response("{}", { status: 202 });
    }
    if (path === "/syncs") return new Response(JSON.stringify({ syncs: [{ workspaceId: "ws1", backlog: "github", repository: "acme/app", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] }));
    if (path.startsWith("/records")) return new Response(JSON.stringify({ workspaceId: "ws1", service: "github", repository: "acme/app", issues: [], top: [], pulls: [], comments: [], unread: [] }));
    if (path === "") return new Response(JSON.stringify({ items: [], changes }));
    const c = changes.find((x) => path.startsWith(`/${x.number}?`) && path.endsWith("&change=1"));
    if (!c) return new Response(JSON.stringify({ error: `unexpected ${path}` }), { status: 404 });
    return new Response(JSON.stringify({ workspaceId: "ws1", issue: { number: c.number, title: c.title, state: c.state, labels: [], body: c.body ?? "", change: { head: c.head, base: "main", mergeCommit: c.mergeCommit, pr: c.pr, reportedAt: c.reportedAt } }, comments: (c.comments ?? []).map((body, i) => ({ id: `sb:${i}`, body, createdAt: `2026-01-0${i + 1}T00:00:00Z` })) }));
  };
  const run: Run = async (cmd, cwd) => {
    if (cmd[0] !== "gh") {
      const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: ENV });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    }
    const args = cmd.slice(1);
    ghCalls.push(args);
    const forced = o.gh?.(args);
    if (forced) return forced;
    const n = Number(args[2]);
    if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ state: o.prState?.[n] ?? "OPEN", comments: (prComments[n] ?? []).map((body) => ({ body })) }), stderr: "" };
    if (args[1] === "comment") (prComments[n] ??= []).push(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"));
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps = () => ({ run, cache: home!, repo: "acme/app", env: { BACKLOG_URL: "http://app/api/backlog", BACKLOG_WORKSPACE: "ws1" }, fetch, now: () => Date.parse("2026-02-01T00:00:00Z") });
  const go = async () => {
    const out: string[] = [];
    const code = await main(["--report"], s.local, { ...deps(), log: (l) => out.push(l), err: (l) => out.push(l) });
    return { code, out: out.join("\n") };
  };
  return { go, deps, writes, ghCalls, prComments, changes };
}

/** `setup` with the local main one commit ahead and pushed: GitHub's main has `merged`; `unpushed` is a commit it does not have. */
function resynced() {
  const s = setup();
  s.commit(s.local, "b.txt", "b\n");
  const merged = s.git(s.local)("rev-parse", "main");
  s.git(s.local)("push", "-q", "origin", "main");
  s.commit(s.local, "c.txt", "c\n");
  const unpushed = s.git(s.local)("rev-parse", "main");
  return { ...s, merged, unpushed };
}
const MARKS = ["[claude] review\n\n### Intent\nok", "振り分け\n| 指摘 |", `[local-ci] pass ${"a".repeat(40)} base=${"b".repeat(40)}\n結果`];

test("report: the summary is one line of what happened and the marks' first lines as list items", () => {
  const text = changeSummary({ number: 3, head: "sb/5-x", mergeCommit: "c".repeat(40) }, MARKS.map((body, i) => ({ body, createdAt: `2026-01-0${i + 1}T00:00:00Z` })));
  expect(text.split("\n")).toEqual(["ローカルでマージしました（GitHub が使えなかった間。L3、sb/5-x、マージコミット ccccccc）", "", "- [claude] review", `- [local-ci] pass ${"a".repeat(40)} base=${"b".repeat(40)}`]);
  // no line of it starts as a mark: left on a PR, it is not read as that PR's review or CI result
  expect(text.split("\n").some((l) => l.startsWith("["))).toBe(false);
});

test("report (a, b): a PR GitHub took as merged gets the comment only; one still open gets it and is closed", async () => {
  const s = resynced();
  const r = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: s.merged, pr: 70, comments: MARKS }, { number: 2, head: "sb/6-y", mergeCommit: s.merged, pr: 71, comments: MARKS }], { prState: { 70: "MERGED", 71: "OPEN" } });
  const out = await r.go();
  expect(out.code).toBe(0);
  expect(JSON.parse(out.out.split("\n").at(-1)!)).toEqual({ result: "reported", reported: [1, 2] });
  expect(r.ghCalls.map((a) => `${a[0]} ${a[1]} ${a[2]}`)).toEqual(["pr view 70", "pr comment 70", "pr view 71", "pr comment 71", "pr close 71"]);
  expect(r.prComments[70]![0]).toContain(`L1、sb/5-x、マージコミット ${s.merged.slice(0, 7)}`);
  expect(r.prComments[70]![0]).toContain("- [claude] review");
  // GitHub's main has the commits: only now are the Tasks the changes close closed (the branches sb/5-x, sb/6-y), each before its change is marked reported
  expect(r.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /5", "PATCH /1?change=1", "PATCH /6", "PATCH /2?change=1"]);
  expect(r.writes[0]!.body).toEqual({ workspaceId: "ws1", state: "CLOSED", fields: { Status: "Done" } });
  expect(r.writes[1]!.body).toEqual({ workspaceId: "ws1", change: { reportedAt: "2026-02-01T00:00:00.000Z" } });
  // no gh call writes anywhere but the PR's comment and close: nothing pushes, nothing merges
  expect(r.ghCalls.every((a) => a[0] === "pr" && ["view", "comment", "close"].includes(a[1]!))).toBe(true);
});

test("report (c): a change with no PR is recorded on the Task it closed, through the app; gh is not called", async () => {
  const s = resynced();
  const r = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: s.merged, pr: null, body: "Closes #5", comments: MARKS }]);
  expect((await r.go()).code).toBe(0);
  expect(r.ghCalls).toEqual([]);
  expect(r.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /5/comment", "PATCH /5", "PATCH /1?change=1"]);
  expect(r.writes[0]!.body.text).toContain("ローカルでマージしました");
});

test("report (d, e): one already reported, one whose commit GitHub's main does not have yet, and a second run write nothing", async () => {
  const s = resynced();
  const r = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: s.merged, pr: 70, reportedAt: "2026-01-09T00:00:00Z" }, { number: 2, head: "sb/6-y", mergeCommit: s.unpushed, pr: 71 }, { number: 3, head: "sb/7-z", mergeCommit: s.merged, pr: null, body: "Closes #7" }]);
  expect((await r.go()).code).toBe(0);
  expect(r.ghCalls).toEqual([]);
  // change 2's commit is not on GitHub's main yet: its Task (6) stays open, nothing is written for it
  expect(r.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /7/comment", "PATCH /7", "PATCH /3?change=1"]);
  const before = r.writes.length;
  expect((await r.go()).code).toBe(0);
  expect([r.writes.length, r.ghCalls.length]).toEqual([before, 0]);
});

test("report (f): gh answers 502: nothing is marked reported, exit 4; the next run goes on and does not write the comment twice", async () => {
  const s = resynced();
  let down = true;
  const r = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: s.merged, pr: 70, comments: MARKS }], { gh: (args) => (down && args[1] === "close" ? { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway (https://api.github.com/graphql)" } : undefined) });
  const first = await r.go();
  expect(first.code).toBe(4);
  expect(r.writes).toEqual([]);
  expect(r.changes[0]!.reportedAt).toBeNull();
  down = false;
  expect((await r.go()).code).toBe(0);
  // the comment went out before the close failed: found again, not written twice
  expect(r.prComments[70]).toHaveLength(1);
  expect(r.ghCalls.filter((a) => a[1] === "comment")).toHaveLength(1);
  expect(r.writes.map((w) => w.path)).toEqual(["/5", "/1?change=1"]);
});

test("report: a failure that is no outage (the PR is gone) leaves that change for the person and goes on with the next (1)", async () => {
  const s = resynced();
  const r = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: s.merged, pr: 70 }, { number: 2, head: "sb/6-y", mergeCommit: s.merged, pr: null, body: "Closes #6" }], { gh: (args) => (args[1] === "view" ? { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest with the number of 70. (repository.pullRequest)" } : undefined) });
  const out = await r.go();
  expect(out.code).toBe(1);
  expect(out.out).toContain("L1 の要約を残せなかった");
  expect(r.writes.map((w) => w.path)).toEqual(["/6/comment", "/6", "/2?change=1"]);
});

test("report: an open change that stood in for a PR is closed unmerged and its marks summed up on the PR, which stays open", async () => {
  const s = resynced();
  const r = reporting(s, [{ number: 1, state: "OPEN", head: "sb/5-x", mergeCommit: null, pr: 70, comments: MARKS }, { number: 2, state: "OPEN", head: "sb/6-y", mergeCommit: null, pr: null }]);
  expect((await r.go()).code).toBe(0);
  expect(r.ghCalls.map((a) => `${a[1]} ${a[2]}`)).toEqual(["view 70", "comment 70"]);
  expect(r.prComments[70]![0]).toContain("ローカルではマージしていません");
  // the open change with no PR goes on locally: untouched
  expect(r.writes).toEqual([{ method: "PATCH", path: "/1?change=1", body: { workspaceId: "ws1", state: "CLOSED", change: { reportedAt: "2026-02-01T00:00:00.000Z" } } }]);
});

test("report: GitHub not reachable for the fetch: 4 and nothing written; --report with another argument is usage (2)", async () => {
  const s = resynced();
  const r = reporting(s, [{ number: 1, head: "sb/5-x", mergeCommit: s.merged, pr: 70 }]);
  s.git(s.local)("remote", "set-url", "origin", "https://127.0.0.1:1/acme/app.git");
  expect((await r.go()).code).toBe(4);
  expect([r.writes, r.ghCalls]).toEqual([[], []]);
  expect(await main(["--report", "--pbi", "3"], s.local, { err: () => {}, log: () => {} })).toBe(2);
});
