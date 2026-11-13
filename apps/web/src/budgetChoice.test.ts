import { expect, test } from "bun:test";
import { continuationPrompt, overBudget } from "./budgetChoice.ts";

test("overBudget: only a Task with a budget that the cost passed (the same cost is not over)", () => {
  expect(overBudget({ budgetUsd: null }, 999)).toBe(false);
  expect(overBudget({ budgetUsd: 150 }, 150)).toBe(false);
  expect(overBudget({ budgetUsd: 150 }, 150.01)).toBe(true);
  expect(overBudget({ budgetUsd: 0.01 }, 0)).toBe(false);
});

test("continuationPrompt: names the old Task's title, id and budget", () => {
  expect(continuationPrompt({ id: "task_abc", title: "長い設計", budgetUsd: 200 }, "ja")).toBe("Task「長い設計」（task_abc）の続き。元の Task は予算 $200 を超えたのでここで続ける。");
  expect(continuationPrompt({ id: "task_abc", title: "Long design", budgetUsd: 200 }, "en")).toBe('Continues Task "Long design" (task_abc). The old Task went over its $200 budget, so the work goes on here.');
});
