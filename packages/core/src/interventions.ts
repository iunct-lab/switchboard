import type { BacklogIssueData, EventEnvelope, BacklogRepositoryKey, Intervention, InterventionReason, InterventionUnknown, InterventionView, InterventionWindow, StopRecord, Workspace } from "@switchboard/protocol";
import { ANSWER_HEADING, waitsOf } from "./backlog.ts";
import { withoutMarker } from "./backlog-merge.ts";
import type { Db } from "./db.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import { NEEDS_PERSON, placeKey, stopKey } from "./stops.ts";

/**
 * A person's interventions (#651): approvals, decisions, resumes and allows after the classifier (#2236, not observed yet), counted at each look from Switchboard's records (the
 * tasks and their events) and the stored copy of the Issues (#885). No table of their own and no call to GitHub; what the
 * records cannot tell is `unknown`, not 0 and not guessed.
 */

/** The same `## 回答` on one Issue within this is one answer sent twice. */
export const ANSWER_DUPLICATE_MS = 10 * 60_000;
/** The same message to one task, or the same Issue started again, within this is one. */
export const SEND_DUPLICATE_MS = 60_000;

const PREFIX_RESOLVED = '{"t":"permission.resolved",';
const PREFIX_ASK = '{"t":"permission.ask",';
const PREFIX_STOP = '{"t":"stop.record",';
const PREFIX_USER_SAY = '{"t":"message.delta","role":"user"';

type IssueInfo = { data: BacklogIssueData; comments: Array<{ id: string; body: string; createdAt: string }> };
/** Whether an Issue or PR is still open, and when it ended (ms; null = not kept, as for one stored before `closedAt` was). */
type End = { open: boolean; at: number | null };
type Repository = { key: BacklogRepositoryKey; issues: Map<number, IssueInfo>; ends: Map<number, End> };

/** A repository as the last import stored it; null = never imported (so nothing of it is known). */
function readRepository(db: Db, ws: Pick<Workspace, "id">): Repository | null {
  const key = db.getWorkspaceBacklogSource(ws.id);
  if (!key || db.getBacklogRepository(key)?.lastSuccessfulSync == null) return null;
  const issues = new Map<number, IssueInfo>();
  const ends = new Map<number, End>();
  const comments = new Map<number, IssueInfo["comments"]>();
  for (const r of db.listBacklogRecords(key)) {
    if (r.objectKind === "issue" && r.remote && r.fetchState === "fetched" && r.remote.number > 0) {
      issues.set(r.remote.number, { data: r.remote, comments: [] });
      ends.set(r.remote.number, { open: r.remote.state === "OPEN", at: r.remote.closedAt ? Date.parse(r.remote.closedAt) : null });
    } else if (r.objectKind === "pull-request" && r.remote && r.fetchState === "fetched") {
      const at = r.remote.mergedAt ?? r.remote.closedAt;
      ends.set(r.remote.number, { open: r.remote.state === "OPEN", at: at ? Date.parse(at) : null });
    } else if (r.objectKind === "comment" && r.remote) comments.set(r.remote.issue, [...(comments.get(r.remote.issue) ?? []), { id: r.externalId, body: r.remote.body, createdAt: r.remote.createdAt }]);
  }
  for (const [n, list] of comments) if (issues.has(n)) issues.get(n)!.comments = list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { key, issues, ends };
}

/** The Issue a Task worked on: the stage Task's, or the `#N ` its title starts with. */
const issueOfTask = (t: { title: string; stageIssue: number | null }): number | null => t.stageIssue ?? (/^#(\d+) /.exec(t.title)?.[1] ? Number(/^#(\d+) /.exec(t.title)![1]) : null);

/**
 * Every intervention, oldest first, and what could not be counted. An intervention on an Issue needs the stored Issue (to name
 * its PBI): without it — the workspace never imported, or the Issue not stored in full — it is `unknown`.
 */
export function collectInterventions(db: Db, workspaces: Workspace[], read: EventEnvelope[] = db.listEventsByPrefix([PREFIX_ASK, PREFIX_RESOLVED, PREFIX_USER_SAY])): { items: Intervention[]; unknown: InterventionUnknown[]; lookup: InterventionLookup } {
  const items: Intervention[] = [];
  const unknown: InterventionUnknown[] = [];
  const repos = new Map<string, Repository | null>();
  const repoOf = (wsId: string): Repository | null => {
    if (!repos.has(wsId)) repos.set(wsId, readRepository(db, { id: wsId }));
    return repos.get(wsId)!;
  };
  const noted = new Set<string>();
  const note = (workspaceId: string, issue: number | null, why: string, pbi?: number) => {
    const k = `${workspaceId}#${issue}`;
    if (!noted.has(k)) {
      noted.add(k);
      unknown.push(pbi === undefined ? { workspaceId, issue, why } : { workspaceId, issue, why, pbi });
    }
  };
  // a workspace with no import yet (the source is written by the first one): its answers are not stored, so none of them is counted
  for (const ws of workspaces) if (!repoOf(ws.id)) note(ws.id, null, "まだ GitHub から取り込んでいません");

  /** The PBI of an Issue by the stored copy: the Issue itself when it is a PBI, else its parent; null with `known` false = not stored. */
  const pbiOf = (wsId: string, issue: number): { pbi: number | null; known: boolean; why?: string } => {
    const info = repoOf(wsId)?.issues.get(issue);
    if (!info) return { pbi: null, known: false, why: repoOf(wsId) ? "取り込んだ写しに無い Issue" : "まだ GitHub から取り込んでいません" };
    if (info.data.labels.includes("type:pbi")) return { pbi: issue, known: true };
    // a Task whose PBI is not stored in full cannot be placed
    const parent = info.data.parent;
    return parent === null || repoOf(wsId)!.issues.has(parent) ? { pbi: parent, known: true } : { pbi: parent, known: false, why: `親の #${parent} が写しに無い` };
  };
  /** Adds an intervention on `issue` (null = on none): unknown when the Issue's PBI cannot be named. */
  const add = (i: Omit<Intervention, "pbi" | "issue"> & { issue: number | null }) => {
    if (i.issue === null) return void items.push({ ...i, pbi: null });
    const { pbi, known, why } = pbiOf(i.workspaceId, i.issue);
    if (!known) return note(i.workspaceId, i.issue, why!, pbi ?? undefined);
    items.push({ ...i, pbi });
  };

  const tasks = db.listTaskRefs();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // approvals: the person's answer to an ask, once per ask (a second answer is refused with 409, and an adapter's close is by "timeout").
  // An allow to an ask the auto-mode classifier stopped is its own kind (#2236), not also an approval. An ordinary block does not ask;
  // the recorded ask is the classifier's denial limit, answered deny (#3214, docs/design/claude-otel.md)
  const seenAsk = new Set<string>();
  const events = read;
  const byClassifier = new Set<string>();
  for (const e of events) if (e.ev.t === "permission.ask" && e.ev.reason === "classifier") byClassifier.add(`${e.taskId}:${e.ev.id}`);
  for (const e of events) {
    const t = taskById.get(e.taskId);
    if (!t?.workspaceId || e.ev.t !== "permission.resolved" || e.ev.by !== "user") continue;
    const key = `${t.id}:${e.ev.id}`;
    if (seenAsk.has(key)) continue;
    seenAsk.add(key);
    const kind = e.ev.decision === "allow" && byClassifier.has(key) ? "classifier" : "approval";
    add({ kind, at: e.ts, workspaceId: t.workspaceId, issue: issueOfTask(t), taskId: t.id, ref: `task:${t.id}#seq:${e.seq}`, afterWaits: null });
  }

  // decisions in a conversation: the person's second and later messages (chunks of one message are adjacent seqs), not the daemon's own
  const byTask = new Map<string, Array<{ seq: number; ts: number; text: string }>>();
  for (const e of events) if (e.ev.t === "message.delta" && e.ev.role === "user") byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), { seq: e.seq, ts: e.ts, text: e.ev.text }]);
  for (const [taskId, deltas] of byTask) {
    const t = taskById.get(taskId);
    if (!t?.workspaceId) continue;
    const messages: Array<{ seq: number; ts: number; text: string }> = [];
    let lastSeq = -2;
    for (const d of deltas) {
      if (d.seq === lastSeq + 1 && messages.length) messages[messages.length - 1]!.text += d.text;
      else messages.push({ ...d });
      lastSeq = d.seq;
    }
    const said = new Map<string, number>(); // text → when it was last counted
    for (const m of messages.slice(1)) {
      if (m.text.startsWith(AUTO_RESUME_HEAD)) continue;
      const before = said.get(m.text);
      if (before !== undefined && m.ts - before <= SEND_DUPLICATE_MS) continue;
      said.set(m.text, m.ts);
      add({ kind: "decision", at: m.ts, workspaceId: t.workspaceId, issue: issueOfTask(t), taskId, ref: `task:${taskId}#seq:${m.seq}`, afterWaits: null });
    }
  }

  // decisions on GitHub: `## 回答` comments of the stored Issues
  const answered = new Set<string>();
  for (const ws of workspaces) {
    const repo = repoOf(ws.id);
    // one pass per repository: its workspaces read the same comments
    if (!repo || answered.has(repo.key.repository)) continue;
    answered.add(repo.key.repository);
    for (const [n, info] of repo.issues) {
      const said = new Map<string, number>(); // body (without the op marker the daemon adds, which differs per send) → when it was last counted
      for (const c of info.comments) {
        if (!c.body.trimStart().startsWith(ANSWER_HEADING)) continue;
        const at = Date.parse(c.createdAt);
        const body = withoutMarker(c.body).trim();
        const before = said.get(body);
        if (before !== undefined && at - before <= ANSWER_DUPLICATE_MS) continue;
        said.set(body, at);
        add({ kind: "decision", at, workspaceId: ws.id, issue: n, taskId: null, ref: `comment:${c.id}`, afterWaits: null });
      }
    }
  }

  // resumes: a stage Task started by the button (a schedule's backlog-next sets `scheduleId`), once per Issue per minute
  const lastStart = new Map<string, number>();
  for (const t of tasks) {
    if (t.stageIssue === null || t.scheduleId !== null || !t.workspaceId) continue;
    const k = `${t.workspaceId}#${t.stageIssue}`;
    const before = lastStart.get(k);
    lastStart.set(k, t.createdAt);
    if (before !== undefined && t.createdAt - before <= SEND_DUPLICATE_MS) continue;
    add({ kind: "resume", at: t.createdAt, workspaceId: t.workspaceId, issue: t.stageIssue, taskId: t.id, ref: `task:${t.id}`, afterWaits: afterWaits(repoOf(t.workspaceId), t.stageIssue, t.createdAt) });
  }

  return { items: items.sort((a, b) => a.at - b.at), unknown, lookup: lookupOf(workspaces, repoOf) };
}

/** What `summarizeInterventions` asks of the stored Issues. */
export type InterventionLookup = {
  /** The Issue as stored (its URL and PBI); null = not stored in full. */
  issue(workspaceId: string, n: number): { url: string; pbi: number | null } | null;
  /** The repository a workspace's Issues are in — what a PBI number belongs to; the workspace itself when it has none stored. */
  repository(workspaceId: string): string;
  /** Every stored PBI, once per repository. `closedAt` null with `open` false = closed, time not kept. */
  pbis: Array<{ repository: string; number: number; open: boolean; closedAt: number | null; subIssues: number[]; workspaceId: string }>;
};

function lookupOf(workspaces: Workspace[], repoOf: (wsId: string) => Repository | null): InterventionLookup {
  const pbis: InterventionLookup["pbis"] = [];
  const seen = new Set<string>();
  for (const ws of workspaces) {
    const repo = repoOf(ws.id);
    if (!repo || seen.has(repo.key.repository)) continue;
    seen.add(repo.key.repository);
    for (const [number, info] of repo.issues)
      if (info.data.labels.includes("type:pbi")) pbis.push({ repository: repo.key.repository, number, open: info.data.state === "OPEN", closedAt: info.data.closedAt ? Date.parse(info.data.closedAt) : null, subIssues: info.data.subIssues, workspaceId: ws.id });
  }
  return {
    issue: (wsId, n) => {
      const info = repoOf(wsId)?.issues.get(n);
      return info ? { url: info.data.url, pbi: info.data.labels.includes("type:pbi") ? n : info.data.parent } : null;
    },
    repository: (wsId) => repoOf(wsId)?.key.repository ?? wsId,
    pbis,
  };
}

/**
 * Was this start after what the Issue waited for? The newest /pbi-complete mark before the start names what it waited for
 * (`waits=` / `overlap=`); true = every one was closed or merged by then, false = no wait, or one was still open, null =
 * a waited-for record is missing or has no time (stored before `closedAt` was kept).
 */
function afterWaits(repo: Repository | null, issue: number, at: number): boolean | null {
  const info = repo?.issues.get(issue);
  if (!repo || !info) return null;
  const waits = waitsOf(info.comments.filter((c) => Date.parse(c.createdAt) <= at));
  if (!waits) return false;
  let unsure = false;
  for (const n of waits.numbers) {
    const end = repo.ends.get(n);
    if (!end) unsure = true; // not stored
    else if (end.open || (end.at !== null && end.at > at)) return false; // still open at the start
    else if (end.at === null) unsure = true; // closed, but its time was not kept
  }
  return unsure ? null : true;
}

const DAY = 86_400_000;
const EVIDENCE = 5;

/**
 * The interventions and stops of the last `days` days and of the `days` before, by `now`: `[now - days, now)` and
 * `[now - 2 × days, now - days)` — a moment on the edge belongs to the newer one. Pure.
 */
export function summarizeInterventions(items: Intervention[], unknown: InterventionUnknown[], stops: StopRecord[], lookup: InterventionLookup, now: number): InterventionView {
  const keyOf = (wsId: string, pbi: number) => `${lookup.repository(wsId)}#${pbi}`;
  // a stop is its first record (when it began) and its last (how it stands); an answer is on the record that was open when it came
  const byId = new Map<string, { first: StopRecord; last: StopRecord }>();
  for (const r of [...stops].sort((a, b) => a.at - b.at)) byId.set(r.id, { first: byId.get(r.id)?.first ?? r, last: r });
  const list = [...byId.values()].map((s) => ({ ...s, began: s.first.at })).sort((a, b) => a.began - b.began);
  // series → when the person answered it. Only an answer the daemon saw (`seq:`; a runner's pointer to an Issue comment is not
  // proof), and only for the series of the stop that was newest at that place when it came — an answer a later record carried
  // over belongs to the series it was given to (the same rule as `reduceStops`)
  const answeredAt = new Map<string, number[]>();
  for (const s of list) {
    for (const r of [s.first, s.last]) {
      const a = r.answer;
      if (!a?.ref.startsWith("seq:")) continue;
      const owner = list.filter((x) => placeKey(x.last) === placeKey(r) && x.began < a.at).at(-1);
      if (owner && stopKey(owner.last) === stopKey(r)) answeredAt.set(stopKey(r), [...(answeredAt.get(stopKey(r)) ?? []), a.at]);
    }
  }
  const perPbi = new Map<string, number>(); // PBI → every intervention on it, whenever
  for (const i of items) if (i.pbi !== null) perPbi.set(keyOf(i.workspaceId, i.pbi), (perPbi.get(keyOf(i.workspaceId, i.pbi)) ?? 0) + 1);
  const unknownPbis = new Set<string>(); // PBIs with something on them that could not be counted
  const byIssue = new Map(lookup.pbis.flatMap((p) => [p.number, ...p.subIssues].map((n) => [`${p.repository}#${n}`, `${p.repository}#${p.number}`] as const)));
  for (const u of unknown) if (u.issue !== null) { const pbi = byIssue.get(`${lookup.repository(u.workspaceId)}#${u.issue}`); if (pbi) unknownPbis.add(pbi); }
  const stateOf = new Map(lookup.pbis.map((p) => [`${p.repository}#${p.number}`, p]));
  // PBIs an uncounted Issue points to but that are not stored at all: whether they are done is not known, in any window
  const missingPbis = new Set(unknown.flatMap((u) => (u.pbi !== undefined && !stateOf.has(`${lookup.repository(u.workspaceId)}#${u.pbi}`) ? [`${lookup.repository(u.workspaceId)}#${u.pbi}`] : [])));

  const window = (days: 7 | 30, from: number, to: number): InterventionWindow => {
    const inside = (t: number) => t >= from && t < to;
    const mine = items.filter((i) => inside(i.at));
    const byKind = { approval: 0, decision: 0, resume: 0, classifier: 0 };
    for (const i of mine) byKind[i.kind]++;
    const resumes = mine.filter((i) => i.kind === "resume");
    const sections = { open: new Map<string, number>(), done: new Map<string, number>() };
    for (const i of mine) {
      if (i.pbi === null) continue;
      const k = keyOf(i.workspaceId, i.pbi);
      const side = stateOf.get(k)?.open === false ? sections.done : sections.open;
      side.set(k, (side.get(k) ?? 0) + 1);
    }
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    // PBIs closed in the window; one closed with no time kept cannot be placed, so it is unknown in every window
    const closedHere = lookup.pbis.filter((p) => !p.open && p.closedAt !== null && inside(p.closedAt));
    const unplaced = lookup.pbis.filter((p) => !p.open && p.closedAt === null);
    const known = closedHere.filter((p) => !unknownPbis.has(`${p.repository}#${p.number}`));
    const total = known.reduce((n, p) => n + (perPbi.get(`${p.repository}#${p.number}`) ?? 0), 0);
    const here = list.filter((s) => inside(s.began));
    const reasons = new Map<StopRecord["reason"], typeof here>();
    for (const s of here) reasons.set(s.last.reason, [...(reasons.get(s.last.reason) ?? []), s]);
    return {
      days, from, to,
      total: mine.length, byKind,
      unknown: unknown.length,
      reAsks: here.filter((s) => NEEDS_PERSON.has(s.last.reason) && (answeredAt.get(stopKey(s.last)) ?? []).some((at) => at <= s.began)).length,
      resumesAfterWaits: { count: resumes.filter((i) => i.afterWaits === true).length, unknown: resumes.filter((i) => i.afterWaits === null).length },
      open: { pbis: sections.open.size, interventions: sum(sections.open) },
      done: { pbis: sections.done.size, interventions: sum(sections.done) },
      completed: { pbis: known.length, perPbi: known.length ? total / known.length : null, unknownPbis: closedHere.length - known.length + unplaced.length + missingPbis.size },
      reasons: [...reasons].map(([reason, ss]): InterventionReason => {
        const notAuto = (s: (typeof ss)[number]) => s.last.state === "exhausted" || s.last.state === "waiting" || items.some((i) => i.at >= s.began && (s.last.state === "resolved" ? i.at <= s.last.at : true) && (i.taskId === s.last.work.taskId || (s.last.work.issue !== null && i.issue === s.last.work.issue && i.workspaceId === s.last.work.workspaceId)));
        return {
          reason, count: ss.length, notAutoResumed: ss.filter(notAuto).length,
          evidence: [...ss].sort((a, b) => b.began - a.began).slice(0, EVIDENCE).map((s) => {
            const w = s.last.work;
            const info = w.workspaceId && w.issue !== null ? lookup.issue(w.workspaceId, w.issue) : null;
            return { workspaceId: w.workspaceId, issue: w.issue, pbi: info?.pbi ?? null, taskId: w.taskId, url: info?.url ?? null, evidence: s.last.evidence, at: s.began };
          }),
        };
      }).sort((a, b) => b.count - a.count),
    };
  };
  return { now, windows: ([7, 30] as const).map((days) => ({ current: window(days, now - days * DAY, now), previous: window(days, now - 2 * days * DAY, now - days * DAY) })) };
}

/** The view at `now`: the interventions and stops of every task, summarized. */
export function interventionView(db: Db, workspaces: Workspace[], now = Date.now()): InterventionView {
  // one pass over the events for everything this reads
  const events = db.listEventsByPrefix([PREFIX_ASK, PREFIX_RESOLVED, PREFIX_USER_SAY, PREFIX_STOP]);
  const { items, unknown, lookup } = collectInterventions(db, workspaces, events);
  const stops = events.flatMap((e) => (e.ev.t === "stop.record" ? [e.ev.stop] : []));
  return summarizeInterventions(items, unknown, stops, lookup, now);
}
