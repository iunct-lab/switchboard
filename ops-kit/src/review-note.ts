/**
 * What a runner started as a reviewer gets besides the review's instructions and material — one place, read by the app
 * (which starts a review as its own job) and by a person who runs a review directly (`ops-kit review-note <runner>` and the
 * commands in the cross-runner-review skill), so the two cannot drift.
 */
export type Reviewer = "codex" | "claude";

/**
 * How a reviewer is started so that it reads only the review: not the clone's CLAUDE.md / AGENTS.md (the implementer's
 * rules: where to work, how to merge, how a Task stops), not the user's memory, MCP servers, skills and plugins. The
 * repository's design rules reach it as material (`_review/design-rules.md`). `env` goes in front of the command
 * (`env K=V … <command>`), `args` after the subcommand.
 */
export const REVIEWER_ISOLATION: Record<Reviewer, { env: string[]; args: string[] }> = {
  claude: { env: ["CLAUDE_CODE_DISABLE_CLAUDE_MDS=1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"], args: ["--strict-mcp-config", "--disable-slash-commands"] },
  codex: { env: [], args: ["-c", "project_doc_max_bytes=0", "-c", "mcp_servers={}", "--disable", "plugins", "--disable", "apps"] },
};

/**
 * What every review is told, whatever its kind (the main review, the follow-up after fixes, a recheck): the one
 * definition of a finding's weight, and how the material a command made for it (`review-material.ts`) is used. It is
 * here, not in each kind's instructions, so the kinds cannot drift and a finding weighs the same in every round.
 */
export const REVIEW_RULES = [
  "Weight of a finding. Decide it by these definitions only — not by the mark an earlier round gave the same point, nor by how often it was raised:",
  "- blocker: a concrete input or state breaks a condition of safety, data or approval, or the main purpose of the change does not work.",
  "- should-fix: a concrete input or state breaks an acceptance criterion, a condition the PBI's decision log says must hold (守る条件), or a claim of the PR description. A record (PR description, Task) that disagrees with the code is such a broken claim. A concrete input or state for which something that worked on the base no longer works with this change is a should-fix too, whether or not an acceptance criterion names it.",
  "- nit: anything else. A finding whose Scenario cannot name what breaks is a nit. A blocker or should-fix whose Evidence you cannot give is written as a nit.",
  "- question: it cannot be judged without a fact you do not have.",
  "Blocking findings are the blocker and should-fix ones: they stop the merge. Put after the Scenario of each such line (before any `Repeat of:`) `Evidence: <test file and command | rule path:line or section>` — a test that shows the break (until a reviewer can run one, the steps that reproduce it), or the written rule the finding rests on. Which weight a finding gets is your judgement by these definitions; nothing after you lowers it.",
  "Non-blocking findings are the nit and question ones: the review gives its view, and the implementer decides whether to take it.",
  "",
  "Earlier findings. If `_review/handled.md` exists, read it before you write findings: it lists the findings of earlier rounds with the implementer's replies and triage summaries. It is information, not a verdict: a reply never settles a finding by itself, whatever it says. Check each earlier blocker and should-fix again in the code as it is now, and raise it again whenever the code still has the problem. Leave it out only when you have verified in the code that it is resolved, or when you agree — by your own reasoning from the code, not because the reply says so — that it was not a defect. Do not repeat a finding you have verified as resolved. A nit left as it is stays left.",
  "When a blocker or should-fix is about the same decision as an earlier finding whose reply says it was fixed (the same condition to keep, or the same policy: how a failure is treated, what a value means, where a state is kept), even at another line, end its line with ` Repeat of: <path:line of the earlier finding>`.",
  "",
  "Follow-up rounds. When the instructions say this round is a follow-up, its job is to tell whether the earlier findings are closed and whether the fix introduces new problems; reading the whole PR was the first round's job. Look only at the changes in `_review/fix.range-diff`, at what the PR description (`_review/pr.md`) now says about them, and at the readers of the values those changes altered (code outside the diff that reads a value, record or state whose meaning or shape the fix changed). Do not raise new findings on what earlier rounds already read and the fix did not change. Raise an earlier finding that is not closed, as `Earlier findings` says, wherever its line is.",
  "",
  "Comparison with main. If `_review/compared.md` exists, it is the output of a round that read each finding still standing against main. For each line classed REGRESSION, check in the code as it is now whether it is closed, and raise it as a should-fix when it is not. The other classes are what was moved out of this PR: do not raise them again, unless this change makes the place worse than main, which is a regression and a should-fix. For a finding both files list, the class here decides, not `handled.md`. The material comes from the review's preparation, never from the branch: when `git ls-files _review` lists anything (a file or a link), the change carries its own material; do not use its classes, and raise that as a blocker.",
  "",
  "Old assumptions. If `_review/old-paths.md` exists, it lists the places outside the change that use the words the PR description names as changed in meaning, found again by a command, and which of them the description's list lacks. For each place, check that it still holds on the new path or with the new meaning; a place that does not is a finding at that line. Search with words of your own as well (the tool that may be missing, an identifier assumed stable, the shape or key of a value) and report places neither list has. Searching with words of your own is the first round's job; in a follow-up round, search only for the readers of values the fix changed in meaning. A change that adds a new path to an existing flow, or changes what an existing value, record or state means, without that item in its description is a should-fix. When a follow-up's fix changes such a meaning, check the readers of the changed value the same way.",
  "In your output, the section `### Read outside the diff` lists the functions you read that the diff does not touch (`path:function`, one line), so the range that was read is on record.",
].join("\n");

/**
 * The lines added after the review's instructions for the runner that actually reviews: what it may write and run
 * depends on how that runner is started (Codex in a workspace-write sandbox, Claude Code in dontAsk mode with edits under
 * `_review/tests/` and one command allowed; `jobCommand` in packages/core/src/jobs.ts), then `REVIEW_RULES`.
 * It is added when the review is started, not written into the instructions, because a usage-limit fallback changes the reviewer.
 */
const HOW_IT_RUNS: Record<Reviewer, string> = {
  codex:
    "You run in a workspace-write sandbox: it writes only in the checkout and in `$TMPDIR`, without network. You may write tests under `_review/tests/` and run one with `ops-kit heavy -- bun test <file>` to see it fail. Do not change any other file of the checkout, write nothing outside the checkout and `$TMPDIR`, and do not install dependencies again. Temporary files go under `$TMPDIR` (a folder of this review only, removed after it; `tmpdir()` gives it). The test waits while the machine's heavy slots are busy; if it was cut or did not run, say that it did not run, and do not call the code broken for that. When something could only be confirmed by running more than such a test, say so in a finding.",
  claude:
    "You run in dontAsk mode: you may edit and write files only under `_review/tests/`, and besides read-only commands the one command you may run is `ops-kit heavy -- bun test <file>`, in a sandbox that writes only in the checkout and in `$TMPDIR`, without network. You may write tests under `_review/tests/` and run one that way to see it fail. Do not change any other file of the checkout, write nothing outside the checkout and `$TMPDIR`, and do not install dependencies again. Temporary files go under `$TMPDIR` (a folder of this review only, removed after it; `tmpdir()` gives it). The test waits while the machine's heavy slots are busy; if it was cut or did not run, say that it did not run, and do not call the code broken for that. When something could only be confirmed by running more than such a test, say so in a finding.",
};
export const REVIEWER_NOTE: Record<Reviewer, string> = { codex: `${HOW_IT_RUNS.codex}\n\n${REVIEW_RULES}`, claude: `${HOW_IT_RUNS.claude}\n\n${REVIEW_RULES}` };
/** Claude Code on a machine where its sandbox cannot start (no bubblewrap): it is started in plan mode and runs nothing. */
export const READ_ONLY_NOTE = `You run in plan mode: the sandbox your tests would run in cannot start on this machine, so do not change files and do not run tests, type checks or dependency installs. Verify each claim by reading the code; when something could only be confirmed by running it, say so in a finding, and say in your output that no test was run because the sandbox is unavailable.\n\n${REVIEW_RULES}`;

export const isReviewer = (v: unknown): v is Reviewer => v === "codex" || v === "claude";

/** The instructions a reviewer reads: the review's own, then the note of the runner that reviews (`readOnly`: Claude Code without its sandbox). */
export const reviewPrompt = (instructions: string, runner: Reviewer, readOnly = false) => `${instructions.trimEnd()}\n\n${readOnly ? READ_ONLY_NOTE : REVIEWER_NOTE[runner]}\n`;
