import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitFile, daemonSource, makeRepo } from "./fixture.ts";
import { appendHistory, buildRelease, currentOf, listReleases, previousOf, pruneReleases, readHistory, releasesDir, switchTo } from "./releases.ts";

let f: Awaited<ReturnType<typeof makeRepo>>;
beforeAll(async () => {
  f = await makeRepo();
});
afterAll(() => rmSync(f.root, { recursive: true, force: true }));

test("buildRelease exports the commit, builds the web UI, and leaves no half-built directory behind", async () => {
  const sha = await buildRelease(f.repo, "HEAD", f.home);
  expect(sha).toBe(f.v1);
  const dir = join(releasesDir(f.home), sha);
  expect(readFileSync(join(dir, "packages/core/src/main.ts"), "utf8")).toContain('"v1"');
  expect(readFileSync(join(dir, "apps/web/dist/index.html"), "utf8").trim()).toBe("built");
  expect(existsSync(join(dir, ".git"))).toBe(false);
  expect(await buildRelease(f.repo, sha, f.home)).toBe(sha); // already built: nothing to do
  await expect(buildRelease(f.repo, "no-such-rev", f.home)).rejects.toThrow(/rev-parse/);
  const broken = await commitFile(f.repo, "apps/web/package.json", JSON.stringify({ name: "web", scripts: { build: "echo web build broke >&2; exit 3" } }), "broken build");
  await expect(buildRelease(f.repo, broken, f.home)).rejects.toThrow(/web build broke/);
  expect(listReleases(f.home)).toEqual([f.v1]);
});

test("switchTo moves current and remembers the one before as previous; history survives a torn line", async () => {
  await commitFile(f.repo, "apps/web/package.json", JSON.stringify({ name: "web", private: true, scripts: { build: "mkdir -p dist && echo built > dist/index.html" } }), "fix build");
  const v2 = await buildRelease(f.repo, await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v2"), "v2"), f.home);
  expect(currentOf(f.home)).toBeNull();
  switchTo(f.home, f.v1);
  expect([currentOf(f.home), previousOf(f.home)]).toEqual([f.v1, null]);
  switchTo(f.home, v2);
  expect([currentOf(f.home), previousOf(f.home)]).toEqual([v2, f.v1]);
  switchTo(f.home, f.v1);
  expect([currentOf(f.home), previousOf(f.home)]).toEqual([f.v1, v2]);
  expect(() => switchTo(f.home, "0".repeat(40))).toThrow(/not built/);
  expect(() => switchTo(f.home, "../repo")).toThrow(/not a release id/); // exists, but is the mutable checkout
  expect(currentOf(f.home)).toBe(f.v1);
  appendHistory(f.home, { action: "promote", from: f.v1, to: v2, ok: true, reason: "checks passed" });
  require("node:fs").appendFileSync(join(releasesDir(f.home), "history.jsonl"), '{"ts":1,"act');
  expect(readHistory(f.home).map((h) => [h.action, h.to])).toEqual([["promote", v2]]);
  appendHistory(f.home, { action: "rollback", from: v2, to: f.v1, ok: true, reason: "after the torn line" });
  expect(readHistory(f.home).map((h) => h.action)).toEqual(["promote", "rollback"]); // the torn line costs only itself
});

test("pruneReleases keeps current, previous and the newest KEEP_RELEASES by history", () => {
  const f2 = { home: join(f.root, "prune-home") };
  const ids = Array.from({ length: 9 }, (_, i) => i.toString(16).repeat(40));
  mkdirSync(releasesDir(f2.home), { recursive: true });
  for (const sha of ids) mkdirSync(join(releasesDir(f2.home), sha));
  // ids[0] has no history entry: it survives only as `previous`. ids[1] is rejected (ok: false), so it counts only as `current`.
  for (const sha of ids.slice(2)) appendHistory(f2.home, { action: "promote", from: null, to: sha, ok: true, reason: "x" });
  appendHistory(f2.home, { action: "rejected", from: null, to: ids[1]!, ok: false, reason: "no" });
  switchTo(f2.home, ids[0]!);
  switchTo(f2.home, ids[1]!);
  const removed = pruneReleases(f2.home);
  const left = listReleases(f2.home).sort();
  // current ids[1], previous ids[0], newest 5 promoted: ids[4..8]; ids[2], ids[3] go.
  expect(left).toEqual([ids[0]!, ids[1]!, ...ids.slice(4)].sort());
  expect(removed.sort()).toEqual([ids[2]!, ids[3]!]);
  expect([currentOf(f2.home), previousOf(f2.home)]).toEqual([ids[1]!, ids[0]!]);
});
