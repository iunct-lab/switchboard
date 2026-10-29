import type { BacklogItem, BacklogStage } from "@switchboard/protocol";

/**
 * How the Backlog screen sorts and narrows its rows (#2695), kept in the browser. Empty arrays = every value; `query`
 * matches a title or a number; `sort` "default" keeps the daemon's order.
 */
export interface BacklogView {
  sort: "default" | "priority" | "updated" | "created" | "points";
  stages: BacklogStage[];
  types: Array<"request" | "pbi">;
  priorities: string[];
  query: string;
}

export const DEFAULT_VIEW: BacklogView = { sort: "default", stages: [], types: [], priorities: [], query: "" };

export const VIEW_KEY = "switchboard.backlog.view";

/** The stage cards in screen order with their headings. */
export const STAGES: Array<[BacklogStage, string]> = [
  ["needs-decision", "判断待ち"],
  ["request", "要望のまま"],
  ["needs-tasks", "分解待ち"],
  ["ready", "Ready"],
  ["in-progress", "実装中"],
];

export const SORTS: Array<[BacklogView["sort"], string]> = [
  ["default", "既定"],
  ["priority", "Priority 順"],
  ["updated", "更新順"],
  ["created", "作成順"],
  ["points", "Story Points 順"],
];

export const TYPES: Array<["request" | "pbi", string]> = [
  ["request", "要望"],
  ["pbi", "PBI"],
];

export const PRIORITIES = ["P0", "P1", "P2", "P3"];

/** P0 → 0 … P3 → 3; null for an unset or unknown value, which sorts last. */
function priorityRank(p: string | null): number | null {
  const m = p ? /^P([0-3])$/.exec(p) : null;
  return m ? Number(m[1]) : null;
}

function time(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** The sort key of a row, smaller first; null = no value, always last. */
function key(sort: BacklogView["sort"], i: BacklogItem): number | null {
  if (sort === "priority") return priorityRank(i.priority);
  if (sort === "updated") return negate(time(i.updatedAt));
  if (sort === "created") return negate(time(i.createdAt));
  if (sort === "points") return negate(i.storyPoints);
  return 0;
}

const negate = (n: number | null) => (n === null ? null : -n);

function matches(i: BacklogItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = /^#?(\d+)$/.exec(q);
  return (n !== null && i.number === Number(n[1])) || i.title.toLowerCase().includes(q);
}

/** The rows that pass every condition of `view`, in its order (a stable sort; rows without the value last). */
export function applyView(items: BacklogItem[], view: BacklogView): BacklogItem[] {
  const shown = items.filter(
    (i) =>
      (view.stages.length === 0 || view.stages.includes(i.stage)) &&
      (view.types.length === 0 || view.types.includes(i.type)) &&
      (view.priorities.length === 0 || (i.priority !== null && view.priorities.includes(i.priority))) &&
      matches(i, view.query),
  );
  if (view.sort === "default") return shown;
  const keyed = shown.map((i) => ({ i, k: key(view.sort, i) }));
  // Array.prototype.sort is stable, so rows with equal keys keep the daemon's order
  keyed.sort((a, b) => (a.k === null ? (b.k === null ? 0 : 1) : b.k === null ? -1 : a.k - b.k));
  return keyed.map((x) => x.i);
}

/** The conditions in effect as one line（「P1, P2 · PBI · Priority 順」）; null when the view is the default. */
export function viewSummary(view: BacklogView): string | null {
  const name = <T extends string>(list: Array<[T, string]>, v: T) => list.find(([k]) => k === v)?.[1] ?? v;
  const parts: string[] = [];
  if (view.stages.length) parts.push(view.stages.map((s) => name(STAGES, s)).join(", "));
  if (view.priorities.length) parts.push(view.priorities.join(", "));
  if (view.types.length) parts.push(view.types.map((t) => name(TYPES, t)).join(", "));
  if (view.query.trim()) parts.push(`「${view.query.trim()}」`);
  if (view.sort !== "default") parts.push(name(SORTS, view.sort));
  return parts.length ? parts.join(" · ") : null;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** The kept view; the default when nothing is kept or what is kept is not a view. */
export function loadView(store: Pick<Storage, "getItem">): BacklogView {
  try {
    const v = JSON.parse(store.getItem(VIEW_KEY) ?? "null") as Partial<BacklogView> | null;
    const ok =
      v !== null &&
      typeof v === "object" &&
      SORTS.some(([s]) => s === v.sort) &&
      strings(v.stages) &&
      v.stages.every((s) => STAGES.some(([k]) => k === s)) &&
      strings(v.types) &&
      v.types.every((t) => TYPES.some(([k]) => k === t)) &&
      strings(v.priorities) &&
      typeof v.query === "string";
    return ok ? (v as BacklogView) : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

/** Keeps `view`; the default is kept as nothing, so the next load starts from the default too. */
export function saveView(store: Pick<Storage, "setItem" | "removeItem">, view: BacklogView): void {
  if (viewSummary(view) === null) store.removeItem(VIEW_KEY);
  else store.setItem(VIEW_KEY, JSON.stringify(view));
}
