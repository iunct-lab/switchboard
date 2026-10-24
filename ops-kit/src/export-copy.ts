import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * A copy of the kit for a repository that cannot read this one (a public repository vendors it, #205 criterion 6).
 * The copy holds what runs (no tests, no test fixtures), `KIT_VERSION` says which commit it came from, and it is
 * checked against the private-words list before it replaces anything: a hit removes the copy and fails.
 */
export const KIT = join(import.meta.dir, "..");
export const VERSION_FILE = "KIT_VERSION";

export class ExportError extends Error {}

export function readPrivateWords(file?: string): string[] {
  if (!file) throw new ExportError("--words-file で固有語のリストを指定してください（検査を省略できないので止めます）");
  if (!existsSync(file)) throw new ExportError(`固有語のリストがありません: ${file}（無いまま検査すると素通りになるので止めます）`);
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/** Every file under `dir` whose path (from `dir`) or a line holds a word, case-insensitively. */
export function findPrivateWords(dir: string, words: string[]): string[] {
  const lower = words.map((w) => [w, w.toLowerCase()] as const);
  const hits: string[] = [];
  for (const f of files(dir)) {
    const name = relative(dir, f);
    for (const [w, lw] of lower) if (name.toLowerCase().includes(lw)) hits.push(`${name}: ${w}（名前）`);
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const l = line.toLowerCase();
        for (const [w, lw] of lower) if (l.includes(lw)) hits.push(`${name}:${i + 1}: ${w}`);
      });
  }
  return hits;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function kitVersion(kit: string, now: Date): string {
  const git = (...args: string[]) => spawnSync("git", ["-C", kit, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) throw new ExportError(`キットの版を読めません（git rev-parse HEAD）: ${head.stderr.trim()}`);
  const dirty = git("status", "--porcelain", "--", ".").stdout.trim() !== "";
  return [`commit ${head.stdout.trim()}`, `date ${now.toISOString()}`, ...(dirty ? ["dirty キットに未コミットの変更があった"] : [])].join("\n") + "\n";
}

/** What goes into the copy, from the kit's root. Only `--help`'s config example comes from fixtures/, only `lint`'s default choices (#2361) from template/. */
const PARTS = ["README.md", "src", "skills", "bin", "public", "package.json", "fixtures/config-with-phase.json", "template/ops.config.json"];

export interface ExportOptions {
  dest: string;
  kit?: string;
  wordsFile?: string;
  now?: Date;
}

/**
 * Writes the copy to `dest`. `dest` may be missing, empty, or an earlier copy (it has `KIT_VERSION`); anything else is
 * left alone. The copy is built next to `dest` and moved there only after the check passes.
 */
export function exportCopy({ dest, kit = KIT, wordsFile, now = new Date() }: ExportOptions): { dest: string; version: string } {
  const target = resolve(dest);
  const root = resolve(kit);
  if (target === root || target.startsWith(root + sep)) throw new ExportError(`コピー先がキットの中です: ${target}`);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new ExportError(`コピー先がディレクトリではありません: ${target}`);
    if (readdirSync(target).length > 0 && !existsSync(join(target, VERSION_FILE))) {
      throw new ExportError(`コピー先が空でなく、前のコピー（${VERSION_FILE} がある）でもありません: ${target}`);
    }
  }
  const words = readPrivateWords(wordsFile);
  const version = kitVersion(root, now);
  mkdirSync(dirname(target), { recursive: true });
  const work = mkdtempSync(join(dirname(target), ".ops-kit-export."));
  try {
    for (const part of PARTS) {
      // A link is copied as what it points at: a link would lead back into this checkout, and its target would go unchecked
      cpSync(join(root, part), join(work, part), { recursive: true, dereference: true, filter: (src) => !src.endsWith(".test.ts") });
    }
    // The license travels with the code. The parent's NOTICE does not: it names the parent and its author (words the
    // copy must not hold), and its third-party part (generated protocol types) is not in the kit. The repository that
    // ships the copy states the attribution in its own NOTICE (README).
    cpSync(join(root, "..", "LICENSE"), join(work, "LICENSE"));
    // The kit's tsconfig extends one outside the kit; the copy carries the options it needs.
    const base = JSON.parse(readFileSync(join(root, "..", "tsconfig.base.json"), "utf8")) as { compilerOptions: object };
    const { extends: _, ...own } = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as { extends?: string; compilerOptions: object };
    writeFileSync(join(work, "tsconfig.json"), JSON.stringify({ ...own, compilerOptions: { ...base.compilerOptions, ...own.compilerOptions } }, null, 2) + "\n");
    writeFileSync(join(work, VERSION_FILE), version);
    const hits = findPrivateWords(work, words);
    if (hits.length > 0) throw new ExportError(`コピーに固有語があります（コピーは消しました）:\n${hits.map((h) => `  ${h}`).join("\n")}`);
    rmSync(target, { recursive: true, force: true });
    renameSync(work, target);
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
  return { dest: target, version };
}
