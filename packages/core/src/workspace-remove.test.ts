import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { copyDeletable, inspectRemoval } from "./workspace-remove.ts";

// What may go with a removed registration (#2600): the copy's reach and what it would lose; the stored backlog of one repository.

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}
function setup() {
  root = mkdtempSync(join(tmpdir(), "switchboard.remove."));
  const repoRoot = join(root, "switchboard");
  mkdirSync(repoRoot);
  return repoRoot;
}
function checkout(path: string) {
  mkdirSync(path);
  sh(path, "init", "-q");
  sh(path, "commit", "-q", "--allow-empty", "-m", "one");
}

test("a Git checkout directly under the parent is deletable; a missing path too", () => {
  const repoRoot = setup();
  checkout(join(root, "a"));
  expect(copyDeletable({ kind: "repo", path: join(root, "a") }, repoRoot)).toEqual({ ok: true });
  expect(copyDeletable({ kind: "repo", path: join(root, "gone") }, repoRoot)).toEqual({ ok: true });
});

test("meta, the checkout itself, a symlink out, a nested path and a non-Git directory are refused", () => {
  const repoRoot = setup();
  checkout(join(root, "a"));
  expect(copyDeletable({ kind: "meta", path: join(root, "a") }, repoRoot)).toMatchObject({ ok: false, code: 400 });
  expect(copyDeletable({ kind: "repo", path: repoRoot }, repoRoot)).toMatchObject({ ok: false, code: 400 });
  const outside = mkdtempSync(join(tmpdir(), "switchboard.outside."));
  try {
    checkout(join(outside, "x"));
    symlinkSync(join(outside, "x"), join(root, "link"));
    expect(copyDeletable({ kind: "repo", path: join(root, "link") }, repoRoot)).toMatchObject({ ok: false, code: 400 });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  mkdirSync(join(root, "a", "inner"));
  checkout(join(root, "a", "inner", "deep"));
  expect(copyDeletable({ kind: "repo", path: join(root, "a", "inner", "deep") }, repoRoot)).toMatchObject({ ok: false, code: 400 });
  expect(copyDeletable({ kind: "repo", path: root }, repoRoot)).toMatchObject({ ok: false, code: 400 });
  mkdirSync(join(root, "plain"));
  expect(copyDeletable({ kind: "repo", path: join(root, "plain") }, repoRoot)).toMatchObject({ ok: false, code: 409 });
});

test("inspectRemoval: clean, changed, and commits not pushed", async () => {
  setup();
  const upstream = join(root, "upstream.git");
  mkdirSync(upstream);
  sh(upstream, "init", "-q", "--bare");
  const a = join(root, "a");
  checkout(a);
  sh(a, "branch", "-M", "main");
  sh(a, "remote", "add", "origin", upstream);
  expect(await inspectRemoval(a)).toEqual({ dirty: false, unpushed: true }); // no upstream, a commit nobody has
  sh(a, "push", "-q", "-u", "origin", "main");
  expect(await inspectRemoval(a)).toEqual({ dirty: false, unpushed: false });
  writeFileSync(join(a, "f"), "x");
  expect(await inspectRemoval(a)).toEqual({ dirty: true, unpushed: false });
  sh(a, "add", "f");
  sh(a, "commit", "-q", "-m", "two");
  expect(await inspectRemoval(a)).toEqual({ dirty: false, unpushed: true });
});

test("deleteBacklogRepository removes one repository's rows and nothing else", () => {
  setup();
  const db = new Db(join(root, "switchboard.db"));
  const record = (objectKind: "issue", externalId: string) => ({ objectKind, externalId, remote: { number: 1 }, fetchState: "fetched" as const });
  const a = { service: "github" as const, host: "github.com", repository: "o/a", project: { owner: "o", number: 1 } };
  const b = { ...a, repository: "o/b" };
  for (const key of [a, b]) db.putBacklogSnapshot(key, { records: [record("issue", "I_1")] as any, cursor: null, syncedAt: 1 });
  db.deleteBacklogRepository(a);
  expect(db.listBacklogRecords(a)).toEqual([]);
  expect(db.getBacklogRepository(a)).toBeNull();
  expect(db.listBacklogRecords(b)).toHaveLength(1);
  expect(db.getBacklogRepository(b)).not.toBeNull();
  db.close();
});
