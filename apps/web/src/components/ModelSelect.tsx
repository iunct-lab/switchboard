import { useEffect, useState } from "react";
import type { RunnerInfo } from "@switchboard/protocol";
import { modelOptions } from "../modelOptions.ts";
import { runnerLabel } from "../runners.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";

const TYPE_IT = "\u0000type"; // never a model name

/**
 * Model select (#155), used for a new task, for the routing turns and on a running task. The label is part of every
 * option ("モデル: …" / "自動選択のモデル: …") because two of these sit in one row on Home. 手入力… swaps the select
 * for a text field (Enter / blur commits; empty or Esc goes back), for a model the adapter's list does not have.
 */
export function ModelSelect(props: { runner: RunnerInfo | undefined; value: string; onChange: (model: string) => void; label: string; disabled?: boolean; title?: string }) {
  const [typing, setTyping] = useState(false);
  useEffect(() => setTyping(false), [props.runner?.id]);
  if (props.runner && props.runner.models.length === 0) return <span className="hint">{t(home.setByRunner, { label: props.label, runner: runnerLabel(props.runner.id, props.runner) })}</span>;
  if (typing) {
    const commit = (v: string) => {
      setTyping(false);
      if (v.trim() && v.trim() !== props.value) props.onChange(v.trim());
    };
    return (
      <input
        className="model"
        autoFocus
        defaultValue={props.value}
        placeholder={t(home.typePlaceholder, { label: props.label })}
        aria-label={t(home.typedLabel, { label: props.label })}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
          if (e.key === "Escape") setTyping(false);
        }}
      />
    );
  }
  return (
    <select className="model-select" value={props.value} disabled={props.disabled} aria-label={props.label} title={props.title} onChange={(e) => (e.target.value === TYPE_IT ? setTyping(true) : props.onChange(e.target.value))}>
      {modelOptions(props.runner, props.value).map((o) => (
        <option key={o.value} value={o.value}>
          {props.label}: {o.label}
        </option>
      ))}
      <option value={TYPE_IT}>{t(home.typeIt)}</option>
    </select>
  );
}
