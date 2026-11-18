import type { FeedbackInput, Task } from "@switchboard/protocol";
import { req } from "./request.ts";

/** Evals: where a request was drafted from; goes into its 出典. The protocol's own shape, so the two cannot drift. */
export type FeedbackSource = NonNullable<FeedbackInput["source"]>;

/** The answer to a request for Switchboard itself on an instance that does not develop it: no Task; `url` opens the upstream form with the text filled in, null when the origin is not on GitHub. */
export interface FeedbackUpstream { upstream: { url: string | null; text: string } }

/** The calls of this group; `api` (index.ts) holds every group's. */
export const feedbackApi = {
  feedback: (text: string, attachmentIds?: string[], screen?: string, mode: "request" | "fix" = "request", workspaceId?: string, source?: FeedbackSource) => req<Task | FeedbackUpstream>("/api/feedback", { method: "POST", body: JSON.stringify({ text, attachmentIds, screen, mode, workspaceId, source }) }),
};
