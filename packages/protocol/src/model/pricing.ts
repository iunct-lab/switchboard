import { z } from "zod";

/** A dated price change: valid from 00:00 UTC of `from`; a field left out keeps the row's value. */
export const PriceChange = z.object({
  // a real calendar day: Date.parse rolls 2027-02-30 over to March and gives NaN for month 13, so round-trip it
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const t = Date.parse(`${s}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
    }, "not a calendar date"),
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
});
export const ModelPrice = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().default(0),
  cacheWrite: z.number().nonnegative().default(0),
  /** The 1-hour cache write (Claude: 2x input); absent = cacheWrite. */
  cacheWrite1h: z.number().nonnegative().optional(),
  /** Scheduled price changes; a table without them prices every time the same. */
  changes: z.array(PriceChange).optional(),
});
/** A price row entered on the settings screen: no dated changes, the row is the price from now on. */
export const SettingsPrice = ModelPrice.omit({ changes: true });
export type SettingsPrice = z.infer<typeof SettingsPrice>;

export const PricingTable = z.object({
  version: z.literal(1),
  /** api = pay-as-you-go (実課金 = API 換算) · subscription = covered by a plan (実課金 0) */
  billing: z.record(z.string(), z.enum(["api", "subscription"])).default({}),
  /** USD per 1M tokens */
  models: z.record(z.string(), ModelPrice).default({}),
  /** model or runner name → model name in `models` */
  aliases: z.record(z.string(), z.string()).default({}),
});
export type PricingTable = z.infer<typeof PricingTable>;
