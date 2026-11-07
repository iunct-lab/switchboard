// test-reads: none
import { describe, expect, test } from "bun:test";
import type { AskQuestion } from "@switchboard/protocol";
import { answerOf, answersOf } from "./questions.ts";

const area: AskQuestion = { header: "Area", question: "どこを直すか", options: [{ label: "web", description: null }, { label: "core", description: "デーモン" }], multiSelect: false };
const extras: AskQuestion = { header: null, question: "何を足すか", options: [{ label: "テスト", description: null }, { label: "文書", description: null }], multiSelect: true };
const note: AskQuestion = { header: null, question: "ほかに", options: [], multiSelect: false };

describe("question tool answers (#3058)", () => {
  test("one question answered of three is not an answer; every one answered is one questions answer, in order", () => {
    const qs = [area, extras, note];
    expect(answersOf(qs, [{ labels: ["core"], text: "" }])).toBeUndefined();
    expect(answersOf(qs, [{ labels: ["core"], text: "" }, { labels: ["テスト", "文書"], text: "" }, { labels: [], text: "  " }])).toBeUndefined();
    expect(answersOf(qs, [{ labels: ["core"], text: "" }, { labels: ["テスト", "文書"], text: "" }, { labels: [], text: " 急ぎで " }])).toEqual({
      kind: "questions",
      answers: [{ choices: ["core"] }, { choices: ["テスト", "文書"] }, { choices: [], text: "急ぎで" }],
    });
  });

  test("a question with options takes its options only (one unless multiSelect); one without takes its free text only", () => {
    expect(answerOf(area, { labels: ["web", "core"], text: "ignored" })).toBe("web");
    expect(answerOf(extras, { labels: ["テスト", "文書"], text: "" })).toBe("テスト, 文書");
    expect(answerOf(area, { labels: [], text: "その他" })).toBe("");
    expect(answerOf(note, { labels: ["x"], text: "自由文" })).toBe("自由文");
    expect(answersOf([], [])).toBeUndefined();
  });
});
