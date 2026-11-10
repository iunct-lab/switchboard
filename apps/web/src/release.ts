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

export interface ReleasePanelView {
  lines: Array<{ text: string; warn: boolean }>;
  canPromote: boolean;
  busyTasks: number;
}

/** The "動いている版" section (#1660), shared by the settings screen and a meta-workspace Task: what runs, what HEAD is, and whether promoting is possible. */
export function releasePanel(r: ReleaseStatus | null): ReleasePanelView | null {
  if (!r) return null;
  if (!r.managed) return { lines: [r.error ? { text: r.error, warn: true } : { text: t(settings.notManaged), warn: false }], canPromote: false, busyTasks: 0 };
  const lines: ReleasePanelView["lines"] = [{ text: t(settings.runningVersion, { sha: shortSha(r.current) }), warn: false }];
  const gap = r.ahead === 0 ? t(settings.upToDate) : r.ahead == null ? t(settings.cannotCount) : t(settings.commitsAhead, { n: r.ahead });
  lines.push({ text: `HEAD: ${shortSha(r.head)}${r.headSubject ? ` ${r.headSubject}` : ""} — ${gap}`, warn: false });
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
  const hold = promotionLine(r);
  if (hold) lines.push({ text: hold.text, warn: !!r.hold?.failed });
  if (r.lastError) lines.push({ text: t(settings.failed, { error: r.lastError }), warn: true });
  return { lines, canPromote: !r.busy && (r.ahead ?? 0) > 0, busyTasks: r.busyTasks ?? 0 };
}

/** The mark at the top of every screen (#1660): only when HEAD is newer than what runs. */
export function newVersionLink(r: ReleaseStatus | null): string | null {
  return r?.managed && (r.ahead ?? 0) > 0 ? t(settings.newVersion, { sha: shortSha(r.head) }) : null;
}
