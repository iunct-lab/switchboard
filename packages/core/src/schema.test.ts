import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import baseline from "./schema-baseline.json";

/**
 * Migrations are additive (#178, docs/design/releases-and-rescue.md): a rollback puts an older daemon on the newer
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
  const source = readFileSync(join(import.meta.dir, "db.ts"), "utf8");
  // Any RENAME at all: SQLite also accepts `ALTER TABLE t RENAME old TO new` without the COLUMN keyword.
  const destructive = (sql: string) => [...sql.matchAll(/\b(DROP\s+(TABLE|COLUMN)|ALTER\s+TABLE\s+\w+\s+DROP|RENAME)\b[^"'`\n]*/gi)].map((m) => m[0]);
  for (const sql of ["ALTER TABLE tasks RENAME resume_at TO resumed_at", "ALTER TABLE t RENAME COLUMN a TO b", "ALTER TABLE t RENAME TO u", "ALTER TABLE t DROP c", "DROP TABLE t"]) expect(destructive(sql).length, sql).toBe(1);
  expect(destructive('db.exec("DROP INDEX IF EXISTS tasks_shadow_of"); ALTER TABLE tasks ADD COLUMN routing TEXT')).toEqual([]);
  expect(destructive(source)).toEqual([]); // DROP INDEX is fine: an index is not something an older release reads by name
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

// #688: Litestream's checkpoint holds the write lock for a moment; without busy_timeout the daemon's INSERT threw SQLITE_BUSY and the daemon exited.
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
