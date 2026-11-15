#!/usr/bin/env bun
// Task の中で回す型検査。root の `bun run typecheck`（codex:types を含む）と同じ結果と終了コードを返す。
// 使い方: bun scripts/typecheck.ts [--local]
// sb-offload があるホストでは外の 1 本のビルドで回し（local-ci と同じ runBuild / ciScript / parseBuild。ビルドの image に Codex CLI が
// ある。codex:types は PR の CI と同じくその Codex で作るので、ホストの Codex と版が違うときは --local。docs/design/local-ci-offload.md）、ホストの重い処理の枠は取らない。外が失敗・時間切れ・中断してもホストで回し直さない。
// 重い処理の枠を取ってホストで回すのは、--local を付けたときと、sb-offload が無いホストだけ。SWITCHBOARD_SUPERVISED は抜かない。
import { join } from "node:path";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { type Deps, type Offload, parseBuild, runBuild } from "./local-ci.ts";
import { currentRepo } from "./repo.ts";
import { offloadFor } from "./tag-ci.ts";

const ROOT = join(import.meta.dir, "..");
const RUN = "bun run typecheck";

export interface TypecheckDeps {
  /** ホストでコマンドを回す（出力は引き継ぐ）。コードを返す。 */
  spawnHost: (cmd: string[]) => Promise<number>;
  /** 外のビルド。無ければホストで回す。 */
  offload?: Offload;
  /** 重い処理の枠を取って `fn` を回す。 */
  slot: Deps["slot"];
  /** owner/name。外の作業ツリーに origin として足す（local-ci と同じ）。 */
  repo?: string;
  log: (line: string) => void;
}

/** 型検査を回し、終了コードを返す。外が非 0 ならホストで回し直さない。 */
export async function runTypecheck(d: TypecheckDeps): Promise<number> {
  if (!d.offload) return await d.slot("typecheck", () => d.spawnHost(["bun", "run", "typecheck"]));
  const steps = [{ name: "typecheck", run: RUN }];
  // the type check reads no recordings: the build gets none (hostOffload adds them where the host has them)
  const { fixtures: _, ...offload } = d.offload;
  const { code, output } = await runBuild(offload, steps, ROOT, { caller: "typecheck", ...(d.repo ? { repo: d.repo } : {}), host: { names: [], accountIds: [] } }).catch((e) => ({ code: 1, output: `sb-offload: ${e instanceof Error ? e.message : String(e)}` }));
  let failed = 0;
  for (const r of parseBuild(output, steps, code)) {
    if (r.code === 0) continue;
    failed ||= r.code;
    d.log(r.output.trimEnd());
  }
  failed ||= code;
  if (!failed) d.log("typecheck: 外で通った");
  return failed;
}

if (import.meta.main) {
  const offload = offloadFor(process.argv.slice(2).includes("--local"));
  process.exit(
    await runTypecheck({
      spawnHost: async (cmd) => await Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exited,
      ...(offload ? { offload } : {}),
      slot: (name, fn) => withHeavySlot(name, fn),
      ...(() => { try { return { repo: currentRepo(ROOT) }; } catch { return {}; } })(),
      log: (l) => console.log(l),
    }),
  );
}
