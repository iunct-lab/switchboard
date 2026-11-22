import { z } from "zod";

/** The `settings` key the hold is kept under (cleared by writing null: what reads it takes null as no hold). */
export const BUNDLE_HOLD_KEY = "bundle.hold";

/**
 * The hold a bundle of work puts on the running daemon (`settings` key `bundle.hold`): the recurring schedules it
 * stopped (`schedules`, by id, to be turned back on by name and nothing else) and the version that ran when it began
 * (`base`, null when none was managed). While it exists no promotion is asked for from anywhere.
 */
export const BundleHold = z.object({
  taskId: z.string(),
  since: z.number(),
  schedules: z.array(z.string()),
  base: z.string().nullable(),
});
export type BundleHold = z.infer<typeof BundleHold>;

/** What starts a bundle: the PBIs to put in together, at least two, each once. */
export const BundleInput = z.object({
  pbis: z.array(z.number().int().positive()).min(2).refine((a) => new Set(a).size === a.length, "pbis に同じ番号が 2 回ある"),
});
export type BundleInput = z.infer<typeof BundleInput>;
