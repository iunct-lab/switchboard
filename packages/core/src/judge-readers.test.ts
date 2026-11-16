// test-reads: apps/ packages/
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// The judge's result is a record kept to be compared with the outcome, never a second result to branch on.
// Reads: the row mapper and the Evals list query (db.ts), the Evals list and its comparison (Evals.tsx, evals.ts).
// Writes and clears: the judge's write (server.ts), the status rules (task-status.ts), and the places that build a fresh Task row (tasks.ts, history.ts).
// The schema (model.ts) completes the list; the Task screen (attention.ts) is not on it.
const ALLOWED = [
  "apps/web/src/components/Evals.tsx",
  "apps/web/src/evals.ts",
  "packages/core/src/db.ts",
  "packages/core/src/history.ts",
  "packages/core/src/server.ts",
  "packages/core/src/task-status.ts",
  "packages/core/src/tasks.ts",
  "packages/protocol/src/model.ts",
];

test("the judge's result is read in the row mapper and the Evals list only: no other source names judgedResult / judged_result", () => {
  const found = [...sources(join(root, "apps")), ...sources(join(root, "packages"))]
    .filter((p) => /judgedResult|judged_result/.test(readFileSync(p, "utf8")))
    .map((p) => relative(root, p))
    .sort();
  expect(found.filter((p) => !ALLOWED.includes(p))).toEqual([]);
});
