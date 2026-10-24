import type { StopSummary } from "@switchboard/protocol";
import { shownStops, stopDisplay } from "../stops.ts";

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
            <summary>停止: {d.title}（{d.count}）— {d.next}</summary>
            <div>前回の回答: {d.answer}</div>
            <div>前回からの変化: {d.changes}</div>
            <div>理由: {d.evidence}</div>
            {d.actions.map((a) => (
              <div key={a}>実施済み: {a}</div>
            ))}
          </details>
        );
      })}
    </div>
  );
}
