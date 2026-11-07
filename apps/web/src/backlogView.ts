import type { BacklogItem, BacklogStage } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";
import { overlapLine, prereqLine, waitText } from "./inProgress.ts";
import { shownStops, stopDisplay } from "./stops.ts";

/**
 * How the Backlog screen sorts and narrows its rows (#2695), kept in the browser. Empty arrays = every value; `query`
 * matches a title or a number; `sort` "default" keeps the daemon's order. `layout` is how the rows are laid out (#2696:
 * the stage cards, or the stages as the columns of a board; #3957: the backlog queue), not a condition.
 */
export interface BacklogView {
  sort: "default" | "priority" | "updated" | "created" | "points";
  stages: BacklogStage[];
  types: Array<"request" | "pbi">;
  priorities: string[];
  query: string;
  layout: "list" | "board" | "queue";
}

export const DEFAULT_VIEW: BacklogView = { sort: "default", stages: [], types: [], priorities: [], query: "", layout: "list" };

export const VIEW_KEY = "switchboard.backlog.view";

/** The stage cards in screen order with their headings. */
export const STAGES: Array<[BacklogStage, string]> = [
  ["needs-decision", t(common.stageNeedsDecision)],
  ["request", t(common.stageRequest)],
  ["needs-tasks", t(common.stageNeedsTasks)],
  ["ready", "Ready"],
  ["in-progress", t(common.stageInProgress)],
];

export const SORTS: Array<[BacklogView["sort"], string]> = [
  ["default", t(common.sortDefault)],
  ["priority", t(common.sortPriority)],
  ["updated", t(common.sortUpdated)],
  ["created", t(common.sortCreated)],
  ["points", t(common.sortPoints)],
];

export const TYPES: Array<["request" | "pbi", string]> = [
  ["request", t(common.typeRequest)],
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
  if (view.types.length) parts.push(view.types.map((k) => name(TYPES, k)).join(", "));
  if (view.query.trim()) parts.push(t(common.quoted, { text: view.query.trim() }));
  if (view.sort !== "default") parts.push(name(SORTS, view.sort));
  return parts.length ? parts.join(" · ") : null;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** No conditions, the layout kept (元に戻す). */
export function resetView(view: BacklogView): BacklogView {
  return { ...DEFAULT_VIEW, layout: view.layout };
}

/** The kept view; the default when nothing is kept or what is kept is not a view. A missing or unknown layout is the list. */
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
    return ok ? { ...(v as BacklogView), layout: v.layout === "board" || v.layout === "queue" ? v.layout : "list" } : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

/** Keeps `view`; the default is kept as nothing, so the next load starts from the default too. */
export function saveView(store: Pick<Storage, "setItem" | "removeItem">, view: BacklogView): void {
  if (viewSummary(view) === null && view.layout === "list") store.removeItem(VIEW_KEY);
  else store.setItem(VIEW_KEY, JSON.stringify(view));
}

/** A short mark on a board tile (#3707): which of the row's sections the item has, without opening the tile. */
export interface ItemMark {
  key: "waits" | "prereq" | "stuck" | "overlap" | "stops" | "reply";
  label: string;
  warn: boolean;
}

/**
 * The marks of one item, in the order of the list row's sections, each from the function that decides whether the row
 * shows that section (no condition of its own): 待ち (`waitText`, not cleared), 前提待ち / 進められない (`prereqLine`),
 * 重なり (`overlapLine`), 停止 N (`shownStops`; warn when one needs a person) and 返事待ち (the row's last Task line says
 * so: a last Task that is not the running one). A needs-decision item has none: its list card shows none of these.
 */
export function itemMarks(item: BacklogItem, auto: boolean): ItemMark[] {
  if (item.stage === "needs-decision") return [];
  const marks: ItemMark[] = [];
  const wait = waitText(item, auto);
  if (wait && !wait.done) marks.push({ key: "waits", label: t(common.markWaits), warn: false });
  const prereq = prereqLine(item);
  if (prereq.waiting.length) marks.push({ key: "prereq", label: t(common.markPrereq), warn: false });
  if (prereq.stuck.length) marks.push({ key: "stuck", label: t(common.markStuck), warn: true });
  if (overlapLine(item)) marks.push({ key: "overlap", label: t(common.markOverlap), warn: true });
  const stops = shownStops(item.stopSummary);
  if (stops.length) marks.push({ key: "stops", label: t(common.markStops, { n: stops.length }), warn: stops.some((s) => stopDisplay(s).needsPerson) });
  const last = item.lastTask;
  if (item.replyWaiting && last && last.id !== item.activeTaskId) marks.push({ key: "reply", label: t(common.markReply), warn: false });
  return marks;
}
