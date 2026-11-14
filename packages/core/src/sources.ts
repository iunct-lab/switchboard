import type { CreatedIssue, SourceRow, SourceView } from "@switchboard/protocol";
import { speakerOf } from "../../../ops-kit/src/lint.ts";
import type { StoredRecords } from "../../../ops-kit/src/backlog-client.ts";
import { revertedShas } from "../../../scripts/merge-audit.ts";
import { readStoredRecords } from "./backlog.ts";
import { deferredTasksSince, scheduledIssuesSince, type Db } from "./db.ts";
import { median, requestOf, type FlowWorkspace } from "./flow.ts";

const DAY = 86_400_000;
/** A request still open with no PBI after this many days is "stale" (shown in the table's heading). */
export const STALE_DAYS = 14;
/** A bug filed this many days after a PBI closed, naming it or its PR, is rework on it. */
export const REWORK_DAYS = 14;
const ORDER: SourceRow["speaker"][] = ["利用者", "エージェント", "定期の検査", "読めない"];
const UNKNOWN_ROUTE = "不明";

/** The route a request names in its `- 経路:` line, cut before the first parenthesis (the rest is free text); null when it has none. */
export function routeLineOf(body: string): string | null {
  const m = /^- 経路: *(.*)$/m.exec(body.replace(/\r\n/g, "\n"));
  const route = m?.[1]?.split(/[（(]/)[0]?.trim();
  return route ? route : null;
}

const emptyRow = (repo: string, speaker: SourceRow["speaker"], route: string | null): SourceRow => ({ repo, speaker, route, opened: 0, planned: 0, dropped: 0, delivered: 0, daysToDeliver: null, stale: 0, reverted: 0, followUpBugs: 0 });

export type MainCommit = { sha: string; message: string; at: number };

/**
 * The commits of the default branch (`origin/HEAD`, else `origin/main`) in the clone at `path` since `since` (ms); null when git cannot
 * read either (no clone, nothing fetched). Run without blocking the event loop.
 */
export async function mainCommits(path: string, since: number): Promise<MainCommit[] | null> {
  for (const ref of ["refs/remotes/origin/HEAD", "origin/main"]) {
    const p = Bun.spawn(["git", "-C", path, "log", ref, `--since=${new Date(since).toISOString()}`, "--format=%H%x00%cI%x00%B%x1e"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) continue;
    return out.split("\x1e").map((x) => x.replace(/^\n/, "")).filter(Boolean).map((x) => {
      const [sha, at, ...message] = x.split("\0");
      return { sha: sha!, at: Date.parse(at!), message: message.join("\0") };
    });
  }
  return null;
}

/**
 * The rework of each delivered PBI: `reverted` = the PRs (else commits) of it that a commit on main took back, and `followUpBugs` = the `bug` Issues (not Tasks)
 * created from its close to `REWORK_DAYS` later that name `#<PBI>` or `#<PR>` of a PR that closed one of its Tasks. A PR is found from the stored `mergeCommit`,
 * else from the `(#N)` ending the commit's subject (a Task or the PBI, as a rebase merge writes it).
 */
export function reworkOf(records: StoredRecords, commits: MainCommit[], deliveredPbis: number[], now: number): Map<number, { reverted: number; followUpBugs: number }> {
  const byNumber = new Map(records.issues.map((i) => [i.number, i]));
  const pbiOf = (n: number): number | null => {
    const i = byNumber.get(n);
    if (!i) return null;
    if (i.labels.includes("type:pbi")) return n;
    return i.parent !== null && byNumber.get(i.parent)?.labels.includes("type:pbi") ? i.parent : null;
  };
  const delivered = new Set(deliveredPbis);
  const prsOf = new Map<number, number[]>();
  for (const p of records.pulls) for (const pbi of new Set(p.closes.map(pbiOf))) if (pbi !== null && delivered.has(pbi)) prsOf.set(pbi, [...(prsOf.get(pbi) ?? []), p.number]);
  const byMergeCommit = new Map(records.pulls.flatMap((p) => (p.mergeCommit ? [[p.mergeCommit, p] as const] : [])));
  const taken = new Map<number, Set<string>>();
  const take = (pbi: number | null, key: string) => {
    if (pbi !== null && delivered.has(pbi)) taken.set(pbi, (taken.get(pbi) ?? new Set()).add(key));
  };
  for (const c of commits) {
    for (const short of revertedShas(c.message)) {
      // as merge-audit reads it: only a commit on main was merged work (a revert inside a PR's branch names a pre-rebase commit), and a short sha with two on main is not read
      const onMain = commits.filter((o) => o.sha.startsWith(short));
      if (onMain.length !== 1) continue;
      const full = onMain[0]!;
      const pr = byMergeCommit.get(full.sha);
      if (pr) {
        for (const closed of pr.closes) take(pbiOf(closed), `pr${pr.number}`);
        continue;
      }
      const n = Number(/\(#(\d+)\)\s*$/.exec(full.message.split("\n")[0]!)?.[1]);
      if (n) take(pbiOf(n), `#${n}`);
    }
  }
  const bugs = records.issues.filter((i) => i.labels.includes("bug") && !i.labels.includes("type:task")).map((i) => ({ at: Date.parse(i.createdAt), body: i.body }));
  const out = new Map<number, { reverted: number; followUpBugs: number }>();
  for (const pbi of delivered) {
    const closedAt = Date.parse(byNumber.get(pbi)?.closedAt ?? "");
    const names = [pbi, ...(prsOf.get(pbi) ?? [])].map((n) => new RegExp(`#${n}\\b`));
    const end = Math.min(now, closedAt + REWORK_DAYS * DAY);
    const followUpBugs = Number.isNaN(closedAt) ? 0 : bugs.filter((b) => b.at >= closedAt && b.at <= end && names.some((re) => re.test(b.body))).length;
    out.set(pbi, { reverted: taken.get(pbi)?.size ?? 0, followUpBugs });
  }
  return out;
}

/**
 * What became of the requests opened in the last `days` days of one repository, by who said them (`- 誰の言葉:`; none of the three = 読めない) and,
 * for the scheduled checks and the agent, by route as well (`routeOf` = the schedule that opened it, else the `- 経路:` line, else 不明). `deferred` are
 * the Tasks put off with the Issues they opened: those of this repository are the 派生 row (`opened` only). Counted from the stored values and `commits` (main's, since the period began less `REWORK_DAYS`).
 */
export function sourceRows(
  records: StoredRecords,
  routeOf: (repo: string, number: number) => string | null,
  deferred: Array<{ endedAt: number; issues: CreatedIssue[] }>,
  days: number,
  now: number,
  commits: MainCommit[],
): SourceRow[] {
  const repo = records.repository;
  const pbisOf = new Map<number, StoredRecords["issues"]>();
  for (const i of records.issues) {
    if (!i.labels.includes("type:pbi")) continue;
    const req = requestOf(i.body);
    if (req !== null) pbisOf.set(req, [...(pbisOf.get(req) ?? []), i]);
  }
  const inPeriod = (r: StoredRecords["issues"][number]) => {
    const created = Date.parse(r.createdAt);
    return r.labels.includes("type:request") && created >= now - days * DAY && created <= now;
  };
  const deliveredPbis = records.issues.filter(inPeriod).flatMap((r) => pbisOf.get(r.number) ?? []).filter((p) => p.state === "CLOSED" && p.stateReason === "COMPLETED");
  const rework = reworkOf(records, commits, deliveredPbis.map((p) => p.number), now);
  const parents = new Map<SourceRow["speaker"], SourceRow>();
  const children = new Map<string, SourceRow>();
  const waits = new Map<SourceRow, number[]>();
  const rowOf = (speaker: SourceRow["speaker"], route: string | null): SourceRow => {
    if (route === null) {
      if (!parents.has(speaker)) parents.set(speaker, emptyRow(repo, speaker, null));
      return parents.get(speaker)!;
    }
    const key = `${speaker}\0${route}`;
    if (!children.has(key)) children.set(key, emptyRow(repo, speaker, route));
    return children.get(key)!;
  };
  for (const r of records.issues) {
    if (!inPeriod(r)) continue;
    const created = Date.parse(r.createdAt);
    const speaker = (speakerOf(r.body) ?? "読めない") as SourceRow["speaker"];
    const rows = [rowOf(speaker, null)];
    if (speaker === "定期の検査" || speaker === "エージェント") rows.push(rowOf(speaker, routeOf(repo, r.number) ?? routeLineOf(r.body) ?? UNKNOWN_ROUTE));
    const pbis = pbisOf.get(r.number) ?? [];
    const closed = r.state === "CLOSED";
    const delivered = closed && pbis.length > 0 && pbis.every((p) => p.state === "CLOSED" && p.stateReason === "COMPLETED");
    for (const row of rows) {
      row.opened++;
      if (pbis.length > 0) row.planned++;
      if (delivered) {
        row.delivered++;
        for (const p of pbis) {
          row.reverted += rework.get(p.number)?.reverted ?? 0;
          row.followUpBugs += rework.get(p.number)?.followUpBugs ?? 0;
        }
        if (r.closedAt) waits.set(row, [...(waits.get(row) ?? []), (Date.parse(r.closedAt) - created) / DAY]);
      } else if (closed) row.dropped++;
      else if (pbis.length === 0 && now - created > STALE_DAYS * DAY) row.stale++;
    }
  }
  for (const [row, w] of waits) row.daysToDeliver = median(w);
  const derived = emptyRow(repo, "派生", null);
  for (const t of deferred) {
    if (t.endedAt < now - days * DAY || t.endedAt > now) continue;
    derived.opened += t.issues.filter((i) => i.repo === repo.toLowerCase()).length;
  }
  const byOpened = (a: SourceRow, b: SourceRow) => b.opened - a.opened || (a.route ?? "").localeCompare(b.route ?? "");
  const rows = ORDER.flatMap((s) => [...(parents.has(s) ? [parents.get(s)!] : []), ...[...children.values()].filter((c) => c.speaker === s).sort(byOpened)]);
  return derived.opened > 0 ? [...rows, derived] : rows;
}

/**
 * `sourceRows` for every repository the workspaces stand on (one read of the stored records each; a workspace never imported is in `unread`).
 * The route of an Issue is the schedule whose Task opened it (the oldest such Task when two named it). The reads are synchronous, so the
 * event loop is given back between them (a read of the whole store takes seconds, none of the steps more than about two).
 */
export async function sourceView(db: Db, workspaces: FlowWorkspace[], days = 30, now = Date.now()): Promise<SourceView> {
  const since = now - days * DAY;
  const routes = new Map<string, string>();
  for (const s of scheduledIssuesSince(db.sqlite, since)) for (const i of s.issues) if (!routes.has(`${i.repo}#${i.number}`)) routes.set(`${i.repo}#${i.number}`, s.schedule);
  const routeOf = (repo: string, number: number) => routes.get(`${repo.toLowerCase()}#${number}`) ?? null;
  const unread: string[] = [];
  const byRepo = new Map<string, FlowWorkspace[]>();
  for (const w of workspaces) {
    if (!w.repository) unread.push(w.name);
    else byRepo.set(w.repository.toLowerCase(), [...(byRepo.get(w.repository.toLowerCase()) ?? []), w]);
  }
  const rows: SourceRow[] = [];
  for (const ws of byRepo.values()) {
    await Bun.sleep(0);
    const records = readStoredRecords(db, ws[0]!);
    if (!records) {
      unread.push(...ws.map((w) => w.name));
      continue;
    }
    let commits: MainCommit[] | null = null;
    for (const w of ws) if ((commits = await mainCommits(w.path, since - REWORK_DAYS * DAY)) !== null) break;
    // git unread: the rows stay with no rework, and the workspaces are listed as not read
    if (commits === null) unread.push(...ws.map((w) => w.name));
    await Bun.sleep(0);
    const deferred = deferredTasksSince(db.sqlite, ws.map((w) => w.id), since);
    await Bun.sleep(0);
    rows.push(...sourceRows(records, routeOf, deferred, days, now, commits ?? []));
  }
  return { days, now, staleDays: STALE_DAYS, reworkDays: REWORK_DAYS, rows, unread };
}

/** The most `days` values `SourceCache` holds at once: the screen asks for one, so another value read drops the oldest instead of growing the store. */
export const SOURCE_CACHE_KEYS = 4;

/**
 * `sourceView` held for an hour per `days` (a read takes seconds on the whole store), at most `SOURCE_CACHE_KEYS` of them, and dropped when the
 * workspaces' repositories changed. Asks that come while a read of the same `days` and scope is going wait for it instead of reading again.
 */
export class SourceCache {
  private held = new Map<number, { view: SourceView; scope: string }>();
  private reading = new Map<string, Promise<SourceView>>();
  constructor(private readonly read: (days: number, now: number) => Promise<SourceView>, private readonly scope: () => string, private readonly ttlMs = 3_600_000, private readonly clock = () => Date.now()) {}

  get(days: number): Promise<SourceView> {
    const now = this.clock();
    const scope = this.scope();
    const hit = this.held.get(days);
    if (hit && hit.scope === scope && now - hit.view.now < this.ttlMs) return Promise.resolve(hit.view);
    const key = `${days}\0${scope}`;
    const going = this.reading.get(key);
    if (going) return going;
    const reading = this.read(days, now).then((view) => {
      this.held.delete(days);
      this.held.set(days, { view, scope });
      for (const k of this.held.keys()) if (this.held.size > SOURCE_CACHE_KEYS) this.held.delete(k);
      return view;
    }).finally(() => this.reading.delete(key));
    this.reading.set(key, reading);
    return reading;
  }
}
