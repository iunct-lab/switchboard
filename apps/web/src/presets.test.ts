import { expect, test } from "bun:test";
import type { Preset, PresetList, PresetUse } from "@switchboard/protocol";
import { forgetPresets, loadPresets, markMatch, presetRow, staleDraft, suggestPresets, usesTarget } from "./presets.ts";

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

const preset = (id: string, name: string, text: string, updatedAt: number): Preset => ({ id, name, text, createdAt: 0, updatedAt });
const use = (id: string, home: number, task: number, lastAt: number | null): PresetUse => ({ id, home, task, lastAt });
const names = (l: Preset[]) => l.map((p) => p.name);

test("suggestPresets: an empty box offers the most used in the scene, then the latest used, then the latest edited", () => {
  const list = [preset("a", "新しい", "x", 90), preset("b", "よく使う", "x", 10), preset("c", "最近使った", "x", 20), preset("d", "古い", "x", 5), preset("e", "task だけ", "x", 1)];
  const uses = [use("b", 5, 0, 100), use("c", 2, 0, 900), use("d", 2, 0, 800), use("e", 0, 9, 700)];
  expect(names(suggestPresets(list, uses, "home", ""))).toEqual(["よく使う", "最近使った", "古い"]);
  expect(names(suggestPresets(list, uses, "task", ""))).toEqual(["task だけ", "最近使った", "古い"]);
  expect(names(suggestPresets(list, [], "home", ""))).toEqual(["新しい", "最近使った", "よく使う"]); // no record: the latest edited
});

test("suggestPresets: typed text keeps the name or text that holds it, in the same order", () => {
  const list = [preset("a", "レビュー対応", "PR {{target}} をマージまで", 1), preset("b", "状況", "Review の状況を確認", 2), preset("c", "別件", "関係なし", 3)];
  expect(names(suggestPresets(list, [], "home", "review"))).toEqual(["状況"]); // the text, any case
  expect(names(suggestPresets(list, [], "home", "レビ"))).toEqual(["レビュー対応"]);
  expect(names(suggestPresets(list, [use("a", 1, 0, 5)], "home", "マージ"))).toEqual(["レビュー対応"]);
  expect(suggestPresets(list, [], "home", "ない言葉")).toEqual([]);
  expect(names(suggestPresets(list, [], "home", " 状況 "))).toEqual(["状況"]);
});

test("suggestPresets: a line break or over 40 characters is a request being written, not a search", () => {
  const list = [preset("a", "あ".repeat(41), "あ\nい", 1)];
  expect(names(suggestPresets(list, [], "home", "あ".repeat(40)))).toEqual(["あ".repeat(41)]);
  expect(suggestPresets(list, [], "home", "あ".repeat(41))).toEqual([]);
  expect(suggestPresets(list, [], "home", "あ\nい")).toEqual([]);
});

test("suggestPresets: blanks only or 1 character offers nothing, 2 characters narrow", () => {
  const list = [preset("a", "Apple", "x", 1), preset("b", "Avocado", "x", 2), preset("c", "Banana", "x", 3)];
  expect(suggestPresets(list, [], "home", "A")).toEqual([]);
  expect(suggestPresets(list, [], "home", " ")).toEqual([]);
  expect(suggestPresets(list, [], "home", "  A ")).toEqual([]);
  expect(names(suggestPresets(list, [], "home", "Ap"))).toEqual(["Apple"]);
  expect(names(suggestPresets(list, [], "home", ""))).toHaveLength(3);
});

test("suggestPresets: 30 presets give 3", () => {
  const list = Array.from({ length: 30 }, (_, i) => preset(`p${i}`, `定型 ${i}`, `返事 ${i}`, i));
  expect(names(suggestPresets(list, [], "task", ""))).toEqual(["定型 29", "定型 28", "定型 27"]);
  expect(suggestPresets(list, [], "task", "定型")).toHaveLength(3);
});

test("markMatch splits the name around the typed text, any case", () => {
  expect(markMatch("Review 対応", " review")).toEqual(["", "Review", " 対応"]);
  expect(markMatch("対応", "")).toEqual(["対応", "", ""]);
  expect(markMatch("対応", "x")).toEqual(["対応", "", ""]);
});

test("loadPresets reads once and reuses it; a failed read and forgetPresets read again", async () => {
  const list: PresetList = { presets: [preset("a", "あ", "あ", 1)], uses: [] };
  let reads = 0;
  let fail = true;
  const read = async () => { reads++; if (fail) throw new Error("down"); return list; };
  forgetPresets();
  await expect(loadPresets(read)).rejects.toThrow("down");
  await Promise.resolve();
  fail = false;
  expect(await loadPresets(read)).toBe(list);
  expect(await loadPresets(read)).toBe(list);
  expect(reads).toBe(2);
  forgetPresets();
  await loadPresets(read);
  expect(reads).toBe(3);
  forgetPresets();
});

test("suggestPresets: a text starting with / offers no preset", () => {
  const list = [preset("a", "pbi を進める", "/pbi-complete 12 して", 1)];
  expect(suggestPresets(list, [], "home", "/")).toEqual([]);
  expect(suggestPresets(list, [], "task", "/pbi")).toEqual([]);
  expect(names(suggestPresets(list, [], "task", "pbi"))).toEqual(["pbi を進める"]); // the same text without the slash still matches
});
