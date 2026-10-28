import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogRepositoryKey } from "@switchboard/protocol";
import { BacklogError, type GhRunner } from "./backlog.ts";
import { BacklogSync, HINT_BUDGET, importGithubSnapshot, noticeTargets } from "./backlog-sync.ts";
import { scanAllRepos } from "./secretscan.ts";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { Db } from "./db.ts";
import { githubHost, type GithubCallMetric } from "../../../ops-kit/src/gh.ts";

// Importing the GitHub backlog into the database (#885): complete or not at all; closed, 404 and 403 told apart.

let dir: string;
let db: Db;
const syncs: BacklogSync[] = [];
function makeSync(...args: ConstructorParameters<typeof BacklogSync>): BacklogSync {
  const sync = new BacklogSync(...args);
  syncs.push(sync);
  return sync;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-sync-"));
  db = new Db(join(dir, "switchboard.db"));
});
afterEach(() => {
  for (const sync of syncs.splice(0)) sync.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const KEY: BacklogRepositoryKey = { service: "github", host: githubHost(), repository: "acme/app" };
const WS = { id: "ws_app", path: "/Users/dev/app" };

const item = (n: number, status: string) => ({
  id: `PVTI_${n}`, project: { number: 1, owner: { login: "acme" } },
  fieldValues: { totalCount: 3, nodes: [{ name: status, field: { name: "Status" } }, { number: 5, field: { name: "Story Points" } }, {}] },
});
const raw = (n: number, over: Record<string, unknown> = {}) => ({
  id: `I_${n}`, number: n, title: `PBI ${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", body: `body ${n}`,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: `2026-10-0${n % 9 || 1}T00:00:00Z`, milestone: { title: "Phase 2" }, parent: null,
  labels: { totalCount: 1, nodes: [{ name: "type:pbi" }] }, subIssues: { totalCount: 1, nodes: [{ number: n + 100 }] },
  comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: `C_${n}_1`, body: "## 回答\nA", createdAt: "2026-10-02T00:00:00Z" }] },
  projectItems: { totalCount: 1, nodes: [item(n, "Ready")] },
  ...over,
});
const pageOf = (nodes: unknown[], next: string | null = null, pulls: unknown[] = [], pullsNext: string | null = null) => ({
  data: { repository: { issues: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes }, pullRequests: { pageInfo: { hasNextPage: !!pullsNext, endCursor: pullsNext }, nodes: pulls } } },
});

/** What the fake GitHub answers; each handler gets the query's variables. A handler that throws answers like a failed gh. */
interface World {
  changed: (v: Record<string, string>) => unknown;
  open: (v: Record<string, string>) => unknown;
  comments?: (v: Record<string, string>) => unknown;
  recheck?: (numbers: number[]) => { body: unknown; code?: number };
}

function fakeGh(world: World) {
  const calls: string[] = [];
  const gh: GhRunner = async (args) => {
    if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/orgs/acme/projects/1\n", stderr: "" };
    const query = args.find((a) => a.startsWith("query="))!.slice(6);
    const vars = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "-f" || args[i - 1] === "-F") && !a.startsWith("query=") ? [a.split(/=(.*)/s).slice(0, 2)] : []));
    const kind = query.includes("issueOrPullRequest") ? "recheck" : query.includes("issue(number:$n)") ? "comments" : query.includes("states:[OPEN,CLOSED]") ? "changed" : "open";
    calls.push(`${kind}${vars.after ? `@${vars.after}` : ""}${vars.since ? ` since ${vars.since}` : ""}`);
    try {
      if (kind === "recheck") {
        const r = world.recheck!([...query.matchAll(/w(\d+): /g)].map((m) => Number(m[1])));
        return { code: r.code ?? 0, stdout: JSON.stringify(r.body), stderr: r.code ? "gh: GraphQL error" : "" };
      }
      return { code: 0, stdout: JSON.stringify(world[kind]!(vars)), stderr: "" };
    } catch (e) {
      return { code: 1, stdout: "", stderr: (e as Error).message };
    }
  };
  return { gh, calls };
}

const stored = () => Object.fromEntries(db.listBacklogRecords(KEY).map((r) => [`${r.objectKind}:${r.externalId}`, { state: r.fetchState, remote: r.remote }]));

test("the first import reads every page and every comment page, then stores Issues, comments and Project fields", async () => {
  const twelve = raw(12, { comments: { pageInfo: { hasNextPage: true, endCursor: "cc1" }, nodes: [{ id: "C_12_1", body: "first", createdAt: "2026-10-02T00:00:00Z" }] } });
  const { gh, calls } = fakeGh({
    changed: (v) => (v.after ? pageOf([raw(13, { state: "CLOSED", labels: { totalCount: 1, nodes: [{ name: "type:task" }] }, parent: { number: 12 } })]) : pageOf([twelve], "p2")),
    comments: (v) => ({ data: { repository: { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "C_12_2", body: "second", createdAt: "2026-10-03T00:00:00Z" }] } } } } }),
    open: () => pageOf([{ number: 12, projectItems: { totalCount: 1, nodes: [item(12, "Ready")] } }]),
  });
  db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  await importGithubSnapshot(gh, db, WS, 1000);
  expect(calls).toEqual(["changed", "comments@cc1", "changed@p2", "open"]);
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual({ ...KEY, project: { owner: "acme", number: 1 }, private: true });
  const s = stored();
  expect(s["issue:I_12"]!.remote).toEqual({
    number: 12, title: "PBI 12", url: "https://github.com/acme/app/issues/12", state: "OPEN", body: "body 12", labels: ["type:pbi"], milestone: "Phase 2",
    parent: null, subIssues: [112], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", stateReason: null, closedAt: null,
  });
  expect(s["issue:I_13"]!.remote).toMatchObject({ state: "CLOSED", parent: 12, labels: ["type:task"] });
  expect(Object.keys(s).filter((k) => k.startsWith("comment:"))).toEqual(["comment:C_12_1", "comment:C_12_2", "comment:C_13_1"]);
  expect(s["project-item:PVTI_12"]!.remote).toEqual({ issue: 12, owner: "acme", project: 1, fields: { Status: "Ready", "Story Points": 5 } });
  expect(db.getBacklogRepository(KEY)).toEqual({ ...KEY, cursor: "2026-10-04T00:00:00Z", lastSuccessfulSync: 1000, retryAt: null });
});

test("a failure on the second page, a comment page or the Project read stores nothing and keeps the last sync", async () => {
  const ok = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([{ number: 12, projectItems: { totalCount: 1, nodes: [item(12, "Ready")] } }]) });
  await importGithubSnapshot(ok.gh, db, WS, 1000);
  const before = db.listBacklogRecords(KEY);
  const fail = () => {
    throw new Error("gh: HTTP 502");
  };
  const worlds: World[] = [
    { changed: (v) => (v.after ? fail() : pageOf([raw(12, { title: "changed" })], "p2")), open: () => pageOf([]) },
    { changed: () => pageOf([raw(12, { title: "changed", comments: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [] } })]), comments: fail, open: () => pageOf([]) },
    { changed: () => pageOf([raw(12, { title: "changed" })]), open: fail },
    { changed: () => pageOf([raw(12, { title: "changed", labels: { totalCount: 150, nodes: [{ name: "type:pbi" }] } })]), open: () => pageOf([]) },
  ];
  for (const world of worlds) {
    await expect(importGithubSnapshot(fakeGh(world).gh, db, WS, 2000)).rejects.toThrow();
    expect(db.listBacklogRecords(KEY)).toEqual(before);
    expect(db.getBacklogRepository(KEY)).toMatchObject({ cursor: "2026-10-03T00:00:00Z", lastSuccessfulSync: 1000 });
  }
});

test("the next import asks since the cursor; a close, a Project field change and a removed comment or item are stored", async () => {
  const first = fakeGh({
    changed: () => pageOf([raw(12, { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "C_a", body: "a", createdAt: "2026-10-02T00:00:00Z" }, { id: "C_b", body: "b", createdAt: "2026-10-02T01:00:00Z" }] } }), raw(14)]),
    open: () => pageOf([12, 14].map((n) => ({ number: n, projectItems: { totalCount: 1, nodes: [item(n, "Ready")] } }))),
  });
  await importGithubSnapshot(first.gh, db, WS, 1000);

  const next = fakeGh({
    // #12 closed and one comment deleted; #14 unchanged but its Status moved and then it left the Project
    changed: () => pageOf([raw(12, { state: "CLOSED", updatedAt: "2026-10-05T00:00:00Z", comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "C_a", body: "a", createdAt: "2026-10-02T00:00:00Z" }] } })]),
    open: () => pageOf([{ number: 14, projectItems: { totalCount: 0, nodes: [] } }]),
  });
  await importGithubSnapshot(next.gh, db, WS, 2000);
  expect(next.calls).toEqual(["changed since 2026-10-05T00:00:00Z", "open"]);
  const s = stored();
  expect(s["issue:I_12"]).toMatchObject({ state: "fetched", remote: { state: "CLOSED" } });
  expect(s["comment:C_b"]).toEqual({ state: "unavailable", remote: { issue: 12, body: "b", createdAt: "2026-10-02T01:00:00Z" } });
  expect(s["project-item:PVTI_14"]).toMatchObject({ state: "unavailable", remote: { fields: { Status: "Ready" } } });
  expect(db.getBacklogRepository(KEY)).toMatchObject({ cursor: "2026-10-05T00:00:00Z", lastSuccessfulSync: 2000 });

  const moved = fakeGh({ changed: () => pageOf([]), open: () => pageOf([{ number: 14, projectItems: { totalCount: 1, nodes: [item(14, "In progress")] } }]) });
  await importGithubSnapshot(moved.gh, db, WS, 3000);
  expect(stored()["project-item:PVTI_14"]).toEqual({ state: "fetched", remote: { issue: 14, owner: "acme", project: 1, fields: { Status: "In progress", "Story Points": 5 } } });
  expect(db.getBacklogRepository(KEY)).toMatchObject({ cursor: "2026-10-05T00:00:00Z", lastSuccessfulSync: 3000 });
});

test("an open Issue gone from both lists is asked by number: 404 and 403 mark it, an answer replaces it, nothing is erased", async () => {
  await importGithubSnapshot(fakeGh({ changed: () => pageOf([raw(12), raw(14), raw(15)]), open: () => pageOf([]) }).gh, db, WS, 1000);
  const asked: number[][] = [];
  const { gh } = fakeGh({
    changed: () => pageOf([]),
    open: () => pageOf([]),
    recheck: (numbers) => {
      asked.push(numbers);
      return {
        code: 1,
        body: {
          data: { repository: { w12: null, w14: null, w15: { __typename: "Issue", ...raw(15, { labels: { totalCount: 0, nodes: [] } }) } } },
          errors: [{ type: "NOT_FOUND", path: ["repository", "w12"], message: "Could not resolve" }, { type: "FORBIDDEN", path: ["repository", "w14"], message: "no access" }],
        },
      };
    },
  });
  await importGithubSnapshot(gh, db, WS, 2000);
  expect(asked).toEqual([[12, 14, 15]]);
  const s = stored();
  expect(s["issue:I_12"]).toMatchObject({ state: "unavailable", remote: { number: 12, title: "PBI 12" } });
  expect(s["issue:I_14"]).toMatchObject({ state: "forbidden", remote: { number: 14 } });
  expect(s["issue:I_15"]).toMatchObject({ state: "fetched", remote: { labels: [] } });
  expect(s["comment:C_12_1"]).toMatchObject({ state: "fetched" });
  expect(db.getBacklogRepository(KEY)).toMatchObject({ lastSuccessfulSync: 2000 });

  // an error that is not about one number fails the whole import
  const broken = fakeGh({ changed: () => pageOf([]), open: () => pageOf([]), recheck: () => ({ code: 1, body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"] }] } }) });
  await expect(importGithubSnapshot(broken.gh, db, WS, 3000)).rejects.toThrow("gh api graphql");
  expect(db.getBacklogRepository(KEY)).toMatchObject({ lastSuccessfulSync: 2000 });
});

const openPr = (n: number, over: Record<string, unknown> = {}) => ({
  id: `PR_${n}`, number: n, state: "OPEN", isDraft: false, updatedAt: "2026-10-05T00:00:00Z", headRefName: `sb/${n}-x`, body: "",
  labels: { totalCount: 1, nodes: [{ name: "needs-decision" }] }, files: { totalCount: 1, nodes: [{ path: "a.ts" }] },
  ...over,
});

test("open pull requests are stored with their files on the open read: no call is added, a cut list is null, one gone is asked again", async () => {
  let pulls: unknown[] = [openPr(50, { isDraft: true }), openPr(51, { files: { totalCount: 120, nodes: [{ path: "b.ts" }] } })];
  const { gh, calls } = fakeGh({
    changed: () => pageOf([raw(12)]),
    open: () => pageOf([{ number: 12, projectItems: { totalCount: 1, nodes: [item(12, "Ready")] } }], null, pulls),
    recheck: () => ({ body: { data: { repository: { w51: openPr(51, { __typename: "PullRequest", state: "CLOSED" }) } } } }),
  });
  await importGithubSnapshot(gh, db, WS, 1000);
  expect(calls).toEqual(["changed", "open"]);
  expect(stored()["pull-request:PR_50"]?.remote).toEqual({ number: 50, state: "OPEN", isDraft: true, labels: ["needs-decision"], closes: [50], mergeCommit: null, updatedAt: "2026-10-05T00:00:00Z", files: ["a.ts"], closedAt: null, mergedAt: null });
  expect(stored()["pull-request:PR_51"]?.remote).toMatchObject({ files: null });
  pulls = [openPr(50, { isDraft: true })];
  await importGithubSnapshot(gh, db, WS, 2000);
  expect(calls.slice(2)).toEqual(["changed since 2026-10-03T00:00:00Z", "open", "recheck"]);
  expect(stored()["pull-request:PR_51"]?.remote).toMatchObject({ state: "CLOSED" });
});

test("more than 50 open pull requests: the pages after the first are read by cursor, and all are stored", async () => {
  const first = Array.from({ length: 50 }, (_, i) => openPr(200 + i));
  const { gh, calls } = fakeGh({
    changed: () => pageOf([raw(12)]),
    open: (v) => (v.after ? pageOf([], null, [openPr(250)]) : pageOf([{ number: 12, projectItems: { totalCount: 1, nodes: [item(12, "Ready")] } }], null, first, "p1")),
  });
  await importGithubSnapshot(gh, db, WS, 1000);
  expect(calls.filter((c) => c.startsWith("open"))).toEqual(["open", "open@p1"]);
  expect(Object.keys(stored()).filter((k) => k.startsWith("pull-request:"))).toHaveLength(51);
  expect(stored()["pull-request:PR_250"]?.remote).toMatchObject({ number: 250, state: "OPEN" });
});

test("a pull request gone from the open list is asked again until it answers: a refused read (403) is asked again too", async () => {
  let pulls: unknown[] = [openPr(50)];
  let answer: "forbidden" | "closed" = "forbidden";
  const { gh } = fakeGh({
    changed: () => pageOf([raw(12)]),
    open: () => pageOf([{ number: 12, projectItems: { totalCount: 1, nodes: [item(12, "Ready")] } }], null, pulls),
    recheck: () => ({ body: answer === "forbidden" ? { data: { repository: { w50: null } }, errors: [{ type: "FORBIDDEN", path: ["repository", "w50"], message: "no" }] } : { data: { repository: { w50: openPr(50, { __typename: "PullRequest", state: "CLOSED" }) } } }, code: answer === "forbidden" ? 1 : 0 }),
  });
  await importGithubSnapshot(gh, db, WS, 1000);
  pulls = [];
  await importGithubSnapshot(gh, db, WS, 2000);
  expect(stored()["pull-request:PR_50"]?.state).toBe("forbidden");
  answer = "closed";
  await importGithubSnapshot(gh, db, WS, 3000);
  expect(stored()["pull-request:PR_50"]).toMatchObject({ state: "fetched", remote: { state: "CLOSED" } });
});

test("the pull requests an open PBI waits for are stored with their state", async () => {
  const pbi = raw(12, { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "C_r", body: "後回し\n<!-- pbi-complete:release waits=40,13 -->", createdAt: "2026-10-02T00:00:00Z" }] } });
  const { gh, calls } = fakeGh({
    changed: () => pageOf([pbi]),
    open: () => pageOf([{ number: 12, projectItems: { totalCount: 1, nodes: [item(12, "In progress")] } }, { number: 13, projectItems: { totalCount: 0, nodes: [] } }]),
    recheck: () => ({ body: { data: { repository: { w40: { __typename: "PullRequest", id: "PR_40", number: 40, state: "MERGED", isDraft: false, updatedAt: "2026-10-01T00:00:00Z", files: { totalCount: 0, nodes: [] }, body: "Fixes #13, closes #13", headRefName: "sb/12-x", labels: { totalCount: 1, nodes: [{ name: "x" }] } } } } } }),
  });
  await importGithubSnapshot(gh, db, WS, 1000);
  expect(calls).toEqual(["changed", "open", "recheck"]); // #13 is open: its state is known without asking
  expect(stored()["pull-request:PR_40"]).toEqual({ state: "fetched", remote: { number: 40, state: "MERGED", isDraft: false, labels: ["x"], closes: [12, 13], mergeCommit: null, updatedAt: expect.any(String), files: [], closedAt: null, mergedAt: null } });
});

test("a wait on a closed Issue is answered by what is stored; a pull request whose labels were cut fails the import", async () => {
  const release = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "C_r", body: "<!-- pbi-complete:release waits=13,40 -->", createdAt: "2026-10-02T00:00:00Z" }] };
  const asked: number[][] = [];
  const pr = (labels: unknown) => ({ body: { data: { repository: { w40: { __typename: "PullRequest", id: "PR_40", number: 40, state: "OPEN", isDraft: false, updatedAt: "2026-10-01T00:00:00Z", files: { totalCount: 0, nodes: [] }, labels } } } } });
  const world = (labels: unknown, changed: unknown[]): World => ({
    changed: () => pageOf(changed),
    open: () => pageOf([{ number: 12, projectItems: { totalCount: 0, nodes: [] } }]),
    recheck: (numbers) => {
      asked.push(numbers);
      const w13 = { __typename: "Issue", ...raw(13, { state: "CLOSED", labels: { totalCount: 0, nodes: [] } }) };
      return { body: { data: { repository: { ...pr(labels).body.data.repository, ...(numbers.includes(13) ? { w13 } : {}) } } } };
    },
  });
  await importGithubSnapshot(fakeGh(world({ totalCount: 0, nodes: [] }, [raw(12, { comments: release }), raw(13, { state: "CLOSED", labels: { totalCount: 1, nodes: [{ name: "type:task" }] } })])).gh, db, WS, 1000);
  // the next import has no update: #13 is closed in storage, so only the pull request is asked
  await importGithubSnapshot(fakeGh(world({ totalCount: 0, nodes: [] }, [])).gh, db, WS, 2000);
  expect(asked).toEqual([[40], [40]]);
  // a closed Issue without a type label would not come back in any list when reopened: it is asked again
  db.sqlite.query("UPDATE backlog_records SET remote = json_set(remote, '$.labels', json('[]')) WHERE external_id = 'I_13'").run();
  await importGithubSnapshot(fakeGh(world({ totalCount: 0, nodes: [] }, [])).gh, db, WS, 2500);
  expect(asked.at(-1)).toEqual([13, 40]);
  await expect(importGithubSnapshot(fakeGh(world({ totalCount: 120, nodes: [] }, [])).gh, db, WS, 3000)).rejects.toThrow("#40 のラベル");
  expect(db.getBacklogRepository(KEY)).toMatchObject({ lastSuccessfulSync: 2500 });
});

test("the prerequisites of open PBIs and Tasks are stored: a pull request with its merge commit, an Issue with how it closed, a 404 as unavailable", async () => {
  const task = raw(20, { body: "**前提**: #40（リリース）, #41, #42", labels: { totalCount: 1, nodes: [{ name: "type:task" }] }, parent: { number: 12 } });
  const pbi = raw(12, { body: "**前提**: #13\n```\n**前提**: #99\n```" });
  const asked: number[][] = [];
  const world = (gone: boolean): World => ({
    changed: () => pageOf(gone ? [] : [pbi, task]),
    open: () => pageOf([{ number: 12, projectItems: { totalCount: 0, nodes: [] } }, { number: 20, projectItems: { totalCount: 0, nodes: [] } }]),
    recheck: (numbers) => {
      asked.push(numbers);
      const repository: Record<string, unknown> = {
        w13: { __typename: "Issue", ...raw(13, { state: "CLOSED", stateReason: "COMPLETED", labels: { totalCount: 0, nodes: [] } }) },
        w40: { __typename: "PullRequest", id: "PR_40", number: 40, state: "MERGED", isDraft: false, updatedAt: "2026-10-01T00:00:00Z", files: { totalCount: 0, nodes: [] }, body: "", headRefName: "sb/30-x", mergeCommit: { oid: "abc123" }, labels: { totalCount: 0, nodes: [] } },
        w41: { __typename: "Issue", ...raw(41, { state: "CLOSED", stateReason: "NOT_PLANNED", labels: { totalCount: 0, nodes: [] } }) },
        w42: gone ? null : { __typename: "Issue", ...raw(42, { labels: { totalCount: 0, nodes: [] } }) },
      };
      return { code: gone ? 1 : 0, body: { data: { repository }, ...(gone ? { errors: [{ type: "NOT_FOUND", path: ["repository", "w42"] }] } : {}) } };
    },
  });
  await importGithubSnapshot(fakeGh(world(false)).gh, db, WS, 1000);
  expect(asked).toEqual([[13, 40, 41, 42]]); // the fenced #99 is not a prerequisite
  let s = stored();
  expect(s["pull-request:PR_40"]).toEqual({ state: "fetched", remote: { number: 40, state: "MERGED", isDraft: false, labels: [], closes: [30], mergeCommit: "abc123", updatedAt: expect.any(String), files: [], closedAt: null, mergedAt: null } });
  expect(s["issue:I_41"]).toMatchObject({ state: "fetched", remote: { state: "CLOSED", stateReason: "NOT_PLANNED" } });
  expect(s["issue:I_13"]).toMatchObject({ state: "fetched", remote: { stateReason: "COMPLETED" } });
  expect(s["issue:I_20"]).toMatchObject({ remote: { stateReason: null } });
  // #42 is gone: kept as it was and marked unavailable; the others are stored with it
  await importGithubSnapshot(fakeGh(world(true)).gh, db, WS, 2000);
  s = stored();
  expect(s["issue:I_42"]).toMatchObject({ state: "unavailable", remote: { number: 42 } });
  expect(s["pull-request:PR_40"]).toMatchObject({ state: "fetched" });
  expect(db.getBacklogRepository(KEY)).toMatchObject({ lastSuccessfulSync: 2000 });
});

test("a limit keeps GitHub's time to come back as retryAt; the cursor stays", async () => {
  const gh: GhRunner = async (args) =>
    args[0] === "repo"
      ? { code: 0, stdout: "acme/app true\n", stderr: "" }
      : { code: 1, stdout: 'HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1900000000\n\n{"message":"API rate limit exceeded"}', stderr: "gh: API rate limit exceeded (HTTP 403)" };
  await expect(importGithubSnapshot(gh, db, WS, 1000)).rejects.toThrow();
  expect(db.getBacklogRepository(KEY)).toEqual({ ...KEY, cursor: null, lastSuccessfulSync: null, retryAt: 1_900_000_000_000 });
  expect(db.listBacklogRecords(KEY)).toEqual([]);
});

test("BacklogSync: imports at once share one; a read asks nothing and says one is under way; a failure is kept until a success", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  let fail = false;
  const { gh, calls } = fakeGh({ changed: () => (fail ? (() => { throw new Error("gh: HTTP 502"); })() : pageOf([raw(12)])), open: () => pageOf([]) });
  let now = 1000;
  const sync = makeSync(db, gh, () => now);
  const runs = [sync.sync(ws), sync.sync(ws), sync.sync(ws)];
  expect(sync.read(ws)).toMatchObject({ syncing: true, fetchedAt: null, items: [] });
  await Promise.all(runs);
  expect(calls.filter((c) => c.startsWith("changed"))).toHaveLength(1);
  expect(sync.read(ws)).toMatchObject({ syncing: false, fetchedAt: 1000, error: null, items: [{ number: 12 }] });
  fail = true;
  await expect(sync.sync(ws)).rejects.toThrow("502");
  expect(sync.read(ws)).toMatchObject({ fetchedAt: 1000, items: [{ number: 12 }], error: expect.stringContaining("502") });
  // an outage is waited out too (GithubRetryState): the next import goes after its time
  fail = false;
  await expect(sync.sync(ws)).rejects.toThrow("まで照会しません");
  now += 60_000;
  await sync.sync(ws);
  expect(sync.read(ws)).toMatchObject({ error: null, fetchedAt: now });
});

test("BacklogSync: after a limit GitHub is not asked until its time, by a new daemon too (the stored retryAt)", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  let limited = false;
  let asked = 0;
  const ok = fakeGh({ changed: () => pageOf([]), open: () => pageOf([]) });
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api") asked++;
    return limited && args[0] === "api" ? { code: 1, stdout: 'HTTP/2.0 403 Forbidden\nRetry-After: 60\n\n{"message":"You have exceeded a secondary rate limit."}', stderr: "gh: secondary rate limit (HTTP 403)" } : ok.gh(args, cwd);
  };
  let now = 1000;
  await makeSync(db, gh, () => now).sync(ws);
  limited = true;
  await expect(makeSync(db, gh, () => now).sync(ws)).rejects.toThrow("secondary");
  expect(db.getBacklogRepository(KEY)!.retryAt).toBe(61_000);
  const before = asked;
  const restarted = makeSync(db, gh, () => now);
  await expect(restarted.sync(ws)).rejects.toThrow("まで照会しません");
  expect(asked).toBe(before);
  expect(restarted.read(ws).error).toContain("まで照会しません");
  limited = false;
  now = 61_000;
  expect(restarted.read(ws).error).toBeNull(); // the wait is over: its reason is not shown any more
  await restarted.sync(ws);
  expect(db.getBacklogRepository(KEY)).toMatchObject({ retryAt: null, lastSuccessfulSync: 61_000 });
});

test("an import does not write back the Project of a variable changed while it ran", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  const { gh } = fakeGh({ changed: () => (db.setWorkspaceProjectVar(ws.id, "OTHER_URL"), pageOf([])), open: () => pageOf([]) });
  await importGithubSnapshot(gh, db, ws, 1000);
  expect(db.getWorkspaceBacklogSource(ws.id)).toBeNull();
  await importGithubSnapshot(gh, db, db.getWorkspace(ws.id)!, 2000);
  expect(db.getWorkspaceBacklogSource(ws.id)).toEqual({ ...KEY, project: { owner: "acme", number: 1 }, private: true });
});

test("BacklogSync: after a write, an import begun before it is not shared; the one after it is, once", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  let release!: () => void;
  let held = new Promise<void>((r) => (release = r));
  let title = "before";
  const { gh, calls } = fakeGh({ changed: () => pageOf([raw(12, { title })]), open: () => pageOf([]) });
  const slow: GhRunner = async (args, cwd) => {
    if (args.some((a) => a.includes("states:[OPEN,CLOSED]"))) await held;
    return gh(args, cwd);
  };
  let now = 1000;
  const metrics: string[] = [];
  const sync = makeSync(db, slow, () => now, (m) => m.kind !== "call" && metrics.push(m.kind));
  const first = sync.sync(ws); // begins before the write
  now = 1001;
  title = "after"; // GitHub has the write
  sync.wrote(ws);
  const a = sync.sync(ws);
  const b = sync.sync(ws);
  release();
  held = Promise.resolve();
  await Promise.all([first, a, b]);
  expect(calls.filter((c) => c.startsWith("changed"))).toHaveLength(2);
  expect(sync.read(ws).items.map((i) => i.title)).toEqual(["after"]);
  // queuing the import after the write asks GitHub: not shared; the two that joined it are
  expect(metrics).toEqual(["shared", "shared"]);
});

test("BacklogSync: the import a write starts is the one a later look shares (no second import)", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  const { gh, calls } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  let now = 1000;
  const sync = makeSync(db, gh, () => now);
  sync.wrote(ws); // the read-back after an answer
  now = 1500;
  await sync.sync(ws); // the screen's 再読込 right after
  expect(calls.filter((c) => c.startsWith("changed"))).toHaveLength(1);
});

test("BacklogSync: an import of another checkout of the same repository, begun before a write, does not store its older copy", async () => {
  const a = db.upsertWorkspace({ id: "ws_a", name: "a", path: "/Users/dev/a", kind: "repo" });
  const b = db.upsertWorkspace({ id: "ws_b", name: "b", path: "/Users/dev/b", kind: "repo" });
  let title = "before";
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let holding = false;
  const { gh } = fakeGh({ changed: () => pageOf([raw(12, { title })]), open: () => pageOf([]) });
  const holdB: GhRunner = async (args, cwd) => {
    const r = await gh(args, cwd);
    if (holding && cwd === b.path && args.some((x) => x.includes("states:OPEN, labels"))) await held; // b read "before", then waits
    return r;
  };
  const sync = makeSync(db, holdB, () => 1000);
  await sync.sync(a);
  await sync.sync(b); // both are checkouts of acme/app
  holding = true;
  const older = sync.sync(b); // b reads while...
  await Bun.sleep(20);
  title = "after"; // ...the answer is written through a
  sync.wrote(a);
  await sync.sync(a); // a's read-back stores "after"
  release();
  await older;
  expect(sync.read(b).items.map((i) => i.title)).toEqual(["after"]);
  expect(sync.read(a).items.map((i) => i.title)).toEqual(["after"]);
});

test("BacklogSync measures: shared and waited carry the workspace's repository — two repositories apart, never the path (#994)", async () => {
  const a = db.upsertWorkspace({ id: "ws_a", name: "wsA", path: "/Users/dev/a", kind: "repo" });
  const b = db.upsertWorkspace({ id: "ws_b", name: "wsB", path: "/Users/dev/lib", kind: "repo" });
  let limited = false;
  const { gh } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const two: GhRunner = async (args, cwd) => {
    if (args[0] === "repo") return { code: 0, stdout: cwd === b.path ? "acme/lib true\n" : "acme/app true\n", stderr: "" };
    if (limited && args[0] === "api") return { code: 1, stdout: "", stderr: "gh: API rate limit exceeded (HTTP 429)" };
    return gh(args, cwd);
  };
  const metrics: GithubCallMetric[] = [];
  const all: GithubCallMetric[] = [];
  let now = 1000;
  const sync = makeSync(db, two, () => now, (m) => (metrics.push(m), all.push(m)));
  // before the first import nothing names the repository: a share then carries null
  await Promise.all([sync.sync(a), sync.sync(a)]);
  expect(metrics.filter((m) => m.kind === "shared").map((m) => m.repo)).toEqual([null]);
  await sync.sync(b);
  metrics.length = 0;
  await Promise.all([sync.sync(a), sync.sync(a), sync.sync(a)]);
  await Promise.all([sync.sync(b), sync.sync(b), sync.sync(b)]);
  expect(metrics.filter((m) => m.kind === "shared").map((m) => m.repo)).toEqual(["acme/app", "acme/app", "acme/lib", "acme/lib"]);
  // a limit met through one is waited for by both, each under its own repository
  limited = true;
  now += 60_000;
  await expect(sync.sync(a)).rejects.toThrow("rate limit");
  metrics.length = 0;
  await expect(sync.sync(a)).rejects.toThrow("まで照会しません");
  await expect(sync.sync(b)).rejects.toThrow("まで照会しません");
  expect(metrics.filter((m) => m.kind === "waited").map((m) => [m.repo, m.failure])).toEqual([["acme/app", "primary"], ["acme/lib", "primary"]]);
  // every record of the run — the imports' calls, the shares and the waits — names no path and no workspace
  const out = JSON.stringify(all);
  for (const leaked of ["/Users/dev", "wsA", "wsB", "ws_a", "ws_b"]) expect(out).not.toContain(leaked);
});

test("BacklogSync: a Project variable changed while an import runs gets an import of its own (the old one stores nothing)", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  let release!: () => void;
  let held: Promise<void> | null = null;
  const { gh, calls } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const slow: GhRunner = async (args, cwd) => {
    if (held && args.some((x) => x.includes("states:[OPEN,CLOSED]"))) await held;
    return gh(args, cwd);
  };
  const sync = makeSync(db, slow, () => 1000);
  await sync.sync(ws);
  held = new Promise<void>((r) => (release = r));
  const old = sync.sync(ws); // begun with the old variable
  await Bun.sleep(10);
  db.setWorkspaceProjectVar(ws.id, "OTHER_URL"); // as the PATCH does: the source is forgotten, then
  sync.wrote(db.getWorkspace(ws.id)!);
  held = null;
  release();
  await old;
  for (let i = 0; sync.read(ws).syncing && i < 200; i++) await Bun.sleep(5); // the import the write asked for, if any
  expect(calls.filter((c) => c.startsWith("changed")).length).toBe(3); // the first, the old one, and the PATCH's own
  expect(db.getWorkspaceBacklogSource(ws.id)).toEqual({ ...KEY, project: { owner: "acme", number: 1 }, private: true });
});

test("BacklogSync: the first import of a checkout begun before a write through another checkout stores nothing", async () => {
  const a = db.upsertWorkspace({ id: "ws_a", name: "a", path: "/Users/dev/a", kind: "repo" });
  const b = db.upsertWorkspace({ id: "ws_b", name: "b", path: "/Users/dev/b", kind: "repo" });
  let title = "before";
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { gh } = fakeGh({ changed: () => pageOf([raw(12, { title })]), open: () => pageOf([]) });
  const holdB: GhRunner = async (args, cwd) => {
    const r = await gh(args, cwd);
    if (cwd === b.path && args.some((x) => x.includes("states:OPEN, labels"))) await held;
    return r;
  };
  const sync = makeSync(db, holdB, () => 1000);
  await sync.sync(a);
  const first = sync.sync(b); // b has no source yet
  await Bun.sleep(20);
  title = "after";
  sync.wrote(a);
  await sync.sync(a);
  release();
  await first;
  expect(sync.read(a).items.map((i) => i.title)).toEqual(["after"]);
});

test("BacklogSync: a caller waiting on an import that a write made store nothing gets what the import after it stored", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  let title = "old";
  let release!: () => void;
  let held: Promise<void> | null = null;
  const { gh } = fakeGh({ changed: () => pageOf([raw(12, { title })]), open: () => pageOf([]) });
  const slow: GhRunner = async (args, cwd) => {
    const r = await gh(args, cwd);
    if (held && args.some((x) => x.includes("states:OPEN, labels"))) await held;
    return r;
  };
  const sync = makeSync(db, slow, () => 1000);
  await sync.sync(ws); // stored: "old"
  held = new Promise<void>((r) => (release = r));
  const sweep = sync.sync(ws); // the sweep waits for an import, which reads "old" again...
  await Bun.sleep(10);
  title = "new"; // ...while an answer is written
  sync.wrote(ws);
  held = null;
  release();
  await sweep;
  expect(sync.read(ws).items.map((i) => i.title)).toEqual(["new"]);
});

// Read again by itself (#887): how long until the next read, from what the reads found.

test("BacklogSync polls every minute while the backlog changes, twice as long each time it does not (up to 15 minutes), after a limit at its time", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  let title = "one";
  let limited = false;
  const { gh } = fakeGh({ changed: () => pageOf([raw(12, { title })]), open: () => pageOf([]) });
  const limit: GhRunner = async (args, cwd) =>
    limited && args[0] === "api" ? { code: 1, stdout: 'HTTP/2.0 403 Forbidden\nRetry-After: 3600\n\n{"message":"You have exceeded a secondary rate limit."}', stderr: "gh: secondary rate limit (HTTP 403)" } : gh(args, cwd);
  let now = 1_000_000;
  const sync = makeSync(db, limit, () => now);
  await sync.sync(ws);
  expect(sync.nextPoll(ws.id)).toBeNull(); // not polling until asked to
  sync.startPolling();
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    await sync.sync(ws);
    waits.push((sync.nextPoll(ws.id)! - now) / 60_000);
  }
  expect(waits).toEqual([2, 4, 8, 15, 15, 15]); // nothing new since the first read
  title = "two";
  await sync.sync(ws);
  expect(sync.nextPoll(ws.id)! - now).toBe(60_000);
  // a limit: not before GitHub's time, and the refusal during it plans the same
  limited = true;
  await expect(sync.sync(ws)).rejects.toThrow("secondary");
  expect(sync.nextPoll(ws.id)).toBe(now + 3_600_000);
  now += 60_000;
  await expect(sync.sync(ws)).rejects.toThrow("まで照会しません");
  expect(sync.nextPoll(ws.id)).toBe(now - 60_000 + 3_600_000);
  sync.stop();
  expect(sync.nextPoll(ws.id)).toBeNull();
});

test("BacklogSync polls: the same answers again store nothing new and queue nothing; a page that failed is read whole by the next poll", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  let broken = false;
  const { gh } = fakeGh({
    changed: (v) => (v.after ? (broken ? (() => { throw new Error("gh: HTTP 502"); })() : pageOf([raw(13)])) : pageOf([raw(12)], "p2")),
    open: () => pageOf([]),
  });
  let now = 1000;
  const sync = makeSync(db, gh, () => now);
  sync.startPolling();
  await sync.sync(ws);
  const first = stored();
  for (let i = 0; i < 3; i++) {
    now += 60_000;
    await sync.sync(ws);
  }
  expect(stored()).toEqual(first);
  expect(db.listPendingBacklogOperations()).toEqual([]);
  // the second page fails: nothing stored, the cursor where it was; the next read gets both pages
  const cursor = db.getBacklogRepository(KEY)!.cursor;
  broken = true;
  now += 60_000;
  await expect(sync.sync(ws)).rejects.toThrow("502");
  expect(db.getBacklogRepository(KEY)!.cursor).toBe(cursor);
  broken = false;
  now += 120_000;
  await sync.sync(ws);
  expect(Object.keys(stored()).filter((k) => k.startsWith("issue:"))).toEqual(["issue:I_12", "issue:I_13"]);
  sync.stop();
});

test("BacklogSync polls: the timer imports and plans the next read; a workspace never imported is tried again at the longest wait only, a gone checkout not at all", async () => {
  jest.useFakeTimers();
  try {
    const path = join(dir, "app");
    mkdirSync(path);
    const ws = db.upsertWorkspace({ id: WS.id, name: "app", path, kind: "repo" });
    const meta = db.upsertWorkspace({ id: "ws_meta", name: "meta", path: dir, kind: "repo" });
    const { gh, calls } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
    // the meta workspace is no GitHub checkout: its import fails at the repository
    const runner: GhRunner = async (args, cwd) => (args[0] === "repo" && cwd === dir ? { code: 1, stdout: "", stderr: "no git remotes found" } : gh(args, cwd));
    let now = 1_000_000;
    const sync = makeSync(db, runner, () => now);
    const settled = async () => {
      for (let i = 0; i < 1000 && sync.read(ws).syncing; i++) await Promise.resolve();
    };
    sync.startPolling();
    await sync.sync(ws);
    await expect(sync.sync(meta)).rejects.toThrow();
    expect(sync.nextPoll(meta.id)).toBe(now + 15 * 60_000);
    // the timer fires: an import, and the next read planned from it (nothing new: twice as long)
    now += 60_000;
    jest.advanceTimersByTime(60_000);
    expect(sync.read(ws).syncing).toBe(true);
    await settled();
    expect(calls.filter((c) => c.startsWith("changed"))).toHaveLength(2);
    expect(sync.nextPoll(ws.id)).toBe(now + 120_000);
    // the checkout gone: the timer reads nothing, and nothing more is planned
    rmSync(path, { recursive: true });
    now += 120_000;
    jest.advanceTimersByTime(120_000);
    expect(sync.read(ws).syncing).toBe(false);
    expect(calls.filter((c) => c.startsWith("changed"))).toHaveLength(2);
    expect(sync.nextPoll(ws.id)).toBeNull();
    sync.stop();
  } finally {
    jest.useRealTimers();
  }
});

// A GitHub Webhook (#887): only a notice to import; nothing it says is stored.

test("a Webhook delivery names the workspaces of its repository, or of its Project's owner; nothing else of it is read", () => {
  const source = (repository: string, owner = "acme") => ({ ...KEY, repository, project: { owner, number: 1 } });
  const all = [{ id: "a", source: source("acme/app") }, { id: "b", source: source("Acme/App") }, { id: "c", source: source("acme/tool", "other") }, { id: "d", source: null }];
  expect(noticeTargets({ action: "edited", repository: { full_name: "ACME/app" }, issue: { title: "偽の題" } }, all)).toEqual(["a", "b"]);
  // a Project item of an Organization's Webhook: no repository, its organization
  expect(noticeTargets({ action: "edited", projects_v2_item: { content_node_id: "I_x" }, organization: { login: "acme" } }, all)).toEqual(["a", "b"]);
  expect(noticeTargets({ repository: { full_name: "someone/else" } }, all)).toEqual([]);
  for (const junk of [null, "acme/app", [], { repository: { full_name: 7 } }, { repository: { full_name: "a".repeat(201) } }, { organization: {} }]) expect(noticeTargets(junk, all)).toEqual([]);
});

test("BacklogSync.hint: 100 deliveries start one import, the rest fold into a read within the window; notices that bring nothing new start imports no more often than the poll; at most HINT_BUDGET imports in all", async () => {
  const repos: string[] = [];
  const { gh } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const counting: GhRunner = async (args, cwd) => (args[0] === "repo" && repos.push(cwd), gh(args, cwd));
  let now = 1_000_000;
  const sync = makeSync(db, counting, () => now);
  sync.startPolling();
  const spaces = Array.from({ length: HINT_BUDGET + 2 }, (_, i) => db.upsertWorkspace({ id: `ws_${i}`, name: `w${i}`, path: join(dir, `w${i}`), kind: "repo" }));
  for (const w of spaces) await sync.sync(w); // each imported once: it has a source
  repos.length = 0;
  now += 3_600_000;

  const started = Array.from({ length: 100 }, () => sync.hint(spaces[0]!));
  expect(started.filter(Boolean)).toHaveLength(1);
  expect(repos).toHaveLength(1);
  await sync.sync(spaces[0]!); // the import it started: nothing new, so the notice window (and the poll's wait) is 2 minutes
  expect(sync.nextPoll(spaces[0]!.id)! - now).toBe(120_000);
  now += 60_000;
  expect(sync.hint(spaces[0]!)).toBe(false); // a minute later: still folded (forged or repeated notices do not read more often)
  expect(sync.nextPoll(spaces[0]!.id)! - now).toBeLessThanOrEqual(120_000);
  now += 60_000;
  expect(sync.hint(spaces[0]!)).toBe(true); // the window over: a new one

  // the budget: the first one above, and HINT_BUDGET − 1 more; the rest are read by the poll within the minute
  repos.length = 0;
  const more = spaces.slice(1).map((w) => sync.hint(w));
  expect(more.filter(Boolean)).toHaveLength(HINT_BUDGET - 1);
  expect(repos).toHaveLength(HINT_BUDGET - 1);
  for (const w of spaces.slice(1).filter((_, i) => !more[i])) expect(sync.nextPoll(w.id)! - now).toBeLessThanOrEqual(60_000);
  for (const w of spaces) await sync.sync(w).catch(() => undefined);
  sync.stop();
});

test("BacklogSync.hint: a folded notice is read once by the next import — a failing one does not bring the next read back at once; one that comes while an import runs is read after it", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: dir, kind: "repo" });
  let failing = false;
  let release: (() => void) | null = null;
  const { gh } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const runner: GhRunner = async (args, cwd) => {
    if (failing && args[0] === "api") return { code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
    if (release && args.some((a) => a.includes("states:[OPEN,CLOSED]"))) await new Promise<void>((r) => (release = r));
    return gh(args, cwd);
  };
  let now = 1_000_000;
  const sync = makeSync(db, runner, () => now);
  sync.startPolling();
  await sync.sync(ws);
  now += 3_600_000;
  expect(sync.hint(ws)).toBe(true);
  await sync.sync(ws);
  expect(sync.hint(ws)).toBe(false); // folded: read within the window (2 minutes: the notice's import read nothing new)
  expect(sync.nextPoll(ws.id)).toBe(now + 120_000);
  // GitHub refuses from now on, with no time to wait for: the read at the minute fails, and the next is not at once
  failing = true;
  now += 120_000;
  await expect(sync.sync(ws)).rejects.toThrow();
  expect(sync.nextPoll(ws.id)! - now).toBeGreaterThanOrEqual(60_000);
  await expect(sync.sync(ws)).rejects.toThrow();
  expect(sync.nextPoll(ws.id)! - now).toBeGreaterThanOrEqual(60_000);

  // a notice while an import runs (it may have read before the change): read again within the minute after it
  failing = false;
  now += 3_600_000;
  for (let i = 0; i < 4; i++) await sync.sync(ws); // nothing new: the wait grows past a minute
  release = () => undefined;
  const running = sync.sync(ws);
  await Bun.sleep(5);
  const noticeAt = now;
  expect(sync.hint(ws)).toBe(false);
  release!();
  release = null;
  await running;
  // within the notice window (4 minutes: the last notices brought nothing new or failed), not the poll's 15
  expect(sync.hintWindow(ws.id)).toBe(240_000);
  expect(sync.nextPoll(ws.id)).toBeLessThanOrEqual(noticeAt + 240_000);
  sync.stop();
});

test("BacklogSync.hint: deliveries in reverse order, or one the daemon's own send caused, end as GitHub is and queue nothing; during a limit nothing is asked", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: dir, kind: "repo" });
  let title = "一つ目";
  let asked = 0;
  const { gh } = fakeGh({ changed: () => pageOf([raw(12, { title })]), open: () => pageOf([]) });
  const counting: GhRunner = async (args, cwd) => (asked++, gh(args, cwd));
  let now = 1_000_000;
  const sync = makeSync(db, counting, () => now);
  sync.startPolling();
  await sync.sync(ws);
  title = "二つ目";
  // the delivery of the second edit comes first, that of the first after it (and the daemon's own write is just one more)
  for (const said of ["二つ目", "一つ目"]) {
    now += 61_000;
    expect(noticeTargets({ repository: { full_name: "acme/app" }, issue: { title: said } }, [{ id: ws.id, source: db.getWorkspaceBacklogSource(ws.id) }])).toEqual([ws.id]);
    expect(sync.hint(ws)).toBe(true);
    await sync.sync(ws);
  }
  expect(sync.read(ws).items.map((i) => i.title)).toEqual(["二つ目"]);
  expect(db.listPendingBacklogOperations()).toEqual([]);
  // a limit: the notice asks GitHub nothing, and the read is planned at the limit's time
  const retryAt = now + 3_600_000;
  db.setBacklogRetryAt(db.getWorkspaceBacklogSource(ws.id)!, retryAt);
  now += 61_000;
  asked = 0;
  sync.hint(ws);
  await sync.sync(ws).catch(() => undefined);
  expect(asked).toBe(0);
  expect(sync.nextPoll(ws.id)).toBe(retryAt);
  sync.stop();
});

test("BacklogSync.hint: forged notices every minute for an hour read GitHub a few times, not sixty; a notice during a wait spends no budget; a daemon that does not poll takes none", async () => {
  const ws = db.upsertWorkspace({ id: WS.id, name: "app", path: dir, kind: "repo" });
  const other = db.upsertWorkspace({ id: "ws_other", name: "other", path: join(dir, "other"), kind: "repo" });
  const { gh, calls } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  let now = 1_000_000;
  const quiet = makeSync(db, gh, () => now);
  await quiet.sync(ws);
  expect(quiet.hint(ws)).toBe(false); // not polling (the candidate, a test daemon): no notice taken
  const sync = makeSync(db, gh, () => now);
  sync.startPolling();
  await sync.sync(ws);
  await sync.sync(other);
  const imports = () => calls.filter((c) => c.startsWith("changed")).length;
  const before = imports();
  for (let i = 0; i < 60; i++) {
    now += 60_000;
    if (sync.hint(ws)) await sync.sync(ws); // nothing changes on GitHub: 1, 2, 4, 8, 15, 15 … minutes apart
  }
  expect(imports() - before).toBeLessThanOrEqual(7);
  // a wait on the repository: notices are folded, ask nothing and leave the budget to others
  const until = now + 3_600_000;
  db.setBacklogRetryAt(db.getWorkspaceBacklogSource(ws.id)!, until);
  now += 15 * 60_000;
  const asked = imports();
  for (let i = 0; i < HINT_BUDGET; i++) expect(sync.hint(ws)).toBe(false);
  expect(imports()).toBe(asked);
  // the wait over at the same moment: the budget is whole (the folded notices spent none of it)
  db.setBacklogRetryAt(db.getWorkspaceBacklogSource(ws.id)!, null);
  expect(sync.hint(other)).toBe(true);
  await sync.sync(other);
  sync.stop();
});

test("a Webhook and a poll end with the same stored backlog: what the delivery says is never stored", async () => {
  let title = "GitHub の題";
  const { gh } = fakeGh({ changed: () => pageOf([raw(12, { title })]), open: () => pageOf([]) });
  const other = new Db(join(dir, "other.db"));
  try {
    const polled = makeSync(db, gh, () => 1000);
    const hinted = makeSync(other, gh, () => 1000);
    hinted.startPolling();
    const a = db.upsertWorkspace({ id: WS.id, name: "app", path: dir, kind: "repo" });
    const b = other.upsertWorkspace({ id: WS.id, name: "app", path: dir, kind: "repo" });
    await polled.sync(a);
    await hinted.sync(b);
    title = "GitHub で直した題";
    // the delivery says something else: it is only a notice
    expect(noticeTargets({ repository: { full_name: "acme/app" }, issue: { number: 12, title: "偽の題" } }, [{ id: b.id, source: other.getWorkspaceBacklogSource(b.id) }])).toEqual([b.id]);
    expect(hinted.hint(b)).toBe(true);
    for (let i = 0; i < 200 && hinted.read(b).syncing; i++) await Bun.sleep(1);
    await polled.sync(a);
    const records = (d: Db) => d.listBacklogRecords(KEY).map((r) => [r.objectKind, r.externalId, r.remote, r.fetchState]);
    expect(records(other)).toEqual(records(db));
    expect(hinted.read(b).items.map((i) => i.title)).toEqual(["GitHub で直した題"]);
    hinted.stop();
  } finally {
    other.close();
  }
});

test("POST /api/backlog/webhooks/github: once opened, without the token, 64 KiB at most, the same answer for any repository; the rest of the API still asks for the token", async () => {
  const home = mkdtempSync(join(tmpdir(), "switchboard-webhook-"));
  const asked: string[][] = [];
  const { gh } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const env = { SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" };
  const opts = { port: 0, selfdevChecks: false, dryRunRestart: true, backlogAutoImport: true, gh: ((args, cwd) => (asked.push(args), gh(args, cwd))) as GhRunner };
  // not opened by the user: the token is asked as on any route
  const closed = await startServer(loadConfig(env), [], opts);
  try {
    expect((await fetch(`http://127.0.0.1:${closed.server.port}/api/backlog/webhooks/github`, { method: "POST", body: "{}" })).status).toBe(401);
  } finally {
    await closed.stop();
  }
  const SECRET = "whsec-test-secret";
  const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const core = await startServer(loadConfig({ ...env, SWITCHBOARD_GITHUB_WEBHOOK: "1", SWITCHBOARD_GITHUB_WEBHOOK_SECRET: SECRET }), [], opts);
  try {
    const base = `http://127.0.0.1:${core.server.port}`;
    const ws = core.db.upsertWorkspace({ id: WS.id, name: "app", path: home, kind: "repo" });
    core.db.setWorkspaceBacklogSource(ws.id, { ...KEY, project: { owner: "acme", number: 1 } });
    const deliver = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/api/backlog/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": sign(body), ...headers }, body });
    // no signature, a wrong one, or one made with another secret: 401, and nothing is asked of GitHub
    const named = JSON.stringify({ repository: { full_name: "acme/app" } });
    for (let n = -1; n !== asked.length; await Bun.sleep(100)) n = asked.length; // the import at startup has finished
    const before = asked.length;
    const unsigned = await fetch(`${base}/api/backlog/webhooks/github`, { method: "POST", headers: { "content-type": "application/json" }, body: named });
    const wrong = await deliver(named, { "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    const other = await deliver(named, { "x-hub-signature-256": sign(named, "another-secret") });
    expect([unsigned.status, wrong.status, other.status]).toEqual([401, 401, 401]);
    await Bun.sleep(150);
    expect(asked.length).toBe(before);
    const evil = "http://198.51.100.7/steal";
    const known = await deliver(JSON.stringify({ action: "edited", repository: { full_name: "acme/app", url: evil }, issue: { url: evil, title: "偽の題" } }));
    const unknown = await deliver(JSON.stringify({ repository: { full_name: "someone/else" } }));
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(await known.json()).toEqual(await unknown.json());
    for (let i = 0; i < 200 && !core.db.listBacklogRecords(KEY).length; i++) await Bun.sleep(5);
    // the known one was imported from GitHub, the payload's values and URLs never used
    expect(core.db.listBacklogRecords(KEY, "issue").map((r) => (r.remote as { title: string }).title)).toEqual(["PBI 12"]);
    expect(asked.flat().some((a) => a.includes("198.51.100.7") || a.includes("someone/else"))).toBe(false);
    expect((await deliver("x".repeat(64 * 1024 + 1))).status).toBe(413);
    // a body with no length (chunked) is cut while it is read
    const chunked = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(16 * 1024).fill(120)); c.close(); } });
    expect((await fetch(`${base}/api/backlog/webhooks/github`, { method: "POST", body: chunked, duplex: "half" } as RequestInit)).status).toBe(413);
    expect((await deliver("not json")).status).toBe(400);
    expect((await deliver("{}", { origin: "http://evil.example" })).status).toBe(403);
    // the token is still asked for everywhere else
    expect((await fetch(`${base}/api/backlog`)).status).toBe(401);
    expect((await fetch(`${base}/api/backlog/12`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: ws.id, title: "x" }) })).status).toBe(401);
  } finally {
    await core.stop();
  }
  // on the cloud host the route is opened as well, but a request around the CDN (no edge header, not from this machine) is still refused
  const edged = await startServer(loadConfig({ ...env, SWITCHBOARD_GITHUB_WEBHOOK: "1", SWITCHBOARD_GITHUB_WEBHOOK_SECRET: SECRET, SWITCHBOARD_EDGE_HEADER_VALUE: "edge-secret" }), [], { ...opts, peerAddress: () => "203.0.113.9" });
  try {
    const url = `http://127.0.0.1:${edged.server.port}/api/backlog/webhooks/github`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: "{}", headers: { "x-switchboard-edge": "edge-secret", "x-hub-signature-256": sign("{}") } })).status).toBe(202);
  } finally {
    await edged.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("SWITCHBOARD_GITHUB_WEBHOOK=1 without the secret keeps the route closed and says why once", async () => {
  const home = mkdtempSync(join(tmpdir(), "switchboard-webhook-"));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  let core: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const env = { SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_GITHUB_WEBHOOK: "1" };
    core = await startServer(loadConfig(env), [], { port: 0, selfdevChecks: false, dryRunRestart: true });
    const res = await fetch(`http://127.0.0.1:${core.server.port}/api/backlog/webhooks/github`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401); // the token is asked, as on any route
    expect(warned.filter((w) => w.includes("SWITCHBOARD_GITHUB_WEBHOOK_SECRET"))).toHaveLength(1);
  } finally {
    console.warn = warn;
    await core?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("after stop a send asks nothing of the database: one that ends after the daemon's stop does not meet it closed (#549)", async () => {
  const own = new Db(join(dir, "stopped.db"));
  own.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  const sync = makeSync(own, async () => ({ code: 1, stdout: "", stderr: "not asked" }));
  sync.stop();
  own.close();
  await expect(sync.send(WS)).resolves.toBeUndefined();
});

test("BacklogSync: the import is the read of the repository's forge (#920): a service ops.config.json names and none supports is the import's failure, said as it is, and GitHub is not asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-forge-"));
  try {
    writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab" } }));
    const ws = db.upsertWorkspace({ id: "ws_lab", name: "lab", path: dir, kind: "repo" });
    const { gh, calls } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
    const sync = makeSync(db, gh, () => 1000);
    await expect(sync.sync(ws)).rejects.toThrow("サービス gitlab には対応していません");
    expect(sync.read(ws)).toMatchObject({ fetchedAt: null, error: "サービス gitlab には対応していません（対応: github）" });
    expect(calls).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with GitHub sync off, create / answer / start go on stored data and gh is never called (#2266)", async () => {
  const home = mkdtempSync(join(tmpdir(), "switchboard-sync-off-"));
  const path = join(home, "app");
  mkdirSync(path);
  const { gh: github } = fakeGh({
    changed: () => pageOf([raw(10, {
      labels: { totalCount: 2, nodes: [{ name: "type:pbi" }, { name: "needs-decision" }] }, subIssues: { totalCount: 0, nodes: [] },
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "C_10_1", body: "## 判断待ち\nQ", createdAt: "2026-10-02T00:00:00Z" }] },
      projectItems: { totalCount: 1, nodes: [item(10, "In progress")] },
    })]),
    open: () => pageOf([{ number: 10, projectItems: { totalCount: 1, nodes: [item(10, "In progress")] } }], null, [openPr(11, { labels: { totalCount: 0, nodes: [] } })]),
  });
  let off = false;
  const asked: string[][] = [];
  const gh: GhRunner = async (args, cwd) => {
    if (cwd === path) asked.push(args);
    if (off) throw new Error("spawn gh ENOENT");
    return github(args, cwd);
  };
  const ending = {
    id: "claude", detect: async () => ({ available: true }),
    start: (_o: unknown, emit: (e: { t: "session.end"; status: "ok" }) => void) => {
      queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise<never>(() => {}) };
    },
  };
  const core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [ending as never], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
  try {
    const base = `http://127.0.0.1:${core.server.port}`;
    const send = async (method: string, route: string, body?: object) => {
      const r = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: (await r.json()) as any };
    };
    const ws = core.db.upsertWorkspace({ name: "app", path, kind: "repo" });
    await importGithubSnapshot(gh, core.db, ws);
    const key = core.db.getWorkspaceBacklogSource(ws.id)!;
    const before = Object.fromEntries(core.db.listBacklogRecords(key).map((r) => [r.externalId, r.remote]));

    const turned = await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "switchboard" });
    expect([turned.status, turned.body.backlog]).toEqual([200, "switchboard"]);
    off = true;
    asked.length = 0;
    const made = await send("POST", "/api/backlog", { workspaceId: ws.id, title: "PBI: off", labels: ["type:pbi"] });
    expect([made.status, made.body.number]).toEqual([202, 12]); // the PR #11 is GitHub's number too
    expect((await send("POST", "/api/backlog/10/answer", { workspaceId: ws.id, text: "こうする" })).status).toBe(202);
    const ten = (await send("GET", `/api/backlog/10?workspaceId=${ws.id}`)).body;
    expect(ten.comments.map((c: { body: string }) => c.body)).toEqual(["## 判断待ち\nQ", "## 回答\n\nこうする"]);
    expect(ten.issue.labels).toEqual(["type:pbi"]);
    // the label taken off a GitHub record waits for the sync to be on; the comment is decided here
    expect(ten.pending).toBe(1);
    expect((await send("POST", "/api/backlog/10/start", { workspaceId: ws.id, action: "complete" })).status).toBe(201);
    expect((await send("POST", "/api/backlog/sync", { workspaceId: ws.id })).status).toBe(200);
    expect(asked).toEqual([]);
    // GitHub's records stay as they were: its ids, numbers, comment and fields (the answer made #10 changed now)
    const after = Object.fromEntries(core.db.listBacklogRecords(key).map((r) => [r.externalId, r.remote]));
    for (const id of ["C_10_1", "PVTI_10", "PR_11"]) expect(after[id]).toEqual(before[id]);
    expect({ ...(after.I_10 as object), updatedAt: null }).toEqual({ ...(before.I_10 as object), updatedAt: null });
    expect(ten.fields).toMatchObject({ Status: "In progress" });
    expect(core.db.getWorkspaceBacklogSource(ws.id)).toEqual({ ...key, disabled: true });
  } finally {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("an import or a send begun before the sync was turned off stores and sends nothing (#2266)", async () => {
  db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  // the first import is under way when the workspace is turned to one kept here
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { gh } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const slow: GhRunner = async (args, cwd) => (args[0] === "repo" ? gh(args, cwd) : held.then(() => gh(args, cwd)));
  const importing = importGithubSnapshot(slow, db, WS, 1000);
  const local = { service: "switchboard" as const, host: "local", repository: WS.id, project: { owner: "switchboard", number: 0 } };
  db.setWorkspaceBacklogSource(WS.id, local);
  release();
  await importing;
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual(local);
  expect(db.listBacklogRecords(KEY)).toEqual([]);
  // a send asked for while it synced runs after the sync is off: nothing goes to GitHub
  db.setWorkspaceBacklogSource(WS.id, { ...KEY, project: { owner: "acme", number: 1 } });
  db.applyBacklogEdit(KEY, { records: [], operations: [{ issue: "I_12", targetKind: "issue", target: "I_12", kind: "set", field: "title", payload: "t", base: "PBI 12" }] });
  const asked: string[][] = [];
  const sync = makeSync(db, async (args) => (asked.push(args), { code: 1, stdout: "", stderr: "not asked" }));
  const sending = sync.send(WS);
  db.setWorkspaceBacklogSource(WS.id, { ...KEY, project: { owner: "acme", number: 1 }, disabled: true });
  await sending;
  expect(asked).toEqual([]);
  expect(db.listPendingBacklogOperations(KEY).map((o) => o.status)).toEqual(["pending"]);
});

// Synthetic names only (#2467): acme/widget is published, acme/widget-dev is its development repository.
test("public copy: a workspace that resolves to its tree's publicSync.target is neither imported nor sent; the failure says how to point it elsewhere", async () => {
  const path = mkdtempSync(join(tmpdir(), "switchboard-public-copy-"));
  try {
    writeFileSync(join(path, "ops.config.json"), JSON.stringify({ envPrefix: "WIDGET", publicSync: { target: "acme/widget" } }));
    const ws = db.upsertWorkspace({ id: "ws_widget", name: "widget", path, kind: "repo" });
    const { gh: github } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
    const asked: string[][] = [];
    const gh: GhRunner = async (args, cwd) => {
      asked.push(args);
      return args[0] === "repo" ? { code: 0, stdout: "acme/widget true\n", stderr: "" } : github(args, cwd);
    };
    const error = await importGithubSnapshot(gh, db, ws, 1000).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(BacklogError);
    expect(error?.message).toContain("gh repo set-default");
    expect(error?.message).toContain("GH_REPO");
    expect(asked.map((a) => a.slice(0, 2))).toEqual([["repo", "view"]]);
    expect(db.getWorkspaceBacklogSource(ws.id)).toBeNull();
    expect(db.listBacklogRecords({ service: "github", host: githubHost(), repository: "acme/widget" })).toEqual([]);

    // through BacklogSync: the failure the backlog screen reads holds the same text; a send writes nothing
    asked.length = 0;
    const sync = makeSync(db, gh, () => 1000);
    await expect(sync.sync(ws)).rejects.toThrow("gh repo set-default");
    expect(sync.read(ws)).toMatchObject({ fetchedAt: null, items: [], error: expect.stringContaining("publicSync.target") });
    await sync.send(ws);
    expect(asked.filter((a) => a[0] !== "repo")).toEqual([]);

    // the daily secret scan only reads: it still checks the repository the clone resolves to
    const scanned: string[][] = [];
    const scan = await scanAllRepos({ workspaces: [{ name: "widget", path }], metaPath: path, gh, spawn: async (argv: string[]) => (scanned.push(argv.slice(-2)), { code: 0, stdout: "hits: 0 / scanned: 1\n", stderr: "" }) });
    expect([scanned, scan.summary]).toEqual([[["scan-issues", "acme/widget"]], { repos: 1, hits: 0, failed: 0 }]);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("public copy: the development repository, whose publicSync names the public copy, is imported as before", async () => {
  const path = mkdtempSync(join(tmpdir(), "switchboard-public-copy-"));
  try {
    writeFileSync(join(path, "ops.config.json"), JSON.stringify({ envPrefix: "WIDGET", publicSync: { target: "acme/widget" } }));
    const ws = db.upsertWorkspace({ id: "ws_widget_dev", name: "widget-dev", path, kind: "repo" });
    const { gh: github, calls } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
    const gh: GhRunner = async (args, cwd) => (args[0] === "repo" ? { code: 0, stdout: "acme/widget-dev true\n", stderr: "" } : github(args, cwd));
    await importGithubSnapshot(gh, db, ws, 1000);
    expect(calls).toEqual(["changed", "open"]);
    expect(db.getWorkspaceBacklogSource(ws.id)).toMatchObject({ repository: "acme/widget-dev" });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

// The registration a rebuild clones from (#2799): an import of another checkout leaves it; a rename is followed.
const PRIVATE_KEY: BacklogRepositoryKey = { service: "github", host: githubHost(), repository: "acme/app-dev" };

test("an import does not overwrite the registered repository with another checkout", async () => {
  db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  const registered = { ...PRIVATE_KEY, project: { owner: "acme", number: 1 }, private: true };
  db.setWorkspaceBacklogSource(WS.id, registered);
  const { gh: github, calls } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const asked: string[][] = [];
  // the checkout is the public acme/app; GitHub says acme/app-dev is still its own repository
  const gh: GhRunner = async (args, cwd) => {
    asked.push(args);
    if (args[0] === "api" && args[1] === "repos/acme/app-dev") return { code: 0, stdout: "acme/app-dev\n", stderr: "" };
    return args[0] === "repo" ? { code: 0, stdout: "acme/app false\n", stderr: "" } : github(args, cwd);
  };
  const error = await importGithubSnapshot(gh, db, WS, 1000).then(() => null, (e: unknown) => e as Error);
  expect(error).toBeInstanceOf(BacklogError);
  expect(error?.message).toContain("acme/app-dev");
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual(registered);
  expect(db.listBacklogRecords(KEY)).toEqual([]);
  expect(db.getBacklogRepository(KEY)).toBeNull();
  expect(calls).toEqual([]);
  // a registration GitHub cannot answer for is refused the same way
  const gone: GhRunner = async (args, cwd) => (args[0] === "api" && args[1] === "repos/acme/app-dev" ? { code: 1, stdout: "", stderr: "HTTP 404" } : gh(args, cwd));
  await expect(importGithubSnapshot(gone, db, WS, 2000)).rejects.toThrow("違うリポジトリの clone");
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual(registered);
});

test("an import follows a renamed repository", async () => {
  db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  // registered under the old name acme/app-dev, which GitHub forwards to acme/app (case aside)
  db.setWorkspaceBacklogSource(WS.id, { ...PRIVATE_KEY, project: { owner: "acme", number: 1 } });
  const { gh: github } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api" && args[1] === "repos/acme/app-dev") return { code: 0, stdout: "Acme/App\n", stderr: "" };
    return args[0] === "repo" ? { code: 0, stdout: "acme/app true\n", stderr: "" } : github(args, cwd);
  };
  await importGithubSnapshot(gh, db, WS, 1000);
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual({ ...KEY, project: { owner: "acme", number: 1 }, private: true });
  expect(db.listBacklogRecords(KEY).length).toBeGreaterThan(0);
});

test("an import records the repository's visibility", async () => {
  db.upsertWorkspace({ id: WS.id, name: "app", path: WS.path, kind: "repo" });
  const { gh: github } = fakeGh({ changed: () => pageOf([raw(12)]), open: () => pageOf([]) });
  const asked: string[][] = [];
  const answer = (visibility: string): GhRunner => async (args, cwd) => (args[0] === "repo" ? (asked.push(args), { code: 0, stdout: `acme/app ${visibility}\n`, stderr: "" }) : github(args, cwd));
  await importGithubSnapshot(answer("true"), db, WS, 1000);
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual({ ...KEY, project: { owner: "acme", number: 1 }, private: true });
  await importGithubSnapshot(answer("false"), db, WS, 2000);
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual({ ...KEY, project: { owner: "acme", number: 1 }, private: false });
  // an answer without the visibility is refused and leaves the registration as it was
  await expect(importGithubSnapshot(answer(""), db, WS, 3000)).rejects.toThrow("リポジトリを特定できません");
  expect(db.getWorkspaceBacklogSource(WS.id)).toEqual({ ...KEY, project: { owner: "acme", number: 1 }, private: false });
  asked.pop();
  // one gh repo view reads both
  expect(asked).toEqual([["repo", "view", "--json", "nameWithOwner,isPrivate", "-q", '"\\(.nameWithOwner) \\(.isPrivate)"'], ["repo", "view", "--json", "nameWithOwner,isPrivate", "-q", '"\\(.nameWithOwner) \\(.isPrivate)"']]);
});
