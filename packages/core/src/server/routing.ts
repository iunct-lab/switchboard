import { existsSync } from "node:fs";
import type { RunnerId, AgentEvent, Task, LlmRoutingSettings, Workspace } from "@switchboard/protocol";
import { ledgerRowFor } from "../pricing.ts";
import { loadProcess } from "../process-defs.ts";
import { collectProvenance } from "../provenance.ts";
import { CompositeSuggester, suggestRunner, type RoutingContext, type Suggester } from "../routing.ts";
import { DEFAULT_EXAMPLE_COUNT, LlmSuggester, readOnlyMode } from "../suggest-llm.ts";
import { WorkspaceSuggester } from "../suggest-workspace.ts";
import { isFableModel, type NewTaskInput } from "../tasks/state.ts";
import { provisionalTitle } from "../tasks/manager.ts";
import type { SuggestCtxInput, ServerContext } from "./context.ts";

export const routingContext = (sc: Pick<ServerContext, "db" | "adapterMap">, input: SuggestCtxInput): RoutingContext => {
  const ws = input.workspaceId ? sc.db.getWorkspace(input.workspaceId) : null;
  const cwd = input.cwd ?? ws?.path;
  const scope = Array.from(new Set([cwd, ...(input.scope ?? [])].filter((d): d is string => !!d)));
  return { title: input.title ?? provisionalTitle(input.prompt), prompt: input.prompt, scope, kind: input.kind, workspaceKind: ws?.kind, previousRunner: sc.db.lastRunnerFor(ws?.id, cwd), available: new Set(sc.adapterMap.keys()) };
};

export const suggestFor = (sc: Pick<ServerContext, "routing" | "routingContext">, input: SuggestCtxInput) => suggestRunner(sc.routing.table, sc.routingContext(input));

/**
 * The runner's own choice for a job that picks a runner (judge, suggestion, titles, review): an empty model or effort
 * is the runner's saved default (`defaultModel` / `defaultEffort`), and an empty one after that is the CLI's own. An
 * effort the runner no longer lists is dropped.
 */
export const runnerChoice = (sc: Pick<ServerContext, "settings" | "tasks">, runner: RunnerId, model: string, effort: string): { runner: RunnerId; model: string; effort: string } => {
  const s = sc.settings();
  const e = effort || s.defaultEffort[runner] || "";
  return { runner, model: model || s.defaultModel[runner] || "", effort: e && !sc.tasks.checkEffort(runner, e) ? e : "" };
};

/**
 * The real LLM suggester: the configured runner's own adapter, one read-only turn in the daemon's data directory
 * (never a repository), the last decisions as training data. A runner that is not detected means no suggestion —
 * the rule table then stands, and the settings PATCH already refuses to enable an uninstalled one.
 */
export const defaultLlmSuggester = (sc: Pick<ServerContext, "adapterMap" | "suggestDir" | "runnerChoice" | "db">, llmCfg: LlmRoutingSettings, onUsage: (ev: Extract<AgentEvent, { t: "usage" }>) => void, taskId: string): Suggester | null => {
  const adapter = sc.adapterMap.get(llmCfg.runner);
  if (!adapter) {
    console.warn(`routing: LLM suggestions are on but runner "${llmCfg.runner}" is not installed; using the rule table`);
    return null;
  }
  // A runner that has permission modes but none we know to be read-only would run the turn in its *default*
  // mode (Claude auto, Codex workspace-write). A suggestion is not worth a runner that may edit anything.
  const ro = readOnlyMode(adapter);
  if (ro.unconstrained && adapter.permissionModes?.length) {
    console.warn(`routing: ${adapter.id} has no read-only permission mode; not asking it for suggestions`);
    return null;
  }
  // the task is already in the log by the time it is asked about: it is no example of itself
  return new LlmSuggester({ adapter, cwd: sc.suggestDir, ...sc.runnerChoice(llmCfg.runner, llmCfg.model, llmCfg.effort), permissionMode: ro.mode, examples: () => sc.db.routingLog(DEFAULT_EXAMPLE_COUNT + 1).filter((r) => r.taskId !== taskId), onUsage, log: (m) => console.warn(m) });
};

/**
 * The LLM's proposal for a task that exists: nothing waits for it. The rule table has already decided, and
 * the task runs on without it; the answer is kept on the task when it comes in time, also after the task ended. `ctx`
 * was taken before the task was created, so the task is not its own history. Only task creation pays for it:
 * `POST /api/tasks/suggest` (typed into on every keystroke) stays rule-table-only.
 */
export const runRoutingAdvice = (sc: Pick<ServerContext, "settings" | "adviceStop" | "db" | "pricingTable" | "loginKindOf" | "opts" | "defaultLlmSuggester" | "ruleSuggester" | "tasks" | "adviceRunning">, taskId: string, ctx: RoutingContext): void => {
  const llmCfg = sc.settings().routing.llm;
  if (!llmCfg.enabled || sc.adviceStop.signal.aborted) return;
  const run = (async () => {
    // billed as reported, under the runner that answered (not the task's own): a turn that then fails or misses the deadline spent it too
    const onUsage = (u: Extract<AgentEvent, { t: "usage" }>) => {
      if (!sc.adviceStop.signal.aborted) sc.db.insertLedger(ledgerRowFor(sc.pricingTable(), { id: taskId, runner: llmCfg.runner, model: u.model ?? null }, u, Date.now(), sc.loginKindOf(llmCfg.runner)));
    };
    const primary = (sc.opts.llmSuggester ?? sc.defaultLlmSuggester)(llmCfg, onUsage, taskId);
    if (!primary) return;
    const { llm } = await new CompositeSuggester(primary, sc.ruleSuggester, llmCfg.timeoutMs, (m) => console.warn(m)).suggest(ctx, sc.adviceStop.signal);
    if (llm && !sc.adviceStop.signal.aborted) sc.tasks.attachLlmSuggestion(taskId, llm);
  })().catch((e) => console.warn(`routing: the LLM suggestion for ${taskId} failed (${String((e as Error).message ?? e)})`));
  sc.adviceRunning.add(run);
  void run.finally(() => sc.adviceRunning.delete(run));
};

/**
 * Provenance (docs/design/process-kernel.md, K1): written right after the row exists, from the input the task was created
 * with. A failure to record never stops the task (it is noted on it). The process named by the input must exist
 * (checked where the input is parsed); `version` comes from the definition as it is at this moment.
 */
export const recordProvenance = (sc: Pick<ServerContext, "metaWorkspace" | "db" | "tasks">, t: Task, input: { process?: string; processReason?: string; issues?: number[] }) => {
  try {
    const meta = sc.metaWorkspace();
    const def = input.process ? loadProcess(input.process, meta?.path) : null;
    sc.db.setTaskProvenance(t.id, collectProvenance({ cwd: t.cwd, metaPath: meta?.path ?? null, runner: t.runner, model: t.model, effort: t.effort, permissionMode: t.permissionMode, process: def ? { id: def.id, version: def.version } : null, processReason: input.processReason ?? null, issues: input.issues ?? null }));
  } catch (e) {
    sc.tasks.record(t.id, { t: "status", text: `由来を記録できませんでした: ${(e as Error).message ?? e}` });
  }
};

/**
 * The settings' default budget for a Task of this model: a Fable Task takes `fableBudgetUsd` first, then `defaultBudgetUsd` (null = none).
 * An empty model is the runner's saved default model, the one `tasks.create` will start it on.
 */
export const defaultBudgetFor = (sc: Pick<ServerContext, "settings">, model: string | null | undefined, runner?: RunnerId): number | null => {
  const s = sc.settings();
  const qr = s.quotaAndResume;
  const resolved = model || (runner ? s.defaultModel[runner] : undefined);
  return (isFableModel(resolved) ? qr.fableBudgetUsd : null) ?? qr.defaultBudgetUsd;
};

/** A local Task made without a budget takes the settings' default (null = none); an explicit one is kept. Cloud Tasks do not take it. */
export const withDefaultBudget = <T extends { budgetUsd?: number | null; model?: string | null; runner?: RunnerId }>(sc: Pick<ServerContext, "defaultBudgetFor">, given: T): T => {
  const defaultBudget = sc.defaultBudgetFor(given.model, given.runner);
  return given.budgetUsd === undefined && defaultBudget !== null ? { ...given, budgetUsd: defaultBudget } : given;
};

/**
 * Creates a routed task on the rule table's suggestion and asks the LLM afterwards. A task whose runner failed to start
 * is saved as an error before `tasks.create` throws, so the advice follows the row rather than the return.
 */
export const createRouted = (sc: Pick<ServerContext, "withDefaultBudget" | "routingContext" | "tasks" | "routing" | "recordProvenance" | "runRoutingAdvice">, given: NewTaskInput & SuggestCtxInput, afterInsert?: (task: Task) => void, deferUntil?: number): Task => {
  const input = sc.withDefaultBudget(given);
  const ctx = sc.routingContext(input);
  const saved: string[] = [];
  try {
    return sc.tasks.create(input, suggestRunner(sc.routing.table, ctx), (t) => {
      saved.push(t.id);
      sc.recordProvenance(t, input);
      afterInsert?.(t);
    }, deferUntil === undefined ? {} : { deferUntil });
  } finally {
    // a Task held at the limit asks no LLM now: the advice would spend the very quota it waits for
    if (deferUntil === undefined) for (const id of saved) sc.runRoutingAdvice(id, ctx);
  }
};

/** Thrown by `chooseWorkspace`: the 409 body. Never a silent default — that would read as "the daemon chose this". */
export const pickYourself = (_sc: unknown, why: string) => new Error(`Workspace を選んでください（${why}）`);

/**
 * "自動": `POST /api/tasks` without cwd and workspaceId. One read-only turn of the routing runner
 * (`routing.llm` runner / model; `enabled` is not consulted — leaving the select on 自動 is the instruction,
 * `enabled` is the switch for runner suggestions) picks among the registered Workspaces.
 */
export const chooseWorkspace = async (sc: Pick<ServerContext, "settings" | "db" | "cfg" | "pickYourself" | "adapterMap" | "suggestDir">, input: { title?: string; prompt: string }): Promise<{ workspace: Workspace; reason: string; usage: Extract<AgentEvent, { t: "usage" }>[]; runner: RunnerId }> => {
  const llmCfg = sc.settings().routing.llm;
  const workspaces = sc.db.listWorkspaces().filter((ws) => existsSync(ws.path) && !(sc.cfg.releaseOnly && ws.kind === "meta"));
  if (workspaces.length === 0) throw sc.pickYourself("登録済みの Workspace がありません");
  const adapter = sc.adapterMap.get(llmCfg.runner);
  if (!adapter) throw sc.pickYourself(`自動選択に使うランナー ${llmCfg.runner} が未検出`);
  const ro = readOnlyMode(adapter);
  if (ro.unconstrained && adapter.permissionModes?.length) throw sc.pickYourself(`${adapter.id} に読み取り専用モードがありません`);
  const usage: Extract<AgentEvent, { t: "usage" }>[] = [];
  const suggester = new WorkspaceSuggester({ adapter, cwd: sc.suggestDir, model: llmCfg.model, permissionMode: ro.mode, onUsage: (u) => usage.push(u), log: (m) => console.warn(m) });
  const hangMs = sc.settings().judgeAndChoice.workspaceChoiceTimeoutMs;
  const deadline = AbortSignal.timeout(hangMs);
  try {
    const choice = await suggester.suggest({ title: input.title ?? provisionalTitle(input.prompt), prompt: input.prompt, workspaces, runners: [...sc.adapterMap.keys()] }, deadline);
    return { workspace: workspaces.find((ws) => ws.id === choice.workspaceId)!, reason: choice.reason, usage, runner: llmCfg.runner };
  } catch (e) {
    // No task exists to bill a failed turn to (ledger rows belong to a task), so what it spent is at least logged.
    console.warn(`workspace: ${llmCfg.runner} could not choose (${String((e as Error).message ?? e)})${usage.length ? `; the turn reported ${JSON.stringify(usage)}` : ""}`);
    throw sc.pickYourself(deadline.aborted ? `${llmCfg.runner} が ${hangMs / 1000} 秒以内に答えませんでした` : `${llmCfg.runner} が選べませんでした: ${String((e as Error).message ?? e).slice(0, 160)}`);
  }
};
