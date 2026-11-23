/**
 * The edits: an Issue made or changed here is stored at once and sent to GitHub later (backlog-send.ts) — create,
 * edit, comment, the answer to a question or a confirmation, a hold — and what the person does with an edit that
 * could not be sent (resolve, retry, cancel, withdraw).
 */
import { machineOfOperation } from "./backlog-upbox.ts";
import type { BacklogCommentData, BacklogCreateInput, BacklogEditInput, BacklogIssueData, BacklogProjectItemData, BacklogRecord, BacklogSource } from "@switchboard/protocol";
import { applyBacklogField, artifactsOfIssues, BacklogResolveError, type BacklogArtifactPayload, type BacklogLocalEntry, type Db, type NewBacklogOperation } from "./db.ts";
import { withoutMarker } from "./backlog-merge.ts";
import { findSecrets, hostAws } from "../../../ops-kit/src/secrets.ts";
import { fieldValue, UsageError, type Field } from "../../../ops-kit/src/set.ts";
import { syncsGithub } from "./backlog-gh.ts";
import { criteria, confirmationsOf } from "./backlog-item.ts";
import { DECISION_HEADING, ANSWER_HEADING, HOLD_HEADING, proceedingAnswer, type Comment } from "./backlog-comments.ts";
import { shown, projectItemOf, issueRecord, shownRecords } from "./backlog-stored.ts";
import { grantHeadsOf, type GrantHeads } from "./merge-grants.ts";

/* ---------- edits kept here and sent to GitHub later ---------- */

/** An edit refused before anything is stored; `status` = the HTTP status the API answers with. */
export class BacklogEditError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Refuses a value that does not fit its Project field, before it is stored: checked as the send checks it
 * (`fieldValue`), against the Project's definitions. `null` (empties the field) fits every field.
 */
export function checkFieldTypes(defs: Array<Field & { name: string }>, fields: Record<string, string | number | null>): void {
  for (const [name, v] of Object.entries(fields)) {
    if (v === null) continue;
    const def = defs.find((d) => d.name === name);
    if (!def) throw new BacklogEditError(`フィールド '${name}' が Project にありません`, 422);
    try {
      fieldValue(name, def, String(v));
    } catch (e) {
      if (e instanceof UsageError) throw new BacklogEditError(e.message, 422);
      throw e;
    }
  }
}

/** Refuses a text with a value that signs in or acts as the user: it would be stored, then posted to GitHub. */
function refuseSecrets(...texts: Array<string | undefined>): void {
  const host = hostAws();
  for (const t of texts) {
    const hit = t ? findSecrets(t, host)[0] : undefined;
    if (hit) throw new BacklogEditError(`認証に使える値（${hit.kind}、${hit.line} 行目）が入っています。外してから保存してください`, 422);
  }
}

/** The names and text values of Project fields: what is stored and goes to GitHub as it is. */
const texts = (fields: Record<string, string | number | null> | null | undefined) => Object.entries(fields ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [k, v] : [k]));
/** Fields to set, none when the map is empty: an empty map does not put an Issue in the Project. */
const someFields = (fields: Record<string, string | number | null> | null | undefined) => (fields && Object.keys(fields).length ? fields : undefined);

/** The create operation of an Issue made here while it can still be changed (not sent yet; GitHub has not made it). */
const pendingCreate = (db: Db, source: BacklogSource, issue: string) => db.listPendingBacklogOperations(source).find((o) => o.kind === "create" && o.issue === issue && o.status === "pending" && !o.remoteId);

/** What a create sends: the Issue's fields, and the Project it goes in with its fields. */
export interface BacklogCreatePayload {
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  milestone: string | null;
  parent: number | null;
  project: { owner: string; number: number; fields: Record<string, string | number | null> } | null;
  /** A local change's branches; absent on an Issue. */
  change?: { head: string; base: string; pr?: number | null };
}

/** A new Issue, kept until it is created on GitHub; read and edited by the returned local id until then and after. */
export function createStoredIssue(db: Db, source: BacklogSource, input: Omit<BacklogCreateInput, "workspaceId">, now = Date.now()): { localId: string } {
  refuseSecrets(input.title, input.body, input.milestone ?? undefined, ...input.labels, ...texts(input.fields));
  const localId = crypto.randomUUID();
  const at = new Date(now).toISOString();
  const change = input.change ? { head: input.change.head, base: input.change.base, pr: input.change.pr ?? null } : undefined;
  const draft: BacklogIssueData = { number: 0, title: input.title, url: "", state: "OPEN", stateReason: null, body: input.body, labels: input.labels, milestone: input.milestone, parent: input.parent, subIssues: [], createdAt: at, updatedAt: at, closedAt: null, ...(change ? { change: { ...change, mergeCommit: null, mergedAt: null, reviewedHead: null, reportedAt: null } } : {}) };
  const payload: BacklogCreatePayload = { title: input.title, body: input.body, state: "OPEN", labels: input.labels, milestone: input.milestone, parent: input.parent, project: someFields(input.fields) ? { ...source.project, fields: input.fields! } : null, ...(change ? { change } : {}) };
  const id = `local:${localId}`;
  db.applyBacklogEdit(source, { records: [{ objectKind: "issue", externalId: id, local: draft }], operations: [{ id: localId, issue: id, targetKind: "issue", target: id, kind: "create", payload }] }, now);
  return { localId };
}

/** A name an Issue artifact can carry: no `#` (it parts the path from the name on the command line), brackets, quotes or control characters; at most 100 characters. */
export const artifactName = (s: string) => s.replace(/[#()\[\]{}<>"'`\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

/**
 * The reports to attach to PBI `number`'s Issue when it is closed: one `artifact` operation per artifact of the
 * Tasks that worked on it or on its sub-issues (`artifactsOfIssues`) — only for a repository synced with GitHub, and
 * only from the Tasks of its workspaces that asked for it (`Workspace.issueArtifacts`): a second workspace of the same
 * repository that did not ask sends nothing. Names are made distinct: the name is how a second send finds what the
 * first one attached.
 */
export function artifactOperations(db: Db, source: BacklogSource, issue: string, number: number, subIssues: number[]): NewBacklogOperation[] {
  if (source.service !== "github" || !syncsGithub(source)) return [];
  const same = (s: BacklogSource | null) => !!s && s.service === source.service && s.host === source.host && s.repository.toLowerCase() === source.repository.toLowerCase();
  const asked = db.listWorkspaces().filter((w) => w.issueArtifacts && same(db.getWorkspaceBacklogSource(w.id)));
  if (!asked.length) return [];
  const used = new Set<string>();
  return artifactsOfIssues(db.sqlite, [number, ...subIssues], asked.map((w) => w.id)).map((a) => {
    const base = artifactName(a.title) || artifactName(a.entry ?? "") || a.id;
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} ${i}`;
    used.add(name.toLowerCase());
    const payload: BacklogArtifactPayload = a.kind === "url" ? { artifactId: a.id, name, kind: "link", url: a.source } : { artifactId: a.id, name, kind: /\.html?$/i.test(a.entry ?? "") ? "html" : "markdown" };
    return { issue, targetKind: "issue", target: issue, kind: "artifact", payload };
  });
}

/**
 * Edits a stored Issue: each field that changes becomes an operation, sent later, made on the value shown now
 * (its `base`). An Issue not created yet has its create changed instead. Refused: an Issue not stored, one not read in
 * full (404 / 403 on its last read), a Project change of an Issue whose create is under way. Returns the operations.
 */
export function editStoredIssue(db: Db, source: BacklogSource, ref: number | string, input: Omit<BacklogEditInput, "workspaceId">, now = Date.now()): { localId: string | null; operations: string[] } {
  refuseSecrets(input.title, input.body, input.milestone ?? undefined, ...(input.labels?.add ?? []), ...texts(input.fields));
  const rec = issueRecord(db, source, ref);
  const cur = rec ? (shown(rec) as BacklogIssueData | null) : null;
  if (!rec || !cur) throw new BacklogEditError(rec?.remote ? `#${ref} は GitHub から読めていません（${rec.fetchState}）。再読込してから編集してください` : `#${ref} は保存されていません`, rec?.remote ? 409 : 404);
  const localId = rec.externalId.startsWith("local:") ? rec.externalId.slice("local:".length) : null;
  // a name both added and removed is removed, whether the Issue was made yet or not
  const added = (input.labels?.add ?? []).filter((l) => !input.labels?.remove.includes(l));
  const labels = (l: string[]) => [...new Set([...l, ...added])].filter((x) => !input.labels?.remove.includes(x));
  const create = pendingCreate(db, source, rec.externalId);
  // a create sends no reason: closing one with a reason waits for it to be made
  if (create && input.stateReason) throw new BacklogEditError("作成を GitHub に送っている間は閉じた理由を付けられません。送り終えてから編集してください", 409);
  if (input.change && !cur.change) throw new BacklogEditError(`#${ref} は変更ではありません`, 422);
  // a merged or closed change is not opened again: its branch may have another open one now (make a new change)
  if (cur.change && input.state === "OPEN" && cur.state === "CLOSED") throw new BacklogEditError(`#${ref} は閉じた変更なので開き直せません（新しい変更を作る）`, 422);
  if (create && input.change) throw new BacklogEditError("作成が確定する前の変更はマージ済みにできません", 409);
  // a merged change keeps its first merge record: another one is refused, the same one again (a resend whose answer
  // was lost) writes nothing
  const mergeInput = input.change && "mergeCommit" in input.change ? input.change : null;
  const merged = mergeInput && cur.change?.mergeCommit ? cur.change : null;
  const sameMerge = !!mergeInput && !!merged && mergeInput.mergeCommit === merged.mergeCommit && mergeInput.mergedAt === merged.mergedAt && mergeInput.reviewedHead === merged.reviewedHead;
  if (merged && !sameMerge) throw new BacklogEditError(`#${ref} はマージ済みの変更なので、マージの記録は書き換えられません`, 409);
  if (create) {
    const p = create.payload as BacklogCreatePayload;
    const project = input.project === false ? null : input.project || someFields(input.fields) || p.project ? { ...source.project, fields: { ...p.project?.fields, ...input.fields } } : null;
    const next: BacklogCreatePayload = { title: input.title ?? p.title, body: input.body ?? p.body, state: input.state ?? p.state, labels: labels(p.labels), milestone: input.milestone === undefined ? p.milestone : input.milestone, parent: input.parent === undefined ? p.parent : input.parent, project, ...(p.change ? { change: p.change } : {}) };
    const { project: _, change: __, ...fields } = next;
    db.applyBacklogEdit(source, { records: [{ objectKind: "issue", externalId: rec.externalId, local: { ...cur, ...fields } }], operations: [{ issue: create.issue, targetKind: "issue", target: create.target, kind: "create", payload: next, replace: create.id }] }, now);
    return { localId, operations: [create.id] };
  }
  const issue = rec.externalId;
  const ops: NewBacklogOperation[] = [];
  const set = (field: string, value: unknown, base: unknown) => ops.push({ issue, targetKind: "issue", target: issue, kind: "set", field, payload: value, base });
  // the body as shown: without the marker a post sent from here left on it
  const was = { ...cur, body: withoutMarker(cur.body) };
  for (const f of ["title", "body", "state", "milestone", "parent"] as const) if (input[f] !== undefined && input[f] !== was[f]) set(f, input[f], was[f]);
  if (input.change && !sameMerge) set("change", input.change, was.change ?? null);
  // after the close: an Issue closed just now is completed until its reason is changed, as GitHub answers it
  // (one closed by a close still waiting to be sent shows that: applyBacklogField). A close that only takes back a
  // reopen still waiting is one with it (Db.applyBacklogEdit) and writes nothing: GitHub keeps its reason, or the one a
  // reason still waiting from before the reopen makes it
  if (input.stateReason) {
    const pending = db.listPendingBacklogOperations(source).filter((o) => o.issue === issue);
    const reopen = [...pending].reverse().find((o) => o.kind === "set" && o.field === "state" && o.status === "pending");
    const undone = !!reopen && reopen.base === "CLOSED" && !pending.some((o) => o.seq > reopen.seq && o.kind !== "set");
    const base = was.state === "CLOSED" ? was.stateReason : undone && input.state === "CLOSED" ? ([...pending].reverse().find((o) => o.kind === "set" && o.field === "stateReason" && o.status === "pending")?.payload ?? (rec.remote as BacklogIssueData | null)?.stateReason ?? null) : "COMPLETED";
    if (input.stateReason !== base) set("stateReason", input.stateReason, base);
  }
  for (const l of added) if (!cur.labels.includes(l)) set(`label:${l}`, true, false);
  for (const l of input.labels?.remove ?? []) if (cur.labels.includes(l)) set(`label:${l}`, false, true);
  // a PBI closed now: the reports of its work follow the close to its Issue, once (a workspace that asked for it)
  if (input.state === "CLOSED" && was.state !== "CLOSED" && cur.number && cur.labels.includes("type:pbi")) ops.push(...artifactOperations(db, source, issue, cur.number, cur.subIssues ?? []));
  const records: BacklogLocalEntry[] = [];
  if (input.project !== undefined || someFields(input.fields)) {
    if (!cur.number) throw new BacklogEditError("作成を GitHub に送っている間は Project を変えられません。送り終えてから編集してください", 409);
    let item = projectItemOf(db.listBacklogRecords(source, "project-item"), source, cur.number);
    // taken out of the Project by an edit not sent yet: in it again undoes that
    const out = !!item && db.listPendingBacklogOperations(source).filter((o) => o.target === item!.externalId && o.field === "member").at(-1)?.payload === false;
    const member = (payload: boolean) => ops.push({ issue, targetKind: "project-item", target: item!.externalId, kind: "set", field: "member", payload, base: !!item!.remote });
    if (item && input.project === false && !out) {
      member(false);
      // one GitHub does not have yet is gone: not shown, and in the Project again makes a new one
      if (!item.remote) records.push({ objectKind: "project-item", externalId: item.externalId, local: null });
    }
    if (item && input.project !== false && out) member(true);
    // only emptying fields does not put the Issue in the Project: it has nothing to empty there
    const made = !item && input.project !== false && (input.project === true || Object.values(input.fields ?? {}).some((v) => v !== null));
    if (made) {
      const local: BacklogProjectItemData = { issue: cur.number, owner: source.project.owner, project: source.project.number, fields: { ...input.fields } };
      item = { ...source, objectKind: "project-item", externalId: `local:${crypto.randomUUID()}`, remote: null, base: null, local, fetchedAt: null, fetchState: "unfetched" };
      records.push({ objectKind: "project-item", externalId: item.externalId, local });
      member(true);
    }
    if (item && input.project !== false) {
      const fields = (shown(item) as BacklogProjectItemData).fields ?? {};
      for (const [name, v] of Object.entries(input.fields ?? {})) if (made || (fields[name] ?? null) !== v) ops.push({ issue, targetKind: "project-item", target: item.externalId, kind: "set", field: `field:${name}`, payload: v, base: made ? null : (fields[name] ?? null) });
      // an item GitHub does not have yet shows its fields here
      if (!made && !item.remote && input.fields) records.push({ objectKind: "project-item", externalId: item.externalId, local: { ...(shown(item) as BacklogProjectItemData), fields: { ...fields, ...input.fields } } });
    }
  }
  // an Issue the service does not have yet shows its edits here; one it has, on what it answered (rebaseBacklogRecord)
  if (!rec.remote) records.push({ objectKind: "issue", externalId: issue, local: ops.filter((o) => o.targetKind === "issue").reduce<unknown>((d, o) => applyBacklogField("issue", d, o.field!, o.payload), cur) });
  return { localId, operations: ops.length ? db.applyBacklogEdit(source, { records, operations: ops }, now) : [] };
}

/**
 * The user's choice on a held conflict of a stored Issue: the held `set` of `field` (as the held edit names it)
 * goes to Db.resolveBacklogConflict with the revision the choice saw. 404 = no such Issue; 409 = no conflict held on
 * that field (an unknown field too), or the revision is old. Returns the operation chosen on.
 */
export function resolveStoredConflict(db: Db, source: BacklogSource, ref: number | string, resolve: NonNullable<BacklogEditInput["resolve"]>, now = Date.now()): { operation: string } {
  const rec = issueRecord(db, source, ref);
  if (!rec) throw new BacklogEditError(`#${ref} は保存されていません`, 404);
  const op = db.listPendingBacklogOperations(source).find((o) => o.issue === rec.externalId && o.kind === "set" && o.field === resolve.field && o.status === "conflict");
  if (!op) throw new BacklogEditError(`#${ref} の ${resolve.field} に保留中の競合はありません`, 409);
  try {
    db.resolveBacklogConflict(source, op.id, resolve.choice, resolve.expectedRevision, now);
  } catch (e) {
    if (e instanceof BacklogResolveError) throw new BacklogEditError(e.message, e.status);
    throw e;
  }
  return { operation: op.id };
}

/**
 * A `failed` operation of a stored Issue sent again: `operation` as the held edit names it. 404 = no such
 * Issue; 409 = no such operation still to send on this Issue (another Issue's, another repository's, or one sent),
 * or it is not failed. Returns the operation.
 */
export function retryStoredOperation(db: Db, source: BacklogSource, ref: number | string, operation: string, now = Date.now()): { operation: string } {
  const rec = issueRecord(db, source, ref);
  if (!rec) throw new BacklogEditError(`#${ref} は保存されていません`, 404);
  const op = db.listPendingBacklogOperations(source).find((o) => o.issue === rec.externalId && o.id === operation);
  if (!op) throw new BacklogEditError(`#${ref} に送り直せる操作 ${operation} はありません`, 409);
  try {
    db.retryBacklogOperation(source, op.id, now);
  } catch (e) {
    if (e instanceof BacklogResolveError) throw new BacklogEditError(e.message, e.status);
    throw e;
  }
  return { operation: op.id };
}

/**
 * A comment of a stored Issue taken back inside its send window (SEND_DELAY_MS): `operation` as the held edit names it.
 * 404 = no such Issue; 409 = no such operation still to send on this Issue, or it is past its window. Returns the operation.
 */
export function cancelStoredOperation(db: Db, source: BacklogSource, ref: number | string, operation: string, now = Date.now()): { operation: string } {
  const rec = issueRecord(db, source, ref);
  if (!rec) throw new BacklogEditError(`#${ref} は保存されていません`, 404);
  const op = db.listPendingBacklogOperations(source).find((o) => o.issue === rec.externalId && o.id === operation);
  if (!op) throw new BacklogEditError(`#${ref} に取り消せる操作 ${operation} はありません`, 409);
  try {
    db.cancelBacklogOperation(source, op.id, now);
  } catch (e) {
    if (e instanceof BacklogResolveError) throw new BacklogEditError(e.message, e.status);
    throw e;
  }
  return { operation: op.id };
}

/**
 * Takes back a held operation of the Issue: one `unknown` or `failed`, with why. Nothing is written to GitHub;
 * the Issue's operations after it go on (a create of an Issue never made takes them back with it). 404 = the Issue is
 * not stored; 409 = no such held operation on this Issue.
 */
export function withdrawStoredOperation(db: Db, source: BacklogSource, ref: number | string, withdraw: { operation: string; reason: string }, now = Date.now()): { operation: string } {
  const rec = issueRecord(db, source, ref);
  if (!rec) throw new BacklogEditError(`#${ref} は保存されていません`, 404);
  const op = db.listPendingBacklogOperations(source).find((o) => o.issue === rec.externalId && o.id === withdraw.operation);
  if (!op) throw new BacklogEditError(`#${ref} に取り下げられる操作 ${withdraw.operation} はありません`, 409);
  try {
    db.withdrawBacklogOperation(source, op.id, withdraw.reason, now);
  } catch (e) {
    if (e instanceof BacklogResolveError) throw new BacklogEditError(e.message, e.status);
    throw e;
  }
  return { operation: op.id };
}

/** A comment kept here until it is sent: its record and its operation. `extra` goes with the operation (what an answer answers). */
function comment(issue: BacklogRecord, n: number, body: string, now: number, extra: object = {}): { record: BacklogLocalEntry; op: NewBacklogOperation } {
  const id = `local:${crypto.randomUUID()}`;
  const local: BacklogCommentData = { issue: n, body, createdAt: new Date(now).toISOString() };
  return { record: { objectKind: "comment", externalId: id, local }, op: { issue: issue.externalId, targetKind: "comment", target: id, kind: "comment", payload: { body, ...extra } } };
}

/** Issue n's comments as shown (one written here and not sent yet too), oldest first: what its questions and answers are read from. */
function shownComments(db: Db, source: BacklogSource, n: number): Comment[] {
  return shownRecords(db, source)
    .flatMap((r) => {
      const c = r.objectKind === "comment" ? (r.remote as BacklogCommentData | null) : null;
      return c && c.issue === n ? [{ body: c.body, createdAt: c.createdAt }] : [];
    })
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
}

/**
 * Who gives an answer and to which question. `question`: the `## 判断待ち` the answer is to, by the time it was asked
 * (what the person's screen showed). `screen` = the person gave it on the app's screen: its comment's operation keeps the
 * mark screenAnswer reads, and `heads` — required with it — the heads of the PRs its grant sentences name: null for a PR
 * not read (yet: `setAnswerHeads` puts in what is read after the answer is kept), and a grant of it then answers for no head.
 * `by` = who else gave it (`task:<id>`, `api`): kept with the operation as a trace, and never read as the person's.
 */
export type AnswerOpts = { question?: { at: string } } & ({ screen: true; heads: GrantHeads; parts?: string[] } | { screen?: false; by?: string });

/**
 * `## 回答` + text on Issue n, then the needs-decision label off, kept here and sent in that order. Returns the id of
 * the comment's operation.
 * The one place an answer to a question is checked and kept, for every route that takes one. On an Issue that carries
 * a `## 判断待ち`, the answer is kept only when the question it is to (`opts.question`, found by the second it was asked
 * in) is there, is still open, and is the one this answer reads as an answer to (`proceedingAnswer`: an answer that
 * names no question is to the newest one). Still open = no `## 回答` reads as its answer yet — or it is the Issue's
 * newest question and the label is on: the label is the record that it waits, also over a `## 回答` written on GitHub
 * by hand, and an answer kept here takes the label off with it. Anything else — no question named, a newer question,
 * one answered meanwhile through another route — is a `BacklogEditError` (409) and nothing is written. The check and
 * the write are one synchronous stretch, so of two answers to one question the second finds the first. An Issue with
 * no `## 判断待ち` at all waits by its label alone: there is no question to check.
 * The label comes off only when this answer is to the Issue's newest `## 判断待ち`: an answer to an older question does
 * not take the label off, and the newer question goes on waiting.
 */
export function answerStoredDecision(db: Db, source: BacklogSource, n: number, text: string, now = Date.now(), opts: AnswerOpts = {}): string {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してから回答してください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, `${ANSWER_HEADING}\n\n${text}`, now, opts.screen ? { screen: true, heads: opts.heads, ...(opts.parts ? { parts: opts.parts } : {}) } : opts.by ? { by: opts.by } : {});
  // from here to the write nothing is awaited: what is checked is what the write is made on
  const before = shownComments(db, source, n);
  const starts = (x: Comment, heading: string) => x.body.trimStart().startsWith(heading);
  const asked = before.filter((x) => starts(x, DECISION_HEADING));
  // a question the work went on from has no label to take off
  const labelled = (shown(rec) as BacklogIssueData).labels.includes("needs-decision");
  let off = labelled;
  if (asked.length) {
    const mine = c.record.local as BacklogCommentData;
    // this answer beside the questions only: which of them it reads as an answer to, whatever else answered them
    const alone = [...before.filter((x) => !starts(x, ANSWER_HEADING)), { body: mine.body, createdAt: mine.createdAt }].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
    const answers = (d: Comment) => proceedingAnswer(alone, { at: d.createdAt }) !== null;
    const newest = asked.at(-1)!;
    // GitHub gives a question's time to the second: one written here and sent since the screen read it is the same question
    const second = (at: string) => Math.floor(Date.parse(at) / 1000);
    const q = opts.question ? asked.filter((x) => second(x.createdAt) === second(opts.question!.at)).at(-1) : undefined;
    const open = !!q && ((q === newest && labelled) || proceedingAnswer(before, { at: q.createdAt }) === null);
    if (!q || !open || !answers(q)) throw new BacklogEditError("問いが変わりました。読み直してから回答してください", 409);
    off = labelled && answers(newest);
  }
  const [operation] = db.applyBacklogEdit(source, { records: [c.record], operations: [c.op, ...(off ? [{ issue: rec.externalId, targetKind: "issue" as const, target: rec.externalId, kind: "set" as const, field: "label:needs-decision", payload: false, base: true }] : [])] }, now);
  return operation!;
}

/**
 * The heads read for a screen answer's grants (`answerGrantHeads`), put with the answer's operation after the answer was
 * kept: the answer is not held back by the read, and a PR not read stays null. Not a screen answer's operation: nothing.
 */
export function setAnswerHeads(db: Db, operationId: string, heads: GrantHeads): void {
  db.setBacklogAnswerHeads(operationId, heads);
}

/**
 * The newest `## 回答` of Issue n and its sub-issues (a PBI and its Tasks) when the person gave it on the app's screen: its comment
 * was made here with the `screen` mark. null = there is none, or the newest came from GitHub (written there, or imported
 * only), from a saved policy, or was edited after it was given — only the screen's answer is the person's words to the next stage Task.
 * `heads`: the heads its grants are for (answerStoredDecision); absent on an answer taken before answers kept them.
 */
export function screenAnswer(db: Db, source: BacklogSource, n: number): { issue: number; text: string; id: string; heads?: GrantHeads; parts?: string[] } | null {
  const records = shownRecords(db, source);
  const item = records.find((r) => r.objectKind === "issue" && (r.remote as BacklogIssueData | null)?.number === n)?.remote as BacklogIssueData | undefined;
  const want = new Set([n, ...(item?.subIssues ?? [])]);
  const last = records
    .flatMap((r) => {
      const c = r.objectKind === "comment" ? (r.remote as BacklogCommentData | null) : null;
      return c && want.has(c.issue) && c.body.trimStart().startsWith(ANSWER_HEADING) ? [{ id: r.externalId, ...c }] : [];
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (!last) return null;
  // and only as it was given: a comment edited on GitHub after it was sent is not the screen's words any more
  // never an operation taken in from a work machine, whatever it carries: the screen meant is this instance's
  const sent = db.listBacklogOperations(source).find((o) => o.kind === "comment" && o.target === last.id && machineOfOperation(o.id) === null && (o.payload as { screen?: unknown } | null)?.screen === true);
  const given = (sent?.payload as { body?: unknown } | undefined)?.body;
  if (typeof given !== "string" || given.trim() !== last.body.trim()) return null;
  // the heads its grants are for, as kept when it was taken; none kept = an answer taken before answers kept them
  const heads = grantHeadsOf((sent!.payload as { heads?: unknown }).heads);
  // the person's own input as the app took it apart (a chosen option's sentence, the memo), when the answer's text starts with lines of the app's
  const kept = (sent!.payload as { parts?: unknown }).parts;
  const parts = Array.isArray(kept) && kept.every((p) => typeof p === "string") ? (kept as string[]) : undefined;
  return { issue: last.issue, text: given.trimStart().slice(ANSWER_HEADING.length).trim(), id: sent!.id, ...(heads ? { heads } : {}), ...(parts ? { parts } : {}) };
}

/** `## 保留` + text on Issue n, kept here and sent later: the needs-decision label stays (an answer would take it off). */
export function holdStoredDecision(db: Db, source: BacklogSource, n: number, text: string, now = Date.now()): void {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してから保留してください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, text ? `${HOLD_HEADING}\n\n${text}` : HOLD_HEADING, now);
  db.applyBacklogEdit(source, { records: [c.record], operations: [c.op] }, now);
}

/** `## 判断待ち` + text on Issue n, then the needs-decision label on, kept here and sent in that order: answerStoredDecision turned round. */
export function askStoredDecision(db: Db, source: BacklogSource, n: number, text: string, now = Date.now()): void {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してから書いてください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, `${DECISION_HEADING}\n${text}`, now);
  db.applyBacklogEdit(source, { records: [c.record], operations: [c.op, { issue: rec.externalId, targetKind: "issue", target: rec.externalId, kind: "set", field: "label:needs-decision", payload: true, base: false }] }, now);
}

/** A plain comment (text as written, no heading) on Issue n, kept here and sent later; no label changes. */
export function commentStoredIssue(db: Db, source: BacklogSource, n: number, text: string, now = Date.now()): { operation: string } {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してからコメントしてください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, text, now);
  const [operation] = db.applyBacklogEdit(source, { records: [c.record], operations: [c.op] }, now);
  return { operation: operation! };
}

/**
 * Answers confirmation `c.n` of PBI n, kept here: false (nothing stored) when that line of the body shown is
 * no longer an unchecked confirmation with `c.text`. `ok` checks the line (`- [ ]` → `- [x]`, the rest of the body byte
 * for byte, CRLF too; sent with the body it was made on, so a body changed on GitHub meanwhile is held, not overwritten)
 * and says it was confirmed; otherwise the body is left and `reason` is written. The labels are not touched.
 */
export function answerStoredConfirmation(db: Db, source: BacklogSource, n: number, c: { n: number; text: string; ok: boolean; reason: string }, now = Date.now()): boolean {
  refuseSecrets(c.reason);
  const rec = issueRecord(db, source, n);
  const body = rec ? (shown(rec) as BacklogIssueData | null)?.body : undefined;
  const line = body === undefined ? undefined : criteria(body).find((x) => x.n === c.n);
  if (!rec || body === undefined || !line || line.checked || line.text !== c.text || !confirmationsOf(body).some((x) => x.n === c.n)) return false;
  const head = `${ANSWER_HEADING}\n\n受け入れ条件 ${c.n}「${c.text}」`;
  const answer = comment(rec, n, c.ok ? `${head}を確認しました。${c.reason ? `\n\n${c.reason}` : ""}` : `${head}は違います: ${c.reason}`, now, { confirm: { n: c.n, text: c.text } });
  const ops = [answer.op];
  if (c.ok) {
    const lines = body.split("\n");
    lines[line.line] = lines[line.line]!.replace(/^- \[ \]/, "- [x]");
    ops.unshift({ issue: rec.externalId, targetKind: "issue", target: rec.externalId, kind: "set", field: "body", payload: lines.join("\n"), base: body });
  }
  db.applyBacklogEdit(source, { records: [answer.record], operations: ops }, now);
  return true;
}
