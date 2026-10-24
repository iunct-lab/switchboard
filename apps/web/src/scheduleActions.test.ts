import { expect, test } from "bun:test";
import { SCHEDULE_ACTIONS, scheduleActionLabel } from "./scheduleActions.ts";

test("the four kinds of schedule in the form's order, insights last (#1838); an unknown kind keeps its value", () => {
  expect(SCHEDULE_ACTIONS.map((a) => a.value)).toEqual(["prompt", "backlog-next", "secret-scan", "insights"]);
  expect(scheduleActionLabel("insights")).toBe("Claude Code Insights");
  expect(scheduleActionLabel("backlog-next")).toBe("バックログを進める");
  expect(scheduleActionLabel("secret-scan")).toBe("認証の値の検査");
  expect(scheduleActionLabel("prompt")).toBe("プロンプト");
  expect(scheduleActionLabel("later-kind")).toBe("later-kind");
});
