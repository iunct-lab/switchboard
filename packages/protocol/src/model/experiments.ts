import { z } from "zod";

/* ---------- Experiments: a question, two branches and a metric registered before the work, and whether the decision changed after ---------- */

/** The branch as compared: whitespace folded and case ignored, so "Both A" and " both  a " are one branch. */
export const foldBranch = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** What is registered before an experiment runs. Two branches that fold to the same text are not an experiment. */
export const ExperimentInput = z
  .object({
    question: z.string().trim().min(1),
    branchA: z.string().trim().min(1),
    branchB: z.string().trim().min(1),
    metric: z.string().trim().min(1),
    /** How many days the experiment is watched. */
    windowDays: z.number().int().positive(),
  })
  .refine((v) => foldBranch(v.branchA) !== foldBranch(v.branchB), { message: "branchA and branchB are the same", path: ["branchB"] });
export type ExperimentInput = z.infer<typeof ExperimentInput>;

/** What is recorded after: whether the experiment changed the decision. Once per experiment. */
export const ExperimentOutcomeInput = z.object({
  changed: z.boolean(),
  note: z.string().optional(),
});
export type ExperimentOutcomeInput = z.infer<typeof ExperimentOutcomeInput>;

export const Experiment = z.object({
  id: z.string(),
  question: z.string(),
  branchA: z.string(),
  branchB: z.string(),
  metric: z.string(),
  windowDays: z.number(),
  registeredAt: z.number(),
  /** When the outcome was recorded; null = not yet. */
  decidedAt: z.number().nullable(),
  changed: z.boolean().nullable(),
  note: z.string().nullable(),
});
export type Experiment = z.infer<typeof Experiment>;
