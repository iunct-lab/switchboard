import { expect, test } from "bun:test";
import { BaselineInput } from "@switchboard/protocol";
import { BASELINE_MAX, CONFIG_MAX, RULES_MAX, baselineWarning, canAdopt, canRemove, canSaveConfig, canSaveRules, canStartBaseline, cloneRowText, configSourceLine, configUsedLabel, removalWarning } from "./workspaceAdd.ts";

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

test("canAdopt: a repository of your own, with or without GitHub", () => {
  expect(canAdopt({ kind: "repo", upstream: undefined })).toBe(true);
  expect(canAdopt({ kind: "repo", upstream: "someone/app" })).toBe(false);
  expect(canAdopt({ kind: "meta", upstream: undefined })).toBe(false);
});

test("canSaveRules: only a text that differs from what is kept and fits; empty removes", () => {
  expect(canSaveRules("テスト: make test", "テスト: make check")).toBe(true);
  expect(canSaveRules("テスト: make test", "テスト: make test")).toBe(false);
  // the API trims, so space around the kept text is no change
  expect(canSaveRules("\n テスト: make test \n", "テスト: make test")).toBe(false);
  expect(canSaveRules("", "テスト: make test")).toBe(true);
  expect(canSaveRules("x".repeat(RULES_MAX), "y")).toBe(true);
  expect(canSaveRules("x".repeat(RULES_MAX + 1), "y")).toBe(false);
});

test("canSaveConfig: only settings that differ from what is kept and fit; empty removes", () => {
  const kept = '{\n  "ci": { "steps": [{ "run": "make test" }] }\n}\n';
  expect(canSaveConfig('{ "ci": { "steps": [{ "run": "make check" }] } }', kept)).toBe(true);
  expect(canSaveConfig(`\n${kept}  `, kept)).toBe(false);
  expect(canSaveConfig("", kept)).toBe(true);
  expect(canSaveConfig("", "")).toBe(false);
  expect(canSaveConfig("x".repeat(CONFIG_MAX), "")).toBe(true);
  expect(canSaveConfig("x".repeat(CONFIG_MAX + 1), "")).toBe(false);
});

test("the fold says which settings the workspace runs with: Switchboard's, the repository's own file (which wins as a whole over saved ones), or none", () => {
  expect(configUsedLabel(null)).toBe("");
  expect([configUsedLabel("switchboard"), configUsedLabel("repository"), configUsedLabel("none")]).toEqual(["使用中", "リポジトリの ops.config.json を使用中", "未設定"]);
  expect(configSourceLine("switchboard", "{}")).toContain("Switchboard の側（下の欄）");
  expect(configSourceLine("repository", "")).toBe("いま使われている設定: リポジトリの ops.config.json。");
  // saved settings that are not in use are said to be so, with the reason
  expect(configSourceLine("repository", "{}")).toContain("下の欄の設定は使われません（キーごとに混ぜません）");
  expect(configSourceLine("none", "")).toContain("なし");
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
