/**
 * Generated lab data of the size of the real home: `bun scripts/perf-load.ts <home> [--tasks N] [--backlog-records N]
 * [--operations N]` writes it and prints the counts. Nothing is read or copied from a real home: `seedLoad` makes every
 * row through the daemon's own `Db` and import, so the data follows the schema, and `loadGh` is the GitHub the import reads.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AgentEvent, BacklogIssueData, BacklogRepositoryKey, Task } from "@switchboard/protocol";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { importGithubSnapshot } from "../packages/core/src/backlog-sync.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { Db } from "../packages/core/src/db.ts";
import { githubHost } from "../ops-kit/src/gh.ts";
import { checkDaemon, tasksThatStop } from "../rescue/src/promote.ts";

/** The real home on 2026-10-27, rounded up: 1,403 Tasks, 28,224 backlog records, 3,897 operations (the import's writes grow with them). */
export const LOAD = { tasks: 1_500, backlogRecords: 30_000, operations: 4_000 };
export type LoadSize = typeof LOAD;

export const LOAD_REPOSITORY = "acme/app";
const PROJECT_URL = "https://github.com/orgs/acme/projects/1";
/** An Issue is 10 records: itself, its Project item and 8 comments. */
const RECORDS_PER_ISSUE = 10;
const COMMENTS_PER_ISSUE = RECORDS_PER_ISSUE - 2;
/** Sized so the whole database comes to the real 78 MB of 2026-10-27 (about 80 MB with `LOAD`): a body is stored twice, 3 bytes a character. */
const ISSUE_BODY = "## 背景\n\n生成したラボのデータです。".padEnd(480, "。");
const COMMENT_BODY = "生成したコメントです。".padEnd(240, "。");
/** Left `pending`, as a real home has a few edits not sent yet (20 of 3,897 on 2026-10-27). */
const PENDING_OPERATIONS = 10;
const TASK_EVENTS = 20;
export const LONG_EVENTS = 2_000;
const FIRST_UPDATE = Date.parse("2026-10-01T00:00:00Z");

/** The long task's history: tool calls, their results and assistant text, in a fixed order. */
export function longEvents(n = LONG_EVENTS): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (let i = 0; out.length < n; i++) {
    out.push({ t: "tool.call", id: `c${i}`, name: "Read", input: { file_path: `src/file${i}.ts` }, summary: `Read src/file${i}.ts` });
    out.push({ t: "tool.result", id: `c${i}`, ok: true, summary: `${40 + (i % 7)} lines` });
    out.push({ t: "message.delta", role: "assistant", text: `Step ${i}: the file reads as expected. `, messageId: `m${i}` });
    out.push({ t: "message.delta", role: "assistant", text: "Moving on to the next one.\n", messageId: `m${i}` });
  }
  return out.slice(0, n);
}

/** One Issue as the import's query asks for it. Every one has its own updatedAt, so a cursor leaves out what it read. */
function issueNode(n: number, generation: number) {
  const updatedAt = new Date(FIRST_UPDATE + generation * 86_400_000 + n * 1_000).toISOString();
  return {
    id: `I_${n}`, number: n, title: `load ${n}`, url: `https://github.com/${LOAD_REPOSITORY}/issues/${n}`, state: "CLOSED", stateReason: "COMPLETED", body: `${ISSUE_BODY}\n\ngeneration ${generation}`, createdAt: "2026-09-01T00:00:00Z", updatedAt, closedAt: updatedAt, milestone: null, parent: null,
    labels: { totalCount: 1, nodes: [{ name: "type:task" }] }, subIssues: { totalCount: 0, nodes: [] },
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: Array.from({ length: COMMENTS_PER_ISSUE }, (_, c) => ({ id: `C_${n}_${c}`, body: `${COMMENT_BODY}\n\ngeneration ${generation}`, createdAt: "2026-09-02T00:00:00Z" })) },
    projectItems: { totalCount: 1, nodes: [{ id: `PVTI_${n}`, project: { number: 1, owner: { login: "acme" } }, fieldValues: { totalCount: 1, nodes: [{ name: "Done", field: { name: "Status" } }] } }] },
  };
}

/**
 * The GitHub of `seedLoad`'s workspace: `issues` closed Issues in the answers of the import's own queries, and no open
 * Issue or pull request. Raise `opts.generation` and every Issue's updatedAt and text move, so the next import rewrites them all. A
 * call waits a turn of the event loop like a real `gh`: the daemon answers others between the reads. Anything else fails.
 */
export function loadGh(issues: number, opts: { generation: number }): GhRunner {
  const nodes = (generation: number) => Array.from({ length: issues }, (_, i) => issueNode(i + 1, generation));
  let cached: { generation: number; nodes: ReturnType<typeof nodes> } | null = null;
  const of = (generation: number) => (cached?.generation === generation ? cached : (cached = { generation, nodes: nodes(generation) })).nodes;
  const ok = (data: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify({ data })}`, stderr: "" });
  return async (args) => {
    await Bun.sleep(0);
    if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: `${LOAD_REPOSITORY} true\n`, stderr: "" };
    if (args[0] === "variable" && args[1] === "get") return { code: 0, stdout: `${PROJECT_URL}\n`, stderr: "" };
    const query = args.find((a) => a.startsWith("query="))?.slice("query=".length) ?? "";
    const value = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
    if (query.includes("rateLimit")) return ok({ rateLimit: { limit: 5000, remaining: 4000, resetAt: new Date(Date.now() + 30 * 60_000).toISOString() } });
    if (query.includes("ProjectV2FieldCommon{ name dataType }")) return ok({ repositoryOwner: { projectV2: { id: "PVT_load" } } });
    if (query.includes("pullRequests(")) return ok({ repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    if (query.includes("states:OPEN")) return ok({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    if (query.includes("states:[OPEN,CLOSED]")) {
      const size = Number(/first:(\d+)/.exec(query)![1]);
      const since = value("since");
      const listed = since ? of(opts.generation).filter((n) => n.updatedAt >= since) : of(opts.generation);
      const from = Number(value("after") ?? 0);
      const more = from + size < listed.length;
      return ok({ repository: { issues: { pageInfo: { hasNextPage: more, endCursor: more ? String(from + size) : null }, nodes: listed.slice(from, from + size) } } });
    }
    return { code: 1, stdout: "", stderr: `no such call in the lab's GitHub: ${args.slice(0, 2).join(" ")}` };
  };
}

/**
 * Runs `act` with the load of a real day on the daemon: one backlog import rewriting every record, the rescue page's
 * status check every 2 s, /api/health every 50 ms. Returns what `act` did and the longest /api/health took, over the
 * window until both `act` and the import ended. The daemon runs in this process, so a stall holds this loop's timer too:
 * the time counts from when the call was due, or a daemon stuck for seconds would read as a fast answer after it.
 * An import that fails fails the run: the numbers would not be of an overlap. No client timeout (Bun's is 5 minutes): a very
 * slow daemon must end as a number over its ceiling.
 */
export async function overlap(d: { base: string; port: number; home: string; github: { generation: number }; workspaceId: string }, act: () => Promise<void>): Promise<number> {
  let healthMaxMs = 0;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  let over = false;
  const health = (async () => {
    while (!over) {
      const due = Date.now() + 50;
      await Bun.sleep(50);
      await fetch(`${d.base}/api/health`, { timeout: false });
      healthMaxMs = Math.max(healthMaxMs, Date.now() - due);
    }
  })();
  const rescue = (async () => {
    while (!over) {
      await Promise.all([checkDaemon(d.port, d.home), tasksThatStop(d.port, d.home)]);
      await Promise.race([Bun.sleep(2_000), finished]);
    }
  })();
  try {
    d.github.generation++;
    const sync = fetch(`${d.base}/api/backlog/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: d.workspaceId }), timeout: false });
    sync.catch(() => undefined); // a failed `act` is the error to report, not an answer nobody waits for
    await act();
    const answer = await sync;
    if (!answer.ok) throw new Error(`the import failed: ${answer.status} ${await answer.text()}`);
  } finally {
    over = true;
    finish();
    await Promise.all([health, rescue]);
  }
  return healthMaxMs;
}

function loadTask(i: number, title: string, cwd: string, workspaceId: string, at: number): Task {
  return { id: `task_load${i}`, workspaceId, title, stage: null, runner: "claude", cwd, scope: [cwd], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Task;
}

/**
 * Fills the home's database, and leaves a git checkout under it as the one workspace: the backlog by a real import, the
 * edits on its Issues (done, but for a few), then the Tasks. The long task comes last, so the list shows it first.
 */
export async function seedLoad(home: string, n: LoadSize = LOAD): Promise<{ workspaceId: string; taskIds: string[] }> {
  if (n.backlogRecords % RECORDS_PER_ISSUE) throw new Error(`backlog records come in tens (an Issue is ${RECORDS_PER_ISSUE}): ${n.backlogRecords}`);
  mkdirSync(home, { recursive: true });
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history") });
  const path = join(home, "work");
  mkdirSync(path);
  for (const args of [["init", "-q"], ["remote", "add", "origin", `https://github.com/${LOAD_REPOSITORY}`]]) {
    const git = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (git.status !== 0) throw new Error(`git ${args[0]}: ${git.stderr}`);
  }
  const db = new Db(cfg.dbPath);
  try {
    const ws = db.upsertWorkspace({ name: "load", path, kind: "repo" });
    const issues = n.backlogRecords / RECORDS_PER_ISSUE;
    await importGithubSnapshot(loadGh(issues, { generation: 0 }), db, ws);
    const repo: BacklogRepositoryKey = { service: "github", host: githubHost(), repository: LOAD_REPOSITORY };
    // the kept ones each on an Issue of their own: a `set` on a pending one of the same field would merge into it
    const kept = Math.min(PENDING_OPERATIONS, issues);
    for (let i = 0; i < n.operations; i++) {
      const issue = `I_${(i % issues) + 1}`;
      const remote = db.getBacklogRecord({ ...repo, objectKind: "issue", externalId: issue })!.remote as BacklogIssueData;
      const [id] = db.applyBacklogEdit(repo, { records: [], operations: [{ issue, targetKind: "issue", target: issue, kind: "set", field: "body", payload: `${ISSUE_BODY}\n\nedit ${i}`, base: remote.body }] });
      // done as a send leaves it, the record showing nothing on top; its value stays what `loadGh` answers, so stored and GitHub agree
      if (i < n.operations - kept) db.setBacklogOperationResult(id!, { status: "done", record: { externalId: issue, remote } });
    }
    const start = Date.now() - n.tasks * 60_000;
    const taskIds: string[] = [];
    for (let i = 0; i < n.tasks; i++) {
      const long = i === n.tasks - 1;
      const task = db.insertTask(loadTask(i, long ? "long" : `load ${i}`, path, ws.id, start + i * 60_000));
      taskIds.push(task.id);
      db.sqlite.transaction(() => {
        if (long) for (const ev of longEvents()) db.appendEvent(task.id, ev);
        else for (let e = 0; e < TASK_EVENTS; e++) db.appendEvent(task.id, { t: "message.delta", role: "assistant", text: `word${e} `, messageId: "reply" });
      })();
    }
    return { workspaceId: ws.id, taskIds };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tasks: { type: "string" }, "backlog-records": { type: "string" }, operations: { type: "string" } } });
  const home = positionals[0];
  if (!home) throw new Error("usage: bun scripts/perf-load.ts <home> [--tasks N] [--backlog-records N] [--operations N]");
  const size = (flag: string | undefined, standard: number) => {
    const n = flag === undefined ? standard : Number(flag);
    if (!Number.isInteger(n) || n < 1) throw new Error(`a count must be a positive integer: ${flag}`);
    return n;
  };
  await seedLoad(home, { tasks: size(values.tasks, LOAD.tasks), backlogRecords: size(values["backlog-records"], LOAD.backlogRecords), operations: size(values.operations, LOAD.operations) });
  const db = new Db(join(home, "switchboard.db"));
  console.log("| table | rows |\n|---|---:|");
  for (const table of ["tasks", "backlog_records", "backlog_operations"]) console.log(`| ${table} | ${(db.sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n} |`);
  db.close();
}
