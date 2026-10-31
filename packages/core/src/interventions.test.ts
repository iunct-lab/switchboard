import { recordingText, skipRecordings } from "../../../scripts/recordings.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, BacklogIssueData, BacklogPullRequestData, BacklogSource, Intervention, InterventionView, InterventionWindow, StopRecord, Task } from "@switchboard/protocol";
import { createClaudeParser } from "@switchboard/adapter-claude";
import { Db, type BacklogSnapshotEntry } from "./db.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import { collectInterventions, interventionView, summarizeInterventions, type InterventionLookup } from "./interventions.ts";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard.interventions."));
  db = new Db(join(dir, "switchboard.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
const MIN = 60_000;
const T0 = Date.parse("2026-10-10T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const issue = (n: number, labels: string[], over: Partial<BacklogIssueData> = {}): BacklogSnapshotEntry => ({
  objectKind: "issue", externalId: `I_${n}`, fetchState: "fetched",
  remote: { number: n, title: `#${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: iso(T0 - 1000 * MIN), updatedAt: iso(T0), closedAt: null, ...over },
});
const pull = (n: number, over: Partial<BacklogPullRequestData> = {}): BacklogSnapshotEntry => ({
  objectKind: "pull-request", externalId: `PR_${n}`, fetchState: "fetched",
  remote: { number: n, state: "OPEN", isDraft: false, labels: [], closes: [], mergeCommit: null, updatedAt: iso(T0), files: [], closedAt: null, mergedAt: null, ...over },
});
const comment = (n: number, id: string, body: string, at: number): BacklogSnapshotEntry => ({ objectKind: "comment", externalId: id, remote: { issue: n, body, createdAt: iso(at) }, fetchState: "fetched" });

/** A workspace whose last import stored `records`; no records = a source that was never imported. */
function workspace(records: BacklogSnapshotEntry[] | null, name = "app", repository = "acme/app") {
  const ws = db.upsertWorkspace({ name, path: join(dir, name), kind: "repo" });
  const source = { ...SOURCE, repository };
  if (records) db.putBacklogSnapshot(source, { records, cursor: null, syncedAt: T0 });
  db.setWorkspaceBacklogSource(ws.id, source);
  return ws;
}

let n = 0;
function task(workspaceId: string, over: { title?: string; stage?: number; scheduleId?: string; createdAt?: number } = {}): string {
  const id = `t${++n}`;
  db.insertTask({
    id, workspaceId, title: over.title ?? "work", runner: "claude", cwd: "/x", scope: { read: [], write: [] }, status: "done", runnerSessionId: null, model: null, routing: null, budgetUsd: null, scheduleId: over.scheduleId ?? null,
    permissionMode: "default", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null,
    judgedResult: null, judgedReason: null, judgedBy: null, statusAt: over.createdAt ?? T0, createdAt: over.createdAt ?? T0, updatedAt: over.createdAt ?? T0, executionMode: "local", cloudSession: null, sourceCloudTaskId: null,
    stage: over.stage ? { issue: over.stage, action: "implement" } : null, judgingAt: null,
  } as unknown as Task);
  return id;
}
const say = (id: string, text: string, ts: number) => db.appendEventAt(id, { t: "message.delta", role: "user", text } as AgentEvent, ts);
const resolved = (id: string, ask: string, by: string, ts: number) => db.appendEventAt(id, { t: "permission.resolved", id: ask, decision: "allow", by } as AgentEvent, ts);
const kinds = (r: ReturnType<typeof collectInterventions>) => r.items.map((i) => `${i.kind}:${i.issue}:${i.pbi}`);

describe("collect", () => {
  test("counts approvals, decisions and resumes by kind; not automatic, rule, timeout or the first prompt", () => {
    const ws = workspace([issue(3, ["type:pbi"], { subIssues: [30] }), issue(30, ["type:task"], { parent: 3 }), comment(3, "C_1", "## 回答\n\nこれで", T0 + 5 * MIN), comment(3, "C_2", "着手", T0 + 6 * MIN)]);
    const stage = task(ws.id, { stage: 3, createdAt: T0 }); // started by the button: a resume
    task(ws.id, { stage: 3, scheduleId: "sch", createdAt: T0 + 30 * MIN }); // started by backlog-next: not one
    const t = task(ws.id, { title: "#30 実装", createdAt: T0 + MIN });
    say(t, "最初の依頼", T0 + MIN); // the request
    resolved(t, "a1", "user", T0 + 2 * MIN);
    resolved(t, "a2", "rule", T0 + 3 * MIN);
    resolved(t, "a3", "timeout", T0 + 4 * MIN);
    say(t, "こうしてください", T0 + 10 * MIN); // a decision
    say(t, `${AUTO_RESUME_HEAD} 続けて`, T0 + 20 * MIN); // the daemon's
    say(stage, "最初", T0);
    const r = collectInterventions(db, db.listWorkspaces());
    expect(r.unknown).toEqual([]);
    expect(kinds(r)).toEqual(["resume:3:3", "approval:30:3", "decision:3:3", "decision:30:3"]);
    expect(r.items.map((i) => i.ref)).toEqual([`task:${stage}`, `task:${t}#seq:2`, "comment:C_1", `task:${t}#seq:5`]);
    expect(r.items.find((i) => i.kind === "resume")).toMatchObject({ taskId: stage, afterWaits: false });
  });

  test("a message of several chunks is one", () => {
    const ws = workspace([issue(3, ["type:pbi"])]);
    const t = task(ws.id, { title: "#3 x" });
    say(t, "request", T0);
    db.appendEventAt(t, { t: "status", text: "x" } as AgentEvent, T0 + 1);
    say(t, "one ", T0 + MIN);
    say(t, "message", T0 + MIN);
    expect(collectInterventions(db, db.listWorkspaces()).items.filter((i) => i.kind === "decision")).toHaveLength(1);
  });
});

describe("classifier", () => {
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/classifier-stop.jsonl"))("classifier (recorded on 2.1.312): a stop nobody was asked about is no intervention", () => {
    const ws = workspace([issue(3, ["type:pbi"])]);
    const t = task(ws.id, { title: "#3 x" });
    const p = createClaudeParser();
    const events = recordingText("packages/adapters/claude/fixtures/classifier-stop.jsonl").split("\n").flatMap((l) => p.feed(l));
    expect(events).toContainEqual({ t: "status", text: "permission denied by runner: Bash" });
    expect(events.filter((e) => e.t === "permission.ask")).toEqual([]);
    for (const ev of events) db.appendEventAt(t, ev, T0);
    expect(collectInterventions(db, db.listWorkspaces()).items).toEqual([]);
  });

  test("classifier: an approval of a classifier-reasoned ask is its own kind, not counted twice", () => {
    const ws = workspace([issue(3, ["type:pbi"])]);
    const t = task(ws.id, { title: "#3 x" });
    const ask = (id: string, reason?: "classifier") => db.appendEventAt(t, { t: "permission.ask", id, kind: "exec", tool: "Bash", input: {}, detail: "x", ...(reason ? { reason } : {}) } as AgentEvent, T0);
    ask("c1", "classifier");
    ask("c2", "classifier");
    ask("p1");
    resolved(t, "c1", "user", T0 + MIN); // allowed after the classifier stopped it
    resolved(t, "c1", "user", T0 + MIN + 1); // the same answer twice is one
    db.appendEventAt(t, { t: "permission.resolved", id: "c2", decision: "deny", by: "user" } as AgentEvent, T0 + 2 * MIN); // denied: still an approval
    resolved(t, "p1", "user", T0 + 3 * MIN); // a plain ask
    const other = task(ws.id, { title: "#3 y" });
    resolved(other, "c1", "user", T0 + 4 * MIN); // the same ask id on another task was not stopped by the classifier
    const r = collectInterventions(db, db.listWorkspaces());
    expect(r.items.map((i) => `${i.kind}:${i.taskId}`)).toEqual([`classifier:${t}`, `approval:${t}`, `approval:${t}`, `approval:${other}`]);
    const w = sevenDays(summarizeInterventions(r.items, r.unknown, [], r.lookup, T0 + DAY)).current;
    expect(w.byKind).toEqual({ approval: 3, decision: 0, resume: 0, classifier: 1 });
    expect(w.total).toBe(4);
  });
});

describe("double submit", () => {
  test("the same answer, message, start or approval twice is one", () => {
    const ws = workspace([issue(3, ["type:pbi"]), comment(3, "C_1", "## 回答\n\nA", T0), comment(3, "C_2", "## 回答\n\nA", T0 + 9 * MIN), comment(3, "C_3", "## 回答\n\nA", T0 + 20 * MIN), comment(3, "C_4", "## 回答\n\nB", T0 + 21 * MIN)]);
    task(ws.id, { stage: 3, createdAt: T0 });
    task(ws.id, { stage: 3, createdAt: T0 + 59_000 });
    task(ws.id, { stage: 3, createdAt: T0 + 5 * MIN });
    const t = task(ws.id, { title: "#3 x" });
    const between = (ts: number) => db.appendEventAt(t, { t: "status", text: "working" } as AgentEvent, ts);
    say(t, "request", T0);
    between(T0 + 1);
    say(t, "again", T0 + MIN);
    between(T0 + MIN + 1);
    say(t, "again", T0 + MIN + 30_000);
    between(T0 + MIN + 31_000);
    say(t, "again", T0 + 3 * MIN);
    resolved(t, "a1", "user", T0 + MIN);
    resolved(t, "a1", "user", T0 + MIN + 1);
    const r = collectInterventions(db, db.listWorkspaces());
    expect(r.items.filter((i) => i.kind === "decision" && i.ref.startsWith("comment:")).map((i) => i.ref)).toEqual(["comment:C_1", "comment:C_3", "comment:C_4"]); // C_2 is 9 minutes after C_1
    expect(r.items.filter((i) => i.kind === "resume")).toHaveLength(2); // T0 and T0+5min; T0+59s is the same start
    expect(r.items.filter((i) => i.kind === "decision" && i.taskId === t)).toHaveLength(2); // +1m (the +1m30s copy dropped) and +3m
    expect(r.items.filter((i) => i.kind === "approval")).toHaveLength(1);
  });
});

describe("double submit, further", () => {
  test("A, B, A is two sends of A when the second is within the window; the daemon's op marker does not make a copy another answer", () => {
    const op = (id: string) => `\n\n<!-- switchboard-op:${id} -->`;
    const ws = workspace([issue(3, ["type:pbi"]), comment(3, "C_1", `## 回答\n\nA${op("11111111-1111-1111-1111-111111111111")}`, T0), comment(3, "C_2", "## 回答\n\nB", T0 + MIN), comment(3, "C_3", `## 回答\n\nA${op("22222222-2222-2222-2222-222222222222")}`, T0 + 2 * MIN)]);
    const t = task(ws.id, { title: "#3 x" });
    const between = (ts: number) => db.appendEventAt(t, { t: "status", text: "working" } as AgentEvent, ts);
    say(t, "request", T0);
    for (const [text, at] of [["A", T0 + MIN], ["B", T0 + MIN + 10_000], ["A", T0 + MIN + 20_000]] as const) {
      between(at - 1);
      say(t, text, at);
    }
    const r = collectInterventions(db, db.listWorkspaces());
    expect(r.items.filter((i) => i.ref.startsWith("comment:")).map((i) => i.ref)).toEqual(["comment:C_1", "comment:C_2"]);
    expect(r.items.filter((i) => i.taskId === t)).toHaveLength(2);
  });
});

describe("unknown", () => {
  test("a Task whose PBI is not stored in full cannot be placed; a workspace with no source is unknown too", () => {
    const stored = workspace([issue(30, ["type:task"], { parent: 3 })]); // #3 itself is not stored
    const bare = db.upsertWorkspace({ name: "bare", path: join(dir, "bare"), kind: "repo" }); // no source at all
    const t = task(stored.id, { title: "#30 x" });
    resolved(t, "a", "user", T0);
    const r = collectInterventions(db, db.listWorkspaces());
    expect(r.items).toEqual([]);
    expect(r.unknown).toEqual([
      { workspaceId: bare.id, issue: null, why: "まだ GitHub から取り込んでいません" },
      { workspaceId: stored.id, issue: 30, why: "親の #3 が写しに無い", pbi: 3 },
    ]);
  });

  test("a workspace never imported and an Issue not stored are unknown, not 0", () => {
    const stored = workspace([issue(3, ["type:pbi"])]);
    const fresh = workspace(null, "fresh", "acme/fresh");
    const a = task(stored.id, { title: "#99 x" }); // #99 is not in the copy
    say(a, "request", T0);
    resolved(a, "p", "user", T0 + MIN);
    const b = task(fresh.id, { stage: 7 }); // names an Issue of a workspace that was never imported
    const c = task(stored.id, { title: "no issue at all" });
    resolved(c, "q", "user", T0 + MIN);
    const r = collectInterventions(db, db.listWorkspaces());
    expect(r.unknown).toEqual([
      { workspaceId: fresh.id, issue: null, why: "まだ GitHub から取り込んでいません" },
      { workspaceId: stored.id, issue: 99, why: "取り込んだ写しに無い Issue" },
      { workspaceId: fresh.id, issue: 7, why: "まだ GitHub から取り込んでいません" },
    ]); // in the order they were met
    expect(r.items.map((i) => i.taskId)).toEqual([c]); // one that names no Issue needs no copy: counted
    expect(r.items.map((i) => i.taskId)).not.toContain(b);
  });
});

describe("after waits", () => {
  const release = (waits: string, at: number) => comment(3, `C_${waits}_${at}`, `<!-- pbi-complete:release waits=${waits} -->\n/pbi-complete 終了`, at);
  const resume = (records: BacklogSnapshotEntry[], startAt: number) => {
    const ws = workspace(records);
    task(ws.id, { stage: 3, createdAt: startAt });
    return collectInterventions(db, db.listWorkspaces()).items.find((i) => i.kind === "resume")!.afterWaits;
  };

  test("true when everything waited for closed before the start, false when not, null when not known", () => {
    const base = [issue(3, ["type:pbi"]), release("40,41", T0)];
    const closedBefore = [issue(41, ["type:task"], { state: "CLOSED", closedAt: iso(T0 + 5 * MIN) }), pull(40, { state: "MERGED", mergedAt: iso(T0 + 4 * MIN) })];
    expect(resume([...base, ...closedBefore], T0 + 10 * MIN)).toBe(true);
  });

  test("false: one closed after the start, or still open, or no wait at all", () => {
    expect(resume([issue(3, ["type:pbi"]), release("41", T0), issue(41, ["type:task"], { state: "CLOSED", closedAt: iso(T0 + 20 * MIN) })], T0 + 10 * MIN)).toBe(false);
  });

  test("false: still open", () => {
    expect(resume([issue(3, ["type:pbi"]), release("41", T0), issue(41, ["type:task"])], T0 + 10 * MIN)).toBe(false);
  });

  test("false: nothing was waited for", () => {
    expect(resume([issue(3, ["type:pbi"]), comment(3, "C", "ふつうのコメント", T0)], T0 + 10 * MIN)).toBe(false);
  });

  test("null: the waited-for record is not stored, or closed with no time kept", () => {
    expect(resume([issue(3, ["type:pbi"]), release("99", T0)], T0 + 10 * MIN)).toBeNull();
  });

  test("null: a closed Issue stored before closedAt was kept", () => {
    expect(resume([issue(3, ["type:pbi"]), release("41", T0), issue(41, ["type:task"], { state: "CLOSED", closedAt: null })], T0 + 10 * MIN)).toBeNull();
  });

  test("a `## 回答` after the release clears the wait", () => {
    expect(resume([issue(3, ["type:pbi"]), release("41", T0), comment(3, "ans", "## 回答\n\nok", T0 + MIN), issue(41, ["type:task"])], T0 + 10 * MIN)).toBe(false);
  });
});

// ---- the summary (#1027) ----

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-17T12:00:00Z");
const iv = (kind: Intervention["kind"], at: number, over: Partial<Intervention> = {}): Intervention => ({ kind, at, workspaceId: "w", issue: 30, pbi: 3, taskId: "t", ref: `r${at}`, afterWaits: null, ...over });
const pbiRec = (number: number, over: Partial<InterventionLookup["pbis"][number]> = {}): InterventionLookup["pbis"][number] => ({ repository: "acme/app", number, open: true, closedAt: null, subIssues: [number * 10], workspaceId: "w", ...over });
const lookupOf = (pbis: InterventionLookup["pbis"]): InterventionLookup => ({
  issue: (_w, n) => (n === 30 ? { url: "https://github.com/acme/app/issues/30", pbi: 3 } : null),
  repository: () => "acme/app",
  pbis,
});
const stop = (id: string, at: number, over: Partial<StopRecord> = {}): StopRecord => ({
  id, work: { workspaceId: "w", issue: 30, taskId: "t" }, op: "answer", target: "#30", reason: "decision", evidence: "判断待ち", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at, ...over,
});
const sevenDays = (v: InterventionView) => v.windows.find((w) => w.current.days === 7)!;
const thirtyDays = (v: InterventionView) => v.windows.find((w) => w.current.days === 30)!;
const total = (w: InterventionWindow) => w.total;

describe("window boundaries", () => {
  test("exactly 7 days ago is in this week, 14 days ago is in the one before, older is in neither", () => {
    const items = [iv("approval", NOW - 7 * DAY), iv("approval", NOW - 7 * DAY - 1), iv("approval", NOW - 14 * DAY), iv("approval", NOW - 14 * DAY - 1), iv("decision", NOW - 1), iv("resume", NOW)];
    const w = sevenDays(summarizeInterventions(items, [], [], lookupOf([pbiRec(3)]), NOW));
    expect(total(w.current)).toBe(2); // NOW - 7d, NOW - 1 (NOW itself is not yet)
    expect(total(w.previous)).toBe(2); // NOW - 7d - 1, NOW - 14d
    expect(w.current.byKind).toEqual({ approval: 1, decision: 1, resume: 0, classifier: 0 });
    expect(w.current).toMatchObject({ days: 7, from: NOW - 7 * DAY, to: NOW });
    expect(w.previous).toMatchObject({ from: NOW - 14 * DAY, to: NOW - 7 * DAY });
    const m = thirtyDays(summarizeInterventions(items, [], [], lookupOf([pbiRec(3)]), NOW));
    expect(total(m.current)).toBe(5); // all but the one at NOW
    expect(total(m.previous)).toBe(0);
  });

  test("unknown places and resumes after waits are told, not hidden", () => {
    const items = [iv("resume", NOW - DAY, { afterWaits: true }), iv("resume", NOW - DAY, { afterWaits: null }), iv("resume", NOW - DAY, { afterWaits: false })];
    const w = sevenDays(summarizeInterventions(items, [{ workspaceId: "w", issue: null, why: "x" }], [], lookupOf([pbiRec(3)]), NOW)).current;
    expect(w.resumesAfterWaits).toEqual({ count: 1, unknown: 1 });
    expect(w.unknown).toBe(1);
  });
});

describe("re-asks and reasons", () => {
  test("stopping again after the answer is a re-ask; a similar-looking other reason is its own series", () => {
    const stops = [
      stop("s1", NOW - 6 * DAY, { answer: { ref: "seq:1", at: NOW - 5 * DAY } }), // asked, answered (seen by the daemon)
      stop("s2", NOW - 4 * DAY), // the same series again after the answer: re-ask 1
      stop("s3", NOW - 3 * DAY), // and again: re-ask 2
      stop("s4", NOW - 2 * DAY, { reason: "permission", evidence: "判断待ち と似た文面" }), // another reason: another series, never answered
      stop("s5", NOW - 2 * DAY, { reason: "usage-limit" }), // not a stop that needs a person
    ];
    const w = sevenDays(summarizeInterventions([], [], stops, lookupOf([]), NOW)).current;
    expect(w.reAsks).toBe(2);
    expect(w.reasons.map((r) => [r.reason, r.count])).toEqual([["decision", 3], ["permission", 1], ["usage-limit", 1]]); // most first
    const decision = w.reasons[0]!;
    expect(decision.evidence.map((e) => e.at)).toEqual([NOW - 3 * DAY, NOW - 4 * DAY, NOW - 6 * DAY]); // newest first
    expect(decision.evidence[0]).toMatchObject({ workspaceId: "w", issue: 30, pbi: 3, taskId: "t", url: "https://github.com/acme/app/issues/30" });
  });

  test("an answer a later record carried over belongs to the series it was given to", () => {
    const place = { op: "answer", target: "#30" };
    const stops = [
      stop("auth1", NOW - 6 * DAY, { ...place, reason: "auth", answer: { ref: "seq:1", at: NOW - 5 * DAY } }), // asked and answered
      stop("d1", NOW - 4 * DAY, { ...place, reason: "decision", answer: { ref: "seq:1", at: NOW - 5 * DAY } }), // carries the auth answer over
      stop("d2", NOW - 3 * DAY, { ...place, reason: "decision", answer: { ref: "seq:1", at: NOW - 5 * DAY } }),
    ];
    // the decision series was never answered: its two stops are not re-asks
    expect(sevenDays(summarizeInterventions([], [], stops, lookupOf([]), NOW)).current.reAsks).toBe(0);
  });

  test("an answer the daemon did not see (a runner's pointer to an Issue comment) is not an answer to ask again after", () => {
    const stops = [stop("s1", NOW - 6 * DAY, { answer: { ref: "https://github.com/acme/app/issues/30#issuecomment-1", at: NOW - 5 * DAY } }), stop("s2", NOW - 4 * DAY)];
    expect(sevenDays(summarizeInterventions([], [], stops, lookupOf([]), NOW)).current.reAsks).toBe(0);
  });

  test("a person who comes after a stop already resolved by itself does not make it a stop that needed one", () => {
    const stops = [stop("a", NOW - 3 * DAY, { reason: "transient", state: "resolved" })]; // resolved at its last record, 3 days ago
    const later = [iv("decision", NOW - DAY, { issue: 30, taskId: "t" })]; // an unrelated decision on the same Task and Issue, later
    const during = [iv("decision", NOW - 3 * DAY, { issue: 30, taskId: "t" })]; // at the same moment: it was there
    expect(sevenDays(summarizeInterventions(later, [], stops, lookupOf([]), NOW)).current.reasons[0]!.notAutoResumed).toBe(0);
    expect(sevenDays(summarizeInterventions(during, [], stops, lookupOf([]), NOW)).current.reasons[0]!.notAutoResumed).toBe(1);
  });

  test("a stop that did not go on by itself: left waiting or exhausted, or a person came to its Issue or Task after", () => {
    const stops = [
      stop("a", NOW - 3 * DAY, { reason: "transient", state: "resolved" }), // went on by itself
      stop("b", NOW - 3 * DAY, { reason: "transient", state: "exhausted", work: { workspaceId: "w", issue: null, taskId: "u" } }),
      stop("c", NOW - 3 * DAY, { reason: "github-limit", state: "waiting", work: { workspaceId: "w", issue: null, taskId: "v" } }),
      stop("d", NOW - 3 * DAY, { reason: "depends", state: "resolved", work: { workspaceId: "w", issue: 70, taskId: "x" } }),
    ];
    const items = [iv("resume", NOW - 3 * DAY, { issue: 70, taskId: "y" })]; // a person started #70 while it stood
    const reasons = Object.fromEntries(sevenDays(summarizeInterventions(items, [], stops, lookupOf([]), NOW)).current.reasons.map((r) => [r.reason, r.notAutoResumed]));
    expect(reasons).toEqual({ transient: 1, "github-limit": 1, depends: 1 });
  });
});

describe("completed vs open", () => {
  test("a PBI closed in the window is counted in that window only; open ones are told apart; one not stored is unknown", () => {
    const pbis = [
      pbiRec(3, { open: false, closedAt: NOW - 2 * DAY }), // closed this week
      pbiRec(4, { open: false, closedAt: NOW - 10 * DAY, subIssues: [40] }), // closed the week before
      pbiRec(5, { open: true }), // not done
      pbiRec(6, { open: false, closedAt: null }), // closed, time not kept: cannot be placed
      pbiRec(7, { open: false, closedAt: NOW - DAY, subIssues: [70] }), // closed this week, with something uncounted on it
    ];
    const items = [
      iv("approval", NOW - 20 * DAY, { pbi: 3 }), iv("decision", NOW - 3 * DAY, { pbi: 3 }), iv("resume", NOW - 2 * DAY, { pbi: 3 }), // 3 in all on #3, 2 of them this week
      iv("decision", NOW - 9 * DAY, { pbi: 4 }),
      iv("approval", NOW - DAY, { pbi: 5 }), iv("approval", NOW - 2 * DAY, { pbi: 5 }),
    ];
    const v = summarizeInterventions(items, [{ workspaceId: "w", issue: 70, why: "x" }], [], lookupOf(pbis), NOW);
    const w = sevenDays(v);
    expect(w.current.completed).toEqual({ pbis: 1, perPbi: 3, unknownPbis: 2 }); // #3 (3 in all); #7 has an uncounted place, #6 has no time
    expect(w.previous.completed).toEqual({ pbis: 1, perPbi: 1, unknownPbis: 1 }); // #4; #6 again
    expect(w.current.done).toEqual({ pbis: 1, interventions: 2 }); // this week's on a PBI closed now
    expect(w.current.open).toEqual({ pbis: 1, interventions: 2 });
    expect(thirtyDays(v).current.completed.pbis).toBe(2); // #3 and #4 (#7 is unknown, #6 cannot be placed)
  });

  test("a PBI an uncounted Issue points to but that is not stored is unknown in every window", () => {
    const w = sevenDays(summarizeInterventions([], [{ workspaceId: "w", issue: 30, why: "親の #9 が写しに無い", pbi: 9 }], [], lookupOf([pbiRec(3)]), NOW));
    expect(w.current.completed.unknownPbis).toBe(1);
    expect(w.previous.completed.unknownPbis).toBe(1);
  });

  test("no closed PBI: perPbi is null, never 0", () => {
    const w = sevenDays(summarizeInterventions([iv("approval", NOW - DAY)], [], [], lookupOf([pbiRec(3)]), NOW)).current;
    expect(w.completed).toEqual({ pbis: 0, perPbi: null, unknownPbis: 0 });
    expect(w.open).toEqual({ pbis: 1, interventions: 1 });
  });
});

describe("api interventions", () => {
  test("GET answers both windows from the records, without asking GitHub", async () => {
    const ws = workspace([issue(3, ["type:pbi"], { state: "CLOSED", closedAt: iso(Date.now() - DAY), subIssues: [30] }), issue(30, ["type:task"], { parent: 3 }), comment(3, "C_1", "## 回答\n\nこれで", Date.now() - 2 * DAY)]);
    const t = task(ws.id, { title: "#30 実装", createdAt: Date.now() - 3 * DAY });
    say(t, "request", Date.now() - 3 * DAY);
    resolved(t, "a1", "user", Date.now() - 2 * DAY);
    db.appendEventAt(t, { t: "stop.record", stop: stop("s1", Date.now() - 2 * DAY, { work: { workspaceId: ws.id, issue: 30, taskId: t } }) } as AgentEvent, Date.now() - 2 * DAY);
    db.close();
    const gh = async () => { throw new Error("no GitHub call"); };
    const core = await startServer(loadConfig({ SWITCHBOARD_HOME: dir, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(dir, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
    try {
      const v = (await (await fetch(`http://127.0.0.1:${core.server.port}/api/interventions`)).json()) as InterventionView;
      const w = sevenDays(v).current;
      expect(w.total).toBe(2); // the answer and the approval
      expect(w.byKind).toEqual({ approval: 1, decision: 1, resume: 0, classifier: 0 });
      expect(w.completed).toEqual({ pbis: 1, perPbi: 2, unknownPbis: 0 });
      expect(w.reasons).toEqual([expect.objectContaining({ reason: "decision", count: 1, evidence: [expect.objectContaining({ issue: 30, pbi: 3, url: "https://github.com/acme/app/issues/30" })] })]);
      expect(v.windows).toHaveLength(2);
    } finally {
      await core.stop();
      db = new Db(join(dir, "switchboard.db")); // the next test's afterEach closes it
    }
  });
});
