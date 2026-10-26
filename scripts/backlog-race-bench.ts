/**
 * bun scripts/backlog-race-bench.ts --fixture   (#927, PBI #899)
 *
 * Replays, against a fake forge, the window the send of 初期方式 A leaves open (#887),
 * and what the read after the write closes of it since #1329 (the history is read back):
 * one field (an Issue's body — the one whose history a revision can be deleted from or evicted out of) edited here
 * (v3) while someone edits it on the forge (v2), at each moment of the send —
 * before the edit here was made and no import told of theirs, before the check read, between the check and the
 * write (and the same with their revision deleted from, or evicted out of, the history before it is read), right after the write, and
 * after a write whose answer was lost. Each moment runs on three forges: GitHub as
 * it is for an Issue's fields (a write replaces whatever is there, and an edit history keeps what it replaced), GitHub
 * as it is for a Project field other than Status (replaces, no history), and one that refuses a write made on a value
 * no longer current (a conditional write — what B asks of the service, or of the one path that writes). Nothing reaches GitHub:
 * no gh is started, the clock is the scenario's. The result says what each side ended with and which value nobody
 * kept. It does not keep anything itself, and a value it does not call lost is kept somewhere it names.
 */
import { parseArgs } from "node:util";
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import { editStoredIssue, type GhRunner } from "../packages/core/src/backlog.ts";
import { sendGithubOperations } from "../packages/core/src/backlog-send.ts";
import { Db } from "../packages/core/src/db.ts";

export type Moment = "notice-lost" | "before-check" | "between-check-and-write" | "history-deleted" | "history-evicted" | "history-unreadable" | "after-write" | "answer-lost";
/**
 * `history-deleted` = between the check and the write, and the content of the revision theirs made is deleted from the
 * history before it is read (GitHub keeps the editor and the time); `history-evicted` = the same, but the revision was
 * pushed out of the history (more than 100 edits: the intermediate edit is removed, nothing of it stays);
 * `history-unreadable` = the same, but the history cannot be read (403, or not every page came back). A timeline event
 * (a title, state, label, milestone, parent or Status change) is neither evicted nor content-deleted: those two moments
 * are the body's and a comment's.
 */
export const MOMENTS: Moment[] = ["notice-lost", "before-check", "between-check-and-write", "history-deleted", "history-evicted", "history-unreadable", "after-write", "answer-lost"];

/** The three values: what both sides started from, the other editor's, and the one made here. */
export const BASE = "v1";
export const REMOTE = "v2";
export const LOCAL = "v3";

/**
 * `github` = a write replaces, and the edit history keeps what it replaced (an Issue's body, title, state, labels,
 * milestone, parent, a Project item's Status); `github-project-field` = replaces, no history (a Project field other
 * than Status); `conditional` = refuses a write made on a value that is no longer current.
 */
export type Forge = "github" | "github-project-field" | "conditional";
export const FORGES: Forge[] = ["github", "github-project-field", "conditional"];

export interface RaceResult {
  moment: Moment;
  forge: Forge;
  /** What the forge has at the end. */
  value: string;
  /** The edit made here: on the forge (done), held as a conflict with the forge's value, refused by the forge's condition, or still pending. */
  local: "done" | "held" | "refused" | "pending";
  /** The other editor's write landed on the forge (false: the forge's condition refused it, and they were told). */
  remoteLanded: boolean;
  /** The send said something about the other edit (a reason on the operation). */
  told: boolean;
  /** Values nobody kept: neither on the forge, nor held here with the edit, nor refused back to whoever made them. */
  lost: string[];
  /** Of the lost-or-held values, those the send's read after the write got back from the history and holds with the edit (`overwritten.value`). */
  recoverable: string[];
  /** The send learned from the history that another editor wrote after the check read, but not what (the revision's content deleted). */
  traced: boolean;
  /** The history could be read (false: the forge has none, or it refused — then the send holds the edit as unverified). */
  historyRead: boolean;
  calls: number;
  writes: number;
}

export interface RaceBenchResult {
  mode: "fixture";
  at: string;
  scenarios: RaceResult[];
  /** On GitHub as it is (the `github` forge): the moments the send told of (held — A's checks, or 1′'s read after the write), the moments a value was lost, and the moments the history gave it back. */
  a: { detects: Moment[]; loses: Moment[]; recovers: Moment[] };
  /** What B needs to close what A loses, read off the runs: nothing when A loses nothing. */
  b: { needs: string[] };
}

const S: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };

type Hook = { phase: "before" | "after"; match: (args: string[]) => boolean; run: () => void };

/**
 * A forge with one Issue and one field, versioned per write. `conditional` = a write is taken only while the version
 * is the one the writer last read (the other editor's `stale` write likewise). `github` keeps a log of every write
 * (who, what, after which version) as GitHub's edit history does; `github-project-field` keeps none. Answers look like
 * gh's with --include.
 */
function forge(kind: Forge, clock: () => number) {
  const cas = kind === "conditional";
  const issue = { id: "I_12", number: 12, body: BASE };
  // what GitHub's edit history keeps: who, after which version, and the value — null once the revision's content was
  // deleted (the editor and the time stay) or evicted (more than 100 edits)
  const log: Array<{ by: "them" | "here"; value: string | null; version: number; at: string }> = [];
  let version = 1;
  let lastRead = 0;
  let checkRead: number | null = null;
  let loseAnswer = false;
  let remoteLanded = false;
  let calls = 0;
  let writes = 0;
  let hook: Hook | null = null;
  let historyRefused = false;
  const ok = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\ndate: ${new Date(clock()).toUTCString()}\n\n${JSON.stringify(body)}`, stderr: "" });
  const refused = (status: number, reason: string) => ({ code: 1, stdout: `HTTP/2.0 ${status} ${reason}\ncontent-type: application/json\n\n{}`, stderr: `HTTP ${status}` });
  const isAfter = (a: string[]) => a.some((x) => x.includes("timelineItems"));
  const isRead = (a: string[]) => !isAfter(a) && a.some((x) => x.includes("issue(number:$n)"));
  const isWrite = (a: string[]) => a.includes("PATCH");
  const fields = () => ({ id: issue.id, title: "PBI", body: issue.body, state: "OPEN", milestone: null, parent: null, labels: { nodes: [] } });
  /** The other editor writes; `stale` = on a value they read before the write made here. */
  const remoteEdit = (value: string, stale = false) => {
    if (cas && stale) return false;
    issue.body = value;
    version++;
    log.push({ by: "them", value, version, at: new Date(clock() + 1000).toISOString() });
    remoteLanded = true;
    return true;
  };
  const fire = (phase: Hook["phase"], args: string[]) => {
    if (!hook || hook.phase !== phase || !hook.match(args)) return;
    const h = hook;
    hook = null;
    h.run();
  };
  const gh: GhRunner = async (args) => {
    calls++;
    fire("before", args);
    let r: { code: number; stdout: string; stderr: string };
    if (isRead(args)) {
      lastRead = version;
      checkRead ??= version;
      r = ok({ data: { repository: { issue: fields() } } });
    } else if (isAfter(args)) {
      // the read after the write (#1329): the value, the history since the check read, the viewer. Every forge gets the
      // body's query (the bench's field is the body); the `github-project-field` forge stands in for a field with no
      // history by answering an empty one, and never refuses (the send reads a real Project field's value only, so a
      // refusal there is not a case). One asked to refuse answers 403
      if (historyRefused && kind !== "github-project-field") r = refused(403, "Forbidden");
      else {
        const since = String(args.find((x) => x.startsWith("s="))?.slice(2) ?? "");
        const edits = kind === "github-project-field" ? [] : log.filter((e) => e.by === "them" && e.version > (checkRead ?? 0) && e.at >= since).map((e) => ({ editedAt: e.at, editor: { login: "them" }, diff: e.value, deletedAt: e.value === null ? e.at : null }));
        r = ok({ data: { viewer: { login: "here" }, repository: { issue: { ...fields(), timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] }, userContentEdits: { pageInfo: { hasNextPage: false }, nodes: edits } } } } });
      }
    } else if (isWrite(args)) {
      const body = args[args.indexOf("-f") + 1]?.replace(/^body=/, "") ?? "";
      if (cas && lastRead !== version) r = refused(412, "Precondition Failed");
      else {
        issue.body = body;
        version++;
        log.push({ by: "here", value: body, version, at: new Date(clock()).toISOString() });
        writes++;
        r = loseAnswer ? ((loseAnswer = false), refused(502, "Bad Gateway")) : ok({});
      }
    } else throw new Error(`the bench's forge does not answer: ${args.slice(0, 2).join(" ")}`);
    fire("after", args);
    return r;
  };
  return {
    gh, issue, isWrite, remoteEdit,
    at: (h: Hook) => (hook = h),
    loseNextAnswer: () => (loseAnswer = true),
    state: () => ({ remoteLanded, calls, writes, hasHistory: kind !== "github-project-field" }),
    refuseHistory: () => (historyRefused = true),
    deleteTheirRevisions: () => log.forEach((e) => { if (e.by === "them") e.value = null; }),
    evictTheirRevisions: () => { for (let i = log.length - 1; i >= 0; i--) if (log[i]!.by === "them") log.splice(i, 1); },
  };
}

/** One moment against one forge: the edit here is sent (and sent again after an outage) and the ends are read. */
export async function replay(moment: Moment, kind: Forge): Promise<RaceResult> {
  const db = new Db(":memory:");
  let t = 1_000_000;
  const f = forge(kind, () => t);
  const issue: BacklogIssueData = { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: BASE, labels: [], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue, fetchState: "fetched" }], cursor: null, syncedAt: 1 });
  // the other editor wrote before the edit here was made, and no notice or import brought it: the edit is made on v1
  if (moment === "notice-lost") f.remoteEdit(REMOTE);
  editStoredIssue(db, S, 12, { body: LOCAL }, t);
  if (moment === "before-check") f.remoteEdit(REMOTE);
  if (moment === "between-check-and-write") f.at({ phase: "before", match: f.isWrite, run: () => f.remoteEdit(REMOTE) });
  // theirs lands in the window, and its revision is gone from the history before the read after the write
  if (moment === "history-deleted") f.at({ phase: "before", match: f.isWrite, run: () => { f.remoteEdit(REMOTE); f.deleteTheirRevisions(); } });
  if (moment === "history-evicted") f.at({ phase: "before", match: f.isWrite, run: () => { f.remoteEdit(REMOTE); f.evictTheirRevisions(); } });
  // theirs is in the history, but the history cannot be read after the write
  if (moment === "history-unreadable") f.at({ phase: "before", match: f.isWrite, run: () => { f.remoteEdit(REMOTE); f.refuseHistory(); } });
  // theirs lands right after the write here, made on what they read before it
  if (moment === "after-write") f.at({ phase: "after", match: f.isWrite, run: () => f.remoteEdit(REMOTE, true) });
  if (moment === "answer-lost") {
    f.loseNextAnswer();
    f.at({ phase: "after", match: f.isWrite, run: () => f.remoteEdit(REMOTE) });
  }
  const send = () => sendGithubOperations(f.gh, db, "/work/app", S, () => t);
  await send();
  if (moment === "answer-lost") {
    t += 10 * 60_000; // the wait after the outage has passed
    await send();
  }
  try {
    const op = db.listPendingBacklogOperations(S)[0];
    const { remoteLanded, calls, writes, hasHistory } = f.state();
    const held = op?.status === "conflict";
    const found = held ? op!.overwritten : null;
    // what the send holds of theirs: the value it got back, a trace of the edit without its value, or that the history
    // could not be read — each is told, so the value is not lost without a word (#1329, the user's answer 4)
    const recoverable = found && "value" in found ? [String(found.value)] : [];
    const traced = Boolean(found && !("value" in found) && !found.unreadable);
    const unreadable = Boolean(found?.unreadable);
    const lost: string[] = [];
    if (remoteLanded && f.issue.body !== REMOTE && !(held && ((op!.error ?? "").includes(REMOTE) || recoverable.includes(REMOTE) || traced || unreadable))) lost.push(REMOTE);
    if (!op && f.issue.body !== LOCAL) lost.push(LOCAL);
    return {
      moment, forge: kind, value: f.issue.body,
      local: !op ? "done" : held ? "held" : op.status === "failed" ? "refused" : "pending",
      remoteLanded, told: Boolean(op?.error), lost, recoverable, traced, historyRead: hasHistory && !unreadable, calls, writes,
    };
  } finally {
    db.close();
  }
}

export async function runBacklogRaceBench(): Promise<RaceBenchResult> {
  const scenarios: RaceResult[] = [];
  for (const kind of FORGES) for (const moment of MOMENTS) scenarios.push(await replay(moment, kind));
  const asIs = scenarios.filter((s) => s.forge === "github");
  const noHistory = scenarios.filter((s) => s.forge === "github-project-field");
  const needs: string[] = [];
  // what the send does not close yet, read off the runs: a lost value in the window on the forge as GitHub is would
  // need a conditional write (none exists) or the history read back; a refused write that ends failed would need a re-check
  if (asIs.some((s) => s.moment === "between-check-and-write" && s.lost.length)) needs.push("a write refused when the value it was made on is no longer current (a conditional write), or the value it replaced read back after the write (an edit history)");
  if (scenarios.some((s) => s.forge === "conditional" && s.local === "refused")) needs.push("a refused write checked again and held as a conflict, not failed");
  // a field with no history: nothing closes the window there
  if (noHistory.some((s) => s.lost.length && !s.recoverable.length)) needs.push("for a field with no edit history (a Project field other than Status) nothing gives the value back: the window stays unless that field is written from one path only");
  // the history can lose the value too: a revision deleted keeps who and when (held as such), one evicted past 100 edits keeps nothing
  if (asIs.some((s) => s.moment === "history-deleted" && s.lost.length)) needs.push("a revision deleted from the history before it is read gives no value back: the conflict can only say that someone wrote, and when — whether that still counts as not lost is the user's decision");
  if (asIs.some((s) => s.moment === "history-evicted" && s.lost.length)) needs.push("a revision evicted from the history (past 100 edits) before it is read leaves nothing: the window stays for it, as for a field with no history");
  // the read itself can fail: then nothing is known either way, and the send must say so, not call the write done
  if (asIs.some((s) => s.moment === "history-unreadable" && s.lost.length)) needs.push("a history that cannot be read (refused, or not every page came back) tells nothing: the write must be held as unverified, not done or failed");
  return {
    mode: "fixture", at: new Date().toISOString(), scenarios,
    a: { detects: asIs.filter((s) => s.told).map((s) => s.moment), loses: asIs.filter((s) => s.lost.length).map((s) => s.moment), recovers: asIs.filter((s) => s.recoverable.length).map((s) => s.moment) },
    b: { needs },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { fixture: { type: "boolean" } } });
  if (!values.fixture) {
    console.error("usage: bun scripts/backlog-race-bench.ts --fixture");
    process.exit(2);
  }
  console.log(JSON.stringify(await runBacklogRaceBench(), null, 2));
}
