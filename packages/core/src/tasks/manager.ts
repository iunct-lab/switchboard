/**
 * `TaskManager`: the last class of the chain under tasks/, with making a Task (and its shadow and its forks), answering
 * a permission, aborting and shutting down. The workspace's rules a first prompt carries and a Task's provisional
 * title are here too.
 */
import type { Attachment, CreateTaskInput, PermissionDecision, RoutingSuggestion, RunnerId, Task } from "@switchboard/protocol";
import { withAttachments } from "../attachments.ts";
import { newId } from "../db.ts";
import { planResumeAfterStop } from "../interrupted.ts";
import { IN_FLIGHT, TERMINAL } from "../task-status.ts";
import { oneLine } from "../suggest-llm.ts";
import { type LiveSession, type NewTaskInput, isFableModel } from "./state.ts";
import { TaskSettings } from "./settings.ts";

/** A workspace's rules kept on Switchboard's side, as the block added after a Task's first prompt. */
const RULES_HEADING = "## このリポジトリの決まり（Switchboard の側に置いたもの。リポジトリの git には無い）";
export function workspaceRulesBlock(rules: string): string {
  return `${RULES_HEADING}\n\n${rules.trim()}`;
}

/** A first prompt without the rules block `create()` added after it: what the person asked, for naming the Task. */
export function withoutWorkspaceRules(prompt: string): string {
  const at = prompt.lastIndexOf(`\n\n${RULES_HEADING}\n\n`);
  return at < 0 ? prompt : prompt.slice(0, at);
}

/** The title a task has until its first turn ends: the head of the prompt, on one line. */
export function provisionalTitle(prompt: string): string {
  return oneLine(prompt).slice(0, 48);
}

/**
 * TaskManager owns the lifecycle: create → start adapter → persist/broadcast events → status transitions → ledger.
 * It never decides anything on the agent's behalf: permissions wait for the user, except where the user wrote an
 * explicit allow rule in Knowledge, which is applied and recorded as by: rule (System ENABLES, Agent DECIDES, User APPROVES).
 */
export class TaskManager extends TaskSettings {
  /**
   * Fork: a new Task that continues `parentId`'s conversation up to the turn that ended at `seq` (a `session.end`),
   * then goes its own way. Nothing starts here: the child is idle with no session, and its first reply starts a
   * forked runner session (startSession). The child shares the parent's working tree. Throws when the turn cannot
   * be forked from (the message says why).
   */
  forkTask(parentId: string, seq: number): Task {
    const parent = this.mustGet(parentId);
    this.requireOwn(parent);
    if (parent.executionMode === "cloud") throw new Error("Cloud Task は分岐できません");
    const adapter = this.adapters.get(parent.runner);
    if (!adapter) throw new Error(`runner "${parent.runner}" is not installed`);
    if (!(this.runnerForks ? this.runnerForks(parent.runner) : adapter.forks === true)) throw new Error(`${parent.runner} は過去のターンからの分岐に対応していません`);
    const end = this.db.getEvent(parentId, seq)?.ev;
    if (end?.t !== "session.end") throw new Error(`seq ${seq} はターンの終わりではありません`);
    if (end.status !== "ok") throw new Error("エラーまたは中断で終わったターンからは分岐できません");
    if (!end.turn) throw new Error("このターンには分岐の目印がありません（古い記録です）");
    // the turn's pointer belongs to the session that turn ran in, which need not be the parent's current one
    const sid = this.db.sessionAt(parentId, seq);
    if (!sid || adapter.hasSession?.(sid) === false) throw new Error("分岐元のセッションがこの機械にありません");
    const now = Date.now();
    const child: Task = {
      id: newId("task"),
      workspaceId: parent.workspaceId,
      title: `${parent.title}（分岐）`,
      runner: parent.runner,
      cwd: parent.cwd,
      scope: parent.scope,
      status: "idle",
      runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null,
      model: parent.model,
      routing: null,
      budgetUsd: parent.budgetUsd,
      scheduleId: null,
      permissionMode: parent.permissionMode,
      effort: parent.effort,
      subagentEffort: parent.subagentEffort,
      subagentModel: parent.subagentModel,
      origin: "switchboard",
      resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null,
      forkOf: parent.id, forkSeq: seq, forkTurn: end.turn,
      shadowOf: null,
      shadowStopped: false,
      workspaceReason: parent.workspaceReason,
      titlePending: false,
      outcome: "unknown",
      reviewedAt: null,
      archivedAt: null,
      judgedResult: null,
      judgedReason: null,
      judgedBy: null, judgingAt: null,
      stage: null,
      statusAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertTask(child);
    this.record(child.id, { t: "status", text: "分岐元の Task の、分岐したターンまでの会話を引き継いでいます。ファイルは分岐元と同じ作業ツリーです" });
    const created = this.mustGet(child.id);
    this.broadcast({ type: "task.updated", task: created });
    return created;
  }

  /**
   * `precomputed` is for the one caller that has to run the router before this point: `POST /api/tasks` with LLM
   * suggestions on awaits an async suggester, which cannot happen inside this synchronous method. It is still
   * the daemon's own suggestion for this very input — never anything a client sent — and everything else (the
   * scheduler) keeps getting the rule table computed here. `afterInsert` runs once the row exists and
   * before the runner starts: what the suggestion turns cost is billed there, so a task that then fails to start (it
   * stays, as an error task) still carries it.
   */
  checkCloudInput(input: Omit<CreateTaskInput, "executionMode"> & { executionMode?: string }): string | undefined {
    if (input.executionMode !== "cloud") return;
    if (input.runner !== "claude") return "Cloud は Claude だけを選択できます。";
    if (!input.cwd && !input.workspaceId) return "Cloud は Workspace を明示選択してください。";
    if (input.model !== undefined || input.permissionMode !== undefined || input.effort !== undefined || input.budgetUsd !== undefined || input.scheduleId !== undefined || input.shadowRunner || input.attachmentIds?.length || input.scope?.some((p) => p !== input.cwd)) return "Cloud はモデル・権限・予算・スケジュール・並走・添付・追加scopeを指定できません。公式 Web で操作してください。";
  }

  /**
   * `opts.deferUntil`: the row is made without starting a runner (status idle); `resumeAt` = that time and
   * `resumeReason` = "start", and the prompt waits in `deferredPrompt` for `startDeferred` (the resume tick, or 今すぐ再開).
   */
  create(given: NewTaskInput, precomputed?: RoutingSuggestion, afterInsert?: (task: Task) => void, opts: { deferUntil?: number } = {}): Task {
    // the workspace's rules kept on Switchboard's side go after the first prompt, whatever route made the Task —
    // except the one whose prompt has to stay the whole message
    const rules = given.workspaceId && !this.isBareCommand(given.scheduleId) ? this.db.getWorkspace(given.workspaceId)?.rules : undefined;
    const withRules = (prompt: string) => (rules ? `${prompt}\n\n${workspaceRulesBlock(rules)}` : prompt);
    const input = rules ? { ...given, prompt: withRules(given.prompt) } : given;
    const why = this.checkCloudInput(input);
    if (why) throw new Error(why);
    const cloud = input.executionMode === "cloud";
    const adapter = this.adapters.get(input.runner);
    if (!adapter) throw new Error(`runner "${input.runner}" is not installed`);
    // no row for a refused start; a schedule and a stage Task come through here too
    const unconfirmed = this.unconfirmedRunnerConfig(input);
    if (unconfirmed) throw unconfirmed;
    const now = Date.now();
    const id = newId("task");
    // Attachments: their directory (deterministic from the id) is in the scope from the start so the first
    // turn can read them without asking; the files themselves move only once nothing else can refuse the creation.
    const attDir = input.attachmentIds?.length ? this.attachmentDir(id) : null;
    const scope = Array.from(new Set([input.cwd, ...(input.scope ?? []), ...(attDir ? [attDir] : [])]));
    const permissionMode = cloud ? null : this.resolvePermissionMode(input.runner, input.permissionMode);
    const saved = cloud ? undefined : this.runnerDefaults?.(input.runner);
    const model = input.model || saved?.model || undefined;
    // a saved effort the CLI no longer offers is dropped (the CLI's own default), never a refusal to create
    const savedEffort = saved?.effort && !this.checkEffort(input.runner, saved.effort) ? saved.effort : undefined;
    const effort = input.effort || savedEffort || null;
    const whyEffort = effort === null ? undefined : this.checkEffort(input.runner, effort);
    if (whyEffort) throw new Error(whyEffort);
    const suggestion = cloud ? undefined : precomputed ?? this.suggest?.(given, scope); // the routing reads the request alone
    const task: Task = {
      id,
      workspaceId: input.workspaceId ?? null,
      title: input.title ?? provisionalTitle(given.prompt), // the request's own words, not the rules added after them
      runner: input.runner,
      cwd: input.cwd,
      scope,
      status: "idle",
      runnerSessionId: null, executionMode: input.executionMode ?? "local", cloudSession: null, sourceCloudTaskId: null,
      model: model ?? null,
      routing: suggestion ? { suggested: suggestion.runner, ruleId: suggestion.ruleId, reason: suggestion.reason, overridden: suggestion.runner !== input.runner, llm: suggestion.llm ?? null } : null,
      budgetUsd: input.budgetUsd ?? (!cloud && isFableModel(model) ? this.defaultFableBudget?.() ?? null : null),
      scheduleId: input.scheduleId ?? null,
      permissionMode,
      effort,
      subagentEffort: cloud ? null : this.subagentEffort?.(input.runner) ?? null,
      subagentModel: cloud ? null : this.subagentModel?.(input.runner) ?? null,
      origin: input.origin ?? "switchboard",
      resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null,
      shadowOf: null,
      forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false,
      workspaceReason: input.workspaceReason ?? null,
      titlePending: input.title === undefined,
      outcome: "unknown",
      reviewedAt: null,
      archivedAt: null,
      judgedResult: null,
      judgedReason: null,
      judgedBy: null, judgingAt: null,
      stage: input.stage ?? null,
      statusAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const atts = this.takeAttachments(input.attachmentIds, id); // a bad id throws here: no row, nothing moved
    const prompt = withAttachments(input.prompt, atts);
    if (opts.deferUntil !== undefined) {
      task.resumeAt = opts.deferUntil;
      task.resumeReason = "start";
      task.deferredPrompt = prompt;
    }
    this.db.insertTask(task);
    afterInsert?.(task);
    this.recordAttachments(task.id, atts);
    if (opts.deferUntil !== undefined) return this.db.getTask(task.id) ?? task; // no runner, no shadow: the first turn starts both
    this.admit(task, prompt, atts);
    // a prompt the app wrote is written again for the shadow's runner; the person's own words are copied as they are
    this.startShadow(task, input, given.promptFor ? (runner) => withAttachments(withRules(given.promptFor!(runner)), atts) : () => prompt, atts);
    return this.db.getTask(task.id) ?? task;
  }

  /**
   * Shadow run: the same prompt on a second runner, as its own task linked by `shadowOf`. The primary is
   * already running; nothing here may fail it — an unavailable default runner or a runner that will not start is
   * noted in the primary's transcript instead. Copied: workspace, cwd / scope, title, the prompt, the budget (the
   * same cap on each side — a paid shadow is capped like the primary, a free runner never reaches it). Not copied: routing (routing_log is
   * training data for the LLM routing suggestion and the shadow was not a decision), scheduleId (the schedule did not run it), the
   * permission mode (modes are runner-native; the shadow gets its own runner's saved / adapter default, and the
   * primary's transcript says which — the two may differ in what they can touch in the shared cwd).
   */
  private startShadow(primary: Task, input: NewTaskInput, promptFor: (runner: RunnerId) => string, atts: Attachment[]) {
    if (primary.executionMode === "cloud") return;
    // The saved default is for the built-in runners: a Task on an ADK server added in Settings gets a shadow only when
    // its creation asks for one (a second runner on the same prompt is not what that server's agent was added for).
    const saved = primary.runner.startsWith("custom:") ? null : (this.defaultShadowRunner?.() ?? null);
    const runner = input.shadowRunner === undefined ? saved : input.shadowRunner;
    if (!runner) return;
    if (runner === primary.runner) {
      this.record(primary.id, { t: "status", text: `並走（${runner}）は主ランナーと同じなので作りません` });
      return;
    }
    if (!this.adapters.get(runner)) {
      this.record(primary.id, { t: "status", text: `並走（${runner}）は未検出のため作りません` });
      return;
    }
    const now = Date.now();
    const permissionMode = this.resolvePermissionMode(runner);
    const shadow: Task = {
      id: newId("task"),
      workspaceId: primary.workspaceId,
      title: primary.title,
      runner,
      cwd: primary.cwd,
      scope: primary.scope,
      status: "idle",
      runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null,
      model: null,
      routing: null,
      budgetUsd: primary.budgetUsd,
      scheduleId: null,
      permissionMode,
      effort: null, // another runner: its own list, so the CLI default
      subagentEffort: this.subagentEffort?.(runner) ?? null, // the shadow runner's own setting (a shadow is always local)
      subagentModel: this.subagentModel?.(runner) ?? null,
      origin: "switchboard",
      resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null,
      shadowOf: primary.id,
      forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false,
      workspaceReason: primary.workspaceReason,
      titlePending: false, // the list shows the primary's title
      outcome: "unknown",
      reviewedAt: null,
      archivedAt: null,
      judgedResult: null,
      judgedReason: null,
      judgedBy: null, judgingAt: null,
      stage: null,
      statusAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertTask(shadow);
    this.recordAttachments(shadow.id, atts);
    try {
      if (this.admit(shadow, promptFor(runner), atts) === "queued") {
        this.record(primary.id, { t: "status", text: `並走（${runner}）は実行枠待ちです。枠が空くと始まります` });
        return;
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      this.record(shadow.id, { t: "error", message: msg });
      this.setStatus(shadow.id, "error");
      this.record(primary.id, { t: "status", text: `並走（${runner}）を起動できませんでした（${msg}）` });
      return;
    }
    this.record(primary.id, {
      t: "status",
      text: `並走（${runner}）を開始 — 承認モード: ${permissionMode ?? "ランナー側の設定で決まる"}（主の ${primary.permissionMode ?? "ランナー側の設定"} は引き継がれない）。返信はここから写される`,
    });
  }

  respondPermission(taskId: string, id: string, decision: PermissionDecision): Task {
    this.requireLocal(this.mustGet(taskId));
    const live = this.live.get(taskId);
    if (!live) throw new Error("task has no live runner session");
    if (!live.pendingPermissions.has(id)) throw new Error(`no pending permission ${id}`);
    const host = live.hostAsks.get(id);
    if (host) {
      live.hostAsks.delete(id);
      live.pendingPermissions.delete(id);
      host(decision);
      this.onEvent(taskId, live, { t: "permission.resolved", id, decision, by: "user" });
      return this.afterAnswer(taskId, live);
    }
    live.session.respondPermission(id, decision, undefined, "user");
    live.pendingPermissions.delete(id);
    return this.afterAnswer(taskId, live);
  }

  /** An answer moves a turn in flight on; a finished task that was only holding the ask keeps its status. */
  private afterAnswer(taskId: string, live: LiveSession): Task {
    const t = this.mustGet(taskId);
    return IN_FLIGHT.has(t.status) ? this.setStatus(taskId, live.pendingPermissions.size ? "waiting" : "running") : t;
  }

  async abort(taskId: string): Promise<Task> {
    this.requireOwn(this.mustGet(taskId));
    const live = this.live.get(taskId);
    if (live?.heldReplies?.length) {
      const dropped = live.heldReplies;
      live.heldReplies = undefined; // the process leaves `live` before the status moves: drop what was held here
      this.record(taskId, { t: "status", text: "中断したので、保留した返信は渡しません" });
      for (const r of dropped) r.dropped?.();
    }
    let task = this.mustGet(taskId);
    if (task.executionMode === "cloud") {
      if (live) { await live.session.close(); this.live.delete(taskId); }
      this.record(taskId, { t: "status", text: "開始プロセスを閉じました。Cloud 作業の停止は確認していません。公式 Web で操作してください。" });
      return this.updateCloudState(taskId);
    }
    // A Task still waiting for a slot has no process: it leaves the wait and ends here
    if (!live && task.queuedAt !== null && this.db.takeQueued(taskId) !== null) {
      this.record(taskId, { t: "status", text: "実行枠待ちを取り消し" });
      task = this.mustGet(taskId);
    }
    // 中断 also means "do not come back to this on its own".
    // 中断 forgets any planned resume — a plan still waiting for its GitHub budget read too (onPlanForgotten);
    // a finished task with no plan is not rewritten (its updatedAt is what the backlog reads)
    if (task.resumeAt !== null) task = this.setResumeAt(taskId, null);
    else for (const l of this.planForgottenListeners) l(taskId);
    // Stopping a shadow is the user saying "no more copies" — whatever state it is in (mid-turn, done, error).
    // Only this path sets the flag: a daemon restart that closes a shadow as aborted does not detach it.
    const primaryId = task.shadowOf;
    if (primaryId && !task.shadowStopped) {
      task = this.db.updateTask(taskId, { shadowStopped: true }) ?? task;
      this.broadcast({ type: "task.updated", task });
      this.record(taskId, { t: "status", text: "並走を停止: 以後、並走元への返信はここに写されません（ここへ直接送ることはできます）" });
      this.record(primaryId, { t: "status", text: `並走（${task.runner}）を停止しました。以後の返信は写されません` });
    }
    // Stopping the primary does not stop its shadow (independent tasks), but a resume the shadow had planned on its
    // own is a turn nobody asked for any more — a paid shadow must not come back hours after the request died.
    const shadow = primaryId ? null : this.db.shadowTaskOf(taskId);
    if (shadow && shadow.resumeAt !== null) {
      this.setResumeAt(shadow.id, null);
      this.record(shadow.id, { t: "status", text: "並走元が中断されたので、予定していた自動再開を取り消しました（返信すれば続けられます）" });
    }
    // the same for an automatic resume already waiting for a run slot (its plan was cleared when it joined the queue); a person's reply in the wait keeps it
    if (shadow && shadow.queuedAt !== null && this.db.isQueuedResume(shadow.id) && this.db.takeQueued(shadow.id) !== null) {
      this.broadcast({ type: "task.updated", task: this.mustGet(shadow.id) });
      this.record(shadow.id, { t: "status", text: "並走元が中断されたので、実行枠待ちの自動再開を取り消しました（返信すれば続けられます）" });
      for (const l of this.planForgottenListeners) l(shadow.id);
    }
    // 中断 cancels a planned retry: the stop waits for the person again.
    this.moveOpenStops(taskId, (s) => (s.state === "retrying" ? { ...s, state: "waiting", actions: [...s.actions, { attempt: Math.max(0, ...s.actions.map((a) => a.attempt)), at: Date.now(), what: "中断で再試行を取り消し", ok: false }].slice(-20) } : null));
    // A task waiting on background jobs is stopped like a running one: aborted, not released (its jobs go with the process)
    if (task.status === "background") task = this.setStatus(taskId, "aborted");
    if (live) {
      this.disarmIdle(live);
      this.live.delete(taskId);
      // An idle process (turn already finished) is released, not aborted: the task keeps its result.
      if (TERMINAL.has(task.status)) {
        await this.track(taskId, live.session.close());
        return task;
      }
      await this.track(taskId, live.session.abort());
    }
    const ended = TERMINAL.has(task.status) ? task : this.setStatus(taskId, "aborted");
    this.drain();
    return ended;
  }

  /**
   * Abort in-flight turns, kill idle processes right away. Finished tasks keep their status across a daemon restart; a
   * turn cut here, or a finished one's wait on background jobs, is planned to continue on the next start (interrupted.ts).
   * Returns the ids of those tasks.
   */
  async shutdown(): Promise<string[]> {
    this.stopped = true;
    this.stopQueue();
    // the turns cut below free their slots; the next daemon starts what waits, not this one
    const now = Date.now();
    const cut: string[] = [];
    await Promise.all(
      [...this.live.entries()].map(([taskId, l]) => {
        this.disarmIdle(l);
        const task = this.db.getTask(taskId);
        const onJobs = task?.status === "background";
        const idle = !task || TERMINAL.has(task.status) || task.status === "idle" || onJobs;
        // a task still waiting on its runner's background jobs loses them with the process: planned like a cut turn,
        // unless it already waits for a limit's reset (that plan stays; its resume comes then)
        const waitingOnJobs = onJobs && task.resumeAt === null;
        if (task && (!idle || waitingOnJobs) && task.executionMode !== "cloud") {
          planResumeAfterStop(this.db, task, now, (ev) => this.recordPlanned(taskId, ev), this.maxStopResumes());
          cut.push(taskId);
        }
        return (idle ? l.session.close({ graceMs: 0 }) : l.session.abort()).catch(() => undefined);
      }),
    );
    this.live.clear();
    return cut;
  }
}
