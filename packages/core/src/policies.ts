import { AnswerPolicy as AnswerPolicySchema, type AnswerPolicy, type ApprovalRuleMatch, AskAnswer, PolicyInput, PolicySubject } from "@switchboard/protocol";
import { findSecrets, hostAws } from "../../../ops-kit/src/secrets.ts";
import { globMatch } from "./approval.ts";
import type { Db } from "./db.ts";

/**
 * Saved answer policies (#938): one answer reused next time under a scope and conditions. They live in the `settings`
 * table (key `answerPolicies`, a JSON array — one user, a small list) and are matched on structured values only (the
 * tool kind and path / command, or the stop record's op / target / conditions), never on the wording of a question.
 * The Knowledge `approval` rules are read elsewhere and never changed here.
 */
export const POLICY_MAX_DAYS = 90;
export const POLICY_DEFAULT_DAYS = 30;
const DAY = 86_400_000;
const KEY = "answerPolicies";

export function readPolicies(db: Db): AnswerPolicy[] {
  const raw = db.getSetting<unknown>(KEY, []);
  // an entry that is not a whole policy is dropped, never half-read
  return Array.isArray(raw) ? raw.flatMap((p) => { const r = AnswerPolicySchema.safeParse(p); return r.success ? [r.data] : []; }) : [];
}

export function writePolicies(db: Db, list: AnswerPolicy[]) {
  db.setSetting(KEY, list);
}

export interface PolicyContext {
  subject: PolicySubject | null;
  workspaceId: string | null;
  pbi: number | null;
  askId: string;
  answer: AskAnswer;
  /** A Knowledge `confirm` rule that fires on this subject: always ask. */
  confirmHit: ApprovalRuleMatch | null;
  /** The runner (not this app) refused it: a saved policy cannot lift that. */
  runnerRefusal: boolean;
  now: number;
}

/** Approvals keep globMatch's two kinds apart (a command vs a path); a stop record's target is one string either way. */
function targetMatches(glob: string, kind: PolicySubject["kind"], op: string, target: string): boolean {
  return globMatch(glob, target, kind === "approval" ? op === "exec" : glob.startsWith("cmd:") || glob.includes(" "));
}

// Only wildcards, separators and the `cmd:` prefix: it would match everything (`*`, `**`, `**/*`, `cmd:*`)
const MATCH_ALL = /^(cmd:)?[*?/]*$/;

/** True when the glob, or any of its `{a,b}` alternatives, would match everything (`cmd:{*,x}`). */
function matchesAll(glob: string): boolean {
  const open = glob.indexOf("{");
  const close = open < 0 ? -1 : glob.indexOf("}", open);
  if (open < 0 || close < 0) return MATCH_ALL.test(glob) || /^(cmd:)?[*?/{},]*$/.test(glob);
  return glob.slice(open + 1, close).split(",").some((alt) => matchesAll(glob.slice(0, open) + alt + glob.slice(close + 1)));
}

export function checkPolicy(input: PolicyInput, ctx: PolicyContext): { ok: true; policy: Omit<AnswerPolicy, "id" | "uses"> } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  const { subject } = ctx;
  if (ctx.runnerRefusal) return no("ランナー側の拒否は保存した方針では解除できません");
  if (ctx.confirmHit) return no(`都度確認のルール ${ctx.confirmHit.source}: ${ctx.confirmHit.pattern} に当たるため保存できません`);
  if (subject?.conditions.some((c) => c.key === "merge-ask" && c.value.includes("security"))) return no("セキュリティのマージ確認は毎回聞きます");
  if (input.scope !== "once") {
    if (!subject) return no("操作と対象が記録されていないため、今回のみにできます");
    if (!ctx.workspaceId) return no("リポジトリが分からないため、今回のみにできます");
    if (input.scope === "pbi" && ctx.pbi === null) return no("PBI が分からないため、このリポジトリか今回のみにできます");
  }
  if (!subject) return no("操作と対象が記録されていないため保存できません");
  if (!ctx.workspaceId) return no("リポジトリが分からないため保存できません");
  if (subject.kind === "approval") {
    if (subject.op !== "exec" && subject.op !== "write") return no("この操作の承認は保存できません（exec / write だけ）");
    if (ctx.answer.kind !== "allow") return no("承認の方針は許可だけ保存できます");
  } else if (ctx.answer.kind !== "choice" && ctx.answer.kind !== "text") {
    return no("選択か文章の回答だけ保存できます");
  }
  if (!input.target || matchesAll(input.target)) return no("全部に当たる対象は保存できません");
  if (!targetMatches(input.target, subject.kind, subject.op, subject.target)) return no("対象が、保存元の問いに当たりません");
  let expiresAt: number | null = null;
  if (input.scope !== "once") {
    if (input.expiresAt === null) return no("期限が必要です");
    if (input.expiresAt <= ctx.now) return no("期限が過去です");
    if (input.expiresAt > ctx.now + POLICY_MAX_DAYS * DAY) return no(`期限は ${POLICY_MAX_DAYS} 日までです`);
    expiresAt = input.expiresAt;
  }
  const answerText = ctx.answer.kind === "choice" ? `${ctx.answer.choice}\n${ctx.answer.note ?? ""}` : ctx.answer.kind === "text" ? ctx.answer.text : "";
  // the source subject is stored with the policy (`from`) and returned by the API: a secret in it is not kept either
  const texts = [input.target, ...input.when.flatMap((w) => [w.key, w.value]), answerText, subject.op, subject.target, ...subject.conditions.flatMap((c) => [c.key, c.value])];
  const host = hostAws();
  if (texts.some((t) => findSecrets(t, host).length)) return no("秘密を含む値は保存できません");
  return {
    ok: true,
    policy: {
      scope: input.scope,
      workspaceId: ctx.workspaceId,
      pbi: input.scope === "pbi" ? ctx.pbi : null,
      askId: input.scope === "once" ? ctx.askId : null,
      kind: subject.kind,
      op: subject.op,
      target: input.target,
      when: input.when,
      answer: ctx.answer,
      expiresAt,
      revokedAt: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      from: subject,
    },
  };
}

export interface PolicyAsk {
  id: string;
  subject: PolicySubject;
  workspaceId: string | null;
  pbi: number | null;
  pbiOpen: boolean;
  choices: string[];
}

const NARROW = { once: 0, pbi: 1, repo: 2 } as const;

export function matchPolicies(list: AnswerPolicy[], ask: PolicyAsk, now: number): { hit: AnswerPolicy | null; misses: Array<{ policy: AnswerPolicy; why: string }> } {
  const misses: Array<{ policy: AnswerPolicy; why: string }> = [];
  const hits: AnswerPolicy[] = [];
  const { subject } = ask;
  for (const policy of list) {
    if (policy.kind !== subject.kind || policy.op !== subject.op) continue;
    const why = missReason(policy, ask, now);
    if (why) misses.push({ policy, why });
    else hits.push(policy);
  }
  hits.sort((a, b) => NARROW[a.scope] - NARROW[b.scope] || b.updatedAt - a.updatedAt);
  return { hit: hits[0] ?? null, misses };
}

function missReason(p: AnswerPolicy, ask: PolicyAsk, now: number): string | null {
  const { subject } = ask;
  if (p.revokedAt !== null) return "失効済み";
  if (p.expiresAt !== null && now >= p.expiresAt) return "期限切れ";
  if (p.workspaceId !== ask.workspaceId) return "別のリポジトリ";
  if (p.scope === "pbi" && (p.pbi !== ask.pbi || !ask.pbiOpen)) return p.pbi !== ask.pbi ? "別の PBI" : "PBI が閉じている";
  if (p.scope === "once" && p.askId !== ask.id) return "別の問い";
  // a policy saved on a PR's head is not an answer about another one (#938)
  if (p.from.head && subject.head && p.from.head !== subject.head) return "PR の差分が変わった";
  if (!targetMatches(p.target, p.kind, subject.op, subject.target)) return "対象が違う";
  for (const w of p.when) {
    const cur = subject.conditions.find((c) => c.key === w.key);
    if (!cur) return `条件 ${w.key} が無い`;
    if (cur.value !== w.value) return `条件 ${w.key} が違う`;
  }
  if (p.answer.kind === "choice") {
    const saved = p.answer.choice;
    if (!ask.choices.some((c) => c.replace(/^[^:]*: /, "") === saved.replace(/^[^:]*: /, ""))) return "回答が今回の選択肢に無い";
  }
  return null;
}

/** What differs between the question a policy was saved from (or an earlier answer) and this one. */
export function subjectChanges(prev: PolicySubject, cur: PolicySubject): string[] {
  const out: string[] = [];
  if (prev.op !== cur.op) out.push(`操作: ${prev.op} → ${cur.op}`);
  if (prev.target !== cur.target) out.push(`対象: ${prev.target} → ${cur.target}`);
  for (const key of new Set([...prev.conditions.map((c) => c.key), ...cur.conditions.map((c) => c.key)])) {
    const a = prev.conditions.find((c) => c.key === key)?.value;
    const b = cur.conditions.find((c) => c.key === key)?.value;
    if (a !== b) out.push(`条件 ${key}: ${a ?? "なし"} → ${b ?? "なし"}`);
  }
  if (prev.head && cur.head && prev.head !== cur.head) out.push(`PR の差分が変わりました（${prev.head.slice(0, 7)} → ${cur.head.slice(0, 7)}）`);
  return out;
}

export function recordUse(list: AnswerPolicy[], id: string, use: AnswerPolicy["uses"][number]): AnswerPolicy[] {
  return list.map((p) => (p.id === id ? { ...p, uses: [use, ...p.uses].slice(0, 20) } : p));
}
