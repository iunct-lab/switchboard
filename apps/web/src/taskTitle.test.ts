import { expect, test } from "bun:test";
import { listTitle, titleToSave, titleToSend } from "./taskTitle.ts";

test("titleToSend: empty or only the inserted prefix sends no title; anything the person wrote is sent trimmed", () => {
  expect(titleToSend("")).toBeUndefined();
  expect(titleToSend("   ")).toBeUndefined();
  expect(titleToSend("repo を改善: ", "repo を改善: ")).toBeUndefined();
  expect(titleToSend("repo を改善: ", undefined)).toBe("repo を改善:");
  expect(titleToSend(" repo を改善: 誤字 ", "repo を改善: ")).toBe("repo を改善: 誤字");
  expect(titleToSend("自分で付けた")).toBe("自分で付けた");
});

test("titleToSave: an empty or unchanged title is not saved; a changed one is, trimmed", () => {
  expect(titleToSave("", "今の名前")).toBeNull();
  expect(titleToSave("  ", "今の名前")).toBeNull();
  expect(titleToSave("今の名前", "今の名前")).toBeNull();
  expect(titleToSave(" 新しい名前 ", "今の名前")).toBe("新しい名前");
});

test("listTitle (#4060): a stage Task's PBI: / 要望: after the stage goes, any other title stays", () => {
  expect(listTitle("#2305 実装: PBI: クラウドのホストでは")).toBe("#2305 実装: クラウドのホストでは");
  expect(listTitle("#3911 Task に分解: PBI: 画面の")).toBe("#3911 Task に分解: 画面の");
  expect(listTitle("#302 PBI にする: 要望: 一覧を")).toBe("#302 PBI にする: 一覧を");
  expect(listTitle("ストーリーポイントの PBI: 見直し")).toBe("ストーリーポイントの PBI: 見直し");
  expect(listTitle("#12 実装: 題に PBI: を含む")).toBe("#12 実装: 題に PBI: を含む");
});
