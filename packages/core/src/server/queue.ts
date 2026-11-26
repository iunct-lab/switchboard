import { decidesNothing } from "../machine.ts";
import { existsSync } from "node:fs";
import { type BacklogQueue, BacklogAction, type BacklogItem, type Task, type Workspace } from "@switchboard/protocol";
import { noteQueue, pruneClosed, QUEUE_KEY, readQueue } from "../backlog-queue.ts";
import { pickNext, notGateHeld, onGateLine, GATE_LINE, dueSoonOf, isUnblocked, flowCounted, flowHeldIn, flowHeldLine, flowLimitOf, flowStopped, flowOutsideQueueLine, type FlowLimit } from "../backlog-pick.ts";
import { storedIssueHeads, canStartStoredBacklog } from "../backlog-stored.ts";
import { overlapLinesUnder, swapOverlapLines } from "../backlog-overlap.ts";
import { SLOT_OF_ACTION } from "../backlog-item.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { resumeDepends } from "../depends-resume.ts";
import { nextStall, stallHolders } from "../queue-stall.ts";

/**
 * A queued PBI's stored Issue: its title, and whether it is closed; null when not stored. Made once per call that
 * looks up several rows, so a workspace's Issues are read once, not once per row.
 */
export const queuedIssues = (sc: Pick<ServerContext, "db">) => {
  const heads = new Map<string, ReturnType<typeof storedIssueHeads>>();
  return (e: { workspaceId: string; number: number }) => {
    if (!heads.has(e.workspaceId)) heads.set(e.workspaceId, storedIssueHeads(sc.db, { id: e.workspaceId }));
    return heads.get(e.workspaceId)!.get(e.number) ?? null;
  };
};

/** The stored queue without the PBIs whose stored Issue is closed: those go to its `ended`, stored. Read and written at once, no wait between. */
export const prunedQueue = (sc: Pick<ServerContext, "db" | "queuedIssues">): BacklogQueue => {
  const queue = readQueue(sc.db);
  const issueOf = sc.queuedIssues();
  const pruned = pruneClosed(queue, (e) => ((i) => (i?.state === "CLOSED" ? { title: i.title } : null))(issueOf(e)));
  if (pruned !== queue) sc.db.setSetting(QUEUE_KEY, pruned);
  return pruned;
};

/** Called after each PUT of the queue, with the queue before and after: an enabled queue starts what it may. */
export const onQueueSaved = (sc: Pick<ServerContext, "cfg" | "startFromQueue">, before: BacklogQueue, after: BacklogQueue): void => {
  if (after.enabled && !decidesNothing(sc.cfg)) void sc.startFromQueue(before.enabled ? "saved" : "enabled");
};

export const resumeUnblocked = async (sc: Pick<ServerContext, "db" | "withActive" | "storedBacklogReleased" | "scheduler">, wsId: string) => {
  // an enabled backlog queue starts the 実装 slot's PBIs itself
  if (readQueue(sc.db).enabled) return;
  const schedule = sc.db.listSchedules().find((s) => s.action === "backlog-next" && s.enabled);
  const ws = schedule && sc.db.getWorkspace(wsId);
  if (!schedule || !ws) return;
  const numbers = sc.withActive({ fetchedAt: 0, items: (await sc.storedBacklogReleased(ws)).items, errors: [], changes: [], syncs: [] }).items
    .filter((i) => isUnblocked(i) && !i.activeTaskId).map((i) => i.number);
  if (numbers.length) await sc.scheduler.runUnblocked(schedule.id, ws.id, numbers);
};

export const startFromQueue = (sc: Pick<ServerContext, "queueRun" | "queueAgain" | "queueOnce" | "scheduler">, reason: "enabled" | "saved" | "task-end" | "judged" | "job-end" | "import" | "boot"): Promise<void> => {
  if (sc.queueRun) {
    sc.queueAgain = true;
    return sc.queueRun;
  }
  sc.queueRun = (async () => {
    try {
      do {
        sc.queueAgain = false;
        await sc.queueOnce(reason);
      } while (sc.queueAgain);
    } catch (e) {
      sc.scheduler.note(`キュー: 始められない (${reason}): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  })().finally(() => {
    sc.queueRun = null;
  });
  return sc.queueRun;
};

export const queueKey = (_sc: unknown, workspaceId: string, n: number) => `${workspaceId}:${n}`;

/** The queue's PBIs' 実装 Tasks running / waiting (a button's too). */
export const queueRunning = (sc: Pick<ServerContext, "queueKey" | "db">, queue: BacklogQueue) => {
  const queued = new Set(queue.items.map((e) => sc.queueKey(e.workspaceId, e.number)));
  return (
    sc.db.listActiveStageTasks().filter((t) => t.workspaceId && SLOT_OF_ACTION[t.stage!.action] === "implement" && queued.has(sc.queueKey(t.workspaceId, t.stage!.issue))).length
  );
};

/** Why an action of the 実装 slot does not start now: its runner's usage at the limit, as backlog-next's; "" = it may. */
export const queueUsage = (sc: Pick<ServerContext, "decidedRunner" | "autoRunner" | "settings" | "db">, action: BacklogAction): string => {
  const decided = sc.decidedRunner(action);
  const runner = decided ? sc.autoRunner(decided).runner : null;
  if (!runner) return "始めるランナーがない";
  const limit = sc.settings().quotaAndResume.backlogQuotaLimit;
  const hot = sc.db.quotaFor(runner).find((q) => q.utilization >= limit && q.resetsAt * 1000 > Date.now());
  return hot ? `${runner} の使用量 ${hot.window} が ${Math.round(hot.utilization * 100)}%（${Math.round(limit * 100)}% 以上）: 始めない` : "";
};

export const queueOnce = async (sc: Pick<ServerContext, "prunedQueue" | "scheduler" | "db" | "metaWorkspace" | "queueRunning" | "SLOT_ACTIONS" | "queueUsage" | "backlogReads" | "withActive" | "itemsToAdvance" | "leftLines" | "settings" | "queueKey" | "startStage" | "storedBacklogReleased">, reason: string): Promise<void> => {
  const queue = sc.prunedQueue();
  if (!queue.enabled) return;
  const lines: string[] = [];
  // a firing that returns early (empty, at the concurrency, every runner at its usage limit) is not a stall: it ends one
  const finish = (firing: Parameters<typeof nextStall>[1] = { stalled: false, holders: [] }) => {
    sc.scheduler.notes(lines.map((l) => `キュー: ${l} (${reason})`));
    const now = Date.now();
    noteQueue(sc.db, lines, now, nextStall(readQueue(sc.db).stall, firing, now));
  };
  if (!queue.items.length) return (lines.push("キューが空"), finish());
  const meta = sc.metaWorkspace();
  if (!meta) return (lines.push("meta workspace がありません"), finish());
  if (sc.queueRunning(queue) >= queue.concurrency) return (lines.push(`同時に動かす数 ${queue.concurrency} に達している`), finish());
  const usage = sc.SLOT_ACTIONS.map(sc.queueUsage);
  if (usage.every(Boolean)) return (lines.push(...new Set(usage)), finish());
  // each workspace of the queue, as stored, its queued items only
  const read: Array<{ ws: Workspace; items: BacklogItem[]; flowCounted: number[]; flowStopped: number; overlapLines: string[] }> = [];
  for (const id of [...new Set(queue.items.map((e) => e.workspaceId))]) {
    const order = queue.items.filter((e) => e.workspaceId === id).map((e) => e.number);
    const ws = sc.db.getWorkspace(id);
    if (!ws || !existsSync(ws.path)) {
      lines.push(`${ws?.name ?? id}: workspace が無い: ${order.map((n) => `#${n}`).join(" ")}`);
      continue;
    }
    if (!sc.backlogReads(ws)) {
      lines.push(`${ws.name}: Switchboard 自体を開発しない設定なので読まない: ${order.map((n) => `#${n}`).join(" ")}`);
      continue;
    }
    const stored = sc.withActive({ fetchedAt: 0, items: await sc.itemsToAdvance(ws, (l) => lines.push(l)), errors: [], changes: [], syncs: [] }).items;
    const all = stored.filter((i) => order.includes(i.number));
    const missing = order.filter((n) => !all.some((i) => i.number === n));
    if (missing.length) lines.push(`${ws.name}: バックログに無い: ${missing.map((n) => `#${n}`).join(" ")}`);
    const judged = all.map((item) => ({ item, can: canStartStoredBacklog(item) }));
    const conflicted = judged.filter((j) => !j.can.ok);
    if (conflicted.length) lines.push(`${ws.name}: 競合があるので自動では始めない: ${conflicted.map((j) => `#${j.item.number}（${(j.can as { why: string }).why}）`).join(" ")}`);
    const items = judged.filter((j) => j.can.ok).map((j) => j.item);
    const notReady = items.filter((i) => !i.onHold && (i.stage === "needs-tasks" || i.stage === "request" || i.stage === "needs-decision"));
    if (notReady.length) lines.push(`${ws.name}: まだ Ready でない: ${notReady.map((i) => `#${i.number}（${i.stage === "needs-decision" ? "判断待ち" : "Task 分解前"}）`).join(" ")}`);
    // flow PBIs in progress are counted on the whole backlog, but only those the queue resumes (or with a Task running)
    const counted = flowCounted(stored, order).map((i) => i.number);
    const stopped = flowStopped(stored, order);
    const outside = flowOutsideQueueLine(stored, order);
    if (outside) lines.push(`${ws.name}: ${outside}`);
    const left = sc.leftLines(items, "implement", flowLimitOf(sc.settings().quotaAndResume.flowLimit, counted, stopped));
    lines.push(...left.map((l) => `${ws.name}: ${l}`));
    read.push({ ws, items, flowCounted: counted, flowStopped: stopped, overlapLines: overlapLinesUnder(`${ws.name}: `, left) });
  }
  const picked = new Set<string>();
  // flow PBIs started from Ready in this run: still ready in `items`, so counted as in progress here
  const flowStarted = new Set<string>();
  const dueSoonBy = new Map<string, Set<number>>(); // each workspace's registry, read once per firing
  const dueSoon = (ws: Workspace) => dueSoonBy.get(ws.id) ?? (dueSoonBy.set(ws.id, dueSoonOf(ws.path)), dueSoonBy.get(ws.id)!);
  const flowOf = (ws: Workspace, counted: number[], stopped: number): FlowLimit => flowLimitOf(sc.settings().quotaAndResume.flowLimit, [...new Set([...counted, ...[...flowStarted].filter((k) => k.startsWith(`${ws.id}:`)).map((k) => Number(k.slice(ws.id.length + 1)))])], stopped);
  let startedAny = false;
  // a PBI left for its runner's usage limit: the firing waits for the limit's reset, not for the person
  let usageHeld = false;
  const reread = new Set<string>();
  for (;;) {
    // the queue as it is now: an entry taken out or moved, the queue disabled or the number lowered while the backlog was read count
    const live = readQueue(sc.db);
    if (!live.enabled || sc.queueRunning(live) >= live.concurrency) break;
    const at = (workspaceId: string, n: number) => live.items.findIndex((e) => e.workspaceId === workspaceId && e.number === n);
    // the first that may go in each workspace; of those, the one first in the queue
    const next = read
      .flatMap(({ ws, items, flowCounted: running, flowStopped: stopped }) => {
        const order = live.items.filter((e) => e.workspaceId === ws.id).map((e) => e.number);
        const p = pickNext(items.filter((i) => !picked.has(sc.queueKey(ws.id, i.number))), "implement", order, flowOf(ws, running, stopped), undefined, dueSoon(ws));
        return p ? [{ ws, p }] : [];
      })
      .sort((a, b) => at(a.ws.id, a.p.item.number) - at(b.ws.id, b.p.item.number))[0];
    if (!next) break;
    const { ws, p } = next;
    picked.add(sc.queueKey(ws.id, p.item.number));
    const why = sc.queueUsage(p.action);
    if (why) {
      usageHeld = true;
      lines.push(`${ws.name}: #${p.item.number} を始めない: ${why}`);
      continue;
    }
    const t = await sc.startStage({ ws, meta, item: p.item, action: p.action, resume: p.resume && { tasksDone: p.item.tasks!.done }, auto: true });
    if ("held" in t && !("error" in t)) {
      // the line of the item the first read already held is the slot's gate line (`leftLines`): said once
      const said = `#${p.item.number}（前回 ${t.held.previousTaskId}）`;
      if (!lines.some((l) => onGateLine(l, p.item, t.held.previousTaskId))) lines.push(`飛ばした: ${ws.name}: 実装の枠: ${GATE_LINE}: ${said}`);
      continue;
    }
    if ("active" in t) {
      lines.push(`${ws.name}: #${p.item.number} は工程 Task が動いている`);
      continue;
    }
    if ("error" in t) {
      lines.push(`${ws.name}: #${p.item.number} を始められない: ${t.error}`);
      break;
    }
    startedAny = true;
    // the next candidate is judged against what this start took: the workspace's queued items read again from the stored data
    const mine = read.find((x) => x.ws.id === ws.id)!;
    const order = live.items.filter((e) => e.workspaceId === ws.id).map((e) => e.number);
    const queued = new Set(order);
    // (and the flow PBIs in progress, counted as the first read counts them: another may have become one since)
    const stored = sc.withActive({ fetchedAt: 0, items: (await sc.storedBacklogReleased(ws)).items, errors: [], changes: [], syncs: [] }).items;
    mine.items = stored.filter((i) => queued.has(i.number) && canStartStoredBacklog(i).ok);
    mine.flowCounted = flowCounted(stored, order).map((i) => i.number);
    mine.flowStopped = flowStopped(stored, order);
    reread.add(ws.id);
    if (p.item.flow && p.item.stage === "ready") flowStarted.add(sc.queueKey(ws.id, p.item.number));
    lines.push(`${ws.name} #${p.item.number} を ${p.action} で開始 ${t.task.id}`);
  }
  // an overlap that only the starts made is said too, as the first read's line with them counted
  for (const { ws, items, flowCounted: running, flowStopped: stopped, overlapLines } of read) {
    if (!reread.has(ws.id)) continue;
    swapOverlapLines(lines, overlapLines, overlapLinesUnder(`${ws.name}: `, sc.leftLines(items, "implement", flowOf(ws, running, stopped))));
  }
  // the flow PBIs left, said after the starts: one started in this run may be what holds the next
  for (const { ws, items, flowCounted: running, flowStopped: stopped } of read) {
    const flowLine = flowHeldLine(flowHeldIn(items.filter((i) => !flowStarted.has(sc.queueKey(ws.id, i.number))).filter(notGateHeld("implement")), "implement", flowOf(ws, running, stopped)), flowOf(ws, running, stopped));
    if (flowLine) lines.push(`${ws.name}: ${flowLine}`);
  }
  const after = readQueue(sc.db);
  const running = sc.queueRunning(after);
  const nothing = !startedAny && after.enabled && running < after.concurrency;
  if (nothing) lines.push("進められる項目が無い");
  finish({ stalled: nothing && running === 0 && !usageHeld, holders: stallHolders(read.map(({ ws, items }) => ({ workspaceId: ws.id, items }))) });
};

/**
 * A stage Task's turn or the Task ended: an 実装 frees a place, and a Task に分解 may have made a queued PBI
 * Ready — the queue may start its next.
 */
export const queueTaskEnded = (sc: Pick<ServerContext, "db" | "startFromQueue">, _id: string, task: Task) => {
  // after the other turn-end listeners: the judge's marks the reply as being judged (judgingAt), which keeps the Task
  // active (Db's activeStage) until its outcome is known — read before that, a Task that ended asking the person
  // looked finished with nothing to wait on, and the queue started its PBI again on top of it
  if (task.stage && readQueue(sc.db).enabled) setTimeout(() => void sc.startFromQueue("task-end"), 0);
};

/**
 * A stage Task stopped being active without a turn of its own ending (Db's activeStage): its reply was judged, or a
 * job it asked the daemon for ended without resuming it. The place it held is free, and its outcome may now hold the PBI.
 */
export const queueTaskFreed = (sc: Pick<ServerContext, "cfg" | "db" | "startFromQueue">, taskId: string, reason: "judged" | "job-end") => {
  if (decidesNothing(sc.cfg) || !sc.db.getTask(taskId)?.stage || !readQueue(sc.db).enabled) return;
  void sc.startFromQueue(reason);
};

export function setupQueue(sc: Pick<ServerContextInit, "SLOT_ACTIONS" | "queueRun" | "queueAgain" | "cfg" | "tasks" | "queueTaskEnded" | "backlog" | "db" | "startFromQueue" | "resumeUnblocked" | "scheduler" | "opts" | "backlogReads">): void {
  /**
   * After an import that stored a change: the PBIs whose waits it closed and no stage Task runs for go on now, in
   * the implement slot of an enabled backlog-next schedule, not at its next firing. No schedule enabled, or the backlog
   * queue enabled (its own start takes the 実装 slot), nothing starts.
   */
  /** The actions of the 実装 slot the backlog queue starts. */
  sc.SLOT_ACTIONS = BacklogAction.options.filter((a) => SLOT_OF_ACTION[a] === "implement");
  /**
   * The backlog queue's own start: no schedule and no managing Task. While the queue is enabled and fewer of its
   * PBIs' 実装 Tasks (stage Tasks of the implement slot) run or wait than its `concurrency`, the next PBI in the queue's
   * order that may go starts as the row's button starts it (`startStage`; the runner of 自動で始まる Task の既定). What
   * holds the others is judged as backlog-next judges it, and said in its words (`leftLines`). What it decided goes to
   * the schedules' log (`キュー: …`) and to the queue's `lastNote`. Called when the queue is saved enabled, when a stage
   * Task's turn or Task ends, after an import that stored a change, and at boot; a call while one runs makes it run once
   * more after.
   */
  sc.queueRun = null;
  sc.queueAgain = false;
  if (!decidesNothing(sc.cfg)) {
    sc.tasks.onTurnEnd(sc.queueTaskEnded);
    sc.tasks.onTaskEnd(sc.queueTaskEnded);
    // an import that stored a change: a queued PBI's wait may have closed, or it became Ready
    sc.backlog.onImported((wsId) => {
      const queue = readQueue(sc.db);
      if (queue.enabled && queue.items.some((e) => e.workspaceId === wsId)) void sc.startFromQueue("import");
    });
  }
  if (!decidesNothing(sc.cfg)) sc.backlog.onImported((wsId) => void sc.resumeUnblocked(wsId).catch((e) => console.error(`[backlog] resume after the import of ${wsId}: ${String((e as Error)?.message ?? e)}`)));
  // a Task started by hand that stopped on other work (its depends stop's pr#N / issue#N) goes on once that closed;
  // after every import, so a wait already closed when the stop came, or a turn that could not be sent, is tried again
  if (!decidesNothing(sc.cfg)) sc.backlog.onImported((wsId) => void resumeDepends({ db: sc.db, tasks: sc.tasks, workspaceId: wsId, now: Date.now() }).catch((e) => console.error(`[backlog] depends resume after the import of ${wsId}: ${String((e as Error)?.message ?? e)}`)), { every: true });
  if (!sc.cfg.candidate) {
    // a work machine fires no schedule and starts nothing from the queue by itself (machine.ts)
    if (!decidesNothing(sc.cfg)) sc.scheduler.start();
    // the queue goes on where it was: what ended while no daemon ran
    if (!decidesNothing(sc.cfg)) void sc.startFromQueue("boot");
    // the stored backlog is brought up to date at boot; reading it does not wait for this
    // what was kept before the stop is sent (a wait still running is waited for by a timer)
    // and read again by itself from then on, more often while it changes
    if (sc.opts.backlogAutoImport) {
      sc.backlog.startPolling();
      for (const ws of sc.db.listWorkspaces()) if (sc.backlogReads(ws) && existsSync(ws.path)) sc.backlog.request(ws), sc.backlog.send(ws);
    }
  }
}
