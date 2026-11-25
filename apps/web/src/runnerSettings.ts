import type { AutoStartChoice, AutoStartKind, AutoStartSettings, ModelCandidates, NewDefaultsSettings, RunnerId, RunnerInfo, Settings, SettingsPatch } from "@switchboard/protocol";
import { t, type Msg } from "./i18n.ts";
import { home } from "./i18n/home.ts";
import { settings } from "./i18n/settings.ts";
import { isAdkRunner } from "./runners.ts";

/** The kinds of Task that start by themselves, in the order of the card: the feedback modes, then the backlog stages. */
export const AUTO_START_KINDS: Array<[AutoStartKind, Msg]> = [["fix", settings.kindFix], ["request", settings.kindRequest], ["to-pbi", settings.kindToPbi], ["to-tasks", settings.kindToTasks], ["complete", settings.kindComplete], ["check", settings.kindCheck], ["close", settings.kindClose], ["new-repo", settings.kindNewRepo], ["adopt-repo", settings.kindAdoptRepo], ["baseline", settings.kindBaseline], ["bundle", settings.kindBundle]];

/** The rows of a runner's card: the same ones, in the same order, for every runner. */
export const RUNNER_ROWS = ["model", "effort", "permissionMode", "subagentModel", "subagentEffort", "autoResume", "models"] as const;
export type RunnerRowKey = (typeof RUNNER_ROWS)[number];

const ROW_LABELS: Record<RunnerRowKey, Msg> = {
  model: settings.rowModel,
  effort: settings.rowEffort,
  permissionMode: settings.rowPermissionMode,
  subagentModel: settings.rowSubagentModel,
  subagentEffort: settings.rowSubagentEffort,
  autoResume: settings.rowAutoResume,
  models: settings.rowModels,
};

/** Every runner gets all the rows; `editable` is read off what the runner reports, never off its name (a custom runner goes through here too). */
export function runnerRows(info: RunnerInfo): Array<{ key: RunnerRowKey; label: Msg; editable: boolean }> {
  const editable: Record<RunnerRowKey, boolean> = {
    model: info.models.length > 0,
    effort: info.efforts.length > 0,
    permissionMode: info.permissionModes.length > 0,
    subagentModel: info.subagents === true,
    subagentEffort: info.subagents === true,
    autoResume: !isAdkRunner(info.id),
    models: info.models.length > 0,
  };
  return RUNNER_ROWS.map((key) => ({ key, label: ROW_LABELS[key], editable: editable[key] }));
}

/**
 * Whether the runner's モデルの選択肢 row offers the CLI's candidates (read, add, hide). It does not depend on the row being
 * editable: a Bedrock login edits its list (the original ids, `listModels`) and also hides and unhides the candidates its CLI reports.
 */
export function showsCliCandidates(info: Pick<RunnerInfo, "id" | "models">): boolean {
  return (info.id === "claude" || info.id === "codex") && info.models.length > 0;
}

/**
 * What the モデルの選択肢 row shows. The row is never dropped: `folded` is the foldable block (the list editor when `list`,
 * else the 変えられない note, and the CLI candidates when `candidates`); a runner with neither gets the plain 変えられない row.
 */
export function modelsRowView(info: RunnerInfo): { folded: boolean; list: boolean; candidates: boolean } {
  const list = runnerRows(info).find((r) => r.key === "models")!.editable;
  const candidates = showsCliCandidates(info);
  return { folded: list || candidates, list, candidates };
}

/** The CLI candidates a block shows: only its own runners' (a runner's block passes just that runner, so claude's block never lists codex's). */
export function candidatesOf(found: ModelCandidates, runners: Pick<RunnerInfo, "id">[]): ModelCandidates {
  return found.filter((r) => runners.some((x) => x.id === r.runner));
}

/**
 * The name of Home's empty model / effort choice: 「ランナーの既定（<value>）」 only when the runner has a saved default; without
 * one the select keeps its own CLI 既定 name (undefined).
 */
export function homeEmptyLabel(kind: "model" | "effort", info: RunnerInfo | undefined): string | undefined {
  const saved = kind === "model" ? info?.defaultModel : effectiveDefaultEffort(info);
  return saved ? runnerDefaultLabel(kind, info) : undefined;
}

/** What 既定に戻す of one runner's block sends: that runner's six values, each back to "none saved" (the other cards reset by `resetCard` of settingsDefaults.ts). */
export function resetPatch(card: { runner: RunnerId }): SettingsPatch {
  const id = card.runner;
  return { defaultModel: { [id]: null }, defaultEffort: { [id]: null }, defaultPermissionMode: { [id]: null }, subagentModel: { [id]: null }, subagentEffort: { [id]: null }, autoResume: { [id]: null } };
}

/**
 * The runner / model / effort a kind's row shows, as the daemon starts the kind: its own when it has its own runner; a kind
 * that changed only its approval mode, budget or 並走 (no runner of its own) starts on the common row's runner, model and
 * effort, so it shows those (runner undefined = 共通); without a choice of its own, the common row.
 */
export function kindChoice(own: AutoStartChoice | undefined, auto: Pick<AutoStartSettings, "runner" | "model" | "effort">): { runner?: RunnerId; model: string; effort: string } {
  if (own?.runner) return { runner: own.runner, model: own.model, effort: own.effort };
  return { runner: own ? undefined : auto.runner, model: auto.model, effort: auto.effort };
}

/**
 * What a kind's model or effort change sends. A kind without a runner of its own shows the common row's values (kindChoice),
 * and a model or an effort pins the common runner to it, keeping its stored values; so the other shown value is sent along,
 * or it would silently become the runner's default. A shown effort the runner no longer lists is sent as empty (the daemon
 * would refuse it, and it already runs on the CLI's own).
 */
export function kindPick(own: AutoStartChoice | undefined, shown: { model: string; effort: string }, change: { model: string } | { effort: string }, info: Pick<RunnerInfo, "efforts"> | undefined): { model?: string; effort?: string } {
  if (!own || own.runner) return change;
  const effort = shown.effort && info?.efforts.some((e) => e.value === shown.effort) ? shown.effort : "";
  return { model: shown.model, effort, ...change };
}

export type JobRowId = "manual" | "autoStart" | `kind:${AutoStartKind}` | "review" | "recheck" | `reviewModel:${RunnerId}` | "judge" | "judgeFallback" | "routing" | "titles";
/** `runner` "" = the recheck row left unset: it follows the review setting. */
export type JobRow = { id: JobRowId; label: Msg; runner: RunnerId | "other" | "same" | ""; model: string; effort: string; runnerOnly?: boolean };

/**
 * The jobs and the runner / model / effort each runs on. "" model / effort = the runner's default. `reviewers` are the
 * runners that get a 「レビューで使うモデル」 row (the model / effort a review job of that runner starts with), in that order.
 */
export function jobRows(s: Settings, reviewers: RunnerId[]): JobRow[] {
  const nd = s.newDefaults;
  const kinds: JobRow[] = AUTO_START_KINDS.flatMap(([kind, label]) => {
    const own = s.autoStart.byKind[kind];
    const c = kindChoice(own, s.autoStart);
    return own ? [{ id: `kind:${kind}` as const, label, runner: c.runner ?? ("same" as const), model: c.model, effort: c.effort }] : [];
  });
  return [
    { id: "manual", label: settings.jobManual, runner: nd.taskRunner, model: nd.taskModel, effort: nd.taskEffort },
    { id: "autoStart", label: settings.jobAutoStart, runner: s.autoStart.runner, model: s.autoStart.model, effort: s.autoStart.effort },
    ...kinds,
    { id: "review", label: settings.jobReview, runner: s.reviewRunner, model: "", effort: "", runnerOnly: true },
    { id: "recheck", label: settings.jobRecheck, runner: s.recheckRunner ?? "", model: "", effort: "", runnerOnly: true },
    ...reviewers.map((runner): JobRow => ({ id: `reviewModel:${runner}`, label: settings.jobReviewModel, runner, model: s.reviewModel[runner] ?? "", effort: s.reviewEffort[runner] ?? "" })),
    { id: "judge", label: settings.jobJudge, runner: s.judge.runner, model: s.judge.model, effort: s.judge.effort },
    { id: "judgeFallback", label: settings.jobJudgeFallback, runner: s.judgeAndChoice.judgeFallbackRunner, model: s.judgeAndChoice.judgeFallbackModel, effort: s.judgeAndChoice.judgeFallbackEffort },
    { id: "routing", label: settings.jobRouting, runner: s.routing.llm.runner, model: s.routing.llm.model, effort: s.routing.llm.effort },
    { id: "titles", label: settings.jobTitles, runner: s.titles.runner, model: s.titles.model, effort: s.titles.effort },
  ];
}

/**
 * The runner's saved default effort as the daemon uses it: only while the runner still lists it (the daemon drops one it
 * does not list and runs on the CLI's own default). A saved default model is used as it is (model names are not checked).
 */
export function effectiveDefaultEffort(info: Pick<RunnerInfo, "efforts" | "defaultEffort"> | undefined): string | undefined {
  const saved = info?.defaultEffort;
  return saved && info.efforts.some((e) => e.value === saved) ? saved : undefined;
}

/** The model / effort a new Task of `runner` starts with in the create form: the rule's model, the saved one for hand-started Tasks, the runner's own default, else "" (the CLI's). */
export function initialChoice(runner: RunnerId, info: RunnerInfo | undefined, nd: NewDefaultsSettings, suggestion?: { runner: RunnerId; model?: string | null }): { model: string; effort: string } {
  const saved = runner === nd.taskRunner ? nd : undefined;
  const suggested = suggestion?.model && suggestion.runner === runner ? suggestion.model : "";
  return {
    model: suggested || saved?.taskModel || info?.defaultModel || "",
    effort: saved?.taskEffort || effectiveDefaultEffort(info) || "",
  };
}

/**
 * The empty choice of a job's model / effort select: 「ランナーの既定（<what it comes to>）」. What it comes to is the runner's saved
 * default, else the CLI's own (its model when the runner reports it), as `initialChoice` and the daemon resolve it.
 */
export function runnerDefaultLabel(kind: "model" | "effort", info: Pick<RunnerInfo, "models" | "efforts" | "defaultModel" | "defaultEffort" | "cliDefaultModel"> | undefined): string {
  const saved = kind === "model" ? info?.defaultModel : effectiveDefaultEffort(info);
  const list = (kind === "model" ? info?.models : info?.efforts) ?? [];
  const value = saved ? (list.find((o) => o.value === saved)?.label ?? saved) : kind === "model" && info?.cliDefaultModel ? info.cliDefaultModel : t(home.cliDefault);
  return t(settings.runnerDefaultNamed, { value });
}

/**
 * Where a job row's runner / model / effort is saved: the PATCH for one change of the row (a field left out is not
 * sent). The kinds' own rows and the review, recheck and review-model rows are saved by their own controls, not here; they fall to autoStart.
 */
export function jobPatchOf(id: JobRowId, p: { runner?: RunnerId; model?: string; effort?: string }): SettingsPatch {
  const only = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const choice = only({ runner: p.runner, model: p.model, effort: p.effort });
  switch (id) {
    case "manual":
      return { newDefaults: only({ taskRunner: p.runner, taskModel: p.model, taskEffort: p.effort }) };
    case "judge":
      return { judge: choice };
    case "judgeFallback":
      return { judgeAndChoice: only({ judgeFallbackRunner: p.runner, judgeFallbackModel: p.model, judgeFallbackEffort: p.effort }) };
    case "routing":
      return { routing: { llm: choice } };
    case "titles":
      return { titles: choice };
    default:
      return { autoStart: choice };
  }
}
