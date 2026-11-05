import { useSyncExternalStore } from "react";

// 「プレビュー / テキスト」(#3677): how Markdown is shown — runner replies on the 会話 tab and .md artifacts. One value in
// this browser's localStorage, shared by every part of the page through one subscription (a reading preference of this
// device, not a server setting). Another tab changing it arrives as a `storage` event.

export type MdView = "preview" | "text";
export const MD_VIEW_KEY = "sb.mdView";

/** The stored view; unset or unknown values read as the default, "preview". */
export function readMdView(get: (k: string) => string | null): MdView {
  return get(MD_VIEW_KEY) === "text" ? "text" : "preview";
}

const listeners = new Set<() => void>();
/** The choice made on this page. It is what the page shows even when the storage refuses to keep it (full, blocked). */
let chosen: MdView | null = null;

function stored(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function setMdView(v: MdView): void {
  chosen = v;
  try {
    localStorage.setItem(MD_VIEW_KEY, v);
  } catch {
    // storage full or blocked: the page switches all the same, only a reload forgets it
  }
  for (const l of listeners) l();
}

/** What the page shows now: this page's choice, else the stored one. */
export function mdViewSnapshot(): MdView {
  return chosen ?? readMdView(stored);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // another tab's choice wins over this page's earlier one
  const onStorage = (e: StorageEvent) => { if (e.key === MD_VIEW_KEY || e.key === null) { chosen = null; onChange(); } };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useMdView(): [MdView, (v: MdView) => void] {
  const view = useSyncExternalStore(subscribe, mdViewSnapshot, () => "preview" as const);
  return [view, setMdView];
}
