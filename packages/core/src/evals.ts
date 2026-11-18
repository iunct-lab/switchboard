import type { AgentEvent, BacklogPullRequestData, EvalContext, EvalsListRow, EvalsRequestRow, EvalsSummary, EvalStage, EventEnvelope, RequestEval, RuleEval, RuleMetrics, Task, TaskEvals } from "@switchboard/protocol";
import { DEFAULT_RUBRIC } from "./rubric.ts";
import type { StoredIssueReader } from "./backlog-stored.ts";
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

/** The note an 実装 Task started with a model for each Task's implementation leaves (server/start.ts `startStage`): what was handed over, not what ran. */
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

/** How often the person had to step into a Task: follow-up instructions plus the stops whose reason is `decision`. */
export function interventionsOf(r: Pick<EvalsListRow, "rules">): number {
  return (r.rules?.userInstructions ?? 0) + (r.rules?.decisionStops ?? 0);
}

/** How many lines 評価をお願い asks for in a week. */
export const EVAL_SAMPLE_SIZE = 5;
/** Of those, how many go first to what the person stepped into most; the rest keep the closed requests and the judge's bands. */
export const EVAL_PUSHBACK_SLOTS = 2;

/** What `weeklyHumanSample` reads of a closed request's row. */
type RequestUnit = Pick<EvalsRequestRow, "kind" | "workspaceId" | "number" | "closedAt" | "interventions" | "taskIds"> & { pbis: Array<Pick<EvalsRequestRow["pbis"][number], "taskIds">> };
const tasksOfUnit = (r: RequestUnit) => [...r.taskIds, ...r.pbis.flatMap((p) => p.taskIds)];
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What is asked to be rated this week, at most `EVAL_SAMPLE_SIZE` lines, from the tasks judged and the requests closed
 * in the week before:
 *  1. up to `EVAL_PUSHBACK_SLOTS` of the units (a request with its PBIs, or a judged task) the person stepped into at
 *     least once, most first (`interventionsOf`; a request before a task on a tie, then the lower number / taskId) —
 *     whatever the judge's score was;
 *  2. the remaining requests, in the order they were closed;
 *  3. the remaining judged tasks: sorted by the judge's average and cut into low / middle / high bands, one from each
 *     band in turn. In a band a kind (workspace × runner) not picked yet comes first, then the lowest taskId. Fewer
 *     than 3 → all of them.
 * A task that belongs to a picked request is not asked again as a task. The same rows give the same picks, so nothing is stored.
 */
export function weeklyHumanSample(rows: EvalsListRow[]): EvalsListRow[];
export function weeklyHumanSample<R extends RequestUnit>(rows: EvalsListRow[], requests: R[]): Array<EvalsListRow | R>;
export function weeklyHumanSample<R extends RequestUnit>(rows: EvalsListRow[], requests: R[] = []): Array<EvalsListRow | R> {
  const picked: Array<EvalsListRow | R> = [];
  const isRequest = (u: EvalsListRow | R): u is R => "kind" in u && u.kind === "request";
  const covered = new Set<string>(); // the tasks of the requests picked
  const take = (u: EvalsListRow | R) => {
    if (picked.length >= EVAL_SAMPLE_SIZE || picked.includes(u) || (!isRequest(u) && covered.has(u.taskId))) return;
    picked.push(u);
    if (isRequest(u)) for (const id of tasksOfUnit(u)) covered.add(id);
  };
  const judged = rows.filter((r) => r.judge);
  const count = (u: EvalsListRow | R) => (isRequest(u) ? u.interventions : interventionsOf(u));
  // a task of a request closed that week stands in the first slots as its request (whose count includes it), not twice
  const inRequests = new Set(requests.flatMap(tasksOfUnit));
  const pushed = [...requests, ...judged.filter((r) => !inRequests.has(r.taskId))]
    .filter((u) => count(u) > 0)
    .sort((a, b) => count(b) - count(a) || Number(isRequest(b)) - Number(isRequest(a)) || (isRequest(a) && isRequest(b) ? byId(a.workspaceId, b.workspaceId) || a.number - b.number : byId((a as EvalsListRow).taskId, (b as EvalsListRow).taskId)));
  for (const u of pushed) {
    if (picked.length >= EVAL_PUSHBACK_SLOTS) break;
    take(u);
  }
  for (const r of [...requests].sort((a, b) => a.closedAt - b.closedAt || byId(a.workspaceId, b.workspaceId) || a.number - b.number)) take(r);

  const rest = judged.filter((r) => !picked.includes(r) && !covered.has(r.taskId)).sort((a, b) => a.judge!.average - b.judge!.average || byId(a.taskId, b.taskId));
  if (rest.length < 3) {
    for (const r of rest) take(r);
    return picked;
  }
  const bands: EvalsListRow[][] = [[], [], []];
  rest.forEach((r, i) => bands[Math.floor((i * 3) / rest.length)]!.push(r));
  for (const band of bands) band.sort((a, b) => byId(a.taskId, b.taskId));
  const kind = (r: EvalsListRow) => `${r.workspaceId}:${r.runner}`;
  const kinds = new Set<string>();
  while (picked.length < EVAL_SAMPLE_SIZE && bands.some((b) => b.length)) {
    for (const band of bands) {
      if (picked.length >= EVAL_SAMPLE_SIZE || !band.length) continue;
      const i = Math.max(0, band.findIndex((r) => !kinds.has(kind(r))));
      const [r] = band.splice(i, 1);
      kinds.add(kind(r!));
      take(r!);
    }
  }
  return picked;
}

/** For how long back the chosen stages are counted (`EvalsSummary.stages`). */
export const EVAL_STAGE_WEEKS = 4;
const STAGES: EvalStage[] = ["none", "request", "pbi", "impl", "report"];
/** How many requests a stage's row names. */
const STAGE_EXAMPLES = 5;

/**
 * How often each stage was chosen in the request evaluations written at or after `from` (`rows` newest first, as
 * `Db.requestEvalsSince` gives them): every stage has a row, 0 too; an evaluation that chose several counts once in each.
 */
export function stageCounts(rows: Array<{ workspaceId: string; issue: number; eval: RequestEval }>, from: number): EvalsSummary["stages"] {
  const recent = rows.filter((r) => r.eval.ts >= from);
  return {
    from,
    rows: STAGES.map((stage) => {
      const hits = recent.filter((r) => r.eval.stages.includes(stage));
      return { stage, count: hits.length, examples: hits.slice(0, STAGE_EXAMPLES).map((r) => ({ workspaceId: r.workspaceId, number: r.issue })) };
    }),
  };
}

/** How far the person's rating sits from the judge: human − the judge's average over the tasks with both, mean to one decimal. Not used to correct anything. */
export function judgeHumanGap(rows: EvalsListRow[]): EvalsSummary["gap"] {
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const diffs = rows.flatMap((r) => (r.judge && r.human ? [r.human.rating - r.judge.average] : []));
  // where the person's answer says the judge's criterion should be low, what the judge scored it; a judge row without that score is left out
  const scored = (criterion: string, missed: (h: NonNullable<EvalsListRow["human"]>) => boolean) => {
    const xs = rows.flatMap((r) => (r.human && missed(r.human) && r.judge?.scores[criterion] !== undefined ? [r.judge.scores[criterion]!] : []));
    return { count: xs.length, mean: mean(xs) };
  };
  return {
    count: diffs.length,
    mean: mean(diffs),
    intent: scored("intent", (h) => h.intent === "partial" || h.intent === "wrong"),
    minimal: scored("minimal", (h) => h.complexity === "some" || h.detour === "some"),
    value: scored("value", (h) => h.value === "unused"),
  };
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

/** The PBI and source request a stage Task works from, each part capped (`caps`): shown in Insights and read by the rubric judge. */
export type StageRequest = { pbi: { number: number; title: string; story: string; outOfScope: string } | null; source: { number: number; head: string } | null };

/**
 * A stage Task's PBI (`## ユーザーストーリー` / `## スコープ外`) and the source request's `## 要望`, read from the stored copy (no
 * GitHub call). A type:task Issue goes up to its parent PBI (none when the parent is not stored), a PBI is read as it is, and the first
 * `#N` of the PBI's `## 元要望` that is not part of `owner/repo#N` is the source. A request Issue's own stage (to-pbi, direct) has no PBI:
 * its `## 要望` is the source. null when the Task is not a stage Task.
 */
export function stageRequestOf(task: Task, issues: StoredIssueReader, caps: { pbiChars: number; requestChars: number }): StageRequest | null {
  if (!task.stage) return null;
  const read = (n: number) => (task.workspaceId ? issues.issue(task.workspaceId, n) : null);
  const requestHead = (n: number, body: string) => ({ number: n, head: cut(sectionOf(body, "要望"), caps.requestChars) });
  const issue = read(task.stage.issue);
  if (!issue) return { pbi: null, source: null };
  if (issue.labels.includes("type:request")) return { pbi: null, source: requestHead(issue.number, issue.body) };
  const pbiIssue = issue.labels.includes("type:task") ? (issue.parent ? read(issue.parent) : null) : issue;
  if (!pbiIssue) return { pbi: null, source: null };
  const pbi = { number: pbiIssue.number, title: pbiIssue.title, story: cut(sectionOf(pbiIssue.body, "ユーザーストーリー"), caps.pbiChars), outOfScope: cut(sectionOf(pbiIssue.body, "スコープ外"), caps.pbiChars) };
  const sourceNumber = /(?<![\w/])#(\d+)/.exec(sectionOf(pbiIssue.body, "元要望"))?.[1];
  return { pbi, source: sourceNumber ? requestHead(Number(sourceNumber), read(Number(sourceNumber))?.body ?? "") : null };
}

/**
 * What the Insights sample shows beside a task so it can be rated without its conversation (`EvalContext`). A stage
 * Task reads its Issue from the stored copy (no GitHub call): a type:task Issue goes up to its parent PBI (none when the parent is not
 * stored), a PBI is read as it is; the first `#N` of the PBI's `## 元要望` is read the same way for its `## 要望`. Any other Task shows the
 * head of its first message. The counts come from the stored rules row, or are counted now (not kept) when there is none.
 * A request Issue's own stage (to-pbi, direct) has no PBI: its `## 要望` is the source. `issues` is the caller's `storedIssueReader`: it is passed in, and this file takes only types from backlog-stored.ts and db.ts (which import it), so there is no runtime import cycle.
 */
export function evalContext(db: Db, task: Task, issues: StoredIssueReader): EvalContext {
  const rules = db.evalsOf(task.id).rules ?? rulesEvalOf(task, db.listEvents(task.id), db.taskCost(task.id));
  const interventions = { userInstructions: rules.metrics.userInstructions, decisionStops: rules.metrics.stopReasons.decision ?? 0 };
  const outputs = evalOutputs(db, task, issues);
  if (!task.stage) return { request: { kind: "prompt", text: cut(db.firstUserText(task.id) ?? "", EVAL_CONTEXT_CHARS) }, interventions, outputs, pbiStatus: null };
  const stage = stageRequestOf(task, issues, { pbiChars: EVAL_CONTEXT_CHARS, requestChars: EVAL_REQUEST_CHARS })!;
  const status = stage.pbi && task.workspaceId ? issues.fields(task.workspaceId, stage.pbi.number)?.["Status"] : undefined;
  return { request: { kind: "stage", pbi: stage.pbi, source: stage.source }, interventions, outputs, pbiStatus: typeof status === "string" ? status : null };
}

/** The pull requests, local changes and Issues a Task opened, with their stored state (`EvalContext.outputs`); no GitHub call. */
export function evalOutputs(db: Db, task: Pick<Task, "id" | "workspaceId">, issues: StoredIssueReader): EvalContext["outputs"] {
  const source = task.workspaceId ? db.getWorkspaceBacklogSource(task.workspaceId) : null;
  const read = (n: number) => (task.workspaceId ? issues.issue(task.workspaceId, n) : null);
  const ours = (repo: string) => !!source && source.repository.toLowerCase() === repo;
  const created = db.createdPullsOf(task.id);
  // the stored pull-request records are read only when the Task opened a pull request
  const pulls = source && created.length ? db.listBacklogRecords(source, "pull-request").flatMap((r) => (r.remote && r.fetchState === "fetched" ? [r.remote as BacklogPullRequestData] : [])) : [];
  type Output = EvalContext["outputs"][number];
  return [
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
}

/**
 * The requests of a workspace closed in [from, to) whose derived PBIs are all closed too (done, or not planned), as the
 * lines 評価をお願い can ask for: the request's `## 要望` head, its own stage Tasks (to-pbi, direct) and each PBI with
 * the stage Tasks of it and of its sub-issues, and how often the person stepped into them (from the stored rules rows;
 * nothing is counted again). Read from the stored copy, no GitHub call; no column ties a request to its PBIs — the
 * request's `## 派生 PBI`, the PBI's sub-issues and `tasksOf` (the Tasks of some Issues, db/issue-work.ts's `tasksOfIssues`) do.
 * `outputs` are left empty here: reading them costs a Task's records, so `withRequestOutputs` fills the picked rows only.
 */
export function requestSampleRows(db: Db, workspaceId: string, from: number, to: number, issues: StoredIssueReader, tasksOf: (issueNumbers: number[]) => string[]): EvalsRequestRow[] {
  const stepped = (taskIds: string[]) =>
    taskIds.reduce((sum, id) => {
      const m = db.evalsOf(id).rules?.metrics;
      return sum + (m ? m.userInstructions + (m.stopReasons.decision ?? 0) : 0);
    }, 0);
  return issues.closedRequests(workspaceId, from, to).flatMap(({ issue, pbis: numbers }): EvalsRequestRow[] => {
    const stored = numbers.flatMap((n) => {
      const pbi = issues.issue(workspaceId, n);
      return pbi ? [pbi] : [];
    });
    if (stored.some((p) => p.state !== "CLOSED")) return []; // a PBI still open: the unit is not finished
    const taskIds = tasksOf([issue.number]);
    const pbis = stored.map((p) => {
      const ids = tasksOf([p.number, ...p.subIssues]);
      const status = issues.fields(workspaceId, p.number)?.["Status"];
      return { number: p.number, title: p.title, status: typeof status === "string" ? status : null, dropped: p.stateReason === "NOT_PLANNED", taskIds: ids, outputs: [], interventions: stepped(ids) };
    });
    return [{ kind: "request", workspaceId, number: issue.number, title: issue.title, closedAt: Date.parse(issue.closedAt!), head: cut(sectionOf(issue.body, "要望"), EVAL_REQUEST_CHARS), taskIds, outputs: [], pbis, interventions: stepped(taskIds) + pbis.reduce((a, p) => a + p.interventions, 0), human: null }];
  });
}

/** A request row with what its Tasks produced, each output once. */
export function withRequestOutputs(db: Db, row: EvalsRequestRow, issues: StoredIssueReader): EvalsRequestRow {
  const outputsOf = (taskIds: string[]) => {
    const seen = new Map<string, EvalContext["outputs"][number]>();
    for (const id of taskIds) for (const o of evalOutputs(db, { id, workspaceId: row.workspaceId }, issues)) seen.set(`${o.kind}:${o.repo}#${o.number}`, o);
    return [...seen.values()];
  };
  return { ...row, outputs: outputsOf(row.taskIds), pbis: row.pbis.map((p) => ({ ...p, outputs: outputsOf(p.taskIds) })) };
}
