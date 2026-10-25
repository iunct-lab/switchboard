/**
 * Turning a workspace's GitHub sync on (#2266): a backlog kept here only (#2265), or one whose sync was turned off
 * (#2299), goes to GitHub without losing what was made here. Each step is decided from the stored data, so a press that
 * failed halfway goes on from where it stopped at the next one:
 *
 * 1. a backlog kept here only reads GitHub's into GitHub's key, then its records move there and its source becomes
 *    GitHub's with `enabling` (one transaction); one turned off loses `disabled` and gets `enabling`
 * 2. each Issue made here only (an `sb:` record) gets a `create`, sent as any other (backlog-send.ts; its marker keeps a
 *    lost answer from making it twice) — without its body and parent: a `#N` in them names Switchboard's numbers
 * 3. once every one is made (every create done), the numbers are kept in `numbers` (Switchboard's → GitHub's), the
 *    stage Tasks and the comments made here follow them
 * 4. then the bodies, parents and comments made here are sent with `#N` rewritten to GitHub's numbers (`queued`), and
 *    once they are, `enabling` comes off
 */
import type { BacklogCommentData, BacklogIssueData, BacklogProjectItemData, BacklogSource } from "@switchboard/protocol";
import type { BacklogOperation, Db, NewBacklogOperation } from "./db.ts";
import { BacklogError, type BacklogCreatePayload, type BacklogWorkspace, type GhRunner } from "./backlog.ts";
import { importGithubSnapshot } from "./backlog-sync.ts";

/** A create of turning the sync on: the Issue's number here, its body and parent (sent once every Issue has GitHub's number). */
export type EnablingCreatePayload = BacklogCreatePayload & { former: { number: number; body: string; parent: number | null } };

const formerOf = (o: BacklogOperation) => (o.kind === "create" ? ((o.payload as Partial<EnablingCreatePayload>).former ?? null) : null);

/** The creates of the turning on under way (made since it began). */
const enablingCreates = (db: Db, source: BacklogSource) =>
  source.enabling ? db.listBacklogOperations(source).filter((o) => formerOf(o) && o.createdAt >= source.enabling!.since) : [];

/**
 * What is not sent while the Issues made here are being made on GitHub: everything but their creates — a body or a
 * comment made while the sync was off may name one of them by Switchboard's number, rewritten once GitHub has numbered
 * them all (`queued`).
 */
export const enablingWaits = (source: BacklogSource | null, op: BacklogOperation) => !!source?.enabling && !source.enabling.queued && !formerOf(op);

/** How far the turning on is: the Issues made here only to make on GitHub, and those made; null = not under way. */
export function enablingOf(db: Db, source: BacklogSource | null): { total: number; done: number } | null {
  if (!source?.enabling) return null;
  const creates = enablingCreates(db, source);
  return { total: creates.length, done: creates.filter((o) => o.status === "done").length };
}

/** The Issues made here only, by number. */
const localIssues = (db: Db, source: BacklogSource) =>
  db.listBacklogRecords(source, "issue").flatMap((r) => {
    const v = (r.remote ?? r.local) as BacklogIssueData | null;
    return r.externalId.startsWith("sb:") && v ? [{ id: r.externalId, value: v }] : [];
  }).sort((a, b) => a.value.number - b.value.number);

/**
 * Turns the workspace's GitHub sync on, or goes on with it (step 1 and 2 above). `ws.projectVar` = the Project a backlog
 * kept here only is to read (null = SWITCHBOARD_PROJECT_URL). Throws BacklogError when GitHub cannot be read: nothing
 * is changed then. Returns how far it is.
 */
export async function enableGithubSync(gh: GhRunner, db: Db, ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">, now = Date.now()): Promise<{ total: number; done: number }> {
  let source = db.getWorkspaceBacklogSource(ws.id);
  if (source?.service === "switchboard") {
    const read = await importGithubSnapshot(gh, db, ws, now, undefined, true);
    if (!read.project) throw new BacklogError("GitHub の Project を読めませんでした");
    const from = source;
    const to: BacklogSource = { ...read.key, project: read.project, enabling: { since: now } };
    source = db.sqlite.transaction(() => {
      // another press moved it while this one read GitHub: that one's turning on goes on
      const cur = db.getWorkspaceBacklogSource(ws.id);
      if (cur?.service !== "switchboard" || cur.repository !== from.repository) return cur;
      db.moveBacklogRecords(from, to);
      // the variable first: setting it forgets the source, which is written next
      db.setWorkspaceProjectVar(ws.id, ws.projectVar ?? null);
      db.setWorkspaceBacklogSource(ws.id, to);
      return to;
    })();
  } else if (source?.disabled) {
    // every checkout of the repository is turned on with it, as they were turned off (they share the records); a
    // turning on that was under way when it was turned off goes on as it was, whichever checkout began it
    const all = sharing(db, source);
    const enabling = all.map((w) => db.getWorkspaceBacklogSource(w)?.enabling).find((e) => e) ?? { since: now };
    for (const w of all) {
      const { disabled: _, ...on } = db.getWorkspaceBacklogSource(w)!;
      db.setWorkspaceBacklogSource(w, { ...on, enabling });
    }
    source = db.getWorkspaceBacklogSource(ws.id)!;
  }
  if (!source?.enabling) return { total: 0, done: 0 };
  queueCreates(db, source, now);
  // the press is the user's "again": what waits for its time after an outage (a create, a body, a comment) goes now,
  // and a create GitHub refused (a Milestone it does not have, tries used up) is tried once more — what refused it may
  // have been put right meanwhile
  for (const o of db.listPendingBacklogOperations(source)) if (o.status === "pending" && o.retryAt) db.setBacklogOperationResult(o.id, { status: "pending", retryAt: null }, now);
  for (const o of enablingCreates(db, source)) if (o.status === "failed") db.setBacklogOperationResult(o.id, { status: "pending", attempt: 0, retryAt: null, error: null }, now);
  return enablingOf(db, source)!;
}

/** The workspaces whose records are the repository's of `source` (another checkout of it too). */
const sharing = (db: Db, source: BacklogSource) =>
  db.listWorkspaces().flatMap((w) => {
    const s = db.getWorkspaceBacklogSource(w.id);
    return s && s.service === source.service && s.host === source.host && s.repository === source.repository ? [w.id] : [];
  });

/** A create for each Issue made here only that has none waiting (step 2): its fields as they are, no body, no parent. */
function queueCreates(db: Db, source: BacklogSource, now: number): void {
  db.sqlite.transaction(() => {
    const waiting = new Set(db.listPendingBacklogOperations(source).flatMap((o) => (o.kind === "create" ? [o.target] : [])));
    const items = db.listBacklogRecords(source, "project-item").flatMap((r) => (r.externalId.startsWith("sb:") && r.remote ? [r.remote as BacklogProjectItemData] : []));
    for (const { id, value: i } of localIssues(db, source)) {
      if (waiting.has(id)) continue;
      const fields = items.find((it) => it.issue === i.number)?.fields;
      const payload: EnablingCreatePayload = {
        title: i.title, body: "", state: i.state, labels: i.labels, milestone: i.milestone, parent: null,
        project: fields ? { owner: source.project.owner, number: source.project.number, fields } : null,
        former: { number: i.number, body: i.body, parent: i.parent },
      };
      db.applyBacklogEdit(source, { records: [], operations: [{ issue: id, targetKind: "issue", target: id, kind: "create", payload }] }, now);
    }
  })();
}

/**
 * `#N` in a text, by the numbers Switchboard gave and GitHub's (#2266): each one once (a number it gave is not
 * rewritten again). `owner/repo#N`, a URL's `/issues/N`, `&#N;` and a number not in the map stay.
 */
export function renumberRefs(text: string, numbers: Array<{ from: number; to: number }>): string {
  const to = new Map(numbers.map((n) => [n.from, n.to]));
  return text.replace(/(?<![\w/#&-])#(\d+)\b/g, (m, n: string) => (to.has(Number(n)) ? `#${to.get(Number(n))}` : m));
}

/**
 * Step 3 and 4, after a send (BacklogSync.send). Once every create of it is done: keeps the numbers GitHub gave, moves
 * the stage Tasks made before the turning on and the comments made here to them, drops the Project items kept here
 * (GitHub has its own now), and queues each made Issue's body and parent and the comments made here, their `#N`
 * rewritten, and what waits to be sent with `#N` in it is rewritten too — "queued", to be sent. Once those are sent
 * (no comment made here is left, no body or parent of a made Issue waits), the turning on ends — "ended", and GitHub is
 * to be read again. Otherwise null.
 */
export function advanceEnabling(db: Db, workspaceId: string, now = Date.now()): "queued" | "ended" | null {
  return db.sqlite.transaction(() => {
    const source = db.getWorkspaceBacklogSource(workspaceId);
    // an Issue GitHub made keeps GitHub's id at once (its Project item, parent and state after it): every create done
    const creates = source?.enabling ? enablingCreates(db, source) : [];
    if (!source?.enabling || localIssues(db, source).length || creates.some((o) => o.status !== "done")) return null;
    if (source.enabling.queued) {
      const made = new Set(creates.map((o) => o.target));
      const waiting = db.listPendingBacklogOperations(source).some((o) => (o.kind === "comment" && o.target.startsWith("sb:")) || (o.kind === "set" && made.has(o.target) && (o.field === "body" || o.field === "parent")));
      if (waiting || db.listBacklogRecords(source, "comment").some((r) => r.externalId.startsWith("sb:"))) return null;
      for (const w of sharing(db, source)) {
        const { enabling, ...done } = db.getWorkspaceBacklogSource(w)!;
        if (enabling) db.setWorkspaceBacklogSource(w, done);
      }
      return "ended";
    }
    const made = creates.flatMap((o) => {
      const to = ((db.getBacklogRecord({ ...source, objectKind: "issue", externalId: o.target })?.remote ?? null) as BacklogIssueData | null)?.number;
      return to ? [{ from: formerOf(o)!.number, to }] : [];
    });
    // a comment made here is on the Issue its operation names (GitHub's id since the create), not on a number: GitHub
    // may have an Issue of the number it had here
    const onIssue = new Map(db.listBacklogOperations(source).flatMap((o) => (o.kind === "comment" ? [[o.target, o.issue] as const] : [])));
    for (const r of db.listBacklogRecords(source, "comment")) {
      const c = r.remote as BacklogCommentData | null;
      const issue = r.externalId.startsWith("sb:") ? onIssue.get(r.externalId) : undefined;
      const n = c && issue ? ((db.getBacklogRecord({ ...source, objectKind: "issue", externalId: issue })?.remote ?? null) as BacklogIssueData | null)?.number : undefined;
      if (c && n && n !== c.issue) db.setBacklogRecordRemote({ ...source, objectKind: "comment", externalId: r.externalId }, { ...c, issue: n });
    }
    for (const r of db.listBacklogRecords(source, "project-item")) if (r.externalId.startsWith("sb:")) db.deleteBacklogRecord({ ...source, objectKind: "project-item", externalId: r.externalId });
    // each checkout of the repository: its stage Tasks and its source
    let numbers = made;
    for (const w of sharing(db, source)) {
      const { enabling, ...rest } = db.getWorkspaceBacklogSource(w)!;
      if (!enabling) continue;
      db.renumberStageIssues(w, made, enabling.since);
      const kept = rest.numbers ?? [];
      numbers = [...kept, ...made.filter((n) => !kept.some((k) => k.from === n.from && k.to === n.to))];
      db.setWorkspaceBacklogSource(w, { ...rest, numbers, enabling: { ...enabling, queued: true } });
    }
    queueFollowUps(db, source, creates, numbers, now);
    return "queued";
  })();
}

/**
 * Step 4: what the creates left out, now that every Issue has GitHub's number — each made Issue's body and parent, then
 * the comments made here, oldest first, `#N` rewritten by `numbers`; and the body edits and comments already waiting
 * (made while the sync was off) get their `#N` rewritten. A `#N` GitHub's own Issues wrote is not touched.
 */
function queueFollowUps(db: Db, source: BacklogSource, creates: BacklogOperation[], numbers: Array<{ from: number; to: number }>, now: number): void {
  const to = new Map(numbers.map((n) => [n.from, n.to]));
  for (const o of db.listPendingBacklogOperations(source)) {
    if (o.kind === "comment") db.setBacklogOperationPayload(o.id, { ...(o.payload as { body: string }), body: renumberRefs((o.payload as { body: string }).body, numbers) }, now);
    else if (o.kind === "set" && o.field === "body" && typeof o.payload === "string") db.setBacklogOperationPayload(o.id, renumberRefs(o.payload, numbers), now);
  }
  const ops: NewBacklogOperation[] = [];
  for (const o of creates) {
    const { body, parent } = formerOf(o)!;
    const issue = (db.getBacklogRecord({ ...source, objectKind: "issue", externalId: o.target })?.remote ?? null) as BacklogIssueData | null;
    if (!issue) continue;
    if (body) ops.push({ issue: o.target, targetKind: "issue", target: o.target, kind: "set", field: "body", payload: renumberRefs(body, numbers), base: issue.body });
    if (parent !== null) ops.push({ issue: o.target, targetKind: "issue", target: o.target, kind: "set", field: "parent", payload: to.get(parent) ?? parent, base: issue.parent });
  }
  // the Issue a comment is on: GitHub's record of its number (none of Switchboard's is left)
  const issueIds = new Map(db.listBacklogRecords(source, "issue").flatMap((r) => {
    const n = (r.remote as BacklogIssueData | null)?.number;
    return n && !r.externalId.startsWith("sb:") ? [[n, r.externalId] as const] : [];
  }));
  const commenting = new Set(db.listPendingBacklogOperations(source).flatMap((o) => (o.kind === "comment" ? [o.target] : [])));
  for (const r of db.listBacklogRecords(source, "comment").filter((r) => r.externalId.startsWith("sb:")).sort((a, b) => a.externalId.localeCompare(b.externalId))) {
    const c = r.remote as BacklogCommentData | null;
    const issue = c ? issueIds.get(c.issue) : undefined;
    if (!c || !issue || commenting.has(r.externalId)) continue;
    ops.push({ issue, targetKind: "comment", target: r.externalId, kind: "comment", payload: { body: renumberRefs(c.body, numbers) } });
  }
  if (ops.length) db.applyBacklogEdit(source, { records: [], operations: ops }, now);
}
