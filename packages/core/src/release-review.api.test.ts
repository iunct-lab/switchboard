// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoreServer } from "./server.ts";
import { CHECK, backlogNextSchedule, boot, endableClaude, fakeGh, holdingClaude, releaseHold, releasedDaemon, runSchedule, settle, useBacklogDaemon } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

describe("release review", () => {
  // local bare repositories named like the public copy and a development repository (a remote on the network would make the tag fetch slow)
  const remote = (name: string) => { const d = join(mkdtempSync(join(tmpdir(), "sb-origin-")), name); mkdirSync(d, { recursive: true }); Bun.spawnSync(["git", "init", "-q", "--bare", d]); return d; };
  const PUBLIC = remote("o/pub");
  const PLAN = [{ value: "plan", label: "plan", description: "" }];
  const reviews = () => core!.db.listTasks().filter((t) => t.origin === "release-review");
  const reply = (sha: string, text: string) => text.replace("SHA", sha);
  const fence = (j: object) => "確認した。\n```switchboard-release-review\n" + JSON.stringify(j) + "\n```";

  test("a public copy's clone: a tag with no check is not promoted, one read-only Task is made, and three entrances at once make one", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC, promoteDelayMs: 100 });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      const id = await backlogNextSchedule(base);
      await Promise.all([runSchedule(base, id), runSchedule(base, id)]);
      await settle(() => reviews().length > 0);
      await Bun.sleep(300);
      expect(r.promoted).toEqual([]);
      expect(reviews()).toHaveLength(1);
      const t = reviews()[0]!;
      expect(t).toMatchObject({ permissionMode: "plan", origin: "release-review", title: "リリースの差分確認 v0.2.0" });
      // the cwd is the folder that holds the tag's tree, not the tree: the tag's own runner settings (hooks) are not read
      expect(t.cwd.endsWith("/release-review/v0.2.0")).toBe(true);
      expect(existsSync(join(t.cwd, "tree", ".git"))).toBe(true);
      expect(existsSync(join(t.cwd, "diff.patch"))).toBe(true);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, reason: "v0.2.0 の差分を確認中" });
      // the check ends ok: the tree and the diff go and the tag is asked for
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      // the stage Tasks backlog-next started meanwhile hold the promotion like any running Task until they end
      for (let i = 1; i < claude.count(); i++) claude.end(i);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
      await settle(() => !existsSync(t.cwd));
      expect(existsSync(t.cwd)).toBe(false);
      expect(reviews()).toHaveLength(1);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  for (const [name, summary, hold] of [
    ["concern", fence({ verdict: "concern", findings: [{ path: "a.ts", why: "fetch" }] }), "v0.2.0 の差分の確認で懸念 1 件"],
    ["unreadable", "問題ありません", "v0.2.0 の差分を確かめられなかった: 最後の返答が結果の書式"],
  ] as const) {
    test(`a public copy's clone: a ${name} result is not promoted and shows in hold.reason`, async () => {
      const r = await releasedDaemon([], false, { origin: PUBLIC });
      const claude = endableClaude(PLAN);
      try {
        const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
        await claude.started(1);
        claude.emit(0, { t: "session.end", status: "ok", summary });
        await settle(() => ((db) => db.lastReply(reviews()[0]!.id) !== null)(core!.db));
        await Bun.sleep(300);
        expect(r.promoted).toEqual([]);
        expect(reviews()).toHaveLength(1);
        expect(((await releaseHold(base)) as { reason: string; failed: boolean }).reason).toContain(hold);
        expect(((await releaseHold(base)) as { failed: boolean }).failed).toBe(false);
        // the hold is not a failure of the version: backlog-next goes on picking (no promotion answer)
        const res = await runSchedule(base, await backlogNextSchedule(base));
        expect(await res.json()).not.toHaveProperty("promotion");
      } finally {
        r.rescue.stop(true);
        rmSync(r.repo, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("a public copy's clone: a check stopped by the usage limit keeps its folder for the resume and is not promoted", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await claude.started(1);
      const t = reviews()[0]!;
      claude.emit(0, { t: "session.end", status: "error", summary: "You've hit your session limit · resets 4:10am (Asia/Tokyo)" });
      await settle(() => core!.db.getTask(t.id)?.resumeAt != null);
      await Bun.sleep(300);
      expect(existsSync(join(t.cwd, "tree"))).toBe(true);
      expect(r.promoted).toEqual([]);
      expect(((await releaseHold(base)) as { reason: string }).reason).toContain("v0.2.0 の差分を確かめられなかった: ランナーの使用上限");
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  const releaseOf = async (base: string) => (await (await fetch(`${base}/api/daemon/release`)).json()) as { latestRelease: { tag: string; sha: string; ahead: number | null; newer: boolean } | null; review: { state: string; tag: string; findings: unknown[]; taskId: string } | null; hold: { reason: string } | null };
  const recheck = (base: string) => fetch(`${base}/api/daemon/release/review`, { method: "POST" });

  test("GET /api/daemon/release shows latestRelease, review and hold, and the re-check starts a new check only from failed or concern (202 / 409)", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await claude.started(1);
      const running = await releaseOf(base);
      expect(running.latestRelease).toEqual({ tag: "v0.2.0", sha: r.sha, ahead: 1, newer: true });
      expect(running.review).toMatchObject({ state: "running", tag: "v0.2.0", findings: [] });
      expect(running.hold?.reason).toContain("差分を確認中");
      expect((await recheck(base)).status).toBe(409); // running
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "concern", findings: [{ path: "a.ts", why: "fetch" }] }) });
      await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
      await Bun.sleep(300);
      const concern = await releaseOf(base);
      expect(concern.review).toMatchObject({ state: "concern", findings: [{ path: "a.ts", why: "fetch" }], taskId: reviews()[0]!.id });
      expect(concern.hold?.reason).toContain("懸念 1 件");
      const again = await recheck(base);
      expect([again.status, await again.json()]).toEqual([202, { started: "review", tag: "v0.2.0" }]);
      await settle(() => reviews().length === 2);
      expect(reviews()).toHaveLength(2);
      expect((await releaseOf(base)).review?.state).toBe("running");
      expect((await recheck(base)).status).toBe(409);
      expect(r.promoted).toEqual([]);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("the re-check of a check stopped by the usage limit cancels its resume, so the old one cannot run again in the shared folder", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await claude.started(1);
      const old = reviews()[0]!;
      claude.emit(0, { t: "session.end", status: "error", summary: "You've hit your session limit · resets 4:10am (Asia/Tokyo)" });
      await settle(() => core!.db.getTask(old.id)?.resumeAt != null);
      expect((await releaseOf(base)).review?.state).toBe("failed");
      expect((await recheck(base)).status).toBe(202);
      await settle(() => reviews().length === 2);
      expect(core!.db.getTask(old.id)?.resumeAt).toBeNull();
      expect((await releaseOf(base)).review?.state).toBe("running");
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("the re-check is refused (409) when the check found no concern", async () => {
    const ok = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, ok.env, undefined, undefined, CHECK);
      await claude.started(1);
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
      expect((await recheck(base)).status).toBe(409);
    } finally {
      ok.rescue.stop(true);
      rmSync(ok.repo, { recursive: true, force: true });
    }
  }, 30_000);

  // an update source: the origin is not a public copy and its tags are not the newest; what sb-rescue says decides
  const treeTask = () => reviews()[0]!;
  test("an update source: the newest release is sb-rescue's, the check reads release-tree's diff with no git worktree, and an ok result asks for the tag with the checked commit", async () => {
    const r = await releasedDaemon([], false, { origin: remote("o/dev"), source: true });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await settle(() => reviews().length > 0);
      const t = treeTask();
      expect(t).toMatchObject({ origin: "release-review", title: "リリースの差分確認 v0.3.0", permissionMode: "plan" });
      expect(r.fromSource!.trees).toEqual(["v0.3.0"]);
      // the prompt carries the paths release-tree returned, and git made no tree
      await claude.started(1);
      expect(claude.prompts.find((p) => p.includes("v0.3.0"))).toContain(join(home!, "release-review", "v0.3.0", "diff.patch"));
      expect(existsSync(join(t.cwd, "tree", ".git"))).toBe(false);
      expect(await releaseOf(base)).toMatchObject({ latestRelease: { tag: "v0.3.0", sha: "a".repeat(40), ahead: null, newer: true }, hold: { reason: "v0.3.0 の差分を確認中" } });
      expect(r.promoted).toEqual([]);
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      for (let i = 1; i < claude.count(); i++) claude.end(i);
      await settle(() => r.promoted.length > 0);
      expect(r.fromSource!.asked).toEqual([{ commit: "v0.3.0", expectSha: "a".repeat(40) }]);
      // now running (the kept answer still says newer): not offered again
      expect(await releaseOf(base)).toMatchObject({ latestRelease: { tag: "v0.3.0", ahead: null, newer: false } });
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("an update source: an ok check made for another commit than the tag now points at is not promoted (a moved tag)", async () => {
    const r = await releasedDaemon([], false, { origin: remote("o/dev"), source: true });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await claude.started(1);
      // the check was made for another commit (the tag moved after it started)
      writeFileSync(join(home!, "release-review", "v0.3.0.sha"), "c".repeat(40) + "\n");
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      for (let i = 1; i < claude.count(); i++) claude.end(i);
      await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
      await Bun.sleep(300);
      expect(r.promoted).toEqual([]);
      expect(((await releaseHold(base)) as { reason: string }).reason).toContain("確認した commit");
      // the screen reads it as not checked too (no checkout is compared from a source), and it can be checked again
      const shown = (await releaseOf(base)) as unknown as { review: { state: string }; head: string; current: string; ahead: number; behind: number };
      expect([shown.review.state, shown.head, shown.ahead, shown.behind]).toEqual(["failed", shown.current, 0, 0]);
      // a check that could not start leaves the commit of the previous one: its ok still does not count for the moved tag
      const create = core!.tasks.create.bind(core!.tasks);
      core!.tasks.create = () => {
        throw new Error("no task");
      };
      try {
        expect((await fetch(`${base}/api/daemon/release/review`, { method: "POST" })).status).toBe(500);
      } finally {
        core!.tasks.create = create;
      }
      expect(readFileSync(join(home!, "release-review", "v0.3.0.sha"), "utf8").trim()).toBe("c".repeat(40));
      expect(await releaseOf(base)).toMatchObject({ review: { state: "failed" } });
      expect(r.promoted).toEqual([]);
      expect((await fetch(`${base}/api/daemon/release/review`, { method: "POST" })).status).toBe(202);
      // the new check is for the commit the tag names now, written once the check exists
      expect(readFileSync(join(home!, "release-review", "v0.3.0.sha"), "utf8").trim()).toBe("a".repeat(40));
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("an update source: a check that could not start is not tried again at every check (GitHub's calls are counted)", async () => {
    const r = await releasedDaemon([], false, { origin: remote("o/dev"), source: true, treeFails: true });
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
      await settle(() => r.fromSource!.trees.length > 0);
      await Bun.sleep(600); // a dozen interval checks
      expect(r.fromSource!.trees).toEqual(["v0.3.0"]);
      expect(reviews()).toEqual([]);
      const waiting = ((await releaseHold(base)) as { reason: string }).reason;
      expect(waiting).toContain("また試す");
      // why it could not start stays while it waits
      expect(waiting).toContain("GitHub returned 503");
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("an update source: a newest release that is not above what runs (a Release deleted) is neither checked nor promoted, nor offered", async () => {
    const r = await releasedDaemon([], false, { origin: remote("o/dev"), source: true, newer: false });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await Bun.sleep(500);
      expect(reviews()).toEqual([]);
      expect(r.fromSource!.trees).toEqual([]);
      expect(r.promoted).toEqual([]);
      expect(await releaseOf(base)).toMatchObject({ latestRelease: { tag: "v0.3.0", ahead: null, newer: false } });
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("an update source: promote by hand asks for the newest tag with its commit, whether named by tag or commit, and refuses another", async () => {
    const r = await releasedDaemon([], false, { origin: remote("o/dev"), source: true });
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
      const post = (commit: string) => fetch(`${base}/api/daemon/promote`, { method: "POST", body: JSON.stringify({ commit, force: true }) });
      expect((await post("b".repeat(40))).status).toBe(409);
      expect(r.fromSource!.asked).toEqual([]);
      expect((await post("a".repeat(40))).status).toBe(202);
      expect((await post("v0.3.0")).status).toBe(202);
      expect(r.fromSource!.asked).toEqual([{ commit: "v0.3.0", expectSha: "a".repeat(40) }, { commit: "v0.3.0", expectSha: "a".repeat(40) }]);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  for (const [name, summary, hold] of [
    ["concern", fence({ verdict: "concern", findings: [{ path: "a.ts", why: "fetch" }] }), "v0.3.0 の差分の確認で懸念 1 件"],
    ["unreadable", "問題ありません", "v0.3.0 の差分を確かめられなかった: 最後の返答が結果の書式"],
  ] as const) {
    test(`an update source: a ${name} result is not promoted`, async () => {
      const r = await releasedDaemon([], false, { origin: remote("o/dev"), source: true });
      const claude = endableClaude(PLAN);
      try {
        const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
        await claude.started(1);
        claude.emit(0, { t: "session.end", status: "ok", summary });
        await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
        await Bun.sleep(300);
        expect(r.promoted).toEqual([]);
        expect(((await releaseHold(base)) as { reason: string }).reason).toContain(hold);
      } finally {
        r.rescue.stop(true);
        rmSync(r.repo, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("a development origin has latestRelease and review null and refuses the re-check", async () => {
    const dev = await releasedDaemon([], false, { origin: remote("o/dev") });
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, dev.env, undefined, undefined, CHECK);
      expect(await releaseOf(base)).toMatchObject({ latestRelease: null, review: null });
      expect((await recheck(base)).status).toBe(409);
    } finally {
      dev.rescue.stop(true);
      rmSync(dev.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("outside sb-rescue (managed: false) a public copy's clone still shows latestRelease from HEAD, and starts no check", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: r.repo }, undefined, undefined, CHECK);
      const rel = await releaseOf(base);
      expect(rel).toMatchObject({ managed: false, latestRelease: { tag: "v0.2.0", sha: r.sha, ahead: 0, newer: false } });
      expect(rel.review).toBeUndefined();
      expect((await recheck(base)).status).toBe(409);
      expect(reviews()).toHaveLength(0);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  });

  test("a clone of a repository that is not the public copy starts no check and keeps promoting", async () => {
    const r = await releasedDaemon([], false, { origin: remote("o/dev") });
    try {
      await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
      expect(reviews()).toHaveLength(0);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  });
});
