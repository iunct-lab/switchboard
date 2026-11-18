import { useEffect, useRef, useState } from "react";
import type { PresetReply } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { shortReply, UNDO_MS } from "../presetReplies.ts";
import { t } from "../i18n.ts";
import { task as m } from "../i18n/task.ts";

/**
 * What the person answered to the same kind of stop before, as 1-3 one-press buttons in one line (nothing is drawn
 * without replies, so a Task that is not stopped takes no height). A press shows 「…を送ります… 取り消す」 for
 * `UNDO_MS`; if it is not cancelled the preset is recorded (expand) and its text is sent. One wait at a time. Leaving
 * the screen (or the row) during the wait sends at once: not cancelling is what sends, so a press is never dropped unseen.
 */
export function PresetReplies(props: { taskId: string; replies: PresetReply[]; onSend: (text: string) => Promise<void>; onError: (msg: string) => void }) {
  const { taskId, replies, onSend, onError } = props;
  const [waiting, setWaiting] = useState<PresetReply | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // the send of the pending press, for the unmount below to run at once
  const pending = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      void pending.current?.();
    };
  }, []);
  if (replies.length === 0 && !waiting) return null;
  const press = (r: PresetReply) => {
    if (waiting) return;
    setWaiting(r);
    const send = async () => {
      pending.current = null;
      try {
        const x = await api.expandPreset(r.id, { scene: "task", taskId });
        await onSend(x.text);
      } catch (e) {
        onError(String((e as Error).message ?? e));
      } finally {
        if (mounted.current) setWaiting(null);
      }
    };
    pending.current = send;
    timer.current = setTimeout(() => {
      timer.current = null;
      void send();
    }, UNDO_MS);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    setWaiting(null);
  };
  return (
    <div className="preset-replies" role="group" aria-label={t(m.presetRepliesLabel)}>
      {waiting ? (
        <>
          <span className="hint" title={waiting.text}>{t(m.presetReplySending, { text: shortReply(waiting.text) })}</span>
          <button onClick={cancel}>{t(m.presetReplyUndo)}</button>
        </>
      ) : (
        replies.map((r) => (
          <button key={r.id} onClick={() => press(r)} title={r.text}>
            {shortReply(r.text)}
          </button>
        ))
      )}
    </div>
  );
}
