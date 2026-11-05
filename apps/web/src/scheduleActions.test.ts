import { expect, test } from "bun:test";
import { claudeOnlyAction, SCHEDULE_ACTIONS, scheduleActionLabel } from "./scheduleActions.ts";

test("the kinds of schedule in the form's order, approval-window last (#1838, #2046); an unknown kind keeps its value", () => {
  expect(SCHEDULE_ACTIONS.map((a) => a.value)).toEqual(["prompt", "backlog-next", "secret-scan", "insights", "approval-window", "ui-layers"]);
  expect(scheduleActionLabel("ui-layers")).toBe("床・天井・壁の点検");
  expect(scheduleActionLabel("insights")).toBe("Claude Code Insights");
  expect(scheduleActionLabel("backlog-next")).toBe("バックログを進める");
  expect(scheduleActionLabel("secret-scan")).toBe("認証の値の検査");
  expect(scheduleActionLabel("prompt")).toBe("プロンプト");
  expect(scheduleActionLabel("later-kind")).toBe("later-kind");
});

test("insights and ui-layers run on claude only (#3353)", () => {
  expect(SCHEDULE_ACTIONS.map((a) => a.value).filter(claudeOnlyAction)).toEqual(["insights", "ui-layers"]);
});
