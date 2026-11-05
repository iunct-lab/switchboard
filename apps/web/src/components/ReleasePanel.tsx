import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { releasePanel, rescueLink, shortSha, type ReleaseStatus } from "../release.ts";
import { t } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";

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
        setMsg(t(settings.promoteStarted, { sha: shortSha(r.commit) }));
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
          <button className="pri" disabled={props.disabled || !view.canPromote} onClick={press} title={t(settings.promoteTitle)}>
            {t(settings.promoteButton, { sha: shortSha(release.head) })}
          </button>
        </div>
      )}
      {release?.managed && view.busyTasks > 0 && <div className="hint">{t(settings.promoteBusy, { n: view.busyTasks })}</div>}
      {confirming && (
        <div className="actions" style={{ marginTop: 6 }}>
          <button className="pri" disabled={props.disabled || !view.canPromote} onClick={() => send(true)}>{t(settings.promoteNow)}</button>
          <button className="ghost" onClick={() => setConfirming(false)}>{t(settings.cancel)}</button>
        </div>
      )}
      {msg && <div className="hint">{msg}</div>}
      {rescueLink(release) && (
        <div className="hint">
          <a href={rescueLink(release)!}>{t(settings.rescuePage)}</a>
        </div>
      )}
    </div>
  );
}
