import type { CustomRunner, ModelCandidates, RunnerInfo, Settings, SettingsPatch } from "@switchboard/protocol";
import { req } from "./request.ts";

/**
 * GET / PATCH /api/settings: the saved settings, the runners, and the default of every setting (what the settings screen
 * shows next to a value and what 既定に戻す puts back). `defaults.hiddenModels`: each runner's 載せない list while none is saved.
 */
export type SettingsResponse = Settings & { runners: RunnerInfo[]; defaults: Settings };

/** The calls of this group; `api` (index.ts) holds every group's. */
export const settingsApi = {
  settings: () => req<SettingsResponse>("/api/settings"),
  /** The ADK servers added in Settings; read by the daemon at its next start. */
  customRunners: () => req<CustomRunner[]>("/api/custom-runners"),
  putCustomRunners: (list: CustomRunner[]) => req<CustomRunner[]>("/api/custom-runners", { method: "PUT", body: JSON.stringify(list) }),
  updateSettings: (patch: SettingsPatch) => req<SettingsResponse>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  /** 「CLI の表を読む」: the installed CLIs' models neither listed nor hidden, or why a table could not be read. Reads the tables (the claude executable is about 240 MB), so only on the button. */
  modelCandidates: () => req<ModelCandidates>("/api/settings/model-candidates"),
};
