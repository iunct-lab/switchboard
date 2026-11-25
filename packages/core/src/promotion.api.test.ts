// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_JOB_TASK, BUNDLE_HOLD_KEY, type BacklogSource, type Job } from "@switchboard/protocol";
import { type CoreServer } from "./server.ts";
import { localBacklogSource, type GhRunner } from "./backlog-gh.ts";
import { tagCi } from "./server/promotion.ts";
import { Db } from "./db.ts";
import { loadConfig } from "./config.ts";
import { JobError, jobCommand, requestJob, type JobDeps } from "./jobs.ts";
import { promotionStep, nextDrain, expireDrain, drainHeld, askedInFlight, drainNote, tagCiOf, tagCiPlan, TAG_CI_ATTEMPTS, TAG_CI_RETRY_MS, reportPromoteFailure, type PromotionDrain, type ReleaseState } from "./promotion.ts";
import { CHECK, STOPPED, backlogNextSchedule, boot, endableClaude, fakeGh, holdingClaude, metaId, refreshed, releaseBody, releaseHold, releasedDaemon, runSchedule, scheduleLog, scheduleLogAll, settle, start, startServer, useBacklogDaemon, waitsGh } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

const released = (over: Partial<ReleaseState> = {}): ReleaseState => ({ managed: true, current: "aaa", history: [], ...over });

const v2 = { tag: "v0.2.0", sha: "bbb" };

test("promote: promotionStep — only under sb-rescue, only a newer tag, never while tasks run, never a tag that failed", () => {
  expect(promotionStep({ status: released({ managed: false }), latest: v2, busyTasks: 0 })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released(), latest: null, busyTasks: 0 })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released({ current: "bbb" }), latest: v2, busyTasks: 0 })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0 })).toEqual({ action: "promote", tag: "v0.2.0", sha: "bbb" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 2 })).toEqual({ action: "wait", reason: "2 件の Task が動いているので v0.2.0 の昇格を待つ", drain: true });
  for (const h of [
    { action: "rejected", from: "aaa", to: "bbb", ok: false, reason: "the candidate did not answer" },
    { action: "auto-rollback", from: "bbb", to: "aaa", ok: false, reason: "went back by itself: health" },
  ]) {
    expect(promotionStep({ status: released({ history: [h] }), latest: v2, busyTasks: 0 })).toEqual({ action: "wait", reason: "昇格に失敗した版のまま: v0.2.0", failed: { tag: "v0.2.0", sha: "bbb", reason: h.reason } });
  }
  // a rollback chosen by hand, or a promote refused before it started, is not a failure of the version
  for (const h of [
    { action: "rollback", from: "bbb", to: "aaa", ok: true, reason: "chosen on the rescue page" },
    { action: "promote", from: "aaa", to: "bbb", ok: false, reason: "no earlier release" },
  ]) {
    expect(promotionStep({ status: released({ history: [h] }), latest: v2, busyTasks: 0 }).action).toBe("promote");
  }
  // what runs already contains the tag's commit (a newer commit promoted by hand): never go back to the tag
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, latestInCurrent: true })).toEqual({ action: "pick" });
  // sb-rescue is promoting: the next check does not ask for the same tag again
  expect(promotionStep({ status: released({ busy: "promote" }), latest: v2, busyTasks: 0 })).toEqual({ action: "wait", reason: "sb-rescue が promote の最中なので v0.2.0 の昇格を待つ" });
  // a failure of another commit does not hold this one
  expect(promotionStep({ status: released({ history: [{ action: "rejected", from: "aaa", to: "ccc", ok: false, reason: "x" }] }), latest: v2, busyTasks: 0 }).action).toBe("promote");
});

test("promote: promotionStep — under Tasks a restart would cut, only a switch that can never restart is asked for; a release that needs a restart waits for all of them", () => {
  const knows = released({ promoteKeepsTasks: true });
  const keep = { action: "promote", tag: "v0.2.0", sha: "bbb", ifNoRestart: true } as const;
  // busyTasks is every Task a restart would cut: running, stopped on an approval or a question, with background jobs
  expect(promotionStep({ status: knows, latest: v2, busyTasks: 2 })).toEqual(keep);
  // nothing to cut: the plain request
  expect(promotionStep({ status: knows, latest: v2, busyTasks: 0 })).toEqual({ action: "promote", tag: "v0.2.0", sha: "bbb" });
  // a sb-rescue without the mark is not asked while Tasks are there — neither one that does not know `ifNoRestart`, nor
  // one that knows it but goes back with a restart when the reload is not confirmed (it would cut every Task)
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 2 })).toMatchObject({ action: "wait", drain: true });
  expect(promotionStep({ status: released({ promoteWithoutRestart: true } as Partial<ReleaseState>), latest: v2, busyTasks: 2 })).toMatchObject({ action: "wait", drain: true });
  // a promotion in flight is not asked again, and is no wait for the Tasks
  expect(promotionStep({ status: released({ promoteKeepsTasks: true, busy: "promote" }), latest: v2, busyTasks: 2 })).toEqual({ action: "wait", reason: "sb-rescue が promote の最中なので v0.2.0 の昇格を待つ" });
  // sb-rescue answered that this tag needs a restart: it waits while any Task would be cut — one is enough, whatever it is doing
  expect(promotionStep({ status: knows, latest: v2, busyTasks: 3, needsRestart: true })).toEqual({ action: "wait", reason: "3 件の Task が動いていて、差分に動いているデーモンが読むファイルがあるか、読むかを確かめられないので v0.2.0 の昇格を待つ", drain: true });
  expect(promotionStep({ status: knows, latest: v2, busyTasks: 1, needsRestart: true })).toMatchObject({ action: "wait", drain: true });
  expect(promotionStep({ status: knows, latest: v2, busyTasks: 0, needsRestart: true })).toEqual({ action: "promote", tag: "v0.2.0", sha: "bbb" });
  // a failed tag is never asked for, that way either
  expect(promotionStep({ status: released({ promoteKeepsTasks: true, history: [{ action: "rejected", from: "aaa", to: "bbb", ok: false, reason: "x" }] }), latest: v2, busyTasks: 2 })).toMatchObject({ action: "wait", failed: { tag: "v0.2.0" } });
});

test("promote: promotionStep — a tag the tag CI failed is never brought in by itself, and one without a result waits unless the setting says no-fail", () => {
  const go = { action: "promote", tag: "v0.2.0", sha: "bbb" } as const;
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, ci: "pass" })).toEqual(go);
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, ci: "fail" })).toEqual({ action: "wait", reason: "v0.2.0 はタグの CI が失敗しているので自動では昇格しない", ci: true });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, ci: "fail", requireCi: "no-fail" })).toMatchObject({ action: "wait", ci: true });
  // a promotion does not wait for the tag CI unless the setting says so
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, ci: "none" })).toEqual(go);
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, ci: "none", requireCi: "pass" })).toEqual({ action: "wait", reason: "v0.2.0 のタグの CI の結果がまだ無いので自動の昇格を待つ", ci: true });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, ci: "none", requireCi: "no-fail" })).toEqual(go);
  // not held by Tasks: no drain is asked for, with Tasks running too, and no switch without a restart either
  expect(promotionStep({ status: released({ promoteKeepsTasks: true }), latest: v2, busyTasks: 2, ci: "fail" })).toEqual({ action: "wait", reason: "v0.2.0 はタグの CI が失敗しているので自動では昇格しない", ci: true });
  // not asked (a public copy: the check of the diff decides): as before
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0 })).toEqual(go);
});

test("promote: promotionStep — how far a new tag goes by itself: promote (the default), the check only, or nothing", () => {
  const review = (state: "ok" | "concern") => ({ tag: "v0.2.0", sha: "bbb", state, findings: state === "ok" ? [] : [{ path: "a.ts", why: "x" }], reason: null, taskId: "t", at: 0 });
  // off: neither the check nor the promotion, and the backlog goes on
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto: "off" })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto: "off", review: "start" })).toEqual({ action: "pick" });
  // review: the check starts and its result holds as before, but a cleared tag is left for the person
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto: "review", review: "start" })).toEqual({ action: "review" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto: "review", review: review("concern") })).toMatchObject({ action: "wait", reason: "v0.2.0 の差分の確認で懸念 1 件" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto: "review", review: review("ok") })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto: "review" })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto: "promote", review: review("ok") })).toEqual({ action: "promote", tag: "v0.2.0", sha: "bbb" });
  // a tag that failed still holds, whatever the setting
  const failed = released({ history: [{ action: "auto-rollback", from: "bbb", to: "aaa", ok: false, reason: "x" }] });
  for (const auto of ["off", "review"] as const) expect(promotionStep({ status: failed, latest: v2, busyTasks: 0, auto })).toMatchObject({ action: "wait", failed: { tag: "v0.2.0" } });
});

test("promote: the drain — one clock for the whole wait: a newer tag replaces the tag, not the clock; the limit ends the hold and cuts nothing", () => {
  const d = nextDrain(null, "v2", "drain", 1000);
  expect(d).toEqual({ tag: "v2", since: 1000, state: "drain" });
  expect(drainHeld(d)).toBe(true);
  // the same tag again is the same wait; sb-rescue busy or a refused request changes nothing
  expect(nextDrain(d, "v2", "drain", 2000)).toBe(d);
  expect(nextDrain(d, "v2", "keep", 2000)).toBe(d);
  expect(nextDrain(null, "v2", "keep", 2000)).toBeNull();
  // a newer tag while the Tasks still run: the tag changes, the clock does not
  const d3 = nextDrain(d, "v3", "drain", 2000);
  expect(d3).toEqual({ tag: "v3", since: 1000, state: "drain" });
  expect(nextDrain(d, "v3", "keep", 2000)).toEqual({ tag: "v3", since: 1000, state: "drain" });
  // the limit: counted from the first wait, whatever the tag is now
  expect(expireDrain(d3, 500, 9999, 1500)).toBe(d3);
  const gone = expireDrain(d3, 500, 9999, 1501);
  expect(gone).toEqual({ tag: "v3", since: 1000, state: "drain", lifted: 1501 });
  expect(drainHeld(gone)).toBe(false);
  expect(expireDrain(gone, 500, 9999, 99_999)).toBe(gone);
  expect(expireDrain(null, 500, 9999, 99_999)).toBeNull();
  // once lifted, no later tag sets the hold up again — the promotion is still pending (the state stays, so it is shown and told)
  const v4 = nextDrain(gone, "v4", "drain", 3000);
  expect(v4).toEqual({ tag: "v4", since: 1000, state: "drain", lifted: 1501 });
  expect(drainHeld(v4)).toBe(false);
  expect(drainHeld(expireDrain(v4, 500, 9999, 3001))).toBe(false);
  // a version held by its diff's check or the tag CI holds no start and keeps the clock
  const off = nextDrain(d, "v3", "off", 2000);
  expect(off).toEqual({ tag: "v3", since: 1000, state: "off" });
  expect(drainHeld(off)).toBe(false);
  expect(nextDrain(off, "v3", "drain", 2500)).toEqual({ tag: "v3", since: 1000, state: "drain" });
  expect(nextDrain(null, "v3", "off", 2000)).toBeNull();
  // over: nothing to bring in, a switch without a restart taken, a version that failed after it got its moment
  expect(nextDrain(gone, null, "drain", 3000)).toBeNull();
  expect(nextDrain(gone, "v3", "done", 3000)).toBeNull();
  // a restart asked for: held from the request, after a lifted wait too, with the wait's clock kept
  const asked = nextDrain(gone, "v4", "asked", 4000);
  expect(asked).toEqual({ tag: "v4", since: 1000, state: "asked", askedAt: 4000, lifted: 1501 });
  expect(drainHeld(asked)).toBe(true);
  expect(nextDrain(null, "v2", "asked", 4000)).toEqual({ tag: "v2", since: 4000, state: "asked", askedAt: 4000 });
  // it is on its way while sb-rescue is busy, and for the grace after the request; after that the promotion ended without a restart
  expect(askedInFlight(asked, true, 99_999, 100)).toBe(true);
  expect(askedInFlight(asked, false, 4050, 100)).toBe(true);
  expect(askedInFlight(asked, false, 4100, 100)).toBe(false);
  expect(askedInFlight(d, true, 4100, 100)).toBe(false);
  // a restart that never comes holds nothing after its own bound (the wait's limit does not apply to it)
  expect(expireDrain(asked, 1, 500, 4500)).toBe(asked);
  const lapsed = expireDrain(asked, 1, 500, 4501);
  expect(lapsed).toEqual({ tag: "v4", since: 1000, state: "off", lifted: 1501 });
  expect(drainHeld(lapsed)).toBe(false);
});

test("promote: the notice of a wait past its limit names the minutes and the Tasks that hold it, and is there only while they do", () => {
  const lifted: PromotionDrain = { tag: "v0.2.0", since: 0, state: "drain", lifted: 3_600_001 };
  const tasks = [{ title: "PBI を進める", status: "running" }, { title: "マージ", status: "waiting" }];
  expect(drainNote(lifted, tasks, 61 * 60_000)).toEqual({
    title: "昇格待ち: v0.2.0 が 61 分待っている（動いている・待っている Task 2 件）",
    body: "待たせている Task: PBI を進める（実行中）、マージ（承認・回答待ち）。新しいターンと Task を止めておく上限を過ぎたので、止めるのはやめた。アプリは Task を切らず、この Task が全部止まったときに昇格する",
    at: 0,
  });
  // before the limit, with no Task left, once the restart is asked for, or for a version held by something else: no notice
  expect(drainNote({ tag: "v0.2.0", since: 0, state: "drain" }, tasks, 1000)).toBeNull();
  expect(drainNote(lifted, [], 1000)).toBeNull();
  expect(drainNote({ ...lifted, state: "asked", askedAt: 1 }, tasks, 1000)).toBeNull();
  expect(drainNote({ ...lifted, state: "off" }, tasks, 1000)).toBeNull();
  expect(drainNote(null, tasks, 1000)).toBeNull();
});

/**
 * The failure report's stored backlog: PBI 499, its Task 500 and (when `pr`) PR 501 closing Issue 500, in a Db under `source`.
 * Its gh answers `gh pr view` only (`prView`: the PR's body and branch, else "not a PR") and counts every call.
 */
function reportStore(source: BacklogSource, opts: { pr?: boolean; prView?: { body: string; headRefName: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-promote-"));
  const db = new Db(join(dir, "x.db"));
  const at = "2030-01-01T00:00:00Z";
  const issue = (number: number, labels: string[], parent: number | null, body: string) =>
    ({ objectKind: "issue" as const, externalId: `I${number}`, fetchState: "fetched" as const, remote: { number, title: `#${number}`, url: "", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues: number === 499 ? [500] : [], createdAt: at, updatedAt: at, closedAt: null } });
  const pr = { objectKind: "pull-request" as const, externalId: "PR501", fetchState: "fetched" as const, remote: { number: 501, state: "MERGED", isDraft: false, labels: [], closes: [500], mergeCommit: "bbbbbbbbbb", updatedAt: at, files: [], closedAt: at, mergedAt: at } };
  db.putBacklogSnapshot(source, { records: [issue(499, ["type:pbi"], null, "## ユーザーストーリー"), issue(500, ["type:task"], 499, "## 親 PBI\n#499"), ...(opts.pr ? [pr] : [])] as never, cursor: null, syncedAt: Date.now() });
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view" && opts.prView) return { code: 0, stdout: JSON.stringify(opts.prView), stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
  const comments = () => db.listBacklogRecords(source, "comment").map((r) => (r.local ?? r.remote) as { issue: number; body: string });
  const labelOps = () => db.listPendingBacklogOperations(source).filter((o) => o.kind === "set" && o.field === "label:needs-decision").map((o) => [o.target, o.payload]);
  return { db, gh, calls, comments, labelOps, done: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

const failure = { tag: "v0.2.0", sha: "bbbbbbbbbb", subject: "feat(core): x (#501)", reason: "went back by itself: health", rescueUrl: "https://d1.example.net/rescue/" };

const githubSource: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };

test("promote: a failed version is reported once on the stored PBI behind its PR, as ## 判断待ち with the reason and the rescue page, kept to be sent", async () => {
  const f = reportStore(githubSource, { pr: true });
  try {
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", failure)).toBe(499);
    // nothing written to GitHub here, and no Issue read from it: the stored PR names its Task
    expect(f.calls).toEqual([]);
    const [c] = f.comments();
    expect(c!.issue).toBe(499);
    expect(c!.body.startsWith("## 判断待ち\n**問い**: 動いているアプリに入らなかった版 v0.2.0（bbbbbbb feat(core): x (#501)）")).toBe(true);
    expect(c!.body).toContain("went back by itself: health");
    expect(c!.body).toContain("救援画面: https://d1.example.net/rescue/");
    expect(f.labelOps()).toEqual([["I499", true]]);
    // the same commit again: one comment
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", failure)).toBe(499);
    expect(f.comments()).toHaveLength(1);
    expect(f.labelOps()).toHaveLength(1);
  } finally {
    f.done();
  }
});

test("promote: a backlog kept in the app only gets the report on its own PBI; a PR not stored is read with gh pr view (closesOf)", async () => {
  const source = localBacklogSource("ws_local");
  const f = reportStore(source, { prView: { body: "## 概要\nBacklog-Task: 500", headRefName: "sb/500-x" } });
  try {
    expect(await reportPromoteFailure(f.db, source, f.gh, "/repo", failure)).toBe(499);
    expect(f.calls.map((a) => a.slice(0, 3))).toEqual([["pr", "view", "501"]]);
    expect(f.comments().map((c) => [c.issue, c.body.split("\n")[0]])).toEqual([[499, "## 判断待ち"]]);
    expect(f.labelOps()).toEqual([["I499", true]]);
  } finally {
    f.done();
  }
});

test("promote: a subject without (#n), or a number that is no stored Issue, reports nothing", async () => {
  const f = reportStore(githubSource);
  try {
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", { ...failure, subject: "fix: no number" })).toBeNull();
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", { ...failure, subject: "fix: y (#777)" })).toBeNull();
    // a Task's own number (not a PR: gh pr view fails) reaches its PBI
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", { ...failure, subject: "fix: z (#500)" })).toBe(499);
    expect(f.comments()).toHaveLength(1);
  } finally {
    f.done();
  }
});

test("promote: a firing of the items whose waits cleared asks for the newer tag first, logs it, and starts nothing", async () => {
  const r = await releasedDaemon();
  try {
    const claude = holdingClaude();
    const states: Record<string, Record<string, unknown>> = { w778: { __typename: "PullRequest", state: "OPEN" } };
    const base = await boot(waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, states).gh, claude.adapter, r.env);
    await backlogNextSchedule(base);
    states.w778 = { ...states.w778, state: "MERGED" };
    await refreshed(base);
    for (const end = Date.now() + 3000; r.promoted.length === 0 && Date.now() < end; ) await Bun.sleep(10);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("v0.2.0 の昇格を依頼 (待ちが解けた)"));
    expect(claude.starts).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: under sb-rescue a newer tag is promoted first, and that firing starts nothing", async () => {
  const r = await releasedDaemon();
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
    const id = await backlogNextSchedule(base);
    const res = await runSchedule(base, id);
    expect([res.status, await res.json()]).toEqual([202, { promotion: "v0.2.0 の昇格を依頼" }]);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLog(base)).toContain("v0.2.0 の昇格を依頼 (manual)");
    // what was asked is shown on 動いている版: the tag, the sha, who asked
    const asked = ((await (await fetch(`${base}/api/daemon/release`)).json()) as { asked: { tag: string; sha: string; by: string; error?: string } | null }).asked;
    expect(asked).toMatchObject({ tag: "v0.2.0", sha: r.sha, by: "backlog-next" });
    expect(asked!.error).toBeUndefined();
    expect(core!.db.listTasks()).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: a release newer than the tag, promoted by hand, is not taken back to the tag", async () => {
  const r = await releasedDaemon([], true);
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(r.promoted).toEqual([]);
    expect(core!.db.listTasks()).toHaveLength(2);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: while the newest tag is one that failed, nothing is promoted or started, and its stored PBI gets one ## 判断待ち", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }]);
  const fake = fakeGh();
  try {
    // the PBI is read on a phone: the rescue page it names is the host's outside URL, not sb-rescue's own address
    const base = await boot(fake.gh, holdingClaude().adapter, { ...r.env, SWITCHBOARD_WEB_URL: "https://d1.example.net" });
    await refreshed(base);
    const source = core!.db.getWorkspaceBacklogSource(metaId())!;
    const at = "2030-01-01T00:00:00Z";
    const issue = (number: number, labels: string[], parent: number | null) =>
      ({ objectKind: "issue", externalId: `I${number}`, fetchState: "fetched", remote: { number, title: `#${number}`, url: "", state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent, subIssues: [], createdAt: at, updatedAt: at, closedAt: null } });
    const pr = { objectKind: "pull-request", externalId: "PR501", fetchState: "fetched", remote: { number: 501, state: "MERGED", isDraft: false, labels: [], closes: [500], mergeCommit: r.sha, updatedAt: at, files: [], closedAt: at, mergedAt: at } };
    core!.db.putBacklogSnapshot(source, { records: [issue(499, ["type:pbi"], null), issue(500, ["type:task"], 499), pr] as never, cursor: core!.db.getBacklogRepository(source)!.cursor, syncedAt: Date.now() });
    const id = await backlogNextSchedule(base);
    const res = await runSchedule(base, id);
    expect([res.status, await res.json()]).toEqual([202, { promotion: "昇格に失敗した版のまま: v0.2.0（判断待ち: #499）" }]);
    expect(await scheduleLog(base)).toContain("昇格に失敗した版のまま: v0.2.0（判断待ち: #499） (manual)");
    expect(r.promoted).toEqual([]);
    expect(core!.db.listTasks()).toHaveLength(0);
    // kept in the app and sent from there: comment then label, on Issue 499
    const ops = core!.db.listBacklogOperations(source).filter((o) => o.kind === "comment" || o.field === "label:needs-decision");
    expect(ops.map((o) => [o.kind, o.field ?? null])).toEqual([["comment", null], ["set", "label:needs-decision"]]);
    expect((ops[0]!.payload as { body: string }).body).toContain("救援画面: https://d1.example.net/rescue/");
    expect(fake.calls.filter((a) => a[0] === "issue" && (a[1] === "comment" || a[1] === "edit"))).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: check — with no schedule, the newest tag is asked for on the interval", async () => {
  const r = await releasedDaemon();
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
    expect(core!.db.listSchedules().filter((s) => s.action === "backlog-next")).toEqual([]); // no firing: only the interval can ask
    await settle(() => r.promoted.length > 0);
    await Bun.sleep(150);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("最新のタグの確認: v0.2.0 の昇格を依頼"));
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: check — a running Task holds it, and the request comes when the Task ends", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    for (const t0 = Date.now(); (await releaseHold(base)) === null && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    claude.end(0);
    await settle(() => r.promoted.length > 0);
    await Bun.sleep(150);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: check — a failed tag is not asked again and gets no ## 判断待ち", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }]);
  const fake = fakeGh();
  try {
    const base = await boot(fake.gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
    await Bun.sleep(300);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: true });
    expect(await scheduleLogAll(base)).toEqual([expect.stringContaining("最新のタグの確認: 昇格に失敗した版のまま: v0.2.0")]);
    expect(fake.calls.filter((a) => a[0] === "issue" && a[1] === "comment")).toHaveLength(0);
    expect(core!.db.listBacklogOperations(core!.db.getWorkspaceBacklogSource(metaId())!).filter((o) => o.kind === "comment")).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: check — backlog-next that joins a check of a failed tag still writes its ## 判断待ち", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }], false, { statusDelayMs: 300 });
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, { promotionCheckMs: 1_000 });
    const source = core!.db.getWorkspaceBacklogSource(metaId())!;
    const at = "2030-01-01T00:00:00Z";
    const issue = (number: number, labels: string[], parent: number | null) =>
      ({ objectKind: "issue", externalId: `I${number}`, fetchState: "fetched", remote: { number, title: `#${number}`, url: "", state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent, subIssues: [], createdAt: at, updatedAt: at, closedAt: null } });
    const pr = { objectKind: "pull-request", externalId: "PR501", fetchState: "fetched", remote: { number: 501, state: "MERGED", isDraft: false, labels: [], closes: [500], mergeCommit: r.sha, updatedAt: at, files: [], closedAt: at, mergedAt: at } };
    core!.db.putBacklogSnapshot(source, { records: [issue(499, ["type:pbi"], null), issue(500, ["type:task"], 499), pr] as never, cursor: core!.db.getBacklogRepository(source)!.cursor, syncedAt: Date.now() });
    const id = await backlogNextSchedule(base);
    // the check is asking sb-rescue when backlog-next comes, so backlog-next joins it
    await settle(() => r.statusAsked.pending > 0);
    await runSchedule(base, id);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("昇格に失敗した版のまま: v0.2.0（判断待ち: #499）"));
    expect(core!.db.listBacklogOperations(source).filter((o) => o.kind === "comment")).toHaveLength(1);
    expect(r.promoted).toEqual([]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: a request sb-rescue refuses is answered with 202 and shown as asked.error", async () => {
  const r = await releasedDaemon([], false, { refuse: true });
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
    const id = await backlogNextSchedule(base);
    const res = await runSchedule(base, id);
    expect([res.status, await res.json()]).toEqual([202, { promotion: `v0.2.0 の昇格を依頼できない: {"error":"refused"}` }]);
    const asked = ((await (await fetch(`${base}/api/daemon/release`)).json()) as { asked: { tag: string; error?: string } }).asked;
    expect(asked).toMatchObject({ tag: "v0.2.0", error: `{"error":"refused"}` });
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: check and backlog-next at once ask /api/promote once", async () => {
  const r = await releasedDaemon([], false, { promoteDelayMs: 200 });
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    await Bun.sleep(500);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: when idle — a promotion held by a running Task is asked for as soon as that Task's turn ends", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(202);
    expect(r.promoted).toEqual([]);
    expect(await scheduleLog(base)).toContain("1 件の Task が動いているので v0.2.0 の昇格を待つ");
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    // the same tag held again keeps when it began
    const since = ((await releaseHold(base)) as { since: number }).since;
    expect((await runSchedule(base, id)).status).toBe(202);
    expect(((await releaseHold(base)) as { since: number }).since).toBe(since);
    // the daily approval-window firing tells the hold in 判断待ち, with the Task count
    const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
    const w = (await (await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "承認待ち", cron: "0 0 * * *", workspaceId: meta.id, runner: "claude", prompt: "", action: "approval-window" }) })).json()) as { id: string };
    const notices = async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; state: string; question: string }> }).asks.filter((a) => a.id.startsWith("notice:promotion:"));
    expect(await notices()).toEqual([]);
    expect((await runSchedule(base, w.id)).status).toBe(202);
    await settle(() => core!.db.getSchedule(w.id)!.lastRunAt !== null);
    expect((await notices()).map((a) => [a.id, a.state, a.question])).toEqual([[`notice:promotion:${w.id}@${since}`, "open", "昇格待ち: v0.2.0（0 時間、動いている Task 1 件）— ヘッダーの「新しい版 →」から昇格できる"]]);
    claude.end(0);
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
    // promoted: the notice is resolved
    expect((await notices()).map((a) => a.state)).toEqual(["resolved"]);
    // ordering (a flake): the line is written after sb-rescue answers, later than `promoted` grows
    const text = "バックログを進める: Task が空いたので v0.2.0 の昇格を依頼";
    for (const t0 = Date.now(); !(await scheduleLog(base)).includes(text) && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
    expect(await scheduleLog(base)).toContain(text);
    expect(await releaseHold(base)).toBeNull();
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000); // a git promotion and HTTP turns under a loaded full suite: over the 5 s default (docs/design/perf.md "Test flakiness")

test("promote: when idle — a Task whose turn ended with background jobs holds the promotion until they end", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    claude.emit(0, { t: "background", count: 1, jobs: ["Recheck"] });
    claude.end(0);
    // the turn is over: only the background job holds the promotion from here
    await settle(() => core!.db.listTasksByStatus("running").length === 0 && core!.db.listTasksByStatus("background").length === 1);
    expect(core!.db.listTasksByStatus("running")).toEqual([]);
    expect((await runSchedule(base, id)).status).toBe(202);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    claude.emit(0, { t: "background", count: 0 });
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: when idle — not while another Task still runs, and asked for once only", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
    await claude.started(2);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(202);
    claude.end(0);
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    claude.end(1);
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
    // a Task made after the request waits for the restart (the drain stays), and nothing asks again
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await Bun.sleep(200);
    expect(claude.count()).toBe(2);
    expect(core!.db.listQueuedTasks()).toHaveLength(1);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: when idle — a Task that ends while a firing runs git is not lost, and the tag is asked for once", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  // the firing's `git fetch --tags origin` hangs in this "ssh" (it marks `entered`) until the gate file exists, then
  // fails (a fetch that fails is ignored)
  const gate = join(r.repo, "gate");
  const entered = join(r.repo, "entered");
  Bun.spawnSync(["git", "-C", r.repo, "remote", "add", "origin", "ssh://gate.invalid/repo"]);
  process.env.GIT_SSH_COMMAND = `sh -c 'touch "${entered}"; until [ -e "${gate}" ]; do sleep 0.02; done; exit 1' ssh`;
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    const firing = runSchedule(base, id);
    await settle(() => existsSync(entered)); // the firing has read sb-rescue and waits on git
    expect(existsSync(entered)).toBe(true);
    claude.end(0);
    await Bun.sleep(50);
    await Bun.write(gate, "");
    expect((await firing).status).toBe(202);
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
    expect(await releaseHold(base)).toBeNull();
  } finally {
    delete process.env.GIT_SSH_COMMAND;
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: when idle — a tag that failed is not asked for when the Tasks end", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }]);
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(202);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: true, busyTasks: 1 });
    claude.end(0);
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: true, busyTasks: 0 });
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: when idle — outside sb-rescue a Task's turn ending asks for nothing", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, { SWITCHBOARD_REPO_ROOT: r.repo });
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    claude.end(0);
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    expect(await scheduleLogAll(base)).not.toContainEqual(expect.stringContaining("Task が空いたので"));
    expect(await releaseHold(base)).toBeUndefined();
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

describe("promotion without cutting or waiting on the Tasks", () => {
  const health = async (base: string) => ((await (await fetch(`${base}/api/health`)).json()) as { promotionDrain: unknown }).promotionDrain;
  const newTask = (base: string, title: string) => fetch(`${base}/api/tasks`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title, prompt: title, runner: "claude" }) });
  const stop = (r: Awaited<ReturnType<typeof releasedDaemon>>) => { r.rescue.stop(true); rmSync(r.repo, { recursive: true, force: true }); };

  test("a sb-rescue that can switch without a restart is asked for that while a Task runs: nothing is held and the Task goes on", async () => {
    const r = await releasedDaemon([], false, { withoutRestart: true });
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      const id = await backlogNextSchedule(base);
      const res = await runSchedule(base, id);
      expect([res.status, await res.json()]).toEqual([202, { promotion: "v0.2.0 の昇格を依頼（Task を切らない切り替え）" }]);
      expect(r.asks).toEqual([{ commit: r.sha, ifNoRestart: true }]);
      expect(await releaseHold(base)).toBeNull();
      expect(await health(base)).toBeNull();
      expect(core!.db.listTasksByStatus("running")).toHaveLength(1);
      // a new Task starts as usual
      expect((await newTask(base, "next")).status).toBe(201);
      await claude.started(2);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("a sb-rescue whose switch without a restart can end in a restart is not asked for it while a Task runs: the promotion waits", async () => {
    const r = await releasedDaemon([], false, { oldWithoutRestart: true });
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(r.asks).toEqual([]);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, tasks: true, busyTasks: 1 });
      claude.end(0);
      await settle(() => r.promoted.length > 0);
      expect(r.asks).toEqual([{ commit: r.sha }]);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("a release that needs a restart waits for the running turn with new starts queued, and goes in when the turn ends", async () => {
    const r = await releasedDaemon([], false, { withoutRestart: true, restartNeeded: true });
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      // B: a Task whose turn has ended; A: a Task whose turn runs
      const b = (await (await newTask(base, "B")).json()) as { id: string };
      await claude.started(1);
      claude.end(0);
      await settle(() => core!.db.getTask(b.id)?.status === "done");
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(2);
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(r.asks).toEqual([{ commit: r.sha, ifNoRestart: true }]);
      expect(r.promoted).toEqual([]);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1, reason: "1 件の Task が動いていて、差分に動いているデーモンが読むファイルがあるか、読むかを確かめられないので v0.2.0 の昇格を待つ" });
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", tasks: 1, queued: 0, limitMs: 60 * 60_000 });
      // while it waits: a reply to B and a new Task C queue instead of starting
      expect((await fetch(`${base}/api/tasks/${b.id}/send`, { method: "POST", body: JSON.stringify({ text: "続き" }) })).ok).toBe(true);
      const c = (await (await newTask(base, "C")).json()) as { id: string };
      await Bun.sleep(150);
      expect(claude.count()).toBe(2);
      expect(core!.db.listQueuedTasks().map((t) => t.id).sort()).toEqual([b.id, c.id].sort());
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", queued: 2 });
      // A's turn ends: the first moment no Task would be cut, asked with a restart this time
      claude.end(1);
      await settle(() => r.promoted.length > 0);
      expect(r.asks).toEqual([{ commit: r.sha, ifNoRestart: true }, { commit: r.sha }]);
      // what queued stays queued for the next daemon (the rows keep queued_at over the restart)
      await Bun.sleep(150);
      expect(claude.count()).toBe(2);
      expect(core!.db.listQueuedTasks()).toHaveLength(2);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("a Task stopped on an approval holds the promotion like a running one: no restart is asked for until it is over too", async () => {
    const r = await releasedDaemon();
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
      await claude.started(2);
      claude.emit(1, { t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: {}, detail: "write" });
      await settle(() => core!.db.listTasksByStatus("waiting").length === 1);
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(r.promoted).toEqual([]);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", busyTasks: 2 });
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", tasks: 2 });
      // the running turn ends: the Task that waits for the person is the middle of a turn, and a restart would cut it and lose its approval
      claude.end(0);
      await settle(() => core!.db.listTasksByStatus("running").length === 0);
      await Bun.sleep(300);
      expect(r.promoted).toEqual([]);
      expect(core!.db.listTasksByStatus("waiting")).toHaveLength(1);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", busyTasks: 1 });
      // with only the waiting Task left, a check does not ask either
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(r.promoted).toEqual([]);
      // its turn ends: now nothing would be cut
      claude.end(1);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
    } finally {
      stop(r);
    }
  }, 30_000);

  const promotionNotices = async (base: string) => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; state: string; question: string; reason: string | null; next: string | null }> }).asks.filter((a) => a.id.startsWith("notice:promotion-drain"));

  test("a wait past its limit cuts nothing: the hold on new starts ends, the promotion stays pending, 判断待ち names the Tasks, and it goes in only when they stop", async () => {
    const r = await releasedDaemon();
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, { promotionCheckMs: 50, promotionDrainLimitMs: 700 });
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      claude.emit(0, { t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: {}, detail: "write" });
      await settle(() => core!.db.listTasksByStatus("waiting").length === 1);
      for (const t0 = Date.now(); (await health(base)) === null && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      const held = (await health(base)) as { since: number };
      expect(held).toMatchObject({ tag: "v0.2.0", limitMs: 700, tasks: 1 });
      expect(await promotionNotices(base)).toEqual([]);
      expect((await newTask(base, "C")).status).toBe(201);
      expect(core!.db.listQueuedTasks()).toHaveLength(1);
      // no new send: the interval check lifts it, and what queued starts
      await claude.started(2);
      expect(core!.db.listQueuedTasks()).toEqual([]);
      expect(await health(base)).toEqual({ expired: { tag: "v0.2.0", at: expect.any(Number), since: held.since, tasks: 2 } });
      expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("昇格の保留が上限"));
      // the Task stopped on its approval was not cut, and nothing was asked of sb-rescue
      await Bun.sleep(300);
      expect(r.promoted).toEqual([]);
      expect(core!.db.listTasksByStatus("waiting")).toHaveLength(1);
      expect(claude.count()).toBe(2);
      // the person is told at once, with the Tasks that hold it and what pressing the button does
      const [n] = await promotionNotices(base);
      expect(n).toMatchObject({ id: `notice:promotion-drain@${held.since}`, state: "open" });
      expect(n!.question).toMatch(/^昇格待ち: v0\.2\.0 が \d+ 分待っている（動いている・待っている Task 2 件）$/);
      expect(n!.reason).toContain("承認・回答待ち");
      expect(n!.reason).toContain("アプリは Task を切らず");
      expect(n!.next).toContain("「待たずに昇格する」を押す（動いている・待っている Task は切れる）");
      // no second hold later: a new Task starts at once
      expect((await newTask(base, "D")).status).toBe(201);
      await claude.started(3);
      expect(core!.db.listQueuedTasks()).toEqual([]);
      // it goes in at the first moment no Task would be cut, and from the request on new starts are held again
      claude.end(1);
      claude.end(2);
      await Bun.sleep(200);
      expect(r.promoted).toEqual([]);
      claude.end(0);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
      expect((await promotionNotices(base)).map((a) => a.state)).toEqual(["resolved"]);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("one limit for the whole wait: a newer tag takes the place of the tag and not of the clock, and after the limit no tag holds new starts again", async () => {
    const r = await releasedDaemon();
    const claude = endableClaude();
    const tag = (name: string) => { for (const a of [["commit", "-q", "--allow-empty", "-m", `feat: ${name}`], ["tag", name]]) Bun.spawnSync(["git", "-C", r.repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]); };
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, { promotionCheckMs: 50, promotionDrainLimitMs: 1500 });
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      for (const t0 = Date.now(); (await health(base)) === null && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      const first = (await health(base)) as { tag: string; since: number };
      expect(first.tag).toBe("v0.2.0");
      // the long Task merges again: a newer tag
      tag("v0.3.0");
      for (const t0 = Date.now(); ((await health(base)) as { tag?: string } | null)?.tag !== "v0.3.0" && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      expect(await health(base)).toMatchObject({ tag: "v0.3.0", since: first.since, limitMs: 1500 });
      // the limit counted from the first wait passes
      for (const t0 = Date.now(); !("expired" in ((await health(base)) as object)) && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      const lifted = (await health(base)) as { expired: { at: number; since: number } };
      expect(lifted.expired.since).toBe(first.since);
      expect(lifted.expired.at - first.since).toBeLessThan(1500 + 1000); // not a second limit after v0.3.0 came
      // and another tag does not hold new starts again
      tag("v0.4.0");
      for (const t0 = Date.now(); ((await health(base)) as { expired?: { tag: string } }).expired?.tag !== "v0.4.0" && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      expect(await health(base)).toMatchObject({ expired: { tag: "v0.4.0", since: first.since, at: lifted.expired.at } });
      expect((await newTask(base, "next")).status).toBe(201);
      await claude.started(2);
      expect(core!.db.listQueuedTasks()).toEqual([]);
      expect(r.promoted).toEqual([]);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("from the request for a restart until the restart nothing new starts, with no Task before it too; a promotion that ends without a restart lets go at once", async () => {
    const r = await releasedDaemon([], false, { building: true });
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, { promotionAskedPollMs: 50 });
      expect(await health(base)).toBeNull(); // a daemon starts with no hold
      const id = await backlogNextSchedule(base);
      const res = await runSchedule(base, id);
      expect([res.status, await res.json()]).toEqual([202, { promotion: "v0.2.0 の昇格を依頼" }]);
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", asked: expect.any(Number), queued: 0 });
      // sb-rescue builds and checks for minutes: a Task made meanwhile waits for the next daemon instead of being cut by the restart
      expect((await newTask(base, "during the build")).status).toBe(201);
      await Bun.sleep(300);
      expect(claude.count()).toBe(0);
      expect(core!.db.listQueuedTasks()).toHaveLength(1);
      // a check that comes meanwhile changes nothing
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", asked: expect.any(Number), queued: 1 });
      // sb-rescue ends the promotion without restarting this daemon (the candidate was refused): the hold is let go by itself
      r.state.busy = null;
      await claude.started(1);
      expect(core!.db.listQueuedTasks()).toEqual([]);
      expect(await health(base)).toBeNull();
      expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("v0.2.0 の昇格は再起動なしで終わったので、新しい開始の保留を外した"));
    } finally {
      stop(r);
    }
  }, 30_000);

  test("a restart that was asked for and never comes does not hold new starts for ever", async () => {
    const r = await releasedDaemon([], false, { building: true });
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, { promotionAskedPollMs: 50, promotionAskedHoldMs: 600 });
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      expect((await newTask(base, "held")).status).toBe(201);
      expect(core!.db.listQueuedTasks()).toHaveLength(1);
      // sb-rescue stays busy and no restart comes
      await claude.started(1);
      expect(r.state.busy).toBe("promote");
      expect(await health(base)).toBeNull();
      expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("たっても再起動が来ないので、新しい開始の保留を外した: v0.2.0"));
    } finally {
      stop(r);
    }
  }, 30_000);

  test("a promotion by hand: the other Tasks are counted as the request is taken, new starts are held from there, and a refused request holds nothing", async () => {
    const r = await releasedDaemon([], false, { building: true });
    const claude = endableClaude();
    // as scripts/promote.ts asks: the Task's id with the token of its own endpoint in the headers
    const promote = async (base: string, body: object, as?: { id: string; token?: string }) => fetch(`${base}/api/daemon/promote`, { method: "POST", headers: as ? { "x-task-id": as.id, "x-task-token": as.token ?? ((await (await fetch(`${base}/api/tasks/${as.id}/mcp`)).json()) as { token: string }).token } : {}, body: JSON.stringify(body) });
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, { promotionAskedPollMs: 50 });
      // A asks (scripts/promote.ts proves it is A); B is another Task, stopped on an approval
      const a = (await (await newTask(base, "A")).json()) as { id: string };
      const b = (await (await newTask(base, "B")).json()) as { id: string };
      await claude.started(2);
      claude.emit(1, { t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: {}, detail: "write" });
      await settle(() => core!.db.getTask(b.id)?.status === "waiting");
      const no = await promote(base, { commit: r.sha }, a);
      expect(no.status).toBe(409);
      expect(await no.json()).toMatchObject({ busy: [{ id: b.id, title: "B", status: "waiting" }] });
      expect(r.promoted).toEqual([]);
      expect(await health(base)).toBeNull();
      // B is over: only the Task that asks is left
      claude.end(1);
      await settle(() => core!.db.getTask(b.id)?.status === "done");
      // a Task named in the request and not proved is counted like any other: in the body, in the header alone, with
      // a token that is not its own — and a request that names none counts every Task. Nothing is asked of sb-rescue
      for (const [body, as] of [[{ commit: r.sha, except: a.id }, undefined], [{ commit: r.sha }, { id: a.id, token: "" }], [{ commit: r.sha }, { id: a.id, token: "mcp_guess" }], [{ commit: r.sha }, undefined]] as const) {
        const counted = await promote(base, body, as);
        expect(counted.status).toBe(409);
        expect(await counted.json()).toMatchObject({ busy: [{ id: a.id, title: "A" }] });
      }
      expect(r.promoted).toEqual([]);
      expect(await health(base)).toBeNull();
      // sb-rescue refuses: nothing stays held
      r.state.refuse = true;
      expect((await promote(base, { commit: r.sha }, a)).status).toBe(409);
      expect(await health(base)).toBeNull();
      r.state.refuse = false;
      expect((await promote(base, { commit: r.sha }, a)).status).toBe(202);
      expect(r.promoted).toEqual([r.sha]);
      expect(await health(base)).toMatchObject({ asked: expect.any(Number) });
      expect((await newTask(base, "C")).status).toBe(201);
      await Bun.sleep(200);
      expect(claude.count()).toBe(2);
      expect(core!.db.listQueuedTasks()).toHaveLength(1);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("the ask at the first moment no Task would be cut is tried again when sb-rescue did not take it: nothing runs, so no later turn's end would", async () => {
    const r = await releasedDaemon();
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, { promotionIdleRetryMs: 50 });
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", tasks: 1 });
      r.state.refuse = true;
      claude.end(0);
      await settle(() => core!.db.listTasksByStatus("running").length === 0);
      await Bun.sleep(200);
      expect(r.promoted).toEqual([]);
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", tasks: 0 }); // still held, with nothing running
      r.state.refuse = false;
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
    } finally {
      stop(r);
    }
  }, 30_000);

  const decisions = async (base: string, days = 1) => (await (await fetch(`${base}/api/ops/stops?days=${days}`)).json()) as { promotions: { noRestartAsked: number; waited: number; refused: number; recent: Array<{ kind: string; tag: string; firstAt: number; reason: string; files: string[]; fileCount: number }> } };

  test("the automatic promotion's waits, refusals and switches without a restart are kept with tag, time and reason, and are read after a restart", async () => {
    const r = await releasedDaemon([], false, { restartFiles: ["packages/core/src/a.ts", "packages/core/src/b.ts"] });
    const claude = endableClaude();
    try {
      let base = await boot(fakeGh().gh, claude.adapter, r.env);
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      const id = await backlogNextSchedule(base);
      // 1. sb-rescue cannot switch while Tasks run (no promoteKeepsTasks): the promotion waits
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(r.asks).toEqual([]);
      // 2. it can, and says this release needs a restart: refused, then waits
      r.state.withoutRestart = true;
      r.state.restartNeeded = true;
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(r.asks).toEqual([{ commit: r.sha, ifNoRestart: true }]);
      // 3. it takes the switch that keeps the Tasks
      r.state.restartNeeded = false;
      expect((await runSchedule(base, id)).status).toBe(202);
      expect(r.asks).toHaveLength(2);
      // the daemon stops and starts again on the same home
      await core!.stop();
      const cfg = loadConfig({ SWITCHBOARD_HOME: home!, SWITCHBOARD_KNOWLEDGE: join(home!, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home!, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...r.env });
      core = await startServer(cfg, [claude.adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: fakeGh().gh, tagCi: async () => "pass" as const });
      base = `http://127.0.0.1:${core.server.port}`;
      const { promotions } = await decisions(base);
      expect({ waited: promotions.waited, refused: promotions.refused, noRestartAsked: promotions.noRestartAsked }).toEqual({ waited: 1, refused: 1, noRestartAsked: 1 });
      const refusal = promotions.recent.find((d) => d.kind === "refused")!;
      expect(refusal).toMatchObject({ tag: "v0.2.0", files: ["packages/core/src/a.ts", "packages/core/src/b.ts"], fileCount: 2 });
      expect(refusal.firstAt).toBeGreaterThan(Date.now() - 60_000);
      expect(refusal.reason).toContain("this release needs a restart");
      expect(promotions.recent.find((d) => d.kind === "waited")!.reason).toContain("v0.2.0");
    } finally {
      stop(r);
    }
  }, 30_000);

  test("the same tag held for the same reason stays one row however often it is decided", async () => {
    const r = await releasedDaemon();
    const claude = endableClaude();
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      const first = core!.db.promotionDecisions(0);
      expect(first).toHaveLength(1);
      await Bun.sleep(5);
      expect((await runSchedule(base, id)).status).toBe(202);
      expect((await runSchedule(base, id)).status).toBe(202);
      const rows = core!.db.promotionDecisions(0);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "waited", tag: "v0.2.0", times: 3, firstAt: first[0]!.firstAt });
      expect(rows[0]!.lastAt).toBeGreaterThan(first[0]!.firstAt);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("a record that cannot be written changes nothing of the promotion", async () => {
    const r = await releasedDaemon([], false, { withoutRestart: true, restartNeeded: true });
    const claude = endableClaude();
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      core!.db.sqlite.exec("DROP TABLE promotion_decisions");
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      // what the same firing does with the table there (the test of a release that needs a restart above)
      expect(r.asks).toEqual([{ commit: r.sha, ifNoRestart: true }]);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
      expect(logged.mock.calls.some((c) => String(c[0]).includes("could not be recorded"))).toBe(true);
      claude.end(0);
      await settle(() => r.promoted.length > 0);
      expect(r.asks).toEqual([{ commit: r.sha, ifNoRestart: true }, { commit: r.sha }]);
    } finally {
      logged.mockRestore();
      stop(r);
    }
  }, 30_000);
});

describe("the tag CI's result before a tag is brought in by itself", () => {
  const stop = (r: Awaited<ReturnType<typeof releasedDaemon>>) => { r.rescue.stop(true); rmSync(r.repo, { recursive: true, force: true }); };
  const patch = (base: string, release: object) => fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ release }) });

  const tagNotices = async (base: string) => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; kind: string; state: string; question: string; reason: string | null }> }).asks.filter((a) => a.id.startsWith("notice:promotion-tag-ci:"));

  test("a tag that failed is not asked for, does not hold the backlog and is told once in 判断待ち; a tag without a result goes in by default and waits only under pass", async () => {
    const r = await releasedDaemon();
    let result: "pass" | "fail" | "none" = "fail";
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, { tagCi: async () => result });
      const id = await backlogNextSchedule(base);
      // the firing goes on to the backlog (201 = it started items), and nothing is asked of sb-rescue
      expect((await runSchedule(base, id)).status).toBe(201);
      expect(r.promoted).toEqual([]);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, tasks: false, ci: true, reason: "v0.2.0 はタグの CI が失敗しているので自動では昇格しない" });
      // never a silent stop: one notice names the tag and the reason, and it is the same one however often it is read
      const told = await tagNotices(base);
      expect(told).toEqual([expect.objectContaining({ id: "notice:promotion-tag-ci:v0.2.0", kind: "notice", state: "open", question: "昇格を止めている: v0.2.0（タグの CI）" })]);
      expect(told[0]!.reason).toContain("v0.2.0 はタグの CI が失敗しているので自動では昇格しない");
      expect(((await (await fetch(`${base}/api/settings`)).json()) as { release: { tagCi: string } }).release.tagCi).toBe("no-fail");
      for (const t of core!.db.listTasks()) await fetch(`${base}/api/tasks/${t.id}/abort`, { method: "POST" });
      await settle(() => core!.db.listWorkingTasks("gate").length === 0);
      await Bun.sleep(200);
      expect(r.promoted).toEqual([]);
      await runSchedule(base, id);
      expect((await tagNotices(base)).map((a) => [a.id, a.state])).toEqual([["notice:promotion-tag-ci:v0.2.0", "open"]]);
      // no result yet: waits only when the setting asks for a pass, and that wait is told too
      expect((await patch(base, { tagCi: "pass" })).status).toBe(200);
      result = "none";
      await runSchedule(base, id);
      expect(r.promoted).toEqual([]);
      expect(await releaseHold(base)).toMatchObject({ ci: true, reason: "v0.2.0 のタグの CI の結果がまだ無いので自動の昇格を待つ" });
      expect((await tagNotices(base)).map((a) => [a.id, a.state, a.reason?.includes("結果がまだ無い")])).toEqual([["notice:promotion-tag-ci:v0.2.0", "open", true]]);
      for (const t of core!.db.listTasks()) await fetch(`${base}/api/tasks/${t.id}/abort`, { method: "POST" });
      await settle(() => core!.db.listWorkingTasks("gate").length === 0);
      // … and the default (back to it) takes a tag that did not fail; the notice is cleared with the hold
      expect((await patch(base, { tagCi: "no-fail" })).status).toBe(200);
      await runSchedule(base, id);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
      expect((await tagNotices(base)).map((a) => a.state)).toEqual(["resolved"]);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("waiting for the app's own tag CI job is no stop: the hold says so and nothing is told in 判断待ち, then the job's result goes the usual way", async () => {
    const r = await releasedDaemon();
    let result: "pass" | "fail" | { waiting: string } = { waiting: "job#4" };
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, { tagCi: async () => result });
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(201);
      expect(r.promoted).toEqual([]);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", ciWait: true, reason: "v0.2.0 のタグの CI の仕事 job#4 を待っている" });
      expect(await tagNotices(base)).toEqual([]);
      for (const t of core!.db.listTasks()) await fetch(`${base}/api/tasks/${t.id}/abort`, { method: "POST" });
      await settle(() => core!.db.listWorkingTasks("gate").length === 0);
      // a fail record is a stop and is told, as before
      result = "fail";
      await runSchedule(base, id);
      expect((await tagNotices(base)).map((a) => [a.id, a.state])).toEqual([["notice:promotion-tag-ci:v0.2.0", "open"]]);
      for (const t of core!.db.listTasks()) await fetch(`${base}/api/tasks/${t.id}/abort`, { method: "POST" });
      await settle(() => core!.db.listWorkingTasks("gate").length === 0);
      // a pass record brings it in
      result = "pass";
      await runSchedule(base, id);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("the result is read from the app's tag CI job records: a fail record for the tag's commit holds it, and the Release is not read", async () => {
    const r = await releasedDaemon();
    const gets: string[][] = [];
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, (g) => async (args, cwd) => {
        if (args[0] === "release") gets.push(args);
        return g(args, cwd);
      }, { tagCi: undefined, promotionCheckMs: 400 });
      // a job that judged the commit and found it failing (no workspace is registered here, so the app starts no job of its own)
      const job = core!.db.insertJob({ kind: "tag-ci", taskId: APP_JOB_TASK, pr: 0, runner: null, cwd: r.repo, startedAt: Date.now(), repo: "", head: r.sha, as: null, kinds: [] });
      core!.db.setJobResult(job.id, { result: { tagCi: { ok: false } } });
      core!.db.finishJob(job.id, { status: "fail", exitCode: 1, summary: "fail", endedAt: Date.now() });
      for (const t0 = Date.now(); (await releaseHold(base)) === null && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      expect(await releaseHold(base)).toMatchObject({ reason: "v0.2.0 はタグの CI が失敗しているので自動では昇格しない" });
      await Bun.sleep(500);
      expect(r.promoted).toEqual([]);
      expect(gets).toEqual([]);
    } finally {
      stop(r);
    }
  }, 30_000);
});

describe("release settings: the interval of the check and how far a new version goes by itself", () => {
  const remote = (name: string) => { const d = join(mkdtempSync(join(tmpdir(), "sb-origin-")), name); mkdirSync(d, { recursive: true }); Bun.spawnSync(["git", "init", "-q", "--bare", d]); return d; };
  const PUBLIC = remote("o/pub");
  const PLAN = [{ value: "plan", label: "plan", description: "" }];
  const reviews = () => core!.db.listTasks().filter((t) => t.origin === "release-review");
  const fence = (j: object) => "確認した。\n```switchboard-release-review\n" + JSON.stringify(j) + "\n```";
  const patch = (base: string, release: object | null) => fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ release }) });
  const release = async (base: string) => (await (await fetch(`${base}/api/daemon/release`)).json()) as { latestRelease: { tag: string; newer: boolean } | null; review: { state: string } | null; hold: unknown; nextCheckAt: number };
  const stop = (r: Awaited<ReturnType<typeof releasedDaemon>>) => { r.rescue.stop(true); rmSync(r.repo, { recursive: true, force: true }); };

  test("the saved interval is when the next check comes, the defaults are told, and values out of range are refused", async () => {
    const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "x" }]);
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
      const got = (await (await fetch(`${base}/api/settings`)).json()) as { release: object; defaults: { release: object } };
      expect(got.release).toEqual({ checkMinutes: 10, auto: "promote", drainMinutes: 60, tagCi: "no-fail" });
      expect(got.defaults.release).toEqual({ checkMinutes: 10, auto: "promote", drainMinutes: 60, tagCi: "no-fail" });
      const within = (at: number, minutes: number) => Math.abs(at - (Date.now() + minutes * 60_000)) < 30_000;
      expect(within((await release(base)).nextCheckAt, 10)).toBe(true);
      expect((await patch(base, { checkMinutes: 3 })).status).toBe(200);
      expect(within((await release(base)).nextCheckAt, 3)).toBe(true);
      for (const bad of [{ checkMinutes: 0 }, { checkMinutes: 1441 }, { auto: "sometimes" }, { drainMinutes: 4 }, { drainMinutes: 1441 }, { tagCi: "any" }]) expect((await patch(base, bad)).status).toBe(400);
      expect((await patch(base, { drainMinutes: 5, auto: "review" })).status).toBe(200);
      expect(((await (await fetch(`${base}/api/settings`)).json()) as { release: object }).release).toEqual({ checkMinutes: 3, auto: "review", drainMinutes: 5, tagCi: "no-fail" });
      // null: the whole group back to the defaults, the timer too
      expect((await patch(base, null)).status).toBe(200);
      expect(within((await release(base)).nextCheckAt, 10)).toBe(true);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("off: a new version is shown, nothing is checked or promoted by itself, and the check and the promotion by hand still work", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      expect((await patch(base, { auto: "off" })).status).toBe(200);
      const id = await backlogNextSchedule(base);
      await runSchedule(base, id);
      await Bun.sleep(300);
      expect(reviews()).toEqual([]);
      expect(r.promoted).toEqual([]);
      const shown = await release(base);
      expect(shown).toMatchObject({ latestRelease: { tag: "v0.2.0", newer: true }, review: null, hold: null });
      // the check by hand
      const check = await fetch(`${base}/api/daemon/release/review`, { method: "POST" });
      expect([check.status, await check.json()]).toEqual([202, { started: "review", tag: "v0.2.0" }]);
      await settle(() => reviews().length === 1);
      const at = claude.prompts.findIndex((p) => p.includes("v0.2.0") && p.includes("diff.patch"));
      expect(at).toBeGreaterThanOrEqual(0);
      claude.emit(at, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
      for (let i = 0; i < claude.count(); i++) if (i !== at) claude.end(i);
      await Bun.sleep(300);
      expect((await release(base)).review).toMatchObject({ state: "ok" });
      expect(r.promoted).toEqual([]);
      // the promotion by hand (and a Task's, the same route) is outside the setting
      const res = await fetch(`${base}/api/daemon/promote`, { method: "POST", body: JSON.stringify({ commit: r.sha, force: true }) });
      expect(res.status).toBe(202);
      expect(r.promoted).toEqual([r.sha]);
    } finally {
      stop(r);
    }
  }, 30_000);

  test("review: the check starts by itself, and a cleared version waits for the person", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env);
      expect((await patch(base, { auto: "review" })).status).toBe(200);
      const id = await backlogNextSchedule(base);
      await runSchedule(base, id);
      await settle(() => reviews().length === 1);
      expect(reviews()).toHaveLength(1);
      const at = claude.prompts.findIndex((p) => p.includes("v0.2.0") && p.includes("diff.patch"));
      claude.emit(at, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
      for (let i = 0; i < claude.count(); i++) if (i !== at) claude.end(i);
      await Bun.sleep(300);
      expect(await release(base)).toMatchObject({ latestRelease: { tag: "v0.2.0", newer: true }, review: { state: "ok" }, hold: null });
      expect(r.promoted).toEqual([]);
      // back to the default: the cleared version goes in at the next look
      expect((await patch(base, { auto: "promote" })).status).toBe(200);
      await runSchedule(base, id);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
    } finally {
      stop(r);
    }
  }, 30_000);
});

describe("a bundle's hold on promotion", () => {
  test("promotionStep waits on a hold, as a wait that no Task's end lifts", () => {
    const held = { action: "wait", reason: "束の作業中（Task tsk_9）", bundle: true } as const;
    expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, bundle: { taskId: "tsk_9" } })).toEqual(held);
    expect(promotionStep({ status: released(), latest: v2, busyTasks: 2, bundle: { taskId: "tsk_9" } })).toEqual(held);
    // whatever `auto` says, and before a diff check is started or waited on: the reason is the hold's
    for (const auto of ["off", "review"] as const) expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, auto, bundle: { taskId: "tsk_9" } })).toEqual(held);
    expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, review: "start", bundle: { taskId: "tsk_9" } })).toEqual(held);
    expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, review: { state: "running" } as never, bundle: { taskId: "tsk_9" } })).toEqual(held);
    expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, bundle: null })).toEqual({ action: "promote", tag: "v0.2.0", sha: "bbb" });
  });

  test("bundle hold lifts a drain that was holding new starts", async () => {
    const r = await releasedDaemon();
    const claude = endableClaude();
    const health = async (base: string) => ((await (await fetch(`${base}/api/health`)).json()) as { promotionDrain: unknown }).promotionDrain;
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      // the newest tag waits on the running Task, and new starts are held for it
      for (const t0 = Date.now(); (await health(base)) === null && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      expect(await health(base)).toMatchObject({ tag: "v0.2.0", tasks: 1 });
      core!.db.setSetting(BUNDLE_HOLD_KEY, { taskId: "tsk_9", since: Date.now(), schedules: [], base: "old" });
      // no promotion can come while the hold stands, so the next check does not keep new starts held
      for (const t0 = Date.now(); (await health(base)) !== null && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
      expect(await health(base)).toBeNull();
      expect(await releaseHold(base)).toMatchObject({ reason: "束の作業中（Task tsk_9）", tasks: false });
      expect(r.asks).toEqual([]);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("bundle hold blocks every way in", async () => {
    const r = await releasedDaemon();
    const claude = endableClaude();
    const promote = (base: string, body: object) => fetch(`${base}/api/daemon/promote`, { method: "POST", body: JSON.stringify(body) });
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, { ...CHECK, promotionIdleRetryMs: 50 });
      core!.db.setSetting(BUNDLE_HOLD_KEY, { taskId: "tsk_9", since: Date.now(), schedules: [], base: "old" });
      // backlog-next, the interval check (50 ms: it runs several times in the wait below) and a Task's end
      expect((await start(base, 304, { action: "complete" })).status).toBe(201);
      await claude.started(1);
      claude.end(0);
      await settle(() => core!.db.listTasksByStatus("running").length === 0);
      // fired with no Task running: nothing but the hold keeps it from asking
      const id = await backlogNextSchedule(base);
      expect((await runSchedule(base, id)).status).toBe(202);
      await Bun.sleep(300);
      // by hand, with and without `force`
      for (const body of [{ commit: r.sha }, { commit: r.sha, force: true }]) {
        const res = await promote(base, body);
        expect([res.status, await res.json()]).toEqual([409, { error: "束の作業中（Task tsk_9）。止めを解いてから昇格する", commit: r.sha }]);
      }
      expect(r.asks).toEqual([]);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, tasks: false, reason: "束の作業中（Task tsk_9）" });
      // the hold released: the same check asks
      core!.db.setSetting(BUNDLE_HOLD_KEY, null);
      await settle(() => r.asks.length > 0);
      expect(r.promoted).toEqual([r.sha]);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("promote: the app's own tag CI job", () => {
  const REPO = "acme/app"; // the origin of the repository `setup` makes
  const SHA = "a".repeat(40);
  const job = (o: Partial<Job>): Job => ({ id: 1, kind: "tag-ci", taskId: APP_JOB_TASK, pr: 0, runner: null, cwd: "/x", status: "pass", exitCode: 0, startedAt: 0, endedAt: 1, summary: null, repo: "", head: SHA, base: null, as: null, kinds: [], result: null, model: null, effort: null, ...o });

  test("the newest tag-ci job of the sha decides: fail holds, pass promotes", () => {
    const failed = job({ id: 1, status: "fail", result: { tagCi: { ok: false } } });
    const passed = job({ id: 2, result: { tagCi: { ok: true } } });
    expect(tagCiOf([])).toBe("none");
    expect(tagCiOf([failed])).toBe("fail");
    expect(tagCiOf([failed, passed])).toBe("pass"); // a later run outweighs an earlier one
    expect(tagCiOf([passed, failed])).toBe("fail");
    // a job still running, or ended without judging the commit, says nothing: it does not erase an earlier word either
    expect(tagCiOf([passed, job({ id: 3, status: "running", endedAt: null })])).toBe("pass");
    expect(tagCiOf([failed, job({ id: 3, status: "aborted", exitCode: null })])).toBe("fail");
    const go = { action: "promote", tag: "v0.2.0", sha: "bbb" } as const;
    const v2 = { tag: "v0.2.0", sha: "bbb" };
    const status = { managed: true, current: "aaa", history: [] };
    expect(promotionStep({ status, latest: v2, busyTasks: 0, ci: tagCiOf([failed]) })).toMatchObject({ action: "wait", ci: true });
    expect(promotionStep({ status, latest: v2, busyTasks: 0, ci: tagCiOf([failed, passed]) })).toEqual(go);
  });

  test("what the app does about a commit's tag CI: a word settles it, a running job (any commit) or a young failed try is waited for, three spent tries leave it with no result", () => {
    const spent = (id: number, endedAt: number) => job({ id, status: "aborted", exitCode: null, endedAt });
    const running = job({ id: 9, status: "running", endedAt: null });
    expect(tagCiPlan([], null, 0)).toEqual({ do: "start" });
    expect(tagCiPlan([], running, 0)).toEqual({ do: "wait", job: 9 }); // one at a time, whatever the commit
    expect(tagCiPlan([job({ result: { tagCi: { ok: false } } })], running, 1e12)).toEqual({ do: "settled" }); // it has a word
    const at = 1_000_000;
    expect(tagCiPlan([spent(1, at)], null, at + TAG_CI_RETRY_MS - 1)).toEqual({ do: "wait", job: 1, retry: true });
    expect(tagCiPlan([spent(1, at)], null, at + TAG_CI_RETRY_MS)).toEqual({ do: "start" });
    const all = Array.from({ length: TAG_CI_ATTEMPTS }, (_, i) => spent(i + 1, at));
    expect(tagCiPlan(all, null, at + 100 * TAG_CI_RETRY_MS)).toEqual({ do: "spent" });
    // only the app's own jobs are its tries: a Task's jobs that ended without judging the commit use none up
    const tasks = Array.from({ length: TAG_CI_ATTEMPTS }, (_, i) => job({ id: 20 + i, taskId: "task_x", status: "aborted", exitCode: null, endedAt: at }));
    expect(tagCiPlan(tasks, null, at + 100 * TAG_CI_RETRY_MS)).toEqual({ do: "start" });
    expect(tagCiPlan([...tasks, spent(1, at)], null, at + 1)).toEqual({ do: "wait", job: 1, retry: true });
  });

  test("the promotion waits for the app's own job under either setting, and a tag with no result and no job to wait for follows the setting", () => {
    const v2 = { tag: "v0.2.0", sha: "bbb" };
    const status = { managed: true, current: "aaa", history: [] };
    const wait = { action: "wait", reason: "v0.2.0 のタグの CI の仕事 job#4 を待っている", ciWait: true } as const;
    for (const requireCi of ["no-fail", "pass"] as const) expect(promotionStep({ status, latest: v2, busyTasks: 0, ci: { waiting: "job#4" }, requireCi })).toEqual(wait);
    expect(promotionStep({ status, latest: v2, busyTasks: 0, ci: "none", requireCi: "no-fail" })).toMatchObject({ action: "promote" });
    expect(promotionStep({ status, latest: v2, busyTasks: 0, ci: "none", requireCi: "pass" })).toMatchObject({ action: "wait", ci: true });
  });

  /** A real database with the meta workspace on a git repository that has the tag, the app's own job deps, and a command per test. */
  function setup(script: string) {
    const root = mkdtempSync(join(tmpdir(), "sb-tagci-job-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "tag-ci.ts"), "");
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/acme/app.git");
    git("commit", "-q", "--allow-empty", "-m", "x");
    git("tag", "v0.2.0");
    const sha = git("rev-parse", "HEAD");
    const db = new Db(join(root, "db.sqlite"));
    const meta = db.upsertWorkspace({ name: "app", path: repo, kind: "meta" });
    const ended: Job[] = [];
    const commands: string[][] = [];
    const argvs: string[][] = [];
    const jobDeps: JobDeps = { db, dir: join(root, "jobs"), env: { ...process.env }, pollMs: 50, command: (req) => { commands.push([req.kind]); argvs.push(jobCommand(req).argv); return { argv: ["sh", "-c", script.replaceAll("SHA", sha)], tail: "" }; }, onFinish: (j) => ended.push(j) };
    const gh = async () => { throw new Error("the Release is not read"); };
    const gitAsync = async (args: string[]) => {
      const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) throw new Error("git failed");
      return out.trim();
    };
    const sc = { opts: { gh }, cfg: { candidate: false }, db, jobDeps, metaWorkspace: () => meta, git: gitAsync } as unknown as Parameters<typeof tagCi>[0];
    const killAll = () => { for (const j of db.listJobs(0)) { const p = db.jobPid(j.id).pid; if (p) try { process.kill(p, "SIGKILL"); } catch {} } };
    return { sc, db, sha, git, ended, commands, argvs, killAll, done: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
  }

  test("a [tag-ci] pass line in the Release body without a job record is not a pass: the app starts its own job and the promotion waits for it", async () => {
    // the Release's body says pass for this commit; a promotion that read it would call the commit passed. It reads the app's records: none, so the app starts its own job and waits for it
    const t = setup("sleep 30");
    const reads: string[][] = [];
    const gh = async (args: string[]) => { reads.push(args); return { code: 0, stdout: JSON.stringify({ body: `## CI\n[tag-ci] pass ${t.sha}\n` }), stderr: "" }; };
    try {
      const state = await tagCi({ ...t.sc, opts: { gh } } as unknown as Parameters<typeof tagCi>[0], "v0.2.0", t.sha);
      expect(state).toEqual({ waiting: expect.stringMatching(/^job#\d+$/) });
      expect(reads).toEqual([]);
      const jobs = t.db.tagCiJobsOf(REPO, t.sha);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: "tag-ci", taskId: APP_JOB_TASK, pr: 0, head: t.sha, status: "running" });
      // and the promotion does not go in on it, with the default setting either
      const status = { managed: true, current: "aaa", history: [] };
      expect(promotionStep({ status, latest: { tag: "v0.2.0", sha: t.sha }, busyTasks: 0, ci: state, requireCi: "no-fail" })).toMatchObject({ action: "wait", ciWait: true });
    } finally {
      t.killAll();
      await Bun.sleep(50);
      t.done();
    }
  });

  test("with no record the app starts one tag CI job and waits for it under either setting; a second check starts none; its pass record promotes and its fail record holds", async () => {
    const pass = setup('printf \'{"judged":[{"sha":"SHA","ok":true}]}\' > "$J/result.json"; sleep 0.3');
    try {
      // the checks that come while it runs (the interval's, the backlog's, a Task's end) start no second one, for this commit or a newer one
      const waiting: unknown[] = await Promise.all([tagCi(pass.sc, "v0.2.0", pass.sha), tagCi(pass.sc, "v0.2.0", pass.sha)]);
      const id = pass.db.tagCiJobsOf(REPO, pass.sha)[0]!.id;
      waiting.push(await tagCi(pass.sc, "v0.3.0", "b".repeat(40)));
      expect(waiting).toEqual([{ waiting: `job#${id}` }, { waiting: `job#${id}` }, { waiting: `job#${id}` }]);
      expect(pass.db.listJobs(0).filter((j) => j.kind === "tag-ci")).toHaveLength(1);
      expect(pass.commands).toEqual([["tag-ci"]]);
      const status = { managed: true, current: "aaa", history: [] };
      for (const requireCi of ["no-fail", "pass"] as const) expect(promotionStep({ status, latest: { tag: "v0.2.0", sha: pass.sha }, busyTasks: 0, ci: waiting[0] as { waiting: string }, requireCi })).toMatchObject({ action: "wait", ciWait: true });
      await settle(() => pass.ended.length === 1);
      expect(pass.ended[0]).toMatchObject({ status: "pass", result: { tagCi: { ok: true } }, head: pass.sha });
      const ci = await tagCi(pass.sc, "v0.2.0", pass.sha);
      expect(ci).toBe("pass");
      expect(promotionStep({ status, latest: { tag: "v0.2.0", sha: pass.sha }, busyTasks: 0, ci, requireCi: "no-fail" })).toMatchObject({ action: "promote" });
      expect(pass.commands).toHaveLength(1); // a commit with a word starts nothing
    } finally { pass.done(); }
    const fail = setup('printf \'{"judged":[{"sha":"SHA","ok":false}]}\' > "$J/result.json"; exit 1');
    try {
      await tagCi(fail.sc, "v0.2.0", fail.sha);
      await settle(() => fail.ended.length === 1);
      // the job's own exit is a failure of the run; what the tag did is in the record
      expect(fail.ended[0]).toMatchObject({ status: "fail", result: { tagCi: { ok: false } } });
      const ci = await tagCi(fail.sc, "v0.2.0", fail.sha);
      expect(ci).toBe("fail");
      expect(promotionStep({ status: { managed: true, current: "aaa", history: [] }, latest: { tag: "v0.2.0", sha: fail.sha }, busyTasks: 0, ci, requireCi: "no-fail" })).toMatchObject({ action: "wait", ci: true, reason: expect.stringContaining("失敗") });
    } finally { fail.done(); }
  });

  test("a job that ended without judging the commit leaves no record: its retry is waited for, three of them leave the commit with no result, and then the setting decides", async () => {
    // the run judged another commit (the tag moved) and the first one's record is empty
    const t = setup('printf \'{"judged":[{"sha":"%s","ok":true}]}\' "$(printf b%.0s $(seq 40))" > "$J/result.json"');
    try {
      const first = await tagCi(t.sc, "v0.2.0", t.sha);
      expect(first).toEqual({ waiting: expect.any(String) });
      await settle(() => t.ended.length === 1);
      expect(t.ended[0]!.result).toBeNull();
      // not asked again before TAG_CI_RETRY_MS: the promotion waits for the retry
      expect(await tagCi(t.sc, "v0.2.0", t.sha)).toEqual({ waiting: expect.stringContaining("頼み直し") });
      expect(t.db.tagCiJobsOf(REPO, t.sha)).toHaveLength(1);
      // the tries are used up: no more are asked, and the commit has no result
      const old = Date.now() - 2 * TAG_CI_RETRY_MS;
      for (let i = 1; i < TAG_CI_ATTEMPTS; i++) {
        const j = t.db.insertJob({ kind: "tag-ci", taskId: APP_JOB_TASK, pr: 0, runner: null, cwd: "/x", startedAt: old, repo: REPO, head: t.sha, as: null, kinds: [] });
        t.db.finishJob(j.id, { status: "aborted", exitCode: null, summary: "", endedAt: old });
      }
      expect(await tagCi(t.sc, "v0.2.0", t.sha)).toBe("none");
      expect(t.db.tagCiJobsOf(REPO, t.sha)).toHaveLength(TAG_CI_ATTEMPTS);
    } finally { t.done(); }
  });

  test("a job for another repository's commit does not count, and a request body cannot say it is the app; the app's job is refused where it cannot run", async () => {
    const t = setup("true");
    try {
      const other = t.db.insertJob({ kind: "tag-ci", taskId: APP_JOB_TASK, pr: 0, runner: null, cwd: "/x", startedAt: 0, repo: "acme/other", head: t.sha, as: null, kinds: [] });
      t.db.setJobResult(other.id, { result: { tagCi: { ok: true } } });
      t.db.finishJob(other.id, { status: "pass", exitCode: 0, summary: "", endedAt: 1 });
      expect(await tagCi(t.sc, "v0.2.0", t.sha)).toEqual({ waiting: expect.any(String) }); // not "pass"
      const dir = t.sc.metaWorkspace()!.path;
      // the reserved taskId is the process's to use, not a request's
      expect(() => requestJob(t.sc.jobDeps, { kind: "tag-ci", taskId: APP_JOB_TASK, cwd: dir })).toThrow("予約");
      expect(() => requestJob(t.sc.jobDeps, { kind: "tag-ci", taskId: APP_JOB_TASK, cwd: "/" }, { app: true })).toThrow(JobError);
    } finally { t.done(); }
    // a candidate runs on a copy of the database: the live daemon's jobs are not its to start
    const c = setup("true");
    try {
      expect(await tagCi({ ...c.sc, cfg: { candidate: true } } as unknown as Parameters<typeof tagCi>[0], "v0.2.0", c.sha)).toBe("none");
      expect(c.db.tagCiJobsOf(REPO, c.sha)).toHaveLength(0);
    } finally { c.done(); }
  });

  test("the job's head is the commit the promotion decided about, when it is a tag's — not the newest tag read again", async () => {
    const t = setup("true");
    try {
      const dir = t.sc.metaWorkspace()!.path;
      t.git("commit", "-q", "--allow-empty", "-m", "newer");
      t.git("tag", "v0.3.0");
      const untagged = (t.git("commit", "-q", "--allow-empty", "-m", "untagged"), t.git("rev-parse", "HEAD"));
      const job = requestJob(t.sc.jobDeps, { kind: "tag-ci", taskId: APP_JOB_TASK, cwd: dir, sha: t.sha }, { app: true });
      expect(job.head).toBe(t.sha); // v0.2.0's commit, although v0.3.0 is the newest tag now
      expect(t.argvs.at(-1)).toEqual(["bun", join(dir, "scripts/tag-ci.ts"), "--sha", t.sha]);
      expect(() => requestJob(t.sc.jobDeps, { kind: "tag-ci", taskId: APP_JOB_TASK, cwd: dir, sha: untagged }, { app: true })).toThrow("タグ");
      // without a sha (a Task's request) it is the newest tag's commit
      expect(requestJob(t.sc.jobDeps, { kind: "tag-ci", taskId: APP_JOB_TASK, cwd: dir }, { app: true }).head).toBe(t.git("rev-parse", "v0.3.0^{commit}"));
    } finally { t.done(); }
  });

  /** `setup` with the meta clone's origin a local bare repository that has the clone's tag; `publish` makes a tagged commit there that the clone has not fetched. */
  function withOrigin(script: string) {
    const t = setup(script);
    const bare = join(t.sc.metaWorkspace()!.path, "..", "origin.git");
    Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
    t.git("push", "-q", bare, "HEAD:refs/heads/main", "--tags");
    t.git("remote", "set-url", "origin", bare);
    const publish = (tag: string) => {
      const other = join(bare, "..", `other-${tag}`);
      Bun.spawnSync(["git", "clone", "-q", bare, other]);
      const g = (...a: string[]) => Bun.spawnSync(["git", "-C", other, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
      g("commit", "-q", "--allow-empty", "-m", tag);
      g("tag", tag);
      g("push", "-q", "origin", "HEAD:refs/heads/main", "--tags");
      return g("rev-parse", "HEAD");
    };
    return { ...t, publish };
  }

  test("a tag the meta clone has not fetched yet is fetched before the job is asked for; a request that is still refused is a try that ended without judging, waited for and asked again, not a commit with no CI", async () => {
    const t = withOrigin("sleep 30");
    try {
      const sha = t.publish("v0.9.0");
      expect(Bun.spawnSync(["git", "-C", t.sc.metaWorkspace()!.path, "tag", "-l", "v0.9.0"]).stdout.toString().trim()).toBe(""); // not in the clone
      const state = await tagCi(t.sc, "v0.9.0", sha);
      expect(state).toEqual({ waiting: expect.stringMatching(/^job#\d+$/) });
      const jobs = t.db.listJobs(0).filter((j) => j.kind === "tag-ci");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ head: sha, status: "running" });
      expect(t.argvs.at(-1)).toContain(sha);
      t.killAll();
      await Bun.sleep(50);
    } finally { t.done(); }
    const u = withOrigin("true");
    try {
      const nowhere = "d".repeat(40); // no tag of the origin is at it
      const first = await tagCi(u.sc, "v0.9.0", nowhere);
      expect(first).toEqual({ waiting: expect.stringContaining("頼めなかった") });
      const tried = u.db.listJobs(0).filter((j) => j.kind === "tag-ci");
      expect(tried).toHaveLength(1);
      expect(tried[0]).toMatchObject({ status: "aborted", head: nowhere, result: null });
      expect(u.commands).toEqual([]); // nothing was started
      // asked about again at once: waited for, not asked again; not a commit with no CI
      expect(await tagCi(u.sc, "v0.9.0", nowhere)).toEqual({ waiting: expect.stringContaining("頼み直し") });
      expect(u.db.tagCiJobsOf(u.db.listJobs(0)[0]!.repo, nowhere)).toHaveLength(1);
      // the tries used up: no result, and the setting decides
      for (let i = 1; i < TAG_CI_ATTEMPTS; i++) u.db.finishJob(u.db.insertJob({ kind: "tag-ci", taskId: APP_JOB_TASK, pr: 0, runner: null, cwd: "/x", startedAt: 0, repo: tried[0]!.repo, head: nowhere, as: null, kinds: [] }).id, { status: "aborted", exitCode: null, summary: "", endedAt: 0 });
      expect(await tagCi(u.sc, "v0.9.0", nowhere)).toBe("none");
    } finally { u.done(); }
  });

  test("a request does not fetch: a tag the clone lacks is refused at once, the promotion fetches it itself before asking", async () => {
    const t = withOrigin("sleep 30");
    try {
      const sha = t.publish("v0.9.0");
      const dir = t.sc.metaWorkspace()!.path;
      // the event loop is not held for the network: requestJob only looks at the tags it has
      expect(() => requestJob(t.sc.jobDeps, { kind: "tag-ci", taskId: APP_JOB_TASK, cwd: dir, sha }, { app: true })).toThrow("タグ");
      expect(Bun.spawnSync(["git", "-C", dir, "tag", "-l", "v0.9.0"]).stdout.toString().trim()).toBe("");
      expect(t.db.listJobs(0)).toEqual([]); // refused before any record
      expect(await tagCi(t.sc, "v0.9.0", sha)).toEqual({ waiting: expect.stringMatching(/^job#\d+$/) }); // the promotion's own fetch, then the request
      expect(Bun.spawnSync(["git", "-C", dir, "tag", "-l", "v0.9.0"]).stdout.toString().trim()).toBe("v0.9.0");
    } finally {
      t.killAll();
      await Bun.sleep(50);
      t.done();
    }
  });

  test("a request that failed after it recorded itself is one try, not two", async () => {
    const t = setup("true");
    try {
      // the job's folder cannot be made (its parent is a file): the job is recorded, then aborted by requestJob itself
      const file = join(t.sc.metaWorkspace()!.path, "..", "a-file");
      writeFileSync(file, "x");
      t.sc.jobDeps.dir = join(file, "jobs");
      const state = await tagCi(t.sc, "v0.2.0", t.sha);
      expect(state).toEqual({ waiting: expect.stringContaining("頼めなかった") });
      const jobs = t.db.tagCiJobsOf(REPO, t.sha);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: "aborted", head: t.sha });
      expect(state).toEqual({ waiting: `job#${jobs[0]!.id}（頼めなかった。頼み直しを待つ）` });
    } finally { t.done(); }
  });

  test("a tag CI job a Task asked for is not counted: the app starts its own job although one is running", async () => {
    const t = setup("sleep 30");
    try {
      const task = t.db.insertJob({ kind: "tag-ci", taskId: "task_x", pr: 0, runner: null, cwd: "/x", startedAt: Date.now(), repo: REPO, head: "e".repeat(40), as: null, kinds: [] });
      expect(task.status).toBe("running");
      const state = await tagCi(t.sc, "v0.2.0", t.sha);
      const own = t.db.tagCiJobsOf(REPO, t.sha);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ taskId: APP_JOB_TASK, status: "running" });
      expect(state).toEqual({ waiting: `job#${own[0]!.id}` });
      // its own job running, the next check waits for that one and starts none
      await tagCi(t.sc, "v0.2.0", t.sha);
      expect(t.db.tagCiJobsOf(REPO, t.sha)).toHaveLength(1);
    } finally {
      t.killAll();
      await Bun.sleep(50);
      t.done();
    }
  });

  test("the job judges the commit it was asked for: the script is given its head", async () => {
    const t = setup("true");
    try {
      await tagCi(t.sc, "v0.2.0", t.sha);
      expect(t.argvs.at(-1)).toEqual(["bun", join(t.sc.metaWorkspace()!.path, "scripts/tag-ci.ts"), "--sha", t.sha]);
    } finally { t.done(); }
  });
});
