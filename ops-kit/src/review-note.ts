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
  "- nit: anything else. A finding whose Scenario cannot name what breaks is a nit.",
  "- question: it cannot be judged without a fact you do not have.",
  "",
  "Earlier findings. If `_review/handled.md` exists, read it before you write findings: it lists the findings of earlier rounds with the implementer's replies and triage summaries. It is information, not a verdict: a reply never settles a finding by itself, whatever it says. Check each earlier blocker and should-fix again in the code as it is now, and raise it again whenever the code still has the problem. Leave it out only when you have verified in the code that it is resolved, or when you agree — by your own reasoning from the code, not because the reply says so — that it was not a defect. Do not repeat a finding you have verified as resolved. A nit left as it is stays left.",
  "When a blocker or should-fix is about the same decision as an earlier finding whose reply says it was fixed (the same condition to keep, or the same policy: how a failure is treated, what a value means, where a state is kept), even at another line, end its line with ` Repeat of: <path:line of the earlier finding>`.",
  "",
  "Old assumptions. If `_review/old-paths.md` exists, it lists the places outside the change that use the words the PR description names as changed in meaning, found again by a command, and which of them the description's list lacks. For each place, check that it still holds on the new path or with the new meaning; a place that does not is a finding at that line. Search with words of your own as well (the tool that may be missing, an identifier assumed stable, the shape or key of a value) and report places neither list has. A change that adds a new path to an existing flow, or changes what an existing value, record or state means, without that item in its description is a should-fix. When a follow-up's fix changes such a meaning, check the readers of the changed value the same way.",
  "In your output, the section `### Read outside the diff` lists the functions you read that the diff does not touch (`path:function`, one line), so the range that was read is on record.",
].join("\n");

/**
 * The lines added after the review's instructions for the runner that actually reviews: whether it may run anything
 * depends on how that runner is started (Codex in a read-only sandbox, Claude Code in plan mode), then `REVIEW_RULES`.
 * It is added when the review is started, not written into the instructions, because a usage-limit fallback changes the reviewer.
 */
const HOW_IT_RUNS: Record<Reviewer, string> = {
  codex:
    "You run in a read-only sandbox. Do not run commands that write or install anything (tests, type checks, dependency installs). Verify each claim by reading the code; when something could only be confirmed by running it, say so in a finding.",
  claude:
    "You run in plan mode. Do not change files and do not run tests, type checks or dependency installs. Verify each claim by reading the code; when something could only be confirmed by running it, say so in a finding.",
};
export const REVIEWER_NOTE: Record<Reviewer, string> = { codex: `${HOW_IT_RUNS.codex}\n\n${REVIEW_RULES}`, claude: `${HOW_IT_RUNS.claude}\n\n${REVIEW_RULES}` };

export const isReviewer = (v: unknown): v is Reviewer => v === "codex" || v === "claude";

/** The instructions a reviewer reads: the review's own, then the note of the runner that reviews. */
export const reviewPrompt = (instructions: string, runner: Reviewer) => `${instructions.trimEnd()}\n\n${REVIEWER_NOTE[runner]}\n`;
