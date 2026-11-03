#!/usr/bin/env bun
// Task の中で回す「関係するテスト」。origin/main から分かれた点からの変更（未コミットと未追跡も）を集め、
// local-ci と同じ scripts/test-select.ts の選択で選んだテストだけを回す。選択の規則はそちらが持ち、ここには足さない。
// 一式に広げるのは、選択が判定できないとき（test-select.ts の classify）と、ほかのパッケージが読む共有の型
// （packages/protocol/）が変わったとき。子プロセスで読むだけの依存は追わない（漏れはタグの CI が拾う）。
// 変更が無い、または選ばれたテストが無ければ何も回さない。SWITCHBOARD_SUPERVISED は抜いて回す。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoFiles, selectFrom } from "./test-select.ts";

const ROOT = join(import.meta.dir, "..");
const SHARED = "packages/protocol/";

export type Picked = { full: string } | { tests: string[] };

/** 変わったファイルから回すテストを選ぶ。 */
export function pickTests(changed: string[], files: string[], read: (p: string) => string): Picked {
  if (!changed.length) return { tests: [] };
  const shared = changed.find((c) => c.startsWith(SHARED));
  if (shared) return { full: `${shared}: 共有の型` };
  const s = selectFrom(changed, files, read);
  return s.full ? { full: s.full } : { tests: s.tests };
}

/** origin/main との分岐点から作業ツリーまでの変更と、未追跡のファイル。 */
export function changedFiles(git: (args: string[]) => string): string[] {
  const fork = git(["merge-base", "HEAD", "origin/main"]).trim();
  const paths = [...git(["diff", "--name-only", "--no-renames", "-z", fork]).split("\0"), ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")];
  return [...new Set(paths.filter(Boolean))].sort();
}

if (import.meta.main) {
  const git = (args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr.toString().trim()}`);
    return p.stdout.toString();
  };
  const files = repoFiles(ROOT);
  const picked = pickTests(changedFiles(git), files, (p) => readFileSync(join(ROOT, p), "utf8"));
  if ("tests" in picked && !picked.tests.length) {
    console.log("test-changed: テスト対象なし");
    process.exit(0);
  }
  console.log("full" in picked ? `test-changed: 一式（${picked.full}）` : `test-changed: ${picked.tests.length} ファイル\n${picked.tests.join("\n")}`);
  const { SWITCHBOARD_SUPERVISED: _, ...env } = process.env;
  const args = "full" in picked ? [] : picked.tests.map((t) => `./${t}`);
  process.exit(await Bun.spawn(["bun", "test", ...args], { cwd: ROOT, env, stdout: "inherit", stderr: "inherit" }).exited);
}
