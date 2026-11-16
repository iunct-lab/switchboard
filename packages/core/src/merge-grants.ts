/** The settings key of the screen answers (their comment operation ids, the newest 200) already read for a stage Task's grants. */
export const MERGE_GRANT_ANSWERS_KEY = "mergeGrantAnswers";

export type MergeGrantKind = "merge" | "answer" | "scope";
export interface MergeGrant {
  kind: MergeGrantKind;
  target: number;
}

// The three fixed sentences a person sends in a task's conversation to let one refused step through.
// A sentence ends its line (a closing full stop is fine); a different verb or a longer clause does not match.
const FORMS: Array<{ kind: MergeGrantKind; re: RegExp }> = [
  { kind: "merge", re: /PR #(\d+) を判定の外でマージしてよい[。.]?\s*$/ },
  { kind: "answer", re: /PR #(\d+) に \[merge-answer\] yes を投稿してよい[。.]?\s*$/ },
  { kind: "scope", re: /Task #(\d+) の本文に名指しのパスを足してよい[。.]?\s*$/ },
];

/** Reads every grant sentence in `text`, one per line; empty when no line is one of the three forms. */
export function parseMergeGrants(text: string): MergeGrant[] {
  const out: MergeGrant[] = [];
  // a question answered with several options carries a grant after each on one line: `… — 許可: <a> — 許可: <b>`
  for (const line of text.split(/\r?\n/).flatMap((l) => l.split(/\s*—\s*許可:\s*/))) {
    for (const f of FORMS) {
      const m = f.re.exec(line);
      if (m) out.push({ kind: f.kind, target: Number(m[1]) });
    }
  }
  return out;
}
