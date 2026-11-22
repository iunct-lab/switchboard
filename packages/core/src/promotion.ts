/**
 * The version the backlog sweep runs on: which release the daemon should be promoted to before the next PBI starts
 * (`promotionStep`), the drain that waits for the running Tasks, the note the screens show while it waits, and the
 * question asked when a promotion failed.
 */
import type { BacklogCommentData, BacklogIssueData, BacklogPullRequestData, BacklogSource } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { closesOf } from "./backlog-fetch.ts";
import type { ReleaseReview } from "./release-review.ts";
import { type GhRunner, call } from "./backlog-gh.ts";
import { askStoredDecision } from "./backlog-edit.ts";
import { shownRecords } from "./backlog-stored.ts";

/* ---------- the version the sweep runs on ---------- */

/** What the backlog sweep needs from sb-rescue's /api/status: the current release and the newest history entries. */
export interface ReleaseState {
  managed: boolean;
  current: string | null;
  /** `owner/name` releases are built from (no git); null or absent = built from the checkout. */
  source?: string | null;
  /** What sb-rescue is doing right now (`/api/status`'s `busy`), e.g. a promotion; null = idle. */
  busy?: string | null;
  /**
   * sb-rescue never restarts the daemon for an `ifNoRestart` request: a reload that is not confirmed is taken back by a
   * second reload, not by a restart. One that only says `promoteWithoutRestart` goes back with a restart (it cuts every
   * Task), so it is not asked that way while a Task would be cut.
   */
  promoteKeepsTasks?: boolean;
  history: Array<{ action: string; from: string | null; to: string | null; ok: boolean; reason: string }>;
}

/** The newest `v*` tag (semver order) and its commit; the remote's tags are fetched first when it answers. */
export async function latestTag(git: (args: string[]) => Promise<string>): Promise<{ tag: string; sha: string } | null> {
  await git(["fetch", "--tags", "-q", "origin"]).catch(() => undefined);
  const tag = (await git(["tag", "-l", "v*", "--sort=-v:refname"])).split("\n")[0]?.trim();
  if (!tag) return null;
  return { tag, sha: await git(["rev-list", "-n", "1", tag]) };
}

/** How far a new version found is taken by itself (`settings.release.auto`). */
export type PromotionAuto = "promote" | "review" | "off";

/** The tag CI's last word on a tag's commit, as its Release says it (`[tag-ci] pass|fail <sha>`); `none` = no result, or it could not be read. */
export type TagCi = "pass" | "fail" | "none";

/** The last `[tag-ci]` result of `sha` in a Release's body (a later line outweighs an earlier one), `none` without one. */
export function tagCiOf(releaseBody: string, sha: string): TagCi {
  let last: TagCi = "none";
  for (const m of releaseBody.matchAll(/^\[tag-ci\] (pass|fail) ([0-9a-f]{40})(?=\s|$)/gm)) if (m[2] === sha) last = m[1] as TagCi;
  return last;
}

export type PromotionStep =
  | { action: "pick" }
  /** `ifNoRestart`: asked as a switch that keeps the Tasks; sb-rescue refuses it (409, `restart: true`) when the release needs a restart. */
  | { action: "promote"; tag: string; sha: string; ifNoRestart?: true }
  | { action: "review" }
  /** `drain`: it waits for the Tasks a restart would cut, and nothing new starts meanwhile (the caller holds new starts). `ci`: held by the tag CI's result, not by Tasks. */
  | { action: "wait"; reason: string; failed?: { tag: string; sha: string; reason: string }; review?: ReleaseReview; drain?: true; ci?: true; bundle?: true };

/**
 * The one decision about the newest tag, for the interval check, a backlog-next firing and a turn's end alike: bring
 * the running app up to it. Only under sb-rescue.
 * A tag whose promotion was rejected or that rolled back by itself is never asked for again, and while it is the newest
 * tag nothing new is started — the next merges would be built on a version that does not run. A rollback chosen by hand
 * is the person's call, not a failure of the version. `latestInCurrent`: the tag's commit is already part of what runs
 * (a newer commit was promoted by hand) — going back to the tag would undo that.
 * `auto` (default `promote`): `off` leaves a new tag alone and `review` stops after the check of its diff; neither holds
 * the backlog, and a failed tag still does. A bundle's hold (`bundle`) waits whatever `auto` says and holds the backlog.
 * `ci` (given for a development origin only): the tag CI's result. A tag that failed it is never brought in by itself;
 * one without a result is brought in as any tag is (`requireCi` `no-fail`, the default: a promotion does not wait for
 * the tag CI) unless `requireCi` is `pass`. Neither wait holds the backlog, and each is told to the person (`tagCiNote`).
 * `busyTasks`: the Tasks a restart would cut — a turn under way, a turn stopped on an approval or a question (the
 * middle of a turn), background jobs. This decision never restarts under one of them: while there are any and sb-rescue
 * can switch without ever restarting (`promoteKeepsTasks`), that is asked for (`ifNoRestart`); `needsRestart` =
 * sb-rescue answered that this tag cannot go in that way, so it waits until none is left (`drain`).
 */
export function promotionStep(s: { status: ReleaseState; latest: { tag: string; sha: string } | null; busyTasks: number; latestInCurrent?: boolean; review?: ReleaseReview | "start" | null; auto?: PromotionAuto; needsRestart?: boolean; bundle?: { taskId: string } | null; ci?: TagCi; requireCi?: "pass" | "no-fail" }): PromotionStep {
  const { status, latest } = s;
  if (!status.managed || !latest || latest.sha === status.current || s.latestInCurrent) return { action: "pick" };
  const failure = status.history.find((h) =>
    (h.to === latest.sha && !h.ok && h.action === "rejected") ||
    (h.from === latest.sha && h.action === "auto-rollback"));
  if (failure) return { action: "wait", reason: `昇格に失敗した版のまま: ${latest.tag}`, failed: { tag: latest.tag, sha: latest.sha, reason: failure.reason } };
  // a bundle of work is under way: nothing is brought in (nor a diff check started) until its hold is released, whatever
  // `auto` says, and no Task ending releases it (the backlog stays held: nothing outside the bundle starts)
  if (s.bundle) return { action: "wait", reason: `束の作業中（Task ${s.bundle.taskId}）`, bundle: true };
  const auto = s.auto ?? "promote";
  if (auto === "off") return { action: "pick" };
  // a public copy's clone (the caller passed `review`): the tag is asked for only once its diff was checked and found ok
  if (s.review === "start") return { action: "review" };
  if (s.review && s.review.state !== "ok") {
    const r = s.review;
    const reason = r.state === "running" ? `${latest.tag} の差分を確認中` : r.state === "concern" ? `${latest.tag} の差分の確認で懸念 ${r.findings.length} 件` : `${latest.tag} の差分を確かめられなかった: ${r.reason}`;
    return { action: "wait", reason, review: r };
  }
  if (auto === "review") return { action: "pick" };
  if (s.ci === "fail") return { action: "wait", reason: `${latest.tag} はタグの CI が失敗しているので自動では昇格しない`, ci: true };
  if (s.ci === "none" && (s.requireCi ?? "no-fail") === "pass") return { action: "wait", reason: `${latest.tag} のタグの CI の結果がまだ無いので自動の昇格を待つ`, ci: true };
  // a promotion in flight: the next check must not ask for the same tag again
  if (status.busy) return { action: "wait", reason: `sb-rescue が ${status.busy} の最中なので ${latest.tag} の昇格を待つ` };
  if (s.busyTasks > 0 && status.promoteKeepsTasks && !s.needsRestart) return { action: "promote", tag: latest.tag, sha: latest.sha, ifNoRestart: true };
  if (s.busyTasks > 0) {
    const why = s.needsRestart ? `${s.busyTasks} 件の Task が動いていて、差分が画面と既定の設定の外にもあるので` : `${s.busyTasks} 件の Task が動いているので`;
    return { action: "wait", reason: `${why} ${latest.tag} の昇格を待つ`, drain: true };
  }
  return { action: "promote", tag: latest.tag, sha: latest.sha };
}

/**
 * A promotion that needs a restart and has not come yet, in memory only (a daemon starts with none).
 * `since`: when a version first had to wait for Tasks. It is the one clock of the wait: a newer tag replaces `tag`, not
 * `since`, so Tasks that keep running cannot hold new starts for one limit per tag.
 * `state`: `drain` = it waits for the Tasks a restart would cut, and no new turn or Task starts until `since` + the limit
 * (they queue, and the next daemon starts them); `asked` = a restart was asked for at `askedAt`, and nothing starts
 * until the restart; `off` = the version is held by something else (its diff's check, the tag CI): no hold.
 * `lifted`: when the wait went past its limit. The hold on new starts ended there and is not set up again; nothing is
 * cut — the promotion stays pending for the first moment no Task would be cut, and the person is told (`drainNote`).
 */
export type PromotionDrain = { tag: string; since: number; state: "drain" | "asked" | "off"; askedAt?: number; lifted?: number } | null;

/**
 * The drain after a decision about the newest tag (`tag` null = nothing to bring in: no state is left).
 * `drain` = the decision waits for the Tasks; `asked` = a restart was asked for (or is about to be); `keep` = nothing
 * new is known (sb-rescue is busy, a request was refused); `off` = the version waits for something that is not a Task;
 * `done` = the wait is over (a switch without a restart was taken, or the version failed after it got its moment).
 */
export function nextDrain(prev: PromotionDrain, tag: string | null, mode: "drain" | "asked" | "keep" | "off" | "done", now: number): PromotionDrain {
  if (!tag || mode === "done") return null;
  if (mode === "keep" || mode === "off") {
    if (!prev) return null;
    if (mode === "keep") return prev.tag === tag ? prev : { ...prev, tag };
    return { tag, since: prev.since, state: "off", ...(prev.lifted !== undefined ? { lifted: prev.lifted } : {}) };
  }
  const carried = { tag, since: prev?.since ?? now, ...(prev?.lifted !== undefined ? { lifted: prev.lifted } : {}) };
  if (mode === "asked") return { ...carried, state: "asked", askedAt: now };
  return prev?.state === "drain" && prev.tag === tag ? prev : { ...carried, state: "drain" };
}

/** The drain as the screens read it (`GET /api/health` `promotionDrain`, `GET /api/daemon/release` `drain`): holding new starts for `tasks` Tasks until `since + limitMs`; a restart `asked` for; or `expired` — the hold ended at its limit and the promotion still waits for `tasks` Tasks. */
export type DrainView =
  | { tag: string; since: number; limitMs: number; tasks: number; queued: number }
  | { tag: string; since: number; asked: number; queued: number }
  | { expired: { tag: string; at: number; since: number; tasks: number } }
  | null;

/** Does this state keep new turns and Tasks from starting (time aside: `expireDrain` is applied first)? */
export function drainHeld(d: PromotionDrain): boolean {
  return !!d && (d.state === "asked" || (d.state === "drain" && d.lifted === undefined));
}

/**
 * What time does to a drain. A wait for Tasks older than `limitMs` is lifted (`lifted`): only the hold on new starts
 * ends, no Task is cut and the promotion stays pending. A restart asked for more than `askedMs` ago that never came
 * (sb-rescue went away in the middle) holds nothing any more. Any other state stays as it is (the same object).
 */
export function expireDrain(d: PromotionDrain, limitMs: number, askedMs: number, now: number): PromotionDrain {
  if (!d) return d;
  if (d.state === "asked") return now - (d.askedAt ?? now) > askedMs ? nextDrain(d, d.tag, "off", now) : d;
  return d.state === "drain" && d.lifted === undefined && now - d.since > limitMs ? { ...d, lifted: now } : d;
}

/**
 * Is the restart that was asked for still on its way? While sb-rescue is busy, and for `graceMs` after the request (it
 * may not have taken it yet). Once this is false on the same daemon, the promotion ended without restarting it.
 */
export function askedInFlight(d: PromotionDrain, rescueBusy: boolean, now: number, graceMs = 10_000): boolean {
  return d?.state === "asked" && (rescueBusy || now - (d.askedAt ?? now) < graceMs);
}

/**
 * The notice of a wait that went past its limit: the version has waited `N` minutes and these Tasks hold it. The app
 * cuts none of them by itself; the person decides (the button on 動いている版). `at` = the wait's `since`, the notice's
 * id. null = no such wait, or nothing holds it any more.
 */
export function drainNote(d: PromotionDrain, holding: Array<{ title: string; status: string }>, now: number): { title: string; body: string; at: number } | null {
  if (!d || d.state !== "drain" || d.lifted === undefined || holding.length === 0) return null;
  const minutes = Math.max(0, Math.floor((now - d.since) / 60_000));
  const word: Record<string, string> = { running: "実行中", waiting: "承認・回答待ち", background: "裏の処理中" };
  return {
    title: `昇格待ち: ${d.tag} が ${minutes} 分待っている（動いている・待っている Task ${holding.length} 件）`,
    body: `待たせている Task: ${holding.map((t) => `${t.title}（${word[t.status] ?? t.status}）`).join("、")}。新しいターンと Task を止めておく上限を過ぎたので、止めるのはやめた。アプリは Task を切らず、この Task が全部止まったときに昇格する`,
    at: d.since,
  };
}

/** Why a promotionFirst held the newest tag, and since when it has held that tag. */
export type PromotionHold = { tag: string; failed: boolean; reason: string; since: number; /** false = held by something that is not a Task (the diff's check, the tag CI, sb-rescue busy): no Task ending brings it in. */ tasks?: boolean; /** Held by the tag CI's result (a fail, or no result under `pass`). */ ci?: boolean };

/**
 * The notice of a tag the tag CI holds back: told from the first check that held it, whatever the schedules, because
 * nothing else brings that tag in (no Task ending does) and what runs stays the version before it. One per tag
 * (`tag` is the notice's key): gone once the tag went in or a newer tag took its place. null = not held by the tag CI.
 */
export function tagCiNote(hold: PromotionHold | null): { tag: string; title: string; body: string; at: number } | null {
  if (!hold || !hold.ci) return null;
  return {
    tag: hold.tag,
    title: `昇格を止めている: ${hold.tag}（タグの CI）`,
    body: `${hold.reason}。動いているのは 1 つ前の版のままで、バックログは進む`,
    at: hold.since,
  };
}

/**
 * The once-a-day notice of a promotion held for running Tasks: only a hold that began before the approval-window
 * schedule's last firing (`firedAt`, 00:00 UTC), so a hold is told at the next firing after it began and a new tag
 * waits for the next day. A failed tag is told by its own ## 判断待ち; no Task running = promoteWhenIdle promotes it.
 * `at` = the hold's `since`: the notice's id, so the same hold back after a moment without it (promoteWhenIdle clears it
 * before asking again) is the same notice, not a second one that day. null = no notice.
 */
export function promotionNote(hold: PromotionHold | null, busyTasks: number, firedAt: number | null, now: number): { title: string; body: string; at: number } | null {
  if (!hold || hold.failed || hold.tasks === false || busyTasks <= 0 || firedAt === null || firedAt < hold.since) return null;
  const hours = Math.max(0, Math.floor((now - hold.since) / 3_600_000));
  return {
    title: `昇格待ち: ${hold.tag}（${hours} 時間、動いている Task ${busyTasks} 件）— ヘッダーの「新しい版 →」から昇格できる`,
    body: `${hold.reason}。Task が全部止まれば自動で昇格する。待たないなら、ヘッダーの「新しい版 →」から設定の「動いている版」を開き「待たずに昇格する」を押す（動いている Task は切れる）`,
    at: hold.since,
  };
}

const marker = (sha: string) => `<!-- promote-failed:${sha} -->`;

/**
 * Tells the PBI behind a failed version (the `(#n)` of its commit subject: a PR's first closed Task → the Task's parent
 * PBI, or the Task / PBI itself) with a ## 判断待ち, once per commit, through the workspace's stored backlog: kept here
 * and sent by the app (a backlog kept here only too). Only the PR is read from the code host when it is not stored
 * (the PR's `closes` are the parallel guard's rule, closesOf). Null when no stored PBI could be found.
 */
/** What a failed promotion's report names in place of the rescue page where sb-rescue answers inside the container only (no address a browser opens). */
export const RESCUE_IN_CONTAINER = "コンテナの中だけ（`docker compose -f container/compose.yaml exec switchboard curl -s http://127.0.0.1:47841/api/status`）";

export async function reportPromoteFailure(db: Db, source: BacklogSource, gh: GhRunner, cwd: string, f: { tag: string; sha: string; subject: string; reason: string; rescueUrl: string }): Promise<number | null> {
  let n = Number(/\(#(\d+)\)\s*$/.exec(f.subject)?.[1]);
  if (!n) return null;
  const records = shownRecords(db, source);
  const issue = (k: number) => records.find((r) => r.objectKind === "issue" && (r.remote as BacklogIssueData).number === k)?.remote as BacklogIssueData | undefined;
  const pr = records.find((r) => r.objectKind === "pull-request" && (r.remote as BacklogPullRequestData).number === n)?.remote as BacklogPullRequestData | undefined;
  const closes = pr
    ? pr.closes
    : await call(gh, cwd, ["pr", "view", String(n), "--json", "body,headRefName"]).then((out) => {
        const v = JSON.parse(out) as { body: string | null; headRefName: string | null };
        return closesOf(v.body, v.headRefName);
      }, () => null);
  if (closes) n = closes[0] ?? 0;
  let it = n ? issue(n) : undefined;
  if (!it) return null;
  if (!it.labels.includes("type:pbi")) {
    n = it.parent ?? Number(/## 親 PBI\s*\n+\s*#(\d+)/.exec(it.body ?? "")?.[1]);
    it = n ? issue(n) : undefined;
    if (!it) return null;
  }
  if (records.some((r) => r.objectKind === "comment" && (r.remote as BacklogCommentData).issue === n && (r.remote as BacklogCommentData).body.includes(marker(f.sha)))) return n;
  askStoredDecision(db, source, n, [
    `**問い**: 動いているアプリに入らなかった版 ${f.tag}（${f.sha.slice(0, 7)} ${f.subject}）をどうするか`,
    "**選択肢**:",
    `- A: 直す — 影響: 直した PR がマージされて新しいタグが付くまで、定期実行は新しい項目を始めない`,
    `- B: 救援画面で前の版に戻したままにし、この変更を revert する — 影響: revert の PR が要る`,
    `**推奨**: A — 理由は sb-rescue の履歴: ${f.reason}`,
    `**止めた場所**: 定期実行（backlog-next）。救援画面: ${f.rescueUrl}`,
    "",
    marker(f.sha),
  ].join("\n"));
  return n;
}
