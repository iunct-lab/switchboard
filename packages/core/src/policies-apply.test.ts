import { afterEach, describe, expect, test } from "bun:test";
import type { AnswerPolicy, PolicySubject } from "@switchboard/protocol";
import { DAY, harness, mergeAnswer, mergeQuestion, policyOf, questionTurn, until } from "./policies-harness.ts";
import { writePolicies } from "./policies.ts";

/* Saved policies answering the next question: tool approvals, a Task's check, a PBI's decision. */

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
  id: "pol_t", scope: "repo", workspaceId: h.meta().id, pbi: null, askId: null, kind: "check", op: "gh pr merge", target: "PR #12", when: [], answer: { kind: "choice", choice: "マージする" },
  expiresAt: Date.now() + DAY, revokedAt: null, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000, from: from("PR #12"), uses: [], ...over,
});
const settle = () => Bun.sleep(250);

describe("applying saved policies", () => {
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

  test("a question tool check takes no policy: the card offers no scope, a saved policy does not answer it, and an answer that asks to save one is 409 with nothing sent or saved", async () => {
    await h.boot();
    // a policy saved for the same op and target (as an older version could) is not applied to a later check
    writePolicies(h.core!.db, [checkPolicy()]);
    const t = await checkTask("first");
    await settle();
    expect(h.sent).toEqual([]);
    const ask = (await asks()).find((x) => x.task?.id === t && x.kind === "check")!;
    expect(ask).toMatchObject({ state: "open", subject: null, policy: { scopes: [], note: null, previous: null } });
    expect((await policies())[0]!.uses).toEqual([]);
    // asking to save one is 409, also for one option of one question
    const r = await post("/api/asks/answer", { id: ask.id, answer: mergeAnswer, policy: { scope: "repo", target: "PR #12", when: [], expiresAt: Date.now() + 7 * DAY } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("この問いは方針にできません");
    expect(await policies()).toHaveLength(1);
    expect(h.sent).toEqual([]);
    // without a policy the same answer goes as one reply
    expect((await post("/api/asks/answer", { id: ask.id, answer: mergeAnswer })).status).toBe(200);
    expect(h.sent).toEqual(["- PR #12 をマージしてよいか: マージする (Recommended)"]);
  });

  /** Issue 306 waiting on a decision a saved policy answers, and backlog-next's firing; returns the choice. */
  const fireDecision = async (onHold = false) => {
    await h.boot();
    const meta = h.meta();
    const stage = { issue: 306, action: "plan" } as never;
    {
      const c = h.core!;
      c.db.insertTask({ id: "tsk_stage306", workspaceId: meta.id, title: "#306 計画", stage, runner: "claude", cwd: meta.path, scope: [meta.path], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: 1000, createdAt: 1000, updatedAt: 1000 });
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

  test("decision on hold: the policy answers, and the work does not go on until the label comes off", async () => {
    await fireDecision(true);
    expect((await policies())[0]!.uses).toMatchObject([{ issue: 306 }]);
    expect(stageTasks()).toEqual([]);
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
