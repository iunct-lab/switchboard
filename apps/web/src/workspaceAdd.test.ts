import { expect, test } from "bun:test";
import { canRemove, cloneRowText, removalWarning } from "./workspaceAdd.ts";

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
