# Daemon jobs: local CI and reviews run outside the Task's session

A Task asks the daemon to run local CI or a review for it, writes `job#<id>` as what it waits on, and ends its turn.
The daemon runs the job as its own child and, when it ends, resumes the Task with a short result.

## Why

A Task used to start local CI or a review from its own shell and wait for it with a loop (`sleep 30` repeated, in the
background). A background job that is still alive keeps the runner process from closing at the idle timeout
(`SWITCHBOARD_RUNNER_IDLE_MS`), which is correct. So every waiting Task held a session open: 150 to 250 MB each. On
2026-11-06 sessions of finished Tasks were found waiting this way for 4 hours 20 minutes, 3 hours 56 minutes and 19
minutes. Free memory was about 1.1 GB on a 3.8 GB machine, below the floor of the heavy-work slot (1536 MB), so the local CI
that those sessions waited for could not start. The wait was the cause of the stall it was waiting out.

The idle timeout was not the bug. The fix moves the wait out of the session: nothing of the Task is left running while
the job runs, so the session closes at the timeout like any other finished turn.

## What a Task does

```bash
ops-kit job request local-ci <PR> [--cwd <dir>] [--fixtures <dir>] [--local] [--change]
ops-kit job request review <PR> [--runner codex|claude] [--as fallback|recheck|audit|attack|arbiter] [--kinds <k,k>] [--change] --prompt <file> --out <file> [--cwd <dir>]
ops-kit job request recheck <PR> --kind migration|rescue|security:lockfile [--cwd <dir>] [--change]
ops-kit job list [--json]
```

`request` prints `job#<id>` and an example of the stop report. The Task writes that report in its `switchboard-stop`
fence (reason `depends`, one condition with key `job#<id>`) and ends its turn. It does not poll.

A review's runner is the daemon's to decide. The main reviewer follows from the review setting as it is when the job is
asked for and from the Task's runner (`primaryReviewer` in `ops-kit/src/conditions.ts`): the Task's own runner for `same`,
the other one for `other`. Without `--runner` the job runs with that reviewer. A `--runner` that names another one is
refused with a message that names the right one, unless `--as` says why another runner reads the PR: `fallback` (it
stands in for a main reviewer at its usage limit) or `audit` (the post-merge audit, whose reader is decided from who
implemented the merged PR and the recheck setting, `auditorOf` in `scripts/post-audit.ts`). `recheck` (the second reader
of a recheck) needs no `--runner`, and the app picks its runner from the setting: its reader follows from the recheck
setting (`recheckRunner`, the `再チェック・マージ後の監査` (`Recheck and post-merge audit` in English) row of Settings, `OPS_KIT_RECHECK_RUNNER` in a Task; unset = the
review setting's value) and the main reviewer — the main reviewer's own
runner in a new session for `same`, the other one for `other` — and a `--runner` that names another one is refused with a
message that names it. Every review job runs with the saved review model and effort of its runner (`reviewModel` /
`reviewEffort`), and with the runner's Task defaults where those are empty. The choice of the main reviewer does not depend on what the Task read. `attack` (the attacking-side review, its instruction printed by `ops-kit review-attack prompt`) names its runner like `fallback`: first the one `attackReviewer` names, the main reviewer's runner (another runner than the implementer under `other`, the implementer's own new session under `same`), and the other runner when that one is at its usage limit, so the attacking-side review does not wait on one runner. Either runner is accepted: the app does not check the usage limit, as for `fallback`. A Task whose runner reviews nothing (not
Claude Code or Codex) must name the runner, and cannot ask for `attack` at all (no runner can be named for it).

With `--fixtures <dir>` (an absolute path, local CI only) the folder becomes the job's `SWITCHBOARD_FIXTURES`, so missing
recordings fail as when the owner runs local CI by hand; the daemon's own environment does not carry it.

## Why kinds, and why the daemon builds the argv

There are four kinds that a Task starts, `local-ci`, `review`, `recheck` and `gate` (the app starts `tag-ci` itself). A request names a kind, a PR and (for a review) two files and optionally a runner;
a `recheck` names one of the rechecks whose pass is a command's exit code (`migration`, `rescue`, `security:lockfile`), and the daemon
runs the checkout's `scripts/recheck.ts` with that kind (a checkout without the script is refused). It never carries a command. The daemon builds the argv itself (`jobCommand` in `packages/core/src/jobs.ts`). For local CI
that is the checkout's own `scripts/local-ci.ts` when the checkout is Switchboard's; a checkout of another registered
repository has no such script, so the daemon runs Switchboard's (the meta workspace's) from that checkout's folder with
`--repo <owner/name>` read from its origin. A job also gets the place of the settings Switchboard keeps for the
checkout's workspace (`OPS_KIT_CONFIG`), as that workspace's Tasks do, so it reads the same CI steps. A command
taken from the request would let a Task run anything the daemon can run, going around the permissions the Task runs
under. The `cwd` is accepted only if it is a checkout of the Task's repository (under the Task's folder, a worktree of
it, a clone of the same origin, which is what a review's fresh clone is, or a clone of the origin of any workspace
registered in the app, which is what an audit Task needs to read another repository's PR); the prompt and output files must be inside
that `cwd`. When a review ends, the usage it left (`claude.jsonl`, `codex.jsonl`) goes to the ledger under the Task that
asked, with source `job`, so what a review cost can be told; a review that left nothing readable books nothing and still
ends normally. This guards against mistakes. It is not a boundary against the Task itself, which runs as the same OS user.

A job is a detached child of the daemon, started through a small wrapper that writes the exit code to
`<jobs dir>/<id>/exit`. Local CI and a `recheck` take a heavy-work slot like any other heavy run. A `recheck` records the head of its checkout, is refused when the checkout has uncommitted or untracked files, and does not run if the head moved while it waited for the slot. A review waits only for the
memory floor (`ops-kit heavy --memory-only`) and is cut after a period without output (`idle-run`). A job that is
waiting for the slot is "waiting" in the resource view; the job's own status does not gain a waiting state.

## The gate: a Task's merge verdict and merge are the app's

In a Task, `bun scripts/merge-gate.ts <PR> [--allow-large] [--merge | --merge-stack | --merge-sync] [--repo <owner/name>]` (and `--change <n>`, `--scope`, `--viewpoints`) does not judge in the Task's shell. It posts a `gate` job (the PR's number and the flags; no command, no environment) and reads `GET /api/jobs/<id>` every 2 seconds until the job ends, prints what the job printed and ends with the job's exit code (0 merge, 1 stop or a failed merge). The wait is `SWITCHBOARD_GATE_WAIT_MS` (default 10 minutes), and the Task's turn is not ended: a verdict takes 10 to 60 seconds and the Task needs it at once. A daemon that does not answer, a request it refuses (an older daemon that does not know the kind), a wait that runs out, or a job that ended without its exit code is not a verdict: exit 2, and the merge is not made by the Task.

The job runs the daemon's own `scripts/merge-gate.ts`, the code of the version that is running. It is started in the daemon's own folder with Bun's `.env` loading off (`bun --no-env-file`), so a `bunfig.toml` (a `preload` is code) or a `.env` in the Task's checkout is not read by it; the checkout is named by `--cwd` and is only the folder the script reads the PR's commits and settings in (git and `gh` run in the checkout: the front of `gh` reads its refusals to write, `ops-kit.noWrite` and the like, from the working tree it runs in, and `gh stack merge` acts on it; the front is started with Bun told not to read that folder's `.env` and `bunfig.toml`). A PR that changes the rules of the gate is therefore judged by the rules that are running, not by its own copy. The job's environment is the daemon's: the records are read at the daemon's own address (`cfg.host`, the loopback address by default) with its own key (`MERGE_RECORDS_URL`, `MERGE_RECORDS_TOKEN_FILE`), and the Task's own addresses and variables are not in it. The consent to an ask reason is read for the Task that asked (`OPS_KIT_TASK_ID`), so the person's grant held for that Task and that head is what `--allow-large` needs, as before. The front of `gh` that stops a Task's merge is on only where `BACKLOG_URL` is set, and the job has none (a `--change` job has the daemon's backlog address, to read the change; it only judges), so the merge the job makes needs no grant of the person outside the gate: it is made only at a `merge` verdict of the app's copy, and a sync PR of the local main (`--merge-sync`, a Merge commit, only for a branch `sb/sync-main-<7>`) the same way. No variable of the Task's shell stands for it. This is the one merge a Task can ask for without the person's grant outside the gate; the other jobs (`local-ci`, `recheck`) run a script of the Task's checkout as the Switchboard OS user, as before. A Task's local merge of a change (`scripts/local-merge.ts`, a git operation of the Task's shell) takes its judgement from a `--change` gate job in the same way.

A gate job records the verdict in `result.gate`: `verdict`, `head` (the PR's head it judged, also the job's `head`), `ask` and `recheck` (the kinds that stopped it), `reasons`, `allowLarge`, `reviewSkipped` and `merged`. A run that judged nothing (exit 2) leaves no result. The verdict is also printed to the job's `out` file, which `GET /api/jobs/<id>` returns.

Until a daemon that knows the kind is the one running, a newer `scripts/merge-gate.ts` in a Task's checkout asks an older daemon, which refuses the kind: exit 2, nothing is merged. The way through is to promote the daemon first.

## What a reviewer reads

A reviewer is meant to judge a PR with no prior context: the instructions (`prompt.md`), the material under `_review/`
(the PR, the Task, the PBI, the design rules, the diff) and the code of the fresh clone. Started plainly in that clone,
a runner also loads what is there for an implementer: the clone's `CLAUDE.md` / `AGENTS.md` (where to work, how to merge
and promote, how a Task stops), the user's memory, and the user's MCP servers, skills and plugins. Those contradict
"review with no prior context" and are not the reviewer's to act on.

`jobCommand` therefore starts a reviewer with `REVIEWER_ISOLATION` (`ops-kit/src/review-note.ts`; the commands in the
`cross-runner-review` skill that run a reviewer directly carry the same values, and a test compares them):

| Reviewer | Added to the start | Leaves out |
|---|---|---|
| Claude Code | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in front of the command; `--strict-mcp-config`, `--disable-slash-commands` | the clone's and the user's CLAUDE.md, auto memory, MCP servers, skills and slash commands |
| Codex | `-c project_doc_max_bytes=0`, `-c mcp_servers={}`, `--disable plugins`, `--disable apps` | `AGENTS.md`, MCP servers, plugins and apps |

Not used: Claude Code's `--bare` (it signs in with an API key only), Codex's `--ignore-user-config` (it would also drop
the user's model choice), and removing files from the clone (a tracked file changed in the clone changes what the
reviewer sees of the diff). The repository's design rules still reach the reviewer, as material (`_review/design-rules.md`).
There is no setting to turn this off: a reviewer never needs the implementer's rules.

What a reviewer may write and run depends on how its runner is started, so the instructions do not say it: it may
write tests in its checkout and run them in a heavy slot (`ops-kit heavy -- bun test <file>`), and write nothing outside
the checkout. Codex runs in a `workspace-write` sandbox without network, `/tmp` and `$TMPDIR`, with the heavy slots'
folder as the one other writable place (without it, `ops-kit heavy` runs the test without a slot). Claude Code runs with
`--permission-mode dontAsk` (a tool use no rule allows is refused) and `--allowedTools "Bash(ops-kit heavy -- bun test:*)"
"Edit(_review/tests/**)" "Write(_review/tests/**)"`: it edits only its tests, not other files of the checkout such as
`.git/config` that a later `git` call there would act on (an unscoped `Edit` or `Write` would allow them anywhere). The test
it runs is code the reviewer wrote, so it runs in Claude Code's sandbox (bubblewrap and socat; `--settings` with
`sandbox.enabled`): it writes in the checkout and the heavy slots' folder but not the checkout's `.git`, not `/tmp` or the
home folder, and has no network; `allowUnsandboxedCommands: false` keeps every command in it, and `failIfUnavailable`
ends the run when the sandbox cannot start, because Claude Code otherwise runs the command unsandboxed. When `bwrap` or
`socat` is not on the job's `PATH`, the daemon starts the Claude reviewer in plan mode instead: it only reads, its note
says that no test was run because the sandbox is unavailable, and the job's log says so too. The job's
`TMPDIR` is the job's own folder (`tmp` in the job's folder under the daemon's jobs), not a folder in the checkout:
Claude Code makes its sockets under it, and a socket's address holds at most 108 bytes, which a checkout with a long
path left no room for (the sandbox then did not start). Codex names it with `--add-dir`; Claude Code writes in its own
`claude-<uid>` under it; the daemon removes it when the job ends. The daemon refuses a `_review` that leads out of the
checkout through a link. Because the reviewer may write in its checkout, that
checkout must be a separate clone or worktree: the daemon refuses a review whose `--cwd` is the Task's own working
folder, a registered workspace's checkout or the working tree of any Task that has not ended, or a folder inside
one of them, by their real paths. Another Task counts by the git working tree that holds its folder (a Task in a package folder protects the whole
tree); a folder in no working tree counts for nothing, so a Task that works in a broad folder such as the home folder
does not refuse every review. The reviewer writes its output in the job's own folder (`<jobs dir>/<id>/out.md`,
which it cannot write to), not at `--out`. When the job ends, the daemon copies the output to `--out` in a short child
process started in the folder of `--out`. That child runs outside any sandbox in a folder the reviewer could write to, so it
is started with Bun's `.env` loading off and the daemon's own `bunfig.toml` (`--no-env-file --config=…`): a
`bunfig.toml` (a `preload` is code) or a `.env` the reviewer left there is not read. Entering the folder pins it, so a folder on the way that is swapped for a link
afterwards (by a process the reviewer's test left running) changes nothing for the child. The child reads where its
folder really is (the kernel's path of its working folder) and refuses a folder outside the checkout. It then creates
a new temporary file by a relative name, without following a link, and renames it over `--out`. A rename replaces a
link or a hard link put at `--out`; it does not write through it. A reviewer cannot move a folder of the checkout to
somewhere outside it, because its sandbox does not write outside the checkout. A copy that cannot be made is noted in
the job's log; the job still ends. One job whose end cannot be recorded is ended as aborted and does not stop the
other jobs' recovery when the daemon starts. The findings are read only from the job's own copy, never from the
checkout. Claude Code's Edit and Write tools do not write through a link either: in
a run of Claude Code 2.1.330 with these flags, a write to a link under `_review/tests/` that pointed outside the
checkout was refused. A reviewer's test waits for a heavy slot like any other; one
that was cut or did not run is reported as not run. The daemon writes `<jobs dir>/<id>/prompt.md` — the Task's instructions
followed by the note of the runner that actually reviews (`REVIEWER_NOTE`) — and the job reads that file; the Task's own
file is not changed. The note is added at the start, not written into the instructions or chosen by the skill's
condition blocks, because a usage-limit fallback changes the reviewer after the instructions were written. A person who
runs a review directly gets the same text from `ops-kit review-note <codex|claude>`.

The same note carries the rules that hold for every review, whatever its kind (`REVIEW_RULES`): the one definition of a
finding's weight (blocker / should-fix / nit / question, decided by what breaks and not by an earlier round's mark; a blocking
finding — blocker or should-fix — carries `Evidence:`, a test that shows the break or the written rule it rests on, and one
without it is a nit; the implementer decides whether to take a non-blocking one — nit or question), taking
the implementer's answer to a finding in `_review/handled.md` (not needed, a non-blocking finding left as it is) as the
implementer's judgement, to which the reviewer objects at most once, as `Repeat of:` (the arbiter rules on it; a finding under
`## Rulings (closed)` is not raised again; one ruled for the reviewer stands until fixed), checking in the code a blocker or should-fix said to be fixed, marking a point raised again
after its fix (`Repeat of:`), keeping a follow-up round to the fix, what the description now says about it and the readers of what it changed, checking the places `_review/old-paths.md` lists, and using a comparison with main
(`_review/compared.md`, the output of a comparison round asked for with `ops-kit review-compare prompt`): a `REGRESSION` row is raised again until the code closes it, and the
other rows are not raised again unless the change makes them worse than main. A branch that carries anything under `_review` does not
get its classes used; that is a blocker. These rules are here and not in each
kind's instructions so that the main review, the follow-up and a recheck cannot drift apart; `handled.md` and `old-paths.md` are made by
`ops-kit review-handled` and `ops-kit old-paths check` when the review's material is prepared (the kit's README, "Review material").

What each of them removes from a reviewer's input was measured with one run of each runner without the isolation and one
with it, in one review checkout (a fresh clone of a merged PR with its `_review/`; the memory figure below comes from a
folder that had a memory, which a new checkout has not), with the argv of `jobCommand` and an instruction that asks the runner only to report what
it has, followed by the runner's note. The numbers come from the runner's own record, not from what the model says about
itself (it miscounts its tools and slash commands). They depend on what the user has installed and on the CLI version, so
read them as an example of where the input comes from; the list after the tables says how to read them on your own machine.

Claude Code (input tokens are the first turn's input, cached or not, from the `result` line):

| Input | Without isolation | With isolation |
|---|---|---|
| Instructions: `prompt.md` and the runner's note (`ops-kit review-note claude`) | the same | the same |
| Material under `_review/` | read when the instructions ask for it | the same |
| `CLAUDE.md` files of the clone | in context: the model quotes a rule of the clone's `CLAUDE.md` when asked | none: asked for the rule, it answers `NONE` |
| The user's `CLAUDE.md` and memory | in context (the memory index was about 1.3k tokens) | none |
| Tools / MCP servers / skills / slash commands / plugins (`init` event) | 23 / 1 / 37 / 67 / 3 | 22 / 0 / 0 / 0 / 3 |
| Input tokens of the first turn | 43.6k | 24.9k |

The plugins left are Claude Code's own built-in ones (their source ends in `@builtin`), not the user's. The `tools` list of
the unisolated start also grows when an MCP server finishes connecting after `init`, so the count of tools there is not fixed.

Codex (from the session record Codex writes under `~/.codex/sessions/` when `--ephemeral` is left off):

| Input | Without isolation | With isolation |
|---|---|---|
| Instructions: `prompt.md` and the runner's note (`ops-kit review-note codex`) | the same | the same |
| Material under `_review/` | read when the instructions ask for it | the same |
| `AGENTS.md` of the clone | a user message beginning `# AGENTS.md instructions` | no such message; the first user message is only the environment context |
| The user's instructions | none were present when measured (no user-level `AGENTS.md`) | none |
| Tools, apps, plugin skills | the 12 built-in tools, plus the apps' tools (`mcp__codex_apps__*`, 13); 32 skills listed, most from plugins (17.0 KB of skills text) | the 12 built-in tools; no apps' tools; Codex's own 4 skills (3.9 KB) |
| Base instructions | 28 KB | 28 KB (not changed by any flag) |
| Input tokens of the turn | 20.4k | 17.1k |

What each candidate removed, with the other candidates left off (Claude Code), or alone (Codex):

| Candidate | Effect |
|---|---|
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | Removes every `CLAUDE.md` (the clone's and the user's): about 16.7k input tokens, and the model no longer quotes the rule. The largest single effect |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Removes the project's memory index: about 1.3k tokens, measured in a folder that has a memory. A new review checkout has none, so there it removes nothing until a memory is written for that path |
| `--strict-mcp-config` | The user's MCP servers go to 0 |
| `--disable-slash-commands` | Skills and slash commands go to 0 (skills are slash commands to Claude Code) |
| `-c project_doc_max_bytes=0` | The `AGENTS.md` message is not sent |
| `-c mcp_servers={}` | Not shown by this measurement: the Codex config it ran with named no MCP server, and the apps' tools come from the apps feature, not from `mcp_servers`. It is kept for a config that names servers; that case has not been measured |
| `--disable apps` | The apps' tools go to 0; the skills list does not change |
| `--disable plugins` | The plugins' skills are no longer listed (32 to 4); the apps' tools stay |

Both CLIs accept the isolated start (Codex with the sandbox flags of `jobCommand`) and run to the end, signed in with the
same OAuth login as without it (`--bare` is not used). Claude Code's `--debug-file` does not print the paths of the
`CLAUDE.md` files it reads, so it is not the evidence for them; the model's answer to a question only the file can answer,
and the input tokens, are.

Measured with Claude Code 2.1.331 and Codex CLI 0.172.0.

To check a reviewer's input on your own machine:

- Claude Code: add `--output-format stream-json --verbose` and read the first line, the `system` event with `subtype` `init`:
  its `tools`, `mcp_servers`, `skills`, `slash_commands` and `plugins` are the lists the reviewer got. Ask the reviewer a
  question only a loaded file can answer (for example, to quote a rule of the checkout's `CLAUDE.md`, or the first line of
  your memory index): `NONE` is the isolated answer.
- Codex: run without `--ephemeral` and with `--json`. The `thread.started` event gives the run's `thread_id`; the session
  record under `~/.codex/sessions/` (or `$CODEX_HOME/sessions/`) whose file name ends in that id is the run's own. Its first
  lines carry `base_instructions`, the tool namespaces, the developer message with the skills list, and a user message
  beginning `# AGENTS.md instructions` when `AGENTS.md` was loaded; a user-level instructions file shows up there the same
  way. Delete that one file when done (not the newest file: another Codex session may have written one since). The
  `turn.completed` event carries the turn's input tokens.

## How the Task is resumed

A stop whose conditions are all `pr#N`, `issue#N`, `job#<id>` or `promoted#<sha>` is resumed by the daemon without a person
(`packages/core/src/depends-resume.ts`, `WAIT_KEY` and `PROMOTED_KEY`). `pr#N` and `issue#N` close when GitHub says so, at the
backlog import. A `job#<id>` closes when the job ends (pass, fail or aborted), and the end of a job runs the same
resume. The resume message carries each job's kind, runner, PR, status, exit code and a summary, so the Task reads the
result and continues. A Task whose job has not ended is not resumed.
A `promoted#<sha>` (a sha of 7 to 40 hex digits) closes when the running version contains that commit; `resumeDepends` asks a judge it is given (`promotedOf`) once per sha in each pass, before it looks at the Tasks, and reads no judge, or an answer it cannot give, as not closed. A stage Task gets its turn for a promotion too (backlog-next starts nothing on one) when the stop waits on promotions with no `pr#N` / `issue#N`, every wait of the Task has closed, and it is still its Issue's latest stage Task; the turn does not ask it to run the overlap check again.
A `job#<id>` on a stop whose reason is other than depends (a decision, for one) is met when the job ends too, also when the Task reports it open again afterwards; that stop keeps waiting for the person's answer, and no resume message is sent for it.
A job's result reaches the Task without waiting for its PR or Issue waits, which are resumed on their own when they close.
Results are batched only while the same Task still waits on a running job: the last job's end sends one message with every result.

## After the daemon restarts

The daemon can stop while a job runs. At start, `recoverJobs` goes through the jobs still marked running. A job that
left an exit code ends with it. A job whose process is still alive in this boot is looked at every few seconds until it
ends. A job whose process is gone, or that started in another boot (after a reboot the pid may belong to another
process), without an exit code is aborted. In every case the end runs the resume, so a Task waiting on a job is not
left waiting after a restart.

## Out of scope

Type checks, `test-changed` and E2E runs are not jobs of their own (the `rescue` recheck runs its E2E inside the `recheck` job). They finish in minutes and the Task needs the result at once, so
the Task runs them itself under `ops-kit heavy`. Other waits (an Actions run, a PR to merge) are not jobs either.
The kinds are fixed here; the memory floor is the kit's per-machine setting (see the kit README). This document does not copy the values the app owns (the number of jobs,
timeouts), which are in the app and the resource view.
