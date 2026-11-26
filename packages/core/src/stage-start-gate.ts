import type { BacklogEvent, BacklogIssueData, BacklogItem, BacklogPullRequestData } from "@switchboard/protocol";
import { afterTime } from "../../../scripts/parallel-guard.ts";
import { ANSWER_HEADING, type Comment, DECISION_HEADING, isConfirmation } from "./backlog-comments.ts";

/**
 * The one rule for starting a stage Task by itself (the queue, the schedule, the resume after an answer): the same Issue's
 * same stage starts again only when something happened once since the last automatic start. An automatic start is
 * therefore never more often than the things that happened, whatever way a stage Task ended and whatever it wrote.
 */

/** What `eventsOf` reads: the item, the stored Issues and PRs of its workspace, the comments, and when. */
export interface EventsInput {
  item: Pick<BacklogItem, "number" | "waits" | "prereqs" | "waitsUntil">;
  issues: ReadonlyMap<number, Pick<BacklogIssueData, "state" | "createdAt" | "closedAt" | "subIssues">>;
  pulls: readonly Pick<BacklogPullRequestData, "number" | "state" | "closes" | "closedAt" | "mergedAt">[];
  commentsOf: (n: number) => Comment[];
  now: number;
  /** When the running version started (a promotion always restarts the daemon): the time a `（リリース）` prerequisite that is in it counts from. null = not known. */
  runningSince: number | null;
}

/** A `## 回答` that records an acceptance criterion confirmed (issue-workflow 「利用者確認の項目」, the screen's confirmation). */
const isCriterionRecord = (head: string) => head.slice(ANSWER_HEADING.length).trimStart().startsWith("受け入れ条件 ");

const ms = (t: string | null | undefined) => {
  const v = t ? Date.parse(t) : NaN;
  return Number.isNaN(v) ? null : v;
};

/**
 * The one place that lists the events of an item (`BacklogItem.events`). An event is a thing that happened once, that a
 * stage Task cannot make itself and that does not go back; each is dated by when it happened to the world, never by when a
 * stage Task wrote about it, so what a Task writes (comments, claims, a release's `--waits` / `--overlap-waits` / `--after`,
 * the body, labels) makes none. Nothing is judged here. Not in the list on purpose: whether a session works on a PBI and
 * whether a wait is met (a wait on a PBI nobody works on is met the moment it is written, and goes back when someone does).
 *
 * - `sub-added:#n` / `sub-closed:#n`: a Task of the item was made / closed (its `createdAt` / `closedAt`)
 * - `pr:#n`: a PR that closes the item or one of its Tasks was merged or closed (`mergedAt`, else `closedAt`)
 * - `answer:#n@<at>`: the answer to a `## 判断待ち` on the item or one of its Tasks, once per question (when it was written)
 * - `wait-closed:<kind>#n`: what a release's wait or a `**前提**:` line names was closed / merged, as of when that happened
 * - `release:#n`: a `（リリース）` prerequisite is in the running version, as of when it started
 * - `after:<at>`: the date a release waits for (`after=`) has passed, as of that date. A Task that names a date later than
 *   the time it ends has written it before the date, so the gate (`autoStartHeld`) counts a due date only when it is later than
 *   the end of the previous automatic Task; `eventsOf` only leaves out dates still to come
 * - `reviewed:<Task id>` is added where the Task's row is read (backlog-stored.ts `withStageTask`)
 */
export function eventsOf(input: EventsInput): BacklogEvent[] {
  const { item, issues, pulls, commentsOf, now } = input;
  const out = new Map<string, number>();
  const add = (key: string, at: number | null) => {
    if (at !== null) out.set(key, at);
  };
  const subs = issues.get(item.number)?.subIssues ?? [];
  for (const n of subs) {
    const t = issues.get(n);
    if (!t) continue;
    add(`sub-added:#${n}`, ms(t.createdAt));
    if (t.state === "CLOSED") add(`sub-closed:#${n}`, ms(t.closedAt));
  }
  const family = new Set([item.number, ...subs]);
  const closedAt = (p: Pick<BacklogPullRequestData, "state" | "closedAt" | "mergedAt">) => (p.state === "MERGED" ? ms(p.mergedAt) ?? ms(p.closedAt) : p.state === "CLOSED" ? ms(p.closedAt) : null);
  for (const p of pulls) if (p.closes.some((n) => family.has(n))) add(`pr:#${p.number}`, closedAt(p));
  // an answer counts only as the answer to a `## 判断待ち` on its Issue, once per question: a stage Task writes `## 回答`
  // itself too. The first `## 回答` after the question takes it up; one that only confirms the recommendation (the work
  // already went on) takes it up without counting. The record of an acceptance criterion confirmed (its text begins with
  // `受け入れ条件 `, written by a stage Task or the screen) answers no question: it neither counts nor takes one up
  for (const n of family) {
    let asked = false;
    for (const c of [...commentsOf(n)].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
      const head = c.body.trimStart();
      if (head.startsWith(DECISION_HEADING)) asked = true;
      else if (head.startsWith(ANSWER_HEADING) && asked && !isCriterionRecord(head)) {
        asked = false;
        if (!isConfirmation(c.body)) add(`answer:#${n}@${c.createdAt}`, ms(c.createdAt));
      }
    }
  }
  // what was waited for, closed: by the time it closed, so a wait written after it closed dates no later than that
  const named = new Map<number, "issue" | "pr" | null>();
  for (const w of item.waits) named.set(w.number, w.kind);
  for (const p of item.prereqs) if (!named.has(p.number)) named.set(p.number, p.kind);
  for (const [n, kind] of named) {
    const issue = issues.get(n);
    const pull = issue ? undefined : pulls.find((p) => p.number === n);
    if (issue && kind !== "pr" && issue.state === "CLOSED") add(`wait-closed:issue#${n}`, ms(issue.closedAt));
    else if (pull && kind !== "issue") add(`wait-closed:pr#${n}`, closedAt(pull));
  }
  if (input.runningSince !== null) for (const p of item.prereqs) if (p.need === "release" && p.state === "met") add(`release:#${p.number}`, input.runningSince);
  if (item.waitsUntil) {
    const due = afterTime(item.waitsUntil.at);
    if (!Number.isNaN(due) && due <= now) add(`after:${item.waitsUntil.at}`, due);
  }
  return [...out].map(([key, at]) => ({ key, at })).sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** The previous automatic start of the same Issue and stage: when it was made and when it ended (null = still going). */
export interface PreviousAutoStart {
  id: string;
  createdAt: number;
  endedAt: number | null;
}

const kindOf = (e: BacklogEvent) => e.key.split(":")[0];

/**
 * null = may start; otherwise the Task it is held for. Without a previous automatic start nothing is held. An event counts
 * when it is later than that start was made; a due date (`after`) counts only when it is also later than the end of that
 * Task, since a date the Task could name before it ended is a date it wrote itself.
 */
export const autoStartHeld = (events: readonly BacklogEvent[], previous: PreviousAutoStart | null): { previousTaskId: string } | null => {
  if (!previous) return null;
  const counts = (e: BacklogEvent) => e.at > previous.createdAt && (kindOf(e) !== "after" || e.at > (previous.endedAt ?? Infinity));
  return events.some(counts) ? null : { previousTaskId: previous.id };
};
