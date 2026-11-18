// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type CoreServer } from "./server.ts";
import { GithubBudgetCache, type GhRunner } from "./backlog-gh.ts";
import { backlogNextSchedule, boot, budgetGh, closeTried, fakeGh, holdingClaude, metaId, runSchedule, scheduleLog, scheduleLogAll, start, startedTasks, useBacklogDaemon } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

describe("GitHub budget", () => {
  test("GitHub budget: backlog-next starts on the stored data at 500 points left with the import refused for the limit, and logs no budget line", async () => {
    const low = budgetGh(500);
    const limited = { on: false };
    const gh: GhRunner = async (args, cwd) =>
      limited.on && args[0] === "api" && !args.some((a) => a.includes("rateLimit"))
        ? { code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${Math.floor(Date.now() / 1000) + 1800}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "gh: API rate limit exceeded" }
        : low.gh(args, cwd);
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    limited.on = true;
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(startedTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
    const log = await scheduleLog(base);
    expect(log).not.toContain("GitHub の API 残量");
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("GitHub と照合できない（保存データで進める）"));
  });

  test("GitHub budget: a stage button starts its Task below 1,000 points left — the budget holds no start", async () => {
    const base = await boot(budgetGh(500).gh, holdingClaude().adapter);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  });

  test("GitHub budget: read once a minute at most — a second read within 60 s does not call gh, a failed one neither; after 60 s it does", async () => {
    let now = 1_000_000;
    let calls = 0;
    let fail = false;
    const gh: GhRunner = async () => {
      calls++;
      return fail ? { code: 1, stdout: "", stderr: "HTTP 502" } : { code: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4321, resetAt: "2026-10-01T10:00:00Z" } } }), stderr: "" };
    };
    const cache = new GithubBudgetCache(gh, 60_000, () => now);
    const [a, b] = await Promise.all([cache.get("/x"), cache.get("/x")]);
    expect(a).toEqual({ remaining: 4321, limit: 5000, resetsAt: Date.parse("2026-10-01T10:00:00Z") / 1000 });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
    now += 59_000;
    await cache.get("/x");
    expect(calls).toBe(1);
    now += 2_000;
    fail = true;
    expect(await cache.get("/x")).toBeNull();
    expect(calls).toBe(2);
    now += 59_000;
    expect(await cache.get("/x")).toBeNull();
    expect(calls).toBe(2);
    now += 2_000;
    await cache.get("/x");
    expect(calls).toBe(3);
  });

  test("GitHub budget: at 0 left GitHub refuses the read itself — that refusal is 0 left until its reset; the budget does not hold a stage button (the import before it is the settled-state wait's, and passes here)", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const fake = fakeGh();
    const gh: GhRunner = async (args, cwd) => {
      if (args.some((a) => a.includes("rateLimit"))) return { code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "gh: API rate limit exceeded" };
      return fake.gh(args, cwd);
    };
    const base = await boot(gh, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toEqual({ remaining: 0, limit: 5000, resetsAt: reset });
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
  });

  test("GitHub budget: a limited read GitHub answers with 200 and no rateLimit in the body is read from the answer's headers", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const fake = fakeGh();
    const gh: GhRunner = async (args, cwd) => {
      if (args.some((a) => a.includes("rateLimit"))) return { code: 0, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "" };
      return fake.gh(args, cwd);
    };
    const base = await boot(gh, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toEqual({ remaining: 0, limit: 5000, resetsAt: reset });
  });

  test("GitHub budget: while the host is waited for nothing is asked — a primary limit is 0 left until its end, another wait is not known", async () => {
    let calls = 0;
    let wait: { until: number; reason: "primary" | "secondary" | null } | null = { until: Date.parse("2026-10-01T10:15:00Z"), reason: "primary" };
    const cache = new GithubBudgetCache(async () => (calls++, { code: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 15000, remaining: 4000, resetAt: "2026-10-01T11:00:00Z" } } }), stderr: "" }), 60_000, () => Date.now(), 10_000, () => wait);
    expect(await cache.get("/x")).toEqual({ remaining: 0, limit: 5000, resetsAt: Date.parse("2026-10-01T10:15:00Z") / 1000 });
    wait = { until: Date.now() + 60_000, reason: "secondary" };
    expect(await cache.get("/x")).toBeNull();
    wait = { until: Date.now() + 60_000, reason: null };
    expect(await cache.get("/x")).toBeNull();
    expect(calls).toBe(0);
    wait = null;
    expect((await cache.get("/x"))?.remaining).toBe(4000);
    expect(calls).toBe(1);
    // the limit GitHub said is kept for the next wait
    wait = { until: Date.parse("2026-10-01T10:15:00Z"), reason: "primary" };
    expect((await cache.get("/x"))?.limit).toBe(15000);
  });

  test("GitHub budget: after a restart the wait a repository stored is kept too — nothing is asked, and the budget is not known (its kind was not stored)", async () => {
    const fake = budgetGh(4000);
    const asked: string[][] = [];
    const base = await boot(async (args, cwd) => (asked.push(args), fake.gh(args, cwd)), holdingClaude().adapter);
    core!.db.setBacklogRetryAt(core!.db.getWorkspaceBacklogSource(metaId())!, Date.now() + 10 * 60_000);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toBeNull();
    expect(asked.filter((a) => a.some((x) => x.includes("rateLimit")))).toHaveLength(0);
    // a start goes on the stored data during the wait, without asking GitHub
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(asked.filter((a) => a.some((x) => x.includes("rateLimit")))).toHaveLength(0);
  });

  test("GitHub budget: the limit a refusal names is kept for the next budget made in a wait", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    let wait: { until: number; reason: "primary" } | null = null;
    const cache = new GithubBudgetCache(async () => ({ code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 15000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n{}`, stderr: "gh: API rate limit exceeded" }), 60_000, () => Date.now(), 10_000, () => wait);
    expect((await cache.get("/x"))?.limit).toBe(15000);
    wait = { until: reset * 1000, reason: "primary" };
    expect((await cache.get("/x"))?.limit).toBe(15000);
  });

  test("GitHub budget: the daemon's read keeps the import's wait — after an import GitHub refused for its limit, the budget is 0 left and rateLimit is not asked", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const asked: string[][] = [];
    const limited: GhRunner = async (args) => {
      asked.push(args);
      return { code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "gh: API rate limit exceeded" };
    };
    const base = await boot(limited, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toEqual({ remaining: 0, limit: 5000, resetsAt: reset });
    expect(asked.filter((a) => a.some((x) => x.includes("rateLimit")))).toHaveLength(0);
  });

  test("GitHub budget: a failure that is not the limit, or a gh that does not answer in time, is not known and holds nothing", async () => {
    const auth = new GithubBudgetCache(async () => ({ code: 1, stdout: "", stderr: "gh auth login" }));
    expect(await auth.get("/x")).toBeNull();
    let now = 0;
    let calls = 0;
    const hung = new GithubBudgetCache(() => (calls++, new Promise(() => {})), 60_000, () => now, 20);
    expect(await hung.get("/x")).toBeNull();
    // a minute later the stuck gh is still waited on: no second process
    now += 61_000;
    expect(await hung.get("/x")).toBeNull();
    expect(calls).toBe(1);
  });

  test("GitHub budget: GET /api/ledger/summary carries it; a gh that does not answer rateLimit gives null and backlog-next starts as before", async () => {
    const low = budgetGh(500);
    let base = await boot(low.gh, holdingClaude().adapter);
    const s = (await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown };
    expect(s.github).toEqual({ remaining: 500, limit: 5000, resetsAt: Date.parse(low.resetAt) / 1000 });
    await core!.stop();
    rmSync(home!, { recursive: true, force: true });
    base = await boot(fakeGh().gh, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toBeNull();
    closeTried();
    expect((await runSchedule(base, await backlogNextSchedule(base))).status).toBe(201);
  });
});
