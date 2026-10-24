import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { releasePanel, rescueLink, shortSha, type ReleaseStatus } from "../release.ts";

/** Which version runs, whether HEAD is newer, and the button that promotes it (#1660). Under sb-rescue only; elsewhere one line. */
export function ReleasePanel(props: { disabled?: boolean; onPromoted?: () => void }) {
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const load = () => api.release().then(setRelease).catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000); // a promotion ends in a restart: keep asking until the result is in the history
    return () => clearInterval(timer);
  }, []);
  const view = releasePanel(release);
  if (!view) return null;
  // The commit on the button is the commit that is sent: HEAD may have moved since the last poll.
  const send = (force: boolean) => {
    const head = release?.head;
    if (!head) return;
    setConfirming(false);
    api
      .promote(head, force)
      .then((r) => {
        setMsg(`${shortSha(r.commit)} を別ポートで起動して確認しています。通れば切り替わり、UI は再接続します。通らなければ今の版のままです`);
        props.onPromoted?.();
      })
      .catch((e) => setMsg(String(e.message ?? e)));
  };
  const press = () => (view.busyTasks > 0 ? setConfirming(true) : send(false));
  return (
    <div id="release-panel">
      {view.lines.map((l, i) => (
        <div key={i} className={l.warn ? "hint warn" : "hint"}>{l.text}</div>
      ))}
      {release?.managed && (
        <div className="actions" style={{ marginTop: 6 }}>
          <button className="pri" disabled={props.disabled || !view.canPromote} onClick={press} title="このコミットのリリースを作り、別ポートで起動して確認してから切り替えます。切り替え後に確認できなければ自動で前の版に戻ります">
            この版を昇格（{shortSha(release.head)}）
          </button>
        </div>
      )}
      {release?.managed && view.busyTasks > 0 && <div className="hint">動いている Task {view.busyTasks} 件: 昇格するとデーモンが再起動します</div>}
      {confirming && (
        <div className="actions" style={{ marginTop: 6 }}>
          <button className="pri" disabled={props.disabled || !view.canPromote} onClick={() => send(true)}>待たずに昇格する</button>
          <button className="ghost" onClick={() => setConfirming(false)}>やめる</button>
        </div>
      )}
      {msg && <div className="hint">{msg}</div>}
      {rescueLink(release) && (
        <div className="hint">
          <a href={rescueLink(release)!}>救援画面 →</a>
        </div>
      )}
    </div>
  );
}
