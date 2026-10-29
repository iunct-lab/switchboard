import { currentRepo } from "./repo.ts";
/**
 * bun scripts/merge-audit.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] — who lifted which kind of a large PR, per kind
 * (PBI #752). Reads the record marks on the PRs (docs/merge-gate.md の「記録の印」: `[merge-ask]`, `[merge-answer]`,
 * `[recheck]`) and main's commits; keeps nothing (the marks are the record). REST only (the GraphQL budget is shared).
 *
 * One line per kind with anything to count (the default period is the last 7 days, until inclusive):
 *   <kind> 聞いた N / 認めた N / 認めなかった N / 返事まで 中央値 Nh / 再チェックで自動マージ N / 戻された N（#a, #b）
 * After the table, one line `印の欠け: 聞かずに返事 #a / 返事なしでマージ #b` when a PR in the period was answered with no
 * recorded `[merge-ask]`, or merged with an ask and no recorded answer (#1069); nothing when there are none.
 * Each table line ends its wait with the sum: `返事まで 中央値 Nh（合計 Nh）` (#1272) — how long the person was waited for in all.
 * Then the proposals to change merge-gate's split, one `案: …` line each, or `案なし`; with
 * --file-request, one `要望: …` line: 起票した #N / 同じ題の開いた要望 #N があるので起票しない / 案が無いので起票しない (#1272).
 * Exit 0 = no proposal / 1 = a proposal / 2 = could not read (gh or git failed).
 *
 * --file-request (the weekly schedule): on exit 1 also file a request Issue (type:request) through scripts/file-request.ts,
 * unless an open request has the same title (the same proposals). The exit code is the same with or without it.
 */
import { type Filed, fileRequest } from "./file-request";
import { ASK_KINDS, MARK_AUTHORS, MERGE_ANSWER, MERGE_ASK, MERGE_KINDS, RECHECK_KINDS, RECHECK_PASS, type MergeKind } from "./merge-gate";

export type Mark = { kind: "ask" | "yes" | "no" | "recheck"; kinds: MergeKind[]; sha: string; at: string };
export interface PrRecord { number: number; mergedAt: string | null; headSha: string; marks: Mark[] }
/** A commit on main that takes merged PRs back: `git revert`, or rollback-pr.ts's tree replacement. */
export interface Revert { sha: string; at: string; reverted: number[] }
export interface Row {
  kind: MergeKind;
  /** `[merge-ask]` marks in the period with this kind (one per head asked). */
  asked: number;
  /** PRs whose latest answer in the period for this kind is yes / no (a PR answered twice — a new head — is one; #1069). */
  yes: number;
  no: number;
  /** Median hours from a PR's ask to its answer for this kind; null when no answer had an ask before it. */
  waitHours: number | null;
  /** The same waits summed (#1272): how long the person was waited for in all, for the kinds that ask. 0 when none. */
  waitTotalHours: number;
  /** Merged in the period with this kind's `[recheck] pass` of the merged head and no `[merge-answer] yes` for it. */
  recheckMerged: number[];
  /** Of recheckMerged, the PRs a revert took back. */
  reverted: number[];
}

const kindsOf = (list: string): MergeKind[] =>
  MERGE_KINDS.filter((k) => list.split(",").includes(k));

/** The marks on a PR's comments (first line only; unknown kinds dropped, a mark with none left is no mark). */
export function parseMarks(comments: { body: string; created_at: string }[]): Mark[] {
  const marks: Mark[] = [];
  for (const c of comments) {
    let m: RegExpExecArray | null;
    let mark: Mark | undefined;
    if ((m = MERGE_ASK.exec(c.body))) mark = { kind: "ask", kinds: kindsOf(m[1]!), sha: m[2]!, at: c.created_at };
    else if ((m = MERGE_ANSWER.exec(c.body))) mark = { kind: m[1] as "yes" | "no", kinds: kindsOf(m[2]!), sha: m[3]!, at: c.created_at };
    else if ((m = RECHECK_PASS.exec(c.body))) mark = { kind: "recheck", kinds: [m[1] as MergeKind], sha: m[2]!, at: c.created_at };
    if (mark && mark.kinds.length > 0) marks.push(mark);
  }
  return marks;
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

/** Merged with this kind lifted by a recheck: its `[recheck] pass` is of the merged head, and no user's yes covered it. */
function recheckMerged(pr: PrRecord, kind: MergeKind): boolean {
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
      // yes / no count PRs by their latest answer (#1069); the waits stay per answer (each head asked and answered)
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

/** Marks missing on PRs in the period (#1069): the table's counts cannot be trusted without them, so they are named. */
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

/** In a row this many of the latest answers for an asked kind are yes → propose moving it to the recheck side. */
export const STREAK = 5;
/** How far back the proposals look (the asked kinds are rare: a week is too few answers). */
export const LOOKBACK_DAYS = 90;

/** evidence: the PRs behind the proposal; reverts: for "ask", the commits that took them back. */
export type Proposal = { to: "ask" | "recheck"; kind: MergeKind; evidence: number[]; reverts?: string[] };

/**
 * Against merge-gate's split now: a recheck kind with a recheck merge that was taken back → back to asking (one is
 * enough); an asked kind other than security whose latest STREAK answers are all yes → to the recheck side. Only what
 * happened in `window` (LOOKBACK_DAYS up to the table's --until) counts. Security is never proposed (PBI #752: the user
 * always answers it).
 */
export function proposals(prs: PrRecord[], reverts: Revert[], window: { since: string; until: string }): Proposal[] {
  // by time, not by string: git's %cI carries the committer's offset (+09:00, -07:00), GitHub's times are UTC
  const inWindow = (at: string) => Date.parse(at) >= Date.parse(window.since) && Date.parse(at) < Date.parse(window.until);
  // only reverts made in the window: a past --until does not see a revert that came later
  const inTime = reverts.filter((r) => inWindow(r.at));
  const takenBack = new Set(inTime.flatMap((r) => r.reverted));
  const out: Proposal[] = [];
  for (const kind of RECHECK_KINDS) {
    const back = prs.filter((p) => p.mergedAt !== null && inWindow(p.mergedAt) && recheckMerged(p, kind) && takenBack.has(p.number)).map((p) => p.number);
    const by = inTime.filter((r) => r.reverted.some((n) => back.includes(n))).map((r) => r.sha);
    if (back.length > 0) out.push({ to: "ask", kind, evidence: back, reverts: by });
  }
  for (const kind of ASK_KINDS.filter((k) => k !== "security")) {
    // STREAK counts PRs: a PR asked again after each new head is one decision, its latest answer
    const answers = prs
      .flatMap((p) => p.marks.filter((m) => (m.kind === "yes" || m.kind === "no") && m.kinds.includes(kind) && inWindow(m.at)).map((m) => ({ ...m, pr: p.number })).slice(-1))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, STREAK);
    if (answers.length === STREAK && answers.every((a) => a.kind === "yes")) out.push({ to: "recheck", kind, evidence: answers.map((a) => a.pr).sort((a, b) => a - b) });
  }
  return out.sort((a, b) => MERGE_KINDS.indexOf(a.kind) - MERGE_KINDS.indexOf(b.kind));
}

/** The `要望:` line of --file-request (#1272): filed (its number), the open request with the same title, or nothing to file. */
export function filingLine(outcome: Filed | null): string {
  if (outcome === null) return "要望: 案が無いので起票しない";
  if ("open" in outcome) return `要望: 同じ題の開いた要望 ${outcome.open} があるので起票しない`;
  return outcome.filed === null ? "要望: 起票した（番号は上の出力）" : `要望: 起票した #${outcome.filed}`;
}

/** The lines after the table (#1272): one per proposal, or `案なし` — a table alone could not tell "none" from "not judged". */
export function formatProposals(ps: Proposal[]): string[] {
  return ps.length ? ps.map((x) => `案: ${proposalText(x)}`) : ["案なし"];
}

const proposalText = (p: Proposal) =>
  p.to === "ask"
    ? `${p.kind} を聞くへ（再チェックで自動マージして戻された: ${p.evidence.map((n) => `#${n}`).join(", ")}。戻したコミット: ${(p.reverts ?? []).map((x) => x.slice(0, 7)).join(", ")}）`
    : `${p.kind} を再チェックへ（直近 ${STREAK} 件の返事がすべて認めた: ${p.evidence.map((n) => `#${n}`).join(", ")}）`;

/** The request Issue for the proposals, or null. The same proposals always get the same title (alreadyFiled compares it). */
export function requestFor(ps: Proposal[], source: { date: string }): { title: string; body: string } | null {
  if (ps.length === 0) return null;
  const sorted = [...ps].sort((a, b) => MERGE_KINDS.indexOf(a.kind) - MERGE_KINDS.indexOf(b.kind));
  const title = `マージ規則の見直し: ${sorted.map((p) => `${p.kind} を${p.to === "ask" ? "聞く" : "再チェック"}へ`).join(" / ")}`;
  const body = [
    "## 要望",
    "マージの記録の印（docs/merge-gate.md の「記録の印」）の集計から、merge-gate の分け（利用者に聞く / 再チェックで外せる）を変える案が出ました。見直してください。",
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

async function spawnRun(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new RunError(`${cmd.slice(0, 3).join(" ")} failed (exit ${code}): ${err.trim()}`, code);
  return out;
}

const ANY_MARK = [MERGE_ASK, MERGE_ANSWER, RECHECK_PASS];

/**
 * The PRs with something to count since `since`, with all their marks, and main's commits since then. A PR counts when a
 * mark was posted on it since then (the repository's comment stream, one paginated call: `issues/comments?since=` — PR
 * comments are issue comments; `since` is by update, so older ones are dropped here) or it was merged since then (search).
 * Each such PR's comments are then read whole, so an ask or a recheck from before `since` still gives the wait and the
 * recheck merge. Marks count by MARK_AUTHORS only, as merge-gate counts them. A mark on a plain Issue (pulls/<n> is 404)
 * is skipped. Main's commits come from `git log` (run from a clone of the repository); the PR of a commit merged by
 * rebase is `commits/<sha>/pulls`.
 */
export async function readHistory(since: string, run: Run = spawnRun, repo = currentRepo()): Promise<{ prs: PrRecord[]; reverts: Revert[] }> {
  const jsonLines = <T>(out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  type Comment = { body: string; created_at: string; author_association: string };
  const isMark = (c: Comment) => MARK_AUTHORS.includes(c.author_association) && ANY_MARK.some((re) => re.test(c.body));
  const candidates = new Set<number>();
  const stream = await run(["gh", "api", "-X", "GET", `repos/${repo}/issues/comments`, "-f", `since=${since}`, "-f", "per_page=100", "--paginate",
    "-q", ".[] | {body, created_at, issue_url, author_association}"]);
  for (const c of jsonLines<Comment & { issue_url: string }>(stream)) {
    if (c.created_at >= since && isMark(c)) candidates.add(Number(c.issue_url.split("/").at(-1)));
  }
  // search answers 1,000 results at most and may say a page is incomplete: then the counts would be short, so it is an error
  const merged = await run(["gh", "api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} is:pr is:merged merged:>=${since.slice(0, 10)}`,
    "-f", "per_page=100", "--paginate", "-q", '"page \\(.incomplete_results) \\(.total_count)", (.items[].number)']);
  for (const l of merged.split("\n").filter(Boolean)) {
    const page = /^page (true|false) (\d+)$/.exec(l);
    if (page && (page[1] === "true" || Number(page[2]) > 1000)) throw new Error(`マージされた PR の検索が不完全（incomplete_results ${page[1]}、${page[2]} 件）`);
    if (!page) candidates.add(Number(l));
  }
  const prs: PrRecord[] = [];
  for (const n of [...candidates].sort((a, b) => a - b)) {
    const comments = jsonLines<Comment>(await run(["gh", "api", `repos/${repo}/issues/${n}/comments`, "--paginate", "-q", ".[] | {body, created_at, author_association}"]));
    const marks = parseMarks(comments.filter(isMark));
    if (marks.length === 0) continue;
    let pull: { merged_at: string | null; head: { sha: string } };
    try {
      pull = JSON.parse(await run(["gh", "api", `repos/${repo}/pulls/${n}`]));
    } catch (e) {
      if (/HTTP 404/.test((e as Error).message)) continue;
      throw e;
    }
    prs.push({ number: n, mergedAt: pull.merged_at, headSha: pull.head.sha, marks });
  }
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
    const sha = onMain[0]!;
    const pulls = JSON.parse(await run(["gh", "api", `repos/${repo}/commits/${sha}/pulls`])) as { number: number }[];
    prOf.set(short, pulls.map((p) => p.number));
  }
  return { prs, reverts: parseReverts(commits, (s) => prOf.get(s) ?? []) };
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
): Promise<number> {
  let code = 0;
  let ps: Proposal[] = [];
  try {
    const p = period(args, now);
    // the proposals look back LOOKBACK_DAYS from the table's end, so a past --until gives that time's proposals
    const lookback = new Date(Date.parse(p.until) - LOOKBACK_DAYS * DAY).toISOString();
    const { prs, reverts } = await readHistory(p.since < lookback ? p.since : lookback, run);
    console.log(`${p.since.slice(0, 10)}〜${new Date(Date.parse(p.until) - DAY).toISOString().slice(0, 10)}`);
    for (const line of format(tally(prs, reverts, p))) console.log(line);
    for (const line of formatGaps(gaps(prs, p))) console.log(line);
    ps = proposals(prs, reverts, { since: lookback, until: p.until });
    for (const line of formatProposals(ps)) console.log(line);
    code = ps.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(`読めなかった: ${(e as Error).message}`);
    return 2;
  }
  const req = requestFor(ps, { date: day(now) });
  if (args.includes("--file-request")) {
    try {
      console.log(filingLine(req ? await file(req) : null));
    } catch (e) {
      console.log(`要望: 起票できなかった（${(e as Error).message}）`);
    }
  }
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
