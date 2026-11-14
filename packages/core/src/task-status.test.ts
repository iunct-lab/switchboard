// test-reads: docs/design/task-work-phase.md
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isWorkingStatus, type Task, type TaskStatus } from "@switchboard/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, abortOrphanedTasks } from "./db.ts";
import { readFileSync } from "node:fs";
import { canTransition, COUNTS, InvalidTaskTransitionError, isWorking, outcomeOnStatus, workingSql, type WorkPhase, type WorkPurpose } from "./task-status.ts";

const ALL: TaskStatus[] = ["idle", "running", "waiting", "background", "done", "error", "aborted"];
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  idle: ["running", "error", "aborted"],
  running: ["waiting", "background", "done", "error", "aborted", "idle"],
  waiting: ["running", "background", "done", "error", "aborted", "idle"],
  background: ["running", "done", "error", "aborted"],
  done: ["running", "background", "error", "idle"],
  error: ["running", "idle"],
  aborted: ["running", "error", "idle"],
};

describe("task status transitions", () => {
  let home: string;
  let db: Db;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "switchboard-task-status-"));
    db = new Db(join(home, "switchboard.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const mk = (id: string, status: TaskStatus, extra: Partial<Task> = {}) => {
    const now = Date.now();
    db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: home, scope: [home], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now, ...extra });
  };

  test("canTransition matches the table for every pair of statuses", () => {
    for (const from of ALL) for (const to of ALL) expect(canTransition(from, to)).toBe(from === to || ALLOWED[from].includes(to));
  });

  test("updateTask throws on a move the table lacks and leaves the row as it was", () => {
    for (const [id, from, to] of [["a", "done", "waiting"], ["b", "error", "aborted"], ["c", "idle", "done"]] as const) {
      mk(id, from, { updatedAt: 1 });
      expect(() => db.updateTask(id, { status: to })).toThrow(InvalidTaskTransitionError);
      expect(db.getTask(id)).toMatchObject({ status: from, outcome: "unknown", updatedAt: 1 });
    }
  });

  test("a status change sets the outcome by rule; a Cloud Task stays unknown", () => {
    const judged = { reviewedAt: 5, archivedAt: null, judgedResult: "done", judgedReason: "r", judgedBy: "codex:m" } as const;
    mk("l", "running");
    expect(db.updateTask("l", { status: "waiting" })?.outcome).toBe("needs_action");
    db.updateTask("l", judged);
    expect(db.updateTask("l", { status: "running" })).toMatchObject({ outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null });
    expect(db.updateTask("l", { status: "error" })?.outcome).toBe("failed");
    mk("d", "running");
    db.updateTask("d", { outcome: "done" });
    expect(db.updateTask("d", { status: "done" })?.outcome).toBe("done");
    mk("c0", "idle", { executionMode: "cloud", outcome: "needs_action", ...judged });
    expect(db.updateTask("c0", { status: "running" })).toMatchObject({ outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null });
    mk("c1", "running", { executionMode: "cloud" });
    expect(db.updateTask("c1", { status: "idle" })?.outcome).toBe("unknown");
    mk("c2", "running", { executionMode: "cloud" });
    expect(db.updateTask("c2", { status: "error" })?.outcome).toBe("unknown");
    expect(outcomeOnStatus("aborted", "local")).toEqual({ outcome: "failed" });
    expect(outcomeOnStatus("waiting", "cloud")).toEqual({ outcome: "unknown" });
  });

  test("orphan recovery: local running → aborted / failed, cloud with a session → idle / unknown, without → error / unknown", () => {
    mk("loc", "running");
    mk("cs", "running", { executionMode: "cloud", cloudSession: { id: "session_s1", url: "https://claude.ai/code/session_s1" }, outcome: "needs_action" });
    mk("cn", "waiting", { executionMode: "cloud", outcome: "needs_action" });
    expect(abortOrphanedTasks(db).sort()).toEqual(["cn", "cs", "loc"]);
    expect(db.getTask("loc")).toMatchObject({ status: "aborted", outcome: "failed" });
    expect(db.getTask("cs")).toMatchObject({ status: "idle", outcome: "unknown" });
    expect(db.getTask("cn")).toMatchObject({ status: "error", outcome: "unknown" });
  });

  test("isWorkingStatus in protocol equals COUNTS.display for every status (the web uses it)", () => {
    for (const st of ALL) expect(isWorkingStatus(st), st).toBe(isWorking({ status: st, resumeAt: null }, "display"));
  });

  test("workingSql selects the same rows as isWorking for every purpose, status and resumeAt", () => {
    const rows: Array<[string, TaskStatus, number | null]> = [];
    for (const st of ALL) for (const r of [null, 1]) { const id = `${st}-${r}`; mk(id, st, { resumeAt: r }); rows.push([id, st, r]); }
    for (const purpose of Object.keys(COUNTS) as WorkPurpose[]) {
      const sql = (db.sqlite.query(`SELECT id FROM tasks WHERE ${workingSql(purpose)}`).all() as Array<{ id: string }>).map((r) => r.id).sort();
      const aliased = (db.sqlite.query(`SELECT x.id FROM tasks x WHERE ${workingSql(purpose, "x")}`).all() as Array<{ id: string }>).map((r) => r.id).sort();
      const fn = rows.filter(([, status, resumeAt]) => isWorking({ status, resumeAt }, purpose)).map(([id]) => id).sort();
      expect(sql, purpose).toEqual(fn);
      expect(aliased, purpose).toEqual(fn);
    }
  });
});

describe("work phase table", () => {
  test("COUNTS matches the table in docs/design/task-work-phase.md", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../docs/design/task-work-phase.md"), "utf8").split("\n");
    const head = doc.findIndex((l) => /^\| Phase \| dedupe /.test(l));
    expect(head).toBeGreaterThan(-1);
    const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim().replaceAll("`", ""));
    const purposes = cells(doc[head]!).slice(1) as WorkPurpose[];
    const rows = doc.slice(head + 2).filter((l) => l.startsWith("|")).map(cells);
    expect(rows.map((r) => r[0]).sort()).toEqual(["approval", "background", "resume", "stopped", "turn"]);
    for (const purpose of Object.keys(COUNTS) as WorkPurpose[]) {
      const col = purposes.indexOf(purpose) + 1;
      expect(col, purpose).toBeGreaterThan(0);
      const documented = rows.filter((r) => r[col] === "yes").map((r) => r[0] as WorkPhase).sort();
      expect(documented, purpose).toEqual([...COUNTS[purpose]].sort());
    }
  });
});

describe("no side-by-side status comparison", () => {
  // The forms of "is this Task working?" written out by hand. A new one goes through isWorking / isWorkingStatus / IN_FLIGHT / workPhase instead.
  const FORMS = String.raw`status === "running" \|\||IN \('running'|"running", ?"waiting"`;
  // One entry per place that may keep a form: file, the one line that must contain `has` (a second such line fails), and why.
  const ALLOWED: Array<{ file: string; has: string; why: string }> = [
    { file: "packages/core/src/task-status.ts", has: "IN_FLIGHT", why: "the definition of IN_FLIGHT" },
    { file: "packages/protocol/src/model.ts", has: "TaskStatus = z.enum", why: "the list of statuses" },
    { file: "packages/protocol/src/model.ts", has: "return status === \"running\" || status === \"waiting\" || status === \"background\";", why: "isWorkingStatus, the web's copy of COUNTS.display (a test keeps them equal)" },
    { file: "packages/core/src/db.ts", has: "NOT IN ('running', 'waiting', 'idle')", why: "a migration is frozen at the statuses of its day" },
    { file: "rescue/src/promote.ts", has: "t.status === \"running\" ||", why: "sb-rescue shares no code with the app; it reads the status strings of /api/health" },
    { file: "packages/core/src/jobs.ts", has: "job.status === \"running\" ||", why: "a job's status (running / pass / fail / aborted), not a Task's" },
  ];

  test("no file outside tests and the allow list compares statuses side by side", () => {
    const r = Bun.spawnSync(["git", "grep", "-nE", FORMS, "--", "*.ts", "*.tsx", ":!*.test.ts", ":!*.test.tsx"], { cwd: join(import.meta.dir, "../../..") });
    const hits = r.stdout.toString().split("\n").filter(Boolean);
    const stray = hits.filter((h) => {
      const [file, , ...rest] = h.split(":");
      const line = rest.join(":");
      return !ALLOWED.some((a) => a.file === file && line.includes(a.has));
    });
    expect(stray).toEqual([]);
  });

  test("every allow-list entry matches exactly one line", () => {
    const r = Bun.spawnSync(["git", "grep", "-nE", FORMS, "--", "*.ts", "*.tsx", ":!*.test.ts", ":!*.test.tsx"], { cwd: join(import.meta.dir, "../../..") });
    const hits = r.stdout.toString().split("\n").filter(Boolean);
    // a copy of an allowed line (another helper written the same way) counts twice, and a removed one zero times
    for (const a of ALLOWED) expect(hits.filter((h) => h.startsWith(`${a.file}:`) && h.includes(a.has)).length, a.file + " " + a.why).toBe(1);
  });
});
