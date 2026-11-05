import type { StopSummary } from "@switchboard/protocol";
import { shownStops, stopDisplay } from "../stops.ts";
import { t } from "../i18n.ts";
import { task as m } from "../i18n/task.ts";

/** The stops of a row's stage Tasks (#939): how many times, the last answer, what changed and what is needed next; none when it never stopped. */
export function Stops(props: { stops: StopSummary[]; issue: string }) {
  const shown = shownStops(props.stops);
  if (!shown.length) return null;
  return (
    <div className="backlog-stops hint" data-issue={props.issue}>
      {shown.map((st) => {
        const d = stopDisplay(st);
        return (
          <details key={d.key} open={d.needsPerson} className={d.needsPerson ? "warn" : undefined}>
            <summary>{t(m.stopSummary, { title: d.title, count: d.count, next: d.next })}</summary>
            <div>{t(m.stopPrevAnswer, { answer: d.answer })}</div>
            <div>{t(m.stopChanges, { changes: d.changes })}</div>
            <div>{t(m.stopReason, { evidence: d.evidence })}</div>
            {d.actions.map((a) => (
              <div key={a}>{t(m.stopDone, { action: a })}</div>
            ))}
          </details>
        );
      })}
    </div>
  );
}
