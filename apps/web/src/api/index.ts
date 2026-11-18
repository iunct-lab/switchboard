/** The screen's calls of the daemon's API, one file per group of paths (as the daemon's routes are grouped); a group is added here in one line. */
import { daemonApi } from "./daemon.ts";
import { knowledgeApi } from "./knowledge.ts";
import { feedbackApi } from "./feedback.ts";
import { artifactsApi } from "./artifacts.ts";
import { tasksApi } from "./tasks.ts";
import { settingsApi } from "./settings.ts";
import { workspacesApi } from "./workspaces.ts";
import { backlogApi } from "./backlog.ts";
import { asksApi } from "./asks.ts";
import { insightsApi } from "./insights.ts";
import { schedulesApi } from "./schedules.ts";
import { presetsApi } from "./presets.ts";
import { historyApi } from "./history.ts";
import { routingApi } from "./routing.ts";
import { ledgerApi } from "./ledger.ts";
import { opsApi } from "./ops.ts";
import { evalsApi } from "./evals.ts";

export const api = {
  ...daemonApi,
  ...knowledgeApi,
  ...feedbackApi,
  ...artifactsApi,
  ...tasksApi,
  ...settingsApi,
  ...workspacesApi,
  ...backlogApi,
  ...asksApi,
  ...insightsApi,
  ...schedulesApi,
  ...presetsApi,
  ...historyApi,
  ...routingApi,
  ...ledgerApi,
  ...opsApi,
  ...evalsApi,
};
