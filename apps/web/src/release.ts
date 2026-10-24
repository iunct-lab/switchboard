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
}

/** The link at the top of every screen (#399): only under sb-rescue, and only when the daemon names the page. */
export function rescueLink(r: ReleaseStatus | null): string | null {
  return r?.managed && r.rescuePage ? r.rescuePage : null;
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "なし");

/** "昇格を却下: abc1234 — the candidate exited (1) …". The reason is shown as recorded: it is what the person needs to act on. */
export function describeRelease(h: ReleaseHistoryEntry): { text: string; ok: boolean } {
  const what: Record<ReleaseHistoryEntry["action"], string> = {
    install: `最初の版 ${shortSha(h.to)} で起動`,
    promote: h.ok ? `${shortSha(h.to)} に昇格した` : `${shortSha(h.to)} に切り替えたが確認できていない`,
    rejected: `${shortSha(h.to)} の昇格を却下（今の版のまま）`,
    "auto-rollback": `${shortSha(h.from)} は切り替え後に確認できず、自動で ${shortSha(h.to)} に戻した`,
    rollback: `${shortSha(h.to)} に戻した`,
    restart: "再起動した",
    "restore-db": "DB をスナップショットから戻した",
    rebuild: "インスタンスの作り直しを頼んだ",
  };
  return { text: `${what[h.action] ?? h.action} — ${h.reason}`, ok: h.ok };
}

/** The backlog screen's line (#626): the newest tag waiting for the running Tasks, or the failed tag the app stays behind. */
export function promotionLine(r: ReleaseStatus | null): { text: string; link: string | null } | null {
  const hold = r?.managed ? r.hold : null;
  if (!hold) return null;
  if (hold.failed) return { text: `昇格に失敗した版のまま: ${hold.tag}`, link: rescueLink(r) };
  return { text: `${hold.tag} の昇格待ち: 動いている Task ${hold.busyTasks} 件が終わると入る`, link: null };
}

export interface ReleasePanelView {
  lines: Array<{ text: string; warn: boolean }>;
  canPromote: boolean;
  busyTasks: number;
}

/** The "動いている版" section (#1660), shared by the settings screen and a meta-workspace Task: what runs, what HEAD is, and whether promoting is possible. */
export function releasePanel(r: ReleaseStatus | null): ReleasePanelView | null {
  if (!r) return null;
  if (!r.managed) return { lines: [r.error ? { text: r.error, warn: true } : { text: "リリースから動いていないので昇格はありません", warn: false }], canPromote: false, busyTasks: 0 };
  const lines: ReleasePanelView["lines"] = [{ text: `動いている版: ${shortSha(r.current)}`, warn: false }];
  const gap = r.ahead === 0 ? "最新の版が動いています" : r.ahead == null ? "動いている版との差を数えられません" : `${r.ahead} コミット先`;
  lines.push({ text: `HEAD: ${shortSha(r.head)}${r.headSubject ? ` ${r.headSubject}` : ""} — ${gap}`, warn: false });
  if (r.dirty) lines.push({ text: "未コミットの変更は含まれません", warn: false });
  if (r.busy) lines.push({ text: `実行中: ${r.busy}`, warn: false });
  const last = r.history?.[0] ? describeRelease(r.history[0]) : null;
  if (last) lines.push({ text: `直近: ${last.text}`, warn: !last.ok });
  const hold = promotionLine(r);
  if (hold) lines.push({ text: hold.text, warn: !!r.hold?.failed });
  if (r.lastError) lines.push({ text: `失敗: ${r.lastError}`, warn: true });
  return { lines, canPromote: !r.busy && (r.ahead ?? 0) > 0, busyTasks: r.busyTasks ?? 0 };
}

/** The mark at the top of every screen (#1660): only when HEAD is newer than what runs. */
export function newVersionLink(r: ReleaseStatus | null): string | null {
  return r?.managed && (r.ahead ?? 0) > 0 ? `新しい版 ${shortSha(r.head)} →` : null;
}
