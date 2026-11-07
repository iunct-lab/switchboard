import type { AskAnswer, AskQuestion } from "@switchboard/protocol";

/** What the person gave one question (#3058): the option labels chosen, or the free text of a question without options. */
export interface QuestionChoice {
  labels: string[];
  text: string;
}

/** One question's answer as the card shows it: the labels joined with ", " (one unless multiSelect), or the free text. */
export function answerOf(q: AskQuestion, c: QuestionChoice | undefined): string {
  if (!q.options.length) return c?.text.trim() ?? "";
  const labels = c?.labels ?? [];
  return (q.multiSelect ? labels : labels.slice(0, 1)).join(", ");
}

/**
 * The answer to a question tool's questions for POST /api/asks/answer (`{ kind: "questions" }`, in the order of
 * `questions`), or undefined while any question is unanswered. A question with options takes only its options, one
 * without takes only its free text.
 */
export function answersOf(questions: AskQuestion[], choices: (QuestionChoice | undefined)[]): Extract<AskAnswer, { kind: "questions" }> | undefined {
  const answers: Array<{ choices: string[]; text?: string }> = [];
  for (const [i, q] of questions.entries()) {
    if (!answerOf(q, choices[i])) return undefined;
    answers.push(q.options.length ? { choices: q.multiSelect ? choices[i]!.labels : choices[i]!.labels.slice(0, 1) } : { choices: [], text: choices[i]!.text.trim() });
  }
  return questions.length ? { kind: "questions", answers } : undefined;
}
