import { expect, test } from "bun:test";
import { runnerConfigSummary } from "./foreignWorkspace.ts";

test("runner config summary: names the files, and says so when there are none", () => {
  expect(runnerConfigSummary([{ path: ".claude/settings.json" }, { path: "CLAUDE.md" }])).toBe("設定のファイル 2 件: .claude/settings.json、CLAUDE.md");
  expect(runnerConfigSummary([])).toBe("ランナーの設定のファイルはありません");
});
