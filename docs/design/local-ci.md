# Local-CI equivalent verification when Actions does not start

Normally you run `bun scripts/local-ci.ts <PR>` (`--all` runs every test). It is the entry point that runs every step of CI locally when Actions fails with 0 steps. For the procedure and the marks of the merge decision see [docs/merge-gate.md](../merge-gate.md), and for the performance check see [perf.md](perf.md).

A PR of another repository is run with `bun <Switchboard の clone>/scripts/local-ci.ts <PR> --repo <owner/name>` from that repository's working tree (decided 2026-10-13). Reading and fetching head and base, the worktree and posting the result all go to that repository (the clone at the root of the working tree it was run in, and that PR), and the steps are read from that clone's `ops.config.json` `ci.steps`, else the `run:` entries of its `.github/workflows/ci.yml` (that repository has no `scripts/ci.ts`, so the `run:` entries are the steps as they are; see "Steps (the same as Actions)" below). When `--repo` is not in the `owner/name` form, the place it was run is not a git working tree, or the working tree's `origin` differs from `--repo`, it posts nothing, prints the reason and exits 2. Without `--repo`, it uses the clone that has the script and the repository of its origin (`GH_REPO` is not read; if there is no origin or it cannot be read as a GitHub owner/name, it posts nothing and exits 2). The mark is counted by `bun scripts/merge-gate.ts <PR> --repo <owner/name>`.

## Target and environment

- Do not run it in the main working tree. Run it from a dedicated worktree of the target repository.
- The target of verification is the content of the PR's newest head merged into the newest tip of the base branch (decided 2026-10-21). It reads `headRefOid` and `baseRefName` from `gh pr view`, fetches `refs/heads/<base>` and `refs/pull/<PR>/head` (GitHub puts this on every PR, fork PRs too) into dedicated refs (`refs/local-ci/<PR>/base` / `refs/local-ci/<PR>/head`) and reads those refs (it does not read `FETCH_HEAD`, because another fetch in the same clone rewrites it. These two refs are overwritten by the next run and are not deleted. The ones for closed PRs remain in the clone; if you do not need them, delete them with `git for-each-ref --format="delete %(refname)" refs/local-ci | git update-ref --stdin`), and checks that the latter equals `headRefOid` (if it differs just after a push, it ends with an error without running anything. It does not retry by itself, so wait a little and rerun). It creates a worktree at the base and merges the head into it with `--no-ff`. It does not use GitHub's `pull/<PR>/merge` (so it can verify even when that does not exist or is stale). local-ci fixes the merge's name and signature (`-c user.name/user.email`, `commit.gpgSign=false`; the clone's settings do not matter). If the merge conflicts (unresolved paths remain), it does not run the steps and reports a failed result. A merge failure other than a conflict is an error and posts nothing.
- `localCi` creates a throwaway worktree in `~/.cache` and a TMPDIR in the OS's temporary directory (`tmpdir()`), and runs with an environment of only PATH / HOME / CI=true / TMPDIR. It does not bring in the daemon's SWITCHBOARD_*, real authentication values or a real Cloud session. The exception is the recordings' location `SWITCHBOARD_FIXTURES` that the caller specified explicitly: only that value is carried over, and if recordings are missing, the replay tests fail. If it is not specified it is not passed, and tests that have no recording count as skipped. The same holds for Actions and a public clone / fork; recordings are not made mandatory. Existing recordings are not distributed, so to verify replay, record with your own runner outside Git following [.claude/skills/runner-adapter-recording/SKILL.md](../../.claude/skills/runner-adapter-recording/SKILL.md), and run `SWITCHBOARD_FIXTURES=<録画のディレクトリ> bun scripts/local-ci.ts <PR>`.
- For the whole of one run (from reading head and base to cleaning up the worktree), it takes one heavy-work slot (`withHeavySlot`, the same as `ops-kit heavy`; the limit and the lower bound of free memory are the machine's setting `~/.config/ops-kit/heavy.json`; see heavy in `ops-kit --help`) before starting. While waiting for the slot to free up, it prints a line with the reason for waiting. The same machine's slot is taken when running a PR of another repository with `--repo`. On a host that has `sb-offload`, the slot is taken only during the steps run on the host, and is not held while waiting for the external build ("The host's heavy slot" in `local-ci-offload.md`).
- It runs the steps of CI. The path check, the frozen install, licenses, the type check and tests are not skipped. Only the perf steps (the Web build, fetching main, fonts, performance measurement, the performance judgment) are not run ("Perf is not measured in a PR's run" below). By default `bun test` runs the affected tests only (see "Narrowing `bun test`" below). The list of steps is fixed and not duplicated here; it is read from inside the worktree ("Steps (the same as Actions)" below).
- The pass mark carries, on its second line, the seconds of the type check and of bun test as one line, `<!-- local-ci-seconds {"typecheck":51.2,"test":43} -->` (added 2026-10-31; `LOCAL_CI_SECONDS` / `markerSeconds`. It does not show in GitHub's display. The seconds are measured the same as the table of steps, for the steps named `bun run typecheck` / `bun test` (a narrowed `bun test` changes its `run`, so look it up by name). In a checkout that has `scripts/ci.ts` (this repository), it stops with an error if either step is missing, and for a repository without `scripts/ci.ts` (`--repo`) the line is not added). What compares them is perf-ratchet ([perf.md](perf.md)).
- A result says what ran in its `テスト:` line and carries a machine line, `<!-- local-ci-tests {"ran":<number or null>,"total":<number>} -->` (`LOCAL_CI_TESTS` / `testsOf`). `ran` other than null means a narrowed run: do not read that run's `local-ci-seconds` `test` as the seconds of all tests, and it is not compared with the `test` ceiling below. A `--all` run has no total, so it has no such line.
- After every step passed, those two seconds are compared with the `local.durations` ceilings of the worktree's `scripts/perf-budget.json` (`judgeDurations` in `scripts/perf-ratchet.ts`, see [perf.md](perf.md)). A value over its ceiling does not fail the run: the result stays `[local-ci] pass`, and the comment has a warning heading (`所要時間の警告（合否には数えない…）`) with each `over:` line under it (`warnings` of the result). The seconds do not decide the merge. A checkout without that file or those ceilings is not compared.

## Reusing a pass

Before anything else, a run reads this PR's own comments. When the newest result there is a pass of the current head and `localCiOf`, with this PR as its own top, counts it (the pass is of this head, so its commits are the PR's as they are), the run prints `既に pass（<URL>）` and exits 0: no worktree, no fetch, no post. Anything else runs as usual. This check does not look at PRs above this one; which result merge-gate takes in a stack is in [docs/merge-gate.md](../merge-gate.md). `--force` runs regardless, and so does `--all`, because a narrowed pass is not what it asks for. An unreadable comment list means a normal run, and GitLab MRs always run.

## Narrowing `bun test`

- What changed since HEAD's fork from the default branch (a rename counts as both paths) goes to the worktree's `scripts/test-select.ts`, and only the files it selects run, as `bun test ./<path>`. A stacked PR's base is the branch below it, so a diff from that base would leave out the PRs below; from the fork it is the sum of every PR in the stack.
- A change it cannot judge, a selection that does not run or cannot be read, and `--all` run every test. Only local-ci narrows: the tag CI runs every test.
- Why a selection failed goes to local-ci's log, not to the result comment: the text holds host paths.

## Incremental run

A PR that already has a pass is not run in full again after a fix. When the newest result in this PR's own comments (by an author `MARK_AUTHORS` allows) is a pass of an earlier head, `incrementalBase` finds the commits added since:

- The pass's head is fetched; `git cherry <pass head> <head> <merge-base>` marks the commits the pass lacks with `+`, where the merge-base is the PR's fork from the base's tip. A rebase that kept every diff adds none, so only real fixes count.
- A merge commit of the PR that is not in the pass's history (a conflict resolved in it) is a change `git cherry` cannot see, so the run falls back to every step. The same holds when the newest result is a fail, is of this head, cannot be read, or the pass's head cannot be fetched.
- The files those commits touch, deleted ones included, go to the checkout's `scripts/test-select.ts` instead of the diff from the fork. A change it cannot judge runs every step, and so do `--all`, `--force` and `--change`.
- Otherwise only the install, the type check and the selected `bun test` run (`incrementalSteps`); the licenses check, the public tree check, the build and the perf steps are left to the tag CI. A CI that lacks one of those three steps runs all of its steps.

The result carries the usual pass mark, so merge-gate counts it like any pass, and one more line, `増分: <7 characters of the pass head> の pass の後の <n> コミット（変更 <m> ファイル）で、型検査と選んだテストだけ`.

## Perf is not measured in a PR's run

A PR's local CI runs the steps without the perf ones (no web build for the bench, no `fetch main`, no perf-bench, no perf-ratchet), so it never measures main again and has no perf verdict or `loaded` choice of its own. The tag CI runs every step, perf included, and measures it; a perf regression is caught there.

## Steps (the same as Actions)

Where the steps come from is read in this order in the worktree (`checkoutSteps`): `ops.config.json`'s `ci.steps` first (for a repository that keeps no CI on GitHub; `ci.yml` is then not read), else the `run:` entries of `.github/workflows/ci.yml`. With neither, it exits 2 with one line naming both places and posts nothing; a `ci` key that is not in its shape is the same. The expansion of `bun scripts/ci.ts` described next applies only to the steps taken from `ci.yml`; `ci.steps` entries run as they are.

The source of truth for the steps is `ciSteps` in `scripts/ci.ts` (a list of names and scripts run with `bash -e -c`). `ci.yml` of Actions has only one `run: bun scripts/ci.ts` after checkout and setup-bun, and `scripts/ci.ts` runs `ciSteps` in order and stops at the first step that fails (except steps with `keepGoing`; see below) (the environment is the runner's own. `GITHUB_ACTIONS` selects perf-ratchet's `github` ceiling). local-ci reads the `run:` entries of the worktree's `ci.yml` (`workflowSteps`), expands the `bun scripts/ci.ts` step into the worktree's `ciSteps` of `scripts/ci.ts` (`checkoutSteps`. It is the PR's code, so it is not imported into the local-ci process; it runs `bun scripts/ci.ts --list` in the worktree in the same environment as the steps and receives JSON), and runs them one at a time in the environment above. The part that runs the steps and stops at the first failure (except `keepGoing` steps) (`runCi`) and the exit (`ciExit`: 1 if any failed, 0 if all passed. The code of the failed step itself is in the line `✗ <手順>: exit <code>`. The step's code is not used directly as the exit, so that tsc's 2 is not confused with local-ci's 2 for "nothing was run") are the same in both. If a PR changes the steps, that PR's steps run. For a repository without `scripts/ci.ts` (`--repo`), the `run:` entries of `ci.yml` are the steps as they are.

The perf steps (`perf-bench.ts` and `perf-ratchet.ts check`) run before `bun test`, so a perf result does not wait for the whole test run (about five minutes). They carry `keepGoing: true` in `ciSteps`: when one of them fails, `runCi` does not stop there, `bun test` still runs, and the run fails at the end (`ciExit`). One run therefore reports both the perf result and the test result, and a fix for one does not reveal a red in the other on the next run. Every other step still stops the run at its first failure. Actions prints one `✗ <step>: exit <code>` line per failed step. The steps stay one list for Actions and local-ci, and they never run in parallel: perf-bench is not measured next to another load. A repository without `scripts/ci.ts` (`--repo`) has no `keepGoing` and stops at the first failing `run:` as before.

## Reporting the result

Whether or not there is an Actions run, the result is posted to the PR as the forge's `verification` (a PR comment on GitHub; `reportResult`). The first line is the mark, followed by the target (the 40 digits of head and base) and a table of the results of the steps that ran:

| Result | First line | Body |
|---|---|---|
| All steps passed | `[local-ci] pass <head sha> base=<base sha>` | The table of steps. It does not say which PRs of the stack this pass contains (merge-gate decides that with git) |
| A step failed | `[local-ci] fail <head sha> base=<base sha>` | Every failed step (the perf check and `bun test` can both fail in one run), each with its exit and the lines picked from its whole output: `(fail)` / `over:` / `raised:` / `improved:` / `grew:` / `無進捗で打ち切り` (up to 20 lines per step), then the table of steps. The whole text is in the record on the host that ran it (paths are not written) |
| The head cannot be merged into the base | `[local-ci] fail <head sha> base=<base sha>` | A conflict. The steps were not run |

When the perf check ran and printed a `bundle:` line, pass or fail, the comment has a part `bundle（gzip、マージ後と main の先端の差）:` after the lines of what was tested: the check's `bundle:` line (js / css, the merged size, main's tip, the difference in B and %) and its `grew:` lines when one of them grew 1% or more. A conflict has none (nothing ran).

Just before posting, it reads head and base again in the same way (`notify`), and if either changed during the run, it posts nothing and exits 1 (it does not write the result for a head or base that was not tested; run it again). It does not rerun because the base moved forward after the post, or because the head changed through the automatic rebase after a lower PR is merged (if the diff of each commit is the same, merge-gate counts it as included in the pass's head with `git cherry`. The mark is only the first line, so as not to require a format of another repository's copy of local-ci (decided 2026-10-29; before that, the second line carried each PR's patch-id). When to run it and how merge-gate counts it are in "When to run local CI and how it counts" of [docs/merge-gate.md](../merge-gate.md)). It does not post when it could not read them again either. The text to be posted passes the kit's check for authentication values (`runForgeOperation`). If posting fails because of authentication or permissions, it prints the reason and stops with exit 1 (it does not post by another route; for a Task, confirm in the conversation). The mark is read by `LOCAL_CI_RESULT` (pass or fail, the head, then `base=`; for how the merge decision treats it see [docs/merge-gate.md](../merge-gate.md)).

### Local changes (`--change`)

A change of a repository without a remote (the kit's `forgeOf` is `app`: no `forge` and no `origin`, or `forge: { "service": "app" }`) runs with `bun scripts/local-ci.ts --change <n> [--all] [--force]`, from inside its checkout, with `BACKLOG_URL` and `BACKLOG_WORKSPACE` (an app Task has them) to read the change. With a PR number or `--repo` it exits 2, and so it does in a checkout whose `forgeOf` is not `app` (the result is never posted on a PR of the same number). The other way round, a PR number in a checkout whose `forge` names `app` exits 2 too (it is never posted on the change of the same number).

- Target: the change's `changeRefs` (the branches' tips, read by `git rev-parse` at each read). Nothing is fetched (there is no remote; the local `refs/heads/<branch>` are read) and gh is not called
- Steps, environment, worktrees and conflicts are as for a PR (`localCi`): the head merged `--no-ff` into the base's tip. Tests are chosen against the base's tip. Worktrees and logs go to `~/.cache/switchboard.local-ci-change-<workspace id>-<n>…`. No bundle row is recorded (that goes to a GitHub records branch)
- Result: the same first line, posted as a comment on the change by the `app` row of `reportResult`'s services. The re-read before posting (`notify`) is the PR's: if a branch moved, nothing is posted (exit 1)
- Reuse: when the change's newest mark is a pass of the current head and base, it does not run again (exit 0; `--force` / `--all` run it). The merge gate (`scripts/merge-gate.ts --change`) counts a pass only for the current head and the base's current tip (there is no tag CI after a local merge). The whole flow: [local-changes.md](local-changes.md)

### Tag CI

The CI of a tag put on main after a merge (`bun scripts/tag-ci.ts [--repo <owner/name>]`) runs this document's steps in the same environment (it shares with `localCi` the part `runCheckout`, which runs the steps in a worktree and keeps the full text of a failure in `~/.cache`. The target is not a PR's merge but the tag's commit itself). The mark is not the PR's `[local-ci]` but `[tag-ci] pass|fail <sha>` in the body of that tag's GitHub Release. If you add `SWITCHBOARD_FIXTURES` and recordings are missing, the tag CI runs no steps, writes no mark and stops with exit 2 (it is a shortage on the host, not the tag's result). The rule of starting from the newest tag and going back when it fails, and how to read it, are in the "Tag CI" section of [releases-and-rescue.md](releases-and-rescue.md).

## Running the steps while keeping full output and measurements

The steps are run by `runIdle` in `ops-kit/src/idle-run.ts`. A step that prints no output for 15 minutes (`STEP_IDLE_SECONDS` in `scripts/ci.ts`) is cut together with its process group, and is treated as a failed step with exit 124 and the reason line `無進捗で打ち切り: 900 秒出力がなかった`. There is no limit on the total time. A process the step started in the background is killed when that step ends (unlike Actions, it does not remain until the next step). If local-ci itself is stopped by a signal, it is not treated as a step failure and ends without posting anything.

For a failed step, `local-ci.ts` keeps the full text in `~/.cache/switchboard.local-ci-<owner>_<name>-<PR>-log.*` and prints the lines `(fail)`, `over:`, `raised:`, `improved:`, `grew:` and `無進捗で打ち切り`, the last 30 lines and its path (added 2026-10-17. Steps that passed are not kept. The directory of the previous failure of the same PR is removed at the next failure, so there is one latest per PR). When more than one step failed in a run (a perf step and `bun test`), each one's whole output is a file `<n>-<step>.log` in that same directory, `<n>` being the step's place in the run.

The following is the procedure for when you also need the full text of the steps that passed, or `perf-result.json` (decided 2026-10-22). It uses the same `localCi` engine, environment and commands, and saves each step's full text and measurements before cleanup. It does not change whether a step succeeded or the judgment rules, and it does not post a pass mark to the PR automatically.

In a dedicated worktree, run it with the target number given in `PR`.

```bash
PR=1116
CI_EVIDENCE=$(mktemp -d /tmp/switchboard.ci-evidence.XXXXXX)
cat > "$CI_EVIDENCE/run.ts" <<'TS'
import { existsSync } from "node:fs";
import { join } from "node:path";
const [prArg, root, evidence] = process.argv.slice(2);
const { localCi, remoteRepo } = await import(join(root, "scripts/local-ci.ts"));
let sequence = 0;
const sh = async (cmd: string[], cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (exit ${code})`);
  return out;
};
const step = async (script: string, cwd: string, env: Record<string, string>) => {
  const p = Bun.spawn(["bash", "-e", "-c", script], {
    cwd, env, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  const output = out + err;
  await Bun.write(join(evidence, `step-${++sequence}.log`), output);
  return { code, output };
};
// the PR's repository is this worktree's origin, as local-ci.ts without --repo (GH_REPO is not read)
const repo = remoteRepo(await sh(["git", "-C", root, "remote", "get-url", "origin"]));
if (!repo) throw new Error("origin is not a GitHub owner/name");
const result = await localCi(Number(prArg), root, { sh, step, log: () => {} }, repo);
await Bun.write(join(evidence, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ sha: result.sha, ok: result.ok, steps: result.results.length }));
process.exitCode = result.ok ? 0 : 1;
TS
bun "$CI_EVIDENCE/run.ts" "$PR" "$PWD" "$CI_EVIDENCE"
```

Exit 0 means every step passed, and exit 1 means a failure (this procedure does not post to the PR). Do not attach `[local-ci] pass` to a run that failed. Read the log before publishing it, and do not paste raw output that contains authentication values, references to a real Cloud session or personal information.

## When the performance check fails

A PR's run has no perf verdict. An `over:` / `raised:` / `improved:` / `grew:` result comes from the tag CI, in the Release's `## CI` part; what to do with it is in [perf.md](perf.md).

## Type check (tsc and bun check)

`bun run typecheck` runs a type check in each package. Two checkers read the same `tsconfig.json`: `tsc --noEmit -p tsconfig.json` and `bun check -p tsconfig.json`. The `typecheck` script of each package's `package.json` says which one is in use. If you want to know whether the faster one gives the same verdict on your host, compare them yourself.

To compare, in each package's directory (the depth of the path to `node_modules` depends on where the package is):

```bash
../../node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false
bun check -p tsconfig.json --no-pretty --all
```

What to compare:

- On the code as it is, both should exit 0.
- Append one deliberate error, such as `export const __typeErr: number = "s";`, to the end of one file in the package's tsconfig, and run both again. Both should exit non-zero and print the same `<file>(<line>,<col>): error TS2322: …` line. Only the exit code may differ (2 for tsc, 1 for `bun check`); the success or failure of `bun run typecheck` and of CI does not change. Revert the error afterwards.
- An error in a file that `exclude` leaves out (for example the test files that use `bun:test` in `apps/web`) is left uncounted by both, because `bun check` follows `exclude` too.
- Time and peak memory: `/usr/bin/time -v bun run typecheck`, a few runs each, on a host with enough free memory and no other heavy work. Compare the medians. The difference depends on the host, so measure it there.

`bun check` takes the tsconfig with `-p`. If there is an error it prints `<file>(<line>,<col>): error TS…` lines and exits 1. Past a pipe, `--no-pretty` is the default; on a terminal it also shows the surrounding code. `--all` does not group the same error even when it exceeds 50.

The form of the output varies with the environment: in the environment of CI and local-ci (`CI=true`, no agent variables) and past a pipe it is one `<file>(<line>,<col>): error TS…` line, the same as tsc; on a terminal it includes the surrounding code; inside an agent (where `CLAUDECODE` and the like exist) it is `<error file="…" line="…" column="…" code="TS…">`. All of them print the file and line.
