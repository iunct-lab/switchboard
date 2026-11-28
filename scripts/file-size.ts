/**
 * bun scripts/file-size.ts — a file of the product's code stays small enough that one feature's change touches that
 * feature's file: under `ROOTS`, a source file has at most 1,000 lines and a test file at most 2,000. Exit 1 with one
 * line per file over its limit; 0 otherwise. A step of the CI (scripts/ci.ts).
 *
 * `STILL_OVER` names the files that were over the limit when the check was added, each with its line count as its
 * ceiling. A ceiling only goes down, and the check holds that, not the reader of a diff:
 * - a listed file must have exactly its ceiling's lines: more fails, and fewer fails until the ceiling is lowered to
 *   the new count (so the room a file gave back cannot be used again);
 * - the list is compared with the base's: `FILE_SIZE_BASE_LIST` (the same shape as `STILL_OVER`, as JSON: what the host
 *   gives a build off the host, which has no base ref), else the base ref's (`origin/main`, or `FILE_SIZE_BASE_REF`). An
 *   entry the base does not have, or a ceiling above the base's, fails. Nothing is added to the list, and no ceiling is
 *   raised. The run says in one line what it compared with;
 * - an entry of a file that is within the limit, or gone, fails, so the list does not outlive the files.
 * Where the base cannot be read (a checkout with no history, a base from before this check, a FILE_SIZE_BASE_LIST that
 * is not such a JSON), the run says why in one line and fails: the comparison is never skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The directories checked, with what is under them. The tools of the development flow (scripts/, ops-kit/) are not checked. */
export const ROOTS = ["packages/core/src", "packages/protocol/src", "apps/web/src"];
export const SOURCE_LIMIT = 1000;
export const TEST_LIMIT = 2000;

/** path → ceiling (the lines it has now: lowered whenever it shrinks, never raised). One entry per line — `listedIn` reads the base's list from this text. See the head of this file. */
export const STILL_OVER: Record<string, number> = {
  // the screen's components: splitting them needs a look at the screens, which the split of the core's code left out
  "apps/web/src/components/Backlog.tsx": 1505,
  "apps/web/src/components/Settings.tsx": 1462,
};

export const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);
export const limitOf = (path: string): number => (isTest(path) ? TEST_LIMIT : SOURCE_LIMIT);
/** Lines as `wc -l` counts them. */
export const lineCount = (text: string): number => text.split("\n").length - 1;

/** One line per failure: a file over its limit, a listed file that has not exactly its ceiling's lines, and an entry of `over` whose file is within the limit or not there. */
export function check(files: Array<{ path: string; lines: number }>, over: Record<string, number> = STILL_OVER): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { path, lines } of files) {
    const limit = limitOf(path);
    const ceiling = over[path];
    if (ceiling !== undefined) {
      seen.add(path);
      if (lines <= limit) out.push(`${path}: ${lines} lines is within the limit of ${limit}: remove its entry from STILL_OVER (scripts/file-size.ts)`);
      else if (lines > ceiling) out.push(`${path}: ${lines} lines > its ceiling ${ceiling} (the limit is ${limit}; the ceiling only goes down)`);
      else if (lines < ceiling) out.push(`${path}: ${lines} lines is under its ceiling ${ceiling}: lower the ceiling to ${lines} in STILL_OVER (scripts/file-size.ts)`);
    } else if (lines > limit) out.push(`${path}: ${lines} lines > ${limit} (${isTest(path) ? "a test file" : "a source file"}): split it by feature`);
  }
  for (const path of Object.keys(over)) if (!seen.has(path)) out.push(`${path}: not there any more: remove its entry from STILL_OVER (scripts/file-size.ts)`);
  return out;
}

/** The list a text of this script holds (`STILL_OVER`), or null when the text has none: how the base ref's list is read. */
export function listedIn(source: string): Record<string, number> | null {
  // a list of several lines ends with a line `};`; an emptied list may be written `= {};` on its own line
  const block = /^export const STILL_OVER\b[^=]*=\s*\{(\s*\}|[\s\S]*?^\});/m.exec(source);
  return block ? Object.fromEntries([...block[1]!.matchAll(/^\s*"([^"]+)":\s*(\d+)\s*,?\s*$/gm)].map((m) => [m[1]!, Number(m[2])])) : null;
}

/** One line per entry of `over` that the base's list does not allow: an entry the base lacks, or a ceiling above the base's. */
export function raisedAgainst(over: Record<string, number>, base: Record<string, number>): string[] {
  return Object.entries(over).flatMap(([path, ceiling]) =>
    base[path] === undefined
      ? [`${path}: added to STILL_OVER (the base's list does not have it): nothing is added to the list, split the file`]
      : ceiling > base[path]!
        ? [`${path}: its ceiling ${ceiling} > the base's ${base[path]}: a ceiling only goes down`]
        : [],
  );
}

/** The ref the list is compared with: origin/main, or FILE_SIZE_BASE_REF. */
const baseRef = () => process.env.FILE_SIZE_BASE_REF || "origin/main";

/**
 * The base's list, or why there is none to compare with: FILE_SIZE_BASE_LIST when it is given (not a JSON of path → ceiling is
 * the reason), else the base ref's (no such ref in a checkout without history, or a base from before this check).
 */
export function baseList(root: string): Record<string, number> | string {
  const given = process.env.FILE_SIZE_BASE_LIST;
  if (given) {
    let list: unknown;
    try {
      list = JSON.parse(given);
    } catch (e) {
      return `not JSON (${e instanceof Error ? e.message : String(e)})`;
    }
    const ok = typeof list === "object" && list !== null && !Array.isArray(list) && Object.values(list).every((n) => Number.isInteger(n));
    return ok ? (list as Record<string, number>) : "not a JSON object of path → ceiling";
  }
  const p = Bun.spawnSync(["git", "show", `${baseRef()}:scripts/file-size.ts`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return p.stderr.toString().trim().split("\n")[0] ?? `exit ${p.exitCode}`;
  return listedIn(p.stdout.toString()) ?? "it has no STILL_OVER";
}

/** The `.ts` / `.tsx` files under `ROOTS` of the checkout at `root`, with their line counts. */
export function measure(root: string, roots: string[] = ROOTS): Array<{ path: string; lines: number }> {
  const out: Array<{ path: string; lines: number }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist") walk(path); }
      else if (/\.tsx?$/.test(e.name)) out.push({ path, lines: lineCount(readFileSync(join(root, path), "utf8")) });
    }
  };
  for (const r of roots) walk(r);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const files = measure(root);
  const base = baseList(root);
  const failures = [...check(files), ...(typeof base === "string" ? [] : raisedAgainst(STILL_OVER, base))];
  for (const f of failures) console.log(f);
  const given = !!process.env.FILE_SIZE_BASE_LIST;
  if (typeof base !== "string") console.log(`the ceilings are compared with ${given ? "FILE_SIZE_BASE_LIST" : baseRef()}`);
  else console.log(`the ceilings cannot be compared with the base's (${given ? "FILE_SIZE_BASE_LIST" : `${baseRef()}:scripts/file-size.ts`}: ${base})`);
  console.log(`files: ${files.length} / over: ${failures.length} / still over (listed): ${Object.keys(STILL_OVER).length}`);
  process.exit(failures.length || typeof base === "string" ? 1 : 0);
}
