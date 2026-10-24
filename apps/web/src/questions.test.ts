import { recordingText, skipRecordings, assertRecordings } from "../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { answersOf, questionsOf } from "./questions.ts";

// The input of the recorded ask (packages/adapters/claude/fixtures/ask-user-question.jsonl).
const fixture = recordingText("packages/adapters/claude/fixtures/ask-user-question.jsonl");
const input = JSON.parse(fixture.split("\n")[0] || "null")?.request?.input;

describe("AskUserQuestion card", () => {
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl"))("questions come from the recorded input; other tools and malformed inputs stay a plain permission card", () => {
    assertRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl");
    const qs = questionsOf("AskUserQuestion", input)!;
    expect(qs.map((q) => [q.header, q.multiSelect, q.options.map((o) => o.label)])).toEqual([
      ["Color", false, ["Red", "Blue"]],
      ["Fruits", true, ["Apple", "Banana", "Cherry"]],
    ]);
    expect(questionsOf("Bash", input)).toBeUndefined();
    expect(questionsOf("AskUserQuestion", { questions: "x" })).toBeUndefined();
    expect(questionsOf("AskUserQuestion", { questions: [{ header: "no text" }] })).toBeUndefined();
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl"))("answers are keyed by question text: one label, several joined with ', ', free text as is", () => {
    assertRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl");
    const qs = questionsOf("AskUserQuestion", input)!;
    const [color, fruits] = qs as [(typeof qs)[0], (typeof qs)[0]];
    expect(
      answersOf(qs, [
        { labels: ["Blue"], other: "" },
        { labels: ["Apple", "Cherry"], other: " 梨 " },
      ]),
    ).toEqual({ [color.question]: "Blue", [fruits.question]: "Apple, Cherry, 梨" });
    expect(answersOf(qs, [{ labels: [], other: "緑" }, { labels: ["Banana"], other: "" }])).toEqual({
      [color.question]: "緑",
      [fruits.question]: "Banana",
    });
  });

  test("a question whose text is an Object.prototype key (constructor / __proto__) is unanswered at first and answerable", () => {
    const qs = questionsOf("AskUserQuestion", { questions: [{ question: "constructor", options: [{ label: "A" }] }, { question: "__proto__", options: [] }] })!;
    expect(answersOf(qs, [])).toBeUndefined();
    const answers = answersOf(qs, [{ labels: ["A"], other: "" }, { labels: [], other: "x" }])!;
    expect(JSON.parse(JSON.stringify(answers))).toEqual(JSON.parse('{"constructor":"A","__proto__":"x"}'));
    expect(JSON.stringify(answers)).toBe('{"constructor":"A","__proto__":"x"}');
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl"))("no answers until every question has one", () => {
    assertRecordings("packages/adapters/claude/fixtures/ask-user-question.jsonl");
    const qs = questionsOf("AskUserQuestion", input)!;
    expect(answersOf(qs, [])).toBeUndefined();
    expect(answersOf(qs, [{ labels: ["Red"], other: "" }, { labels: [], other: "  " }])).toBeUndefined();
  });
});
