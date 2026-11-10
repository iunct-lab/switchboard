/**
 * Process candidates as data (docs/design/process-kernel.md, K4): one Markdown file per candidate under
 * `ops-kit/processes/<id>.md`, with YAML frontmatter (`id`, `version`, `title`, `fits`) and the text a Task gets at
 * each entry in `## entry <name>` sections. The daemon reads a definition when a Task starts and renders the entry
 * with `renderEntry`; the file is the only copy of the text, so changing a candidate is editing its file, not core.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { findRepoRoot } from "./config.ts";

/** Where the candidates live, relative to the meta repository's root (beside `ops-kit/skills`). */
export const PROCESS_SOURCE = "ops-kit/processes";

export type ProcessAuto = { maxBodyChars?: number; excludeLabels?: string[] };

export type ProcessDef = {
  id: string;
  version: number;
  title: string;
  /** The kinds of work the candidate is meant for, as its author wrote them (free text, one line each). */
  fits: string[];
  /**
   * When a request may start in this candidate without a person choosing (#4322): `maxBodyChars` = the body's length limit,
   * `excludeLabels` = labels that keep it out. null = the candidate is never chosen automatically (the default one).
   */
  auto: ProcessAuto | null;
  /** `## entry <name>` → the section's text, trimmed. */
  entries: Record<string, string>;
  /** The file it was read from (for messages). */
  path: string;
};

const ENTRY = /^## entry (\S+)\s*$/;

/** Parse one definition. Throws with the path and the reason when the frontmatter is missing a required key. */
export function parseProcessDef(text: string, path: string): ProcessDef {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  // the frontmatter must open the file: a `---` rule later in the prose is not one
  // the closing fence is a line of its own; the block between may be empty
  const m = body.match(/^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if (!m) throw new Error(`${path}: no frontmatter (--- … ---)`);
  const y = parseYaml(m[1] ?? "") as unknown;
  if (y === null || typeof y !== "object" || Array.isArray(y)) throw new Error(`${path}: frontmatter must be a mapping (key: value)`);
  const fm = y as Record<string, unknown>;
  if (typeof fm.id !== "string" || !fm.id.trim()) throw new Error(`${path}: frontmatter needs \`id\``);
  if (typeof fm.version !== "number" || !Number.isInteger(fm.version) || fm.version < 1) throw new Error(`${path}: frontmatter needs an integer \`version\` ≥ 1`);
  if (typeof fm.title !== "string" || !fm.title.trim()) throw new Error(`${path}: frontmatter needs \`title\``);
  const fits = fm.fits === undefined ? [] : fm.fits;
  if (!Array.isArray(fits) || fits.some((f) => typeof f !== "string")) throw new Error(`${path}: \`fits\` must be a list of strings`);
  let auto: ProcessAuto | null = null;
  if (fm.auto !== undefined && fm.auto !== null) {
    const a = fm.auto;
    if (typeof a !== "object" || Array.isArray(a)) throw new Error(`${path}: \`auto\` must be a mapping (maxBodyChars, excludeLabels)`);
    const { maxBodyChars, excludeLabels } = a as Record<string, unknown>;
    if (maxBodyChars !== undefined && (typeof maxBodyChars !== "number" || !Number.isInteger(maxBodyChars) || maxBodyChars < 0)) throw new Error(`${path}: \`auto.maxBodyChars\` must be an integer ≥ 0`);
    if (excludeLabels !== undefined && (!Array.isArray(excludeLabels) || excludeLabels.some((l) => typeof l !== "string"))) throw new Error(`${path}: \`auto.excludeLabels\` must be a list of strings`);
    auto = { ...(maxBodyChars !== undefined ? { maxBodyChars: maxBodyChars as number } : {}), ...(excludeLabels !== undefined ? { excludeLabels: excludeLabels as string[] } : {}) };
  }
  const entries: Record<string, string> = {};
  let name: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (name !== null) entries[name] = lines.join("\n").trim();
  };
  for (const line of body.slice(m[0].length).split(/\r?\n/)) {
    const e = line.match(ENTRY);
    if (e) {
      flush();
      name = e[1]!;
      if (name in entries) throw new Error(`${path}: entry \`${name}\` appears twice`);
      lines = [];
    } else if (name !== null) lines.push(line);
  }
  flush();
  return { id: fm.id.trim(), version: fm.version, title: fm.title.trim(), fits: fits as string[], auto, entries, path };
}

/**
 * The directory the candidates are read from: `<root>/ops-kit/processes`. Callers in the daemon pass the meta workspace's
 * path (the checkout the shared skills are read from), so an edit there reaches the next Task without a promotion; the
 * default — this code's own repository, the release when run from one — is for tests and tools run from a checkout.
 */
export function processDir(root = findRepoRoot(import.meta.dir)): string {
  return join(root, PROCESS_SOURCE);
}

/** Every candidate under the directory, by file name. A file whose `id` differs from its name is refused. */
export function listProcesses(root?: string): ProcessDef[] {
  const dir = processDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => {
      const path = join(dir, f);
      const def = parseProcessDef(readFileSync(path, "utf8"), path);
      if (def.id !== f.slice(0, -3)) throw new Error(`${path}: id \`${def.id}\` must equal the file name`);
      return def;
    });
}

/** One candidate by id. Throws when there is no such file (a stage that names a missing candidate must not start silently on nothing). */
export function loadProcess(id: string, root?: string): ProcessDef {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`process id \`${id}\` is not a file name (lower-case letters, digits, hyphens)`);
  const path = join(processDir(root), `${id}.md`);
  if (!existsSync(path)) throw new Error(`process \`${id}\` not found (${path})`);
  const def = parseProcessDef(readFileSync(path, "utf8"), path);
  if (def.id !== id) throw new Error(`${path}: id \`${def.id}\` must equal the file name`);
  return def;
}

/**
 * The text of an entry with every `{{key}}` replaced from `vars`. A key the entry uses but `vars` does not name is an
 * error (the Task would read a literal `{{…}}`), and so is an entry the definition does not have.
 */
export function renderEntry(def: ProcessDef, entry: string, vars: Record<string, string | number>): string {
  const text = def.entries[entry];
  if (text === undefined) throw new Error(`${def.path}: no \`## entry ${entry}\``);
  const out = text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`${def.path}: entry \`${entry}\` uses {{${key}}}, which was not given`);
    return String(v);
  });
  return out;
}
