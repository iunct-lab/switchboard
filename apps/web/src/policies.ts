import type { AnswerPolicy } from "@switchboard/protocol";
import { jstDay, jstStamp } from "./time.ts";

/* The settings screen's list of saved answer policies (#938). */

const DAY_MS = 86_400_000;
const dayOf = jstDay;
const stamp = jstStamp;

export type PolicyTone = "ok" | "wait" | "bad";

/** 有効 / 期限切れ (`now === expiresAt` is expired) / 無効 (revoked) / 使用済み (a 今回のみ one that answered). */
export function policyState(p: AnswerPolicy, now: number): { text: "有効" | "期限切れ" | "無効" | "使用済み"; tone: PolicyTone } {
  if (p.revokedAt !== null) return { text: "無効", tone: "bad" };
  if (p.scope === "once" && p.uses.length > 0) return { text: "使用済み", tone: "wait" };
  if (p.expiresAt !== null && now >= p.expiresAt) return { text: "期限切れ", tone: "wait" };
  return { text: "有効", tone: "ok" };
}

export function policyRow(p: AnswerPolicy, workspaceName: (id: string) => string, now = Date.now()): { scope: string; subject: string; when: string; expires: string; uses: string } {
  const scope = p.scope === "once" ? "今回のみ" : p.scope === "pbi" ? `この PBI 内（#${p.pbi ?? "不明"}）` : `このリポジトリ（${workspaceName(p.workspaceId)}）`;
  return {
    scope,
    subject: `${p.op}: ${p.target}`,
    when: p.when.length ? p.when.map((w) => `${w.key}=${w.value}`).join(" ") : "条件なし",
    expires: p.expiresAt === null ? "期限なし（1 回きり）" : `${dayOf(p.expiresAt)}（あと ${Math.max(0, Math.ceil((p.expiresAt - now) / DAY_MS))} 日）`,
    uses: p.uses.length ? `${p.uses.length} 回・最後 ${stamp(p.uses[0]!.at)}` : "未使用",
  };
}

/** Each use, newest first: when, where (the Task or the Issue) and what it was about. */
export function useLines(p: AnswerPolicy, taskTitle: (id: string) => string | undefined = () => undefined): string[] {
  return [...p.uses]
    .sort((a, b) => b.at - a.at)
    .map((u) => `${stamp(u.at)} ${u.issue !== null ? `Issue #${u.issue}` : u.taskId ? `Task ${taskTitle(u.taskId) ?? u.taskId}` : "不明"} ${u.subject.op} ${u.subject.target}`);
}
