import { useEffect, useRef, useState } from "react";
import type { BacklogItem, BundleHold, Task } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { holdLine, unreadableHold, type BundleGate } from "../bundle.ts";
import { sameRows } from "../backlogSelect.ts";
import { t } from "../i18n.ts";
import { bundle as m } from "../i18n/bundle.ts";

/** The hold a bundle has put on the daemon, read when the Backlog loads (`reloadKey` changes); null = none, undefined = not read yet (a failed read keeps what was read before). */
export function useBundleHold(reloadKey: unknown): [BundleHold | null | undefined, (h: BundleHold | null) => void] {
  const [hold, setHold] = useState<BundleHold | null | undefined>(undefined);
  useEffect(() => {
    api.bundleHold().then(setHold).catch(() => undefined);
  }, [reloadKey]);
  return [hold, setHold];
}

/** The button in the selection bar that opens the confirmation; disabled unless the gate is ok, and then the reason is a line under it. */
export function BundleButton(props: { gate: BundleGate; onOpen: () => void }) {
  const { gate } = props;
  return (
    <>
      <button className="queue-btn" data-select-bundle disabled={!gate.ok} onClick={props.onOpen}>
        {t(m.button)}
      </button>
      {!gate.ok && gate.reason && (
        <div className="hint select-reason" data-select-bundle-reason>
          {gate.reason}
        </div>
      )}
    </>
  );
}

/**
 * The bundle button with its confirmation. The confirmation belongs to the rows it showed when it opened: when the
 * selection or the gate changes under it (a reload took a row away, a hold appeared), it closes instead of starting
 * something other than what was read.
 */
export function BundleDoor(props: { chosen: BacklogItem[]; gate: BundleGate; onStarted: (task: Task) => void; onChanged: () => void; onError: (msg: string) => void }) {
  const [shown, setShown] = useState<BacklogItem[] | null>(null);
  const stale = shown !== null && (!props.gate.ok || !sameRows(shown, props.chosen));
  useEffect(() => {
    if (stale) setShown(null);
  }, [stale]);
  return (
    <>
      <BundleButton gate={props.gate} onOpen={() => setShown(props.chosen)} />
      {shown && !stale && <BundleConfirm items={shown} onClose={() => setShown(null)} onStarted={props.onStarted} onChanged={props.onChanged} onError={props.onError} />}
    </>
  );
}

/**
 * The confirmation before a bundle starts: the chosen PBIs by number and title, and the warning (schedules and
 * promotion stop) shown unfolded. 「やめる」 calls nothing; there is no field to type numbers in.
 */
export function BundleConfirm(props: { items: BacklogItem[]; onClose: () => void; onStarted: (task: Task) => void; onChanged: () => void; onError: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const start = () => {
    setBusy(true);
    api
      .startBundle(props.items.map((i) => i.number))
      .then((task) => {
        props.onChanged();
        props.onStarted(task);
        props.onClose();
      })
      .catch((e) => {
        // a hold placed elsewhere (409) shows here at once, not at the next reload
        props.onChanged();
        props.onError(t(m.startFailed, { error: String(e.message ?? e) }));
        props.onClose();
      })
      .finally(() => setBusy(false));
  };
  return (
    <dialog
      ref={dialog}
      className="bundle-confirm"
      data-bundle-confirm
      aria-labelledby="bundle-confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <h2 id="bundle-confirm-title">{t(m.confirmTitle)}</h2>
      <ul className="bundle-confirm-list">
        {props.items.map((i) => (
          <li key={`${i.workspaceId}:${i.number}`} data-bundle-item={i.number}>
            #{i.number} {i.title}
          </li>
        ))}
      </ul>
      <div className="bundle-confirm-warn" role="alert">
        {t(m.confirmWarn)}
      </div>
      <div className="hint">{t(m.confirmNote)}</div>
      <div className="bundle-confirm-actions">
        <button className="ghost" data-bundle-cancel disabled={busy} onClick={props.onClose}>
          {t(m.cancel)}
        </button>
        <button className="pri" data-bundle-start disabled={busy} onClick={start}>
          {t(m.start)}
        </button>
      </div>
    </dialog>
  );
}

/** Shown only while a hold stands, and not folded: schedules and promotion are stopped. Releasing asks once. */
export function BundleHoldLine(props: { hold: BundleHold | null | undefined; now: number; onOpenTask: (id: string) => void; onReleased: () => void; onError: (msg: string) => void }) {
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
