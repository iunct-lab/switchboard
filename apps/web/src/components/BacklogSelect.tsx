import { createContext, useContext, useState } from "react";
import type { BacklogItem, BacklogQueue, BacklogQueueEntry } from "@switchboard/protocol";
import { pickTop, queueFacts, queueSections, type PickAxis } from "../backlogQueue.ts";
import { selectable, selectedOf } from "../backlogSelect.ts";
import { itemMarks } from "../backlogView.ts";
import { t } from "../i18n.ts";
import { backlog as m } from "../i18n/backlog.ts";
import { IssueLink } from "./BacklogOwner.tsx";

/** The rows chosen on the Backlog (in the order chosen) and the toggle every row's box uses. The one place the choice lives: `Backlog` holds the state. */
export const Selection = createContext<{ selected: BacklogQueueEntry[]; toggle: (e: BacklogQueueEntry) => void }>({ selected: [], toggle: () => undefined });

/** The box at the start of a row; nothing for a row that cannot be chosen (a decision card, a request). */
export function SelectBox(props: { item: BacklogItem }) {
  const { selected, toggle } = useContext(Selection);
  const { item: i } = props;
  if (!selectable(i)) return null;
  const on = selected.some((e) => e.workspaceId === i.workspaceId && e.number === i.number);
  return <input type="checkbox" className="select-box" data-select={`${i.workspaceId}:${i.number}`} aria-label={t(m.selectBox)} checked={on} onChange={() => toggle({ workspaceId: i.workspaceId, number: i.number })} />;
}

/**
 * The bar at the foot of the screen while anything is chosen: the count, 「キューに入れる」, the clear button and `children`
 * (the bundle button and its reason). 「キューに入れる」 stays off until the save it started is answered (and, when it
 * failed, the queue is read back): until then the queue shown still holds rows that may not have been saved.
 */
export function SelectBar(props: { count: number; canQueue: boolean; onQueue: () => Promise<void> | void; onClear: () => void; children?: React.ReactNode }) {
  const [saving, setSaving] = useState(false);
  const queue = () => {
    const sent = props.onQueue();
    if (!sent) return;
    setSaving(true);
    void sent.finally(() => setSaving(false));
  };
  if (props.count === 0) return null;
  return (
    <div className="select-bar" data-select-bar>
      <span data-select-count={props.count}>{t(m.selectCount, { n: props.count })}</span>
      <button className="queue-btn" data-select-queue disabled={!props.canQueue || saving} onClick={queue}>
        {t(m.selectQueue)}
      </button>
      {props.children}
      <button className="ghost queue-btn" data-select-clear onClick={props.onClear}>
        {t(m.selectClear)}
      </button>
    </div>
  );
}

/** The queue view's card of PBIs not in the queue: a row each with its box, and 「条件で選ぶ」, which only marks rows (the queue changes when 「キューに入れる」 is pressed in the bar). */
export function QueueOutside(props: { queue: BacklogQueue; items: BacklogItem[]; inView: (workspaceId: string) => boolean; auto: Record<string, boolean>; onSelect: (entries: BacklogQueueEntry[]) => void }) {
  const { queue, items } = props;
  const outside = queueSections(queue, items).outside.filter((i) => props.inView(i.workspaceId));
  // by what to put first and how many (not kept: a choice made now and then)
  const [axis, setAxis] = useState<PickAxis>("priority");
  const [count, setCount] = useState(5);
  const [withWaitingOnes, setWithWaitingOnes] = useState(false);
  const pick = () => props.onSelect(selectedOf(pickTop(items.filter((i) => props.inView(i.workspaceId)), queue, axis, count, withWaitingOnes, (w) => props.auto[w] ?? false)));
  return (
    <section className="card queue">
      <div className="queue-h">
        {t(m.queueOutside)} <span className="hint">{t(m.queueOutsideHint)}</span>
      </div>
      <div className="queue-pick" data-queue-pick>
        <b className="hint">{t(m.queuePickLead)}</b>
        <label>
          {t(m.queuePickAxis)}{" "}
          <select data-queue-pick-axis value={axis} onChange={(e) => setAxis(e.target.value as PickAxis)}>
            <option value="priority">{t(m.queuePickPriority)}</option>
            <option value="progress">{t(m.queuePickProgress)}</option>
            <option value="small">{t(m.queuePickSmall)}</option>
            <option value="old">{t(m.queuePickOld)}</option>
          </select>
        </label>
        <label>
          {t(m.queuePickCount)}{" "}
          <select data-queue-pick-count value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[3, 5, 8, 12].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" data-queue-pick-waiting checked={withWaitingOnes} onChange={(e) => setWithWaitingOnes(e.target.checked)} /> {t(m.queuePickWaiting)}
        </label>
        <button className="queue-btn" data-queue-pick-add disabled={outside.length === 0} onClick={pick}>
          {t(m.queuePickSelect)}
        </button>
      </div>
      {outside.length === 0 && <div className="muted">{t(m.none)}</div>}
      <div className="queue-list">
        {outside.map((i) => (
          <div key={`${i.workspaceId}:${i.number}`} className="queue-row" data-outside={`${i.workspaceId}:${i.number}`}>
            <div className="queue-main">
              <div className="queue-body">
                <div className="queue-title">
                  <SelectBox item={i} /> <IssueLink url={i.url}>#{i.number}</IssueLink> {i.title}
                </div>
                <div className="queue-facts">
                  <span>{queueFacts(i)}</span>
                  {itemMarks(i, props.auto[i.workspaceId] ?? false).map((x) => (
                    <span key={x.key} className={"mark" + (x.warn ? " warn" : "")} data-mark={x.key}>
                      {x.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
