/**
 * The waits: what a PBI waits for before it can go on — the prerequisites its body names, the Issues and pull requests
 * a stage Task said it waits for, the confirmations after a merge — each read against the stored state of its target,
 * and the question asked when a prerequisite was withdrawn.
 */
import type { BacklogCommentData, BacklogIssueData, BacklogItem, BacklogPrereq, BacklogSource } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { pbiProgress } from "./pbi-progress.ts";
import { afterTime } from "../../../scripts/parallel-guard.ts";
import { confirmDecisionsOf, pbiFactsOf, prereqsOf } from "./backlog-item.ts";
import { ANSWER_HEADING, type Comment, PBI_COMPLETE_MARK } from "./backlog-comments.ts";
import { BacklogEditError, askStoredDecision } from "./backlog-edit.ts";
import { shownRecords } from "./backlog-stored.ts";

/** What a PBI waits for, as `waitsOf` reads it from a release mark: `after` = the `after=` time as written, when it is a time with a zone. */
export type PbiWait = { numbers: number[]; at: string; overlap: boolean; after: string | null };

/**
 * What a PBI waits for and when that was written: the numbers of its newest /pbi-complete mark when that is a
 * release with `waits=`, and its `after=` date (a release with only a date waits too), and no ## 回答 came after
 * it. A later release without either or a later claim clears it, so nothing else has to. null = it waits for nothing.
 */
export function waitsOf(comments: Comment[]): PbiWait | null {
  let at = comments.length - 1;
  while (at >= 0 && !PBI_COMPLETE_MARK.test(comments[at]!.body)) at--;
  const m = at >= 0 ? PBI_COMPLETE_MARK.exec(comments[at]!.body) : null;
  if (m?.[1] !== "release" || comments.slice(at + 1).some((c) => c.body.trimStart().startsWith(ANSWER_HEADING))) return null;
  const tokens = [m[2], m[3]].filter((t): t is string => !!t);
  const first = tokens.find((t) => !t.startsWith("after="));
  const list = first && /^(?:waits|overlap)=(\d+(?:,\d+)*)$/.exec(first)?.[1];
  const date = tokens.find((t) => t.startsWith("after="))?.slice("after=".length);
  const after = date && !Number.isNaN(afterTime(date)) ? date : null;
  if (!list && !after) return null;
  return { numbers: list ? [...new Set(list.split(",").map(Number))] : [], at: comments[at]!.createdAt, overlap: !!first?.startsWith("overlap="), after };
}

/**
 * What an Issue or PR a PBI waits for is now: its type, state (OPEN / CLOSED / MERGED), Draft, labels and, for
 * a PR, the Issues it closes (`[]` for an Issue).
 */
export interface WaitTarget {
  kind: "issue" | "pr";
  state: string;
  isDraft: boolean;
  labels: string[];
  closes: number[];
  /** An Issue's; null for a PR, or not read. */
  stateReason: string | null;
  /** A merged PR's merge commit; null otherwise. */
  mergeCommit: string | null;
  /** An open Issue left with only the user's checks and after-merge lines (`prereqMet` of pbi-progress.ts); false for a PR. */
  confirmOnly: boolean;
}

/** What a stored Issue is counted from (the app's record and the kit's read of it both fit). */
export type StoredIssue = { state: string; stateReason: string | null; labels: string[]; body: string; subIssues: number[] };

/**
 * The children of an Issue that are closed as the last import read them: stored as `CLOSED` and read in full. A child
 * not stored or not read counts as open, never as closed (a value that could not be read is not an empty one).
 */
export function readClosedTasks(subIssues: number[], issues: Map<number, Pick<StoredIssue, "state">>, unread: (n: number) => boolean): number[] {
  return subIssues.filter((m) => issues.get(m)?.state === "CLOSED" && !unread(m));
}

/**
 * What an Issue a PBI waits for is, from the stored records, for the app and the parallel guard alike. undefined = not
 * stored or not read in full by the last import (`unread`): not judged, so a prerequisite on it stays `missing`.
 * `confirmOnly` counts the Tasks closed by `readClosedTasks`, and the children kept here that GitHub's list of its sub-issues
 * does not hold yet (`waiting`, as the backlog's rows count them).
 */
export function storedIssueTarget(n: number, issues: Map<number, StoredIssue>, unread: (n: number) => boolean, waiting: (n: number) => Array<{ state: string }> = () => []): WaitTarget | undefined {
  const i = issues.get(n);
  if (!i || unread(n)) return undefined;
  const w = waiting(n);
  const done = readClosedTasks(i.subIssues, issues, unread).length + w.filter((c) => c.state === "CLOSED").length;
  const confirmOnly = pbiProgress(pbiFactsOf({ labels: i.labels, body: i.body, status: null, tasks: { total: i.subIssues.length + w.length, done } })).prereqMet;
  return { kind: "issue", state: i.state, isDraft: false, labels: i.labels, closes: [], stateReason: i.stateReason, mergeCommit: null, confirmOnly };
}

/**
 * How one prerequisite stands from what is stored of it (`t`; undefined = not stored): an Issue is met when closed
 * as completed (or closed with no reason read), withdrawn when closed as not planned / a duplicate; a PR is met when
 * merged, withdrawn when closed unmerged. `release` needs the merge commit in the running release too (`released`; null
 * = cannot tell); an Issue cannot be released, so that is not judged. Open is pending, a Draft too.
 */
export function prereqState(t: WaitTarget | undefined, need: BacklogPrereq["need"], released: (oid: string) => boolean | null): BacklogPrereq["state"] {
  if (!t) return "missing";
  if (t.state === "OPEN") return "pending";
  if (t.kind === "issue") return t.stateReason === "NOT_PLANNED" || t.stateReason === "DUPLICATE" ? "withdrawn" : need === "release" ? "unknown" : "met";
  if (t.state !== "MERGED") return "withdrawn";
  if (need !== "release") return "met";
  const r = t.mergeCommit ? released(t.mergeCommit) : null;
  return r === null ? "unknown" : r ? "met" : "pending";
}

/**
 * A prerequisite as the app and the parallel guard both count it: `prereqState`, and an open PBI left with only the
 * user's checks (`t.confirmOnly`) is met, told apart by `confirming`. A wait (`waits`) keeps `prereqState`: it waits
 * until the other side closes.
 */
export function prereqOf(t: WaitTarget | undefined, need: BacklogPrereq["need"], released: (oid: string) => boolean | null): { state: BacklogPrereq["state"]; confirming: boolean } {
  const read = prereqState(t, need, released);
  const confirming = read === "pending" && t?.kind === "issue" && t.confirmOnly;
  return { state: confirming ? "met" : read, confirming };
}

/** A wait's `open` as the Backlog screen reads it: false = met, true = pending, null = anything else. */
const openOf = (state: BacklogPrereq["state"]) => (state === "met" ? false : state === "pending" ? true : null);

/**
 * The PBI that moves a wait forward, from the stored Issues: an Issue that is a PBI is its own, else its
 * parent; a PR's is the first one the Issues it closes give. null = none found (不明).
 */
function pbiOf(n: number, t: WaitTarget, issues: Map<number, BacklogIssueData>): BacklogItem["waits"][number]["pbi"] {
  const ofIssue = (m: number) => {
    const issue = issues.get(m);
    if (issue?.labels.includes("type:pbi")) return { number: m, title: issue.title };
    if (issue?.parent) return { number: issue.parent, title: issues.get(issue.parent)?.title ?? null };
    return null;
  };
  if (t.kind === "issue") return ofIssue(n);
  for (const m of t.closes) {
    const pbi = ofIssue(m);
    if (pbi) return pbi;
  }
  return null;
}

/**
 * Gives each waiting item its waits with their states, why it waits and the PBI that moves each forward
 * (`pbiOf`). A number with no known state stays, with `open: null`: not taken as closed. `worked` tells whether a session
 * works on a PBI: an overlap wait on an open Task whose PBI none works on is met.
 */
export function withWaits(waiting: Map<BacklogItem, PbiWait>, targets: Map<number, WaitTarget>, issues: Map<number, BacklogIssueData>, now: number, worked: (pbi: number) => boolean = () => true): void {
  for (const [i, w] of waiting) {
    const reason = w.overlap ? ("overlap" as const) : ("prerequisite" as const);
    i.waits = w.numbers.flatMap((n): BacklogItem["waits"] => {
      const t = targets.get(n);
      if (!t) return [{ number: n, kind: "issue", open: null, state: "missing", reason, pbi: null }];
      const decision = t.labels.includes("needs-decision");
      // These PRs are deliberately parked, not prerequisites that must be completed first.
      if (t.kind === "pr" && (t.isDraft || decision)) return [];
      if (w.overlap && t.kind === "issue" && decision) return [];
      // an overlap is over once the other side closes, or once it is a Task whose PBI no session works on (nothing of it
      // changes while none does); a prerequisite only once it is done
      const idle = t.kind === "issue" && t.state === "OPEN" && ((p) => p !== null && !worked(p))(issues.get(n)?.parent ?? null);
      const state = w.overlap ? (t.state === "OPEN" && !idle ? "pending" : "met") : prereqState(t, t.kind === "pr" ? "merged" : "done", () => null);
      return [{ number: n, kind: t.kind, open: openOf(state), state, reason, pbi: pbiOf(n, t, issues) }];
    });
    i.waitsAt = w.at;
    if (w.after) i.waitsUntil = { at: w.after, met: afterTime(w.after) <= now };
  }
}

/**
 * Takes the confirmation lines that name decisions (`confirmDecisionsOf`) out of `confirmations` once every named number
 * is stored: the decisions' own cards ask, not the user's check. One still labelled `needs-decision` keeps the PBI
 * from being `closable`. A number not stored leaves its line as is. The answers are `pbiProgress`'s again, over the
 * item as it stands now (a Task's open question holds its PBI too).
 */
export function withConfirmDecisions(items: BacklogItem[], targets: Map<number, WaitTarget>): void {
  for (const i of items) {
    if (i.type !== "pbi") continue;
    let held = false;
    const decided = i.confirmations.filter((c) => {
      const ns = confirmDecisionsOf(c.text);
      if (ns.length === 0 || !ns.every((n) => targets.has(n))) return false;
      if (ns.some((n) => targets.get(n)!.labels.includes("needs-decision"))) held = true;
      return true;
    }).map((c) => c.n);
    // `others` is not carried by an item and only `prereqMet` and `checking` read it, which are not taken here: `checking` is
    // the item's own (toItem, from the body) and is kept as it is
    const p = pbiProgress({ pbi: true, decision: i.stage === "needs-decision", status: i.projectStatus, tasks: i.tasks ?? { total: 0, done: 0 }, others: 0, confirms: i.confirmations.map((c) => c.n), postMerge: i.postMerge.map((c) => c.n), decided, held });
    i.confirmations = i.confirmations.filter((c) => p.asked.includes(c.n));
    i.closable = p.closable;
    i.progress = { closableByApi: p.closableByApi, closesOnAnswer: p.closesOnAnswer, checking: i.progress.checking };
  }
}

/**
 * Gives each Ready / in-progress PBI its prerequisites with their states: those its body names, and
 * those its open Tasks name, other than the PBI's own open Tasks (their order is the PBI's own business), when every
 * open Task has one not met. A number is listed once, with the Tasks that name it (`via`; `mergePrereqs`). One that is still pending and leads back to the PBI (or to the Task naming it) along the
 * open Issues' prerequisites — a PBI leading on to its open Tasks' — is a `cycle`. Answers each PBI's open Tasks that can
 * start now: every prerequisite in another PBI or PR met, and none naming one of the PBI's own open Tasks.
 */
export function withPrereqs(items: BacklogItem[], issues: Map<number, BacklogIssueData>, targets: Map<number, WaitTarget>, released: (oid: string) => boolean | null): Map<number, number[]> {
  const named = (n: number) => {
    const i = issues.get(n);
    return i?.state === "OPEN" ? prereqsOf(i.body) : [];
  };
  const openTasks = (n: number) => (issues.get(n)?.subIssues ?? []).filter((m) => issues.get(m)?.state === "OPEN");
  // only open Issues lead on: a closed PBI's Tasks left open do not hold anything
  const next = (n: number) => (issues.get(n)?.state === "OPEN" ? [n, ...openTasks(n)] : []).flatMap((m) => named(m).map((p) => p.number));
  const leadsTo = (from: number, to: number[]) => {
    const seen = new Set<number>();
    for (const queue = [from]; queue.length; ) {
      const n = queue.shift()!;
      if (to.includes(n)) return true;
      if (!seen.has(n)) (seen.add(n), queue.push(...next(n)));
    }
    return false;
  };
  const startable = new Map<number, number[]>();
  for (const i of items) {
    if (i.type !== "pbi" || (i.stage !== "ready" && i.stage !== "in-progress")) continue;
    const judge = (p: { number: number; release: boolean }, via: number | null): BacklogPrereq => {
      const t = targets.get(p.number);
      const need = p.release ? "release" : t?.kind === "pr" ? "merged" : "done";
      const { state, confirming } = prereqOf(t, need, released);
      const cycle = state === "pending" && t?.kind === "issue" && leadsTo(p.number, via === null ? [i.number] : [i.number, via]);
      return { number: p.number, kind: t?.kind ?? null, need, state: cycle ? "cycle" : state, via: via === null ? [] : [via], confirming };
    };
    const tasks = openTasks(i.number);
    const ofTasks = tasks.map((t) => named(t).filter((p) => !tasks.includes(p.number)).map((p) => judge(p, t)));
    const blocked = tasks.length > 0 && ofTasks.every((ps) => ps.some((p) => p.state !== "met"));
    i.prereqs = mergePrereqs([...named(i.number).map((p) => judge(p, null)), ...(blocked ? ofTasks.flat() : [])]);
    startable.set(i.number, tasks.filter((t, n) => ofTasks[n]!.every((p) => p.state === "met") && !named(t).some((p) => tasks.includes(p.number))));
  }
  return startable;
}

/**
 * One entry per number, in the order first named, with every Task that names it (`via`, ascending). The same number is the
 * same Issue or PR, so its state is one — except what the naming side changes: a cycle (which side leads back) and
 * `（リリース）` (one names it, another does not). The entry kept is the one that holds the PBI most: a cycle, else one not met.
 */
export function mergePrereqs(list: BacklogPrereq[]): BacklogPrereq[] {
  const out = new Map<number, BacklogPrereq>();
  const weight = (p: BacklogPrereq) => (p.state === "cycle" ? 2 : p.state !== "met" ? 1 : 0);
  for (const p of list) {
    const had = out.get(p.number);
    const kept = !had || weight(p) > weight(had) ? p : had;
    out.set(p.number, { ...kept, via: [...new Set([...(had?.via ?? []), ...p.via])].sort((a, b) => a - b) });
  }
  return [...out.values()];
}

const withdrawnMarker = (n: number) => `<!-- prereq-withdrawn:${n} -->`;

/**
 * Asks about the Ready / in-progress PBIs held by a withdrawn prerequisite (an Issue closed as not planned / a duplicate,
 * a PR closed unmerged): nothing meets it any more, so without a question the PBI stays in the queue until someone
 * happens to fix the line. One `## 判断待ち` per PBI (then the `needs-decision` label, `askStoredDecision`), naming every
 * withdrawn number not asked about yet; a number is asked about once per PBI, told by a mark in the stored comments, so
 * an answer that leaves the line as it is is not asked again. The prerequisite is not taken off here: whether the
 * reason it was written still stands is the person's call. An on-hold PBI is left. Returns the PBIs written to.
 */
export function askWithdrawnPrereqs(db: Db, source: BacklogSource, items: BacklogItem[], now = Date.now()): number[] {
  const held = items.filter((i) => i.type === "pbi" && (i.stage === "ready" || i.stage === "in-progress") && !i.onHold && i.prereqs.some((p) => p.state === "withdrawn"));
  if (!held.length) return [];
  const comments = shownRecords(db, source).flatMap((r) => (r.objectKind === "comment" && r.remote ? [r.remote as BacklogCommentData] : []));
  const out: number[] = [];
  for (const i of held) {
    const said = comments.filter((c) => c.issue === i.number).map((c) => c.body).join("\n");
    const fresh = i.prereqs.filter((p) => p.state === "withdrawn" && !said.includes(withdrawnMarker(p.number)));
    if (!fresh.length) continue;
    const ref = (p: BacklogPrereq) => `${p.kind === "pr" ? "PR " : ""}#${p.number}`;
    const named = fresh.map((p) => `${ref(p)}${p.via.length ? `（Task ${p.via.map((t) => `#${t}`).join("・")} の前提）` : ""}`).join("、");
    const refs = fresh.map(ref).join("、");
    try {
      askStoredDecision(db, source, i.number, [
        `**問い**: 前提 ${named} は取り下げられた（Issue を「やらない」か重複で閉じた、または PR をマージせずに閉じた）。前提の行から ${refs} を外して進めるか、この PBI をやらないか`,
        "**選択肢**:",
        `- A: 前提の行から ${refs} を外して進める — 影響: 外したあとの発火から、この PBI が始まる`,
        "- B: この PBI をやらない（閉じる）— 影響: この PBI と開いている Task を「やらない」で閉じる",
        "**推奨**: A — 取り下げた前提は待っても満たされない。外す前に、前提を書いた理由が残っていないかを見る",
        "**進め方**: 止めて待つ — 前提を書いた理由が残っているかは人の判断",
        "**止めた場所**: バックログを進める（定期実行・キュー）",
        "",
        ...fresh.map((p) => withdrawnMarker(p.number)),
      ].join("\n"), now);
      out.push(i.number);
    } catch (e) {
      // an Issue not read from GitHub now, or a body the guard refuses: left as it is, said on the 進められない line as before
      if (!(e instanceof BacklogEditError)) throw e;
    }
  }
  return out;
}
