import type { ModelOption } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";

/**
 * Editing a runner's model choices on the settings screen (#1400). Each edit returns the whole new list, which the
 * screen saves as is (PATCH /api/settings `models`); the daemon checks the same rules again.
 */

/** The list with one model added at the end, the id and label trimmed (an empty label is the id); why it cannot be added otherwise. */
export function addModel(list: ModelOption[], value: string, label: string): ModelOption[] | string {
  const id = value.trim();
  if (!id) return t(common.modelIdMissing);
  if (list.some((m) => m.value === id)) return t(common.modelListed, { id });
  return [...list, { value: id, label: label.trim() || id }];
}

export function removeModel(list: ModelOption[], value: string): ModelOption[] {
  return list.filter((m) => m.value !== value);
}

/** The list with one model moved up (-1) or down (1); at either end the list is unchanged. */
export function moveModel(list: ModelOption[], value: string, dir: -1 | 1): ModelOption[] {
  const i = list.findIndex((m) => m.value === value);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The 載せない list (#1401) with one id added at the end (once); the screen saves the whole list (PATCH `hiddenModels`). */
export function hideModel(hidden: string[], value: string): string[] {
  return hidden.includes(value) ? hidden : [...hidden, value];
}

/** The 載せない list without one id: the next 「CLI の表を読む」 offers it again. */
export function unhideModel(hidden: string[], value: string): string[] {
  return hidden.filter((id) => id !== value);
}
