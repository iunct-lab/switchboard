import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Preset, PresetList, PresetScene } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { loadPresets, markMatch, presetRow, suggestPresets, usesTarget } from "../presets.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";

/** `text` with the part `query` matched in a `mark`. */
function Marked(props: { text: string; query: string }) {
  const [a, m, b] = markMatch(props.text, props.query);
  return <>{a}{m && <mark>{m}</mark>}{b}</>;
}

/** True when the list `el` does not fit above `box` inside its scrolling area: it lies over what is under the box instead. */
export function overlayBelow(box: HTMLElement, el: HTMLElement): boolean {
  let top = 0;
  for (let n = box.parentElement; n; n = n.parentElement) {
    if (/(auto|scroll|hidden)/.test(getComputedStyle(n).overflowY)) { top = n.getBoundingClientRect().top; break; }
  }
  return box.getBoundingClientRect().top - top < el.offsetHeight + 8;
}

/**
 * 定型の指示 over the request and reply boxes: it wraps the box (`children` is its textarea) and adds nothing around it.
 * When the box takes the cursor, the 3 presets sent most in this scene lie over the top of the box (nothing below moves);
 * typing narrows them by name and text (when there is no room above the box, they lie over what is under it); Tab or a press puts the expanded text in the box. A preset with a target asks for
 * it where the list was, and Enter puts it in. Nothing is sent from here: sending is the box's own 開始 / 送信, and the
 * approval mode stays the box's choice. The list is read once, when the box first takes the cursor (opening Home or a Task
 * costs no request) and reused until Settings changes a preset. No "/": that belongs to the runner's commands and skills.
 */
export function PresetPicker(props: { scene: PresetScene; taskId?: string; workspaceId: string | null; text: string; onText: (text: string, title: string) => void; onError: (msg: string) => void; children: ReactNode }) {
  const { scene, taskId, workspaceId, text, onText, onError } = props;
  const [data, setData] = useState<PresetList | null>(null);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false); // closed by Esc or by putting a text in, until the box is emptied
  const [composing, setComposing] = useState(false);
  const [sel, setSel] = useState(0);
  const [moved, setMoved] = useState(false); // the arrows were used since the text last changed: Tab then takes the chosen preset
  const [asking, setAsking] = useState<Preset | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const over = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false); // not enough room above the box inside its scrolling area: lie over what is under it instead
  const put = useRef<string | null>(null); // the text this picker last put in the box: while the box still holds it, leaving and coming back offers nothing
  const textarea = () => box.current?.querySelector("textarea") ?? null;
  useEffect(() => {
    if (!text) setHidden(false);
    if (text !== put.current) put.current = null;
    setSel(0);
    setMoved(false);
    setError(null);
  }, [text]);
  const list = data ? suggestPresets(data.presets, data.uses, scene, text) : [];
  const shown = !asking && focused && !hidden && !composing && list.length > 0;
  const at = Math.min(sel, Math.max(list.length - 1, 0));
  useLayoutEffect(() => {
    const el = over.current;
    if (!el || !box.current) return;
    setBelow(overlayBelow(box.current, el));
  }, [shown, asking, list.length, error]);
  const close = () => {
    setHidden(true);
    setAsking(null);
    setMoved(false);
  };
  const expand = async (p: Preset, to: string | undefined) => {
    setError(null);
    try {
      const r = await api.expandPreset(p.id, { workspaceId: workspaceId ?? undefined, target: to, scene, taskId });
      textarea()?.focus(); // before the target field goes, so the focus stays inside
      close();
      put.current = r.text;
      onText(r.text, r.title);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const choose = (p: Preset) => {
    if (usesTarget(p)) {
      setAsking(p);
      setTarget("");
      setError(null);
    } else void expand(p, undefined);
  };
  const enter = () => {
    if (!asking) return;
    if (!target.trim()) return setError(t(home.needTarget));
    if (!workspaceId) return setError(t(home.needWorkspace));
    void expand(asking, target.trim());
  };
  const why = asking && !target.trim() ? t(home.needTarget) : asking && !workspaceId ? t(home.needWorkspace) : null;
  return (
    <div
      ref={box}
      className="preset-box"
      onFocus={(e) => {
        if (e.target instanceof HTMLTextAreaElement) {
          setFocused(true);
          loadPresets().then(setData).catch((err) => onError(t(home.presetsUnreadable, { error: String(err.message ?? err) })));
        }
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setFocused(false);
        if (text !== put.current) setHidden(false);
        setMoved(false);
        setAsking(null);
      }}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onKeyDownCapture={(e) => {
        if (!(e.target instanceof HTMLTextAreaElement) || e.nativeEvent.isComposing || !shown) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setMoved(true);
          setSel((at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        } else if (e.key === "Tab" && !e.shiftKey && (moved || (!!text && list[at]!.name.toLowerCase().includes(text.trim().toLowerCase())))) {
          // without the arrows, Tab takes a preset only when the typed text is in its name: a short reply that only matches
          // some preset's text ("OK" in "token") is left as typed, and Tab moves on
          e.preventDefault();
          choose(list[at]!);
        }
      }}
    >
      {props.children}
      {shown && (
        <div ref={over} className={`preset-suggest${below ? " below" : ""}`} role="listbox" aria-label={t(home.presetLabel)} onMouseDown={(e) => e.preventDefault()}>
          {list.map((p, i) => (
            <button key={p.id} type="button" role="option" tabIndex={-1} aria-selected={i === at} className="preset-opt" data-preset={p.id} onClick={() => choose(p)}>
              <span className="preset-name"><Marked text={p.name} query={text} /></span>
              <span className="preset-head"><Marked text={presetRow(p).head} query={text} /></span>
            </button>
          ))}
          {error && <div className="hint warn" role="alert">{error}</div>}
        </div>
      )}
      {asking && (
        <div ref={over} className={`preset-suggest preset-target${below ? " below" : ""}`} role="group" aria-label={asking.name} onMouseDown={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
          <span className="preset-name">{asking.name}</span>
          <span className="preset-head">{presetRow(asking).head}</span>
          <input
            autoFocus
            aria-label={t(home.targetLabel)}
            value={target}
            placeholder="#12 / owner/name#12 / URL"
            onChange={(e) => { setTarget(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") { e.preventDefault(); enter(); }
              else if (e.key === "Escape") { e.preventDefault(); textarea()?.focus(); close(); }
            }}
          />
          <div className={`hint${error ? " warn" : ""}`} role={error ? "alert" : undefined}>{error ?? why}</div>
        </div>
      )}
    </div>
  );
}
