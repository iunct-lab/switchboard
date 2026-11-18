import { otherMachineOf, ranElsewhereLine } from "../machine.ts";
import { heldLine } from "../lease.ts";
import { reduceStops } from "../stops.ts";
import { ResumeSupersededError } from "../tasks/state.ts";
import type { Task } from "@switchboard/protocol";
import { existsSync } from "node:fs";
import { IN_FLIGHT } from "../task-status.ts";
import type { Workspace } from "@switchboard/protocol";
import { receiveUplink, sendUplink } from "../uplink-s3.ts";
import { importBacklogOperations } from "../backlog-upbox.ts";
import { syncsGithub } from "../backlog-gh.ts";
import { storedIssueHeads } from "../backlog-stored.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";

/** The repository (`owner/name`) a PBI's lease is kept under: only a backlog synced with its service has one both machines name alike. */
export const leaseRepository = (sc: Pick<ServerContext, "leases" | "db">, ws: Pick<Workspace, "id">): string | null => {
  const source = sc.leases ? sc.db.getWorkspaceBacklogSource(ws.id) : null;
  return source && syncsGithub(source) ? source.repository : null;
};

/** Who else holds the PBI's lease, as last seen (no request is made); null = no one, or alone. */
export const leasedElsewhere = (sc: Pick<ServerContext, "leaseRepository" | "leases">, ws: Pick<Workspace, "id">, n: number) => {
  const repository = sc.leaseRepository(ws);
  return repository ? sc.leases!.heldElsewhere(repository, n) : null;
};

/** A Task whose record came from another machine is read only here: what would run it or change how it runs is refused with the reason. */
export const ranElsewhere = (sc: Pick<ServerContext, "db" | "bad">, id: string): Response | null => {
  const machine = otherMachineOf(sc.db.getTask(id));
  return machine ? sc.bad(ranElsewhereLine(machine), 409) : null;
};

export const uplinkRound = async (sc: Pick<ServerContext, "s3" | "uplinkBusy" | "uplink" | "db" | "cfg" | "backlogReads" | "backlog">): Promise<void> => {
  if (!sc.s3 || sc.uplinkBusy) return;
  sc.uplinkBusy = true;
  try {
    if (sc.uplink.mode === "send") {
      await sendUplink(sc.db, sc.cfg, sc.s3);
      for (const ws of sc.db.listWorkspaces().filter(sc.backlogReads)) if (existsSync(ws.path)) await sc.backlog.sync(ws).catch(() => undefined);
    } else {
      const got = await receiveUplink(sc.db, sc.cfg, sc.s3);
      if (got.some((r) => r.status === "applied")) console.log(`[uplink] took in ${got.filter((r) => r.status === "applied").map((r) => r.deltaId).join(", ")}`);
      for (const id of await importBacklogOperations(sc.db, sc.s3, sc.uplink.machines)) {
        const ws = sc.db.getWorkspace(id);
        if (ws) void sc.backlog.send(ws);
      }
    }
  } catch (e) {
    console.error(`[uplink] ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  } finally {
    sc.uplinkBusy = false;
  }
};

/** The Tasks whose PBI's lease was lost while their turn ran: stopped when that turn ends (`leaseTurnEnded`). By TaskManager, so two daemons in one process (tests) do not share it. */
const lostWhileRunning = new WeakMap<object, Map<string, { pbi: number; why: "taken" | "expired" }>>();
const LEASE_OP = "pbi-lease";
/** What stopping a Task for a lost lease reads: the three calls of the Task manager and the Task's row. */
type LeaseStopContext = { tasks: Pick<ServerContext["tasks"], "record" | "recordStop" | "abort">; db: Pick<ServerContext["db"], "getTask"> & Partial<Pick<ServerContext["db"], "listStopRecords">> };

/** Whether a stage Task takes its PBI's lease (as `startStage` does: every stage of a PBI or a request but a status check and a direct fix). */
const leasedStage = (task: Pick<Task, "stage">): number | null => (task.stage && task.stage.action !== "check" && task.stage.action !== "direct" ? task.stage.issue : null);

/**
 * Whether a stage Task of the PBI is still at it on this machine: one at work (a turn, a queue place, a planned
 * resume, a job, a judging), or the newest one stopped on something that will bring it back — a wait it recorded
 * (a PR, a date) or the person's answer. One that finished, failed or was stopped for good is not.
 */
export const leaseWanted = (sc: Pick<ServerContext, "db">, workspaceId: string, pbi: number): Task | null => {
  const active = sc.db.activeStageTask(workspaceId, pbi);
  if (active) return active;
  const last = sc.db.lastStageTask(workspaceId, pbi);
  return last && (last.outcome === "needs_action" || last.outcome === "waits") ? last : null;
};

/**
 * The one check of a PBI's lease where a turn of a stage Task starts or resumes (the Task manager's `turnGate`: every
 * reply, planned resume and turn the daemon starts by itself comes through it). Alone — no uplink configured — it does
 * nothing and asks nobody.
 *  - held by this machine: the turn goes on, with no request;
 *  - not held (lost while the Task was between turns, lost while this daemon was down, given back since), and the
 *    person asks for the turn (a reply): the lease is taken again for it — refused, with who holds it, while another
 *    machine does. The person's word is what decides to go on; the lease keeps the two machines from doing it at once;
 *  - not held, and the daemon asks (a planned resume, a wait that was met): the bucket is read once (a daemon that
 *    just started has not seen its own leases yet), and if the lease is still not this machine's the turn is not
 *    started: the Task stops with the stop that waits for the person (`stopForLostLease`), as when a lease is lost under it.
 */
export const leaseGate = async (sc: Pick<ServerContext, "leases" | "leaseRepository" | "tasks" | "db">, task: Task, by: "person" | "daemon"): Promise<void> => {
  const pbi = leasedStage(task);
  const repository = pbi !== null && task.workspaceId ? sc.leaseRepository({ id: task.workspaceId }) : null;
  if (pbi === null || !repository || !sc.leases) return;
  if (sc.leases.holds(repository, pbi)) return;
  if (by === "person") {
    let got: Awaited<ReturnType<NonNullable<ServerContext["leases"]>["acquire"]>>;
    try {
      got = await sc.leases.acquire(repository, pbi, true);
    } catch (e) {
      throw new Error(`PBI #${pbi} のリースを確かめられないので、この Task は続けません（別のマシンが進めているかもしれません）: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    if (!got.ok) throw new Error(`${heldLine(pbi, got.holder, got.until)}。同じ PBI を 2 台で進めないよう、この Task はここでは続けません`);
    return;
  }
  await sc.leases.refresh().catch(() => undefined);
  if (sc.leases.holds(repository, pbi)) return;
  await stopForLostLease(sc, task.id, { pbi, why: sc.leases.heldElsewhere(repository, pbi) ? "taken" : "expired" }, true);
  throw new ResumeSupersededError(`the lease of PBI #${pbi} is not held by this machine`);
};

/** A stage Task ended: its PBI's lease goes back when no stage Task of the PBI is at it here any more (`leaseWanted`). */
export const returnLease = async (sc: Pick<ServerContext, "leases" | "leaseRepository" | "db">, task: Task): Promise<void> => {
  const pbi = leasedStage(task);
  const repository = pbi !== null && task.workspaceId ? sc.leaseRepository({ id: task.workspaceId }) : null;
  if (pbi === null || !repository || !sc.leases) return;
  const held = sc.leases.held().find((h) => h.repository.toLowerCase() === repository.toLowerCase() && h.pbi === pbi);
  if (!held || !(held.stage || held.recovered) || leaseWanted(sc, task.workspaceId!, pbi)) return;
  await sc.leases.release(repository, pbi).catch((e) => console.error(`[lease] PBI #${pbi} was not given back: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
};

/**
 * The lease of a Task's PBI is lost (`PbiLeases.renewAll`): the Task stops at its next turn boundary and says so, and
 * nothing else is decided for it — no take-back of the lease, no retry, no word to the other machine. A Task between
 * turns stops now: what it had planned by itself (a resume, a place in the queue) is dropped and a stop that waits for
 * the person is recorded. One whose turn runs is noted, and stops the same way when that turn ends. The person decides
 * what comes next (the other machine may be at the PBI).
 */
export async function stopForLostLease(sc: LeaseStopContext, taskId: string, lost: { pbi: number; why: "taken" | "expired" }, turnEnded = false): Promise<void> {
  const { tasks } = sc;
  const task = sc.db.getTask(taskId);
  if (!task) return;
  const line = lost.why === "taken" ? `PBI #${lost.pbi} のリースを別のマシンに取られました` : `PBI #${lost.pbi} のリースを延長できないまま期限が来ました（別のマシンが取れる状態です）`;
  if (!turnEnded && IN_FLIGHT.has(task.status)) {
    const waiting = lostWhileRunning.get(tasks) ?? lostWhileRunning.set(tasks, new Map()).get(tasks)!;
    if (!waiting.has(taskId)) tasks.record(taskId, { t: "status", text: `${line}。このターンが終わったら止めます。同じ PBI が 2 台で進んでいないか確かめてください。` });
    waiting.set(taskId, lost);
    return;
  }
  lostWhileRunning.get(tasks)?.delete(taskId);
  // said once: a Task already stopped for this lease (the gate finds it lost again at each try) gets no second stop
  const open = sc.db.listStopRecords ? reduceStops(sc.db.listStopRecords([taskId])).some((x) => x.op === LEASE_OP && x.state === "waiting") : false;
  if (!open) tasks.recordStop(taskId, { id: `${LEASE_OP}/${lost.pbi}-${Date.now()}`, op: LEASE_OP, target: `#${lost.pbi}`, reason: "decision", evidence: `${line}。この Task は止めました。同じ PBI が 2 台で進んでいないか確かめてから、続けるか決めてください。`, safety: "unknown", conditions: [], actions: [], state: "waiting" });
  await tasks.abort(taskId).catch((e) => console.error(`[lease] task ${taskId} was not stopped: ${String((e as Error)?.message ?? e)}`));
}

/** The end of a turn: a Task whose lease was lost while it ran stops now. */
export function leaseTurnEnded(sc: LeaseStopContext, taskId: string): Promise<void> {
  const lost = lostWhileRunning.get(sc.tasks)?.get(taskId);
  return lost ? stopForLostLease(sc, taskId, lost, true) : Promise.resolve();
}

export const leaseRound = async (sc: Pick<ServerContext, "leases" | "leaseBusy" | "uplink" | "leaseTicks" | "db" | "leaseRepository" | "tasks">): Promise<void> => {
  if (!sc.leases || sc.leaseBusy) return;
  sc.leaseBusy = true;
  try {
    const every = Math.max(1, Math.floor(sc.uplink.leaseTtlMs / 3 / sc.uplink.leaseRenewMs));
    if (sc.leaseTicks++ % every === 0) await sc.leases.refresh();
    const sources = sc.db.listWorkspaces().flatMap((ws) => ((r) => (r ? [{ ws, repository: r.toLowerCase() }] : []))(sc.leaseRepository(ws)));
    for (const held of sc.leases.held()) {
      const at = sources.filter((x) => x.repository === held.repository.toLowerCase());
      const closed = at.some(({ ws }) => storedIssueHeads(sc.db, { id: ws.id }).get(held.pbi)?.state === "CLOSED");
      // a lease taken for a stage Task (by this daemon, or by one before it), with no stage Task of the PBI at it here
      // any more: nobody is at it. One a session took for itself (the lease route) is its own to give back
      const orphan = (held.recovered || held.stage) && !at.some(({ ws }) => leaseWanted(sc, ws.id, held.pbi));
      if (closed || orphan) await sc.leases.release(held.repository, held.pbi);
    }
    for (const lost of await sc.leases.renewAll()) {
      console.error(`[lease] PBI #${lost.pbi} (${lost.repository}): the lease is lost (${lost.why})`);
      for (const { ws } of sources.filter((x) => x.repository === lost.repository.toLowerCase())) {
        // the Task at it: also one between turns that waits for a PR, a date or the person (it would go on later)
        const t = leaseWanted(sc, ws.id, lost.pbi);
        if (t) await stopForLostLease(sc, t.id, lost);
      }
    }
  } catch (e) {
    console.error(`[lease] ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  } finally {
    sc.leaseBusy = false;
  }
};

export function setupUplink(sc: Pick<ServerContextInit, "leaseRepository" | "tasks" | "db" | "uplinkBusy" | "uplinkTimer" | "s3" | "uplinkRound" | "uplink" | "leaseBusy" | "leaseTicks" | "leaseTimer" | "leases" | "leaseRound">): void {
  // Two machines sharing work: a work machine sends its Tasks' records and brings its backlog copy up to date, the
  // instance takes in what was put (the records, then the backlog edits, which it sends). Once at start — what was put
  // while the instance was stopped all goes in then — and on an interval; one round at a time, a failure waits for the next.
  sc.uplinkBusy = false;
  sc.uplinkTimer = sc.s3 ? setInterval(() => void sc.uplinkRound(), sc.uplink.intervalMs) : null;
  if (sc.s3) void sc.uplinkRound();
  // The leases held are renewed on an interval; one that is lost (another machine took it over, or it could not be
  // renewed in time) stops the PBI's stage Task at its next turn boundary, with a stop that waits for the person
  // (`stopForLostLease`). A PBI that closed gives its lease back.
  // Every third of a lease's life the bucket is read for what other machines hold (and what this one held before a restart).
  sc.leaseBusy = false;
  sc.leaseTicks = 0;
  sc.leaseTimer = sc.leases ? setInterval(() => void sc.leaseRound(), sc.uplink.leaseRenewMs) : null;
  if (sc.leases) sc.tasks.onTurnEnd((id) => void leaseTurnEnded(sc, id));
  // a stage Task that ended gives its PBI's lease back at once (the renewal round does the same for what this missed)
  if (sc.leases) sc.tasks.onTaskEnd((_id, task) => void returnLease(sc, task));
  if (sc.leases) void sc.leaseRound();
}
