export type MergeGrantKind = "merge" | "answer" | "scope";
/** One grant sentence as written: `repo` is the repository the sentence itself names, null when it names none (the task's own is meant). */
export interface MergeGrant {
  kind: MergeGrantKind;
  target: number;
  repo: string | null;
}

/**
 * How a grant's text came in, as far as the daemon can tell (a record's `by`). Only OWNER answers a check.
 * - OWNER: the text came the way the web UI sends it — a reply or an answer whose request looked like the screen's
 *   (`screenLook` of server/guards.ts) and named no sending Task. Every route decides it through `grantSource`
 *   (server/task-hooks.ts); an answer to an Issue is marked the screen's by the same rule before a stage's start reads it.
 * - API: a send that named no sending Task and did not look like the screen's (a bare call of the API).
 * - `task:<id>`: the send said it came from that Task (`from`, which `ops-kit task send` always sets).
 * This is advice against mistakes — a forgotten `from`, a text relayed from another Task, a bare call — and not a
 * boundary: the daemon on loopback trusts whoever reaches it, a Task runs as the same user, and it can send the
 * same request the screen sends (or write the record itself). OWNER means "nothing said otherwise", not "the person typed it".
 */
export const OWNER = "owner";

/** Where the release before the grants' table keeps the screen answers it gave grants from, and how many it keeps: read by that release only; this one writes it beside its own record (`recordMergeGrants`, and the grants' migration at every start), so a rollback finds every answer already spent. */
export const USED_ANSWERS_KEY = "mergeGrantAnswers";
export const USED_ANSWERS_KEPT = 200;

export const API = "api";

// The three fixed sentences a person sends in a task's conversation to let one refused step through.
// A sentence ends its line (a closing full stop is fine); a different verb or a longer clause does not match.
// It may start with `<owner/name> の ` to name another repository than the task's.
const REPO = String.raw`(?:(?<![\w./-])([\w.-]+\/[\w.-]+) の )?`;
const BODIES: Array<{ kind: MergeGrantKind; body: string }> = [
  { kind: "merge", body: String.raw`PR #(\d+) を判定の外でマージしてよい` },
  { kind: "answer", body: String.raw`PR #(\d+) に \[merge-answer\] yes を投稿してよい` },
  { kind: "scope", body: String.raw`Task #(\d+) の本文に名指しのパスを足してよい` },
];
const FORMS: Array<{ kind: MergeGrantKind; re: RegExp }> = BODIES.map((f) => ({ kind: f.kind, re: new RegExp(String.raw`${REPO}${f.body}[。.]?\s*$`) }));

/**
 * The fixed sentences a Task wrote anywhere in `text` (a stop's grant, its reply), not only at the end of a line: inside
 * backticks or a longer line too, but not followed by more of a word (`…してよいですか` is a question, not the sentence).
 * A sentence that names another repository (also with the name in backticks, `acme/lib` の PR …), and a quoted line
 * (starting with `>`), are left out.
 */
export function findGrantSentences(text: string): MergeGrant[] {
  const out: MergeGrant[] = [];
  for (const line of text.split(/\r?\n/).filter((l) => !/^\s*>/.test(l))) {
    for (const f of BODIES) {
      for (const m of line.matchAll(new RegExp(String.raw`${REPO}${f.body}(?![\p{L}\p{N}])`, "gu"))) {
        // a repository named just before it in another form (in backticks, with a space) is another repository's too
        if (!m[1] && !/[\w.-]+\/[\w.-]+[`'"」)）*_]*\s*の\s*[`'"「(（*_]*$/.test(line.slice(0, m.index))) out.push({ kind: f.kind, target: Number(m[2]), repo: null });
      }
    }
  }
  return out;
}

/**
 * Reads every grant sentence in `text`, one per line; empty when no line is one of the three forms. A quoted line (one
 * that starts with `>`) is not read: a quote repeats someone's words, it is not a grant given in this text.
 */
export function parseMergeGrants(text: string): MergeGrant[] {
  const out: MergeGrant[] = [];
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*>/.test(l));
  // a question answered with several options carries a grant after each on one line: `… — 許可: <a> — 許可: <b>`
  for (const line of lines.flatMap((l) => l.split(/\s*—\s*許可:\s*/))) {
    for (const f of FORMS) {
      const m = f.re.exec(line);
      if (m) out.push({ kind: f.kind, target: Number(m[2]), repo: m[1] ?? null });
    }
  }
  return out;
}
