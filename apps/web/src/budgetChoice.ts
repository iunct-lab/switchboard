import type { Task } from "@switchboard/protocol";
import { type Lang, lang, t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/** The Task has a budget and its cost passed it: the next turn is refused until the budget goes up (the daemon's `isOverBudget`). */
export function overBudget(task: Pick<Task, "budgetUsd">, costUsd: number): boolean {
  return task.budgetUsd !== null && costUsd > task.budgetUsd;
}

/** The first instruction of the Task that continues an over-budget one: it names the old Task, no summary of the conversation (llm-routing.md). */
export function continuationPrompt(task: Pick<Task, "id" | "title" | "budgetUsd">, l: Lang = lang): string {
  return t(m.budgetContinuationPrompt, { title: task.title, id: task.id, budget: task.budgetUsd ?? "" }, l);
}
