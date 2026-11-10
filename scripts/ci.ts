/**
 * The CI's steps, one list for both runs (#912): Actions runs `bun scripts/ci.ts` after checkout and setup-bun, and
 * local-ci expands that step of ci.yml into `ciSteps` of the PR's own checkout, so the two run the same commands in the
 * same order and stop at the same failing step (a `keepGoing` step's failure does not stop them: the perf steps, so that
 * `bun test` still runs and both results are known in one run). Only node builtins at the top (the kit's idle-run, which imports nothing, in Actions' branch): it runs before `bun install`.
 * Each step is a `bash -e -c` script, as Actions runs a `run:`. Exit: 1 when a step failed (its own code is in the
 * `✗ <step>: exit <code>` line), else 0 — local-ci's too, whose 2 means it ran nothing.
 * `bun scripts/ci.ts --list` prints the steps as JSON and runs nothing.
 */

/** A step that prints nothing for this long is taken as stuck. No limit on a step's total time. */
export const STEP_IDLE_SECONDS = 900;

/** `keepGoing`: a failure of this step does not stop the run (the run still fails). */
export interface Step { name: string; run: string; keepGoing?: boolean }

export const ciSteps: Step[] = [
  // Personal data (#24): a home path other than the placeholders fixtures and docs use (/Users/dev, /Users/example, …) fails.
  // 0 = a match (a real home path), 1 = none, anything else = git grep itself failed: only 1 passes. `\/` so that this line is not a match itself.
  {
    name: "no personal home paths",
    run: String.raw`rc=0; git grep -nP '/Users\/(?!(dev|example|me|x|<you>)(?![A-Za-z0-9._-])|")' -- ':!node_modules' || rc=$?
[ "$rc" -eq 1 ]`,
  },
  { name: "bun install --frozen-lockfile", run: "bun install --frozen-lockfile" },
  // 公開に出すツリーの検査（Private のリポジトリ名・ホームパス・個人のメール）。公開の同期と同じ判定を、タグの後の同期より前（マージの前）に走らせる。
  // 公開側の写しでは origin が publicSync.target なので飛ぶ
  { name: "public tree check", run: "bun ops-kit/src/cli.ts public-sync --check" },
  { name: "bun run licenses:check", run: "bun run licenses:check" },
  // typecheck は Codex から型を生成する（scripts/codex_types.ts）ので CI を回す環境にも Codex CLI が要る。入っていれば飛ばし（Codex のあるホストのローカル CI）、無ければ入れる（公開側の Actions。ログインは要らない）
  { name: "Codex CLI for typecheck", run: "if command -v codex >/dev/null; then exit 0; fi\nnpm install -g @openai/codex" },
  { name: "bun run typecheck", run: "bun run typecheck" },
  // perf-bench measures this build; bun test does not depend on it
  { name: "bun run --cwd apps/web build", run: "bun run --cwd apps/web build" },
  // perf ratchet (#638): the counts of the four journeys against scripts/perf-budget.json, and the bundle against main's
  // tip built in a worktree next to the checkout (#3167). check also compares the ceilings with main's, so main is fetched. 5 runs: the medians move by the bands perf-ratchet allows, a single
  // run by more. Chrome is on ubuntu-latest; perf-bench finds it.
  // --depth=1 only in Actions' shallow checkout: in local-ci's worktree it would make the developer's clone shallow
  {
    name: "fetch main",
    run: `if [ "$(git rev-parse --is-shallow-repository)" = true ]; then depth=--depth=1; else depth=; fi
git fetch $depth origin +refs/heads/main:refs/remotes/origin/main`, // the tag CI compares perf with the tag before (PERF_BASE_REF), not this tip
  },
  // perf-bench shows Chrome only Noto Sans + Noto Sans CJK (the same text size everywhere); ubuntu-latest has neither
  {
    name: "Noto fonts for perf-bench",
    run: `if fc-list ':family=Noto Sans' | grep -q . && fc-list ':family=Noto Sans CJK JP' | grep -q .; then exit 0; fi
sudo apt-get update -qq && sudo apt-get install -y -qq fonts-noto-core fonts-noto-cjk`,
  },
  // main's tip, built and measured for the bundle check: compared with origin/main's tip, not the PR's base branch, so a
  // stack's top compares the whole stack. The tag CI records it (perf-records/bundle.tsv) and compares with the tag before:
  // it passes PERF_BASE_REF (#4219), so the growth and raised ceilings are the tag's own
  { name: "bun scripts/perf-ratchet.ts base origin/main perf-base.json", run: 'bun scripts/perf-ratchet.ts base "${PERF_BASE_REF:-origin/main}" perf-base.json', keepGoing: true },
  // the perf steps run before bun test (their result does not wait 5 minutes for it) and keep going: a perf red still
  // runs bun test, so a run says both (#2945). Not in parallel: perf-bench is not measured next to another load.
  { name: "bun scripts/perf-bench.ts --runs 5 --json perf-result.json", run: "bun scripts/perf-bench.ts --runs 5 --json perf-result.json", keepGoing: true },
  // the ceilings for Actions are `github` (GITHUB_ACTIONS=true); on a red the result JSON is printed for `update --env github`
  { name: "bun scripts/perf-ratchet.ts check perf-result.json", run: "bun scripts/perf-ratchet.ts check perf-result.json --base perf-base.json || { cat perf-result.json; exit 1; }", keepGoing: true },
  // 実ランナー（claude/codex）は CI に無い。アダプタの再生テストは Git の外の録画を読み、無ければ理由を出して飛ぶ
  // （README の Development）。録画を置いた所有者のローカル CI だけが再生まで確かめる。
  { name: "bun test", run: "bun test" },
];

/** Runs `steps` in order with `run` and stops after the first non-zero code of a step without `keepGoing`; the results are the steps that ran. */
export async function runCi<R extends { code: number }>(steps: Step[], run: (s: Step) => Promise<R>): Promise<Array<Step & R>> {
  const results: Array<Step & R> = [];
  for (const s of steps) {
    const r = await run(s);
    results.push({ ...s, ...r });
    if (r.code !== 0 && !s.keepGoing) break;
  }
  return results;
}

/** The exit of a run, the same for both entries: 1 when a step failed, else 0 (not the step's own code: tsc's 2 would read as local-ci's "ran nothing"). */
export const ciExit = (results: Array<{ code: number }>): number => (results.some((r) => r.code !== 0) ? 1 : 0);

if (import.meta.main && process.argv[2] === "--list") {
  // local-ci reads a checkout's steps this way: in its own process, with only local-ci's environment (#912)
  console.log(JSON.stringify(ciSteps));
} else if (import.meta.main) {
  // Actions: this environment as the runner gives it (GITHUB_ACTIONS picks perf-ratchet's ceilings), the output as it comes
  // imported here: --list reads this file alone from a checkout, and the kit's idle-run itself imports nothing, so this still runs before `bun install`
  const { IDLE_KILLED_LINE, runIdle } = await import("../ops-kit/src/idle-run.ts");
  const results = await runCi(ciSteps, async (s) => {
    console.log(`▶ ${s.name}`);
    const r = await runIdle(["bash", "-e", "-c", s.run], { idleSeconds: STEP_IDLE_SECONDS, onData: (chunk) => process.stdout.write(chunk) });
    if (r.idleKilled) console.log(IDLE_KILLED_LINE(STEP_IDLE_SECONDS));
    return { code: r.code };
  });
  for (const failed of results.filter((r) => r.code !== 0)) console.log(`✗ ${failed.name}: exit ${failed.code}`);
  process.exit(ciExit(results));
}
