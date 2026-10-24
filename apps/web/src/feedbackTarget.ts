import type { Workspace } from "@switchboard/protocol";

/**
 * Where a request can be filed and where the dialog opens: the workspace it was opened for (the backlog's narrowed one),
 * listed even if App's list has not caught up with it, else the meta workspace; "" = not loaded yet (the daemon files it
 * in the meta workspace).
 */
export type FeedbackTarget = Pick<Workspace, "id" | "name">;

export function feedbackTargets(workspaces: Workspace[], opened?: FeedbackTarget): { list: FeedbackTarget[]; initial: string } {
  const list = opened && !workspaces.some((w) => w.id === opened.id) ? [...workspaces, opened] : workspaces;
  return { list, initial: opened?.id ?? workspaces.find((w) => w.kind === "meta")?.id ?? "" };
}
