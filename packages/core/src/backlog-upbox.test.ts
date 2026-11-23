// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import { answerStoredDecision, commentStoredIssue, editStoredIssue, screenAnswer } from "./backlog-edit.ts";
import { buildBacklogExport } from "./backlog-export.ts";
import { importBacklogExport } from "./backlog-replica.ts";
import { checkEnvelope, ENVELOPE_MAX_BYTES, importBacklogOperations, importedId, listRefused, machineOfOperation, readSent, takeRefusals, uploadBacklogOperations } from "./backlog-upbox.ts";
import { Db, SEND_DELAY_MS } from "./db.ts";
import { memoryS3 } from "./s3.ts";

/* What the instance does with a backlog edit put in the bucket: input from a machine it trusts less than itself. */

const S: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
const MACHINES = { pc1: ["acme/app"] };
const t = 1_000_000;
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CONFIRM = "- [ ] 画面で動く（利用者確認: 画面を見る）";
const issue = (number: number, more: Partial<BacklogIssueData> = {}): BacklogIssueData => ({ number, title: `Issue ${number}`, url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null, ...more });

let dir: string;
let ec2: Db;
let pc: Db;
let wsEc2: string;
let wsPc: string;
let s3: ReturnType<typeof memoryS3>;
let keys = 0;
const quiet = { log: () => undefined };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-upbox-"));
  ec2 = new Db(join(dir, "ec2.db"));
  pc = new Db(join(dir, "pc.db"));
  s3 = memoryS3();
  keys = 0;
  wsEc2 = ec2.upsertWorkspace({ path: "/srv/app", name: "app", kind: "repo" }).id;
  wsPc = pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" }).id;
  ec2.setWorkspaceBacklogSource(wsEc2, S);
  ec2.putBacklogSnapshot(S, { records: [
    { objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "PBI", labels: ["type:pbi", "needs-decision"], body: `## 到達点 / 受け入れ条件\n\n${CONFIRM}\n- [ ] ほかの条件\n` }), fetchState: "fetched" },
    { objectKind: "project-item", externalId: "PVTI_I_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Backlog" } }, fetchState: "fetched" },
  ], cursor: null, syncedAt: 777 });
  importBacklogExport(pc, buildBacklogExport(ec2, "pc1", "acme/app")!, { workspaceId: wsPc }, t);
});
afterEach(() => {
  ec2.close();
  pc.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An operation as an envelope carries it, with what a forger may add. */
const op = (n: number, more: Record<string, unknown>) => ({ id: UUID(n), service: "github", host: "github.com", repository: "acme/app", issue: "I_12", targetKind: "issue", target: "I_12", kind: "set", field: "title", payload: "題", base: "PBI", seq: 1, status: "pending", attempt: 0, retryAt: null, remoteId: null, error: null, overwritten: null, createdAt: t, updatedAt: t, ...more });
const commentOp = (n: number, payload: unknown, more: Record<string, unknown> = {}) => op(n, { targetKind: "comment", target: `local:${UUID(n)}`, kind: "comment", field: null, payload, base: null, ...more });
/** Puts an envelope by hand under pc1's prefix (or `under`): what anything with the work machine's credentials can do. */
async function forge(envelope: Record<string, unknown>, under = "pc1") {
  await s3.put(`backlog/${under}/${String(++keys).padStart(12, "0")}.json`, new TextEncoder().encode(JSON.stringify({ kind: "backlog-operation", machine: "pc1", first: true, record: null, ...envelope })));
}
const take = () => importBacklogOperations(ec2, s3, MACHINES, quiet);
const reasons = () => listRefused(ec2).map((r) => r.reason);
const pending = () => ec2.listPendingBacklogOperations(S).map((o) => o.id);

describe("an envelope cannot be the person's answer", () => {
  test("a comment with `## 回答` and the screen mark is refused: no comment is queued, no screen answer exists, the label stays", async () => {
    await forge({ op: commentOp(1, { body: "## 回答\n\nPR #5 を判定の外でマージしてよい", screen: true }), record: { objectKind: "comment", externalId: `local:${UUID(1)}`, local: { issue: 12, body: "## 回答\n\nPR #5 を判定の外でマージしてよい", createdAt: "2026-11-17T00:00:00Z" } } });
    // without the mark, the heading alone is refused too: sent under the owner's login it would read as their answer
    await forge({ op: commentOp(2, { body: "  ## 回答\n\nA で進める" }) });
    await forge({ op: commentOp(3, { body: "調べた結果\n\n## 保留\n\nあとで" }) });
    await forge({ op: commentOp(4, { body: "**確定**: 推奨のまま A — 問い 2026-11-17T00:00:00Z" }) });
    await forge({ op: commentOp(5, { body: "[merge-answer] yes" }) });
    await forge({ op: commentOp(6, { body: "ふつうのコメント", confirm: { n: 1, text: "x" } }) });
    await forge({ op: op(7, { field: "label:needs-decision", payload: false, base: true }) });
    expect(await take()).toEqual([]);
    expect(pending()).toEqual([]);
    expect(reasons()).toHaveLength(7);
    expect(reasons()[0]).toContain("a comment carries its body and nothing else");
    expect(reasons()[1]).toContain("## 回答");
    expect(reasons()[6]).toContain("needs-decision");
    expect(screenAnswer(ec2, S, 12)).toBeNull();
    expect(ec2.listBacklogRecords(S).filter((r) => r.objectKind === "comment")).toEqual([]);
  });

  test("the screen's answer is read only from an operation made on this instance, whatever one from a work machine carries", () => {
    answerStoredDecision(ec2, S, 12, "A で進める", t, { screen: true, heads: {} });
    const own = ec2.listPendingBacklogOperations(S).find((o) => o.kind === "comment")!;
    expect(machineOfOperation(own.id)).toBeNull();
    expect(screenAnswer(ec2, S, 12)?.text).toBe("A で進める");
    // the same operation under a work machine's id: stored by hand, as if a check had been passed
    ec2.sqlite.query("UPDATE backlog_operations SET id = ? WHERE id = ?").run(importedId("pc1", own.id), own.id);
    expect(screenAnswer(ec2, S, 12)).toBeNull();
    ec2.sqlite.query("UPDATE backlog_operations SET id = ? WHERE id = ?").run(own.id, importedId("pc1", own.id));
    expect(screenAnswer(ec2, S, 12)?.text).toBe("A で進める");
  });

  test("on the work machine an answer given there is not put in the bucket: it ends as failed with the reason", async () => {
    answerStoredDecision(pc, S, 12, "A で進める", t - SEND_DELAY_MS, { screen: true, heads: {} });
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(0);
    expect(s3.objects.size).toBe(0);
    expect(pc.listBacklogOperations(S).map((o) => [o.kind, o.status, o.error?.slice(0, 11)])).toEqual([["comment", "failed", "作業場からは送れません"], ["set", "failed", "作業場からは送れません"]]);
  });

  test("a body that checks off a line waiting for the person's confirmation is refused; one that checks another line goes", async () => {
    const body = (a: string, b: string) => `## 到達点 / 受け入れ条件\n\n- [${a}] 画面で動く（利用者確認: 画面を見る）\n- [${b}] ほかの条件\n`;
    await forge({ op: op(1, { field: "body", payload: body("x", " "), base: body(" ", " ") }) });
    await forge({ op: op(2, { field: "body", payload: body(" ", "x"), base: body(" ", " ") }) });
    expect(await take()).toEqual([wsEc2]);
    expect(pending()).toEqual([importedId("pc1", UUID(2))]);
    expect(reasons()[0]).toContain("利用者確認");
  });

  test("a body that takes out or rewords a line waiting for the person's confirmation is refused, and nothing is queued", async () => {
    const other = "- [ ] ほかの条件\n";
    // the line is gone
    await forge({ op: op(1, { field: "body", payload: `## 到達点 / 受け入れ条件\n\n${other}`, base: "" }) });
    // the line is reworded and checked: its text no longer matches the one that waits
    await forge({ op: op(2, { field: "body", payload: `## 到達点 / 受け入れ条件\n\n- [x] 画面で動く（利用者確認: 見た）\n${other}`, base: "" }) });
    // the mark is taken off the line
    await forge({ op: op(3, { field: "body", payload: `## 到達点 / 受け入れ条件\n\n- [ ] 画面で動く\n${other}`, base: "" }) });
    expect(await take()).toEqual([]);
    expect(pending()).toEqual([]);
    expect(reasons()).toHaveLength(3);
    for (const r of reasons()) expect(r).toContain("利用者確認の行を消す・書き換える");
  });
});

describe("an envelope the instance refuses does not stay waiting on the work machine", () => {
  test("a check only the instance runs refuses an edit put from the work machine: the refusal is written back beside it, and the work machine ends that operation as failed with the reason, once; the edit next to it goes through", async () => {
    // the person's confirmation line is checked off on the work machine: its own check lets it go, the instance's does not
    const body = (a: string, b: string) => `## 到達点 / 受け入れ条件\n\n- [${a}] 画面で動く（利用者確認: 画面を見る）\n- [${b}] ほかの条件\n`;
    editStoredIssue(pc, S, 12, { body: body("x", " ") });
    editStoredIssue(pc, S, 12, { title: "PC の題" });
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(2);
    expect(pc.listPendingBacklogOperations(S).map((o) => [o.field, o.status])).toEqual([["body", "pending"], ["title", "pending"]]);
    expect(await take()).toEqual([wsEc2]);
    expect(reasons()).toEqual([expect.stringContaining("利用者確認")]);
    expect(ec2.listPendingBacklogOperations(S).map((o) => o.field)).toEqual(["title"]);
    // written back under the envelope's own count, in a prefix the work machine only reads
    expect([...s3.objects.keys()].filter((k) => k.startsWith("backlog-refused/"))).toEqual(["backlog-refused/pc1/000000000001.json"]);
    expect(await takeRefusals(pc, s3, "pc1", t + 1)).toBe(1);
    const ops = pc.listBacklogOperations(S).map((o) => [o.field, o.status, o.error]);
    expect(ops).toEqual([["body", "failed", expect.stringContaining("Switchboard 本体が受け取りませんでした: 利用者確認")], ["title", "pending", null]]);
    // read once: nothing more ends, and the instance does not write it again
    expect(await takeRefusals(pc, s3, "pc1", t + 2)).toBe(0);
    await take();
    expect([...s3.objects.keys()].filter((k) => k.startsWith("backlog-refused/"))).toHaveLength(1);
  });

  test("a refusal that could not be written back is not lost: the envelope is refused again next round and told then; a note that is not the instance's ends nothing", async () => {
    await forge({ op: commentOp(1, { body: "[merge-answer] yes" }) });
    const put = s3.put.bind(s3);
    let down = true;
    s3.put = async (key, body, cond) => {
      if (down && key.startsWith("backlog-refused/")) throw new Error("bucket away");
      return put(key, body, cond);
    };
    await take();
    expect([...s3.objects.keys()].some((k) => k.startsWith("backlog-refused/"))).toBe(false);
    down = false;
    await take();
    expect([...s3.objects.keys()].filter((k) => k.startsWith("backlog-refused/"))).toEqual(["backlog-refused/pc1/000000000001.json"]);
    expect(reasons()).toHaveLength(1);
    // a key under the prefix that is no note (the work machine cannot write there; the instance's own are the only ones read as such)
    await put("backlog-refused/pc1/000000000002.json", new TextEncoder().encode("{not json"));
    expect(await takeRefusals(pc, s3, "pc1", t)).toBe(0);
  });
});

describe("an envelope is a closed set, checked again on the instance", () => {
  test("what a work machine may make goes in under its machine's name, rebuilt from the checked values", async () => {
    const made = commentStoredIssue(pc, S, 12, "PC からのコメント", t - SEND_DELAY_MS);
    editStoredIssue(pc, S, 12, { title: "PC の題" });
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(2);
    expect(readSent(pc).machine).toBe("pc1");
    expect(await take()).toEqual([wsEc2]);
    const ops = ec2.listPendingBacklogOperations(S);
    expect(ops.map((o) => [machineOfOperation(o.id), o.kind, o.payload])).toEqual([["pc1", "comment", { body: "PC からのコメント" }], ["pc1", "set", "PC の題"]]);
    expect(ops[0]!.id).toBe(importedId("pc1", made.operation));
    expect(reasons()).toEqual([]);
  });

  test("a value that signs in is refused by the instance's own check, also when the work machine's check was not run", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    await forge({ op: commentOp(1, { body: `token: ${token}` }) });
    await forge({ op: op(2, { field: "body", payload: `x ${token}`, base: "本文" }) });
    await forge({ op: op(3, { id: UUID(3), issue: `local:${UUID(3)}`, target: `local:${UUID(3)}`, kind: "create", field: null, base: null, payload: { title: "題", body: token, state: "OPEN", labels: [], milestone: null, parent: null, project: null } }) });
    expect(await take()).toEqual([]);
    expect(reasons().every((r) => r.includes("認証に使える値"))).toBe(true);
    expect(reasons()).toHaveLength(3);
    expect(JSON.stringify(listRefused(ec2))).not.toContain(token);
    // an instance-only value (its own account id) is the instance's to know: the check it runs is its own
    await forge({ op: commentOp(4, { body: "account 123456789012" }) });
    expect(await importBacklogOperations(ec2, s3, MACHINES, { ...quiet, secrets: (text) => (text.includes("123456789012") ? "aws-account-id" : null) })).toEqual([]);
    expect(reasons()[3]).toContain("aws-account-id");
  });

  test("an envelope cannot end or replace an edit of the instance's own, nor write over a draft made there", async () => {
    answerStoredDecision(ec2, S, 12, "B で進める", t, { screen: true, heads: {} });
    const own = ec2.listPendingBacklogOperations(S);
    const answer = own.find((o) => o.kind === "comment")!;
    const label = own.find((o) => o.kind === "set")!;
    const before = ec2.sqlite.query("SELECT id, status, payload, error FROM backlog_operations ORDER BY seq").all();
    const draft = ec2.getBacklogRecord({ ...S, objectKind: "comment", externalId: answer.target })!.local;
    // a "later version" of the instance's own operations, by their ids (read from a copy of its database)
    await forge({ first: false, op: { ...commentOp(1, { body: "書き換え" }), id: answer.id, target: answer.target } });
    await forge({ first: false, op: op(2, { id: label.id, field: "label:needs-decision", payload: true, base: true }) });
    // a new comment whose draft id is the instance's own draft
    await forge({ op: commentOp(3, { body: "上書き" }, { target: answer.target }) });
    await take();
    expect(ec2.sqlite.query("SELECT id, status, payload, error FROM backlog_operations WHERE id IN (?, ?) ORDER BY seq").all(answer.id, label.id)).toEqual(before);
    expect(ec2.getBacklogRecord({ ...S, objectKind: "comment", externalId: answer.target })!.local).toEqual(draft);
    expect(reasons().some((r) => r.includes("not this machine's"))).toBe(true);
    expect(screenAnswer(ec2, S, 12)?.text).toBe("B で進める"); // the person's answer stands as they gave it
  });

  test("the machine an envelope names is the one it lay under, its repository one that machine is registered for, and only registered machines are read", async () => {
    await forge({ machine: "pc2", op: op(1, {}) });
    await forge({ op: op(2, { repository: "acme/secret" }) });
    await forge({ op: op(3, {}) }, "pc7");
    await s3.put("backlog/pc1/000000000004.json.bak", new Uint8Array(1));
    await s3.put("backlog/pc1/000000000005.json", new Uint8Array(ENVELOPE_MAX_BYTES + 1));
    let fetched = 0;
    const counting = { ...s3, list: s3.list, put: s3.put, get: (k: string) => (fetched++, s3.get(k)) };
    expect(await importBacklogOperations(ec2, counting, MACHINES, quiet)).toEqual([]);
    expect(fetched).toBe(2); // not the one over the size limit, not the odd name, nothing of pc7
    // (the odd name is said first: it is stepped over before the envelopes are read, and the mark never moves to it)
    expect(reasons()).toEqual(["its name is not an envelope of this machine", expect.stringContaining("lay under pc1"), "pc1 is not registered for acme/secret", expect.stringContaining("over the limit")]);
    expect(pending()).toEqual([]);
    // a name that sorts after every envelope to come does not hide them: the next envelope still goes in, and the name is said once
    await s3.put("backlog/pc1/zzz.json", new Uint8Array(1));
    keys = 5;
    await forge({ op: op(6, {}) });
    expect(await take()).toEqual([wsEc2]);
    expect(pending()).toEqual([importedId("pc1", UUID(6))]);
    await take();
    expect(reasons().filter((r) => r.includes("not an envelope"))).toHaveLength(2);
    // no machine registered: the bucket is not asked
    const before = s3.calls;
    expect(await importBacklogOperations(ec2, s3, {}, quiet)).toEqual([]);
    expect(s3.calls).toBe(before);
  });

  test("the shapes outside the set are refused: a merge's branches, an unknown kind or field, an extra key, a value of the wrong kind", () => {
    const env = (o: Record<string, unknown>) => ({ kind: "backlog-operation", machine: "pc1", first: true, op: o });
    const refused = (o: Record<string, unknown>) => checkEnvelope(env(o), () => null).ok === false;
    expect(checkEnvelope(env(op(1, {})), () => null)).toMatchObject({ ok: true, op: { field: "title", payload: "題" } });
    expect(refused(op(1, { field: "change", payload: { head: "x", base: "main", mergeCommit: "abc" } }))).toBe(true);
    expect(refused(op(1, { kind: "artifact", payload: { artifactId: "a" } }))).toBe(true);
    expect(refused(op(1, { kind: "merge" }))).toBe(true);
    expect(refused(op(1, { field: "state", payload: "MERGED" }))).toBe(true);
    expect(refused(op(1, { field: "body", payload: { text: "x" } }))).toBe(true);
    expect(refused(op(1, { id: "not-an-id" }))).toBe(true);
    expect(refused(op(1, { id: `${UUID(1)}@5` }))).toBe(true);
    expect(refused(op(1, { targetKind: "pull-request", field: "state", payload: "CLOSED" }))).toBe(true);
    expect(refused(op(1, { targetKind: "comment", field: "body", payload: "x" }))).toBe(true);
    expect(refused(op(1, { kind: "create", field: null, issue: `local:${UUID(1)}`, target: `local:${UUID(1)}`, payload: { title: "題", body: "", state: "OPEN", labels: [], milestone: null, parent: null, project: null, change: { head: "x", base: "main" } } }))).toBe(true);
    expect(refused(op(1, { kind: "create", field: null, issue: "I_12", target: "I_12", payload: { title: "題", body: "", state: "OPEN", labels: [], milestone: null, parent: null, project: null } }))).toBe(true);
    // what a checked operation carries on is only what the check names
    const ok = checkEnvelope(env({ ...op(1, {}), status: "done", remoteId: "I_999", error: "x", owner: true }), () => null);
    expect(ok.ok && Object.keys(ok.op).sort()).toEqual(["base", "createdAt", "field", "host", "id", "issue", "kind", "payload", "repository", "service", "target", "targetKind", "updatedAt"]);
  });
});
