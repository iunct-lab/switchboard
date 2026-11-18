import { useEffect, useRef, useState } from "react";
import type { Task, TaskSummary } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { canArchive, forkSides, type ForkSide } from "../forkCompare.ts";
import { jstDateTime } from "../time.ts";
import { Markdown } from "./Markdown.tsx";
import { RunnerPill } from "./ui.tsx";
import { t } from "../i18n.ts";
import { brief as m } from "../i18n/brief.ts";
import { task as tm } from "../i18n/task.ts";

const END_LABEL = { ok: tm.statusDone, aborted: tm.statusAborted, error: tm.sinceError } as const;

/**
 * 並べて見る: a fork's parent and one of its forks, two columns over the Task screen. Each column shows what that
 * Task did after the fork (forkCompare.ts) and can archive it on the spot with the Task screen's own archive call.
 * `forks` are the parent's forks in the order made; `childId` is the one on the right first.
 */
export function ForkCompare(props: { parent: TaskSummary; forks: TaskSummary[]; childId: string; onOpenTask: (id: string) => void; onTask: (t: Task) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [childId, setChildId] = useState(props.childId);
  const child = props.forks.find((c) => c.id === childId) ?? props.forks[0];
  const [sides, setSides] = useState<[ForkSide, ForkSide] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // read again when either side moves on (a turn ends, a status changes): the Task list brings updatedAt
  const stamp = `${props.parent.id}:${props.parent.updatedAt}:${child?.id}:${child?.updatedAt}`;
  useEffect(() => {
    if (!child) return;
    let stale = false;
    // the child whole, then the parent from the fork point on (the child's own row names it; the Task list does not carry it): never cut to the last page
    api
      .taskSince(child.id, 0)
      .then(async (c) => [await api.taskSince(props.parent.id, c.task.forkSeq ?? 0), c] as const)
      .then(([p, c]) => !stale && (setSides(forkSides(p, c)), setError(null)))
      .catch((e) => !stale && setError(String((e as Error).message ?? e)));
    return () => { stale = true; };
  }, [stamp]);

  const column = (task: TaskSummary, side: ForkSide | undefined, label: string) => {
    const archive = canArchive(task);
    return (
      <section className="fork-col" data-testid={`fork-col-${side?.role ?? "loading"}`}>
        <h3>
          {label} <RunnerPill runner={task.runner} />
        </h3>
        <div className="hint" title={task.title}>
          {side ? (side.turns === 0 ? t(m.forkNoTurn) : `${t(m.forkTurns, { n: side.turns })} · ${side.end ? t(m.forkEnd, { status: t(END_LABEL[side.end.status]), at: jstDateTime(side.end.at) }) : t(m.forkRunning)}`) : "…"}
        </div>
        <div className="fork-reply">{side && (side.lastReply ? <Markdown text={side.lastReply} /> : <span className="hint">{t(m.forkNoReply)}</span>)}</div>
        <div className="fork-actions">
          <button className="btn" onClick={() => { props.onClose(); props.onOpenTask(task.id); }}>{t(m.forkOpen)}</button>
          {task.archivedAt !== null ? (
            <span className="hint">{t(m.forkDropped)}</span>
          ) : (
            <>
              <button className="btn" disabled={!archive.ok} title={archive.reason} onClick={() => api.setArchived(task.id, true).then(props.onTask).catch((e) => setError(String((e as Error).message ?? e)))}>
                {t(m.forkDrop)}
              </button>
              {/* a disabled button's title does not show on a phone: the reason is also a line */}
              {!archive.ok && <span className="hint">{archive.reason}</span>}
            </>
          )}
        </div>
      </section>
    );
  };

  return (
    <dialog ref={dialog} className="fork-compare" aria-labelledby="fork-compare-title" onCancel={(e) => { e.preventDefault(); props.onClose(); }}>
      <header>
        <h2 id="fork-compare-title">{t(m.forkCompareTitle)}</h2>
        <button className="ghost" onClick={props.onClose}>{t(m.forkClose)}</button>
      </header>
      <div className="hint">{t(m.forkCompareHint)}</div>
      {props.forks.length > 1 && (
        <label className="fork-pick">
          {t(m.forkPick)}{" "}
          <select value={child?.id} onChange={(e) => { setSides(null); setChildId(e.target.value); }}>
            {props.forks.map((c, i) => (
              <option key={c.id} value={c.id}>{t(m.forkSideChild, { n: i + 1 })} · {c.title}</option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="hint err" role="alert">{error}</div>}
      {child && (
        <div className="fork-cols">
          {column(props.parent, sides?.[0], t(m.forkSideParent))}
          {column(child, sides?.[1], t(m.forkSideChild, { n: props.forks.indexOf(child) + 1 }))}
        </div>
      )}
    </dialog>
  );
}
