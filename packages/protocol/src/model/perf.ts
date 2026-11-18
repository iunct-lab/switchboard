import { z } from "zod";

/**
 * The user journeys the Web UI times: each starts with the person's action and ends once the result is drawn.
 * `launch` = page load → the list and the composer usable; `new-task` = send on Home → the first event drawn;
 * `open-task` = a task picked in the rail → its transcript's last row drawn; `send` = send in a task → the reply's end drawn.
 */
export const Journey = z.enum(["launch", "new-task", "open-task", "send"]);
export type Journey = z.infer<typeof Journey>;

/**
 * One finished journey as the Web UI timed it in everyday use: `build` = the hash in the loaded JS file's name
 * (`dev` under the dev server), `device` = `mobile` below 700 px wide. Kept only in this daemon's database, 30 days.
 */
export const PerfSample = z.object({
  journey: Journey,
  device: z.enum(["desktop", "mobile"]),
  build: z.string().min(1).max(64),
  ms: z.number().nonnegative().max(600_000),
  /** The Task's size, for `open-task` / `send` only (null otherwise). bytes = that Task's `GET /api/tasks/:id` response (decoded). */
  taskId: z.string().min(1).max(64).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  events: z.number().int().nonnegative().nullable(),
});
export type PerfSample = z.infer<typeof PerfSample>;
/** `POST /api/perf`: what the Web UI sends at once. */
export const PerfSamplesInput = z.array(PerfSample).min(1).max(50);

/** A Task's size by its event count: small up to 1,000, medium up to 5,000, large above. */
export const SizeClass = z.enum(["small", "medium", "large"]);
export type SizeClass = z.infer<typeof SizeClass>;
export const PerfPeriodStats = z.object({ count: z.number(), p50: z.number(), p90: z.number() });
/**
 * `GET /api/perf/summary`: per journey × device × size (null: no event count, as `launch`), the last 7
 * days (`current`) against the 7 days before them (`previous`); a period without samples is null.
 */
export const PerfSummaryRow = z.object({ journey: Journey, device: PerfSample.shape.device, size: SizeClass.nullable(), current: PerfPeriodStats.nullable(), previous: PerfPeriodStats.nullable() });
export type PerfSummaryRow = z.infer<typeof PerfSummaryRow>;
