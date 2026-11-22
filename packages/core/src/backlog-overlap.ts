/**
 * The overlap: two PBIs whose Tasks name the same files do not run side by side. Whose turn it is (from the comments
 * the stage Tasks leave and the stored pull requests), the mark on an item that waits for another's turn
 * (`withOverlap`), and the lines the screens show for it.
 */
import type { BacklogIssueData, BacklogItem } from "@switchboard/protocol";
import { holder, judge, othersOf, STALE_HOURS, topWith, turnsAhead, waitsOnlyForCheck, type Turn } from "../../../scripts/parallel-guard.ts";
import { overlaps, pathsIn } from "../../../ops-kit/src/task-paths.ts";
import { readdirSync } from "node:fs";
import { type Comment, PBI_COMPLETE_MARK } from "./backlog-comments.ts";

/**
 * What `pathsIn` answered, by the body and the names it read against: a pure function's result, so the same input is the
 * same answer. Oldest first out past the limit. The arrays are shared between reads: a caller copies before it changes one.
 */
const PATHS_MEMO_MAX = 4000;
const pathsMemo = new Map<string, readonly string[]>();
/** `pathsIn` against these names through the memo; the names part of the key is built once per reader. */
function pathsReader(names: ReturnType<typeof topWith>): (body: string) => string[] {
  const prefix = `${names.map((t) => `${t.dir ? "/" : ""}${t.name}`).join("\0")}\0\0`;
  return (body) => {
    const key = prefix + body;
    const hit = pathsMemo.get(key);
    if (hit) return hit as string[];
    const paths = pathsIn(body, names);
    pathsMemo.set(key, paths);
    if (pathsMemo.size > PATHS_MEMO_MAX) pathsMemo.delete(pathsMemo.keys().next().value!);
    return paths;
  };
}

/** An item whose 実装 would touch what other work touches, or cannot be judged. */
export const isOverlapped = (i: BacklogItem) => !!i.overlap && (i.overlap.hits.length > 0 || i.overlap.unknown !== null);

/** Why the given overlapped items are not started, as the log and the refusals word it: the touching ones, then the ones that cannot be judged. */
export function overlapLine(items: BacklogItem[]): string[] {
  const out: string[] = [];
  const touching = items.filter((i) => i.overlap!.hits.length > 0);
  if (touching.length) out.push(`重なり: ${touching.map((i) => `#${i.number}（${i.overlap!.hits.map((h) => (h.turn !== undefined ? `順番待ち: #${h.turn}（${h.path}）` : `${h.ref}: ${h.path}`)).join("・")}）`).join(" ")}`);
  const undecided = items.filter((i) => i.overlap!.unknown !== null);
  if (undecided.length) out.push(`重なりを判定できない: ${undecided.map((i) => `#${i.number}（${i.overlap!.unknown}）`).join(" ")}`);
  return out;
}

/**
 * One line per other work (`overlap.hits`' ref) that stops the given items, the one stopping the most PBIs first (a PBI counted once; the same
 * count in the order of `ref`): "<ref> が <n> 件を止めている（作業中 | 作業していない）". The queue's log says it so a person sees whom to wait for or free.
 */
export function overlapHolderLines(items: BacklogItem[]): string[] {
  const by = new Map<string, { pbis: Set<number>; working: boolean }>();
  for (const i of items) for (const h of i.overlap?.hits ?? []) {
    // a place ahead is no one's work under way: the 重なり line names the PBI waited for
    if (h.turn !== undefined) continue;
    const e = by.get(h.ref) ?? { pbis: new Set<number>(), working: false };
    e.pbis.add(i.number);
    e.working ||= h.working;
    by.set(h.ref, e);
  }
  return [...by].sort(([a, x], [b, y]) => y.pbis.size - x.pbis.size || (a < b ? -1 : a > b ? 1 : 0)).map(([ref, e]) => `${ref} が ${e.pbis.size} 件を止めている（${e.working ? "作業中" : "作業していない"}）`);
}

/** Whether a line of `leftLines` is one of the overlap's: `overlapLine`'s or `overlapHolderLines`'. */
export const isOverlapLine = (line: string) => /^(重なり|(?:Task|PR) #\d+ が \d+ 件を止めている)/.test(line);

/** The overlap lines (`isOverlapLine`) of a `leftLines`, each under `head` (a workspace's name and a slot, as the log says it). */
export const overlapLinesUnder = (head: string, lines: string[]): string[] => lines.filter(isOverlapLine).map((l) => `${head}${l}`);

/**
 * Swap in `lines`, in place, the overlap lines this workspace and slot put in at the first read (`before`) for those of a
 * later read (`after`; both from `overlapLinesUnder`): after a firing's starts a holder's count and the 重なり lines are said as
 * the reread counts them, none left from the first read. One line is taken out for each of `before`, so a line another
 * workspace of the same name put in (the same text) stays; the head is no key, the name is not unique.
 */
export function swapOverlapLines(lines: string[], before: string[], after: string[]): void {
  for (const line of before) {
    const k = lines.lastIndexOf(line);
    if (k >= 0) lines.splice(k, 1);
  }
  lines.push(...after);
}

type OverlapTurn = { since: string; waits: number[]; last: string };

/**
 * The place a PBI holds after yielding on an overlap, from its /pbi-complete marks oldest first: `since` = its first
 * release with `overlap=` of the run that still lasts, `waits` = every number those releases named, `last` = its newest
 * mark. A claim or a takeover in between keeps the place (the PBI is at work on what it waited for); a release without
 * `overlap=` ends it. null = it holds none.
 */
export function overlapTurnOf(comments: Comment[]): OverlapTurn | null {
  // the next place is made by a function of the place so far: written in the loop, the place's type would depend on itself
  const yielded = (held: OverlapTurn | null, at: string, list: string): OverlapTurn => ({ since: held?.since ?? at, waits: [...new Set([...(held?.waits ?? []), ...list.split(",").map(Number)])], last: at });
  let turn: OverlapTurn | null = null;
  for (const c of comments) {
    const m = PBI_COMPLETE_MARK.exec(c.body);
    if (!m) continue;
    const list = m[1] === "release" ? /^overlap=(\d+(?:,\d+)*)$/.exec(m[2] ?? "")?.[1] : undefined;
    if (list) turn = yielded(turn, c.createdAt, list);
    else if (m[1] === "release") turn = null;
    else if (turn) turn.last = c.createdAt;
  }
  return turn;
}

type StoredPull = { number: number; isDraft: boolean; labels: string[]; closes: number[]; updatedAt: string; files: string[] | null; state: string };

/** A Task the session of its PBI does not start: in review or done, or with an open PR of its own (what is left is the review and the merge). */
const reviewOnly = (n: number, pulls: StoredPull[], statuses: Map<number, string | number | null>) =>
  statuses.get(n) === "In review" || statuses.get(n) === "Done" || pulls.some((p) => p.state === "OPEN" && p.closes.includes(n));

/**
 * The places of the PBIs that yielded on an overlap (`overlapTurnOf`), oldest first: for each, the paths its Tasks not
 * in review yet name that what it yielded to touches (an In progress one too: the PBI keeps its place once its Task is
 * claimed, so the guard in the Task does not count every later place ahead of a PBI that has none and defer what the app started) (a PR's files, a Task's body and its PRs' files, closed ones too) —
 * only those, so a PBI that touches something else is not held. A PBI that cannot move now holds none, and gets its place
 * back with the same `since` once it can: not Ready / in progress (a question holds it), `on-hold`, waiting for a date,
 * a prerequisite not met, its stage Task only waiting for a planned resume (`parked`), or no mark for STALE_HOURS (a
 * session that died does not hold the line), or the queue does not resume it (`notResumed`: backlog-pick.ts — not moved since
 * its last resume, waiting for a reply, failed with no update since, stopped the same way again). A closed PBI is not an item, and a Task that no longer names the path gives none.
 * `withOverlap` further leaves out the place of a PBI that cannot start for the places before its own.
 * `yieldsTo`: the PBIs of what it still waits for (an open PR's Tasks' parents, an open Task's parent), which its place
 * does not hold back: holding them back would keep the one it waits for from moving. Once that is closed, it holds them again.
 */
export function turnWorks(items: BacklogItem[], issues: Map<number, BacklogIssueData>, pulls: StoredPull[], statuses: Map<number, string | number | null>, commentsOf: (n: number) => Comment[], taskPaths: (n: number) => string[], now: number, parked: (pbi: number) => boolean = () => false, notResumed: (i: BacklogItem) => boolean = () => false): Turn[] {
  const out: Turn[] = [];
  for (const i of items) {
    if (i.type !== "pbi" || (i.stage !== "ready" && i.stage !== "in-progress") || i.onHold || (!!i.waitsUntil && !i.waitsUntil.met) || i.prereqs.some((p) => p.state !== "met") || parked(i.number)) continue;
    const turn = overlapTurnOf(commentsOf(i.number));
    if (!turn || now - Date.parse(turn.last) > STALE_HOURS * 3600_000 || notResumed(i)) continue;
    const held = turn.waits.flatMap((n) => {
      const pr = pulls.find((p) => p.number === n);
      return pr ? pr.files ?? [] : [...taskPaths(n), ...pulls.filter((p) => p.closes.includes(n)).flatMap((p) => p.files ?? [])];
    });
    const yieldsTo = [...new Set(turn.waits.flatMap((n) => {
      const pr = pulls.find((p) => p.number === n);
      const tasks = pr ? (pr.state === "OPEN" ? pr.closes : []) : issues.get(n)?.state === "OPEN" ? [n] : [];
      return tasks.map((t) => issues.get(t)?.parent);
    }).filter((n): n is number => typeof n === "number" && n !== i.number))];
    for (const task of issues.get(i.number)?.subIssues ?? []) {
      if (issues.get(task)?.state !== "OPEN" || reviewOnly(task, pulls, statuses)) continue;
      const paths = taskPaths(task).filter((p) => held.some((q) => overlaps(p, q)));
      if (paths.length) out.push({ pbi: i.number, since: turn.since, task, paths, ...(yieldsTo.length ? { yieldsTo } : {}) });
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since) || a.pbi - b.pbi);
}

/**
 * Whether a session works on a PBI: its stage Task runs (`active`), or a claim of /pbi-complete that no release ended
 * (`holder`). Without the comments it cannot be told, and a PBI whose last read was not complete may have a claim not
 * stored yet: both count as worked on. A claim written while a stage Task of the PBI ran that has ended since (`ended`:
 * the claim's time falls between that Task's start and end) was left by it, ended without a release (an error, a stop):
 * it is no session at work, when no stage Task runs now. A claim written after the end (a hand outside the app) or one whose time cannot be read still counts.
 * Reads no value of the repository.
 */
export function sessionOn(opts: { active?: (pbi: number) => boolean; commentsOf?: (n: number) => Comment[]; unread?: (n: number) => boolean; ended?: (pbi: number, at: number) => boolean }): (pbi: number) => boolean {
  return (pbi) => {
    if ((opts.active?.(pbi) ?? false) || !opts.commentsOf || (opts.unread?.(pbi) ?? false)) return true;
    const comments = opts.commentsOf(pbi);
    const h = holder(comments.map((c, k) => ({ id: k, body: c.body })));
    if (h === null) return false;
    const at = Date.parse(comments[h.id]?.createdAt ?? "");
    return !(opts.ended && Number.isFinite(at) && opts.ended(pbi, at));
  };
}

/**
 * Gives each Ready / in-progress PBI the files its Tasks name that other work touches too, by the functions the guard in
 * the Task uses (scripts/parallel-guard.ts: `othersOf`, `turnsAhead`, `judge`; ops-kit/src/task-paths.ts: `pathsIn`) read
 * from the stored records, so that backlog-next does not start a session that would only find the overlap itself, and a
 * session it does start is not deferred by that guard. The other work: `othersOf` (ready PRs, Tasks at work, the Draft of
 * a Task at work), where a Task at work is an In progress Task of another PBI that is not `needs-decision`, whose PBI has a stage Task running
 * (`active`) or a claim of /pbi-complete that no release ended (`holder`; a Task with no PBI always counts, and so does any
 * Task when `commentsOf` is not given or its PBI's last read was not complete, `unread`), and every open
 * Task of a PBI whose stage Task runs now (`active`), before its Status says so. Not at work: an In progress Task of a PBI nobody works on, a Task of a PBI that waits
 * for a date, one that only waits for a check (`waitsOnlyForCheck`), the unstarted Tasks of a PBI whose stage Task only has
 * a resume planned. Then the places ahead of the PBI's own (`turnWorks`: a PBI that yielded goes before one that came
 * later; a hit on one carries `turn`). An overlap only on `sharedFiles` does not count. A PR whose files are not all
 * stored cannot be judged (`unknown`). `root` = the checkout, whose top level the paths in a Task's body are read against.
 *
 * Judged per Task the session would start: one that can start (`startable`) and is not `reviewOnly`. One free Task lets
 * the PBI go, and the free ones are kept in `freeTasks` for the prompt; with none that can start, the Tasks left to do as
 * one. A PBI with nothing left to start (every open Task in review) is not held. Returns the places it kept (a PBI the queue does not resume, `notResumed`, has none): `turnWorks`'
 * places in the order they yielded, less those of a PBI whose Tasks all overlap the places kept before its own (it
 * waits for one of them; other work, a PR or a Task, does not drop it). Such a PBI holds no place, so two PBIs that yielded to each other do not wait
 * for each other: the one the pick takes first starts, and its Tasks at work then hold the other (a place does not hold back
 * the PBIs it waits for, `yieldsTo`, so with each waiting for the other neither place decides). The place comes back with the same `since` once the PBI can start. The judgement of
 * every item and the list returned (the guard in the Task reads it) use the kept places only.
 */
export function withOverlap(items: BacklogItem[], issues: Map<number, BacklogIssueData>, startable: Map<number, number[]>, pulls: StoredPull[], statuses: Map<number, string | number | null>, root: string, opts: { active?: (pbi: number) => boolean; parked?: (pbi: number) => boolean; commentsOf?: (n: number) => Comment[]; unread?: (n: number) => boolean; ended?: (pbi: number, at: number) => boolean; sharedFiles?: string[]; notResumed?: (i: BacklogItem) => boolean } = {}): Turn[] {
  const active = opts.active ?? (() => false);
  const mine = items.filter((i) => i.type === "pbi" && (i.stage === "ready" || i.stage === "in-progress"));
  if (!mine.length) return [];
  let rootTop: { name: string; dir: boolean }[] = [];
  try {
    rootTop = readdirSync(root, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    // the checkout is gone: the top level comes from the PRs' files only
  }
  const prs = pulls.filter((p) => p.state === "OPEN").map((p) => ({ number: p.number, linked: p.closes, updatedAt: p.updatedAt, files: p.files, isDraft: p.isDraft, labels: p.labels }));
  const names = topWith(rootTop, prs);
  const pathsFor = pathsReader(names);
  const taskPaths = (n: number) => pathsFor(issues.get(n)?.body ?? "");
  // a Task of a PBI that waits for a date is not at work: nothing of it changes before the date
  const dated = new Set(items.filter((i) => !!i.waitsUntil && !i.waitsUntil.met).map((i) => i.number));
  const linked = pulls.map((p) => ({ state: p.state, linked: p.closes }));
  const holds = (t: BacklogIssueData) => t.state === "OPEN" && t.labels.includes("type:task") && !t.labels.includes("needs-decision") && !waitsOnlyForCheck(t.number, linked);
  const now = new Date();
  // an In progress Task counts only where a session works on its PBI (`sessionOn`); one left In progress by a check that was still to come blocks no one
  const worked = sessionOn(opts);
  const inProgress = [...issues.values()].filter((t) => holds(t) && statuses.get(t.number) === "In progress" && !(t.parent !== null && dated.has(t.parent)) && (t.parent === null || worked(t.parent)));
  // a PBI whose stage Task runs now: its open child Tasks are the other work too, even while their Status is not In progress yet
  const started = [...issues.values()]
    .filter((m) => m.state === "OPEN" && m.labels.includes("type:pbi") && active(m.number))
    .flatMap((m) => m.subIssues.flatMap((n) => {
      const t = issues.get(n);
      return t && holds(t) && !inProgress.includes(t) ? [{ ...t, updatedAt: now.toISOString() }] : [];
    }));
  const working = [...inProgress, ...started];
  // one PBI's Tasks judged against the other work and the places `ahead` of its own (`placesOnly`: against the places alone): null = nothing to judge
  const judgeOf = (i: BacklogItem, ahead: Turn[], placesOnly = false) => {
    const subs = issues.get(i.number)?.subIssues ?? [];
    const todo = subs.filter((n) => issues.get(n)?.state === "OPEN" && !reviewOnly(n, pulls, statuses));
    const all = todo.flatMap(taskPaths);
    if (!all.length) return null;
    const free = (startable.get(i.number) ?? []).filter((n) => todo.includes(n));
    const { others, unknown } = placesOnly ? { others: [], unknown: [] } : othersOf(new Set<number>([i.number, ...subs]), { prs, working }, names, pathsFor);
    const against = [...others, ...turnsAhead(ahead, i.number)];
    const judged = (free.length ? free.map((task) => ({ task: task as number | null, paths: taskPaths(task) })) : [{ task: null, paths: all }])
      .map((j) => ({ ...j, blocking: judge({ paths: j.paths }, against, now, opts.sharedFiles).blocking }));
    return { judged, unknown };
  };
  // the places in the order they yielded; one whose PBI cannot start for the places kept before it (not for other work) is left out (it gets
  // the place back with the same `since` once it can), so a PBI waiting for a place that is not held is not held back by it
  const turns: Turn[] = [];
  const byPbi = new Map<number, Turn[]>();
  for (const t of opts.commentsOf ? turnWorks(items, issues, pulls, statuses, opts.commentsOf, taskPaths, now.getTime(), opts.parked, opts.notResumed) : []) byPbi.set(t.pbi, [...(byPbi.get(t.pbi) ?? []), t]);
  for (const [pbi, own] of byPbi) {
    const item = mine.find((m) => m.number === pbi);
    const r = item ? judgeOf(item, turns, true) : null;
    if (!r || r.judged.some((j) => !j.blocking.length)) turns.push(...own);
  }
  // whether a hit's other side is at work now: a Task = its PBI's stage Task runs (`active`), a PR = updated within
  // STALE_HOURS (judge never lets an older one block); a place ahead is not work
  const atWork = (h: { ref: string; updatedAt: string; turn?: number }) => {
    if (h.turn !== undefined) return false;
    if (h.ref.startsWith("PR #")) return now.getTime() - Date.parse(h.updatedAt) <= STALE_HOURS * 3600_000;
    const parent = issues.get(Number(h.ref.slice("Task #".length)))?.parent ?? null;
    return parent !== null && active(parent);
  };
  for (const i of mine) {
    const r = judgeOf(i, turns);
    if (!r) continue;
    const { judged, unknown } = r;
    const go = judged.filter((j) => !j.blocking.length);
    const seen = new Set<string>();
    const hits = (go.length ? [] : judged.flatMap((j) => j.blocking))
      .filter((h) => !seen.has(`${h.ref} ${h.path}`) && !!seen.add(`${h.ref} ${h.path}`))
      .map((h) => ({ ref: h.ref, path: h.path, working: atWork(h), ...(h.turn !== undefined ? { turn: h.turn } : {}) }));
    i.overlap = hits.length || unknown.length ? { hits, unknown: unknown.length ? unknown.map((n) => `PR #${n} の変更ファイルが記録に無い`).join("・") : null } : null;
    // a Task with no path named cannot be judged by the guard in the Task: it lets the PBI go, but is not named to start from
    if (!i.overlap) i.freeTasks = go.flatMap((j) => (j.task !== null && j.paths.length ? [j.task] : []));
  }
  return turns;
}
