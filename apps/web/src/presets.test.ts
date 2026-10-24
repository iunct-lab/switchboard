import { expect, test } from "bun:test";
import { presetRow, staleDraft, usesTarget } from "./presets.ts";

test("usesTarget", () => {
  expect(usesTarget({ text: "PR {{target}} をマージまで" })).toBe(true);
  expect(usesTarget({ text: "状況を確認して" })).toBe(false);
  expect(usesTarget({ text: "PR {{ target }} をマージまで" })).toBe(false);
});

test("presetRow", () => {
  const long = "あ".repeat(100);
  expect(presetRow({ name: "長い", text: long })).toEqual({ name: "長い", head: `${"あ".repeat(80)}…`, target: "対象なし" });
  expect(presetRow({ name: "二行", text: "PR {{target}} の指摘に対応\n2 行目は出さない" })).toEqual({ name: "二行", head: "PR {{target}} の指摘に対応", target: "対象: Issue / PR を選ぶ" });
});

test("staleDraft", () => {
  const draft = { workspaceId: "ws_a", text: "PR o/a#12 をマージまで" };
  expect(staleDraft(draft, { workspaceId: "ws_b", text: draft.text })).toBe(true);
  expect(staleDraft(draft, { workspaceId: null, text: draft.text })).toBe(true);
  expect(staleDraft(draft, { workspaceId: "ws_b", text: `${draft.text}。急ぎで` })).toBe(false);
  expect(staleDraft(draft, { workspaceId: "ws_a", text: draft.text })).toBe(false);
  expect(staleDraft(null, { workspaceId: "ws_b", text: "x" })).toBe(false);
});
