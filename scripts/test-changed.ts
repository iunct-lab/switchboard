#!/usr/bin/env bun
// Task の中で回す「関係するテスト」。origin/main から分かれた点からの変更（未コミットと未追跡も）を集め、
// local-ci と同じ scripts/test-select.ts の選択で選んだテストだけを回す。選択の規則はそちらが持ち、ここには足さない。
// 一式に広げるのは、選択が判定できないとき（test-select.ts の classify）と、ほかのパッケージが読む共有の型
// （packages/protocol/）が変わったとき。子プロセスで読むだけの依存は追わない（漏れはタグの CI が拾う）。
// 変更が無い、または選ばれたテストが無ければ何も回さない。SWITCHBOARD_SUPERVISED は抜いて回す。
// sb-offload があるホストでは、選んだテスト全部（録画を読むものも）を外の 1 本のビルドで回す（local-ci と同じ runBuild /
// ciScript / parseBuild。docs/design/local-ci-offload.md）。ホストの重い処理の枠は取らない。外が失敗・時間切れ・中断しても
// ホストで回し直さない。sb-offload が無いホストでは、重い処理の枠を取って今までどおりホストで回す。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { type Deps, hostOffload, parseBuild, runBuild, testRun, type Offload } from "./local-ci.ts";
import { currentRepo } from "./repo.ts";
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

export interface RunDeps {
  /** ホストでコマンドを回す（出力は引き継ぐ）。コードを返す。 */
  spawnHost: (cmd: string[]) => Promise<number>;
  /** 外のビルド。無ければ全部ホストで回す。 */
  offload?: Offload;
  /** 重い処理の枠を取って `fn` を回す。 */
  slot: Deps["slot"];
  /** owner/name。外の作業ツリーに origin として足す（origin を読むテストのため。local-ci と同じ）。 */
  repo?: string;
  log: (line: string) => void;
}

/** 選ばれたテストを回し、終了コードを返す。外が非 0 ならホストで回し直さない。 */
export async function runTests(picked: Picked, d: RunDeps): Promise<number> {
  const tests = "full" in picked ? null : picked.tests;
  if (!d.offload) {
    const code = await d.slot("test-changed", () => d.spawnHost(["bun", "test", ...(tests ?? []).map((t) => `./${t}`)]));
    return code;
  }
  const steps = [{ name: "bun test", run: tests ? testRun(tests) : "bun test" }];
  const { code, output } = await runBuild(d.offload, steps, ROOT, { ...(d.repo ? { repo: d.repo } : {}), host: { names: [], accountIds: [] } }).catch((e) => ({ code: 1, output: `sb-offload: ${e instanceof Error ? e.message : String(e)}` }));
  let offCode = 0;
  let passed = 0;
  let counted = false;
  // 一式のときは選んだファイルの数が無いので、bun test の `Ran N tests across M files.` の M を数える
  let ranFiles = 0;
  for (const r of parseBuild(output, steps, code)) {
    if (r.code === 0) {
      const m = r.output.match(/^\s*(\d+) pass\s*$/m);
      if (m) (passed += Number(m[1]), (counted = true));
      const f = r.output.match(/across (\d+) files?\./);
      if (f) ranFiles += Number(f[1]);
      continue;
    }
    offCode ||= r.code;
    const fails = [...new Set(r.output.split("\n").filter((l) => l.startsWith("(fail)")))];
    for (const l of fails) d.log(l);
    d.log(r.tail.split("\n").filter((l) => !fails.includes(l)).join("\n"));
  }
  if (code !== 0) offCode ||= code;
  // 通ったときも外で回ったと分かるように 1 行出す（pass の行が見つからなくてもファイル数は出す。一式で数が読めなければ数を省く）
  const files = tests ? tests.length : ranFiles;
  const counts = [...(files ? [`${files} ファイル`] : []), ...(counted ? [`${passed} pass`] : [])];
  if (!offCode) d.log(`test-changed: 外で通った${counts.length ? `（${counts.join("、")}）` : ""}`);
  return offCode;
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
  const offload = hostOffload();
  process.exit(
    await runTests(picked, {
      spawnHost: async (cmd) => await Bun.spawn(cmd, { cwd: ROOT, env, stdout: "inherit", stderr: "inherit" }).exited,
      ...(offload ? { offload } : {}),
      slot: (name, fn) => withHeavySlot(name, fn),
      ...(() => { try { return { repo: currentRepo(ROOT) }; } catch { return {}; } })(),
      log: (l) => console.log(l),
    }),
  );
}
