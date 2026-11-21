#!/usr/bin/env bun
// Task の中で回す型検査。root の `bun run typecheck`（codex:types を含む）と同じ結果と終了コードを返す。
// 使い方: bun scripts/typecheck.ts [--local]
// いつもこのマシンで回し、外のビルドは使わない（sb-offload があっても同じ。`--local` は受け付けて同じ動き）。1 回は数秒・最大 RSS 200 MB 弱なので
// 重い処理の枠は取らず、空きメモリが型検査だけの床（既定 512 MB、heavy.json の floors.typecheck で変える。minFreeMb ではない）を下回る間だけ待つ。Codex の型は pin の版で作る（scripts/codex_types.ts）。
// SWITCHBOARD_SUPERVISED は抜かない。docs/design/local-ci-offload.md
import { join } from "node:path";
import { type HeavyOptions, withHeavySlot } from "../ops-kit/src/heavy.ts";

const ROOT = join(import.meta.dir, "..");

export interface TypecheckDeps {
  /** ホストでコマンドを回す（出力は引き継ぐ）。コードを返す。 */
  spawnHost: (cmd: string[]) => Promise<number>;
  /** 重い処理を回す入口。`fn` を回して結果を返す。 */
  slot: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/** 1 回の最大 RSS は 180 MB 弱なので、heavy.json の床（既定 1536 MB）ではなくこの値を床にする。マシンごとには heavy.json の `floors.typecheck` で変える。 */
export const TYPECHECK_MIN_FREE_MB = 512;

/** 空きメモリが型検査の床を下回る間だけ待ち、枠は取らずに `fn` を回す。 */
export const typecheckSlot = <T>(name: string, fn: () => Promise<T>, heavy: HeavyOptions = {}): Promise<T> => withHeavySlot(name, fn, { ...heavy, memoryOnly: true, minFreeMb: TYPECHECK_MIN_FREE_MB });

/** 型検査をこのマシンで 1 回回し、終了コードを返す。 */
export async function runTypecheck(d: TypecheckDeps): Promise<number> {
  return await d.slot("typecheck", () => d.spawnHost(["bun", "run", "typecheck"]));
}

if (import.meta.main) {
  process.exit(
    await runTypecheck({
      spawnHost: async (cmd) => await Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exited,
      slot: typecheckSlot,
    }),
  );
}
