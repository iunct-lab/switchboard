import { expect, test } from "bun:test";
import type { RunnerId } from "@switchboard/protocol";
import { afterFailedRead, composeShadow } from "./composeShadow.ts";

const ok = new Set<string>(["claude", "codex"]);

test("composeShadow: a saved codex default on a claude primary shows the row checked and names codex", () => {
  expect(composeShadow({ runner: "claude", shadowDefault: "codex", touched: null, runnerOk: ok })).toMatchObject({ show: true, runner: "codex", checked: true, disabled: false, note: null, field: "codex" });
  expect(composeShadow({ runner: "claude", shadowDefault: "codex", touched: false, runnerOk: ok })).toMatchObject({ checked: false, field: null });
});

test("composeShadow: the primary is the default runner, the default is not detected, nothing is saved, not loaded", () => {
  expect(composeShadow({ runner: "codex", shadowDefault: "codex", touched: true, runnerOk: ok })).toMatchObject({ show: true, checked: false, disabled: true, note: "same", field: null });
  expect(composeShadow({ runner: "claude", shadowDefault: "dak", touched: null, runnerOk: ok })).toMatchObject({ show: true, checked: false, disabled: true, note: "missing", field: null });
  expect(composeShadow({ runner: "claude", shadowDefault: null, touched: null, runnerOk: ok })).toMatchObject({ show: false, field: null });
  expect(composeShadow({ runner: "claude", shadowDefault: undefined, touched: null, runnerOk: ok })).toMatchObject({ show: true, disabled: true, note: "loading", field: null });
  expect(composeShadow({ runner: "claude", shadowDefault: "unread", touched: true, runnerOk: ok })).toMatchObject({ show: true, checked: false, disabled: true, note: "unread", field: null });
});

test("composeShadow: a DAK primary leaves the saved default of another runner to the daemon, as before; a custom primary and a DAK default say none", () => {
  expect(composeShadow({ runner: "dak", shadowDefault: "codex", touched: null, runnerOk: ok })).toMatchObject({ show: false, field: undefined });
  expect(composeShadow({ runner: "dak", shadowDefault: null, touched: null, runnerOk: ok })).toMatchObject({ show: false, field: undefined });
  expect(composeShadow({ runner: "dak", shadowDefault: "dak", touched: null, runnerOk: ok })).toMatchObject({ show: false, field: null });
  expect(composeShadow({ runner: "custom:sample", shadowDefault: "codex", touched: null, runnerOk: ok })).toMatchObject({ show: false, field: null });
});

test("composeShadow: no saved default and DAK detected keeps the one-task DAK box, off until ticked", () => {
  const withDak = new Set<string>(["claude", "codex", "dak"]);
  expect(composeShadow({ runner: "claude", shadowDefault: null, touched: null, runnerOk: withDak })).toMatchObject({ show: true, runner: "dak", saved: false, checked: false, disabled: false, field: null });
  expect(composeShadow({ runner: "claude", shadowDefault: null, touched: true, runnerOk: withDak })).toMatchObject({ show: true, runner: "dak", saved: false, checked: true, field: "dak" });
  expect(composeShadow({ runner: "claude", shadowDefault: "codex", touched: null, runnerOk: withDak })).toMatchObject({ runner: "codex", saved: true, checked: true, field: "codex" });
  // DAK registered but not reachable: the box stays, off and disabled, and says why
  expect(composeShadow({ runner: "claude", shadowDefault: null, touched: true, runnerOk: ok, dakListed: true })).toMatchObject({ show: true, runner: "dak", saved: false, checked: false, disabled: true, note: "missing", field: null });
  expect(composeShadow({ runner: "claude", shadowDefault: null, touched: null, runnerOk: ok })).toMatchObject({ show: false, field: null });
});

test("composeShadow: checked iff the request names the shadow runner", () => {
  const runners: string[] = ["claude", "codex", "dak", "custom:sample"];
  const defaults: Array<RunnerId | null | undefined | "unread"> = [undefined, "unread", null, "claude", "codex", "dak"];
  for (const runner of runners) for (const shadowDefault of defaults) for (const touched of [null, true, false]) for (const runnerOk of [ok, new Set<string>(["claude", "codex", "dak"]), new Set<string>()]) for (const dakListed of [false, true]) {
    const r = composeShadow({ runner, shadowDefault, touched, runnerOk, dakListed });
    const label = JSON.stringify({ runner, shadowDefault, touched, ok: [...runnerOk] });
    // omitted (the daemon decides) only for a DAK primary whose row is not drawn; loading and unread say null
    if (r.field === undefined) {
      expect({ label, checked: r.checked, omitted: runner === "dak" && !r.show }).toEqual({ label, checked: false, omitted: true });
      continue;
    }
    expect({ label, same: r.checked === (r.field !== null && r.field === r.runner) }).toEqual({ label, same: true });
    if (!r.checked) expect({ label, field: r.field }).toEqual({ label, field: null });
  }
});

test("afterFailedRead: a failed first read is unread; a failed re-read keeps the default already read", () => {
  expect(afterFailedRead(undefined)).toBe("unread");
  expect(afterFailedRead("codex")).toBe("codex");
  expect(afterFailedRead(null)).toBeNull();
  expect(afterFailedRead("unread")).toBe("unread");
});
