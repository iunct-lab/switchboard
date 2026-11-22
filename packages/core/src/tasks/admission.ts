/** The TaskManager's part that keeps the queue (see `TaskAdmission`). */
import type { Attachment, Task } from "@switchboard/protocol";
import { IN_FLIGHT, TERMINAL } from "../task-status.ts";
import { TaskSessions } from "./sessions.ts";
import type { TaskManager } from "./manager.ts";

/** The queue: how many runner processes may run, which waiting Task starts next when a slot frees, and releasing an idle process. */
export abstract class TaskAdmission extends TaskSessions {
  /** Why a reply that continues a session may not start now (null = it may). Defined where a direct reply is checked. */
  protected abstract resumeRefusal(task: Task): string | null;

  /** The refusal already written for a queued reply (by Task), so a tick that finds it again does not write it again. */
  private readonly refusalNoted = new Map<string, string>();

  /** Local Tasks with a turn in progress: the same count as the busy list and the backlog's stage count (running / waiting). */
  private occupied(): number {
    return [...this.db.listTasksByStatus("running"), ...this.db.listTasksByStatus("waiting")].filter((t) => t.executionMode === "local").length;
  }

  /**
   * Why a new start has to wait (null = it may start). The count is the limit; the memory is read only while something
   * runs — with nothing running no event would ever call drain() again, so a first Task is never held for memory.
   */
  private slotBlock(): { wait: string; detail: string; memory?: true; promotion?: true } | null {
    const hold = this.holdBlock();
    if (hold) return hold;
    const occupied = this.occupied();
    const max = this.maxRunners();
    if (occupied >= max) return { wait: "実行枠が埋まっているため待機", detail: `実行中 ${occupied} / 上限 ${max}` };
    const mem = occupied > 0 ? this.memoryHeadroom?.() : null;
    if (mem && mem.free < mem.safety)
      return {
        memory: true,
        wait: "空きメモリ不足のため待機",
        detail: `空き ${Math.floor(mem.free / 1048576)} MB / 安全弁 ${Math.ceil(mem.safety / 1048576)} MB`,
      };
    return null;
  }

  /** The hold on every new start (local and Cloud alike), or null. */
  protected holdBlock(): { wait: string; detail: string; promotion: true } | null {
    const hold = this.admissionHold?.();
    return hold ? { ...hold, promotion: true } : null;
  }

  /** What a new start of this Task waits for: the hold on every Task, then the run count and memory for a local one. */
  protected startBlock(task: Task): ReturnType<TaskManager["slotBlock"]> {
    return task.executionMode === "local" ? this.slotBlock() : this.holdBlock();
  }

  /** A start that goes ahead with less free memory than the `ops-kit heavy` floor (still above the safety valve): the line to write, else null. */
  protected memoryWarning(task: Task): string | null {
    if (task.executionMode !== "local" || this.occupied() === 0) return null;
    const mem = this.memoryHeadroom?.();
    if (!mem || mem.free < mem.safety || mem.free >= mem.floor) return null;
    return `空きメモリが少ない（空き ${Math.floor(mem.free / 1048576)} MB / 下限 ${Math.ceil(mem.floor / 1048576)} MB）が、安全弁（${Math.ceil(mem.safety / 1048576)} MB）以上なので続けます`;
  }

  /** Why the queue waits: null = nothing queued or no block (the memory is not read for an empty queue), "promotion" = the admission hold, "memory" = free memory below the safety valve, "slot" = the run count. */
  queueWait(): "slot" | "memory" | "promotion" | null {
    if (!this.db.listQueuedTasks()[0]) return null;
    const block = this.slotBlock();
    return block === null ? null : block.promotion ? "promotion" : block.memory ? "memory" : "slot";
  }

  /** Why a reply waiting in the queue was refused at its last start (budget, Teleport); null = not refused, or the daemon restarted since. Memory only: the record is the Task's status line. */
  queueRefusal(taskId: string): string | null {
    return this.refusalNoted.get(taskId) ?? null;
  }

  /** The admission hold has ended: start what waited for it (the same as drain()). */
  resumeAdmission(): void {
    for (const [id, live] of [...this.live]) this.flushHeldReplies(id, live);
    this.drain();
  }

  /** How many more Tasks may start now (0 while the memory is short too). */
  freeSlots(): number {
    return this.slotBlock() === null ? Math.max(0, this.maxRunners() - this.occupied()) : 0;
  }

  /**
   * A first turn that starts a process, or waits for a free slot: the row stays idle with `queued_at` and the
   * prompt, so a restart keeps the wait. Cloud Tasks start no local process and are not counted.
   */
  protected admit(task: Task, prompt: string, atts: Attachment[]): "started" | "queued" {
    const block = this.startBlock(task);
    if (block === null) {
      const warning = this.memoryWarning(task);
      if (warning) this.record(task.id, { t: "status", text: warning });
      this.startOrFail(task, prompt, atts);
      return "started";
    }
    this.db.setQueued(task.id, prompt, Date.now(), atts.map((a) => a.id));
    const position = this.db.listQueuedTasks().findIndex((t) => t.id === task.id) + 1;
    this.record(task.id, { t: "status", text: `${block.wait}（${block.detail}、待ち ${position} 番目）` });
    this.broadcast({ type: "task.updated", task: this.mustGet(task.id) });
    // Short of memory while a finished Task's process is still open: close it now rather than after its idle time; if that frees enough, the queue starts at once
    if (block.memory && this.idleLive().length > 0) void this.releaseIdleForMemory().then(() => this.drain());
    return "queued";
  }

  /** Attached processes whose Task has no turn in flight (what release() may close). */
  protected idleLive(): string[] {
    return [...this.live.keys()].filter((id) => {
      const st = this.db.getTask(id)?.status;
      return st !== undefined && !IN_FLIGHT.has(st);
    });
  }

  /** Close the processes of the Tasks whose turn ended and wait until they are gone (their memory is back). */
  protected async releaseIdleForMemory(): Promise<void> {
    await Promise.all(this.idleLive().map((id) => this.releaseAndWait(id)));
  }

  /**
   * Start the waiting Tasks, oldest first, while a slot is free. Called wherever a Task leaves running / waiting, when
   * the limit changes, at the daemon's start and on a timer (`drainTickMs`) that does nothing while the queue is empty. A process left open after its turn (nothing in
   * flight) is closed first so that the processes do not outnumber the limit.
   */
  drain(): void {
    if (this.draining || this.stopped || this.holdQueue) return;
    const waiting = this.db.listQueuedTasks();
    // a refusal is written once per stay in the queue: a Task that left it (aborted, even with every slot taken) is forgotten
    for (const id of [...this.refusalNoted.keys()]) if (!waiting.some((t) => t.id === id)) this.refusalNoted.delete(id);
    if (!waiting[0]) return; // nothing waits: do not read the memory
    this.draining = true;
    try {
      while (this.freeSlots() > 0) {
        const queued = this.db.listQueuedTasks();
        // a queued reply (the Task has a session) goes through the same refusals as a direct one; one that is refused
        // keeps its place and the Tasks behind it may start. A first prompt has no session and no refusal.
        const next = queued.find((t) => {
          const refusal = t.runnerSessionId === null ? null : this.resumeRefusal(t);
          if (refusal === null) return true;
          if (this.refusalNoted.get(t.id) !== refusal) {
            this.refusalNoted.set(t.id, refusal);
            this.record(t.id, { t: "status", text: `実行枠が空きましたが、この返信はまだ始めません（${refusal}）。待ち列に残します` });
          }
          return false;
        });
        if (!next) break;
        this.refusalNoted.delete(next.id);
        const taken = this.db.takeQueued(next.id);
        if (taken === null) continue;
        const { prompt } = taken;
        for (const [id] of this.live) {
          if (this.live.size < this.maxRunners()) break;
          const st = this.db.getTask(id)?.status;
          if (st && !IN_FLIGHT.has(st)) void this.release(id); // takes the entry out of `live` at once
        }
        this.record(next.id, { t: "status", text: "実行枠が空いたので開始" });
        // the files the queued turns were sent with, by id (an earlier turn's files are not sent again; a shadow's are its source's)
        const atts = taken.attachmentIds.flatMap((id) => this.attachments?.get(id) ?? []);
        const task = this.mustGet(next.id);
        const warning = this.memoryWarning(task);
        if (warning) this.record(task.id, { t: "status", text: warning });
        try {
          const { resume, preamble } = this.resumeArgs(task); // a queued reply continues the session the Task had
          this.startOrFail(this.withResolvedMode(task), prompt, atts, resume, preamble);
          this.notifyQueuedStart(next.id, { ok: true }, taken.resume);
        } catch (e) {
          // startOrFail wrote the error on the row; the next one may still start
          this.notifyQueuedStart(next.id, { ok: false, message: String((e as Error).message ?? e) }, taken.resume);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** One listener's failure must not skip the others or the drain. */
  private notifyQueuedStart(taskId: string, r: { ok: true } | { ok: false; message: string }, resume: boolean): void {
    for (const l of this.queuedStartListeners) {
      try {
        l(taskId, r, resume);
      } catch (e) {
        console.error(`task ${taskId}: queued-start listener failed:`, e);
      }
    }
  }

  /** Release the idle task's process and wait until every close of it in flight, earlier ones included, has finished. */
  async releaseAndWait(taskId: string): Promise<void> {
    await this.release(taskId);
    await this.closing.get(taskId);
  }

  /** Release the runner process of an idle task (no turn in flight). The task keeps its status; the next turn resumes. */
  async release(taskId: string, opts: { graceMs?: number } = {}): Promise<boolean> {
    const live = this.live.get(taskId);
    if (!live) return false;
    const task = this.db.getTask(taskId);
    if (task && !TERMINAL.has(task.status) && task.status !== "idle") return false;
    this.disarmIdle(live);
    this.live.delete(taskId);
    await this.track(taskId, live.session.close(opts));
    return true;
  }

  protected track(taskId: string, p: Promise<void>): Promise<void> {
    const done = p.catch(() => undefined).finally(() => {
      if (this.closing.get(taskId) === done) this.closing.delete(taskId);
      this.maybeEnded(taskId);
    });
    this.closing.set(taskId, done);
    return done;
  }
}
