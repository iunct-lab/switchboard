import { z } from "zod";

/** The CLIs the daemon brings in new versions of on the host. */
export const CliUpdateRunner = z.enum(["claude", "codex"]);
export type CliUpdateRunner = z.infer<typeof CliUpdateRunner>;

/** What one decision of the update was: put in, kept out with a reason, held for the Tasks or for the wait, kept from being tried, or put back. */
export const CliUpdateOutcome = z.enum(["installed", "refused", "waiting", "untested", "rolled-back"]);
export type CliUpdateOutcome = z.infer<typeof CliUpdateOutcome>;

/** One row of the record of the host CLIs' versions (`cli_updates`). Times are epoch ms; `by`: `auto` = the daemon decided, `person` = a person asked. */
export const CliUpdateRow = z.object({
  id: z.number(),
  runner: CliUpdateRunner,
  at: z.number(),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  outcome: CliUpdateOutcome,
  sha256: z.string().nullable(),
  reason: z.string(),
  by: z.enum(["auto", "person"]),
});
export type CliUpdateRow = z.infer<typeof CliUpdateRow>;

/** Where one runner's CLI stands. `current` null = the link is not one the installer put (nothing says what runs), and nothing is done to it. */
export const CliUpdateRunnerState = z.object({
  runner: CliUpdateRunner,
  current: z.string().nullable(),
  /** The version a rollback goes to; null = none recorded. */
  previous: z.string().nullable(),
  /** `previous` is recorded but its files are not on disk (a rebuilt host lost them), so the button cannot go back. */
  previousGone: z.boolean(),
  /** A version found and held back, and why (the wait in hours, the Tasks that run). */
  waiting: z.object({ version: z.string(), reason: z.string() }).nullable(),
  /** A rollback was asked for and waits for the Tasks to end. */
  rollbackWaiting: z.boolean(),
  /** When the distributor was last read for this runner. */
  checkedAt: z.number().nullable(),
  /** Why nothing is done, when nothing is (the link is not ours). */
  note: z.string().nullable(),
});
export type CliUpdateRunnerState = z.infer<typeof CliUpdateRunnerState>;

/** `GET /api/runners/updates`: the state of each runner and the record, the newest first (at most 50). `enabled` false = this daemon does not run the update (a candidate, a work machine). */
export const CliUpdateState = z.object({
  enabled: z.boolean(),
  runners: z.array(CliUpdateRunnerState),
  records: z.array(CliUpdateRow),
});
export type CliUpdateState = z.infer<typeof CliUpdateState>;

/** `POST /api/runners/:id/rollback`: `waiting` = a Task runs, so the rollback is done when none does. */
export const CliRollbackResult = z.object({
  ok: z.boolean(),
  waiting: z.boolean(),
  /** Done (`waiting: false`): the version the link points at now. Waiting: the version it would go to as things stand; a version already being moved in can change that, and the rollback then goes to the one before that version. */
  to: z.string().nullable(),
  reason: z.string(),
});
export type CliRollbackResult = z.infer<typeof CliRollbackResult>;
