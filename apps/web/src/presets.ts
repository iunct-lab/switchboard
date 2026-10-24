import type { Preset } from "@switchboard/protocol";

/* 定型の指示 (#940, docs/design/presets.md): what the settings list and the pickers show of a saved instruction. */

/** The text has the slot the chosen Issue / PR goes in (the daemon's `{{target}}`, written exactly so). */
export const usesTarget = (p: Pick<Preset, "text">) => p.text.includes("{{target}}");

const HEAD_MAX = 80;

/** One settings row: the name, the text's first line (cut at 80 characters) and whether a target is chosen when sending. */
export function presetRow(p: Pick<Preset, "name" | "text">): { name: string; head: string; target: string } {
  const first = p.text.split("\n", 1)[0]!;
  const head = first.length > HEAD_MAX ? `${first.slice(0, HEAD_MAX)}…` : first;
  return { name: p.name, head, target: usesTarget(p) ? "対象: Issue / PR を選ぶ" : "対象なし" };
}

/** The request box's state: its workspace and its text. */
type Box = { workspaceId: string | null; text: string };

/**
 * True when the text put in from a preset is still in the box as it was, but the workspace changed since: it names the
 * other workspace's repository, so it is not sent until put in again. A text edited by hand is the user's and is not held.
 */
export const staleDraft = (draft: Box | null, now: Box) => !!draft && draft.text === now.text && draft.workspaceId !== now.workspaceId;
