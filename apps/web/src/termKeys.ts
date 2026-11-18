/**
 * The keys a phone's on-screen keyboard does not have, as the row under the terminal sends them: what xterm sends for the
 * physical key. Arrows follow the cursor-keys mode the program in the shell asked for (application mode = ESC O x).
 */
export const TERM_KEYS = ["up", "down", "left", "right", "esc", "tab", "enter", "ctrl-c"] as const;
export type TermKey = (typeof TERM_KEYS)[number];

export const TERM_KEY_LABELS: Record<TermKey, string> = { up: "↑", down: "↓", left: "←", right: "→", esc: "Esc", tab: "Tab", enter: "Enter", "ctrl-c": "^C" };

const ARROWS: Partial<Record<TermKey, string>> = { up: "A", down: "B", right: "C", left: "D" };
const PLAIN: Partial<Record<TermKey, string>> = { esc: "\x1b", tab: "\t", enter: "\r", "ctrl-c": "\x03" };

export function keySequence(key: TermKey, applicationCursor: boolean): string {
  const arrow = ARROWS[key];
  return arrow ? `\x1b${applicationCursor ? "O" : "["}${arrow}` : PLAIN[key]!;
}
