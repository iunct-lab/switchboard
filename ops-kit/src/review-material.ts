/**
 * Material a review is handed besides the diff, made by a command instead of by the runner's memory of a rule:
 *
 * - `handledFindings`: the findings of earlier rounds with the implementer's public replies and triage summaries, so a
 *   later round knows what was said about each. It is information only: no reply is marked as settling its finding,
 *   because whether a finding is settled is read from the code by the reviewer (`REVIEW_RULES` in `review-note.ts`);
 * - the old-assumption list (`oldPathHits` …): the places outside a change that use the words whose meaning the change
 *   touches. The implementer lists them in the PR description, and the same command checks that list for the reviewer.
 *
 * The functions are pure; `cli.ts` gives them what `gh` and `git` print.
 */

/** A PR's inline review comment, as `gh api repos/{owner}/{repo}/pulls/<n>/comments` returns it. */
export interface InlineComment {
  id: number;
  in_reply_to_id?: number | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body: string;
}

/** The heading a triage summary starts with (the review-triage-and-merge skill's template). */
export const TRIAGE_HEADING = "## レビュー対応";
/** The first line of a recheck's summary comment: `[<runner>] recheck <kinds>`. */
const RECHECK_SUMMARY = /^\[[\w-]+\] recheck\b/;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The findings of earlier rounds and what the implementer said about each, as Markdown: every thread that has a reply
 * (the finding, then the replies as they were written), and every triage summary. A reply is quoted, never classified:
 * a reply that says "fixed" and one that says "not fixed" look the same to a pattern, so none of them is given a mark
 * that could stand in for the reviewer's own check of the code. Empty when nothing was replied to yet. For a recheck
 * (`kind`), empty until the PR has an earlier recheck's summary: the first recheck reads the PR with fresh eyes, the
 * later ones are told what was said.
 */
export function handledFindings(inline: InlineComment[], comments: string[], kind: "review" | "recheck"): string {
  if (kind === "recheck" && !comments.some((c) => RECHECK_SUMMARY.test(c))) return "";
  const replies = new Map<number, string[]>();
  for (const c of inline) if (c.in_reply_to_id) replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c.body]);
  const threads = inline
    .filter((c) => !c.in_reply_to_id && replies.has(c.id))
    .flatMap((c) => [`- \`${c.path}:${c.line ?? c.original_line ?? "?"}\` ${oneLine(c.body)}`, ...replies.get(c.id)!.map((r) => `  - reply: ${oneLine(r)}`)]);
  const summaries = comments.filter((c) => c.trimStart().startsWith(TRIAGE_HEADING)).map((c) => c.trim());
  if (!threads.length && !summaries.length) return "";
  return [
    "# Findings of earlier rounds and the implementer's replies",
    "From the pull request's public replies only, quoted as written. This is what the implementer says, not what the code does: no reply here settles its finding. Check each earlier blocker and should-fix in the code as it is now; a triage summary may list the nits left as they are, with the grounds.",
    ...(threads.length ? ["", "## Threads", ...threads] : []),
    ...(summaries.length ? ["", "## Triage summaries", ...summaries.flatMap((s) => [s.replace(/^#+ /gm, (h) => `##${h}`), ""])] : []),
  ]
    .join("\n")
    .trimEnd();
}

/** One line `git grep -n` found. */
export interface Hit {
  path: string;
  line: number;
  text: string;
}

/** The lines a diff adds, by file: the new side of every hunk of `git diff -U0`. Those lines are the change itself, not a place that holds the old assumption. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let cur: Set<number> | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      const path = l.slice(4).replace(/^b\//, "");
      cur = path === "/dev/null" ? null : (out.get(path) ?? out.set(path, new Set()).get(path)!);
      continue;
    }
    const h = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!h || !cur) continue;
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    for (let i = 0; i < count; i++) cur.add(start + i);
  }
  return out;
}

/** The hits of `git grep -n` (`path:line:text`) that are not lines the change adds. */
export function oldPathHits(grep: string, added: Map<string, Set<number>>): Hit[] {
  const out: Hit[] = [];
  for (const l of grep.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    const hit = { path: m[1]!, line: Number(m[2]), text: m[3]!.trim() };
    if (!added.get(hit.path)?.has(hit.line)) out.push(hit);
  }
  return out;
}

/** The item's name in a PR description and in a Task. */
export const OLD_PATHS_ITEM = "古い前提を持つ既存の箇所";
const TEXT_CHARS = 100;
const rowText = (h: Hit) => h.text.slice(0, TEXT_CHARS);

/** The item as the implementer pastes it: the words, then one row per place with the part to fill in. */
export function oldPathsItem(words: string[], hits: Hit[]): string {
  return [
    `- ${OLD_PATHS_ITEM}（語: ${words.map((w) => `\`${w}\``).join(" ")}）:${hits.length ? "" : " 当たる箇所なし"}`,
    ...hits.map((h) => `  - \`${h.path}:${h.line}\` \`${rowText(h)}\` — <新しい道・新しい意味で成り立つか。どう確かめたか>`),
  ].join("\n");
}

/** The item's own line: a list item that starts with its name (a sentence that only mentions the name is not it). */
const itemLine = (body: string) => body.split("\n").find((l) => /^\s*[-*] /.test(l) && l.replace(/^\s*[-*] /, "").startsWith(OLD_PATHS_ITEM));

/**
 * The rows under the item's line: the lines indented deeper than the item line, up to a blank line or a line at the
 * same or a shallower indent. `[]` when there is no item.
 */
function itemRows(body: string): string[] {
  const lines = body.split("\n");
  const line = itemLine(body);
  const at = line === undefined ? -1 : lines.indexOf(line);
  if (at < 0) return [];
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[at]!);
  const rows: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim() || indent(l) <= base) break;
    rows.push(l);
  }
  return rows;
}

/** The words a description's item names; `[]` when the item says none apply (なし), null when there is no item. */
export function oldPathWords(body: string): string[] | null {
  const line = itemLine(body);
  if (line === undefined) return null;
  const words = /（語: (.*?)）/.exec(line)?.[1];
  return words === undefined ? [] : [...words.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

/**
 * The hits the description has no row for. A row is matched by the file and the line's text, not its number: later
 * commits move lines. A row answers for one hit only: a file with the same line twice needs two rows (the second place
 * was looked at too, or it was not). The longer texts take their rows first, so a row is not spent on a hit whose
 * text is only a part of it. Only the item's own rows are counted: the same place written elsewhere in the description
 * does not answer for it.
 */
export function unlistedHits(body: string, hits: Hit[]): Hit[] {
  const rows = itemRows(body);
  const listed = new Set<Hit>();
  for (const h of [...hits].sort((a, b) => rowText(b).length - rowText(a).length)) {
    const at = rows.findIndex((r) => r.includes(`\`${h.path}:`) && r.includes(rowText(h)));
    if (at < 0) continue;
    rows.splice(at, 1);
    listed.add(h);
  }
  return hits.filter((h) => !listed.has(h));
}

const SHOWN = 200;
const shown = (hits: Hit[]) => [...hits.slice(0, SHOWN).map((h) => `- \`${h.path}:${h.line}\` ${rowText(h)}`), ...(hits.length > SHOWN ? [`- (${hits.length - SHOWN} more)`] : [])];

/** What the reviewer reads about the list (`_review/old-paths.md`), and whether the list is complete for its own words. */
export function oldPathsReport(body: string, hitsFor: (words: string[]) => Hit[]): { ok: boolean; text: string } {
  const head = "# Old assumptions: places outside the change that use the words the PR description names";
  const words = oldPathWords(body);
  if (words === null) return { ok: false, text: `${head}\nThe PR description has no \`${OLD_PATHS_ITEM}\` item.` };
  if (!words.length) return { ok: true, text: `${head}\nThe PR description says none apply: ${itemLine(body)!.trim()}` };
  const hits = hitsFor(words);
  const missing = unlistedHits(body, hits);
  return {
    ok: missing.length === 0,
    text: [head, `Words: ${words.map((w) => `\`${w}\``).join(" ")}`, "", `## Places found again with those words, outside the lines the PR adds: ${hits.length}`, ...shown(hits), "", `## Of those, missing from the PR's list: ${missing.length}`, ...shown(missing)].join("\n"),
  };
}
