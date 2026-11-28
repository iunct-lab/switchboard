import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Workspace } from "@switchboard/protocol";
import { SaveIssue } from "./components/SaveIssue.tsx";
import { newIssueDraftKey } from "./backlogSync.ts";

// A SaveIssue mounted late (when 詳細 is first opened) is handed what one mounted when the Workspace list arrived would have
// had: `first` (the Workspace the form had then: it decides, once, whether the draft section starts expanded) and `remembered`
// (the last one chosen, kept after the select goes back to 自動). The eager mount's state is spelled out in each case.
const list = [{ id: "ws_a", name: "a", path: "/a" }, { id: "ws_b", name: "b", path: "/b" }] as Workspace[];
const draft = (title: string) => JSON.stringify({ title, body: `body of ${title}`, kind: "type:pbi" });
const keep = (drafts: Record<string, string>) => {
  const stored = new Map(Object.entries(drafts).map(([id, d]) => [newIssueDraftKey(id), d]));
  globalThis.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: () => undefined, removeItem: () => undefined } as unknown as Storage;
};
const draw = (props: { current: string; first?: string; remembered?: string }) => {
  const html = renderToStaticMarkup(createElement(SaveIssue, { workspaces: list, ...props }));
  return { open: /<details[^>]*\sopen=""/.test(html), ws: /<option value="([^"]+)" selected/.exec(html)?.[1], title: /<input[^>]*value="([^"]*)"/.exec(html)?.[1] ?? "" };
};
afterEach(() => {
  globalThis.localStorage = { getItem: () => null, setItem: () => undefined } as unknown as Storage;
});

test("without the handover props it starts from the current Workspace, else the first in the list (as before)", () => {
  keep({ ws_a: draft("a"), ws_b: draft("b") });
  expect(draw({ current: "" }).title).toBe("a");
  expect(draw({ current: "ws_b" }).title).toBe("b");
});

test("late mount, drafts in the first Workspace only, after choosing the second and back to 自動: the eager mount's Workspace, draft and open state", () => {
  keep({ ws_a: draft("a") });
  // eager: mounted at 自動 with ws_a (draft → open, shows a), then switchTo(ws_b) when it was chosen (shows b's empty draft, stays open), and 自動 changes nothing
  const late = draw({ current: "", first: "ws_a", remembered: "ws_b" });
  expect(late.open).toBe(true);
  expect(late.title).toBe("");
  expect(late.ws).toBe("ws_b");
});

test("late mount, drafts in the second Workspace only: closed as the eager mount was (decided from the first), showing the second's draft", () => {
  keep({ ws_b: draft("b") });
  const late = draw({ current: "", first: "ws_a", remembered: "ws_b" });
  expect(late.open).toBe(false);
  expect(late.title).toBe("b");
});

test("late mount while the second Workspace is chosen: current wins over remembered, open comes from first", () => {
  keep({ ws_a: draft("a"), ws_b: draft("b") });
  const late = draw({ current: "ws_b", first: "ws_a", remembered: "ws_b" });
  expect(late.open).toBe(true);
  expect(late.title).toBe("b");
});
