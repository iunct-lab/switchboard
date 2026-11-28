import type { TaskRouting } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { brief as m } from "./i18n/brief.ts";

/**
 * The model the rule table proposed and the model the task was created with, only when they differ. It reads the
 * creation model kept in `routing`, not the task's current model, which a later switch or the id the runner reports
 * rewrites. A task created on the runner's default (no model) is shown as such rather than as a blank.
 */
export function modelSuggestionNote(routing: TaskRouting | null): { suggested: string; actual: string } | null {
  const suggested = routing?.suggestedModel;
  if (!suggested || suggested === routing.chosenModel) return null;
  return { suggested, actual: routing.chosenModel ?? t(m.modelDefault) };
}
