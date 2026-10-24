import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerPolicy, AskAnswerResult } from "@switchboard/protocol";
import { DAY, harness, HEAD, policyOf } from "./policies-harness.ts";

/* POST /api/asks/answer with a policy, and /api/policies (#938): the harness's daemon (a scripted runner, a fake gh). */

const h = harness();
const { post, patch, asks, policies, approvalTask, checkTask } = h;
afterEach(() => h.stop());
const boot = (confirm?: string[]) => h.boot(confirm);

/** Runs `fn` with AWS_CONFIG_FILE on a made-up config holding one account id, which it is given bare. */
async function withHostAccount<T>(fn: (id: string) => Promise<T> | T): Promise<T> {
  const id = ["8642", "9753", "1086"].join("");
  const dir = mkdtempSync(join(tmpdir(), "policies.aws."));
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

describe("answers that save a policy (#938)", () => {
  test("save scopes: an approval for the repository, a check for the PBI-less Task and once — each read back with scope, expiry and where it came from", async () => {
    await boot();
    const a = await approvalTask("approve");
    const ask = (await asks()).find((x) => x.kind === "approval")!;
    expect(ask.policy.scopes).toEqual(["once", "repo"]);
    const r = await post("/api/asks/answer", { id: ask.id, answer: { kind: "allow" }, policy: policyOf() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AskAnswerResult;
    expect(body.policy).toMatchObject({ scope: "repo", kind: "approval", op: "exec", target: "bun test*", from: { target: "bun test packages/core" }, workspaceId: h.meta().id });
    expect(a).toBeTruthy();
    const c = await checkTask("check");
    const check = (await asks()).find((x) => x.kind === "check")!;
    const once = await post("/api/asks/answer", { id: check.id, answer: { kind: "choice", choice: "A: マージする" }, policy: { scope: "once", target: "PR #12", when: [], expiresAt: null } });
    expect(once.status).toBe(200);
    expect(c).toBeTruthy();
    const list = await policies();
    expect(list.map((p) => p.scope).sort()).toEqual(["once", "repo"]);
    const saved = list.find((p) => p.scope === "once")!;
    expect(saved).toMatchObject({ askId: check.id, kind: "check", op: "gh pr merge", expiresAt: null, from: { head: HEAD } });
    expect(list.find((p) => p.scope === "repo")!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("refuse: a confirm rule, a security merge check, a secret and a scope the question does not offer are 409 with nothing saved or sent", async () => {
    await boot(["bun test*"]);
    const a = await approvalTask("approve");
    const ask = (await asks()).find((x) => x.kind === "approval")!;
    expect(ask.policy).toMatchObject({ scopes: [] });
    const r = await post("/api/asks/answer", { id: ask.id, answer: { kind: "allow" }, policy: policyOf() });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("都度確認");
    expect(h.core!.db.getTask(a)!.status).toBe("waiting");
    await checkTask("check");
    const check = (await asks()).find((x) => x.kind === "check")!;
    const refuse = async (answer: unknown, policy: unknown) => {
      const x = await post("/api/asks/answer", { id: check.id, answer, policy });
      expect(x.status).toBe(409);
      return ((await x.json()) as { error: string }).error;
    };
    h.mark = "security,large";
    expect(await refuse({ kind: "choice", choice: "A: マージする" }, policyOf({ target: "PR #12" }))).toContain("セキュリティ");
    h.mark = null;
    expect(await refuse({ kind: "text", text: "key AKIA" + "ABCDEFGHIJKLMNOP" }, policyOf({ target: "PR #12" }))).toContain("秘密");
    // an account id of the host's AWS config, written bare (#2351)
    expect(await withHostAccount((id) => refuse({ kind: "text", text: `メモ ${id}` }, policyOf({ target: "PR #12" })))).toContain("秘密");
    expect(await refuse({ kind: "choice", choice: "A: マージする" }, policyOf({ scope: "pbi", target: "PR #12" }))).toContain("この範囲");
    expect(await policies()).toEqual([]);
    expect(h.core!.db.getTask(check.task!.id)!.status).not.toBe("running");
  });

  test("edit: a PATCH changes the target and expiry as saving checks them; * is 400, revoked sets revokedAt, once is 409, an unknown id 404", async () => {
    await boot();
    await approvalTask("approve");
    const ask = (await asks()).find((x) => x.kind === "approval")!;
    await post("/api/asks/answer", { id: ask.id, answer: { kind: "allow" }, policy: policyOf() });
    const [p] = await policies();
    const ok = await patch(`/api/policies/${p!.id}`, { target: "bun test packages/*", expiresAt: Date.now() + 7 * DAY });
    expect(ok.status).toBe(200);
    expect((await policies())[0]).toMatchObject({ target: "bun test packages/*" });
    expect((await patch(`/api/policies/${p!.id}`, { target: "*" })).status).toBe(400);
    expect((await patch(`/api/policies/${p!.id}`, { target: "git push*" })).status).toBe(400);
    expect((await patch(`/api/policies/${p!.id}`, { revoked: true })).status).toBe(200);
    expect((await policies())[0]!.revokedAt).not.toBeNull();
    expect((await patch(`/api/policies/${p!.id}`, { revoked: false })).status).toBe(200);
    expect((await policies())[0]!.revokedAt).toBeNull();
    expect((await patch("/api/policies/pol_none", { revoked: true })).status).toBe(404);
    await checkTask("check");
    const check = (await asks()).find((x) => x.kind === "check")!;
    await post("/api/asks/answer", { id: check.id, answer: { kind: "choice", choice: "A: マージする" }, policy: { scope: "once", target: "PR #12", when: [], expiresAt: null } });
    const once = (await policies()).find((x) => x.scope === "once")!;
    expect((await patch(`/api/policies/${once.id}`, { target: "PR #*" })).status).toBe(409);
    expect((await patch(`/api/policies/${once.id}`, { revoked: true })).status).toBe(200);
  });

  test("a Task: its token, sent without the page's origin, cannot save or edit a policy — a plain answer still goes", async () => {
    await boot();
    await approvalTask("approve");
    const ask = (await asks()).find((x) => x.kind === "approval")!;
    const noOrigin = {};
    const refused = await post("/api/asks/answer", { id: ask.id, answer: { kind: "allow" }, policy: policyOf() }, noOrigin);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "human" });
    // the origin alone is not the page: Sec-Fetch-Site is the browser's own
    expect((await post("/api/asks/answer", { id: ask.id, answer: { kind: "allow" }, policy: policyOf() }, { origin: h.base })).status).toBe(403);
    expect(await policies()).toEqual([]);
    expect(h.core!.db.getTask(ask.task!.id)!.status).toBe("waiting"); // nothing was answered either
    // what a Task could always do: allow its own approval, once
    expect((await post("/api/asks/answer", { id: ask.id, answer: { kind: "allow" } }, noOrigin)).status).toBe(200);
    expect(await policies()).toEqual([]);
    // an edit is refused the same way, and nothing changes
    await approvalTask("approve again");
    const ask2 = (await asks()).find((x) => x.kind === "approval" && x.state === "open")!;
    await post("/api/asks/answer", { id: ask2.id, answer: { kind: "allow" }, policy: policyOf() });
    const [p] = await policies();
    expect((await patch(`/api/policies/${p!.id}`, { revoked: true }, noOrigin)).status).toBe(403);
    expect((await policies())[0]!.revokedAt).toBeNull();
  });

  test("answer fails: when the PR cannot be read the answer is not written and no policy is saved", async () => {
    await boot();
    await checkTask("check");
    const check = (await asks()).find((x) => x.kind === "check")!;
    h.prFails = true;
    const r = await post("/api/asks/answer", { id: check.id, answer: { kind: "choice", choice: "A: マージする" }, policy: policyOf({ target: "PR #12" }) });
    expect(r.status).toBe(424);
    expect(await policies()).toEqual([]);
    expect(h.prCalls).toBeGreaterThan(0);
  });
});
