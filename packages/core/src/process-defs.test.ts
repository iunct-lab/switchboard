// test-reads: ops-kit/processes/p0-pipeline.md ops-kit/processes/p1-direct.md
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProcesses, loadProcess, parseProcessDef, renderEntry, PROCESS_SOURCE } from "./process-defs.ts";

const P0_ENTRIES = ["to-pbi", "to-tasks", "to-tasks-ready", "complete", "complete-other", "complete-resume", "check", "close"];

test("the kit's candidates are read: p0-pipeline has the 8 stage entries, p1-direct one", () => {
  const defs = listProcesses();
  expect(defs.map((d) => d.id)).toEqual(expect.arrayContaining(["p0-pipeline", "p1-direct"]));
  const p0 = loadProcess("p0-pipeline");
  expect(p0.version).toBe(1);
  expect(p0.fits.length).toBeGreaterThan(0);
  expect(Object.keys(p0.entries).sort()).toEqual([...P0_ENTRIES].sort());
  expect(Object.keys(loadProcess("p1-direct").entries)).toEqual(["direct"]);
});

test("p1-direct's entry makes no PBI or Task Issue and leaves one line on the request (#3690)", () => {
  const text = renderEntry(loadProcess("p1-direct"), "direct", { signal: "#1" });
  expect(text).toContain("PBI・Task Issue は作らない");
  expect(text).toContain("`直行: PR #<番号>`");
});

test("a definition without id, version or title is refused with the path and the reason", () => {
  expect(() => parseProcessDef("---\nversion: 1\ntitle: t\n---\n", "x.md")).toThrow("x.md: frontmatter needs `id`");
  expect(() => parseProcessDef("---\nid: a\ntitle: t\n---\n", "x.md")).toThrow("needs an integer `version`");
  expect(() => parseProcessDef("---\nid: a\nversion: 1\n---\n", "x.md")).toThrow("needs `title`");
  expect(() => parseProcessDef("no frontmatter", "x.md")).toThrow("no frontmatter");
  expect(() => parseProcessDef("---\n---\n## entry e\nx\n", "x.md")).toThrow("must be a mapping");
  // only a fence on its own line closes the block: a value ending in --- is not cut
  expect(parseProcessDef("---\nid: a\nversion: 1\ntitle: t ---\n---\n## entry e\nx\n", "x.md").title).toBe("t ---");
  // a `---` rule inside the prose is not frontmatter: the block must open the file
  expect(() => parseProcessDef("# title\nprose\n---\nid: a\nversion: 1\ntitle: t\n---\n", "x.md")).toThrow("no frontmatter");
  expect(() => parseProcessDef("---\nid: a\nversion: 1\ntitle: t\n---\n## entry e\na\n## entry e\nb\n", "x.md")).toThrow("appears twice");
});

test("renderEntry fills {{keys}} and refuses a key that was not given or an entry that does not exist", () => {
  const def = parseProcessDef("---\nid: a\nversion: 2\ntitle: t\nfits:\n  - small\n---\nprose before entries\n\n## entry go\n\nDo #{{n}} with {{count}} items.\n\ntrailing\n\n## entry stop\nStop.\n", "a.md");
  expect(def.fits).toEqual(["small"]);
  expect(renderEntry(def, "go", { n: 7, count: "two" })).toBe("Do #7 with two items.\n\ntrailing");
  expect(renderEntry(def, "stop", {})).toBe("Stop.");
  expect(() => renderEntry(def, "go", { n: 7 })).toThrow("uses {{count}}, which was not given");
  expect(() => renderEntry(def, "nope", {})).toThrow("no `## entry nope`");
});

test("listProcesses / loadProcess read a root's ops-kit/processes and refuse an id that differs from the file name", () => {
  const root = mkdtempSync(join(tmpdir(), "switchboard-procs-"));
  try {
    expect(listProcesses(root)).toEqual([]);
    mkdirSync(join(root, PROCESS_SOURCE), { recursive: true });
    writeFileSync(join(root, PROCESS_SOURCE, "b.md"), "---\nid: b\nversion: 1\ntitle: B\n---\n## entry e\nx\n");
    writeFileSync(join(root, PROCESS_SOURCE, "README.md"), "# not a candidate\n");
    expect(listProcesses(root).map((d) => d.id)).toEqual(["b"]);
    expect(() => loadProcess("missing", root)).toThrow("process `missing` not found");
    expect(() => loadProcess("../etc", root)).toThrow("is not a file name");
    writeFileSync(join(root, PROCESS_SOURCE, "c.md"), "---\nid: other\nversion: 1\ntitle: C\n---\n");
    expect(() => loadProcess("c", root)).toThrow("must equal the file name");
    expect(() => listProcesses(root)).toThrow("must equal the file name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
