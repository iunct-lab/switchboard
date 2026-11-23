// test-reads: scripts/local-merge.ts
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, BacklogIssueDetail, RunnerAdapter, Workspace } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer, type CoreServer } from "../packages/core/src/server.ts";
import { closedBy, main } from "./local-merge.ts";

// A local change merged against the real daemon with a fake runner and a repository with no remote: what
// main's log, the branches and the app's states are after it.

let core: CoreServer | undefined;
let home: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (home) rmSync(home, { recursive: true, force: true });
  core = home = undefined;
});

const idle: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start: () => ({ send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) }),
};

/** The daemon, a local workspace on a repository `main` → `sb/2-x` (2 commits), a PBI `#1`, its Task `#2` and the change `#3` of the branch, reviewed with a local-ci pass. */
async function setup(o: { lines?: number } = {}) {
  home = mkdtempSync(join(tmpdir(), "sb-local-merge-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  git("checkout", "-q", "-b", "sb/2-x");
  for (const name of ["b", "c"]) {
    writeFileSync(join(repo, `${name}.txt`), Array.from({ length: o.lines ?? 1 }, () => `${name}\n`).join(""));
    git("add", "-A");
    git("commit", "-q", "-m", name);
  }
  git("checkout", "-q", "main");
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [idle], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async () => { throw new Error("gh called"); } });
  const url = `http://127.0.0.1:${core.server.port}/api/backlog`;
  const send = async (method: string, path: string, body: object) => (await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  const ws = (await (await fetch(`http://127.0.0.1:${core.server.port}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo, backlog: "switchboard" }) })).json()) as Workspace;
  await send("POST", "", { workspaceId: ws.id, title: "PBI: p", labels: ["type:pbi"], fields: { Status: "In progress" } });
  await send("POST", "", { workspaceId: ws.id, title: "Task: t", labels: ["type:task"], parent: 1 });
  expect((await send("POST", "", { workspaceId: ws.id, title: "変更", body: "Backlog-Task: 2", change: { head: "sb/2-x", base: "main" } })).number).toBe(3);
  const tip = (b: string) => git("rev-parse", b);
  // the app's jobs of the change (it reads them, not a comment): a main review of the head and a local CI pass of the head on the base
  const mark = async () => {
    const at = Date.now();
    const base = { taskId: "task_x", pr: 3, cwd: repo, startedAt: at, repo: `local:${ws.id}`, as: null, kinds: [] };
    const review = core!.db.insertJob({ ...base, kind: "review", runner: "claude", head: tip("sb/2-x") });
    core!.db.finishJob(review.id, { status: "pass", exitCode: 0, summary: "", endedAt: at });
    core!.db.setJobResult(review.id, { result: { review: { findings: [], firstLine: "[claude] review" } } });
    const ci = core!.db.insertJob({ ...base, kind: "local-ci", runner: null, head: null });
    core!.db.finishJob(ci.id, { status: "pass", exitCode: 0, summary: "", endedAt: at });
    core!.db.setJobResult(ci.id, { head: tip("sb/2-x"), base: tip("main"), result: { ci: { outcome: "pass" } } });
  };
  await mark();
  const tokenFile = join(home, "client-token");
  writeFileSync(tokenFile, "k\n");
  const view = async (n: number) => (await (await fetch(`${url}/${n}?workspaceId=${ws.id}`)).json()) as BacklogIssueDetail;
  const done = async () => ((await (await fetch(url)).json()) as Backlog).items.find((i) => i.workspaceId === ws.id && i.number === 1)?.tasks;
  const run = async (args: string[] = ["3"], f?: (u: string, init?: RequestInit) => Promise<Response>, env: Record<string, string> = {}) => {
    const out: string[] = [];
    const code = await main(args, repo, { env: { BACKLOG_URL: url, BACKLOG_TOKEN_FILE: tokenFile, BACKLOG_WORKSPACE: ws.id, ...env }, ...(f ? { fetch: f } : {}), cache: home!, log: (s) => out.push(s), err: (s) => out.push(s), now: () => new Date("2026-01-02T00:00:00Z") });
    return { code, out: out.join("\n") };
  };
  const branches = () => git("branch", "--format=%(refname:short)").split("\n").sort();
  const subjects = () => git("log", "--format=%s", "main").split("\n");
  const merges = () => git("rev-list", "--merges", "main");
  return { repo, git, tip, ws, url, view, done, run, mark, branches, subjects, merges };
}

test("(a, c) base not moved: main gets the branch's commits in order, no merge commit; the branch goes, the change is merged, its Task closed and the PBI's done grows", async () => {
  const s = await setup();
  const head = s.tip("sb/2-x");
  const base = s.tip("main");
  expect((await s.done())).toMatchObject({ total: 1, done: 0 });
  const r = await s.run();
  expect(r.code).toBe(0);
  expect(s.subjects()).toEqual(["c", "b", "a"]);
  expect(s.merges()).toBe("");
  // nothing to rebase onto: the same commits
  expect(s.tip("main")).toBe(head);
  expect(s.branches()).toEqual(["main"]);
  expect((await s.view(3)).issue).toMatchObject({ state: "CLOSED", change: { head: "sb/2-x", base: "main", mergeCommit: head, mergedAt: "2026-01-02T00:00:00.000Z", reviewedHead: head } });
  // which commits the merge put on the base is recorded on the change: forge-resync sends only commits so recorded
  expect((await s.view(3)).comments.map((c) => c.body)).toContain(`[local-merge] merged ${head} base=${base}`);
  // a workspace that keeps its changes itself: its branch (and the checkout that has it) is where the merge lands, no landing ref
  expect(() => s.git("rev-parse", "--verify", "-q", "refs/switchboard/landed/main")).toThrow();
  // the Task had no Status (no field set when made): it is Done now
  const task = await s.view(2);
  expect(task.issue.state).toBe("CLOSED");
  expect(task.fields).toMatchObject({ Status: "Done" });
  expect((await s.done())).toMatchObject({ total: 1, done: 1 });
});

test("in a Task the judgement is the app's gate job: an address of the records in the Task's environment is not read, and only its merge verdict at the head read here goes on", async () => {
  const s = await setup();
  const head = s.tip("sb/2-x");
  const urls: string[] = [];
  const posts: unknown[] = [];
  // the app's gate job (the daemon's own run of merge-gate --change) as a verdict: the head it judged and whether it merges
  const job = (verdict: "merge" | "stop", judged: string) => async (u: string, init?: RequestInit) => {
    urls.push(u);
    const path = new URL(u).pathname;
    if (path === "/api/jobs") return (posts.push(JSON.parse(String(init?.body))), Response.json({ id: 41 }));
    if (path === "/api/jobs/41") return Response.json({ job: { id: 41, status: verdict === "merge" ? "pass" : "fail", exitCode: verdict === "merge" ? 0 : 1, summary: null, result: { gate: { head: judged } } }, out: JSON.stringify({ verdict }) });
    return fetch(u, init);
  };
  const env = { SWITCHBOARD_TASK_ID: "task_1", OPS_KIT_TASK_ID: "task_1", SWITCHBOARD_GATE_POLL_MS: "1", MERGE_RECORDS_URL: "http://evil.test", MERGE_RECORDS_TOKEN_FILE: "/nonexistent" };
  const before = () => [s.tip("main"), s.tip("sb/2-x"), s.branches().join(",")];
  const was = before();
  // a stop, and a verdict for another head: nothing moves
  expect((await s.run(["3", "--allow-large"], job("stop", head), env)).code).toBe(1);
  expect((await s.run(["3"], job("merge", "e".repeat(40)), env)).out).toContain("判定した head");
  expect(before()).toEqual(was);
  expect(posts).toEqual([{ kind: "gate", taskId: "task_1", cwd: s.repo, pr: 3, change: true, allowLarge: true }, { kind: "gate", taskId: "task_1", cwd: s.repo, pr: 3, change: true }]);
  // the merge verdict at the head: the merge goes through, as outside a Task
  const ok = await s.run(["3"], job("merge", head), env);
  expect(ok.code).toBe(0);
  expect(s.subjects()).toEqual(["c", "b", "a"]);
  expect((await s.view(3)).issue).toMatchObject({ state: "CLOSED" });
  // nothing here read the address the Task's environment named, or the app's records itself
  expect(urls.some((u) => u.includes("evil.test") || u.includes("/api/merge-records"))).toBe(false);
});

test("(b) base moved before: the branch's commits are rebased onto the new tip, author dates kept", async () => {
  const s = await setup();
  writeFileSync(join(s.repo, "z.txt"), "z\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "z");
  // the pass was of the old base: a new one for this base
  await s.mark();
  const reviewed = s.tip("sb/2-x");
  const r = await s.run();
  expect(r.code).toBe(0);
  // the change keeps the head that was judged beside the commit main got: the rebase made them differ
  const merged = (await s.view(3)).issue.change!;
  expect(merged.reviewedHead).toBe(reviewed);
  expect(merged.mergeCommit).toBe(s.tip("main"));
  expect(merged.reviewedHead).not.toBe(merged.mergeCommit);
  expect(s.subjects()).toEqual(["c", "b", "z", "a"]);
  expect(s.merges()).toBe("");
  expect(s.git("log", "-1", "--format=%aI %an", "main")).toBe("2026-01-01T00:00:00Z t");
});

test("(d) a stop, a conflict, a dirty worktree of the base: main, the branch and the app stay as they were", async () => {
  const s = await setup();
  const before = () => [s.tip("main"), s.tip("sb/2-x"), s.branches().join(",")];
  const same = async (r: { code: number }, was: string[]) => {
    expect(r.code).toBe(1);
    expect(before()).toEqual(was);
    expect((await s.view(3)).issue).toMatchObject({ state: "OPEN", change: { mergeCommit: null } });
    expect((await s.view(2)).issue.state).toBe("OPEN");
  };
  // a stop: main moved since the pass (its base is old) — the judgement again catches it
  writeFileSync(join(s.repo, "b.txt"), "other\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "conflicting");
  let was = before();
  const stop = await s.run();
  expect(stop.out).toContain('"verdict": "stop"');
  await same(stop, was);
  // a conflict: judged as DIRTY first, so a stop too — nothing is rebased
  await s.mark();
  const dirty = await s.run();
  expect(dirty.out).toContain("DIRTY");
  await same(dirty, was);
  // a dirty worktree of the base, with a change that merges
  s.git("reset", "-q", "--hard", "HEAD~1");
  await s.mark();
  writeFileSync(join(s.repo, "a.txt"), "edited\n");
  was = before();
  const unclean = await s.run();
  expect(unclean.out).toContain("未コミットの変更");
  await same(unclean, was);
});

test("(e) the base checked out nowhere and the branch checked out in a worktree: update-ref moves main, the worktree is detached and the branch goes", async () => {
  const s = await setup();
  s.git("switch", "-q", "--detach");
  const other = join(home!, "task-tree");
  s.git("worktree", "add", "-q", other, "sb/2-x");
  const r = await s.run();
  expect(r.code).toBe(0);
  expect(s.subjects()).toEqual(["c", "b", "a"]);
  expect(s.branches()).toEqual(["(HEAD detached at " + s.git("rev-parse", "--short", "HEAD") + ")", "main"].sort());
  expect(execFileSync("git", ["-C", other, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("");
});

test("(f) a commit that conflicts on the way although the whole merges: the rebase is taken back, nothing changes", async () => {
  const s = await setup();
  // main sets a.txt to B; the branch goes a → A → B: the end merges cleanly, its first commit does not
  writeFileSync(join(s.repo, "a.txt"), "B\n");
  s.git("commit", "-qam", "main B");
  s.git("checkout", "-q", "sb/2-x");
  writeFileSync(join(s.repo, "a.txt"), "A\n");
  s.git("commit", "-qam", "A");
  writeFileSync(join(s.repo, "a.txt"), "B\n");
  s.git("commit", "-qam", "back to B");
  s.git("checkout", "-q", "main");
  await s.mark();
  const was = [s.tip("main"), s.tip("sb/2-x")];
  const r = await s.run();
  expect(r.code).toBe(1);
  expect(r.out).toContain("rebase できない（衝突）");
  expect([s.tip("main"), s.tip("sb/2-x")]).toEqual(was);
  expect((await s.view(3)).issue.state).toBe("OPEN");
});

test("(g) a commit on the branch after it was read: main gets what was judged, the branch stays with the new commit, said as left", async () => {
  const s = await setup();
  let moved = false;
  const f = async (u: string, init?: RequestInit) => {
    const res = await fetch(u, init);
    // right after the change's detail was read
    if (!moved && /\/3\?workspaceId=/.test(u)) {
      moved = true;
      s.git("checkout", "-q", "sb/2-x");
      writeFileSync(join(s.repo, "late.txt"), "late\n");
      s.git("add", "-A");
      s.git("commit", "-q", "-m", "late");
      s.git("checkout", "-q", "main");
    }
    return res;
  };
  const r = await s.run(["3"], f);
  expect(r.code).toBe(1);
  expect(r.out).toContain("状態の更新が残った: 枝 sb/2-x の削除（判定の後に動いた");
  expect(s.subjects()).toEqual(["c", "b", "a"]);
  expect(s.git("log", "-1", "--format=%s", "sb/2-x")).toBe("late");
});

test("(g') the same with the branch checked out in a Task's worktree: that worktree stays on the branch", async () => {
  const s = await setup();
  const other = join(home!, "task-tree");
  s.git("worktree", "add", "-q", other, "sb/2-x");
  let moved = false;
  const f = async (u: string, init?: RequestInit) => {
    const res = await fetch(u, init);
    if (!moved && /\/3\?workspaceId=/.test(u)) {
      moved = true;
      writeFileSync(join(other, "late.txt"), "late\n");
      execFileSync("git", ["-C", other, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", "add", "-A"]);
      execFileSync("git", ["-C", other, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "late"]);
    }
    return res;
  };
  expect((await s.run(["3"], f)).code).toBe(1);
  expect(execFileSync("git", ["-C", other, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("sb/2-x");
});

test("(h) main moved after the judgement while checked out nowhere: it is not the tip that was judged, nothing changes", async () => {
  const s = await setup();
  s.git("switch", "-q", "--detach");
  let moved = false;
  const f = async (u: string, init?: RequestInit) => {
    const res = await fetch(u, init);
    if (!moved && /\/3\?workspaceId=/.test(u)) {
      moved = true;
      // a commit on main made from elsewhere, after main was read
      const tree = s.git("rev-parse", "main^{tree}");
      const c = execFileSync("git", ["-C", s.repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", tree, "-p", "main", "-m", "elsewhere"], { encoding: "utf8" }).trim();
      s.git("update-ref", "refs/heads/main", c);
    }
    return res;
  };
  const r = await s.run(["3"], f);
  expect(r.code).toBe(1);
  expect(r.out).toContain("main が判定の後に動いた");
  expect(s.git("log", "-1", "--format=%s", "main")).toBe("elsewhere");
  expect(s.branches()).toContain("sb/2-x");
  expect((await s.view(3)).issue.state).toBe("OPEN");
});

test("(i) the record refused after the base moved: the left line names --record, and that command records the merge and closes the Task", async () => {
  const s = await setup();
  writeFileSync(join(s.repo, "z.txt"), "z\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "z");
  await s.mark();
  const reviewed = s.tip("sb/2-x");
  // the app refuses the change's and the Task's update the first time only (a daemon that does not know the field, a cut line)
  const refused = new Set<string>();
  const f = async (u: string, init?: RequestInit) => {
    const key = `${init?.method} ${new URL(u).pathname}`;
    if (init?.method === "PATCH" && /\/(2|3)$/.test(new URL(u).pathname) && !refused.has(key)) {
      refused.add(key);
      return new Response(JSON.stringify({ error: "refused" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return fetch(u, init);
  };
  const first = await s.run(["3"], f);
  expect(first.code).toBe(1);
  const tip = s.tip("main");
  expect(s.subjects()).toEqual(["c", "b", "z", "a"]);
  expect((await s.view(3)).issue.state).toBe("OPEN");
  expect((await s.view(2)).issue.state).toBe("OPEN");
  const cmd = /bun scripts\/local-merge\.ts 3 (--record [0-9a-f]{40} --reviewed [0-9a-f]{40})/.exec(first.out);
  expect(cmd?.[1]).toBe(`--record ${tip} --reviewed ${reviewed}`);
  // a commit that was never judged landed on top: recording it as this change's merge would let forge-resync send it
  const marksBefore = (await s.view(3)).comments.length;
  writeFileSync(join(s.repo, "y.txt"), "y\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "unjudged");
  const later = await s.run(["3", "--record", s.tip("main"), "--reviewed", reviewed]);
  expect(later.code).toBe(1);
  expect(later.out).toContain("と同じでない");
  expect((await s.view(3)).issue.state).toBe("OPEN");
  expect((await s.view(3)).comments.length).toBe(marksBefore);
  s.git("reset", "-q", "--hard", tip);
  // the line that was printed, as typed
  const again = await s.run(["3", ...cmd![1]!.split(" ")]);
  expect(again.code).toBe(0);
  expect((await s.view(3)).issue).toMatchObject({ state: "CLOSED", change: { mergeCommit: tip, reviewedHead: reviewed } });
  // the mark the first run posted is not posted again; the merge time is when the base moved
  const marks = (await s.view(3)).comments.filter((c) => c.body.startsWith("[local-merge] merged "));
  expect(marks.length).toBe(1);
  expect(marks[0]!.body).toMatch(new RegExp(`^\\[local-merge\\] merged ${tip} base=[0-9a-f]{40}$`));
  expect((await s.view(3)).issue.change?.mergedAt).toBe(new Date(s.git("log", "-1", "--format=%cI", tip)).toISOString());
  expect((await s.view(2)).issue.state).toBe("CLOSED");
  // nothing else moved: main is as the merge left it
  expect(s.tip("main")).toBe(tip);
  // recorded once: a second run finds the change closed and writes nothing
  expect((await s.run(["3", ...cmd![1]!.split(" ")])).code).toBe(1);
});

test("(j) --record with a tip not on the base writes nothing", async () => {
  const s = await setup();
  const head = s.tip("sb/2-x");
  const commentsBefore = (await s.view(3)).comments.length;
  // the branch's head is not on main: it was never merged
  const r = await s.run(["3", "--record", head, "--reviewed", head]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("に入っていない");
  expect((await s.view(3)).issue).toMatchObject({ state: "OPEN", change: { mergeCommit: null } });
  expect((await s.view(3)).comments.length).toBe(commentsBefore);
  expect((await s.view(2)).issue.state).toBe("OPEN");
  expect(s.branches()).toEqual(["main", "sb/2-x"]);
  // not both values, not 40 hex: the usage
  for (const args of [["3", "--record", head], ["3", "--record", "abc", "--reviewed", head], ["3", "--reviewed", head, "--record", head]]) expect((await s.run(args)).code).toBe(2);
});

test("not judged (2): no number, another argument", async () => {
  for (const args of [[], ["x"], ["3", "--merge"]]) expect(await main(args, tmpdir(), { env: {}, log: () => {}, err: () => {} })).toBe(2);
});

test("closedBy: Closes #n, Backlog-Task: n and the branch sb/<n>-, once each, not the change itself", () => {
  expect(closedBy(9, "Closes #4\nBacklog-Task: 5\nBacklog-Task: 9", "sb/4-x")).toEqual([4, 5]);
  expect(closedBy(9, "", "feature")).toEqual([]);
});
