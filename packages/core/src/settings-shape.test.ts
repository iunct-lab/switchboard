import { describe, expect, test } from "bun:test";
import { Settings } from "@switchboard/protocol";

/**
 * A settings row saved before the runners' default model / effort, the judge's and the titles' own effort existed (the
 * parts of a real row that the change touches; the prices and the Workspace values are left out). It must read as it
 * is, and the new fields must come in empty, so nothing already chosen moves. That a Task started by itself from such a
 * row still starts on the runner, model and effort it had is in settings-runners.api.test.ts (it needs the daemon).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SAVED: Record<string, any> = {
  autoStart: {
    runner: "claude",
    model: "claude-opus-5-5",
    effort: "",
    byKind: {
      fix: { runner: "claude", model: "claude-opus-5-5", effort: "" },
      request: { runner: "claude", model: "claude-opus-5-5", effort: "" },
      "to-pbi": { runner: "claude", model: "claude-opus-5-5", effort: "" },
      "to-tasks": { runner: "claude", model: "claude-sonnet-5-5", effort: "" },
      complete: { runner: "claude", model: "claude-opus-5-5", effort: "" },
      check: { runner: "claude", model: "claude-haiku-5-5", effort: "" },
      close: { runner: "claude", model: "claude-haiku-5-5", effort: "" },
    },
    fallback: [],
    fallbackAt: 1,
    completeTaskModel: "claude-sonnet-5-5",
  },
  judge: { enabled: true, runner: "claude", model: "claude-haiku-5-5", recapChars: 12000, laterChars: 4000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 },
  judgeAndChoice: { judgeFallbackRunner: "codex", judgeFallbackModel: "gpt-6-luna", judgeTimeoutMs: 60000, workspaceChoiceTimeoutMs: 60000 },
  routing: { llm: { enabled: false, runner: "claude", model: "claude-haiku-5-5", timeoutMs: 5000 } },
  reviewRunner: "same",
  defaultPermissionMode: {},
  subagentEffort: {},
  autoResume: { claude: true, codex: true },
  models: { claude: [{ value: "claude-opus-5-5", label: "Opus 5.5" }, { value: "claude-haiku-5-5", label: "Haiku 5.5" }], codex: [{ value: "gpt-6-luna", label: "GPT-6 Luna" }] },
};

describe("a settings row saved before the runner defaults", () => {
  const s = Settings.parse(SAVED);

  test("every saved value stays as it was; the fields added since come in empty", () => {
    expect(s.autoStart).toMatchObject(SAVED.autoStart);
    expect(s.judge).toEqual({ ...SAVED.judge, effort: "" });
    expect(s.judgeAndChoice).toMatchObject({ ...SAVED.judgeAndChoice, judgeFallbackEffort: "" });
    expect(s.routing.llm).toEqual({ ...SAVED.routing.llm, effort: "" });
    expect(s.titles).toEqual({ auto: true, runner: "codex", model: "gpt-6-luna", effort: "" });
    expect(s.newDefaults).toMatchObject({ taskModel: "", taskEffort: "" });
    expect({ reviewRunner: s.reviewRunner, defaultPermissionMode: s.defaultPermissionMode, subagentEffort: s.subagentEffort, autoResume: s.autoResume, models: s.models }).toEqual({ reviewRunner: SAVED.reviewRunner, defaultPermissionMode: SAVED.defaultPermissionMode, subagentEffort: SAVED.subagentEffort, autoResume: SAVED.autoResume, models: SAVED.models });
  });

});
