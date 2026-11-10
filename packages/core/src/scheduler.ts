import { existsSync } from "node:fs";
import type { Queue, RunnerId, ScanCursors, Schedule, ScheduleInput, Task } from "@switchboard/protocol";
import { nextRun, parseCron } from "./cron.ts";
import { type Db, newId } from "./db.ts";
import type { ScanSummary } from "./secretscan.ts";
import type { TaskManager } from "./tasks.ts";
import { collectProvenance } from "./provenance.ts";
import { isWorking } from "./task-status.ts";

/**
 * Scheduler (#20): DAK-style nightly jobs started from Switchboard. A schedule is a cron expression plus everything a
 * task needs; each firing creates an ordinary task (same approvals, same ledger, same budget). A schedule never
 * overlaps itself: while its last task is still running or waiting, a due firing is skipped and noted.
 * The queue (`/api/queue`) is the morning view: tasks waiting for an approval, staged writes to apply, and what the
 * schedules did overnight.
 */
/** What a backlog-next firing did (#267, #561): the stage Tasks it started, and why each workspace / slot started nothing. */
/** `promotion`: the firing asked for the newest tag, or stopped on it (a Task running, a tag that failed): it started nothing else (#2479). */
export type BacklogNextResult = { started: Array<{ task: Task; label: string }>; skipped: string[]; promotion?: string };

/** What the insights schedule's Task sends (#1838): the built-in command alone — Claude Code expands it only as the whole message. */
export const INSIGHTS_PROMPT = "/insights";

/**
 * What the ui-layers schedule's Task is told (#3353): the monthly floor / ceiling / walls check (docs/design/ui-layers.md,
 * docs/design/scheduler.md). The scripts count and write; the Task reads the code and writes the ratings and findings.
 */
export const UI_LAYERS_PROMPT = `床・天井・壁の月次の点検をしてください（docs/design/ui-layers.md の原則）。このリポジトリの root で、作業ファイルは W=$(mktemp -d /tmp/switchboard.ui-layers.XXXXXX) の下に置きます。

1. 指標を数える: bun scripts/ui-layers-metrics.ts > "$W/metrics.json"
2. 置き場所の行が無い画面の PBI を名指しする: bun scripts/ui-layers-placement.ts --days 30 > "$W/placement.json"（exit 2 なら理由をレポートの評価の文に書き、{"checked":0,"missing":[]} で続ける）
3. 評価を書く: docs/design/ui-layers.md を読み、1 の値と前回の値（\${SWITCHBOARD_HOME:-$HOME/.switchboard}/ui-layers/history.jsonl の最後の行。無ければ初回）、画面のコード（apps/web/src）を読んだ所見から、床・天井・壁それぞれの評価を 2〜4 文で書き、{"floor":"…","ceiling":"…","walls":"…"} を "$W/ratings.json" に置く
4. レポートを作る: bun scripts/ui-layers-report.ts --metrics "$W/metrics.json" --placement "$W/placement.json" --ratings "$W/ratings.json" --out "$W/ui-layers.html"。走らせるたびに履歴に 1 行積むので、1 回の点検で 1 度だけ走らせる（作り直すなら、その履歴を "$W" に写して最後の行（今回の分）を除き、--history にその写しを渡す）。できた HTML を返答の switchboard-artifact のフェンスで成果物に登録する（題は「床・天井・壁の点検 YYYY-MM-DD」）
5. 要望にする: 前回より悪くなった点と、新しく見つけた問題だけを、所見の JSON（[{"key","title","detail","source"}]。最大 3 件、大事な順。source は指標の変化なら「定期の検査」、コードを読んだ所見なら「エージェント」）にして bun scripts/ui-layers-requests.ts --findings "$W/findings.json"。無ければ走らせない

指標が悪くなっても何も止めません。マージ・リリース・画面の修正・PBI の作成はしません。最後に、作った要望の番号（無ければ「なし」）と評価の要約を 3 行で返してください。`;

/** The kinds that run on claude only and fire as a Task of their own on a fixed instruction (#1838, #3353). */
const claudeOnly = (action: string): action is "insights" | "ui-layers" => action === "insights" || action === "ui-layers";

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: string[] = [];
  /** backlog-next / secret-scan / approval-window schedules whose firing is still in progress. */
  private starting = new Set<string>();
  /** A runUnblocked asked while a firing was in progress (#1879): per schedule, the items per workspace, run after it. */
  private unblocked = new Map<string, Map<string, Set<number>>>();
  /** The backlog-next firings in progress that read one workspace's items only, with what they read. */
  private narrow = new Map<string, { workspaceId: string; numbers: number[] }>();
  /** The backlog-next firing in progress per schedule, and the full firings (due / manual) waiting for a narrow one to end. */
  private running = new Map<string, Promise<unknown>>();
  private fullWaiting = new Set<string>();
  /** A tick is in progress: a backlog-next firing can await GitHub longer than the 30 s interval. */
  private ticking = false;

  constructor(
    private db: Db,
    private tasks: TaskManager,
    private now: () => number = Date.now,
    private startNext: (scheduleId: string, only?: { workspaceId: string; numbers: number[] }) => Promise<BacklogNextResult> = async () => ({ started: [], skipped: ["backlog-next is not available"] }),
    private scanSecrets: (schedule: { id: string; title: string }, cursors: ScanCursors) => Promise<{ lines: string[]; summary: ScanSummary; cursors?: ScanCursors }> = async () => ({ lines: ["secret-scan is not available"], summary: { repos: 0, hits: 0, failed: 1 } }),
    /** Claude's 7-day utilization at or above this and an insights or ui-layers firing is skipped (#1838, #3353): the backlog's `backlogQuotaLimit`. */
    private quotaLimit: () => number = () => 0.8,
    /** 上限のときの代わり (#834): the runner a prompt schedule's Task starts on, and the status line when it is another. */
    private autoRunner: (r: RunnerId) => { runner: RunnerId; note?: string } = (r) => ({ runner: r }),
    /** approval-window (#2046): reads the batches still waiting (判断待ち shows them as a notice, #2866) and says so, in a line. */
    private approvalWindow: (schedule: { id: string; title: string }) => Promise<string> = async () => "approval-window is not available",
    /** The budget of a schedule's Task when the schedule has none: the settings' `defaultBudgetUsd` (null = none). */
    private defaultBudgetUsd: () => number | null = () => null,
  ) {}

  list(): Schedule[] {
    return this.db.listSchedules();
  }

  create(input: ScheduleInput): Schedule {
    parseCron(input.cron); // validate
    const action = input.action ?? "prompt";
    if (action === "prompt" && !(input.prompt ?? "").trim()) throw new Error("prompt is required");
    if (claudeOnly(action) && input.runner !== "claude") throw new Error(`${action} runs on claude`);
    const ws = this.db.getWorkspace(input.workspaceId);
    if (!ws) throw new Error("workspace not found");
    if (!existsSync(ws.path)) throw new Error("workspace directory does not exist");
    // backlog-next and secret-scan are one schedule each, kept on the meta workspace; a firing works on every workspace
    // (#561, #775).
    if (action !== "prompt" && ws.kind !== "meta") throw new Error(`${action} runs on the meta workspace only`);
    const effortWhy = input.effort ? this.tasks.checkEffort(input.runner, input.effort) : undefined;
    if (effortWhy) throw new Error(effortWhy);
    const s: Schedule = {
      id: newId("sch"),
      title: input.title,
      cron: input.cron,
      workspaceId: input.workspaceId,
      runner: input.runner,
      model: input.model ?? "",
      effort: input.effort ?? "",
      prompt: input.prompt ?? "",
      action,
      budgetUsd: input.budgetUsd ?? null,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      lastTaskId: null,
      lastResult: null,
      nextRunAt: nextRun(input.cron, new Date(this.now()))?.getTime() ?? null,
      createdAt: this.now(),
    };
    return this.db.insertSchedule(s);
  }

  update(id: string, patch: Partial<ScheduleInput>): Schedule {
    const cur = this.db.getSchedule(id);
    if (!cur) throw new Error("schedule not found");
    if (patch.cron !== undefined) parseCron(patch.cron);
    if (patch.workspaceId !== undefined) {
      const ws = this.db.getWorkspace(patch.workspaceId);
      if (!ws) throw new Error("workspace not found");
      if (!existsSync(ws.path)) throw new Error("workspace directory does not exist");
    }
    if ((patch.action ?? cur.action) === "prompt" && !(patch.prompt ?? cur.prompt).trim()) throw new Error("prompt is required");
    const action = patch.action ?? cur.action;
    if (action !== "prompt" && this.db.getWorkspace(patch.workspaceId ?? cur.workspaceId)?.kind !== "meta") throw new Error(`${action} runs on the meta workspace only`);
    const cron = patch.cron ?? cur.cron;
    // an effort belongs to one runner's list (#833): a runner change without one goes back to the CLI default. Only a
    // sent effort is checked, so a kept one the runner no longer lists does not block e.g. turning the schedule off.
    const runner = patch.runner ?? cur.runner;
    if (claudeOnly(action) && runner !== "claude") throw new Error(`${action} runs on claude`);
    const effort = patch.effort ?? (runner !== cur.runner ? "" : cur.effort);
    const effortWhy = patch.effort ? this.tasks.checkEffort(runner, patch.effort) : undefined;
    if (effortWhy) throw new Error(effortWhy);
    const next = this.db.updateSchedule(id, { ...patch, effort, budgetUsd: patch.budgetUsd === undefined ? cur.budgetUsd : patch.budgetUsd, nextRunAt: nextRun(cron, new Date(this.now()))?.getTime() ?? null });
    return next!;
  }

  remove(id: string) {
    this.db.deleteSchedule(id);
  }

  /** Start the schedule's task now (manual or due). Returns null when its previous task is still active or nothing was started; `{ promotion }` when backlog-next only asked for (or held on) the newest tag. */
  async runNow(id: string, reason: "manual" | "due" = "manual"): Promise<Task | { promotion: string } | null> {
    const s = this.db.getSchedule(id);
    if (!s) throw new Error("schedule not found");
    const ws = this.db.getWorkspace(s.workspaceId);
    if (!ws) throw new Error("workspace of the schedule no longer exists");
    if (!existsSync(ws.path)) throw new Error("workspace directory no longer exists on disk");
    // The "one active task per schedule" guarantee below is enforced only by there being no `await` between this
    // check and `tasks.create()` — both run to completion on the same tick of the event loop, so nothing else can
    // observe `s.lastTaskId`'s task between the read and the create. This is incidental, not structural: if
    // `tasks.create()` ever becomes async, or a real async step (e.g. an I/O-bound validation) is inserted below,
    // this must move behind a per-schedule lock (or a DB-level compare-and-swap on lastTaskId) instead.
    // backlog-next decides per workspace and slot instead (#561): its last Task running does not hold the others.
    const prev = (s.action === "prompt" || claudeOnly(s.action)) && s.lastTaskId ? this.db.getTask(s.lastTaskId) : null;
    if (prev && (isWorking(prev, "slot") || prev.queuedAt !== null)) {
      this.note(`${s.title}: skipped (${reason}); previous run ${prev.id} is still ${prev.queuedAt !== null ? "queued" : prev.status}`);
      return null;
    }
    if (s.action === "backlog-next") return this.runBacklogNext(s.id, s.title, s.cron, reason);
    if (s.action === "secret-scan") return this.runSecretScan(s.id, s.title, s.cron, reason);
    if (s.action === "approval-window") return this.runApprovalWindow(s.id, s.title, s.cron, reason);
    const stamp = new Date(this.now());
    const p = (n: number) => String(n).padStart(2, "0");
    const when = `${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}:${p(stamp.getMinutes())}`;
    const fixed = claudeOnly(s.action);
    if (fixed) {
      // the report's session summaries (insights) and the check's reading (ui-layers) spend the subscription: not while
      // Claude's 7-day window is at the backlog's threshold (#1838, #3353)
      const limit = this.quotaLimit();
      const hot = this.db.quotaFor("claude").find((q) => q.window === "seven_day" && q.utilization >= limit && q.resetsAt * 1000 > this.now());
      if (hot) {
        this.db.updateSchedule(id, { nextRunAt: nextRun(s.cron, new Date(this.now()))?.getTime() ?? null });
        this.note(`${s.title}: ${s.action} を飛ばした (${reason}): Claude の 7 日枠が ${Math.round(hot.utilization * 100)}% で閾値 ${Math.round(limit * 100)}% 以上`);
        return null;
      }
    }
    // insights and ui-layers run on claude only; a prompt schedule's runner at its limit gives way to the fallback order, on its CLI default model (#834)
    const { runner, note } = fixed ? { runner: "claude" as const, note: undefined } : this.autoRunner(s.runner);
    const task = this.tasks.create({
      workspaceId: ws.id,
      cwd: ws.path,
      title: `${s.action === "insights" ? "Claude Code Insights" : s.action === "ui-layers" ? "床・天井・壁の点検" : s.title} (${when})`,
      prompt: s.action === "insights" ? INSIGHTS_PROMPT : s.action === "ui-layers" ? UI_LAYERS_PROMPT : s.prompt,
      runner,
      ...(s.model && !note ? { model: s.model } : {}),
      ...(s.effort && !note ? { effort: s.effort } : {}),
      budgetUsd: s.budgetUsd ?? this.defaultBudgetUsd() ?? undefined,
      scheduleId: s.id,
      kind: "maintenance",
      // Unattended runs get no shadow (#99): the one-active-run guard and the queue's scheduled section only know the
      // primary, and a shadow of every nightly run would pile up asks nobody is there to answer.
      shadowRunner: null,
    }, undefined, (t) => {
      if (note) this.tasks.record(t.id, { t: "status", text: note });
      // Provenance (docs/design/process-kernel.md, K1), from the row just inserted; a failure to record never stops the task
      try {
        const meta = this.db.listWorkspaces().find((w) => w.kind === "meta");
        this.db.setTaskProvenance(t.id, collectProvenance({ cwd: t.cwd, metaPath: meta?.path ?? null, runner: t.runner, model: t.model, effort: t.effort, permissionMode: t.permissionMode, process: null, processReason: `schedule ${s.id}` }));
      } catch (e) {
        this.tasks.record(t.id, { t: "status", text: `由来を記録できませんでした: ${(e as Error).message ?? e}` });
      }
    });
    this.db.updateSchedule(id, { lastRunAt: this.now(), lastTaskId: task.id, nextRunAt: nextRun(s.cron, new Date(this.now()))?.getTime() ?? null });
    if (note) this.note(`${s.title}: ${note}`);
    this.note(`${s.title}: started ${task.id} (${reason})`);
    return task;
  }

  /**
   * An import closed the waits of `numbers` in a workspace (#1879): a backlog-next firing of that workspace's implement
   * slot and those items only, not waiting for the next one. While a firing is in progress the items are kept and run
   * after it (a full one read each workspace once, maybe before the wait cleared), but the ones a narrow firing under
   * way reads (the import its own read sets off comes back with them). The schedule's times stay; only a start is logged — what is not started now is started by the next
   * firing as before, and its reasons are logged there.
   */
  async runUnblocked(id: string, workspaceId: string, numbers: number[]): Promise<Task | null> {
    const s = this.db.getSchedule(id);
    if (!s || s.action !== "backlog-next" || !s.enabled) return null;
    if (this.starting.has(id)) {
      const under = this.narrow.get(id);
      // what the firing under way reads is not kept (the import its own read sets off comes back with it)
      const rest = under?.workspaceId === workspaceId ? numbers.filter((n) => !under.numbers.includes(n)) : numbers;
      if (rest.length) {
        const of = this.unblocked.get(id) ?? new Map<string, Set<number>>();
        of.set(workspaceId, new Set([...(of.get(workspaceId) ?? []), ...rest]));
        this.unblocked.set(id, of);
      }
      return null;
    }
    const r = await this.runBacklogNext(id, s.title, s.cron, "unblocked", { workspaceId, numbers });
    return r && "promotion" in r ? null : r;
  }

  /** backlog-next (#267, #561): the daemon picks the items and starts their stage Tasks; one firing at a time per schedule. */
  private async runBacklogNext(id: string, title: string, cron: string, reason: "manual" | "due" | "unblocked", only?: { workspaceId: string; numbers: number[] }): Promise<Task | { promotion: string } | null> {
    // a full firing that comes during a narrow one waits for it (a narrow one reads one workspace's items only: the
    // firing it would take the place of is not made up until the next due time)
    if (!only && this.narrow.has(id) && !this.fullWaiting.has(id)) {
      this.fullWaiting.add(id);
      try {
        while (this.narrow.has(id)) await this.running.get(id)?.catch(() => undefined);
      } finally {
        this.fullWaiting.delete(id);
      }
    }
    if (this.starting.has(id)) {
      this.note(`${title}: 飛ばした (${reason}): 前の発火がまだ項目を選んでいる`);
      return null;
    }
    this.starting.add(id);
    if (only) this.narrow.set(id, only);
    try {
      const run = this.startNext(id, only);
      this.running.set(id, run);
      const r = await run;
      const last = r.started.at(-1)?.task ?? null;
      if (reason === "unblocked") {
        if (last) this.db.updateSchedule(id, { lastTaskId: last.id });
        for (const x of r.started) this.note(`${title}: ${x.label} で開始 ${x.task.id} (待ちが解けた)`);
        return last ?? (r.promotion ? { promotion: r.promotion } : null);
      }
      const next = nextRun(cron, new Date(this.now()))?.getTime() ?? null;
      this.db.updateSchedule(id, { lastRunAt: this.now(), nextRunAt: next, ...(last ? { lastTaskId: last.id } : {}) });
      for (const x of r.started) this.note(`${title}: ${x.label} で開始 ${x.task.id} (${reason})`);
      if (r.promotion) this.note(`${title}: ${r.promotion} (${reason})`);
      for (const why of r.skipped) this.note(`${title}: 飛ばした (${reason}): ${why}`);
      return last ?? (r.promotion ? { promotion: r.promotion } : null);
    } finally {
      this.starting.delete(id);
      this.narrow.delete(id);
      this.running.delete(id);
      const kept = this.unblocked.get(id);
      this.unblocked.delete(id);
      // after a narrow one, the next of what was kept (each in turn: one firing at a time); a full firing waiting reads them all
      if (kept) void (async () => {
        for (const [ws, n] of kept) {
          if (this.fullWaiting.has(id)) return;
          await this.runUnblocked(id, ws, [...n]).catch((e) => this.note(`${title}: 始められない (待ちが解けた): ${String((e as Error)?.message ?? e)}`));
        }
      })();
    }
  }

  /**
   * secret-scan (#775): the daemon checks every registered repository itself, no runner and no Actions; a line per
   * repository goes to the log. One firing at a time per schedule, like backlog-next. Starts no Task (null).
   */
  private async runSecretScan(id: string, title: string, cron: string, reason: "manual" | "due"): Promise<null> {
    if (this.starting.has(id)) {
      this.note(`${title}: 飛ばした (${reason}): 前の検査がまだ終わっていない`);
      return null;
    }
    this.starting.add(id);
    try {
      // The result stays on the schedule (#1274): the log is memory, gone with a restart — without this, a clean day left
      // no trace to tell "0 hits" from "did not run". 判断待ち's notice is read from it too (#2866).
      // each repository is read from where the last firing left it (kept on the schedule, so a restart keeps it too)
      const before = this.db.getSchedule(id)?.lastResult?.cursors ?? {};
      let r: { lines: string[]; summary: ScanSummary; cursors?: ScanCursors };
      try {
        r = await this.scanSecrets({ id, title }, before);
      } catch (e) {
        // the error's name only: what a failure prints could quote anything, a token included (docs/design/secret-guard.md), and
        // the result is kept, shown and logged — `bash scripts/setup/scan_issues.sh <owner/name>` by hand shows the reason
        const why = `検査が失敗した（${e instanceof Error ? e.name : typeof e}。理由は scan_issues.sh を手で走らせて見る）`;
        r = { lines: [why], summary: { repos: 0, hits: 0, failed: 1 } };
      }
      const at = this.now();
      // read again after the scan (minutes): a schedule turned into another action meanwhile keeps no result (its result
      // belongs to secret-scan), and one deleted meanwhile is not written back
      for (const l of r.lines) this.note(`${title}: ${l} (${reason})`);
      const still = this.db.getSchedule(id);
      if (!still) return null; // deleted meanwhile: logged above, nothing written back
      // a scan that threw read nothing: the cursors stay where they were
      const cursors = r.cursors ?? before;
      const result = still.action === "secret-scan" ? { lastResult: { at, ...r.summary, lines: r.lines, ...(Object.keys(cursors).length ? { cursors } : {}) } } : {};
      this.db.updateSchedule(id, { lastRunAt: at, nextRunAt: nextRun(cron, new Date(at))?.getTime() ?? null, ...result });
      return null;
    } finally {
      this.starting.delete(id);
    }
  }

  /** approval-window (#2046): no runner, no Task — its line in the log and on the schedule. One firing at a time, like secret-scan. */
  private async runApprovalWindow(id: string, title: string, cron: string, reason: "manual" | "due"): Promise<null> {
    if (this.starting.has(id)) {
      this.note(`${title}: 飛ばした (${reason}): 前の発火がまだ終わっていない`);
      return null;
    }
    this.starting.add(id);
    try {
      let failed = 0;
      // the error's name only, as secret-scan's: a message could quote anything (docs/design/secret-guard.md)
      const line = await this.approvalWindow({ id, title }).catch((e) => ((failed = 1), `待ちを読めなかった（${e instanceof Error ? e.name : typeof e}）`));
      this.note(`${title}: ${line} (${reason})`);
      const at = this.now();
      // the line stays on the schedule, as secret-scan's does (a restart keeps it); the counts are not used for this kind
      if (this.db.getSchedule(id)?.action === "approval-window") this.db.updateSchedule(id, { lastRunAt: at, nextRunAt: nextRun(cron, new Date(at))?.getTime() ?? null, lastResult: { at, repos: 0, hits: 0, failed, lines: [line] } });
      return null;
    } finally {
      this.starting.delete(id);
    }
  }

  /** Fire every enabled schedule whose next run is due. Called by the ticker and by tests. */
  async tick(): Promise<Task[]> {
    // One tick at a time: a second one would fire the same due schedules from its own stale list.
    if (this.ticking) return [];
    this.ticking = true;
    try {
      return await this.fireDue();
    } finally {
      this.ticking = false;
    }
  }

  private async fireDue(): Promise<Task[]> {
    const started: Task[] = [];
    const t = this.now();
    for (const s of this.db.listSchedules()) {
      if (!s.enabled || s.nextRunAt === null || s.nextRunAt > t) continue;
      try {
        const task = await this.runNow(s.id, "due");
        if (task && !("promotion" in task)) started.push(task);
        // a firing that started nothing still moves on — unless it already did, after a long firing (a secret-scan
        // reads for minutes: the next run from before it could be due again at once)
        else if ((this.db.getSchedule(s.id)?.nextRunAt ?? 0) <= t) this.db.updateSchedule(s.id, { nextRunAt: nextRun(s.cron, new Date(t))?.getTime() ?? null });
      } catch (e) {
        this.note(`${s.title}: failed to start (${String((e as Error).message ?? e)})`);
        this.db.updateSchedule(s.id, { nextRunAt: nextRun(s.cron, new Date(t))?.getTime() ?? null });
      }
    }
    return started;
  }

  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recentLog(): string[] {
    return this.log.slice(-50);
  }

  note(text: string) {
    this.log.push(`${new Date(this.now()).toISOString()} ${text}`);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  /**
   * The morning view. Built entirely from bounded, targeted queries — never a full scan of every task the workspace
   * has ever had (that grows forever, and this is polled every 30s): `listTasksByStatus("waiting")` is a small live
   * set, `pendingStagedByTask()` is a single grouped join, and `scheduledTasks()` is already time-windowed.
   */
  queue(): Queue {
    const waiting: Queue["waiting"] = this.db.listTasksByStatus("waiting").map((t) => {
      const ask = this.db
        .listEvents(t.id)
        .filter((e) => e.ev.t === "permission.ask")
        .at(-1);
      return { taskId: t.id, title: t.title, runner: t.runner, ask: ask && ask.ev.t === "permission.ask" ? ask.ev.detail : "", since: ask?.ts ?? t.updatedAt };
    });
    const staged: Queue["staged"] = this.db.pendingStagedByTask();
    const since = this.now() - 36 * 3600 * 1000;
    const schedules = new Map(this.db.listSchedules().map((s) => [s.id, s.title]));
    const scheduled: Queue["scheduled"] = this.db.scheduledTasks(since).map((t) => ({ taskId: t.id, title: t.title, runner: t.runner, status: t.status, scheduleId: t.scheduleId!, scheduleTitle: schedules.get(t.scheduleId!) ?? "(deleted)", costUsd: this.db.taskCost(t.id).costUsd, createdAt: t.createdAt }));
    const queued: Queue["queued"] = this.db.listQueuedTasks().map((t, i) => ({ taskId: t.id, title: t.title, runner: t.runner, since: t.queuedAt!, position: i + 1 }));
    return { waiting, staged, scheduled, queued };
  }
}
