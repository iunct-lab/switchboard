// test-reads: .gitignore .dockerignore
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The image copies the whole tree (`COPY . /opt/switchboard`), so a file Git does not track must not reach the build context.
const root = join(import.meta.dir, "..");
const lines = (p: string) => readFileSync(join(root, p), "utf8").split("\n").map((l) => l.trim());

describe(".dockerignore", () => {
  test("every pattern of .gitignore keeps its files out of the build context", () => {
    const dockerignore = new Set(lines(".dockerignore"));
    const missing: string[] = [];
    for (const line of lines(".gitignore")) {
      if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
      const p = line.replace(/\/+$/, "").replace(/^\/+/, "");
      // a pattern with no slash matches at any depth in .gitignore, but only at the root in .dockerignore
      const want = p.includes("/") ? p : `**/${p}`;
      if (!dockerignore.has(want)) missing.push(want);
    }
    expect(missing).toEqual([]);
  });
});
