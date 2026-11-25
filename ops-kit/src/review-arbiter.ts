/**
 * The arbiter's single ruling on a review that did not settle by itself: a supervising sub-agent reads the material of the
 * earlier rounds (not the PR again) and, for each finding the implementer's answer was disputed on, says whose side the written
 * rules take. The instruction (`arbiterPrompt`) and the reader of its output (`checkRulings`) are here, in one file, so the shape
 * of a line is written once. Printed by `ops-kit review-arbiter prompt`; checked by `ops-kit review-arbiter check <file>`.
 */
export const RULINGS_HEADING = "### Rulings";
export const VIEWPOINTS_HEADING = "### Viewpoints";

const MATERIAL =
  "Material, in `_review/`: `handled.md` (earlier findings with the implementer's replies), the output of each round of the review, `viewpoints.md` (the viewpoints the review was to look at), `tests/` (the tests the change added), `pbi.md` (the PBI: acceptance criteria, out of scope, decision log), `design-rules.md` (the repository's design rules) and the `docs/design` files that concern the places the findings point at.";

export function arbiterPrompt(followUp: boolean): string {
  return [
    followUp
      ? "You gave a ruling on this review before, and the implementer has pushed fixes after it. This is the second and last round: read only the diff of those fixes (`_review/fix.range-diff`) and the findings you ruled on (`handled.md` and your earlier output). Do not read the pull request again from the start, and do not open findings you did not rule on."
      : "You are the arbiter of a review whose findings the implementer disputed. Rule once. Do not hold a debate, and do not review the pull request again: do not read the whole diff and do not look for new findings.",
    "",
    MATERIAL,
    "",
    "Read only that material; if a point needs the code, read the lines a finding names and no more.",
    "",
    followUp
      ? "For each finding you ruled for the reviewer, read the fix and say whether it does what the ruling asked: write the line as `[fixed]` when it does and keep it `[reviewer]` when it does not. A finding you ruled for the implementer stays that way and gets no line. Copy the `### Viewpoints` section of your earlier output unchanged (this round does not judge viewpoints again)."
      : "1. Viewpoints: for each viewpoint in `viewpoints.md`, say whether the earlier rounds looked at it (`covered`) or not (`missing`). A viewpoint is `covered` only when a round's output names it or a finding or a test shows it was read.",
    followUp ? "" : "2. Rulings: for each finding the implementer's reply disputed (one marked `Repeat of:` in `handled.md`, or one the reviewer raised again), decide by a rule that is written down, never by which side argued better: the README's Design rules, the PBI's acceptance criteria, out of scope and decision log, or a `docs/design` file at the place of the finding. Name the rule as `path:line` or the name of its section. If no written rule supports the reviewer, rule for the implementer and write `none`.",
    "",
    "Output, and nothing before the first line of the first section:",
    RULINGS_HEADING,
    "One line per finding (write `- none` when no finding was disputed):",
    followUp ? "- [fixed|reviewer] `path:line` — rule: <the rule of your earlier ruling>" : "- [implementer|reviewer] `path:line` — rule: <path:line or the name of the section|none>",
    "",
    VIEWPOINTS_HEADING,
    "One line per viewpoint (write `- none` when `viewpoints.md` is empty):",
    "- <viewpoint> — covered|missing",
    "",
    "This ruling is for the record the app keeps of the job; a comment copied to the pull request is for display only.",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export const RULING_ROW = /^- \[(implementer|reviewer|fixed)\] `([^`\t]+?:\d+)` — rule: (.+)$/;
/** A ruling row for the reviewer that names a rule: the finding stands until a follow-up round writes it `[fixed]`. */
export function standsForReviewer(row: string): boolean {
  const m = RULING_ROW.exec(row);
  return !!m && m[1] === "reviewer" && m[3]!.trim().replace(/^`(.*)`$/, "$1").toLowerCase() !== "none";
}

const VIEWPOINT = /^- (.+?) — (covered|missing)$/;

/** Splits the text into the lines of one section (to the next `### ` heading); a heading inside a fence is not one. */
export function section(lines: string[], heading: string): string[] | null {
  let fence = "";
  let start = -1;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (m && !fence) fence = m[1]!;
    else if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && m[2]!.trim() === "") fence = "";
    if (start < 0) {
      if (!fence && l === heading) start = i;
      continue;
    }
    if (!fence && l.startsWith("### ")) break;
    out.push(l);
  }
  return start < 0 ? null : out;
}

/**
 * reviewerSide: rulings for the reviewer that name a rule (a `none` rule, in any case or in backticks, reads as the implementer's
 * side; `fixed` is a reviewer-side ruling the follow-up round found fixed);
 * missing: viewpoints no round looked at; unreadable: a missing section or a line that does not parse.
 */
export function checkRulings(text: string): { reviewerSide: string[]; missing: string[]; unreadable: string[] } {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const reviewerSide: string[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  const rulings = section(lines, RULINGS_HEADING);
  const viewpoints = section(lines, VIEWPOINTS_HEADING);
  if (!rulings) unreadable.push(`no \`${RULINGS_HEADING}\` section`);
  if (!viewpoints) unreadable.push(`no \`${VIEWPOINTS_HEADING}\` section`);
  for (const l of rulings ?? []) {
    if (l.trim() === "" || l === "- none") continue;
    const m = RULING_ROW.exec(l);
    if (!m) unreadable.push(l);
    else if (standsForReviewer(l)) reviewerSide.push(l);
  }
  for (const l of viewpoints ?? []) {
    if (l.trim() === "" || l === "- none") continue;
    const m = VIEWPOINT.exec(l);
    if (!m) unreadable.push(l);
    else if (m[2] === "missing") missing.push(l);
  }
  return { reviewerSide, missing, unreadable };
}
