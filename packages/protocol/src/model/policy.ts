import { z } from "zod";
import { AskAnswer } from "./answer.ts";

/**
 * A saved answer policy: one answer reused next time under a scope and conditions. Matched on structured values
 * only (tool kind + path / command, or the stop record's op / target / conditions), never on the wording of a question.
 */
export const PolicyScope = z.enum(["once", "pbi", "repo"]);
export type PolicyScope = z.infer<typeof PolicyScope>;
const PolicyCondition = z.object({ key: z.string(), value: z.string() });
export const PolicySubject = z.object({
  kind: z.enum(["approval", "check", "decision"]),
  op: z.string().max(100),
  target: z.string().max(200),
  conditions: z.array(PolicyCondition),
  /** Head sha of the PR the work stopped at, when there is one. */
  head: z.string().nullable(),
});
export type PolicySubject = z.infer<typeof PolicySubject>;
export const AnswerPolicy = z.object({
  id: z.string(),
  scope: PolicyScope,
  workspaceId: z.string(),
  pbi: z.number().nullable(),
  askId: z.string().nullable(),
  kind: PolicySubject.shape.kind,
  op: z.string(),
  /** A glob, same rules as the approval rules' globMatch. */
  target: z.string(),
  /** Applies only when the current conditions hold every one of these values. */
  when: z.array(PolicyCondition),
  answer: AskAnswer,
  expiresAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The question it was saved from. */
  from: PolicySubject,
  /** How many times it answered, in all: `uses` keeps only the newest 20, this is not cut. */
  useCount: z.number().int().nonnegative(),
  /** When it first answered; null = not used yet. Set by the first use and never changed. */
  firstUsedAt: z.number().nullable(),
  /** Newest 20 uses (the total is `useCount`). */
  uses: z.array(
    z.object({ at: z.number(), askId: z.string(), taskId: z.string().nullable(), issue: z.number().nullable(), subject: PolicySubject, /** The answered question's id, when the question's id changes with its answer (a decision's). */ answered: z.string().optional() }),
  ),
});
export type AnswerPolicy = z.infer<typeof AnswerPolicy>;
export const PolicyInput = z.object({
  scope: PolicyScope,
  target: z.string().trim().min(1).max(200),
  when: z.array(PolicyCondition),
  expiresAt: z.number().nullable(),
});
export type PolicyInput = z.infer<typeof PolicyInput>;
export const PolicyPatch = PolicyInput.omit({ scope: true }).partial().extend({ revoked: z.boolean().optional() });
export type PolicyPatch = z.infer<typeof PolicyPatch>;

/**
 * One question across the Tasks and the backlog, built from the records each time it is read,
 * never stored. null = not known (the screen says 不明). `needs`: person = someone has to answer, auto = it goes on by itself
 * once its `conditions` are met. `route` = where the screen sends the person to answer it.
 *
 * `id` (what an answer to it names):
 * - `decision:<workspaceId>#<the Issue asked on>@<the ## 判断待ち's at>` (`@` and nothing after it when the ## 判断待ち
 *   cannot be read); an answered one, whose question is gone from the records, is `decision:<workspaceId>#<PBI>@<answeredAt>`
 * - `confirm:<workspaceId>#<PBI>:<n>` (n = the criterion's number, BacklogItem.confirmations)
 * - `wait:<workspaceId>#<PBI>@<waitsAt>`
 * - `stop:<StopSummary.key with each \0 written as |>@<StopSummary.contentAt>` (the time the stop took its present op, reason and grant)
 * - `notice:workspace:<workspaceId>`, `notice:scan:<scheduleId>@<first sight>`
 */
/**
 * What the screen shows about saved policies for one question: `scopes` = the ranges it can be saved under ([] = it
 * cannot, with `note`), `defaults` = what the form starts with, `applied` = the policy that answered it, `previous` = the
 * earlier answer that no longer applies, and what differs.
 */
export const AskPolicy = z.object({
  scopes: z.array(PolicyScope),
  note: z.string().nullable(),
  defaults: z.object({ target: z.string(), when: AnswerPolicy.shape.when, expiresAt: z.number().nullable() }).nullable(),
  applied: z.object({ id: z.string(), scope: PolicyScope, at: z.number(), summary: z.string() }).nullable(),
  previous: z.object({ id: z.string(), answer: AskAnswer, at: z.number(), why: z.string(), changes: z.array(z.string()) }).nullable(),
});
export type AskPolicy = z.infer<typeof AskPolicy>;
/** GET /api/policies. */
export const PolicyList = z.object({ policies: z.array(AnswerPolicy) });
export type PolicyList = z.infer<typeof PolicyList>;
