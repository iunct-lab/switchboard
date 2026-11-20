/**
 * The limits and allowances the checks hold: a PR that raises one, or adds an entry, is asked of the owner at the merge
 * decision (`limits`), because a raised ceiling or a new allowance hides, on every later merge, what it was set to catch.
 * Lowering a ceiling or removing an entry is not asked: perf-ratchet's `update` and the clearing of expired known failures
 * are such changes. Removing a perf-budget ceiling is asked: the ratchet only checks the ceilings that exist, so a removed
 * one is no longer checked at all. A file that cannot be read, or whose shape is not the expected one, counts as raised.
 */
import type { FileStatus } from "./merge-gate";

export const LIMIT_FILES = ["scripts/perf-budget.json", "scripts/licenses.allow.json", "known-failures.json", "scripts/file-size.ts"];

const UNREADABLE = "読めない（上げたとして聞く）";
const NONE = "(なし)";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every leaf of an object tree, by its dotted path (the `exceptions` list is read apart). Ceilings are numbers; another leaf is a shape the ratchet does not expect. */
function leaves(v: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (!isObject(v)) out.set(prefix, v);
  else for (const [k, x] of Object.entries(v)) if (prefix || k !== "exceptions") leaves(x, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** The entries of a list that the base does not have (by `key`), and those whose `until` (YYYY-MM-DD) is later than the base's. */
function listRaised(label: string, key: (e: unknown) => string, base: unknown[], head: unknown[]): string[] {
  const was = new Map(base.map((e) => [key(e), e]));
  const out: string[] = [];
  for (const e of head) {
    const before = was.get(key(e));
    const until = isObject(e) && typeof e.until === "string" ? e.until : undefined;
    const beforeUntil = isObject(before) && typeof before.until === "string" ? before.until : undefined;
    if (before === undefined) out.push(`${label}: ${NONE} → ${JSON.stringify(e)}`);
    else if (until !== undefined && (beforeUntil === undefined || until > beforeUntil)) out.push(`${label} ${key(e)} until: ${beforeUntil ?? NONE} → ${until}`);
  }
  return out;
}

function parseJson(text: string | null, empty: unknown): unknown {
  if (text === null) return empty;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * What a PR raises in one limit file, one line each: `<path> <key>: <before> → <after>`. `base` / `head` are the file's text
 * before and after; null = the file does not exist there (a new file adds everything it holds, a removed one raises nothing).
 */
export function limitsRaised(path: string, base: string | null, head: string | null): string[] {
  if (head === null) return [];
  const unreadable = [`${path}: ${UNREADABLE}`];
  if (path === "scripts/file-size.ts") {
    const limit = (text: string | null, name: string) => (text === null ? NONE : new RegExp(`^export const ${name} = (\\d+);`, "m").exec(text)?.[1]);
    const out: string[] = [];
    for (const name of ["SOURCE_LIMIT", "TEST_LIMIT"]) {
      const was = limit(base, name);
      const now = limit(head, name);
      if (was === undefined || now === undefined) return unreadable;
      if (was === NONE || Number(now) > Number(was)) out.push(`${path} ${name}: ${was} → ${now}`);
    }
    return out;
  }
  const before = parseJson(base, path === "scripts/perf-budget.json" || path === "scripts/licenses.allow.json" ? {} : []);
  const after = parseJson(head, undefined);
  if (path === "known-failures.json") {
    if (!Array.isArray(before) || !Array.isArray(after)) return unreadable;
    return listRaised(path, (e) => (isObject(e) ? String(e.test) : JSON.stringify(e)), before, after);
  }
  if (!isObject(before) || !isObject(after)) return unreadable;
  const list = (v: Record<string, unknown>, k: string) => (v[k] === undefined ? [] : Array.isArray(v[k]) ? (v[k] as unknown[]) : null);
  if (path === "scripts/perf-budget.json") {
    const was = leaves(before, "", new Map());
    const now = leaves(after, "", new Map());
    if ([...was.values(), ...now.values()].some((n) => typeof n !== "number")) return unreadable;
    const out = [
      ...[...now].filter(([k, n]) => (n as number) > ((was.get(k) as number | undefined) ?? -Infinity)).map(([k, n]) => `${path} ${k}: ${was.get(k) ?? NONE} → ${n}`),
      ...[...was].filter(([k]) => !now.has(k)).map(([k, n]) => `${path} ${k}: ${n} → ${NONE}`),
    ];
    const bx = list(before, "exceptions");
    const ax = list(after, "exceptions");
    if (bx === null || ax === null) return unreadable;
    return [...out, ...listRaised(`${path} exceptions`, (e) => (isObject(e) ? `${e.key} ${e.issue}` : JSON.stringify(e)), bx, ax)];
  }
  if (path === "scripts/licenses.allow.json") {
    const ba = list(before, "allowed");
    const aa = list(after, "allowed");
    const bx = list(before, "exceptions");
    const ax = list(after, "exceptions");
    if (ba === null || aa === null || bx === null || ax === null) return unreadable;
    const had = new Set(ba);
    return [
      ...aa.filter((w) => !had.has(w)).map((w) => `${path} allowed: ${NONE} → ${JSON.stringify(w)}`),
      ...listRaised(`${path} exceptions`, (e) => (isObject(e) ? `${e.name} ${e.license}` : JSON.stringify(e)), bx, ax),
    ];
  }
  return unreadable;
}

/**
 * The raised limits of the limit files among a change's files. `read` gives a file's text on one side (it throws when it
 * cannot): a file that was added has no base, a file that was removed has no head, and a side that cannot be read counts as raised.
 */
export async function limitsRaisedOf(files: { path: string; status?: FileStatus }[], read: (side: "base" | "head", path: string) => Promise<string>): Promise<string[]> {
  const out: string[] = [];
  for (const f of files.filter((x) => LIMIT_FILES.includes(x.path))) {
    try {
      const base = f.status === "added" ? null : await read("base", f.path);
      const head = f.status === "removed" ? null : await read("head", f.path);
      out.push(...limitsRaised(f.path, base, head));
    } catch {
      out.push(`${f.path}: ${UNREADABLE}`);
    }
  }
  return out;
}
