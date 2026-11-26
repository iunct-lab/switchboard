import type { ReactNode } from "react";
import type { Ask } from "@switchboard/protocol";
import { t } from "../i18n.ts";
import { panels as m } from "../i18n/panels.ts";
import { waitChoices, type waitGroups } from "../asks.ts";

/** A wait past its limit that a heading's button could not answer: the question's id, and the line that says so. */
export interface WaitFailure { id: string; text: string }

/**
 * The waits past their limit, a heading per kind of wait (`waitGroups` of asks.ts): how many, the buttons that answer
 * every question under the heading with one press, then a card per question with its own two buttons and the link to
 * its Task. `onAnswerAll` gets the questions under the heading as they were drawn when the button was pressed.
 */
export function WaitGroups(props: { groups: ReturnType<typeof waitGroups>; busy: boolean; failures: WaitFailure[]; answered: ReadonlyMap<string, unknown>; card: (x: Ask) => ReactNode; onAnswerAll: (shown: Ask[], which: "stop" | "keep") => void; onOpenTask: (id: string) => void }) {
  return (
    <>
      {props.groups.map((g) => {
        // the heading answers only the waits not yet answered from their own card
        const open = g.asks.filter((x) => !props.answered.has(x.id));
        return (
          <div key={g.kind} className="ask-waits" data-wait-kind={g.kind}>
            <div className="ask-wait-head">
              <h6>
                {g.label} <span className="hint">{g.asks.length}</span>
              </h6>
              <div className="ask-wait-actions">
                {open.length > 0 && open.every((x) => waitChoices(x)?.keep != null) && (
                  <button className="pri" disabled={props.busy} onClick={() => props.onAnswerAll(open, "keep")}>
                    {t(m.waitKeepAll, { n: open.length })}
                  </button>
                )}
                {open.length > 0 && (
                  <button disabled={props.busy} onClick={() => props.onAnswerAll(open, "stop")}>
                    {t(m.waitStopAll, { n: open.length })}
                  </button>
                )}
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
        );
      })}
    </>
  );
}
