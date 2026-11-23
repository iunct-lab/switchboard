import { currentRepo } from "./repo.ts";
/**
 * bun scripts/merge-audit.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo <owner/name>] — who lifted which kind of a large PR, per kind.
 * Reads the app's records (`GET /api/merge-records/history`, docs/design/merge-audit.md): the jobs it ran (the merge verdicts, the
 * rechecks and the main review), the person's grants of a head, the PRs it stored and their comments; and main's commits for the
 * reverts. It asks GitHub nothing for this repository (a PR comment is not a key of anything here; besides the app's audit jobs, only
 * `[post-audit]` is read, as the audit's output). Keeps nothing.
 *
 * The first line is the period, the second says from when the records exist (`記録は <日付> から`: before it no job holds a
 * record, so an older period counts nothing). Then one line per kind with anything to count (the default period is the last 7 days,
 * until inclusive); security is one line per group (`security:<group>`):
 *   <kind> 聞いた N / 認めた N / 認めなかった N / 返事まで 中央値 Nh / 再チェックで自動マージ N / 戻された N（#a, #b）
 * After the table, one line `印の欠け: 聞かずに返事 #a / 返事なしでマージ #b` when a PR in the period was answered with no
 * recorded ask, or merged with an ask and no recorded answer; nothing when there are none. And one line `保存に無い PR N 件（#a, #b）`
 * for the PRs the jobs name that the app never stored (opened and closed between two imports: no state, no comments), nothing when
 * there are none. Then one line per route of the weekly post-merge audit (scripts/post-audit.ts), a route with
 * nothing sampled as 0: `監査 <owner/name> <recheck|direct|review> 抜き取り N / finding N / 率 N%`. A recheck-merged PR the
 * audit found something in counts as evidence for the proposals like a revert (`戻された / 監査の指摘`).
 * `--repo` reads another registered repository (default: this one); its reverts come from the API, not from this clone's git.
 * Each table line ends its wait with the sum: `返事まで 中央値 Nh（合計 Nh）` — how long the person was waited for in all.
 * Then the proposals to change merge-gate's split, one `案: …` line each, or `案なし`; with
 * --file-request, one `要望: …` line: 起票した #N / 同じ題の開いた要望 #N があるので起票しない / 案が無いので起票しない.
 * Exit 0 = no proposal / 1 = a proposal / 2 = could not read (the app, git or gh failed).
 *
 * --file-request (the weekly schedule): on exit 1 also file a request Issue (type:request) through scripts/file-request.ts,
 * unless an open request has the same title (the same proposals). The exit code is the same with or without it.
 */
import { type Filed, fileRequest } from "./file-request";
import { MARK_AUTHORS, MERGE_KINDS, RECHECK_KINDS, type MergeKind } from "./merge-gate";
import { rechecksOf, reviewedOf } from "./merge-gate-records.ts";
import { mergeRecordsEnv } from "./merge-records-env.ts";
import { mergeHistory, type MergeHistory } from "../ops-kit/src/merge-records.ts";

/** The weekly post-merge audit's output on a PR: `[post-audit] pass|finding <merge sha>` (scripts/post-audit.ts writes it after the PBI of a finding is filed; the app's audit job keeps its first line too, but only a `pass` there settles the PR — a `finding` is settled by this mark, or by its stored PBI in post-audit's `settleFound`). */
export const POST_AUDIT = /^\[post-audit\] (pass|finding) ([0-9a-f]{40})\b/;

/** `post-audit` has no merge kind (`kinds` is empty) and says its verdict in `verdict`; `sha` is the merge commit it read. */
export type Mark = { kind: "ask" | "yes" | "no" | "recheck" | "post-audit"; kinds: MergeKind[]; sha: string; at: string; verdict?: "pass" | "finding" };
/** `reviewed`: the merge was not a direct one that skipped the main review — what tells a `review` route from a `direct` one (routeOf). */
export interface PrRecord { number: number; mergedAt: string | null; headSha: string; marks: Mark[]; reviewed: boolean }
/** A commit on main that takes merged PRs back: `git revert`, or rollback-pr.ts's tree replacement. */
export interface Revert { sha: string; at: string; reverted: number[] }
export interface Row {
  kind: MergeKind;
  /** `[merge-ask]` marks in the period with this kind (one per head asked). */
  asked: number;
  /** PRs whose latest answer in the period for this kind is yes / no (a PR answered twice — a new head — is one). */
  yes: number;
  no: number;
  /** Median hours from a PR's ask to its answer for this kind; null when no answer had an ask before it. */
  waitHours: number | null;
  /** The same waits summed: how long the person was waited for in all, for the kinds that ask. 0 when none. */
  waitTotalHours: number;
  /** Merged in the period by a verdict whose recheck of this kind passed at the merged head, with no grant of the person's for that head. */
  recheckMerged: number[];
  /** Of recheckMerged, the PRs a revert took back. */
  reverted: number[];
}

// git revert's own line: the full sha and a period (", reversing" for a merge commit). Prose quoting it is not a revert.
const REVERTS = /^This reverts commit ([0-9a-f]{40})(?:\.|, reversing)$/gm;
// scripts/rollback-pr.ts: the subject `revert: <tag> に戻す`, then `<tag>..origin/main:` and one `- <short sha> <subject>`
// line per commit taken back (only the lines right under that header)
const ROLLBACK = /^revert: (\S+) に戻す\n/;
const ROLLBACK_LINE = /^- ([0-9a-f]{7,40}) /;

/** The commits a commit message takes back (as written there: short or full sha). */
export function revertedShas(message: string): string[] {
  const shas = [...message.matchAll(REVERTS)].map((m) => m[1]!);
  const tag = ROLLBACK.exec(message)?.[1];
  if (tag) {
    const lines = message.split("\n");
    const at = lines.indexOf(`${tag}..origin/main:`);
    for (const l of at < 0 ? [] : lines.slice(at + 1)) {
      const m = ROLLBACK_LINE.exec(l);
      if (!m) break;
      shas.push(m[1]!);
    }
  }
  return [...new Set(shas)];
}

export function parseReverts(commits: { sha: string; message: string; at: string }[], prOf: (sha: string) => number[]): Revert[] {
  const reverts: Revert[] = [];
  for (const c of commits) {
    const shas = revertedShas(c.message);
    if (shas.length === 0) continue;
    reverts.push({ sha: c.sha, at: c.at, reverted: [...new Set(shas.flatMap(prOf))].sort((a, b) => a - b) });
  }
  return reverts;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export type Route = "recheck" | "direct" | "review";

/** recheck (a kind lifted by a recheck of the merged head, no yes) → direct (no main review mark: nobody read it) → review. */
export function routeOf(pr: PrRecord): Route {
  if (RECHECK_KINDS.some((k) => recheckMerged(pr, k))) return "recheck";
  return pr.reviewed ? "review" : "direct";
}

/** Merged with this kind lifted by a recheck: its `[recheck] pass` is of the merged head, and no user's yes covered it. */
export function recheckMerged(pr: PrRecord, kind: MergeKind): boolean {
  const marks = pr.marks.filter((m) => m.kinds.includes(kind));
  return pr.mergedAt !== null && marks.some((m) => m.kind === "recheck" && m.sha === pr.headSha) && !marks.some((m) => m.kind === "yes");
}

export function tally(prs: PrRecord[], reverts: Revert[], period: { since: string; until: string }): Row[] {
  const inPeriod = (at: string) => at >= period.since && at < period.until;
  const takenBack = new Set(reverts.flatMap((r) => r.reverted));
  return MERGE_KINDS.map((kind) => {
    const row: Row = { kind, asked: 0, yes: 0, no: 0, waitHours: null, waitTotalHours: 0, recheckMerged: [], reverted: [] };
    const waits: number[] = [];
    for (const pr of prs) {
      const marks = pr.marks.filter((m) => m.kinds.includes(kind));
      const answers = marks.filter((m) => inPeriod(m.at) && (m.kind === "yes" || m.kind === "no"));
      row.asked += marks.filter((m) => inPeriod(m.at) && m.kind === "ask").length;
      // yes / no count PRs by their latest answer; the waits stay per answer (each head asked and answered)
      const last = answers.at(-1);
      if (last) row[last.kind as "yes" | "no"]++;
      for (const m of answers) {
        const ask = marks.filter((a) => a.kind === "ask" && a.at <= m.at).at(-1);
        if (ask) waits.push((Date.parse(m.at) - Date.parse(ask.at)) / 3_600_000);
      }
      if (pr.mergedAt && inPeriod(pr.mergedAt) && recheckMerged(pr, kind)) {
        row.recheckMerged.push(pr.number);
        if (takenBack.has(pr.number)) row.reverted.push(pr.number);
      }
    }
    row.waitHours = median(waits);
    row.waitTotalHours = waits.reduce((a, b) => a + b, 0);
    return row;
  });
}

/** Marks missing on PRs in the period: the table's counts cannot be trusted without them, so they are named. */
export interface Gaps {
  /** A yes / no in the period with no `[merge-ask]` at or before it (any kinds): answered without a recorded ask. */
  answeredWithoutAsk: number[];
  /** Merged in the period, asked, and no yes / no at or after its latest `[merge-ask]`: merged without a recorded answer. */
  mergedWithoutAnswer: number[];
}

export function gaps(prs: PrRecord[], period: { since: string; until: string }): Gaps {
  const inPeriod = (at: string) => at >= period.since && at < period.until;
  const g: Gaps = { answeredWithoutAsk: [], mergedWithoutAnswer: [] };
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const asks = pr.marks.filter((m) => m.kind === "ask");
    const answers = pr.marks.filter((m) => m.kind === "yes" || m.kind === "no");
    if (answers.some((m) => inPeriod(m.at) && !asks.some((a) => a.at <= m.at))) g.answeredWithoutAsk.push(pr.number);
    const lastAsk = asks.at(-1);
    if (pr.mergedAt && inPeriod(pr.mergedAt) && lastAsk && !answers.some((m) => m.at >= lastAsk.at)) g.mergedWithoutAnswer.push(pr.number);
  }
  return g;
}

/** The one line after the table naming the gaps; none when there are none. */
export function formatGaps(g: Gaps): string[] {
  const parts = [
    g.answeredWithoutAsk.length ? `聞かずに返事 ${g.answeredWithoutAsk.map((n) => `#${n}`).join(", ")}` : "",
    g.mergedWithoutAnswer.length ? `返事なしでマージ ${g.mergedWithoutAnswer.map((n) => `#${n}`).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? [`印の欠け: ${parts.join(" / ")}`] : [];
}

/** The line after the period: from when the app's records begin (a period before it has no job to count). */
export const formatSince = (since: number | null): string => (since === null ? "記録はまだ無い" : `記録は ${iso(since).slice(0, 10)} から`);

/** The PRs the jobs name that the app never stored: they have no state and no comments, so the table cannot place them; they are named, not dropped. None when there are none. */
export function formatUnsaved(numbers: number[]): string[] {
  return numbers.length ? [`保存に無い PR ${numbers.length} 件（${numbers.map((n) => `#${n}`).join(", ")}）: 取込みの間に開いて閉じたため、状態とコメントが無い`] : [];
}

/** One route's line of the audit: the PRs the audit read in the period, how many it found something in, and the rate. */
export interface AuditRow { route: Route; sampled: number; findings: number; rate: number }

export const ROUTES: Route[] = ["review", "direct", "recheck"];

/** A route with nothing sampled is a row of 0 (a route nobody takes yet still shows). A PR counts once, by its latest `[post-audit]` mark in the period. */
export function auditRows(prs: PrRecord[], period: { since: string; until: string }): AuditRow[] {
  return ROUTES.map((route) => {
    let sampled = 0;
    let findings = 0;
    for (const pr of prs) {
      const last = pr.marks.filter((m) => m.kind === "post-audit" && m.at >= period.since && m.at < period.until).at(-1);
      if (!last || routeOf(pr) !== route) continue;
      sampled++;
      if (last.verdict === "finding") findings++;
    }
    return { route, sampled, findings, rate: sampled === 0 ? 0 : findings / sampled };
  });
}

/** `監査 <owner/name> <通り方> 抜き取り N / finding N / 率 N%`, one line per route. */
export function formatAudit(repo: string, rows: AuditRow[]): string[] {
  return rows.map((r) => `監査 ${repo} ${r.route} 抜き取り ${r.sampled} / finding ${r.findings} / 率 ${Math.round(r.rate * 1000) / 10}%`);
}

/** How far back the proposals look (a recheck merge taken back is rare: a week is too few). */
export const LOOKBACK_DAYS = 90;

/** evidence: the PRs behind the proposal; reverts: the commits that took them back; audited: of evidence, those the audit found something in. */
export type Proposal = { kind: MergeKind; evidence: number[]; reverts: string[]; audited: number[] };

/**
 * Against merge-gate's split now: a recheck kind with a recheck merge that was taken back, or that the post-merge audit
 * found something in (`[post-audit] finding`, posted in the window; the same weight as a revert) → back to asking (one is
 * enough). Only what happened in `window` (LOOKBACK_DAYS up to the table's --until) counts. A security group the table
 * still asks is never proposed (the user always answers it, and moving one is the user's call); a group moved to a recheck
 * is a recheck kind here like the others.
 */
export function proposals(prs: PrRecord[], reverts: Revert[], window: { since: string; until: string }): Proposal[] {
  // by time, not by string: git's %cI carries the committer's offset (+09:00, -07:00), GitHub's times are UTC
  const inWindow = (at: string) => Date.parse(at) >= Date.parse(window.since) && Date.parse(at) < Date.parse(window.until);
  // only reverts made in the window: a past --until does not see a revert that came later
  const inTime = reverts.filter((r) => inWindow(r.at));
  const takenBack = new Set(inTime.flatMap((r) => r.reverted));
  const out: Proposal[] = [];
  for (const kind of RECHECK_KINDS) {
    const found = (p: PrRecord) => p.marks.some((m) => m.kind === "post-audit" && m.verdict === "finding" && inWindow(m.at));
    const lifted = prs.filter((p) => p.mergedAt !== null && inWindow(p.mergedAt) && recheckMerged(p, kind));
    const back = lifted.filter((p) => takenBack.has(p.number) || found(p)).map((p) => p.number);
    const by = inTime.filter((r) => r.reverted.some((n) => back.includes(n))).map((r) => r.sha);
    const audited = lifted.filter((p) => found(p)).map((p) => p.number);
    if (back.length > 0) out.push({ kind, evidence: back, reverts: by, audited });
  }
  return out.sort((a, b) => MERGE_KINDS.indexOf(a.kind) - MERGE_KINDS.indexOf(b.kind));
}

/** The `要望:` line of --file-request: filed (its number), the open request with the same title, or nothing to file. */
export function filingLine(outcome: Filed | null): string {
  if (outcome === null) return "要望: 案が無いので起票しない";
  if ("open" in outcome) return `要望: 同じ題の開いた要望 ${outcome.open} があるので起票しない`;
  return outcome.filed === null ? "要望: 起票した（番号は上の出力）" : `要望: 起票した #${outcome.filed}`;
}

/** The lines after the table: one per proposal, or `案なし` — a table alone could not tell "none" from "not judged". */
export function formatProposals(ps: Proposal[]): string[] {
  return ps.length ? ps.map((x) => `案: ${proposalText(x)}`) : ["案なし"];
}

const proposalText = (p: Proposal) =>
  `${p.kind} を聞くへ（再チェックで自動マージして戻された${p.audited.length > 0 ? " / 監査の指摘" : ""}: ${p.evidence.map((n) => `#${n}`).join(", ")}${p.reverts.length > 0 ? `。戻したコミット: ${p.reverts.map((x) => x.slice(0, 7)).join(", ")}` : ""}）`;

/** The request Issue for the proposals, or null. The same proposals always get the same title (alreadyFiled compares it). */
export function requestFor(ps: Proposal[], source: { date: string }): { title: string; body: string } | null {
  if (ps.length === 0) return null;
  const sorted = [...ps].sort((a, b) => MERGE_KINDS.indexOf(a.kind) - MERGE_KINDS.indexOf(b.kind));
  const title = `マージ規則の見直し: ${sorted.map((p) => `${p.kind} を聞くへ`).join(" / ")}`;
  const body = [
    "## 要望",
    "アプリのマージの記録（判定・許可・再チェックの仕事の記録と、マージ後の監査）の集計から、merge-gate の分け（利用者に聞く / 再チェックで外せる）を変える案が出ました。見直してください。",
    "",
    ...sorted.map((p) => `- ${proposalText(p)}`),
    "",
    "直し方: 採るなら `scripts/merge-gate.ts` の `ASK_KINDS` / `RECHECK_KINDS` と、その種類の理由の分け（`judge`）を PR で変える。採らないならこの要望を閉じる（同じ案は、閉じたあとの次の集計でまた出る）。",
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `\`bun scripts/merge-audit.ts --file-request\`（定期実行） / ${source.date}`,
  ].join("\n");
  return { title, body };
}

export function format(rows: Row[]): string[] {
  return rows
    .filter((r) => r.asked + r.yes + r.no + r.recheckMerged.length > 0)
    .map((r) => {
      const h = (x: number) => `${Math.round(x * 10) / 10}h`;
      const wait = r.waitHours === null ? "-" : `${h(r.waitHours)}（合計 ${h(r.waitTotalHours)}）`;
      const back = r.reverted.length > 0 ? `（${r.reverted.map((n) => `#${n}`).join(", ")}）` : "";
      return `${r.kind} 聞いた ${r.asked} / 認めた ${r.yes} / 認めなかった ${r.no} / 返事まで 中央値 ${wait} / 再チェックで自動マージ ${r.recheckMerged.length} / 戻された ${r.reverted.length}${back}`;
    });
}

export type Run = (cmd: string[]) => Promise<string>;

/** A command that exited non-zero; `code` tells "no" (e.g. merge-base --is-ancestor's 1) from a failure. */
export class RunError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

export async function spawnRun(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new RunError(`${cmd.slice(0, 3).join(" ")} failed (exit ${code}): ${err.trim()}`, code);
  return out;
}

/** What a merge verdict job's record holds (`result.gate`, packages/protocol `JobResult`). */
type Gate = { verdict: "merge" | "stop"; head: string | null; ask: string[]; recheck: string[]; required?: string[]; stack?: Array<{ pr: number; head: string | null; ask: string[]; recheck: string[]; required: string[]; merged: boolean; reviewSkipped?: boolean }>; reasons: string[]; allowLarge: boolean; reviewSkipped: boolean; merged: boolean };

/** The PR as the tables read it: a `PrRecord` and what the audit's selection and the unsaved count need. */
export interface PrView extends PrRecord {
  /** The merge commit; null when the app has no stored record of the merge. */
  mergeSha: string | null;
  /** The app stored the PR. false: only its jobs are known (opened and closed between two imports), so it has no state and no comments. */
  stored: boolean;
  /** A finished audit job of the app that read its merge commit and kept `pass`, or a `[post-audit]` comment of an owner, member or collaborator, is on record: it is not selected again. An audit job that kept `finding` is not enough here (`auditFound`). */
  audited: boolean;
  /** An audit job of the app that kept `finding`: post-audit's `select` takes the PR as audited when the audit's PBI (`pbiTitle`) is in the backlog, and selects it again when `record` stopped before filing it. */
  auditFound: boolean;
  /** The runner of the Task that asked for its jobs, which is what implemented it; null = unknown. */
  implementer: "claude" | "codex" | null;
  /** `[post-audit]` comments not counted: stored with no author (before it was kept) or by someone who is not an owner, member or collaborator. */
  uncountedAudits: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const sortedKinds = (xs: Iterable<string>): MergeKind[] => {
  const set = new Set(xs);
  return MERGE_KINDS.filter((k) => set.has(k));
};

/**
 * The PRs of a period's records, with the marks the tables count, made from the app's records (what the verdict wrote, not what
 * anyone commented). A head's `ask` = its first merge verdict that stopped with an ask kind left, of its ask and recheck kinds; its
 * `yes` = the person's first grant of it after that (the kinds are those the verdicts at that head named); its `no` = an asked head
 * with no grant when the PR was closed unmerged or went on at another head; its `recheck` = the merge verdict at that head merged with
 * nothing to ask and no grant of that head, and a recheck kind the verdicts at that head required (`required`, or the reasons of an older record) has a passing recheck record of that head. The
 * `[post-audit]` comments are the audit's output. A PR with no stored record has no state: its merge time and head come from its
 * merge verdict, and it has no comments.
 */
export async function prViewsOf(h: MergeHistory): Promise<PrView[]> {
  const jobsOf = new Map<number, MergeHistory["jobs"]>();
  for (const j of h.jobs) jobsOf.set(j.pr, [...(jobsOf.get(j.pr) ?? []), j]);
  const commentsOf = new Map<number, MergeHistory["comments"]>();
  for (const c of h.comments) commentsOf.set(c.issue, [...(commentsOf.get(c.issue) ?? []), c]);
  // the verdicts of each PR: a stack's verdict gives each PR of the stack its own entry (its head and kinds; the reasons with that PR's `#<n>:`), a single PR's its own record
  // (a record of a stack from before the entries were kept keeps only the named PR's reasons, those without a `#<n>:`)
  type G = Gate & { head: string };
  const gatesByPr = new Map<number, Array<{ j: MergeHistory["jobs"][number]; g: G }>>();
  const addGate = (pr: number, x: { j: MergeHistory["jobs"][number]; g: G }) => gatesByPr.set(pr, [...(gatesByPr.get(pr) ?? []), x]);
  for (const j of h.jobs) {
    const g = j.kind === "gate" ? (j.result as { gate?: Gate } | null)?.gate : undefined;
    if (!g || typeof g.head !== "string") continue;
    const own = (g.reasons ?? []).filter((r) => !/^#\d+: /.test(r));
    for (const e of g.stack ?? []) {
      const reasons = e.pr === j.pr ? own : (g.reasons ?? []).filter((r) => r.startsWith(`#${e.pr}: `)).map((r) => r.slice(`#${e.pr}: `.length));
      addGate(e.pr, { j, g: { ...g, head: e.head ?? g.head, ask: e.ask, recheck: e.recheck, required: e.required, merged: e.merged, reviewSkipped: e.reviewSkipped ?? (e.pr === j.pr ? g.reviewSkipped : false), reasons } });
    }
    if (!g.stack) addGate(j.pr, { j, g: { ...g, head: g.head, reasons: own } });
  }
  const views: PrView[] = [];
  for (const pull of h.pulls) {
    const jobs = jobsOf.get(pull.number) ?? [];
    const gates = gatesByPr.get(pull.number) ?? [];
    const marks: Mark[] = [];
    // the kinds a head's verdicts asked of the person (also the ones a grant already lifted: the verdict keeps them), and the first verdict that stopped on them
    const kindsAt = new Map<string, Set<string>>();
    const asked = new Map<string, { mark: Mark; job: number }>();
    const grantsOf = h.grants.filter((x) => x.target === pull.number && h.since !== null && x.at >= h.since);
    for (const { j, g } of gates) {
      if (g.ask.length === 0) continue;
      const kinds = kindsAt.get(g.head) ?? new Set<string>();
      for (const k of [...g.ask, ...g.recheck]) kinds.add(k);
      kindsAt.set(g.head, kinds);
      // a verdict run with --allow-large after the person's grant of its head had its ask lifted: it stopped for another reason and asked nothing (a grant made after the verdict did not lift it)
      const lifted = g.allowLarge && grantsOf.some((x) => x.head.toLowerCase() === g.head.toLowerCase() && x.at <= j.startedAt);
      if (g.verdict === "stop" && !lifted && !asked.has(g.head)) asked.set(g.head, { mark: { kind: "ask", kinds: sortedKinds([...g.ask, ...g.recheck]), sha: g.head, at: iso(j.endedAt ?? j.startedAt) }, job: j.id });
    }
    for (const { mark } of asked.values()) marks.push(mark);
    // the person's first grant of a head after its ask (the first at all when it was given before the ask)
    const granted = new Map<string, number>();
    // a grant from before the records began has no verdict beside it: it would read as an answer given with no ask
    for (const gr of [...grantsOf].sort((a, b) => a.at - b.at)) {
      const head = gr.head.toLowerCase();
      const after = asked.get(head)?.mark.at;
      const have = granted.get(head);
      if (have === undefined || (after !== undefined && iso(have) < after && iso(gr.at) >= after)) granted.set(head, gr.at);
    }
    for (const [head, at] of granted) marks.push({ kind: "yes", kinds: sortedKinds(kindsAt.get(head) ?? []), sha: head, at: iso(at) });
    for (const [head, { mark, job }] of asked) {
      if (granted.has(head)) continue;
      const closed = pull.state === "CLOSED";
      const later = gates.find((x) => x.j.id > job && x.g.head !== head);
      const at = closed ? pull.closedAt ?? mark.at : later ? iso(later.j.endedAt ?? later.j.startedAt) : null;
      if (at) marks.push({ kind: "no", kinds: mark.kinds, sha: head, at });
    }
    const merged = gates.filter((x) => x.g.merged).at(-1);
    // a grant of the merged head means the person allowed it: not a merge by the recheck, whatever kinds the verdicts named
    if (merged && merged.g.ask.length === 0 && !granted.has(merged.g.head.toLowerCase())) {
      const head = merged.g.head;
      // a recheck kind with a passing record of the merged head that the change asked for: the verdict's `required` (the recheck may have passed before it, so its reason never appeared), or, in a record from before that was kept, a `[再チェック <kind>]` reason of a verdict at that head. A recheck run for nothing the change asked is no recheck merge
      const named = (k: string) => gates.some((x) => x.g.head === head && (x.g.required ? x.g.required.includes(k) : x.g.reasons.some((r) => r.includes(`[再チェック ${k}]`))));
      const kinds = sortedKinds((await rechecksOf(jobs, head, (x) => x === head)).filter((k) => (RECHECK_KINDS as readonly string[]).includes(k) && named(k)));
      if (kinds.length > 0) marks.push({ kind: "recheck", kinds, sha: head, at: iso(merged.j.endedAt ?? merged.j.startedAt) });
    }
    // the audit's mark counts only from an owner, member or collaborator, as it did when the comments were read from GitHub; a comment stored with no author is not counted
    const comments = (commentsOf.get(pull.number) ?? []).filter((c) => POST_AUDIT.test(c.body));
    const counted = comments.filter((c) => c.authorAssociation !== undefined && MARK_AUTHORS.includes(c.authorAssociation));
    for (const c of counted) {
      const m = POST_AUDIT.exec(c.body)!;
      marks.push({ kind: "post-audit", kinds: [], sha: m[2]!, at: c.createdAt, verdict: m[1] as "pass" | "finding" });
    }
    // the app's own record of an audit: a finished audit job that read the merge commit and kept `pass` or `finding` as its first line,
    // not asked for by a Task that asked for the PR's other jobs (the Task that implemented it does not audit itself)
    const implementing = new Set(jobs.filter((j) => !(j.kind === "review" && j.as === "audit")).map((j) => j.taskId));
    const audits = pull.mergeCommit ? jobs.flatMap((j) => {
      const first = (j.result as { review?: { firstLine?: string } } | null)?.review?.firstLine?.trim().toLowerCase();
      return j.kind === "review" && j.as === "audit" && !implementing.has(j.taskId) && j.status === "pass" && j.head === pull.mergeCommit && (first === "pass" || first === "finding") && j.endedAt !== null ? [{ j, verdict: first as "pass" | "finding" }] : [];
    }) : [];
    for (const { j, verdict } of audits) marks.push({ kind: "post-audit", kinds: [], sha: pull.mergeCommit!, at: iso(j.endedAt!), verdict });
    marks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const mergedAt = pull.mergedAt ?? (merged ? iso(merged.j.endedAt ?? merged.j.startedAt) : null);
    // a direct PR's verdict says it skipped the main review; a PR merged with no main review record after the records began was read by nobody either
    const skipped = gates.some((x) => x.g.merged && x.g.reviewSkipped);
    const direct = skipped || (mergedAt !== null && h.since !== null && Date.parse(mergedAt) >= h.since && !(await reviewedOf(jobs, () => true)));
    // the runner of the Task that asked for the PR's jobs; with none named, the other of the runner that read the main review (the settings pair them); else unknown
    const runnerOf = (j: (typeof jobs)[number]) => (j.taskRunner === "claude" || j.taskRunner === "codex" ? j.taskRunner : null);
    const reader = jobs.find((j) => j.kind === "review" && (j.as === null || j.as === "fallback") && (j.runner === "claude" || j.runner === "codex"))?.runner;
    const implementer = jobs.filter((j) => !(j.kind === "review" && j.as === "audit")).map(runnerOf).find((r) => r !== null) ?? (reader ? (reader === "claude" ? "codex" : "claude") : null);
    views.push({
      number: pull.number, mergedAt, headSha: merged?.g.head ?? pull.head ?? "", marks, reviewed: !direct,
      mergeSha: pull.mergeCommit, stored: pull.stored, implementer,
      // a `finding` job alone does not settle the PR here: post-audit settles it when the app has stored the audit's PBI (`record` may have stopped before filing it)
      audited: counted.length > 0 || audits.some((a) => a.verdict === "pass"), auditFound: audits.some((a) => a.verdict === "finding"), uncountedAudits: comments.length - counted.length,
    });
  }
  return views;
}

/**
 * The PRs with something to count since `since` (an ISO time), with their marks, the PRs the jobs name that the app never stored, and
 * the reverts on main since then. All of it from the app's records (`GET /api/merge-records/history`) and main's commits
 * (`git log` of this clone, or the API for another repository): nothing is asked of GitHub for this repository's PRs. `since` of the
 * answer is when the records begin.
 */
export async function readHistory(since: string, run: Run = spawnRun, repo = currentRepo(), env: Record<string, string | undefined> = process.env, f?: Parameters<typeof mergeHistory>[2]): Promise<{ prs: PrRecord[]; reverts: Revert[]; since: number | null; unsaved: Array<{ number: number; mergedAt: string | null }>; uncounted: number }> {
  const h = await mergeHistory(mergeRecordsEnv(env), { repo, sinceMs: Date.parse(since) }, f);
  const views = await prViewsOf(h);
  const mergeCommits = mergeCommitsOf(views);
  return { prs: views.filter((v) => v.marks.length > 0), reverts: await revertsSince(since, run, repo, mergeCommits), since: h.since, unsaved: views.filter((v) => !v.stored).map((v) => ({ number: v.number, mergedAt: v.mergedAt })), uncounted: views.reduce((n, v) => n + v.uncountedAudits, 0) };
}

/** The reverts on main since `since`: main's commits (this clone's `git log`, or the API for another repository) and the PRs they took back (this clone: the stored PR it belongs to, from `mergeCommits` and git, no API call). */
export async function revertsSince(since: string, run: Run, repo: string, mergeCommits: MergeCommits = new Map()): Promise<Revert[]> {
  const { commits, prOf } = repo === currentRepo() ? await localCommits(since, run, mergeCommits) : await remoteCommits(since, run, repo);
  return parseReverts(commits, (s) => prOf.get(s) ?? []);
}

type Commits = { commits: { sha: string; at: string; message: string }[]; prOf: Map<string, number[]> };

/** A stored PR's merge commit (the last commit a rebase merge put on main) with the PR's number and when it was merged (ms). */
export type MergeCommits = Map<string, { pr: number; at: number }>;

/** The stored merge commits of the read PRs, each with its PR and merge time: what `revertsSince` reads a revert's PR from. */
export function mergeCommitsOf(views: readonly PrView[]): MergeCommits {
  return new Map(views.flatMap((v) => (v.mergeSha && v.mergedAt ? [[v.mergeSha, { pr: v.number, at: Date.parse(v.mergedAt) }] as const] : [])));
}

/**
 * The PR of a commit on main. A stored PR's merge commit is that PR's. A rebase merge puts all of a PR's commits on main with the merge
 * time as their committer time and the merge commit last, so another commit is a PR's when its committer time is the time that PR was
 * merged and the first stored merge commit after it (50 commits at most) is that PR's. Anything else is no PR's (a PR the app never
 * stored is not credited to the next one): empty.
 */
async function pullOfCommit(sha: string, run: Run, mergeCommits: MergeCommits): Promise<number[]> {
  const own = mergeCommits.get(sha);
  if (own !== undefined) return [own.pr];
  const at = Date.parse((await run(["git", "log", "-1", "--format=%cI", sha])).trim());
  for (const c of (await run(["git", "rev-list", "--reverse", "--ancestry-path", `${sha}..origin/main`])).split("\n").filter(Boolean).slice(0, 50)) {
    const m = mergeCommits.get(c);
    if (m !== undefined) return m.at === at ? [m.pr] : [];
  }
  return [];
}

/** The repository this clone is of: main's commits from `git log`, a short sha resolved in the clone. */
async function localCommits(since: string, run: Run, mergeCommits: MergeCommits): Promise<Commits> {
  await run(["git", "fetch", "-q", "origin", "main"]);
  const log = await run(["git", "log", "origin/main", `--since=${since}`, "--format=%H%x09%cI%x09%B%x00"]);
  const commits = log.split("\0").map((x) => x.replace(/^\n/, "")).filter(Boolean).map((x) => {
    const [sha, at, ...message] = x.split("\t");
    return { sha: sha!, at: at!, message: message.join("\t") };
  });
  const prOf = new Map<string, number[]>();
  for (const short of new Set(commits.flatMap((c) => revertedShas(c.message)))) {
    // Only a commit on main is a merged PR's. A revert made inside a PR's branch names the branch's pre-rebase commit:
    // the clone has no such object (0 candidates), or has it off main (--is-ancestor exits 1) — it took nothing merged
    // back. Of a short sha's candidates only those on main count, so an object off main that shares the prefix does not
    // make it ambiguous. Two or more on main, or git failing otherwise, is a reading failure (exit 2), not "nothing
    // taken back". --disambiguate lists every object with the prefix (blobs and trees too): only commits are candidates
    const onMain: string[] = [];
    for (const o of (await run(["git", "rev-parse", `--disambiguate=${short}`])).split("\n").filter(Boolean)) {
      if ((await run(["git", "cat-file", "-t", o])).trim() !== "commit") continue;
      try {
        await run(["git", "merge-base", "--is-ancestor", o, "origin/main"]);
        onMain.push(o);
      } catch (e) {
        if (!(e instanceof RunError && e.code === 1)) throw e;
      }
    }
    if (onMain.length === 0) continue;
    if (onMain.length > 1) throw new Error(`${short} は曖昧（main に ${onMain.length} 件）`);
    prOf.set(short, await pullOfCommit(onMain[0]!, run, mergeCommits));
  }
  return { commits, prOf };
}

/** Another repository (`--repo`): this clone has no such history, so the default branch's commits come from the API (REST). */
async function remoteCommits(since: string, run: Run, repo: string): Promise<Commits> {
  const out = await run(["gh", "api", "-X", "GET", `repos/${repo}/commits`, "-f", `since=${since}`, "-f", "per_page=100", "--paginate",
    "-q", ".[] | {sha, at: .commit.committer.date, message: .commit.message}"]);
  const commits = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sha: string; at: string; message: string });
  const prOf = new Map<string, number[]>();
  for (const short of new Set(commits.flatMap((c) => revertedShas(c.message)))) {
    // a short sha resolves in the API too; one that is no commit of the repository (404, a branch-only commit) or is not
    // an ancestor of the default branch took nothing merged back. compare's status: ahead / identical = an ancestor
    let sha: string;
    try {
      sha = (await run(["gh", "api", `repos/${repo}/commits/${short}`, "-q", ".sha"])).trim();
      const status = (await run(["gh", "api", `repos/${repo}/compare/${sha}...HEAD`, "-q", ".status"])).trim();
      if (status !== "ahead" && status !== "identical") continue;
    } catch (e) {
      if (/HTTP (404|422)/.test((e as Error).message)) continue;
      throw e;
    }
    const pulls = JSON.parse(await run(["gh", "api", `repos/${repo}/commits/${sha}/pulls`])) as { number: number }[];
    prOf.set(short, pulls.map((p) => p.number));
  }
  return { commits, prOf };
}

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `--since` / `--until` as UTC days; until is inclusive (the period ends at the start of the next day). */
export function period(args: string[], now = Date.now()): { since: string; until: string } {
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${flag} は YYYY-MM-DD`);
    return Date.parse(`${v}T00:00:00Z`);
  };
  const until = (at("--until") ?? Date.parse(`${day(now)}T00:00:00Z`)) + DAY;
  const since = at("--since") ?? until - 7 * DAY;
  if (since >= until) throw new Error("--since は --until 以前の日");
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

/** The CLI: prints the table and the proposals, returns the exit code (0 none / 1 proposals / 2 could not read). `run` / `now` / `file` are injected for the tests. */
export async function main(
  args: string[],
  run: Run = spawnRun,
  now = Date.now(),
  file: (req: { title: string; body: string }) => Promise<Filed> = fileRequest,
  app: { env?: Record<string, string | undefined>; fetch?: Parameters<typeof mergeHistory>[2] } = {},
): Promise<number> {
  let code = 0;
  let ps: Proposal[] = [];
  let other = false;
  try {
    const p = period(args, now);
    const i = args.indexOf("--repo");
    // `--repo` without a value is an error, not the current repository
    const repo = i < 0 ? currentRepo() : args[i + 1] ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("--repo は owner/name");
    other = repo !== currentRepo();
    // the proposals look back LOOKBACK_DAYS from the table's end, so a past --until gives that time's proposals
    const lookback = new Date(Date.parse(p.until) - LOOKBACK_DAYS * DAY).toISOString();
    const { prs, reverts, since, unsaved, uncounted } = await readHistory(p.since < lookback ? p.since : lookback, run, repo, app.env, app.fetch);
    console.log(`${p.since.slice(0, 10)}〜${new Date(Date.parse(p.until) - DAY).toISOString().slice(0, 10)}`);
    console.log(formatSince(since));
    for (const line of format(tally(prs, reverts, p))) console.log(line);
    for (const line of formatGaps(gaps(prs, p))) console.log(line);
    for (const line of formatUnsaved(unsaved.filter((u) => u.mergedAt !== null && u.mergedAt >= p.since && u.mergedAt < p.until).map((u) => u.number))) console.log(line);
    if (uncounted > 0) console.log(`数えなかった監査の印 ${uncounted} 件: 投稿者が保存されていない（古い保存）か、所有者・メンバー・協力者のものでない`);
    for (const line of formatAudit(repo, auditRows(prs, p))) console.log(line);
    ps = proposals(prs, reverts, { since: lookback, until: p.until });
    for (const line of formatProposals(ps)) console.log(line);
    code = ps.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(`読めなかった: ${(e as Error).message}`);
    return 2;
  }
  const req = requestFor(ps, { date: day(now) });
  if (args.includes("--file-request") && other) {
    // the request goes to this repository's backlog: a proposal about another repository's merges is not filed here
    console.log("要望: 別のリポジトリの集計なので起票しない");
  } else if (args.includes("--file-request")) {
    try {
      console.log(filingLine(req ? await file(req) : null));
    } catch (e) {
      console.log(`要望: 起票できなかった（${(e as Error).message}）`);
    }
  }
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
