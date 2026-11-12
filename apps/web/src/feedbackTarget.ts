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

/**
 * What the feedback dialog offers (#2459). `developSelf` off: no 「すぐ直す」, and a request for Switchboard itself (the meta
 * workspace, which is also where a dialog opened for no workspace files it) goes upstream instead of making a Task.
 * One place for the decision, so the render does not branch on the setting.
 */
export function feedbackModes(developSelf: boolean, target: FeedbackTarget | undefined, workspaces: Workspace[]): { fix: boolean; upstream: boolean } {
  const kind = target ? workspaces.find((w) => w.id === target.id)?.kind : "meta";
  return { fix: developSelf, upstream: !developSelf && kind === "meta" };
}

/**
 * The feedback dialog's developSelf for each opening (#2459): off until that opening's answer, and a late answer for an
 * earlier opening is dropped, so すぐ直す is never offered on a value from before the setting changed. The returned
 * call is made at each opening; its promise rejects when the read fails.
 */
export function developSelfPerOpening(read: () => Promise<boolean>, set: (on: boolean) => void): () => Promise<void> {
  let latest = 0;
  return () => {
    const n = ++latest;
    set(false);
    return read().then((on) => { if (n === latest) set(on); });
  };
}

/** What the dialog sends: すぐ直す only while it is offered; a choice kept from before the setting was turned off goes as a request. */
export function sentMode(modes: { fix: boolean }, mode: "request" | "fix"): "request" | "fix" {
  return modes.fix ? mode : "request";
}
