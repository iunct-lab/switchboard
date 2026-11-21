// test-reads: packages/core/src/db.ts packages/core/src/db/
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import baseline from "./schema-baseline.json";
import beforeSplit from "./schema-before-split.json";

/**
 * Migrations are additive (docs/design/releases-and-rescue.md): a rollback puts an older daemon on the newer
 * database without restoring it, so a table or column that a released version reads must never go away or change name.
 * schema-baseline.json is append-only — a line is added with the column, and never removed or edited.
 */
function actualSchema(): Record<string, string[]> {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-schema-"));
  try {
    new Db(join(dir, "switchboard.db")).close();
    const raw = new Database(join(dir, "switchboard.db"), { readonly: true });
    const tables = (raw.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as Array<{ name: string }>).map((t) => t.name);
    const schema = Object.fromEntries(tables.map((t) => [t, (raw.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name)]));
    raw.close();
    return schema;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("no table or column of the baseline has been dropped or renamed", () => {
  const actual = actualSchema();
  const missing = Object.entries(baseline as Record<string, string[]>).flatMap(([table, columns]) => (actual[table] ? columns.filter((c) => !actual[table]!.includes(c)).map((c) => `${table}.${c}`) : [`${table} (table)`]));
  expect(missing, "dropped or renamed — an older release would fail on this database after a rollback; add a new column instead").toEqual([]);
});

test("every table and column is in the baseline (add new ones to schema-baseline.json; never remove a line)", () => {
  const known = baseline as Record<string, string[]>;
  const unknown = Object.entries(actualSchema()).flatMap(([table, columns]) => (known[table] ? columns.filter((c) => !known[table]!.includes(c)).map((c) => `${table}.${c}`) : [`${table} (table)`]));
  expect(unknown, "new in the schema but not in schema-baseline.json — add them, so a later drop is caught").toEqual([]);
});

test("db.ts contains no statement that removes or renames a table or column", () => {
  // db.ts and the files it is written across (db/: the schema, the migrations, the queries)
  const files = ["db.ts", ...(readdirSync(join(import.meta.dir, "db"), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => join("db", f))];
  expect(files).toContain("db/schema.ts");
  expect(files.filter((f) => f.startsWith("db/migrations/")).length).toBeGreaterThan(1);
  const source = files.map((f) => readFileSync(join(import.meta.dir, f), "utf8")).join("\n");
  // Any RENAME at all: SQLite also accepts `ALTER TABLE t RENAME old TO new` without the COLUMN keyword.
  const destructive = (sql: string) => [...sql.matchAll(/\b(DROP\s+(TABLE|COLUMN)|ALTER\s+TABLE\s+\w+\s+DROP|RENAME)\b[^"'`\n]*/gi)].map((m) => m[0]);
  for (const sql of ["ALTER TABLE tasks RENAME resume_at TO resumed_at", "ALTER TABLE t RENAME COLUMN a TO b", "ALTER TABLE t RENAME TO u", "ALTER TABLE t DROP c", "DROP TABLE t"]) expect(destructive(sql).length, sql).toBe(1);
  expect(destructive('db.exec("DROP INDEX IF EXISTS tasks_shadow_of"); ALTER TABLE tasks ADD COLUMN routing TEXT')).toEqual([]);
  expect(destructive(source)).toEqual([]); // DROP INDEX is fine: an index is not something an older release reads by name
  // a setting is data an older release reads too: a migration that stops using one leaves the row where it is
  const settingGone = (sql: string) => [...sql.matchAll(/\bDELETE\s+FROM\s+settings\b[^"'`\n]*/gi)].map((m) => m[0]);
  expect(settingGone(`db.exec("DELETE FROM settings WHERE key = 'x'")`).length).toBe(1);
  expect(files.filter((f) => f.startsWith("db/migrations/")).flatMap((f) => settingGone(readFileSync(join(import.meta.dir, f), "utf8")).map((m) => `${f}: ${m}`))).toEqual([]);
});

/** Tables (with their columns), indexes (name and the statement that made it) and `user_version` of a database file. */
function shapeOf(path: string): { tables: Record<string, string[]>; indexes: Array<{ name: string; sql: string | null }>; userVersion: number } {
  const raw = new Database(path, { readonly: true });
  try {
    const names = (type: string) => (raw.query("select name from sqlite_master where type = ? and name not like 'sqlite_%' order by name").all(type) as Array<{ name: string }>).map((r) => r.name);
    const tables = Object.fromEntries(names("table").map((t) => [t, (raw.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name).sort()]));
    const indexes = raw.query("select name, sql from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name").all() as Array<{ name: string; sql: string | null }>;
    return { tables, indexes, userVersion: (raw.query("PRAGMA user_version").get() as { user_version: number }).user_version };
  } finally {
    raw.close();
  }
}

test("a database made before db.ts was cut into files opens to the schema and user_version of a new one", () => {
  // schema-before-split.json: the statements and user_version of a database the last version with one db.ts created
  const dir = mkdtempSync(join(tmpdir(), "switchboard-schema-split-"));
  try {
    const old = new Database(join(dir, "old.db"), { create: true });
    for (const sql of beforeSplit.statements) old.exec(sql);
    old.exec(`PRAGMA user_version = ${beforeSplit.userVersion}`);
    // one row each in the tables the migrations after that version rewrite or fill, with the columns the old database had.
    // Run on a database at this version (the order is db/migrate.ts): outcome-done-renamed-finished moves `done` to `finished`
    // in tasks.outcome and tasks.judged_result; ui-layers-schedule-prompt turns a schedule of action `ui-layers` into a prompt one
    // with its prompt filled in. (outcome-kept-by-status leaves a done Task's outcome; ledger-billing and ledger-reported-total
    // add columns this database already has, so they do nothing to the ledger row.)
    old.exec("INSERT INTO tasks (id, title, runner, cwd, scope, status, outcome, judged_result, status_at, created_at, updated_at) VALUES ('t1', 'old task', 'claude', '/x', '[]', 'done', 'done', 'done', 5, 4, 6)");
    old.exec("INSERT INTO ledger (task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, billed_usd, source, ts, billing) VALUES ('t1', 'claude', 'm', 10, 20, 30, 40, 1.5, 1.5, 'reported', 7, 'api')");
    old.exec("INSERT INTO schedules (id, title, cron, workspace_id, runner, prompt, enabled, action, created_at) VALUES ('s1', 'monthly', '0 9 1 * *', 'ws_x', 'claude', '', 1, 'ui-layers', 8)");
    old.close();
    const before = shapeOf(join(dir, "old.db"));
    new Db(join(dir, "old.db")).close();
    new Db(join(dir, "new.db")).close();
    const opened = shapeOf(join(dir, "old.db"));
    expect(opened).toEqual(shapeOf(join(dir, "new.db")));
    // nothing that was there went away, and the version did not go back
    for (const [table, columns] of Object.entries(before.tables)) expect(opened.tables[table], table).toEqual(expect.arrayContaining(columns));
    expect(opened.indexes).toEqual(expect.arrayContaining(before.indexes));
    expect(opened.userVersion).toBeGreaterThanOrEqual(before.userVersion);
    // the rows are all still there; what a migration rewrites has its new value and the rest is as it was put in
    const raw = new Database(join(dir, "old.db"), { readonly: true });
    try {
      expect(raw.query("SELECT id, title, runner, cwd, scope, status, outcome, judged_result, status_at, created_at, updated_at FROM tasks").all()).toEqual([
        { id: "t1", title: "old task", runner: "claude", cwd: "/x", scope: "[]", status: "done", outcome: "finished", judged_result: "finished", status_at: 5, created_at: 4, updated_at: 6 },
      ]);
      expect(raw.query("SELECT task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, billed_usd, source, billing, ts FROM ledger").all()).toEqual([
        { task_id: "t1", runner: "claude", model: "m", input_tokens: 10, output_tokens: 20, cache_read: 30, cache_write: 40, cost_usd: 1.5, billed_usd: 1.5, source: "reported", billing: "api", ts: 7 },
      ]);
      const schedule = raw.query("SELECT id, title, cron, workspace_id, runner, enabled, action, prompt, created_at FROM schedules").all() as Array<{ action: string; prompt: string }>;
      expect(schedule).toHaveLength(1);
      expect(schedule[0]).toMatchObject({ id: "s1", title: "monthly", cron: "0 9 1 * *", workspace_id: "ws_x", runner: "claude", enabled: 1, action: "prompt", created_at: 8 });
      expect(schedule[0]!.prompt).toContain("docs/design/ui-layers.md");
    } finally {
      raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy_timeout is 5000", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-busy-"));
  try {
    const db = new Db(join(dir, "switchboard.db"));
    expect(db.sqlite.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Litestream's checkpoint holds the write lock for a moment; without busy_timeout the daemon's INSERT threw SQLITE_BUSY and the daemon exited.
test("waits for another process's write lock instead of failing with SQLITE_BUSY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-busy-"));
  const path = join(dir, "switchboard.db");
  try {
    const db = new Db(path);
    const holder = Bun.spawn(
      ["bun", "-e", `const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]); d.exec("BEGIN IMMEDIATE"); d.query("INSERT INTO events (task_id, seq, ts, json) VALUES ('other', 1, 0, '{}')").run(); console.log("held"); await Bun.sleep(300); d.exec("COMMIT"); d.close();`, path],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    let out = "";
    while (!out.includes("held")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the lock holder exited before holding the lock: ${out}`);
      out += new TextDecoder().decode(value);
    }
    const start = performance.now();
    const env = db.appendEvent("t1", { t: "session.end", status: "ok" });
    const waited = performance.now() - start;
    expect(await holder.exited).toBe(0);
    expect(db.sqlite.query("SELECT seq FROM events WHERE task_id = 't1'").all()).toEqual([{ seq: env.seq }]);
    expect(waited).toBeGreaterThanOrEqual(200);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration moves a done task with a background mark to background once", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-bgstatus-"));
  try {
    const path = join(dir, "switchboard.db");
    const first = new Db(path);
    const ins = first.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, background, status_at, created_at, updated_at) VALUES (?, 't', 'claude', '/x', '[]', ?, ?, 1, 1, 1)");
    ins.run("bg", "done", '{"jobs":["a"],"since":1}');
    ins.run("plain", "done", null);
    ins.run("run", "running", '{"jobs":["a"],"since":1}');
    first.sqlite.exec("PRAGMA user_version = 2");
    first.close();
    const second = new Db(path);
    const status = (id: string) => (second.sqlite.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
    expect([status("bg"), status("plain"), status("run")]).toEqual(["background", "done", "running"]);
    expect((second.sqlite.query("SELECT count(*) AS c FROM tasks").get() as { c: number }).c).toBe(3);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration renames the outcome, judged result and rules row outcome done to finished once", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-finished-"));
  try {
    const path = join(dir, "switchboard.db");
    const first = new Db(path);
    const ins = first.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, outcome, judged_result, status_at, created_at, updated_at) VALUES (?, 't', 'claude', '/x', '[]', 'done', ?, ?, 1, 1, 1)");
    ins.run("judged", "done", "done");
    ins.run("asked", "needs_action", "needs_action");
    ins.run("unjudged", "unknown", null);
    const ev = first.sqlite.query("INSERT INTO task_evals (task_id, source, by, rubric, json, ts) VALUES (?, ?, 'x', NULL, ?, 1)");
    ev.run("judged", "rules", JSON.stringify({ status: "done", outcome: "done", costUsd: 0 }));
    ev.run("asked", "rules", JSON.stringify({ status: "done", outcome: "needs_action", costUsd: 0 }));
    ev.run("judged", "judge", JSON.stringify({ outcome: "done" }));
    first.close();
    const read = () => {
      const db = new Db(path);
      try {
        return {
          tasks: db.sqlite.query("SELECT id, status, outcome, judged_result AS judged FROM tasks ORDER BY id").all(),
          evals: db.sqlite.query("SELECT task_id AS id, source, json_extract(json, '$.outcome') AS outcome FROM task_evals ORDER BY task_id, source").all(),
        };
      } finally {
        db.close();
      }
    };
    const rows = [
      { id: "asked", status: "done", outcome: "needs_action", judged: "needs_action" },
      { id: "judged", status: "done", outcome: "finished", judged: "finished" },
      { id: "unjudged", status: "done", outcome: "unknown", judged: null },
    ];
    // only the rules row carries the task's outcome; another source's JSON is not touched
    const evals = [
      { id: "asked", source: "rules", outcome: "needs_action" },
      { id: "judged", source: "judge", outcome: "done" },
      { id: "judged", source: "rules", outcome: "finished" },
    ];
    expect(read()).toEqual({ tasks: rows, evals });
    expect(read()).toEqual({ tasks: rows, evals });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration: stored outcome keeps only what the status does not decide, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-stored-outcome-"));
  try {
    const path = join(dir, "switchboard.db");
    const first = new Db(path);
    const ins = first.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, outcome, status_at, created_at, updated_at) VALUES (?, 't', 'claude', '/x', '[]', ?, ?, 1, 1, 1)");
    ins.run("failed_error", "error", "failed");
    ins.run("failed_done", "done", "failed");
    ins.run("waiting_asked", "waiting", "needs_action");
    ins.run("aborted_finished", "aborted", "finished");
    ins.run("done_asked", "done", "needs_action");
    ins.run("done_finished", "done", "finished");
    ins.run("bg_asked", "background", "needs_action");
    first.close();
    const read = () => {
      const db = new Db(path);
      try {
        return {
          stored: db.sqlite.query("SELECT id, outcome FROM tasks ORDER BY id").all(),
          shown: db.listTasks().map((t) => [t.id, t.outcome]).sort(),
        };
      } finally {
        db.close();
      }
    };
    const stored = [
      { id: "aborted_finished", outcome: "unknown" },
      { id: "bg_asked", outcome: "needs_action" },
      { id: "done_asked", outcome: "needs_action" },
      { id: "done_finished", outcome: "finished" },
      { id: "failed_done", outcome: "unknown" },
      { id: "failed_error", outcome: "unknown" },
      { id: "waiting_asked", outcome: "unknown" },
    ];
    const shown = [["aborted_finished", "failed"], ["bg_asked", "needs_action"], ["done_asked", "needs_action"], ["done_finished", "finished"], ["failed_done", "unknown"], ["failed_error", "failed"], ["waiting_asked", "needs_action"]];
    expect(read()).toEqual({ stored, shown });
    expect(read()).toEqual({ stored, shown });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
