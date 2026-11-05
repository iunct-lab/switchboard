import { expect, test } from "bun:test";
import { MD_VIEW_KEY, mdViewSnapshot, readMdView, setMdView } from "./mdView.ts";

test("readMdView defaults to preview and keeps text", () => {
  const from = (v: string | null) => (k: string) => (k === MD_VIEW_KEY ? v : null);
  expect(readMdView(from(null))).toBe("preview");
  expect(readMdView(from("text"))).toBe("text");
  expect(readMdView(from("preview"))).toBe("preview");
  expect(readMdView(from("raw"))).toBe("preview");
});

test("a choice the storage cannot keep still switches the view", () => {
  // bun has no localStorage: every write throws, like a full or blocked storage in a browser
  setMdView("text");
  expect(mdViewSnapshot()).toBe("text");
  setMdView("preview");
  expect(mdViewSnapshot()).toBe("preview");
});
