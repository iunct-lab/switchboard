import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/**
 * What the Terminal tab does when its socket closes. The daemon names the session in the socket's first frame;
 * with that id a dropped connection is tried again (500 ms doubling up to 8 s, like the event socket) and comes back to the
 * same shell. A shell that has ended — exited (1000), or gone when the socket came back (4404) — is not started again on
 * its own: a new one starts only from 開き直す.
 */
export type AfterClose = { kind: "retry"; delayMs: number } | { kind: "ended"; message: string; reopen: boolean };

export function afterClose(code: number, shell: string | null, attempt: number): AfterClose {
  if (code === 1000) return { kind: "ended", message: t(m.termExited), reopen: true };
  if (code === 4404) return { kind: "ended", message: t(m.termGone), reopen: true };
  if (shell) return { kind: "retry", delayMs: Math.min(500 * 2 ** attempt, 8000) };
  return { kind: "ended", message: t(m.termLost), reopen: true };
}

/**
 * Why the daemon refused a terminal before its socket opened, when the refusal is about the target itself (`ptyTarget`
 * answers 409 or 404 with a line: the Task ran on another machine, this is a work machine, the folder is not here):
 * the line to show instead of "the connection was lost" — trying again would get the same answer. Null = no such
 * refusal (426 is the answer to a plain GET of a target that is fine; a login refusal is handled by its own path).
 */
export function targetRefusal(status: number, body: unknown): string | null {
  if (status !== 409 && status !== 404) return null;
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  return typeof error === "string" && error.trim() ? error.trim().slice(0, 300) : null;
}

/** Whose shell a terminal shows: a Task's (in its cwd), or a registered Workspace's (in its path, no Task). */
export type TerminalTarget = { task: string } | { workspace: string };

/** The PtyManager key of a target: the id the session to come back to is remembered under. */
export const targetKey = (target: TerminalTarget): string => ("task" in target ? target.task : target.workspace);

/** The query of /ws/pty: the Task or the Workspace, the Teleport view (a Task's only), and the session to come back to. */
export function ptyQuery(target: TerminalTarget, shell: string | null, teleport = false): Record<string, string> {
  return { ...target, ...(teleport && "task" in target ? { teleport: "1" } : {}), ...(shell ? { shell } : {}) };
}
