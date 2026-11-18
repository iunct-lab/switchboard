/** The daemon's event stream over a WebSocket. */
import type { ServerMessage } from "@switchboard/protocol";
import { getToken } from "./request.ts";

/** A WebSocket URL on the page's own host. The token travels in the query: a browser WebSocket cannot set headers. */
export function wsUrl(path: string, query: Record<string, string> = {}, loc: { protocol: string; host: string } = location, token: string | null = getToken()): string {
  const q = new URLSearchParams(query);
  if (token) q.set("token", token);
  const qs = q.toString();
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}${qs ? `?${qs}` : ""}`;
}

/** WebSocket feed with automatic reconnect. */
export function connectEvents(onMessage: (m: ServerMessage) => void, onState: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  const open = () => {
    if (closed) return;
    ws = new WebSocket(wsUrl("/ws"));
    ws.onopen = () => {
      retry = 500;
      onState(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onState(false);
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 8000)));
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
