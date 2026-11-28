import { expect, test } from "bun:test";
import type { TaskRouting } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { brief as m } from "./i18n/brief.ts";
import { modelSuggestionNote } from "./routingNote.ts";

const routing = (suggestedModel: string | null, chosenModel: string | null): TaskRouting => ({
  suggested: "claude", ruleId: "status-question", reason: "r", overridden: false, suggestedModel, chosenModel, llm: null,
});

test("a creation model that differs from the suggestion is returned with both values, and the sentence names both", () => {
  const note = modelSuggestionNote(routing("claude-haiku-5-5", "claude-fable-5-2"));
  expect(note).toEqual({ suggested: "claude-haiku-5-5", actual: "claude-fable-5-2" });
  expect(t(m.modelSuggested, note!)).toContain("claude-haiku-5-5");
  expect(t(m.modelSuggested, note!)).toContain("claude-fable-5-2");
});

test("a task created on the runner's default model shows the default wording as the actual", () => {
  expect(modelSuggestionNote(routing("claude-haiku-5-5", null))).toEqual({ suggested: "claude-haiku-5-5", actual: t(m.modelDefault) });
});

test("the same creation model, no suggestion, or no routing gives no note", () => {
  expect(modelSuggestionNote(routing("claude-haiku-5-5", "claude-haiku-5-5"))).toBeNull();
  expect(modelSuggestionNote(routing(null, "claude-fable-5-2"))).toBeNull();
  expect(modelSuggestionNote(null)).toBeNull();
});
