import type { RunnerId, Schedule, ScheduleInput } from "@switchboard/protocol";

/** The edit form's values for one schedule row (#1480). Strings throughout: they are input values. */
export type ScheduleDraft = { title: string; cron: string; workspaceId: string; runner: RunnerId; model: string; effort: string; budget: string; prompt: string };

export const scheduleDraft = (s: Schedule): ScheduleDraft => ({
  title: s.title,
  cron: s.cron,
  workspaceId: s.workspaceId,
  runner: s.runner,
  model: s.model,
  effort: s.effort,
  budget: s.budgetUsd == null ? "" : String(s.budgetUsd),
  prompt: s.prompt,
});

/** Only the fields that changed. A runner change always carries model and effort: the form has already reset them to the CLI default. */
export function scheduleEditPatch(cur: Schedule, d: ScheduleDraft): { patch: Partial<ScheduleInput> } | { error: string } {
  const patch: Partial<ScheduleInput> = {};
  if (d.title.trim() !== cur.title.trim()) patch.title = d.title.trim();
  if (d.cron !== cur.cron) patch.cron = d.cron;
  if (cur.action === "prompt") {
    if (d.workspaceId !== cur.workspaceId) patch.workspaceId = d.workspaceId;
    if (d.prompt.trim() !== cur.prompt.trim()) patch.prompt = d.prompt.trim();
  }
  if (d.runner !== cur.runner) {
    patch.runner = d.runner;
    patch.model = d.model;
    patch.effort = d.effort;
  } else {
    if (d.model !== cur.model) patch.model = d.model;
    if (d.effort !== cur.effort) patch.effort = d.effort;
  }
  const budget = d.budget.trim();
  if (budget === "") {
    if (cur.budgetUsd != null) patch.budgetUsd = null;
  } else {
    const n = Number(budget);
    if (!Number.isFinite(n) || n <= 0) return { error: `予算は0より大きい数値で入力してください: "${d.budget}"` };
    if (n !== cur.budgetUsd) patch.budgetUsd = n;
  }
  return { patch };
}

/**
 * The create form's body (#1924): the kinds that run on the meta workspace (backlog-next, secret-scan, insights) take the
 * meta workspace and no prompt; insights runs on claude whatever runner the form held (its select is locked, but the
 * saved defaults can land late) and keeps the model and effort the form shows — those are claude's, the form resets them
 * when the kind is chosen. A prompt schedule keeps its workspace and its trimmed prompt.
 */
export function scheduleCreateInput(f: { title: string; cron: string; wsId: string; metaId: string | undefined; runner: RunnerId; model: string; effort: string; prompt: string; action: Schedule["action"]; budgetUsd?: number }): ScheduleInput {
  const metaOnly = f.action !== "prompt";
  const insights = f.action === "insights";
  return metaOnly
    ? { title: f.title.trim(), cron: f.cron, workspaceId: f.metaId ?? "", runner: insights ? "claude" : f.runner, model: f.model, effort: f.effort, prompt: "", action: f.action, budgetUsd: f.budgetUsd }
    : { title: f.title.trim(), cron: f.cron, workspaceId: f.wsId, runner: f.runner, model: f.model, effort: f.effort, prompt: f.prompt.trim(), action: f.action, budgetUsd: f.budgetUsd };
}
