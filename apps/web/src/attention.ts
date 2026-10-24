import type { Task, TaskOutcome } from "@switchboard/protocol";

/**
 * 要対応 (#492): the stopped tasks the person has not reviewed yet, except those that came to 完了 — a finished task needs
 * nothing from the person, and listing it buries the ones that do. Separate from whether the runner is running — a task
 * waiting on an approval is in both lists. Home and the rail both use these, below 実行中.
 */
export function needsAttention(t: Task): boolean {
  return t.reviewedAt === null && t.outcome !== "done" && t.status !== "running" && t.status !== "idle";
}

const RANK: Record<TaskOutcome, number> = { needs_action: 0, failed: 1, done: 2, unknown: 2 };

/** 要対応 → 失敗 → 未判定; newest first within each. */
export function attentionList(tasks: Task[]): Task[] {
  return tasks.filter(needsAttention).sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || b.updatedAt - a.updatedAt);
}

const LABEL: Record<TaskOutcome, string> = { needs_action: "要対応", failed: "失敗", done: "完了", unknown: "未判定" };

export function outcomeLabel(o: TaskOutcome): string {
  return LABEL[o];
}

/**
 * What the Task screen shows next to the outcome (#493): the judge's one-line reason, and in the tooltip who judged.
 * When the person set a different outcome by hand, the judged result is named in the text so the two can be told apart.
 */
export function judgementNote(t: Task): { text: string; title: string } | null {
  if (!t.judgedResult || !t.judgedReason) return null;
  const judged = outcomeLabel(t.judgedResult);
  // `<runner>:` = judged on that runner's CLI default model (the setting's model is "")
  const by = t.judgedBy?.endsWith(":") ? `${t.judgedBy}CLI 既定` : (t.judgedBy ?? "?");
  return { text: t.outcome === t.judgedResult ? t.judgedReason : `自動判定: ${judged} — ${t.judgedReason}`, title: `自動判定（${by}）: ${judged}` };
}

/** The dot of a row under 要対応: coloured by the outcome, not the runner's status. */
export function outcomeDotClass(o: TaskOutcome): string {
  return o === "needs_action" ? "wait" : o === "failed" ? "err" : o === "done" ? "ok" : "idle";
}
