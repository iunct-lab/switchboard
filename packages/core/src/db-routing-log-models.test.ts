import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";

const cols = (sqlite: Database) => (sqlite.query("SELECT name FROM pragma_table_info('routing_log')").all() as Array<{ name: string }>).map((c) => c.name);

test("routing_log models: a new database has both columns, and a row from before them keeps its values and reads the two models as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-db-routing-models-"));
  try {
    const path = join(dir, "switchboard.db");
    const first = new Db(path);
    expect(cols(first.sqlite)).toEqual(expect.arrayContaining(["suggested_model", "chosen_model"]));
    first.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, created_at, updated_at, status_at) VALUES ('t', 't', 'claude', '/w', '[]', 'done', 1, 1, 1)").run();
    first.close();
    const raw = new Database(path);
    raw.exec("ALTER TABLE routing_log DROP COLUMN suggested_model");
    raw.exec("ALTER TABLE routing_log DROP COLUMN chosen_model");
    raw.exec("INSERT INTO routing_log (task_id, cwd, suggested, rule_id, reason, chosen, ts) VALUES ('t', '/w', 'claude', 'r', 'why', 'claude', 5)");
    raw.close();
    const db = new Db(path);
    expect(cols(db.sqlite)).toEqual(expect.arrayContaining(["suggested_model", "chosen_model"]));
    expect(db.routingLog()).toEqual([expect.objectContaining({ taskId: "t", suggested: "claude", ruleId: "r", suggestedModel: null, chosenModel: null })]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task whose routing was stored before suggestedModel and chosenModel reads both as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-db-routing-models-"));
  try {
    const db = new Db(join(dir, "switchboard.db"));
    db.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, routing, created_at, updated_at, status_at) VALUES ('t', 't', 'claude', '/w', '[]', 'done', ?, 1, 1, 1)")
      .run(JSON.stringify({ suggested: "claude", ruleId: "status-question", reason: "r", overridden: false, llm: null }));
    expect(db.getTask("t")!.routing).toMatchObject({ suggestedModel: null, chosenModel: null });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
