// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { expect, test } from "bun:test";
import type { BacklogSource } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { createStoredIssue, editStoredIssue } from "./backlog-edit.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { forgeKind, Limit, sendGithubOperations } from "./backlog-send.ts";
import { S, answerStoredDecision, clock, fakeGithub, makeSync, seed, send, useSendDb } from "./api-test-harness.ts";

let dir: string;
let db: Db;
let t = 1_000_000;
useSendDb({ get dir() { return dir; }, set dir(v) { dir = v; }, get db() { return db; }, set db(v) { db = v; }, get t() { return t; }, set t(v) { t = v; } });

/* ---------- the forge operation of the repository's service ---------- */

test("an operation is sent through its service's forge operation: a service not supported, or a value that signs in, is held as failed and nothing is sent", async () => {
  const g = fakeGithub();
  // a value that signs in, written past the edit's own check (a copy restored from an older store): checked again right before it goes out
  editStoredIssue(db, S, 12, { title: "直した題" });
  db.sqlite.query("UPDATE backlog_operations SET payload = ?").run(JSON.stringify("ghp_" + "a".repeat(36)));
  expect(await send(g.gh)).toBe(0);
  expect(db.listPendingBacklogOperations(S).map((o) => [o.status, o.error?.includes("認証に使える値")])).toEqual([["failed", true]]);
  expect(g.writes).toEqual([]);
  expect(g.issues.get(12)!.title).toBe("PBI");
  // another service's repository: the same operation is not sent some other way, it says the service is not supported
  const L: BacklogSource = { ...S, service: "gitea" as "github", host: "gitea.example.com" };
  seed(db);
  db.putBacklogSnapshot(L, { records: [{ objectKind: "issue", externalId: "I_12", remote: { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: "本文", labels: [], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null }, fetchState: "fetched" }], cursor: null, syncedAt: 1 });
  editStoredIssue(db, L, 12, { title: "別のサービス" });
  expect(await sendGithubOperations(g.gh, db, dir, L, clock)).toBe(0);
  expect(db.listPendingBacklogOperations(L).map((o) => [o.status, o.error])).toEqual([["failed", "サービス gitea には対応していません（対応: github, gitlab）"]]);
  expect(g.writes).toEqual([]);
});

/* ---------- GitLab ---------- */

const LAB: BacklogSource = { service: "gitlab", host: "gitlab.example.com", repository: "group/app", project: { owner: "group/app", number: 0 } };

/**
 * A fake GitLab behind glab (REST API v4): its Issues by iid and their notes. `fail` answers a call (method and path)
 * with an HTTP status instead — after doing it when `after` (an answer lost).
 */
function fakeGitlab() {
  type I = { id: number; iid: number; title: string; description: string; state: "opened" | "closed"; labels: string[]; milestone: { id: number; title: string } | null; notes: Array<{ id: number; body: string; system: boolean; created_at: string }> };
  const issues = new Map<number, I>([[12, { id: 9001, iid: 12, title: "PBI", description: "本文", state: "opened", labels: ["type:pbi", "needs-decision"], milestone: null, notes: [] }]]);
  const milestones = [{ id: 5, title: "Phase 2" }];
  const writes: string[] = [];
  let fail: { on: (m: string, p: string) => boolean; status: number; after?: boolean } | null = null;
  let next = 9100;
  const raw = (i: I) => ({ id: i.id, iid: i.iid, title: i.title, description: i.description, state: i.state, labels: i.labels, milestone: i.milestone, web_url: `https://gitlab.example.com/group/app/-/issues/${i.iid}`, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", closed_at: null });
  const glab = async (cmd: string[]) => {
    expect(cmd.slice(0, 4)).toEqual(["glab", "api", "--hostname", "gitlab.example.com"]);
    const m = cmd[cmd.indexOf("-X") + 1]!;
    const path = cmd[cmd.length - 1]!.replace("projects/group%2Fapp", "");
    const f: Record<string, string> = {};
    cmd.forEach((a, k) => cmd[k - 1] === "-f" && (f[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1)));
    const failing = fail?.on(m, path) ? fail : null;
    if (failing && !failing.after) throw new Error(`glab: error (HTTP ${failing.status})`);
    let out: unknown;
    const one = /^\/issues\/(\d+)(\/notes)?(\?.*)?$/.exec(path);
    if (m !== "GET") writes.push(`${m} ${path.replace(/\?.*/, "")}`);
    if (m === "GET" && path.startsWith("/milestones")) out = milestones;
    else if (m === "GET" && path.startsWith("/issues?")) out = [...issues.values()].reverse().map(raw);
    else if (one && !one[2]) {
      const i = issues.get(Number(one[1]));
      if (!i) throw new Error("glab: 404 Not Found (HTTP 404)");
      if (m === "PUT") {
        if (f.title) i.title = f.title;
        if (f.description !== undefined) i.description = f.description;
        if (f.state_event) i.state = f.state_event === "close" ? "closed" : "opened";
        if (f.add_labels) i.labels.push(f.add_labels);
        if (f.remove_labels) i.labels = i.labels.filter((l) => l !== f.remove_labels);
        if (f.milestone_id) i.milestone = milestones.find((x) => String(x.id) === f.milestone_id) ?? null;
      }
      out = raw(i);
    } else if (m === "DELETE" && /^\/issues\/\d+\/notes\/\d+$/.test(path)) {
      const [, iid, id] = /^\/issues\/(\d+)\/notes\/(\d+)$/.exec(path)!;
      const i = issues.get(Number(iid))!;
      i.notes = i.notes.filter((x) => x.id !== Number(id));
      out = null;
    } else if (one && one[2]) {
      const i = issues.get(Number(one[1]))!;
      if (m === "POST") i.notes.push({ id: next++, body: f.body!, system: false, created_at: "2026-10-02T00:00:00Z" });
      out = m === "POST" ? i.notes.at(-1) : [...i.notes].reverse();
    } else if (m === "POST" && path === "/issues") {
      const iid = Math.max(...issues.keys()) + 1;
      issues.set(iid, { id: next++, iid, title: f.title!, description: f.description!, state: "opened", labels: f.labels ? f.labels.split(",") : [], milestone: milestones.find((x) => String(x.id) === f.milestone_id) ?? null, notes: [] });
      out = raw(issues.get(iid)!);
    } else throw new Error(`fake GitLab: ${m} ${path}`);
    if (failing) throw new Error(`glab: error (HTTP ${failing.status})`);
    return JSON.stringify(out);
  };
  return { issues, writes, glab, failWith: (f: typeof fail) => void (fail = f) };
}

const noGh: GhRunner = async (args) => {
  throw new Error(`gh is not asked for GitLab: ${args.join(" ")}`);
};

function seedLab() {
  db.putBacklogSnapshot(LAB, { records: [{ objectKind: "issue", externalId: "gitlab:issue:9001", remote: { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi", "needs-decision"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null }, fetchState: "fetched" }], cursor: null, syncedAt: 1 });
}

const sendLab = (g: ReturnType<typeof fakeGitlab>) => sendGithubOperations(noGh, db, dir, LAB, clock, undefined, undefined, undefined, g.glab);

const labStatuses = () => db.listPendingBacklogOperations(LAB).map((o) => [o.kind, o.field, o.status, o.error]);

test("GitLab: a field is written only while GitLab still has the value it was made on, and read again after; gh is never asked", async () => {
  const g = fakeGitlab();
  seedLab();
  editStoredIssue(db, LAB, 12, { title: "直した題", state: "CLOSED", milestone: "Phase 2", labels: { add: ["P1"], remove: ["needs-decision"] } });
  expect(await sendLab(g)).toBe(5);
  expect(g.issues.get(12)).toMatchObject({ title: "直した題", state: "closed", milestone: { id: 5 }, labels: ["type:pbi", "P1"] });
  expect(g.writes).toEqual(["PUT /issues/12", "PUT /issues/12", "PUT /issues/12", "PUT /issues/12", "PUT /issues/12"]);
  // changed on GitLab since the edit was made: held, nothing written
  editStoredIssue(db, LAB, 12, { body: "手元の本文" });
  g.issues.get(12)!.description = "GitLab で書いた本文";
  g.writes.length = 0;
  expect(await sendLab(g)).toBe(0);
  expect(labStatuses()).toEqual([["set", "body", "conflict", 'GitLab の値が編集の元から変わっています（body: GitLab は "GitLab で書いた本文"）']]);
  expect(g.writes).toEqual([]);
});

test("GitLab: what it does not have (a parent, a Project field) is failed with why and nothing is sent", async () => {
  const g = fakeGitlab();
  seedLab();
  editStoredIssue(db, LAB, 12, { parent: 3 });
  expect(await sendLab(g)).toBe(0);
  expect(labStatuses()).toEqual([["set", "parent", "failed", "GitLab には無いフィールドです（parent）。親は本文の ## 親 PBI で書きます"]]);
  db.sqlite.query("DELETE FROM backlog_operations").run();
  db.putBacklogSnapshot(LAB, { records: [{ objectKind: "project-item", externalId: "item_12", remote: { issue: 12, owner: "group/app", project: 0, fields: { Status: "Backlog" } }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  editStoredIssue(db, LAB, 12, { fields: { Status: "Ready" } });
  expect(await sendLab(g)).toBe(0);
  expect(labStatuses()).toEqual([["set", "field:Status", "failed", "サービス gitlab の project には対応していません"]]);
  expect(g.writes).toEqual([]);
});

test("GitLab: a comment and a create carry their marker; a lost answer is looked for, never posted twice", async () => {
  const g = fakeGitlab();
  seedLab();
  answerStoredDecision(db, LAB, 12, "A で");
  // the post went out and its answer was lost
  g.failWith({ on: (m, p) => m === "POST" && p.endsWith("/notes"), status: 502, after: true });
  await sendLab(g);
  expect(labStatuses().find((o) => o[0] === "comment")?.[2]).toBe("unknown");
  g.failWith(null);
  await sendLab(g);
  expect(g.issues.get(12)!.notes).toHaveLength(1);
  expect(g.issues.get(12)!.notes[0]!.body).toMatch(/^## 回答\n\nA で\n\n<!-- switchboard-op:/);
  expect(db.listPendingBacklogOperations(LAB).filter((o) => o.kind === "comment")).toEqual([]);
  createStoredIssue(db, LAB, { title: "新しい Task", body: "## 親 PBI\n#12", labels: ["type:task"], milestone: "Phase 2", parent: 12, fields: { Status: "Ready" } });
  g.writes.length = 0;
  await sendLab(g);
  const made = g.issues.get(13)!;
  expect(made).toMatchObject({ title: "新しい Task", labels: ["type:task"], milestone: { id: 5 }, state: "opened" });
  expect(made.description).toMatch(/^## 親 PBI\n#12\n\n<!-- switchboard-op:/);
  // the Project's fields are not sent (GitLab has no Project); the parent is the body's
  expect(g.writes).toEqual(["POST /issues"]);
  expect(db.listBacklogRecords(LAB, "issue").find((r) => r.externalId === `gitlab:issue:${made.id}`)?.remote).toMatchObject({ number: 13, parent: 12, state: "OPEN" });
});

test("GitLab: a create or a comment whose answer was lost and that GitLab does not have is made again once every page is read; a look that fails keeps the first error", async () => {
  const g = fakeGitlab();
  seedLab();
  createStoredIssue(db, LAB, { title: "作られなかった", body: "本文", labels: [], milestone: null, parent: null, fields: null });
  answerStoredDecision(db, LAB, 12, "A で");
  // GitLab answers 502 and makes nothing
  g.failWith({ on: (m) => m === "POST", status: 502 });
  await sendLab(g);
  expect(labStatuses().map((o) => [o[0], o[2]])).toEqual([["create", "unknown"], ["comment", "unknown"], ["set", "pending"]]);
  // the look cannot read the lists: nothing posted, the first 502 kept in front
  g.failWith({ on: (m, p) => m === "GET" && (p.startsWith("/issues?") || p.includes("/notes?")), status: 503 });
  g.writes.length = 0;
  await sendLab(g);
  expect(g.writes).toEqual([]);
  for (const o of labStatuses().slice(0, 2)) expect(o[3]).toMatch(/^最初の失敗: .*HTTP 502.* \/ 照合: .*HTTP 503/);
  // every page read, none marked: made again, one each
  g.failWith(null);
  expect(await sendLab(g)).toBe(3);
  expect(labStatuses()).toEqual([]);
  expect([...g.issues.values()].filter((i) => i.title === "作られなかった")).toHaveLength(1);
  expect(g.issues.get(12)!.notes).toHaveLength(1);
  expect(g.issues.get(12)!.labels).toEqual(["type:pbi"]);
});

test("GitLab: made again and the first one shows up after all: the later Issue is closed, the later note deleted", async () => {
  const g = fakeGitlab();
  seedLab();
  const { localId } = createStoredIssue(db, LAB, { title: "遅れて見える", body: "本文", labels: [], milestone: null, parent: null, fields: null });
  answerStoredDecision(db, LAB, 12, "A で");
  g.failWith({ on: (m) => m === "POST", status: 502, after: true });
  await sendLab(g);
  g.failWith(null);
  const first = [...g.issues.values()].find((i) => i.title === "遅れて見える")!;
  const firstNote = g.issues.get(12)!.notes[0]!.id;
  // the first look of each list misses them (the lists lag behind)
  const lag = new Set(["issues", "notes"]);
  const glab = async (cmd: string[]) => {
    const out = await g.glab(cmd);
    const path = cmd.at(-1)!;
    const kind = cmd.includes("GET") ? (path.includes("/notes?") ? "notes" : path.includes("/issues?") ? "issues" : null) : null;
    if (!kind || !lag.delete(kind)) return out;
    return JSON.stringify((JSON.parse(out) as Array<{ description?: string; body?: string }>).filter((x) => !String(x.description ?? x.body).includes("switchboard-op")));
  };
  expect(await sendGithubOperations(noGh, db, dir, LAB, clock, undefined, undefined, undefined, glab)).toBe(3);
  const made = [...g.issues.values()].filter((i) => i.title === "遅れて見える");
  expect(made.map((i) => [i.iid, i.state])).toEqual([[first.iid, "opened"], [first.iid + 1, "closed"]]);
  expect(db.getBacklogOperation(localId)!.remoteId).toBe(`gitlab:issue:${first.id}`);
  expect(g.issues.get(12)!.notes.map((n) => n.id)).toEqual([firstNote]);
});

test("GitLab: both answers lost: the next look finds two, keeps the first made and closes / deletes the other; a 429 on the cleanup stops the run with the operation done", async () => {
  const g = fakeGitlab();
  seedLab();
  const { localId } = createStoredIssue(db, LAB, { title: "二度失う", body: "本文", labels: [], milestone: null, parent: null, fields: null });
  answerStoredDecision(db, LAB, 12, "A で");
  const op = db.getBacklogOperation(localId)!;
  const comment = db.listPendingBacklogOperations(LAB).find((o) => o.kind === "comment")!;
  const raw = { title: "二度失う", state: "opened" as const, labels: [], milestone: null, notes: [] };
  g.issues.set(20, { id: 9200, iid: 20, description: `本文\n\n<!-- switchboard-op:${op.id} -->`, ...raw });
  g.issues.set(21, { id: 9201, iid: 21, description: `本文\n\n<!-- switchboard-op:${op.id} -->`, ...raw });
  g.issues.get(12)!.notes.push(...[9300, 9301].map((id) => ({ id, body: `## 回答\n\nA で\n\n<!-- switchboard-op:${comment.id} -->`, system: false, created_at: "2026-10-02T00:00:00Z" })));
  for (const id of [op.id, comment.id]) db.setBacklogOperationResult(id, { status: "unknown" });
  // the close of the second Issue meets GitLab's limit: the create is done with the first, the run stops there
  g.failWith({ on: (m, p) => m === "PUT" && p === "/issues/21", status: 429 });
  await expect(sendLab(g)).rejects.toBeInstanceOf(Limit);
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "done", remoteId: "gitlab:issue:9200" });
  expect(g.issues.get(12)!.notes).toHaveLength(2);
  // the comment goes next: the first note stays
  g.failWith(null);
  expect(await sendLab(g)).toBe(2);
  expect(g.issues.get(12)!.notes.map((n) => n.id)).toEqual([9300]);
  expect(g.issues.get(21)!.state).toBe("opened"); // left: nothing looks for it again
});

test("GitLab: a 429 on the cleanup holds the create's close too, sent after the wait from the Issue kept", async () => {
  for (const unreached of [false, true]) await holdsTheClose(unreached);
});

async function holdsTheClose(unreached: boolean) {
  db.sqlite.query("DELETE FROM backlog_operations").run();
  const g = fakeGitlab();
  seedLab();
  const { localId } = createStoredIssue(db, LAB, { title: "閉じて作る", body: "本文", labels: [], milestone: null, parent: null, fields: null });
  db.sqlite.query("UPDATE backlog_operations SET payload = json_set(payload, '$.state', 'CLOSED') WHERE id = ?").run(localId);
  const op = db.getBacklogOperation(localId)!;
  const raw = { title: "閉じて作る", state: "opened" as const, labels: [], milestone: null, notes: [] };
  for (const [iid, id] of [[20, 9200], [21, 9201]]) g.issues.set(iid!, { id: id!, iid: iid!, description: `<!-- switchboard-op:${op.id} -->`, ...raw });
  db.setBacklogOperationResult(localId, { status: "unknown" });
  // GitLab's limit, or GitLab not reached at all (no HTTP status): the same wait
  const glab = async (cmd: string[]) => {
    if (unreached && cmd.includes("PUT") && cmd.at(-1)!.endsWith("/issues/21")) throw new Error("glab: dial tcp: connection refused");
    return g.glab(cmd);
  };
  if (!unreached) g.failWith({ on: (m, p) => m === "PUT" && p === "/issues/21", status: 429 });
  await expect(sendGithubOperations(noGh, db, dir, LAB, clock, undefined, undefined, undefined, glab)).rejects.toMatchObject({ kind: unreached ? "offline" : "limit" });
  expect(g.issues.get(20)!.state).toBe("opened");
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "unknown", remoteId: "gitlab:issue:9200" });
  g.failWith(null);
  t += 120_000;
  expect(await sendLab(g)).toBe(1);
  expect(g.issues.get(20)!.state).toBe("closed");
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "done", remoteId: "gitlab:issue:9200" });
}

test("GitLab: a lost create is found by its marker; a failed look for it keeps it unknown, never posted twice; a value moved right after the write is a conflict", async () => {
  const g = fakeGitlab();
  seedLab();
  createStoredIssue(db, LAB, { title: "答えを失う", body: "本文", labels: [], milestone: null, parent: null, fields: null });
  g.failWith({ on: (m, p) => m === "POST" && p === "/issues", status: 502, after: true });
  await sendLab(g);
  expect(labStatuses()).toEqual([["create", null, "unknown", expect.stringContaining("502")]]);
  // the look for its marker fails too: still unknown, nothing posted
  g.failWith({ on: (m, p) => m === "GET" && p.startsWith("/issues?"), status: 503 });
  await sendLab(g);
  expect(labStatuses()).toEqual([["create", null, "unknown", expect.stringContaining("503")]]);
  g.failWith(null);
  await sendLab(g);
  expect(labStatuses()).toEqual([]);
  expect([...g.issues.values()].filter((i) => i.title === "答えを失う")).toHaveLength(1);
  expect(g.writes.filter((w) => w === "POST /issues")).toHaveLength(1);
  // another edit lands between the write and the read after it
  editStoredIssue(db, LAB, 12, { title: "手元の題" });
  const glab = g.glab;
  const racing = async (cmd: string[]) => {
    const out = await glab(cmd);
    if (cmd.includes("PUT")) g.issues.get(12)!.title = "誰かの題";
    return out;
  };
  await sendGithubOperations(noGh, db, dir, LAB, clock, undefined, undefined, undefined, racing);
  expect(labStatuses()).toEqual([["set", "title", "conflict", '送った直後の GitLab の値が送った値と違います（title: GitLab は "誰かの題"）。ほかの編集と重なりました']]);
});

test("GitLab: GitHub's wait does not hold a GitLab project's sends", async () => {
  const g = fakeGitlab();
  seedLab();
  const ws = db.upsertWorkspace({ name: "lab", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, LAB);
  const sync = makeSync(db, noGh, clock);
  sync.glab = g.glab;
  (sync as unknown as { limits: { failed: (h: string, r: unknown) => unknown } }).limits.failed("github.com", { status: 429, headers: { "retry-after": "3600" } });
  editStoredIssue(db, LAB, 12, { title: "待たずに送る" });
  await sync.send(ws);
  expect(g.issues.get(12)!.title).toBe("待たずに送る");
});

test("GitLab: 401 and 429 stop the run with nothing failed; a 4xx fails the operation; a 5xx before the write waits", async () => {
  const g = fakeGitlab();
  seedLab();
  editStoredIssue(db, LAB, 12, { title: "題" });
  g.failWith({ on: (m) => m === "GET", status: 401 });
  await expect(sendLab(g)).rejects.toMatchObject({ kind: "auth" });
  g.failWith({ on: (m) => m === "GET", status: 429 });
  await expect(sendLab(g)).rejects.toMatchObject({ kind: "limit" });
  expect(labStatuses()).toEqual([["set", "title", "pending", expect.any(String)]]);
  g.failWith({ on: (m) => m === "PUT", status: 503 });
  await sendLab(g);
  expect(labStatuses()[0]![2]).toBe("pending");
  g.failWith({ on: (m) => m === "PUT", status: 403 });
  t += 3_600_000;
  await sendLab(g);
  expect(labStatuses()[0]!.slice(0, 3)).toEqual(["set", "title", "failed"]);
  expect(g.writes).toEqual([]);
});

test("forgeKind: a Project item and its fields are project, a create and a comment their own, any other field write", () => {
  expect(forgeKind({ kind: "create", field: null, targetKind: "issue" })).toBe("create");
  expect(forgeKind({ kind: "comment", field: null, targetKind: "comment" })).toBe("comment");
  expect(forgeKind({ kind: "set", field: "member", targetKind: "project-item" })).toBe("project");
  expect(forgeKind({ kind: "set", field: "field:Status", targetKind: "project-item" })).toBe("project");
  for (const field of ["title", "body", "state", "label:type:pbi", "milestone", "parent"]) expect(forgeKind({ kind: "set", field, targetKind: "issue" })).toBe("write");
});
