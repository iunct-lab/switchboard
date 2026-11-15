import { expect, test } from "bun:test";
import { BaselineInput } from "@switchboard/protocol";
import { BASELINE_MAX, baselineWarning, canAdopt, canRemove, canStartBaseline, cloneRowText, removalWarning } from "./workspaceAdd.ts";

test("cloneRowText: cloning and failed rows", () => {
  expect(cloneRowText({ repo: "acme/app", path: "/srv/app", state: "cloning" })).toBe("acme/app を /srv/app に clone しています");
  expect(cloneRowText({ repo: "acme/app", path: "/srv/app", state: "failed", error: "fatal: repository not found" })).toBe("acme/app を追加できませんでした: fatal: repository not found（途中のディレクトリがあれば消してから）");
});

test("removalWarning: a running Task always; the copy's loss only when it is deleted", () => {
  expect(removalWarning({ dirty: true, unpushed: true, running: 2 }, true)).toBe("動いている Task が 2 件あります。終えてから外してください");
  expect(removalWarning({ dirty: true, unpushed: true, running: 0 }, false)).toBeNull();
  expect(removalWarning({ dirty: false, unpushed: false, running: 0 }, true)).toBeNull();
  expect(removalWarning({ dirty: true, unpushed: false, running: 0 }, true)).toBe("コミットされていない変更があります");
  expect(removalWarning({ dirty: false, unpushed: true, running: 0 }, true)).toBe("push していないコミットがあります");
  expect(removalWarning({ dirty: true, unpushed: true, running: 0 }, true)).toBe("コミットされていない変更と、push していないコミットがあります");
});

test("canRemove: the exact name, and nothing running", () => {
  expect(canRemove("app", { name: "app", running: 0 })).toBe(true);
  expect(canRemove("ap", { name: "app", running: 0 })).toBe(false);
  expect(canRemove("app", { name: "app", running: 1 })).toBe(false);
});

test("canAdopt: only a repository of your own that syncs with GitHub", () => {
  expect(canAdopt({ kind: "repo", upstream: undefined, backlog: "github" })).toBe(true);
  // someone else's repository, even one whose backlog points at GitHub
  expect(canAdopt({ kind: "repo", upstream: "someone/app", backlog: "github" })).toBe(false);
  expect(canAdopt({ kind: "repo", upstream: undefined, backlog: "switchboard" })).toBe(false);
  expect(canAdopt({ kind: "meta", upstream: undefined, backlog: "github" })).toBe(false);
});

test("canStartBaseline: something in it, and no longer than the API takes", () => {
  expect(canStartBaseline("旅行の予定を共有する")).toBe(true);
  expect(canStartBaseline("")).toBe(false);
  expect(canStartBaseline("  \n ")).toBe(false);
  expect(canStartBaseline("x".repeat(BASELINE_MAX))).toBe(true);
  expect(canStartBaseline(` ${"x".repeat(BASELINE_MAX)} `)).toBe(true);
  expect(canStartBaseline("x".repeat(BASELINE_MAX + 1))).toBe(false);
  // the same limit as the API's: the longest it takes passes there, one more is refused
  expect(BaselineInput.safeParse({ concept: "x".repeat(BASELINE_MAX) }).success).toBe(true);
  expect(BaselineInput.safeParse({ concept: "x".repeat(BASELINE_MAX + 1) }).success).toBe(false);
});

test("baselineWarning: says why 始める cannot be pressed only when the concept is too long", () => {
  expect(baselineWarning("x".repeat(BASELINE_MAX))).toBeNull();
  expect(baselineWarning(` ${"x".repeat(BASELINE_MAX)} `)).toBeNull();
  expect(baselineWarning("")).toBeNull();
  expect(baselineWarning("x".repeat(BASELINE_MAX + 1))).toBe(`構想が長すぎます（${BASELINE_MAX + 1} 字。${BASELINE_MAX} 字まで）`);
});
