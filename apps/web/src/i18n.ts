/**
 * The screen's language (docs/design/ui-language.md, "Language switch"): Japanese by default, English when this browser chose it.
 * The choice is per browser, in localStorage; the module reads it once at load, and a change reloads the page.
 * Wording lives in dictionaries, one per screen under `i18n/`, each entry `{ ja, en }`.
 */
export type Lang = "ja" | "en";
export const LANG_KEY = "switchboard.lang";

/** `en` only when stored as such; anything else, or storage that cannot be read, is Japanese. */
export function readLang(s: Pick<Storage, "getItem"> | undefined): Lang {
  try {
    return s?.getItem(LANG_KEY) === "en" ? "en" : "ja";
  } catch {
    return "ja";
  }
}

/** This browser's choice; a `localStorage` that throws on access (storage blocked by the browser's policy) is Japanese. */
export function browserLang(g: { readonly localStorage?: Pick<Storage, "getItem"> } = globalThis): Lang {
  try {
    return readLang(g.localStorage);
  } catch {
    return "ja";
  }
}

export const lang: Lang = browserLang();

export type Msg = { ja: string; en: string };

/** A screen's dictionary; an entry without both languages fails the type check. */
export function msgs<T extends Record<string, Msg>>(m: T): T {
  return m;
}

/** The entry in the language, with each `{name}` replaced by `vars.name` (left as it is when not given). */
export function t(m: Msg, vars?: Record<string, string | number>, l: Lang = lang): string {
  const text = m[l];
  return vars ? text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all)) : text;
}

/** Saves the choice and reloads, so every module reads it again. False when the browser refuses to store it (nothing changes). */
export function setLang(l: Lang): boolean {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    return false;
  }
  location.reload();
  return true;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

/** Entries (`file.key`) with an empty side, or whose `{name}` placeholders differ between the two languages. */
export function missingText(dicts: Record<string, Record<string, Msg>>): string[] {
  const out: string[] = [];
  for (const [file, dict] of Object.entries(dicts))
    for (const [key, m] of Object.entries(dict))
      if (!m.ja?.trim() || !m.en?.trim() || placeholders(m.ja) !== placeholders(m.en)) out.push(`${file}.${key}`);
  return out;
}
