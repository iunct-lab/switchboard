import type { Preset, PresetList, PresetScene, PresetUse } from "@switchboard/protocol";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";

/* 定型の指示 (#940): what the settings list and the pickers show of a saved instruction. */

/** The text has the slot the chosen Issue / PR goes in (the daemon's `{{target}}`, written exactly so). */
export const usesTarget = (p: Pick<Preset, "text">) => p.text.includes("{{target}}");

const HEAD_MAX = 80;

/** One settings row: the name, the text's first line (cut at 80 characters) and whether a target is chosen when sending. */
export function presetRow(p: Pick<Preset, "name" | "text">): { name: string; head: string; target: string } {
  const first = p.text.split("\n", 1)[0]!;
  const head = first.length > HEAD_MAX ? `${first.slice(0, HEAD_MAX)}…` : first;
  return { name: p.name, head, target: usesTarget(p) ? t(home.presetTarget) : t(home.presetNoTarget) };
}

/** The request box's state: its workspace and its text. */
type Box = { workspaceId: string | null; text: string };

/**
 * True when the text put in from a preset is still in the box as it was, but the workspace changed since: it names the
 * other workspace's repository, so it is not sent until put in again. A text edited by hand is the user's and is not held.
 */
export const staleDraft = (draft: Box | null, now: Box) => !!draft && draft.text === now.text && draft.workspaceId !== now.workspaceId;

let loaded: Promise<PresetList> | null = null;
/** The list and its use counts, read once (the first time a box takes the cursor) and reused after; a failed read is asked again next time. */
export function loadPresets(read: () => Promise<PresetList> = () => api.presets()): Promise<PresetList> {
  if (!loaded) {
    const p = read();
    loaded = p;
    p.catch(() => { if (loaded === p) loaded = null; });
  }
  return loaded;
}
/** Settings changed the list: the next box that takes the cursor reads it again. */
export const forgetPresets = () => { loaded = null; };

const SUGGEST_MAX = 3;
const TYPED_MAX = 40;
const TYPED_MIN = 2;

/**
 * The presets offered over a box: the most used in this scene first (the last 14 days), then the latest used, then the latest
 * edited. A box with nothing in it offers the first 3; typed text (trimmed) of 2 or more characters keeps those whose name or text holds it (any case), 3 at most; blanks only or 1 character offers nothing. Text that
 * has a line break or is over 40 characters is a request being written, not a name being looked for: nothing is offered.
 */
export function suggestPresets(list: Preset[], uses: PresetUse[], scene: PresetScene, text: string): Preset[] {
  if (text.includes("\n") || text.length > TYPED_MAX) return [];
  const q = text.trim().toLowerCase();
  if (text && q.length < TYPED_MIN) return []; // blanks only, or 1 character: not yet a name being looked for (Tab out of the box must not replace it)
  const by = new Map(uses.map((u) => [u.id, u]));
  const count = (p: Preset) => by.get(p.id)?.[scene] ?? 0;
  const last = (p: Preset) => by.get(p.id)?.lastAt ?? 0;
  return list
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q))
    .sort((a, b) => count(b) - count(a) || last(b) - last(a) || b.updatedAt - a.updatedAt)
    .slice(0, SUGGEST_MAX);
}

/** The name split around the first place `text` is found (any case), for marking the matched characters. */
export function markMatch(name: string, text: string): [string, string, string] {
  const q = text.trim();
  const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? [name, "", ""] : [name.slice(0, i), name.slice(i, i + q.length), name.slice(i + q.length)];
}
