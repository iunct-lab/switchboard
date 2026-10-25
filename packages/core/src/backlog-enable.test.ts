import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, BacklogIssueDetail, BacklogSource, RunnerAdapter, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import type { GhRunner } from "./backlog.ts";
import { fakeGithub, type Issue } from "./backlog-fake-github.ts";
import { renumberRefs } from "./backlog-enable.ts";

// Turning a workspace's GitHub sync on (#2266): what was made here goes to GitHub, numbered there, nothing lost.

let core: CoreServer | undefined;
let home: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (home) rmSync(home, { recursive: true, force: true });
  core = home = undefined;
});

const ending: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(_opts, emit) {
    queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};

/** The fake GitHub with its imports' reads (backlog-sync.ts) answered from its Issues, comments and Project items; `down` fails every call. */
function github(numbers: number[]) {
  const g = fakeGithub(() => Date.now());
  g.issues.clear();
  g.items.clear();
  for (const n of numbers) g.issues.set(n, { node_id: `I_${n}`, number: n, title: `GitHub ${n}`, body: "", state: "OPEN", labels: [], parent: null, comments: [] });
  g.state.next = Math.max(0, ...numbers) + 1;
  const down = { on: false };
  const items = (i: Issue) => [...g.items].filter(([, it]) => it.issue === i.node_id).map(([id, it]) => ({
    id, project: { number: 1, owner: { login: "acme" } },
    fieldValues: { totalCount: Object.keys(it.fields).length, nodes: Object.entries(it.fields).map(([name, v]) => (typeof v === "number" ? { number: v, field: { name } } : { name: v, field: { name } })) },
  }));
  const raw = (i: Issue) => ({
    id: i.node_id, number: i.number, title: i.title, url: `https://github.com/acme/app/issues/${i.number}`, state: i.state, body: i.body, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", milestone: null,
    parent: i.parent ? { number: i.parent } : null, labels: { totalCount: i.labels.length, nodes: i.labels.map((name) => ({ name })) },
    subIssues: { totalCount: 0, nodes: [...g.issues.values()].filter((c) => c.parent === i.number).map((c) => ({ number: c.number })) },
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: i.comments.map((c) => ({ id: c.node_id, body: c.body, createdAt: c.created_at })) },
    projectItems: { totalCount: items(i).length, nodes: items(i) },
  });
  const page = (nodes: unknown[]) => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), stderr: "" });
  const gh: GhRunner = async (args, cwd) => {
    if (down.on) return { code: 1, stdout: "", stderr: "gh: HTTP 503" };
    if (args[0] === "repo") return { code: 0, stdout: "acme/app\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/orgs/acme/projects/1\n", stderr: "" };
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (q.includes("states:[OPEN,CLOSED]")) return page([...g.issues.values()].map(raw));
    if (q.includes("states:OPEN")) return page([...g.issues.values()].filter((i) => i.state === "OPEN").map((i) => ({ number: i.number, projectItems: { totalCount: items(i).length, nodes: items(i) } })));
    if (q.includes("issueOrPullRequest")) {
      // one GitHub does not have is NOT_FOUND, as GitHub answers
      const asked = [...q.matchAll(/w(\d+): /g)].map((m) => Number(m[1]));
      const errors = asked.filter((n) => !g.issues.has(n)).map((n) => ({ type: "NOT_FOUND", path: ["repository", `w${n}`] }));
      return { code: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries(asked.map((n) => [`w${n}`, g.issues.has(n) ? { __typename: "Issue", ...raw(g.issues.get(n)!) } : null])) }, ...(errors.length ? { errors } : {}) }), stderr: "" };
    }
    return g.gh(args, cwd);
  };
  return { ...g, gh, down };
}

async function boot(gh: GhRunner) {
  home = mkdtempSync(join(tmpdir(), "sb-backlog-enable-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [ending], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
  const base = `http://127.0.0.1:${core.server.port}`;
  const send = async (method: string, path: string, body?: object) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const dir = (name: string) => {
    const p = join(home!, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const view = async (ws: Workspace, ref: number) => (await send("GET", `/api/backlog/${ref}?workspaceId=${ws.id}`)).body as BacklogIssueDetail;
  const syncOf = async (ws: Workspace) => ((await send("GET", "/api/backlog")).body as Backlog).syncs.find((s) => s.workspaceId === ws.id)!;
  /** Until the turning on is over (or `until` says it stopped): every send and import it started has ended. */
  const settled = async (ws: Workspace, until = (s: Backlog["syncs"][number]) => s.enabling === null) => {
    for (let i = 0; i < 150; i++) {
      const s = await syncOf(ws);
      if (until(s) && !s.syncing && !core!.db.listPendingBacklogOperations().some((o) => o.status === "sending")) return s;
      await Bun.sleep(20);
    }
    throw new Error(`not settled: ${JSON.stringify(await syncOf(ws))}`);
  };
  /** A workspace kept here only with Issues #1 (a request), #2 (Ready, with a stage Task) and #3 (closed). */
  const local = async () => {
    const ws = (await send("POST", "/api/workspaces", { path: dir("local"), backlog: "switchboard" })).body as Workspace;
    for (const [title, fields] of [["要望: a", undefined], ["PBI: b", { Status: "Ready" }], ["PBI: c", undefined]] as const)
      expect((await send("POST", "/api/backlog", { workspaceId: ws.id, title, labels: [title.startsWith("要望") ? "type:request" : "type:pbi"], ...(fields ? { fields } : {}) })).status).toBe(202);
    expect((await send("PATCH", "/api/backlog/3", { workspaceId: ws.id, state: "CLOSED" })).status).toBe(202);
    const started = await send("POST", "/api/backlog/2/start", { workspaceId: ws.id, action: "complete" });
    expect([started.status, started.body.error]).toEqual([201, undefined]);
    return ws;
  };
  return { base, send, dir, view, syncOf, settled, local } as const;
}

const sourceOf = (ws: Workspace) => core!.db.getWorkspaceBacklogSource(ws.id) as BacklogSource;
const posts = (writes: string[]) => writes.filter((w) => w === "POST repos/acme/app/issues").length;

test("enabling a local workspace makes its Issues on GitHub and keeps the numbers (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  const { send, view, settled, local } = await boot(g.gh);
  const ws = await local();
  const turned = await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github", projectVar: "SWITCHBOARD_PROJECT_URL" });
  expect(turned.status).toBe(202);
  expect(turned.body.enabling).toEqual({ total: 3, done: 0 });
  const s = await settled(ws);
  expect([s.backlog, s.enabling, s.repository]).toEqual(["github", null, "acme/app"]);
  expect(posts(g.writes)).toBe(3);
  expect(sourceOf(ws).numbers).toEqual([{ from: 1, to: 57 }, { from: 2, to: 58 }, { from: 3, to: 59 }]);
  expect(sourceOf(ws).enabling).toBeUndefined();
  expect([57, 58, 59].map((n) => g.issues.get(n)!.title)).toEqual(["要望: a", "PBI: b", "PBI: c"]);
  expect(g.issues.get(59)!.state).toBe("CLOSED");
  expect((await view(ws, 58)).fields).toMatchObject({ Status: "Ready" });
  expect((await view(ws, 59)).issue.state).toBe("CLOSED");
  expect((await view(ws, 57)).issue.labels).toEqual(["type:request"]);
  // GitHub's own #1–#3 are its own; the stage Task follows its Issue
  expect((await view(ws, 2)).issue.title).toBe("GitHub 2");
  expect(core!.db.listTasks().map((t) => t.stage?.issue)).toEqual([58]);
  // nothing made here is left under the workspace's own key
  expect(core!.db.listBacklogRecords({ service: "switchboard", host: "local", repository: ws.id })).toEqual([]);
  expect(core!.db.listBacklogRecords(sourceOf(ws), "issue").filter((r) => r.externalId.startsWith("sb:"))).toEqual([]);
});

test("re-enabling sends what was made and edited while off; a conflict is held (#2266)", async () => {
  const g = github([10]);
  g.items.set("PVTI_I_10", { issue: "I_10", fields: { Status: "Backlog" } });
  const { send, view, settled, dir } = await boot(g.gh);
  const ws = (await send("POST", "/api/workspaces", { path: dir("app") })).body as Workspace;
  await send("POST", "/api/backlog/sync", { workspaceId: ws.id });
  expect((await view(ws, 10)).fields).toEqual({ Status: "Backlog" });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "switchboard" })).status).toBe(200);
  expect((await send("POST", "/api/backlog", { workspaceId: ws.id, title: "PBI: 無効の間", labels: ["type:pbi"] })).body.number).toBe(11);
  expect((await send("PATCH", "/api/backlog/10", { workspaceId: ws.id, fields: { Status: "Ready" } })).status).toBe(202);
  expect(g.writes).toEqual([]);
  // GitHub moved on meanwhile: #10's Status changed there, and #11 / #12 were made by someone else
  g.items.get("PVTI_I_10")!.fields.Status = "Done";
  g.state.next = 13;
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws);
  expect(sourceOf(ws)).toMatchObject({ repository: "acme/app", numbers: [{ from: 11, to: 13 }] });
  expect(sourceOf(ws).disabled).toBeUndefined();
  expect(g.issues.get(13)!.title).toBe("PBI: 無効の間");
  expect((await view(ws, 13)).issue.title).toBe("PBI: 無効の間");
  // the edit made while off was checked against GitHub: held, GitHub's value not overwritten
  expect(g.items.get("PVTI_I_10")!.fields.Status).toBe("Done");
  expect((await view(ws, 10)).held.map((h) => [h.field, h.status])).toEqual([["field:Status", "conflict"]]);
});

test("a 502 halfway keeps every record; the next press goes on without making one twice (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  const { send, view, settled, local } = await boot(g.gh);
  const ws = await local();
  // GitHub makes the second Issue, then answers 502 when it is put in the Project: it waits a minute by itself
  g.fail.push({ match: (a) => a.some((x) => x.includes("addProjectV2ItemById")), status: 502 });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  const halfway = await settled(ws, (s) => s.enabling?.done === 2);
  expect(halfway.enabling).toEqual({ total: 3, done: 2 });
  expect(core!.db.listPendingBacklogOperations().map((o) => [o.kind, o.status, !!o.retryAt])).toEqual([["create", "pending", true]]);
  // every Issue made here is still read; nothing is numbered yet
  for (const title of ["要望: a", "PBI: b", "PBI: c"]) expect(core!.db.listBacklogRecords(sourceOf(ws), "issue").some((r) => (r.remote as { title: string } | null)?.title === title)).toBe(true);
  expect(sourceOf(ws).numbers).toBeUndefined();
  // the next press goes on at once from the Issue GitHub made: none is made twice
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).body.enabling).toEqual({ total: 3, done: 2 });
  await settled(ws);
  expect(posts(g.writes)).toBe(3);
  expect(g.issues.size).toBe(59);
  expect(sourceOf(ws).numbers).toEqual([{ from: 1, to: 57 }, { from: 2, to: 58 }, { from: 3, to: 59 }]);
  expect((await view(ws, 58)).fields).toMatchObject({ Status: "Ready" });
  expect(core!.db.listTasks().map((t) => t.stage?.issue)).toEqual([58]);
});

test("an import that fails leaves a local workspace as it was (#2266)", async () => {
  const g = github([1]);
  const { send, local } = await boot(g.gh);
  const ws = await local();
  const before = core!.db.listBacklogRecords({ service: "switchboard", host: "local", repository: ws.id });
  g.down.on = true;
  const r = await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" });
  expect(r.status).toBe(424);
  expect(r.body.error).toContain("503");
  expect(sourceOf(ws).service).toBe("switchboard");
  expect(core!.db.listBacklogRecords({ service: "switchboard", host: "local", repository: ws.id })).toEqual(before);
  expect((await send("GET", "/api/workspaces")).body.find((w: Workspace) => w.id === ws.id).backlog).toBe("switchboard");
});

test("turned off halfway and on again through another checkout, the turning on goes on as it was; every checkout comes back (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  const { send, view, settled, local, dir } = await boot(g.gh);
  const ws = await local();
  g.fail.push({ match: (a) => a.some((x) => x.includes("addProjectV2ItemById")), status: 502 });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws, (s) => s.enabling?.done === 2);
  // another checkout of the same repository, then both turned off
  const other = (await send("POST", "/api/workspaces", { path: dir("other") })).body as Workspace;
  await send("POST", "/api/backlog/sync", { workspaceId: other.id });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "switchboard" })).status).toBe(200);
  expect((await send("GET", "/api/workspaces")).body.filter((w: Workspace) => [ws.id, other.id].includes(w.id)).map((w: Workspace) => w.backlog)).toEqual(["switchboard", "switchboard"]);
  // the create left halfway is GitHub's to finish: not decided here while off
  await send("POST", "/api/backlog/sync", { workspaceId: ws.id });
  expect(core!.db.listPendingBacklogOperations().map((o) => [o.kind, o.status])).toEqual([["create", "pending"]]);
  // turned on again through the other checkout, which never began it
  const r = await send("PATCH", `/api/workspaces/${other.id}`, { backlog: "github" });
  expect(r.body.enabling).toEqual({ total: 3, done: 2 });
  await settled(ws);
  expect((await send("GET", "/api/workspaces")).body.filter((w: Workspace) => [ws.id, other.id].includes(w.id)).map((w: Workspace) => w.backlog)).toEqual(["github", "github"]);
  expect(posts(g.writes)).toBe(3);
  expect(sourceOf(ws).numbers).toEqual([{ from: 1, to: 57 }, { from: 2, to: 58 }, { from: 3, to: 59 }]);
  expect(core!.db.listTasks().map((t) => t.stage?.issue)).toEqual([58]);
  expect((await view(other, 58)).issue.title).toBe("PBI: b");
});

test("a comment made here moves with its Issue to GitHub's number, not to GitHub's Issue of its old number (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  const { send, view, settled, local } = await boot(g.gh);
  const ws = await local();
  expect((await send("POST", "/api/backlog/2/comment", { workspaceId: ws.id, text: "ここで書いた" })).status).toBe(202);
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws);
  // on the Issue made from #2, sent to it; not on GitHub's #2
  expect((await view(ws, 58)).comments.map((c) => c.body.split("\n")[0])).toEqual(["ここで書いた"]);
  expect(g.issues.get(58)!.comments).toHaveLength(1);
  expect((await view(ws, 2)).comments).toEqual([]);
  // the move read nothing: the repository's last read is the import's
  expect(core!.db.getBacklogRepository(sourceOf(ws))?.cursor).not.toBeNull();
});

test("two presses while GitHub is read turn it on once (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  let slow = false;
  const gh: GhRunner = async (args, cwd) => {
    if (slow && args.some((a) => a.includes("states:[OPEN,CLOSED]"))) await Bun.sleep(100);
    return g.gh(args, cwd);
  };
  const { send, settled, local } = await boot(gh);
  const ws = await local();
  slow = true;
  const [a, b] = await Promise.all([1, 2].map(() => send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })));
  expect([a!.status, b!.status]).toEqual([202, 202]);
  await settled(ws);
  expect(posts(g.writes)).toBe(3);
  expect(sourceOf(ws).numbers).toEqual([{ from: 1, to: 57 }, { from: 2, to: 58 }, { from: 3, to: 59 }]);
  expect(core!.db.listTasks().map((t) => t.stage?.issue)).toEqual([58]);
});

test("renumberRefs rewrites #N by the map only (#2266)", () => {
  const m = [{ from: 1, to: 57 }, { from: 57, to: 60 }];
  expect(renumberRefs("#1", m)).toBe("#57");
  // each once: the #57 #1 became is not rewritten again
  expect(renumberRefs("#1 と #57", m)).toBe("#57 と #60");
  expect(renumberRefs("acme/app#1、https://github.com/acme/app/issues/1、#10、&#1;、(#1)、#1.", m)).toBe("acme/app#1、https://github.com/acme/app/issues/1、#10、&#1;、(#57)、#57.");
});

/** A workspace kept here only: request #1, PBI #2 naming it, Task #3 under #2 with a comment naming #2. */
async function family(send: (method: string, path: string, body?: object) => Promise<{ status: number; body: any }>, path: string) {
  const ws = (await send("POST", "/api/workspaces", { path, backlog: "switchboard" })).body as Workspace;
  await send("POST", "/api/backlog", { workspaceId: ws.id, title: "要望: a", labels: ["type:request"] });
  await send("POST", "/api/backlog", { workspaceId: ws.id, title: "PBI: b", labels: ["type:pbi"], body: "要望 #1 から\n\n## 元要望\n#1" });
  await send("POST", "/api/backlog", { workspaceId: ws.id, title: "Task: c", labels: ["type:task"], parent: 2 });
  expect((await send("POST", "/api/backlog/3/comment", { workspaceId: ws.id, text: "#2 の続き" })).status).toBe(202);
  return ws;
}

test("bodies, parents and comments go after numbering, with #N rewritten (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  const bodies: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    if (args[1] === "repos/acme/app/issues" && args.includes("POST")) bodies.push(args[args.indexOf("-f", args.findIndex((a) => a.startsWith("title="))) + 1]!);
    return g.gh(args, cwd);
  };
  const { send, view, settled, dir } = await boot(gh);
  const ws = await family(send, dir("local"));
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws);
  // the creates carried no body: only the marker
  expect(bodies.map((b) => b.replace(/<!-- switchboard-op:[^>]+ -->/, "").trim())).toEqual(["body=", "body=", "body="]);
  expect(g.issues.get(58)!.body).toBe("要望 #57 から\n\n## 元要望\n#57");
  expect(g.issues.get(59)!.parent).toBe(58);
  expect(g.issues.get(59)!.comments.map((c) => c.body.split("\n")[0])).toEqual(["#58 の続き"]);
  expect((await view(ws, 58)).issue.body).toBe("要望 #57 から\n\n## 元要望\n#57");
  expect((await view(ws, 59)).issue.parent).toBe(58);
  expect((await view(ws, 59)).comments.map((c) => c.body.split("\n")[0])).toEqual(["#58 の続き"]);
  expect(sourceOf(ws).enabling).toBeUndefined();
  expect(core!.db.listBacklogRecords(sourceOf(ws), "comment").filter((r) => r.externalId.startsWith("sb:"))).toEqual([]);
});

test("a 502 in the follow-ups goes on at the next press (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  const { send, view, settled, dir } = await boot(g.gh);
  const ws = await family(send, dir("local"));
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues/58" && a.includes("PATCH"), status: 502 });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  // the comment went; #58's body waits for its time, and the turning on with it
  await settled(ws, (s) => !!s.enabling && g.issues.get(59)!.comments.length === 1);
  expect(core!.db.listPendingBacklogOperations().map((o) => [o.kind, o.field, o.status, !!o.retryAt])).toEqual([["set", "body", "pending", true]]);
  expect(sourceOf(ws).enabling).toMatchObject({ queued: true });
  expect(await (await send("GET", `/api/backlog/58?workspaceId=${ws.id}`)).body.issue.body).toBe("要望 #57 から\n\n## 元要望\n#57");
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws);
  expect(g.issues.get(58)!.body).toBe("要望 #57 から\n\n## 元要望\n#57");
  // nothing sent twice
  expect(g.writes.filter((w) => w === "PATCH repos/acme/app/issues/58")).toHaveLength(1);
  expect(g.writes.filter((w) => w === "POST repos/acme/app/issues/59/comments")).toHaveLength(1);
  expect(g.issues.get(59)!.comments).toHaveLength(1);
  expect((await view(ws, 59)).issue.parent).toBe(58);
});

test("a create GitHub refused is tried again at the next press (#2266)", async () => {
  const g = github(Array.from({ length: 56 }, (_, i) => i + 1));
  const { send, settled, local } = await boot(g.gh);
  const ws = await local();
  // GitHub refuses the second Issue (an input it does not take): held as failed, the turning on does not end
  let n = 0;
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues" && a.includes("POST") && ++n === 2, status: 422 });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws, (s) => s.enabling?.done === 2);
  expect(core!.db.listPendingBacklogOperations().map((o) => [o.kind, o.status])).toEqual([["create", "failed"]]);
  // put right on GitHub, pressed again: made, and the turning on ends
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws);
  expect(g.issues.size).toBe(59);
  expect(sourceOf(ws).numbers?.map((m) => m.from)).toEqual([1, 2, 3]);
});

test("a body edited while off that names an Issue made then is sent with GitHub's number (#2266)", async () => {
  const g = github([10]);
  const { send, view, settled, dir } = await boot(g.gh);
  const ws = (await send("POST", "/api/workspaces", { path: dir("app") })).body as Workspace;
  await send("POST", "/api/backlog/sync", { workspaceId: ws.id });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "switchboard" })).status).toBe(200);
  expect((await send("POST", "/api/backlog", { workspaceId: ws.id, title: "Task: 無効の間", labels: ["type:task"] })).body.number).toBe(11);
  expect((await send("PATCH", "/api/backlog/10", { workspaceId: ws.id, body: "続きは #11" })).status).toBe(202);
  expect((await send("POST", "/api/backlog/10/comment", { workspaceId: ws.id, text: "#11 を作った" })).status).toBe(202);
  g.state.next = 13;
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws);
  expect(g.issues.get(10)!.body).toBe("続きは #13");
  expect(g.issues.get(10)!.comments.map((c) => c.body.split("\n")[0])).toEqual(["#13 を作った"]);
  expect((await view(ws, 10)).issue.body).toBe("続きは #13");
});

test("an Issue made here and not on GitHub yet is not asked of GitHub by its number (#2266)", async () => {
  // GitHub has no #1–#3: an import that asked for them would mark the ones made here as gone
  const g = github([5]);
  const { send, view, settled, local } = await boot(g.gh);
  const ws = await local();
  let n = 0;
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues" && a.includes("POST") && ++n === 2, status: 422 });
  expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "github" })).status).toBe(202);
  await settled(ws, (s) => s.enabling?.done === 2);
  await send("POST", "/api/backlog/sync", { workspaceId: ws.id });
  // #2 is still Switchboard's, shown as it was
  expect((await view(ws, 2)).issue.title).toBe("PBI: b");
  expect(core!.db.listBacklogRecords(sourceOf(ws), "issue").filter((r) => r.externalId.startsWith("sb:")).map((r) => r.fetchState)).toEqual(["fetched"]);
});
