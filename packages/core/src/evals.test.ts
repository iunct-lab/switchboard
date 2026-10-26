import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, EventEnvelope, StopRecord, Task } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { AUTO_RESUME_HEAD, evalRequestDraft, isAutomaticUserText, RULES_BY, ruleMetrics, rulesEvalOf } from "./evals.ts";
import { RESUME_PROMPT } from "./ratelimit.ts";
import { STOP_RESUME_PROMPT } from "./interrupted.ts";

/** Events at 1 s intervals, from t = 1000. */
const envelopes = (evs: AgentEvent[]): EventEnvelope[] => evs.map((ev, i) => ({ taskId: "t", seq: i + 1, ts: 1000 + i * 1000, ev }));
const user = (text: string, messageId?: string): AgentEvent => ({ t: "message.delta", role: "user", text, ...(messageId ? { messageId } : {}) });
const assistant = (text: string): AgentEvent => ({ t: "message.delta", role: "assistant", text });
const end = (status: "ok" | "error" | "aborted"): AgentEvent => ({ t: "session.end", status, summary: "s" });
const stop = (id: string, reason: StopRecord["reason"]): AgentEvent => ({
  t: "stop.record",
  stop: { id, work: { workspaceId: null, issue: null, taskId: "t" }, op: "gh", target: "", reason, evidence: "", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: 1 },
});

describe("ruleMetrics (#1218)", () => {
  test("counts tool calls, failures (ok:false only), errors, asks and denials; the last end and the duration", () => {
    const m = ruleMetrics(
      envelopes([
        { t: "session.start", runner: "claude", cwd: "/w" },
        user("do it"),
        { t: "tool.call", id: "a", name: "Bash", input: {}, summary: "ls" },
        { t: "tool.result", id: "a", ok: true, summary: "fine" },
        { t: "tool.call", id: "b", name: "Bash", input: {}, summary: "rm" },
        { t: "tool.result", id: "b", ok: false, summary: "denied" },
        { t: "permission.ask", id: "p1", kind: "exec", tool: "Bash", input: {}, detail: "rm" },
        { t: "permission.resolved", id: "p1", decision: "deny", by: "user" },
        { t: "permission.ask", id: "p2", kind: "write", tool: "Write", input: {}, detail: "f" },
        { t: "permission.resolved", id: "p2", decision: "allow", by: "rule" },
        { t: "error", message: "boom" },
        end("error"),
        user("try again"),
        assistant("ok"),
        end("ok"),
      ]),
    );
    expect(m).toEqual({ turns: 2, toolCalls: 2, toolFailures: 1, errors: 1, asks: 2, denials: 1, stops: 0, stopReasons: {}, userInstructions: 1, lastEnd: "ok", durationMs: 14_000 });
  });

  test("user instructions: the first message is the request; the daemon's resume messages do not count; a streamed message counts once; different messageIds split", () => {
    expect(isAutomaticUserText(RESUME_PROMPT)).toBe(true);
    expect(isAutomaticUserText(STOP_RESUME_PROMPT)).toBe(true);
    expect(RESUME_PROMPT.startsWith(AUTO_RESUME_HEAD)).toBe(true);
    expect(isAutomaticUserText("続けて")).toBe(false);
    const m = ruleMetrics(
      envelopes([
        user("first"),
        assistant("a"),
        end("ok"),
        user(RESUME_PROMPT),
        assistant("b"),
        end("error"),
        user(STOP_RESUME_PROMPT),
        end("ok"),
        user("second, ", "m1"),
        user("in two chunks", "m1"),
        assistant("c"),
        user("third"),
        user(" still third"),
        user("fourth", "m4"),
        user("fifth", "m5"), // a different id with nothing between: another message
        end("ok"),
      ]),
    );
    expect(m.userInstructions).toBe(4);
    expect(m.turns).toBe(4);
  });

  test("stops are counted by reason code", () => {
    const m = ruleMetrics(envelopes([user("x"), stop("s1", "usage-limit"), stop("s2", "github-limit"), stop("s1", "usage-limit"), end("ok")]));
    expect(m.stops).toBe(3);
    expect(m.stopReasons).toEqual({ "usage-limit": 2, "github-limit": 1 });
  });

  test("no events: zeros, no last end, no duration", () => {
    expect(ruleMetrics([])).toEqual({ turns: 0, toolCalls: 0, toolFailures: 0, errors: 0, asks: 0, denials: 0, stops: 0, stopReasons: {}, userInstructions: 0, lastEnd: null, durationMs: null });
  });

  test("Db: upsertEval twice keeps one row; evalsOf returns the rules row and null for the rest; deleteEval clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-evals-"));
    try {
      const db = new Db(join(dir, "switchboard.db"));
      const now = 1_700_000_000_000;
      const task: Task = { id: "t1", workspaceId: null, title: "t1", runner: "claude", cwd: dir, scope: [dir], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now };
      db.insertTask(task);
      const events = envelopes([user("go"), { t: "tool.call", id: "a", name: "Read", input: {}, summary: "f" }, { t: "tool.result", id: "a", ok: true, summary: "" }, end("ok")]);
      const first = rulesEvalOf(task, events, { costUsd: 0.5 }, now);
      expect(first).toMatchObject({ status: "done", outcome: "unknown", costUsd: 0.5, by: RULES_BY, ts: now, metrics: { toolCalls: 1, turns: 1 } });
      db.upsertEval({ taskId: "t1", source: "rules", by: RULES_BY, rubric: null, json: first, ts: now });
      const second = rulesEvalOf(task, [...events, ...envelopes([user("more"), end("ok")]).map((e, i) => ({ ...e, seq: 10 + i }))], { costUsd: 0.75 }, now + 1);
      db.upsertEval({ taskId: "t1", source: "rules", by: RULES_BY, rubric: null, json: second, ts: now + 1 });
      expect((db.sqlite.query("SELECT count(*) AS n FROM task_evals WHERE task_id = 't1'").get() as { n: number }).n).toBe(1);
      expect(db.evalsOf("t1")).toEqual({ rules: second, judge: null, human: null });
      expect(db.evalsOf("t1").rules?.metrics.turns).toBe(2);
      expect(db.getEval("t1", "rules")?.ts).toBe(now + 1);
      db.deleteEval("t1", "rules");
      expect(db.evalsOf("t1")).toEqual({ rules: null, judge: null, human: null });
      // a row from a counter whose shape this version does not read: null rather than a throw
      db.upsertEval({ taskId: "t1", source: "rules", by: "rules@0", rubric: null, json: { old: true }, ts: now });
      expect(db.evalsOf("t1").rules).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evalRequestDraft (#1221)", () => {
  const task = { id: "task_1", title: "README を\n直す", runner: "claude" as const };
  const rules = { metrics: { turns: 2, toolCalls: 7, toolFailures: 2, errors: 1, asks: 0, denials: 0, stops: 1, stopReasons: { "usage-limit": 1 }, userInstructions: 3, lastEnd: "ok" as const, durationMs: 1000 }, status: "done" as const, outcome: "done" as const, costUsd: 0.1, by: RULES_BY, ts: 1 };
  test("the task, the counts, the criteria at 3 or below with their reasons, the summary, the rating, then the line to fill", () => {
    const text = evalRequestDraft(task, {
      rules,
      judge: { scores: { goal: { score: 4, reason: "終えた" }, efficiency: { score: 2, reason: "同じ失敗を繰り返した" }, custom: { score: 3, reason: "x" } }, summary: "総評です", rubric: "switchboard-default@1", by: "codex:gpt-6-luna", ts: 1 },
      human: { rating: 2, comment: "手戻りが多い", by: "user", ts: 1 },
    });
    expect(text.split("\n")).toEqual([
      "Task「README を 直す」（task_1、claude）の評価から:",
      "- 指標: ツール呼び出し 7 / 失敗 2 / エラー 1 / 追加指示 3 / 停止 1 / 終わり方 ok",
      "- 効率: 2 / 5 — 同じ失敗を繰り返した",
      "- custom: 3 / 5 — x",
      "- 総評（codex:gpt-6-luna、switchboard-default@1）: 総評です",
      "- 自分の評価: 2 / 5 — 手戻りが多い",
      "",
      "改善したいこと:",
      "",
    ]);
  });
  test("without any eval row: the heading and the line to fill only", () => {
    expect(evalRequestDraft(task, { rules: null, judge: null, human: null })).toBe("Task「README を 直す」（task_1、claude）の評価から:\n\n改善したいこと:\n");
    expect(evalRequestDraft(task, { rules, judge: null, human: { rating: 5, comment: "", by: "user", ts: 1 } })).toContain("- 自分の評価: 5 / 5\n");
  });
});
