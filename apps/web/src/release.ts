import { t } from "./i18n.ts";
import { settings } from "./i18n/settings.ts";
import { jstClock } from "./time.ts";

/** Releases: what `GET /api/daemon/release` returns under sb-rescue, and one line of its history in words. */
export interface ReleaseHistoryEntry {
  ts: number;
  action: "install" | "promote" | "rejected" | "auto-rollback" | "rollback" | "restart" | "restore-db" | "rebuild" | "promote-web";
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
  /** The version the daemon was started from. Differs from `current` after a promotion that switched without a restart. */
  running?: string | null;
  previous?: string | null;
  state?: string;
  busy?: string | null;
  /** An operation that failed outside the history (the snapshot could not be taken, …). */
  lastError?: string | null;
  history?: ReleaseHistoryEntry[];
  /** The rescue page a person opens: the host's `/rescue/` on the cloud, sb-rescue's own address on a Mac. */
  rescuePage?: string;
  /** sb-rescue answers inside the container only: there is no page to link, and `rescueCommands` are what reaches it. */
  rescueInContainer?: boolean;
  /** Why the newest tag is not promoted yet: it is a tag that failed (`failed`), Tasks a restart would cut (`tasks` not false; `busyTasks` of them now), or something else that `reason` says (`tasks: false`: its diff's check, the tag CI, sb-rescue busy). */
  hold?: { tag: string; failed: boolean; reason: string; busyTasks: number; tasks?: boolean } | null;
  /** The wait before a promotion with a restart, as in the health (`PromotionDrain`). */
  drain?: PromotionDrain;
  /** The last promotion the daemon asked for, or why it could not (`error`). Memory only: gone after a restart, when `history` has the result. */
  asked?: { tag: string; sha: string; at: number; by: "check" | "backlog-next" | "idle"; error?: string } | null;
  /**
   * The newest release of a public copy's clone. `newer`: it is newer than what runs. `ahead`: the commits counted
   * from what runs (from HEAD outside sb-rescue), null when they cannot be counted (a version installed from a Release has
   * no git). Null on a development origin.
   */
  latestRelease?: { tag: string; sha: string; ahead: number | null; newer: boolean } | null;
  /** The check of that release's diff, under sb-rescue only. */
  review?: ReleaseReview | null;
}
/**
 * The wait before a promotion with a restart (`promotionDrain` of the health). While `tag` waits for the `tasks` Tasks a
 * restart would cut (running, stopped on an approval or a question, with background jobs), new turns and Tasks queue
 * (`queued` of them so far) until `since + limitMs`. `asked` = the restart was asked for at that time, and nothing starts
 * until it comes. `expired` = the wait went past its limit at `at`: new turns start again, no Task was cut, and the
 * promotion still waits for the `tasks` Tasks. Null = no wait.
 */
export type PromotionDrain =
  | { tag: string; since: number; limitMs: number; tasks: number; queued: number }
  | { tag: string; since: number; asked: number; queued: number }
  | { expired: { tag: string; at: number; since: number; tasks: number } }
  | null;

/**
 * The band of Home and the Task screen while a promotion holds new turns back, or after that hold ended at its limit; null =
 * no band. `line` is the one row the band shows (the tag and when new turns start), short enough for a phone held upright;
 * `detail` (the Tasks it waits for, the minutes, the way to act) is the band's title and what it opens to.
 */
export function drainBanner(d: PromotionDrain | undefined, now: number): { line: string; detail: string } | null {
  if (!d) return null;
  if ("expired" in d) {
    const e = d.expired;
    return { line: t(settings.drainExpired, { tag: e.tag }), detail: t(settings.drainExpiredDetail, { n: e.tasks, minutes: Math.max(0, Math.floor((now - e.since) / 60_000)) }) };
  }
  if ("asked" in d) return { line: t(settings.drainAsked, { tag: d.tag }), detail: t(settings.drainAskedDetail, { tag: d.tag }) };
  return { line: t(settings.drainWaiting, { tag: d.tag }), detail: t(settings.drainWaitingDetail, { n: d.tasks, minutes: Math.max(0, Math.ceil((d.since + d.limitMs - now) / 60_000)) }) };
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

/** The link at the top of every screen: only under sb-rescue, and only when the daemon names the page. */
export function rescueLink(r: ReleaseStatus | null): string | null {
  return r?.managed && r.rescuePage ? r.rescuePage : null;
}

/** What reaches sb-rescue of the stand-alone container from a terminal on the machine: its status, and the roll back (docs/design/local-container.md, "What can reach the screen and the API"). */
export const RESCUE_IN_CONTAINER_COMMANDS = [
  "docker compose -f container/compose.yaml exec switchboard curl -s http://127.0.0.1:47841/api/status",
  "docker compose -f container/compose.yaml exec switchboard curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:47841/api/rollback",
] as const;

/** The commands shown in place of the rescue page's link: under sb-rescue, where the daemon says the page does not open outside the container. */
export function rescueCommands(r: ReleaseStatus | null): readonly string[] | null {
  return r?.managed && r.rescueInContainer && !r.rescuePage ? RESCUE_IN_CONTAINER_COMMANDS : null;
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
    "promote-web": t(settings.relPromotedWeb, { sha: shortSha(h.to) }),
  };
  return { text: `${what[h.action] ?? h.action} — ${h.reason}`, ok: h.ok };
}

/** The core (what the daemon started from) and the Web UI with the defaults (`current`), only when they differ: a promotion that did not restart. */
export function runningParts(r: ReleaseStatus): { core: string; web: string } | null {
  return r.running && r.current && r.running !== r.current ? { core: shortSha(r.running), web: shortSha(r.current) } : null;
}

/** The backlog screen's line: the newest tag waiting for the running Tasks, or the failed tag the app stays behind. */
export function promotionLine(r: ReleaseStatus | null): { text: string; link: string | null } | null {
  const hold = r?.managed ? r.hold : null;
  if (!hold) return null;
  if (hold.failed) return { text: t(settings.holdFailed, { tag: hold.tag }), link: rescueLink(r) };
  // held by something that is not a Task: the daemon's own words say what
  if (hold.tasks === false) return { text: hold.reason, link: null };
  return { text: t(settings.holdWaiting, { tag: hold.tag, n: hold.busyTasks }), link: null };
}

/** A release of a public copy's clone waiting to be applied: the button's tag, the dialog before a version that was not cleared, and whether it can be checked again. */
export interface ReleaseTarget {
  tag: string;
  state: ReleaseReview["state"] | null;
  /** The text of the dialog before promoting a version with a concern or one that could not be checked; null when the check cleared it. */
  confirm: string | null;
  /** The check can be started from the screen: not checked yet (the automatic check is off, or has not come), a concern, or a check that failed. */
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

/** The newest release when the daemon says it is newer than what runs; otherwise no line, no button. */
const newerRelease = (r: ReleaseStatus) => (r.latestRelease?.newer ? r.latestRelease : null);

/** The release and the check of its diff in words. The findings are listed in full: a concern is a safety matter, not folded. */
function releaseLines(r: ReleaseStatus, latest: NonNullable<ReleaseStatus["latestRelease"]>): { lines: ReleasePanelView["lines"]; target: ReleaseTarget } {
  const review = r.review && r.review.tag === latest.tag ? r.review : null;
  const lines: ReleasePanelView["lines"] = [{ text: latest.ahead == null ? t(settings.latestReleaseNewer, { tag: latest.tag }) : t(settings.latestRelease, { tag: latest.tag, n: latest.ahead }), warn: false }];
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
  return { lines, target: { tag: latest.tag, state, confirm, canReview: state === null || state === "concern" || state === "failed", taskLink: review ? `/task/${encodeURIComponent(review.taskId)}` : null } };
}

/** The "動いている版" section, shared by the settings screen and a meta-workspace Task: what runs, what HEAD is, and whether promoting is possible. */
export function releasePanel(r: ReleaseStatus | null): ReleasePanelView | null {
  if (!r) return null;
  if (!r.managed) {
    const lines = [r.error ? { text: r.error, warn: true } : { text: t(settings.notManaged), warn: false }];
    const latest = newerRelease(r);
    // outside sb-rescue nothing is checked or applied from here: the new release and where to run it so it can be
    if (latest) lines.push({ text: t(settings.latestReleaseUnmanaged, { tag: latest.tag }), warn: false });
    return { lines, canPromote: false, promoteSha: null, busyTasks: 0, release: null };
  }
  const parts = runningParts(r);
  const lines: ReleasePanelView["lines"] = parts
    ? [{ text: t(settings.runningCore, { sha: parts.core }), warn: false }, { text: t(r.busy ? settings.runningWebBusy : settings.runningWeb, { sha: parts.web }), warn: false }]
    : [{ text: t(settings.runningVersion, { sha: shortSha(r.current) }), warn: false }];
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
  // — and for a check that could not be started at all (no state, and a hold that is not about Tasks): its reason is
  // the only line that says why nothing happens
  const notStarted = !!shown && shown.target.state === null && r.hold?.tasks === false;
  if (hold && (!(shown && shown.target.state !== "ok") || notStarted)) lines.push({ text: hold.text, warn: !!r.hold?.failed || notStarted });
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
 * The "promote without waiting" step is bound to what the person pressed for: when a poll has moved the target
 * or its check since (a newer tag, a new HEAD, a re-check with other findings), that step is gone and the button has to
 * be pressed again (with its own dialog).
 */
export function pendingForce(confirming: PromoteTarget | null, current: PromoteTarget | null): string | null {
  return confirming && current && confirming.key === current.key ? confirming.commit : null;
}

/** The mark at the top of every screen: only when HEAD (or a public copy's newest tag) is newer than what runs. */
export function newVersionLink(r: ReleaseStatus | null): string | null {
  if (!r) return null;
  const latest = newerRelease(r); // a public copy's clone: HEAD does not move, the tag does; the mark opens 動いている版 even outside sb-rescue, where it says how to update
  if (latest) return t(settings.newVersion, { sha: latest.tag });
  return r.managed && (r.ahead ?? 0) > 0 ? t(settings.newVersion, { sha: shortSha(r.head) }) : null;
}
