import { statSync } from "node:fs";
import { MAX_PTY_SESSIONS } from "../pty.ts";
import { sameOrigin } from "../auth.ts";
import { isWorkMachine, otherMachineOf } from "../machine.ts";
import type { Peer, Routes, ServerContext } from "../server/context.ts";

/**
 * The one check every socket upgrade passes before anything about its target is read: same Origin, then the login
 * (never a stale one), and for a shell (`/ws/pty`, of a Task or of a Workspace alike) the recent passkey check of a
 * cookie session and that this distribution can open a PTY. A Response = refused; otherwise the session to keep.
 */
export const socketGate = async (sc: Pick<ServerContext, "refused" | "bad" | "authorize" | "recentRefusal" | "pty">, req: Request, srv: Peer, shell: boolean): Promise<Response | { session?: string }> => {
  if (!sameOrigin(req)) return sc.refused(req, srv, sc.bad("cross-origin request refused", 403));
  const auth = await sc.authorize(req, srv, true, true);
  if (!auth.ok) return sc.refused(req, srv, sc.bad("unauthorized", 401));
  if (!shell) return { session: auth.session };
  const recent = sc.recentRefusal(req, auth.session);
  if (recent) return recent;
  if (!sc.pty) return sc.bad("no terminal in this distribution", 404);
  return { session: auth.session };
};

/** A Workspace's id as the daemon makes it (`ws_` + 12 hex) or as seeded by name: letters, digits, `_`, `-`. Anything else (a path) is not looked up. */
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,64}$/;

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export type PtyTarget = { key: string; cwd: string; task?: string; teleport: boolean };

/**
 * Whose shell a `/ws/pty` request asks for, and where it starts. `?task=<id>` is that Task's cwd; without it
 * `?workspace=<id>` is a registered Workspace's path (no Task needed). The directory only ever comes from the stored
 * row: the query carries an id, never a path. Refused (a Response):
 *  - a Task whose record came from another machine (409, Teleport too): it is read only here, and its cwd is a string
 *    that machine sent, not a place this one chose;
 *  - a Workspace's shell on a work machine (`isWorkMachine`: SWITCHBOARD_UPLINK=send; 409): that machine runs Tasks
 *    and sends their records, it is not where the person works in a repository by hand. A Task's shell still opens there;
 *  - a directory that is not on this machine, or is not a directory (409).
 */
export const ptyTarget = (sc: Pick<ServerContext, "db" | "bad" | "cfg">, q: URLSearchParams): Response | PtyTarget => {
  const teleport = q.get("teleport") === "1";
  if (q.has("task") || !q.has("workspace")) {
    const task = sc.db.getTask(q.get("task") ?? "");
    if (!task) return sc.bad("task not found", 404);
    const machine = otherMachineOf(task);
    if (machine) return sc.bad(`この Task は ${machine} で動きました。ターミナルは ${machine} で開きます。`, 409);
    if (!isDirectory(task.cwd)) return sc.bad("the task's directory is not on this machine", 409);
    return { key: task.id, cwd: task.cwd, task: task.id, teleport };
  }
  if (teleport) return sc.bad("teleport needs a task", 400);
  if (isWorkMachine(sc.cfg)) return sc.bad("この作業マシンでは Workspace のターミナルを開けません。Task のターミナルを使います。", 409);
  const id = q.get("workspace") ?? "";
  const w = WORKSPACE_ID.test(id) ? sc.db.getWorkspace(id) : null;
  if (!w) return sc.bad("workspace not found", 404);
  if (!isDirectory(w.path)) return sc.bad("the workspace's path is not a directory on this machine", 409);
  return { key: w.id, cwd: w.path, teleport: false };
};

/** The routes under /ws. */
export function wsRoutes(sc: Pick<ServerContext, "refused" | "bad" | "authorize" | "recentRefusal" | "pty" | "db" | "clientOf" | "logOp" | "cfg">): Routes {
  return {
    "/ws": async (req, srv) => {
      const gate = await socketGate(sc, req, srv, false);
      if (gate instanceof Response) return gate;
      if (srv.upgrade(req, { data: gate.session ? { session: gate.session } : undefined })) return undefined as unknown as Response;
      return sc.bad("websocket upgrade failed", 426);
    },
    // Terminal: a Task's shell or a Workspace's. Same rules as /ws and more (socketGate) — this socket can run anything
    // the daemon's user can — and both kinds pass them before the target is read.
    "/ws/pty": async (req, srv) => {
      const gate = await socketGate(sc, req, srv, true);
      if (gate instanceof Response) return gate;
      const pty = sc.pty!; // socketGate refused when there is none
      const q = new URL(req.url).searchParams;
      const target = ptyTarget(sc, q);
      if (target instanceof Response) return target;
      // ?shell=<id>: coming back to that session only; without it, the key's session or a new one. A reconnect
      // starts nothing, so the cap does not apply: a gone shell must be told 4404 even when the others fill the cap.
      const shell = q.get("shell") ?? undefined;
      if (shell === undefined && !pty.has(target.key) && pty.size >= MAX_PTY_SESSIONS) return sc.bad(`too many terminals open (max ${MAX_PTY_SESSIONS}); close one first`, 429);
      // The shell starts in the socket's open handler: a request that never becomes a socket must not leave one behind.
      const from = sc.clientOf(req, srv); // before the upgrade: the socket's peer is gone after it
      if (srv.upgrade(req, { data: { ptyKey: target.key, cwd: target.cwd, ofTask: target.task !== undefined, teleport: target.teleport, shell, session: gate.session } })) {
        sc.logOp(req, srv, "pty.open", { ...(target.task ? { task: target.task } : { detail: `workspace ${target.key}` }), ...(target.teleport ? { detail: "teleport" } : {}) }, from);
        return undefined as unknown as Response;
      }
      return sc.bad("websocket upgrade failed", 426);
    },
  };
}
