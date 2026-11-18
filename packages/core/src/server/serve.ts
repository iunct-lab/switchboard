import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { ClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@switchboard/protocol";
import { type PtyAttached, PtyClientMessage } from "../pty.ts";
import type { Peer, ServerContext, WsData } from "./context.ts";
import { TOPIC } from "./helpers.ts";

// Web UI policy (Content-Security-Policy and the other headers every page gets).
const WEB_HEADERS = {
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** What a request no route took gets: the built web UI's file, or its page; an unknown API path is a 404. */
export function fallbackFetch(sc: Pick<ServerContext, "viaEdge" | "refused" | "notViaEdge" | "hostOk" | "notAllowedHost" | "bad" | "webDist">) {
  return async (req: Request, srv: Peer) => {
    if (!sc.viaEdge(req, srv)) return sc.refused(req, srv, sc.notViaEdge());
    if (!sc.hostOk(req)) return sc.refused(req, srv, sc.notAllowedHost());
    const url = new URL(req.url);
    // an API path no route took does not exist: without this it would get the web UI's page with 200
    if (url.pathname.startsWith("/api/")) return sc.bad("not found", 404);
    // Static web UI when built; otherwise point at the Vite dev server.
    const dist = sc.webDist;
    if (existsSync(dist)) {
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(dist, rel));
      if (await file.exists()) return new Response(file, { headers: WEB_HEADERS });
      return new Response(Bun.file(join(dist, "index.html")), { headers: WEB_HEADERS });
    }
    return new Response(`Switchboard core is running. Web UI is not built; run "bun run dev" and open http://localhost:5173\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };
}

/** The handlers of the event socket (/ws) and of a terminal socket (/ws/pty). */
export function socketHandlers(sc: Pick<ServerContext, "cookieSockets" | "pty" | "setTerminal" | "hostIdle" | "wsCount" | "terminals" | "catchUpWithShadow" | "noteMergeGrant" | "tasks">): WebSocketHandler<WsData> {
  return {
    open(ws: ServerWebSocket<WsData>) {
      if (ws.data?.session) sc.cookieSockets.add(ws);
      if (ws.data?.ptyKey !== undefined) {
        try {
          if (ws.data.shell !== undefined) { /* a reconnect starts nothing */ }
          else if (ws.data.teleport) sc.pty!.prepareTeleport(ws.data.ptyKey);
          // Claude Code's status in the shell is a Task's mark (Rail, Home): a Workspace's shell reports none
          else { const id = ws.data.ptyKey; sc.pty!.open(id, ws.data.cwd, process.env.SHELL || "/bin/sh", ws.data.ofTask ? st => sc.setTerminal(id, st) : undefined, ws.data.ofTask ? "task" : "workspace"); }
        } catch (e) {
          return ws.close(1011, `shell failed to start: ${String((e as Error).message ?? e)}`.slice(0, 120));
        }
        // the session it asked for has ended (exited, the task ended, the daemon restarted): the client offers a new one
        const id = sc.pty!.sessionId(ws.data.ptyKey);
        if (!id || (ws.data.shell !== undefined && ws.data.shell !== id)) return ws.close(4404, "shell gone");
        ws.send(JSON.stringify({ type: "attached", shell: id } satisfies PtyAttached));
        ws.data.client = { send: (data) => void ws.send(data), close: () => ws.close(1000, "shell exited") };
        sc.hostIdle?.touch();
        return sc.pty!.attach(ws.data.ptyKey, ws.data.client);
      }
      sc.wsCount++;
      sc.hostIdle?.touch();
      ws.subscribe(TOPIC);
      ws.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION } satisfies ServerMessage));
      ws.send(JSON.stringify({ type: "task.terminals", terminals: Object.fromEntries(sc.terminals) } satisfies ServerMessage));
    },
    message(ws: ServerWebSocket<WsData>, raw) {
      if (ws.data?.ptyKey !== undefined) {
        const m = PtyClientMessage.safeParse(safeParse(String(raw)));
        if (!m.success) return;
        if (m.data.type === "input") sc.pty!.write(ws.data.ptyKey, m.data.data);
        // only a Workspace's shell: a Task's shell and a Teleport end with their Task, never by a message
        else if (m.data.type === "close") { if (sc.pty!.ofWorkspace(ws.data.ptyKey)) sc.pty!.close(ws.data.ptyKey); }
        else sc.pty!.resize(ws.data.ptyKey, m.data.cols, m.data.rows);
        return;
      }
      const parsed = ClientMessage.safeParse(safeParse(String(raw)));
      if (!parsed.success) {
        ws.send(JSON.stringify({ type: "error", message: "bad message" } satisfies ServerMessage));
        return;
      }
      const m = parsed.data;
      try {
        if (m.type === "task.send") {
          sc.catchUpWithShadow(m.taskId);
          // the web UI sends a reply over HTTP (/api/tasks/:id/send), never over this socket: a grant sentence that comes
          // in here is recorded as a bare call's and answers no check (merge-grants.ts)
          void sc.noteMergeGrant(m.taskId, m.text, { via: "api" }).catch(() => undefined)
            .then(() => sc.tasks.send(m.taskId, m.text))
            .catch((e) => ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) } satisfies ServerMessage)));
        } else if (m.type === "permission.respond") sc.tasks.respondPermission(m.taskId, m.id, m.decision);
        else if (m.type === "task.abort") void sc.tasks.abort(m.taskId).catch((e) => ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) } satisfies ServerMessage))); // a refusal (another machine's Task) is answered, never left unhandled
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) } satisfies ServerMessage));
      }
    },
    close(ws: ServerWebSocket<WsData>) {
      sc.hostIdle?.touch();
      sc.cookieSockets.delete(ws);
      if (ws.data?.ptyKey !== undefined) return void (ws.data.client && sc.pty!.detach(ws.data.ptyKey, ws.data.client));
      sc.wsCount--;
      ws.unsubscribe(TOPIC);
    },
  };
}
