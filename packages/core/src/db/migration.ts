import type { Database } from "bun:sqlite";

/**
 * A table's column names as they were when a `migrate` run first asked for them: read once per run and table, so a
 * step that adds a column does not change what a later step of the same run sees.
 */
export type Columns = (table: string) => Set<string>;

/**
 * One step of `migrate` (db/migrate.ts), in a file of its own: `db/migrations/<number, 4 digits>-<name>.ts`.
 * `number` is the step's place in the order and is never used twice. `version` is set on a step that runs once and
 * marks it in the file's `user_version`: `run` does nothing at that version or above and leaves the file at it, and no
 * two steps share one. A step without it tells by the shape or the rows it finds whether there is anything left to do.
 * Every step is idempotent.
 */
export interface Migration {
  number: number;
  name: string;
  version?: number;
  run(db: Database, columns: Columns): void;
}
