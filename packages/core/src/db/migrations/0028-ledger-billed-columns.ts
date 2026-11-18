import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const lcols = columns("ledger");
  if (!lcols.has("billed_usd")) db.exec("ALTER TABLE ledger ADD COLUMN billed_usd REAL NOT NULL DEFAULT 0");
  if (!lcols.has("cache_write_1h")) db.exec("ALTER TABLE ledger ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0");
}

export const migration: Migration = { number: 28, name: "ledger-billed-columns", run };
