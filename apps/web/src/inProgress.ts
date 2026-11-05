import type { BacklogAction, BacklogItem, BacklogStage, Schedule, TaskStatus, Workspace } from "@switchboard/protocol";
import { jstClock } from "./time.ts";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/** The button a row shows for its stage (#265; in-progress asks for its status, #522); needs-decision rows get none. */
const START: Partial<Record<BacklogStage, [BacklogAction, string]>> = {
  request: ["to-pbi", t(m.toPbi)],
  "needs-tasks": ["to-tasks", t(m.toTasks)],
  ready: ["complete", t(m.implement)],
  "in-progress": ["check", t(m.checkStatus)],
};

/** A PBI waiting for Tasks that already has sub-issues (#1393): decomposed, only not Ready yet. Its sub-issues alone decide, not whether they cover it. */
export const readyPending = (item: BacklogItem) => item.stage === "needs-tasks" && !!item.tasks && item.tasks.total > 0;

/** The row's stage button: the action and its words. A decomposed PBI waiting for Tasks starts the same `to-tasks` as 「Ready にする」 (#1393). */
export function startButton(item: BacklogItem): [BacklogAction, string] | null {
  if (readyPending(item)) return ["to-tasks", t(m.makeReady)];
  return START[item.stage] ?? null;
}

/**
 * The row's second button, 直行で直す (#3691): on the same rows as PBI にする (a request with no PBI, not waiting for a
 * decision), of the meta workspace only (`metaId`; the start refuses another repository's for now).
 */
export function directButton(item: BacklogItem, metaId: string | null): [BacklogAction, string] | null {
  return item.stage === "request" && item.workspaceId === metaId ? ["direct", t(m.direct)] : null;
}

/** A Task's state as the backlog row names it. */
export const TASK_STATUS: Record<TaskStatus, string> = { idle: t(m.statusIdle), running: t(m.running), waiting: t(m.statusWaiting), done: t(m.statusDone), error: t(m.statusFailed), aborted: t(m.statusAborted) };

/**
 * Whether an in-progress item is moving (#522), from the item's own values only: the first that holds of a running
 * stage Task, the last stage Task waiting for the person's reply (the item's `replyWaiting`, #1619), every Task done
 * with the PBI still open, the last stage Task failed, no stage Task at all, else how the last one ended. Not stored
 * anywhere; asking why is the 状況を確認 button.
 */
export function inProgressState(item: BacklogItem): { running: boolean; label: string } {
  // the last Task may have started between the two lookups of one read: running / waiting is moving, not "stopped"
  if (item.activeTaskId || item.lastTask?.status === "running" || item.lastTask?.status === "waiting") return { running: true, label: t(m.moving) };
  if (item.replyWaiting) return { running: false, label: t(m.stoppedReply) };
  if (item.tasks && item.tasks.total > 0 && item.tasks.done === item.tasks.total) return { running: false, label: t(m.stoppedAllDone) };
  if (item.lastTask?.status === "error") return { running: false, label: t(m.stoppedFailed) };
  if (!item.lastTask) return { running: false, label: t(m.stoppedNoTask) };
  return { running: false, label: t(m.stoppedLast, { status: TASK_STATUS[item.lastTask.status] }) };
}

/** The status a Task has been in since `statusAt`, in the Task screen's words (its head's badge): idle is 待機 (an idle Task with a time has been waiting since then, a Cloud landing), error is エラー. */
export const SINCE: Record<TaskStatus, string> = { ...TASK_STATUS, idle: t(m.sinceIdle), error: t(m.sinceError) };

/**
 * When a Task started and since when it is in its status, in JST (#2030): `開始 17:03` and `17:40 から完了` (the date too
 * on another day). A reply that runs it again makes `since` that run's start; `started` stays the first.
 */
export function taskTimes(x: { status: TaskStatus; createdAt: number; statusAt: number }, now: number, word = SINCE[x.status]): { started: string; since: string } {
  return { started: t(m.started, { time: jstClock(x.createdAt, now) }), since: t(m.since, { time: jstClock(x.statusAt, now), word }) };
}

/** The Backlog row's last stage Task (#2030): `最後の Task: 完了（17:40 から・開始 16:02）`, in the backlog's words; `返事待ち` for one waiting for the person's reply (#1619). */
export function lastTaskLine(x: { status: TaskStatus; createdAt: number; statusAt: number }, now: number, word = TASK_STATUS[x.status]): string {
  return t(m.lastTask, { word, since: jstClock(x.statusAt, now), started: jstClock(x.createdAt, now) });
}

/** The row's button for its running stage Task: running or waiting, and since when (`承認待ち（17:40 から）`). */
export function activeTaskLine(x: { status: TaskStatus; statusAt: number } | null, now: number): string {
  return x && (x.status === "running" || x.status === "waiting") ? t(m.activeTask, { status: TASK_STATUS[x.status], time: jstClock(x.statusAt, now) }) : t(m.running);
}

/** How long ago `at` (ISO string or epoch ms) was: N 分前 under an hour, N 時間前 under a day, else N 日前. */
export function ago(at: string | number, now: number): string {
  const min = Math.max(0, Math.floor((now - (typeof at === "number" ? at : Date.parse(at))) / 60_000));
  if (min < 60) return t(m.agoMin, { n: min });
  if (min < 24 * 60) return t(m.agoHour, { n: Math.floor(min / 60) });
  return t(m.agoDay, { n: Math.floor(min / (24 * 60)) });
}

type Wait = BacklogItem["waits"][number];

const WAIT_STATE: Record<Wait["state"], string> = { met: t(m.waitMet), pending: t(m.waitPending), missing: t(m.waitMissing), withdrawn: t(m.waitWithdrawn), cycle: t(m.waitCycle), unknown: t(m.waitUnknown) };

/**
 * One wait as a row names it (#817, #1046): `PR #n` / `#n` and its state; not read is said, not guessed. A PR closed
 * unmerged or an Issue closed as not planned is 取り下げ, not 完了 (#937).
 */
export function waitRef(w: Wait): { ref: string; state: string } {
  return { ref: `${w.kind === "pr" ? "PR " : ""}#${w.number}`, state: WAIT_STATE[w.state] };
}

/**
 * Whether backlog-next goes on by itself in each workspace (#2656): an enabled バックログを進める and the workspace's own
 * implement slot above 0. Workspace id → that; a workspace not listed is not.
 */
export function autoByWorkspace(schedules: Schedule[], workspaces: Workspace[]): Record<string, boolean> {
  const on = schedules.some((s) => s.action === "backlog-next" && s.enabled);
  return Object.fromEntries(workspaces.map((w) => [w.id, on && w.sweep.implement > 0]));
}

/** Where a wait is on GitHub: the row's repository, `/pull/<n>` or `/issues/<n>` (an Issue URL reaches a PR too). */
export const waitUrl = (item: BacklogItem, w: Wait) => item.url.replace(/\/issues\/\d+$/, `/${w.kind === "pr" ? "pull" : "issues"}/${w.number}`);

/**
 * What a Ready / in-progress row waits for (#817, #1046): 待ち while one is open or not read, 待ちが解けた once all are
 * closed; `cond` = how it comes undone, by why it waits; `next` = whether backlog-next goes on by itself (`auto`: an
 * enabled バックログを進める with an implement slot) or the row's button is needed (also when one was not read). A
 * record whose waits all left (deferred PRs, #817) is 待ちが解けた with none named, as backlog-next and the inbox take it.
 * null = no record.
 */
export function waitText(item: BacklogItem, auto: boolean): { label: string; done: boolean; cond: string; next: string } | null {
  if (item.waitsAt === null) return null;
  const done = item.waits.every((w) => w.state === "met");
  const cond = [
    item.waits.some((w) => w.reason === "overlap") ? t(m.condOverlap) : null,
    item.waits.some((w) => w.reason === "prerequisite") ? t(m.condPrereq) : null,
    item.waits.some((w) => w.state === "missing") ? t(m.condMissing) : null,
    item.waits.some((w) => w.state === "withdrawn") ? t(m.condWithdrawn) : null,
  ].filter(Boolean).join(" / ");
  // not read or withdrawn (#937): nothing changes it by itself, so a person looks whatever backlog-next does
  // a Ready row's button starts 実装; an in-progress row's is 状況を確認, which does not resume it
  const byHand = item.stage === "ready" ? t(m.byHandReady) : t(m.byHandPbi, { n: item.number });
  const stuck = [...new Set(item.waits.filter((w) => w.state !== "met" && w.state !== "pending").map((w) => WAIT_STATE[w.state]))];
  // the row's prerequisites (#937) hold it too: backlog-next goes on only once they are met
  const held = item.prereqs.filter((p) => p.state !== "met");
  const next = stuck.length
    ? t(m.nextStuck, { states: stuck.join(t(m.listDot)), byHand })
    : held.some((p) => p.state !== "pending")
      ? t(m.nextHeld, { byHand })
      : !auto
        ? t(m.nextOff, { byHand })
        : held.length
          ? t(m.nextPrereq)
          : t(m.nextWait);
  return { label: done ? t(m.waitCleared) : t(m.waiting), done, cond, next };
}

/**
 * The waits behind a row's waits (#1046), one step each: an Issue still open or not read whose parent PBI (`pbi` when it is not the Issue itself, #1183) is in the
 * backlog with waits of its own gives that PBI and its waits, followed in turn; one with no parent, or a parent not in
 * the list, gives `parent: null` (先は未取得 — not guessed). Only open Issues are followed. A PBI already passed is not followed again (a cycle).
 */
export function waitChain(item: BacklogItem, items: BacklogItem[]): Array<{ depth: number; via: Wait; parent: BacklogItem | null }> {
  const steps: Array<{ depth: number; via: Wait; parent: BacklogItem | null }> = [];
  const seen = new Set([item.number]);
  const walk = (waits: Wait[], depth: number) => {
    for (const w of waits) {
      // closed: nothing behind it; not read: the row already says so
      if (w.kind !== "issue" || w.open !== true) continue;
      // an Issue's parent only (#1183's `pbi` is the Issue itself for a PBI, which the chain does not follow: #937)
      const of = w.pbi && w.pbi.number !== w.number ? w.pbi.number : null;
      const parent = of === null ? undefined : items.find((i) => i.workspaceId === item.workspaceId && i.number === of);
      if (!parent) {
        steps.push({ depth, via: w, parent: null });
        continue;
      }
      if (seen.has(parent.number) || parent.waits.length === 0) continue;
      seen.add(parent.number);
      steps.push({ depth, via: w, parent });
      walk(parent.waits, depth + 1);
    }
  };
  walk(item.waits, 0);
  return steps;
}

/**
 * Who moves a wait forward (#1045): the PBI behind it (`w.pbi`, #1183) and that PBI's stage Task, read from the PBI's
 * own item in the same list — not asked for apart. null = the PBI is not known (不明). `task`: running = it moves (only
 * opened), stopped = how its last one ended, null = it has none, "unknown" = the PBI is not in the list (closed, or
 * not a backlog item). `startable` = a wait not closed yet whose PBI is Ready / in progress with nothing running, which
 * 続きを始める starts (`complete`); a closed wait still names its PBI and Task.
 */
export function waitOwner(w: Wait, row: BacklogItem, items: BacklogItem[]): { pbi: { number: number; title: string; url: string }; task: { id: string; running: boolean; label: string } | null | "unknown"; startable: boolean } | null {
  if (w.pbi === null) return null;
  const n = w.pbi.number;
  const owner = items.find((i) => i.workspaceId === row.workspaceId && i.number === n);
  const pbi = { number: n, title: owner?.title ?? w.pbi.title ?? "", url: row.url.replace(/\/issues\/\d+$/, `/issues/${n}`) };
  if (!owner) return { pbi, task: "unknown", startable: false };
  const last = owner.lastTask;
  // the last Task may have started between the two lookups of one read: running / waiting is moving (inProgressState)
  const running = owner.activeTaskId ?? (last && (last.status === "running" || last.status === "waiting") ? last.id : null);
  const task = running ? { id: running, running: true, label: t(m.moving) } : last ? { id: last.id, running: false, label: t(m.stoppedStatus, { status: TASK_STATUS[last.status] }) } : null;
  return { pbi, task, startable: w.open !== false && !running && (owner.stage === "ready" || owner.stage === "in-progress") };
}

/** One prerequisite as a row names it (#937): its link, and what follows the number (`（未完）` / ` 取り下げ`). */
export interface PrereqPart { ref: string; url: string; after: string; via: number | null; viaUrl: string | null }

/**
 * A Ready / in-progress row's prerequisites (#937, `item.prereqs`), in two lines: `waiting` = not done yet, which
 * backlog-next waits for by itself (前提: #12（未完）・PR #34（マージ待ち）・PR #56（リリース待ち）); `stuck` = what a person
 * has to fix (進められない: #12 取り下げ・#99 見つからない・#9 と循環・PR #56 の反映を確かめられない). `via` = the Task that
 * names it. Waits recorded by a release (`waits`) stay in their own line (waitText).
 */
export function prereqLine(item: BacklogItem): { waiting: PrereqPart[]; stuck: PrereqPart[] } {
  const at = (n: number, pr = false) => item.url.replace(/\/issues\/\d+$/, `/${pr ? "pull" : "issues"}/${n}`);
  const part = (p: BacklogItem["prereqs"][number], after: string): PrereqPart => ({
    ref: `${p.kind === "pr" ? "PR " : ""}#${p.number}`, url: at(p.number, p.kind === "pr"), after, via: p.via, viaUrl: p.via === null ? null : at(p.via),
  });
  const waiting = item.prereqs.filter((p) => p.state === "pending").map((p) => part(p, p.need === "release" ? t(m.prereqRelease) : p.kind === "pr" ? t(m.prereqMerge) : t(m.prereqOpen)));
  const stuck = item.prereqs.filter((p) => p.state !== "met" && p.state !== "pending").map((p) =>
    part(p, p.state === "withdrawn" ? t(m.stuckWithdrawn) : p.state === "missing" ? t(m.stuckMissing) : p.state === "cycle" ? t(m.stuckCycle) : p.need === "release" ? t(m.stuckRelease) : t(m.stuckUnknown)),
  );
  return { waiting, stuck };
}

/** One side of an overlap as a row names it (#1044): its link (`PR #n` → /pull/n, `Task #m` → /issues/m) and the path. */
export interface OverlapPart { ref: string; url: string; path: string }

/**
 * A Ready / in-progress row's overlap with other work (#1044, `item.overlap`): the PRs / Tasks whose files its Tasks name
 * (`hits`; backlog-next leaves the row, the button still starts it) and why it cannot be judged (`unknown`). null = none.
 */
export function overlapLine(item: BacklogItem): { hits: OverlapPart[]; unknown: string | null } | null {
  const o = item.overlap;
  if (!o || (!o.hits.length && o.unknown === null)) return null;
  const at = (ref: string) => {
    const n = /#(\d+)$/.exec(ref)?.[1] ?? "";
    return item.url.replace(/\/issues\/\d+$/, `/${ref.startsWith("PR") ? "pull" : "issues"}/${n}`);
  };
  return { hits: o.hits.map((h) => ({ ref: h.ref, url: at(h.ref), path: h.path })), unknown: o.unknown };
}
