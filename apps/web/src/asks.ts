import type { Ask, AskAnswer, AskBatch, PolicyInput, PolicyScope } from "@switchboard/protocol";
import { jstClock, jstDay } from "./time.ts";

/** 判断待ち (#935): what each kind of question is called on screen. */
export const KIND_LABEL: Record<Ask["kind"], string> = {
  approval: "ツール承認",
  decision: "実装の判断",
  check: "運用の確認",
  confirmation: "利用者確認",
  stop: "停止",
  wait: "依存待ち",
  notice: "お知らせ",
};

// open is 未回答: 保留 is the person's hold (#936)
export const STATE_LABEL: Record<Ask["state"], string> = { open: "未回答", held: "保留", answered: "回答済み", resolved: "解消済み" };

type GroupKey = "person" | "auto" | "answered" | "resolved";
const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: "person", label: "あなたの判断待ち" },
  { key: "auto", label: "自動で待っている（操作不要）" },
  { key: "answered", label: "回答済み" },
  { key: "resolved", label: "解消済み" },
];

// a held one (#936) is still the person's to answer
const groupKeyOf = (a: Ask): GroupKey => (a.state === "open" ? a.needs : a.state === "held" ? "person" : a.state);

/** The screen's groups, in order and without the empty ones: open ones by who has to act, then answered, then resolved (whoever). */
export function groupAsks(asks: Ask[]): Array<{ key: GroupKey; label: string; asks: Ask[] }> {
  return GROUPS.map((g) => ({ ...g, asks: asks.filter((a) => groupKeyOf(a) === g.key) })).filter((g) => g.asks.length > 0);
}

/** The heading of the questions whose Workspace is not known (#1673). */
export const UNKNOWN_WORKSPACE = "Workspace 不明";

/** The Workspace a question is filtered by (#1673): its id, "" when not known. */
export const workspaceKey = (a: Pick<Ask, "workspace">) => a.workspace?.id ?? "";

/**
 * The questions of a group under one heading per Workspace (#1673): the most questions first, then by name, the unknown
 * one last; each keeps the order it was given.
 */
export function workspaceSections(asks: Ask[]): Array<{ key: string; name: string; asks: Ask[] }> {
  const by = new Map<string, { key: string; name: string; asks: Ask[] }>();
  for (const a of asks) {
    const key = workspaceKey(a);
    const s = by.get(key) ?? { key, name: a.workspace?.name ?? UNKNOWN_WORKSPACE, asks: [] };
    s.asks.push(a);
    by.set(key, s);
  }
  return [...by.values()].sort((x, y) => Number(x.key === "") - Number(y.key === "") || y.asks.length - x.asks.length || x.name.localeCompare(y.name));
}

/** The filter's buttons (#1673): every Workspace of the questions, in the headings' order, with how many are the person's to answer. */
export const workspaceChips = (asks: Ask[]) =>
  workspaceSections(asks).map((s) => ({ key: s.key, name: s.name, count: s.asks.filter((a) => groupKeyOf(a) === "person").length }));

const UNKNOWN = "不明";

/** The facts of one question card, in the PBI's order; a value the records do not have says 不明. Choices and conditions only when there are some. */
export function askFacts(a: Ask): Array<{ label: string; value: string; href?: string }> {
  const r = a.recommendation;
  // a daemon's notice (#2866) has no PBI, Task or choice: what it is about, why, what to do, and what put it there
  if (a.kind === "notice")
    return [
      { label: "お知らせ", value: a.question ?? UNKNOWN },
      ...(a.reason ? [{ label: "内容", value: a.reason }] : []),
      ...(a.next ? [{ label: "すること", value: a.next }] : []),
      { label: "出したもの", value: a.source.label },
    ];
  return [
    { label: "対象リポジトリ", value: a.workspace?.name ?? UNKNOWN },
    a.pbi ? { label: "PBI", value: `#${a.pbi.number} ${a.pbi.title}`, href: a.pbi.url } : { label: "PBI", value: UNKNOWN },
    { label: "Task", value: a.task ? (a.task.title ?? a.task.id) : UNKNOWN },
    { label: "停止理由", value: a.reason ?? UNKNOWN },
    { label: "問い", value: a.question ?? UNKNOWN },
    ...(a.choices.length ? [{ label: "選択肢", value: a.choices.join("\n") }] : []),
    { label: "推奨と根拠", value: r ? (r.why ? `${r.choice} — ${r.why}` : r.choice) : UNKNOWN },
    { label: "回答後", value: a.next ?? UNKNOWN },
    ...(a.conditions.length ? [{ label: "条件", value: a.conditions.map((c) => `${c.key}: ${c.value}${c.met ? "（済み）" : ""}`).join("\n") }] : []),
    a.source.url ? { label: "元の記録", value: a.source.label, href: a.source.url } : { label: "元の記録", value: a.source.label },
  ];
}

/** One answer button of a card (#936): what it sends, where it is written and what goes on after it. */
export interface AnswerButton {
  label: string;
  answer: AskAnswer;
  /** The answer as written / sent. */
  send: string;
  /** The grant it sends (#2745): the stop's, or the choice's ` — 許可: `; shown on a line of its own. */
  grant: string | null;
  /** Where it goes: the Issue it is written on, or the Task it is sent to. */
  target: string;
  next: string;
  primary: boolean;
}

/** Where an answer goes (#936): the Issue it is written on (a decision, a confirmation), else the Task it is sent to. */
export const answerTarget = (a: Pick<Ask, "kind" | "issue" | "task">) =>
  a.kind === "decision" || a.kind === "confirmation" ? (a.issue ? `Issue #${a.issue.number}` : "Issue") : a.task ? `Task「${a.task.title ?? a.task.id}」` : "Task";

/** A choice's grant (#2745): what follows ` — 許可: ` in its line; null = none. The daemon's parseAskBlock reads the same. */
export function grantOf(choice: string): string | null {
  const m = / — 許可[:：]\s*(.+)$/.exec(choice);
  return m ? m[1]!.trim() : null;
}

/** A choice's text before its grant: what the card shows on the 送る line, the grant going on the next. */
export const withoutGrant = (choice: string) => choice.replace(/ — 許可[:：]\s*.+$/, "");

/** `A` of `A: 置き換える — 影響: …`; the whole choice when it has no short head. */
const choiceKey = (c: string) => /^([^:：\s]{1,12})(?::\s|：)/.exec(c)?.[1] ?? c;

/**
 * The buttons of a question (#936), from what it takes (`answers`), its choices and its recommendation: a stop's grant
 * (#2745: この操作だけ許可して続ける, on the stop's Issue for a stage Task's), an approval's 承認して続行 / 拒否, one per choice (the recommended one first, as 推奨案で進める), 確認した, a notice's 誤検知として閉じる (#2866), and 保留. None when it takes
 * no answer; free text (and a confirmation's 違う) is the card's text box.
 */
export function answerButtons(a: Ask): AnswerButton[] {
  const takes = new Set(a.answers);
  const target = answerTarget(a);
  const next = a.next ?? "不明";
  const out: AnswerButton[] = [];
  if (takes.has("grant") && a.grant) out.push({ label: "この操作だけ許可して続ける", answer: { kind: "grant" }, send: a.grant, grant: a.grant, target: a.issue ? `Issue #${a.issue.number}` : target, next, primary: true });
  if (takes.has("allow")) {
    const tool = a.reason?.split(": ").at(-1) ?? "ツール";
    out.push({ label: "承認して続行", answer: { kind: "allow" }, send: `${tool} を許可`, grant: null, target, next, primary: true });
  }
  if (takes.has("deny")) out.push({ label: "拒否", answer: { kind: "deny" }, send: "拒否", grant: null, target, next: "Task は許可されずに続く", primary: false });
  if (takes.has("choice")) {
    const rec = a.recommendation ? choiceKey(a.recommendation.choice) : null;
    const choices = [...a.choices].sort((x, y) => Number(choiceKey(y) === rec) - Number(choiceKey(x) === rec));
    for (const c of choices) {
      const recommended = choiceKey(c) === rec;
      out.push({ label: recommended ? `推奨案で進める（${choiceKey(c)}）` : `${choiceKey(c)} で進める`, answer: { kind: "choice", choice: c }, send: c, grant: grantOf(c), target, next, primary: recommended && !takes.has("grant") });
    }
  }
  if (takes.has("confirm")) out.push({ label: "確認した", answer: { kind: "confirm", ok: true }, send: `受け入れ条件「${a.question ?? ""}」を確認しました`, grant: null, target, next, primary: true });
  if (takes.has("dismiss")) out.push({ label: "誤検知として閉じる", answer: { kind: "dismiss" }, send: "誤検知として閉じる", grant: null, target, next: "同じ当たりは次の検査でも出ない", primary: false });
  if (takes.has("hold")) out.push({ label: "保留", answer: { kind: "hold" }, send: "## 保留 を書く。判断待ちのまま", grant: null, target, next: "続行しない", primary: false });
  return out;
}

/** The questions of one Task its screen answers (#2745): its open operational checks and stops a person answers. */
export const taskAsks = (list: Ask[], taskId: string) => list.filter((a) => a.task?.id === taskId && (a.kind === "check" || a.kind === "stop") && a.state === "open" && a.needs === "person");

/** How the work goes on after the answer (#936), as the card's badge; null while nothing is answered. */
export function resumeLabel(a: Pick<Ask, "state" | "resume">): { text: string; tone: "ok" | "wait" | "bad" } | null {
  const r = a.resume;
  if (!r) return a.state === "answered" ? { text: "回答済み", tone: "ok" } : null;
  if (r.state === "running") return { text: "実行中", tone: "ok" };
  if (r.state === "queued") return { text: `再開待ち${r.reason ? `: ${r.reason}` : ""}`, tone: "wait" };
  if (r.state === "failed") return { text: `再開失敗${r.reason ? `: ${r.reason}` : ""}`, tone: "bad" };
  return { text: "回答済み", tone: "ok" };
}

/** How many other PBIs wait on the question (#1674); null = none. */
export const unblocksLine = (a: Pick<Ask, "unblocks">) => (a.unblocks.length ? `答えると ${a.unblocks.length} 件が進められる` : null);

/** What an answer does not take away (#936), one line each, shown above the buttons. */
// a runner's refusal already says it
export const blockerLines = (a: Pick<Ask, "blockers">) => a.blockers.map((b) => (b.kind === "runner" ? b.detail : `回答だけでは解除されません: ${b.detail}`));

/**
 * What a card answered on this screen shows (#936): the question the answer returned (`changed` = a 409: what changed,
 * kept on the question now, under its id).
 */
export type Answered = { ask: Ask; changes?: string[]; changed?: boolean };

/** The list has the question answered under another id (a decision's names the answer's time). */
const answeredIn = (x: Ask, list: Ask[]) =>
  list.some((y) => y.kind === x.kind && y.state !== "open" && y.state !== "held" && y.workspace?.id === x.workspace?.id && (x.pbi ? y.pbi?.number === x.pbi.number : !!x.task && y.task?.id === x.task.id));

/**
 * What stays of the answers given here once a newer list comes (#936): an answer the list has the question of gives way to
 * the list, one whose question left the list (a check whose Task went on) stays; a 409's notice stays on its question
 * until the list has that question changed again (or no longer has it).
 */
export function pruneAnswered(answered: Map<string, Answered>, list: Ask[]): Map<string, Answered> {
  return new Map(
    [...answered].filter(([id, v]) => {
      const now = list.find((x) => x.id === id);
      return v.changed ? !!now && now.changedAt === v.ask.changedAt : !now;
    }),
  );
}

/** The answers given here that the list no longer has, as their cards (not when the list has them answered under a new id). */
export const keptAnswers = (answered: Map<string, Answered>, list: Ask[]) =>
  [...answered.entries()].filter(([id, v]) => !v.changed && !list.some((y) => y.id === id) && !answeredIn(v.ask, list)).map(([, v]) => v.ask);

/* ---------- answer policies (#938) ---------- */

const DAY_MS = 86_400_000;
const dayOf = jstDay;

/** The range a policy is saved under, as the card says it. */
export function scopeLabel(scope: PolicyScope, ask: Pick<Ask, "pbi" | "workspace" | "task">): string {
  if (scope === "once") return "今回のみ";
  if (scope === "pbi") return `この PBI 内（${ask.pbi ? `#${ask.pbi.number}` : ask.task?.stageIssue ? `#${ask.task.stageIssue}` : "不明"}）`;
  return `このリポジトリ（${ask.workspace?.name ?? "不明"}）`;
}

/** What the person confirms before a policy is saved: operation, target, conditions, expiry and what is answered. */
export function policySummary(ask: Pick<Ask, "subject">, input: PolicyInput, answerText = "許可", now = Date.now()): string[] {
  const left = input.expiresAt === null ? null : Math.max(0, Math.ceil((input.expiresAt - now) / DAY_MS));
  return [
    `操作: ${ask.subject?.op ?? "不明"}`,
    `対象: ${input.target}`,
    `条件: ${input.when.length ? input.when.map((w) => `${w.key}=${w.value}`).join(" ") : "なし"}`,
    `期限: ${input.expiresAt === null ? "なし" : `${dayOf(input.expiresAt)}（あと ${left} 日）`}`,
    `回答: ${answerText}`,
  ];
}

/** The earlier answer that no longer applies, and why, and what differs (the card says it will ask again). */
export function previousLines(ask: Pick<Ask, "policy">): string[] {
  const p = ask.policy.previous;
  if (!p) return [];
  const said = p.answer.kind === "choice" ? p.answer.choice : p.answer.kind === "text" ? p.answer.text : p.answer.kind === "allow" ? "許可" : p.answer.kind;
  return [`前回の回答: ${said}（${dayOf(p.at)}、方針 ${p.id}）`, `適用しなかった理由: ${p.why}`, ...p.changes];
}

/** The policy that answered this question, as one line. */
export const appliedLine = (ask: Pick<Ask, "policy">): string | null => (ask.policy.applied ? `方針で回答: ${ask.policy.applied.summary}` : null);

/** The "次回も使う" form of a card. */
export interface PolicyForm {
  scope: PolicyScope;
  target: string;
  when: Array<{ key: string; value: string; on: boolean }>;
  /** YYYY-MM-DD */
  expires: string;
  /** The person opened the form: 今回のみ is then kept as a one-time policy (its history), not just answered. */
  opened: boolean;
}

/** The form a card starts with (the server's defaults), or null when there is nothing to choose (once only, or none). */
export function initialPolicyForm(ask: Pick<Ask, "policy">): PolicyForm | null {
  const d = ask.policy.defaults;
  if (ask.policy.scopes.length < 2 || !d) return null;
  return { scope: "once", target: d.target, when: d.when.map((w) => ({ ...w, on: true })), expires: dayOf(d.expiresAt ?? Date.now() + 30 * DAY_MS), opened: false };
}

/** What goes with the answer: nothing until the form is opened; 今回のみ is a one-time policy (no expiry), else the policy to save (the day's end as its expiry). */
export function policyInput(form: PolicyForm | null): PolicyInput | undefined {
  if (!form || !form.opened) return undefined;
  if (form.scope === "once") return { scope: "once", target: form.target.trim(), when: [], expiresAt: null };
  return { scope: form.scope, target: form.target.trim(), when: form.when.filter((w) => w.on).map(({ key, value }) => ({ key, value })), expiresAt: Date.parse(`${form.expires}T23:59:59+09:00`) };
}

/* ---------- batches (#2046) ---------- */

export const BATCH_LABEL: Record<AskBatch["kind"], string> = { sso: "SSO のログイン待ち", deploy: "配備の承認待ち" };

/** A batch's Task lines: the Task, its operation and when it stopped. */
export const batchLines = (b: Pick<AskBatch, "asks">, now = Date.now()) => b.asks.map((a) => ({ taskId: a.taskId, text: `${a.title} — ${a.op} — ${jstClock(a.at, now)}` }));

/**
 * The questions a batch shows: their own cards are left out of the list (answered on the batch's card), and so are the
 * open stop / check of the Task logging in for it (the card says it logs in).
 */
export function hiddenByBatches(asks: Ask[], batches: AskBatch[]): Ask[] {
  const ids = new Set(batches.flatMap((b) => b.asks.map((a) => a.askId)));
  const loggingIn = new Set(batches.flatMap((b) => (b.loggingIn ? [b.loggingIn.taskId] : [])));
  return asks.filter((a) => !ids.has(a.id) && !(a.task && loggingIn.has(a.task.id) && a.state === "open" && (a.kind === "stop" || a.kind === "check")));
}
