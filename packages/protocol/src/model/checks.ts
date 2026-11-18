import { z } from "zod";

/** Self-dev: results of the repository's checks after a task on the meta workspace. */
export const CheckResult = z.object({
  kind: z.enum(["typecheck", "test"]),
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  summary: z.string(),
  output: z.string(),
  durationMs: z.number(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const CheckRun = z.object({ taskId: z.string(), ok: z.boolean(), results: z.array(CheckResult), ts: z.number() });
export type CheckRun = z.infer<typeof CheckRun>;
