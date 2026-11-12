import { t } from "./i18n.ts";
import { settings } from "./i18n/settings.ts";
import { jstClock } from "./time.ts";

/** Releases (#178): what `GET /api/daemon/release` returns under sb-rescue, and one line of its history in words. */
export interface ReleaseHistoryEntry {
  ts: number;
  action: "install" | "promote" | "rejected" | "auto-rollback" | "rollback" | "restart" | "restore-db" | "rebuild";
  from: string | null;
  to: string | null;
  ok: boolean;
  reason: string;
}
export interface ReleaseStatus {
  managed: boolean;
  error?: string;
  head?: string;
  /** The subject line of HEAD's commit. */
  headSubject?: string;
  /** Commits from the running version to HEAD. 0 = there is no newer version, null = it cannot be counted. */
  ahead?: number | null;
  /** Commits in the running version that HEAD lacks. > 0 with `ahead` 0 = HEAD is behind what runs (the checkout does not follow the tag). Absent/null = not counted. */
  behind?: number | null;
  /** Tasks running or waiting: a promotion restarts the daemon under them. */
  busyTasks?: number;
  dirty?: boolean;
  current?: string | null;
  previous?: string | null;
  state?: string;
  busy?: string | null;
  /** An operation that failed outside the history (the snapshot could not be taken, …). */
  lastError?: string | null;
  history?: ReleaseHistoryEntry[];
  /** The rescue page a person opens (#399): the host's `/rescue/` on the cloud, sb-rescue's own address on a Mac. */
  rescuePage?: string;
  /** Why the newest tag is not promoted yet (#626): Tasks still running (`failed: false`), or it is a tag that failed. */
  hold?: { tag: string; failed: boolean; reason: string; busyTasks: number } | null;
  /** The last promotion the daemon asked for (#2479), or why it could not (`error`). Memory only: gone after a restart, when `history` has the result. */
  asked?: { tag: string; sha: string; at: number; by: "check" | "backlog-next" | "idle"; error?: string } | null;
  /** The newest release of a public copy's clone (#4569), `ahead` counted from what runs (from HEAD outside sb-rescue). Null on a development origin. */
  latestRelease?: { tag: string; sha: string; ahead: number | null } | null;
  /** The check of that release's diff (#4569), under sb-rescue only. */
  review?: ReleaseReview | null;
}
/** What `GET /api/daemon/release` says of the check of the newest release's diff (`ReleaseReview` in core). */
export interface ReleaseReview {
  tag: string;
  sha: string;
  state: "running" | "ok" | "concern" | "failed";
  findings: Array<{ path: string; why: string }>;
  reason: string | null;
  taskId: string;
  at: number;
}

/** The link at the top of every screen (#399): only under sb-rescue, and only when the daemon names the page. */
export function rescueLink(r: ReleaseStatus | null): string | null {
  return r?.managed && r.rescuePage ? r.rescuePage : null;
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : t(settings.shaNone));

/** "昇格を却下: abc1234 — the candidate exited (1) …". The reason is shown as recorded: it is what the person needs to act on. */
export function describeRelease(h: ReleaseHistoryEntry): { text: string; ok: boolean } {
  const what: Record<ReleaseHistoryEntry["action"], string> = {
    install: t(settings.relInstall, { sha: shortSha(h.to) }),
    promote: h.ok ? t(settings.relPromoted, { sha: shortSha(h.to) }) : t(settings.relPromoteUnconfirmed, { sha: shortSha(h.to) }),
    rejected: t(settings.relRejected, { sha: shortSha(h.to) }),
    "auto-rollback": t(settings.relAutoRollback, { from: shortSha(h.from), to: shortSha(h.to) }),
    rollback: t(settings.relRollback, { sha: shortSha(h.to) }),
    restart: t(settings.relRestart),
    "restore-db": t(settings.relRestoreDb),
    rebuild: t(settings.relRebuild),
  };
  return { text: `${what[h.action] ?? h.action} — ${h.reason}`, ok: h.ok };
}

/** The backlog screen's line (#626): the newest tag waiting for the running Tasks, or the failed tag the app stays behind. */
export function promotionLine(r: ReleaseStatus | null): { text: string; link: string | null } | null {
  const hold = r?.managed ? r.hold : null;
  if (!hold) return null;
  if (hold.failed) return { text: t(settings.holdFailed, { tag: hold.tag }), link: rescueLink(r) };
  return { text: t(settings.holdWaiting, { tag: hold.tag, n: hold.busyTasks }), link: null };
}

/** A release of a public copy's clone waiting to be applied (#4569): the button's tag, the dialog before a version that was not cleared, and whether it can be checked again. */
export interface ReleaseTarget {
  tag: string;
  state: ReleaseReview["state"] | null;
  /** The text of the dialog before promoting a version with a concern or one that could not be checked; null when the check cleared it. */
  confirm: string | null;
  canReview: boolean;
  /** The check's Task, to read the whole reply. */
  taskLink: string | null;
}
export interface ReleasePanelView {
  lines: Array<{ text: string; warn: boolean }>;
  canPromote: boolean;
  /** The HEAD sha the promote button names; null when the button does not promote HEAD (nothing newer, HEAD is behind what runs, or a newer release is what goes up). */
  promoteSha: string | null;
  busyTasks: number;
  release: ReleaseTarget | null;
}

/** The newest release when it is newer than what runs (#4569). Not "can be counted" is not "newer": no line, no button. */
const newerRelease = (r: ReleaseStatus) => (r.latestRelease && (r.latestRelease.ahead ?? 0) > 0 ? r.latestRelease : null);

/** The release and the check of its diff in words (#4569). The findings are listed in full: a concern is a safety matter, not folded. */
function releaseLines(r: ReleaseStatus, latest: NonNullable<ReleaseStatus["latestRelease"]>): { lines: ReleasePanelView["lines"]; target: ReleaseTarget } {
  const review = r.review && r.review.tag === latest.tag ? r.review : null;
  const lines: ReleasePanelView["lines"] = [{ text: t(settings.latestRelease, { tag: latest.tag, n: latest.ahead ?? 0 }), warn: false }];
  const time = review ? jstClock(review.at) : "";
  let confirm: string | null = null;
  if (!review) lines.push({ text: t(settings.reviewNone), warn: false });
  else if (review.state === "running") lines.push({ text: t(settings.reviewRunning), warn: false }, { text: t(settings.reviewWaitsFor), warn: false });
  else if (review.state === "ok") lines.push({ text: t(settings.reviewOk, { time }), warn: false });
  else if (review.state === "concern") {
    const found = review.findings.map((f) => `${f.path}: ${f.why}`);
    lines.push({ text: t(settings.reviewConcern, { n: review.findings.length, time }), warn: true }, ...found.map((text) => ({ text: `・${text}`, warn: true })), { text: t(settings.reviewNotAuto), warn: false });
    confirm = t(settings.confirmConcern, { tag: latest.tag, findings: found.map((f) => `・${f}`).join("\n") });
  } else {
    const reason = review.reason ?? t(settings.reviewNoReason);
    lines.push({ text: t(settings.reviewFailed, { reason }), warn: true }, { text: t(settings.reviewNotAuto), warn: false });
    confirm = t(settings.confirmFailed, { tag: latest.tag, reason });
  }
  const state = review?.state ?? null;
  return { lines, target: { tag: latest.tag, state, confirm, canReview: state === "concern" || state === "failed", taskLink: review ? `/task/${encodeURIComponent(review.taskId)}` : null } };
}

/** The "動いている版" section (#1660), shared by the settings screen and a meta-workspace Task: what runs, what HEAD is, and whether promoting is possible. */
export function releasePanel(r: ReleaseStatus | null): ReleasePanelView | null {
  if (!r) return null;
  if (!r.managed) {
    const lines = [r.error ? { text: r.error, warn: true } : { text: t(settings.notManaged), warn: false }];
    const latest = newerRelease(r);
    // outside sb-rescue nothing is checked or applied from here: the new release and where to run it so it can be
    if (latest) lines.push({ text: t(settings.latestReleaseUnmanaged, { tag: latest.tag }), warn: false });
    return { lines, canPromote: false, promoteSha: null, busyTasks: 0, release: null };
  }
  const lines: ReleasePanelView["lines"] = [{ text: t(settings.runningVersion, { sha: shortSha(r.current) }), warn: false }];
  const latest = newerRelease(r);
  const headBehind = r.ahead === 0 && (r.behind ?? 0) > 0;
  const gap = headBehind ? t(settings.runningNewer) : r.ahead === 0 ? t(settings.upToDate) : r.ahead == null ? t(settings.cannotCount) : t(settings.commitsAhead, { n: r.ahead });
  // a public copy's clone does not move HEAD: "the latest version runs" would contradict the newer release below.
  // HEAD behind what runs says so instead, which the newer release does not contradict
  if (!(latest && r.ahead === 0) || headBehind) lines.push({ text: `HEAD: ${shortSha(r.head)}${r.headSubject ? ` ${r.headSubject}` : ""} — ${gap}`, warn: false });
  const shown = latest ? releaseLines(r, latest) : null;
  if (shown) lines.push(...shown.lines);
  if (r.dirty) lines.push({ text: t(settings.uncommitted), warn: false });
  if (r.busy) lines.push({ text: t(settings.inProgress, { what: r.busy }), warn: false });
  const last = r.history?.[0] ? describeRelease(r.history[0]) : null;
  if (last) lines.push({ text: t(settings.latest, { text: last.text }), warn: !last.ok });
  const asked = r.asked && r.asked.sha !== r.current ? r.asked : null;
  if (asked) {
    const by = t({ check: settings.askedByCheck, "backlog-next": settings.askedByBacklogNext, idle: settings.askedByIdle }[asked.by]);
    const time = jstClock(asked.at);
    lines.push(asked.error ? { text: t(settings.askFailed, { tag: asked.tag, error: asked.error }), warn: true } : { text: t(settings.asked, { tag: asked.tag, time, by }), warn: false });
  }
  // the check's own lines say why a release waits (running, a concern, not checked); the hold line is for the Tasks it waits for, or a version that failed to start
  const hold = promotionLine(r);
  if (hold && !(shown && shown.target.state !== "ok")) lines.push({ text: hold.text, warn: !!r.hold?.failed });
  if (r.lastError) lines.push({ text: t(settings.failed, { error: r.lastError }), warn: true });
  // a public copy's clone does not move HEAD: what is applied is the tag, once the check has not stopped it
  const canPromote = shown ? !r.busy && shown.target.state !== "running" && shown.target.state !== null : !r.busy && (r.ahead ?? 0) > 0;
  return { lines, canPromote, promoteSha: !shown && canPromote && r.head ? r.head : null, busyTasks: r.busyTasks ?? 0, release: shown?.target ?? null };
}

/**
 * What the update button sends now (a public copy's newest tag, else HEAD), and what the person approves with it: the
 * commit with the check they saw (its Task, state and findings). A re-check of the same tag is a new approval.
 */
export type PromoteTarget = { commit: string; key: string };
export function promoteTarget(r: ReleaseStatus | null, view: ReleasePanelView | null): PromoteTarget | null {
  const commit = view?.release?.tag ?? (r?.managed ? r.head : null) ?? null;
  if (!commit) return null;
  const c = view?.release;
  return { commit, key: JSON.stringify([commit, c?.taskLink ?? null, c?.state ?? null, c?.confirm ?? null]) };
}

/**
 * The "promote without waiting" step is bound to what the person pressed for (#4569): when a poll has moved the target
 * or its check since (a newer tag, a new HEAD, a re-check with other findings), that step is gone and the button has to
 * be pressed again (with its own dialog).
 */
export function pendingForce(confirming: PromoteTarget | null, current: PromoteTarget | null): string | null {
  return confirming && current && confirming.key === current.key ? confirming.commit : null;
}

/** The mark at the top of every screen (#1660): only when HEAD (or a public copy's newest tag) is newer than what runs. */
export function newVersionLink(r: ReleaseStatus | null): string | null {
  if (!r) return null;
  const latest = newerRelease(r); // a public copy's clone (#4569): HEAD does not move, the tag does; the mark opens 動いている版 even outside sb-rescue, where it says how to update
  if (latest) return t(settings.newVersion, { sha: latest.tag });
  return r.managed && (r.ahead ?? 0) > 0 ? t(settings.newVersion, { sha: shortSha(r.head) }) : null;
}
