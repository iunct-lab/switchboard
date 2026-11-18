import { assertRecordings, recordingText, skipRecordings } from "../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeParser } from "@switchboard/adapter-claude";
import type { AgentEvent, BacklogIssueData, BacklogPullRequestData, BacklogSource, EvalsListRow, EventEnvelope, RequestEval, StopRecord, Task } from "@switchboard/protocol";
import { Db, tasksOfIssues } from "./db.ts";
import { storedIssueReader } from "./backlog-stored.ts";
import { AUTO_RESUME_HEAD, delegatedNote, EVAL_CONTEXT_CHARS, EVAL_REQUEST_CHARS, evalContext, evalRequestDraft, isAutomaticUserText, judgeHumanGap, personMessages, RULES_BY, ruleMetrics, requestSampleRows, rulesEvalOf, stageCounts, stageRequestOf, STOP_NOTE, weekStartUtc, weeklyHumanSample, withRequestOutputs } from "./evals.ts";
import { decisionsFromOtlp } from "./otel.ts";
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

describe("ruleMetrics", () => {
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
    expect(m).toEqual({ turns: 2, toolCalls: 2, toolFailures: 1, errors: 1, asks: 2, denials: 1, stops: 0, stopReasons: {}, userInstructions: 1, lastEnd: "ok", daemonStops: 0, lastCutByDaemon: false, durationMs: 14_000, classifier: null, delegatedModel: null });
  });

  test("a status after the last real event (the cleanup note) does not move the duration", () => {
    const evs: AgentEvent[] = [{ t: "session.start", runner: "claude", cwd: "/w" }, user("do it"), end("ok")];
    const base = ruleMetrics(envelopes(evs)).durationMs;
    expect(base).toBe(2000);
    expect(ruleMetrics(envelopes([...evs, { t: "status", text: "cleanup skipped" }, { t: "status", text: "later" }])).durationMs).toBe(base);
    expect(ruleMetrics(envelopes([{ t: "status", text: "only" }, { t: "status", text: "notes" }])).durationMs).toBe(1000);
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
    expect(personMessages(envelopes([user("first"), end("ok"), user(RESUME_PROMPT), user("second, ", "m1"), user("in two chunks", "m1"), user("third", "m3")]).map((e) => e.ev))).toEqual(["first", "second, in two chunks", "third"]);
  });

  test("stops are counted once per stop id", () => {
    const m = ruleMetrics(envelopes([user("x"), stop("A", "depends"), stop("B", "github-limit"), stop("A", "usage-limit"), stop("A", "usage-limit"), end("ok")]));
    expect(m.stops).toBe(2);
    expect(m.stopReasons).toEqual({ "usage-limit": 1, "github-limit": 1 });
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/classifier-stop.jsonl", "packages/core/fixtures/otel-classifier-stop.jsonl"))("classifier (recorded): the recorded stop counts as stopped", () => {
    assertRecordings("packages/adapters/claude/fixtures/classifier-stop.jsonl", "packages/core/fixtures/otel-classifier-stop.jsonl");
    const p = createClaudeParser();
    const stream = recordingText("packages/adapters/claude/fixtures/classifier-stop.jsonl").split("\n").flatMap((l) => p.feed(l));
    const otel = recordingText("packages/core/fixtures/otel-classifier-stop.jsonl").split("\n").filter(Boolean).flatMap((l) => decisionsFromOtlp(JSON.parse(l)));
    const m = ruleMetrics(envelopes([...stream, ...otel]));
    expect(m.classifier).toEqual({ allowed: 1, denied: 1, byCategory: { interfere_with_workloads: 1 } });
  });

  test("classifier: allowed and stopped calls, the stopped ones per kind; null when nothing was recorded", () => {
    const d = (verdict: "allow" | "block", category: string | null = null): AgentEvent => ({ t: "classifier.decision", verdict, category, mode: "auto", tool: "Bash", callId: null });
    const ask = (reason?: "classifier"): AgentEvent => ({ t: "permission.ask", id: "p", kind: "exec", tool: "Bash", input: {}, detail: "x", ...(reason ? { reason } : {}) });
    const m = ruleMetrics(envelopes([user("x"), d("allow"), d("allow"), d("block", "Irreversible Local Destruction"), d("block"), ask("classifier"), ask(), end("ok")]));
    expect(m.classifier).toEqual({ allowed: 2, denied: 3, byCategory: { "Irreversible Local Destruction": 1, asked: 1 } });
    expect(m.asks).toBe(2);
    // a plain ask is not the classifier's; no record at all (Codex, not Auto) is null, not zero
    expect(ruleMetrics(envelopes([user("x"), ask(), end("ok")])).classifier).toBeNull();
  });

  test("no events: zeros, no last end, no duration", () => {
    expect(ruleMetrics([])).toEqual({ turns: 0, toolCalls: 0, toolFailures: 0, errors: 0, asks: 0, denials: 0, stops: 0, stopReasons: {}, userInstructions: 0, lastEnd: null, daemonStops: 0, lastCutByDaemon: false, durationMs: null, classifier: null, delegatedModel: null });
  });

  test("daemon stops: STOP_NOTE status lines are counted; the last turn cut by one is marked", () => {
    const note = (rest: string): AgentEvent => ({ t: "status", text: `${STOP_NOTE}${rest}` });
    // abortOrphanedTasks: the turn's end, then the note
    expect(ruleMetrics(envelopes([user("x"), end("error"), note("。次に起動したとき…")]))).toMatchObject({ daemonStops: 1, lastCutByDaemon: true, lastEnd: "error" });
    // shutdown: the note, then the turn's end
    expect(ruleMetrics(envelopes([user("x"), note("。次に起動したとき…"), end("aborted")]))).toMatchObject({ daemonStops: 1, lastCutByDaemon: true, lastEnd: "aborted" });
    // the daemon's resume starts the next turn, which ends on its own: still one stop, the last end is the task's
    const resumed = ruleMetrics(envelopes([user("x"), note("。…"), end("aborted"), user(STOP_RESUME_PROMPT), end("ok")]));
    expect(resumed).toMatchObject({ daemonStops: 1, lastCutByDaemon: false, lastEnd: "ok" });
    // a resumed turn that fails by itself is the task's failure
    expect(ruleMetrics(envelopes([user("x"), note("。…"), end("aborted"), user(STOP_RESUME_PROMPT), end("error")]))).toMatchObject({ daemonStops: 1, lastCutByDaemon: false, lastEnd: "error" });
    // a usage-limit status is not a daemon stop; a note with no finished turn marks nothing
    expect(ruleMetrics(envelopes([user("x"), { t: "status", text: "使用上限で停止" }, end("error")]))).toMatchObject({ daemonStops: 0, lastCutByDaemon: false });
    expect(ruleMetrics(envelopes([user("x"), note("。…")]))).toMatchObject({ daemonStops: 1, lastCutByDaemon: false, lastEnd: null });
  });

  test("delegated model: the note names the model and carries no 試験", () => {
    expect(delegatedNote("claude-sonnet-5-5")).toBe("Task ごとの実装は claude-sonnet-5-5 に任せます");
    expect(delegatedNote("claude-sonnet-5-5")).not.toContain("試験");
  });

  test("delegated model: the model of the note; null without one or for another status line; a rules@3 row is counted again", () => {
    expect(ruleMetrics(envelopes([{ t: "status", text: delegatedNote("claude-sonnet-5-5") }, user("x"), end("ok")])).delegatedModel).toBe("claude-sonnet-5-5");
    expect(ruleMetrics(envelopes([user("x"), end("ok")])).delegatedModel).toBeNull();
    expect(ruleMetrics(envelopes([{ t: "status", text: "Task ごとの実装は 自分で行います" }, user("x"), end("ok")])).delegatedModel).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "switchboard-evals-"));
    try {
      const db = new Db(join(dir, "switchboard.db"));
      const { delegatedModel: _d, ...old } = ruleMetrics(envelopes([user("x"), end("ok")]));
      db.upsertEval({ taskId: "t1", source: "rules", by: "rules@3", rubric: null, json: { metrics: old, status: "done", outcome: "unknown", costUsd: 0, by: "rules@3", ts: 1 }, ts: 1 });
      expect(db.evalsOf("t1").rules).toBeNull(); // not the current counter: counted again, not read
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an old rules@4 row is counted again", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-evals-"));
    try {
      const db = new Db(join(dir, "switchboard.db"));
      const metrics = ruleMetrics(envelopes([user("x"), end("ok")]));
      db.upsertEval({ taskId: "t1", source: "rules", by: "rules@4", rubric: null, json: { metrics, status: "done", outcome: "unknown", costUsd: 0, by: "rules@4", ts: 1 }, ts: 1 });
      expect(db.evalsOf("t1").rules).toBeNull();
      db.upsertEval({ taskId: "t1", source: "rules", by: RULES_BY, rubric: null, json: { metrics, status: "done", outcome: "unknown", costUsd: 0, by: RULES_BY, ts: 1 }, ts: 1 });
      expect(db.evalsOf("t1").rules?.metrics.turns).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an old rules@1 row without daemonStops reads as null, so it is counted again", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-evals-"));
    try {
      const db = new Db(join(dir, "switchboard.db"));
      const { daemonStops: _d, lastCutByDaemon: _l, ...old } = ruleMetrics(envelopes([user("x"), end("ok")]));
      db.upsertEval({ taskId: "t1", source: "rules", by: "rules@1", rubric: null, json: { metrics: old, status: "done", outcome: "unknown", costUsd: 0, by: "rules@1", ts: 1 }, ts: 1 });
      expect(db.evalsOf("t1").rules).toBeNull();
      expect(RULES_BY).toBe("rules@5");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Db: upsertEval twice keeps one row; evalsOf returns the rules row and null for the rest; deleteEval clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-evals-"));
    try {
      const db = new Db(join(dir, "switchboard.db"));
      const now = 1_700_000_000_000;
      const task: Task = { id: "t1", workspaceId: null, title: "t1", runner: "claude", cwd: dir, scope: [dir], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now };
      db.insertTask(task);
      const events = envelopes([user("go"), { t: "tool.call", id: "a", name: "Read", input: {}, summary: "f" }, { t: "tool.result", id: "a", ok: true, summary: "" }, end("ok")]);
      const first = rulesEvalOf(task, events, { costUsd: 0.5 }, now);
      expect(first).toMatchObject({ status: "done", outcome: "unknown", costUsd: 0.5, by: RULES_BY, ts: now, metrics: { toolCalls: 1, turns: 1 } });
      db.upsertEval({ taskId: "t1", source: "rules", by: RULES_BY, rubric: null, json: first, ts: now });
      const second = rulesEvalOf(task, [...events, ...envelopes([user("more"), end("ok")]).map((e, i) => ({ ...e, seq: 10 + i }))], { costUsd: 0.75 }, now + 1);
      db.upsertEval({ taskId: "t1", source: "rules", by: RULES_BY, rubric: null, json: second, ts: now + 1 });
      expect((db.sqlite.query("SELECT count(*) AS n FROM task_evals WHERE task_id = 't1'").get() as { n: number }).n).toBe(1);
      expect(db.evalsOf("t1")).toEqual({ rules: second, judge: null, human: null, models: [] });
      expect(db.evalsOf("t1").rules?.metrics.turns).toBe(2);
      expect(db.getEval("t1", "rules")?.ts).toBe(now + 1);
      db.deleteEval("t1", "rules");
      expect(db.evalsOf("t1")).toEqual({ rules: null, judge: null, human: null, models: [] });
      // a row from a counter whose shape this version does not read: null rather than a throw
      db.upsertEval({ taskId: "t1", source: "rules", by: "rules@0", rubric: null, json: { old: true }, ts: now });
      expect(db.evalsOf("t1").rules).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evalRequestDraft", () => {
  const task = { id: "task_1", title: "README を\n直す", runner: "claude" as const };
  const rules = { metrics: { turns: 2, toolCalls: 7, toolFailures: 2, errors: 1, asks: 0, denials: 0, stops: 1, stopReasons: { "usage-limit": 1 }, userInstructions: 3, lastEnd: "ok" as const, daemonStops: 0, lastCutByDaemon: false, durationMs: 1000, classifier: null, delegatedModel: null }, status: "done" as const, outcome: "finished" as const, costUsd: 0.1, by: RULES_BY, ts: 1 };
  test("the task, the counts, the criteria at 3 or below with their reasons, the summary, the rating, then the line to fill", () => {
    const text = evalRequestDraft(task, {
      rules,
      judge: { scores: { goal: { score: 4, reason: "終えた" }, efficiency: { score: 2, reason: "同じ失敗を繰り返した" }, custom: { score: 3, reason: "x" } }, summary: "総評です", rubric: "switchboard-default@1", by: "codex:gpt-6-luna", ts: 1 },
      human: { rating: 2, comment: "手戻りが多い", by: "user", ts: 1 },
      models: [],
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
    expect(evalRequestDraft(task, { rules: null, judge: null, human: null, models: [] })).toBe("Task「README を 直す」（task_1、claude）の評価から:\n\n改善したいこと:\n");
    expect(evalRequestDraft(task, { rules, judge: null, human: { rating: 5, comment: "", by: "user", ts: 1 }, models: [] })).toContain("- 自分の評価: 5 / 5\n");
  });
});

/** A list row with a judge average (null = not judged) and a human rating (null = none). */
const listRow = (taskId: string, average: number | null, o: { runner?: EvalsListRow["runner"]; workspaceId?: string | null; rating?: number; intent?: "fit" | "partial" | "wrong" | "unknown"; judgeIntent?: number; answers?: Omit<NonNullable<EvalsListRow["human"]>, "rating" | "comment" | "intent">; judge?: Record<string, number> } = {}): EvalsListRow => ({
  taskId, title: taskId, runner: o.runner ?? "claude", workspaceId: o.workspaceId === undefined ? "w1" : o.workspaceId, status: "done", outcome: "unknown", judgedResult: null, updatedAt: 1, costUsd: 0, models: [], efforts: [], subagentEffort: null, rules: null,
  judge: average === null ? null : { average, scores: { ...(o.judgeIntent === undefined ? {} : { intent: o.judgeIntent }), ...o.judge }, rubric: "r@1", by: "x", ts: 1 },
  human: o.rating === undefined ? null : { rating: o.rating, comment: "", ...(o.intent ? { intent: o.intent } : {}), ...o.answers },
});

describe("weekly human sample", () => {
  test("weekStartUtc: the Monday 0:00 UTC of the week, a Monday itself included", () => {
    const mon = Date.UTC(2026, 9, 26);
    expect(weekStartUtc(mon)).toBe(mon);
    expect(weekStartUtc(Date.UTC(2026, 9, 28, 13, 5))).toBe(mon); // Wednesday
    expect(weekStartUtc(Date.UTC(2026, 10, 1, 23, 59))).toBe(mon); // Sunday
    expect(weekStartUtc(mon - 1)).toBe(Date.UTC(2026, 9, 19));
  });
  test("one from each of the low / middle / high bands in turn, at most 5", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id, i) => listRow(id, 1 + i * 0.5, { runner: "claude" }));
    const picked = weeklyHumanSample(rows).map((r) => r.taskId);
    expect(picked.length).toBe(5);
    // bands by average: a b c | d e f | g h i; one kind only, so each band gives its lowest taskId first
    expect(picked).toEqual(["a", "d", "g", "b", "e"]);
  });
  test("within a band a kind (workspace × runner) not picked yet comes first", () => {
    const rows = [
      listRow("a1", 1.0, { runner: "claude" }), listRow("a2", 1.1, { runner: "codex" }),
      listRow("b1", 3.0, { runner: "claude" }), listRow("b2", 3.1, { runner: "codex" }),
      listRow("c1", 4.5, { runner: "claude" }), listRow("c2", 4.6, { runner: "claude", workspaceId: "w2" }),
    ];
    const picked = weeklyHumanSample(rows).map((r) => r.taskId);
    // low: a1 (w1:claude); middle: b2 (w1:codex, new); high: c2 (w2:claude, new); then the rest
    expect(picked.slice(0, 3)).toEqual(["a1", "b2", "c2"]);
    expect(picked.length).toBe(5);
  });
  test("tasks without a judge are not candidates; fewer than 3 candidates → all of them", () => {
    expect(weeklyHumanSample([listRow("x", null), listRow("b", 4), listRow("a", 2)]).map((r) => r.taskId)).toEqual(["a", "b"]);
    expect(weeklyHumanSample([])).toEqual([]);
    expect(weeklyHumanSample([listRow("a", 2), listRow("b", 3), listRow("c", 4)]).map((r) => r.taskId)).toEqual(["a", "b", "c"]);
  });
  test("the same input in any order gives the same result", () => {
    const rows = Array.from({ length: 12 }, (_, i) => listRow(`t${String(i).padStart(2, "0")}`, 1 + (i % 7) * 0.6, { runner: i % 2 ? "codex" : "claude", workspaceId: i % 3 ? "w1" : "w2" }));
    const a = weeklyHumanSample(rows).map((r) => r.taskId);
    expect(weeklyHumanSample([...rows].reverse()).map((r) => r.taskId)).toEqual(a);
    expect(a.length).toBe(5);
  });
});

describe("weekly human sample: what the person stepped into comes first", () => {
  const stepped = (row: EvalsListRow, userInstructions: number, decisionStops = 0): EvalsListRow => ({ ...row, rules: { toolCalls: 0, toolFailures: 0, errors: 0, userInstructions, stops: decisionStops, decisionStops, lastEnd: "ok", daemonStops: 0, lastCutByDaemon: false } });
  const request = (number: number, interventions: number, closedAt: number, taskIds: string[] = [], pbiTasks: string[] = []) => ({ kind: "request" as const, workspaceId: "w1", number, closedAt, interventions, taskIds, pbis: [{ taskIds: pbiTasks }] });
  const id = (u: EvalsListRow | { number: number }) => ("taskId" in u ? u.taskId : `#${u.number}`);

  test("a task with 21 follow-up instructions is asked first even from the high band; one never stepped into is not pulled forward", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((x, i) => listRow(x, 1 + i * 0.5));
    rows[8] = stepped(rows[8]!, 21); // i: the best average of all
    rows[4] = stepped(rows[4]!, 1, 2); // e: 3 with its decision stops
    rows[1] = stepped(rows[1]!, 0); // b: counted, never stepped into
    const picked = weeklyHumanSample(rows).map((r) => r.taskId);
    expect(picked.slice(0, 2)).toEqual(["i", "e"]);
    // the bands go on over the rest: a b c | d f | g h
    expect(picked).toEqual(["i", "e", "a", "d", "g"]);
  });
  test("only the first two slots go by interventions: a third such task waits for its band", () => {
    const rows = ["a", "b", "c", "d", "e", "f"].map((x, i) => stepped(listRow(x, 1 + i), 6 - i));
    expect(weeklyHumanSample(rows).map((r) => r.taskId)).toEqual(["a", "b", "c", "e", "f"]); // then the bands of the rest, c d | e | f, one each in turn: d, stepped into 3 times, waits
  });
  test("requests: the most stepped-into unit first (a request before a task on a tie), then the other requests as closed, then tasks; a picked request's tasks are not asked again", () => {
    const rows = [stepped(listRow("t-in", 2), 9), stepped(listRow("t-free", 3), 4), listRow("t-x", 1), listRow("t-y", 5), listRow("t-pbi", 4)];
    const requests = [request(30, 0, 300), request(10, 4, 200, [], ["t-pbi"]), request(20, 9, 100, ["t-in"])];
    const picked = weeklyHumanSample(rows, requests).map(id);
    // issue 20 (9, which is its task t-in's) and issue 10 (4, a tie with t-free: the request wins); issue 30 by its close; then the tasks left
    expect(picked).toEqual(["#20", "#10", "#30", "t-x", "t-free"]);
    expect(picked).not.toContain("t-in");
    expect(picked).not.toContain("t-pbi");
  });
  test("more requests than lines: five requests, and no task", () => {
    const requests = [1, 2, 3, 4, 5, 6].map((n) => request(n, 0, n));
    expect(weeklyHumanSample([listRow("a", 2)], requests).map(id)).toEqual(["#1", "#2", "#3", "#4", "#5"]);
  });
});

describe("stageCounts", () => {
  const ev = (issue: number, stages: RequestEval["stages"], ts: number) => ({ workspaceId: "w1", issue, eval: { stages, rating: 3, comment: "", by: "user" as const, ts } });
  test("every stage has a row; an evaluation with several stages counts in each; older than `from` is not counted; examples newest first", () => {
    const rows = [ev(7, ["request", "pbi"], 500), ev(6, ["request"], 400), ev(5, ["none"], 300), ev(4, ["impl"], 99)];
    expect(stageCounts(rows, 100)).toEqual({
      from: 100,
      rows: [
        { stage: "none", count: 1, examples: [{ workspaceId: "w1", number: 5 }] },
        { stage: "request", count: 2, examples: [{ workspaceId: "w1", number: 7 }, { workspaceId: "w1", number: 6 }] },
        { stage: "pbi", count: 1, examples: [{ workspaceId: "w1", number: 7 }] },
        { stage: "impl", count: 0, examples: [] },
        { stage: "report", count: 0, examples: [] },
      ],
    });
    expect(stageCounts(Array.from({ length: 8 }, (_, i) => ev(i + 1, ["report"], 1000 - i)), 0).rows[4]).toMatchObject({ count: 8, examples: [1, 2, 3, 4, 5].map((number) => ({ workspaceId: "w1", number })) });
  });
});

describe("judge vs human gap", () => {
  test("only the tasks with both, the mean of human − judge to one decimal, and the count", () => {
    const rows = [listRow("a", 2.6, { rating: 1 }), listRow("b", 3.6, { rating: 1 }), listRow("c", 4, {}), listRow("d", null, { rating: 5 })];
    expect(judgeHumanGap(rows)).toEqual({ count: 2, mean: -2.1, intent: { count: 0, mean: null }, minimal: { count: 0, mean: null }, value: { count: 0, mean: null } });
    expect(judgeHumanGap([listRow("a", 3, { rating: 4 }), listRow("b", 3.5, { rating: 4 })])).toEqual({ count: 2, mean: 0.8, intent: { count: 0, mean: null }, minimal: { count: 0, mean: null }, value: { count: 0, mean: null } });
  });
  test("none with both → mean null", () => {
    expect(judgeHumanGap([listRow("a", 3), listRow("b", null, { rating: 2 })])).toEqual({ count: 0, mean: null, intent: { count: 0, mean: null }, minimal: { count: 0, mean: null }, value: { count: 0, mean: null } });
  });
  test("intent: the judge's intent score only where the person answered partial or wrong; fit, no answer and no intent score are left out", () => {
    const rows = [
      listRow("a", 3, { rating: 2, intent: "partial", judgeIntent: 4 }),
      listRow("b", 3, { rating: 1, intent: "wrong", judgeIntent: 3 }),
      listRow("c", 3, { rating: 5, intent: "fit", judgeIntent: 5 }),
      listRow("d", 3, { rating: 3, judgeIntent: 5 }),
      listRow("e", 3, { rating: 3, intent: "unknown", judgeIntent: 5 }),
      listRow("f", 3, { rating: 2, intent: "wrong" }), // a judgment of the older rubric has no intent score
    ];
    expect(judgeHumanGap(rows).intent).toEqual({ count: 2, mean: 3.5 });
    expect(judgeHumanGap([listRow("a", 3, { rating: 5, intent: "fit", judgeIntent: 5 })]).intent).toEqual({ count: 0, mean: null });
  });
  test("minimal: the judge's minimal score where the person answered some to complexity or detour; value: the judge's value score where it went unused", () => {
    const rows = [
      listRow("a", 3, { rating: 2, answers: { complexity: "some", detour: "none" }, judge: { minimal: 5, value: 4 } }),
      listRow("b", 3, { rating: 2, answers: { complexity: "none", detour: "some", value: "unused" }, judge: { minimal: 4, value: 3 } }),
      listRow("c", 3, { rating: 4, answers: { complexity: "none", detour: "none", value: "used" }, judge: { minimal: 2, value: 1 } }),
      listRow("d", 3, { rating: 3, answers: { complexity: "unknown", detour: "unknown", value: "unknown" }, judge: { minimal: 2, value: 1 } }),
      listRow("e", 3, { rating: 2, answers: { complexity: "some", value: "unused" } }), // no minimal / value score: left out
    ];
    expect(judgeHumanGap(rows).minimal).toEqual({ count: 2, mean: 4.5 });
    expect(judgeHumanGap(rows).value).toEqual({ count: 1, mean: 3 });
  });
});

describe("evalContext", () => {
  const SRC: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  const issue = (number: number, labels: string[], body: string, parent: number | null = null): BacklogIssueData => ({ number, title: `題 ${number}`, url: "", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null });
  const taskOf = (id: string, workspaceId: string | null, stage: Task["stage"]): Task => ({ id, workspaceId, title: id, runner: "claude", cwd: "/w", scope: ["/w"], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage, statusAt: 1, createdAt: 1, updatedAt: 1 });
  const pull = (number: number, state: "OPEN" | "CLOSED" | "MERGED"): BacklogPullRequestData => ({ number, state, isDraft: false, labels: [], closes: [], mergeCommit: null, updatedAt: "2026-10-01T00:00:00Z", files: [], closedAt: null, mergedAt: null });
  const pbiBody = (source: string) => `## ユーザーストーリー\n${"あ".repeat(EVAL_CONTEXT_CHARS + 50)}\n\n## スコープ外\n- やらない\n\n${source}## 前提\nなし`;
  const read = (db: Db) => storedIssueReader(db);
  const withDb = (run: (db: Db, wsId: string, dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-evals-"));
    try {
      const db = new Db(join(dir, "switchboard.db"));
      const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
      db.setWorkspaceBacklogSource(ws.id, SRC);
      db.putBacklogSnapshot(SRC, { records: [
        { objectKind: "issue", externalId: "I_10", remote: issue(10, ["type:pbi"], pbiBody("## 元要望\n#9（1 と 2）\n\n")), fetchState: "fetched" },
        { objectKind: "issue", externalId: "I_11", remote: issue(11, ["type:task"], "## 親 PBI\n#10", 10), fetchState: "fetched" },
        { objectKind: "issue", externalId: "I_12", remote: issue(12, ["type:pbi"], pbiBody("")), fetchState: "fetched" },
        { objectKind: "issue", externalId: "I_13", remote: issue(13, ["type:task"], "## 親 PBI\n#77", 77), fetchState: "fetched" },
        { objectKind: "issue", externalId: "I_14", remote: issue(14, ["type:pbi"], pbiBody("## 元要望\nother/repo#5 と acme/app#6（元は #9）\n\n")), fetchState: "fetched" },
        { objectKind: "issue", externalId: "I_9", remote: issue(9, ["type:request"], `## 要望\n${"い".repeat(EVAL_REQUEST_CHARS + 50)}\n\n## 補足\nx`), fetchState: "fetched" },
        { objectKind: "project-item", externalId: "P_10", remote: { issue: 10, owner: "acme", project: 1, fields: { Status: "In progress", Priority: "P2" } }, fetchState: "fetched" },
        { objectKind: "issue", externalId: "I_20", remote: issue(20, ["type:task"], "x"), fetchState: "fetched" },
        { objectKind: "pull-request", externalId: "PR_30", remote: pull(30, "MERGED"), fetchState: "fetched" },
        { objectKind: "pull-request", externalId: "PR_31", remote: pull(31, "OPEN"), fetchState: "fetched" },
      ], cursor: null, syncedAt: 1 });
      run(db, ws.id, dir);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a stage Task of a type:task Issue reads its parent PBI (story and out-of-scope cut) and the source request's head; the counts come from its events", () => {
    withDb((db, ws) => {
      const t = taskOf("s1", ws, { issue: 11, action: "complete" });
      db.insertTask(t);
      for (const ev of [user("go"), stop("a", "decision"), stop("b", "other" as StopRecord["reason"]), user("やり直して", "m2"), end("ok")]) db.appendEvent("s1", ev);
      const c = evalContext(db, t, read(db));
      expect(c.interventions).toEqual({ userInstructions: 1, decisionStops: 1 });
      expect(c.request).toEqual({
        kind: "stage",
        pbi: { number: 10, title: "題 10", story: `${"あ".repeat(EVAL_CONTEXT_CHARS)}…`, outOfScope: "- やらない" },
        source: { number: 9, head: `${"い".repeat(EVAL_REQUEST_CHARS)}…` },
      });
    });
  });

  test("an ordinary Task shows the head of its first message, cut", () => {
    withDb((db, ws) => {
      const t = taskOf("p1", ws, null);
      db.insertTask(t);
      db.appendEvent("p1", user("x".repeat(EVAL_CONTEXT_CHARS + 10)));
      expect(evalContext(db, t, read(db))).toEqual({ request: { kind: "prompt", text: `${"x".repeat(EVAL_CONTEXT_CHARS)}…` }, interventions: { userInstructions: 0, decisionStops: 0 }, outputs: [], pbiStatus: null });
    });
  });

  test("a stage Task of a PBI without 元要望 has source null; one whose Issue is not stored has no PBI either", () => {
    withDb((db, ws) => {
      const t = taskOf("s2", ws, { issue: 12, action: "complete" });
      db.insertTask(t);
      expect(evalContext(db, t, read(db)).request).toMatchObject({ kind: "stage", pbi: { number: 12, title: "題 12", outOfScope: "- やらない" }, source: null });
      const gone = taskOf("s3", ws, { issue: 99, action: "complete" });
      db.insertTask(gone);
      expect(evalContext(db, gone, read(db)).request).toEqual({ kind: "stage", pbi: null, source: null });
    });
  });
  test("a stage Task of a request Issue (to-pbi, direct) has no PBI; its own 要望 head is the source", () => {
    withDb((db, ws) => {
      const t = taskOf("s4", ws, { issue: 9, action: "to-pbi" });
      db.insertTask(t);
      expect(evalContext(db, t, read(db)).request).toEqual({ kind: "stage", pbi: null, source: { number: 9, head: `${"い".repeat(EVAL_REQUEST_CHARS)}…` } });
    });
  });

  test("a type:task Issue whose parent is not stored has no PBI (not the Task Issue itself)", () => {
    withDb((db, ws) => {
      const t = taskOf("s5", ws, { issue: 13, action: "complete" });
      db.insertTask(t);
      expect(evalContext(db, t, read(db)).request).toEqual({ kind: "stage", pbi: null, source: null });
    });
  });

  test("a #N that is part of owner/repo#N in 元要望 is not the source request", () => {
    withDb((db, ws) => {
      const t = taskOf("s6", ws, { issue: 14, action: "complete" });
      db.insertTask(t);
      expect(evalContext(db, t, read(db)).request).toMatchObject({ kind: "stage", pbi: { number: 14 }, source: { number: 9 } });
    });
  });

  test("stageRequestOf cuts the PBI and the request by the given caps, and is null for an ordinary Task", () => {
    withDb((db, ws) => {
      const t = taskOf("c1", ws, { issue: 11, action: "complete" });
      db.insertTask(t);
      const small = stageRequestOf(t, read(db), { pbiChars: 5, requestChars: 3 })!;
      expect(small.pbi).toMatchObject({ story: "ああああああ".slice(0, 5) + "…", outOfScope: "- やらない".slice(0, 5) + "…" });
      expect(small.source).toEqual({ number: 9, head: "いいい…" });
      const large = stageRequestOf(t, read(db), { pbiChars: 10_000, requestChars: 10_000 })!;
      expect(large.pbi!.story).toBe("あ".repeat(EVAL_CONTEXT_CHARS + 50));
      expect(large.source!.head).toBe("い".repeat(EVAL_REQUEST_CHARS + 50));
      expect(stageRequestOf(taskOf("c2", ws, null), read(db), { pbiChars: 5, requestChars: 3 })).toBeNull();
    });
  });

  test("the counts come from the stored rules row when there is one (not counted again)", () => {
    withDb((db, ws) => {
      const t = taskOf("s7", ws, null);
      db.insertTask(t);
      db.appendEvent("s7", user("go"));
      const counted = rulesEvalOf(t, db.listEvents("s7"), db.taskCost("s7"));
      db.upsertEval({ taskId: "s7", source: "rules", by: counted.by, rubric: null, json: { ...counted, metrics: { ...counted.metrics, userInstructions: 7, stopReasons: { decision: 3 } } }, ts: 1 });
      expect(evalContext(db, t, read(db)).interventions).toEqual({ userInstructions: 7, decisionStops: 3 });
    });
  });

  test("outputs: the pull requests, local changes and Issues a Task opened with their stored state, and the PBI's Project Status of a stage Task", () => {
    withDb((db, ws) => {
      const t = taskOf("o1", ws, { issue: 11, action: "complete" });
      db.insertTask(t);
      const call = (id: string, command: string, summary: string) => {
        db.appendEvent("o1", { t: "tool.call", id, name: "Bash", input: { command }, summary: command });
        db.appendEvent("o1", { t: "tool.result", id, ok: true, summary });
      };
      call("a", "gh pr create --fill", "https://github.com/acme/app/pull/30");
      call("b", "gh pr create --fill", "https://github.com/acme/app/pull/31\nhttps://github.com/other/tool/pull/7");
      call("c", "gh issue create --title x", "https://github.com/acme/app/issues/20");
      call("d", "gh pr view 31", "https://github.com/acme/app/pull/99");
      // a local change: its create is stored first, then read back by localId once it has a number
      const localId = "33333333-3333-4333-8333-333333333333";
      const draft = { ...issue(0, [], "変更"), number: 0, change: { head: "sb/1", base: "main", mergeCommit: null, mergedAt: null, reviewedHead: null, pr: null, reportedAt: null } };
      db.appendEventAt("o1", { t: "tool.call", id: "e", name: "Bash", input: { command: "ops-kit backlog create --head sb/1" }, summary: "create" }, Date.now() - 1);
      const [create] = db.applyBacklogEdit(SRC, { records: [{ objectKind: "issue", externalId: `local:${localId}`, local: draft }], operations: [{ id: localId, issue: `local:${localId}`, targetKind: "issue", target: `local:${localId}`, kind: "create", payload: draft }] });
      db.setBacklogOperationResult(create!, { status: "done", remoteId: "I_21", record: { externalId: "I_21", remote: { ...draft, number: 21, title: "手元の変更", state: "CLOSED", change: { ...draft.change, mergedAt: "2026-10-02T00:00:00Z" } } } });
      db.appendEvent("o1", { t: "tool.result", id: "e", ok: true, summary: `#21 を作りました（localId ${localId}）` });
      const c = evalContext(db, t, read(db));
      expect(c.outputs).toEqual([
        { kind: "pr", repo: "acme/app", number: 30, title: null, state: "merged" },
        { kind: "pr", repo: "acme/app", number: 31, title: null, state: "open" },
        { kind: "pr", repo: "other/tool", number: 7, title: null, state: null },
        { kind: "issue", repo: "acme/app", number: 20, title: "題 20", state: "open" },
        { kind: "change", repo: "acme/app", number: 21, title: "手元の変更", state: "merged" },
      ]);
      expect(c.pbiStatus).toBe("In progress");
      // an ordinary Task has no PBI, so no Status
      const p = taskOf("o2", ws, null);
      db.insertTask(p);
      expect(evalContext(db, p, read(db))).toMatchObject({ outputs: [], pbiStatus: null });
    });
  });

  test("a pending remove from the Project hides the PBI's Status, as the stored Issue shows it", () => {
    withDb((db, ws) => {
      const t = taskOf("o3", ws, { issue: 11, action: "complete" });
      db.insertTask(t);
      expect(evalContext(db, t, read(db)).pbiStatus).toBe("In progress");
      db.applyBacklogEdit(SRC, { records: [], operations: [{ issue: "I_10", targetKind: "project-item", target: "P_10", kind: "set", field: "member", payload: false, base: true }] });
      expect(evalContext(db, t, read(db)).pbiStatus).toBeNull();
    });
  });
});

describe("requestSampleRows", () => {
  const SRC: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  const WEEK = Date.UTC(2026, 10, 9); // a Monday
  const day = (n: number) => new Date(WEEK + n * 86_400_000).toISOString();
  const issue = (number: number, labels: string[], body: string, o: Partial<BacklogIssueData> = {}): BacklogIssueData => ({ number, title: `題 ${number}`, url: "", state: "CLOSED", stateReason: "COMPLETED", body, labels, milestone: null, parent: null, subIssues: [], createdAt: day(-30), updatedAt: day(-1), closedAt: day(-3), ...o });
  const rec = (i: BacklogIssueData) => ({ objectKind: "issue" as const, externalId: `I_${i.number}`, remote: i, fetchState: "fetched" as const });
  const task = (id: string, workspaceId: string, stage: Task["stage"], title = id): Task => ({ id, workspaceId, title, runner: "claude", cwd: "/w", scope: ["/w"], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage, statusAt: 1, createdAt: 1, updatedAt: 1 });

  test("a request closed last week with its PBIs closed: the PBIs in order, their stage Tasks and outputs, the interventions summed; open PBIs, older and duplicate requests stay out", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-evals-req-"));
    try {
      const db = new Db(join(dir, "switchboard.db"));
      const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" }).id;
      db.setWorkspaceBacklogSource(ws, SRC);
      db.putBacklogSnapshot(SRC, { records: [
        // the unit: request 9 → PBI 12 (done, Task Issue 13) and PBI 10 (not planned), written in that order
        rec(issue(9, ["type:request"], "## 要望\n速くしてほしい\n\n## 原文\n```\n## 派生 PBI\n#99\n```\n\n## 派生 PBI\n- #12 速くする\n- #10 やらない案（acme/other#55 は別）\n- #12")),
        rec(issue(12, ["type:pbi"], "## 元要望\n#9", { subIssues: [13] })),
        rec(issue(13, ["type:task"], "x", { parent: 12 })),
        rec(issue(10, ["type:pbi"], "## 元要望\n#9", { stateReason: "NOT_PLANNED" })),
        { objectKind: "project-item", externalId: "P_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Done" } }, fetchState: "fetched" },
        // not units: a PBI still open, closed before the week, closed as a duplicate, closed this week, not a request
        rec(issue(20, ["type:request"], "## 要望\nx\n\n## 派生 PBI\n#21")),
        rec(issue(21, ["type:pbi"], "", { state: "OPEN", stateReason: null, closedAt: null })),
        rec(issue(30, ["type:request"], "## 要望\nold", { closedAt: day(-8) })),
        rec(issue(31, ["type:request"], "## 要望\ndup", { stateReason: "DUPLICATE" })),
        rec(issue(32, ["type:request"], "## 要望\nthis week", { closedAt: day(1) })),
        rec(issue(33, ["type:pbi"], "## 元要望\nなし")),
        // a request done directly, with no PBI
        rec(issue(40, ["type:request"], "## 要望\n3 行の追記", { closedAt: day(-5) })),
        { objectKind: "pull-request", externalId: "PR_50", remote: { number: 50, state: "MERGED", isDraft: false, labels: [], closes: [13], mergeCommit: null, updatedAt: day(-3), files: [], closedAt: null, mergedAt: day(-3) } satisfies BacklogPullRequestData, fetchState: "fetched" },
      ], cursor: null, syncedAt: 1 });
      const counted = (id: string, userInstructions: number, decision: number) => {
        const evs = [user("go"), ...Array.from({ length: userInstructions }, (_, i) => user(`again ${i}`, `m${i}`)), ...Array.from({ length: decision }, (_, i) => stop(`s${i}`, "decision")), end("ok")];
        for (const ev of evs) db.appendEvent(id, ev);
        const t = db.getTask(id)!;
        const rules = rulesEvalOf(t, db.listEvents(id), db.taskCost(id));
        db.upsertEval({ taskId: id, source: "rules", by: RULES_BY, rubric: null, json: rules, ts: 1 });
      };
      db.insertTask(task("t-topbi", ws, { issue: 9, action: "to-pbi" }));
      db.insertTask(task("t-impl", ws, { issue: 13, action: "complete" }));
      db.insertTask(task("t-plan", ws, { issue: 12, action: "to-tasks" }));
      db.insertTask(task("t-direct", ws, { issue: 40, action: "direct" }));
      db.insertTask(task("t-other", ws, null));
      counted("t-topbi", 1, 0);
      counted("t-impl", 2, 1);
      counted("t-plan", 0, 0);
      db.appendEvent("t-impl", assistant("opened https://github.com/acme/app/pull/50"));
      const reader = storedIssueReader(db);
      const tasksOf = (numbers: number[]) => tasksOfIssues(db.sqlite, numbers, [ws]).map((t) => t.id);
      const rows = requestSampleRows(db, ws, WEEK - 7 * 86_400_000, WEEK, reader, tasksOf);
      expect(rows.map((r) => r.number)).toEqual([40, 9]); // as closed
      const unit = rows[1]!;
      expect(unit).toMatchObject({ kind: "request", workspaceId: ws, number: 9, title: "題 9", closedAt: WEEK - 3 * 86_400_000, head: "速くしてほしい", taskIds: ["t-topbi"], interventions: 4, human: null });
      expect(unit.pbis.map((p) => [p.number, p.status, p.dropped, [...p.taskIds].sort(), p.interventions])).toEqual([[12, "Done", false, ["t-impl", "t-plan"], 3], [10, null, true, [], 0]]);
      expect(rows[0]).toMatchObject({ number: 40, pbis: [], taskIds: ["t-direct"], interventions: 0 });
      // outputs are read for the rows picked only
      expect(unit.pbis[0]!.outputs).toEqual([]);
      const full = withRequestOutputs(db, unit, reader);
      expect(full.pbis[0]!.outputs).toEqual(db.createdPullsOf("t-impl").map((p) => ({ kind: "pr", repo: p.repo, number: p.number, title: null, state: "merged" })));
      // the unit's tasks are not asked again as tasks; a task outside it is
      const list = ["t-impl", "t-plan", "t-topbi", "t-other"].map((x, i) => listRow(x, 2 + i * 0.5, { workspaceId: ws }));
      const picked = weeklyHumanSample(list, rows).map((u) => ("kind" in u ? `#${u.number}` : u.taskId));
      expect(picked).toEqual(["#9", "#40", "t-other"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
