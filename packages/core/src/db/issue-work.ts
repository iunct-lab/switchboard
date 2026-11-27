/** What the Tasks did for Issues: the Tasks of an Issue, the Issues and pull requests a Task opened, what a report put off. */

import { Database } from "bun:sqlite";
import type { AgentEvent, CreatedIssue } from "@switchboard/protocol";
import { taskDurationSql } from "./tasks.ts";
import { EvalQueries } from "./evals.ts";

/**
 * The Switchboard Tasks of these workspaces that worked on these Issues: a stage Task of the Issue (`stage_issue`) or a Task whose
 * title starts `#N `. Issue numbers repeat across repositories, so the workspaces (of the repository read) say whose they are.
 * Reads only, so the caller may open the file read-only. `durationMs` is the same creation → last non-`status` event as routingLog's.
 */
/** The document kinds an Issue artifact can be: by the copy's file name. */
const ISSUE_ARTIFACT_FILE = /\.(md|markdown|html?)$/i;
/**
 * The artifacts of the Tasks that worked on these Issues (`tasksOfIssues`) that can be attached to an Issue: links, and
 * single Markdown / HTML files — not removed ones, folders, images or any other kind. Oldest first.
 */
export function artifactsOfIssues(sqlite: Database, issues: number[], workspaceIds: string[]): Array<{ id: string; taskId: string; title: string; kind: "file" | "url"; source: string; entry: string | null }> {
  const tasks = tasksOfIssues(sqlite, issues, workspaceIds).map((t) => t.id);
  if (tasks.length === 0) return [];
  const rows = sqlite
    .query(`SELECT id, task_id AS taskId, title, kind, source, entry FROM artifacts WHERE removed_at IS NULL AND kind IN ('file', 'url') AND task_id IN (${tasks.map(() => "?").join(",")}) ORDER BY created_at, id`)
    .all(...tasks) as Array<{ id: string; taskId: string; title: string; kind: "file" | "url"; source: string; entry: string | null }>;
  return rows.filter((a) => a.kind === "url" || ISSUE_ARTIFACT_FILE.test(a.entry ?? ""));
}

export function tasksOfIssues(sqlite: Database, issues: number[], workspaceIds: string[]): Array<{ id: string; createdAt: number; durationMs: number; costUsd: number; stageIssue: number | null; stageAction: string | null; processId: string | null }> {
  if (issues.length === 0 || workspaceIds.length === 0) return [];
  const marks = issues.map(() => "?").join(",");
  const titles = issues.map(() => "t.title LIKE ?").join(" OR ");
  return sqlite
    .query(
      `SELECT t.id AS id, t.created_at AS createdAt, t.stage_issue AS stageIssue, t.stage_action AS stageAction, json_extract(t.provenance, '$.process.id') AS processId,
              ${taskDurationSql("t.id")} AS durationMs,
              COALESCE((SELECT SUM(cost_usd) FROM ledger l WHERE l.task_id = t.id), 0) AS costUsd
       FROM tasks t WHERE t.workspace_id IN (${workspaceIds.map(() => "?").join(",")}) AND (t.stage_issue IN (${marks}) OR ${titles}) ORDER BY t.created_at`,
    )
    .all(...workspaceIds, ...issues, ...issues.map((n) => `#${n} %`)) as Array<{ id: string; createdAt: number; durationMs: number; costUsd: number; stageIssue: number | null; stageAction: string | null; processId: string | null }>;
}

/**
 * The bundle Tasks (`p3-bundle` in the provenance) of these workspaces: the Issues they were started with (the provenance's `issues`),
 * the same run time and cost as `tasksOfIssues`, and the pull requests each opened (`createdPullsOf`). A bundle Task is the one
 * a title or a stage does not tie to a PBI, so this is read once for all the PBIs and not per PBI. A Task whose provenance has no `issues` is left out.
 */
export function bundleTasks(sqlite: Database, workspaceIds: string[]): Array<{ id: string; createdAt: number; durationMs: number; costUsd: number; issues: number[]; prs: CreatedIssue[] }> {
  if (workspaceIds.length === 0) return [];
  const rows = sqlite
    .query(
      `SELECT t.id AS id, t.created_at AS createdAt, json_extract(t.provenance, '$.issues') AS issues,
              ${taskDurationSql("t.id")} AS durationMs,
              COALESCE((SELECT SUM(cost_usd) FROM ledger l WHERE l.task_id = t.id), 0) AS costUsd
       FROM tasks t WHERE t.workspace_id IN (${workspaceIds.map(() => "?").join(",")}) AND json_extract(t.provenance, '$.process.id') = 'p3-bundle' AND json_type(t.provenance, '$.issues') = 'array' ORDER BY t.created_at`,
    )
    .all(...workspaceIds) as Array<{ id: string; createdAt: number; durationMs: number; costUsd: number; issues: string }>;
  return rows.map((r) => ({ ...r, issues: JSON.parse(r.issues) as number[], prs: createdPullsOf(sqlite, r.id) }));
}

/** The words of a final report that put something off: matched as words, so a "スコープ外は無し" counts too. */
export const DEFERRED_WORDS = /残した|見送り|後回し|スコープ外|別 ?Issue/;

/** Every GitHub Issue URL in this text, once each, in the order they appear. */
export function issuesInText(text: string): CreatedIssue[] {
  const seen = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?!\d)/g)) {
    const issue = { repo: m[1]!.toLowerCase(), number: Number(m[2]) };
    const key = `${issue.repo}#${issue.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/** Every GitHub pull request URL in this text, once each, in the order they appear (`issuesInText`'s twin). */
export function pullsInText(text: string): CreatedIssue[] {
  const seen = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?!\d)/g)) {
    const pull = { repo: m[1]!.toLowerCase(), number: Number(m[2]) };
    const key = `${pull.repo}#${pull.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pull);
  }
  return out;
}

/**
 * The pull requests a Task opened, once each, in order, from the successful `tool.result` of each `tool.call`: every pull
 * URL where the input runs `gh pr create`; where it runs `gh stack submit` (this repository's way to open a PR), only the
 * ones its `✓ Created PR #N (<url>)` lines name — the same output also lists the stack's PRs that already existed
 * (`PR #N (<url>) for <branch> is up to date`), which that Task did not open. Counted from the events on every read (no column), like createdIssuesOf.
 */
export function createdPullsOf(sqlite: Database, taskId: string): CreatedIssue[] {
  const prefix = '{"t":"tool.';
  const rows = sqlite.query("SELECT json FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq").all(taskId, prefix, prefix) as Array<{ json: string }>;
  const opening = new Set<string>();
  const submitting = new Set<string>();
  const out: CreatedIssue[] = [];
  for (const r of rows) {
    const ev = JSON.parse(r.json) as AgentEvent;
    if (ev.t === "tool.call") {
      const input = JSON.stringify(ev.input ?? null);
      if (/gh pr create/.test(input)) opening.add(ev.id);
      else if (/gh stack submit/.test(input)) submitting.add(ev.id);
    }
    if (ev.t !== "tool.result" || !ev.ok) continue;
    if (opening.has(ev.id)) out.push(...pullsInText(ev.summary));
    else if (submitting.has(ev.id)) out.push(...[...ev.summary.matchAll(/Created PR #\d+ \((https:\/\/github\.com\/[^\s)]+)\)/g)].flatMap((m) => pullsInText(m[1]!)));
  }
  return out.filter((x, i) => out.findIndex((y) => y.repo === x.repo && y.number === x.number) === i);
}

/**
 * The Issues a Task opened, in the order it opened them, once each: the Issue URLs in the successful `tool.result` of
 * each `tool.call` whose input runs `gh issue create` or `request_issue.sh` — one check of the input's JSON, whichever the
 * runner — and the `localId` the app's backlog create prints (`ops-kit backlog create`, and `request_issue.sh` in the app's
 * Task, whatever script ran it; only a create stored while that call ran, so a log of another Task's create shown again is not read), read back to its repository and number through the stored create and its record; one not
 * sent yet is left out until it has a number. Counted from the events on every read (no column); nothing is asked of GitHub.
 * Reads only, like tasksOfIssues.
 */
export function createdIssuesOf(sqlite: Database, taskId: string): CreatedIssue[] {
  // the prefix compare of listStopRecords: `t` is always written first
  const prefix = '{"t":"tool.';
  const rows = sqlite.query("SELECT ts, json FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq").all(taskId, prefix, prefix) as Array<{ ts: number; json: string }>;
  const stored = sqlite.query(
    `SELECT o.repository AS repo, COALESCE(json_extract(r.remote, '$.number'), json_extract(r.local, '$.number')) AS number FROM backlog_operations o
     JOIN backlog_records r ON r.service = o.service AND r.host = o.host AND r.repository = o.repository AND r.object_kind = 'issue' AND r.external_id IN (o.remote_id, 'local:' || o.id)
     WHERE o.id = ? AND o.kind = 'create' AND o.created_at BETWEEN ? AND ?`,
  );
  const opening = new Set<string>();
  const calledAt = new Map<string, number>();
  const out: CreatedIssue[] = [];
  for (const r of rows) {
    const ev = JSON.parse(r.json) as AgentEvent;
    if (ev.t === "tool.call") calledAt.set(ev.id, r.ts);
    if (ev.t === "tool.call" && /gh issue create|request_issue\.sh/.test(JSON.stringify(ev.input ?? null))) opening.add(ev.id);
    if (ev.t !== "tool.result" || !ev.ok) continue;
    if (opening.has(ev.id)) out.push(...issuesInText(ev.summary));
    for (const m of ev.summary.matchAll(/^(?:#\d+ を作りました（localId ([0-9a-f-]{36})）|作りました（送信待ち）: localId ([0-9a-f-]{36})。)/gm)) {
      const hit = stored.get((m[1] ?? m[2])!, calledAt.get(ev.id) ?? r.ts, r.ts) as { repo: string; number: number | null } | null;
      if (hit?.number) out.push({ repo: hit.repo.toLowerCase(), number: hit.number });
    }
  }
  return out.filter((x, i) => out.findIndex((y) => y.repo === x.repo && y.number === x.number) === i);
}

/** Whether a Task's final report put something off: its last `session.end`'s summary has one of DEFERRED_WORDS. */
export function deferredOf(sqlite: Database, taskId: string): boolean {
  const prefix = '{"t":"session.end",';
  const r = sqlite.query("SELECT json_extract(json, '$.summary') AS text FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq DESC LIMIT 1").get(taskId, prefix, prefix) as { text: string | null } | null;
  return DEFERRED_WORDS.test(r?.text ?? "");
}

/**
 * The Tasks of these workspaces whose last `session.end` is at `since` or later and whose final report put something off
 * (deferredOf), with when that turn ended and the Issues they opened (createdIssuesOf). Reads only, like tasksOfIssues.
 */
export function deferredTasksSince(sqlite: Database, workspaceIds: string[], since: number): Array<{ id: string; endedAt: number; issues: CreatedIssue[] }> {
  if (workspaceIds.length === 0) return [];
  const prefix = '{"t":"session.end",';
  const rows = sqlite
    .query(
      `SELECT t.id AS id, MAX(e.ts) AS endedAt FROM tasks t JOIN events e ON e.task_id = t.id AND substr(e.json, 1, length(?)) = ?
       WHERE t.workspace_id IN (${workspaceIds.map(() => "?").join(",")}) GROUP BY t.id HAVING MAX(e.ts) >= ? ORDER BY endedAt`,
    )
    .all(prefix, prefix, ...workspaceIds, since) as Array<{ id: string; endedAt: number }>;
  return rows.filter((r) => deferredOf(sqlite, r.id)).map((r) => ({ ...r, issues: createdIssuesOf(sqlite, r.id) }));
}

/**
 * The Tasks a schedule started whose last `session.end` is at `since` or later, in any workspace (a schedule for "all workspaces" opens
 * Issues in the others), oldest Task first, with the schedule's name (its title less a trailing `（…）`) and the Issues they opened (createdIssuesOf). Reads only.
 */
export function scheduledIssuesSince(sqlite: Database, since: number): Array<{ schedule: string; issues: CreatedIssue[] }> {
  const prefix = '{"t":"session.end",';
  const rows = sqlite
    .query(
      `SELECT t.id AS id, s.title AS title FROM tasks t JOIN schedules s ON s.id = t.schedule_id JOIN events e ON e.task_id = t.id AND substr(e.json, 1, length(?)) = ?
       GROUP BY t.id HAVING MAX(e.ts) >= ? ORDER BY t.created_at, t.id`,
    )
    .all(prefix, prefix, since) as Array<{ id: string; title: string }>;
  return rows.map((r) => ({ schedule: r.title.replace(/[（(][^（(）)]*[）)]$/, "").trim(), issues: createdIssuesOf(sqlite, r.id) })).filter((r) => r.issues.length > 0);
}

/** What the Tasks did for Issues: the Tasks of an Issue, the Issues and pull requests a Task opened, what a report put off. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class IssueWorkQueries extends EvalQueries {
  /** The pull requests / Issues a task opened (`createdPullsOf` / `createdIssuesOf`), as methods so evals.ts, which db.ts imports, takes them from the Db it is given. */
  createdPullsOf(taskId: string): CreatedIssue[] {
    return createdPullsOf(this.sqlite, taskId);
  }

  createdIssuesOf(taskId: string): CreatedIssue[] {
    return createdIssuesOf(this.sqlite, taskId);
  }
}
