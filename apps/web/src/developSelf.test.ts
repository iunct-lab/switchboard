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

test("Compose: before the setting is read (and while off) 要望にしてすぐ直す is not offered for Switchboard itself and a Switchboard request says no Issue is made automatically", () => {
  globalThis.localStorage ??= { getItem: () => null, setItem: noop } as unknown as Storage; // the form reads whether 詳細 was left open
  const html = compose([ws("ws_meta", "meta")]);
  expect(html).toContain("data-compose");
  expect(html).toContain("data-compose-backlog");
  expect(html).toContain("data-compose-start");
  expect(html).not.toContain("data-compose-fix");
  expect(html).toContain("Issue は自動では作らず");
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
