import type { Settings, SettingsPatch } from "@switchboard/protocol";
import type { settings } from "./i18n/settings.ts";

/**
 * The cards of the Settings screen that hold values with a default, by the key of the card's title in the dictionary,
 * and the values each one shows. A value is a path into the settings: one segment is a whole key, more is one value
 * inside it. This list is the one place that says what a card's 既定に戻す puts back, so a card never resets a value
 * shown on another card (the runner / model / effort of a job are rows of 「どの仕事をどのランナーで」, the Fable budget is
 * in 「予算」). A card that only lists what the user made (the logins, ADK agents, policies, presets, prices, workspaces) has
 * no default and is not here; the block of one runner in 「ランナーごとの既定」 resets by `resetPatch` of runnerSettings.ts.
 */
export const RESETTABLE_CARDS = {
  jobsCard: [
    "autoStart",
    "reviewRunner",
    "recheckRunner",
    "reviewModel",
    "reviewEffort",
    "newDefaults.taskRunner",
    "newDefaults.taskModel",
    "newDefaults.taskEffort",
    "judge.runner",
    "judge.model",
    "judge.effort",
    "judgeAndChoice.judgeFallbackRunner",
    "judgeAndChoice.judgeFallbackModel",
    "judgeAndChoice.judgeFallbackEffort",
    "routing.llm.runner",
    "routing.llm.model",
    "routing.llm.effort",
    "titles.runner",
    "titles.model",
    "titles.effort",
  ],
  shadowDefault: ["shadowRunner"],
  developSelfCard: ["developSelf"],
  sweep: ["maxRunners", "autoDirect", "quotaAndResume.flowShareLimit"],
  usage: ["quotaAndResume.backlogQuotaLimit", "quotaAndResume.retryDelayMs", "quotaAndResume.retryMaxDelayMs", "quotaAndResume.maxLimitStops", "quotaAndResume.resumePrompt", "quotaAndResume.maxStopResumes", "quotaAndResume.thinSample", "quotaAndResume.flowLimit", "quotaAndResume.silentAfterMs", "quotaAndResume.waitLimitMs", "quotaAndResume.queueStallMs", "quotaAndResume.dependsLimitMs"],
  newSchedule: ["newDefaults.scheduleCron"],
  judgeAndChoice: ["judge.enabled", "evals.judge.enabled", "judgeAndChoice.judgeTimeoutMs", "judgeAndChoice.workspaceChoiceTimeoutMs"],
  llm: ["routing.llm.enabled", "routing.llm.timeoutMs"],
  titles: ["titles.auto"],
  budgetCard: ["quotaAndResume.fableBudgetUsd"],
  release: ["release"],
  outbound: ["outbound"],
} satisfies Partial<Record<keyof typeof settings, string[]>>;

export type ResettableCard = keyof typeof RESETTABLE_CARDS;

/**
 * What a card's 既定に戻す sends: null for a whole key (the daemon puts the key back to its default), and for one value
 * inside a key the default itself, read from the answer's `defaults` (the screen keeps no copy of a default).
 */
export function resetCard(card: ResettableCard, defaults: Settings): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const path of RESETTABLE_CARDS[card]) {
    const keys = path.split(".");
    if (keys.length === 1) {
      patch[path] = null;
      continue;
    }
    let from: unknown = defaults;
    let into = patch;
    for (const [i, key] of keys.entries()) {
      from = (from as Record<string, unknown>)[key];
      if (i === keys.length - 1) into[key] = from;
      else into = (into[key] ??= {}) as Record<string, unknown>;
    }
  }
  return patch as SettingsPatch;
}
