/**
 * Two machines sharing work (docs/design/work-machine.md): the two judgements everything else reads.
 *
 *  1. "This Task belongs to another machine" (`otherMachineOf`). Its record came in from a work machine; here it is
 *     read only. The one place that enforces it is `TaskManager` (`requireOwn`, called by every method that runs,
 *     resumes, answers, stops or changes a Task), so a route, the socket, an answer to a question, the automatic resume
 *     and the wait watch are all refused by the same line, whatever they checked themselves. The lists the daemon acts
 *     on by itself (`Db.listTasksUpdatedSince` and the like) leave such Tasks out as well.
 *  2. "This daemon is a work machine" (`isWorkMachine`). A work machine makes no write to the backlog's service and
 *     decides nothing by itself: the daemon's `gh` is `workMachineGh` (reads only), and the sweeps, the queue, the
 *     automatic resume, the automatic answers and the promotion are not started (`workMachineOff`).
 *
 * What is not guaranteed here: a Task is a process of the same OS user as the daemon, so it can run `git push` or a
 * `gh` of its own with whatever credentials that user has. Only the credentials on the work machine (a token that can
 * read and not write) close that; the document lists it as a check before deployment.
 */

import { ghReadsOnly } from "../../../ops-kit/src/gh-reads.ts";

/** A machine's name: what `SWITCHBOARD_MACHINE` may be, and so one key segment in the bucket and one folder name. Never `.` or `..`. */
export const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

export const isMachineName = (name: unknown): name is string => typeof name === "string" && MACHINE_NAME.test(name);

/** The machine a Task ran on when that is not this one; null = this daemon's own Task. */
export function otherMachineOf(task: { machine?: string | null } | null | undefined): string | null {
  return task?.machine ? task.machine : null;
}

/** What the API and the screen say when something would run or change a Task of another machine. */
export const ranElsewhereLine = (machine: string) => `この Task は ${machine} で動きました。返信は ${machine} の Switchboard から行います。`;

/** Thrown by `TaskManager` for a Task of another machine: nothing was run, sent, answered or written. */
export class OtherMachineError extends Error {
  readonly status = 409;
  constructor(readonly machine: string) {
    super(ranElsewhereLine(machine));
  }
}

/** Throws OtherMachineError when the Task belongs to another machine. */
export function requireOwn(task: { machine?: string | null }): void {
  const machine = otherMachineOf(task);
  if (machine) throw new OtherMachineError(machine);
}

/** Whether this daemon is a work machine (`SWITCHBOARD_UPLINK=send`). A candidate daemon (a copy of a database) is never one: it shares nothing. */
export function isWorkMachine(cfg: { uplink: { mode: "send" | "receive" | null }; candidate?: boolean }): boolean {
  return cfg.uplink.mode === "send" && !cfg.candidate;
}

/**
 * Whether this daemon decides nothing by itself: a candidate (it runs on a copy of a database) and a work machine. The
 * schedules, the backlog queue, the automatic resume of a Task that waited on other work, the automatic answers and the
 * promotion check are started only where this is false.
 */
export function decidesNothing(cfg: { uplink: { mode: "send" | "receive" | null }; candidate?: boolean }): boolean {
  return !!cfg.candidate || isWorkMachine(cfg);
}

/** Why a work machine does not do something the instance does by itself. */
export const WORK_MACHINE_OFF = "作業場のマシンでは行いません（GitHub への書き込みと自動の判断は Switchboard 本体だけが行います）";

type Gh = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The `gh` of a work machine's daemon: a call that only reads goes through, anything else is not run and answers as a
 * failed call with the reason. Every `gh` the daemon makes goes through the one runner the server was started with, so
 * wrapping that one is the whole of the daemon's side.
 */
export function workMachineGh(gh: Gh, onRefused?: (args: string[]) => void): Gh {
  return async (args, cwd) => {
    if (ghReadsOnly(args)) return gh(args, cwd);
    onRefused?.(args);
    return { code: 1, stdout: "", stderr: `gh ${args.slice(0, 2).join(" ")}: ${WORK_MACHINE_OFF}` };
  };
}
