import { z } from "zod";

export const FeedbackInput = z.object({
  text: z.string().min(1).max(20_000),
  attachmentIds: z.array(z.string()).optional(),
  /** The screen the feedback was sent from, as the UI names it: Home, Task「<title>」(<id>), … */
  screen: z.string().max(200).optional(),
  /** request = register it as a request (request-to-backlog); fix = start a Task that fixes it now. */
  mode: z.enum(["request", "fix"]).default("request"),
  /** Where a request is filed, or where a すぐ直す Task runs: the workspace whose repository it is. Omitted = the meta workspace. */
  workspaceId: z.string().optional(),
  /** Evals: the request was drafted from a task's evaluations; the task goes into the request's 出典. An artifact: from a throwaway app. */
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("eval"), taskId: z.string() }),
    /** A throwaway app: the artifact goes into the request's 出典 with where its copy is. */
    z.object({ kind: z.literal("artifact"), artifactId: z.string() }),
  ]).optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;
/** The 200 of POST /api/feedback when the request is for Switchboard itself and this instance does not develop it: no Task; where to file it upstream. */
export const FeedbackUpstream = z.object({ upstream: z.object({ url: z.string().nullable(), text: z.string() }) });
export type FeedbackUpstream = z.infer<typeof FeedbackUpstream>;
