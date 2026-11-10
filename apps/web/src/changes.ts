import type { Backlog, BacklogIssueDetail } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";

/**
 * What the screen shows of a local change (#2486): the marks of its comments, read with the patterns merge-gate reads
 * them by (the screen does not judge: whether the review is newer than the last commit is merge-gate's). The patterns are the scripts' (`LOCAL_CI_RESULT` of scripts/local-ci.ts, `RECHECK_PASS` of scripts/merge-gate.ts):
 * those modules run git and cannot go in the web bundle, so they are written here and changes.test.ts holds them equal.
 */
export const LOCAL_CI_RESULT = /^\[local-ci\] (pass|fail) ([0-9a-f]{40}) base=([0-9a-f]{40})(?=\s|$)/;
export const RECHECK_PASS = /^\[recheck\] (size|responsibility|migration|rescue|design-rules) pass ([0-9a-f]{40})\b/;
/** A main review: the other runner's (merge-gate's `REVIEW`). */
export const REVIEW = /^\[(codex|claude)\] review/;

export interface ChangeMarks {
  /** The newest main review: who and when; null = none. */
  review: { runner: string; at: string } | null;
  /** The newest local-ci result: fail (whatever it was of, as merge-gate says it first), a pass of the head and base now, `stale` = a pass of another head or base; null = none. */
  localCi: "pass" | "fail" | "stale" | null;
  /** The recheck kinds passed for the head now. */
  rechecks: string[];
}

export function changeMarks(comments: Array<{ body: string; createdAt: string }>, refs: BacklogIssueDetail["changeRefs"]): ChangeMarks {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const review = sorted.map((c) => ({ m: REVIEW.exec(c.body), at: c.createdAt })).filter((x) => x.m).at(-1);
  const ci = sorted.map((c) => LOCAL_CI_RESULT.exec(c.body)).filter((m): m is RegExpExecArray => m !== null).at(-1);
  const localCi = !ci ? null : ci[1] === "fail" ? "fail" : refs?.head === ci[2] && refs?.base === ci[3] ? "pass" : "stale";
  const rechecks = [...new Set(sorted.flatMap((c) => {
    const m = RECHECK_PASS.exec(c.body);
    return m && refs?.head && m[2] === refs.head ? [m[1]!] : [];
  }))];
  return { review: review ? { runner: review.m![1]!, at: review.at } : null, localCi, rechecks };
}

/** 開いている / マージ済み / 閉じた (closed without a merge). */
export function changeStateLabel(change: Pick<Backlog["changes"][number], "state" | "mergeCommit">): string {
  return change.state === "OPEN" ? t(common.changeOpen) : change.mergeCommit ? t(common.changeMerged) : t(common.changeClosed);
}

/** A sha's first 7, or なし. */
export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : t(common.shaNone));

/** A merged change's `reviewed → merged` (7 digits each; なし for one merged before the head was kept): the head that was judged, and the commit it became on the base. null = not merged. */
export function mergedPair(change: { mergeCommit: string | null; reviewedHead: string | null }): string | null {
  return change.mergeCommit ? `${short(change.reviewedHead)} → ${short(change.mergeCommit)}` : null;
}
