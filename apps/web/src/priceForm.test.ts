import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PriceRows } from "./components/Ledger.tsx";
import { EMPTY_PRICE_FORM, parsePriceForm, priceFormOf } from "./priceForm.ts";

const form = (f: Partial<typeof EMPTY_PRICE_FORM>) => ({ ...EMPTY_PRICE_FORM, ...f });

test("parsePriceForm (#1402): a full row, the model name trimmed", () => {
  expect(parsePriceForm(form({ model: " claude-x ", input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75", cacheWrite1h: "6" }))).toEqual({ model: "claude-x", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 } });
});

test("parsePriceForm: empty cache read / write are 0; an empty 1-hour cache write is left out", () => {
  expect(parsePriceForm(form({ model: "m", input: "1", output: "2" }))).toEqual({ model: "m", price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
});

test("parsePriceForm: an empty model name, an empty input, a non-number and a negative value are refused with why", () => {
  expect(parsePriceForm(form({ model: "  ", input: "1", output: "2" }))).toBe("モデル名を入れてください");
  expect(parsePriceForm(form({ model: "m", output: "2" }))).toBe("input を入れてください");
  expect(parsePriceForm(form({ model: "m", input: "abc", output: "2" }))).toBe("input が数ではありません: abc");
  expect(parsePriceForm(form({ model: "m", input: "1", output: "-1" }))).toBe("output は 0 以上にしてください: -1");
  expect(parsePriceForm(form({ model: "m", input: "1", output: "2", cacheWrite1h: "x" }))).toBe("cache write 1h が数ではありません: x");
});

test("priceFormOf fills the form back from a saved row (直す), and parses to the same row", () => {
  const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
  expect(priceFormOf("m", price)).toEqual({ model: "m", input: "1", output: "2", cacheRead: "0.1", cacheWrite: "1.25", cacheWrite1h: "" });
  expect(parsePriceForm(priceFormOf("m", price))).toEqual({ model: "m", price });
});


test("the Ledger's price rows: only the models the daemon lists in fromSettings carry the 設定 tag", () => {
  const models = { "claude-opus-4": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, "ui-model": { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const html = renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(PriceRows, { models, fromSettings: ["ui-model"] }))));
  const rows = html.split("<tr>").slice(1);
  expect(rows[0]).toContain("claude-opus-4");
  expect(rows[0]).not.toContain(">設定<");
  expect(rows[1]).toContain('ui-model<span class="tag">設定</span>');
  expect(rows[1]).toContain("$1.5");
});
