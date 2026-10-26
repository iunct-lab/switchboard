/**
 * The CI's steps, one list for both runs (#912): Actions runs `bun scripts/ci.ts` after checkout and setup-bun, and
 * local-ci expands that step of ci.yml into `ciSteps` of the PR's own checkout, so the two run the same commands in the
 * same order and stop at the same failing step. Only node builtins here: it runs before `bun install`.
 * Each step is a `bash -e -c` script, as Actions runs a `run:`. Exit: 1 when a step failed (its own code is in the
 * `✗ <step>: exit <code>` line), else 0 — local-ci's too, whose 2 means it ran nothing.
 * `bun scripts/ci.ts --list` prints the steps as JSON and runs nothing.
 */

export interface Step { name: string; run: string }

export const ciSteps: Step[] = [
  // Personal data (#24): a home path other than the placeholders fixtures and docs use (/Users/dev, /Users/example, …) fails.
  // 0 = a match (a real home path), 1 = none, anything else = git grep itself failed: only 1 passes. `\/` so that this line is not a match itself.
  {
    name: "no personal home paths",
    run: String.raw`rc=0; git grep -nP '/Users\/(?!(dev|example|me|x|<you>)(?![A-Za-z0-9._-])|")' -- ':!node_modules' || rc=$?
[ "$rc" -eq 1 ]`,
  },
  { name: "bun install --frozen-lockfile", run: "bun install --frozen-lockfile" },
  { name: "bun run licenses:check", run: "bun run licenses:check" },
  // typecheck は先に入っている Codex から型を生成する（scripts/codex_types.ts）。CI を回す環境にも Codex CLI が要る
  { name: "bun run typecheck", run: "bun run typecheck" },
  // 実ランナー（claude/codex）は CI に無い。アダプタの再生テストは Git の外の録画を読み、無ければ理由を出して飛ぶ
  // （README の Development）。録画を置いた所有者のローカル CI だけが再生まで確かめる。
  { name: "bun test", run: "bun test" },
  { name: "bun run --cwd apps/web build", run: "bun run --cwd apps/web build" },
  // perf ratchet (#638): the counts of the four journeys and the bundle against scripts/perf-budget.json. check also
  // compares the ceilings with main's, so main is fetched. 5 runs: the medians move by the bands perf-ratchet allows, a single
  // run by more. Chrome is on ubuntu-latest; perf-bench finds it.
  // --depth=1 only in Actions' shallow checkout: in local-ci's worktree it would make the developer's clone shallow
  {
    name: "fetch main",
    run: `if [ "$(git rev-parse --is-shallow-repository)" = true ]; then depth=--depth=1; else depth=; fi
git fetch $depth origin +refs/heads/main:refs/remotes/origin/main`,
  },
  // perf-bench shows Chrome only Noto Sans + Noto Sans CJK (the same text size everywhere); ubuntu-latest has neither
  {
    name: "Noto fonts for perf-bench",
    run: `if fc-list ':family=Noto Sans' | grep -q . && fc-list ':family=Noto Sans CJK JP' | grep -q .; then exit 0; fi
sudo apt-get update -qq && sudo apt-get install -y -qq fonts-noto-core fonts-noto-cjk`,
  },
  { name: "bun scripts/perf-bench.ts --runs 5 --json perf-result.json", run: "bun scripts/perf-bench.ts --runs 5 --json perf-result.json" },
  // the ceilings for Actions are `github` (GITHUB_ACTIONS=true); on a red the result JSON is printed for `update --env github`
  { name: "bun scripts/perf-ratchet.ts check perf-result.json", run: "bun scripts/perf-ratchet.ts check perf-result.json || { cat perf-result.json; exit 1; }" },
];

/** Runs `steps` in order with `run` and stops after the first non-zero code; the results are the steps that ran. */
export async function runCi<R extends { code: number }>(steps: Step[], run: (s: Step) => Promise<R>): Promise<Array<Step & R>> {
  const results: Array<Step & R> = [];
  for (const s of steps) {
    const r = await run(s);
    results.push({ ...s, ...r });
    if (r.code !== 0) break;
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
  const results = await runCi(ciSteps, async (s) => {
    console.log(`▶ ${s.name}`);
    return { code: await Bun.spawn(["bash", "-e", "-c", s.run], { stdout: "inherit", stderr: "inherit" }).exited };
  });
  const failed = results.find((r) => r.code !== 0);
  if (failed) console.log(`✗ ${failed.name}: exit ${failed.code}`);
  process.exit(ciExit(results));
}
