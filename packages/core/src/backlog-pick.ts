/**
 * The selection: which item the scheduler starts next in a slot (`pickNext`), and why each of the others is not
 * started — answered or not, stopped, waiting for a reply, held by the flow limit or the allocation, held by the gate — with the
 * lines the screens show for them. Whether a start by itself repeats a previous one is not decided here: stage-start-gate.ts.
 */
import type { BacklogAction, BacklogItem, BacklogStage, WorkspaceMode } from "@switchboard/protocol";
import { FLOW_LIMIT_FIELD, personWait } from "@switchboard/protocol";
import { TERMINAL } from "./task-status.ts";
import type { ProcessDef } from "./process-defs.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_FAILURES_FILE, parseKnownFailures, type KnownFailure } from "../../../ops-kit/src/known-failures.ts";
import { DIRECT_RETURNED_LABEL, chooseProcess, ACTION_FOR_STAGE, type Slot } from "./backlog-item.ts";
import { isOverlapped } from "./backlog-overlap.ts";

/** An entry of the known-failures registry this close to its last day (or past it) puts its Issue's PBIs before Priority. */
export const KNOWN_FAILURE_DUE_DAYS = 1;

/** The Issues of the registry's entries whose `until` (the last day in effect, UTC) is at most `KNOWN_FAILURE_DUE_DAYS` days away, an expired one too. */
export function dueSoonIssues(entries: KnownFailure[], now: number): Set<number> {
  const today = Math.floor(now / 86_400_000);
  return new Set(entries.filter((e) => Date.parse(`${e.until}T00:00:00Z`) / 86_400_000 - today <= KNOWN_FAILURE_DUE_DAYS).map((e) => e.issue));
}

/** `dueSoonIssues` of the registry in a workspace's checkout; an absent or unreadable file is none (picking goes on without the tier). */
export function dueSoonOf(dir: string, now = Date.now()): Set<number> {
  try { return dueSoonIssues(parseKnownFailures(readFileSync(join(dir, KNOWN_FAILURES_FILE), "utf8")), now); } catch { return new Set(); }
}

/** While any usage window of the runner the stage Tasks start on (after 上限のときの代わり) is at or above this, the scheduler starts a stage Task only when none runs anywhere. The default of `quotaAndResume.backlogQuotaLimit`. */
export const QUOTA_LIMIT = 0.8;
/** A usage window of the runner the stage Tasks start on at this has hit its limit: a stage Task would end at once, so the scheduler starts none until it resets. */
export const QUOTA_FULL = 1;

const STAGE_ORDER: BacklogStage[] = ["ready", "needs-tasks", "request"];
const SLOT_STAGES: Record<Slot, BacklogStage[]> = { implement: ["ready"], plan: ["needs-tasks", "request"] };
/** Priority as an order: P0 first, unset last. */
export const priorityRank = (p: string | null) => (p && /^P[0-3]$/.test(p) ? Number(p[1]) : 4);

/**
 * An in-progress PBI answered since its last stage Task finished: its newest ## 回答 (on it or a Task; a Task's open
 * question makes the PBI needs-decision) is newer than when its last stage
 * Task — any stage, a status check too — last changed, which for a finished one is when it finished.
 * So an answer is taken up once. A PBI never started from the backlog has no last stage Task and is left to
 * whoever runs it.
 */
export const isAnswered = (i: BacklogItem) => i.stage === "in-progress" && !!i.answeredAt && !!i.lastTask && Date.parse(i.answeredAt) > i.lastTask.updatedAt;

// TERMINAL, not TURN_ENDED: a Task in `background` is still working, so its item is not stopped. A stop it recorded that
// needs the person still shows on the row (the stop mark and the person's stop rows read the stop records, not the
// status), and a pending tool approval is listed whatever the status. What waits for the background to end: this
// reply-waiting mark (the row says "moving", `activeTaskId`) and a question-tool question (`personWait` counts
// `background` as at work); both show once the Task is `done`.
const isFinished = (t: NonNullable<BacklogItem["lastTask"]>) => TERMINAL.has(t.status);
/** The newest stop series (by `lastAt`) of the item's last stage Task; only that one decides. */
const lastStopOf = (i: BacklogItem) => (i.lastTask ? i.stopSummary.filter((x) => x.work.taskId === i.lastTask!.id).sort((a, b) => b.lastAt - a.lastAt)[0] : undefined);
/**
 * Its last stage Task stopped for a reason and nothing about that stop changed since: an open series (waiting /
 * exhausted) of that Task with no new cause, answer or condition met against its earlier stop, and it stopped before (or
 * ran out of retries, or still waits on a condition). Starting again would stop at the same place and ask the same thing,
 * so an update to the Issue alone — a label, an unrelated comment — does not release it. A new `## 回答` (isAnswered), a
 * wait that closed (isUnblocked), a person's answer to the stop or its condition met do. A stop that waits for the person
 * is not decided here: the Task's outcome is `needs_action` then, and `awaitingReply` holds it. A condition met is read from
 * the item's own waits / prerequisites (`pr#12`, `issue#3`), so it is not waited for in the runner's own report.
 */
export const stopHeld = (i: BacklogItem) => {
  const t = i.lastTask;
  if (!t || !isFinished(t) || releasedByReview(t) || isAnswered(i)) return false;
  // only the stop that came last decides: an older series that stayed the same does not hold back a new cause
  const s = lastStopOf(i);
  if (!s || (s.state !== "waiting" && s.state !== "exhausted")) return false;
  if (s.changes.some((c) => c.kind === "answer" || c.kind === "cause")) return false;
  const metByWait = (key: string) => {
    const m = /^(issue|pr)#(\d+)$/.exec(key);
    return !!m && [...i.waits, ...i.prereqs].some((w) => w.state === "met" && w.number === Number(m[2]) && (w.kind === null || w.kind === m[1]));
  };
  const unmet = s.conditions.filter((c) => !c.met && !metByWait(c.key));
  // a condition met lets it go only when none other still holds it back; a value moving while unmet is not a met one
  if (unmet.length === 0 && (s.changes.some((c) => c.kind === "condition-met") || s.conditions.some((c) => !c.met))) return false;
  return s.count >= 2 || s.state === "exhausted" || unmet.length > 0;
};

/** A request / 分解待ち / Ready item whose last stage Task was this stage's (from a button too). */
const triedThisStage = (i: BacklogItem) => STAGE_ORDER.includes(i.stage) && !!i.lastTask && i.lastTask.action === ACTION_FOR_STAGE[i.stage];

/** A comment was written on the Issue after `since` (ms): `commentedAt` is the newest written time (`BacklogItem.commentedAt`), not the time GitHub saw the Issue change. */
const commentedSince = (i: BacklogItem, since: number) => !!i.commentedAt && Date.parse(i.commentedAt) > since;

/**
 * Something happened on the Issue since its last stage Task ended: a comment was written on it, or a ## 回答 came
 * on one of its Tasks (`answeredAt`, which a child's answer sets without a comment on the parent).
 */
const touchedSince = (i: BacklogItem) => !!i.lastTask && (commentedSince(i, i.lastTask.updatedAt) || (!!i.answeredAt && Date.parse(i.answeredAt) > i.lastTask.updatedAt));

/** The person read the Task that ended asking them and marked it reviewed: that releases the item in every stage. */
const releasedByReview = (t: NonNullable<BacklogItem["lastTask"]>) => t.outcome === "needs_action" && t.reviewedAt !== null;

/**
 * Its last stage Task, finished, waits for the person (`personWait` = needs: approval open, or the outcome `needs_action`, which
 * the Task's stop records set when they are written) and no ## 回答 came since (`answersRead`; for an item whose answers are
 * not read, no comment on the Issue). An operational
 * question is asked in the Task, not on the Issue (CLAUDE.md), so the Issue shows nothing; starting the stage again stops at
 * the same question (two PBIs that asked to merge, and the queue started their 実装 again within a second). A reply resumes
 * the Task (then activeTaskId holds the item), a ## 回答 on the Issue or marking the Task reviewed lets it be picked again;
 * on a Ready or in-progress PBI an unrelated change to the Issue (a label, the Project's Status)
 * does not. The row's
 * `replyWaiting` is the same judgment. A Task in `background` is not finished (`isFinished`), so it never counts here.
 */
export const awaitingReply = (i: BacklogItem) => !!i.lastTask && isFinished(i.lastTask) && personWait(i.lastTask) === "needs" && !(answersRead(i) ? answeredSince(i) : touchedSince(i));
/** A `## 回答` on the Issue since its last stage Task: what lets a Task that waits for the person go (an unrelated update does not). */
const answeredSince = (i: BacklogItem) => !!i.lastTask && !!i.answeredAt && Date.parse(i.answeredAt) > i.lastTask.updatedAt;
/** Items whose `## 回答` is read (`answeredAt`: Ready and in-progress PBIs); for the others (a request, a PBI before Ready) any update to the Issue still lets it go. */
const answersRead = (i: BacklogItem) => i.type === "pbi" && (i.stage === "ready" || i.stage === "in-progress");

export const isReplyWaiting = awaitingReply;

/** The stages a slot's firing picks from: its own, and for the implement slot the in-progress PBIs it resumes or closes. */
const inSlot = (i: BacklogItem, slot: Slot) => SLOT_STAGES[slot].includes(i.stage) || (slot === "implement" && i.stage === "in-progress");

/**
 * The limit on flow-improvement PBIs and how many are in progress. `running` is counted by the caller on the whole
 * workspace backlog (`flowRunning`), not on the candidates it passes (a queue's or a narrow firing's few, the ones already
 * picked taken out), plus what it started from Ready since it read them.
 */
export type FlowLimit = { limit: number; running: number; stopped?: number; counted?: number[] };
/** The limit with the numbers counted against it (`flowCounted`'s, plus what the caller started since) and how many are left out. */
export const flowLimitOf = (limit: number, counted: number[], stopped: number): FlowLimit => ({ limit, running: counted.length, counted, stopped });
/**
 * The flow PBIs in progress that count against the limit: one with a stage Task running, or one backlog-next would
 * go on with (`candidates` without `flow`: a resume, a close, a lifted reply). One it leaves (a reply or decision waited
 * for, a wait on a dependency, the same stop again, held by the gate (`autoHeld`), on hold) is stopped and is not counted.
 * One whose implementation does not start because it touches what other work touches, or the overlap cannot be judged
 * (`isOverlapped`; `pickNext` skips it), is stopped too, unless a stage Task is running on it; a close does not look at
 * the overlap, so it still counts. Once its overlap clears it counts again, so the running ones may then be over the limit
 * for a while: the limit holds back new starts, not resumes.
 * With `order` (the queue's numbers, when the queue has the implementation slot) only the queued ones count, as only
 * those are resumed; a flow PBI outside it counts only while a stage Task runs on it.
 */
export function flowCounted(items: BacklogItem[], order?: number[]): BacklogItem[] {
  const goes = new Set(candidates(items, "implement", order).filter((c) => !(c.action === "complete" && isOverlapped(c.item))).map((c) => c.item));
  // a PBI left with only after-merge checks (`progress.checking`) is a candidate only when an answer or a met wait resumes it
  // (it is never closable): it counts then, and not while it only waits for the checks
  return items.filter((i) => i.flow && i.stage === "in-progress" && (i.activeTaskId || goes.has(i)));
}
/** How many `flowCounted` counts. */
export const flowRunning = (items: BacklogItem[], order?: number[]) => flowCounted(items, order).length;
/** The flow PBIs in progress `flowRunning` does not count. */
export const flowStopped = (items: BacklogItem[], order?: number[]) => items.filter((i) => i.flow && i.stage === "in-progress").length - flowRunning(items, order);
/**
 * With the queue on, the flow PBIs in progress that are not in its order and have no stage Task running: nothing resumes
 * them while the queue has the implementation slot, and `flowRunning(items, order)` does not count them. null = none.
 */
export function flowOutsideQueueLine(items: BacklogItem[], order: number[]): string | null {
  const out = items.filter((i) => i.flow && i.stage === "in-progress" && !i.activeTaskId && !order.includes(i.number));
  return out.length ? `キューに無い実装中: ${out.map((i) => `#${i.number}`).join(" ")}（再開されない。順に足すかは利用者が決める）` : null;
}
/**
 * A Ready flow-improvement PBI (not P0) is left while `limit` or more flow PBIs are in progress. Without a limit
 * nothing is held. An in-progress one is never held here: its resume goes on.
 */
export function flowHeldIn(items: BacklogItem[], slot: Slot, flow?: FlowLimit): BacklogItem[] {
  if (!flow || flow.running < flow.limit) return [];
  return items.filter((i) => i.flow && !i.onHold && i.stage === "ready" && i.priority !== "P0" && inSlot(i, slot) && !i.activeTaskId);
}
/**
 * What a workspace's share of the week holds back from backlog-next: `flowShare` = flow-improvement's part of the spend
 * against its limit; `mode` = the workspace's mode. Only the firing's pick passes it (not a button, the re-read before a
 * start, or the queue).
 */
export type AllocationHold = { flowShare?: { actual: number; limit: number }; mode?: WorkspaceMode };
/** A flow-improvement PBI (not P0) not yet started is left while its part of the spend is at or over the limit. An in-progress one goes on. */
export function flowShareHeldIn(items: BacklogItem[], slot: Slot, hold?: AllocationHold): BacklogItem[] {
  const f = hold?.flowShare;
  if (!f || f.actual < f.limit) return [];
  return items.filter((i) => i.flow && i.priority !== "P0" && SLOT_STAGES[slot].includes(i.stage) && !i.activeTaskId);
}
/** In maintenance mode a PBI not started is left unless its Kind is bug / deps, and a request unless its words are a routine check's. */
export function maintenanceHeldIn(items: BacklogItem[], slot: Slot, hold?: AllocationHold): BacklogItem[] {
  if (hold?.mode !== "maintenance") return [];
  return items.filter((i) => SLOT_STAGES[slot].includes(i.stage) && !i.activeTaskId && (i.type === "pbi" ? i.kind !== "bug" && i.kind !== "deps" : i.requestFrom !== "定期の検査"));
}
/** The report lines for what `flowShareHeldIn` and `maintenanceHeldIn` leave. */
export function allocationHeldLines(items: BacklogItem[], slot: Slot, hold?: AllocationHold): string[] {
  const f = hold?.flowShare;
  const pct = (n: number) => Math.round(n * 100);
  return [
    ...flowShareHeldIn(items, slot, hold).map((i) => `飛ばした: #${i.number}: 自己改善の上限（実績 ${pct(f!.actual)}% / 上限 ${pct(f!.limit)}%）`),
    ...maintenanceHeldIn(items, slot, hold).map((i) => `飛ばした: #${i.number}: メンテのモード（Kind ${i.kind ?? "未設定"}）`),
  ];
}
/**
 * The report line for the flow PBIs `flowHeldIn` leaves; null when none is left. It names the Settings field the limit is
 * changed in and the PBIs counted against it, so the reader can tell which setting holds what and where to change it.
 */
export function flowHeldLine(held: BacklogItem[], { limit, running, stopped, counted }: FlowLimit): string | null {
  if (!held.length) return null;
  const numbers = counted?.length ? `: ${counted.map((n) => `#${n}`).join(" ")}` : "";
  return `開発の流れの PBI は同時 ${limit} 件まで（Settings の「${FLOW_LIMIT_FIELD}」。実装中 ${running} 件${numbers}${stopped ? `、止まっていて数に入れない ${stopped} 件` : ""}）: 待ち ${held.map((i) => `#${i.number}`).join(" ")}`;
}
/** The items of a slot backlog-next leaves because they are on hold; a running stage Task's is not left for that. */
export const onHoldIn = (items: BacklogItem[], slot: Slot) => items.filter((i) => i.onHold && inSlot(i, slot) && !i.activeTaskId);

/** The items of a slot backlog-next leaves because their last stage Task ended asking the person. */
export const replyWaitingIn = (items: BacklogItem[], slot: Slot) =>
  items.filter((i) => inSlot(i, slot) && !i.activeTaskId && !isWaiting(i) && !isUnblocked(i) && awaitingReply(i));

/**
 * The items of a slot a resume reservation holds (the runner's usage limit, the GitHub budget, the disk, or a start queued
 * at the limit): a stage Task is the Issue's running one (dedupe counts it) and has a time to resume at.
 */
export const plannedResumeIn = (items: BacklogItem[], slot: Slot) =>
  items.filter((i) => inSlot(i, slot) && i.activeTaskId !== null && i.activeTaskId === i.lastTask?.id && i.lastTask.resumeAt !== null);

/**
 * The items of a slot backlog-next leaves because a Task holds them with a claim (`claim`: not released, its Task at work or
 * waiting for the person). One a stage Task runs on is its own work, not a claim to wait for, so it is not here.
 */
export const claimedIn = (items: BacklogItem[], slot: Slot) => items.filter((i) => inSlot(i, slot) && i.claim !== null && !i.activeTaskId);

/** The log line for `claimedIn`; null when none. */
export function claimedLine(items: BacklogItem[], slot: Slot): string | null {
  const held = claimedIn(items, slot);
  return held.length ? `占有中: ${held.map((i) => `#${i.number}${i.claim!.taskId ? `（Task ${i.claim!.taskId}）` : ""}`).join(" ")}` : null;
}

/** The log line for `plannedResumeIn`, the time written by `fmt` (server passes `fmtTime` of ratelimit.ts, which the backlog's files do not import: ratelimit.ts imports backlog-gh.ts); null when none. */
export function plannedResumeLine(items: BacklogItem[], slot: Slot, now: number, fmt: (at: number, now: number) => string): string | null {
  const held = plannedResumeIn(items, slot);
  if (!held.length) return null;
  return `再開の予約: ${held.map((i) => `#${i.number}（${fmt(i.lastTask!.resumeAt!, now)} に再開）`).join(" ")}`;
}

/**
 * The in-progress PBIs of the implement slot whose Tasks are all closed and whose only unchecked criteria are the person's
 * checks: backlog-next leaves them to the person. One another line names (waiting, a reply awaited, stopped) or
 * one an answer or a met wait starts again is left out, so no PBI is on two lines nor named as left when it is started.
 */
export const checksOnlyIn = (items: BacklogItem[], slot: Slot) =>
  slot !== "implement"
    ? []
    : items.filter((i) => i.stage === "in-progress" && !i.activeTaskId && i.progress.closableByApi && i.confirmations.length > 0 && !i.progress.checking && !isWaiting(i) && !isAnswered(i) && !isUnblocked(i) && !awaitingReply(i) && !stopHeld(i));

/** The log line for `checksOnlyIn`; null when none. */
export function checksOnlyLine(items: BacklogItem[], slot: Slot): string | null {
  const held = checksOnlyIn(items, slot);
  return held.length ? `利用者確認だけ: ${held.map((i) => `#${i.number}`).join(" ")}` : null;
}

/**
 * The in-progress PBIs of the implement slot that are `checking` (`pbiProgress`: built, Tasks all closed, only after-merge
 * lines unchecked) with no stage Task running: backlog-next starts no 閉じる for them. One an answer or a met wait starts
 * again, or one another line already names (a wait, a reply, a stop), is left out, as for `checksOnlyIn`.
 */
export const checkingIn = (items: BacklogItem[], slot: Slot) =>
  slot !== "implement" ? [] : items.filter((i) => i.stage === "in-progress" && !i.activeTaskId && i.progress.checking && !isWaiting(i) && !isAnswered(i) && !isUnblocked(i) && !awaitingReply(i) && !stopHeld(i));

/** The log line for `checkingIn`; null when none. */
export function checkingLine(items: BacklogItem[], slot: Slot): string | null {
  const held = checkingIn(items, slot);
  return held.length ? `確認中: ${held.map((i) => `#${i.number}`).join(" ")}` : null;
}

/** The items of a slot backlog-next leaves because it stopped the same way again (`stopHeld`). */
export const unchangedIn = (items: BacklogItem[], slot: Slot) => items.filter((i) => inSlot(i, slot) && !i.activeTaskId && !isWaiting(i) && !isUnblocked(i) && stopHeld(i));

/**
 * The items of a slot the gate holds for the previous automatic start (`autoHeld`: nothing happened since it that the gate counts): the one reason the log gives
 * for a held item. A Task running on it or a wait still open names it elsewhere, so it is not here.
 */
export const gateHeldIn = (items: BacklogItem[], slot: Slot) => items.filter((i) => inSlot(i, slot) && !i.activeTaskId && !isWaiting(i) && i.autoHeld !== null);
/** Not one `gateHeldIn` takes: the overlap and the flow-limit lines leave a held item to the gate's line. */
export const notGateHeld = (slot: Slot) => (i: BacklogItem) => !gateHeldIn([i], slot).length;
/** The words of the gate's line: the log names a held item by them only (`#N（前回 <Task id>）` after). */
export const GATE_LINE = "前回の開始から出来事が増えていない";
/**
 * Whether a log line already names held item `i` on the gate's line: by the previous Task the start was held for, or the one
 * the item's `autoHeld` names (the line `leftLines` wrote; a request held both ways may name the other way's). Task ids
 * are unique, so a same-numbered item of another workspace, even one of the same name, is not taken for it.
 */
export const onGateLine = (line: string, i: Pick<BacklogItem, "number" | "autoHeld">, previousTaskId: string) =>
  line.includes(GATE_LINE) && [previousTaskId, i.autoHeld?.previousTaskId].some((id) => !!id && line.includes(`#${i.number}（前回 ${id}）`));

/**
 * A Ready / in-progress PBI with a wait or a prerequisite not met: still open, not read, withdrawn,
 * in a cycle or not judged. backlog-next leaves it; its row's button does not.
 */
const isWaiting = (i: BacklogItem) => i.waits.some((w) => w.state !== "met") || (!!i.waitsUntil && !i.waitsUntil.met) || i.prereqs.some((p) => p.state !== "met");

/**
 * The stages an automatic start of the item can start, as `candidates` chooses: one in progress goes on with 実装 when
 * answered or unblocked, else is closed (閉じる) when its Tasks and checks are done (`closable`, as `candidates` picks 閉じる
 * for it), else 実装 again; a request starts direct or to-pbi by the
 * process definitions (`chooseProcess`), which the item does not carry, so both are named; [] = no stage starts by itself.
 */
export const autoActionsOf = (i: BacklogItem): BacklogAction[] =>
  i.stage === "in-progress" ? [isAnswered(i) || isUnblocked(i) || !i.closable ? "complete" : "close"] : i.stage === "request" ? ["to-pbi", "direct"] : ACTION_FOR_STAGE[i.stage] ? [ACTION_FOR_STAGE[i.stage]!] : [];

/**
 * A Ready / in-progress PBI whose waits closed or became deferred.
 * waitsAt also preserves the resumption trigger when all parked PRs are removed from the current wait list.
 * It stopped with a release that came before its 実装 finished. Taken once: the 実装 it starts is a stage Task started after the waits, which makes them
 * old (backlog-stored.ts withStageTask), and it claims and releases the PBI again.
 */
export const isUnblocked = (i: BacklogItem) => (i.stage === "in-progress" || i.stage === "ready") && i.waitsAt !== null && !isWaiting(i);

/**
 * The items of a slot backlog-next leaves because of their waits and prerequisites, with what holds each:
 * `pending` = not done yet (goes on by itself once done), `stuck` = withdrawn / missing / cycle / unknown (a person has
 * to act).
 */
export const heldIn = (items: BacklogItem[], slot: Slot) =>
  items
    .filter((i) => slot === "implement" && !i.activeTaskId && (i.stage === "ready" || i.stage === "in-progress") && isWaiting(i))
    .map((item) => {
      const held = [...item.waits, ...item.prereqs].filter((x) => x.state !== "met");
      return { item, pending: held.filter((x) => x.state === "pending"), stuck: held.filter((x) => x.state !== "pending") };
    });

/** An in-progress PBI with Tasks left and nothing it waits on: backlog-next resumes it (`complete`). */
const isStalled = (i: BacklogItem) => i.stage === "in-progress" && !!i.tasks && i.tasks.done < i.tasks.total;

/**
 * A PBI the queue does not resume: the gate holds its next automatic start (`autoHeld`: nothing happened since the previous one
 * that the gate counts, whichever way that Task ended), it waits for a reply, or it stopped the same way again (`stopHeld`). A PBI
 * that is unblocked is resumed, so it is not one. `candidates` leaves these out, and so does the place a PBI yielded with on an overlap
 * (backlog-overlap.ts `turnWorks`): a place that nothing resumes would hold the others until a person looks.
 */
export const notResumed = (i: BacklogItem) => !isUnblocked(i) && (awaitingReply(i) || stopHeld(i) || i.autoHeld !== null);

/**
 * The one item backlog-next moves on in a slot: the PBIs to finish first (回答済みの実装中 →
 * 待ちが解けた Ready・実装中 → 閉じられる実装中 → 止まった実装中), then Priority (P0 first, none last), then within one Priority
 * the items not yet worked on at their stage before those worked on, then the stage (Ready → 分解待ち → 要望), then the
 * oldest. Items waiting for a decision or with a running stage Task are left alone. An answered in-progress PBI goes on with 実装
 * (`complete`), not the in-progress button's 状況確認; so does one whose waits all closed.
 * An item worked on at its stage before goes after the items of the same Priority not yet worked on (an answered
 * in-progress PBI still first); whether it starts again is the gate's (stage-start-gate.ts).
 * An item waiting for a PR / Issue still open is left, Ready or in progress.
 * A Ready PBI whose waits all closed takes the same place as such an in-progress one, its stopped Task reviewed or not.
 * Any other in-progress PBI is closed (`close`) when it can be, else resumed (`complete`, `resume: true`).
 * An item the gate holds (`autoHeld`: nothing happened since the previous automatic start, whichever way that Task ended), or
 * whose last stage Task ended asking the person, is left in any stage (`gateHeldIn`, `replyWaitingIn`).
 * An item labelled `on-hold` is left in every slot and stage (`onHoldIn`), and in no other reason's list.
 */
export function pickNext(items: BacklogItem[], slot: Slot, order?: number[], flow?: FlowLimit, defs: ProcessDef[] = [], dueSoon: ReadonlySet<number> = new Set(), hold?: AllocationHold): Picked | null {
  // An 実装 (`complete`) that would touch what other work touches is not started; the next candidate goes instead
  return candidates(items, slot, order, flow, defs, dueSoon, hold).find((c) => !(c.action === "complete" && isOverlapped(c.item))) ?? null;
}

/** The items of the 実装 slot backlog-next leaves for their files overlapping other work, or for that not being judged. */
export const overlapIn = (items: BacklogItem[], slot: Slot, order?: number[], flow?: FlowLimit, hold?: AllocationHold) => candidates(items, slot, order, flow, [], new Set(), hold).filter((c) => c.action === "complete" && isOverlapped(c.item)).map((c) => c.item);

export type Picked = { item: BacklogItem; action: BacklogAction; resume?: true; reason?: string };

/**
 * The items a slot may move on, in the order backlog-next takes them, each with what it would do. With `order` (the
 * backlog queue's numbers) the 実装 slot takes only the items in it, in its order; what holds an item is judged as
 * without it.
 */
function candidates(items: BacklogItem[], slot: Slot, order?: number[], flow?: FlowLimit, defs: ProcessDef[] = [], dueSoon: ReadonlySet<number> = new Set(), hold?: AllocationHold): Picked[] {
  const resumed = (i: BacklogItem) =>
    isAnswered(i) ? -4 : isUnblocked(i) ? -3 : i.stage !== "in-progress" ? null : i.closable ? -2 : isStalled(i) ? -1 : null;
  const first = (i: BacklogItem) => resumed(i) ?? 0;
  const tried = (i: BacklogItem) => (triedThisStage(i) ? 1 : 0);
  // a PBI of (or itself) an Issue a known failure's registry entry names, close to its end, goes before Priority
  const due = (i: BacklogItem) => (dueSoon.has(i.number) || (i.origin !== null && dueSoon.has(i.origin)) ? 0 : 1);
  // A Task that stopped asking, the same stop again or the gate's hold (`notResumed`) leaves the item in any stage (an unblocked one still goes on)
  // a request a direct Task ran on is not made a PBI after it, whatever that Task came to — unless it came back (`direct-returned`);
  // one whose direct Task never started (queued at the limit, then its start cancelled) is picked again
  const flowHeld = new Set([...flowHeldIn(items, slot, flow), ...flowShareHeldIn(items, slot, hold), ...maintenanceHeldIn(items, slot, hold)]);
  const open = items.filter((i) => !i.onHold && !flowHeld.has(i) && !i.activeTaskId && !i.claim && (i.lastTask?.action !== "direct" || !i.lastTask.started || i.labels.includes(DIRECT_RETURNED_LABEL)) && !isWaiting(i) && !notResumed(i) && (SLOT_STAGES[slot].includes(i.stage) || (slot === "implement" && resumed(i) !== null)));
  const queued = order && slot === "implement" ? (i: BacklogItem) => order.indexOf(i.number) : null;
  // The ones to finish first (`resumed`), then the PBIs of a known failure close to its end (`due`), then Priority, then not yet worked on, then the stage, then the oldest;
  // the queue's order instead when there is one
  const ranked = queued ? open.filter((i) => queued(i) >= 0) : open;
  ranked.sort(
    (a, b) =>
      (queued ? queued(a) - queued(b) : 0) ||
      first(a) - first(b) ||
      due(a) - due(b) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      tried(a) - tried(b) ||
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  return ranked.map((item) => {
    const r = resumed(item);
    // a request starts in the candidate its own criteria choose; the reason goes into the Task's provenance
    const chosen = r === null && item.stage === "request" ? chooseProcess(item, defs) : null;
    const action: BacklogAction = r !== null ? autoActionsOf(item)[0]! : chosen ? (chosen.process === "p1-direct" ? "direct" : "to-pbi") : ACTION_FOR_STAGE[item.stage]!;
    return r === -1 ? { item, action, resume: true } : chosen ? { item, action, reason: chosen.reason } : { item, action };
  });
}
