export type MergeGrantKind = "merge" | "answer";
/** One grant sentence as written: `repo` is the repository the sentence itself names, null when it names none (the task's own is meant). */
export interface MergeGrant {
  kind: MergeGrantKind;
  target: number;
  repo: string | null;
  /** The sentence names a local change of the Task's workspace (`変更 L<n>`), not a PR: its repository is `local:<workspace id>` (`changeRepoOf`). */
  change?: true;
}

/** The repository a grant of a local change is kept under: the change belongs to the workspace, and no repository's PR shares its number. */
export const changeRepoOf = (workspaceId: string): string => `local:${workspaceId}`;

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

// The fixed sentences a person sends in a task's conversation to let one refused step through: `PR #n をマージしてよい`
// records the person's allowing the merge (answer; the gate reads it for its ask reason), `PR #n を判定の外でマージしてよい` lets the merge skip the gate (merge); a change of the
// workspace has the first (`変更 Ln をマージしてよい`). A sentence ends its line (a closing full stop is fine); a different
// verb or a longer clause does not match. A PR's may start with `<owner/name> の ` to name another repository than the task's.
const REPO = String.raw`(?:(?<![\w./-])([\w.-]+\/[\w.-]+) の )?`;
// `whole`: the sentence is everyday wording, so in a person's text it is read only as a whole line (after a list mark);
// with other words before it, a condition among them, the line is left to the reader of the person's own words.
// An Issue's chosen option line (which the Task wrote) reaches this reader as `選択肢: <line>` (`ownParts` of server/asks.ts),
// so it is never a whole line of fixed sentences, and only the sentences read at the end of any line are read from it.
const BODIES: Array<{ kind: MergeGrantKind; body: string; change?: true; whole?: true }> = [
  { kind: "merge", body: String.raw`PR #(\d+) を判定の外でマージしてよい` },
  { kind: "answer", body: String.raw`PR #(\d+) をマージしてよい`, whole: true },
  { kind: "answer", body: String.raw`変更 L(\d+) をマージしてよい`, change: true, whole: true },
];
// a change has no repository to name: its group stays empty so every form reads the number as group 2
const prefixOf = (f: { change?: true }) => (f.change ? "()" : REPO);
const FORMS = BODIES.map((f) => ({ ...f, re: new RegExp(String.raw`${prefixOf(f)}${f.body}[。.]?\s*$`) }));

/** The text before a sentence names a repository (`acme/lib の`, also in backticks or bold): the sentence is that repository's, not the task's own. */
const namesRepoBefore = (before: string): boolean => /[\w.-]+\/[\w.-]+[`'"」)）*_]*\s*の\s*[`'"「(（*_]*$/.test(before);

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
      for (const m of line.matchAll(new RegExp(String.raw`${prefixOf(f)}${f.body}(?![\p{L}\p{N}])`, "gu"))) {
        // a repository named just before it in another form (in backticks, with a space) is another repository's too
        if (!m[1] && !namesRepoBefore(line.slice(0, m.index))) out.push({ kind: f.kind, target: Number(m[2]), repo: null, ...(f.change ? { change: true as const } : {}) });
      }
    }
  }
  return out;
}

/**
 * The heads of the PRs the merge / answer grants of a screen answer name, read once when the answer was taken and kept
 * with the answer's operation: by `grantHeadKey`, null = not read then. The record of the grant reads them and never
 * the PR again; a grant with no head here answers for none.
 */
export type GrantHeads = Record<string, string | null>;
export const grantHeadKey = (repo: string, target: number): string => `${repo.toLowerCase()}#${target}`;
/** `GrantHeads` as kept in an operation's payload: undefined = the operation keeps none; anything that is not a full sha is not read (null). */
export function grantHeadsOf(kept: unknown): GrantHeads | undefined {
  if (kept === undefined) return undefined;
  if (!kept || typeof kept !== "object" || Array.isArray(kept)) return {};
  return Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? v : null]));
}

/** A line that is a fixed sentence of any form, alone on its line (a list mark before it is fine). */
const SENTENCE_LINE = new RegExp(BODIES.map((f) => String.raw`${prefixOf(f)}${f.body}`).map((b) => String.raw`^\s*(?:[-*・]\s+)?${b}[。.]?\s*$`).join("|"));

/**
 * Reads the grant sentences of one message the person sent (a reply, a free answer, a pressed grant, one chosen option's
 * sentence). A quoted line (one that starts with `>`) is not read: a quote repeats someone's words, it is not a grant given
 * in this text; empty lines are not read either.
 * - The two sentences that lift the ask reason are everyday wording, so they are read by letters only when the whole
 *   message is fixed sentences, one to a line: any other word in the message (a condition before or after) leaves the
 *   message to the reader of the person's own words (`noteConsent`).
 * - The merge outside the gate is read at the end of any line, and
 *   after a ` — 許可: ` that a question's answer carries, as they were.
 */
export function parseMergeGrants(text: string): MergeGrant[] {
  const out: MergeGrant[] = [];
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*>/.test(l) && l.trim() !== "");
  const whole = lines.length > 0 && lines.every((l) => SENTENCE_LINE.test(l));
  // a question answered with several options carries a grant after each on one line: `… — 許可: <a> — 許可: <b>`
  for (const line of lines.flatMap((l) => l.split(/\s*—\s*許可:\s*/))) {
    for (const f of FORMS) {
      if (f.whole) continue;
      const m = f.re.exec(line);
      if (m) out.push({ kind: f.kind, target: Number(m[2]), repo: m[1] || null });
    }
  }
  if (whole) {
    for (const line of lines) {
      for (const f of FORMS) {
        if (!f.whole) continue;
        const m = new RegExp(String.raw`^\s*(?:[-*・]\s+)?${prefixOf(f)}${f.body}[。.]?\s*$`).exec(line);
        // a change is the task's own workspace's: one that names another repository first is not read (its form has no place for one)
        if (m) out.push({ kind: f.kind, target: Number(m[2]), repo: m[1] || null, ...(f.change ? { change: true as const } : {}) });
      }
    }
  }
  return out;
}
