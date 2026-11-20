/**
 * The lines of the instruction files (CLAUDE.md, AGENTS.md, skills) that carry the user's mark: a rule the user gave in so
 * many words. A PR that deletes or rewrites one has the owner's rule move, which the merge decision names beside the reason.
 */

/** A line the user's own word made: `YYYY-MM-DD の利用者の指摘` (or 決定, 指示). One form only. */
export const USER_RULE_MARK = /\d{4}-\d{2}-\d{2} の利用者の(指摘|決定|指示)/;

/**
 * The base file's 1-based line numbers that a unified diff of it deletes or rewrites and that carry USER_RULE_MARK. Added
 * lines never count: a line that is only added is not one of the user's rules moving. The hunks are read as designRulesTouched
 * reads them.
 */
export function markedLinesTouched(base: string, patch: string): number[] {
  const lines = base.split("\n");
  const out: number[] = [];
  let old = 0;
  for (const l of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(l);
    if (hunk) {
      old = hunk[2] === "0" ? Number(hunk[1]) + 1 : Number(hunk[1]);
      continue;
    }
    if (l.startsWith("-")) {
      if (USER_RULE_MARK.test(lines[old - 1] ?? "")) out.push(old);
      old++;
    } else if (l.startsWith(" ")) old++;
  }
  return out;
}
