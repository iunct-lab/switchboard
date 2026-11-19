/**
 * What every Task waits for, in one form (`WaitRecord`: what, since when, until when at the latest), and the one
 * watch that looks at them (docs/design/waits.md). A wait is not made here: it is read from where it already is — an
 * `ops-kit wait` record file, the Task's planned resume, its place in the queue, an open approval, its open stops'
 * conditions, the runner's last event — and each gets a limit. The watch stores the list on the Task (`Task.waits`), so
 * the list, the Task's header and the asks screen show the same thing; a wait past its limit (`waitOver`) is a question
 * for the person there, and a runner silent past its limit is shown as 応答なし.
 */
import { otherMachineOf } from "./machine.ts";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { personWait, waitOver, type QuotaAndResumeSettings, type StopRecord, type Task, type WaitRecord } from "@switchboard/protocol";
import { WaitFile } from "../../../ops-kit/src/wait.ts";
import { afterTime } from "../../../scripts/parallel-guard.ts";
import type { Db } from "./db.ts";
import { AFTER_CHECK_MS, STOP_WAITS_MS } from "./depends-resume.ts";
import { AFTER_KEY, issueOf, openStops, RUNNER_LIMIT_KEY, spanText, stopRecordsFor, WAIT_KEY } from "./stops.ts";
import { isWorking } from "./task-status.ts";
import type { TaskManager } from "./tasks/manager.ts";

/** The limits of the waits. The defaults are the settings' (`quotaAndResume`): how long is too long depends on the machine and the work. */
export interface WaitBounds {
  /** A turn, or the runner's background jobs, with no event for this long is silent. */
  silentMs: number;
  /** A wait for something this machine does itself: a job, a run slot. */
  ownMs: number;
  /** A wait for someone else: a PR, an Issue, the person, a stop with no end of its own. */
  othersMs: number;
  /** How long after its time a planned resume or a date may still be on its way: the daemon looks every AFTER_CHECK_MS. */
  graceMs: number;
}

export const boundsOf = (s: Pick<QuotaAndResumeSettings, "silentAfterMs" | "waitLimitMs" | "dependsLimitMs">): WaitBounds => ({ silentMs: s.silentAfterMs, ownMs: s.waitLimitMs, othersMs: s.dependsLimitMs, graceMs: 6 * AFTER_CHECK_MS });

/** Where the `ops-kit wait` records of this daemon's Tasks are (the Tasks get it as OPS_KIT_WAITS_DIR). */
export const waitsDirOf = (home: string): string => join(home, "waits");

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The `ops-kit wait` records: `waiting` = the ones whose command still runs, by Task; `cut` = the ones a cut wait left
 * behind, each with its path (whoever takes one removes it). A record that cannot be read, or whose command is gone
 * without a cut, is removed: a killed command waits for nothing.
 */
export function readWaitFiles(dir: string, alive: (pid: number) => boolean = pidAlive): { waiting: Map<string, WaitFile[]>; cut: Array<{ file: WaitFile; path: string }> } {
  const waiting = new Map<string, WaitFile[]>();
  const cut: Array<{ file: WaitFile; path: string }> = [];
  if (!existsSync(dir)) return { waiting, cut };
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let file: WaitFile | null = null;
    try {
      const r = WaitFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
      file = r.success ? r.data : null;
    } catch {
      file = null;
    }
    if (file?.cut) cut.push({ file, path });
    else if (file && alive(file.pid)) waiting.set(file.taskId, [...(waiting.get(file.taskId) ?? []), file]);
    else rmSync(path, { force: true });
  }
  return { waiting, cut };
}

const RESUME_LABEL: Record<NonNullable<Task["resumeReason"]>, string> = { limit: "使用上限の解除", github: "GitHub の API 上限の解除", disk: "ディスクの空き", start: "使用上限の解除（開始待ち）" };
const QUEUE_LABEL = { slot: "実行枠の空き", memory: "空きメモリ", promotion: "昇格（動いている Task の終わり）" } as const;

export interface WaitFacts {
  task: Task;
  /** The Task's own stop records, oldest first (`Db.listStopRecords([task.id])`). */
  stops: StopRecord[];
  /** Its `ops-kit wait` commands still running. */
  files: WaitFile[];
  /** When its attached runner last gave an event; null = no runner attached. */
  lastEventAt: number | null;
  /** A later stage Task of the same Issue took the work over: this Task's stops are waited on by nobody any more. */
  superseded: boolean;
  /** Why the queue waits (`TaskManager.queueWait`). */
  queue: "slot" | "memory" | "promotion" | null;
  now: number;
  bounds: WaitBounds;
}

/**
 * Everything the Task waits for now. The same facts give the same list.
 * - a running `ops-kit wait`: its own limit;
 * - a turn, or the runner's background jobs: the runner's next event, `silentMs` after the last one — unless a command
 *   wait says what the quiet is for (its limit is the limit then);
 * - an open approval, or a turn that ended needing the person: the person, `othersMs`;
 * - a planned resume: its time and `graceMs` (with a try before a long wait, the later of the two);
 * - a place in the queue: `ownMs`;
 * - of a Task stopped on its stops (the stored outcome `waits` / `needs_action`, not reviewed, and no later stage Task
 *   of its Issue has taken the work over), each unmet condition of an open stop:
 *   a PR / an Issue `othersMs` after the stop came, a job `ownMs`, a date its time and `graceMs`, another runner's limit
 *   its time and `graceMs`, anything else `othersMs`; an open stop that waits by itself with no condition, `othersMs`.
 */
export function waitsOf(f: WaitFacts): WaitRecord[] {
  const { task: t, now, bounds: b } = f;
  const out: WaitRecord[] = [];
  for (const w of f.files) out.push({ kind: "command", key: `command:${w.pid}`, label: w.label, since: w.startedAt, until: w.timeoutAt, progressAt: w.stallSec === null ? null : w.progressAt, stallSec: w.stallSec });
  // a turn, or the runner's background jobs: the runner is expected to say something
  const atWork = isWorking(t, "output");
  if (atWork && t.executionMode !== "cloud" && f.lastEventAt !== null && !f.files.some((w) => !waitOver({ until: w.timeoutAt }, now)))
    out.push({ kind: "output", key: "output", label: t.status === "background" ? "裏の処理の知らせ" : "ランナーの出力", since: f.lastEventAt, until: f.lastEventAt + b.silentMs });
  if (t.status === "waiting") out.push({ kind: "person", key: "approval", label: "ツールの承認", since: t.statusAt, until: t.statusAt + b.othersMs });
  else if (personWait(t) === "needs") out.push({ kind: "person", key: "person", label: "利用者の対応", since: t.statusAt, until: t.statusAt + b.othersMs });
  if (t.resumeAt !== null) {
    const at = Math.max(t.resumeAt, t.resumePlannedAt ?? 0);
    out.push({ kind: "resume", key: "resume", label: t.resumeReason ? RESUME_LABEL[t.resumeReason] : "中断からの自動再開", since: t.resumeSince ?? Math.min(t.updatedAt, t.resumeAt), until: at + b.graceMs });
  }
  if (t.queuedAt !== null) out.push({ kind: "queue", key: "queue", label: QUEUE_LABEL[f.queue ?? "slot"], since: t.queuedAt, until: t.queuedAt + b.ownMs });
  if (atWork || t.status === "waiting" || t.reviewedAt !== null || f.superseded || (t.outcome !== "waits" && t.outcome !== "needs_action")) return out;
  // since when each stop has been open: its first record, or the first after it was last resolved (it came back)
  const openSince = new Map<string, number>();
  for (const r of f.stops) {
    if (r.state === "resolved") openSince.delete(r.id);
    else if (!openSince.has(r.id)) openSince.set(r.id, r.at);
  }
  for (const s of openStops(f.stops)) {
    if (s.work.taskId !== t.id) continue;
    const since = openSince.get(s.id) ?? s.at;
    const unmet = s.conditions.filter((c) => !c.met);
    for (const c of unmet) {
      const m = WAIT_KEY.exec(c.key);
      const runner = RUNNER_LIMIT_KEY.exec(c.key);
      if (m && m[1] === "job") out.push({ kind: "job", key: c.key, label: `頼んだ仕事 ${c.key}`, since, until: since + b.ownMs });
      else if (m) out.push({ kind: "depends", key: c.key, label: `${m[1] === "pr" ? "PR" : "Issue"} #${m[2]}`, since, until: since + b.othersMs });
      else if (c.key === AFTER_KEY && !Number.isNaN(afterTime(c.value))) out.push({ kind: "date", key: `${AFTER_KEY}:${c.value}`, label: `期日 ${c.value}`, since, until: afterTime(c.value) + b.graceMs });
      else if (runner) {
        const at = Date.parse(c.value);
        out.push({ kind: "resume", key: c.key, label: `${runner[1]} の使用上限の解除`, since, until: Number.isNaN(at) ? since + b.ownMs : at + b.graceMs });
      } else out.push({ kind: "stop", key: `${s.id}:${c.key}`, label: `${c.key}: ${c.value}`, since, until: since + b.othersMs });
    }
    // a stop that names nothing to wait for and is not the person's: nothing would ever end it
    if (!unmet.length && s.reason === "depends") out.push({ kind: "stop", key: s.id, label: `${s.op}${s.target ? ` ${s.target}` : ""}`, since, until: since + b.othersMs });
  }
  // one wait per key: two stops on the same PR are one wait, from the earlier
  const byKey = new Map<string, WaitRecord>();
  for (const w of out) {
    const had = byKey.get(w.key);
    if (!had || w.since < had.since) byKey.set(w.key, w);
  }
  return [...byKey.values()];
}

/**
 * What is stored and shown of `waitsOf`: every wait, but the runner's output only once it is over its limit — a runner
 * that keeps talking is not a wait worth a row, and its `since` moves with every event.
 */
export const shownWaits = (waits: WaitRecord[], now: number): WaitRecord[] => waits.filter((w) => w.kind !== "output" || waitOver(w, now));

/** The defaults of the settings `silentAfterMs` / `waitLimitMs` / `dependsLimitMs` (a test keeps the settings' defaults equal to these). */
export const SILENT_AFTER_MS = 10 * 60_000;
export const WAIT_LIMIT_MS = 6 * 3600_000;
export const DEPENDS_LIMIT_MS = 3 * 86_400_000;

/** The stop a cut `ops-kit wait` is recorded as: the person decides whether to wait again. */
export const WAIT_OP = "wait";
/** The note left on a Task whose turn was stopped at the second cut of the same wait. */
export const WAIT_REPEATED_NOTE = "同じ待ちが 2 回切れたので止めました（返信すると続けます）";

/** How often the watch looks. */
export const WAIT_CHECK_MS = 30_000;

export interface WaitWatchDeps {
  db: Db;
  tasks: Pick<TaskManager, "lastEvents" | "queueWait" | "recordStop" | "record" | "abort">;
  dir: string;
  bounds: () => WaitBounds;
  broadcastTask: (task: Task) => void;
  alive?: (pid: number) => boolean;
}

/**
 * One look at every wait: the waits of each Task that can have one are worked out again and stored when they changed
 * (the screens are told), and each `ops-kit wait` cut since the last look becomes a stop of its Task that waits for
 * the person. The same wait cut again with no answer from the person in between is recorded as exhausted and the turn
 * is stopped: a Task must not go back into the wait it was just cut from without being told to.
 */
export async function checkWaits(deps: WaitWatchDeps, now: number): Promise<void> {
  const { db, tasks } = deps;
  const { waiting, cut } = readWaitFiles(deps.dir, deps.alive);
  for (const { file, path } of cut) {
    rmSync(path, { force: true });
    const task = db.getTask(file.taskId);
    // a wait file names its Task itself: one that names another machine's Task is not acted on here
    if (!task || otherMachineOf(task)) continue;
    // the cut before this one of the same wait (same work, same label), unless the person answered it since: then this is a first cut again
    const prior = stopRecordsFor(db, task).filter((r) => r.op === WAIT_OP && r.target === file.label && r.reason === "decision");
    const last = prior.at(-1);
    const lastCame = last ? prior.find((r) => r.id === last.id)!.at : 0;
    const repeated = !!last && last.state !== "resolved" && !(last.answer?.ref.startsWith("seq:") && last.answer.at >= lastCame);
    const r = tasks.recordStop(task.id, {
      // a new id each time: the same wait cut again is the series stopping again, not an update of the first stop
      id: `${WAIT_OP}/${file.pid}-${file.cut!.at}`,
      op: WAIT_OP,
      target: file.label,
      reason: "decision",
      evidence: `待ちが${file.cut!.reason === "stalled" ? `無進捗（${file.stallSec} 秒）` : `上限（${spanText(file.timeoutAt - file.startedAt)}）`}で切れた`,
      safety: "unknown",
      conditions: [],
      actions: [],
      state: repeated ? "exhausted" : "waiting",
    });
    if (!r.ok || !repeated) continue;
    const cur = db.getTask(task.id);
    if (cur && isWorking(cur, "gate")) {
      tasks.record(task.id, { t: "status", text: `${WAIT_REPEATED_NOTE}: ${file.label}` });
      await tasks.abort(task.id).catch((e) => console.error(`[waits] task ${task.id}: the turn was not stopped: ${String((e as Error)?.message ?? e)}`));
    }
  }
  const lastEvents = tasks.lastEvents();
  const queue = tasks.queueWait();
  const candidates = new Map<string, Task>();
  // a Task stopped on its stops is looked at while the daemon still resumes it (STOP_WAITS_MS after its last change);
  // once a wait of it is stored it stays in the look until that wait ends, so a wait the daemon gave up on is not dropped unseen
  for (const t of [...db.listTasksWithWaits(), ...db.listTasksOnStops(now - STOP_WAITS_MS), ...db.listTasksWithResume(), ...db.listQueuedTasks(), ...db.listTasksByStatus("waiting")]) candidates.set(t.id, t);
  for (const id of [...lastEvents.keys(), ...waiting.keys()]) {
    const t = candidates.has(id) ? null : db.getTask(id);
    if (t && !otherMachineOf(t)) candidates.set(id, t);
  }
  const bounds = deps.bounds();
  for (const task of candidates.values()) {
    const issue = issueOf(task);
    const superseded = issue !== null && db.lastStageTask(task.workspaceId!, issue)?.id !== task.id;
    const waits = task.archivedAt !== null ? [] : shownWaits(waitsOf({ task, stops: db.listStopRecords([task.id]), files: waiting.get(task.id) ?? [], lastEventAt: lastEvents.get(task.id) ?? null, superseded, queue, now, bounds }), now);
    if (JSON.stringify(waits) === JSON.stringify(task.waits ?? [])) continue;
    db.setTaskWaits(task.id, waits);
    const next = db.getTask(task.id);
    if (next) deps.broadcastTask(next);
  }
}
