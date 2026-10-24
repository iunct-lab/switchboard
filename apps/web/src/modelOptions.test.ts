import { describe, expect, test } from "bun:test";
import { modelOptions } from "./modelOptions.ts";

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
