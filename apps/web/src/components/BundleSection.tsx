import { useEffect, useState } from "react";
import type { BundleHold, Task } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { canStartBundle, holdLine, parsePbiNumbers, unreadableHold } from "../bundle.ts";
import { t } from "../i18n.ts";
import { bundle as m } from "../i18n/bundle.ts";

/** The hold a bundle has put on the daemon, read when the Backlog loads (`reloadKey` changes); null = none (or not readable yet). */
export function useBundleHold(reloadKey: unknown): [BundleHold | null, (h: BundleHold | null) => void] {
  const [hold, setHold] = useState<BundleHold | null>(null);
  useEffect(() => {
    api.bundleHold().then(setHold).catch(() => undefined);
  }, [reloadKey]);
  return [hold, setHold];
}

/** The folded section that starts a bundle of PBIs; it cannot be started while a hold stands. */
export function BundleStart(props: { hold: BundleHold | null; onStarted: (task: Task) => void; onChanged: () => void; onError: (msg: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const nums = parsePbiNumbers(text);
  const start = () => {
    setBusy(true);
    api
      .startBundle(nums)
      .then((task) => {
        setText("");
        props.onChanged();
        props.onStarted(task);
      })
      .catch((e) => {
        // a hold placed elsewhere (409) shows here at once, not at the next reload
        props.onChanged();
        props.onError(t(m.startFailed, { error: String(e.message ?? e) }));
      })
      .finally(() => setBusy(false));
  };
  return (
    <details className="backlog-new">
      <summary>
        {t(m.sectionTitle)}
        {props.hold && ` — ${t(m.sectionHeld)}`}
      </summary>
      <div className="hint">{t(m.hint)}</div>
      <input value={text} placeholder="5232, 5233" aria-label={t(m.inputLabel)} disabled={busy || props.hold !== null} onChange={(e) => setText(e.target.value)} />
      <div className="hint">{t(m.inputHint)}</div>
      <button className="pri" disabled={busy || !canStartBundle(nums, props.hold)} onClick={start}>
        {t(m.start)}
      </button>
    </details>
  );
}

/** Shown only while a hold stands, and not folded: schedules and promotion are stopped. Releasing asks once. */
export function BundleHoldLine(props: { hold: BundleHold | null; now: number; onOpenTask: (id: string) => void; onReleased: () => void; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!props.hold) return null;
  const hold = props.hold;
  const release = () => {
    if (!window.confirm(t(m.releaseConfirm, { n: hold.schedules.length }))) return;
    setBusy(true);
    api
      .releaseBundle()
      .then(props.onReleased)
      .catch((e) => props.onError(t(m.releaseFailed, { error: String(e.message ?? e) })))
      .finally(() => setBusy(false));
  };
  return (
    <div className="hint backlog-hold" data-bundle-hold>
      {holdLine(hold, props.now)}{" "}
      {!unreadableHold(hold) && (
        <button className="ghost link" onClick={() => props.onOpenTask(hold.taskId)}>
          {t(m.openTask)}
        </button>
      )}{" "}
      <button className="ghost" disabled={busy} onClick={release}>
        {t(m.release)}
      </button>
    </div>
  );
}

/** The bundle's two parts for the Backlog: the hold line (only while a hold stands) and the folded section that starts one. */
export function BundleSection(props: { reloadKey: unknown; now: number; onOpenTask: (id: string) => void; onStarted: (task: Task) => void; onReleased: () => void; onError: (msg: string) => void }) {
  const [hold, setHold] = useBundleHold(props.reloadKey);
  const reread = () => api.bundleHold().then(setHold).catch(() => undefined);
  return (
    <>
      <BundleHoldLine hold={hold} now={props.now} onOpenTask={props.onOpenTask} onReleased={() => {
          setHold(null);
          // the promotion line and the schedules' state change with the hold
          props.onReleased();
        }} onError={props.onError} />
      <BundleStart hold={hold} onStarted={props.onStarted} onChanged={reread} onError={props.onError} />
    </>
  );
}
