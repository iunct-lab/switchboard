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

/** The two answers to a question for a wait past its limit (`Ask.choices`, in this order), and what each leaves in the stop's actions (`<action>: <wait key>`). */
export const WAIT_STOP_CHOICE = "止める";
export const WAIT_KEEP_CHOICE = "待ち続ける";
export const WAIT_STOPPED_ACTION = "利用者が止めた";
export const WAIT_KEPT_ACTION = "利用者が待ち続けると答えた";
/** What the question says each answer does (`Ask.next`). */
export const WAIT_ANSWER_NEXT = `${WAIT_STOP_CHOICE}: この待ちを片づけ、相手が片づいても再開しない / ${WAIT_KEEP_CHOICE}: 上限をいまから数え直す`;
/** The action an answer leaves on each stop of the wait `key`, cut as a stop's action is stored. */
export const waitAnswerAction = (action: typeof WAIT_STOPPED_ACTION | typeof WAIT_KEPT_ACTION, key: string): string => `${action}: ${key}`.slice(0, 200);

/** One wait an open stop makes, before its times: `until` gives the limit from when the wait began. */
type StopWait = Pick<WaitRecord, "kind" | "key" | "label"> & { until: (since: number, b: WaitBounds) => number };

/**
 * The waits of one open stop — the one place a wait's key is built from a stop (`waitsOf` and `stopsOfWait` both read
 * it): each unmet condition is a wait — a job (`job#<n>`), a PR / an Issue (`pr#<n>` / `issue#<n>`), a date
 * (`after:<value>`), another runner's limit (`runner#<id>`), anything else (`<stop id>:<condition key>`); a `depends`
 * stop with no unmet condition is one by itself (`<stop id>`).
 */
function stopWaits(s: StopRecord): StopWait[] {
  const unmet = s.conditions.filter((c) => !c.met);
  const out = unmet.map((c): StopWait => {
    const m = WAIT_KEY.exec(c.key);
    const runner = RUNNER_LIMIT_KEY.exec(c.key);
    if (m && m[1] === "job") return { kind: "job", key: c.key, label: `頼んだ仕事 ${c.key}`, until: (since, b) => since + b.ownMs };
    if (m) return { kind: "depends", key: c.key, label: `${m[1] === "pr" ? "PR" : "Issue"} #${m[2]}`, until: (since, b) => since + b.othersMs };
    if (c.key === AFTER_KEY && !Number.isNaN(afterTime(c.value))) return { kind: "date", key: `${AFTER_KEY}:${c.value}`, label: `期日 ${c.value}`, until: (_since, b) => afterTime(c.value) + b.graceMs };
    if (runner) {
      const at = Date.parse(c.value);
      return { kind: "resume", key: c.key, label: `${runner[1]} の使用上限の解除`, until: (since, b) => (Number.isNaN(at) ? since + b.ownMs : at + b.graceMs) };
    }
    return { kind: "stop", key: `${s.id}:${c.key}`, label: `${c.key}: ${c.value}`, until: (since, b) => since + b.othersMs };
  });
  // a stop that names nothing to wait for and is not the person's: nothing would ever end it
  if (!unmet.length && s.reason === "depends") out.push({ kind: "stop", key: s.id, label: `${s.op}${s.target ? ` ${s.target}` : ""}`, until: (since, b) => since + b.othersMs });
  return out;
}

/** The Task's own open stops that make the wait `key` (the newest record of each): what an answer to that wait's question moves. */
export const stopsOfWait = (stops: StopRecord[], taskId: string, key: string): StopRecord[] => openStops(stops).filter((s) => s.work.taskId === taskId && stopWaits(s).some((w) => w.key === key));

/**
 * Whether the question for this wait past its limit takes the two answers: a wait that comes from a stop (a PR / an
 * Issue, a job, a date, another condition, another runner's limit) of a Task whose turn is over. A wait of a Task at
 * work (a command, the runner's output, the queue) and a planned resume take none: ending one means cutting the turn.
 */
export const answerableWait = (t: Pick<Task, "status" | "resumeAt">, w: Pick<WaitRecord, "kind" | "key">): boolean =>
  !isWorking(t, "gate") && (w.kind === "depends" || w.kind === "job" || w.kind === "date" || w.kind === "stop" || (w.kind === "resume" && RUNNER_LIMIT_KEY.test(w.key)));

export interface WaitFacts {
  task: Task;
  /** The Task's own stop records, oldest first (`Db.listStopRecords([task.id])`). */
  stops: StopRecord[];
  /** Its `ops-kit wait` commands still running. */
  files: WaitFile[];
  /** When its attached runner last gave an event; null = no runner attached. */
  lastEventAt: number | null;
  /** The hook the runner runs now, from its heartbeats (`TaskManager.lastHooks`); null = none. */
  hook?: { name: string; since: number; beatAt: number } | null;
  /** A later stage Task of the same Issue took the work over: this Task's stops are waited on by nobody any more. */
  superseded: boolean;
  /** Why the queue waits (`TaskManager.queueWait`). */
  queue: "slot" | "memory" | "promotion" | null;
  /** Why this Task's queued reply was refused at its last start (`TaskManager.queueRefusal`): it waits for that, not for the queue. */
  refusal?: string | null;
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
 *   A wait the person answered 待ち続ける to (the stop's action says so) counts from that answer.
 */
export function waitsOf(f: WaitFacts): WaitRecord[] {
  const { task: t, now, bounds: b } = f;
  const out: WaitRecord[] = [];
  for (const w of f.files) out.push({ kind: "command", key: `command:${w.pid}`, label: w.label, since: w.startedAt, until: w.timeoutAt, progressAt: w.stallSec === null ? null : w.progressAt, stallSec: w.stallSec });
  // a turn, or the runner's background jobs: the runner is expected to say something
  const atWork = isWorking(t, "output");
  if (atWork && t.executionMode !== "cloud" && f.lastEventAt !== null && !f.files.some((w) => !waitOver({ until: w.timeoutAt }, now))) {
    // heartbeats of a hook still arriving: the runner is working, not silent. Once they stop for `silentMs` it is the silence again.
    // Judged by the last heartbeat, not the last event: a send to the live runner moves `lastEventAt` without a heartbeat.
    if (f.hook && now - f.hook.beatAt < b.silentMs)
      out.push({ kind: "hook", key: "hook", label: f.hook.name, since: f.hook.since, until: f.hook.beatAt + b.silentMs, progressAt: f.hook.beatAt, stallSec: null });
    else out.push({ kind: "output", key: "output", label: t.status === "background" ? "裏の処理の知らせ" : "ランナーの出力", since: f.lastEventAt, until: f.lastEventAt + b.silentMs });
  }
  if (t.status === "waiting") out.push({ kind: "person", key: "approval", label: "ツールの承認", since: t.statusAt, until: t.statusAt + b.othersMs });
  else if (personWait(t) === "needs") out.push({ kind: "person", key: "person", label: "利用者の対応", since: t.statusAt, until: t.statusAt + b.othersMs });
  if (t.resumeAt !== null) {
    const at = Math.max(t.resumeAt, t.resumePlannedAt ?? 0);
    out.push({ kind: "resume", key: "resume", label: t.resumeReason ? RESUME_LABEL[t.resumeReason] : "中断からの自動再開", since: t.resumeSince ?? Math.min(t.updatedAt, t.resumeAt), until: at + b.graceMs });
  }
  if (t.queuedAt !== null) out.push({ kind: "queue", key: "queue", label: f.refusal ? `返信の開始の条件（${f.refusal}）` : QUEUE_LABEL[f.queue ?? "slot"], since: t.queuedAt, until: t.queuedAt + b.ownMs });
  if (atWork || t.status === "waiting" || t.reviewedAt !== null || f.superseded || (t.outcome !== "waits" && t.outcome !== "needs_action")) return out;
  // since when each stop has been open: its first record, or the first after it was last resolved (it came back)
  const openSince = new Map<string, number>();
  for (const r of f.stops) {
    if (r.state === "resolved") openSince.delete(r.id);
    else if (!openSince.has(r.id)) openSince.set(r.id, r.at);
  }
  for (const s of openStops(f.stops)) {
    if (s.work.taskId !== t.id) continue;
    const opened = openSince.get(s.id) ?? s.at;
    for (const { until, ...w } of stopWaits(s)) {
      // 待ち続ける: the limit counts again from the person's last answer to this wait
      const kept = waitAnswerAction(WAIT_KEPT_ACTION, w.key);
      // an answer from before the stop was resolved and came back is not an answer to this wait
      const keptAt = Math.max(0, ...s.actions.filter((a) => a.what === kept && a.at >= opened).map((a) => a.at));
      const since = Math.max(opened, keptAt);
      // a wait whose limit is a fixed time (a date, a runner's limit) would stay over after the answer: it gets one more limit from the answer too
      const again = keptAt ? keptAt + (w.kind === "resume" || w.kind === "job" ? b.ownMs : b.othersMs) : 0;
      out.push({ ...w, since, until: Math.max(until(since, b), again) });
    }
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
  tasks: Pick<TaskManager, "lastEvents" | "lastHooks" | "queueWait" | "queueRefusal" | "recordStop" | "record" | "abort">;
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
/**
 * One Task's waits worked out again and stored when they changed (the screens are told): what the watch does for each
 * Task it looks at, and what an answer to a wait's question does at once, so the question does not stay until the next look.
 */
export function refreshTaskWaits(deps: Pick<WaitWatchDeps, "db" | "broadcastTask" | "bounds">, task: Task, extra: Pick<WaitFacts, "files" | "lastEventAt" | "hook" | "queue" | "refusal">, now: number): void {
  const { db } = deps;
  const issue = issueOf(task);
  const superseded = issue !== null && db.lastStageTask(task.workspaceId!, issue)?.id !== task.id;
  const waits = task.archivedAt !== null ? [] : shownWaits(waitsOf({ task, stops: db.listStopRecords([task.id]), ...extra, superseded, now, bounds: deps.bounds() }), now);
  if (JSON.stringify(waits) === JSON.stringify(task.waits ?? [])) return;
  db.setTaskWaits(task.id, waits);
  const next = db.getTask(task.id);
  if (next) deps.broadcastTask(next);
}

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
  const hooks = tasks.lastHooks();
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
  for (const task of candidates.values()) refreshTaskWaits({ ...deps, bounds: () => bounds }, task, { files: waiting.get(task.id) ?? [], lastEventAt: lastEvents.get(task.id) ?? null, hook: hooks.get(task.id) ?? null, queue, refusal: tasks.queueRefusal(task.id) }, now);
}
