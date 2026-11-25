import type { Workspace } from "@switchboard/protocol";
import type { FeedbackSource } from "./api/feedback.ts";

/** What the instruction form hands `api.feedback`, in the order it takes them. */
export type FeedbackArgs = [text: string, attachmentIds: string[], screen: string, mode: "request" | "fix", workspaceId: string | undefined, source: FeedbackSource | undefined];

/**
 * The arguments of 「バックログに積む」(`request`) and 「要望にしてすぐ直す」(`fix`). A request names the repository it is filed in
 * (`null` = 自動: nothing is sent and the daemon files it in Switchboard itself) and where it was drafted from; a fix is always
 * about Switchboard, so it names neither.
 */
export function feedbackArgs(
  how: "request" | "fix",
  s: { text: string; attachmentIds: string[]; screen: string; workspaceId: string | null; source?: FeedbackSource },
): FeedbackArgs {
  return how === "request" ? [s.text, s.attachmentIds, s.screen, "request", s.workspaceId ?? undefined, s.source] : [s.text, s.attachmentIds, s.screen, "fix", undefined, undefined];
}

/** The name of the repository 「バックログに積む」 files in: the chosen Workspace, and with 自動 (`wsId` empty) Switchboard itself (meta). "" = neither is known. */
export function backlogTargetName(workspaces: Workspace[], wsId: string): string {
  return (wsId ? workspaces.find((w) => w.id === wsId) : workspaces.find((w) => w.kind === "meta"))?.name ?? "";
}
