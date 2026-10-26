import { expect, test } from "bun:test";
import { titleToSave, titleToSend } from "./taskTitle.ts";

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
