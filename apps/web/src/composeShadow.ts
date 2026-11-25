import type { RunnerId } from "@switchboard/protocol";
import { isAdkRunner } from "./runners.ts";

/** What Home's parallel run row shows and what the request carries: one result, so the checkbox and the request cannot differ. */
export type ComposeShadow = {
  /** The row is drawn at all. */
  show: boolean;
  /** The runner the row names: the saved default, or DAK for this one Task when nothing is saved and DAK is detected. */
  runner: RunnerId | null;
  /** The named runner is the saved default (not the one-task DAK box). */
  saved: boolean;
  checked: boolean;
  disabled: boolean;
  /** Why the row is off: the default is the primary itself, is not detected, or is not loaded yet. */
  note: "same" | "missing" | "loading" | null;
  /** The request's `shadowRunner`: the named runner when checked, `null` when not, `undefined` (omitted: the daemon applies what is saved) before the default is loaded and for a DAK primary. */
  field: RunnerId | null | undefined;
};

/**
 * `shadowDefault`: the saved default (undefined = not loaded yet). `touched`: what a click on the box chose, null = untouched.
 * A DAK or custom primary has no row. A custom primary says null; a DAK primary omits the field unless the default is DAK itself, so
 * the daemon applies a saved default of another runner. With nothing saved and DAK detected the row is the one-task DAK box, off until ticked
 * (`dakListed`: DAK is registered; when it is not reachable the box is drawn disabled).
 */
export function composeShadow(v: { runner: string; shadowDefault: RunnerId | null | undefined; touched: boolean | null; runnerOk: ReadonlySet<string>; dakListed?: boolean }): ComposeShadow {
  const { runner, shadowDefault, touched, runnerOk } = v;
  const none = { show: false, runner: null, saved: false, checked: false, disabled: true, note: null } as const;
  if (runner === "dak") return { ...none, field: shadowDefault === "dak" ? null : undefined };
  if (isAdkRunner(runner)) return { ...none, field: null };
  if (shadowDefault === undefined) return { show: true, runner: null, saved: false, checked: false, disabled: true, note: "loading", field: undefined };
  if (shadowDefault === null) {
    // DAK registered but not reachable: the box stays, off, and says why
    if (!runnerOk.has("dak")) return v.dakListed ? { show: true, runner: "dak", saved: false, checked: false, disabled: true, note: "missing", field: null } : { ...none, field: null };
    const checked = touched ?? false;
    return { show: true, runner: "dak", saved: false, checked, disabled: false, note: null, field: checked ? "dak" : null };
  }
  if (shadowDefault === runner) return { show: true, runner: shadowDefault, saved: true, checked: false, disabled: true, note: "same", field: null };
  if (!runnerOk.has(shadowDefault)) return { show: true, runner: shadowDefault, saved: true, checked: false, disabled: true, note: "missing", field: null };
  const checked = touched ?? true;
  return { show: true, runner: shadowDefault, saved: true, checked, disabled: false, note: null, field: checked ? shadowDefault : null };
}
