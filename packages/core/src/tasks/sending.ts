/** The TaskManager's part that takes a prompt or a reply to a Task (see `TaskSending`). */
import { WORK_MACHINE_OFF } from "../machine.ts";
import { dirname } from "node:path";
import type { Attachment, Task } from "@switchboard/protocol";
import { REPLY_QUEUED } from "@switchboard/protocol";
import { withAttachments } from "../attachments.ts";
import { IN_FLIGHT } from "../task-status.ts";
import { answerableStops } from "../stops.ts";
import { type LiveSession, ResumeSupersededError } from "./state.ts";
import { TaskAdmission } from "./admission.ts";
import type { TaskManager } from "./manager.ts";

/** A prompt or a reply on its way to a Task: checked, queued while no slot is free or a hold is on, then given to the runner. */
export abstract class TaskSending extends TaskAdmission {
  /** Moves a wait's next look without counting as a change of the task: `updatedAt` stays, a `## 回答` during the wait stays newer. */
  deferResume(taskId: string, resumeAt: number): void {
    const t = this.db.updateTask(taskId, { resumeAt, updatedAt: this.mustGet(taskId).updatedAt });
    if (t) this.broadcast({ type: "task.updated", task: t });
  }

  /**
   * Plan (or forget) a resume after a usage-limit stop, a GitHub limit or a full disk (`reason`). Any turn that starts
   * clears it. `wait`: the quota window that stopped the turn and when, for resuming early; and, when `resumeAt`
   * is a try before a long wait, the time the wait goes back to (`plannedAt`). Absent = none.
   */
  setResumeAt(taskId: string, resumeAt: number | null, reason: NonNullable<Task["resumeReason"]> = "limit", wait: { window?: string | null; since?: number | null; plannedAt?: number | null } = {}): Task {
    if (resumeAt !== null) this.requireLocal(this.mustGet(taskId));
    const on = resumeAt !== null;
    const t = this.db.updateTask(taskId, { resumeAt, resumeReason: on ? reason : null, resumeWindow: on ? (wait.window ?? null) : null, resumeSince: on ? (wait.since ?? null) : null, resumePlannedAt: on ? (wait.plannedAt ?? null) : null, ...(on ? {} : { deferredPrompt: null }) });
    if (!t) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: t });
    if (resumeAt === null) for (const l of this.planForgottenListeners) l(taskId);
    return t;
  }

  /** The first turn of a Task made without starting: the plan and the held prompt go, the prompt is sent as an ordinary first turn. */
  async startDeferred(taskId: string): Promise<Task> {
    const t = this.mustGet(taskId);
    if (t.resumeReason !== "start" || t.deferredPrompt === null) throw new Error(`task ${taskId} is not waiting to start`);
    const prompt = t.deferredPrompt;
    this.setResumeAt(taskId, null); // also drops deferredPrompt
    try {
      return await this.send(taskId, prompt, { mirror: false });
    } catch (e) {
      // refused before a runner started (e.g. a Terminal holds the folder): the plan and the prompt come back, so the Task can still start
      const cur = this.db.getTask(taskId);
      if (cur && cur.runnerSessionId === null && cur.status === "idle") {
        const back = this.db.updateTask(taskId, { resumeAt: t.resumeAt, resumeReason: "start", deferredPrompt: prompt });
        if (back) this.broadcast({ type: "task.updated", task: back });
      }
      throw e;
    }
  }

  /**
   * Widen a task's scope to where its attachments live (a turn on a task created without any, or a shadow reading
   * the primary's files). A live runner only learns its roots at start, so it is flagged to restart with --resume;
   * whether that happens on this very turn is decided (and said) in sendOne.
   */
  private widenScope(task: Task, dirs: string[]): { task: Task; widened: boolean } {
    const missing = dirs.filter((d) => !task.scope.includes(d));
    if (!missing.length) return { task, widened: false };
    const updated = this.db.updateTask(task.id, { scope: [...task.scope, ...missing] });
    if (!updated) return { task, widened: false };
    this.broadcast({ type: "task.updated", task: updated });
    const live = this.live.get(task.id);
    if (live) live.restartNext = true;
    return { task: updated, widened: true };
  }

  /**
   * Follow-up turn. A turn sent to a primary task is copied to its shadow once the primary took it; a turn sent
   * to the shadow itself stays there. A shadow the user stopped (`shadowStopped`, set by abort()) is left alone;
   * so is one waiting on an approval (a turn pushed into it would end the open confirmation as denied on DAK) — that
   * is noted on both sides, and the person can send the text to the shadow by hand after answering. Anything else
   * — done, errored, aborted by a daemon restart, mid-turn (queued by the adapter) — gets the copy. A copy that
   * fails (a budget the user put on the shadow, a runner that will not resume) is noted on both transcripts, since
   * the person is looking at the primary; it is never raised here. `mirror: false` (the resumer's 今すぐ再開) and
   * `asResume` turns (the daemon continuing this task after its own runner's limit lifted) are not copied —
   * the shadow's runner was not stopped by that. `daemon` (the daemon continuing a task whose waits closed) is
   * the daemon's own turn with no plan behind it: it is not copied, answers no stop, clears no planned resume, and is
   * refused (ResumeSupersededError) while the task runs, waits or has a resume planned, or when 中断 or a reply came
   * while it waited for the runner's process to close. Any turn that needs a new process while the run slots or the
   * memory are short (a person's reply, an `asResume` or a `daemon` turn alike) waits in the queue instead of failing:
   * drain() starts it with --resume once there is room.
   */
  async send(taskId: string, text: string, opts: { asResume?: boolean; daemon?: boolean; mirror?: boolean; attachmentIds?: string[] } = {}): Promise<Task> {
    // Everything that can refuse the turn (unknown task, a superseded resume, the budget) runs before any file moves:
    // a refused turn leaves the uploads in the inbox, reusable. Attachments are taken once, by the primary;
    // the shadow reads the same files (its scope is widened to them).
    await this.preflight(taskId, opts);
    const atts = this.takeAttachments(opts.attachmentIds, taskId);
    this.recordAttachments(taskId, atts);
    text = withAttachments(text, atts);
    const before = this.db.nextSeq(taskId);
    const task = await this.dispatch(taskId, text, atts, !!(opts.asResume || opts.daemon));
    // The person's turn answers the task's open stops, by its user message (none echoed = nothing recorded).
    if (!opts.asResume && !opts.daemon) {
      // a reply put in the queue echoes no message yet (it is sent when the Task starts): the status line that says so is the answer
      const added = this.db.listEvents(taskId, before - 1);
      const said = added.find((e) => e.ev.t === "message.delta" && e.ev.role === "user") ?? added.find((e) => e.ev.t === "status" && e.ev.text.startsWith(REPLY_QUEUED));
      if (said) this.moveOpenStops(taskId, (s) => ({ ...s, answer: { ref: `seq:${said.seq}`, at: said.ts } }), answerableStops);
    }
    const shadow = opts.asResume || opts.daemon || opts.mirror === false ? null : this.db.shadowTaskOf(taskId);
    if (shadow && !shadow.shadowStopped) {
      if (shadow.status === "waiting") {
        this.record(shadow.id, { t: "status", text: "並走元への返信は写しませんでした: この Task は承認待ちです。答えたあと、必要なら同じ文面をここに直接送ってください" });
        this.record(taskId, { t: "status", text: `並走（${shadow.runner}）は承認待ちのため返信を写しませんでした。承認に答えたあと、並走に直接送れます` });
      } else {
        this.recordAttachments(shadow.id, atts);
        this.sendOne(shadow.id, text, { atts }).catch((e) => {
          const msg = String((e as Error).message ?? e);
          this.record(shadow.id, { t: "status", text: `並走の返信を送れませんでした（${msg}）` });
          this.record(taskId, { t: "status", text: `並走（${shadow.runner}）に返信を写せませんでした（${msg}）。ここから先の会話は並走と食い違います` });
        });
      }
    }
    return task;
  }

  /**
   * One task's follow-up turn. Reuses the live process; otherwise restarts the runner with --resume once any release
   * has finished. A person's turn supersedes a planned resume the moment it is asked for; the resumer's own
   * turn (`asResume`) only goes out if the plan is still there after the wait — a reply or 中断 that landed meanwhile
   * wins (ResumeSupersededError, nothing sent).
   */
  private async sendOne(taskId: string, text: string, opts: { asResume?: boolean; atts?: Attachment[] } = {}): Promise<Task> {
    await this.preflight(taskId, opts);
    return this.dispatch(taskId, text, opts.atts ?? [], !!opts.asResume);
  }

  /** The checks that can refuse a turn, before anything is moved or recorded. Throws; returns the task as it stands. */
  private async preflight(taskId: string, opts: { asResume?: boolean; daemon?: boolean }): Promise<Task> {
    let task = this.mustGet(taskId);
    this.requireLocal(task);
    // a turn nobody asked for is the daemon deciding by itself: a work machine has none
    if (opts.daemon && this.workMachine) throw new Error(WORK_MACHINE_OFF);
    await this.turnGate?.(task, opts.asResume || opts.daemon ? "daemon" : "person");
    this.beforeResume?.(task);
    if (!opts.asResume && !opts.daemon) {
      if (task.resumeAt !== null) task = this.setResumeAt(taskId, null);
      else for (const l of this.planForgottenListeners) l(taskId);
    }
    // a daemon turn has no plan for 中断 or a reply to clear: while it waits here, either one forgets "the plan"
    // (both call the plan-forgotten listeners), and the turn gives up
    let moved = false;
    const off = opts.daemon ? this.onPlanForgotten((id) => void (id === taskId && (moved = true))) : null;
    try {
      await this.closing.get(taskId);
    } finally {
      off?.();
    }
    task = this.mustGet(taskId);
    if (moved) throw new ResumeSupersededError("中断 or a reply came meanwhile");
    if (opts.asResume) {
      if (task.resumeAt === null) throw new ResumeSupersededError("the plan was cleared meanwhile");
      if (IN_FLIGHT.has(task.status)) throw new ResumeSupersededError(`the task is ${task.status}`);
      task = this.setResumeAt(taskId, null);
    }
    if (opts.daemon) {
      if (task.resumeAt !== null) throw new ResumeSupersededError("a resume is planned");
      if (IN_FLIGHT.has(task.status)) throw new ResumeSupersededError(`the task is ${task.status}`);
    }
    const refusal = this.resumeRefusal(task);
    if (refusal !== null) throw new Error(refusal);
    return task;
  }

  /**
   * Why a reply that continues this Task's session may not start now (null = it may): a Teleport Terminal holds the
   * folder, or the budget is spent. preflight() throws it for a direct reply; drain() asks it before starting a queued one.
   */
  protected resumeRefusal(task: Task): string | null {
    try {
      this.beforeResume?.(task);
    } catch (e) {
      return String((e as Error).message ?? e);
    }
    return this.isOverBudget(task.id) ? `budget exceeded ($${task.budgetUsd}); raise the budget to continue` : null;
  }

  /**
   * A reply that cannot start a process now waits in the queue (the row stays `idle` with `queued_at`, so a restart
   * keeps it). A Task already waiting gets the reply after its prompt; drain() starts it with --resume.
   */
  private queueReply(task: Task, text: string, block: ReturnType<TaskManager["slotBlock"]>, atts: Attachment[], resume: boolean): Task {
    this.db.queueReply(task.id, text, Date.now(), atts.map((a) => a.id), { resume });
    const position = this.db.listQueuedTasks().findIndex((t) => t.id === task.id) + 1;
    // the whole reply: the input box is cleared, and this line is where the text stays in the log until the Task starts
    this.record(task.id, { t: "status", text: `${REPLY_QUEUED}（${block?.wait ?? "待ち列にいます"}${block ? `、${block.detail}` : ""}、待ち ${position} 番目）: 「${text.trim()}」` });
    this.broadcast({ type: "task.updated", task: this.mustGet(task.id) });
    // the same as a first prompt (admit): short of memory with a finished Task's process open = close it now, then look again
    if (block?.memory && this.idleLive().length > 0) void this.releaseIdleForMemory().then(() => this.drain());
    return this.mustGet(task.id);
  }

  /**
   * Hand the text to the runner: the live process, or a restart with --resume. `auto` = a turn nobody asked for (a resume, a daemon turn): if it waits in the queue it is marked so. `atts` = the turn's attachments: the
   * scope must cover their folders, and the adapter gets them with the text (DAK sends the contents).
   */
  private async dispatch(taskId: string, text: string, atts: Attachment[], auto: boolean): Promise<Task> {
    let task = this.mustGet(taskId);
    const dirs = Array.from(new Set(atts.map((a) => dirname(a.path))));
    let widened = false;
    if (dirs.length) ({ task, widened } = this.widenScope(task, dirs));
    // a Task still in the queue starts from drain() with its first prompt: the reply goes after it
    if (task.queuedAt !== null) return this.queueReply(task, text, this.startBlock(task), atts, auto);
    const live = this.live.get(taskId);
    // a new turn is a new start: under the hold a process left open after its turn is closed and the reply waits (a turn
    // in flight is sent to as before). A process still running background jobs keeps them: the reply waits on it
    // (heldReplies) and is dispatched when the jobs and turns are over or the hold ends.
    if (live && task.status === "background") {
      const hold = this.holdBlock();
      if (hold) {
        (live.heldReplies ??= []).push(text);
        // the input box is cleared: this line is where the text stays in the log until the Task is queued
        this.record(taskId, { t: "status", text: `${REPLY_QUEUED}（${hold.wait}、裏の処理の終わりを待って待ち列に入れます、${hold.detail}）: 「${text.trim()}」` });
        this.broadcast({ type: "task.updated", task: this.mustGet(taskId) });
        return this.mustGet(taskId);
      }
    }
    if (live && !IN_FLIGHT.has(task.status)) {
      const hold = this.holdBlock();
      if (hold && (await this.release(taskId))) {
        this.queueReply(this.mustGet(taskId), text, hold, atts, auto);
        this.drain(); // the hold may have lifted while the process closed
        return this.mustGet(taskId);
      }
    }
    // A process flagged for restart is released first; release() refuses while a turn is in flight, and then the
    // live process takes the text as before (the mode change waits for the next turn) — never two processes.
    if (live && (!live.restartNext || !(await this.release(taskId)))) {
      if (widened) {
        this.onEvent(taskId, live, { t: "status", text: "添付ディレクトリを scope に加えました。実行中のプロセスには渡せないため、この返信の添付を読むときに承認が出ることがあります。次のターンで再開します" });
      }
      this.disarmIdle(live);
      live.turnErrors = [];
      live.turnQuota = undefined;
      live.turnQuestion = undefined;
      live.lastEventAt = Date.now();
      live.session.send(text, atts);
      return this.setStatus(taskId, "running");
    }
    if (widened && live) this.record(taskId, { t: "status", text: "添付ディレクトリを scope に加えたので、プロセスを再開します（--resume）" });
    task = this.mustGet(taskId); // the release above was awaited: a model or mode chosen meanwhile is the one to start with
    // no process, and no slot for a new one (preflight saw a live process that a release above may have closed): wait in the queue
    const block = this.startBlock(task);
    if (block !== null) return this.queueReply(task, text, block, atts, auto);
    const { resume, preamble } = this.resumeArgs(task);
    const warning = this.memoryWarning(task);
    if (warning) this.record(taskId, { t: "status", text: warning });
    this.startOrFail(this.withResolvedMode(task), text, atts, resume, preamble);
    return this.mustGet(taskId);
  }

  /**
   * Replies held under the admission hold on a process with background jobs: while the Task is still on its jobs or in a
   * turn and the hold stands, they keep waiting. Otherwise they go through dispatch as one reply sent now: under the hold
   * the process is closed and the reply queued, without it the process (or a resume) takes it. A planned automatic
   * resume is dropped, the same as for a person's reply (this reply is the next turn). An aborted Task drops them (中断
   * means it does not come back on its own; abort() drops them first), and so does a daemon that is stopping.
   */
  protected flushHeldReplies(taskId: string, live: LiveSession): void {
    const texts = live.heldReplies;
    const task = this.db.getTask(taskId);
    if (!texts?.length || !task) return;
    if ((task.status === "background" || IN_FLIGHT.has(task.status)) && this.holdBlock()) return;
    live.heldReplies = undefined;
    if (task.status === "aborted" || this.stopped) {
      this.record(taskId, { t: "status", text: task.status === "aborted" ? "中断したので、保留した返信は渡しません" : "デーモンが止まるので、保留した返信は渡しません" });
      return;
    }
    if (task.resumeAt !== null) this.setResumeAt(taskId, null);
    this.dispatch(taskId, texts.join("\n\n"), [], false).catch((e) => this.record(taskId, { t: "error", message: `保留した返信を渡せませんでした: ${String((e as Error).message ?? e)}` }));
  }
}
