// test-reads: apps/web/src/i18n/
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { browserLang, LANG_KEY, missingText, readLang, t, type Msg } from "./i18n.ts";

const dir = new URL("./i18n/", import.meta.url);
/** Every dictionary under i18n/, by file name: each export of each file. */
async function allDicts(): Promise<Record<string, Record<string, Msg>>> {
  const out: Record<string, Record<string, Msg>> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const mod = (await import(new URL(f, dir).href)) as Record<string, Record<string, Msg>>;
    for (const [name, dict] of Object.entries(mod)) out[`${f.replace(/\.ts$/, "")}.${name}`] = dict;
  }
  return out;
}

describe("dictionaries", () => {
  test("every entry of every dictionary has both languages, with the same placeholders", async () => {
    const dicts = await allDicts();
    expect(Object.keys(dicts).length).toBeGreaterThan(0);
    expect(missingText(dicts)).toEqual([]);
  });

  test("missingText names an empty side and placeholders that differ", () => {
    const d = { ok: { ja: "{n} 件", en: "{n} items" }, noEn: { ja: "保存", en: "" }, blankJa: { ja: " ", en: "Save" }, vars: { ja: "{n} 件", en: "{count} items" } };
    expect(missingText({ x: d })).toEqual(["x.noEn", "x.blankJa", "x.vars"]);
  });
});

describe("readLang", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === LANG_KEY ? v : null) });
  test("en only when stored as en; nothing, ja or another value is ja", () => {
    expect(readLang(store("en"))).toBe("en");
    expect(readLang(store("ja"))).toBe("ja");
    expect(readLang(store(null))).toBe("ja");
    expect(readLang(store("fr"))).toBe("ja");
    expect(readLang(undefined)).toBe("ja");
  });
  test("storage that throws (blocked by the browser) is ja", () => {
    expect(readLang({ getItem: () => { throw new Error("denied"); } })).toBe("ja");
  });
  test("a localStorage whose getter throws (SecurityError) is ja, so the screen still loads", () => {
    const blocked = { get localStorage(): Storage { throw new Error("SecurityError"); } };
    expect(browserLang(blocked)).toBe("ja");
    expect(browserLang({})).toBe("ja");
    expect(browserLang({ localStorage: store("en") })).toBe("en");
  });
});

describe("t", () => {
  const m = { ja: "{n} 件 / {name}", en: "{n} items / {name}" };
  test("picks the language and fills the placeholders", () => {
    expect(t(m, { n: 3, name: "x" }, "ja")).toBe("3 件 / x");
    expect(t(m, { n: 3, name: "x" }, "en")).toBe("3 items / x");
  });
  test("a placeholder without a value stays as it is", () => {
    expect(t(m, { n: 1 }, "en")).toBe("1 items / {name}");
    expect(t({ ja: "保存", en: "Save" }, undefined, "en")).toBe("Save");
  });
});
