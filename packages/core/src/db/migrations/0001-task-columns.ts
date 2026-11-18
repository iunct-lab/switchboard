import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  if (!cols.has("execution_mode")) db.exec("ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'local'");
  if (!cols.has("cloud_session")) db.exec("ALTER TABLE tasks ADD COLUMN cloud_session TEXT");
  if (!cols.has("source_cloud_task_id")) db.exec("ALTER TABLE tasks ADD COLUMN source_cloud_task_id TEXT");
  if (!cols.has("routing")) db.exec("ALTER TABLE tasks ADD COLUMN routing TEXT");
  if (!cols.has("budget_usd")) db.exec("ALTER TABLE tasks ADD COLUMN budget_usd REAL");
  if (!cols.has("schedule_id")) db.exec("ALTER TABLE tasks ADD COLUMN schedule_id TEXT");
  if (!cols.has("permission_mode")) db.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT");
  if (!cols.has("effort")) db.exec("ALTER TABLE tasks ADD COLUMN effort TEXT");
  if (!cols.has("subagent_effort")) db.exec("ALTER TABLE tasks ADD COLUMN subagent_effort TEXT");
  if (!cols.has("subagent_model")) db.exec("ALTER TABLE tasks ADD COLUMN subagent_model TEXT");
  if (!cols.has("origin")) db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'switchboard'");
  if (!cols.has("resume_at")) db.exec("ALTER TABLE tasks ADD COLUMN resume_at INTEGER");
  if (!cols.has("resume_reason")) db.exec("ALTER TABLE tasks ADD COLUMN resume_reason TEXT");
  if (!cols.has("resume_window")) db.exec("ALTER TABLE tasks ADD COLUMN resume_window TEXT");
  if (!cols.has("resume_since")) db.exec("ALTER TABLE tasks ADD COLUMN resume_since INTEGER");
  if (!cols.has("resume_planned_at")) db.exec("ALTER TABLE tasks ADD COLUMN resume_planned_at INTEGER");
  if (!cols.has("queued_at")) db.exec("ALTER TABLE tasks ADD COLUMN queued_at INTEGER");
  if (!cols.has("queued_prompt")) db.exec("ALTER TABLE tasks ADD COLUMN queued_prompt TEXT");
  if (!cols.has("deferred_prompt")) db.exec("ALTER TABLE tasks ADD COLUMN deferred_prompt TEXT");
  if (!cols.has("background")) db.exec("ALTER TABLE tasks ADD COLUMN background TEXT");
  if (!cols.has("waits")) db.exec("ALTER TABLE tasks ADD COLUMN waits TEXT");
  if (!cols.has("shadow_of")) db.exec("ALTER TABLE tasks ADD COLUMN shadow_of TEXT");
  if (!cols.has("fork_of")) db.exec("ALTER TABLE tasks ADD COLUMN fork_of TEXT");
  if (!cols.has("fork_seq")) db.exec("ALTER TABLE tasks ADD COLUMN fork_seq INTEGER");
  if (!cols.has("fork_turn")) db.exec("ALTER TABLE tasks ADD COLUMN fork_turn TEXT");
}

export const migration: Migration = { number: 1, name: "task-columns", run };
