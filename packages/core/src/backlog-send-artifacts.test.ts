// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { BacklogIssueData } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { editStoredIssue } from "./backlog-edit.ts";
import { readStoredIssue } from "./backlog-stored.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { forgeKind, sendGithubOperations } from "./backlog-send.ts";
import { mkdirSync as mkdirs, writeFileSync as writeFile } from "node:fs";
import { artifactName, artifactOperations } from "./backlog-edit.ts";
import { ARTIFACT_PUBLIC, issueArtifactGh } from "./backlog-send.ts";
import { S, clock, commentStoredIssue, fakeGithub, useSendDb } from "./api-test-harness.ts";

let dir: string;
let db: Db;
let t = 1_000_000;
useSendDb({ get dir() { return dir; }, set dir(v) { dir = v; }, get db() { return db; }, set db(v) { db = v; }, get t() { return t; }, set t(v) { t = v; } });

/** A workspace of S that asked for it (`on`), PBI 12 with its Task 13, and the Tasks that worked on them with their artifacts' copies under `<dir>/artifacts`. */
function reports(o: { on?: boolean; secret?: boolean } = {}) {
  const artifactsDir = join(dir, "artifacts");
  const ws = db.upsertWorkspace({ name: "app", path: join(dir, "app"), kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  if (o.on !== false) db.setWorkspaceIssueArtifacts(ws.id, true);
  const twelve = db.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_12" })!.remote as BacklogIssueData;
  db.putBacklogSnapshot(S, { records: [
    { objectKind: "issue", externalId: "I_12", remote: { ...twelve, labels: ["type:pbi"], subIssues: [13] }, fetchState: "fetched" },
    { objectKind: "issue", externalId: "I_13", remote: { ...twelve, number: 13, title: "Task", labels: ["type:task"], parent: 12 }, fetchState: "fetched" },
  ], cursor: null, syncedAt: 2 });
  const task = (id: string, title: string, stage: number | null, workspace = ws.id) =>
    db.sqlite.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, status_at, created_at, updated_at, stage_issue) VALUES (?, ?, ?, 'claude', '/w', '[]', 'done', 1, 1, 1, ?)").run(id, workspace, title, stage);
  task("t_pbi", "PBI を進める", 12);
  task("t_task", "#13 実装", null);
  task("t_other", "#99 別の PBI", null);
  let at = 10;
  const artifact = (id: string, taskId: string, title: string, entry: string | null, extra: { kind?: "file" | "dir" | "url"; source?: string; removed?: boolean; text?: string } = {}) => {
    db.insertArtifact({ id, taskId, title, kind: extra.kind ?? "file", source: extra.source ?? `/w/${entry}`, entry, mime: "text/plain", size: 1, removedAt: extra.removed ? 5 : null, createdAt: at, updatedAt: at++, appDays: 0, appRequestTaskId: null });
    if (entry) {
      mkdirs(join(artifactsDir, taskId, id), { recursive: true });
      writeFile(join(artifactsDir, taskId, id, entry), extra.text ?? `# ${title}\n`);
    }
  };
  artifact("art_md", "t_pbi", "結果のレポート", "report.md", o.secret ? { text: `token: ghp_${"a".repeat(36)}\n` } : {});
  artifact("art_html", "t_task", "画面 (案 #2)", "board.html");
  artifact("art_link", "t_task", "", null, { kind: "url", source: "https://example.com/doc" });
  artifact("art_dir", "t_task", "フォルダ", "index.html", { kind: "dir" });
  artifact("art_png", "t_task", "絵", "shot.png");
  artifact("art_gone", "t_task", "消した", "gone.md", { removed: true });
  artifact("art_other", "t_other", "別の PBI", "other.md");
  const sendAll = (gh: GhRunner) => sendGithubOperations(gh, db, dir, S, clock, undefined, undefined, undefined, undefined, undefined, artifactsDir);
  const ops = () => db.listBacklogOperations(S).filter((x) => x.kind === "artifact").sort((a, b) => a.seq - b.seq);
  return { ws, artifactsDir, sendAll, ops };
}

test("issue artifacts: closing a PBI of a workspace that asked for it queues its work's Markdown, HTML and links, one each — nothing else", () => {
  const r = reports();
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  // the PBI's own Task and its sub-issue's: not the folder, the image, the removed one, nor another PBI's
  expect(r.ops().map((x) => x.payload)).toEqual([
    { artifactId: "art_md", name: "結果のレポート", kind: "markdown" },
    { artifactId: "art_html", name: "画面 案 2", kind: "html" },
    { artifactId: "art_link", name: "art_link", kind: "link", url: "https://example.com/doc" },
  ]);
  // after the close, on the PBI's Issue
  const all = db.listPendingBacklogOperations(S);
  expect(all.map((x) => x.kind)).toEqual(["set", "artifact", "artifact", "artifact"]);
  expect(all.every((x) => x.issue === "I_12" && x.target === "I_12")).toBe(true);
  // closed already: a second close queues nothing more
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  expect(r.ops()).toHaveLength(3);
});

test("issue artifacts: nothing is queued without the workspace's mark, for an Issue that is no PBI, for another edit, or while the sync is off", () => {
  const off = reports({ on: false });
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  expect(off.ops()).toEqual([]);
  db.setWorkspaceIssueArtifacts(off.ws.id, true);
  // a Task closed, a PBI's title edited
  editStoredIssue(db, S, 13, { state: "CLOSED" });
  editStoredIssue(db, S, 3, { title: "題" });
  expect(off.ops()).toEqual([]);
  // the sync turned off, or a service that has no Issue artifacts
  expect(artifactOperations(db, { ...S, disabled: true }, "I_3", 12, [13])).toEqual([]);
  expect(artifactOperations(db, { ...S, service: "gitlab" }, "I_3", 12, [13])).toEqual([]);
  expect(artifactOperations(db, S, "I_3", 12, [13])).toHaveLength(3);
});

test("issue artifacts: a second workspace of the same repository that did not ask sends none of its Tasks' reports", () => {
  const r = reports();
  const quiet = db.upsertWorkspace({ name: "app-private", path: join(dir, "app-private"), kind: "repo" });
  db.setWorkspaceBacklogSource(quiet.id, S);
  db.sqlite.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, status_at, created_at, updated_at, stage_issue) VALUES ('t_quiet', ?, '#13 内輪の調べ', 'claude', '/w', '[]', 'done', 1, 1, 1, NULL)").run(quiet.id);
  db.insertArtifact({ id: "art_quiet", taskId: "t_quiet", title: "内輪のメモ", kind: "file", source: "/w/memo.md", entry: "memo.md", mime: "text/plain", size: 1, removedAt: null, createdAt: 50, updatedAt: 50, appDays: 0, appRequestTaskId: null });
  const ids = () => artifactOperations(db, S, "I_12", 12, [13]).map((x) => (x.payload as { artifactId: string }).artifactId);
  expect(ids()).toEqual(["art_md", "art_html", "art_link"]);
  // the workspace's own mark is what sends them
  db.setWorkspaceIssueArtifacts(quiet.id, true);
  expect(ids()).toContain("art_quiet");
  db.setWorkspaceIssueArtifacts(r.ws.id, false);
  expect(ids()).toEqual(["art_quiet"]);
});

test("issue artifacts: names are made plain and distinct", () => {
  expect(artifactName("  画面 (案 #2) [draft] \"x\"  ")).toBe("画面 案 2 draft x");
  expect(artifactName("a".repeat(150))).toHaveLength(100);
  reports();
  db.insertArtifact({ id: "art_same", taskId: "t_pbi", title: "結果のレポート", kind: "url", source: "https://example.com/2", entry: null, mime: "text/uri-list", size: 0, removedAt: null, createdAt: 99, updatedAt: 99, appDays: 0, appRequestTaskId: null });
  expect(artifactOperations(db, S, "I_12", 12, [13]).map((x) => (x.payload as { name: string }).name)).toEqual(["結果のレポート", "画面 案 2", "art_link", "結果のレポート 2"]);
});

test("issue artifacts: the command's shape is in one place", () => {
  expect(issueArtifactGh.list("acme/app", 12)).toEqual(["issue", "artifact", "list", "12", "-R", "acme/app", "--json", "name"]);
  expect(issueArtifactGh.create("acme/app", 12, { name: "レポート", file: "/a/report.md" })).toEqual(["issue", "artifact", "create", "12", "-R", "acme/app", "/a/report.md#レポート"]);
  expect(issueArtifactGh.create("acme/app", 12, { name: "資料", url: "https://example.com/doc" })).toEqual(["issue", "artifact", "create", "12", "-R", "acme/app", "https://example.com/doc", "--name", "資料"]);
  expect(issueArtifactGh.names('[{"name":"a"},{"name":"b"},{}]')).toEqual(["a", "b"]);
  expect([issueArtifactGh.writes(issueArtifactGh.list("a/b", 1)), issueArtifactGh.writes(issueArtifactGh.create("a/b", 1, { name: "n", url: "u" }))]).toEqual([false, true]);
});

test("issue artifacts: sent after the close with gh issue artifact create, each on the PBI's Issue; one already there under its name is not made again", async () => {
  const r = reports();
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  expect(await r.sendAll(g.gh)).toBe(4);
  expect(g.issues.get(12)!.state).toBe("CLOSED");
  expect(g.artifacts.get(12)).toEqual([
    { name: "結果のレポート", from: join(r.artifactsDir, "t_pbi", "art_md", "report.md") },
    { name: "画面 案 2", from: join(r.artifactsDir, "t_task", "art_html", "board.html") },
    { name: "art_link", from: "https://example.com/doc" },
  ]);
  // the close first, then the reports
  expect(g.writes).toEqual(["PATCH repos/acme/app/issues/12", "artifact create 12 結果のレポート", "artifact create 12 画面 案 2", "artifact create 12 art_link"]);
  expect(g.artifactCalls.filter((a) => a[2] === "create").every((a) => a[3] === "12" && a[4] === "-R" && a[5] === "acme/app")).toBe(true);
  expect(r.ops().map((x) => x.status)).toEqual(["done", "done", "done"]);
  // sent again (the operations put back as waiting): the names are there, nothing is created
  for (const x of r.ops()) db.setBacklogOperationResult(x.id, { status: "pending" }, t);
  g.writes.length = 0;
  expect(await r.sendAll(g.gh)).toBe(3);
  expect(g.writes).toEqual([]);
  expect(g.artifacts.get(12)).toHaveLength(3);
});

test("issue artifacts: an answer lost after the create is looked for by name before anything is sent again: one artifact, not two", async () => {
  const r = reports();
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  g.fail.push({ match: (a) => a[1] === "artifact" && a[2] === "create", status: 502, after: true });
  await r.sendAll(g.gh).catch(() => undefined);
  expect(r.ops()[0]!.status).toBe("unknown");
  expect(g.artifacts.get(12)!.filter((a) => a.name === "結果のレポート")).toHaveLength(1);
  await r.sendAll(g.gh);
  expect(r.ops().map((x) => x.status)).toEqual(["done", "done", "done"]);
  expect(g.artifacts.get(12)!.map((a) => a.name)).toEqual(["結果のレポート", "画面 案 2", "art_link"]);
  // and one never made (the create itself refused before it ran) is made by the next send
  expect(g.artifactCalls.filter((a) => a[2] === "create" && a[6]!.endsWith("#結果のレポート"))).toHaveLength(1);
});

test("issue artifacts: a copy holding a value that signs in is not sent — failed with why, no create for it, and the rest goes on", async () => {
  const r = reports({ secret: true });
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  editStoredIssue(db, S, 3, { title: "別の Issue の題" });
  await r.sendAll(g.gh);
  const [bad, ...rest] = r.ops();
  expect(bad!.status).toBe("failed");
  expect(bad!.error).toContain("認証に使える値");
  expect(g.artifacts.get(12)!.map((a) => a.name)).toEqual(["画面 案 2", "art_link"]);
  expect(rest.map((x) => x.status)).toEqual(["done", "done"]);
  // another Issue's edit, and a later edit of the same Issue, are sent all the same
  expect(g.issues.get(3)!.title).toBe("別の Issue の題");
  commentStoredIssue(db, S, 12, "結果");
  await r.sendAll(g.gh);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
  expect(db.getBacklogOperation(bad!.id)!.status).toBe("failed");
  // it shows where the Issue's held edits are shown
  expect(readStoredIssue(db, { id: r.ws.id }, 12)!.held).toMatchObject([{ kind: "artifact", status: "failed", reason: expect.stringContaining("認証に使える値") }]);
});

test("issue artifacts: nothing is sent to a public repository — failed with why, no create, the close still sent", async () => {
  const r = reports();
  const g = fakeGithub();
  g.state.private = false;
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  editStoredIssue(db, S, 3, { title: "別の Issue の題" });
  await r.sendAll(g.gh);
  expect(r.ops().map((x) => [x.status, x.error])).toEqual([["failed", ARTIFACT_PUBLIC], ["failed", ARTIFACT_PUBLIC], ["failed", ARTIFACT_PUBLIC]]);
  expect(g.artifactCalls).toEqual([]);
  expect(g.writes).toEqual(["PATCH repos/acme/app/issues/12", "PATCH repos/acme/app/issues/3"]);
});

test("issue artifacts: one removed after it was queued is skipped; with the sync off nothing is created; GitLab has none", async () => {
  const r = reports();
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  db.sqlite.query("UPDATE artifacts SET removed_at = 9 WHERE id = 'art_html'").run();
  // off: the close and the creates are writes, none is made
  await sendGithubOperations(g.gh, db, dir, S, clock, undefined, () => false, undefined, undefined, undefined, r.artifactsDir).catch(() => undefined);
  expect(g.writes).toEqual([]);
  await r.sendAll(g.gh);
  expect(g.artifacts.get(12)!.map((a) => a.name)).toEqual(["結果のレポート", "art_link"]);
  expect(r.ops().map((x) => x.status)).toEqual(["done", "done", "done"]);
  expect(forgeKind({ kind: "artifact", field: null, targetKind: "issue" })).toBe("artifact");
});
