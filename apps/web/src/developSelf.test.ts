import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Workspace } from "@switchboard/protocol";
import { FeedbackDialog, FeedbackUpstreamBox } from "./components/Feedback.tsx";
import { Compose, ImproveButtons } from "./components/Compose.tsx";
import { DevelopSelfToggle } from "./components/SettingsToggles.tsx";

// 「Switchboard 自体を開発する」: what each screen draws for the setting
const ws = (id: string, kind: Workspace["kind"] = "repo") => ({ id, name: id, path: `/${id}`, kind }) as Workspace;
const noop = () => undefined;

test("Settings: the toggle shows the setting as saved and hands the change on", () => {
  const on = renderToStaticMarkup(createElement(DevelopSelfToggle, { checked: true, disabled: false, onChange: noop }));
  const off = renderToStaticMarkup(createElement(DevelopSelfToggle, { checked: false, disabled: false, onChange: noop }));
  expect(on).toContain('type="checkbox" checked=""');
  expect(off).not.toContain('checked=""');
  expect(off).toContain("Switchboard 自体を開発する");
  // the hint says where a request goes and that nothing is filed by the app
  expect(off).toContain("取得元（origin）のリポジトリの要望フォーム");
  expect(off).toContain("Issue を自動では作りません");
});

test("Home: このアプリを改善 only while Switchboard itself is developed; the user's own app keeps its button", () => {
  const meta = ws("ws_meta", "meta");
  const html = (developSelf: boolean, chosen?: Workspace) => renderToStaticMarkup(createElement(ImproveButtons, { ws: chosen, meta, developSelf, onImprove: noop }));
  expect(html(true)).toContain("このアプリを改善");
  expect(html(false)).toBe("");
  expect(html(false, ws("ws_lib"))).toContain("ws_lib");
  expect(html(false, ws("ws_lib"))).not.toContain("このアプリを改善");
});

const compose = (workspaces: Workspace[]) => renderToStaticMarkup(createElement(Compose, { health: null, workspaces, runnerOk: new Set(), onCreate: async () => undefined, onError: noop, onOpenSettings: noop, screen: "home", onSent: noop }));

test("Compose: before the setting is read the form is drawn as the default (on) says: the fix is offered, the upstream hint is not; SaveIssue waits for 詳細 to open", () => {
  globalThis.localStorage ??= { getItem: () => null, setItem: noop } as unknown as Storage; // the form reads whether 詳細 was left open
  const html = compose([ws("ws_meta", "meta")]);
  expect(html).toContain("data-compose");
  expect(html).toContain("data-compose-backlog");
  expect(html).toContain("data-compose-start");
  expect(html).toContain("data-compose-fix");
  expect(html).not.toContain("Issue は自動では作らず");
  expect(html).not.toContain("data-compose-save");
});

test("Compose: 詳細 left open mounts SaveIssue from the first draw", () => {
  globalThis.localStorage = { getItem: () => "open", setItem: noop } as unknown as Storage;
  try {
    expect(compose([ws("ws_meta", "meta")])).toContain("data-compose-save");
  } finally {
    globalThis.localStorage = { getItem: () => null, setItem: noop } as unknown as Storage;
  }
});

test("Feedback: a closed dialog draws no form, so Home keeps the only one", () => {
  const html = renderToStaticMarkup(createElement(FeedbackDialog, { open: false, screen: "home", health: null, workspaces: [ws("ws_meta", "meta")], runnerOk: new Set(), onCreate: async () => undefined, onOpenSettings: noop, onClose: noop, onSent: noop, onError: noop }));
  expect(html).toContain("feedback-dialog");
  expect(html).not.toContain("data-compose");
});

test("Feedback: the upstream answer is a form link on GitHub, else the text with a copy button", () => {
  const link = renderToStaticMarkup(createElement(FeedbackUpstreamBox, { upstream: { url: "https://github.com/acme/switchboard/issues/new?template=request.yml", text: "body" }, onCopyError: noop }));
  expect(link).toContain('href="https://github.com/acme/switchboard/issues/new?template=request.yml"');
  expect(link).toContain("acme/switchboard の要望フォームを開く");
  expect(link).not.toContain("<pre");
  const copy = renderToStaticMarkup(createElement(FeedbackUpstreamBox, { upstream: { url: null, text: "the request body" }, onCopyError: noop }));
  expect(copy).not.toContain("<a ");
  expect(copy).toContain("the request body");
  expect(copy).toContain("<button");
});

test("Compose: the first draw uses the last value read in this browser, so an instance with it off gets its final form at once", () => {
  const stored = (value: string | null) => ({ getItem: (k: string) => (k === "switchboard.compose.developSelf" ? value : null), setItem: noop }) as unknown as Storage;
  const form = (html: string) => ({ fix: html.includes("data-compose-fix"), upstream: html.includes("Issue は自動では作らず"), improveSelf: html.includes("このアプリを改善") });
  const meta = [ws("ws_meta", "meta")];
  try {
    globalThis.localStorage = stored("off");
    // what the answered form offers for the setting off (`feedbackModes`): no fix for Switchboard itself, the upstream hint instead
    expect(form(compose(meta))).toEqual({ fix: false, upstream: true, improveSelf: false });
    globalThis.localStorage = stored("on");
    expect(form(compose(meta)).fix).toBe(true);
    // nothing kept (the first visit) or a value that is not one of ours: the setting's default (on)
    globalThis.localStorage = stored(null);
    expect(form(compose(meta))).toEqual({ fix: true, upstream: false, improveSelf: true });
    globalThis.localStorage = stored("garbage");
    expect(form(compose(meta)).fix).toBe(true);
  } finally {
    globalThis.localStorage = { getItem: () => null, setItem: noop } as unknown as Storage;
  }
});

test("Settings save: the browser's copy of the setting follows a successful save, which Home's next first draw starts from", async () => {
  const { api } = await import("./api/index.ts");
  const { loadDevelopSelf } = await import("./composeDetails.ts");
  const map = new Map<string, string>();
  const realStorage = globalThis.localStorage;
  const realFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) } as unknown as Storage;
  try {
    for (const on of [false, true, false]) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ developSelf: on }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
      await api.updateSettings({ developSelf: on });
      expect(loadDevelopSelf(globalThis.localStorage, !on)).toBe(on);
    }
    // a refused save changes nothing
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "no" }), { status: 500, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(api.updateSettings({ developSelf: true })).rejects.toThrow();
    expect(loadDevelopSelf(globalThis.localStorage, true)).toBe(false);
  } finally {
    globalThis.localStorage = realStorage;
    globalThis.fetch = realFetch;
  }
});
