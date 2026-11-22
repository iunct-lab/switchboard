/**
 * The TaskManager's part that starts a runner process (see `TaskSessions`), with what a process is started with: the
 * Task's private temporary directory, the commands it is allowed without asking, and the kit's place on its PATH.
 */
import { FORGE_READ_ONLY_ENV } from "../../../../ops-kit/src/gh-reads.ts";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { Attachment, RunnerAdapter, RunnerSession, Task } from "@switchboard/protocol";
import { readCloudPreparation } from "../claude-cloud.ts";
import { artifactPrompt, parseArtifactFence } from "../artifacts.ts";
import { planResumeAfterStop } from "../interrupted.ts";
import { recapOf } from "../recap.ts";
import { IN_FLIGHT } from "../task-status.ts";
import { setupScripts, skillCopiesCurrent, syncSkills, type SkillSyncOptions } from "../skillsync.ts";
import { savedConfigFile } from "../workspace-config.ts";
import { FenceReader, reduceStops, openStopsPrompt, StopFenceReader, stopRecordsFor, stopRecoveryPrompt } from "../stops.ts";
import { originMismatch } from "../workspace-clone.ts";
import type { LiveSession } from "./state.ts";
import { TaskEvents } from "./events.ts";

const realpathOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * The temp directory only this task writes under (StartOptions.privateTmp): `<root>/<task id>`, where the root is
 * the daemon's own (`<home>/tmp`), so that another daemon, or one started on a copy of the database, never shares it.
 */
export function privateTmpOf(root: string, taskId: string): string {
  const dir = join(root, taskId);
  if (!taskId || basename(dir) !== taskId || taskId === "." || taskId === "..") throw new Error(`task id "${taskId}" is not a directory name`);
  return dir;
}

/** Makes it (or takes the one a resume left): a real directory of this user's, closed to others. A symlink or a foreign one is refused. */
export function makePrivateTmp(root: string, taskId: string): string {
  const dir = privateTmpOf(root, taskId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${dir} is not a directory of this user's`);
  chmodSync(dir, 0o700);
  const now = new Date();
  utimesSync(dir, now, now); // the sweep's age counts from the last start
  return dir;
}

/**
 * Removes the directories of tasks the database lets go. A `done` task is not over (a follow-up resumes the same
 * thread and its files), so those wait for this sweep at the daemon's start: older than `maxAgeMs` by their mtime.
 */
export function sweepPrivateTmps(root: string, maxAgeMs: number, removable: (taskId: string) => boolean, now = Date.now()): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!removable(name)) continue;
    const dir = join(root, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || now - st.mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      n++;
    } catch {
      // not ours or not removable: left
    }
  }
  return n;
}

/** One word for the shell: in single quotes, a quote inside written as '\''. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The Claude Code allow rules a task gets (docs/design/permission-modes.md): the operations the skills ask for, so that
 * auto mode does not stop them. Only the merge through the merge gate (it merges on a merge verdict only; a bare `gh pr merge`
 * stays with auto mode), resolving a review thread (not a general `gh api graphql`), the marks (`gh pr comment`; the check in
 * front of `gh` still reads them), editing the skills of the task's folder and its worktrees (`<cwd>-<topic>`, CLAUDE.md), and
 * three writes that reach the backlog or the stack's own branches only: `gh stack submit` / `gh stack push` write the
 * stack's branches and nothing else; the rewrite push is the one line `ops-kit pr push-rebased` (it refuses the default branch
 * itself, and a bare `git push --force-with-lease:*` is never allowed because a prefix match would let a main target through);
 * `ops-kit backlog` goes through the app, which checks the values it writes.
 * Not a fence: the same OS user can do all of it by another way (the loopback trust model).
 * Also allowed: promotion (`scripts/promote.ts` checks the CLAUDE.md conditions itself) and the parallel guard's `release` (a step of the skills; `claim` / `overlap` stay out).
 */
export function taskAllowRules(metaPath: string, cwd: string): string[] {
  const skills = [cwd, `${cwd}-*`].flatMap((root) => ["ops-kit/skills", ".claude/skills"].map((dir) => `/${root}/${dir}/**`));
  return [
    "Bash(bun scripts/merge-gate.ts:*)",
    `Bash(bun ${join(metaPath, "scripts/merge-gate.ts")}:*)`,
    "Bash(bun scripts/promote.ts:*)",
    `Bash(bun ${join(metaPath, "scripts/promote.ts")}:*)`,
    "Bash(bun scripts/parallel-guard.ts release:*)",
    `Bash(bun ${join(metaPath, "scripts/parallel-guard.ts")} release:*)`,
    "Bash(ops-kit pr resolve-thread:*)",
    "Bash(gh pr comment:*)",
    "Bash(gh stack submit:*)",
    "Bash(gh stack push:*)",
    "Bash(ops-kit pr push-rebased)",
    "Bash(ops-kit backlog:*)",
    ...skills.flatMap((path) => [`Edit(${path})`, `Write(${path})`]),
  ];
}

/**
 * PATH for a Task's runner and for the jobs the daemon starts for it: the kit's bin first (the check in front of `gh`),
 * then the daemon's own PATH, and the folder of the bun this daemon runs on last (a daemon started by bun's full
 * path has none in its PATH; last, so that it does not come before the user's own tools). Without the meta workspace
 * there is no kit bin.
 */
export function kitPath(metaPath: string | null, base = process.env.PATH ?? ""): string {
  return [...(metaPath ? [join(metaPath, "ops-kit/bin")] : []), base, dirname(process.execPath)].join(delimiter);
}

/** Starting a Task's runner process: the arguments, the environment and the sandbox it is started with, here or in the cloud. */
export abstract class TaskSessions extends TaskEvents {
  /** The heavy slots' directory, made if missing. Not made = not added: one line on the task, which still starts (`ops-kit heavy` then runs without a slot). */
  /** The waits directory, made; undefined when there is none or it cannot be made (the waits go on, unshown). */
  private waitsDirFor(): string | undefined {
    if (!this.waitsDir) return undefined;
    try {
      mkdirSync(this.waitsDir, { recursive: true });
      return this.waitsDir;
    } catch {
      return undefined;
    }
  }

  private heavySlotsDir(taskId: string): string | undefined {
    if (!this.heavyStateDir) return undefined;
    try {
      mkdirSync(this.heavyStateDir, { recursive: true });
      return this.heavyStateDir;
    } catch (e) {
      this.record(taskId, { t: "status", text: `重い処理の枠の置き場をサンドボックスで書ける場所に足せませんでした: ${this.heavyStateDir} (${e instanceof Error ? e.message : String(e)})` });
      return undefined;
    }
  }

  /**
   * A turn that starts a runner process: the first of a new task, or a reply that finds none. An adapter that throws
   * from start() (a missing binary, a server that refused the session, no file descriptors left: EMFILE) leaves the
   * row saying why — error event, status error — instead of an idle task that never ran.
   */
  protected startOrFail(task: Task, prompt: string, atts: Attachment[], resume?: string, preamble?: string) {
    try {
      this.startSession(task, prompt, resume, preamble, atts);
    } catch (e) {
      this.record(task.id, { t: "error", message: String((e as Error).message ?? e) });
      // a Cloud Task lands on idle / error by whether it got a session; a local one is already error (startSession)
      if (task.executionMode === "cloud") this.updateCloudState(task.id);
      else this.setStatus(task.id, "error");
      throw e;
    }
  }

  /** The resume of a start that continues the Task's session: its id, or (when this machine has no record of it) a recap for a new session. */
  protected resumeArgs(task: Task): { resume?: string; preamble?: string } {
    const resume = task.runnerSessionId ?? undefined;
    // A task moved from another machine whose session record did not come along: `--resume` would fail at once
    // (error_during_execution), so start a new session and hand it the transcript Switchboard kept.
    if (resume && this.adapters.get(task.runner)?.hasSession?.(resume) === false) {
      this.record(task.id, { t: "status", text: `前のセッション（${resume}）の記録がこの機械に無いため、これまでのやり取りを渡して新しいセッションで続けます` });
      return { preamble: recapOf(this.db.listEvents(task.id).map((e) => e.ev)) };
    }
    return { resume };
  }

  /* ---------- internals ---------- */

  /**
   * Tasks from before the approval mode was kept per Task carry no mode (NULL). Resuming one goes through the same resolution as a new task (saved
   * runner default → adapter default) and records the result, so the row says what the resumed turn ran with.
   */
  protected withResolvedMode(task: Task): Task {
    if (task.permissionMode !== null) return task;
    const mode = this.resolvePermissionMode(task.runner);
    if (mode === null) return task;
    const updated = this.db.updateTask(task.id, { permissionMode: mode });
    if (!updated) return task;
    this.broadcast({ type: "task.updated", task: updated });
    return updated;
  }

  private startSession(task: Task, prompt: string, resumeSessionId: string | undefined, preamble?: string, attachments: Attachment[] = []) {
    const adapter = this.adapters.get(task.runner);
    if (!adapter) throw new Error(`runner "${task.runner}" is not installed`);
    // A task moved from another machine whose folder is not here: say so on the task and fail like a start
    // that threw (callers note it on a primary / answer 409), instead of a spawn error with no trace on the task.
    if (!existsSync(task.cwd)) {
      const msg = `作業フォルダ ${task.cwd} がこの機械に無いため、ランナーを起動できません`;
      this.record(task.id, { t: "status", text: msg });
      this.setStatus(task.id, "error");
      throw new Error(msg);
    }
    // A checkout that is not the workspace's registered repository (a rebuild that cloned a public one of the
    // same name) would take the task's worktrees, pushes and PRs there: it does not start, the same way
    const mismatch = task.workspaceId ? originMismatch(task.cwd, this.db.getWorkspaceBacklogSource(task.workspaceId), this.originOf) : null;
    if (mismatch) {
      this.record(task.id, { t: "status", text: mismatch });
      this.setStatus(task.id, "error");
      throw new Error(mismatch);
    }
    // A new process reads the config again: a Task continued after it changed is refused as a new one is
    const unconfirmed = this.unconfirmedRunnerConfig(task);
    if (unconfirmed) {
      this.record(task.id, { t: "status", text: unconfirmed.message });
      this.setStatus(task.id, "error");
      throw unconfirmed;
    }
    if (task.executionMode === "cloud") { this.startCloudSession(task, prompt, adapter); return; }
    // A fork's first start: a new session branched from the parent's, at the turn the fork was taken at. Never a
    // new session without the parent's conversation: when this machine has no record of it, the start fails.
    let fork: { turn: string } | undefined;
    if (task.forkOf && !task.runnerSessionId) {
      const parentSession = task.forkSeq === null ? null : this.db.sessionAt(task.forkOf, task.forkSeq);
      if (!parentSession || adapter.hasSession?.(parentSession) === false || !task.forkTurn) {
        const msg = "分岐元のセッションがこの機械に無いため、分岐を始められません";
        this.record(task.id, { t: "status", text: msg });
        this.setStatus(task.id, "error");
        throw new Error(msg);
      }
      resumeSessionId = parentSession;
      fork = { turn: task.forkTurn };
    }
    // Development-standard skills where the runner reads them. A skill that cannot be placed does not stop the task —
    // unless a copy placed before may then be one rendered for other conditions (below).
    const meta = this.db.listWorkspaces().find((w) => w.kind === "meta");
    if (meta) {
      let sync: SkillSyncOptions | undefined;
      try {
        // Rendered for this Task: its runner's place only, the review setting as it is now, and each repository's own backlog
        const workspaces = this.db.listWorkspaces();
        const own = task.workspaceId ? workspaces.find((w) => w.id === task.workspaceId) : undefined;
        const metaRoot = realpathOr(meta.path);
        const backlog = (root: string) => (root === metaRoot ? meta.backlog : (own ?? workspaces.find((w) => realpathOr(w.path) === root))?.backlog) ?? "github";
        // the settings kept on Switchboard's side decide the copies' conditions when the repository has no file of its own
        const savedConfig = (root: string) => savedConfigFile((root === metaRoot ? meta : own ?? workspaces.find((w) => realpathOr(w.path) === root))?.id);
        sync = { metaPath: meta.path, cwd: task.cwd, runner: task.runner, review: this.reviewRunner?.() ?? "other", recheck: this.recheckRunner?.() ?? "other", backlog, savedConfig };
        for (const s of syncSkills(sync).skipped) {
          this.record(task.id, { t: "status", text: `スキル ${s.name} はリポジトリにあるもの（${s.path}）を使います。Switchboard の正本は置いていません` });
        }
      } catch (e) {
        // The copies are the only place the runner reads the review setting from (no environment variable carries it):
        // one left from an earlier start may be rendered for the other setting, and the runner would follow it. So the
        // runner starts only when the copies that are there are verified to be the ones for the conditions now (or
        // there is none); otherwise this start is refused, and the next one tries to place them again.
        let current = false;
        try {
          current = sync !== undefined && skillCopiesCurrent(sync);
        } catch {
          // the source cannot be rendered either: not verified
        }
        if (!current) {
          const msg = `スキルを今の設定（レビューするランナーなど）で置き直せず、置いてある写しが今の設定のものと確かめられないため、Task を始めません: ${(e as Error).message ?? e}。原因を直してからもう一度送ると、置き直してから始めます`;
          this.record(task.id, { t: "status", text: msg });
          this.setStatus(task.id, "error");
          throw new Error(msg);
        }
        this.record(task.id, { t: "status", text: `スキルを置けませんでした: ${(e as Error).message ?? e}` });
      }
      // Copies of the operating tools that do not call the shared kit; noted, never stopped on.
      try {
        for (const name of setupScripts({ metaPath: meta.path, cwd: task.cwd }).copies) {
          this.record(task.id, { t: "status", text: `scripts/setup/${name} は共通キットを呼ばない写しです。検査の結果が共通スキルとずれることがあります` });
        }
      } catch (e) {
        this.record(task.id, { t: "status", text: `scripts/setup を調べられませんでした: ${(e as Error).message ?? e}` });
      }
    }
    // The check in front of `gh` (docs/design/secret-guard.md): the order is `kitPath`'s
    const path = meta ? { PATH: kitPath(meta.path) } : undefined;
    const deviceAuth = this.deviceAuthEnv?.(task.id);
    // Everything the task starts, detached or not, carries this; onTaskEnd stops what still does. The kit's
    // `ops-kit heavy` names the Task of a job holding or waiting for a slot by OPS_KIT_TASK_ID (the kit names no app).
    // OPS_KIT_REVIEW_RUNNER: the review setting at this start or resume. The skills placed now carry the setting in their
    // text and do not read it; a skill folder an earlier release left in the checkout (one this release does not replace)
    // still does, and would otherwise fall back to the other runner whatever the setting says
    const env = { ...path, ...deviceAuth, ...this.dockerEnv?.(task.id), SWITCHBOARD_TASK_ID: task.id, OPS_KIT_TASK_ID: task.id, OPS_KIT_REVIEW_RUNNER: this.reviewRunner?.() ?? "other", OPS_KIT_RECHECK_RUNNER: this.recheckRunner?.() ?? "other", ...(this.workMachine ? { [FORGE_READ_ONLY_ENV]: "1" } : {}) };
    // The stop for writes to fixed names right under /tmp (docs/design/shared-tmp-guard.md): the kit's hook
    const guards = meta ? [shellQuote(join(meta.path, "ops-kit/bin/deny-shared-tmp"))] : undefined;
    const allow = meta ? taskAllowRules(meta.path, task.cwd) : undefined;
    // How to report a stop and when to retry, and how to register an artifact: once per session, with only the
    // sentences that hold for this Task. A process started again on the same session (a reply after the idle release,
    // a queued reply, an automatic resume) already has them in its conversation and is told only the stops still
    // open. A recap (`preamble`) goes last: it ends with the heading of the person's message, which the prompt follows.
    const open = reduceStops(stopRecordsFor(this.db, task)).filter((s) => s.state !== "resolved");
    const servers = this.mcpServers?.(task);
    if (this.isBareCommand(task.scheduleId)) preamble = undefined;
    else if (resumeSessionId && !fork) preamble = openStopsPrompt(open) || undefined;
    else preamble = [stopRecoveryPrompt(open, { workspaceMcp: !!servers && "workspace" in servers, stage: !!task.stage, planMode: task.permissionMode === "plan" }), artifactPrompt(), preamble].filter((p): p is string => !!p).join("\n\n");
    // in flight before the adapter can emit anything: its events only move a running / waiting task (onEvent)
    this.setStatus(task.id, "running");
    const live: LiveSession = { session: undefined as unknown as RunnerSession, lastEventAt: Date.now(), held: [], pendingPermissions: new Map(), hostAsks: new Map(), ruleMatches: new Map(), effort: task.effort ?? "", turnErrors: [], turnCalls: new Map(), turnGithub: new Map(), stopReader: new StopFenceReader(), artifactReader: new FenceReader("switchboard-artifact", parseArtifactFence) };
    this.live.set(task.id, live);
    try {
      // For the runner that cannot run the hook (Codex): a temp directory of the task's own, removed when it ends.
      // Not made = the task does not start (the error below), never a Codex without the stop.
      const privateTmp = meta && task.runner === "codex" && this.privateTmpRoot ? makePrivateTmp(this.privateTmpRoot, task.id) : undefined;
      // The heavy slots are writable to the sandbox too: only for this start, never into the saved scope
      const heavy = meta && task.runner === "codex" ? this.heavySlotsDir(task.id) : undefined;
      // so are the records of its waits (`ops-kit wait`): without them the screen cannot say what a sandboxed Task waits for
      const waits = task.runner === "codex" ? this.waitsDirFor() : undefined;
      live.session = adapter.start(
        { cwd: task.cwd, scope: [...task.scope, ...[heavy, waits].filter((d): d is string => !!d && !task.scope.includes(d))], prompt, model: task.model ?? undefined, permissionMode: task.permissionMode ?? undefined, effort: task.effort ?? undefined, subagentEffort: task.subagentEffort ?? undefined, subagentModel: task.subagentModel ?? undefined, resumeSessionId, fork, preamble, env, guards, allow, privateTmp, bedrock: this.bedrock?.(task), attachments, attachmentDir: this.attachments?.taskDir(task.id), mcpServers: servers, otel: this.otelFor?.(task.id), runnerTelemetry: this.runnerTelemetry?.() ?? false },
        (ev) => this.fromRunner(task.id, live, ev),
      );
    } catch (e) {
      // An adapter that throws from start() must not leave a session-less entry behind (shutdown would trip on it).
      this.live.delete(task.id);
      this.setStatus(task.id, "error");
      throw e;
    }
    void live.session.exited.then((code) => {
      for (const resolve of live.hostAsks.values()) resolve("deny");
      live.hostAsks.clear();
      if (this.live.get(task.id) === live) {
        this.disarmIdle(live);
        this.live.delete(task.id);
        const afterExit = () => {
          const cur = this.db.getTask(task.id);
          // the runner gone took its background jobs with it, and no notification will start the next turn
          // (nor count them: the turn end made up below must not read the count as jobs still running)
          live.background = 0;
          if (cur?.background) {
            const jobs = cur.background.jobs.join(" / ") || "内容不明";
            try {
              this.db.sqlite
                .transaction(() => {
                  this.db.setTaskBackground(task.id, null);
                  // the turn had ended ok (that is how it came to wait): back to done, with the resume planned below
                  const now = cur.status === "background" ? this.transition(task.id, "done") ?? cur : cur;
                  if (now.status !== "done" && now.status !== "error") return;
                  this.record(task.id, { t: "status", text: `裏で実行中の処理がランナーの終了で失われました: ${jobs}` });
                  if (now.resumeAt === null) planResumeAfterStop(this.db, now, Date.now(), (ev) => this.recordPlanned(task.id, ev), this.maxStopResumes());
                })
                .immediate();
              this.broadcast({ type: "task.updated", task: this.db.getTask(task.id)! });
              this.notifyBackgroundEmpty(task.id, true);
            } catch (e) {
              console.error(`task ${task.id}: the lost background jobs were not recorded:`, e); // the mark stays: the next start reports them
            }
          }
          live.afterHeld = () => this.maybeEnded(task.id);
          if (cur && IN_FLIGHT.has(cur.status)) {
            this.fromRunner(task.id, live, { t: "session.end", status: code === 0 ? "ok" : "error", summary: `runner exited (${code})` });
          } else this.takeHeld(task.id, live);
          // the process is gone (out of `live`, so no move above reached it): what was held goes on now
          this.flushHeldReplies(task.id, live);
        };
        if (live.held.length) live.afterHeld = afterExit;
        else afterExit();
      } else if (live.background && !this.live.has(task.id)) {
        // closed on purpose (released, aborted): nothing will report these jobs ending. Not when a new process took over the task.
        try {
          this.db.setTaskBackground(task.id, null);
          // an abort moved the task already; a shutdown's cut leaves it waiting on jobs that are gone: back to done (its resume is planned)
          if (this.db.getTask(task.id)?.status === "background") this.transition(task.id, "done");
          const cur = this.db.getTask(task.id);
          if (cur) this.broadcast({ type: "task.updated", task: cur });
          this.notifyBackgroundEmpty(task.id, true);
        } catch (e) {
          console.error(`task ${task.id}: background mark not cleared:`, e); // the next start clears it
        }
      }
    });
  }

  private startCloudSession(task: Task, prompt: string, adapter: RunnerAdapter) {
    const preparation = readCloudPreparation(task.cwd);
    this.record(task.id, { t: "status", text: `Cloud 明示選択による転送範囲の了承。起動直前の Git 状態: ${JSON.stringify(preparation)}` });
    const live: LiveSession = { session: undefined as unknown as RunnerSession, lastEventAt: Date.now(), held: [], effort: "", pendingPermissions: new Map(), hostAsks: new Map(), ruleMatches: new Map(), turnErrors: [], turnCalls: new Map(), turnGithub: new Map(), stopReader: new StopFenceReader(), artifactReader: new FenceReader("switchboard-artifact", parseArtifactFence) };
    this.live.set(task.id, live);
    this.setStatus(task.id, "running");
    try {
      live.session = adapter.start({ executionMode: "cloud", cwd: task.cwd, scope: [task.cwd], prompt }, (ev) => this.fromRunner(task.id, live, ev));
    } catch (e) {
      this.live.delete(task.id); this.updateCloudState(task.id); throw e;
    }
    void live.session.exited.then(() => {
      if (this.live.get(task.id) !== live) return;
      this.live.delete(task.id);
      const current = this.updateCloudState(task.id);
      this.record(task.id, { t: "status", text: current.cloudSession ? "開始プロセスは終了しました。Cloud 作業の状態は未確認です。公式 Web で操作してください。" : "Cloud 作成の参照を確認できません。公式 Web で有無を確認してください。自動再試行はしません。" });
    });
  }
}
