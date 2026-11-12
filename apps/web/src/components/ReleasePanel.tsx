import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { pendingForce, promoteTarget, releasePanel, rescueLink, shortSha, type PromoteTarget, type ReleaseStatus } from "../release.ts";
import { t } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";

/** Which version runs, whether HEAD is newer, and the button that promotes it (#1660). Under sb-rescue only; elsewhere one line. */
export function ReleasePanel(props: { disabled?: boolean; onPromoted?: () => void }) {
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // the version the person pressed the button for, while running Tasks hold it (see pendingForce)
  const [confirming, setConfirming] = useState<PromoteTarget | null>(null);
  useEffect(() => {
    const load = () => api.release().then(setRelease).catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000); // a promotion ends in a restart: keep asking until the result is in the history
    return () => clearInterval(timer);
  }, []);
  const view = releasePanel(release);
  if (!view) return null;
  const target = view.release;
  // The commit on the button is the commit that is sent: HEAD may have moved since the last poll. A public copy's clone sends the tag (#4569).
  const current = promoteTarget(release, view);
  const forcing = pendingForce(confirming, current);
  const send = (commit: string, force: boolean) => {
    setConfirming(null);
    api
      .promote(commit, force)
      .then((r) => {
        setMsg(t(settings.promoteStarted, { sha: shortSha(r.commit) }));
        props.onPromoted?.();
      })
      .catch((e) => setMsg(String(e.message ?? e)));
  };
  // A version with a concern, or one that could not be checked, goes up only after the person has read why and said OK.
  const press = () => {
    if (!current) return;
    if (target?.confirm && !window.confirm(target.confirm)) return;
    if (view.busyTasks > 0) setConfirming(current);
    else send(current.commit, false);
  };
  const recheck = () =>
    api
      .recheckRelease()
      .then((r) => setMsg(t(settings.recheckStarted, { tag: r.tag })))
      .catch((e) => setMsg(String(e.message ?? e)));
  const label = !target ? null : target.state === "concern" ? settings.releaseUpdateConcern : target.state === "failed" ? settings.releaseUpdateUnchecked : settings.releaseUpdate;
  return (
    <div id="release-panel">
      {view.lines.map((l, i) => (
        <div key={i} className={l.warn ? "hint warn" : "hint"}>{l.text}</div>
      ))}
      {target?.taskLink && (
        <div className="hint">
          <a href={target.taskLink}>{t(settings.reviewTask)}</a>
        </div>
      )}
      {release?.managed && (
        <div className="actions" style={{ marginTop: 6 }}>
          {target && label ? (
            <>
              <button className="pri" disabled={props.disabled || !view.canPromote} onClick={press} title={t(settings.releaseUpdateTitle)}>
                {t(label, { tag: target.tag })}
              </button>
              {target.canReview && (
                <button className="ghost" disabled={props.disabled || !!release.busy} onClick={recheck}>{t(settings.recheck)}</button>
              )}
            </>
          ) : (
            <button className="pri" disabled={props.disabled || !view.canPromote} onClick={press} title={t(settings.promoteTitle)}>
              {view.promoteSha ? t(settings.promoteButton, { sha: shortSha(view.promoteSha) }) : t(settings.promoteButtonNone)}
            </button>
          )}
        </div>
      )}
      {release?.managed && view.busyTasks > 0 && <div className="hint">{t(settings.promoteBusy, { n: view.busyTasks })}</div>}
      {forcing && (
        <div className="actions" style={{ marginTop: 6 }}>
          <button className="pri" disabled={props.disabled || !view.canPromote} onClick={() => send(forcing, true)}>{t(settings.promoteNow)}</button>
          <button className="ghost" onClick={() => setConfirming(null)}>{t(settings.cancel)}</button>
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
