/**
 * The stored reads: a workspace's backlog as the screens and the scheduler read it, from the copy the DB keeps
 * (backlog-sync.ts) with the edits made here on top — the whole backlog (`readStoredBacklog`), one Issue, the records
 * the kit's tools read, and how each stands against GitHub (`syncOf`).
 */
import type { ProceedingQuestion } from "@switchboard/protocol";
import type { Backlog, BacklogFetchState, BacklogHeldEdit, BacklogIssueData, BacklogIssueDetail, BacklogItem, BacklogProjectItemData, BacklogPullRequestData, BacklogRecord, BacklogSource, BacklogSyncInfo, BacklogSyncState } from "@switchboard/protocol";
import type { BacklogOperation, Db } from "./db.ts";
import { conflictRevision, withoutMarker } from "./backlog-merge.ts";
import { CONFIG_FILE, sharedFilesOf } from "../../../ops-kit/src/config.ts";
import { workspaceConfigPath } from "./workspace-config.ts";
import type { Turn } from "../../../scripts/parallel-guard.ts";
import { readdirSync } from "node:fs";
import type { StoredRecords } from "../../../ops-kit/src/backlog-client.ts";
import { type BacklogWorkspace, localBacklogSource, syncsGithub, changesApart } from "./backlog-gh.ts";
import { type RawBacklogIssue, FLOW_LABEL, toItem, derivedPbisOf } from "./backlog-item.ts";
import { holder } from "../../../scripts/parallel-guard.ts";
import { sessionOn, withOverlap } from "./backlog-overlap.ts";
import { notResumed } from "./backlog-pick.ts";
import { reduceStops } from "./stops.ts";
import { type Comment, type SubTask, latestDecision, latestAnswer, proceedingOf, proceedCheckOf, checkoutTop, refusedProceeding, heldSince, taskDecision, latestReport } from "./backlog-comments.ts";
import { type PbiWait, waitsOf, type WaitTarget, storedIssueTarget, readClosedTasks, withWaits, withConfirmDecisions, withPrereqs } from "./backlog-waits.ts";
import { eventsOf } from "./stage-start-gate.ts";
import type { BacklogCreatePayload } from "./backlog-edit.ts";

/**
 * What a stored record shows: an edit not sent yet over what GitHub answered, or one made here that GitHub does not have
 * yet. A record GitHub has that its last read did not get in full (404 / 403) shows nothing, edits or not.
 */
export const shown = (r: BacklogRecord) => (r.fetchState === "fetched" || !r.remote ? (r.local ?? r.remote) : null);

/** The workspace's Project item of Issue n, as shown. */
export const projectItemOf = (records: BacklogRecord[], source: BacklogSource, n: number) =>
  records.find((r) => {
    const v = r.objectKind === "project-item" ? (shown(r) as BacklogProjectItemData | null) : null;
    return !!v && v.issue === n && v.owner.toLowerCase() === source.project.owner.toLowerCase() && v.project === source.project.number;
  });

/** The Issue record of `ref`: a number, or the local id of an Issue made here (its create operation's id). */
/** The Issues' record ids by number, as issueRecord finds them: one GitHub no longer shows by the value kept here. */
const issueIds = (records: Iterable<BacklogRecord>) =>
  new Map([...records].flatMap((r) => {
    const n = ((r.local ?? r.remote) as BacklogIssueData | null)?.number;
    return n ? [[n, r.externalId] as const] : [];
  }));

/** A PBI's own record and its Tasks': an edit kept for one of them is the PBI's too (its stage and completion come from the Tasks). */
const familyOf = (own: string | undefined, subIssues: number[], ids: Map<number, string>) => new Set([own, ...subIssues.map((n) => ids.get(n))].filter((x): x is string => !!x));

/** Issue `n`'s record among the Issue records: one made here (sb:) with the number of one of GitHub's yields to GitHub's. */
const issueRecordOf = (issues: BacklogRecord[], n: number): BacklogRecord | undefined =>
  issues.filter((r) => ((r.local ?? r.remote) as BacklogIssueData | null)?.number === n).sort((a, b) => Number(a.externalId.startsWith("sb:")) - Number(b.externalId.startsWith("sb:")))[0];

export function issueRecord(db: Db, source: BacklogSource, ref: number | string): BacklogRecord | null {
  // while the sync is being turned on an Issue made here may still have the number of one of GitHub's: #N is GitHub's
  if (typeof ref === "number") return (ref > 0 && issueRecordOf(db.listBacklogRecords(source, "issue"), ref)) || null;
  const op = db.getBacklogOperation(ref);
  if (!op || op.kind !== "create" || op.repository !== source.repository || op.host !== source.host) return null;
  return db.getBacklogRecord({ ...source, objectKind: "issue", externalId: op.target });
}

/** What the check before a send, and the read with the history after it, keep and what they cannot (GitHub's values are read just before a send, and just after it with the edit history, so an edit made in between is caught where a history exists): told with every stored Issue. */
export const SYNC_LIMITS =
  "GitHub に送る編集は、送る直前に GitHub の値を確かめ、編集の元から変わっていれば止めて競合として残します。本文・題・状態・ラベル・Milestone・親・Project の Status は、書いた直後に GitHub の編集履歴も読み、確かめてから書くまでの間にほかの人が書いていれば、その値を添えて競合として残します（版の内容が履歴に残っていれば、上書きした値を選んで戻せます。消されていれば編集者と時刻だけが残ります）。Status 以外の Project フィールド（Priority・Story Points・Phase など）には履歴が無く、本文・コメントは 100 版を超えて押し出された版が残らないので、そこは確かめてから書くまでの間の編集を上書きしうる（気づけない）ことがあります。履歴を読めなかったときは、書いた編集を未確認の競合として残します。同じ GitHub アカウントで GitHub の画面から書いた編集は、ほかの人の編集と区別しません（利用者 1 人の運用を前提に、自分のログインの編集は相手と数えません）。GitHub Project の自動化が動かした Status は編集として数えず競合にしません（手元の値を送ります。Issue が閉じたことで動いた Status は GitHub の値のままにします）。";

/** The items whose comments are read: needs-decision, in-progress, and Ready PBIs (their waits). */
const askedOf = (items: BacklogItem[]) => items.filter((i) => i.stage === "needs-decision" || i.stage === "in-progress" || (i.stage === "ready" && i.type === "pbi"));
/** In-progress PBIs, whose Tasks are read too. */
const buildingOf = (asked: BacklogItem[]) => asked.filter((i) => i.stage === "in-progress" && i.type === "pbi").map((i) => i.number);

/**
 * Gives the asked items what their comments say, wherever the comments came from (GitHub, or what is stored):
 * needs-decision items their open question, in-progress ones their last status report, their Tasks' questions and their
 * newest answer. Returns the waits of Ready and in-progress PBIs, for `withWaits`.
 */
function withComments(asked: BacklogItem[], building: number[], commentsOf: (n: number) => Comment[], tasksOf: (n: number) => SubTask[]): Map<BacklogItem, PbiWait> {
  const waiting = new Map<BacklogItem, PbiWait>();
  for (const i of asked) {
    const nodes = commentsOf(i.number);
    if (i.stage === "needs-decision") {
      const d = latestDecision(nodes);
      i.decision = d && { ...d, issue: i.number };
      i.heldAt = heldSince(nodes, d);
      continue;
    }
    if (i.stage === "ready") {
      // its own ## 回答: what lets its last stage Task that waits for the person go (`awaitingReply`)
      i.answeredAt = latestAnswer(nodes)?.at ?? null;
      const w = waitsOf(nodes);
      if (w) waiting.set(i, w);
      continue;
    }
    if (!building.includes(i.number)) {
      i.report = latestReport(nodes);
      continue;
    }
    const tasks = tasksOf(i.number);
    i.answeredAt = [nodes, ...tasks.map((t) => t.comments.nodes)].map((c) => latestAnswer(c)?.at).filter((a): a is string => !!a).sort().at(-1) ?? null;
    const d = taskDecision(tasks, i.updatedAt);
    if (d) {
      // a Task's question holds its PBI: shown and answered where the PBI's own questions are
      i.stage = "needs-decision";
      i.decision = d;
      i.heldAt = heldSince(tasks.find((t) => t.number === d.issue)?.comments.nodes ?? [], d);
    } else {
      i.report = latestReport(nodes);
      const w = waitsOf(nodes);
      if (w) waiting.set(i, w);
    }
  }
  return waiting;
}

/**
 * Why the work may not go on from the `## 判断待ち` `body` asked on Issue `n` with its recommendation, read against the
 * workspace's stored Issues and its checkout (`proceedCheckOf`), and the PBI it holds (the Issue, or its parent).
 * null = it may go on, the body does not say 推奨で進める, or the Issue is not stored.
 */
export function storedProceedRefusal(db: Db, ws: Pick<BacklogWorkspace, "id" | "path">, n: number, body: string): { why: string; pbi: number } | null {
  const source = db.getWorkspaceBacklogSource(ws.id);
  if (!source) return null;
  const issues = new Map(shownRecords(db, source).flatMap((r) => (r.objectKind === "issue" && r.remote && r.remote.number > 0 ? [[r.remote.number, r.remote] as const] : [])));
  const issue = issues.get(n);
  const why = issue ? proceedCheckOf(issues, () => checkoutTop(ws.path))(body, issue) : null;
  return issue && why !== null ? { why, pbi: issue.labels.includes("type:pbi") || issue.parent === null ? issue.number : issue.parent } : null;
}

/**
 * The backlog of a workspace as stored by its last import, without asking GitHub: the same items, stages,
 * questions, reports, answers and waits as GitHub's own answer would give, from the records read in full (`fetched`). `fetchedAt` = when
 * the last complete import was stored. A workspace never imported answers `fetchedAt: null` and no items — never an
 * empty list as if read.
 */
export function readStoredBacklog(db: Db, ws: Pick<BacklogWorkspace, "id" | "name" | "path">, opts: { released?: (oid: string) => boolean | null; runningSince?: number | null; importFailed?: boolean; now?: number; active?: (pbi: number) => boolean; parked?: (pbi: number) => boolean } = {}): { fetchedAt: number | null; items: BacklogItem[]; changes: Backlog["changes"]; turns?: Turn[]; unheld?: number[]; proceeding?: ProceedingQuestion[] } {
  const source = db.getWorkspaceBacklogSource(ws.id);
  const fetchedAt = source ? db.getBacklogRepository(source)?.lastSuccessfulSync ?? null : null;
  if (!source || fetchedAt === null) return { fetchedAt: null, items: [], changes: [] };
  const records = shownRecords(db, source);
  const ops = db.listPendingBacklogOperations(source);
  const repoSync = db.getBacklogRepository(source);
  const now = opts.now ?? Date.now();
  const issues = new Map<number, BacklogIssueData>();
  const targets = new Map<number, WaitTarget>();
  const comments = new Map<number, Comment[]>();
  const fields = new Map<number, RawBacklogIssue["projectItems"]["nodes"]>();
  const pulls: Array<NonNullable<Extract<BacklogRecord, { objectKind: "pull-request" }>["remote"]>> = [];
  const statuses = new Map<number, string | number | null>();
  const storedIssues = new Map(db.listBacklogRecords(source, "issue").map((r) => [r.externalId, r]));
  const readOf = new Map<number, { externalId: string; fetchedAt: number | null; fetchState: BacklogFetchState }>();
  const ids = issueIds(storedIssues.values());
  for (const r of records) {
    // an Issue made here has no number until GitHub gives it one: read by its local id (readStoredIssue)
    if (r.objectKind === "issue" && r.remote?.number === 0) continue;
    if (r.objectKind === "issue" && r.remote) {
      issues.set(r.remote.number, r.remote);
      // as GitHub last answered, not as shown
      const stored = storedIssues.get(r.externalId);
      readOf.set(r.remote.number, { externalId: r.externalId, fetchedAt: stored?.fetchedAt ?? null, fetchState: stored?.fetchState ?? "unfetched" });
    } else if (r.objectKind === "pull-request" && r.remote) {
      targets.set(r.remote.number, { kind: "pr", state: r.remote.state, isDraft: r.remote.isDraft, labels: r.remote.labels, closes: r.remote.closes, mergeCommit: r.remote.mergeCommit, stateReason: null, confirmOnly: false });
      pulls.push(r.remote);
    }
    else if (r.objectKind === "comment" && r.remote) comments.set(r.remote.issue, [...(comments.get(r.remote.issue) ?? []), r.remote]);
    // the Project the workspace reads, by owner (GitHub ignores its case; the URL is written by hand) and number:
    // another owner's Project #n is another Project
    else if (r.objectKind === "project-item" && r.remote && r.remote.owner.toLowerCase() === source.project.owner.toLowerCase() && r.remote.project === source.project.number) {
      const values = Object.entries(r.remote.fields).map(([name, v]) => (typeof v === "number" ? { number: v, field: { name } } : { name: v ?? undefined, field: { name } }));
      fields.set(r.remote.issue, [{ project: { number: r.remote.project }, fieldValues: { nodes: values } }]);
      statuses.set(r.remote.issue, r.remote.fields.Status ?? null);
    }
  }
  const unread = (n: number) => readOf.get(n)?.fetchState !== "fetched";
  for (const n of issues.keys()) {
    const t = storedIssueTarget(n, issues, unread);
    if (t) targets.set(n, t);
  }
  for (const c of comments.values()) c.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const commentsOf = (n: number) => comments.get(n) ?? [];

  // a question that says 推奨で進める and that the reversibility table does not let go on holds its Issue as the label
  // `needs-decision` does, whether its writer put the label or not (`refusedProceeding`)
  // (the declared kind is checked against where the question stands: its Issue, the PBI's Tasks, the checkout's top level)
  const refuses = proceedCheckOf(issues, () => checkoutTop(ws.path));
  const labelsOf = (i: BacklogIssueData): string[] => (i.state === "OPEN" && !i.labels.includes("needs-decision") && refusedProceeding(commentsOf(i.number), i, refuses) ? [...i.labels, "needs-decision"] : i.labels);
  const items: BacklogItem[] = [];
  for (const i of issues.values()) {
    if (i.state !== "OPEN" || !i.labels.some((l) => l === "type:pbi" || l === "type:request")) continue;
    const closedSubs = readClosedTasks(i.subIssues, issues, unread);
    const raw: RawBacklogIssue = {
      number: i.number, title: i.title, url: i.url, createdAt: i.createdAt, updatedAt: i.updatedAt, body: i.body,
      labels: { nodes: labelsOf(i).map((name) => ({ name })) },
      subIssuesSummary: {
        total: i.subIssues.length, completed: closedSubs.length,
        doneAt: closedSubs.map((n) => issues.get(n)!.closedAt ?? issues.get(n)!.updatedAt).sort().at(-1) ?? null,
      },
      projectItems: { nodes: fields.get(i.number) ?? [] },
    };
    const item = toItem(raw, source.project.number, ws);
    if (!item) continue;
    // as times: GitHub's `…:00Z` and a written `…:00.500Z` do not sort as text
    item.commentedAt = commentsOf(i.number).reduce<string | null>((a, c) => (a === null || Date.parse(c.createdAt) > Date.parse(a) ? c.createdAt : a), null);
    const read = readOf.get(i.number);
    const family = familyOf(read?.externalId, i.subIssues, ids);
    item.sync = syncOf(db, ops.filter((o) => family.has(o.issue)), { lastSuccessfulSync: freshAt(repoSync?.lastSuccessfulSync ?? null, read), retryAt: repoSync?.retryAt ?? null, fetchState: read?.fetchState, importFailed: opts.importFailed, now });
    items.push(item);
  }
  // newest created first, as GitHub's list of Issues
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.number - b.number);
  const asked = askedOf(items);
  const tasksOf = (n: number): SubTask[] =>
    (issues.get(n)?.subIssues ?? []).flatMap((m) => {
      const t = issues.get(m);
      return t ? [{ number: m, state: t.state, labels: { nodes: labelsOf(t).map((name) => ({ name })) }, comments: { nodes: commentsOf(m) } }] : [];
    });
  // a claim left by a stage Task that ended is no session at work (`sessionOn`), unless the PBI's Task only waits for a planned resume
  const ended = (n: number, at: number) => !opts.parked?.(n) && db.endedStageRanAt(ws.id, n, at);
  withWaits(withComments(asked, buildingOf(asked), commentsOf, tasksOf), targets, issues, now, sessionOn({ active: opts.active, commentsOf, unread, ended }));
  withConfirmDecisions(items, targets);
  const startable = withPrereqs(items, issues, targets, opts.released ?? (() => null));
  for (const i of items) i.events = eventsOf({ item: i, issues, pulls, commentsOf, now, runningSince: opts.runningSince ?? null });
  const turns = withOverlap(items, issues, startable, pulls, statuses, ws.path, { active: opts.active, parked: opts.parked, commentsOf, unread, ended, notResumed: (i) => {
    // a PBI whose stage Tasks are not on record (`lastTask` null) keeps its place: nothing says the queue left it
    if (opts.active?.(i.number)) return false;
    const s = withStageTask(db, i);
    return s.lastTask !== null && notResumed({ ...s, activeTaskId: null });
  }, sharedFiles: sharedFilesOf(ws.path, workspaceConfigPath(ws, ws.path) ?? CONFIG_FILE) });
  // the PBIs with a claim the app does not count as work: the guard in a Task counts the same
  const worked = sessionOn({ active: opts.active, commentsOf, unread, ended });
  const unheld = [...issues.values()].filter((t) => t.state === "OPEN" && t.labels.includes("type:pbi")).map((t) => t.number).filter((n) => !worked(n) && holder(commentsOf(n).map((c, k) => ({ id: k, body: c.body }))) !== null);
  // a workspace whose Issues are a service's keeps its changes apart (changeSourceOf)
  const apart = changesApart(source);
  const changeIssues = apart ? shownRecords(db, localBacklogSource(ws.id)).flatMap((r) => (r.objectKind === "issue" && r.remote ? [r.remote as BacklogIssueData] : [])) : issues.values();
  return { fetchedAt, items, changes: changesOf(ws.id, changeIssues, apart), turns, unheld, proceeding: proceedingOf(ws, issues, commentsOf, now, refuses) };
}

/**
 * An item with its last stage Task (`lastTask`), the record of how its stage Tasks stopped (`stopSummary`), and its waits
 * dropped when an 実装 started after they were written: the part of server/backlog-read.ts `withActive` that reads only the
 * stage Tasks' rows, which `readStoredBacklog` needs before it judges the places (`notResumed`).
 */
export function withStageTask(db: Db, i: BacklogItem): BacklogItem {
  const t = db.lastStageTask(i.workspaceId, i.number);
  // an 実装 started after the waits were written makes them old: it claimed, or it ended before it could —
  // then it is not started again by itself. A 状況確認 only reads, so the newest 実装 is the one compared
  const impl = i.waitsAt ? db.lastStageTask(i.workspaceId, i.number, "complete") : null;
  const old = !!impl && impl.createdAt > Date.parse(i.waitsAt!);
  return {
    ...i,
    lastTask: t ? { id: t.id, status: t.status, statusAt: t.statusAt, createdAt: t.createdAt, updatedAt: t.updatedAt, action: t.stage?.action ?? null, outcome: t.outcome, reviewedAt: t.reviewedAt, resumeAt: t.resumeAt, started: t.runnerSessionId !== null } : null,
    stopSummary: reduceStops(db.listStopRecords(db.stageTaskIds(i.workspaceId, i.number)), { newestTaskId: t?.id ?? null }),
    ...(old ? { waits: [], waitsAt: null, waitsUntil: null } : {}),
  };
}

/**
 * Whether the stored Issue or PR `n` of the workspace has ended, and when: an Issue closed, a PR merged or closed
 * (they share one run of numbers). null = open, or not stored. The records are read when the first number is asked.
 */
export function storedEnds(db: Db, ws: Pick<BacklogWorkspace, "id">): (n: number) => { kind: "issue" | "pr"; state: "CLOSED" | "MERGED"; at: number | null } | null {
  let ends: Map<number, { kind: "issue" | "pr"; state: "CLOSED" | "MERGED"; at: number | null }> | null = null;
  const read = () => {
    const out = new Map<number, { kind: "issue" | "pr"; state: "CLOSED" | "MERGED"; at: number | null }>();
    const source = db.getWorkspaceBacklogSource(ws.id);
    const at = (s: string | null | undefined) => (s ? Date.parse(s) : null);
    for (const rec of source ? db.listBacklogRecords(source, "pull-request") : []) {
      const v = (shown(rec) ?? rec.remote) as BacklogPullRequestData | null;
      if (v && v.state !== "OPEN") out.set(v.number, { kind: "pr", state: v.state, at: at(v.mergedAt ?? v.closedAt ?? v.updatedAt) });
    }
    // an Issue last: a number is an Issue's when both are stored (a workspace kept only here numbers its own)
    for (const [n, h] of source ? storedIssueStates(db.listBacklogRecords(source, "issue")) : []) {
      if (h.state === "CLOSED") out.set(n, { kind: "issue", state: "CLOSED", at: at(h.closedAt ?? h.updatedAt) });
      else out.delete(n);
    }
    return out;
  };
  return (n) => (ends ??= read()).get(n) ?? null;
}

/** Each stored Issue as shown, by number: one made here (sb:) with the number of one of GitHub's yields to GitHub's (as issueRecord). */
function storedIssueStates(records: BacklogRecord[]): Map<number, BacklogIssueData> {
  const heads = new Map<number, { value: BacklogIssueData; own: boolean }>();
  for (const rec of records) {
    const value = (shown(rec) ?? rec.local ?? rec.remote) as BacklogIssueData | null;
    if (!value?.number) continue;
    const own = rec.externalId.startsWith("sb:");
    if (!heads.has(value.number) || (heads.get(value.number)!.own && !own)) heads.set(value.number, { value, own });
  }
  return new Map([...heads].map(([n, h]) => [n, h.value]));
}

/**
 * The local changes among a workspace's Issues: every open one, then the newest 10 closed; newest first each. Where they
 * stand in for a service's PRs (`apart`), a merged one whose summary is not on the service yet stays listed past the 10:
 * the report after the service is back reads them here.
 */
function changesOf(workspaceId: string, issues: Iterable<BacklogIssueData>, apart = false): Backlog["changes"] {
  const all = [...issues].flatMap((i) => (i.change ? [{ workspaceId, number: i.number, title: i.title, state: i.state, head: i.change.head, base: i.change.base, mergeCommit: i.change.mergeCommit, mergedAt: i.change.mergedAt, updatedAt: i.updatedAt, pr: i.change.pr ?? null, reportedAt: i.change.reportedAt ?? null }] : []));
  const newest = (a: { updatedAt: string; number: number }, b: { updatedAt: string; number: number }) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number;
  const closed = all.filter((c) => c.state === "CLOSED").sort(newest);
  return [...all.filter((c) => c.state === "OPEN").sort(newest), ...closed.filter((c, i) => i < 10 || (apart && c.mergeCommit !== null && c.reportedAt === null))];
}

/**
 * The records as shown, each with its shown value as `remote` (and `fetched`): an edit not sent yet over what GitHub answered,
 * and the records made here. A Project item whose last edit takes it out of the Project is not shown.
 */
export function shownRecords(db: Db, source: BacklogSource): BacklogRecord[] {
  const member = new Map(db.listPendingBacklogOperations(source).filter((o) => o.kind === "set" && o.field === "member").map((o) => [o.target, o.payload]));
  return db.listBacklogRecords(source).flatMap((r) => {
    const v = shown(r);
    const value = v && (r.objectKind === "issue" || r.objectKind === "comment") ? { ...v, body: withoutMarker((v as { body: string }).body) } : v;
    // read like a record GitHub answered with that value
    return value && !(r.objectKind === "project-item" && member.get(r.externalId) === false) ? [{ ...r, remote: value, local: null, fetchState: "fetched" } as BacklogRecord] : [];
  });
}

/**
 * The state and title of every stored Issue of the workspace, read in one pass: what the queue needs of a PBI, as
 * `readStoredIssue` shows it, without its comments, Project item or sync state. Empty when the workspace has no source.
 */
export function storedIssueHeads(db: Db, ws: Pick<BacklogWorkspace, "id">): Map<number, { state: BacklogIssueData["state"]; title: string }> {
  const source = db.getWorkspaceBacklogSource(ws.id);
  return new Map([...storedIssueStates(source ? db.listBacklogRecords(source, "issue") : [])].map(([n, v]) => [n, { state: v.state, title: v.title }]));
}

/** The numbers of the workspace's stored Issues (closed ones too) that carry the flow-improvement label. Unlike `storedIssueHeads`, a number counts when either of its records (one made here, or GitHub's) carries the label. */
export function storedFlowIssues(db: Db, ws: Pick<BacklogWorkspace, "id">): Set<number> {
  const source = db.getWorkspaceBacklogSource(ws.id);
  const out = new Set<number>();
  for (const rec of source ? db.listBacklogRecords(source, "issue") : []) {
    const value = (shown(rec) ?? rec.local ?? rec.remote) as BacklogIssueData | null;
    if (value?.number && value.labels.includes(FLOW_LABEL)) out.add(value.number);
  }
  return out;
}

/** What `storedIssueReader` reads: an Issue as `readStoredIssue` shows it, and its Project fields as shown. */
export interface StoredIssueReader {
  issue(workspaceId: string, number: number): BacklogIssueData | null;
  /** The Project item's fields of the Issue, as shown (a pending "remove from Project" hides them); null = none. */
  fields(workspaceId: string, number: number): Record<string, string | number | null> | null;
  /**
   * The workspace's requests (`type:request`) closed in [from, to) (ms), oldest first, each with the numbers of its
   * `## 派生 PBI` in the order written. One closed as a duplicate is another request's, not a unit of its own.
   */
  closedRequests(workspaceId: string, from: number, to: number): Array<{ issue: BacklogIssueData; pbis: number[] }>;
}

/**
 * `readStoredIssue`'s Issue and Project fields for many Issues of a request: a workspace's records are read the first
 * time they are asked and kept for the reader's life, so a list of rows that look up a few Issues each reads them once.
 * Make one per request.
 */
export function storedIssueReader(db: Db): StoredIssueReader {
  const issues = new Map<string, BacklogRecord[]>();
  const shownAll = new Map<string, BacklogRecord[]>();
  return {
    issue(workspaceId, number) {
      const source = db.getWorkspaceBacklogSource(workspaceId);
      if (!source || number <= 0) return null;
      if (!issues.has(workspaceId)) issues.set(workspaceId, db.listBacklogRecords(source, "issue"));
      const rec = issueRecordOf(issues.get(workspaceId)!, number);
      const value = rec && ((shown(rec) ?? rec.local ?? rec.remote) as BacklogIssueData | null);
      return value ? { ...value, body: withoutMarker(value.body) } : null;
    },
    closedRequests(workspaceId, from, to) {
      const source = db.getWorkspaceBacklogSource(workspaceId);
      if (!source) return [];
      if (!issues.has(workspaceId)) issues.set(workspaceId, db.listBacklogRecords(source, "issue"));
      return [...storedIssueStates(issues.get(workspaceId)!).values()]
        .flatMap((issue) => {
          const at = issue.closedAt ? Date.parse(issue.closedAt) : NaN;
          return issue.state === "CLOSED" && issue.stateReason !== "DUPLICATE" && issue.labels.includes("type:request") && at >= from && at < to ? [{ issue: { ...issue, body: withoutMarker(issue.body) }, pbis: derivedPbisOf(issue.body), at }] : [];
        })
        .sort((a, b) => a.at - b.at || a.issue.number - b.issue.number)
        .map(({ issue, pbis }) => ({ issue, pbis }));
    },
    fields(workspaceId, number) {
      const source = db.getWorkspaceBacklogSource(workspaceId);
      if (!source || number <= 0) return null;
      if (!shownAll.has(workspaceId)) shownAll.set(workspaceId, shownRecords(db, source));
      const item = projectItemOf(shownAll.get(workspaceId)!, source, number);
      return item ? (item.remote as BacklogProjectItemData).fields : null;
    },
  };
}

/**
 * One stored Issue of the workspace's repository, without asking GitHub; null = not stored. `ref`: its number, or
 * the local id of an Issue made here — before GitHub numbers it and after. It shows the edits not sent yet.
 */
export function readStoredIssue(db: Db, ws: Pick<BacklogWorkspace, "id">, ref: number | string, opts: { importFailed?: boolean; now?: number; source?: BacklogSource | null } = {}): BacklogIssueDetail | null {
  // `source`: the workspace's changes, where they are kept apart from its Issues (changeSourceOf)
  const source = opts.source ?? db.getWorkspaceBacklogSource(ws.id);
  const rec = source ? issueRecord(db, source, ref) : null;
  // one GitHub no longer showed (404 / 403) is still read as stored, with its fetchState; it is not edited (409)
  const value = rec && ((shown(rec) ?? rec.local ?? rec.remote) as BacklogIssueData | null);
  if (!source || !rec || !value) return null;
  const issue = { ...value, body: withoutMarker(value.body) };
  const records = shownRecords(db, source);
  // a comment made here is named by its `local:` id before it is sent and by the service's after: both find its operation.
  // Oldest last: one sent again when GitHub is turned on (backlog-enable.ts) keeps the seq it was written with
  const written = new Map(db.listBacklogOperations(source).reverse().flatMap((o) => (o.kind === "comment" ? [[o.target, o.seq] as const, ...(o.remoteId ? [[o.remoteId, o.seq] as const] : [])] : [])));
  const comments = issue.number ? records.flatMap((r) => (r.objectKind === "comment" && r.remote?.issue === issue.number ? [{ ...r.remote, id: r.externalId, seq: written.get(r.externalId) ?? null }] : [])) : [];
  const item = issue.number ? projectItemOf(records, source, issue.number) : undefined;
  const all = db.listPendingBacklogOperations(source);
  const pending = all.filter((o) => o.issue === rec.externalId);
  // as its list row
  const family = familyOf(rec.externalId, value.subIssues ?? [], issueIds(db.listBacklogRecords(source, "issue")));
  const create = pending.find((o) => o.kind === "create")?.payload as BacklogCreatePayload | undefined;
  const held = pending.flatMap((o): BacklogHeldEdit[] => {
    if (o.status !== "conflict" && o.status !== "failed" && o.status !== "unknown") return [];
    const conflict = o.status === "conflict" ? conflictOf(db, o) : null;
    return [{ operation: o.id, kind: o.kind, field: o.field, status: o.status, reason: o.error, updatedAt: o.updatedAt, conflict }];
  });
  return {
    workspaceId: ws.id, issue, comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    fields: item ? (item.remote as BacklogProjectItemData).fields : (create?.project?.fields ?? null), projectFields: source.projectFields ?? [], fetchedAt: rec.fetchedAt, fetchState: rec.fetchState,
    localId: typeof ref === "string" ? ref : rec.externalId.startsWith("local:") ? rec.externalId.slice("local:".length) : null, pending: pending.length,
    held, limits: SYNC_LIMITS, changeRefs: null,
    sync: syncOf(db, all.filter((o) => family.has(o.issue)), { lastSuccessfulSync: freshAt(db.getBacklogRepository(source)?.lastSuccessfulSync ?? null, rec), retryAt: db.getBacklogRepository(source)?.retryAt ?? null, fetchState: rec.externalId.startsWith("local:") && !rec.remote ? "fetched" : rec.fetchState, importFailed: opts.importFailed, now: opts.now ?? Date.now() }),
  };
}

/**
 * The stored records of a workspace as the kit's checks read them (`GET /api/backlog/records`): every Issue as
 * shown with its Project fields, the pull requests, the checkout's top level (what a Task body's paths are read
 * against) and the Issues whose last read was not complete (`unread`: never read as current). null = never imported.
 */
export function readStoredRecords(db: Db, ws: Pick<BacklogWorkspace, "id" | "path">): StoredRecords | null {
  const source = db.getWorkspaceBacklogSource(ws.id);
  const fetchedAt = source ? db.getBacklogRepository(source)?.lastSuccessfulSync ?? null : null;
  if (!source || fetchedAt === null) return null;
  const records = shownRecords(db, source);
  const fields = new Map<number, BacklogProjectItemData["fields"]>();
  for (const r of records) {
    if (r.objectKind === "project-item" && r.remote && r.remote.owner.toLowerCase() === source.project.owner.toLowerCase() && r.remote.project === source.project.number) fields.set(r.remote.issue, r.remote.fields);
  }
  let top: StoredRecords["top"] = [];
  try {
    top = readdirSync(ws.path, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    // the checkout is gone: the kit adds the PRs' files' top level
  }
  // one the last import did not read in full is not shown, but is listed with what GitHub last answered: a check then
  // knows it is a typed open Issue it cannot judge (unread), not one that does not exist
  const unread = db.listBacklogRecords(source, "issue").flatMap((r) => (r.fetchState !== "fetched" && (r.remote as BacklogIssueData | null)?.number ? [r.remote as BacklogIssueData] : []));
  const issues = records.flatMap((r) => (r.objectKind === "issue" && r.remote && r.remote.number > 0 ? [r.remote] : []));
  return {
    workspaceId: ws.id, service: syncsGithub(source) ? source.service : "switchboard", repository: source.repository, project: source.project, fetchedAt, top, shared: sharedFilesOf(ws.path, workspaceConfigPath(ws, ws.path) ?? CONFIG_FILE),
    issues: [...issues, ...unread.filter((u) => !issues.some((i) => i.number === u.number))].map((i) => ({ ...i, fields: fields.get(i.number) ?? null })),
    unread: unread.map((i) => i.number),
    pulls: records.flatMap((r) => (r.objectKind === "pull-request" && r.remote ? [r.remote] : [])),
    comments: records.flatMap((r) => (r.objectKind === "comment" && r.remote ? [{ issue: r.remote.issue, body: r.remote.body, createdAt: r.remote.createdAt }] : [])).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/**
 * The three values of a held conflict and the revision a choice names. A conflict the write found afterwards
 * shows the other's value from the history, not GitHub's (which is the value made here); its revision still
 * names what GitHub has, as the choice does.
 */
function conflictOf(db: Db, o: BacklogOperation): NonNullable<BacklogHeldEdit["conflict"]> {
  const read = db.backlogRemoteValue(o);
  return o.overwritten
    ? { base: o.base, local: o.payload, remote: o.overwritten.value ?? null, remoteRead: "value" in o.overwritten, revision: conflictRevision(o, read) }
    : { base: o.base, local: o.payload, remote: read ?? null, remoteRead: read !== undefined, revision: conflictRevision(o, read) };
}

/**
 * When an Issue was last known to be current: an import reads only what changed since its cursor, so a complete
 * one vouches for every record it did not return (`repoAt`), and the record's own read can only be as late. A record GitHub
 * did not answer for (404 / 403 / never read) is vouched for by neither: its last own read.
 */
const freshAt = (repoAt: number | null, rec: { fetchedAt: number | null; fetchState: BacklogFetchState } | undefined) =>
  rec && rec.fetchState === "fetched" ? Math.max(rec.fetchedAt ?? 0, repoAt ?? 0) || null : rec?.fetchedAt ?? null;

/** What a sync is judged on besides the operations. `importFailed`: the workspace's last import failed or is held back. */
interface SyncAt { lastSuccessfulSync: number | null; retryAt: number | null; fetchState?: BacklogFetchState; importFailed?: boolean; now: number }

/**
 * How one Issue, or a workspace's whole repository, stands against GitHub, from the stored operations and when it
 * was last read. Conflict wins, then what cannot be sent or told (a refused edit, a record GitHub no longer shows or
 * never read, a failed import), then what waits; `unknown` (a lost answer) waits, to be looked for before it is sent again.
 * A failed read never moves `lastSuccessfulSync`.
 */
export function syncOf(db: Db, ops: BacklogOperation[], at: SyncAt): BacklogSyncInfo {
  const open = ops.filter((o) => o.status !== "done");
  const conflicts = open.filter((o) => o.status === "conflict").map((o) => ({ field: o.field, ...conflictOf(db, o) }));
  const has = (status: BacklogOperation["status"]) => open.some((o) => o.status === status);
  const fetchState = at.fetchState ?? "fetched";
  const wait = at.retryAt !== null && at.retryAt > at.now ? at.retryAt : null;
  let state: BacklogSyncState = "synced";
  let reason: BacklogSyncInfo["reason"] = null;
  if (conflicts.length) state = "conflict";
  else if (has("failed")) [state, reason] = ["error", "failed"];
  else if (fetchState !== "fetched") [state, reason] = ["error", fetchState];
  // an edit waiting is "pending" even while GitHub is out of reach (the reason says so, and `retryAt` when it is tried again)
  else if (open.length) [state, reason] = ["pending", has("unknown") ? "unknown" : at.importFailed || wait !== null ? "import" : null];
  else if (at.importFailed || wait !== null) [state, reason] = ["error", "import"];
  const nextOp = open.flatMap((o) => (o.status === "pending" && o.retryAt && o.retryAt > at.now ? [o.retryAt] : []));
  return {
    state, reason, lastSuccessfulSync: at.lastSuccessfulSync,
    retryAt: wait ?? (nextOp.length ? Math.min(...nextOp) : null),
    pendingCount: open.length, conflicts, guarantee: "A",
  };
}

/**
 * A workspace's sync as a whole: its repository's operations, when it was last imported, the Issues made here
 * that GitHub has not numbered yet (no number: no stage can start on them), and the numbered Issues that hold operations
 * not sent — a conflict or a send held by an Issue with no row in the list (Closed ones) is opened from here.
 * A workspace never imported is `unfetched`.
 */
export function workspaceSyncOf(db: Db, ws: Pick<BacklogWorkspace, "id">, opts: { importFailed?: boolean; now?: number } = {}): {
  sync: BacklogSyncInfo;
  creates: Array<{ localId: string; title: string; state: BacklogSyncState }>;
  issues: Array<{ number: number; title: string; url: string; closed: boolean; state: BacklogSyncState; pendingCount: number; conflictCount: number }>;
} {
  const now = opts.now ?? Date.now();
  const source = db.getWorkspaceBacklogSource(ws.id);
  const repo = source ? db.getBacklogRepository(source) : null;
  const ops = source ? db.listPendingBacklogOperations(source) : [];
  const last = repo?.lastSuccessfulSync ?? null;
  // the worst of the Issues: one GitHub no longer shows, refused, or never read in full makes the workspace say so
  const unread = source ? db.listBacklogRecords(source, "issue").find((r) => !r.externalId.startsWith("local:") && r.fetchState !== "fetched") : undefined;
  const base = syncOf(db, ops, { lastSuccessfulSync: last, retryAt: repo?.retryAt ?? null, importFailed: opts.importFailed, now, fetchState: last === null ? "unfetched" : unread?.fetchState ?? "fetched" });
  // only those GitHub has not numbered yet (a create whose Issue exists keeps its follow-ups, not a place here)
  const creates = ops.filter((o) => o.kind === "create" && !o.remoteId).map((o) => ({
    localId: o.id,
    title: String((o.payload as { title?: unknown } | null)?.title ?? ""),
    state: syncOf(db, [o], { lastSuccessfulSync: last, retryAt: null, now }).state,
  }));
  const held = new Map<string, BacklogOperation[]>();
  for (const o of ops) if (o.status !== "done") held.set(o.issue, [...(held.get(o.issue) ?? []), o]);
  const issues = (source ? db.listBacklogRecords(source, "issue") : []).flatMap((r) => {
    const own = held.get(r.externalId);
    const v = (shown(r) ?? r.local ?? r.remote) as BacklogIssueData | null;
    if (!own || !v || !(v.number > 0)) return [];
    const s = syncOf(db, own, { lastSuccessfulSync: last, retryAt: null, now });
    return [{ number: v.number, title: v.title, url: v.url, closed: v.state === "CLOSED", state: s.state, pendingCount: s.pendingCount, conflictCount: s.conflicts.length }];
  }).sort((a, b) => a.number - b.number);
  // a work machine's records are a copy of the instance's: said with when the copy was taken
  const takenAt = source ? db.getSetting<Record<string, number>>("backlog.replica", {})[`${source.service}/${source.host}/${source.repository}`] : undefined;
  return { sync: takenAt === undefined ? base : { ...base, replica: { takenAt } }, creates, issues };
}

/**
 * Whether a stage may start on this item: the stored data is what is true, so only a conflict held here
 * stops it. GitHub's side of the sync (edits waiting to be sent, a failed or old import, an Issue it did not return) is
 * shown, never a reason not to start — what is kept here is sent once GitHub can be reached.
 */
export function canStartStoredBacklog(item: Pick<BacklogItem, "sync">): { ok: true } | { ok: false; why: string } {
  const c = item.sync.conflicts;
  return c.length ? { ok: false, why: `競合が解消されていない（${c.map((x) => x.field ?? "作成").join("・")}）` } : { ok: true };
}
