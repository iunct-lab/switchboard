import { afterEach, describe, expect, test } from "bun:test";
import type { AnswerPolicy, PolicySubject } from "@switchboard/protocol";
import { DAY, harness, policyOf, until } from "./policies-harness.ts";
import { writePolicies } from "./policies.ts";

/* Saved policies answering the next question (#938): tool approvals, a Task's check, a PBI's decision. */

const h = harness();
afterEach(() => h.stop());
const { post, patch, asks, policies, approvalTask, checkTask } = h;

const resolvedBy = (taskId: string) => h.core!.db.listEvents(taskId).flatMap((e) => (e.ev.t === "permission.ask" && e.ev.rule?.mode === "allow" ? [e.ev.rule.source] : []));
const saveApproval = async () => {
  await approvalTask("first");
  const ask = (await asks()).find((x) => x.kind === "approval")!;
  const r = await post("/api/asks/answer", { id: ask.id, answer: { kind: "allow" }, policy: policyOf() });
  expect(r.status).toBe(200);
  return (await policies())[0]!;
};
const from = (target: string): PolicySubject => ({ kind: "check", op: "gh pr merge", target, conditions: [], head: null });
const checkPolicy = (over: Partial<AnswerPolicy> = {}): AnswerPolicy => ({
  id: "pol_t", scope: "repo", workspaceId: h.meta().id, pbi: null, askId: null, kind: "check", op: "gh pr merge", target: "PR #12", when: [], answer: { kind: "choice", choice: "A: マージする" },
  expiresAt: Date.now() + DAY, revokedAt: null, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000, from: from("PR #12"), uses: [], ...over,
});
const settle = () => Bun.sleep(250);

describe("applying saved policies (#938)", () => {
  test("approval applies: the next permission.ask for a matching command is allowed by the policy, with its source, and the use is kept", async () => {
    await h.boot();
    const p = await saveApproval();
    const second = await approvalTask("second");
    expect(resolvedBy(second)).toEqual([`policy:${p.id}`]);
    expect(h.core!.db.getTask(second)!.status).not.toBe("waiting");
    const after = (await policies())[0]!;
    expect(after.uses).toHaveLength(1);
    expect(after.uses[0]).toMatchObject({ askId: `approval:${second}:perm1`, taskId: second, subject: { op: "exec", target: "bun test packages/core" } });
  });

  test("check applies: a policy for the same op answers a later check with a reply that names the policy and its scope; the use is kept", async () => {
    await h.boot();
    await checkTask("first");
    const ask = (await asks()).find((x) => x.kind === "check")!;
    const saved = await post("/api/asks/answer", { id: ask.id, answer: { kind: "choice", choice: "A: マージする" }, policy: { scope: "repo", target: "PR #12", when: [], expiresAt: Date.now() + 7 * DAY } });
    expect(saved.status).toBe(200);
    expect(h.sent).toHaveLength(1);
    const second = await checkTask("second");
    await until(async () => h.sent.length >= 2);
    const [p] = await policies();
    expect(h.sent[1]).toStartWith(`（方針 ${p!.id} を適用: このリポジトリ / gh pr merge PR #12 / 条件 `);
    expect(h.sent[1]).toContain("A: マージする");
    await settle();
    expect(h.sent).toHaveLength(2);
    expect((await policies())[0]!.uses).toMatchObject([{ taskId: second, subject: { target: "PR #12", head: expect.any(String) } }]);
  });

  /** #306 waiting on a decision a saved policy answers, and backlog-next's firing; returns the choice. */
  const fireDecision = async (onHold = false) => {
    await h.boot();
    const meta = h.meta();
    const stage = { issue: 306, action: "plan" } as never;
    {
      const c = h.core!;
      c.db.insertTask({ id: "tsk_stage306", workspaceId: meta.id, title: "#306 計画", stage, runner: "claude", cwd: meta.path, scope: [meta.path], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: 1000, createdAt: 1000, updatedAt: 1000 });
      c.db.appendEvent("tsk_stage306", { t: "stop.record", stop: { id: "s306", work: { workspaceId: meta.id, issue: 306, taskId: "tsk_stage306" }, op: "decide", target: "storage", reason: "decision", evidence: "needs a decision", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: 1000 } });
    }
    const ask = (await asks()).find((x) => x.kind === "decision" && x.pbi?.number === 306)!;
    expect(ask.subject).toMatchObject({ kind: "decision", op: "decide", target: "storage" });
    const choice = ask.choices.find((c) => c.startsWith("B:"))!;
    writePolicies(h.core!.db, [{ ...checkPolicy({ kind: "decision", op: "decide", target: "storage", answer: { kind: "choice", choice }, from: { ...from("storage"), kind: "decision", op: "decide" } }) }]);
    const s = await post("/api/schedules", { title: "バックログを進める", cron: "0 */3 * * *", workspaceId: meta.id, runner: "claude", prompt: "", action: "backlog-next" });
    const id = ((await s.json()) as { id: string }).id;
    await h.patch(`/api/workspaces/${meta.id}`, { sweep: { implement: 0, plan: 0 } });
    if (onHold) expect((await h.patch("/api/backlog/306", { workspaceId: meta.id, labels: { add: ["on-hold"], remove: [] } })).status).toBe(202);
    await post(`/api/schedules/${id}/run`, {});
    return choice;
  };
  const stageTasks = () => h.core!.db.listTasks().filter((t) => t.title.startsWith("#306 ") && t.id !== "tsk_stage306");

  test("decision applies: backlog-next's firing writes the policy's choice as ## 回答 with the basis line, and the label comes off", async () => {
    const choice = await fireDecision();
    const ops = h.core!.db.listPendingBacklogOperations().map((o) => o.payload as unknown);
    const comment = ops.map((o) => (o as { body?: string }).body).find((b) => b?.startsWith("## 回答"));
    expect(comment).toContain(choice);
    expect(comment).toContain("（方針 pol_t を適用: このリポジトリ / decide storage / 条件 なし / 期限 ");
    expect(ops).toContain(false);
    expect((await policies())[0]!.uses).toMatchObject([{ issue: 306 }]);
    expect(stageTasks()).toHaveLength(1); // the answer goes on with a stage Task
  });

  test("decision on hold: the policy answers, and the work does not go on until the label comes off (#2930)", async () => {
    await fireDecision(true);
    expect((await policies())[0]!.uses).toMatchObject([{ issue: 306 }]);
    expect(stageTasks()).toEqual([]);
  });

  test("not applied: expired, revoked, other repository, other PBI, other target, other condition, other choice, a security merge check and a refused permission all leave the question open", async () => {
    await h.boot();
    const variants: Array<[string, Partial<AnswerPolicy>, string]> = [
      ["expired", { expiresAt: Date.now() - 1 }, "期限切れ"],
      ["revoked", { revokedAt: Date.now() - 1 }, "失効済み"],
      ["repo", { workspaceId: "other" }, "別のリポジトリ"],
      ["pbi", { scope: "pbi", pbi: 1 }, "別の PBI"],
      ["target", { target: "PR #99" }, "対象が違う"],
      ["when", { when: [{ key: "area", value: "x" }] }, "条件 area が無い"],
      ["choice", { answer: { kind: "choice", choice: "Z: 別の案" } }, "回答が今回の選択肢に無い"],
    ];
    const tasks: string[] = [];
    // the policies pile up (each misses every ask for its own reason), so the daemon's weighing after the last one still meets each variant's policy
    const pols: AnswerPolicy[] = [];
    for (const [name, over, why] of variants) {
      pols.push(checkPolicy({ id: `pol_${name}`, ...over }));
      writePolicies(h.core!.db, pols);
      const t = await checkTask(name);
      tasks.push(t);
      // the ask is listed as soon as the outcome is set, with the newest policy's miss reason: wait for that, not a fixed 250 ms
      let ask: Awaited<ReturnType<typeof asks>>[number] | undefined;
      await until(async () => (ask = (await asks()).find((x) => x.task?.id === t && x.kind === "check")) !== undefined);
      expect(ask).toBeDefined();
      expect(ask!.state).toBe("open");
      expect(ask!.policy.previous?.why).toBe(why);
    }
    // "nothing happens" cannot be waited for by its state: one settle for all of them, then no reply was sent and every ask is still open
    await settle();
    expect(h.sent).toEqual([]);
    expect((await asks()).filter((x) => tasks.includes(x.task?.id ?? "") && x.kind === "check").map((x) => x.state)).toEqual(variants.map(() => "open"));
  });

  test("not applied: a matching policy does not answer a PR carrying a security merge check, nor a refused permission", async () => {
    await h.boot();
    writePolicies(h.core!.db, [checkPolicy()]);
    h.mark = "security,large";
    const sec = await checkTask("security");
    const refused = await checkTask("refused", "gh pr merge", { reason: "permission", evidence: "denied by the runner" });
    await settle();
    expect(h.sent).toEqual([]);
    expect((await asks()).filter((x) => [sec, refused].includes(x.task?.id ?? "") && x.kind === "check").map((x) => x.state)).toEqual(["open", "open"]);
    expect((await policies())[0]!.uses).toEqual([]);
  });

  test("not applied: a policy saved on another head of the PR leaves the question open, and the card says the head changed", async () => {
    await h.boot();
    writePolicies(h.core!.db, [checkPolicy({ from: { ...from("PR #12"), head: "a".repeat(40) } })]);
    const t = await checkTask("moved head");
    await settle();
    expect(h.sent).toEqual([]);
    const ask = (await asks()).find((x) => x.task?.id === t && x.kind === "check")!;
    expect(ask.state).toBe("open");
    expect(ask.policy.previous).toMatchObject({ id: "pol_t", why: "PR の差分が変わった", changes: ["PR の差分が変わりました（aaaaaaa → ccccccc）"] });
  });

  test("not applied: a PR question whose PR cannot be read is left to the person", async () => {
    await h.boot();
    writePolicies(h.core!.db, [checkPolicy()]);
    h.prFails = true;
    const t = await checkTask("no source");
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.prCalls).toBeGreaterThan(0);
    expect((await asks()).find((x) => x.task?.id === t && x.kind === "check")!.state).toBe("open");
  });

  test("edit takes effect: a revoked policy no longer matches the next permission.ask; a corrected target matches it again", async () => {
    await h.boot();
    const p = await saveApproval();
    expect((await patch(`/api/policies/${p.id}`, { revoked: true })).status).toBe(200);
    const second = await approvalTask("second");
    await settle();
    expect(h.core!.db.getTask(second)!.status).toBe("waiting");
    expect(resolvedBy(second)).toEqual([]);
    expect((await patch(`/api/policies/${p.id}`, { revoked: false, target: "bun test packages/*" })).status).toBe(200);
    const third = await approvalTask("third");
    expect(resolvedBy(third)).toEqual([`policy:${p.id}`]);
  });
});
