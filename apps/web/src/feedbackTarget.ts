import type { Workspace } from "@switchboard/protocol";

/** A repository the instruction form can start on: just what the Backlog's narrowing says, an id and a name. */
export type FeedbackTarget = Pick<Workspace, "id" | "name">;

/**
 * Where the instruction form starts: the repository it was opened for (the Backlog's narrowed one), else 自動 (""). `extra` is that
 * repository when App's list has not caught up with it: the form offers it too, so what it shows is what is sent.
 */
export function startWorkspace(workspaces: Workspace[], opened?: FeedbackTarget): { initial: string; extra: FeedbackTarget | null } {
  return { initial: opened?.id ?? "", extra: opened && !workspaces.some((w) => w.id === opened.id) ? opened : null };
}

/**
 * What the instruction form offers. `developSelf` off: no 「要望にしてすぐ直す」, and a request for Switchboard itself (the meta
 * workspace, which is also where a form with 自動 chosen files it) goes upstream instead of making a Task.
 * One place for the decision, so the render does not branch on the setting.
 */
export function feedbackModes(developSelf: boolean, target: FeedbackTarget | undefined, workspaces: Workspace[]): { fix: boolean; upstream: boolean } {
  const kind = target ? workspaces.find((w) => w.id === target.id)?.kind : "meta";
  return { fix: developSelf, upstream: !developSelf && kind === "meta" };
}
