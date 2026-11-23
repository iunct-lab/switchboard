/**
 * What the merge verdict reads of the jobs the app ran (GET /api/merge-records): CI, the main review, the attacking
 * review and the rechecks. Only a job's record counts, at the head the PR has or at one that has the PR's commits with the
 * same diff (`covers`): a comment, an argument or a mark is no part of it. These are pure functions of the jobs; the
 * caller reads the jobs (`mergeRecords`) and decides what `covers` and `moved` ask git.
 */
import type { MergeRecordJob } from "../ops-kit/src/merge-records.ts";
import { newestCiRecord } from "./local-ci.ts";
import { stepsNotConfirmed, type HeldSettings } from "./workspace-settings.ts";

/** A commit id as git writes it: what a record's head and base must be before they go into a git argument (anything else is no record). */
export const isSha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);

/** Whether a job's head stands for the PR's head now: the same commit, or the PR's commits are in it with the same diff (`inPass`). */
export type Covers = (jobHead: string) => boolean | Promise<boolean>;

/** The rechecks a command decides (`scripts/recheck.ts`, a job of kind `recheck`); every other kind is read by a review. `rescue` is both. */
export const COMMAND_RECHECKS = ["migration", "rescue", "security:lockfile"];

type Review = { findings: { severity: string }[] };
/** The findings a review job's end recorded; none when its output had no Findings section. */
const reviewOf = (j: MergeRecordJob): Review | undefined => {
  const r = (j.result as { review?: Review } | null)?.review;
  return r && Array.isArray(r.findings) ? r : undefined;
};

/** Whether a job is a passing recheck review of `kind`: run as `recheck` for it, with its findings recorded and no blocker and no should-fix among them. */
export const reviewPassOf = (j: MergeRecordJob, kind: string): boolean => {
  const r = reviewOf(j);
  return j.kind === "review" && j.status === "pass" && !!r && j.as === "recheck" && j.kinds.includes(kind) && !r.findings.some((f) => f.severity === "blocker" || f.severity === "should-fix");
};
/** Whether a job is a passing recheck command of `kind` (the head it ran at is the caller's to check). */
export const commandPassOf = (j: MergeRecordJob, kind: string): boolean => j.kind === "recheck" && j.status === "pass" && j.kinds.includes(kind);

/** A review job that passed and left its findings (its output had the Findings section), by `as`, at a head the PR's head is covered by. */
async function someReview(jobs: MergeRecordJob[], covers: Covers, ok: (j: MergeRecordJob, r: Review) => boolean): Promise<boolean> {
  for (const j of jobs) {
    const r = reviewOf(j);
    if (j.kind === "review" && j.status === "pass" && r && isSha(j.head) && ok(j, r) && await covers(j.head)) return true;
  }
  return false;
}

/** The main review: a review job with no reason to be another (`as` none), or standing in for it at a usage limit (`fallback`). */
export const reviewedOf = (jobs: MergeRecordJob[], covers: Covers): Promise<boolean> => someReview(jobs, covers, (j) => j.as === null || j.as === "fallback");

/** The attacking-side review: a review job run as `attack`. */
export const attackedOf = (jobs: MergeRecordJob[], covers: Covers): Promise<boolean> => someReview(jobs, covers, (j) => j.as === "attack");

/**
 * The recheck kinds the jobs satisfy at `head`. A kind a review reads: a review run as `recheck` for that kind, with no
 * blocker and no should-fix among its findings, at a covered head (a review that named no kind satisfies none). A kind a
 * command decides: a recheck job of the kind that passed at exactly `head` (it is run again for every head). `rescue` needs both.
 */
export async function rechecksOf(jobs: MergeRecordJob[], head: string, covers: Covers): Promise<string[]> {
  const kinds = new Set<string>();
  for (const j of jobs) for (const k of j.kinds) if ((j.kind === "review" && j.as === "recheck") || j.kind === "recheck") kinds.add(k);
  const out: string[] = [];
  for (const k of kinds) {
    const byCommand = jobs.some((j) => commandPassOf(j, k) && j.head === head);
    const byReview = await someReview(jobs, covers, (j) => reviewPassOf(j, k));
    if (COMMAND_RECHECKS.includes(k) ? byCommand && (k !== "rescue" || byReview) : byReview) out.push(k);
  }
  return out;
}

const shortSha = (s: string) => s.slice(0, 7);

/** The newest local CI job of `pr` that left a result, and the hash of the steps it ran when they came from the workspace's settings. */
function newestCi(jobs: MergeRecordJob[], pr: number) {
  const own = jobs.filter((j) => j.pr === pr);
  const rec = newestCiRecord(own);
  if (!rec || !isSha(rec.head) || !isSha(rec.base)) return undefined;
  const hash = (own.find((j) => j.id === rec.id)?.result as { ci?: { stepsHash?: string } } | null)?.ci?.stepsHash;
  return { ...rec, stepsHash: hash ?? null };
}

/**
 * Whether the newest recorded local CI run of the stack's top `top` (the PR itself when alone) passed, with the steps the
 * person confirmed, at a head the PR's commits are in (`covers`), and with no shared file the PR touches moved on the
 * base since (`moved`); else why not. A run that left no record (from a terminal, or whose head or base moved before it
 * posted) is not counted. The base's tip is not compared: a conflict with another PR is mergeStateStatus's, a fault of two
 * PRs together the tag CI's.
 */
export async function ciOf(jobs: MergeRecordJob[], top: number, covers: Covers, moved: (passHead: string, passBase: string) => Promise<string[]>, held?: HeldSettings): Promise<{ pass: boolean; note?: string }> {
  const newest = newestCi(jobs, top);
  if (!newest) return { pass: false };
  if (newest.outcome !== "pass") return { pass: false, note: `一番上の PR #${top} の local-ci の最新が fail` };
  const steps = stepsNotConfirmed(newest.stepsHash, held);
  if (steps) return { pass: false, note: steps };
  if (!await covers(newest.head)) return { pass: false, note: `この PR のコミットが #${top} の pass（${shortSha(newest.head)}）に同じ差分で入っていない（一番上で回し直す）` };
  const files = await moved(newest.head, newest.base);
  if (files.length) return { pass: false, note: `#${top} の pass（${shortSha(newest.head)}）の後に、この PR の触る合流ファイルが base で進んだ: ${files.join(", ")}（最新の base に合わせて一番上で回し直す）` };
  return { pass: true };
}

/**
 * `ciOf` for a local change and a GitLab MR: the newest recorded run counts only for the head and the base's tip now (there
 * is no tag CI after the merge to catch a fault of two changes together, so a base that moved runs it again).
 */
export function ciAtTips(jobs: MergeRecordJob[], pr: number, head: string, baseTip: string, held?: HeldSettings): { pass: boolean; note?: string } {
  const newest = newestCi(jobs, pr);
  if (!newest) return { pass: false };
  if (newest.outcome !== "pass") return { pass: false, note: "local-ci の最新が fail" };
  const steps = stepsNotConfirmed(newest.stepsHash, held);
  if (steps) return { pass: false, note: steps };
  if (newest.head !== head) return { pass: false, note: `local-ci の pass（${shortSha(newest.head)}）は今の head（${shortSha(head)}）のものでない（回し直す）` };
  if (newest.base !== baseTip) return { pass: false, note: `local-ci の pass の base（${shortSha(newest.base)}）が今の base の先端（${shortSha(baseTip)}）でない（回し直す）` };
  return { pass: true };
}
