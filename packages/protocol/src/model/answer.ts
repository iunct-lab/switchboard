import { z } from "zod";

const answerText = z.string().trim().max(20_000);
/**
 * One answer to a question: choice = one of its choices (and a note), text = free text, hold = put it on hold
 * (not an approval), allow / deny = a tool approval, confirm = an acceptance criterion checked by the user (ok) or not.
 */
export const AskAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), choice: z.string().min(1), note: answerText.optional() }),
  z.object({ kind: z.literal("text"), text: answerText.min(1) }),
  z.object({ kind: z.literal("hold"), text: answerText.optional() }),
  z.object({ kind: z.literal("allow") }),
  z.object({ kind: z.literal("deny") }),
  z.object({ kind: z.literal("confirm"), ok: z.boolean(), text: answerText.optional() }),
  /** Send the stop's grant as the reply, once. */
  z.object({ kind: z.literal("grant") }),
  /** Close a daemon's notice as a false positive: the same findings do not come back. */
  z.object({ kind: z.literal("dismiss") }),
  /**
   * The answers to a question tool's questions, in the order of `Ask.questions`: the chosen option labels, or the
   * free text of a question without options. Sent to the Task as one reply.
   */
  z.object({ kind: z.literal("questions"), answers: z.array(z.object({ choices: z.array(z.string()), text: answerText.optional() })).min(1) }),
]);
export type AskAnswer = z.infer<typeof AskAnswer>;
export const AskAnswerKind = z.enum(["choice", "text", "hold", "allow", "deny", "confirm", "grant", "dismiss", "questions"]);
export type AskAnswerKind = z.infer<typeof AskAnswerKind>;
