import { isWorkMachine } from "../machine.ts";
import { isPublicCopy, type ReleaseReview } from "../release-review.ts";
import type { Workspace } from "@switchboard/protocol";
import { latestTag, promotionStep, nextDrain, expireDrain, drainHeld, askedInFlight, tagCiOf, type DrainView, type PromotionDrain, type PromotionStep, type TagCi, reportPromoteFailure, RESCUE_IN_CONTAINER, type ReleaseState } from "../promotion.ts";
import { call, runGh } from "../backlog-gh.ts";
import { nextWakeFrom } from "../hostidle.ts";
import type { RescueStatus, ServerContext, ServerContextInit } from "./context.ts";

export const drainLimitMs = (sc: Pick<ServerContext, "opts" | "settings">) => sc.opts.promotionDrainLimitMs ?? sc.settings().release.drainMinutes * 60_000;

/** How long a restart that was asked for keeps new starts held when it never comes (sb-rescue went away in the middle of the promotion): longer than a build and its checks take. */
export const askedHoldMs = (sc: Pick<ServerContext, "opts">) => sc.opts.promotionAskedHoldMs ?? 30 * 60_000;

/** How often sb-rescue's status is read while a restart is awaited; a request counts as on its way for twice that before sb-rescue shows it. */
const askedPollMs = (sc: Pick<ServerContext, "opts">) => sc.opts.promotionAskedPollMs ?? 5_000;

export const setDrain = (sc: Pick<ServerContext, "promotionDrain" | "tasks" | "stopped">, next: PromotionDrain) => {
  const held = drainHeld(sc.promotionDrain);
  sc.promotionDrain = next;
  // after the caller's turn: the Task manager may be the one asking (a start reads the hold)
  if (held && !drainHeld(next)) queueMicrotask(() => { if (!sc.stopped) sc.tasks.resumeAdmission(); });
};

/**
 * The hold on every new start, read by the Task manager on each start. Time is applied here: a wait for Tasks past its
 * limit stops holding (no Task is cut, the promotion stays pending and 判断待ち tells the person), and so does a restart
 * that was asked for and never came.
 */
export const drainHold = (sc: Pick<ServerContext, "promotionDrain" | "drainLimitMs" | "askedHoldMs" | "setDrain" | "scheduler">): { wait: string; detail: string } | null => {
  const was = sc.promotionDrain;
  const now = expireDrain(was, sc.drainLimitMs(), sc.askedHoldMs(), Date.now());
  if (now !== was && was) {
    sc.setDrain(now);
    const text = was.state === "asked"
      ? `昇格を頼んでから ${Math.round(sc.askedHoldMs() / 60_000)} 分たっても再起動が来ないので、新しい開始の保留を外した: ${was.tag}`
      : `昇格の保留が上限 ${Math.round(sc.drainLimitMs() / 60_000)} 分を超えたので外した: ${was.tag}。新しいターンは始まる。昇格は待ったままで、動いている・待っている Task は切らない（判断待ちに知らせる。切って入れるのは「待たずに昇格する」を押したときだけ）`;
    queueMicrotask(() => sc.scheduler.note(text));
  }
  return drainHeld(sc.promotionDrain) ? { wait: "昇格を待っているので昇格の後に始まる", detail: `${sc.promotionDrain!.tag} を待っている` } : null;
};

/**
 * A restart is about to be asked for by hand (the button, a Task's `scripts/promote.ts`): from this call on nothing new
 * starts, so no turn begins between the request and the restart. The caller calls the result with whether sb-rescue
 * took the request: `false` puts back what was there (unless something else changed it meanwhile).
 */
export const holdForRestart = (sc: Pick<ServerContext, "promotionDrain" | "setDrain" | "watchAsked">, label: string): ((taken: boolean) => void) => {
  const before = sc.promotionDrain;
  const mine = nextDrain(before, label, "asked", Date.now());
  sc.setDrain(mine);
  return (taken) => {
    if (taken) return sc.watchAsked();
    if (sc.promotionDrain === mine) sc.setDrain(before);
  };
};

/**
 * While a restart that was asked for is awaited: sb-rescue's status is read every few seconds, and when it is no longer
 * busy and this daemon still runs, the promotion ended without a restart (refused, failed before the switch, or a
 * switch that needed none) — the hold on new starts ends at once instead of at the next interval check. Nothing is
 * asked for from here: the next check decides again.
 */
export const watchAsked = (sc: Pick<ServerContext, "askedWatch" | "opts" | "promotionDrain" | "releaseStatus" | "drainHold" | "setDrain" | "scheduler" | "stopped" | "watchAsked">) => {
  if (sc.askedWatch || sc.stopped) return;
  const tick = async () => {
    sc.askedWatch = null;
    if (sc.stopped || sc.promotionDrain?.state !== "asked") return;
    try {
      const s = await sc.releaseStatus();
      if (sc.stopped) return;
      sc.drainHold(); // the longest it is held without an answer
      const d = sc.promotionDrain;
      if (d?.state !== "asked") return;
      const rescue = s.managed ? (s as RescueStatus) : null;
      if (rescue && !askedInFlight(d, !!rescue.busy, Date.now(), 2 * askedPollMs(sc))) {
        sc.setDrain(nextDrain(d, d.tag, "off", Date.now()));
        sc.scheduler.note(`${d.tag} の昇格は再起動なしで終わったので、新しい開始の保留を外した${rescue.lastError ? `: ${rescue.lastError}` : ""}`);
        return;
      }
    } catch { /* a status that could not be read is read again */ }
    sc.watchAsked();
  };
  sc.askedWatch = setTimeout(() => void tick(), askedPollMs(sc));
  sc.askedWatch.unref();
};

export const releaseStatus = async (sc: Pick<ServerContext, "cfg" | "askRescue">): Promise<RescueStatus | { managed: false; error?: string }> => {
  if (!sc.cfg.rescueUrl) return { managed: false };
  try {
    const r = await sc.askRescue("/api/status");
    if (!r.ok) return { managed: false, error: `sb-rescue answered ${r.status} at ${sc.cfg.rescueUrl}` };
    const s = (await r.json()) as Omit<RescueStatus, "managed">;
    return { ...s, managed: true };
  } catch (e) {
    return { managed: false, error: `sb-rescue did not answer at ${sc.cfg.rescueUrl}: ${String((e as Error).message ?? e)}` };
  }
};

/** sb-rescue builds, checks on a spare port, switches and rolls back by itself; this only asks (202 = started). */
export const requestPromote = async (sc: Pick<ServerContext, "askRescue" | "bundleHold">, commit: string, expectSha?: string, ifNoRestart = false): Promise<{ status: number; body: object }> => {
  // every way in ends here, so the hold of a bundle of work is checked here: nothing is asked of sb-rescue while it stands
  const held = sc.bundleHold();
  if (held) return { status: 409, body: { error: `束の作業中（Task ${held.taskId}）。止めを解いてから昇格する` } };
  // `expectSha`: from an update source the release is asked for by its tag, with the commit that was checked; a tag moved since is not built
  // `ifNoRestart`: only a switch that keeps the Tasks; sb-rescue refuses (409, `restart: true`) a release that needs a restart
  const r = await sc.askRescue("/api/promote", { method: "POST", body: JSON.stringify({ commit, ...(expectSha ? { expectSha } : {}), ...(ifNoRestart ? { ifNoRestart: true } : {}) }) });
  return { status: r.status, body: (await r.json()) as object };
};

/** Running and waiting Tasks, and those whose turn ended with background jobs still going: a restart cuts all of them. */
export const busyTasks = (sc: Pick<ServerContext, "db">) => sc.db.listActiveTasks().length;

/** What a promotion with a restart waits for, the automatic one and its hold on new starts alike: every Task a restart would cut (a turn under way, a turn stopped on an approval or a question, background jobs). */
export const drainBusy = (sc: Pick<ServerContext, "db">) => sc.db.listWorkingTasks("gate").length;

/**
 * The drain as the screens read it: while new starts are held for the Tasks, with its limit and what it waits for;
 * `asked` once the restart was asked for; `expired` after the limit ended the hold (the promotion still waits for
 * `tasks` Tasks); null when nothing waits for Tasks.
 */
export const drainView = (sc: Pick<ServerContext, "drainHold" | "promotionDrain" | "drainLimitMs" | "drainBusy" | "db">): DrainView => {
  sc.drainHold();
  const d = sc.promotionDrain;
  if (!d || d.state === "off") return null;
  const queued = sc.db.listQueuedTasks().length;
  if (d.state === "asked") return { tag: d.tag, since: d.since, asked: d.askedAt ?? d.since, queued };
  if (d.lifted !== undefined) return { expired: { tag: d.tag, at: d.lifted, since: d.since, tasks: sc.drainBusy() } };
  return { tag: d.tag, since: d.since, limitMs: sc.drainLimitMs(), tasks: sc.drainBusy(), queued };
};

/**
 * The tag CI's result for a tag of a development origin, from the tag's Release (`gh release view`). A pass is final
 * for that commit and kept; a fail or no result is read again after 5 minutes (a later run can pass). A Release that
 * cannot be read (`gh` fails, or answers what is no JSON) is no result: with the default (`no-fail`) such a tag is promoted as any tag is, with `pass` it waits.
 */
export const tagCi = async (sc: Pick<ServerContext, "opts" | "cfg" | "tagCiKnown">, tag: string, sha: string): Promise<TagCi> => {
  if (sc.opts.tagCi) return sc.opts.tagCi(tag, sha);
  const key = `${tag}@${sha}`;
  const had = sc.tagCiKnown.get(key);
  if (had && (had.result === "pass" || Date.now() - had.at < 5 * 60_000)) return had.result;
  const result = await call(sc.opts.gh ?? runGh, sc.cfg.repoRoot, ["release", "view", tag, "--json", "body"]).then((out) => tagCiOf(String((JSON.parse(out) as { body?: unknown }).body ?? ""), sha)).catch(() => "none" as const);
  sc.tagCiKnown.set(key, { result, at: Date.now() });
  return result;
};

/**
 * The newest release of a public copy's clone, for 動いている版: `ahead` is the commits counted from what runs (from
 * HEAD when nothing is managed; null when they cannot be counted, as from an update source), `newer` whether it is newer
 * than what runs. Reads the tags already fetched (the interval check fetches), so it makes no network call. Null for a
 * development origin or a clone with no tag.
 */
export const latestRelease = async (sc: Pick<ServerContext, "latestOfSource" | "git" | "cfg">, current: string | null, source?: string | null): Promise<{ tag: string; sha: string; ahead: number | null; newer: boolean } | null> => {
  if (source) {
    const l = await sc.latestOfSource(source);
    // no git: the commits cannot be counted (`ahead` null), only whether it is newer than what runs
    // the answer is kept 10 minutes: the release just promoted to is not offered again
    return l ? { tag: l.tag, sha: l.sha, ahead: null, newer: l.newer && l.sha !== current } : null;
  }
  if (!(await sc.git(["remote", "get-url", "origin"]).then((u) => isPublicCopy(u, sc.cfg.repoRoot), () => false))) return null;
  const tag = (await sc.git(["tag", "-l", "v*", "--sort=-v:refname"]).catch(() => "")).split("\n")[0]?.trim();
  if (!tag) return null;
  const sha = await sc.git(["rev-list", "-n", "1", tag]);
  const ahead = await sc.git(["rev-list", "--count", `${current ?? "HEAD"}..${sha}`]).then(Number, () => null);
  return { tag, sha, ahead, newer: ahead !== null && ahead > 0 };
};

export const latestOfSource = async (sc: Pick<ServerContext, "sourceLatest" | "askRescue">, source: string): Promise<{ tag: string; sha: string; newer: boolean } | null> => {
  if (sc.sourceLatest?.source === source && Date.now() - sc.sourceLatest.at < (sc.sourceLatest.value ? 10 * 60_000 : 5 * 60_000)) return sc.sourceLatest.value;
  const value = await sc.askRescue("/api/latest-release").then(async (r) => (r.ok ? ((await r.json()) as { tag: string; sha: string; newer: boolean }) : null), () => null);
  sc.sourceLatest = { source, at: Date.now(), value };
  return value;
};

/** Before picking: bring the app up to the newest tag, or hold everything while that tag failed to start. */
export const promotionFirst = async (sc: Pick<ServerContext, "releaseStatus" | "latestOfSource" | "git" | "cfg" | "releaseReviewFor" | "drainBusy" | "db" | "settings" | "requestPromote" | "reviewStartFailed" | "REVIEW_RETRY_MS" | "startReleaseReview" | "heldSince" | "promotionHold" | "drainHold" | "setDrain" | "promotionDrain" | "promotionAsked" | "opts" | "backlog" | "tagCi" | "watchAsked" | "bundleHold">, meta: Workspace, { report, by }: { report: boolean; by: "check" | "backlog-next" | "idle" }): Promise<string | null> => {
  const status = await sc.releaseStatus();
  if (!status.managed) return null;
  // an update source (sb-rescue builds from tarballs, no git): the newest release comes from it, and it is a public copy by being the source
  const source = (status as ReleaseState).source ?? null;
  const latest = source ? await sc.latestOfSource(source) : await latestTag(sc.git).catch(() => null);
  const current = (status as ReleaseState).current;
  // exit 0 = the tag's commit is an ancestor of what runs (git throws on any other exit). From a source (no history) sb-rescue
  // compares the tags: one that is not above what runs counts as in it, so nothing goes down a version by itself
  const latestInCurrent = !!latest && !!current && latest.sha !== current && (source ? !(latest as { newer?: boolean }).newer : await sc.git(["merge-base", "--is-ancestor", latest.sha, current]).then(() => true, () => false));
  // a public copy's clone checks the tag's diff first: the check is the Task of origin release-review titled with the tag
  const publicCopy = !!latest && (!!source || (await sc.git(["remote", "get-url", "origin"]).then((u) => isPublicCopy(u, sc.cfg.repoRoot), () => false)));
  let review: ReleaseReview | "start" | undefined;
  if (publicCopy) {
    review = sc.releaseReviewFor(latest!) ?? "start";
  }
  // a development origin: a tag is brought in by itself only on its tag CI's result (a public copy has the check of the diff instead)
  const auto = sc.settings().release.auto;
  const ci = latest && !publicCopy && auto === "promote" && latest.sha !== current && !latestInCurrent ? await sc.tagCi(latest.tag, latest.sha) : undefined;
  sc.drainHold(); // time is applied before the next state is made from it
  // a restart asked for by hand that is still on its way: its hold is not this check's to change
  const foreign = askedInFlight(sc.promotionDrain, !!(status as RescueStatus).busy, Date.now(), 2 * askedPollMs(sc));
  const settle = (tag: string | null, mode: Parameters<typeof nextDrain>[2]) => { if (!foreign) sc.setDrain(nextDrain(sc.promotionDrain, tag, mode, Date.now())); };
  // counted after the last await before each decision: a Task that ends while git runs either counts as ended here or finds the hold set
  const decide = (needsRestart = false) => promotionStep({ status: status as ReleaseState, latest, busyTasks: sc.drainBusy(), latestInCurrent, review, auto, needsRestart, bundle: sc.bundleHold(), ci, requireCi: sc.settings().release.tagCi });
  const send = async (p: Extract<PromotionStep, { action: "promote" }>): Promise<{ status: number; restart: boolean; heavy: boolean; error: string }> => {
    try {
      const r = await (source ? sc.requestPromote(p.tag, p.sha, !!p.ifNoRestart) : sc.requestPromote(p.sha, undefined, !!p.ifNoRestart));
      return { status: r.status, restart: (r.body as { restart?: unknown }).restart === true, heavy: (r.body as { heavy?: unknown }).heavy === true, error: JSON.stringify(r.body) };
    } catch (e) {
      return { status: 0, restart: false, heavy: false, error: String((e as Error).message ?? e) };
    }
  };
  // A request that restarts: new starts are held from the count (no await between `decide` and here) until the restart, so
  // no turn begins in between; a request sb-rescue did not take puts back what was there.
  const askRestart = async (p: Extract<PromotionStep, { action: "promote" }>) => {
    const before = sc.promotionDrain;
    const mine = foreign ? null : nextDrain(before, p.tag, "asked", Date.now());
    if (mine) sc.setDrain(mine);
    let a: Awaited<ReturnType<typeof send>> | null = null;
    try {
      a = await send(p);
      return a;
    } finally {
      if (a?.status !== 202 && mine && sc.promotionDrain === mine) sc.setDrain(nextDrain(before, p.tag, "keep", Date.now()));
      if (sc.promotionDrain?.state === "asked") sc.watchAsked();
    }
  };
  let step = decide();
  let answer: Awaited<ReturnType<typeof send>> | null = null;
  if (step.action === "promote" && step.ifNoRestart) {
    answer = await send(step);
    // asked as a switch that keeps the Tasks, and this release needs a restart: decided again — it waits for the Tasks, or goes in now when none is left
    if (answer.status === 409 && answer.restart) {
      step = decide(true);
      answer = null;
    }
  }
  if (step.action === "promote" && !step.ifNoRestart) answer = await askRestart(step);
  const accepted = answer?.status === 202;
  // the drain after this decision (a restart that was asked for has set its own above); no await since the last count
  if (step.action === "pick") settle(null, "done");
  else if (step.action === "review") settle(latest!.tag, "off");
  else if (step.action === "wait") settle(latest!.tag, step.drain ? "drain" : step.failed ? "done" : step.review || step.ci || step.bundle ? "off" : "keep");
  else if (step.ifNoRestart) settle(latest!.tag, accepted ? "done" : "keep");
  let reviewNote: string | null = null;
  if (step.action === "review") {
    // from a source a start that failed (GitHub not answering, a moved tag) is tried again only after a while, as each
    // try spends GitHub's unauthenticated calls; the re-check on the screen is not held back
    const key = `${latest!.tag}@${latest!.sha}`;
    const failed = source ? sc.reviewStartFailed.get(key) : undefined;
    if (failed !== undefined && Date.now() - failed.at < sc.REVIEW_RETRY_MS) {
      // the first reason stays while it waits (it already names the tag)
      reviewNote = `${failed.reason}。${new Date(failed.at + sc.REVIEW_RETRY_MS).toLocaleTimeString("ja-JP")} ごろにまた試す`;
    } else {
      reviewNote = await sc.startReleaseReview(latest!.tag, latest!.sha, current!, source);
      if (source && reviewNote) sc.reviewStartFailed.set(key, { at: Date.now(), reason: reviewNote });
      else sc.reviewStartFailed.delete(key);
    }
  }
  const heldTag = step.action === "wait" ? (step.failed?.tag ?? latest!.tag) : step.action === "review" ? latest!.tag : null;
  if (heldTag === null) sc.heldSince = null;
  else if (sc.heldSince?.tag !== heldTag) sc.heldSince = { tag: heldTag, at: Date.now() };
  sc.promotionHold = step.action === "wait" ? { tag: heldTag!, failed: !!step.failed, tasks: !!step.drain, ...(step.ci ? { ci: true } : {}), reason: step.reason, since: sc.heldSince!.at } : step.action === "review" ? { tag: heldTag!, failed: false, tasks: false, reason: reviewNote ?? `${latest!.tag} の差分を確認中`, since: sc.heldSince!.at } : null;
  if (step.action === "pick") return null;
  // a check started, running, or not ok is not a failure of the version: the backlog goes on while it holds (hold.reason shows it)
  // nor is a tag CI that failed or has no result yet: what runs is the version before it (the hold is told in 判断待ち: `tagCiNote`)
  if (step.action === "review" || (step.action === "wait" && (step.review || step.ci))) return null;
  if (step.action === "promote") {
    const asked = { tag: step.tag, sha: step.sha, at: Date.now(), by };
    if (accepted) { sc.promotionAsked = asked; return `${step.tag} の昇格を依頼${step.ifNoRestart ? "（Task を切らない切り替え）" : ""}`; }
    sc.promotionAsked = { ...asked, error: answer!.error };
    // asked under running Tasks, and sb-rescue builds only inside a heavy-process slot: none was free (the next check asks again)
    if (answer!.status === 409 && answer!.heavy) return `${step.tag} の昇格（Task を切らない切り替え）は、重い処理の枠が空くまでビルドしない: ${answer!.error}`;
    return `${step.tag} の昇格を依頼できない: ${answer!.error}`;
  }
  if (step.failed && !report) return step.reason; // the interval check does not write 判断待ち (an origin that is only followed takes no comments)
  if (step.failed) {
    const subject = await sc.git(["log", "-1", "--format=%s", step.failed.sha]).catch(() => "");
    const source = sc.db.getWorkspaceBacklogSource(meta.id);
    const pbi = source ? await reportPromoteFailure(sc.db, source, sc.opts.gh ?? runGh, meta.path, { ...step.failed, subject, rescueUrl: sc.cfg.rescuePageUrl ?? RESCUE_IN_CONTAINER }).catch(() => null) : null;
    if (pbi) sc.backlog.send(meta);
    return `${step.reason}${pbi ? `（判断待ち: #${pbi}）` : ""}`;
  }
  return step.reason;
};

export const askPromotion = (sc: Pick<ServerContext, "promotionAsking" | "promotionHold" | "askPromotion" | "metaWorkspace" | "promotionFirst">, by: "check" | "backlog-next" | "idle"): Promise<string | null> => {
  const report = by !== "check";
  if (sc.promotionAsking) {
    if (!report || sc.promotionAsking.report) return sc.promotionAsking.asking;
    return sc.promotionAsking.asking.then((why) => (sc.promotionHold?.failed ? sc.askPromotion(by) : why));
  }
  const meta = sc.metaWorkspace();
  if (!meta) return Promise.resolve(null);
  const asking = sc.promotionFirst(meta, { report, by }).finally(() => { if (sc.promotionAsking?.asking === asking) sc.promotionAsking = null; });
  sc.promotionAsking = { asking, report };
  return asking;
};

/**
 * A promotion held only by Tasks is asked for at the first moment no Task would be cut (no turn under way or stopped on
 * an approval, no background job), not at the next firing. When that ask could not decide (sb-rescue did not answer)
 * or was not taken while new starts are still held, it is tried again shortly: nothing runs and nothing may start, so
 * no later turn's end would come to try it.
 */
export const promoteWhenIdle = (sc: Pick<ServerContext, "promotionHold" | "drainBusy" | "metaWorkspace" | "askPromotion" | "scheduler" | "promotionDrain" | "idleRetry" | "opts" | "stopped" | "promoteWhenIdle">) => {
  if (!sc.promotionHold || sc.promotionHold.failed || sc.drainBusy() > 0) return;
  if (!sc.metaWorkspace()) return;
  const was = sc.promotionHold;
  sc.promotionHold = null; // before the await: a second Task ending meanwhile does not ask again
  const after = () => {
    const d = sc.promotionDrain;
    if (sc.stopped || sc.promotionHold || !(d?.state === "drain" && d.lifted === undefined) || sc.idleRetry) return;
    sc.promotionHold = was;
    sc.idleRetry = setTimeout(() => { sc.idleRetry = null; if (!sc.stopped) sc.promoteWhenIdle(); }, sc.opts.promotionIdleRetryMs ?? 10_000);
    sc.idleRetry.unref();
  };
  void sc.askPromotion("idle").then((why) => { if (why) sc.scheduler.note(`バックログを進める: Task が空いたので ${why}`); }, () => undefined).then(after);
};

export const armPromotionCheck = (sc: Pick<ServerContext, "cfg" | "promotionTimer" | "opts" | "settings" | "nextPromotionCheckAt" | "armPromotionCheck" | "askPromotion" | "lastCheck" | "scheduler">) => {
  if (!sc.cfg.rescueUrl || isWorkMachine(sc.cfg)) return;
  if (sc.promotionTimer) clearTimeout(sc.promotionTimer);
  const ms = sc.opts.promotionCheckMs ?? sc.settings().release.checkMinutes * 60_000;
  sc.nextPromotionCheckAt = Date.now() + ms;
  sc.promotionTimer = setTimeout(() => {
    sc.armPromotionCheck();
    void sc.askPromotion("check").then((why) => {
      if (why === sc.lastCheck) return;
      sc.lastCheck = why;
      if (why) sc.scheduler.note(`最新のタグの確認: ${why}`);
    }, () => undefined);
  }, ms);
  sc.promotionTimer.unref();
};

export const nextWakeAt = (sc: Pick<ServerContext, "db" | "savedAutoResume">) => nextWakeFrom(sc.db.listTasksWithResume().map((t) => ({ resumeAt: t.resumeAt ?? null, auto: sc.savedAutoResume(t.runner) })), sc.db.listSchedules());

export function setupPromotion(sc: Pick<ServerContextInit, "askedWatch" | "idleRetry" | "tagCiKnown" | "promotionHold" | "heldSince" | "promotionAsked" | "tasks" | "releaseReviewEnded" | "reviewStartFailed" | "REVIEW_RETRY_MS" | "sourceLatest" | "rechecking" | "releaseKnown" | "promotionAsking" | "promoteWhenIdle">): void {
  /**
   * Why the last promotionFirst held the newest tag: Tasks running (asked again once they end) or a tag that
   * failed. Memory only: a restart forgets it and the next firing makes it again. `GET /api/daemon/release` shows it.
   * `since`: when it began to hold that tag, kept while the same tag is held (promoteWhenIdle clears the hold
   * before it asks again, so the first sight is kept apart in `heldSince`).
   */
  sc.promotionHold = null;
  sc.heldSince = null;
  sc.askedWatch = null;
  sc.idleRetry = null;
  sc.tagCiKnown = new Map<string, { result: TagCi; at: number }>();
  /**
   * The last promotion this daemon asked sb-rescue for — or why it could not ask. Memory only, like promotionHold:
   * a promotion restarts the daemon, and sb-rescue's `history` has the result after that. `GET /api/daemon/release` shows it.
   */
  sc.promotionAsked = null;
  sc.tasks.onTurnEnd(sc.releaseReviewEnded);
  sc.tasks.onTaskEnd(sc.releaseReviewEnded);
  /**
   * The newest release of an update source, from sb-rescue (`GET /api/latest-release`: one or two calls to GitHub's
   * unauthenticated API, 60 an hour). Kept 10 minutes (a failure 5 minutes) so the interval check, the firings and the
   * screen's polling together stay well under that. Null = could not be told.
   */
  /** From an update source: when a start of the check of `<tag>@<sha>` last failed and why, and how long until it is tried again. */
  sc.reviewStartFailed = new Map<string, { at: number; reason: string }>();
  sc.REVIEW_RETRY_MS = 10 * 60_000;
  sc.sourceLatest = null;
  sc.rechecking = false;
  /**
   * Whether a merge commit is in the release that runs, for the `（リリース）` prerequisites: only Switchboard's own
   * workspace (meta) under sb-rescue can tell — `git merge-base --is-ancestor <oid> <current>`, once per commit while
   * `current` stays; anything else answers null (cannot tell, so not met), a commit the checkout does not have too. The commits asked about are the ones the
   * stored prerequisites name.
   */
  sc.releaseKnown = null;
  /**
   * The one way to ask for the newest tag: the backlog-next firing, a Task ending and the interval check come
   * here, and while one asks, the others get its answer, so the same tag is not asked for twice. Only the check does not
   * report a failed tag as ## 判断待ち; a caller that reports and joined a check asks once more when that check found a
   * failed tag (a failed tag is never promoted, so asking again cannot ask /api/promote twice).
   */
  sc.promotionAsking = null;
  sc.tasks.onTurnEnd(sc.promoteWhenIdle);
  sc.tasks.onTaskEnd(sc.promoteWhenIdle);
  sc.tasks.onBackgroundEmpty(sc.promoteWhenIdle);
}

export function setupPromotionCheck(sc: Pick<ServerContextInit, "lastCheck" | "promotionTimer" | "nextPromotionCheckAt" | "armPromotionCheck">): void {
  // Under sb-rescue the newest tag is read on an interval (`settings.release.checkMinutes`) with no schedule registered.
  // The interval is read each time the timer is set, and a saved change sets it again. The result is
  // noted only when it differs from the last check's: a Task that runs for hours does not add the same line every time.
  sc.lastCheck = undefined;
  sc.promotionTimer = null;
  sc.nextPromotionCheckAt = null;
  sc.armPromotionCheck();
}
