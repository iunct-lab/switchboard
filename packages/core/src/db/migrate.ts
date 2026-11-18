import type { Database } from "bun:sqlite";
import type { Columns } from "./migration.ts";
import { MIGRATIONS } from "./migrations/index.ts";

/**
 * The columns of a table as the migrations of one run see them: read once per table and kept, so a migration sees a
 * table as it was when a migration first asked about it in this run, not what an earlier migration of the run has added
 * since (each one keeps the set right itself where a later one depends on it). The tests run the migrations with this too.
 */
export function columnsOf(db: Database): Columns {
  const read = new Map<string, Set<string>>();
  return (table) => {
    let cols = read.get(table);
    if (!cols) {
      cols = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      read.set(table, cols);
    }
    return cols;
  };
}

/** Additive schema changes for databases created by earlier versions. Each step is idempotent. */
export function migrate(db: Database) {
  const columns = columnsOf(db);
  for (const m of MIGRATIONS) m.run(db, columns);
}
