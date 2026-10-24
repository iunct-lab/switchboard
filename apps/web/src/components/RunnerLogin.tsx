import { useEffect, useState } from "react";
import type { RunnerId } from "@switchboard/protocol";
import { api, type RunnerLoginView } from "../api.ts";

/**
 * "ログインする" on the banner of a runner whose login ran out (#354). The daemon runs the runner's own login and relays
 * what it prints: codex a device URL and a one-time code (approve on the page, this goes away by itself), claude a URL
 * and a box for the code its page shows. No terminal.
 */
export function RunnerLogin(props: { runner: RunnerId; onDone: () => void; onError: (m: string) => void }) {
  const [view, setView] = useState<RunnerLoginView | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  // while a login waits (codex: the approval happens elsewhere), look again every 2 s
  useEffect(() => {
    if (view?.state !== "waiting") return;
    const t = setInterval(() => {
      api.runnerLoginState(props.runner).then((v) => {
        setView(v);
        if (v.state === "done") props.onDone();
      }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.state, props.runner]);

  const start = () => {
    setBusy(true);
    api.runnerLogin(props.runner).then(setView).catch((e) => props.onError(`${props.runner} のログインを始められません: ${e.message}`)).finally(() => setBusy(false));
  };
  const send = () => {
    setBusy(true);
    api.runnerLoginCode(props.runner, code).then((v) => {
      setCode("");
      setView(v);
      if (v.state === "done") props.onDone();
    }).catch((e) => props.onError(`コードを送れません: ${e.message}`)).finally(() => setBusy(false));
  };

  if (!view || view.state === "failed")
    return (
      <span className="runner-login">
        {view?.error && <span className="hint">{view.error}</span>}
        <button className="pri" disabled={busy} onClick={start}>
          {busy ? "準備しています…" : "ログインする"}
        </button>
      </span>
    );
  const cancel = () => {
    api.runnerLoginCancel(props.runner).then(setView).catch(() => setView(null));
  };
  if (view.state === "done") return <span className="hint">ログインしました</span>;
  // the CLI printed no login URL (a changed CLI, a network problem): say so, and let the person stop or retry
  if (!view.url)
    return (
      <span className="runner-login">
        <span className="hint">ログインの URL が出ませんでした。</span>
        <button className="ghost" onClick={cancel}>
          取り消す
        </button>
        <button className="pri" disabled={busy} onClick={() => api.runnerLoginCancel(props.runner).catch(() => undefined).then(start)}>
          やり直す
        </button>
      </span>
    );
  return (
    <span className="runner-login">
      {view.url && (
        <a className="button pri" href={view.url} target="_blank" rel="noreferrer">
          ログインページを開く
        </a>
      )}
      {view.code && (
        <span>
          コード <code className="device-code">{view.code}</code>{" "}
          <button className="ghost" onClick={() => void navigator.clipboard?.writeText(view.code!)}>
            コピー
          </button>
          <span className="hint"> ページで入力して承認すると、自動で消えます</span>
        </span>
      )}
      {view.needsCode && (
        <span className="runner-login-code">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ページに表示されたコードを貼る" autoComplete="off" />
          <button className="pri" disabled={busy || !code.trim()} onClick={send}>
            送る
          </button>
        </span>
      )}
    </span>
  );
}
