import { expect, test } from "bun:test";
import type { RunnerId } from "@switchboard/protocol";
import { detailsSummary, loadDetailsOpen, saveDetailsOpen } from "./composeDetails.ts";

const untouched = { title: "", executionMode: "local" as const, model: "", effort: "", budget: "", shadow: null as RunnerId | null };

test("detailsSummary: nothing changed → empty", () => {
  expect(detailsSummary(untouched, { model: "", shadow: null })).toBe("");
  // the values an untouched form holds are not changes (a proposed model, a shadow that is on by default)
  expect(detailsSummary({ ...untouched, model: "opus", shadow: "codex" as const }, { model: "opus", shadow: "codex" as const })).toBe("");
  expect(detailsSummary({ ...untouched, title: "  ", budget: " " }, { model: "", shadow: null })).toBe("");
});

test("detailsSummary: each changed value shows, in the form's order", () => {
  expect(detailsSummary({ title: "ログを直す", executionMode: "cloud", model: "opus", effort: "high", budget: "2.5", shadow: "codex" as const }, { model: "", shadow: null })).toBe(
    "タイトル: ログを直す · 実行場所: クラウド · モデル: opus · 思考: high · 予算 $2.5 · 並走: Codex",
  );
  expect(detailsSummary({ ...untouched, effort: "low" }, { model: "", shadow: null })).toBe("思考: low");
  // a shadow turned off where the default runs it says so
  expect(detailsSummary({ ...untouched, shadow: null }, { model: "", shadow: "codex" as const })).toBe("並走: なし");
  // a model put back to the CLI default where the rule proposed one
  expect(detailsSummary({ ...untouched, model: "" }, { model: "opus", shadow: null })).toBe("モデル: CLI 既定");
});

test("detailsSummary: a long title is cut", () => {
  expect(detailsSummary({ ...untouched, title: "あ".repeat(30) }, { model: "", shadow: null })).toBe(`タイトル: ${"あ".repeat(20)}…`);
  expect(detailsSummary({ ...untouched, title: "あ".repeat(20) }, { model: "", shadow: null })).toBe(`タイトル: ${"あ".repeat(20)}`);
});

test("detailsSummary: the title 改善 → put in alone is not a change (it is not sent)", () => {
  const briefTitle = "Switchboard を改善: ";
  expect(detailsSummary({ ...untouched, title: briefTitle }, { model: "", shadow: null, briefTitle })).toBe("");
  expect(detailsSummary({ ...untouched, title: `${briefTitle}ログ` }, { model: "", shadow: null, briefTitle })).toBe("タイトル: Switchboard を改善: ログ");
});

function memory(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } };
}

test("loadDetailsOpen / saveDetailsOpen: closed at first, then what was saved", () => {
  const s = memory();
  expect(loadDetailsOpen(s)).toBe(false);
  saveDetailsOpen(s, true);
  expect(s.getItem("switchboard.compose.details")).toBe("open");
  expect(loadDetailsOpen(s)).toBe(true);
  saveDetailsOpen(s, false);
  expect(loadDetailsOpen(s)).toBe(false);
});

test("loadDetailsOpen / saveDetailsOpen: a storage that throws starts closed and does not throw", () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
  expect(loadDetailsOpen(broken)).toBe(false);
  expect(() => saveDetailsOpen(broken, true)).not.toThrow();
});
