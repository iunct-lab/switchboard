import type { ReactNode } from "react";
import type { Ask } from "@switchboard/protocol";
import { t } from "../i18n.ts";
import { panels as m } from "../i18n/panels.ts";
import type { waitGroups } from "../asks.ts";

/** A wait past its limit that a heading's button could not answer: the question's id, and the line that says so. */
export interface WaitFailure { id: string; text: string }

/**
 * The waits past their limit, a heading per kind of wait (`waitGroups` of asks.ts): how many, the two buttons that answer
 * every question under the heading with one press, then a card per question with its own two buttons and the link to
 * its Task. `onAnswerAll` gets the questions under the heading as they were drawn when the button was pressed.
 */
export function WaitGroups(props: { groups: ReturnType<typeof waitGroups>; busy: boolean; failures: WaitFailure[]; card: (x: Ask) => ReactNode; onAnswerAll: (shown: Ask[], which: "stop" | "keep") => void; onOpenTask: (id: string) => void }) {
  return (
    <>
      {props.groups.map((g) => (
        <div key={g.kind} className="ask-waits" data-wait-kind={g.kind}>
          <div className="ask-wait-head">
            <h6>
              {g.label} <span className="hint">{g.asks.length}</span>
            </h6>
            <div className="ask-wait-actions">
              <button className="pri" disabled={props.busy} onClick={() => props.onAnswerAll(g.asks, "keep")}>
                {t(m.waitKeepAll, { n: g.asks.length })}
              </button>
              <button disabled={props.busy} onClick={() => props.onAnswerAll(g.asks, "stop")}>
                {t(m.waitStopAll, { n: g.asks.length })}
              </button>
            </div>
          </div>
          {g.asks.map((x) => {
            const taskId = x.source.taskId ?? x.task?.id ?? null;
            return (
              <div key={x.id}>
                {props.card(x)}
                {props.failures.filter((f) => f.id === x.id).map((f) => (
                  <div key={f.id} className="hint warn ask-wait-failed">
                    {f.text}
                  </div>
                ))}
                {taskId && (
                  <div className="ask-links">
                    <button className="ghost link" onClick={() => props.onOpenTask(taskId)}>
                      {t(m.openTask)}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
