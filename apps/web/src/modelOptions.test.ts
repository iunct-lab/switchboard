import { describe, expect, test } from "bun:test";
import { modelOptions, taskModelOptions } from "./modelOptions.ts";

const claude = { models: [{ value: "claude-fable-5-1", label: "Fable 5.1" }, { value: "claude-haiku-4-5", label: "Haiku 4.5" }], cliDefaultModel: "haiku" };

describe("modelOptions (#155)", () => {
  test("the first choice is the CLI's default and says what it resolves to; the runner's models follow", () => {
    expect(modelOptions(claude, "")).toEqual([
      { value: "", label: "CLI 既定（haiku）" },
      { value: "claude-fable-5-1", label: "Fable 5.1（claude-fable-5-1）" },
      { value: "claude-haiku-4-5", label: "Haiku 4.5（claude-haiku-4-5）" },
    ]);
  });

  test("a CLI default that is not known is not guessed", () => {
    expect(modelOptions({ models: claude.models }, "")[0]).toEqual({ value: "", label: "CLI 既定" });
    expect(modelOptions(undefined, "")).toEqual([{ value: "", label: "CLI 既定" }]);
  });

  test("a current value that is not on the list (typed, or the full id a runner reported) stays selectable; one on the list is not doubled", () => {
    expect(modelOptions(claude, "claude-haiku-4-5-20251001").at(-1)).toEqual({ value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001" });
    expect(modelOptions(claude, "claude-haiku-4-5")).toHaveLength(3);
  });
});

describe("taskModelOptions", () => {
  test("complete task model: 同じ first, then the runner's models; a saved value off the list stays, marked so; one on the list is not doubled", () => {
    expect(taskModelOptions(claude, "")).toEqual([
      { value: "", label: "Task ごと: 同じ" },
      { value: "claude-fable-5-1", label: "Task ごと: Fable 5.1" },
      { value: "claude-haiku-4-5", label: "Task ごと: Haiku 4.5" },
    ]);
    expect(taskModelOptions(claude, "claude-sonnet-5-5").at(-1)).toEqual({ value: "claude-sonnet-5-5", label: "Task ごと: claude-sonnet-5-5（一覧に無い）" });
    expect(taskModelOptions(claude, "claude-haiku-4-5")).toHaveLength(3);
    expect(taskModelOptions(undefined, "")).toEqual([{ value: "", label: "Task ごと: 同じ" }]);
  });
});
