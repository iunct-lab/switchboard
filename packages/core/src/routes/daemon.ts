import { isSupervised, restartArgv } from "../selfdev.ts";
import type { ReleaseState } from "../promotion.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/daemon. */
export function daemonRoutes(sc: Pick<ServerContext, "callingTask" | "strong" | "readJson" | "restarting" | "bad" | "db" | "selfdev" | "logOp" | "opts" | "json" | "broadcast" | "performRestart" | "releaseStatus" | "latestRelease" | "git" | "releaseReviewFor" | "cfg" | "busyTasks" | "promotionAsked" | "promotionHold" | "drainBusy" | "drainView" | "nextPromotionCheckAt" | "rechecking" | "tasks" | "startReleaseReview" | "askPromotion" | "latestOfSource" | "UPSTREAM_FAILED" | "clientOf" | "requestPromote" | "holdForRestart">): Routes {
  return {
    // Restart the daemon on the current code. Gate: no task running/waiting, no check in flight, and a *current*
    // passing check run for the task — `force: true` skips the gates. Under scripts/dev.ts the daemon exits with
    // RESTART_EXIT_CODE and the supervisor respawns it; standalone it spawns a detached replacement, waits for it
    // to serve /api/health, and comes back up on the old code if that never happens.
    "/api/daemon/restart": {
      POST: sc.strong(async (req, srv) => {
        const body = await sc.readJson(req, (x) => x as { taskId?: string; force?: boolean });
        if (sc.restarting) return sc.bad("already restarting", 409);
        const gate = () => {
          const busy = sc.db.listWorkingTasks("gate");
          if (busy.length) return `${busy.length} task(s) still running; wait or force`;
          if (sc.selfdev.isRunning()) return "checks are still running; wait or force";
          return null;
        };
        if (!body.force) {
          const why = gate();
          if (why) return sc.bad(why, 409);
          if (!body.taskId) return sc.bad("taskId required (the task whose checks vouch for this tree), or force", 400);
          const run = sc.selfdev.last(body.taskId);
          if (!run) return sc.bad("run the checks first", 409);
          if (!sc.selfdev.isCurrent(run)) return sc.bad("the tree changed since these checks ran; run them again", 409);
          if (!run.ok) return sc.bad(`checks failed (${run.results.filter((r) => !r.ok).map((r) => r.summary).join("; ")}); fix or force`, 409);
        }
        let argv: string[];
        try {
          argv = restartArgv();
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 500);
        }
        const supervised = isSupervised();
        sc.logOp(req, srv, "daemon.restart", body.taskId ? { task: body.taskId } : {});
        if (sc.opts.dryRunRestart) return sc.json({ restarting: false, supervised, argv });
        sc.restarting = true;
        sc.broadcast({ type: "daemon.restarting" });
        setTimeout(() => void sc.performRestart(argv, supervised, !!body.force), 200);
        return sc.json({ restarting: true, supervised, argv }, 202);
      }),
    },
    // Releases. Under sb-rescue the daemon runs from an immutable release, so new code arrives by promoting
    // a commit, and sb-rescue does all of it (candidate check, switch, automatic rollback). The daemon only relays:
    // it cannot be trusted to judge or survive its own replacement.
    "/api/daemon/release": async () => {
      const s = await sc.releaseStatus();
      if (!s.managed) return sc.json({ ...s, latestRelease: await sc.latestRelease(null).catch(() => null) });
      try {
        // `ahead`: commits in HEAD that the running version lacks — 0 when HEAD is the running version or inside it;
        // null when it cannot be counted (the running version is not in this checkout, git failed).
        // `behind` is its pair: commits in the running version that HEAD lacks. > 0 with `ahead` 0 = HEAD is an ancestor of what
        // runs (the checkout does not follow the tag), so "up to date" and promoting HEAD would be wrong.
        // from an update source the running version is an unpacked tarball (no .git, maybe no git): there is no checkout, so
        // the running version stands for HEAD (nothing ahead or behind) and the panel shows no HEAD line beside a newer release
        const [head, dirty, headSubject, ahead, behind] = s.source ? [s.current, "", null, 0, 0] : await Promise.all([
          sc.git(["rev-parse", "HEAD"]), sc.git(["status", "--porcelain"]), sc.git(["log", "-1", "--format=%s", "HEAD"]),
          s.current ? sc.git(["rev-list", "--count", `${s.current}..HEAD`]).then(Number, () => null) : Promise.resolve(null),
          s.current ? sc.git(["rev-list", "--count", `HEAD..${s.current}`]).then(Number, () => null) : Promise.resolve(null),
        ]);
        // a public copy's clone: the newest release and the check of its diff (null on a development origin)
        const latest = await sc.latestRelease(s.current, s.source).catch(() => null);
        const review = latest ? sc.releaseReviewFor(latest) : null;
        return sc.json({ managed: true, latestRelease: latest, review, rescuePage: sc.cfg.rescuePageUrl, rescueInContainer: sc.cfg.rescueInContainer || undefined, head, headSubject, ahead, behind, busyTasks: sc.busyTasks(), dirty: dirty !== "", current: s.current, running: s.running ?? null, previous: s.previous, state: s.state, busy: s.busy, lastError: s.lastError ?? null, history: s.history.slice(0, 5), asked: sc.promotionAsked, hold: sc.promotionHold ? { ...sc.promotionHold, busyTasks: sc.drainBusy() } : null, drain: sc.drainView(), nextCheckAt: sc.nextPromotionCheckAt });
      } catch (e) {
        return sc.json({ managed: false, error: `sb-rescue did not answer at ${sc.cfg.rescueUrl}: ${String((e as Error).message ?? e)}` });
      }
    },
    // Check the newest release's diff again after it could not be checked or found a concern. Promotion itself stays
    // `/api/daemon/promote`: the dialog on the screen is the confirmation (a mark on the API would not stop a caller of it).
    "/api/daemon/release/review": {
      POST: sc.strong(async () => {
        const s = await sc.releaseStatus();
        if (!s.managed) return sc.bad("this daemon does not run from a release (start it with sb-rescue)", 409);
        const latest = await sc.latestRelease(s.current, s.source).catch(() => null);
        if (!latest) return sc.bad("this clone has no public release to check", 409);
        const review = sc.releaseReviewFor(latest);
        if (review?.state === "running" || sc.rechecking) return sc.bad(`${latest.tag} の差分を確認中です`, 409);
        // never checked (the automatic check is switched off, or has not come yet), or checked and not cleared
        if (review ? review.state !== "failed" && review.state !== "concern" : !latest.newer) return sc.bad(`${latest.tag} は確かめ直す状態ではありません`, 409);
        sc.rechecking = true;
        try {
          // the old check waiting to resume (a usage limit) is superseded: it shares the folder, and its end would remove the new one's
          if (review?.state === "failed") { const old = sc.db.getTask(review.taskId); if (old?.resumeAt != null) sc.tasks.setResumeAt(old.id, null); }
          const why = await sc.startReleaseReview(latest.tag, latest.sha, s.current!, s.source);
          if (why) return sc.bad(why, 500);
          sc.promotionHold = null;
          await sc.askPromotion("idle").catch(() => undefined); // the hold now says the check is running
          return sc.json({ started: "review", tag: latest.tag }, 202);
        } finally {
          sc.rechecking = false;
        }
      }),
    },
    "/api/daemon/promote": {
      POST: sc.strong(async (req, srv) => {
        if (!sc.cfg.rescueUrl) return sc.bad("this daemon does not run from a release (start it with sb-rescue)", 409);
        // The Task that asks (scripts/promote.ts) accepts being cut itself: it is left out of the count when the request
        // proves it is that Task's (`callingTask`), and every other Task still counts. A Task named in the body is not
        // left out: a request without the proof counts every Task.
        // `force`: the person's 待たずに昇格する, the one way a running or waiting Task is cut for a promotion.
        const body = await sc.readJson(req, (x) => x as { commit?: string; force?: boolean });
        const asking = sc.callingTask(req, srv);
        const busy = sc.db.listWorkingTasks("gate").filter((t) => t.id !== asking);
        if (busy.length && !body.force) return sc.json({ error: `${busy.length} task(s) still running or waiting; a promotion restarts the daemon — wait or force`, busy: busy.map((t) => ({ id: t.id, title: t.title, status: t.status })) }, 409);
        // counted and held with no await in between: nothing new starts from here until the restart, or until sb-rescue says no
        const held = sc.holdForRestart(body.commit?.slice(0, 12) ?? "HEAD");
        let taken = false;
        try {
          // an update source builds by tag: the newest release (named by its tag or its commit) is asked for with the commit that was seen
          const source = await sc.releaseStatus().then((s) => (s.managed ? (s as ReleaseState).source ?? null : null));
          const newest = source ? await sc.latestOfSource(source) : null;
          if (source && !newest) return sc.bad(`${source} の最新のリリースを確かめられない`, sc.UPSTREAM_FAILED);
          if (source && body.commit !== undefined && body.commit !== newest!.tag && body.commit !== newest!.sha) return sc.bad(`更新元から昇格できるのは最新のリリース ${newest!.tag} だけです`, 409);
          const commit = source ? newest!.sha : body.commit ?? (await sc.git(["rev-parse", "HEAD"]));
          const from = sc.clientOf(req, srv);
          const r = await (source ? sc.requestPromote(newest!.tag, newest!.sha) : sc.requestPromote(commit));
          taken = r.status >= 200 && r.status < 300;
          if (taken) sc.logOp(req, srv, "daemon.promote", { detail: { commit } }, from); // sb-rescue took it
          return sc.json({ ...r.body, commit }, r.status);
        } catch (e) {
          return sc.bad(`sb-rescue did not answer at ${sc.cfg.rescueUrl}: ${String((e as Error).message ?? e)}`, sc.UPSTREAM_FAILED);
        } finally {
          held(taken);
        }
      }),
    },
  };
}
