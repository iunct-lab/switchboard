import type { EvalsListRow, EventEnvelope, RuleEval, RuleMetrics, Task, TaskEvals } from "@switchboard/protocol";
import { DEFAULT_RUBRIC } from "./rubric.ts";

/**
 * Evals (#1218): what a task's own record says about how it went, counted by rules — no model, no person. The counts
 * feed the task screen now and the rubric judge (#1219) and the list (#1221) later. Stored in `task_evals`
 * (`Db.upsertEval`) under `source: rules`, one row per task; `RULES_BY` names the counter so a change in what is
 * counted tells old rows apart.
 */
export const RULES_BY = "rules@3";

/** How every message the daemon sends by itself begins (`RESUME_PROMPT`, `STOP_RESUME_PROMPT`): not the person's instruction. */
export const AUTO_RESUME_HEAD = "[Switchboard 自動再開]";

export function isAutomaticUserText(text: string): boolean {
  return text.startsWith(AUTO_RESUME_HEAD);
}

/** The transcript note a daemon stop leaves (interrupted.ts); also how the resumer, its cap and the counts below recognise one. Here, not there, because interrupted.ts imports this file. */
export const STOP_NOTE = "デーモンの停止でターンが中断されました";

/**
 * The counts over a task's events. Consecutive user deltas are one message (a streamed message arrives in chunks; any
 * other event between them ends it — `recapOf` cuts only on a role change, a tool call or a turn's end) unless a delta
 * carries a `messageId` the one before did not — two follow-ups typed while the runner was silent. Two follow-ups without ids and nothing between them read as one: a known under-count, not worth a
 * second rule. The first message is the request; later ones are the person's instructions unless the daemon sent them.
 * A daemon stop's note marks the turn it cut until the next user message (the daemon's own resume included): `shutdown`
 * writes the note before that turn's `session.end`, `abortOrphanedTasks` after it, so the turn's end is not the boundary.
 */
export function ruleMetrics(events: EventEnvelope[]): RuleMetrics {
  const m: RuleMetrics = { turns: 0, toolCalls: 0, toolFailures: 0, errors: 0, asks: 0, denials: 0, stops: 0, stopReasons: {}, userInstructions: 0, lastEnd: null, daemonStops: 0, lastCutByDaemon: false, durationMs: null, classifier: null };
  let userMessages = 0;
  let userText: string | null = null; // the user message being assembled; null = not in one
  let userId: string | undefined; // its messageId, when the adapter gave one
  let cut = false; // a daemon stop's note since the last user message
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
      cut = false;
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
        if (ev.reason === "classifier") stopped(m, "asked");
        break;
      case "classifier.decision":
        if (ev.verdict === "allow") (m.classifier ??= { allowed: 0, denied: 0, byCategory: {} }).allowed++;
        else stopped(m, ev.category);
        break;
      case "permission.resolved":
        if (ev.decision === "deny") m.denials++;
        break;
      case "status":
        if (ev.text.startsWith(STOP_NOTE)) {
          m.daemonStops++;
          cut = true;
        }
        break;
      case "stop.record":
        m.stops++;
        m.stopReasons[ev.stop.reason] = (m.stopReasons[ev.stop.reason] ?? 0) + 1;
        break;
    }
  }
  flushUser();
  m.userInstructions = Math.max(0, userMessages - 1);
  m.lastCutByDaemon = m.lastEnd !== null && cut;
  if (events.length) m.durationMs = events[events.length - 1]!.ts - events[0]!.ts;
  return m;
}

/** One call the classifier stopped, under its kind when there is one. */
function stopped(m: RuleMetrics, kind: string | null) {
  const c = (m.classifier ??= { allowed: 0, denied: 0, byCategory: {} });
  c.denied++;
  if (kind) c.byCategory[kind] = (c.byCategory[kind] ?? 0) + 1;
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

/** The Monday 0:00 UTC of the week `now` falls in (ms). The weekly sample (#1877) is picked from the week before it. */
export function weekStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}

/**
 * The tasks asked to be rated this week (#1877), from the rows judged in the week before: sorted by the judge's
 * average and cut into low / middle / high bands, one from each band in turn, at most 5. In a band a kind
 * (workspace × runner) not picked yet comes first, then the lowest taskId — the same rows give the same picks, so
 * nothing is stored. Fewer than 3 candidates → all of them.
 */
export function weeklyHumanSample(rows: EvalsListRow[]): EvalsListRow[] {
  const judged = rows.filter((r) => r.judge).sort((a, b) => a.judge!.average - b.judge!.average || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  if (judged.length < 3) return judged;
  const bands: EvalsListRow[][] = [[], [], []];
  judged.forEach((r, i) => bands[Math.floor((i * 3) / judged.length)]!.push(r));
  for (const band of bands) band.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const kind = (r: EvalsListRow) => `${r.workspaceId}:${r.runner}`;
  const kinds = new Set<string>();
  const picked: EvalsListRow[] = [];
  while (picked.length < 5 && bands.some((b) => b.length)) {
    for (const band of bands) {
      if (picked.length >= 5 || !band.length) continue;
      const i = Math.max(0, band.findIndex((r) => !kinds.has(kind(r))));
      const [r] = band.splice(i, 1);
      kinds.add(kind(r!));
      picked.push(r!);
    }
  }
  return picked;
}

/** How far the person's rating sits from the judge (#1877): human − the judge's average over the tasks with both, mean to one decimal. Not used to correct anything. */
export function judgeHumanGap(rows: EvalsListRow[]): { count: number; mean: number | null } {
  const diffs = rows.flatMap((r) => (r.judge && r.human ? [r.human.rating - r.judge.average] : []));
  return { count: diffs.length, mean: diffs.length ? Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10 : null };
}
