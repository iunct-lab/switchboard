import type { AgentEvent, BacklogPullRequestData, EvalContext, EvalsListRow, EventEnvelope, RuleEval, RuleMetrics, Task, TaskEvals } from "@switchboard/protocol";
import { DEFAULT_RUBRIC } from "./rubric.ts";
import type { StoredIssueReader } from "./backlog.ts";
import type { Db } from "./db.ts";

/**
 * Evals: what a task's own record says about how it went, counted by rules — no model, no person. The counts
 * feed the task screen now and the rubric judge and the list later. Stored in `task_evals`
 * (`Db.upsertEval`) under `source: rules`, one row per task; `RULES_BY` names the counter so a change in what is
 * counted tells old rows apart.
 */
export const RULES_BY = "rules@5";

/** How every message the daemon sends by itself begins (`RESUME_PROMPT`, `STOP_RESUME_PROMPT`): not the person's instruction. */
export const AUTO_RESUME_HEAD = "[Switchboard 自動再開]";

export function isAutomaticUserText(text: string): boolean {
  return text.startsWith(AUTO_RESUME_HEAD);
}

/** The transcript note a daemon stop leaves (interrupted.ts); also how the resumer, its cap and the counts below recognise one. Here, not there, because interrupted.ts imports this file. */
export const STOP_NOTE = "デーモンの停止でターンが中断されました";

/** How the transcript note of Task ごとの実装のモデル begins; the model follows it. */
export const DELEGATED_HEAD = "Task ごとの実装は ";
const DELEGATED_TAIL = " に任せます";

/** The note an 実装 Task started with a model for each Task's implementation leaves (server.ts `startStage`): what was handed over, not what ran. */
export function delegatedNote(model: string): string {
  return `${DELEGATED_HEAD}${model}${DELEGATED_TAIL}`;
}

/** The model of a `delegatedNote` line; null for any other status text. */
export function delegatedModelOf(text: string): string | null {
  if (!text.startsWith(DELEGATED_HEAD) || !text.endsWith(DELEGATED_TAIL)) return null;
  return text.slice(DELEGATED_HEAD.length, -DELEGATED_TAIL.length) || null;
}

/**
 * The person's messages in order (the first is the request). Consecutive user deltas are one message (a streamed message
 * arrives in chunks; any other event between them ends it) unless a delta carries a `messageId` the one before did not —
 * two follow-ups typed while the runner was silent. The daemon's own resume messages are not the person's.
 */
export function personMessages(events: AgentEvent[]): string[] {
  const out: string[] = [];
  let text: string | null = null; // the user message being assembled; null = not in one
  let id: string | undefined; // its messageId, when the adapter gave one
  const flush = () => {
    if (text !== null && !isAutomaticUserText(text)) out.push(text);
    text = null;
    id = undefined;
  };
  for (const ev of events) {
    if (ev.t === "message.delta" && ev.role === "user") {
      if (text !== null && ev.messageId && ev.messageId !== id) flush(); // an id after a different id, or after id-less chunks: a new message
      text = (text ?? "") + ev.text;
      id = ev.messageId ?? id;
    } else flush();
  }
  flush();
  return out;
}

/**
 * The counts over a task's events. Consecutive user deltas are one message (a streamed message arrives in chunks; any
 * other event between them ends it — `recapOf` cuts only on a role change, a tool call or a turn's end) unless a delta
 * carries a `messageId` the one before did not — two follow-ups typed while the runner was silent. Two follow-ups without ids and nothing between them read as one: a known under-count, not worth a
 * second rule. The first message is the request; later ones are the person's instructions unless the daemon sent them.
 * A daemon stop's note marks the turn it cut until the next user message (the daemon's own resume included): `shutdown`
 * writes the note before that turn's `session.end`, `abortOrphanedTasks` after it, so the turn's end is not the boundary.
 * A stop is counted once per `stop.id`, under the reason of its last record (a record is rewritten as the stop moves on).
 */
export function ruleMetrics(events: EventEnvelope[]): RuleMetrics {
  const m: RuleMetrics = { turns: 0, toolCalls: 0, toolFailures: 0, errors: 0, asks: 0, denials: 0, stops: 0, stopReasons: {}, userInstructions: 0, lastEnd: null, daemonStops: 0, lastCutByDaemon: false, durationMs: null, classifier: null, delegatedModel: null };
  const stopIds = new Map<string, string>(); // stop.id -> reason of its last record
  let cut = false; // a daemon stop's note since the last user message
  for (const { ev } of events) {
    if (ev.t === "message.delta" && ev.role === "user") {
      cut = false;
      continue;
    }
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
        m.delegatedModel ??= delegatedModelOf(ev.text);
        break;
      case "stop.record":
        stopIds.set(ev.stop.id, ev.stop.reason);
        break;
    }
  }
  m.stops = stopIds.size;
  for (const reason of stopIds.values()) m.stopReasons[reason] = (m.stopReasons[reason] ?? 0) + 1;
  m.userInstructions = Math.max(0, personMessages(events.map((e) => e.ev)).length - 1);
  m.lastCutByDaemon = m.lastEnd !== null && cut;
  if (events.length) {
    // The end is the last event that is not a `status`: the notes after `done` (container cleanup) are not work.
    let end = events.length - 1;
    while (end >= 0 && events[end]!.ev.t === "status") end--;
    m.durationMs = events[end >= 0 ? end : events.length - 1]!.ts - events[0]!.ts;
  }
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
 * The draft of an improvement request from a task's evaluations: the task, its counts in one line, the rubric
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

/** The Monday 0:00 UTC of the week `now` falls in (ms). The weekly sample is picked from the week before it. */
export function weekStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}

/**
 * The tasks asked to be rated this week, from the rows judged in the week before: sorted by the judge's
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

/** How far the person's rating sits from the judge: human − the judge's average over the tasks with both, mean to one decimal. Not used to correct anything. */
export function judgeHumanGap(rows: EvalsListRow[]): { count: number; mean: number | null } {
  const diffs = rows.flatMap((r) => (r.judge && r.human ? [r.human.rating - r.judge.average] : []));
  return { count: diffs.length, mean: diffs.length ? Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10 : null };
}

/** How many characters of a PBI's story / out-of-scope and of a first message the Evals context shows: what a row can read at a glance. */
export const EVAL_CONTEXT_CHARS = 300;
/** The same for the head of the source request's `## 要望`. */
export const EVAL_REQUEST_CHARS = 200;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The body under `## <heading>` up to the next `## ` line, trimmed; "" when there is none. */
function sectionOf(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `## ${heading}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((l) => l.startsWith("## "));
  return (next < 0 ? rest : rest.slice(0, next)).join("\n").trim();
}

/**
 * What the Insights sample shows beside a task so it can be rated without its conversation (`EvalContext`). A stage
 * Task reads its Issue from the stored copy (no GitHub call): a type:task Issue goes up to its parent PBI (none when the parent is not
 * stored), a PBI is read as it is; the first `#N` of the PBI's `## 元要望` is read the same way for its `## 要望`. Any other Task shows the
 * head of its first message. The counts come from the stored rules row, or are counted now (not kept) when there is none.
 * A request Issue's own stage (to-pbi, direct) has no PBI: its `## 要望` is the source. `issues` is the caller's `storedIssueReader`: it is passed in, and this file takes only types from backlog.ts and db.ts (which import it), so there is no runtime import cycle.
 */
export function evalContext(db: Db, task: Task, issues: StoredIssueReader): EvalContext {
  const rules = db.evalsOf(task.id).rules ?? rulesEvalOf(task, db.listEvents(task.id), db.taskCost(task.id));
  const interventions = { userInstructions: rules.metrics.userInstructions, decisionStops: rules.metrics.stopReasons.decision ?? 0 };
  const source = task.workspaceId ? db.getWorkspaceBacklogSource(task.workspaceId) : null;
  const read = (n: number) => (task.workspaceId ? issues.issue(task.workspaceId, n) : null);
  const requestHead = (n: number, body: string) => ({ number: n, head: cut(sectionOf(body, "要望"), EVAL_REQUEST_CHARS) });
  const ours = (repo: string) => !!source && source.repository.toLowerCase() === repo;
  const created = db.createdPullsOf(task.id);
  // the stored pull-request records are read only when the Task opened a pull request
  const pulls = source && created.length ? db.listBacklogRecords(source, "pull-request").flatMap((r) => (r.remote && r.fetchState === "fetched" ? [r.remote as BacklogPullRequestData] : [])) : [];
  type Output = EvalContext["outputs"][number];
  const outputs: Output[] = [
    ...created.map(({ repo, number }): Output => {
      const state = ours(repo) ? pulls.find((p) => p.number === number)?.state : undefined;
      return { kind: "pr", repo, number, title: null, state: state ? (state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open") : null };
    }),
    ...db.createdIssuesOf(task.id).map(({ repo, number }): Output => {
      const found = ours(repo) ? read(number) : null;
      if (!found) return { kind: "issue", repo, number, title: null, state: null };
      return { kind: found.change ? "change" : "issue", repo, number, title: found.title, state: found.change?.mergedAt ? "merged" : found.state === "OPEN" ? "open" : "closed" };
    }),
  ];
  if (!task.stage) return { request: { kind: "prompt", text: cut(db.firstUserText(task.id) ?? "", EVAL_CONTEXT_CHARS) }, interventions, outputs, pbiStatus: null };
  const issue = read(task.stage.issue);
  if (!issue) return { request: { kind: "stage", pbi: null, source: null }, interventions, outputs, pbiStatus: null };
  // a request's own stage (to-pbi, direct): no PBI yet, its `## 要望` is the source
  if (issue.labels.includes("type:request")) return { request: { kind: "stage", pbi: null, source: requestHead(issue.number, issue.body) }, interventions, outputs, pbiStatus: null };
  // a type:task Issue goes up to its parent; one whose parent is not stored shows no PBI
  const pbiIssue = issue.labels.includes("type:task") ? (issue.parent ? read(issue.parent) : null) : issue;
  if (!pbiIssue) return { request: { kind: "stage", pbi: null, source: null }, interventions, outputs, pbiStatus: null };
  const pbi = { number: pbiIssue.number, title: pbiIssue.title, story: cut(sectionOf(pbiIssue.body, "ユーザーストーリー"), EVAL_CONTEXT_CHARS), outOfScope: cut(sectionOf(pbiIssue.body, "スコープ外"), EVAL_CONTEXT_CHARS) };
  // the first `#N` of `## 元要望` that is not part of `owner/repo#N` (another repository's number reads another Issue here)
  const sourceNumber = /(?<![\w/])#(\d+)/.exec(sectionOf(pbiIssue.body, "元要望"))?.[1];
  const request = sourceNumber ? requestHead(Number(sourceNumber), read(Number(sourceNumber))?.body ?? "") : null;
  const status = task.workspaceId ? issues.fields(task.workspaceId, pbi.number)?.["Status"] : undefined;
  return { request: { kind: "stage", pbi, source: request }, interventions, outputs, pbiStatus: typeof status === "string" ? status : null };
}
