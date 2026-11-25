import { isWorkMachine, WORK_MACHINE_OFF } from "../machine.ts";
import { existsSync } from "node:fs";
import { type RunnerId, type BacklogAllocation, BacklogAction, type BacklogItem, type ScanCursors, type Workspace } from "@switchboard/protocol";
import { fmtTime } from "../ratelimit.ts";
import { type BacklogNextResult, Scheduler } from "../scheduler.ts";
import { scanAllRepos } from "../secretscan.ts";
import { listProcesses } from "../process-defs.ts";
import { readQueue } from "../backlog-queue.ts";
import { allocationOf, sweepOrder, weekWindowStart } from "../allocation.ts";
import { askWithdrawnPrereqs } from "../backlog-waits.ts";
import { awaitingReply, failedIn, failedSince, plannedResumeLine, checksOnlyLine, claimedLine, checkingLine, pickNext, dueSoonOf, replyWaitingIn, overlapIn, QUOTA_FULL, spinningIn, unchangedIn, heldIn, onHoldIn, flowCounted, flowHeldIn, flowHeldLine, flowLimitOf, allocationHeldLines, type AllocationHold, flowStopped, type FlowLimit } from "../backlog-pick.ts";
import { storedFlowIssues, canStartStoredBacklog } from "../backlog-stored.ts";
import { overlapLine, overlapHolderLines, overlapLinesUnder, swapOverlapLines } from "../backlog-overlap.ts";
import { runGh } from "../backlog-gh.ts";
import { SLOT_OF_ACTION, type Slot } from "../backlog-item.ts";
import { approvalWindowLine } from "../approval-batch.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { HELD_LINES, heldWhy } from "./helpers.ts";
import { addSamples, ensureSecretScan } from "../scheduleSamples.ts";

/**
 * A workspace's stored items as the firing and the queue read them before they pick: a PBI held by a withdrawn
 * prerequisite is asked about first (`askWithdrawnPrereqs`, once per prerequisite), and the items are read again, so
 * it is a question for the person from this very run on and not a 進められない line. `say` gets the log line.
 */
export const itemsToAdvance = async (sc: Pick<ServerContext, "storedBacklogReleased" | "db" | "backlog">, ws: Workspace, say: (line: string) => void): Promise<BacklogItem[]> => {
  const items = (await sc.storedBacklogReleased(ws)).items;
  const source = sc.db.getWorkspaceBacklogSource(ws.id);
  const asked = source ? askWithdrawnPrereqs(sc.db, source, items) : [];
  if (!asked.length) return items;
  say(`${ws.name}: 取り下げた前提を判断待ちにした: ${asked.map((n) => `#${n}`).join(" ")}`);
  sc.backlog.send(ws);
  return (await sc.storedBacklogReleased(ws)).items;
};

/**
 * Why the slot's items are left, one line each in backlog-next's words (`<what>: #N …`; the firing puts the workspace
 * and the slot before each). The backlog queue says it the same way for its own items.
 */
export const leftLines = (_sc: unknown, items: BacklogItem[], slot: Slot, flow?: FlowLimit, hold?: AllocationHold): string[] => {
  const out: string[] = [];
  // on hold: named on this line only, whatever else would also leave it
  const onHold = onHoldIn(items, slot);
  if (onHold.length) out.push(`保留: ${onHold.map((i) => `#${i.number}`).join(" ")}`);
  const unheld = items.filter((i) => !i.onHold);
  // a Task that ended asking the person, or failed, with no update to the Issue since; named under that, not as unchanged
  const replyWaiting = replyWaitingIn(unheld, slot);
  if (replyWaiting.length) out.push(`返事待ち: ${replyWaiting.map((i) => `#${i.number}`).join(" ")}`);
  const failed = failedIn(unheld, slot);
  if (failed.length) out.push(`前回の Task が失敗したまま更新が無い: ${failed.map((i) => `#${i.number}${i.lastTask!.resumeAt ? `（使用上限、${fmtTime(i.lastTask!.resumeAt, Date.now())} に戻る）` : ""}`).join(" ")}`);
  const planned = plannedResumeLine(unheld, slot, Date.now(), fmtTime);
  if (planned) out.push(planned);
  const claimed = claimedLine(unheld, slot);
  if (claimed) out.push(claimed);
  const checksOnly = checksOnlyLine(unheld, slot);
  if (checksOnly) out.push(checksOnly);
  const checking = checkingLine(unheld, slot);
  if (checking) out.push(checking);
  const unchanged = unchangedIn(unheld, slot).filter((i) => !failedSince(i) && !awaitingReply(i));
  if (unchanged.length) out.push(`前回から更新が無い: ${unchanged.map((i) => `#${i.number}`).join(" ")}`);
  // what holds them: an overlap still open, a prerequisite not done yet, one a person has to look at
  const held = heldIn(unheld, slot);
  for (const [label, of] of HELD_LINES) {
    const rows = held.flatMap(({ item, pending, stuck }) => {
      const named = of(pending, stuck);
      return named.length ? [`#${item.number}（${named.map(heldWhy).join("・")}）`] : [];
    });
    if (rows.length) out.push(`${label}: ${rows.join(" ")}`);
  }
  // PBIs whose Tasks' files other work touches: left before a session starts only to find that out
  const overlapped = overlapIn(unheld, slot, undefined, flow, hold);
  out.push(...overlapHolderLines(overlapped), ...overlapLine(overlapped));
  out.push(...allocationHeldLines(unheld, slot, hold));
  // stalled PBIs whose newest ## 状況 counts as many closed Tasks as now
  const spinning = spinningIn(unheld, slot);
  if (spinning.length) out.push(`前回の再開から進んでいない: ${spinning.map((i) => `#${i.number}`).join(" ")}`);
  return out;
};

/** Each workspace's share, mode, actual part of the week's spend and shortfall, and flow-improvement's part against its limit, with where the window begins. */
export const readAllocation = (sc: Pick<ServerContext, "db" | "settings">): Omit<BacklogAllocation, "flowLimit"> => {
  const now = Date.now();
  const quota = (["claude", "codex"] as const).flatMap((r) => sc.db.quotaFor(r).map((q) => ({ runner: r, window: q.window, resetsAt: q.resetsAt })));
  const windowStart = weekWindowStart(quota, now);
  return { windowStart, ...allocationOf(sc.db.listWorkspaces(), sc.db.spendSince(windowStart), (id) => storedFlowIssues(sc.db, { id }), sc.settings().quotaAndResume.flowShareLimit) };
};

/**
 * The flow limit and, per workspace, the flow PBIs counted against it and the Ready ones it holds back now, counted as
 * the firing counts them (with the queue on: as the queue does, its own items only). Read for the Settings screen only:
 * a firing does not read it. A workspace with neither is left out.
 */
export const readFlowLimit = async (sc: Pick<ServerContext, "settings" | "db" | "backlogReads" | "withActive" | "storedBacklogReleased">): Promise<BacklogAllocation["flowLimit"]> => {
  const limit = sc.settings().quotaAndResume.flowLimit;
  const queue = readQueue(sc.db);
  const workspaces: BacklogAllocation["flowLimit"]["workspaces"] = [];
  for (const ws of sc.db.listWorkspaces().filter((w) => sc.backlogReads(w) && existsSync(w.path))) {
    const order = queue.enabled ? queue.items.filter((e) => e.workspaceId === ws.id).map((e) => e.number) : undefined;
    const all = sc.withActive({ fetchedAt: 0, items: (await sc.storedBacklogReleased(ws)).items, errors: [], changes: [], syncs: [] }).items;
    const counted = flowCounted(all, order).map((i) => i.number);
    const held = flowHeldIn(order ? all.filter((i) => order.includes(i.number)) : all, "implement", flowLimitOf(limit, counted, 0)).map((i) => i.number);
    if (counted.length || held.length) workspaces.push({ workspaceId: ws.id, counted, held });
  }
  return { limit, workspaces };
};

/**
 * One backlog-next firing: for every registered workspace and each of its two slots (implement / plan),
 * start the slot's next item while fewer stage Tasks of that slot run there than the workspace's own slots allow
 * (`Workspace.sweep`; read per firing). While the usage of the runner it starts them on is high, one stage Task at most runs anywhere; while the newest tag waits to be
 * promoted, nothing starts anywhere. `only`: one workspace's implement slot and those items only, the waits
 * of which an import closed; the same checks hold.
 */
export const startNext = async (sc: Pick<ServerContext, "cfg" | "metaWorkspace" | "askPromotion" | "promotionHold" | "scheduler" | "db" | "activeAs" | "autoRunner" | "decidedRunner" | "settings" | "runnerInfo" | "applyPolicies" | "withActive" | "itemsToAdvance" | "backlogReads" | "backlog" | "notSettled" | "ghLoginRefused" | "readAllocation" | "authStopHeld" | "leftLines" | "storedBacklogReleased" | "startStage" | "autoHeldOf">, scheduleId: string, only?: { workspaceId: string; numbers: number[] }): Promise<BacklogNextResult> => {
  const started: BacklogNextResult["started"] = [];
  const skipped: string[] = [];
  // a work machine chooses no PBI by itself, also when the schedule is fired by hand: there a PBI is started by its own button
  if (isWorkMachine(sc.cfg)) return { started, skipped: [WORK_MACHINE_OFF] };
  const meta = sc.metaWorkspace();
  if (!meta) return { started, skipped: ["meta workspace がありません"] };
  const held = await sc.askPromotion("backlog-next");
  // a narrow firing logs no skips, but a promotion it asked for (no hold left: it was asked) is an action, logged as a full firing's is
  if (held && only && !sc.promotionHold) sc.scheduler.note(`${sc.db.getSchedule(scheduleId)?.title ?? "バックログを進める"}: ${held} (待ちが解けた)`, scheduleId);
  if (held) return { started, skipped: [], promotion: held };
  // Stage Tasks at work (Db's activeStage), per workspace and slot.
  const stageTasks = () => sc.db.listActiveStageTasks();
  const busy = (wsId: string, slot: Slot) => {
    const tasks = stageTasks().filter((t) => t.workspaceId === wsId && SLOT_OF_ACTION[t.stage!.action] === slot).map((t) => `工程 Task ${t.id}（${t.title}）が ${sc.activeAs(t)}`);
    return tasks;
  };
  // The usage that counts is the one of the runner each stage Task starts on: its kind's as startMetaTask decides
  // it (the kind's own, else the schedule's), after 上限のときの代わり; read once per firing.
  const schedule = sc.db.getSchedule(scheduleId);
  // every action, 直行で直す too: a request starts in the candidate its own criteria choose
  const sweepActions = BacklogAction.options;
  // the candidates' definitions (the meta checkout's, like startStage's). Unreadable: no request is started on a guess —
  // each is left with why; 直行で直す is the meta workspace's only, like its button (routes/backlog.ts /start)
  let defsError = "";
  const defs = (() => { try { return listProcesses(meta?.path); } catch (e) { defsError = (e as Error).message ?? String(e); return []; } })();
  const dueSoonAt = Date.now(); // the registry of each workspace's checkout, read once per firing
  const dueSoonBy = new Map<string, Set<number>>();
  const dueSoon = (ws: Workspace) => dueSoonBy.get(ws.id) ?? (dueSoonBy.set(ws.id, dueSoonOf(ws.path, dueSoonAt)), dueSoonBy.get(ws.id)!);
  const defsFor = (ws: Workspace) => (ws.kind === "meta" ? defs : defs.filter((d) => !d.auto));
  const targetOf = Object.fromEntries(sweepActions.map((a) => [a, ((d) => (d ? sc.autoRunner(d).runner : null))(sc.decidedRunner(a, schedule?.runner))])) as Record<BacklogAction, RunnerId | null>;
  // Only a window that has not reset yet counts: a row from before the reset would otherwise hold the sweep for good,
  // since only a turn of that runner writes a new one (resetsAt is in seconds).
  const limit = sc.settings().quotaAndResume.backlogQuotaLimit;
  const windowAt = (r: RunnerId | null, at: number) => (r ? sc.db.quotaFor(r).find((q) => q.utilization >= at && q.resetsAt * 1000 > Date.now()) : undefined);
  // A window at its limit: the stage Task would end at once on the limit, so it is not started.
  const fullOf = (r: RunnerId | null) => {
    const w = windowAt(r, QUOTA_FULL);
    return w ? `${r} の使用量 ${w.window} が ${Math.round(w.utilization * 100)}%: ${fmtTime(w.resetsAt * 1000, Date.now())} に戻るまで始めない` : "";
  };
  const usageOf = (r: RunnerId | null) => {
    const w = windowAt(r, limit);
    return w ? `${r} の使用量 ${w.window} が ${Math.round(w.utilization * 100)}%（${Math.round(limit * 100)}% 以上）` : "";
  };
  // Why an action's stage Task is not started now: its runner at the limit, or its runner's usage high and a stage Task
  // already running anywhere or started by this firing (one start per firing, asked again before each start: one a
  // button started while GitHub was read counts too). "" = it may start.
  const quotaHeld = (a: BacklogAction) => fullOf(targetOf[a]) || (usageOf(targetOf[a]) && (started.length > 0 || stageTasks().length > 0) ? usageOf(targetOf[a]) : "");
  // The login of the runner an action starts on: a lapsed login holds every slot (the stage Task would end at once on
  // "not logged in"), a Claude login that lapses within LOGIN_SOON_MS holds the implement slot only (a long run would
  // be cut off on the way). The button (startStage) is not held. Memory only: runnerInfo() starts no runner. "" = it may start.
  const LOGIN_SOON_MS = 24 * 3600_000;
  const loginHeld = (a: BacklogAction) => {
    const r = targetOf[a];
    const info = r ? sc.runnerInfo().find((x) => x.id === r) : undefined;
    if (!r || !info) return "";
    if (info.login === "expired") return `${r} のログインが切れている: 始めない`;
    const left = info.loginExpiresAt === undefined ? undefined : info.loginExpiresAt - Date.now();
    return r === "claude" && left !== undefined && left < LOGIN_SOON_MS && SLOT_OF_ACTION[a] === "implement" ? `${r} のログインが ${fmtTime(info.loginExpiresAt!, Date.now())} に切れる: 実装の枠を始めない` : "";
  };
  const stageHeld = (a: BacklogAction) => loginHeld(a) || quotaHeld(a);
  const lines = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  // nothing could start: GitHub is not read
  if (sweepActions.every(stageHeld)) return { started, skipped: lines(sweepActions.map((a) => loginHeld(a) || fullOf(targetOf[a]) || `${usageOf(targetOf[a])}: 工程 Task が動いているので始めない`)) };
  skipped.push(...lines(sweepActions.map(loginHeld)), ...lines(sweepActions.map((a) => fullOf(targetOf[a]))), ...lines(sweepActions.map((a) => (fullOf(targetOf[a]) ? "" : usageOf(targetOf[a])))).map((u) => `${u}: 全体で 1 件まで`));
  // a saved policy answers the decisions it matches before the next one is picked
  await sc.applyPolicies();
  const SLOTS: Slot[] = only ? ["implement"] : ["implement", "plan"];
  const SLOT_NAME: Record<Slot, string> = { implement: "実装の枠", plan: "計画の枠" };
  // an enabled backlog queue starts the 実装 slot's PBIs itself, in its order; the firing moves the 計画 slot only.
  // Read again where it is used: the queue may be enabled while GitHub is read
  const queued = () => readQueue(sc.db).enabled;
  // a workspace's stored items the sweep may pick from; read again after each start, so the next candidate's overlap counts the PBI just started
  const load = async (ws: Workspace) => {
    const all = sc.withActive({ fetchedAt: 0, items: await sc.itemsToAdvance(ws, (l) => skipped.push(l)), errors: [], changes: [], syncs: [] }).items;
    const judged = all.filter((i) => !only || only.numbers.includes(i.number)).map((item) => ({ item, can: canStartStoredBacklog(item) }));
    // flow PBIs in progress are counted on the whole backlog, not only the numbers a narrow firing reads
    return { items: judged.filter((j) => j.can.ok).map((j) => j.item), syncHeld: judged.flatMap((j) => (j.can.ok ? [] : [`#${j.item.number}（${j.can.why}）`])), flowCounted: flowCounted(all).map((i) => i.number), flowStopped: flowStopped(all) };
  };
  // read every workspace that has a free slot in parallel; one GitHub cannot be read for goes on with what is stored
  const read = await Promise.all(sc.db.listWorkspaces().filter((ws) => sc.backlogReads(ws) && (!only || ws.id === only.workspaceId)).map(async (ws) => {
    if (!SLOTS.some((slot) => busy(ws.id, slot).length < ws.sweep[slot])) return { ws, items: [] as BacklogItem[], syncHeld: [] as string[], unsynced: null, ghLoginHeld: null, flowCounted: [] as number[], flowStopped: 0 };
    if (!existsSync(ws.path)) return { ws, error: "workspace directory does not exist" };
    // the stored data is what is true: GitHub is brought up to date first when it can be reached, and when it
    // cannot (a limit, an outage) the workspace goes on with what is stored; only an Issue with a conflict is not picked
    // a narrow firing comes right after the import that cleared the waits: it is not read again here (the read right before a start still is)
    const unsynced = only ? null : await sc.backlog.settle(ws).then(() => null, (e) => sc.notSettled(e));
    return { ws, ...(await load(ws)), unsynced, ghLoginHeld: unsynced && sc.ghLoginRefused(ws) ? unsynced : null };
  }));
  // the week's spend against the shares, read once per firing
  const alloc = sc.readAllocation();
  type Read = (typeof read)[number];
  type ReadOk = Exclude<Read, { error: string }>;
  // what is wrong with a workspace as it was read: said for every workspace of the firing, one skipped for its share too
  const anomalyLines = (r: Read): string[] => "error" in r
    ? [`${r.ws.name}: ${r.error}`]
    : [
      ...(r.unsynced ? [`${r.ws.name}: GitHub と照合できない（保存データで進める）: ${r.unsynced}`] : []),
      ...(r.syncHeld.length ? [`${r.ws.name}: 競合があるので自動では始めない: ${r.syncHeld.join(" ")}`] : []),
    ];
  // the flow limit and the week's holds of a workspace as read; `flowStarted` = the flow PBIs this firing started from Ready since
  const flowOfRead = (r: ReadOk, flowStarted: ReadonlySet<number> = new Set()): FlowLimit => flowLimitOf(sc.settings().quotaAndResume.flowLimit, [...new Set([...r.flowCounted, ...flowStarted])], r.flowStopped);
  const holdOf = (ws: Workspace): AllocationHold => ({ flowShare: alloc.flow, mode: alloc.workspaces.find((w) => w.workspaceId === ws.id)?.mode });
  // whether a slot has an item a turn would start: the first picked that the gate (stage-start-gate.ts) does not hold, as the turn picks
  const startableIn = (r: ReadOk, slot: (typeof SLOTS)[number]) => {
    const held = new Set<number>();
    for (;;) {
      const next = pickNext(r.items.filter((i) => !held.has(i.number)), slot, undefined, flowOfRead(r), defsFor(r.ws), dueSoon(r.ws), holdOf(r.ws));
      if (!next) return false;
      if (!sc.autoHeldOf(r.ws, next.item, next.action)) return true;
      held.add(next.item.number);
    }
  };
  // whether a turn would start something there: a slot is free (and the firing's, not the queue's) and has an item to start
  const hasWork = (r: ReadOk) => SLOTS.some((slot) => !(slot === "implement" && queued()) && busy(r.ws.id, slot).length < r.ws.sweep[slot] && startableIn(r, slot));
  // one workspace's turn: its slots, each filled while an item can start
  const sweepWorkspace = async (r: Read) => {
  const { ws } = r;
  skipped.push(...anomalyLines(r));
  if ("error" in r) return;
  const picked = new Set<number>();
  // flow PBIs started from Ready in this firing: still ready in `r.items`, so counted as in progress here
  const flowStarted = new Set<number>();
  const flow = () => flowOfRead(r, flowStarted);
  const hold = holdOf(ws);
  for (const slot of SLOTS) {
    if (slot === "implement" && queued()) {
      if (ws.sweep[slot] > 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: キューに任せる`);
      continue;
    }
    // checked again after GitHub was read: a button may have started a stage meanwhile
    let reported = false;
    let reread = false;
    // the overlap lines the first read of this slot put in the log: what the reread takes out again (and no other workspace's)
    let firstOverlap: string[] = [];
    for (let n = 0; ; n++) {
      // the import was refused the login: the 実装 slot starts nothing until it is back (the 計画 slot and the buttons go on)
      const authHeld = slot === "implement" ? (r.ghLoginHeld ?? sc.authStopHeld(ws)) : null;
      if (authHeld) {
        if (n === 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: GitHub の認証切れ: 始めない（${authHeld}）`);
        break;
      }
      const running = busy(ws.id, slot);
      if (running.length >= ws.sweep[slot]) {
        if (ws.sweep[slot] > 0 && n === 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}が埋まっている: ${running.join(" / ")}`);
        break;
      }
      const slotHeld = sweepActions.filter((a) => SLOT_OF_ACTION[a] === slot).map(stageHeld);
      if (slotHeld.every(Boolean)) {
        if (n === 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: ${lines(slotHeld).join(" / ")}`);
        break;
      }
      const next = pickNext(r.items.filter((i) => !picked.has(i.number)), slot, undefined, flow(), defsFor(ws), dueSoon(ws), hold);
      if (n === 0) {
        const left = sc.leftLines(r.items, slot, flow(), hold);
        skipped.push(...left.map((l) => `${ws.name}: ${SLOT_NAME[slot]}: ${l}`));
        firstOverlap = overlapLinesUnder(`${ws.name}: ${SLOT_NAME[slot]}: `, left);
      }
      if (n === 0) reported = true;
      if (!next) {
        if (n === 0) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 進められる項目が無い`);
        break;
      }
      picked.add(next.item.number);
      if (defsError && next.item.stage === "request") {
        skipped.push(`${ws.name}: #${next.item.number} を始めない: 候補の定義を読めません: ${defsError}`);
        continue;
      }
      // held for the previous automatic start (stage-start-gate.ts): said before GitHub is read again, so a held item costs no read
      const heldBefore = sc.autoHeldOf(ws, next.item, next.action);
      if (heldBefore) {
        skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 前回の開始から出来事が増えていない: #${next.item.number}（前回 ${heldBefore.previousTaskId}）`);
        continue;
      }
      // read again right before the start: the sweep may have taken long since this workspace was read, and an
      // edit may have been kept meanwhile — GitHub when it can be reached, the stored data either way
      const late = await sc.backlog.settle(ws).then(() => null, (e) => sc.notSettled(e));
      if (late && slot === "implement" && sc.ghLoginRefused(ws)) {
        skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: GitHub の認証切れ: 始めない（${late}）`);
        break;
      }
      if (late && !r.unsynced) skipped.push(`${ws.name}: GitHub と照合できない（保存データで進める）: ${late}`);
      const fresh = sc.withActive({ fetchedAt: 0, items: (await sc.storedBacklogReleased(ws)).items, errors: [], changes: [], syncs: [] }).items.find((i) => i.number === next.item.number);
      const can = fresh ? canStartStoredBacklog(fresh) : { ok: false as const, why: "バックログから無くなった" };
      // its stage Task started meanwhile (a button, an answer's resume): the slot's next item instead
      if (fresh?.activeTaskId) {
        skipped.push(`${ws.name}: #${next.item.number} は工程 Task が動いている`);
        continue;
      }
      // what to do is picked again on the item as it is now (a Task reopened meanwhile makes a 閉じる a 実装, or nothing)
      const again = can.ok ? pickNext([fresh!], slot, undefined, undefined, defsFor(ws)) : null;
      if (!can.ok || !again || again.action !== next.action || !again.resume !== !next.resume) {
        skipped.push(`${ws.name}: #${next.item.number} を始めない: ${can.ok ? "照合の間に変わった（次の発火で選び直す）" : can.why}`);
        continue;
      }
      // the usage of the runner this action starts on: another item of the slot may start on another runner
      const why = stageHeld(again.action);
      if (why) {
        skipped.push(`${ws.name}: #${next.item.number} を始めない: ${why}`);
        continue;
      }
      // the queue enabled since this workspace was read: the 実装 slot is the queue's now
      if (slot === "implement" && queued()) {
        skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: キューに任せる`);
        break;
      }
      // Unattended: no shadow (like prompt schedules) and the schedule's budget applies to the stage Task.
      const t = await sc.startStage({
        ws, meta, item: again.item, action: again.action, resume: again.resume && { tasksDone: again.item.tasks!.done }, processReason: again.reason, auto: true,
        extra: { runner: schedule?.runner, model: schedule?.model, effort: schedule?.effort, scheduleId, shadowRunner: null, budgetUsd: schedule?.budgetUsd },
      });
      if ("held" in t && !("error" in t)) {
        skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: 前回の開始から出来事が増えていない: #${next.item.number}（前回 ${t.held.previousTaskId}）`);
        continue;
      }
      // its stage Task started after GitHub was read (a button, an answer's resume): the slot's next item instead
      if ("active" in t) {
        skipped.push(`${ws.name}: #${next.item.number} は工程 Task が動いている`);
        continue;
      }
      if ("error" in t) {
        skipped.push(`${ws.name}: #${next.item.number} を始められない: ${t.error}`);
        // another machine holds this PBI: the slot's next item instead
        if (t.held) continue;
        break;
      }
      if (again.item.flow && again.item.stage === "ready") flowStarted.add(again.item.number);
      started.push({ task: t.task, label: `${ws.name} #${next.item.number} を ${next.action}` });
      // the next candidate is judged against what this start took (its stage Task now runs): the stored data only; the sync lines stay those of the first read
      // (the flow PBIs in progress are read again too: another may have become one since the first read)
      const reloaded = await load(ws);
      r.items = reloaded.items;
      r.flowCounted = reloaded.flowCounted;
      r.flowStopped = reloaded.flowStopped;
      reread = true;
    }
    // an overlap that only the starts made is said too: the line is the first read's with them counted
    if (reread) {
      const head = `${ws.name}: ${SLOT_NAME[slot]}: `;
      swapOverlapLines(skipped, firstOverlap, overlapLinesUnder(head, sc.leftLines(r.items, slot, flow(), hold)));
    }
    // the flow PBIs left, said after the starts: one started in this firing may be what holds the next
    const flowLine = reported && flowHeldLine(flowHeldIn(r.items.filter((i) => !flowStarted.has(i.number)), slot, flow()), flow());
    if (flowLine) skipped.push(`${ws.name}: ${SLOT_NAME[slot]}: ${flowLine}`);
  }
  };
  // the workspaces with the largest shortfall first; those over their share only when nothing else started in this firing
  const order = sweepOrder(alloc, read.map((r) => r.ws.id));
  const byId = new Map(read.map((r) => [r.ws.id, r]));
  for (const id of order.first) await sweepWorkspace(byId.get(id)!);
  if (!started.length) for (const o of order.over) await sweepWorkspace(byId.get(o.workspaceId)!);
  else for (const o of order.over) {
    // skipped for its share: what is wrong there is still said, and the share is the reason only when it had work to start
    const r = byId.get(o.workspaceId)!;
    skipped.push(...anomalyLines(r));
    if (!("error" in r) && hasWork(r)) skipped.push(`飛ばした: ${r.ws.name}: 取り分 ${Math.round(o.share * 100)}% に対し実績 ${Math.round(o.actual * 100)}%`);
  }
  return { started, skipped };
};

// secret-scan: every registered repository through the kit's scan-issues; its result is on the schedule, 判断待ち's notice is read from it
export const scanSecrets = async (sc: Pick<ServerContext, "metaWorkspace" | "db" | "opts">, s: { id: string; title: string }, cursors: ScanCursors) => {
  const meta = sc.metaWorkspace();
  if (!meta) return { lines: ["meta workspace がない（共通キットの scan-issues を呼べない）"], summary: { repos: 0, hits: 0, failed: 1 } };
  const r = await scanAllRepos({ workspaces: sc.db.listWorkspaces(), metaPath: meta.path, gh: sc.opts.gh ?? runGh, cursors });
  return r;
};

// Scheduler: cron-fired tasks, morning queue view.
// approval-window: the SSO / deploy batches still waiting; 判断待ち shows them as a notice from this firing on
export const approvalWindow = async (sc: Pick<ServerContext, "currentAsks">) => {
  const { batches, asks } = await sc.currentAsks();
  return approvalWindowLine(batches, asks);
};

export function setupScheduler(sc: Pick<ServerContextInit, "scheduler" | "db" | "tasks" | "startNext" | "scanSecrets" | "settings" | "autoRunner" | "approvalWindow" | "defaultBudgetFor" | "metaWorkspace">): void {
  sc.scheduler = new Scheduler(sc.db, sc.tasks, Date.now, sc.startNext, sc.scanSecrets, () => sc.settings().quotaAndResume.backlogQuotaLimit, sc.autoRunner, sc.approvalWindow, sc.defaultBudgetFor);
  // The samples are put in once, disabled; one the person deleted is not put back (the row is theirs to turn on,
  // rewrite or remove in Schedules). The list and the rule are in scheduleSamples.ts.
  const seedMeta = sc.metaWorkspace();
  if (seedMeta) addSamples(sc.db, sc.scheduler, seedMeta.id);
  // the daily credential scan is put in once too, enabled, unless one already fires (`ensureSecretScan`)
  if (seedMeta) ensureSecretScan(sc.db, sc.scheduler, seedMeta.id);
}
