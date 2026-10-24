import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getToken, wsUrl } from "../api.ts";
import { askRecentCheck, isRecentRefusal } from "../recent.ts";
import { afterClose, ptyQuery } from "../terminalReconnect.ts";

/**
 * The task's shell (#16). The shell lives in the daemon: unmounting only drops the socket, and the daemon re-sends
 * the recent output to the next one. Mounted once the tab is first opened and kept mounted while hidden. A dropped
 * connection comes back to the same shell by the id the daemon names first (#1137, terminalReconnect.ts).
 */
export function Terminal(props: { taskId: string; teleport?: boolean; onEnded?: () => void }) {
  const onEnded = useRef(props.onEnded); onEnded.current = props.onEnded;
  const host = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState<{ message: string; reopen: boolean } | null>(null);
  const [session, setSession] = useState(0);
  const reopened = useRef(false); // the passkey check re-opens the socket once (#1491)
  // the session to come back to, for this task only; tries since the last attach
  const shell = useRef<{ task: string; id: string } | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    const el = host.current!;
    const term = new XTerm({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const known = shell.current?.task === props.taskId ? shell.current.id : null;
    const url = wsUrl("/ws/pty", ptyQuery(props.taskId, known, props.teleport));
    const ws = new WebSocket(url);
    let opened = false;
    let attached = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = (m: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    // A hidden tab has no size: fitting then would tell the shell it is 2 columns wide.
    const refit = () => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    ws.onopen = () => {
      opened = true;
      reopened.current = false;
      setEnded(null);
      refit();
      term.focus();
    };
    ws.onmessage = (e) => {
      if (attached) return void term.write(String(e.data));
      attached = true; // the first frame names the session: {"type":"attached","shell":"<id>"}
      shell.current = { task: props.taskId, id: (JSON.parse(String(e.data)) as { shell: string }).shell };
      attempt.current = 0;
    };
    const closed = (e: CloseEvent) => {
      const next = afterClose(e.code, shell.current?.task === props.taskId ? shell.current.id : null, attempt.current);
      if (next.kind === "retry") {
        attempt.current++;
        setEnded({ message: "再接続しています…", reopen: false });
        retry = setTimeout(() => setSession((n) => n + 1), next.delayMs);
        return;
      }
      setEnded({ message: next.message, reopen: next.reopen });
      onEnded.current?.();
    };
    ws.onclose = (e) => {
      if (opened || reopened.current) return closed(e);
      // refused before it opened: a browser hides why, so read it from the same URL as a plain GET; "recent" asks for the passkey (#1491)
      const token = getToken();
      void fetch(url.replace(/^ws/, "http"), { credentials: "same-origin", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) })
        .then(async (r) => (isRecentRefusal(r.status, await r.json().catch(() => ({}))) ? askRecentCheck() : false), () => false)
        .then((ok) => {
          if (ok) { reopened.current = true; setSession((n) => n + 1); } else closed(e);
        });
    };
    const input = term.onData((data) => send({ type: "input", data }));
    return () => {
      clearTimeout(retry);
      observer.disconnect();
      input.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [props.taskId, props.teleport, session]);

  return (
    <div className="terminal">
      <div className="terminal-host" ref={host} />
      {ended && (
        <div className="hint">
          {ended.message}{" "}
          {ended.reopen && (
            // a new shell starts only from here: the one it was on is forgotten
            <button className="btn" onClick={() => { reopened.current = false; shell.current = null; attempt.current = 0; setSession((n) => n + 1); }}>
              開き直す
            </button>
          )}
        </div>
      )}
    </div>
  );
}
