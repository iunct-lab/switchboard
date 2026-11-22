import { existsSync } from "node:fs";
import type { AutoStartKind, FeedbackInput, RunnerId, BacklogAction, BacklogItem, Task, Workspace } from "@switchboard/protocol";
import { displayPath } from "../db.ts";
import { buildFeedbackPrompt, type FeedbackSource, feedbackTitle, upstreamRequest } from "../feedback.ts";
import { delegatedNote } from "../evals.ts";
import { deferNote, fallbackNote, fallbackRunner, RESUME_MARGIN_MS } from "../ratelimit.ts";
import { heldLine } from "../lease.ts";
import { loadProcess } from "../process-defs.ts";
import { localForgeOf } from "../backlog-local.ts";
import { savedConfigFile } from "../workspace-config.ts";
import { syncsGithub } from "../backlog-gh.ts";
import { buildDirectPrompt, buildStartPrompt, subagentModelAlias, startTitle } from "../backlog-prompt.ts";
import { screenAnswer } from "../backlog-edit.ts";
import { autoStartHeld } from "../stage-start-gate.ts";
import { otherRepo } from "./helpers.ts";
import type { ServerContext } from "./context.ts";

/**
 * The runner a Task that starts by itself is decided on, before 上限のときの代わり: the caller's (a start request's,
 * or a schedule's) when it is detected, else the kind's own when it is detected, else the saved one; only a saved one that is not detected falls back to
 * claude. null = none to start on. startMetaTask starts on it, and backlog-next reads its usage.
 */
export const decidedRunner = (sc: Pick<ServerContext, "settings" | "adapterMap">, kind: AutoStartKind, runner?: RunnerId): RunnerId | null => {
  const auto = sc.settings().autoStart;
  if (runner && sc.adapterMap.has(runner)) return runner;
  const own = auto.byKind[kind];
  if (own?.runner && sc.adapterMap.has(own.runner)) return own.runner;
  const configured = runner ?? auto.runner;
  return sc.adapterMap.has(configured) ? configured : !runner && sc.adapterMap.has("claude") ? "claude" : null;
};

/**
 * 上限のときの代わり: the runner a Task that starts by itself (a stage button, feedback, a schedule) starts on,
 * and the transcript's status line when it is not the decided one.
 */
export const autoRunner = (sc: Pick<ServerContext, "settings" | "db" | "adapterMap">, decided: RunnerId): { runner: RunnerId; note?: string; deferUntil?: number; deferNote?: string } => {
  const now = Date.now();
  const r = fallbackRunner(decided, sc.settings().autoStart, (x) => sc.db.quotaFor(x), (x) => sc.adapterMap.has(x), now);
  // no way round the limit: the Task is made without starting and starts when the window resets
  if (r.held) return { runner: r.runner, deferUntil: r.held.resetsAt + RESUME_MARGIN_MS, deferNote: deferNote(r.held, now) };
  return r.from ? { runner: r.runner, note: fallbackNote(r.runner, r.from, now) } : { runner: r.runner };
};

/**
 * A fixed-prompt Task on the meta workspace (feedback, backlog stage buttons, backlog-next): the saved
 * 自動で始まる Task の既定 (`settings.autoStart`), else claude. A schedule passes its own runner and id. A backlog stage button on another
 * workspace's Issue, and a request filed for another workspace, pass that workspace (`ws`). The caller's runner
 * wins over the kind's own choice (`autoStart.byKind`), which wins over the saved one, each when its runner is detected.
 * A `prompt` given as a function is written for the runner the Task starts on (known only here, after 上限のときの代わり),
 * and again for its shadow's runner.
 */
export const startMetaTask = async (sc: Pick<ServerContext, "metaWorkspace" | "settings" | "adapterMap" | "decidedRunner" | "autoRunner" | "tasks" | "attachments" | "createRouted">, req: { kind: AutoStartKind; title: string; prompt: string | ((runner: RunnerId) => string); attachmentIds?: string[]; runner?: RunnerId; model?: string; effort?: string; scheduleId?: string; shadowRunner?: null; budgetUsd?: number | null; ws?: Workspace; stage?: Task["stage"]; process?: string; processReason?: string; note?: string }): Promise<{ task: Task } | { error: string; status: number }> => {
  const meta = req.ws ?? sc.metaWorkspace();
  if (!meta) return { error: "meta workspace がありません", status: 409 };
  if (!existsSync(meta.path)) return { error: "workspace directory does not exist", status: 409 };
  const auto = sc.settings().autoStart;
  const own = auto.byKind[req.kind];
  // a kind without its own runner follows the caller's / the common one: its model and effort belong to its own runner only
  if (!(req.runner && sc.adapterMap.has(req.runner)) && own?.runner && sc.adapterMap.has(own.runner)) req = { ...req, runner: own.runner, model: own.model, effort: own.effort };
  const decided = sc.decidedRunner(req.kind, req.runner);
  if (!decided) return { error: "ランナーが検出されていません", status: 409 };
  // the decided runner at its limit: the order's next one, on its CLI default model and effort
  const { runner, note, deferUntil, deferNote: held } = sc.autoRunner(decided);
  // the saved model goes with the saved runner only; a caller's own runner brings its own model (empty = the CLI default)
  const model = note ? "" : req.runner ? req.model : runner === auto.runner ? auto.model : "";
  // the effort follows the same rule; a saved one the runner no longer lists falls back to the CLI default
  const wanted = note ? "" : req.runner ? req.effort : runner === auto.runner ? auto.effort : "";
  const effort = wanted && !sc.tasks.checkEffort(runner, wanted) ? wanted : "";
  if (req.attachmentIds?.length) {
    const why = sc.attachments.check(req.attachmentIds);
    if (why) return { error: why.message, status: why.status };
  }
  // the kind's own permission mode goes to the runner it starts on; one that runner no longer lists, or one that
  // skips approvals there, starts on the runner's default
  const mode = own?.permissionMode;
  const permissionMode = mode && !sc.tasks.checkPermissionMode(runner, mode) && !sc.adapterMap.get(runner)?.permissionModes?.find((m) => m.value === mode)?.danger ? mode : "";
  const budgetUsd = own?.budgetUsd ?? req.budgetUsd;
  const input = {
    workspaceId: meta.id, cwd: meta.path, runner, title: req.title, prompt: typeof req.prompt === "function" ? req.prompt(runner) : req.prompt, ...(typeof req.prompt === "function" ? { promptFor: req.prompt } : {}), attachmentIds: req.attachmentIds, scheduleId: req.scheduleId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    // the unattended sweep (shadowRunner: null) never mirrors; otherwise the kind's own 並走 over the common one
    ...(req.shadowRunner === null || own?.shadow === "off" ? { shadowRunner: null } : own?.shadow ? { shadowRunner: own.shadow } : {}),
    // the kind's budget, else the caller's (the schedule's), else the settings' default (createRouted)
    ...(budgetUsd ? { budgetUsd } : {}),
    ...(req.stage ? { stage: req.stage } : {}),
    ...(req.process ? { process: req.process, processReason: req.processReason } : {}),
  };
  try {
    const task = sc.createRouted(input, (t) => {
      if (note) sc.tasks.record(t.id, { t: "status", text: note });
      if (held) sc.tasks.record(t.id, { t: "status", text: held });
      if (req.note) sc.tasks.record(t.id, { t: "status", text: req.note });
    }, deferUntil);
    return { task };
  } catch (e) {
    return { error: String((e as Error).message ?? e), status: 409 };
  }
};

/** The upstream request for a text: the repo is the workspace directory's origin. A moved or removed directory makes the spawn throw: the text to copy is still answered. */
export const upstreamFor = (sc: Pick<ServerContext, "originRepoOf">, ws: Workspace, text: string) => upstreamRequest({ repo: sc.originRepoOf(ws.path), text });

/**
 * A request Task (request-to-backlog): the feedback button's 要望 and a throwaway app used on enough days.
 * `workspaceId` files it in that workspace's repository, as its backlog stage buttons act there; omitted = the meta.
 * An artifact source must name a known artifact; its 出典 gets the Task it came from and where its copy is.
 */
export const startRequestTask = async (sc: Pick<ServerContext, "metaWorkspace" | "db" | "backlogReads" | "upstreamFor" | "artifacts" | "startMetaTask">, input: { text: string; screen?: string; attachmentIds?: string[]; workspaceId?: string; source?: FeedbackInput["source"]; auto?: boolean }): Promise<{ task: Task } | { upstream: { url: string | null; text: string } } | { error: string; status: number }> => {
  const meta = sc.metaWorkspace();
  if (!meta) return { error: "meta workspace がありません", status: 409 };
  const ws = input.workspaceId ? sc.db.getWorkspace(input.workspaceId) : meta;
  if (!ws) return { error: "workspace not found", status: 404 };
  // a request for Switchboard itself, on an instance that does not develop it, goes upstream: no Task is made
  if (!sc.backlogReads(ws)) return { upstream: sc.upstreamFor(ws, input.text) };
  let source: FeedbackSource | undefined;
  if (input.source?.kind === "artifact") {
    const a = sc.artifacts.get(input.source.artifactId);
    if (!a) return { error: "artifact not found", status: 404 };
    source = { kind: "artifact", artifactId: a.id, taskId: a.taskId, copy: `${displayPath(sc.artifacts.folderOf(a))}/` };
  } else source = input.source;
  const when = new Date();
  const prompt = (runner: RunnerId) => buildFeedbackPrompt({ text: input.text, when, screen: input.screen, other: otherRepo(meta, ws), local: ws.backlog === "switchboard", source, auto: input.auto, runner });
  return sc.startMetaTask({ kind: "request", ws, title: feedbackTitle(input.text), prompt, attachmentIds: input.attachmentIds });
};

/**
 * Task ごとの実装のモデル of an 実装 Task that starts now: the saved one while the Task starts on claude
 * (its kind's runner, after 上限のときの代わり) and the model has a subagent alias; else "" — the prompt as before.
 */
export const completeTaskModelFor = (sc: Pick<ServerContext, "settings" | "decidedRunner" | "autoRunner">, runner?: RunnerId): string => {
  const model = sc.settings().autoStart.completeTaskModel;
  if (!model || !subagentModelAlias(model)) return "";
  const decided = sc.decidedRunner("complete", runner);
  return decided && sc.autoRunner(decided).runner === "claude" ? model : "";
};

/** A stage Task runs on the workspace whose repository the Issue is in, so another repository's #n is not the meta's #n. */
export const activeStageTask = (sc: Pick<ServerContext, "db">, workspaceId: string, n: number) => sc.db.activeStageTask(workspaceId, n);

/** The one place that applies the rule of stage-start-gate.ts to an item: null = an automatic start may go, otherwise the previous automatic Task it is held for. */
export const autoHeldOf = (sc: Pick<ServerContext, "db">, ws: Workspace, item: BacklogItem, action: BacklogAction): { previousTaskId: string } | null => {
  const prev = sc.db.lastAutoStageTask(ws.id, item.number, action);
  const running = prev ? sc.db.activeStageTask(ws.id, item.number)?.id === prev.id : false;
  return autoStartHeld(item.events, prev && { id: prev.id, createdAt: prev.createdAt, endedAt: running ? null : prev.statusAt });
};

/**
 * Starts one stage Task of an Issue: the button, backlog-next and the resume after an answer all come here, so
 * the same Issue never has two. A running / waiting one is answered instead of a second; nothing awaits between that
 * check and the Task's creation in startMetaTask, so a second start of the same Issue always finds the first one.
 */
export const startStage = async <A extends true | undefined = undefined>(sc: Pick<ServerContext, "startMetaTask" | "leaseRepository" | "leases" | "activeStageTask" | "db" | "noteMergeGrant" | "settings" | "completeTaskModelFor">, input: {
  ws: Workspace;
  meta: Workspace;
  item: BacklogItem;
  action: BacklogAction;
  resume?: { tasksDone: number };
  /** Why this candidate (backlog-next: `chooseProcess`'s); the buttons leave it out and are recorded as the button / the stage. */
  processReason?: string;
  /**
   * A start the app makes by itself (the queue, the schedule, the resume after an answer). Only this one is held when nothing
   * happened once since the last automatic start of the same stage (stage-start-gate.ts), and only this one is recorded as
   * such: the buttons leave it out, are never held and do not count as the last automatic start.
   */
  auto?: A;
  extra?: Pick<Parameters<typeof sc.startMetaTask>[0], "runner" | "model" | "effort" | "scheduleId" | "shadowRunner" | "budgetUsd">;
}): Promise<{ task: Task } | { active: Task } | { error: string; status: number; held?: true } | (A extends true ? { held: { previousTaskId: string } } : never)> => {
  const { ws, item, action } = input;
  // before the lease, so a held start takes nothing and gives nothing back
  if (input.auto) {
    const held = autoHeldOf(sc, ws, item, action);
    if (held) return { held } as never; // typed by `A`: the union has `held` only for a start made with `auto`
  }
  const stage = { issue: item.number, action, ...(input.auto ? { auto: true as const } : {}) };
  // Two machines share work: the PBI's lease is taken before anything of it starts here (a check only reads and takes
  // none). Alone there is no lease and nothing is awaited, so the check below and the Task's creation stay together.
  // a request's stage makes PBIs: two machines at it would make them twice, so it takes the lease of its number too
  const leaseAt = (item.type === "pbi" || item.type === "request") && action !== "check" && action !== "direct" ? sc.leaseRepository(ws) : null;
  const heldBefore = leaseAt ? sc.leases!.holds(leaseAt, item.number) : false;
  /** A lease taken for a start that did not happen is given back, so the other machine is not kept from the PBI by nothing. */
  const orGiveBack = async <R extends object>(r: R): Promise<R> => {
    if (leaseAt && !heldBefore && !("task" in r) && !("active" in r)) await sc.leases!.release(leaseAt, item.number).catch((e) => console.error(`[lease] PBI #${item.number} was not given back: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
    return r;
  };
  if (leaseAt) {
    try {
      const got = await sc.leases!.acquire(leaseAt, item.number, true);
      // held: this PBI only, so a sweep goes on to the slot's next item
      if (!got.ok) return { error: heldLine(item.number, got.holder, got.until), status: 409, held: true };
    } catch (e) {
      // not known who holds it: not started (the other machine may be at it)
      return { error: `PBI #${item.number} のリースを確かめられません: ${String((e as Error)?.message ?? e).slice(0, 200)}`, status: 409 };
    }
  }
  const active = sc.activeStageTask(ws.id, item.number);
  if (active) return { active };
  const other = otherRepo(input.meta, ws);
  // the person's newest answer on the screen goes in as their words
  const source = action === "check" ? null : sc.db.getWorkspaceBacklogSource(ws.id);
  const answer = source ? screenAnswer(sc.db, source, item.number) : null;
  // the stage runs under the pipeline candidate (docs/design/process-kernel.md, K4); its definition is the meta checkout's, like the skills, not the running release's.
  // A checkout without it (behind, or mid-edit) answers like any other reason a stage cannot start, so a button gets its 409 and a sweep skips the item
  // 直行で直す runs under the direct candidate, the stages under the pipeline
  let def;
  try {
    def = loadProcess(action === "direct" ? "p1-direct" : "p0-pipeline", input.meta.path);
  } catch (e) {
    return orGiveBack({ error: `候補の定義を読めません: ${(e as Error).message ?? e}`, status: 409 });
  }
  // a grant sentence in the screen answer of the Issue is recorded for the first stage Task started after it (the Issue's Task
  // that asked has ended); a later stage Task, while that answer is still the newest, does not get it again. The answer is
  // known by its comment operation's id, which sending it to the service does not change, and the grant's record carries
  // that id: an answer whose id stands in a record is spent, however many starts came in between. "The screen answer" is
  // one an answer route marked because its request came in as the screen's (`grantSource`: it looked like the web UI's
  // and named no sending Task) — an answer a Task or a bare call posted carries no mark, so it is no answer here
  // The grant's head is the one the PR had when the answer was taken (the answer's `heads`), not the one it has at
  // this start: a head pushed in between is not granted, and one that could not be read then is none. Said so in
  // permission-modes.md, "A grant is for the head recorded with it"
  const granting = async (r: Awaited<ReturnType<typeof sc.startMetaTask>>) => {
    if (answer && "task" in r && !sc.db.mergeGrantSourceSpent(answer.id)) await sc.noteMergeGrant(r.task.id, answer.text, { source: answer.id, via: "screen", heads: answer.heads });
    return r;
  };
  if (action === "direct") return orGiveBack(await granting(await sc.startMetaTask({ kind: action, ws, title: startTitle(item, action), stage, prompt: (runner) => buildDirectPrompt(item, { review: sc.settings().reviewRunner, local: ws.backlog === "switchboard", localForge: ws.backlog === "switchboard" && localForgeOf(ws.path, savedConfigFile(ws.id)), answer, runner }, def), process: def.id, processReason: input.processReason ?? "direct button", ...input.extra })));
  const taskModel = action === "complete" ? sc.completeTaskModelFor(input.extra?.runner) : "";
  return orGiveBack(await granting(await sc.startMetaTask({ kind: action, ws, title: startTitle(item, action), stage, prompt: (runner) => buildStartPrompt(item, action, { review: sc.settings().reviewRunner, other, resume: input.resume, local: ws.backlog === "switchboard", localForge: ws.backlog === "switchboard" && localForgeOf(ws.path, savedConfigFile(ws.id)), answer, taskModel, runner }, def), process: def.id, processReason: input.processReason ?? `backlog stage ${action}`, ...(taskModel ? { note: delegatedNote(taskModel) } : {}), ...input.extra })));
};

// the login GitHub refused (the import's failure kind): a stage is not started on it, a stored edit could not be sent either
export const ghLoginRefused = (sc: Pick<ServerContext, "db" | "backlog">, ws: Workspace) => syncsGithub(sc.db.getWorkspaceBacklogSource(ws.id)) && sc.backlog.state(ws).errorKind === "gh-login";

// the last implement-slot (complete / close, SLOT_OF_ACTION) stage Task ended on an `auth` stop and no import has succeeded since: the login is taken as still out (a successful settle moves lastSuccessfulSync and so lifts it)
export const authStopHeld = (sc: Pick<ServerContext, "db">, ws: Workspace): string | null => {
  const source = sc.db.getWorkspaceBacklogSource(ws.id);
  if (!source || !syncsGithub(source)) return null;
  const t = sc.db.lastEndedStageTask(ws.id, ["complete", "close"]);
  const stop = t ? sc.db.listStopRecords([t.id]).at(-1) : undefined;
  if (!t || !stop || stop.reason !== "auth" || stop.state === "resolved") return null;
  return (sc.db.getBacklogRepository(source)?.lastSuccessfulSync ?? 0) < t.statusAt ? `直前の工程 Task ${t.id} が認証で止まり、その後 GitHub から取り込めていない` : null;
};
