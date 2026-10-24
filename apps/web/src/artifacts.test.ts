import { expect, test } from "bun:test";
import { artifactsLabel, pickArtifact, viewOf } from "./artifacts.ts";

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
