import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Footprint } from "@switchboard/protocol";

const IGNORE_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache", ".turbo", "coverage", ".DS_Store", "uv.lock"]);
const MAX_FILES = 20000;

/**
 * Rough "context footprint" for a scope: how much text an agent could pull in.
 * Deliberately simple (no .gitignore parsing) — the number is for the meter, not billing.
 */
export async function measureFootprint(dirs: string[]): Promise<Footprint> {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const seen = new Set<string>();
  const stack = [...new Set(dirs)];
  while (stack.length) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        files++;
        if (files > MAX_FILES) {
          truncated = true;
          return { files: MAX_FILES, bytes, estTokens: Math.round(bytes / 4), truncated };
        }
        try {
          bytes += (await stat(p)).size;
        } catch {
          /* skip */
        }
      }
    }
  }
  return { files, bytes, estTokens: Math.round(bytes / 4), truncated };
}
