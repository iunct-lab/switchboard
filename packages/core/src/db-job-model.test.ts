import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";

test("migration: a job from before model / effort were recorded gains them as null, and a second start changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-db-job-model-"));
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  raw.exec("ALTER TABLE jobs DROP COLUMN model");
  raw.exec("ALTER TABLE jobs DROP COLUMN effort");
  const { id } = raw.query("INSERT INTO jobs (kind, task_id, pr, runner, cwd, status, started_at, ended_at, repo, head, as_reason, kinds) VALUES ('review', 't1', 12, 'codex', '/w', 'pass', 1000, 2000, 'acme/app', 'h', 'recheck', 'size') RETURNING id").get() as { id: number };
  raw.close();

  let db = new Db(path);
  expect(db.getJob(id)).toMatchObject({ kind: "review", runner: "codex", as: "recheck", model: null, effort: null });
  db.setJobModel(id, "m-after");
  db.setJobModel(id, "m-later"); // a model already recorded stays
  db.close();
  db = new Db(path); // again: the columns are there and what was written in them stays
  expect(db.getJob(id)).toMatchObject({ as: "recheck", model: "m-after", effort: null });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
