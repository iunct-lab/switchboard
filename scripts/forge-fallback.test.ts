// test-reads: scripts/forge-fallback.ts scripts/merge-gate.ts scripts/local-merge.ts
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueDetail, RunnerAdapter, Workspace } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer, type CoreServer } from "../packages/core/src/server.ts";
import { main as fallback, switchNote, unusable } from "./forge-fallback.ts";
import { main as localMerge } from "./local-merge.ts";
import { main as mergeGate } from "./merge-gate.ts";

// A GitHub workspace while GitHub cannot be used: the real daemon with a fake runner and a gh that always fails, a
// repository with no remote. What the switch makes, and that the local way to the merge stops where a PR's would.

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

const FAILS = {
  outage: "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
  limit: "GraphQL: API rate limit exceeded for user ID 1.",
  auth: "HTTP 401: Bad credentials (https://api.github.com/graphql)",
  input: "HTTP 422: Validation Failed (https://api.github.com/repos/acme/app/pulls)",
} as const;

/**
 * What the app's own gh sees of GitHub: "outage" = every call fails with a 502; "usable" = it answers, with budget left;
 * "limit" = it answers and the GraphQL budget is 0 until a reset ten minutes on; "auth" = every call is a 401.
 */
type Github = "outage" | "usable" | "limit" | "auth";

/** The daemon, a workspace whose Issues are GitHub's (a PBI numbered 4, its Tasks 5 and 6, as last imported) on a repository `main` → `sb/5-x` (commits b, c). */
async function setup(o: { task?: string; github?: Github; openPr?: number } = {}) {
  home = mkdtempSync(join(tmpdir(), "sb-forge-fallback-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  git("checkout", "-q", "-b", "sb/5-x");
  for (const name of ["b", "c"]) {
    writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", name);
  }
  git("checkout", "-q", "main");
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  // GitHub is away for the app too unless a test says otherwise: nothing it keeps can be sent
  const github = { state: o.github ?? ("outage" as Github) };
  const budget = (graphql: number) => JSON.stringify({ resources: { core: { remaining: 4000, reset: Math.floor(Date.now() / 1000) + 600 }, graphql: { remaining: graphql, reset: Math.floor(Date.now() / 1000) + 600 } } });
  core = await startServer(cfg, [idle], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async (args) => {
    if (github.state === "outage") throw new Error(FAILS.outage);
    if (github.state === "auth") return { code: 1, stdout: "", stderr: FAILS.auth };
    if (args.includes("rate_limit")) return { code: 0, stdout: `HTTP/2.0 200 OK\n\n${budget(github.state === "limit" ? 0 : 4000)}`, stderr: "" };
    return { code: 1, stdout: "", stderr: FAILS.input };
  } });
  const root = `http://127.0.0.1:${core.server.port}`;
  const url = `${root}/api/backlog`;
  const ws = (await (await fetch(`${root}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo }) })).json()) as Workspace;
  const source = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  core.db.setWorkspaceBacklogSource(ws.id, source);
  const issue = (number: number, title: string, labels: string[], body: string, parent: number | null, subIssues: number[] = []) => ({ objectKind: "issue" as const, externalId: `I_${number}`, fetchState: "fetched" as const, remote: { number, title, url: "", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", closedAt: null } });
  // `openPr`: an open pull request that closes Task 5, as the last import stored it before GitHub went away
  const pulls = o.openPr ? [{ objectKind: "pull-request" as const, externalId: `PR_${o.openPr}`, fetchState: "fetched" as const, remote: { number: o.openPr, state: "OPEN" as const, isDraft: false, labels: [], closes: [5], mergeCommit: null, updatedAt: "2026-01-01T00:00:00Z", files: null, closedAt: null, mergedAt: null } }] : [];
  core.db.putBacklogSnapshot(source, { records: [issue(4, "PBI: p", ["type:pbi"], "", null, [5, 6]), issue(5, "Task: b と c", ["type:task"], o.task ?? "触る場所: `b.txt`、`c.txt`", 4), issue(6, "Task: a", ["type:task"], "触る場所: `a.txt`", 4), ...pulls], cursor: null, syncedAt: Date.now() });
  // the app's records (its jobs) are read with the same address and a key file
  const tokenFile = join(home, "client-token");
  writeFileSync(tokenFile, "k\n");
  // the gate runs in the Task whose jobs `mark` records: outside a Task the person's own --allow-large would be the consent
  const env = { BACKLOG_URL: url, BACKLOG_TOKEN_FILE: tokenFile, BACKLOG_WORKSPACE: ws.id, OPS_KIT_TASK_ID: "task_x" };
  const send = async (method: string, path: string, body: object) => fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const view = async (n: number, change = false) => {
    const r = await fetch(`${url}/${n}?workspaceId=${ws.id}${change ? "&change=1" : ""}`);
    return { status: r.status, detail: (await r.json()) as BacklogIssueDetail };
  };
  const tip = (b: string) => git("rev-parse", b);
  const ghCalls: string[][] = [];
  /** forge-fallback with a gh that fails with `stderr` (undefined = succeeds). */
  const run = async (stderr: string | undefined, extra: string[] = []) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await fallback(["--task", "5", "--pbi", "4", "--head", "sb/5-x", ...extra, "--", "pr", "create", "--fill"], repo, {
      env, log: (s) => out.push(s), err: (s) => err.push(s),
      gh: async (args) => (ghCalls.push(args), stderr === undefined ? { code: 0, stdout: "https://github.com/acme/app/pull/77\n", stderr: "" } : { code: 1, stdout: "", stderr }),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  /** The marks a merge needs, on the change. */
  const mark = async (n = 1) => {
    const at = Date.now();
    const base = { taskId: "task_x", pr: n, cwd: repo, startedAt: at, repo: `local:${ws.id}`, as: null, kinds: [] };
    const review = core!.db.insertJob({ ...base, kind: "review", runner: "claude", head: tip("sb/5-x") });
    core!.db.finishJob(review.id, { status: "pass", exitCode: 0, summary: "", endedAt: at });
    core!.db.setJobResult(review.id, { result: { review: { findings: [], firstLine: "[claude] review" } } });
    const ci = core!.db.insertJob({ ...base, kind: "local-ci", runner: null, head: null });
    core!.db.finishJob(ci.id, { status: "pass", exitCode: 0, summary: "", endedAt: at });
    core!.db.setJobResult(ci.id, { head: tip("sb/5-x"), base: tip("main"), result: { ci: { outcome: "pass" } } });
  };
  const noGh = async () => { throw new Error("gh called"); };
  const gate = async (n = 1, extra: string[] = []) => {
    const out: string[] = [];
    const code = await mergeGate(["--change", String(n), ...extra], noGh, (s) => out.push(s), (s) => out.push(s), () => undefined, noGh, repo, { env });
    return { code, out: out.join("\n") };
  };
  const merge = async (n = 1, extra: string[] = []) => {
    const out: string[] = [];
    const code = await localMerge([String(n), ...extra], repo, { env, cache: home!, log: (s) => out.push(s), err: (s) => out.push(s), now: () => new Date("2026-01-02T00:00:00Z") });
    return { code, out: out.join("\n") };
  };
  const subjects = () => git("log", "--format=%s", "main").split("\n");
  /** What the local merges put on the base's landing ref (the branch `main` and its work tree are never moved in a GitHub workspace); [] = nothing landed. */
  const landed = () => { try { return git("log", "--format=%s", "refs/switchboard/landed/main").split("\n"); } catch { return []; } };
  return { repo, git, ws, source, view, tip, run, mark, gate, merge, subjects, landed, ghCalls, send, github, url };
}

test("unusable: the kit's classes switch; a refusal of the input does not", () => {
  // a login or permission failure never asks for the switch: waiting does not mend it
  expect([FAILS.outage, FAILS.limit, FAILS.auth, FAILS.input, "HTTP 403: Resource not accessible by personal access token (https://api.github.com/repos/o/r/commits/x/check-runs)", "HTTP 404: Not Found (https://api.github.com/repos/o/r)", "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com"].map((e) => unusable("", e, 0))).toEqual(["transient", "primary", null, null, null, null, "network"]);
  expect(switchNote("transient", "HTTP 502", 3, "sb/5-x")).toContain("ローカルの変更 L3（sb/5-x）");
});

test("(a) an outage: a change of the branch is made apart from GitHub's Issues, the switch is written on the Task and the PBI, and the local way merges it", async () => {
  const s = await setup();
  const r = await s.run(FAILS.outage);
  expect([r.code, r.out]).toEqual([3, "L1"]);
  // gh was asked once, and not again for the switch
  expect(s.ghCalls).toEqual([["pr", "create", "--fill"]]);
  const change = await s.view(1, true);
  expect(change.detail.issue).toMatchObject({ number: 1, title: "Task: b と c", state: "OPEN", body: expect.stringContaining("Closes #5"), change: { head: "sb/5-x", base: "main", pr: null } });
  for (const n of [5, 4]) expect((await s.view(n)).detail.comments.map((c) => c.body)).toEqual([expect.stringContaining("GitHub が使えないため（障害 transient: HTTP 502: Bad Gateway")]);
  expect((await s.view(5)).detail.comments[0]!.body).toContain("ローカルの変更 L1（sb/5-x）に切り替えました");
  // not mergeable yet: no review, no CI — as a PR
  expect((await s.gate()).code).toBe(1);
  expect((await s.merge()).code).toBe(1);
  expect(s.subjects()).toEqual(["a"]);
  await s.mark();
  expect((await s.gate()).code).toBe(0);
  const head = s.tip("sb/5-x");
  const base = s.tip("main");
  const merged = await s.merge();
  expect(merged.code).toBe(0);
  // the merge landed on the base's landing ref: the branch main and the work tree that has it checked out did not move
  expect(s.landed()).toEqual(["c", "b", "a"]);
  expect([s.subjects(), s.tip("main"), s.git("status", "--porcelain", "--untracked-files=no"), s.git("rev-parse", "--abbrev-ref", "HEAD")]).toEqual([["a"], base, "", "main"]);
  expect(merged.out).toContain("ops-kit pull-main");
  expect((await s.view(1, true)).detail.issue).toMatchObject({ state: "CLOSED", change: { mergeCommit: head, reviewedHead: head, reportedAt: null } });
  expect((await s.view(1, true)).detail.comments.map((c) => c.body)).toContain(`[local-merge] merged ${head} base=${base}`);
  // the Task is not closed here: a close kept now would reach GitHub before the code does (forge-resync --report closes it)
  expect((await s.view(5)).detail.issue.state).toBe("OPEN");
  expect((await s.view(1)).status).toBe(404);
  // nothing of the change itself waits to go to GitHub: only the two comments of the switch
  const kept = core!.db.listBacklogOperations(s.source);
  expect(kept.map((o) => `${o.kind} ${o.field ?? ""}`.trim()).sort()).toEqual(["comment", "comment"]);
  expect(kept.every((o) => o.issue === "I_5" || o.issue === "I_4")).toBe(true);
});

test("(a) a limit GitHub gives an end for switches too", async () => {
  const s = await setup({ github: "limit" });
  expect((await s.run(FAILS.limit)).code).toBe(3);
  expect((await s.view(1, true)).status).toBe(200);
  expect((await s.view(5)).detail.comments[0]!.body).toContain("上限 primary");
});

test("an expired login or a missing permission never switches: gh's failure (1), no change, no comment — also when asked of the app directly", async () => {
  for (const stderr of [FAILS.auth, "HTTP 403: Resource not accessible by personal access token (https://api.github.com/repos/acme/app/commits/x/check-runs)", "HTTP 404: Not Found (https://api.github.com/repos/acme/app/pulls/9)"]) {
    const s = await setup({ github: "auth" });
    const r = await s.run(stderr);
    expect([stderr, r.code]).toEqual([stderr, 1]);
    expect((await s.view(1, true)).status).toBe(404);
    for (const n of [5, 4]) expect((await s.view(n)).detail.comments).toEqual([]);
    // the same change asked of the app without the script (`ops-kit backlog create --head … --base …`): the app's own call is a 401
    const direct = await s.send("POST", "", { workspaceId: s.ws.id, title: "t", body: "Closes #5", change: { head: "sb/5-x", base: "main" } });
    expect([direct.status, ((await direct.json()) as { error: string }).error]).toEqual([409, expect.stringContaining("認証か権限の失敗")]);
    expect((await s.view(1, true)).status).toBe(404);
    await core!.stop();
    rmSync(home!, { recursive: true, force: true });
    core = home = undefined;
  }
});

test("the switch rests on what the app itself sees, not on what a Task's command printed: with GitHub answering no change is made", async () => {
  const s = await setup({ github: "usable" });
  // the Task's gh printed an outage (or the Task says so): the app asks GitHub itself, and GitHub answers
  const r = await s.run(FAILS.outage);
  expect([r.code, r.err]).toEqual([2, expect.stringContaining("GitHub は使えます")]);
  // and straight to the API, as `ops-kit backlog create --head … --base …` does
  const direct = await s.send("POST", "", { workspaceId: s.ws.id, title: "t", body: "Closes #5", change: { head: "sb/5-x", base: "main" } });
  expect([direct.status, ((await direct.json()) as { error: string }).error]).toEqual([409, expect.stringContaining("GitHub は使えます")]);
  expect((await s.view(1, true)).status).toBe(404);
  for (const n of [5, 4]) expect((await s.view(n)).detail.comments).toEqual([]);
  // a limit the command printed, while GitHub's budget is not at 0: no end to wait for, no change
  expect((await s.run(FAILS.limit)).code).toBe(2);
  expect((await s.view(1, true)).status).toBe(404);
});

test("GitHub is back before the local merge: the change is not merged here, nothing lands", async () => {
  const s = await setup();
  expect((await s.run(FAILS.outage)).code).toBe(3);
  await s.mark();
  expect((await s.gate()).code).toBe(0);
  s.github.state = "usable";
  const back = await s.merge();
  expect([back.code, back.out.includes("GitHub は使えます"), s.landed(), s.subjects()]).toEqual([1, true, [], ["a"]]);
  expect((await s.view(1, true)).detail.issue.state).toBe("OPEN");
  // nor when the app's own call is a login failure: that is not an outage
  s.github.state = "auth";
  const denied = await s.merge();
  expect([denied.code, s.landed()]).toEqual([1, []]);
});

test("a [merge-answer] yes is not kept on a GitHub workspace's change, however it is spelled and whoever posts it: an ask reason cannot be lifted here", async () => {
  const s = await setup();
  s.git("checkout", "-q", "sb/5-x");
  mkdirSync(join(s.repo, "scripts"));
  writeFileSync(join(s.repo, "scripts", "merge-gate.ts"), "// gate\n");
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "gate");
  s.git("checkout", "-q", "main");
  core!.db.putBacklogSnapshot(s.source, { records: core!.db.listBacklogRecords(s.source, "issue").map((r) => (r.externalId === "I_5" ? { ...r, remote: { ...(r.remote as object), body: "触る場所: `b.txt`、`c.txt`、`scripts/merge-gate.ts`" } } : r)) as never, cursor: null, syncedAt: Date.now() });
  expect((await s.run(FAILS.outage)).code).toBe(3);
  await s.mark();
  const head = s.tip("sb/5-x");
  // straight to the app's API, past the kit's command: the reviewer's leading space, and other spellings the store or a reader would fold
  for (const text of [`[merge-answer] yes security:gates ${head}`, ` [merge-answer] yes security:gates ${head}`, `\t[merge-answer] yes security:gates ${head}`, `\uFEFF[merge-answer] yes security:gates ${head}`, `［merge-answer］ YES security:gates ${head}`, `[merge\u200B-answer] yes security:gates ${head}`]) {
    const r = await s.send("POST", "/1/comment?change=1", { workspaceId: s.ws.id, text });
    expect([text, r.status]).toEqual([text, 422]);
  }
  expect((await s.view(1, true)).detail.comments.some((c) => c.body.includes("merge-answer"))).toBe(false);
  const g = await s.gate(1, ["--allow-large"]);
  // the app holds no grant of the change's head (the yes was refused), so the flag lifts nothing in the Task
  expect([g.code, g.out.includes("[聞く]") && g.out.includes("利用者の許可の記録が無い: security:gates")]).toEqual([1, true]);
  expect((await s.merge(1, ["--allow-large"])).code).toBe(1);
  expect(s.landed()).toEqual([]);
});

test("a pull request the app already knows for the Task, or a branch that was pushed, stops the local merge without the Task naming it: its review threads cannot be read", async () => {
  // the last import stored open PR 40 that closes Task 5; the Task switches without --pr
  const known = await setup({ openPr: 40 });
  expect((await known.run(FAILS.outage)).code).toBe(3);
  expect((await known.view(1, true)).detail.issue.change).toMatchObject({ pr: null });
  await known.mark();
  const g = await known.gate();
  expect([g.code, g.out.includes("PR #40 のレビュースレッドを読めない")]).toEqual([1, true]);
  for (const extra of [[], ["--allow-large"]]) expect((await known.merge(1, extra)).code).toBe(1);
  expect(known.landed()).toEqual([]);
  await core!.stop();
  rmSync(home!, { recursive: true, force: true });
  core = home = undefined;
  // no PR stored, but the branch has been pushed to origin: a PR of it may exist that nothing here has
  const pushed = await setup();
  pushed.git("update-ref", "refs/remotes/origin/sb/5-x", pushed.tip("sb/5-x"));
  expect((await pushed.run(FAILS.outage)).code).toBe(3);
  await pushed.mark();
  const p = await pushed.gate();
  expect([p.code, p.out.includes("origin に push 済み")]).toEqual([1, true]);
  expect((await pushed.merge()).code).toBe(1);
  expect(pushed.landed()).toEqual([]);
});

test("(b, c) a refusal of the input is gh's failure (1), a success is a success (0): no change, no comment", async () => {
  const s = await setup();
  const refused = await s.run(FAILS.input);
  expect([refused.code, refused.err]).toEqual([1, FAILS.input]);
  const ok = await s.run(undefined);
  expect([ok.code, ok.out]).toEqual([0, "https://github.com/acme/app/pull/77"]);
  expect((await s.view(1, true)).status).toBe(404);
  for (const n of [5, 4]) expect((await s.view(n)).detail.comments).toEqual([]);
});

test("(d) a second failure on the same branch goes on with the change there and writes nothing twice", async () => {
  const s = await setup();
  expect((await s.run(FAILS.outage)).code).toBe(3);
  const again = await s.run(FAILS.limit);
  expect([again.code, again.out]).toEqual([3, "L1"]);
  expect((await s.view(2, true)).status).toBe(404);
  expect((await s.view(5)).detail.comments).toHaveLength(1);
});

test("(e) a change that stands in for a PR is kept and commented, but not merged here: its review threads cannot be read", async () => {
  const s = await setup();
  expect((await s.run(FAILS.outage, ["--pr", "77"])).code).toBe(3);
  expect((await s.view(1, true)).detail.issue.change).toMatchObject({ pr: 77 });
  await s.mark();
  const g = await s.gate();
  expect(g.code).toBe(1);
  expect(g.out).toContain("PR #77 のレビュースレッドを読めない");
  for (const extra of [[], ["--allow-large"]]) expect((await s.merge(1, extra)).code).toBe(1);
  expect(s.subjects()).toEqual(["a"]);
  expect((await s.view(1, true)).detail.issue.state).toBe("OPEN");
  expect((await s.view(5)).detail.issue.state).toBe("OPEN");
});

test("(f) a file the Task does not name does not stop the local merge: the gate merges and lists it in notes", async () => {
  const s = await setup({ task: "触る場所: `b.txt`" });
  expect((await s.run(FAILS.outage)).code).toBe(3);
  await s.mark();
  const g = await s.gate();
  expect(g.code).toBe(0);
  expect(g.out).toContain("Task #5 の名指しの外: c.txt");
});

test("usage (2): a missing Task, PBI, branch or gh command", async () => {
  const err: string[] = [];
  const env = { BACKLOG_URL: "http://127.0.0.1:1/api/backlog" };
  const gh = async () => { throw new Error("gh called"); };
  for (const argv of [["--task", "5", "--pbi", "4", "--head", "sb/5-x"], ["--task", "5", "--head", "sb/5-x", "--", "pr", "view"], ["--task", "x", "--pbi", "4", "--head", "b", "--", "pr", "view"], ["--task", "5", "--pbi", "4", "--head", "b", "--pr", "x", "--", "pr", "view"]])
    expect(await fallback(argv, ".", { env, gh, err: (s) => err.push(s) })).toBe(2);
  expect(err.every((e) => e.startsWith("usage:"))).toBe(true);
});

test("the switch cannot be made (the app is not reached): 2, with gh's line", async () => {
  const err: string[] = [];
  const code = await fallback(["--task", "5", "--pbi", "4", "--head", "sb/5-x", "--", "pr", "create"], ".", { env: { BACKLOG_URL: "http://127.0.0.1:1/api/backlog", BACKLOG_WORKSPACE: "ws" }, gh: async () => ({ code: 1, stdout: "", stderr: FAILS.outage }), err: (s) => err.push(s), log: () => {} });
  expect(code).toBe(2);
  expect(err.join("\n")).toContain("切り替えられなかった");
  expect(err.join("\n")).toContain("HTTP 502");
});
