import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Workspace } from "@switchboard/protocol";
import { FeedbackDialog, FeedbackUpstreamBox } from "./components/Feedback.tsx";
import { ImproveButtons } from "./components/Home.tsx";
import { DevelopSelfToggle } from "./components/Settings.tsx";

// 「Switchboard 自体を開発する」 (#2459): what each screen draws for the setting
const ws = (id: string, kind: Workspace["kind"] = "repo") => ({ id, name: id, path: `/${id}`, kind }) as Workspace;
const noop = () => undefined;

test("Settings: the toggle shows the setting as saved and hands the change on", () => {
  const on = renderToStaticMarkup(createElement(DevelopSelfToggle, { checked: true, disabled: false, onChange: noop }));
  const off = renderToStaticMarkup(createElement(DevelopSelfToggle, { checked: false, disabled: false, onChange: noop }));
  expect(on).toContain('type="checkbox" checked=""');
  expect(off).not.toContain('checked=""');
  expect(off).toContain("Switchboard 自体を開発する");
});

test("Home: このアプリを改善 only while Switchboard itself is developed; the user's own app keeps its button", () => {
  const meta = ws("ws_meta", "meta");
  const html = (developSelf: boolean, chosen?: Workspace) => renderToStaticMarkup(createElement(ImproveButtons, { ws: chosen, meta, developSelf, onImprove: noop }));
  expect(html(true)).toContain("このアプリを改善");
  expect(html(false)).toBe("");
  expect(html(false, ws("ws_lib"))).toContain("ws_lib");
  expect(html(false, ws("ws_lib"))).not.toContain("このアプリを改善");
});

test("Feedback: before the setting is read (and while off) すぐ直す is not offered and a Switchboard request says it goes upstream", () => {
  const html = renderToStaticMarkup(createElement(FeedbackDialog, { open: false, screen: "home", workspaces: [ws("ws_meta", "meta")], onClose: noop, onSent: noop, onError: noop }));
  expect(html).not.toContain('name="feedback-mode"');
  expect(html).toContain("upstream");
});

test("Feedback: the upstream answer is a form link on GitHub, else the text with a copy button", () => {
  const link = renderToStaticMarkup(createElement(FeedbackUpstreamBox, { upstream: { url: "https://github.com/acme/switchboard/issues/new?template=request.yml", text: "body" }, onCopyError: noop }));
  expect(link).toContain('href="https://github.com/acme/switchboard/issues/new?template=request.yml"');
  expect(link).not.toContain("<pre");
  const copy = renderToStaticMarkup(createElement(FeedbackUpstreamBox, { upstream: { url: null, text: "the request body" }, onCopyError: noop }));
  expect(copy).not.toContain("<a ");
  expect(copy).toContain("the request body");
  expect(copy).toContain("<button");
});
