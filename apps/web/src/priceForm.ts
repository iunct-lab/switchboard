import type { SettingsPrice } from "@switchboard/protocol";

/** The settings screen's price form (#1402): every box is text, USD / 1M tokens. */
export interface PriceForm {
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  cacheWrite1h: string;
}

export const EMPTY_PRICE_FORM: PriceForm = { model: "", input: "", output: "", cacheRead: "", cacheWrite: "", cacheWrite1h: "" };

/**
 * The row to save, or why not (an empty model name, a value that is not a number or is negative). An empty cache read /
 * cache write is 0; an empty 1-hour cache write is left out (the ledger then uses cache write). The daemon checks again (400).
 */
export function parsePriceForm(f: PriceForm): { model: string; price: SettingsPrice } | string {
  const model = f.model.trim();
  if (!model) return "モデル名を入れてください";
  // `empty`: what an empty box means — a value, required (an error), or left out (undefined)
  const num = (label: string, text: string, empty: number | "required" | "omit"): number | string | undefined => {
    if (text.trim() === "") return empty === "required" ? `${label} を入れてください` : empty === "omit" ? undefined : empty;
    const n = Number(text);
    if (!Number.isFinite(n)) return `${label} が数ではありません: ${text}`;
    if (n < 0) return `${label} は 0 以上にしてください: ${text}`;
    return n;
  };
  const input = num("input", f.input, "required");
  const output = num("output", f.output, "required");
  const cacheRead = num("cache read", f.cacheRead, 0);
  const cacheWrite = num("cache write", f.cacheWrite, 0);
  const cacheWrite1h = num("cache write 1h", f.cacheWrite1h, "omit");
  for (const v of [input, output, cacheRead, cacheWrite, cacheWrite1h]) if (typeof v === "string") return v;
  const price: SettingsPrice = { input: input as number, output: output as number, cacheRead: cacheRead as number, cacheWrite: cacheWrite as number };
  if (cacheWrite1h !== undefined) price.cacheWrite1h = cacheWrite1h as number;
  return { model, price };
}

/** The form filled from a saved row, for 直す. */
export function priceFormOf(model: string, p: SettingsPrice): PriceForm {
  return { model, input: String(p.input), output: String(p.output), cacheRead: String(p.cacheRead), cacheWrite: String(p.cacheWrite), cacheWrite1h: p.cacheWrite1h === undefined ? "" : String(p.cacheWrite1h) };
}

