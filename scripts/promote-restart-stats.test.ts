// test-reads: none
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countPairs, pairsOf, tagsSince } from "./promote-restart-stats.ts";

const reads = { files: new Set(["packages/core/src/main.ts", "docs/design/scratch-apps.md"]), dirs: ["ops-kit/skills/"] };

test("countPairs: a pair of tests and unread documents counts under the new rule only; a pair with a read file counts under neither", () => {
  const c = countPairs([
    { from: "v1", to: "v2", files: ["apps/web/src/a.ts"], reads },
    { from: "v2", to: "v3", files: ["apps/web/src/a.ts", "packages/core/src/x.test.ts", "docs/design/other.md"], reads },
    { from: "v3", to: "v4", files: [".github/workflows/ci.yml"], reads },
    { from: "v4", to: "v5", files: ["packages/core/src/x.test.ts", "docs/design/scratch-apps.md"], reads },
    { from: "v5", to: "v6", files: ["ops-kit/skills/a/SKILL.md"], reads },
  ]);
  expect(c).toEqual({ pairs: 5, before: 1, after: 3, withoutList: 0, movedBy: { "*.test.ts + docs/": 1, ".github/": 1 } });
});

test("countPairs: a pair whose older tag has no list is judged by the two places only", () => {
  const c = countPairs([
    { from: "v1", to: "v2", files: ["docs/design/other.md"], reads: null },
    { from: "v2", to: "v3", files: ["packages/core/config/routing.json"], reads: null },
  ]);
  expect(c).toEqual({ pairs: 2, before: 1, after: 1, withoutList: 2, movedBy: {} });
});

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function git(cwd: string, args: string[], date?: string) {
  const env = { ...process.env, GIT_AUTHOR_DATE: date ?? "", GIT_COMMITTER_DATE: date ?? "" };
  if (!date) { delete env.GIT_AUTHOR_DATE; delete env.GIT_COMMITTER_DATE; }
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, env, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function put(root: string, file: string, body: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

test("pairsOf: the list comes from the older tag of each pair; a tag without the command gives none", async () => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "switchboard.restart-stats-test."));
  git(dir, ["init", "-q"]);
  put(dir, "docs/a.md", "1");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "1"], "2026-11-01T00:00:00Z");
  git(dir, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"], "2026-11-01T00:00:00Z");
  // the next tag has the command; what it says it reads does not include docs/
  put(dir, "packages/core/src/daemon-reads.ts", 'console.log(JSON.stringify({ complete: true, files: ["packages/core/src/daemon-reads.ts"], dirs: [], unknown: [] }));\n');
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "2"], "2026-11-20T00:00:00Z");
  git(dir, ["tag", "-a", "v1.1.0", "-m", "v1.1.0"], "2026-11-20T00:00:00Z");
  put(dir, "docs/a.md", "2");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "3"], "2026-11-21T00:00:00Z");
  git(dir, ["tag", "-a", "v1.2.0", "-m", "v1.2.0"], "2026-11-21T00:00:00Z");

  expect(await tagsSince(dir, "2026-11-19")).toEqual(["v1.1.0", "v1.2.0"]);
  const pairs = await pairsOf(dir, await tagsSince(dir, "2026-10-01"));
  expect(pairs.map((p) => [p.from, p.to, p.files, p.reads === null])).toEqual([
    ["v1.0.0", "v1.1.0", ["packages/core/src/daemon-reads.ts"], true],
    ["v1.1.0", "v1.2.0", ["docs/a.md"], false],
  ]);
  expect(countPairs(pairs)).toEqual({ pairs: 2, before: 0, after: 1, withoutList: 1, movedBy: { "docs/": 1 } });
});
