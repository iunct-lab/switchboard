import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `gh project item-list` reads every item of the Project (about 400 GraphQL points a call; the hourly budget is 5,000 per
 * user, shared by every Task on the host). Only the warning in issue-workflow may name it (#548).
 */
const root = join(import.meta.dir, "..");
const self = relative(root, import.meta.path);

test("no gh project item-list outside the one warning in issue-workflow", () => {
  const hits: string[] = [];
  for (const dir of ["scripts", "ops-kit/src", "ops-kit/skills"]) {
    for (const f of readdirSync(join(root, dir), { recursive: true }) as string[]) {
      const rel = join(dir, f);
      if (rel.split("/").includes("node_modules") || rel === self || !statSync(join(root, rel)).isFile()) continue;
      readFileSync(join(root, rel), "utf8")
        .split("\n")
        .forEach((line, i) => line.includes("item-list") && hits.push(`${rel}:${i + 1}: ${line}`));
    }
  }
  expect(hits.map((h) => h.split(":")[0])).toEqual(["ops-kit/skills/issue-workflow/SKILL.md"]);
  expect(hits[0]).toContain("使わない");
});
