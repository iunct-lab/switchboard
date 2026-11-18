// test-reads: apps/web/src/termKeys.ts
import { expect, test } from "bun:test";
import { keySequence, TERM_KEYS, TERM_KEY_LABELS } from "./termKeys.ts";

test("each key sends what xterm sends for the physical key, arrows following the cursor-keys mode", () => {
  expect(TERM_KEYS.map((k) => keySequence(k, false))).toEqual(["\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C", "\x1b", "\t", "\r", "\x03"]);
  expect(TERM_KEYS.map((k) => keySequence(k, true))).toEqual(["\x1bOA", "\x1bOB", "\x1bOD", "\x1bOC", "\x1b", "\t", "\r", "\x03"]);
  expect(TERM_KEYS.map((k) => TERM_KEY_LABELS[k])).toEqual(["↑", "↓", "←", "→", "Esc", "Tab", "Enter", "^C"]);
});
