import { useEffect, useState } from "react";
import type { Preset } from "@switchboard/protocol";
import { api } from "../api.ts";
import { usesTarget } from "../presets.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";

/**
 * 定型の指示 (#940) in the request and reply boxes: pick a saved instruction, give the Issue / PR when it uses one, and
 * 「本文に入れる」 puts the daemon's expanded text in the box. Sending is the box's own 開始 / 送信 — nothing is sent from
 * here, and the approval mode stays the box's choice. The list is read when the picker is opened, not with the screen:
 * opening Home or a Task costs no request and no second layout.
 */
export function PresetPicker(props: { workspaceId: string | null; onText: (text: string, title: string) => void; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Preset[] | null>(null);
  const [id, setId] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { onError } = props;
  useEffect(() => {
    if (!open) return;
    api.presets().then((r) => setList(r.presets)).catch((e) => {
      onError(t(home.presetsUnreadable, { error: String(e.message ?? e) }));
      setOpen(false); // the button again, to retry
    });
  }, [open, onError]);
  if (!open || !list)
    return (
      <div className="preset-picker">
        <div className="preset-picker-row">
          <button className="ghost" disabled={open} onClick={() => setOpen(true)}>
            {t(home.presetsButton)}
          </button>
        </div>
      </div>
    );
  if (!list.length) return <div className="hint preset-picker">{t(home.noPresets)}</div>;
  const p = list.find((x) => x.id === id) ?? null;
  const needs = !!p && usesTarget(p);
  const why = !p ? t(home.choosePreset) : needs && !target.trim() ? t(home.needTarget) : needs && !props.workspaceId ? t(home.needWorkspace) : null;
  const put = async () => {
    if (!p || why) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.expandPreset(p.id, { workspaceId: props.workspaceId ?? undefined, target: needs ? target.trim() : undefined });
      props.onText(r.text, r.title);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="preset-picker">
      <div className="preset-picker-row">
        <select aria-label={t(home.presetLabel)} value={id} onChange={(e) => { setId(e.target.value); setError(null); }}>
          <option value="">{t(home.presetsButton)}</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        {needs && <input aria-label={t(home.targetLabel)} value={target} onChange={(e) => { setTarget(e.target.value); setError(null); }} placeholder="#12 / owner/name#12 / URL" />}
        <button className="ghost" disabled={busy || !!why} title={why ?? t(home.putTitle)} onClick={() => void put()}>
          {t(home.put)}
        </button>
      </div>
      {p && why && <div className="hint">{why}</div>}
      {error && <div className="hint warn" role="alert">{error}</div>}
    </div>
  );
}
