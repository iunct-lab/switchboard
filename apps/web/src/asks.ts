import type { Ask, AskAnswer, AskBatch, PolicyInput, PolicyScope, WaitKind } from "@switchboard/protocol";
import { choiceKey, isRecommendedChoice } from "@switchboard/protocol";
import { issueHref } from "./backlogSync.ts";
import { jstClock, jstDay } from "./time.ts";
import { t } from "./i18n.ts";
import { panels as pm } from "./i18n/panels.ts";
import { task as m } from "./i18n/task.ts";

/** 判断待ち: what each kind of question is called on screen. */
export const KIND_LABEL: Record<Ask["kind"], string> = {
  approval: t(m.kindApproval),
  decision: t(m.kindDecision),
  check: t(m.kindCheck),
  confirmation: t(m.kindConfirmation),
  stop: t(m.kindStop),
  wait: t(m.kindWait),
  notice: t(m.kindNotice),
};

// open is 未回答: 保留 is the person's hold
export const STATE_LABEL: Record<Ask["state"], string> = { open: t(m.stateOpen), held: t(m.stateHeld), answered: t(m.stateAnswered), resolved: t(m.stateResolved) };

/** The state a card's badge shows: a wait answered from its card (待ち続ける / 止める) reads answered until the list is read again. */
export function cardState(x: Ask, waitAnswer: "stop" | "keep" | undefined): Ask["state"] {
  return waitAnswer ? "answered" : x.state;
}

type GroupKey = "person" | "proceeding" | "auto" | "done";
const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: "person", label: t(m.groupPerson) },
  { key: "proceeding", label: t(m.groupProceeding) },
  { key: "auto", label: t(m.groupAuto) },
  { key: "done", label: t(m.groupDone) },
];

// a held one is still the person's to answer; one the work went on from with its recommendation is looked at later, in a group of its own
const groupKeyOf = (a: Ask): GroupKey => (a.state === "open" ? (a.proceeding ? "proceeding" : a.needs) : a.state === "held" ? "person" : "done");

/** How many of the done ones are questions whose PBI closed with the recommendation standing (推奨で確定した). */
export const settledCount = (asks: Ask[]): number => asks.filter((a) => a.proceeding && a.state === "resolved").length;

/** How many of the questions going on by their recommendation 「全部推奨のままで確定」 confirms: the open ones with a recommendation to confirm. */
export const confirmable = (asks: Ask[]): number => asks.filter((a) => a.proceeding && a.state === "open" && a.recommendation !== null).length;

/** The screen's groups, in order and without the empty ones: open ones by who has to act, then the done ones (answered and resolved, whoever). */
export function groupAsks(asks: Ask[]): Array<{ key: GroupKey; label: string; asks: Ask[] }> {
  return GROUPS.map((g) => ({ ...g, asks: asks.filter((a) => groupKeyOf(a) === g.key) })).filter((g) => g.asks.length > 0);
}

/** The heading of the questions whose Workspace is not known. */
export const UNKNOWN_WORKSPACE = t(m.unknownWorkspace);

/** The Workspace a question is filtered by: its id, "" when not known. */
export const workspaceKey = (a: Pick<Ask, "workspace">) => a.workspace?.id ?? "";

/**
 * The questions of a group under one heading per Workspace: the most questions first, then by name, the unknown
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

/**
 * The filter's buttons: every Workspace of the questions, in the headings' order, with how many are the person's to
 * answer — the rows (a PBI's, else a Task's questions are one) plus the tool approvals, which stay a card each.
 */
export const workspaceChips = (asks: Ask[]) =>
  workspaceSections(asks).map((s) => {
    const mine = s.asks.filter((a) => groupKeyOf(a) === "person");
    // a wait past its limit that is answered here is a card of its own under its kind's heading, not part of a row
    const waits = new Set(waitGroups(mine).flatMap((g) => g.asks));
    return { key: s.key, name: s.name, count: askRows(mine.filter((a) => !waits.has(a))).filter((r) => r.open).length + mine.filter((a) => a.kind === "approval").length + waits.size };
  });

/** The headings the waits past their limit are put under, in the screen's order: what each kind of wait is called. A kind not here has no heading (a running Task's wait is not answered here). */
export const WAIT_KIND_LABEL: Partial<Record<WaitKind, string>> = {
  depends: t(pm.waitKindDepends),
  job: t(pm.waitKindJob),
  date: t(pm.waitKindDate),
  resume: t(pm.waitKindResume),
  stop: t(pm.waitKindStop),
};

// the two choices of a wait past its limit, as the daemon writes them: found by their value in the question's own `choices`
// (never by position), and that value is what is sent back — the buttons' wording is the dictionary's
const WAIT_CHOICE = { stop: "止める", keep: "待ち続ける" } as const;

/**
 * The answers of a wait past its limit — the question's own choices, sent as they are; `keep` is null when the wait has
 * only 止める (it is retrying: there is nothing to keep waiting for). null = it is not answered here (not open, a running
 * Task's wait with no `choice`, or no 止める among the choices). The one place that tells which choice stops and which
 * keeps waiting.
 */
export function waitChoices(a: Pick<Ask, "kind" | "state" | "answers" | "choices" | "wait">): { stop: string; keep: string | null } | null {
  if (a.kind !== "wait" || !a.wait || a.state !== "open" || !a.answers.includes("choice")) return null;
  const stop = a.choices.find((c) => c === WAIT_CHOICE.stop);
  const keep = a.choices.find((c) => c === WAIT_CHOICE.keep);
  return stop !== undefined ? { stop, keep: keep ?? null } : null;
}

/** The waits past their limit that are answered here, under one heading per kind of wait in WAIT_KIND_LABEL's order; a kind with none has no heading, and each keeps the order it was given. */
export function waitGroups(asks: Ask[]): Array<{ kind: WaitKind; label: string; asks: Ask[] }> {
  return (Object.keys(WAIT_KIND_LABEL) as WaitKind[])
    .map((kind) => ({ kind, label: WAIT_KIND_LABEL[kind]!, asks: asks.filter((a) => a.wait?.kind === kind && waitChoices(a) !== null) }))
    .filter((g) => g.asks.length > 0);
}

/** One line of the 判断待ち screen: the questions of one Workspace that wait on the same PBI (else the same Task). */
export interface AskRow {
  key: string;
  title: { text: string; href?: string };
  /** The first question, else the first stop's reason. */
  lead: string | null;
  kinds: Ask["kind"][];
  /** One of its questions answers with one press. */
  quick: boolean;
  unblocks: Ask["unblocks"];
  /** The PBIs that wait for the row's PBI to be done and that no answer of the row lets go on. */
  waiting: Ask["waiting"];
  asks: Ask[];
  /** One of its questions is open or held, whoever it waits on (the screen passes only the person's). */
  open: boolean;
}

/** What a question is grouped under: its Workspace and PBI, else its Task; one without either (a notice) is alone. */
export const rowKey = (a: Ask): string => (a.pbi ? `${workspaceKey(a)}:pbi:${a.pbi.number}` : a.task ? `${workspaceKey(a)}:task:${a.task.id}` : `ask:${a.id}`);

/** The questions but the tool approvals (each stays a card) as rows, in the order of the topmost question of each. */
export function askRows(asks: Ask[]): AskRow[] {
  const by = new Map<string, Ask[]>();
  for (const a of asks) if (a.kind !== "approval") by.set(rowKey(a), [...(by.get(rowKey(a)) ?? []), a]);
  return [...by].map(([key, list]) => {
    const parts = list.map(askCardParts);
    const lead = parts.find((p) => p.question)?.question ?? list.find((a) => (a.kind === "stop" || a.kind === "wait") && a.reason)?.reason ?? null;
    const unblocks = new Map<number, Ask["unblocks"][number]>();
    for (const u of list.flatMap((a) => a.unblocks)) if (!unblocks.has(u.number)) unblocks.set(u.number, u);
    const waiting = new Map<number, Ask["waiting"][number]>();
    for (const u of list.flatMap((a) => a.waiting)) if (!unblocks.has(u.number) && !waiting.has(u.number)) waiting.set(u.number, u);
    return {
      key,
      title: parts[0]!.title ?? { text: parts[0]!.question ?? KIND_LABEL[list[0]!.kind] },
      lead,
      kinds: [...new Set(list.map((a) => a.kind))],
      quick: list.some(isQuick),
      unblocks: [...unblocks.values()],
      waiting: [...waiting.values()],
      asks: list,
      open: list.some((a) => a.state === "open" || a.state === "held"),
    };
  });
}

/**
 * A question answered here: its id and row, and the decisions the list already had answered in that row then. A decision is
 * named anew once answered (the time of the answer, and the PBI's number where it was asked on a Task's Issue), so it is
 * matched by its row instead of its id.
 */
export interface AnsweredHere { id: string; kind: Ask["kind"]; key: string; before: Set<string> }
export const answeredHere = (list: Ask[], x: Ask): AnsweredHere => ({
  id: x.id,
  kind: x.kind,
  key: rowKey(x),
  before: new Set(list.filter((y) => y.kind === "decision" && y.state === "answered" && rowKey(y) === rowKey(x)).map((y) => y.id)),
});

/** A question the list has answered that was answered here (the same id, or the row's decision answered since): it stays in its row; one answered elsewhere goes where the list has it. */
export const answeredInRow = (a: Ask, here: AnsweredHere[]) =>
  a.kind !== "approval" && a.state === "answered" && here.some((h) => h.id === a.id || (h.kind === "decision" && a.kind === "decision" && h.key === rowKey(a) && !h.before.has(a.id)));

/** The rows with a question that answers with one press, the order kept. */
export const quickRows = (rows: AskRow[]): AskRow[] => rows.filter((r) => r.quick);

/** What a fact the daemon did not record reads as; the 判断待ち screen greys it out. */
export const UNKNOWN = t(m.unknown);

/** The facts of one question card, in the PBI's order; a value the records do not have says 不明. Choices and conditions only when there are some. */
export function askFacts(a: Ask): Array<{ label: string; value: string; href?: string }> {
  const r = a.recommendation;
  // a daemon's notice has no PBI, Task or choice: what it is about, why, what to do, and what put it there
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
    // a question tool's options carry their own ` (Recommended)`: the card shows it there, not as a fact
    ...(a.kind === "check" ? [] : [{ label: t(m.factRecommendation), value: r ? (r.why ? `${r.choice} — ${r.why}` : r.choice) : UNKNOWN }]),
    { label: t(m.factAfter), value: a.next ?? UNKNOWN },
    ...(a.conditions.length ? [{ label: t(m.factConditions), value: a.conditions.map((c) => `${c.key}: ${c.value}${c.met ? t(m.conditionMet) : ""}`).join("\n") }] : []),
    a.source.url ? { label: t(m.factRecord), value: a.source.label, href: a.source.url } : { label: t(m.factRecord), value: a.source.label },
  ];
}

/** One answer button of a card: what it sends, where it is written and what goes on after it. */
export interface AnswerButton {
  label: string;
  answer: AskAnswer;
  /** The answer as written / sent. */
  send: string;
  /** The grant it sends: the stop's, or the choice's ` — 許可: `; shown on a line of its own. */
  grant: string | null;
  /** Where it goes: the Issue it is written on, or the Task it is sent to. */
  target: string;
  next: string;
  /** The button's second line: a choice's impact, or what a hold / deny / dismiss does; null = none. */
  sub: string | null;
  primary: boolean;
}

/** Where an answer goes: the Issue it is written on (a decision, a confirmation), else the Task it is sent to. */
export const answerTarget = (a: Pick<Ask, "kind" | "issue" | "task">) =>
  a.kind === "decision" || a.kind === "confirmation" ? (a.issue ? `Issue #${a.issue.number}` : "Issue") : a.task ? t(m.taskTarget, { title: a.task.title ?? a.task.id }) : "Task";

/** A choice's grant: what follows ` — 許可: ` in its line; null = none. The daemon's parseAskBlock reads the same. */
export function grantOf(choice: string): string | null {
  const m = / — 許可[:：]\s*(.+)$/.exec(choice); // compared with the daemon's choice line
  return m ? m[1]!.trim() : null;
}

/** A choice's text before its grant: the grant goes on a line of its own. */
export const withoutGrant = (choice: string) => choice.replace(/ — 許可[:：]\s*.+$/, ""); // compared with the daemon's choice line

/** A choice split into what the button says (`head`), its ` — 影響: ` (`impact`) and its ` — 許可: ` (`grant`). */
export function choiceParts(choice: string): { head: string; impact: string | null; grant: string | null } {
  const grant = grantOf(choice);
  const rest = withoutGrant(choice);
  const hit = / — 影響[:：]/.exec(rest); // compared with the daemon's choice line
  if (!hit) return { head: rest.trim(), impact: null, grant };
  const impact = rest.slice(hit.index + 3).trim();
  return { head: rest.slice(0, hit.index).trim(), impact: impact || null, grant };
}

/** Whether a question's answer is written on an Issue: a decision's or a confirmation's. */
const answersOnIssue = (a: Pick<Ask, "kind">) => a.kind === "decision" || a.kind === "confirmation";

/** The one line of a question that says where its answer goes and what goes on after it: the same target its buttons send to. */
export function answerRoute(a: Ask): string {
  const next = a.next ?? UNKNOWN;
  if (!answersOnIssue(a)) return t(m.answerRouteTask, { target: answerTarget(a), next });
  return t(m.answerRouteIssue, { target: a.issue ? `Issue #${a.issue.number}` : "Issue", next });
}

/**
 * The buttons of a question, from what it takes (`answers`), its choices and its recommendation: a stop's grant
 * (この操作だけ許可して続ける), an approval's 承認して続行 / 拒否, one per choice (its head, the recommended one first with （推奨）; a wait past its limit: 待ち続ける / 止める), 確認した, a notice's 誤検知として閉じる, and 保留. None when it takes
 * no answer; free text (and a confirmation's 違う) is the card's text box.
 */
export function answerButtons(a: Ask): AnswerButton[] {
  const takes = new Set(a.answers);
  const target = answerTarget(a);
  const next = a.next ?? t(m.unknown);
  const out: AnswerButton[] = [];
  if (takes.has("grant") && a.grant) out.push({ label: t(m.btnGrant), answer: { kind: "grant", grant: a.grant }, send: a.grant, grant: a.grant, target, next, sub: null, primary: true });
  if (takes.has("allow")) {
    // `send` (here and below) is sent to the daemon as the answer: it stays Japanese in either language
    // ui-strings: value "ツール" — part of the answer sent to the daemon
    const tool = a.reason?.split(": ").at(-1) ?? "ツール";
    out.push({ label: t(m.btnAllow), answer: { kind: "allow" }, send: `${tool} を許可`, grant: null, target, next, sub: null, primary: true });
  }
  if (takes.has("deny")) out.push({ label: t(m.deny), answer: { kind: "deny" }, send: "拒否" /* sent to the daemon */, grant: null, target, next: t(m.denyNext), sub: t(m.denyNext), primary: false });
  // one the work went on from: 「<推奨> のまま」 confirms it, 「<ほか> にする」 overturns it (and a Task redoes that part)
  if (a.proceeding) {
    // the recommended choice by its own line when the question lists it (`A: 置き換える`), else as the recommendation names it
    const kept = a.choices.find((x) => isRecommendedChoice(x, a.recommendation));
    if (takes.has("confirm") && a.recommendation) out.push({ label: t(m.btnKeep, { choice: kept ? choiceParts(kept).head : choiceKey(a.recommendation.choice) }), answer: { kind: "confirm", ok: true }, send: `推奨のまま ${choiceKey(a.recommendation.choice)}` /* sent to the daemon */, grant: null, target, next: t(m.keepNext), sub: null, primary: true });
    for (const c of takes.has("choice") ? a.choices.filter((x) => !isRecommendedChoice(x, a.recommendation)) : []) {
      const { head, impact } = choiceParts(c);
      out.push({ label: t(m.btnSwitch, { choice: head }), answer: { kind: "choice", choice: c }, send: c, grant: grantOf(c), target, next: t(m.switchNext), sub: impact, primary: false });
    }
    return out;
  }
  // a wait past its limit: 待ち続ける (when it has one) then 止める, neither the recommended one; what is sent is the question's own choice
  const wait = waitChoices(a);
  if (wait) {
    if (wait.keep !== null) out.push({ label: t(pm.waitKeep), answer: { kind: "choice", choice: wait.keep }, send: wait.keep, grant: null, target, next, sub: null, primary: false });
    out.push({ label: t(pm.waitStop), answer: { kind: "choice", choice: wait.stop }, send: wait.stop, grant: null, target, next, sub: null, primary: false });
  } else if (takes.has("choice")) {
    const rec = a.recommendation ? choiceKey(a.recommendation.choice) : null;
    const choices = [...a.choices].sort((x, y) => Number(choiceKey(y) === rec) - Number(choiceKey(x) === rec));
    for (const c of choices) {
      const recommended = choiceKey(c) === rec;
      const { head, impact } = choiceParts(c);
      out.push({ label: recommended ? head + t(m.recommendedSuffix) : head, answer: { kind: "choice", choice: c }, send: c, grant: grantOf(c), target, next, sub: impact, primary: recommended && !takes.has("grant") });
    }
  }
  if (takes.has("confirm")) out.push({ label: t(m.btnConfirm), answer: { kind: "confirm", ok: true }, send: `受け入れ条件「${a.question ?? ""}」を確認しました` /* sent to the daemon */, grant: null, target, next, sub: null, primary: true });
  if (takes.has("dismiss")) out.push({ label: t(m.btnDismiss), answer: { kind: "dismiss" }, send: "誤検知として閉じる" /* sent to the daemon */, grant: null, target, next: t(m.dismissNext), sub: t(m.dismissNext), primary: false });
  if (takes.has("hold")) out.push({ label: t(m.btnHold), answer: { kind: "hold" }, send: "## 保留 を書く。判断待ちのまま" /* sent to the daemon */, grant: null, target, next: t(m.holdNext), sub: t(m.holdNext), primary: false });
  return out;
}

/**
 * 「すぐ答えられる」: the person's to answer (open or held), nothing an answer does not take away, and a button
 * that answers it with one press (answerButtons' primary: 承認して続行, the recommended choice, 確認した). One that sends a
 * grant (a stop's この操作だけ許可して続ける, a recommended choice's ` — 許可: `) is not: it widens what the Task may do.
 */
export const isQuick = (a: Ask) => groupKeyOf(a) === "person" && a.blockers.length === 0 && answerButtons(a).some((b) => b.primary && b.grant === null);

/** The questions of one Task its screen answers: its open operational checks and stops a person answers. */
export const taskAsks = (list: Ask[], taskId: string) => list.filter((a) => a.task?.id === taskId && (a.kind === "check" || a.kind === "stop") && a.state === "open" && a.needs === "person");

/** How the work goes on after the answer, as the card's badge; null while nothing is answered. */
export function resumeLabel(a: Pick<Ask, "state" | "resume">): { text: string; tone: "ok" | "wait" | "bad" } | null {
  const r = a.resume;
  if (!r) return a.state === "answered" ? { text: t(m.stateAnswered), tone: "ok" } : null;
  if (r.state === "running") return { text: t(m.running), tone: "ok" };
  if (r.state === "queued") return { text: r.reason ? t(m.resumeQueuedWhy, { reason: r.reason }) : t(m.resumeQueued), tone: "wait" };
  if (r.state === "failed") return { text: r.reason ? t(m.resumeFailedWhy, { reason: r.reason }) : t(m.resumeFailed), tone: "bad" };
  return { text: t(m.stateAnswered), tone: "ok" };
}

/** The Issues an Ask unblocks, each with its link — null when the Issue has no url (a workspace without GitHub sync). */
export const unblockLinks = (unblocks: Ask["unblocks"]): Array<{ number: number; title: string; href: string | null }> => unblocks.map((u) => ({ number: u.number, title: u.title, href: issueHref(u.url) }));

/** Where "open the Issue" goes: the url of the Issue the Ask has (a decision's or a confirmation's PBI, a stage Task's Issue) unless it routes nowhere, else null (no link to show). */
export const issueOpenHref = (x: Pick<Ask, "route" | "issue">): string | null => (x.route !== "none" && x.issue ? issueHref(x.issue.url) : null);

/** How many other PBIs wait on the question; null = none. */
export const unblocksLine = (a: Pick<Ask, "unblocks">) => (a.unblocks.length ? t(m.unblocks, { count: a.unblocks.length }) : null);

/** How many other PBIs wait for the question's PBI to be done when no answer here lets them go on; null = none, or `unblocksLine` says it. */
export const waitingLine = (a: Pick<Ask, "unblocks" | "waiting">) => (a.unblocks.length === 0 && a.waiting.length ? t(m.waitingForPbi, { count: a.waiting.length }) : null);

/** The one badge about the PBIs behind a question: what an answer lets go on, else what waits for its PBI. */
export const waitersLine = (a: Pick<Ask, "unblocks" | "waiting">) => unblocksLine(a) ?? waitingLine(a);

/** What an answer does not take away, one line each, shown above the buttons. */
// a runner's refusal already says it
export const blockerLines = (a: Pick<Ask, "blockers">) => a.blockers.map((b) => (b.kind === "runner" ? b.detail : t(m.blocker, { detail: b.detail })));

/**
 * What a card answered on this screen shows: the question the answer returned (`changed` = a 409: what changed,
 * kept on the question now, under its id).
 */
export type Answered = { ask: Ask; changes?: string[]; changed?: boolean };

/**
 * The list has moved past the question answered here: a decision answered under another id (its id names the answer's
 * time); a Task's question, once the list has any other question of the same Task (the Task went on and stopped
 * again — open or answered, the card answered here gives way to it).
 */
const answeredIn = (x: Ask, list: Ask[]) =>
  list.some((y) =>
    y.id !== x.id && y.workspace?.id === x.workspace?.id &&
    (x.pbi ? y.kind === x.kind && y.state !== "open" && y.state !== "held" && y.pbi?.number === x.pbi.number : !!x.task && !y.pbi && y.task?.id === x.task.id),
  );

/**
 * What stays of the answers given here once a newer list comes: an answer the list has the question of gives way to
 * the list, one whose question left the list (a check whose Task went on) stays until the list has moved past it
 * (answeredIn: the decision answered under a new id, the Task's next question — dropped then, so a later list without
 * that question does not bring the card back); a 409's notice stays on its question until the list has that
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
 * new id, nor once the list has another question of the same Task.
 */
export const keptAnswers = (answered: Map<string, Answered>, list: Ask[]) =>
  [...answered.entries()].filter(([id, v]) => !v.changed && !list.some((y) => y.id === id) && !answeredIn(v.ask, list)).map(([, v]) => v.ask);

/* ---------- answer policies ---------- */

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

/**
 * An exec target that fixes only the program and wildcards the rest (`bun *`, `cmd:git *`): the program names, else null.
 * A program written as a prefix wildcard with a `*` (`cmd:bun*`, `cmd:npm{,x}*`, `bun* *`) may stand alone with `cmd:` or be followed by wildcards only; its names keep the trailing wildcard.
 * A bare `bun*` (no `cmd:`, no space) is a path pattern to core's `globMatch` and never matches a command, so it is not broad.
 */
export function broadTarget(op: string, target: string): string[] | null {
  if (op !== "exec") return null;
  const trimmed = target.trim();
  const [program, ...rest] = trimmed.replace(/^cmd:/, "").split(/\s+/);
  if (!program || !rest.every((w) => /^[*?]+$/.test(w))) return null;
  const command = rest.length > 0 || trimmed.startsWith("cmd:");
  if (/^[^*?[\s]+[*?]+$/.test(program) && program.includes("*") && command) return expandBraces(program);
  if (/[*?[]/.test(program) || rest.length === 0) return null;
  return expandBraces(program);
}

/** The warning line for a broad target, or none. */
export const broadLines = (op: string, target: string): string[] => {
  const names = broadTarget(op, target);
  if (!names) return [];
  if (!/[*?]$/.test(names[0]!)) return [t(m.broad, { names: names.join(" / ") })];
  return [t(m.broadPrefix, { names: names.join(" / "), stems: names.map((n) => n.replace(/[*?]+$/, "")).join(" / ") })];
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

/* ---------- batches ---------- */

export const BATCH_LABEL: Record<AskBatch["kind"], string> = { sso: t(m.batchSso), deploy: t(m.batchDeploy) };

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

/**
 * A question card's parts in the order a phone reads them: what it is about (the PBI, else the Task, else
 * nothing), the question itself (above the answer buttons), the facts that are known, and the labels of the ones the
 * records do not have — one line 「不明: …」 instead of a row each (docs/design/asks.md still says they are 不明).
 * `confirm`: for a notice the person confirms (a change of a workspace's settings), what the confirmation is of — its
 * content and what confirming does — shown above the answer buttons and never among the folded facts: a safety
 * confirmation's substance is not behind a closed section while its button is in view (README, Design rules).
 */
export function askCardParts(a: Ask): { title: { text: string; href?: string } | null; question: string | null; confirm: Array<{ label: string; value: string }>; facts: Array<{ label: string; value: string; href?: string }>; unknown: string[] } {
  const all = askFacts(a);
  const questionLabel = a.kind === "notice" ? t(m.kindNotice) : t(m.factQuestion);
  const q = all.find((f) => f.label === questionLabel);
  const unfolded = a.kind === "notice" && a.answers.includes("confirm") ? [t(m.factTodo), t(m.factContent)] : [];
  const confirm = unfolded.flatMap((label) => all.filter((f) => f.label === label && f.value !== UNKNOWN));
  const rest = all.filter((f) => f !== q && !confirm.includes(f));
  const title = a.kind === "notice" ? null : a.pbi ? { text: `#${a.pbi.number} ${a.pbi.title}`, href: a.pbi.url } : a.task ? { text: a.task.title ?? a.task.id } : null;
  return {
    title,
    question: q && q.value !== UNKNOWN ? q.value : null,
    confirm,
    facts: rest.filter((f) => f.value !== UNKNOWN),
    unknown: [...(q && q.value === UNKNOWN ? [q.label] : []), ...rest.filter((f) => f.value === UNKNOWN).map((f) => f.label)],
  };
}

/** How much of a long question a card shows before 全文: six lines, and about 300 characters (a short screenful of Japanese on a phone). */
export const QUESTION_HEAD = 300;

/** A question's first part and whether there is more: at most six lines, cut at a line end within QUESTION_HEAD characters when there is one; counted in characters, so an emoji is not split. */
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

/** How much of a Task's last reply a stop's row shows before 全文: six lines, and 400 characters. */
export const REPLY_HEAD = 400;

/** A last reply's first part and whether there is more: at most six lines and REPLY_HEAD characters (counted in characters, so an emoji is not split). */
export function replyPreview(text: string): { head: string; more: boolean } {
  const head = Array.from(text.split("\n").slice(0, 6).join("\n")).slice(0, REPLY_HEAD).join("");
  // trailing blank lines are not more to read
  return head.length < text.trimEnd().length ? { head: head.trimEnd(), more: true } : { head: text, more: false };
}

/** The line that says a stop's reply reaches the Task (its title, else its id) and the Task goes on. */
export const replyTarget = (a: Pick<Ask, "task">): string => t(pm.replyTarget, { title: a.task?.title ?? a.task?.id ?? "Task" });

/** A stop the person answers in words: the reply is sent to its Task. */
export const takesReply = (a: Pick<Ask, "kind" | "answers">) => a.kind === "stop" && a.answers.includes("text");
