import { expect, test } from "bun:test";
import { githubBudgetLabel, githubBudgetLow } from "./components/ui.tsx";

test("githubBudgetLabel: what is left, of how much, and when it is back (#549)", () => {
  const now = Date.parse("2026-10-09T11:00:00+09:00");
  const resetsAt = Date.parse("2026-10-09T11:31:00+09:00") / 1000;
  expect(githubBudgetLabel({ remaining: 500, limit: 5000, resetsAt }, now)).toBe(`500 / ${(5000).toLocaleString()} · 11:31 に戻る`);
  // another day: the date too, as every time the UI shows
  expect(githubBudgetLabel({ remaining: 3965, limit: 5000, resetsAt: Date.parse("2026-10-10T00:05:00+09:00") / 1000 }, now)).toBe(`${(3965).toLocaleString()} / ${(5000).toLocaleString()} · 10/10 00:05 に戻る`);
});

test("githubBudgetLow: below 2 tenths left — 999 / 5000 is low, 1000 / 5000 is not", () => {
  expect(githubBudgetLow({ remaining: 999, limit: 5000, resetsAt: 0 })).toBe(true);
  expect(githubBudgetLow({ remaining: 1000, limit: 5000, resetsAt: 0 })).toBe(false);
});
