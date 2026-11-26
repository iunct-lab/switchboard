/**
 * The backlog queue's stall: a firing that could start nothing (the queue enabled, none of its PBIs' 実装 Tasks running,
 * nothing left for the usage limit), since when it lasts, and what other work holds the queued PBIs back. The queue keeps
 * it (`BacklogQueue.stall`); what the person is told of it is made from that record.
 */
import type { Ask, BacklogItem, BacklogQueue, QueueStallHolder } from "@switchboard/protocol";
import { policyPbi, unanswered } from "./asks.ts";
import { changeRepoOf, parseMergeGrants } from "./merge-grants.ts";

/** How many holders the stall keeps. */
export const STALL_HOLDERS_KEEP = 10;

/**
 * The other work that holds the queued items back on an overlap (`overlap.hits`), one per workspace and ref, the one
 * holding the most PBIs first (a PBI counted once; the same count in the order of the workspace, then the ref), at most
 * `STALL_HOLDERS_KEEP`. Counted as `overlapHolderLines` counts (a PBI the gate holds too, which the log names on the gate's
 * line instead of the overlap's), and a place waited for (`turn`) counts too, as
 * `#N の順番` (its `pbi` = N, `working` = null: no one's work under way).
 */
export function stallHolders(read: Array<{ workspaceId: string; items: BacklogItem[] }>): QueueStallHolder[] {
  const by = new Map<string, QueueStallHolder>();
  for (const { workspaceId, items } of read) {
    for (const i of items) {
      for (const h of i.overlap?.hits ?? []) {
        const ref = h.turn !== undefined ? `#${h.turn} の順番` : h.ref;
        const key = `${workspaceId}\0${ref}`;
        const e = by.get(key) ?? { workspaceId, ref, pbi: h.turn ?? h.pbi, held: [], working: h.turn !== undefined ? null : false };
        if (!e.held.includes(i.number)) e.held.push(i.number);
        if (h.turn === undefined) e.working ||= h.working;
        by.set(key, e);
      }
    }
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...by.values()]
    .sort((a, b) => b.held.length - a.held.length || order(a.workspaceId, b.workspaceId) || order(a.ref, b.ref))
    .slice(0, STALL_HOLDERS_KEEP);
}

/**
 * The stall after a firing: while it starts nothing (`stalled`) the first firing's time stays and the holders are the
 * latest; a firing that is not stalled ends it (null).
 */
export function nextStall(prev: BacklogQueue["stall"], firing: { stalled: boolean; holders: QueueStallHolder[] }, now: number): BacklogQueue["stall"] {
  if (!firing.stalled) return null;
  return { since: prev?.since ?? now, holders: firing.holders };
}

/** How many holders the notice names. */
export const STALL_HOLDERS_SHOWN = 3;

/** The questions a person answers that a stalled queue lists, and how each is named in its line. */
const PERSON_KINDS: Partial<Record<Ask["kind"], string>> = { decision: "判断待ち", check: "返事待ち", stop: "止まり", approval: "許可待ち" };

type PbiRef = { number: number; title: string; url: string };

/** `キューが <h> 時間 <m> 分止まっています` (no hours under one). */
const stalledFor = (ms: number): string => {
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  return `キューが ${h ? `${h} 時間 ` : ""}${min % 60} 分止まっています`;
};

/**
 * The notice of a stalled queue (`notice:queue-stall@<since>`), or null: only while the queue is enabled, its stall
 * (`BacklogQueue.stall`) has lasted `limitMs`, and none of its 実装 Tasks runs (`running`) — each is read again here, so
 * one that changed since the last firing takes it away. It names the holders holding the most PBIs (top 3) and the
 * questions the person has to answer (`needs: "person"`, open or held, a decision / check / stop / approval, and a stop
 * `staleGrant` marks though it waits by itself) of a PBI in the queue or of a holder's PBI, the most held first: held =
 * the PBIs its PBI's holders hold in its workspace and those that wait for its PBI (`unblocks` / `waiting`), each once.
 * `staleGrant`: the stop asks again for a PR the person allowed its Task (its head moved since; `headMoved`). No answer
 * is taken on the notice itself.
 */
export function queueStallAsk(input: {
  queue: BacklogQueue;
  running: number;
  limitMs: number;
  now: number;
  asks: Ask[];
  /** The PBI `number` of a workspace, as stored; null = not found. */
  pbiOf: (workspaceId: string, number: number) => PbiRef | null;
  /** Where a holder's `ref` (`PR #N`, `Task #N`, `#N の順番`) opens; null = nowhere known. */
  refUrl: (workspaceId: string, ref: string) => string | null;
  staleGrant: (a: Ask) => boolean;
  workspaceName: (id: string) => string | null;
}): Ask | null {
  const { queue, now } = input;
  const stall = queue.stall;
  if (!queue.enabled || !stall || input.running > 0 || now - stall.since < input.limitMs) return null;
  const where = (id: string) => ({ id, name: input.workspaceName(id) ?? id });
  const holders = [...stall.holders].sort((a, b) => b.held.length - a.held.length).slice(0, STALL_HOLDERS_SHOWN).map((h) => ({
    workspace: where(h.workspaceId),
    ref: h.ref,
    url: input.refUrl(h.workspaceId, h.ref),
    pbi: h.pbi === null ? null : input.pbiOf(h.workspaceId, h.pbi),
    held: h.held.length,
    working: h.working,
  }));
  const key = (w: string, n: number) => `${w}#${n}`;
  const queued = new Set(queue.items.map((e) => key(e.workspaceId, e.number)));
  const holderPbis = new Set(stall.holders.flatMap((h) => (h.pbi === null ? [] : [key(h.workspaceId, h.pbi)])));
  const person = input.asks.flatMap((a) => {
    const kind = PERSON_KINDS[a.kind];
    const n = policyPbi(a);
    const ws = a.workspace?.id;
    if (!kind || (a.state !== "open" && a.state !== "held") || n === null || !ws) return [];
    if (!queued.has(key(ws, n)) && !holderPbis.has(key(ws, n))) return [];
    // a stop that asks again for what the person allowed waits by itself (`needs: "auto"`), yet only the person moves it
    const headMoved = input.staleGrant(a);
    if (a.needs !== "person" && !headMoved) return [];
    const held = new Set([...stall.holders.filter((h) => h.workspaceId === ws && h.pbi === n).flatMap((h) => h.held), ...a.unblocks.map((p) => p.number), ...a.waiting.map((p) => p.number)]);
    const text = (a.question ?? a.reason ?? "").split("\n")[0]!.slice(0, 80);
    return [{
      askId: a.id,
      workspace: { id: ws, name: a.workspace!.name },
      pbi: a.pbi ?? input.pbiOf(ws, n) ?? { number: n, title: `#${n}`, url: a.issue?.url ?? "" },
      label: text ? `${kind}: ${text}` : kind,
      taskId: a.task?.id ?? a.source.taskId ?? null,
      url: a.source.url ?? a.issue?.url ?? null,
      held: held.size,
      headMoved,
      at: a.at,
    }];
  });
  person.sort((a, b) => b.held - a.held || a.at - b.at);
  const title = stalledFor(now - stall.since);
  return {
    ...unanswered,
    id: `notice:queue-stall@${stall.since}`,
    kind: "notice",
    needs: "person",
    state: "open",
    at: stall.since,
    changedAt: stall.since,
    workspace: null,
    pbi: null,
    issue: null,
    task: null,
    reason: "始められる PBI が無い（実装の Task 0 件）",
    question: title,
    choices: [],
    recommendation: null,
    next: "返事は各行の Task か Issue で",
    source: { label: "バックログのキュー", url: null, taskId: null },
    route: "none",
    conditions: [],
    answers: [],
    stall: { since: stall.since, holders, person: person.map(({ at: _at, ...p }) => p) },
  };
}

/**
 * Whether a stop asks again for a PR the person allowed its Task: an open (or held) stop whose `grant` names a merge /
 * answer grant, of which the person's grant to the same Task, repository, kind and PR is on record with a head
 * (`lastOwnerGrant`). A grant on record answers the stop for its head (the gate lets the merge through), so a stop that
 * still asks for it means the PR's head has moved since. No time is compared: a stop asked again keeps its series' first
 * time. `own`: the repository a sentence that names none is for (the workspace's backlog repository). GitHub is not asked.
 */
export function staleGrant(a: Pick<Ask, "kind" | "state" | "grant" | "task" | "workspace">, own: string | null, lastOwnerGrant: (taskId: string, repo: string, kind: string, target: number) => { at: number; head: string } | null): boolean {
  const taskId = a.task?.id;
  if (a.kind !== "stop" || (a.state !== "open" && a.state !== "held") || !a.grant || !taskId) return false;
  const ws = a.workspace?.id ?? null;
  return parseMergeGrants(a.grant).some((g) => {
    const repo = g.change ? (ws ? changeRepoOf(ws) : null) : (g.repo ?? own);
    return !!repo && lastOwnerGrant(taskId, repo, g.kind, g.target) !== null;
  });
}
