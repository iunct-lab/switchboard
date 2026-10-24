import type { RunnerInfo } from "@switchboard/protocol";
import { effortOptions } from "../effortOptions.ts";

/**
 * Thinking-effort select (#833), for a new task, a new schedule and the default of the Tasks that start by themselves.
 * Like ModelSelect, every option carries the label ("思考の深さ: …") because it sits in a row of selects.
 */
export function EffortSelect(props: { runner: RunnerInfo | undefined; value: string; onChange: (effort: string) => void; label: string; disabled?: boolean; title?: string }) {
  if (props.runner && props.runner.efforts.length === 0) return <span className="hint">{props.label}: DAK 側の設定で決まる</span>;
  return (
    <select className="model-select" value={props.value} disabled={props.disabled} aria-label={props.label} title={props.title} onChange={(e) => props.onChange(e.target.value)}>
      {effortOptions(props.runner, props.value).map((o) => (
        <option key={o.value} value={o.value}>
          {props.label}: {o.label}
        </option>
      ))}
    </select>
  );
}
