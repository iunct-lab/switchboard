/**
 * The instruction of the attacking-side review: a runner other than the implementer reads the diff for the checks that are
 * missing at the entries it changed. One place, printed by `ops-kit review-attack prompt`, so the cross-runner-review skill
 * does not carry a copy. It asks for where a check is missing and what already guards it, never for how to get past it.
 */
export const ATTACK_PROMPT = `You are reviewing a pull request in this repository from the attacking side, with no prior context. Do not assume anything about the author's intent beyond what the files below say. Read, in this order, under \`_review/\`: \`pr.md\` (the PR description), \`task.md\` (the Task issue it closes), \`pbi.md\` (the parent PBI), \`design-rules.md\` (the repository's design rules), \`handled.md\`, \`old-paths.md\` and \`scope.md\` when they exist, then \`diff.patch\`. Then read the surrounding code in the working tree (this checkout is the PR's head branch). Do not install dependencies. Do not skim.

Find every entry the diff changes or adds: an API route, a command, an import of data from outside, a reading of settings or environment, a function that decides (permission, merge, promotion, who may do what). For each entry, follow its callers and callees in the working tree and say which of these checks is missing, where it should be made, and what already guards it:
- authentication: who is the caller, and is that checked at this entry?
- authorization: may this caller do this, to this object?
- destination: is a path, URL, host, repository or id the input names confined to what it should be?
- format: is the input's shape and size checked before it is used, and does an unknown value fail closed?
- the user's approval: does the action need the user's answer, and can anything other than that answer stand in for it?
Also check that a change which makes a rule stricter on one path did not leave the same rule open on a sibling path (another entry, another caller, another spelling of the same input).

Do NOT write attack steps: no list of attack scenarios, no payloads, no full commands to run. Describe the defence side only: which route or function has no check, where one belongs, and what exists today. If you cannot say it without an attack step, say what the missing check is and stop.

Weight each finding by the definitions you are given. Output these sections, in Markdown (and any section the note after this instruction asks for):

### Findings
One line per finding, or the single line \`- none\`:
- [blocker|should-fix|nit|question] \`path:line\` — <one sentence>. Entry: <the route, command, import, setting or function it is reached by>. Missing: <the check that is not there, and where it should be made>. Existing: <the defence that is there today, or "none">.

### Entries read
A list of the entries you followed (one per line, \`path:line\` and what it is), including those where you found nothing missing.

### Verdict
One of \`no missing checks found\`, \`missing checks found\` or \`could not judge\`, with one sentence of why.
`;

export function attackPrompt(): string {
  return ATTACK_PROMPT;
}
