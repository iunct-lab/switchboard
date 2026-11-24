// test-reads: docs/merge-gate.md scripts/ packages/core/src/ ops-kit/src/
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The rows of the table under "## What the gate reads as a key" in docs/merge-gate.md: the key's words, and the `function` names grouped by the file they are read in. */
function keyRows(): { key: string; reads: { file: string; names: string[] }[] }[] {
  const doc = read("docs/merge-gate.md");
  const start = doc.indexOf("## What the gate reads as a key");
  expect(start).toBeGreaterThanOrEqual(0);
  const section = doc.slice(start).split(/\n## /)[0]!;
  const rows = section.split("\n").filter((l) => l.startsWith("|")).slice(2);
  return rows.map((line) => {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    expect(cells.length).toBe(3);
    const reads = cells[2]!.split(";").map((seg) => {
      const m = /^(.*?)\s*\(`([^`]+)`\)$/.exec(seg.trim());
      expect(m, `a "Read in" segment is "\`name\`, … (\`file\`)": ${seg}`).not.toBeNull();
      return { file: m![2]!, names: [...m![1]!.matchAll(/`([A-Za-z_]\w*)`/g)].map((x) => x[1]!) };
    });
    return { key: cells[0]!, reads };
  });
}

/** Which row (by the start of its first cell) reads each field of `PrFacts`. A field added to the type with no entry here fails the test below. */
const FIELD_ROWS: Record<string, string[]> = {
  files: ["The diff"],
  configScope: ["The diff"],
  designRulesTouched: ["The diff"],
  limitsRaised: ["The diff"],
  checks: ["GitHub's state"],
  unresolvedThreads: ["GitHub's state"],
  mergeState: ["GitHub's state"],
  head: ["GitHub's state"],
  base: ["GitHub's state"],
  branch: ["GitHub's state"],
  localCi: ["The app's records"],
  localCiNote: ["The app's records"],
  rechecks: ["The app's records"],
  reviewed: ["The app's records"],
  attacked: ["The app's records"],
  direct: ["The app's records"],
  threadsUnread: ["The app's records"],
  threadsUnknown: ["The app's records"],
  subject: ["The app's records"],
  granted: ["The app's records", "The person's own `--allow-large`"],
  held: ["Switchboard-side settings"],
  userRulesTouched: ["The dated marks"],
  task: ["The Task Issue"],
};

/** The field names of the `PrFacts` interface in scripts/merge-gate.ts (the top level of its body). */
function prFactsFields(): string[] {
  const src = read("scripts/merge-gate.ts");
  const open = src.indexOf("export interface PrFacts {");
  expect(open).toBeGreaterThanOrEqual(0);
  const names: string[] = [];
  let depth = 0;
  let comment = false;
  for (const line of src.slice(open).split("\n").slice(1)) {
    const t = line.trim();
    if (comment) { if (t.includes("*/")) comment = false; continue; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) comment = true; continue; }
    if (depth === 0 && t === "}") break;
    const m = depth === 0 ? /^([A-Za-z_]\w*)\??:/.exec(t) : null;
    if (m) names.push(m[1]!);
    for (const ch of line) { if (ch === "{" || ch === "[" || ch === "(") depth++; else if (ch === "}" || ch === "]" || ch === ")") depth--; }
  }
  return names;
}

describe("the keys table of docs/merge-gate.md", () => {
  test("every input the gate reads as a key is a row of the table in docs/merge-gate.md", () => {
    const rows = keyRows();
    expect(rows.length).toBeGreaterThan(0);
    // each function a row names is declared in the file the row names
    for (const row of rows) {
      expect(row.reads.length, `row "${row.key}" names where it is read`).toBeGreaterThan(0);
      for (const { file, names } of row.reads) {
        expect(existsSync(join(ROOT, file)), `${file} (row "${row.key}")`).toBe(true);
        const src = read(file);
        for (const name of names) {
          const declared = new RegExp(`(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\b)`).test(src);
          expect(declared, `${name} is declared in ${file} (row "${row.key}")`).toBe(true);
        }
      }
    }
    // each field of PrFacts is covered by a row that exists
    const fields = prFactsFields();
    expect(fields.length).toBeGreaterThan(10);
    for (const f of fields) {
      const covered = FIELD_ROWS[f];
      expect(covered, `PrFacts.${f} has no row in the keys table: add the row to docs/merge-gate.md and the field to FIELD_ROWS`).toBeDefined();
      for (const start of covered!) {
        expect(rows.some((r) => r.key.startsWith(start)), `PrFacts.${f}: no row starts with "${start}"`).toBe(true);
      }
    }
    // an entry for a field that is gone is a stale mapping
    for (const f of Object.keys(FIELD_ROWS)) expect(fields, `FIELD_ROWS.${f} names no PrFacts field`).toContain(f);
  });
});
