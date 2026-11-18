import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "../api/request.ts";
import { wsUrl } from "../api/events.ts";
import { askRecentCheck, isRecentRefusal } from "../recent.ts";
import { afterClose, ptyQuery, targetKey, targetRefusal, type TerminalTarget } from "../terminalReconnect.ts";
import { keySequence, TERM_KEYS, TERM_KEY_LABELS } from "../termKeys.ts";
import { t } from "../i18n.ts";
import { task as m } from "../i18n/task.ts";

/**
 * A shell: a Task's, or a Workspace's opened without a Task. The shell lives in the daemon: unmounting only drops the socket, and the daemon re-sends
 * the recent output to the next one. Mounted once the tab is first opened and kept mounted while hidden. A dropped
 * connection comes back to the same shell by the id the daemon names first (terminalReconnect.ts). Under it, on a
 * phone's width only, the row of keys an on-screen keyboard lacks (termKeys.ts). `closable` (a Workspace's terminal)
 * shows the button that ends the shell: nothing else ends a shell that belongs to no Task.
 */
export function Terminal(props: { target: TerminalTarget; teleport?: boolean; onEnded?: () => void; closable?: boolean }) {
  const key = targetKey(props.target);
  const onEnded = useRef(props.onEnded); onEnded.current = props.onEnded;
  const host = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState<{ message: string; reopen: boolean } | null>(null);
  const [session, setSession] = useState(0);
  const reopened = useRef(false); // the passkey check re-opens the socket once
  // the session to come back to, for this task only; tries since the last attach
  const shell = useRef<{ task: string; id: string } | null>(null);
  const attempt = useRef(0);
  // what the keys' row and the end button reach: the live terminal and its socket
  const live = useRef<{ term: XTerm; send: (m: { type: "input"; data: string } | { type: "close" }) => void } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new XTerm({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const known = shell.current?.task === key ? shell.current.id : null;
    const url = wsUrl("/ws/pty", ptyQuery(props.target, known, props.teleport));
    const ws = new WebSocket(url);
    let opened = false;
    let attached = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = (m: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number } | { type: "close" }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    live.current = { term, send };
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
      shell.current = { task: key, id: (JSON.parse(String(e.data)) as { shell: string }).shell };
      attempt.current = 0;
    };
    const closed = (e: CloseEvent) => {
      const next = afterClose(e.code, shell.current?.task === key ? shell.current.id : null, attempt.current);
      if (next.kind === "retry") {
        attempt.current++;
        setEnded({ message: t(m.reconnecting), reopen: false });
        retry = setTimeout(() => setSession((n) => n + 1), next.delayMs);
        return;
      }
      setEnded({ message: next.message, reopen: next.reopen });
      onEnded.current?.();
    };
    ws.onclose = (e) => {
      if (opened || reopened.current) return closed(e);
      // refused before it opened: a browser hides why, so read it from the same URL as a plain GET; "recent" asks for the passkey
      const token = getToken();
      void fetch(url.replace(/^ws/, "http"), { credentials: "same-origin", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) })
        .then(async (r): Promise<{ again: boolean; refusal: string | null }> => {
          const body = await r.json().catch(() => ({}));
          return isRecentRefusal(r.status, body) ? { again: await askRecentCheck(), refusal: null } : { again: false, refusal: targetRefusal(r.status, body) };
        }, () => ({ again: false, refusal: null }))
        .then(({ again, refusal }) => {
          if (again) { reopened.current = true; setSession((n) => n + 1); }
          // the daemon said why this terminal is not opened here: its line, and no 開き直す (the same answer would come back)
          else if (refusal) { setEnded({ message: refusal, reopen: false }); onEnded.current?.(); }
          else closed(e);
        });
    };
    const input = term.onData((data) => send({ type: "input", data }));
    return () => {
      live.current = null;
      clearTimeout(retry);
      observer.disconnect();
      input.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [key, props.teleport, session]);

  return (
    <div className="terminal">
      <div className="terminal-host" ref={host} />
      <div className="term-keys">
        {TERM_KEYS.map((k) => (
          <button
            key={k}
            className="btn"
            // keep the focus in xterm's textarea: taking it would close the on-screen keyboard
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              const l = live.current;
              if (!l) return;
              l.send({ type: "input", data: keySequence(k, l.term.modes.applicationCursorKeysMode) });
              l.term.focus();
            }}
          >
            {TERM_KEY_LABELS[k]}
          </button>
        ))}
      </div>
      {props.closable && !ended && (
        <div className="hint">
          {t(m.termKeepsHost)}{" "}
          <button className="btn" onClick={() => live.current?.send({ type: "close" })}>{t(m.termEnd)}</button>
        </div>
      )}
      {ended && (
        <div className="hint">
          {ended.message}{" "}
          {ended.reopen && (
            // a new shell starts only from here: the one it was on is forgotten
            <button className="btn" onClick={() => { reopened.current = false; shell.current = null; attempt.current = 0; setSession((n) => n + 1); }}>
              {t(m.reopen)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
