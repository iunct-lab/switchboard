import { expect, test } from "bun:test";
import { appRequestDraft, appRequestOf, artifactsLabel, copyKind, isMarkdown, pickArtifact, viewOf } from "./artifacts.ts";

const f = (mime: string, kind: "file" | "dir" | "url" = "file") => viewOf({ kind, mime });

test("viewOf: pages in a frame, images as images, text-like as text, the rest and URLs handed to the browser", () => {
  expect([f("text/html"), f("application/xhtml+xml"), f("image/svg+xml")]).toEqual(["frame", "frame", "frame"]);
  expect([f("image/png"), f("image/jpeg"), f("image/webp")]).toEqual(["image", "image", "image"]);
  expect([f("text/plain"), f("text/markdown"), f("application/json"), f("application/yaml"), f("text/css")]).toEqual(["text", "text", "text", "text", "text"]);
  expect([f("application/pdf"), f("application/octet-stream"), f("video/mp4")]).toEqual(["external", "external", "external"]);
  expect(f("text/uri-list", "url")).toBe("external");
  expect(f("text/html", "url")).toBe("external");
});

test("artifactsLabel shows the count only when there is one", () => {
  expect(artifactsLabel(0)).toBe("成果物");
  expect(artifactsLabel(2)).toBe("成果物（2）");
});

test("pickArtifact (#1778): the requested one when present, else the current one, else the first; gone says a request missed", () => {
  const list = [{ id: "a" }, { id: "b" }];
  expect(pickArtifact(list, "b", "a")).toEqual({ id: "b", gone: false });
  expect(pickArtifact(list, "zz", "b")).toEqual({ id: "b", gone: true });
  expect(pickArtifact(list, "zz", "gone-too")).toEqual({ id: "a", gone: true });
  expect(pickArtifact(list, undefined, "b")).toEqual({ id: "b", gone: false });
  expect(pickArtifact(list, undefined, null)).toEqual({ id: "a", gone: false });
  expect(pickArtifact([], "zz", null)).toEqual({ id: null, gone: true });
  expect(pickArtifact([], undefined, "a")).toEqual({ id: null, gone: false });
});

test("isMarkdown: only markdown files", () => {
  expect(isMarkdown({ kind: "file", mime: "text/markdown" })).toBe(true);
  expect(isMarkdown({ kind: "dir", mime: "text/markdown" })).toBe(true);
  expect(isMarkdown({ kind: "file", mime: "text/plain" })).toBe(false);
  expect(isMarkdown({ kind: "file", mime: "text/html" })).toBe(false);
  expect(isMarkdown({ kind: "url", mime: "text/markdown" })).toBe(false);
});

test("appRequestOf (#3683): 要望にする once the page used the bridge (earlier days or now); the link once a request Task was started", () => {
  expect(appRequestOf({ appDays: 0, appRequestTaskId: null }, false)).toEqual({ offer: false, taskId: null });
  expect(appRequestOf({ appDays: 0, appRequestTaskId: null }, true)).toEqual({ offer: true, taskId: null });
  expect(appRequestOf({ appDays: 2, appRequestTaskId: null }, false)).toEqual({ offer: true, taskId: null });
  expect(appRequestOf({ appDays: 3, appRequestTaskId: "task_r" }, false)).toEqual({ offer: true, taskId: "task_r" });
  expect(appRequestDraft("ボード")).toBe("使い捨てアプリ「ボード」を一般機能にしたい。");
});

test("copyKind: content for text and pages, url for links, none for images, folders and downloads", () => {
  const c = (mime: string, kind: "file" | "dir" | "url" = "file") => copyKind({ kind, mime });
  expect([c("text/plain"), c("text/markdown"), c("application/json"), c("text/html"), c("image/svg+xml")]).toEqual(["content", "content", "content", "content", "content"]);
  expect([c("text/uri-list", "url"), c("text/html", "url")]).toEqual(["url", "url"]);
  expect([c("image/png"), c("application/pdf"), c("application/octet-stream")]).toEqual([null, null, null]);
  expect([c("text/html", "dir"), c("text/plain", "dir")]).toEqual([null, null]);
});
