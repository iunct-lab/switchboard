// test-reads: apps/web/public/sw.js
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pathToWrite, viewFromPath, viewPath } from "./route.ts";
import type { View } from "./screen.ts";

const views: View[] = [
  { name: "home" },
  { name: "task", id: "task_abc123" },
  { name: "knowledge" },
  { name: "ledger" },
  { name: "evals" },
  { name: "schedules" },
  { name: "backlog" },
  { name: "resources" },
  { name: "approvals" },
  { name: "settings" },
];

describe("screen URLs (#3355)", () => {
  test("every screen has a path and comes back from it", () => {
    for (const v of views) expect(viewFromPath(viewPath(v))).toEqual(v);
    expect(viewPath({ name: "approvals" })).toBe("/approvals"); // the PWA's start_url stays (#26)
    expect(viewPath({ name: "evals" })).toBe("/insights"); // the tab's name, not the internal one
    expect(viewPath({ name: "home" })).toBe("/");
  });

  test("a Task id with Japanese and symbols survives the round trip", () => {
    for (const id of ["タスク 1", "a/b?c#d&e", "100%"]) {
      const path = viewPath({ name: "task", id });
      expect(path.slice("/task/".length)).not.toMatch(/[/?# ]/);
      expect(viewFromPath(path)).toEqual({ name: "task", id });
    }
  });

  test("what the URL does not carry is dropped: the artifact, Insights' report and artifacts", () => {
    expect(viewPath({ name: "task", id: "t1", artifact: "a.html" })).toBe("/task/t1");
    expect(viewPath({ name: "evals", report: "r1", artifacts: true })).toBe("/insights");
  });

  test("a trailing slash is fine; an unknown path, /task/ without an id and a malformed id are not screens", () => {
    expect(viewFromPath("/backlog/")).toEqual({ name: "backlog" });
    expect(viewFromPath("/task/t1/")).toEqual({ name: "task", id: "t1" });
    for (const p of ["/nope", "/task/", "/task", "/task/a/b", "/task/%E0%A4%A", "/evals", "//backlog", ""]) expect(viewFromPath(p)).toBeNull();
  });

  test("the daemon's own paths are never read as a screen (the service worker's LIVE set)", () => {
    const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    const live = sw.match(/const LIVE = \/\^\\\/\(([^)]+)\)/)?.[1]?.split("|") ?? [];
    expect(live).toContain("api");
    for (const prefix of live) {
      expect(viewFromPath(`/${prefix}`)).toBeNull();
      expect(viewFromPath(`/${prefix}/`)).toBeNull();
      expect(viewFromPath(`/${prefix}/x`)).toBeNull();
    }
  });
});

describe("when the address bar is written (#3427)", () => {
  test("a new screen writes its path; the screen already shown writes nothing", () => {
    expect(pathToWrite({ name: "task", id: "t1" }, "/")).toBe("/task/t1");
    expect(pathToWrite({ name: "backlog" }, "/task/t1")).toBe("/backlog");
    expect(pathToWrite({ name: "home" }, "/settings")).toBe("/");
    expect(pathToWrite({ name: "task", id: "t1" }, "/task/t1")).toBeNull(); // popstate brought it: no second entry
  });

  test("the same screen in another shape is not a new entry: an artifact of the open Task, a trailing slash, Insights' scope", () => {
    expect(pathToWrite({ name: "task", id: "t1", artifact: "a1" }, "/task/t1")).toBeNull(); // 全画面's own history entry stays the one on top
    expect(pathToWrite({ name: "backlog" }, "/backlog/")).toBeNull();
    expect(pathToWrite({ name: "evals", artifacts: true }, "/insights")).toBeNull();
  });

  test("a path that is no screen is written over with Home", () => {
    expect(pathToWrite({ name: "home" }, "/nope")).toBe("/");
    expect(pathToWrite({ name: "home" }, "/task/")).toBe("/");
  });
});
