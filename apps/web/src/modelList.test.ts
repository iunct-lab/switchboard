import { expect, test } from "bun:test";
import { addModel, moveModel, removeModel } from "./modelList.ts";

const opt = (value: string, label = value) => ({ value, label });
const list = [opt("a", "A"), opt("b", "B"), opt("c", "C")];

test("addModel (#1400): appended at the end, trimmed; an empty label is the id", () => {
  expect(addModel(list, " d ", " D ")).toEqual([...list, opt("d", "D")]);
  expect(addModel(list, "d", "  ")).toEqual([...list, opt("d")]);
  expect(list).toHaveLength(3); // the given list is not changed
});

test("addModel: an empty id and an id already listed are refused with why", () => {
  expect(addModel(list, "  ", "X")).toBe("モデルの id を入れてください");
  expect(addModel(list, " b", "")).toBe("b は一覧にあります");
});

test("removeModel: drops the one id; an unknown id leaves the list as it is", () => {
  expect(removeModel(list, "b")).toEqual([opt("a", "A"), opt("c", "C")]);
  expect(removeModel(list, "x")).toEqual(list);
});

test("moveModel: up and down swap with the neighbour; at either end and for an unknown id nothing moves", () => {
  expect(moveModel(list, "b", -1)).toEqual([opt("b", "B"), opt("a", "A"), opt("c", "C")]);
  expect(moveModel(list, "b", 1)).toEqual([opt("a", "A"), opt("c", "C"), opt("b", "B")]);
  expect(moveModel(list, "a", -1)).toBe(list);
  expect(moveModel(list, "c", 1)).toBe(list);
  expect(moveModel(list, "x", 1)).toBe(list);
});
