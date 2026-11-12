import type { Ask, AskAnswer, AskBatch, PolicyInput, PolicyScope } from "@switchboard/protocol";
import { issueHref } from "./backlogSync.ts";
import { jstClock, jstDay } from "./time.ts";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/** 判断待ち (#935): what each kind of question is called on screen. */
export const KIND_LABEL: Record<Ask["kind"], string> = {
  approval: t(m.kindApproval),
  decision: t(m.kindDecision),
  check: t(m.kindCheck),
  confirmation: t(m.kindConfirmation),
  stop: t(m.kindStop),
  wait: t(m.kindWait),
  notice: t(m.kindNotice),
};

// open is 未回答: 保留 is the person's hold (#936)
export const STATE_LABEL: Record<Ask["state"], string> = { open: t(m.stateOpen), held: t(m.stateHeld), answered: t(m.stateAnswered), resolved: t(m.stateResolved) };

type GroupKey = "person" | "auto" | "answered" | "resolved";
const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: "person", label: t(m.groupPerson) },
  { key: "auto", label: t(m.groupAuto) },
  { key: "answered", label: t(m.stateAnswered) },
  { key: "resolved", label: t(m.stateResolved) },
];

// a held one (#936) is still the person's to answer
const groupKeyOf = (a: Ask): GroupKey => (a.state === "open" ? a.needs : a.state === "held" ? "person" : a.state);

/** The screen's groups, in order and without the empty ones: open ones by who has to act, then answered, then resolved (whoever). */
export function groupAsks(asks: Ask[]): Array<{ key: GroupKey; label: string; asks: Ask[] }> {
  return GROUPS.map((g) => ({ ...g, asks: asks.filter((a) => groupKeyOf(a) === g.key) })).filter((g) => g.asks.length > 0);
}

/** The heading of the questions whose Workspace is not known (#1673). */
export const UNKNOWN_WORKSPACE = t(m.unknownWorkspace);

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

/** What a fact the daemon did not record reads as; the 判断待ち screen greys it out. */
export const UNKNOWN = t(m.unknown);

/** The facts of one question card, in the PBI's order; a value the records do not have says 不明. Choices and conditions only when there are some. */
export function askFacts(a: Ask): Array<{ label: string; value: string; href?: string }> {
  const r = a.recommendation;
  // a daemon's notice (#2866) has no PBI, Task or choice: what it is about, why, what to do, and what put it there
  if (a.kind === "notice")
    return [
      { label: t(m.kindNotice), value: a.question ?? UNKNOWN },
      ...(a.reason ? [{ label: t(m.factContent), value: a.reason }] : []),
      ...(a.next ? [{ label: t(m.factTodo), value: a.next }] : []),
      { label: t(m.factSource), value: a.source.label },
    ];
  return [
    { label: t(m.factRepo), value: a.workspace?.name ?? UNKNOWN },
    a.pbi ? { label: "PBI", value: `#${a.pbi.number} ${a.pbi.title}`, href: a.pbi.url } : { label: "PBI", value: UNKNOWN },
    { label: "Task", value: a.task ? (a.task.title ?? a.task.id) : UNKNOWN },
    { label: t(m.factReason), value: a.reason ?? UNKNOWN },
    { label: t(m.factQuestion), value: a.question ?? UNKNOWN },
    ...(a.choices.length ? [{ label: t(m.factChoices), value: a.choices.join("\n") }] : []),
    { label: t(m.factRecommendation), value: r ? (r.why ? `${r.choice} — ${r.why}` : r.choice) : UNKNOWN },
    { label: t(m.factAfter), value: a.next ?? UNKNOWN },
    ...(a.conditions.length ? [{ label: t(m.factConditions), value: a.conditions.map((c) => `${c.key}: ${c.value}${c.met ? t(m.conditionMet) : ""}`).join("\n") }] : []),
    a.source.url ? { label: t(m.factRecord), value: a.source.label, href: a.source.url } : { label: t(m.factRecord), value: a.source.label },
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
  a.kind === "decision" || a.kind === "confirmation" ? (a.issue ? `Issue #${a.issue.number}` : "Issue") : a.task ? t(m.taskTarget, { title: a.task.title ?? a.task.id }) : "Task";

/** A choice's grant (#2745): what follows ` — 許可: ` in its line; null = none. The daemon's parseAskBlock reads the same. */
export function grantOf(choice: string): string | null {
  const m = / — 許可[:：]\s*(.+)$/.exec(choice); // compared with the daemon's choice line
  return m ? m[1]!.trim() : null;
}

/** A choice's text before its grant: what the card shows on the 送る line, the grant going on the next. */
export const withoutGrant = (choice: string) => choice.replace(/ — 許可[:：]\s*.+$/, ""); // compared with the daemon's choice line

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
  const next = a.next ?? t(m.unknown);
  const out: AnswerButton[] = [];
  if (takes.has("grant") && a.grant) out.push({ label: t(m.btnGrant), answer: { kind: "grant" }, send: a.grant, grant: a.grant, target: a.issue ? `Issue #${a.issue.number}` : target, next, primary: true });
  if (takes.has("allow")) {
    // `send` (here and below) is sent to the daemon as the answer: it stays Japanese in either language
    // ui-strings: value "ツール" — part of the answer sent to the daemon
    const tool = a.reason?.split(": ").at(-1) ?? "ツール";
    out.push({ label: t(m.btnAllow), answer: { kind: "allow" }, send: `${tool} を許可`, grant: null, target, next, primary: true });
  }
  if (takes.has("deny")) out.push({ label: t(m.deny), answer: { kind: "deny" }, send: "拒否" /* sent to the daemon */, grant: null, target, next: t(m.denyNext), primary: false });
  if (takes.has("choice")) {
    const rec = a.recommendation ? choiceKey(a.recommendation.choice) : null;
    const choices = [...a.choices].sort((x, y) => Number(choiceKey(y) === rec) - Number(choiceKey(x) === rec));
    for (const c of choices) {
      const recommended = choiceKey(c) === rec;
      out.push({ label: recommended ? t(m.btnRecommended, { key: choiceKey(c) }) : t(m.btnChoice, { key: choiceKey(c) }), answer: { kind: "choice", choice: c }, send: c, grant: grantOf(c), target, next, primary: recommended && !takes.has("grant") });
    }
  }
  if (takes.has("confirm")) out.push({ label: t(m.btnConfirm), answer: { kind: "confirm", ok: true }, send: `受け入れ条件「${a.question ?? ""}」を確認しました` /* sent to the daemon */, grant: null, target, next, primary: true });
  if (takes.has("dismiss")) out.push({ label: t(m.btnDismiss), answer: { kind: "dismiss" }, send: "誤検知として閉じる" /* sent to the daemon */, grant: null, target, next: t(m.dismissNext), primary: false });
  if (takes.has("hold")) out.push({ label: t(m.btnHold), answer: { kind: "hold" }, send: "## 保留 を書く。判断待ちのまま" /* sent to the daemon */, grant: null, target, next: t(m.holdNext), primary: false });
  return out;
}

/**
 * 「すぐ答えられる」 (#1675): the person's to answer (open or held), nothing an answer does not take away, and a button
 * that answers it with one press (answerButtons' primary: 承認して続行, 推奨案で進める, 確認した). One that sends a
 * grant (a stop's この操作だけ許可して続ける, a recommended choice's ` — 許可: `) is not: it widens what the Task may do.
 */
export const isQuick = (a: Ask) => groupKeyOf(a) === "person" && a.blockers.length === 0 && answerButtons(a).some((b) => b.primary && b.grant === null);

/** The groups with the person's narrowed to the quick ones (#1675): the other groups as they are, the order kept, an emptied group left out. */
export const quickGroups = <G extends { key: GroupKey; asks: Ask[] }>(groups: G[]): G[] =>
  groups.map((g) => (g.key === "person" ? { ...g, asks: g.asks.filter(isQuick) } : g)).filter((g) => g.asks.length > 0);

/** The questions of one Task its screen answers (#2745): its open operational checks and stops a person answers. */
export const taskAsks = (list: Ask[], taskId: string) => list.filter((a) => a.task?.id === taskId && (a.kind === "check" || a.kind === "stop") && a.state === "open" && a.needs === "person");

/** How the work goes on after the answer (#936), as the card's badge; null while nothing is answered. */
export function resumeLabel(a: Pick<Ask, "state" | "resume">): { text: string; tone: "ok" | "wait" | "bad" } | null {
  const r = a.resume;
  if (!r) return a.state === "answered" ? { text: t(m.stateAnswered), tone: "ok" } : null;
  if (r.state === "running") return { text: t(m.running), tone: "ok" };
  if (r.state === "queued") return { text: r.reason ? t(m.resumeQueuedWhy, { reason: r.reason }) : t(m.resumeQueued), tone: "wait" };
  if (r.state === "failed") return { text: r.reason ? t(m.resumeFailedWhy, { reason: r.reason }) : t(m.resumeFailed), tone: "bad" };
  return { text: t(m.stateAnswered), tone: "ok" };
}

/** The Issues an Ask unblocks, each with its link — null when the Issue has no url (a workspace without GitHub sync, #2343). */
export const unblockLinks = (unblocks: Ask["unblocks"]): Array<{ number: number; title: string; href: string | null }> => unblocks.map((u) => ({ number: u.number, title: u.title, href: issueHref(u.url) }));

/** Where "open the Issue" goes: the Issue's url when the Ask routes to it and it has one, else null (no link to show). */
export const issueOpenHref = (x: Pick<Ask, "route" | "issue">): string | null => (x.route === "issue" && x.issue ? issueHref(x.issue.url) : null);

/** How many other PBIs wait on the question (#1674); null = none. */
export const unblocksLine = (a: Pick<Ask, "unblocks">) => (a.unblocks.length ? t(m.unblocks, { count: a.unblocks.length }) : null);

/** What an answer does not take away (#936), one line each, shown above the buttons. */
// a runner's refusal already says it
export const blockerLines = (a: Pick<Ask, "blockers">) => a.blockers.map((b) => (b.kind === "runner" ? b.detail : t(m.blocker, { detail: b.detail })));

/**
 * What a card answered on this screen shows (#936): the question the answer returned (`changed` = a 409: what changed,
 * kept on the question now, under its id).
 */
export type Answered = { ask: Ask; changes?: string[]; changed?: boolean };

/**
 * The list has moved past the question answered here: a decision answered under another id (its id names the answer's
 * time); a Task's question, once the list has any other question of the same Task (#3059: the Task went on and stopped
 * again — open or answered, the card answered here gives way to it).
 */
const answeredIn = (x: Ask, list: Ask[]) =>
  list.some((y) =>
    y.id !== x.id && y.workspace?.id === x.workspace?.id &&
    (x.pbi ? y.kind === x.kind && y.state !== "open" && y.state !== "held" && y.pbi?.number === x.pbi.number : !!x.task && !y.pbi && y.task?.id === x.task.id),
  );

/**
 * What stays of the answers given here once a newer list comes (#936): an answer the list has the question of gives way to
 * the list, one whose question left the list (a check whose Task went on) stays until the list has moved past it
 * (answeredIn: the decision answered under a new id, the Task's next question — dropped then, so a later list without
 * that question does not bring the card back, #3059); a 409's notice stays on its question until the list has that
 * question changed again (or no longer has it).
 */
export function pruneAnswered(answered: Map<string, Answered>, list: Ask[]): Map<string, Answered> {
  return new Map(
    [...answered].filter(([id, v]) => {
      const now = list.find((x) => x.id === id);
      return v.changed ? !!now && now.changedAt === v.ask.changedAt : !now && !answeredIn(v.ask, list);
    }),
  );
}

/**
 * The answers given here that the list no longer has, as their cards: not when the list has the decision answered under a
 * new id, nor once the list has another question of the same Task (#3059).
 */
export const keptAnswers = (answered: Map<string, Answered>, list: Ask[]) =>
  [...answered.entries()].filter(([id, v]) => !v.changed && !list.some((y) => y.id === id) && !answeredIn(v.ask, list)).map(([, v]) => v.ask);

/* ---------- answer policies (#938) ---------- */

const DAY_MS = 86_400_000;
const dayOf = jstDay;

/** The range a policy is saved under, as the card says it. */
export function scopeLabel(scope: PolicyScope, ask: Pick<Ask, "pbi" | "workspace" | "task">): string {
  if (scope === "once") return t(m.scopeOnce);
  if (scope === "pbi") return t(m.scopePbi, { ref: ask.pbi ? `#${ask.pbi.number}` : ask.task?.stageIssue ? `#${ask.task.stageIssue}` : t(m.unknown) });
  return t(m.scopeRepo, { name: ask.workspace?.name ?? t(m.unknown) });
}

/** `{a,b}` alternatives spelled out (`npm{,x}` → npm, npmx). */
function expandBraces(word: string): string[] {
  const m = /\{([^{}]*)\}/.exec(word);
  if (!m) return [word];
  return m[1]!.split(",").flatMap((alt) => expandBraces(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length)));
}

/** An exec target that fixes only the program and wildcards the rest (`bun *`, `cmd:git *`): the program names, else null. */
export function broadTarget(op: string, target: string): string[] | null {
  if (op !== "exec") return null;
  const [program, ...rest] = target.trim().replace(/^cmd:/, "").split(/\s+/);
  if (!program || /[*?[]/.test(program) || rest.length === 0 || !rest.every((w) => /^[*?]+$/.test(w))) return null;
  return expandBraces(program);
}

/** The warning line for a broad target, or none. */
export const broadLines = (op: string, target: string): string[] => {
  const names = broadTarget(op, target);
  return names ? [t(m.broad, { names: names.join(" / ") })] : [];
};

/** What the person confirms before a policy is saved: operation, target (and a broad target's warning), conditions, expiry and what is answered. */
export function policySummary(ask: Pick<Ask, "subject">, input: PolicyInput, answerText = t(m.allow), now = Date.now()): string[] {
  const left = input.expiresAt === null ? null : Math.max(0, Math.ceil((input.expiresAt - now) / DAY_MS));
  return [
    t(m.sumOp, { op: ask.subject?.op ?? t(m.unknown) }),
    t(m.sumTarget, { target: input.target }),
    ...broadLines(ask.subject?.op ?? "", input.target),
    t(m.sumWhen, { when: input.when.length ? input.when.map((w) => `${w.key}=${w.value}`).join(" ") : t(m.none) }),
    t(m.sumExpires, { expires: input.expiresAt === null ? t(m.none) : t(m.expiresLeft, { day: dayOf(input.expiresAt), left: left ?? 0 }) }),
    t(m.answerLine, { answer: answerText }),
  ];
}

/** The earlier answer that no longer applies, and why, and what differs (the card says it will ask again). */
export function previousLines(ask: Pick<Ask, "policy">): string[] {
  const p = ask.policy.previous;
  if (!p) return [];
  const said = p.answer.kind === "choice" ? p.answer.choice : p.answer.kind === "text" ? p.answer.text : p.answer.kind === "allow" ? t(m.allow) : p.answer.kind;
  return [t(m.prevAnswer, { said, day: dayOf(p.at), id: p.id }), t(m.prevWhy, { why: p.why }), ...p.changes];
}

/** The policy that answered this question, as one line. */
export const appliedLine = (ask: Pick<Ask, "policy">): string | null => (ask.policy.applied ? t(m.applied, { summary: ask.policy.applied.summary }) : null);

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

export const BATCH_LABEL: Record<AskBatch["kind"], string> = { sso: t(m.batchSso), deploy: t(m.batchDeploy), "security-merge": t(m.batchSecurityMerge) };

/** A batch's Task lines: the Task, its operation and when it stopped. */
export const batchLines = (b: Pick<AskBatch, "asks">, now = Date.now()) => b.asks.map((a) => ({ taskId: a.taskId, text: `${a.title} — ${a.op} — ${jstClock(a.at, now)}` }));

/** The merge choice of a check (`A: マージする — …`, as the daemon's mergeChoiceOf reads it: 「マージしない」・「待つ」 are not it). */
const hasMergeChoice = (a: Ask) => a.choices.some((c) => /^[A-Za-z0-9]+\s*[:：.．)）]\s*マージする/.test(c));

/** How long a Task has waited: 「14 時間」 (rounded up, 「N 分」 under an hour). */
const waitedText = (at: number, now: number) => {
  const min = Math.max(0, Math.ceil((now - at) / 60_000));
  return min < 60 ? t(m.waitedMinutes, { n: min }) : t(m.waitedHours, { n: Math.ceil(min / 60) });
};

/**
 * The security-merge batch's rows (#2778): a PR per row with its Task, the `[聞く]` lines it stopped with, `+add/-del` and
 * how long it has waited. `selectable` = its question (in `asks`) has a 「マージする」 choice, the one the answer sends.
 */
export const mergeBatchRows = (b: Pick<AskBatch, "asks">, now = Date.now(), asks: Ask[] = []) =>
  b.asks.map((a) => ({
    askId: a.askId,
    taskId: a.taskId,
    workspaceId: a.workspaceId,
    pr: a.pr ?? null,
    title: a.title,
    reasons: a.reasons ?? [],
    diff: a.diff ?? null,
    waited: waitedText(a.at, now),
    selectable: asks.some((k) => k.id === a.askId && hasMergeChoice(k)),
  }));

/**
 * The Tasks a press sends "merge" to: the rows chosen by their question (`askId`, a new one for each question a Task asks),
 * so a Task that asks again about another PR is not chosen by the tick on the question it asked before.
 */
export const mergeChosen = (rows: ReadonlyArray<{ askId: string; taskId: string; selectable: boolean }>, on: ReadonlySet<string>) =>
  rows.filter((r) => r.selectable && on.has(r.askId)).map((r) => r.taskId);

/** The question of each row `mergeChosen` picks (same order): sent with the Tasks so the daemon can tell the question changed. */
export const mergeChosenAskIds = (rows: ReadonlyArray<{ askId: string; taskId: string; selectable: boolean }>, on: ReadonlySet<string>) =>
  rows.filter((r) => r.selectable && on.has(r.askId)).map((r) => r.askId);

/**
 * The questions a batch shows: their own cards are left out of the list (answered on the batch's card), and so are the
 * open stop / check of the Task logging in for it (the card says it logs in).
 */
export function hiddenByBatches(asks: Ask[], batches: AskBatch[]): Ask[] {
  const ids = new Set(batches.flatMap((b) => b.asks.map((a) => a.askId)));
  const loggingIn = new Set(batches.flatMap((b) => (b.loggingIn ? [b.loggingIn.taskId] : [])));
  return asks.filter((a) => !ids.has(a.id) && !(a.task && loggingIn.has(a.task.id) && a.state === "open" && (a.kind === "stop" || a.kind === "check")));
}

/**
 * A question card's parts in the order a phone reads them (#4068): what it is about (the PBI, else the Task, else
 * nothing), the question itself (above the answer buttons), the facts that are known, and the labels of the ones the
 * records do not have — one line 「不明: …」 instead of a row each (docs/design/asks.md still says they are 不明).
 */
export function askCardParts(a: Ask): { title: { text: string; href?: string } | null; question: string | null; facts: Array<{ label: string; value: string; href?: string }>; unknown: string[] } {
  const all = askFacts(a);
  const questionLabel = a.kind === "notice" ? t(m.kindNotice) : t(m.factQuestion);
  const q = all.find((f) => f.label === questionLabel);
  const rest = all.filter((f) => f !== q);
  const title = a.kind === "notice" ? null : a.pbi ? { text: `#${a.pbi.number} ${a.pbi.title}`, href: a.pbi.url } : a.task ? { text: a.task.title ?? a.task.id } : null;
  return {
    title,
    question: q && q.value !== UNKNOWN ? q.value : null,
    facts: rest.filter((f) => f.value !== UNKNOWN),
    unknown: [...(q && q.value === UNKNOWN ? [q.label] : []), ...rest.filter((f) => f.value === UNKNOWN).map((f) => f.label)],
  };
}

/** How much of a long question a card shows before 全文 (#4068): six lines, and about 300 characters (a short screenful of Japanese on a phone). */
export const QUESTION_HEAD = 300;

/** A question's first part and whether there is more (#4068): at most six lines, cut at a line end within QUESTION_HEAD characters when there is one; counted in characters, so an emoji is not split. */
export function questionHead(q: string): { head: string; more: boolean } {
  const lines = q.split("\n");
  let head = lines.slice(0, 6).join("\n");
  const chars = Array.from(head);
  if (chars.length > QUESTION_HEAD) {
    const within = chars.slice(0, QUESTION_HEAD).join("");
    const cut = within.lastIndexOf("\n");
    head = cut > within.length / 2 ? within.slice(0, cut) : within;
  }
  return head.length < q.length ? { head: head.trimEnd() + " …", more: true } : { head: q, more: false };
}
