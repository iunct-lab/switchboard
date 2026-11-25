// test-reads: ./
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findRepoRoot } from "./config.ts";
import { daemonReads } from "./daemon-reads.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A small release tree: `files` maps a path under the root to its text. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "switchboard.daemon-reads."));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ENTRY = "packages/core/src/main.ts";

describe("daemonReads", () => {
  test("the real tree: complete, and what the daemon imports or reads at run time is listed", () => {
    const r = daemonReads(findRepoRoot(import.meta.dir));
    expect(r.unknown).toEqual([]);
    expect(r.complete).toBe(true);
    for (const f of [ENTRY, "scripts/parallel-guard.ts", "ops-kit/src/config.ts", "docs/design/scratch-apps.md"]) expect(r.files).toContain(f);
    expect(r.dirs).toContain("ops-kit/skills/");
    expect(r.files.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
    expect(r.files).not.toContain("docs/design/local-ci.md");
    expect(r.files.filter((f) => f.startsWith(".github/"))).toEqual([]);
  });

  test("a file the daemon starts importing moves to the read side", () => {
    const before = tree({ [ENTRY]: "console.log(1);\n", "packages/core/src/later.ts": "export const x = 1;\n" });
    const r0 = daemonReads(before);
    expect(r0.complete).toBe(true);
    expect(r0.files).toContain(ENTRY);
    expect(r0.files).not.toContain("packages/core/src/later.ts");

    const after = tree({ [ENTRY]: 'import { x } from "./later.ts";\nconsole.log(x);\n', "packages/core/src/later.ts": "export const x = 1;\n" });
    const r1 = daemonReads(after);
    expect(r1.complete).toBe(true);
    expect(r1.files).toContain("packages/core/src/later.ts");
  });

  test("a new place that builds a path from the started release, with no declaration, makes the answer incomplete", () => {
    const root = tree({
      [ENTRY]: 'import { doc } from "./doc.ts";\nconsole.log(doc);\n',
      "packages/core/src/doc.ts": 'import { join } from "node:path";\nexport const doc = join(import.meta.dir, "x.md");\n',
    });
    const r = daemonReads(root);
    expect(r.complete).toBe(false);
    expect(r.unknown).toEqual(["packages/core/src/doc.ts"]);
  });

  test("a name import of any package the root package.json lists as a workspace is followed into the release", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "rescue"] }),
      "rescue/package.json": JSON.stringify({ name: "sb-rescue", exports: { "./releases": "./src/releases.ts" } }),
      "rescue/src/releases.ts": "export const x = 1;\n",
      [ENTRY]: 'import { x } from "sb-rescue/releases";\nconsole.log(x);\n',
    });
    const r = daemonReads(root);
    expect(r.complete).toBe(true);
    expect(r.files).toContain("rescue/src/releases.ts");
    expect(r.files).toContain("rescue/package.json");
  });
});
