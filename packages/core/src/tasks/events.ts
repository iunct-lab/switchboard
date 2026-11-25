/** The TaskManager's part that reads the runner's events (see `TaskEvents`). */
import { diskFullHit, diskFullText } from "../diskfull.ts";
import { githubLimitHit, usesGraphql } from "../ratelimit.ts";
import type { AgentEvent, ApprovalRuleMatch, StopRecord, Attachment, PendingApproval, PermissionDecision, StoredOutcome, Task } from "@switchboard/protocol";
import { CloudSessionRef, isWorkingStatus } from "@switchboard/protocol";
import { ledgerRowFor, usageSince } from "../pricing.ts";
import type { ArtifactFence } from "../artifacts.ts";
import { canTransition, IN_FLIGHT, InvalidTaskTransitionError, outcomeOf, STORED_OUTCOMES, TERMINAL } from "../task-status.ts";
import { lastAttempt, meetEndedJobs, openStops, outcomeFromStops, reserveStopRetry, stopRecordsFor, stopWork, type StopReport } from "../stops.ts";
import { type LiveSession, type TurnEnd, TaskManagerState } from "./state.ts";

/** How soon a runner's event held back by a locked database is tried again. Each try can itself wait out busy_timeout. */
const HELD_RETRY_MS = 1000;

const isDbBusy = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? "").startsWith("SQLITE_BUSY");

/**
 * What ends the runner's reply and is recorded after the fences it closes: a tool call, an ask, the session's
 * end. The person's next message closes them too, but after it is recorded — its files are recorded before it, and a row
 * between them would split them.
 */
const endsReply = (ev: AgentEvent) => ev.t === "tool.call" || ev.t === "permission.ask" || ev.t === "question.ask" || ev.t === "session.end";

/** What a Task's runner says and what is recorded of it: the event log, the stops, the artifacts, the budget, and the status transitions that follow from an event. */
export abstract class TaskEvents extends TaskManagerState {
  protected abstract flushHeldReplies(taskId: string, live: LiveSession): void;
  abstract release(taskId: string, opts?: { graceMs?: number }): Promise<boolean>;

  protected noteFableBudget(taskId: string, budget: number): void {
    const text = `Fable のため既定の予算 $${budget} を付けました`;
    const live = this.live.get(taskId);
    if (live) this.onEvent(taskId, live, { t: "status", text });
    else this.record(taskId, { t: "status", text });
  }

  /** Append an event that did not come from the runner (Workspace MCP tool calls, host notes). */
  record(taskId: string, ev: AgentEvent): void {
    // another machine's Task: its events are numbered there, and one written here would take the place of one of its own
    if (this.isElsewhere(taskId)) return;
    const live = this.live.get(taskId);
    if (live) this.onEvent(taskId, live, ev);
    else {
      const env = this.db.appendEvent(taskId, ev);
      this.broadcast({ type: "event", env });
    }
  }

  /**
   * Raise a permission.ask on behalf of the host (Workspace MCP). Resolves with the user's decision (or a Knowledge
   * allow rule, recorded as by: rule); a task without a live runner, or one that ends first, resolves "deny".
   */
  askPermission(taskId: string, ask: Omit<Extract<AgentEvent, { t: "permission.ask" }>, "t" | "id">): Promise<PermissionDecision> {
    const live = this.live.get(taskId);
    if (!live) return Promise.resolve("deny");
    const id = `host_${crypto.randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      live.hostAsks.set(id, resolve);
      this.onEvent(taskId, live, { t: "permission.ask", id, ...ask });
    });
  }

  /**
   * Record a stop the runner reported: task.note's `stop` or a `switchboard-stop` fence. Its id is the runner's
   * within this task. The answer is the one it names (an Issue comment), else the newest one this stop or the same
   * work + op + target already had — never one made up from the conversation. The same report twice (a note and a
   * fence) is recorded once. A retry is reserved only by the bounded rule (`reserveStopRetry`) and only for the
   * next attempt: one refused is recorded as waiting / exhausted with the reason, and the caller hears why.
   */
  recordStop(taskId: string, report: StopReport): { ok: true; stop: StopRecord } | { ok: false; why: string } {
    const task = this.mustGet(taskId);
    this.requireOwn(task);
    const now = Date.now();
    report = meetEndedJobs(report, (jobId) => {
      const j = this.db.getJob(jobId);
      return !!j && j.status !== "running";
    });
    const id = `${taskId}/${report.id}`;
    const known = stopRecordsFor(this.db, task);
    const prev = known.filter((r) => r.id === id).at(-1);
    const place = known.filter((r) => r.op === report.op && r.target === report.target && r.answer).at(-1);
    const named = report.answer && (prev?.answer?.ref === report.answer ? prev.answer : { ref: report.answer, at: now });
    const { answer: _, ...rest } = report;
    // an action reported without a time keeps the one it was first recorded with
    const actions = rest.actions.map((a) => (a.at ? a : { ...a, at: prev?.actions.find((p) => p.attempt === a.attempt && p.what === a.what)?.at ?? now }));
    const stop: StopRecord = { ...rest, actions, id, work: stopWork(task), answer: named || prev?.answer || place?.answer || null, at: now };
    if (stop.state === "retrying") {
      const r = reserveStopRetry(prev, stop);
      if (!r.ok) {
        const refused: StopRecord = { ...stop, state: r.exhausted ? "exhausted" : "waiting", actions: [...(prev?.actions ?? []), { attempt: prev ? lastAttempt(prev) : 0, at: now, what: `再試行しない: ${r.why}`, ok: false }].slice(-20) };
        if (!(prev && prev.state === refused.state && prev.actions.at(-1)?.what === refused.actions.at(-1)?.what)) this.recordStopEvent(taskId, refused);
        return { ok: false, why: r.why };
      }
      if (lastAttempt(stop) !== r.attempt) return { ok: false, why: `再試行 ${r.attempt - 1} 回目は予約済みです（次は ${r.attempt} 回目）` };
    }
    const same = (s: StopRecord) => JSON.stringify({ ...s, at: 0, work: 0 });
    if (prev && same(prev) === same(stop)) {
      for (const l of this.stopRecordedListeners) l(taskId, prev, prev);
      return { ok: true, stop: prev };
    }
    this.recordStopEvent(taskId, stop);
    for (const l of this.stopRecordedListeners) l(taskId, stop, prev);
    return { ok: true, stop };
  }

  /**
   * The one place a `stop.record` is written. Right after, the Task's `outcome` is set from its stop records
   * (`outcomeFromStops`; docs/design/task-outcome.md), unless the person has reviewed the Task, its status decides its outcome
   * (waiting, error, aborted) or the status cannot store the value. No stop record of its own leaves the outcome as it is.
   * Stops that are all closed after the turn give `finished` only in place of what the stops had set before this record
   * (`needs_action` / `waits`): an outcome the judge or the person set after them (a later turn without a stop) stays.
   */
  recordStopEvent(taskId: string, stop: StopRecord): void {
    this.record(taskId, { t: "stop.record", stop });
    const cur = this.db.getTask(taskId);
    if (!cur || cur.reviewedAt !== null) return;
    const records = this.db.listStopRecords([taskId]);
    const outcome = outcomeFromStops(records, isWorkingStatus(cur.status));
    if (outcome === null || outcome === cur.outcome || outcomeOf(cur.status, "unknown") !== "unknown" || !STORED_OUTCOMES[cur.status].has(outcome as StoredOutcome)) return;
    if (outcome === "finished") {
      const before = outcomeFromStops(records.slice(0, -1), false);
      if (before !== cur.outcome || (before !== "needs_action" && before !== "waits")) return;
    }
    const t = this.db.updateTask(taskId, { outcome: outcome as StoredOutcome, updatedAt: cur.updatedAt });
    if (t) this.broadcast({ type: "task.updated", task: t });
  }

  /** What `planResumeAfterStop` writes: its notes as they are, its stop (the cap of resumes) through `recordStopEvent`, so the outcome follows. */
  protected recordPlanned(taskId: string, ev: AgentEvent): void {
    if (ev.t === "stop.record") this.recordStopEvent(taskId, ev.stop);
    else this.record(taskId, ev);
  }

  /** Move the task's own open stops: an answer the person gave (to an exhausted stop too, `pick`), or 中断 cancelling a planned retry. */
  protected moveOpenStops(taskId: string, f: (s: StopRecord) => StopRecord | null, pick = openStops) {
    for (const s of pick(this.db.listStopRecords([taskId]))) {
      const next = f(s);
      if (next) this.recordStopEvent(taskId, { ...next, at: Date.now() });
    }
  }

  /** Every unanswered permission.ask of every live task, newest first. */
  pendingApprovals(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const [taskId, live] of this.live) {
      if (!live.pendingPermissions.size) continue;
      const task = this.db.getTask(taskId);
      if (!task) continue;
      const workspace = task.workspaceId ? (this.db.getWorkspace(task.workspaceId)?.name ?? null) : null;
      for (const [id, { ask, at }] of live.pendingPermissions) out.push({ taskId, taskTitle: task.title, workspace, id, kind: ask.kind, tool: ask.tool, input: ask.input, detail: ask.detail, mcpHint: ask.mcpHint, askedAt: at });
    }
    return out.sort((a, b) => b.askedAt - a.askedAt);
  }

  /** One transcript row per file, just before the turn's own user message, so the UI shows them with it. */
  protected recordAttachments(taskId: string, atts: Attachment[]) {
    for (const a of atts) this.record(taskId, { t: "attachment", id: a.id, name: a.name, mime: a.mime, size: a.size });
  }

  /** Fire onTaskEnd listeners once the task is terminal and no process is attached. */
  protected maybeEnded(taskId: string) {
    if (this.live.has(taskId)) return;
    const t = this.db.getTask(taskId);
    if (t && TERMINAL.has(t.status)) for (const l of this.endListeners) l(taskId, t);
  }

  protected updateCloudState(taskId: string): Task {
    const task = this.mustGet(taskId);
    // the outcome is the rule's (task-status.ts): a Cloud Task is never judged here, so unknown
    const updated = this.transition(taskId, task.cloudSession ? "idle" : "error", { resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, runnerSessionId: null })!;
    this.broadcast({ type: "task.updated", task: updated });
    return updated;
  }

  /**
   * Budget: once cumulative API-equivalent spend passes the task's budget, further turns are refused (409)
   * until the user raises the budget or stops the task. The crossing is noted once per turn in the transcript; the
   * decision itself is a UI action (×2 / 中断), not a permission.ask — a running turn is never interrupted, and a
   * synthetic ask arriving next to session.end would leave the task in a contradictory state.
   */
  private checkBudget(taskId: string, live: LiveSession, task: Task) {
    if (task.budgetUsd === null) return;
    const spent = this.db.taskCost(taskId).costUsd;
    if (spent <= task.budgetUsd) return;
    if (live.budgetNoted === task.budgetUsd) return;
    live.budgetNoted = task.budgetUsd;
    this.onEvent(taskId, live, { t: "status", text: `予算 $${task.budgetUsd} を超過（API 換算 $${spent.toFixed(4)}）。次のターンは予算を上げるまで送れません` });
  }

  private armIdle(taskId: string, live: LiveSession) {
    this.disarmIdle(live);
    if (this.idleMs < 0 || live.background) return;
    live.idleTimer = setTimeout(() => void this.release(taskId), this.idleMs);
  }

  /**
   * Every runner's events come in here. A throw must not reach the adapter: it reads stdout in the same call, so one failed
   * write ended the reading and the turn never ended on the screen (the nightly events-archive holding the write lock past
   * busy_timeout, 2026-10-31). A lock holds this event and the ones after it, in order, until the database answers.
   */
  protected fromRunner(taskId: string, live: LiveSession, ev: AgentEvent) {
    const now = Date.now();
    live.lastEventAt = now;
    if (ev.t === "hook.progress") {
      // a heartbeat only says the runner is alive: it is kept in memory, not in the transcript (one every 30 s would grow it)
      // hooks run in parallel and beat in turn: while beats keep coming, the first one's start stays
      live.hook = { name: ev.hook, since: live.hook?.since ?? ev.startedAt ?? now, beatAt: now };
      this.endSilence(taskId, true);
      return;
    }
    live.hook = undefined;
    live.held.push(ev);
    if (live.held.length === 1) this.takeHeld(taskId, live);
  }

  protected takeHeld(taskId: string, live: LiveSession) {
    for (let ev = live.held[0]; ev; ev = live.held[0]) {
      try {
        // IMMEDIATE: onEvent has side effects outside the database (the fence readers, the runner's answer, the turn-end
        // listeners), so the lock is met here, before any of them, and a try again starts from the beginning.
        this.db.sqlite
          .transaction(() => {
            // caught inside: a failure past appendEvent (a ledger or quota write) must not roll the event back. What was done stays.
            try {
              this.endSilence(taskId);
              this.onEvent(taskId, live, ev!);
            } catch (e) {
              console.error(`task ${taskId}: runner event ${ev!.t} not fully taken in:`, e);
              if (ev!.t !== "error") live.held.push({ t: "error", message: `イベントの処理に失敗しました（${ev!.t}）: ${String(e)}` });
            }
          })
          .immediate();
      } catch (e) {
        if (isDbBusy(e)) {
          setTimeout(() => this.takeHeld(taskId, live), HELD_RETRY_MS).unref();
          return;
        }
        console.error(`task ${taskId}: runner event ${ev.t} dropped:`, e); // the database itself failed (closed): nothing to show it on
      }
      live.held.shift();
    }
    const after = live.afterHeld;
    live.afterHeld = undefined;
    after?.();
  }

  /** The runner spoke again: the silence the wait watch had stored on the Task (応答なし) is over at once, not at the watch's next look. */
  private endSilence(taskId: string, keepHook = false) {
    const waits = this.db.getTask(taskId)?.waits;
    const ends = (w: { kind: string }) => w.kind === "output" || (w.kind === "hook" && !keepHook);
    if (!waits?.some(ends)) return;
    this.db.setTaskWaits(taskId, waits.filter((w) => !ends(w)));
    const t = this.db.getTask(taskId);
    if (t) this.broadcast({ type: "task.updated", task: t });
  }

  protected onEvent(taskId: string, live: LiveSession, ev: AgentEvent) {
    const cloudTask = this.db.getTask(taskId);
    if (cloudTask?.executionMode === "cloud") {
      if (ev.t === "cloud.session.created") {
        const ref = CloudSessionRef.safeParse({ id: ev.id, url: ev.url });
        if (!ref.success) { this.record(taskId, { t: "error", message: "Cloud 参照を検証できません。公式 Web で確認してください。" }); return; }
        if (cloudTask.cloudSession) return;
        this.db.updateTask(taskId, { cloudSession: ref.data });
        this.updateCloudState(taskId);
      } else if (ev.t !== "message.delta" && ev.t !== "status" && ev.t !== "error") return;
      const env = this.db.appendEvent(taskId, ev);
      this.broadcast({ type: "event", env });
      return;
    }
    if (ev.t === "cloud.session.created") return;
    // a DAK turn sends thousands of them in a row and buries the reply under the transcript's tail
    const thinking = ev.t === "status" && ev.text === "thinking";
    if (thinking && live.thinkingRecorded) return;
    // Approval rules run before the ask is persisted so the recorded event carries the matched rule.
    let autoAllow: ApprovalRuleMatch | undefined;
    if (ev.t === "permission.ask" && this.approval) {
      const t = this.db.getTask(taskId);
      const verdict = t ? this.approval(t, ev) : { decision: "ask" as const };
      if (verdict.match) ev = { ...ev, rule: verdict.match };
      if (verdict.decision === "allow") autoAllow = verdict.match;
    }
    if (ev.t === "permission.resolved" && ev.by === "rule" && !ev.rule) {
      const m = live.ruleMatches.get(ev.id);
      if (m) ev = { ...ev, rule: m };
      live.ruleMatches.delete(ev.id);
    }
    if (ev.t === "session.start") ev = { ...ev, effort: live.effort }; // the runner does not name its effort; core knows what it was started with
    // a fence whose closing line ends the reply (no newline after it) is only read when the reply ends: read it before the
    // event that ends the reply is recorded, so its stop / artifact row comes before the tool row or 完了
    if (endsReply(ev)) this.readFences(taskId, live, ev);
    const env = this.db.appendEvent(taskId, ev);
    live.thinkingRecorded = thinking;
    const task = this.db.getTask(taskId);
    if (!task) return;
    this.readStops(taskId, live, ev, env.seq, env.ts);

    if (ev.t === "permission.ask" && autoAllow) {
      // Recorded as asked → resolved by rule; the task never enters "waiting". Then handed to the runner / host ask.
      this.broadcast({ type: "event", env });
      const host = live.hostAsks.get(ev.id);
      if (host) {
        live.hostAsks.delete(ev.id);
        host("allow");
        this.onEvent(taskId, live, { t: "permission.resolved", id: ev.id, decision: "allow", by: "rule", rule: autoAllow });
        return;
      }
      try {
        // The adapter emits permission.resolved(by: rule) itself once it has answered the runner.
        live.ruleMatches.set(ev.id, autoAllow);
        live.session.respondPermission(ev.id, "allow", `allowed by rule ${autoAllow.source}: ${autoAllow.pattern}`, "rule");
        return;
      } catch (e) {
        // The runner did not take the answer (closed stdin, unknown id): fall through and let the user decide.
        live.ruleMatches.delete(ev.id);
        this.onEvent(taskId, live, { t: "status", text: `rule allow could not be delivered (${String((e as Error).message ?? e)}); asking the user` });
      }
    }

    switch (ev.t) {
      case "session.start":
        {
          // a runner's event moves a task only while a turn is in flight; the session id and model are kept either way
          const extra = { runnerSessionId: ev.runnerSessionId ?? task.runnerSessionId, model: live.modelChanged ? task.model : (ev.model ?? task.model) };
          // A turn the attached runner starts on its own after the last one ended (Claude Code on a background job's
          // notification) is in flight like a sent one: the idle release must not kill it mid-command (Exit code 137),
          // and its end must be reported. A released or aborted process is no longer attached.
          const ownTurn = (task.status === "done" || task.status === "error" || task.status === "background") && this.live.get(taskId) === live;
          if (ownTurn) {
            this.disarmIdle(live);
            live.turnErrors = [];
            live.turnQuota = undefined;
            live.turnQuestion = undefined;
          }
          if (!(IN_FLIGHT.has(task.status) || ownTurn) || !this.transition(taskId, "running", extra)) this.db.updateTask(taskId, extra);
          const budget = this.fableBudgetFor({ ...task, model: extra.model }, task.model);
          const budgeted = budget === null ? null : this.db.updateTask(taskId, { budgetUsd: budget });
          if (budgeted && budget !== null) {
            this.broadcast({ type: "task.updated", task: budgeted });
            this.noteFableBudget(taskId, budget);
          }
        }
        break;
      case "permission.ask":
        live.pendingPermissions.set(ev.id, { ask: ev, at: env.ts }); // the recorded event's time, as the transcript and /api/queue show it
        if (IN_FLIGHT.has(task.status)) this.transition(taskId, "waiting");
        break;
      case "question.ask":
        live.turnQuestion = true;
        break;
      case "permission.resolved":
        live.pendingPermissions.delete(ev.id);
        if (task.status === "waiting" && live.pendingPermissions.size === 0) this.transition(taskId, "running");
        break;
      case "usage":
        if (ev.source === "reported" && !ev.cumulative) {
          this.db.insertLedger(ledgerRowFor(this.pricing?.(), task, ev, env.ts, this.loginKind?.(task)));
          this.checkBudget(taskId, live, task);
        } else if (ev.source === "reported") {
          // a running total of the session (Claude): the row is what it grew by since the last one of this model
          const prev = this.db.lastReportedTotal(taskId, ev.model ?? null);
          const turn = usageSince(prev, ev, task.runnerSessionId, prev ? 0 : this.db.migratedCredit(taskId, task.runnerSessionId));
          if (turn) {
            this.db.insertLedger(ledgerRowFor(this.pricing?.(), task, turn.usage, env.ts, this.loginKind?.(task)), turn.total);
            this.checkBudget(taskId, live, task);
          }
        }
        break;
      case "artifact": {
        // A file the runner made in the task's attachment directory is one of the task's files from here on.
        const a = ev.kind === "file" ? this.attachments?.register(taskId, ev.path) : undefined;
        if (a) this.recordAttachments(taskId, [a]);
        break;
      }
      case "quota":
        if (ev.account !== undefined) this.db.noteAccount(ev.runner, ev.account);
        for (const [w, v] of Object.entries(ev.windows)) this.db.upsertQuota(ev.runner, w, v.utilization, v.resetsAt, env.ts);
        live.turnQuota = ev;
        break;
      case "tool.call":
        live.turnCalls.set(ev.id, { name: ev.name, key: `${ev.name}:${JSON.stringify(ev.input ?? null)}`, graphql: usesGraphql(ev.name, ev.input) });
        break;
      case "tool.result": {
        // a GitHub limit line at the head of a command's result; the same command succeeding later takes it out,
        // and any command using GraphQL succeeding takes all of them out
        const call = live.turnCalls.get(ev.id);
        live.turnCalls.delete(ev.id);
        if (call) {
          const hit = githubLimitHit(call.name, ev.summary ?? "");
          if (hit) {
            live.turnGithub.delete(call.key); // to the end of the order: the last entry is the latest hit
            live.turnGithub.set(call.key, { line: hit, at: env.ts });
          } else if (ev.ok) {
            if (call.graphql) live.turnGithub.clear();
            else live.turnGithub.delete(call.key);
          }
          if (!ev.ok) live.turnDisk = diskFullHit(call.name, ev.summary ?? "") ?? live.turnDisk;
        }
        break;
      }
      case "session.end":
        // Only an in-flight turn can end. A late session.end (e.g. the process being released) must not
        // rewrite a task that already finished.
        if (IN_FLIGHT.has(task.status)) {
          // a turn that asked through the question tool ends on the person's answer: 要対応 at once, not judged
          // a turn that ended ok with jobs left is `background`, not `done`; a failed or aborted one is shown as such (the mark stays)
          this.transition(taskId, ev.status === "ok" ? (live.background ?? 0) > 0 ? "background" : "done" : ev.status === "aborted" ? "aborted" : "error", ev.status === "ok" && live.turnQuestion ? { outcome: "needs_action" } : {});
          // A shadow's turn that ended in error — a session the agent lost, an ADK error — is invisible from the
          // primary, which is where the person is looking; the copies stop matching from here on.
          if (ev.status === "error" && task.shadowOf) this.record(task.shadowOf, { t: "status", text: `並走（${task.runner}）のターンがエラーで終わりました（${ev.summary ?? ""}）。ここから先の会話は並走と食い違います` });
        }
        // Keep the process for quick follow-ups only when nothing is pending; a permission still open means the turn is not over.
        if (ev.status !== "aborted" && live.pendingPermissions.size === 0 && this.live.get(taskId) === live) this.armIdle(taskId, live);
        // A turn ended only if one was in flight; the session.end that closing an idle process emits is not a turn.
        if (IN_FLIGHT.has(task.status)) {
          const after = this.db.getTask(taskId);
          const github = [...live.turnGithub.values()].at(-1);
          const turn: TurnEnd = { end: ev, errors: live.turnErrors, quota: live.turnQuota, githubLimit: github?.line, githubLimitAt: github?.at, diskFull: live.turnDisk ?? [ev.status === "error" ? ev.summary : undefined, ...live.turnErrors].map(diskFullText).find(Boolean) };
          live.turnCalls.clear();
          live.turnGithub.clear();
          live.turnDisk = undefined;
          live.turnErrors = [];
          live.turnQuota = undefined;
          live.turnQuestion = undefined;
          if (after) {
            for (const l of this.turnEndListeners) {
              // one listener's failure must not skip the others, nor the broadcast of the end below
              try {
                l(taskId, after, turn);
              } catch (e) {
                console.error(`task ${taskId}: turn-end listener failed:`, e);
                this.record(taskId, { t: "error", message: `ターン終了の処理に失敗しました: ${String(e)}` });
              }
            }
          }
        }
        break;
      case "background":
        live.background = ev.count;
        const hadBackground = task.background !== null;
        this.db.setTaskBackground(taskId, ev.count > 0 ? { jobs: ev.jobs ?? [], since: task.background?.since ?? env.ts } : null);
        // the last job gone ends the wait; a mark that arrives after the turn ended starts one
        if (ev.count === 0 && task.status === "background") this.transition(taskId, "done");
        else if (ev.count > 0 && task.status === "done") this.transition(taskId, "background");
        this.broadcast({ type: "task.updated", task: this.db.getTask(taskId)! });
        // a job left keeps the process (its notification starts the next turn); the last one gone starts the idle clock
        if (ev.count > 0) this.disarmIdle(live);
        else if (!IN_FLIGHT.has(task.status) && live.pendingPermissions.size === 0 && this.live.get(taskId) === live) this.armIdle(taskId, live);
        if (ev.count === 0 && hadBackground) this.notifyBackgroundEmpty(taskId);
        break;
      case "error":
        // Recorded in the transcript only. The status is decided by session.end (or by the exit handler when the
        // process dies without one), so a recoverable mid-turn error cannot stick over a later session.end(ok).
        // Kept for the turn-end listeners (a usage-limit stop may be reported here rather than in session.end).
        if (live.turnErrors.length < 5) live.turnErrors.push(ev.message.slice(0, 300));
        break;
      default:
        break;
    }

    this.broadcast({ type: "event", env });
    const updated = this.db.getTask(taskId);
    if (updated && (updated.status !== task.status || updated.runnerSessionId !== task.runnerSessionId)) {
      this.broadcast({ type: "task.updated", task: updated });
    }
    // a Task that left running / waiting frees a slot
    if (updated && updated.status !== task.status && !IN_FLIGHT.has(updated.status)) this.drain();
  }

  /**
   * Stop reports in the runner's own reply: assistant text only — a tool's output or the person's message is
   * never read; a tool call, an ask, the turn's end or the person's message closes the message. A person's answer to an ask answers the task's open stops that wait on one.
   */
  private readStops(taskId: string, live: LiveSession, ev: AgentEvent, seq: number, ts: number) {
    if (ev.t === "stop.record") return;
    // the reply's own text and the person's next message, after they are recorded; the other ends were read before (onEvent)
    if (ev.t === "message.delta") this.readFences(taskId, live, ev);
    // an answer to an ask answers the stops waiting on one (permission / decision), not a CI wait or a usage limit
    if (ev.t === "permission.resolved" && ev.by === "user") this.moveOpenStops(taskId, (s) => (s.reason === "permission" || s.reason === "decision" ? { ...s, answer: { ref: `seq:${seq}`, at: ts } } : null));
  }

  /**
   * The runner's `switchboard-stop` and `switchboard-artifact` fences: a reply's text feeds them, and what
   * ends the reply (`endsReply`, the person's next message) closes a fence still open in it.
   */
  private readFences(taskId: string, live: LiveSession, ev: AgentEvent) {
    const text = ev.t === "message.delta" && ev.role === "assistant" ? ev : null;
    const reports = text ? live.stopReader.feed(text.text, text.messageId) : live.stopReader.end();
    for (const r of reports) this.recordStop(taskId, r);
    const found = text ? live.artifactReader.feed(text.text, text.messageId) : live.artifactReader.end();
    for (const a of found) this.saveArtifact(taskId, a);
  }

  /**
   * An agent's `switchboard-artifact` fence: registered as a path typed on the 成果物 tab would be — the same
   * scope, the same limits, the same path replacing its copy. A refusal is one status line on the Task, never a stop.
   */
  private saveArtifact(taskId: string, fence: ArtifactFence) {
    const task = this.db.getTask(taskId);
    if (!task) return;
    if (!fence.ok) {
      this.record(taskId, { t: "status", text: `成果物を登録できませんでした（フェンスが読めません: ${fence.why}）` });
      return;
    }
    const report = fence.report;
    if (!this.artifacts) {
      this.record(taskId, { t: "status", text: "成果物を登録できませんでした（この構成では成果物の置き場がありません）" });
      return;
    }
    try {
      const a = this.artifacts.add(task, { source: report.path, title: report.title });
      this.record(taskId, { t: "artifact.saved", id: a.id, title: a.title });
    } catch (e) {
      this.record(taskId, { t: "status", text: `成果物を登録できませんでした（${String((e as Error).message ?? e)}）` });
    }
  }

  protected setStatus(taskId: string, status: Task["status"]): Task {
    const before = this.mustGet(taskId).status;
    const t = this.transition(taskId, status);
    // a move the table lacks is a mistake of whoever asked (an API call on a finished task), not something to store
    if (!t) throw new InvalidTaskTransitionError(taskId, before, status);
    this.broadcast({ type: "task.updated", task: t });
    if (TERMINAL.has(status) && !TERMINAL.has(before)) {
      this.maybeEnded(taskId);
      this.drain();
    }
    return t;
  }

  /**
   * The one place a task's status is written: checked against the table (task-status.ts) first, and `null`
   * when the move is not allowed, with the row untouched. The outcome follows by rule in `Db.updateTask`.
   */
  protected transition(taskId: string, status: Task["status"], extra: { outcome?: StoredOutcome } & Partial<Pick<Task, "runnerSessionId" | "model" | "resumeAt" | "resumeReason" | "resumeWindow" | "resumeSince" | "resumePlannedAt">> = {}): Task | null {
    const cur = this.db.getTask(taskId);
    if (!cur || !canTransition(cur.status, status)) return null;
    const t = this.db.updateTask(taskId, { status, ...extra });
    // off its jobs and turns: replies held under the admission hold go on, once the caller has written the rest of this move
    const live = this.live.get(taskId);
    if (t && live?.heldReplies && status !== "background" && !IN_FLIGHT.has(status)) queueMicrotask(() => this.flushHeldReplies(taskId, live));
    return t;
  }
}
