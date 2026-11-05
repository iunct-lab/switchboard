import type { AnswerPolicy } from "@switchboard/protocol";
import { broadLines } from "./asks.ts";
import { jstDay, jstStamp } from "./time.ts";
import { t } from "./i18n.ts";
import { settings } from "./i18n/settings.ts";

/* The settings screen's list of saved answer policies (#938). */

const DAY_MS = 86_400_000;
const dayOf = jstDay;
const stamp = jstStamp;

export type PolicyTone = "ok" | "wait" | "bad";

/** 有効 / 期限切れ (`now === expiresAt` is expired) / 無効 (revoked) / 使用済み (a 今回のみ one that answered). */
export function policyState(p: AnswerPolicy, now: number): { text: string; tone: PolicyTone } {
  if (p.revokedAt !== null) return { text: t(settings.policyRevoked), tone: "bad" };
  if (p.scope === "once" && p.uses.length > 0) return { text: t(settings.policyUsed), tone: "wait" };
  if (p.expiresAt !== null && now >= p.expiresAt) return { text: t(settings.policyExpired), tone: "wait" };
  return { text: t(settings.policyActive), tone: "ok" };
}

export function policyRow(p: AnswerPolicy, workspaceName: (id: string) => string, now = Date.now()): { scope: string; subject: string; when: string; expires: string; uses: string } {
  const scope = p.scope === "once" ? t(settings.scopeOnce) : p.scope === "pbi" ? t(settings.scopePbi, { pbi: p.pbi ?? t(settings.unknown) }) : t(settings.scopeRepo, { name: workspaceName(p.workspaceId) });
  return {
    scope,
    subject: `${p.op}: ${p.target}`,
    when: p.when.length ? p.when.map((w) => `${w.key}=${w.value}`).join(" ") : t(settings.noCondition),
    expires: p.expiresAt === null ? t(settings.noExpiry) : t(settings.expiresIn, { day: dayOf(p.expiresAt), days: Math.max(0, Math.ceil((p.expiresAt - now) / DAY_MS)) }),
    uses: p.uses.length ? t(settings.usesLine, { n: p.uses.length, at: stamp(p.uses[0]!.at) }) : t(settings.unused),
  };
}

/** Each use, newest first: when, where (the Task or the Issue) and what it was about. */
export function useLines(p: AnswerPolicy, taskTitle: (id: string) => string | undefined = () => undefined): string[] {
  return [...p.uses]
    .sort((a, b) => b.at - a.at)
    .map((u) => `${stamp(u.at)} ${u.issue !== null ? `Issue #${u.issue}` : u.taskId ? `Task ${taskTitle(u.taskId) ?? u.taskId}` : t(settings.unknown)} ${u.subject.op} ${u.subject.target}`);
}

/** Warnings shown above the edit's save button: the same broad-target line as the card's confirmation. */
export const editWarnings = (p: Pick<AnswerPolicy, "op">, target: string): string[] => broadLines(p.op, target);
