import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { RunnerCommand } from "@switchboard/protocol";
import { putCommand, readFor, slashOpen, slashQuery, slashView } from "../slashCommands.ts";
import { markMatch } from "../presets.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";
import { overlayBelow } from "./PresetPicker.tsx";

/** The rows (or the one failure line) for what the box holds; no state, so it can be rendered on its own. */
export function SlashList(props: { rows: RunnerCommand[] | null; query: string; at: number; onPick: (c: RunnerCommand) => void }) {
  if (!props.rows) return <div className="hint warn" role="alert">{t(home.slashFailed)}</div>;
  return (
    <>
      {props.rows.map((c, i) => {
        const [a, m, b] = markMatch(c.insert, props.query);
        return (
          <button key={`${i}:${c.insert}`} type="button" role="option" tabIndex={-1} aria-selected={i === props.at} className="preset-opt slash-opt" data-command={c.name} onClick={() => props.onPick(c)}>
            <span className="preset-name">{a}{m && <mark>{m}</mark>}{b}{c.argumentHint && <span className="slash-arg"> {c.argumentHint}</span>}</span>
            <span className="preset-head">{c.description}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * The runner's commands and skills over the request and reply boxes: it wraps the box (`children` is its textarea) and adds
 * nothing around it. While the box holds only a head word that starts with "/", the matching commands lie over the top of the
 * box (over what is under it when there is no room above), named and described, narrowed by what is typed. Up / Down choose;
 * Tab, Enter or a press puts what the runner says goes in (`insert`) and a space at the head of the box; Esc closes until the
 * text changes; nothing shows while an IME is composing. Nothing is sent from here. The list is read when "/" is first typed
 * (opening Home or a Task costs no request) and kept per runner and workspace; a read that fails shows one line and the box
 * works as before.
 */
export function SlashPicker(props: { runner: string | null; workspaceId: string | null; text: string; onText: (text: string) => void; children: ReactNode }) {
  // no runner = a box whose text does not reach the runner as typed (a Task started from a terminal, a cloud request): the box alone
  return props.runner === null ? <>{props.children}</> : <Picker {...props} runner={props.runner} />;
}

function Picker(props: { runner: string; workspaceId: string | null; text: string; onText: (text: string) => void; children: ReactNode }) {
  const { runner, workspaceId, text, onText } = props;
  const [loaded, setLoaded] = useState<{ key: string; data: RunnerCommand[] | Error } | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [below, setBelow] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const over = useRef<HTMLDivElement>(null);
  const key = `${runner}:${workspaceId ?? ""}`;
  const open = slashOpen(text);
  useEffect(() => {
    const read = readFor(text, runner, workspaceId);
    if (!read) return;
    let live = true;
    read.then(
      (data) => live && setLoaded({ key, data }),
      (e) => live && setLoaded({ key, data: e instanceof Error ? e : new Error(String(e)) }),
    );
    return () => { live = false; };
  }, [open, key]);
  useEffect(() => { if (!open) setLoaded(null); }, [open]); // a failure is asked again the next time "/" is typed
  useEffect(() => setSel(0), [text]);
  const view = slashView(text, loaded && loaded.key === key ? loaded.data : null);
  const shown = focused && !composing && closedFor !== text && view.kind !== "none";
  const rows = view.kind === "rows" ? view.rows : null;
  const at = Math.min(sel, Math.max((rows?.length ?? 1) - 1, 0));
  useLayoutEffect(() => {
    if (over.current && box.current) setBelow(overlayBelow(box.current, over.current));
    // keep the chosen row in sight by scrolling the list only (scrollIntoView would also move the page around the box)
    const list = over.current;
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && row) {
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [shown, rows?.length, at]);
  const pick = (c: RunnerCommand) => {
    onText(putCommand(text, c.insert));
    box.current?.querySelector("textarea")?.focus();
  };
  return (
    <div
      ref={box}
      className="preset-box"
      onFocus={(e) => { if (e.target instanceof HTMLTextAreaElement) setFocused(true); }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setFocused(false);
        setClosedFor(null);
      }}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onKeyDownCapture={(e) => {
        if (!(e.target instanceof HTMLTextAreaElement) || e.nativeEvent.isComposing || !shown || !rows) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setSel((at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setClosedFor(text);
        } else if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
          e.preventDefault();
          pick(rows[at]!);
        }
      }}
    >
      {props.children}
      {shown && (
        <div ref={over} className={`preset-suggest slash-suggest${below ? " below" : ""}`} role="listbox" aria-label={t(home.slashLabel)} onMouseDown={(e) => e.preventDefault()}>
          <SlashList rows={rows} query={slashQuery(text) ?? ""} at={at} onPick={pick} />
        </div>
      )}
    </div>
  );
}
