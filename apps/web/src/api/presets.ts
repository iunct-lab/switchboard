import type { Preset, PresetExpandInput, PresetExpansion, PresetInput, PresetList } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const presetsApi = {
  presets: () => req<PresetList>("/api/presets"),
  createPreset: (input: PresetInput) => req<Preset>("/api/presets", { method: "POST", body: JSON.stringify(input) }),
  updatePreset: (id: string, patch: Partial<PresetInput>) => req<Preset>(`/api/presets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePreset: (id: string) => req<{ ok: boolean }>(`/api/presets/${id}`, { method: "DELETE" }),
  expandPreset: (id: string, input: PresetExpandInput) => req<PresetExpansion>(`/api/presets/${id}/expand`, { method: "POST", body: JSON.stringify(input) }),
};
