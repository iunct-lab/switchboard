/**
 * The comparison round of a review that does not converge: the reviewer reads each finding still standing one at a time
 * against the default branch and says whether the change made it worse. The instruction (`comparePrompt`) and the reader of
 * its output (`parseCompared`, `checkCompared`) are here, in one file, so the shape of a line is written once.
 */
export const COMPARE_CLASSES = ["REGRESSION", "NEW-FEATURE-GAP", "IMPROVED-BUT-INCOMPLETE", "SAME", "OWNER-DECIDED"] as const;
export type CompareClass = (typeof COMPARE_CLASSES)[number];

const DEFINITIONS: Record<CompareClass, string> = {
  REGRESSION: "main handles the input or state correctly, and HEAD does not. There is a concrete input or state that worked on main and no longer works.",
  "NEW-FEATURE-GAP": "main has no such feature at all; the gap is in something this change adds.",
  "IMPROVED-BUT-INCOMPLETE": "main was missing more than HEAD is: HEAD covers more cases than main and still leaves some out.",
  SAME: "main has the same problem in the same way.",
  "OWNER-DECIDED": "the owner's decision, or the PBI's acceptance criteria or decision log, set it so.",
};

export const COMPARE_HEADING = "### Compared with main";
export const VERDICT_HEADING = "### Verdict versus main";
const ENDS = ["### Regressions in detail", VERDICT_HEADING, "### Findings"];
const VERDICTS = ["at least as good as main", "worse than main"];

export function comparePrompt(): string {
  return [
    "Compare the findings that still stand with main, one at a time. Do not review the whole change again: this round only classifies.",
    "",
    "Material, in `_review/`: `pr.md` (the PR description), `pbi.md` (the PBI), `latest-review.md` (the output of the latest round), `handled.md` (earlier findings with the replies; it may be missing), `main.txt` (the sha of main to compare with). Read main's version of a file with `git show <sha>:<path>`, the sha being the one in `main.txt`; read HEAD's version in the working tree.",
    "",
    "Take every blocker and should-fix of `latest-review.md` and `handled.md` that the code at HEAD still has. Leave out what you verify is resolved. For each one, read the same place on main and on HEAD, and give it exactly one class:",
    ...COMPARE_CLASSES.map((c) => `- ${c}: ${DEFINITIONS[c]}`),
    "",
    "Do not decide a class by the reply an implementer gave or by the mark an earlier round gave. Decide it from what main and HEAD do with the same input or state.",
    "",
    "Output, and nothing before the first line of the first section:",
    COMPARE_HEADING,
    "One line per finding (write `- none` when no blocker or should-fix still stands):",
    "- <CLASS> `path:line` — <one sentence: the input or state that breaks>. main: <what main does there, with path:line>. HEAD: <what HEAD does, with path:line>. Conditions: <the input or state that makes the difference>.",
    "",
    "### Regressions in detail",
    "For each REGRESSION, one line: what to change so that HEAD is no worse than main. Write `- none` when there is no REGRESSION.",
    "",
    VERDICT_HEADING,
    "One line: `at least as good as main` or `worse than main`, then the reason.",
    "",
    "### Findings",
    "- none",
  ].join("\n");
}

export type ComparedRow = { cls: CompareClass; path: string; line: number; text: string; raw: string };

// a path may hold a space, not a tab or a backtick
const ROW = /^- ([A-Za-z-]+) `([^`\t]+?):(\d+)` — (.+)$/;

/** Reads the `### Compared with main` section: its rows, the lines it cannot read, and the verdict line if present. */
export function parseCompared(text: string): { rows: ComparedRow[]; bad: string[]; verdict: string | null } {
  const lines = text.split("\n").map((l) => l.trimEnd());
  // a heading inside a fenced block (an example) is not the section
  // (CommonMark: a fence closes only on the same character, at least as long, with nothing after it)
  let fence = "";
  const start = lines.findIndex((l) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (m && !fence) fence = m[1]!;
    else if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && m[2]!.trim() === "") fence = "";
    return !fence && l === COMPARE_HEADING;
  });
  if (start < 0) return { rows: [], bad: [`no \`${COMPARE_HEADING}\` section`], verdict: null };
  const rows: ComparedRow[] = [];
  const bad: string[] = [];
  for (const l of lines.slice(start + 1)) {
    // the section ends at a heading the prompt asks for; any other heading would hide the rows after it
    if (l.startsWith("### ")) {
      if (!ENDS.includes(l)) bad.push(l);
      break;
    }
    if (l.trim() === "" || l === "- none") continue;
    const m = ROW.exec(l);
    if (!m || !(COMPARE_CLASSES as readonly string[]).includes(m[1]!)) {
      bad.push(l);
      continue;
    }
    rows.push({ cls: m[1] as CompareClass, path: m[2]!, line: Number(m[3]), text: m[4]!, raw: l });
  }
  const at = lines.findIndex((l) => l === VERDICT_HEADING);
  const verdictLine = at < 0 ? undefined : lines.slice(at + 1).find((l) => l.trim() !== "");
  const verdict = verdictLine && VERDICTS.some((v) => verdictLine.toLowerCase().includes(v)) ? verdictLine.trim() : null;
  return { rows, bad, verdict };
}

/** exit 1: one regression or more (their lines); 0: none; 2: no section, or a line whose class cannot be read. */
export function checkCompared(text: string): { code: 0 | 1 | 2; lines: string[] } {
  const { rows, bad } = parseCompared(text);
  if (bad.length) return { code: 2, lines: bad.map((b) => `unreadable: ${b}`) };
  const regressions = rows.filter((r) => r.cls === "REGRESSION");
  if (regressions.length) return { code: 1, lines: regressions.map((r) => `- REGRESSION \`${r.path}:${r.line}\` — ${r.text}`) };
  return { code: 0, lines: [] };
}

/** The area a path belongs to: `packages/<name>` and `apps/<name>` are two levels, any other path with a `/` is its top directory, a file at the top is `root`. */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "root";
  return (parts[0] === "packages" || parts[0] === "apps") && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

const MEANING: Partial<Record<CompareClass, string>> = {
  "NEW-FEATURE-GAP": "main has no such feature at all; the gap is in something the change adds",
  "IMPROVED-BUT-INCOMPLETE": "main was missing more than the change is, and the change still leaves some out",
  SAME: "main has the same problem in the same way",
  "OWNER-DECIDED": "the owner's decision, or a PBI's acceptance criteria or decision log, set it so",
};

/** One request body and title per area for the rows that are not a REGRESSION, in area-name order; the same rows give the same groups. */
export function leftoverRequests(rows: ComparedRow[], source: string, today: string): { area: string; title: string; body: string }[] {
  const byArea = new Map<string, ComparedRow[]>();
  for (const r of rows) {
    if (r.cls === "REGRESSION") continue;
    const area = areaOf(r.path);
    byArea.set(area, [...(byArea.get(area) ?? []), r]);
  }
  return [...byArea.keys()].sort().map((area) => {
    const group = byArea.get(area)!;
    const text = group.map((r) => r.raw).join("\n");
    const fence = "`".repeat(Math.max(4, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const classes = COMPARE_CLASSES.filter((c) => group.some((r) => r.cls === c));
    const body = [
      "## 要望",
      "",
      `${fence}text`,
      text,
      fence,
      "",
      "## 出典",
      "- 誰の言葉: エージェント",
      `- いつ: ${today}`,
      `- 経路: ${source}`,
      "",
      "## 添付",
      "なし",
      "",
      "## 派生 PBI",
      "（未作成）",
      "",
      "## 解釈メモ",
      ...classes.map((c) => `- \`${c}\`: ${MEANING[c]}`),
      "- PBI にするとき今のコードで確かめ直す（行はずれる）",
      "",
    ].join("\n");
    return { area, title: `要望: レビューで残った指摘（main と比べて後退でない）— ${area}`, body };
  });
}
