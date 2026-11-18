// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueDetail } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { importing } from "../fixtures/github-import.ts";
import { BacklogEditError, checkFieldTypes } from "./backlog-edit.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { FAKE_ORIGIN, boot, detailOf, fakeGh, holdingClaude, importedAs, limitedGh, metaId, patch, queued, refreshed, start, useBacklogDaemon } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("edit: every attribute is kept while GitHub is out of reach and shows at once; one field edited again is one operation", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  const before = await detailOf(base, 304);
  const r = await patch(base, 304, { title: "新しい題", body: "一回目", labels: { add: ["P1"], remove: ["type:pbi"] }, state: "CLOSED", milestone: "Phase 3", parent: 12, fields: { Status: "In progress", "Story Points": 3 } });
  expect(r.status).toBe(202);
  expect((await patch(base, 304, { body: "二回目" })).status).toBe(202);
  expect((await patch(base, 304, { body: "三回目" })).status).toBe(202);
  const after = await detailOf(base, 304);
  expect(after.issue).toMatchObject({ number: 304, title: "新しい題", body: "三回目", state: "CLOSED", milestone: "Phase 3", parent: 12 });
  expect(after.issue.labels).toContain("P1");
  expect(after.issue.labels).not.toContain("type:pbi");
  expect(after.fields).toMatchObject({ Status: "In progress", "Story Points": 3 });
  expect(after.pending).toBe(9);
  expect(queued().filter((o) => o[2] === "body")).toEqual([[304, "set", "body", "三回目"]]);
  // each operation keeps the value it was made on, for the check before sending
  expect(core!.db.listPendingBacklogOperations().find((o) => o.field === "title")!.base).toBe(before.issue.title);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  // taken out of the Project: its fields are no longer shown
  expect((await patch(base, 304, { project: false })).status).toBe(202);
  expect((await detailOf(base, 304)).fields).toBeNull();
  // and in it again: the removal not sent yet is undone
  expect((await patch(base, 304, { project: true })).status).toBe(202);
  expect((await detailOf(base, 304)).fields).toMatchObject({ Status: "In progress" });
  expect(core!.db.listPendingBacklogOperations().filter((o) => o.field === "member").map((o) => o.payload)).toEqual([true]);
});

test("edit: an Issue put in the Project here shows each later field edit before GitHub has its item", async () => {
  const base = await boot(fakeGh().gh);
  core!.db.sqlite.query("DELETE FROM backlog_records WHERE object_kind = 'project-item' AND json_extract(remote, '$.issue') = 302").run();
  // an empty map of fields does not put it in the Project
  expect((await patch(base, 302, { fields: {} })).status).toBe(202);
  expect(queued()).toEqual([]);
  expect((await patch(base, 302, { fields: { Status: "Backlog" } })).status).toBe(202);
  expect((await patch(base, 302, { fields: { Priority: "P2" } })).status).toBe(202);
  expect((await detailOf(base, 302)).fields).toEqual({ Status: "Backlog", Priority: "P2" });
  expect(queued().map((o) => o[2])).toEqual(["member", "field:Status", "field:Priority"]);
});

/** The Project's field definitions as GitHub answers the send's read of them. */
const PROJECT_DEFS = [
  { id: "F_s", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "o1", name: "Backlog" }, { id: "o2", name: "Ready" }] },
  { id: "F_sp", name: "Story Points", dataType: "NUMBER" },
  { id: "F_d", name: "Due", dataType: "DATE" },
];

test("checkFieldTypes: a value that does not fit its field is a 422; a fitting one and null pass", () => {
  for (const [fields, msg] of [
    [{ "Story Points": "abc" }, /整数だけ/],
    [{ Status: "Done" }, /選択肢 'Done'/],
    [{ Due: "2026/11/04" }, /YYYY-MM-DD/],
    [{ Nope: "x" }, /フィールド 'Nope' が Project にありません/],
  ] as const) {
    let err: unknown;
    try {
      checkFieldTypes(PROJECT_DEFS, fields);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BacklogEditError);
    expect((err as BacklogEditError).status).toBe(422);
    expect((err as Error).message).toMatch(msg);
  }
  expect(() => checkFieldTypes(PROJECT_DEFS, { Status: "Ready", "Story Points": 3, Due: "2026-11-04", Nope: null })).not.toThrow();
  expect(() => checkFieldTypes(PROJECT_DEFS, { "Story Points": "5" })).not.toThrow();
});

test("edit: a field value that does not fit the Project's field is refused before it is stored; GitHub out of reach stores it", async () => {
  const fake = fakeGh();
  const down = { on: false, reads: 0 };
  const base = await boot(async (args, cwd) => {
    if (!args.some((a) => a.includes("ProjectV2FieldCommon{ id name dataType }"))) return fake.gh(args, cwd);
    down.reads++;
    if (down.on) return { code: 1, stdout: "", stderr: "HTTP 503" };
    return { code: 0, stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: { id: "P_1", fields: { nodes: PROJECT_DEFS } } } } }), stderr: "" };
  });
  const r = await patch(base, 304, { fields: { "Story Points": "abc" } });
  expect(r.status).toBe(422);
  expect(((await r.json()) as { error: string }).error).toMatch(/選択肢 'abc'/)  // the config's choices first; the Project's type is read for what has none;
  expect((await patch(base, 304, { fields: { Status: "Done" } })).status).toBe(422);
  expect(core!.db.listPendingBacklogOperations()).toEqual([]);
  // an empty passes (Due has no value, so nothing to send for it); a fitting value is stored
  expect((await patch(base, 304, { fields: { "Story Points": 5, Due: null } })).status).toBe(202);
  expect(core!.db.listPendingBacklogOperations().map((o) => o.field)).toEqual(["field:Story Points"]);
  // GitHub not reached: stored, the send checks it last
  down.on = true;
  expect((await patch(base, 304, { fields: { Due: "2026/11/04" } })).status).toBe(202);
  // another repository waited for (a GitLab one): this one's values are still checked
  down.on = false;
  const db = core!.db;
  const lab = { service: "gitlab" as const, host: "gitlab.com", repository: "acme/other", project: { owner: "acme", number: 1 } };
  db.setWorkspaceBacklogSource(db.upsertWorkspace({ id: "ws_lab", name: "lab", path: join(home!, "lab"), kind: "repo" }).id, lab);
  db.sqlite.query("INSERT INTO backlog_repositories (service, host, repository, retry_at) VALUES ('gitlab', 'gitlab.com', 'acme/other', ?)").run(Date.now() + 3_600_000);
  expect((await patch(base, 304, { fields: { Status: "Done" } })).status).toBe(422);
  // this repository waited for: the definitions are not read at all, the value is stored
  core!.db.sqlite.query("UPDATE backlog_repositories SET retry_at = ? WHERE service = 'github'").run(Date.now() + 3_600_000);
  const before = down.reads;
  expect((await patch(base, 304, { fields: { Status: "Done" } })).status).toBe(202);
  expect(down.reads).toBe(before);
});

test("project fields: the import keeps the Project's writable fields in its order, GET returns them, and an edit is checked against them", async () => {
  const fake = fakeGh();
  const base = await boot(async (args, cwd) => {
    if (!args.some((a) => a.includes("ProjectV2FieldCommon{ id name dataType }"))) return fake.gh(args, cwd);
    return { code: 0, stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: { id: "P_1", fields: { nodes: PROJECT_DEFS } } } } }), stderr: "" };
  });
  // Title (TITLE) and Sprint (ITERATION) are no field a value is sent to; the order is the Project's
  expect((await detailOf(base, 304)).projectFields).toEqual([
    { name: "Status", dataType: "SINGLE_SELECT", options: ["Backlog", "Ready", "Done"] },
    { name: "Priority", dataType: "SINGLE_SELECT", options: ["P1", "P2"] },
    { name: "Story Points", dataType: "NUMBER", options: [] },
    { name: "Due", dataType: "DATE", options: [] },
  ]);
  for (const fields of [{ "Story Points": "abc" }, { "Story Points": 5.5 }, { Priority: "P9" }, { Nope: "x" }]) expect((await patch(base, 304, { fields })).status).toBe(422);
  expect((await patch(base, 304, { fields: { "Story Points": 5 } })).status).toBe(202);
});

/** Runs `fn` with AWS_CONFIG_FILE on a made-up config holding one account id, which it is given bare. */
async function withHostAccount<T>(fn: (id: string) => Promise<T> | T): Promise<T> {
  const id = ["8642", "9753", "1086"].join("");
  const dir = mkdtempSync(join(tmpdir(), "backlog.aws."));
  writeFileSync(join(dir, "config"), `[profile x-admin]\nsso_account_id = ${id}\n`);
  const saved = process.env.AWS_CONFIG_FILE;
  process.env.AWS_CONFIG_FILE = join(dir, "config");
  try {
    return await fn(id);
  } finally {
    if (saved === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = saved;
    rmSync(dir, { recursive: true });
  }
}

test("edit: an unknown key is 400, an Issue not stored 404, one not read in full 409, a value that signs in 422 — none stored", async () => {
  const base = await boot(fakeGh().gh);
  expect((await patch(base, 304, { assignee: "me" })).status).toBe(400);
  expect((await patch(base, 999, { title: "x" })).status).toBe(404);
  core!.db.sqlite.query("UPDATE backlog_records SET fetch_state = 'unavailable' WHERE object_kind = 'issue' AND json_extract(remote, '$.number') = 303").run();
  const gone = await patch(base, 303, { title: "x" });
  expect(gone.status).toBe(409);
  expect(await gone.text()).toContain("unavailable");
  // still read as stored, with how its last read went
  expect(await detailOf(base, 303)).toMatchObject({ issue: { number: 303 }, fetchState: "unavailable" });
  // a label both added and removed is removed
  expect((await patch(base, 304, { labels: { add: ["P2"], remove: ["P2"] } })).status).toBe(202);
  expect((await detailOf(base, 304)).issue.labels).not.toContain("P2");
  // an edit waiting does not make one GitHub no longer shows editable, or listed
  expect((await patch(base, 304, { title: "待っている編集" })).status).toBe(202);
  core!.db.sqlite.query("UPDATE backlog_records SET fetch_state = 'unavailable' WHERE object_kind = 'issue' AND json_extract(remote, '$.number') = 304").run();
  expect((await patch(base, 304, { title: "y" })).status).toBe(409);
  expect((await refreshed(base, false)).items.some((i) => i.number === 304)).toBe(false);
  core!.db.sqlite.query("DELETE FROM backlog_operations").run();
  const token = `ghp_${"a".repeat(36)}`;
  const leaked = await patch(base, 304, { body: `メモ\n${token}` });
  expect(leaked.status).toBe(422);
  expect(await leaked.text()).not.toContain(token);
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: token }) })).status).toBe(422);
  // an account id of the host's AWS config, written bare
  const bare = await withHostAccount(async (id) => {
    const r = await patch(base, 304, { body: `メモ\n${id}` });
    return { status: r.status, leaks: (await r.text()).includes(id) };
  });
  expect(bare).toEqual({ status: 422, leaks: false });
  // the values that go to GitHub as they are: a Project field, a label, a milestone
  for (const edit of [{ fields: { Note: token } }, { fields: { [token]: "x" } }, { labels: { add: [token] } }, { milestone: token }]) expect((await patch(base, 304, edit)).status).toBe(422);
  expect(core!.db.listPendingBacklogOperations()).toEqual([]);
});

test("resolve: a held conflict shows its three values and what A cannot keep; a choice names its revision — old 409, with an edit 400, none there 409", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true; // nothing is sent: the edits wait
  const was = (await detailOf(base, 304)).issue;
  expect((await patch(base, 304, { title: "手元の題", body: "手元の本文" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題", body: "GitHub の本文" });
  const d = await detailOf(base, 304);
  const title = d.held.find((h) => h.field === "title")!;
  expect(title).toMatchObject({ status: "conflict", kind: "set", reason: expect.stringContaining("GitHub の題"), conflict: { base: was.title, local: "手元の題", remote: "GitHub の題", remoteRead: true } });
  // it is held, not sent, and what the check keeps is told as it is, with what stays open (the history read after the write)
  expect(d.pending).toBe(2);
  expect(d.limits).toContain("上書きしうる");
  expect(d.limits).toContain("同じ GitHub アカウントで GitHub の画面から書いた編集は、ほかの人の編集と区別しません");
  expect(d.limits).toContain("100 版");
  const resolve = (field: string, choice: string, expectedRevision: string, extra = {}) => patch(base, 304, { resolve: { field, choice, expectedRevision }, ...extra });

  expect((await resolve("title", "local", title.conflict!.revision, { title: "ついで" })).status).toBe(400);
  expect((await resolve("milestone", "local", title.conflict!.revision)).status).toBe(409);
  // GitHub moved again after the screen read it
  importedAs(304, { title: "GitHub の題 2", body: "GitHub の本文" });
  const old = await resolve("title", "local", title.conflict!.revision);
  expect(old.status).toBe(409);
  expect((await detailOf(base, 304)).held.map((h) => h.status)).toEqual(["conflict", "conflict"]);

  // the local value: sent again on GitHub's; GitHub's value: the edit is dropped and GitHub's shows
  const now = await detailOf(base, 304);
  const r = await resolve("title", "local", now.held.find((h) => h.field === "title")!.conflict!.revision);
  expect(r.status).toBe(202);
  expect(core!.db.getBacklogOperation(((await r.json()) as { operation: string }).operation)).toMatchObject({ status: "pending", base: "GitHub の題 2", payload: "手元の題" });
  expect((await resolve("body", "remote", now.held.find((h) => h.field === "body")!.conflict!.revision)).status).toBe(202);
  const after = await detailOf(base, 304);
  expect(after.held).toEqual([]);
  expect(after.issue).toMatchObject({ title: "手元の題", body: "GitHub の本文" });
});

test("overwritten: a conflict the write found afterwards shows the other's value from the history as remote, not GitHub's; remote sends it back, a gone revision is not readable", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await patch(base, 304, { title: "v3", body: "b3" })).status).toBe(202);
  // the send wrote both (GitHub now has them) and found another login's edits in the history
  const ops = core!.db.listPendingBacklogOperations();
  core!.db.setBacklogOperationResult(ops.find((o) => o.field === "title")!.id, { status: "conflict", error: "書く直前に them が 2026-10-12T10:00:00Z に title を v2 にしていました", overwritten: { value: "v2", editor: "them", at: "2026-10-12T10:00:00Z" } });
  core!.db.setBacklogOperationResult(ops.find((o) => o.field === "body")!.id, { status: "conflict", error: "版の内容は履歴から消されています", overwritten: { editor: "them", at: "2026-10-12T10:00:00Z" } });
  importedAs(304, { title: "v3", body: "b3" });
  const d = await detailOf(base, 304);
  const title = d.held.find((h) => h.field === "title")!;
  expect(title).toMatchObject({ status: "conflict", reason: expect.stringContaining("them"), conflict: { base: expect.anything(), local: "v3", remote: "v2", remoteRead: true } });
  expect(d.held.find((h) => h.field === "body")!.conflict).toMatchObject({ local: "b3", remote: null, remoteRead: false });
  const resolve = (field: string, choice: string, expectedRevision: string) => patch(base, 304, { resolve: { field, choice, expectedRevision } });
  // the gone revision cannot be chosen as remote; local goes on
  expect((await resolve("body", "remote", d.held.find((h) => h.field === "body")!.conflict!.revision)).status).toBe(409);
  expect((await resolve("body", "local", d.held.find((h) => h.field === "body")!.conflict!.revision)).status).toBe(202);
  // remote: the found value is queued as a new set on GitHub's current value
  const r = await resolve("title", "remote", title.conflict!.revision);
  expect(r.status).toBe(202);
  expect(core!.db.getBacklogOperation(((await r.json()) as { operation: string }).operation)).toMatchObject({ status: "pending", payload: "v2", base: "v3", overwritten: null });
  expect((await detailOf(base, 304)).issue).toMatchObject({ title: "v2", body: "b3" });
});

test("limits: what the send cannot keep is named per field — the Project fields without a history, the evicted revision, the same login — and nothing is promised", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const d = await detailOf(base, 304);
  expect(d.limits).toContain("Status 以外の Project フィールド");
  expect(d.limits).toContain("100 版");
  expect(d.limits).toContain("同じ GitHub アカウント");
  expect(d.limits).toContain("消されていれば");
  expect(d.limits).toContain("同じ GitHub アカウントで GitHub の画面から書いた編集は、ほかの人の編集と区別しません");
  expect(d.limits).not.toMatch(/保証します|防ぎます/);
});

test("resolve: the same number in another repository is another Issue — a choice there does not touch this one's conflict", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題" });
  const held = (await detailOf(base, 304)).held[0]!;
  // another workspace whose repository has its own Issue 304, nothing held
  const db = core!.db;
  const mine = db.getWorkspaceBacklogSource(metaId())!;
  const other = db.upsertWorkspace({ id: "ws_tool", name: "tool", path: join(home!, "tool"), kind: "repo" });
  const source = { ...mine, repository: "acme/tool" };
  db.setWorkspaceBacklogSource(other.id, source);
  const rec = db.listBacklogRecords(mine, "issue").find((r) => (r.remote as { number: number }).number === 304)!;
  // the same external id too: only the repository tells them apart
  db.putBacklogSnapshot(source, { records: [{ objectKind: "issue", externalId: rec.externalId, remote: rec.remote as never, fetchState: "fetched" }], cursor: null, syncedAt: Date.now() });
  const r = await fetch(`${base}/api/backlog/304`, { method: "PATCH", body: JSON.stringify({ workspaceId: other.id, resolve: { field: "title", choice: "remote", expectedRevision: held.conflict!.revision } }) });
  expect(r.status).toBe(409);
  expect(((await (await fetch(`${base}/api/backlog/304?workspaceId=${other.id}`)).json()) as BacklogIssueDetail).held).toEqual([]);
  expect((await detailOf(base, 304)).held).toEqual([held]);
});

test("resolve: a conflict GitHub cannot be read on keeps GitHub's only; a refused send is shown as held with its reason, not as sent", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題" });
  importedAs(304, {}, "forbidden");
  const held = (await detailOf(base, 304)).held[0]!;
  expect(held.conflict).toMatchObject({ remote: null, remoteRead: false });
  expect((await patch(base, 304, { resolve: { field: "title", choice: "local", expectedRevision: held.conflict!.revision } })).status).toBe(409);
  expect((await patch(base, 304, { resolve: { field: "title", choice: "remote", expectedRevision: held.conflict!.revision } })).status).toBe(202);

  // a permission refused on the send: failed, with why
  core!.db.sqlite.exec("DELETE FROM backlog_operations");
  importedAs(304, { title: "GitHub の題" });
  expect((await patch(base, 304, { title: "書けない題" })).status).toBe(202);
  const op = core!.db.listPendingBacklogOperations()[0]!;
  core!.db.setBacklogOperationResult(op.id, { status: "failed", error: "gh api repos/acme/app/issues/304: HTTP 403" });
  expect((await detailOf(base, 304)).held).toEqual([expect.objectContaining({ operation: op.id, status: "failed", reason: expect.stringContaining("403"), conflict: null })]);
});

/* ---------- a failed operation sent again ---------- */

test("retry: a failed set / comment / create goes back to pending; one not failed, of another Issue or another repository is 409 and nothing changes; with an edit 400", async () => {
  const base = await boot(fakeGh().gh);
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  // during a limit: nothing is sent, the operations stay as this test sets them
  db.setBacklogRetryAt(source, Date.now() + 3_600_000);
  expect((await patch(base, 304, { title: "送れなかった題", body: "まだ送る本文", fields: { Priority: "P1" } })).status).toBe(202);
  expect((await fetch(`${base}/api/backlog/304/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "送れなかったコメント" }) })).status).toBe(202);
  expect((await patch(base, 305, { title: "別の Issue の題" })).status).toBe(202);
  const created = await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title: "作れなかった Issue", body: "", labels: [], fields: { Status: "Backlog" } }) });
  const { localId } = (await created.json()) as { localId: string };
  const ops = db.listPendingBacklogOperations(source);
  const of = (pred: (o: (typeof ops)[number]) => boolean) => ops.find(pred)!;
  const title = of((o) => o.field === "title" && o.payload === "送れなかった題");
  const comment = of((o) => o.kind === "comment");
  const other = of((o) => o.field === "title" && o.payload === "別の Issue の題");
  const body = of((o) => o.field === "body");
  const priority = of((o) => o.field?.includes("Priority") ?? false);
  for (const o of [title, comment, other]) db.setBacklogOperationResult(o.id, { status: "failed", attempt: 3, retryAt: 1, error: "HTTP 403: Resource not accessible" });
  db.setBacklogOperationResult(localId, { status: "failed", attempt: 1, error: "HTTP 403: read:project" });
  db.setBacklogOperationResult(priority.id, { status: "unknown", error: "送ったかどうか分からない" });
  const retry = (ref: number | string, operation: string, extra = {}) => patch(base, ref, { retry: { operation }, ...extra });
  const snapshot = () => JSON.stringify(db.listBacklogOperations(source));

  // refused, nothing changed: with an edit, not failed (pending, unknown, sending, conflict, done), another Issue's, no such one
  const before = snapshot();
  expect((await retry(304, title.id, { title: "ついで" })).status).toBe(400);
  expect((await retry(304, body.id)).status).toBe(409);
  expect((await retry(304, priority.id)).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "sending" });
  expect((await retry(304, body.id)).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "conflict", error: "重なった" });
  expect((await retry(304, body.id)).status).toBe(409);
  expect((await retry(304, other.id)).status).toBe(409);
  expect((await retry(304, "no-such-operation")).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "done" });
  expect((await retry(304, body.id)).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "pending", error: null });
  expect(JSON.parse(snapshot()).map((o: { id: string; status: string }) => [o.id, o.status])).toEqual(JSON.parse(before).map((o: { id: string; status: string }) => [o.id, o.id === body.id ? "pending" : o.status]));
  // the same number in another repository: another Issue, its failed edit is not this one's
  const ws = db.upsertWorkspace({ id: "ws_tool", name: "tool", path: join(home!, "tool"), kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, { ...source, repository: "acme/tool" });
  const rec = db.listBacklogRecords(source, "issue").find((r) => (r.remote as { number: number } | null)?.number === 304)!;
  db.putBacklogSnapshot({ ...source, repository: "acme/tool" }, { records: [{ objectKind: "issue", externalId: rec.externalId, remote: rec.remote as never, fetchState: "fetched" }], cursor: null, syncedAt: Date.now() });
  expect((await fetch(`${base}/api/backlog/304`, { method: "PATCH", body: JSON.stringify({ workspaceId: ws.id, retry: { operation: title.id } }) })).status).toBe(409);
  expect(db.getBacklogOperation(title.id)).toMatchObject({ status: "failed", attempt: 3 });

  // the failed ones of the Issue go back to pending as at first; the held list no longer has them
  for (const [ref, id] of [[304, title.id], [304, comment.id], [localId, localId]] as const) {
    const r = await retry(ref, id);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ operation: id });
    expect(db.getBacklogOperation(id)).toMatchObject({ status: "pending", attempt: 0, retryAt: null, error: null });
  }
  expect((await detailOf(base, 304)).held.map((h) => [h.operation, h.status])).toEqual([[priority.id, "unknown"]]);
  expect((await detailOf(base, localId)).held).toEqual([]);
  // sent again already: nothing to retry
  expect((await retry(304, title.id)).status).toBe(409);
  expect(db.getBacklogOperation(other.id)).toMatchObject({ status: "failed", attempt: 3 });
});

test("cancel: a comment inside its send window is taken back (202); again, past the window, or not a comment is 409; with an edit 400", async () => {
  const base = await boot(fakeGh().gh);
  const db = core!.db;
  expect((await fetch(`${base}/api/backlog/304/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "取り消すコメント" }) })).status).toBe(202);
  expect((await patch(base, 304, { title: "コメントでない操作" })).status).toBe(202);
  const ops = db.listPendingBacklogOperations();
  const comment = ops.find((o) => o.kind === "comment")!;
  const title = ops.find((o) => o.field === "title")!;
  const cancel = (operation: string, extra = {}) => patch(base, 304, { cancel: { operation }, ...extra });
  expect((await cancel(comment.id, { title: "ついで" })).status).toBe(400);
  expect((await cancel(title.id)).status).toBe(409);
  const r = await cancel(comment.id);
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ operation: comment.id });
  expect(db.getBacklogOperation(comment.id)).toMatchObject({ status: "done", error: "送る前に取り消しました" });
  expect((await cancel(comment.id)).status).toBe(409);
});

test("create: a new Issue is kept with a local id, read and edited by it before it has a number; it is not in the list yet", async () => {
  const base = await boot(fakeGh().gh);
  // during a limit: nothing is sent, so the create can still be changed
  core!.db.setBacklogRetryAt(core!.db.getWorkspaceBacklogSource(metaId())!, Date.now() + 3_600_000);
  const r = await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title: "要望: 新しい", body: "本文", labels: ["type:request"], fields: { Status: "Backlog" } }) });
  expect(r.status).toBe(202);
  const { localId } = (await r.json()) as { localId: string };
  const d = await detailOf(base, localId);
  expect(d).toMatchObject({ localId, pending: 1, fields: { Status: "Backlog" }, issue: { number: 0, title: "要望: 新しい", labels: ["type:request"] } });
  // not sent yet: the edit changes what is created
  expect((await patch(base, localId, { title: "要望: 直した", fields: { Priority: "P2" } })).status).toBe(202);
  expect(core!.db.listPendingBacklogOperations()).toMatchObject([{ id: localId, kind: "create", payload: { title: "要望: 直した", project: { owner: "acme", number: 11, fields: { Status: "Backlog", Priority: "P2" } } } }]);
  expect((await detailOf(base, localId)).issue.title).toBe("要望: 直した");
  expect((await refreshed(base, false)).items.some((i) => i.number === 0)).toBe(false);
  expect((await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title: " " }) })).status).toBe(400);
});

test("send: an answer kept is sent to GitHub once its window has passed; after a restart one that was out is looked for, not posted again", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const posts = () => fake.calls.filter((a) => a[1] === "repos/acme/app/issues/306/comments" && a.includes("POST")).length;
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "すぐ送る" }) })).status).toBe(202);
  // inside its 60 s window nothing is posted; the window over, the next send run posts it
  await Bun.sleep(50);
  expect(posts()).toBe(0);
  core!.db.sqlite.exec("UPDATE backlog_operations SET retry_at = NULL");
  expect((await patch(base, 306, { title: "送りを促す" })).status).toBe(202);
  for (let i = 0; i < 100 && posts() === 0; i++) await Bun.sleep(10);
  expect(posts()).toBe(1);

  // the daemon stops while a post is out; at its start it looks for it and posts nothing
  const h = home!;
  const db = core!.db;
  db.sqlite.exec("DELETE FROM backlog_operations; DELETE FROM backlog_records WHERE remote IS NULL; UPDATE backlog_records SET local = NULL");
  db.setBacklogRetryAt(db.getWorkspaceBacklogSource(metaId())!, Date.now() + 3_600_000);
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "送信中に止まった" }) })).status).toBe(202);
  db.sqlite.exec("UPDATE backlog_operations SET retry_at = NULL"); // its window over
  db.setBacklogOperationResult(db.listPendingBacklogOperations()[0]!.id, { status: "sending" });
  db.sqlite.exec("UPDATE backlog_repositories SET retry_at = NULL");
  await core!.stop();
  fake.calls.length = 0;
  const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_KNOWLEDGE: join(h, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(h, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fake.gh), backlogAutoImport: true });
  const looked = () => fake.calls.some((a) => a[1]?.startsWith("repos/acme/app/issues/306/comments?"));
  for (let i = 0; i < 100 && !looked(); i++) await Bun.sleep(10);
  expect(looked()).toBe(true);
  // the look runs with it `sending` (not taken back meanwhile); this fake cannot answer the list, so it waits unknown
  for (let i = 0; i < 100 && core.db.listPendingBacklogOperations()[0]?.status === "sending"; i++) await Bun.sleep(10);
  expect(posts()).toBe(0);
  expect(core.db.listPendingBacklogOperations()[0]).toMatchObject({ kind: "comment", status: "unknown" });
});

test("an answer during a limit is stored, read by the next start, and sent after the limit", async () => {
  const fake = limitedGh();
  // GitHub's REST answers for Issue 306's comments and labels, as backlog-send.test.ts's fake GitHub gives them
  // and its reads before and after a write (graphql) with no one else's edits
  const comments: Array<{ node_id: string; body: string; created_at: string }> = [];
  let labels = ["type:pbi", "needs-decision"];
  const ok = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\ndate: ${new Date().toUTCString()}\n\n${JSON.stringify(body)}`, stderr: "" });
  const gh: GhRunner = async (args, cwd) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    const of306 = args[1]?.startsWith("repos/acme/app/issues/306/") || (query.includes("issue(number:$n)") && args.includes("n=306"));
    if (fake.limited.on || args[0] !== "api" || !of306) return fake.gh(args, cwd);
    fake.calls.push(args);
    if (args[1] === "graphql") {
      const r = core!.db.listBacklogRecords(core!.db.getWorkspaceBacklogSource(metaId())!, "issue").find((x) => (x.remote as { number: number } | null)?.number === 306)!.remote as unknown as { id: string; title: string; body: string };
      const issue = { id: r.id, title: r.title, body: r.body, state: "OPEN", milestone: null, parent: null, labels: { nodes: labels.map((name) => ({ name })) }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] }, userContentEdits: { pageInfo: { hasNextPage: false }, nodes: [] } };
      return ok({ data: { viewer: { login: "me" }, repository: { issue } } });
    }
    if (args[1] === "repos/acme/app/issues/306/comments" && args.includes("POST")) {
      const c = { node_id: `IC_306_${comments.length}`, body: args[args.indexOf("-f") + 1]!.slice("body=".length), created_at: new Date().toISOString() };
      comments.push(c);
      return ok(c);
    }
    if (args.includes("DELETE")) labels = labels.filter((l) => !args[1]!.endsWith(`/labels/${l}`));
    return ok(args[1]!.includes("/comments") ? comments : []);
  };
  const claude = holdingClaude();
  const base = await boot(gh, claude.adapter);
  fake.limited.on = true;
  // 1. answered while GitHub refuses every read and write for its limit: kept here at once
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "上限中の回答" }) })).status).toBe(202);
  const detail = (await (await fetch(`${base}/api/backlog/306?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail;
  expect(detail.comments.at(-1)!.body).toBe("## 回答\n\n上限中の回答");
  expect(detail.sync.pendingCount).toBeGreaterThanOrEqual(1);
  expect((await refreshed(base, false)).items.find((i) => i.number === 306)!.stage).not.toBe("needs-decision");
  // 2. the next stage starts on the stored data, and its Task is told to read the answer with --fresh
  expect((await start(base, 306, { action: "complete" })).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("`ops-kit backlog view 306 --fresh`");
  // 3. the limit ends (its time passed: the daemon starts again without the wait): the answer is sent once, comment then label
  const h = home!;
  core!.db.sqlite.exec("UPDATE backlog_repositories SET retry_at = NULL; UPDATE backlog_operations SET retry_at = NULL");
  await core!.stop();
  fake.limited.on = false;
  fake.calls.length = 0;
  const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_KNOWLEDGE: join(h, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(h, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh), backlogAutoImport: true });
  const after = `http://127.0.0.1:${core.server.port}`;
  const writes = () => fake.calls.filter((a) => a.includes("POST") || a.includes("DELETE")).map((a) => `${a.includes("POST") ? "POST" : "DELETE"} ${a[1]}`);
  for (let i = 0; i < 200 && core.db.listPendingBacklogOperations().length > 0; i++) await Bun.sleep(10);
  expect(writes()).toEqual(["POST repos/acme/app/issues/306/comments", "DELETE repos/acme/app/issues/306/labels/needs-decision"]);
  expect(comments.map((c) => c.body.split("\n\n<!--")[0])).toEqual(["## 回答\n\n上限中の回答"]);
  await fetch(`${after}/api/backlog/sync`, { method: "POST", body: JSON.stringify({ workspaceId: metaId() }) });
  expect(((await (await fetch(`${after}/api/backlog/306?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail).sync.pendingCount).toBe(0);
});

test("comment: a plain comment is kept here at once (202) as a comment operation — no heading, no label change — and refused for a secret or an unknown Issue", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  const post = (n: number, text: string) => fetch(`${base}/api/backlog/${n}/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text }) });
  const r = await post(304, "確認しました");
  expect(r.status).toBe(202);
  const ops = core!.db.listPendingBacklogOperations().filter((o) => o.kind === "comment");
  expect(ops).toHaveLength(1);
  expect(ops[0]!.payload).toEqual({ body: "確認しました" });
  expect(core!.db.listPendingBacklogOperations().filter((o) => o.kind === "set")).toEqual([]);
  expect((await detailOf(base, 304)).comments.map((c) => c.body)).toContain("確認しました");
  expect((await post(999, "x")).status).toBe(404);
  expect((await post(304, "ghp_" + "a".repeat(36))).status).toBe(422);
  expect((await fetch(`${base}/api/backlog/304/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "  " }) })).status).toBe(400);
});
