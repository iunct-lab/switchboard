/**
 * What an Issue's comments say: the headings a question, an answer, a hold and a report are written under, the latest
 * of each, the answers that let a PBI proceed, and the marks the stage Tasks leave.
 */
import type { ProceedingQuestion } from "@switchboard/protocol";
import { readdirSync } from "node:fs";
import { proceedLine, proceedRefusal, type AskPlace } from "../../../ops-kit/src/reversibility.ts";
import type { BacklogIssueData, BacklogItem } from "@switchboard/protocol";
import type { BacklogWorkspace } from "./backlog-gh.ts";

export const DECISION_HEADING = "## 判断待ち";
export const ANSWER_HEADING = "## 回答";
/** A question put on hold: not an answer — the label stays, nothing resumes, and the question is still the person's. */
export const HOLD_HEADING = "## 保留";
export const REPORT_HEADING = "## 状況";

export type Comment = { body: string; createdAt: string };
export type SubTask = { number: number; state: string; labels: { nodes: Array<{ name: string }> }; comments: { nodes: Comment[] } };
/** The newest comment that starts with `heading`; null when there is none. */
function latestHeading(comments: Comment[], heading: string): { body: string; at: string } | null {
  const c = comments.filter((x) => x.body.trimStart().startsWith(heading)).at(-1);
  return c ? { body: c.body, at: c.createdAt } : null;
}

/** The open question of a needs-decision item. */
export const latestDecision = (comments: Comment[]) => latestHeading(comments, DECISION_HEADING);

/** How long an answered / resolved question stays on the list after its state changed. */
export const ASK_HISTORY_MS = 24 * 60 * 60 * 1000;

/**
 * The first line of the `## 回答` to a question the work went on from with its recommendation (`**進め方**: 推奨で進める`):
 * `**確定**: 推奨のまま <A>[（まとめて）]` leaves the work as it is, `**覆す**: 推奨 <A> → <B>` (`→ 自由文` for words of the
 * person's own) has it done again by that answer. Both end with ` — 問い <the question's time>`: an Issue may carry several
 * such questions, and the answer says which one it is to. The interventions count the overturned ones by the line's start.
 */
export const PROCEED_CONFIRMED = "**確定**: 推奨のまま";
export const PROCEED_OVERTURNED = "**覆す**: 推奨";
const PROCEED_NAMED = / — 問い (\S+)\s*$/m;
/** The time of the question a `## 回答` names with its mark (`— 問い <time>`); null = it names none. The one place the mark is read. */
export const namedQuestion = (body: string): string | null => PROCEED_NAMED.exec(body)?.[1] ?? null;
/**
 * Whether a mark that names the time `named` is to the question asked at `t` (ms), the next `## 判断待ち` of its Issue
 * asked at `next` (ms; Infinity = none): the named time is at or after the question — from the start of its second, as
 * GitHub gives a time to the second — and before the next question. The one rule of which question a mark names.
 */
const namesQuestion = (named: string, t: number, next: number): boolean => Date.parse(named) >= Math.floor(t / 1000) * 1000 && Date.parse(named) < next;
/**
 * The questions of one Issue that a `## 回答` with `body` closes, for the counts of how long the person was waited for
 * (interventions.ts, flow.ts): `asked` = when each `## 判断待ち` of the Issue before the answer was asked (ms, oldest
 * first). An answer that names a question closes that one only (`namesQuestion`, the rule `proceedingAnswer` reads the
 * mark with); one that names none closes every question before it. Returns when the closed ones were asked.
 */
export function questionsAnswered(body: string, asked: readonly number[]): number[] {
  const named = namedQuestion(body);
  return named === null ? [...asked] : asked.filter((t, i) => namesQuestion(named, t, asked[i + 1] ?? Infinity));
}
/** A first line of a `## 回答` with the mark of the question it is to (asked at `at`): the one place the mark is written, as `PROCEED_NAMED` reads it. */
const namedLine = (said: string, at: string): string => `${said} — 問い ${at}`;
export const proceedAnswerLine = (q: { at: string; recommended: string }, said: { same: true; batch?: boolean } | { same: false; choice: string | null }): string =>
  namedLine(said.same ? `${PROCEED_CONFIRMED} ${q.recommended}${said.batch ? "（まとめて）" : ""}` : `${PROCEED_OVERTURNED} ${q.recommended} → ${said.choice ?? "自由文"}`, q.at);
/**
 * The first line of the `## 回答` the app writes to such a question that stopped and asked instead (its kind could not
 * go on): nothing was confirmed or overturned, so the line only names the question (asked at `at`). Without it the
 * answer reads as one to the newest question before it (`proceedingAnswer`), so with two such questions on an Issue an
 * answer to the older one would count for the newer, and the older would stay open.
 */
export const stoppedAnswerLine = (at: string): string => namedLine("**止めて聞く問いへの回答**", at);
/** A `## 回答` that only confirms a recommendation: nothing goes on from it, so it is not the answer a stage waits for. */
export const isConfirmation = (body: string) => body.split("\n").some((l) => l.trim().startsWith(PROCEED_CONFIRMED));
/** The newest `## 回答` that asks for work: one that only confirms a recommendation (`PROCEED_CONFIRMED`) is passed over. */
export const latestAnswer = (comments: Comment[]) => latestHeading(comments.filter((c) => !isConfirmation(c.body)), ANSWER_HEADING);

/**
 * The `## 回答` to the proceeding question asked at `q.at` among its Issue's comments (oldest first): the first one after
 * it that names it (`— 問い <time>`, a time at or after it and before the next `## 判断待ち`), or that names none while no later `## 判断待ち` has been asked (an answer written by
 * hand answers the newest question before it). null = not answered.
 */
export function proceedingAnswer(comments: Comment[], q: { at: string }): { at: string; body: string } | null {
  const t = Date.parse(q.at);
  // the question a time names is the newest one written at or before it: an answer made before comments kept their
  // written time names the time the service received the question, which is a send delay after it was written. A next
  // question written within that delay takes such an old answer instead (docs/design/asks.md)
  // GitHub gives its time to the second, so a question sent at once is named by the start of the second it was written in (`namesQuestion`)
  const next = Math.min(...comments.filter((c) => Date.parse(c.createdAt) > t && c.body.trimStart().startsWith(DECISION_HEADING)).map((c) => Date.parse(c.createdAt)));
  let newest = true;
  for (const c of comments) {
    if (Date.parse(c.createdAt) <= t) continue;
    const head = c.body.trimStart();
    if (head.startsWith(DECISION_HEADING)) newest = false;
    else if (head.startsWith(ANSWER_HEADING)) {
      const named = namedQuestion(c.body);
      // GitHub writes `…:00Z`, a comment kept here `…:00.000Z`: compared as times, not as text
      if (named ? namesQuestion(named, t, next) : newest) return { at: c.createdAt, body: c.body };
    }
  }
  return null;
}

/** The names at the top of a checkout, as the paths in an Issue's body are read against; empty when it cannot be read. */
export function checkoutTop(root: string): { name: string; dir: boolean }[] {
  try {
    return readdirSync(root, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
}

/** Whether the work may go on from a question asked on `issue` with its recommendation: the reason it may not, or null. */
export type ProceedCheck = (body: string, issue: BacklogIssueData) => string | null;

/**
 * Where a question asked on `issue` stands (`AskPlace`): the Issue, its PBI (itself, or its parent) with that PBI's
 * Tasks, and the top of the checkout. A PBI not among `issues` is not known (null): the kind `task-order` is refused then.
 */
export function askPlaceOf(issue: BacklogIssueData, issues: ReadonlyMap<number, BacklogIssueData>, top: { name: string; dir: boolean }[]): AskPlace {
  const pbi = issue.labels.includes("type:pbi") ? issue : issue.parent !== null ? issues.get(issue.parent) : undefined;
  return { issue: { number: issue.number, body: issue.body ?? "", labels: issue.labels }, pbi: pbi?.labels.includes("type:pbi") ? { number: pbi.number, tasks: pbi.subIssues } : null, top };
}

/** The check of a stored backlog: the table, the stop words and the question's place among `issues` (`top` is read once, when first needed). */
export function proceedCheckOf(issues: ReadonlyMap<number, BacklogIssueData>, top: () => { name: string; dir: boolean }[]): ProceedCheck {
  let names: { name: string; dir: boolean }[] | undefined;
  return (body, issue) => proceedRefusal(body, undefined, askPlaceOf(issue, issues, (names ??= top())));
}

/** With no place known, nothing that says 推奨で進める goes on (the kind cannot be checked). */
const noPlace: ProceedCheck = (body) => proceedRefusal(body);

/**
 * The newest `## 判断待ち` of an Issue when it says 推奨で進める, the reversibility table does not let it go on
 * (`proceedRefusal`) and no `## 回答` came to it: the Issue waits for the person exactly as one labelled
 * `needs-decision` does (it is not picked, its question is asked as a waiting decision), although its writer put no label.
 * null = there is no such question.
 */
export function refusedProceeding(comments: Comment[], issue: BacklogIssueData, refuses: ProceedCheck = noPlace): { at: string; why: string } | null {
  const d = latestDecision(comments);
  if (!d || proceedLine(d.body)?.said !== "recommended") return null;
  const why = refuses(d.body, issue);
  return why !== null && proceedingAnswer(comments, { at: d.at }) === null ? { at: d.at, why } : null;
}

/**
 * The questions whose 進め方 line says 推奨で進める, on any stored Issue, closed ones too. Whether the work may really go
 * on from one is not its writer's to say: the reversibility table decides (`proceedRefusal` — the kind named on the line,
 * listed as compensable, the question's place agreeing with that kind, no stop word). One the table refuses carries the reason (`stopped`) and is asked of the person
 * as a question that waits, label or not; nothing in the comment's text can turn that off. Its PBI is the Issue itself or its parent. Not listed: the newest question of an open Issue labelled
 * `needs-decision` (the label says the work waits: it is asked as a waiting decision), and one answered, or whose PBI
 * closed, more than ASK_HISTORY_MS ago.
 */
export function proceedingOf(ws: Pick<BacklogWorkspace, "id" | "name">, issues: ReadonlyMap<number, BacklogIssueData>, commentsOf: (n: number) => Comment[], now: number, refuses: ProceedCheck = noPlace): ProceedingQuestion[] {
  const out: ProceedingQuestion[] = [];
  const old = (at: string | null) => at !== null && now - Date.parse(at) > ASK_HISTORY_MS;
  for (const i of issues.values()) {
    const nodes = commentsOf(i.number);
    const asked = nodes.filter((c) => c.body.trimStart().startsWith(DECISION_HEADING) && proceedLine(c.body)?.said === "recommended");
    if (!asked.length) continue;
    // the newest question of an open Issue that waits (labelled, or refused by the table) is the item's waiting decision, not listed here
    const waiting = i.state === "OPEN" && (i.labels.includes("needs-decision") || refusedProceeding(nodes, i, refuses)) ? latestDecision(nodes)?.at : undefined;
    const parent = i.labels.includes("type:pbi") || i.parent === null ? undefined : issues.get(i.parent);
    const pbi = parent ?? i;
    const closedAt = pbi.state === "CLOSED" ? (pbi.closedAt ?? pbi.updatedAt) : null;
    if (old(closedAt)) continue;
    for (const c of asked) {
      if (c.createdAt === waiting) continue;
      const answer = proceedingAnswer(nodes, { at: c.createdAt });
      if (old(answer?.at ?? null)) continue;
      out.push({ workspaceId: ws.id, workspaceName: ws.name, issue: { number: i.number, url: i.url }, pbi: { number: pbi.number, title: pbi.title, url: pbi.url, open: pbi.state === "OPEN" }, body: c.body, at: c.createdAt, answer, closedAt, stopped: refuses(c.body, i) });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * When the question `d` was put on hold: the newest `## 保留` after it; a ## 判断待ち asked after the hold reopens it.
 * A labelled Issue without its ## 判断待ち (null) is held by any `## 保留` on it.
 */
export function heldSince(comments: Comment[], d: { at: string } | null): string | null {
  const h = latestHeading(comments, HOLD_HEADING);
  // GitHub writes `…:00Z`, a comment kept here `…:00.000Z`: compared as times, not as text
  return h && (!d || Date.parse(h.at) > Date.parse(d.at)) ? h.at : null;
}

/**
 * The question an in-progress PBI waits on in one of its open Tasks: the newest ## 判断待ち among the Tasks labelled
 * needs-decision; a labelled Task without one still holds the PBI (the label is the record) and says so. null = none waits.
 */
export function taskDecision(tasks: SubTask[], fallbackAt: string): NonNullable<BacklogItem["decision"]> | null {
  const waiting = tasks.filter((t) => t.state === "OPEN" && t.labels.nodes.some((l) => l.name === "needs-decision"));
  if (!waiting.length) return null;
  const asked = waiting.map((t) => ({ t, d: latestDecision(t.comments.nodes) })).filter((x) => x.d).sort((a, b) => a.d!.at.localeCompare(b.d!.at)).at(-1);
  if (asked) return { ...asked.d!, issue: asked.t.number };
  const t = waiting[0]!;
  return { body: `${DECISION_HEADING}\n（Task #${t.number} に「${DECISION_HEADING}」のコメントがありません。Issue を開いて確かめてください）`, at: fallbackAt, issue: t.number };
}

/** A /pbi-complete occupancy mark (scripts/parallel-guard.ts); a release may name what the PBI waits for (`waits=603,778`). */
export const PBI_COMPLETE_MARK = /<!-- pbi-complete:(claim|takeover|release)(?: (\S+))?(?: (after=\S+))? -->/;

/** The last status report of an in-progress item. */
export const latestReport = (comments: Comment[]) => latestHeading(comments, REPORT_HEADING);
