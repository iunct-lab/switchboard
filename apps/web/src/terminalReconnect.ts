/**
 * What the Terminal tab does when its socket closes (#1137). The daemon names the session in the socket's first frame;
 * with that id a dropped connection is tried again (500 ms doubling up to 8 s, like the event socket) and comes back to the
 * same shell. A shell that has ended — exited (1000), or gone when the socket came back (4404) — is not started again on
 * its own: a new one starts only from 開き直す.
 */
export type AfterClose = { kind: "retry"; delayMs: number } | { kind: "ended"; message: string; reopen: boolean };

export function afterClose(code: number, shell: string | null, attempt: number): AfterClose {
  if (code === 1000) return { kind: "ended", message: "Terminalは終了しました。", reopen: true };
  if (code === 4404) return { kind: "ended", message: "Terminalは終了していました。", reopen: true };
  if (shell) return { kind: "retry", delayMs: Math.min(500 * 2 ** attempt, 8000) };
  return { kind: "ended", message: "ターミナルとの接続が切れました。", reopen: true };
}

/** The query of /ws/pty: the task, the Teleport view, and the session to come back to. */
export function ptyQuery(taskId: string, shell: string | null, teleport = false): Record<string, string> {
  return { task: taskId, ...(teleport ? { teleport: "1" } : {}), ...(shell ? { shell } : {}) };
}
