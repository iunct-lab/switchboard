import type { ModelOption } from "@switchboard/protocol";

/**
 * Editing a runner's model choices on the settings screen (#1400). Each edit returns the whole new list, which the
 * screen saves as is (PATCH /api/settings `models`); the daemon checks the same rules again.
 */

/** The list with one model added at the end, the id and label trimmed (an empty label is the id); why it cannot be added otherwise. */
export function addModel(list: ModelOption[], value: string, label: string): ModelOption[] | string {
  const id = value.trim();
  if (!id) return "モデルの id を入れてください";
  if (list.some((m) => m.value === id)) return `${id} は一覧にあります`;
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
