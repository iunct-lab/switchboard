/** One question of Claude's AskUserQuestion tool as it arrives in `permission.ask.input.questions`. */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** What the user picked for one question: option labels plus the free-text 「その他」 field. */
export interface QuestionChoice {
  labels: string[];
  other: string;
}

/**
 * Questions of a `permission.ask`, or undefined when it is not a question tool (or the input has no usable
 * question) — the card then stays the plain 許可 / 拒否 one.
 */
export function questionsOf(tool: string, input: unknown): AskQuestion[] | undefined {
  if (tool !== "AskUserQuestion") return undefined;
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return undefined;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q.question !== "string" || !q.question) continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o: unknown): o is { label: string; description?: unknown } => !!o && typeof (o as { label?: unknown }).label === "string")
      .map((o: { label: string; description?: unknown }) => ({ label: o.label, description: typeof o.description === "string" ? o.description : undefined }));
    out.push({ question: q.question, header: typeof q.header === "string" ? q.header : undefined, multiSelect: q.multiSelect === true, options });
  }
  return out.length ? out : undefined;
}

/** The answer string of one question: labels (one unless multiSelect) and the free text, joined with ", ". */
export function answerOf(q: AskQuestion, c: QuestionChoice | undefined): string {
  const labels = c?.labels ?? [];
  const parts = [...(q.multiSelect ? labels : labels.slice(0, 1)), c?.other.trim() ?? ""].filter(Boolean);
  return parts.join(", ");
}

/**
 * `answers` for POST /permission, or undefined while any question is still unanswered. `choices` is indexed like
 * `questions`, and the result has no prototype: the question text is the agent's, and a key such as `constructor` or
 * `__proto__` must be an ordinary entry, not an inherited property.
 */
export function answersOf(questions: AskQuestion[], choices: (QuestionChoice | undefined)[]): Record<string, string> | undefined {
  const answers: Record<string, string> = Object.create(null);
  for (const [i, q] of questions.entries()) {
    const a = answerOf(q, choices[i]);
    if (!a) return undefined;
    answers[q.question] = a;
  }
  return answers;
}
