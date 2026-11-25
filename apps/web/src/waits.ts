import { overWaits, waitOver, type Task, type WaitRecord } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";
import { jstClock } from "./time.ts";

/**
 * What a Task's waits (`Task.waits`, the daemon's list) say in its tag: the list and the Task's header show one wait —
 * the runner's silence first, then a running hook, then one over its limit, then the one whose limit comes first — and the tooltip all of them.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The unit a wait is counted in, by its limit: minutes under two hours, hours under two days, else days. */
function unitOf(limitMs: number): { ms: number; name: string } {
  return limitMs < 2 * HOUR ? { ms: MIN, name: t(m.waitMinutes) } : limitMs < 2 * DAY ? { ms: HOUR, name: t(m.waitHours) } : { ms: DAY, name: t(m.waitDays) };
}

const count = (ms: number, unit: number) => Math.max(0, Math.floor(ms / unit));

/** A command wait whose other side has stood still for more than half of what it is allowed: how long (ms), else null. */
export function stalledFor(w: WaitRecord, now: number): number | null {
  if (w.progressAt == null || w.stallSec == null) return null;
  const still = now - w.progressAt;
  return still > (w.stallSec * 1000) / 2 ? still : null;
}

/** One wait as a line: `待ち: <label> 3 分 / 上限 30 分`; `compact` (the list) leaves the label to the tooltip. */
export function waitLabel(w: WaitRecord, now: number, compact: boolean): string {
  if (w.kind === "output") return t(m.silent, { min: count(now - w.since, MIN) });
  if (w.kind === "hook") return t(m.hookRunning, { min: count(now - w.since, MIN) });
  const unit = unitOf(w.until - w.since);
  const vars = { label: w.label, waited: count(now - w.since, unit.ms), limit: count(w.until - w.since, unit.ms), unit: unit.name };
  const over = waitOver(w, now);
  const text = compact ? t(over ? m.waitOverCompact : m.waitCompact, vars) : t(over ? m.waitOver : m.wait, vars);
  const still = stalledFor(w, now);
  return still === null ? text : `${text}${t(m.waitStalled, { min: count(still, MIN) })}`;
}

/**
 * The wait the tag shows: the runner's silence, else a running hook, else one over its limit, else the one whose limit comes first. The
 * person's own waits (an approval, a question) are shown where they are answered, not here.
 */
export function shownWait(task: Pick<Task, "waits">, now: number): WaitRecord | null {
  // a planned resume within its time has its own tag (when it resumes); past it, it is a wait over its limit like any other
  const waits = (task.waits ?? []).filter((w) => w.kind !== "person" && (w.kind !== "resume" || waitOver(w, now)));
  const byLimit = (a: WaitRecord, b: WaitRecord) => a.until - b.until;
  return waits.find((w) => w.kind === "output") ?? waits.find((w) => w.kind === "hook") ?? overWaits({ waits }, now).sort(byLimit)[0] ?? [...waits].sort(byLimit)[0] ?? null;
}

export interface WaitTagView {
  text: string;
  /** Every wait, a line each; the runner's silence says when its last event was. */
  title: string;
  /** silent = 応答なし, over = past its limit, wait = within it. */
  tone: "silent" | "over" | "wait";
}

/** The tag of a Task's waits, or null when it waits for nothing shown here. */
export function waitTag(task: Pick<Task, "waits">, now: number, compact: boolean): WaitTagView | null {
  const w = shownWait(task, now);
  if (!w) return null;
  const line = (x: WaitRecord) =>
    x.kind === "output"
      ? t(m.silentTitle, { when: jstClock(x.since, now) })
      : x.kind === "hook"
        ? t(m.hookRunningTitle, { name: x.label, since: jstClock(x.since, now), beat: jstClock(x.progressAt ?? x.since, now) })
        : waitLabel(x, now, false);
  const lines = (task.waits ?? []).filter((x) => x.kind !== "person").map(line);
  return { text: waitLabel(w, now, compact), title: lines.join("\n"), tone: w.kind === "output" ? "silent" : w.kind !== "hook" && waitOver(w, now) ? "over" : "wait" };
}
