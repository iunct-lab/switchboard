/** The TaskManager's part that changes a Task's settings (see `TaskSettings`). */
import type { LlmSuggestion, SetOutcomeInput, Task } from "@switchboard/protocol";
import { archiveRefusal } from "@switchboard/protocol";
import { OutcomeNotSettableError, outcomeOf, STORED_OUTCOMES } from "../task-status.ts";
import { TaskSending } from "./sending.ts";

/** What the person changes on a Task: its permission mode, model, effort, budget, outcome, title, and whether it is archived. */
export abstract class TaskSettings extends TaskSending {
  /**
   * Change the mode of an existing task. A live session that can switch does so now (Claude at once, Codex from
   * its next turn); one that cannot is released if idle so the next turn resumes with the new mode. The change is
   * recorded in the transcript either way.
   */
  async setPermissionMode(taskId: string, mode: string): Promise<Task> {
    const task = this.mustGet(taskId);
    this.requireLocal(task);
    const why = this.checkPermissionMode(task.runner, mode);
    if (why) throw new Error(why);
    const live = this.live.get(taskId);
    // A live runner that can switch is asked first; the record only changes once it confirmed (Claude answers the
    // control request; a refusal — unknown mode, a policy — must not leave the task claiming a mode it is not in).
    if (live?.session.setPermissionMode) {
      try {
        await live.session.setPermissionMode(mode);
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        this.onEvent(taskId, live, { t: "status", text: `permission mode not changed (${msg})` });
        throw new Error(`runner refused permission mode ${mode}: ${msg}`);
      }
    }
    const updated = this.db.updateTask(taskId, { permissionMode: mode });
    if (!updated) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: updated });
    if (!live) {
      this.record(taskId, { t: "status", text: `permission mode → ${mode} (applies when the task resumes)` });
      return updated;
    }
    if (live.session.setPermissionMode) {
      this.onEvent(taskId, live, { t: "status", text: `permission mode → ${mode}` });
      return updated;
    }
    this.onEvent(taskId, live, { t: "status", text: `permission mode → ${mode} (applies to the next turn)` });
    // No live switch: this process would keep the old mode for quick follow-ups. Release it now if idle; a turn in
    // flight finishes as it is and the next turn restarts the runner (send() checks the flag).
    live.restartNext = true;
    if (updated.status !== "running" && updated.status !== "waiting") await this.release(taskId);
    return updated;
  }

  /** The LLM's proposal, arrived after the task was created. Advice: the status, the outcome and the runner stay. */
  attachLlmSuggestion(taskId: string, suggestion: LlmSuggestion): Task | null {
    const updated = this.db.attachLlmSuggestion(taskId, suggestion);
    if (updated) this.broadcast({ type: "task.updated", task: updated });
    return updated;
  }

  /**
   * Change the model of an existing task; null = back to the CLI's default. One path for every runner: the
   * process that is running keeps the model it was started with, so it is released (now if idle, else before the next
   * turn — `restartNext`) and the next turn resumes the same session with the new model.
   */
  async setModel(taskId: string, model: string | null): Promise<Task> {
    const before = this.mustGet(taskId);
    this.requireLocal(before);
    const budget = this.fableBudgetFor({ ...before, model }, before.model);
    const updated = this.db.updateTask(taskId, budget === null ? { model } : { model, budgetUsd: budget });
    if (!updated) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: updated });
    if (budget !== null) this.noteFableBudget(taskId, budget);
    const name = model ?? "CLI default";
    const live = this.live.get(taskId);
    if (!live) {
      this.record(taskId, { t: "status", text: `model → ${name} (applies when the task resumes)` });
      return updated;
    }
    this.onEvent(taskId, live, { t: "status", text: `model → ${name} (applies to the next turn)` });
    live.restartNext = true;
    live.modelChanged = true;
    if (updated.status !== "running" && updated.status !== "waiting") await this.release(taskId);
    return updated;
  }

  /**
   * Change the thinking effort of an existing task; null = back to the CLI's default. The same path as the
   * model: the process keeps the effort it was started with, so it is released (now if idle, else before the next
   * turn — `restartNext`) and the next turn resumes the same session with the new one. The caller checks the value
   * (`checkEffort`).
   */
  async setEffort(taskId: string, effort: string | null): Promise<Task> {
    this.requireLocal(this.mustGet(taskId));
    const updated = this.db.updateTask(taskId, { effort });
    if (!updated) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: updated });
    const name = effort ?? "CLI default";
    const live = this.live.get(taskId);
    if (!live) {
      this.record(taskId, { t: "status", text: `effort → ${name} (applies when the task resumes)` });
      return updated;
    }
    this.onEvent(taskId, live, { t: "status", text: `effort → ${name} (applies to the next turn)` });
    live.restartNext = true;
    if (updated.status !== "running" && updated.status !== "waiting") await this.release(taskId);
    return updated;
  }

  /** Raise (or remove) a task's budget. The over-budget hold is derived from spend vs. budget, so raising it past the spend lifts it. */
  setBudget(taskId: string, budgetUsd: number | null): Task {
    const t = this.db.updateTask(taskId, { budgetUsd });
    if (!t) throw new Error(`task ${taskId} not found`);
    this.broadcast({ type: "task.updated", task: t });
    return t;
  }

  /**
   * The person's say on what the task came to: 確認済み on / off, the outcome by hand, or both. Setting it to
   * needs_action / failed without `reviewed` takes 確認済み off, so the task is back under 要対応. The list order
   * (updatedAt) does not move.
   */
  setOutcome(taskId: string, input: SetOutcomeInput): Task {
    const cur = this.db.getTask(taskId);
    if (!cur) throw new Error(`task ${taskId} not found`);
    // waiting / error / aborted show an outcome their status decides; the other statuses take only what STORED_OUTCOMES lists for them
    if (input.outcome !== undefined && (outcomeOf(cur.status, "unknown") !== "unknown" || !STORED_OUTCOMES[cur.status].has(input.outcome))) throw new OutcomeNotSettableError(cur.status);
    const reopen = input.reviewed === undefined && input.outcome === "needs_action";
    const reviewedAt = input.reviewed === true ? Date.now() : input.reviewed === false || reopen ? null : cur.reviewedAt;
    const t = this.db.updateTask(taskId, { ...(input.outcome ? { outcome: input.outcome } : {}), reviewedAt, updatedAt: cur.updatedAt })!;
    this.broadcast({ type: "task.updated", task: t });
    return t;
  }

  /** The person's new title: kept as it is from now on, never set again automatically. */
  rename(taskId: string, title: string): Task {
    // An imported terminal session takes its title from Claude's own log on every import, so a rename would not stay
    if (this.mustGet(taskId).origin !== "switchboard") throw new Error("ターミナルから取り込んだ Task のタイトルは Claude 側のものなので変えられません");
    const t = this.db.updateTask(taskId, { title, titlePending: false })!;
    this.broadcast({ type: "task.updated", task: t });
    return t;
  }

  /** Hide a stopped Task from the list, or bring it back. Like setOutcome, the list order does not move. */
  setArchived(taskId: string, archived: boolean): Task {
    const cur = this.mustGet(taskId);
    if (archiveRefusal(cur.status)) throw new Error("a running or idle task cannot be archived");
    const t = this.db.updateTask(taskId, { archivedAt: archived ? Date.now() : null, updatedAt: cur.updatedAt })!;
    this.broadcast({ type: "task.updated", task: t });
    return t;
  }
}
