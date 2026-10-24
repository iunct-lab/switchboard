import type { EventEnvelope, RuleEval, RuleMetrics, Task, TaskEvals } from "@switchboard/protocol";
import { DEFAULT_RUBRIC } from "./rubric.ts";

/**
 * Evals (#1218): what a task's own record says about how it went, counted by rules — no model, no person. The counts
 * feed the task screen now and the rubric judge (#1219) and the list (#1221) later. Stored in `task_evals`
 * (`Db.upsertEval`) under `source: rules`, one row per task; `RULES_BY` names the counter so a change in what is
 * counted tells old rows apart.
 */
export const RULES_BY = "rules@1";

/** How every message the daemon sends by itself begins (`RESUME_PROMPT`, `STOP_RESUME_PROMPT`): not the person's instruction. */
export const AUTO_RESUME_HEAD = "[Switchboard 自動再開]";

export function isAutomaticUserText(text: string): boolean {
  return text.startsWith(AUTO_RESUME_HEAD);
}

/**
 * The counts over a task's events. Consecutive user deltas are one message (a streamed message arrives in chunks; any
 * other event between them ends it — `recapOf` cuts only on a role change, a tool call or a turn's end) unless a delta
 * carries a `messageId` the one before did not — two follow-ups typed while the runner was silent. Two follow-ups without ids and nothing between them read as one: a known under-count, not worth a
 * second rule. The first message is the request; later ones are the person's instructions unless the daemon sent them.
 */
export function ruleMetrics(events: EventEnvelope[]): RuleMetrics {
  const m: RuleMetrics = { turns: 0, toolCalls: 0, toolFailures: 0, errors: 0, asks: 0, denials: 0, stops: 0, stopReasons: {}, userInstructions: 0, lastEnd: null, durationMs: null };
  let userMessages = 0;
  let userText: string | null = null; // the user message being assembled; null = not in one
  let userId: string | undefined; // its messageId, when the adapter gave one
  const flushUser = () => {
    if (userText !== null && !isAutomaticUserText(userText)) userMessages++;
    userText = null;
    userId = undefined;
  };
  for (const { ev } of events) {
    if (ev.t === "message.delta" && ev.role === "user") {
      if (userText !== null && ev.messageId && ev.messageId !== userId) flushUser(); // an id after a different id, or after id-less chunks: a new message
      userText = (userText ?? "") + ev.text;
      userId = ev.messageId ?? userId;
      continue;
    }
    flushUser();
    switch (ev.t) {
      case "session.end":
        m.turns++;
        m.lastEnd = ev.status;
        break;
      case "tool.call":
        m.toolCalls++;
        break;
      case "tool.result":
        if (!ev.ok) m.toolFailures++;
        break;
      case "error":
        m.errors++;
        break;
      case "permission.ask":
        m.asks++;
        break;
      case "permission.resolved":
        if (ev.decision === "deny") m.denials++;
        break;
      case "stop.record":
        m.stops++;
        m.stopReasons[ev.stop.reason] = (m.stopReasons[ev.stop.reason] ?? 0) + 1;
        break;
    }
  }
  flushUser();
  m.userInstructions = Math.max(0, userMessages - 1);
  if (events.length) m.durationMs = events[events.length - 1]!.ts - events[0]!.ts;
  return m;
}

/** The rules row for a task as it stands: its metrics with the status, outcome and ledger total of the moment. */
export function rulesEvalOf(task: Task, events: EventEnvelope[], cost: { costUsd: number }, now = Date.now()): RuleEval {
  return { metrics: ruleMetrics(events), status: task.status, outcome: task.outcome, costUsd: cost.costUsd, by: RULES_BY, ts: now };
}

/** A rubric criterion's title for the draft: the default rubric's wording, else the id as it is. */
const criterionTitle = (id: string) => DEFAULT_RUBRIC.criteria.find((c) => c.id === id)?.title ?? id;

/**
 * The draft of an improvement request from a task's evaluations (#1221): the task, its counts in one line, the rubric
 * criteria scored 3 or below with their reasons, the person's rating, then a line for what the person wants changed.
 * The person edits it in the feedback dialog before it is sent; nothing is filed from here.
 */
export function evalRequestDraft(task: Pick<Task, "id" | "title" | "runner">, e: TaskEvals): string {
  const lines = [`Task「${task.title.replace(/\s+/g, " ").trim()}」（${task.id}、${task.runner}）の評価から:`];
  if (e.rules) {
    const m = e.rules.metrics;
    lines.push(`- 指標: ツール呼び出し ${m.toolCalls} / 失敗 ${m.toolFailures} / エラー ${m.errors} / 追加指示 ${m.userInstructions} / 停止 ${m.stops} / 終わり方 ${m.lastEnd ?? "-"}`);
  }
  if (e.judge) {
    const low = Object.entries(e.judge.scores).filter(([, v]) => v.score <= 3);
    for (const [id, v] of low) lines.push(`- ${criterionTitle(id)}: ${v.score} / 5 — ${v.reason}`);
    if (e.judge.summary) lines.push(`- 総評（${e.judge.by}、${e.judge.rubric}）: ${e.judge.summary}`);
  }
  if (e.human) lines.push(`- 自分の評価: ${e.human.rating} / 5${e.human.comment ? ` — ${e.human.comment}` : ""}`);
  lines.push("", "改善したいこと:", "");
  return lines.join("\n");
}
