// test-reads: packages/core/fixtures/
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, RunnerAdapter, Task } from "@switchboard/protocol";
import { importing } from "../fixtures/github-import.ts";
import { ACTION_FOR_STAGE } from "./backlog-item.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { loadConfig, UPLINK_PREVIEW } from "./config.ts";
import { Db } from "./db.ts";
import { leaseKey, PbiLeases } from "./lease.ts";
import { awsS3, memoryS3, runCommand, uplinkStores, type AwsRun } from "./s3.ts";
import { leaseRound } from "./server/lease.ts";
import { performRestart } from "./server/lifecycle.ts";
import { startServer, type CoreServer } from "./server.ts";
import { sendUplink } from "./uplink-s3.ts";

/* The daemon as one of two machines sharing work: the uplink bucket kept in memory, a fake runner, the fixtures' gh. */

const pages = (await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json()) as unknown[];
const decisions = await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json();
const gh: GhRunner = async (args) => {
  if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};
/** A runner whose Task runs until it is stopped. */
const holding: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true, version: "fake" }),
  start: () => ({ send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) }),
};

let core: CoreServer | null = null;
let home = "";
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(home, { recursive: true, force: true });
});

async function boot(env: Record<string, string>, s3 = memoryS3()) {
  home = mkdtempSync(join(tmpdir(), "sb-uplink-server-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: join(home, "sb"), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_CODEX_HOME: join(home, "codex"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...env });
  core = await startServer(cfg, [holding], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: () => null, gh: importing(gh, () => []), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined), s3 });
  const base = `http://127.0.0.1:${core.server.port}`;
  for (let n = 0; n < 400; n++) {
    const b = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
    if (b.syncs.length && !b.syncs.some((s) => s.syncing)) break;
    await Bun.sleep(10);
  }
  return { base, s3 };
}
const meta = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
/** A PBI of the fixtures a stage can be started on, with that stage's action. */
async function startable(base: string): Promise<{ n: number; action: string }> {
  const b = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  const item = b.items.find((i) => i.type === "pbi" && (i.stage === "ready" || i.stage === "needs-tasks") && !i.overlap && !i.activeTaskId)!;
  return { n: item.number, action: ACTION_FOR_STAGE[item.stage]! };
}
const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const RECEIVE = { ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "receive", SWITCHBOARD_UPLINK_MACHINES: "pc1=acme/app", SWITCHBOARD_UPLINK_INTERVAL_S: "3600", SWITCHBOARD_LEASE_RENEW_S: "0.05" };
const stored = async (s3: ReturnType<typeof memoryS3>, pbi: number) => JSON.parse(new TextDecoder().decode((await s3.get(leaseKey("acme/app", pbi)))!.body));
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/work/repo", scope: ["/work/repo"], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumePlannedAt: null, resumeSince: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 5_000, createdAt: 1_000, updatedAt: 5_000, ...extra });

describe("lease", () => {
  test("alone, a PBI starts as it always did: the lease route answers enabled false and S3 is never asked", async () => {
    const { base, s3 } = await boot({});
    const { n, action } = await startable(base);
    expect(await (await post(base, `/api/backlog/${n}/lease`, { workspaceId: meta().id, action: "acquire" })).json()).toEqual({ enabled: false });
    expect((await post(base, `/api/backlog/${n}/start`, { workspaceId: meta().id, action })).status).toBe(201);
    expect(s3.calls).toBe(0);
  });

  test("a PBI another machine holds is not started: the button answers 409 with who holds it until when, and it starts once given back", async () => {
    const { base, s3 } = await boot(RECEIVE);
    const { n, action } = await startable(base);
    const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: 900_000 });
    expect(await pc.acquire("acme/app", n)).toEqual({ ok: true });
    const refused = await post(base, `/api/backlog/${n}/start`, { workspaceId: meta().id, action });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/^PBI #\d+ は pc1 が \d{4}-\d\d-\d\d \d\d:\d\d UTC まで持っている$/);
    expect(core!.db.listTasks().filter((t) => t.stage?.issue === n)).toEqual([]);
    expect(await (await post(base, `/api/backlog/${n}/lease`, { workspaceId: meta().id, action: "acquire" })).json()).toMatchObject({ enabled: true, ok: false, holder: "pc1" });
    // the backlog's overlap judgement counts the PBI as at work elsewhere without asking S3 again
    const calls = s3.calls;
    await fetch(`${base}/api/backlog`);
    expect(s3.calls).toBe(calls);

    await pc.release("acme/app", n);
    expect((await post(base, `/api/backlog/${n}/start`, { workspaceId: meta().id, action })).status).toBe(201);
    expect(await stored(s3, n)).toMatchObject({ machine: "instance", state: "held" });
    // held by this machine: another start of it (the running Task answers) is not refused for the lease
    const again = await post(base, `/api/backlog/${n}/start`, { workspaceId: meta().id, action });
    expect(((await again.json()) as { taskId?: string }).taskId).toBeDefined();
    // and the other machine is now the one refused
    expect((await pc.acquire("acme/app", n)).ok).toBe(false);
  });

  test("the daemon renews what it holds on its interval, and gives the lease back through the route and when the PBI is closed", async () => {
    const { base, s3 } = await boot(RECEIVE);
    expect(await (await post(base, "/api/backlog/306/lease", { workspaceId: meta().id, action: "acquire" })).json()).toEqual({ enabled: true, ok: true });
    const first = (await stored(s3, 306)).expiresAt as number;
    let later = first;
    for (let n = 0; n < 100 && later === first; n++) (await Bun.sleep(20), (later = (await stored(s3, 306)).expiresAt));
    expect(later).toBeGreaterThan(first);
    expect(await (await post(base, "/api/backlog/306/lease", { workspaceId: meta().id, action: "release" })).json()).toEqual({ enabled: true, ok: true });
    expect((await stored(s3, 306)).state).toBe("released");

    // taken again, then the PBI closes in what is stored: the next round gives it back
    await post(base, "/api/backlog/306/lease", { workspaceId: meta().id, action: "acquire" });
    const source = core!.db.getWorkspaceBacklogSource(meta().id)!;
    const rec = core!.db.listBacklogRecords(source, "issue").flatMap((r) => (r.objectKind === "issue" && r.remote?.number === 306 ? [r] : []))[0]!;
    core!.db.putBacklogSnapshot(source, { records: [{ objectKind: "issue", externalId: rec.externalId, remote: { ...rec.remote!, state: "CLOSED", stateReason: "COMPLETED" }, fetchState: "fetched" }], cursor: null, syncedAt: Date.now() });
    let state = "held";
    for (let n = 0; n < 100 && state === "held"; n++) (await Bun.sleep(20), (state = (await stored(s3, 306)).state));
    expect(state).toBe("released");
    expect(await new PbiLeases(s3, { machine: "pc1", ttlMs: 900_000 }).acquire("acme/app", 306)).toEqual({ ok: true });
  });
});

describe("lease and backlog-next", () => {
  test("backlog-next does not start a PBI another machine holds: the reason (who, until when) is in the log, and the slot's next item is started instead", async () => {
    // the renewal round is far off: the daemon has not seen the lease when it picks, so the refusal comes from the start itself
    const { base, s3 } = await boot({ ...RECEIVE, SWITCHBOARD_LEASE_RENEW_S: "3600" });
    // the fixtures' plan slot has a PBI to split into Tasks and a request to make PBIs of; the PBI is held elsewhere
    const items = ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items;
    const planned = items.find((i) => i.type === "pbi" && i.stage === "needs-tasks")!.number;
    const request = items.find((i) => i.stage === "request")!.number;
    const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: 900_000 });
    expect(await pc.acquire("acme/app", planned)).toEqual({ ok: true });
    const r = await post(base, "/api/schedules", { title: "バックログを進める", cron: "0 */3 * * *", workspaceId: meta().id, runner: "claude", prompt: "", action: "backlog-next" });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    expect((await fetch(`${base}/api/schedules/${id}/run`, { method: "POST" })).status).toBe(201);
    const started = core!.db.listTasks().flatMap((t) => (t.stage ? [[t.stage.issue, t.stage.action]] : []));
    expect(started).not.toContainEqual([planned, "to-tasks"]);
    expect(started.map(([n]) => n)).toContain(request);
    expect(await stored(s3, planned)).toMatchObject({ machine: "pc1", state: "held" });
    const log = ((await (await fetch(`${base}/api/schedules/log`)).json()) as string[]).join("\n");
    expect(log).toContain(`#${planned} を始められない: PBI #${planned} は pc1 が `);
    expect(log).toMatch(/ \d{4}-\d\d-\d\d \d\d:\d\d UTC まで持っている/);
  });
});

/** The `aws` CLI over an S3 kept in memory; a get of `stuck.key`, or a list under `stuck.list`, is a `sleep` that ends only when the limit the caller passed kills it. */
const emulated = (mem: ReturnType<typeof memoryS3>, stuck: { key: string | null; list?: string }): AwsRun => async (args, opts) => {
  const at = (flag: string) => args[args.indexOf(flag) + 1]!;
  const fail = (stderr: string) => ({ code: 254, stdout: "", stderr });
  if (args[1] === "get-object") {
    if (args.includes(`--key`) && at("--key") === stuck.key) return runCommand("sleep", ["30"], opts?.timeoutMs);
    const got = await mem.get(at("--key"));
    if (!got) return fail("NoSuchKey");
    writeFileSync(args[args.length - 1]!, got.body);
    return { code: 0, stdout: JSON.stringify({ ETag: got.etag }), stderr: "" };
  }
  if (args[1] === "put-object") {
    const cond = args.includes("--if-none-match") ? { ifNoneMatch: true as const } : args.includes("--if-match") ? { ifMatch: at("--if-match") } : undefined;
    const r = await mem.put(at("--key"), new Uint8Array(readFileSync(at("--body"))), cond);
    return r === "conflict" ? fail("PreconditionFailed") : { code: 0, stdout: JSON.stringify({ ETag: r.etag }), stderr: "" };
  }
  if (stuck.list !== undefined && at("--prefix") === stuck.list) return runCommand("sleep", ["30"], opts?.timeoutMs);
  const listed = await mem.list(at("--prefix"));
  return { code: 0, stdout: JSON.stringify(listed.map((o) => ({ key: o.key, etag: o.etag, size: o.size }))), stderr: "" };
};

describe("the renewal round with a request that never answers", () => {
  const REPO = "acme/app";
  /** A daemon holding PBIs 7 (recovered: nobody is at it here, so a round gives it back) and 8, whose reads of 7 never come back. */
  async function holding78(timeoutMs: number | undefined) {
    const mem = memoryS3();
    const clock = { now: 1_000_000 };
    const first = new PbiLeases(mem, { machine: "instance", ttlMs: 900_000, now: () => clock.now });
    await first.acquire(REPO, 7);
    const stuck: { key: string | null } = { key: null };
    const leases = new PbiLeases(awsS3("b", emulated(mem, stuck), timeoutMs === undefined ? undefined : { timeoutMs }), { machine: "instance", ttlMs: 900_000, now: () => clock.now });
    await leases.refresh();
    await leases.acquire(REPO, 8); // taken by this daemon for a session of its own: not recovered, not a stage's, so a round leaves it be
    stuck.key = leaseKey(REPO, 7);
    void leases.acquire(REPO, 7, true).catch(() => undefined);
    const sc = { leases, leaseBusy: false, leaseTicks: 1, uplink: { leaseTtlMs: 900_000, leaseRenewMs: 60_000 }, db: { listWorkspaces: () => [] }, leaseRepository: () => null, tasks: {} } as unknown as Parameters<typeof leaseRound>[0];
    const expiry = async (n: number) => (await stored(mem, n)).expiresAt as number;
    return { sc, clock, expiry };
  }

  test("one PBI's request that never answers is given up at the limit, and another PBI's lease is renewed in every round meanwhile", async () => {
    const { sc, clock, expiry } = await holding78(300);
    const before = await expiry(8);
    clock.now += 60_000;
    const round1 = leaseRound(sc);
    // renewed while 7's request is still stuck: the give-back of 7 does not come first, and the round does not wait for it
    await Bun.sleep(100);
    expect(await expiry(8)).toBe(clock.now + 900_000);
    expect(await expiry(8)).toBeGreaterThan(before);
    await round1;
    expect(sc.leaseBusy).toBe(false);
    // the next round is not skipped, and renews 8 again
    clock.now += 60_000;
    await leaseRound(sc);
    expect(await expiry(8)).toBe(clock.now + 900_000);
  }, 10_000);
});

describe("the lease where a turn starts, resumes and where a Task ends", () => {
  /** A runner whose every turn ends at once: its Task is between turns right after it starts. */
  const sends: string[] = [];
  const ending: RunnerAdapter = {
    id: "claude",
    detect: async () => ({ available: true, version: "fake" }),
    start(o, emit) {
      // (a Task stopped between turns has no process: its next turn starts one, with the text as its prompt)
      sends.push(String((o as { prompt?: unknown }).prompt ?? ""));
      const turn = () => queueMicrotask(() => { emit({ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }); emit({ t: "message.delta", role: "assistant", text: "ok" }); emit({ t: "session.end", status: "ok", summary: "ok" }); });
      turn();
      let end!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (end = r));
      return { send: (text: string) => { sends.push(text); turn(); }, respondPermission() {}, abort: async () => end(null), close: async () => end(0), exited };
    },
  };
  async function bootEnding(s3 = memoryS3()) {
    sends.length = 0;
    home = mkdtempSync(join(tmpdir(), "sb-uplink-server-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: join(home, "sb"), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_CODEX_HOME: join(home, "codex"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...RECEIVE });
    core = await startServer(cfg, [ending], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: () => null, gh: importing(gh, () => []), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined), s3 });
    const base = `http://127.0.0.1:${core.server.port}`;
    for (let n = 0; n < 400; n++) {
      const b = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
      if (b.syncs.length && !b.syncs.some((x) => x.syncing)) break;
      await Bun.sleep(10);
    }
    return { base, s3 };
  }
  const started = async (base: string) => {
    const { n, action } = await startable(base);
    const r = await post(base, `/api/backlog/${n}/start`, { workspaceId: meta().id, action });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    for (let k = 0; k < 300 && core!.db.getTask(id)!.status !== "done"; k++) await Bun.sleep(10);
    expect(core!.db.getTask(id)!.status).toBe("done");
    return { n, id };
  };
  const leaseOf = (base: string, n: number, action: "acquire" | "release") => post(base, `/api/backlog/${n}/lease`, { workspaceId: meta().id, action });
  const until = async (what: () => boolean | Promise<boolean>) => { for (let k = 0; k < 300 && !(await what()); k++) await Bun.sleep(10); };
  /** The follow-up turns that reached the runner (the stage's own first prompt aside). */
  const said = () => sends.filter((x) => x === "続けて" || x === "再開");
  const stops = (id: string) => core!.db.listStopRecords([id]).filter((x) => x.op === "pbi-lease").map((x) => [x.target, x.reason, x.state]);
  const pcTakes = async (s3: ReturnType<typeof memoryS3>, n: number) => {
    // the instance's lease runs out unrenewed (it slept, or was down), and the work machine takes the PBI
    await s3.put(leaseKey("acme/app", n), new TextEncoder().encode(JSON.stringify({ ...(await stored(s3, n)), expiresAt: 1 })));
    const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: 900_000 });
    expect(await pc.acquire("acme/app", n)).toEqual({ ok: true });
    return pc;
  };

  test("a stage Task between turns whose PBI another machine took meanwhile does not go on: the daemon's own resume is not started and stops it for the person (once), a reply is refused with who holds it — and goes through once the lease is free", async () => {
    const { base, s3 } = await bootEnding();
    const { n, id } = await started(base);
    // the renewal round finds it lost: the Task that would go on later (it waits for the person's judgement) is stopped now
    core!.db.updateTask(id, { outcome: "needs_action" });
    core!.db.sqlite.run("UPDATE tasks SET judging_at = NULL WHERE id = ?", [id]); // between turns, nothing of it at work
    const pc = await pcTakes(s3, n);
    await until(() => stops(id).length > 0);
    expect(stops(id)).toEqual([[`#${n}`, "decision", "waiting"]]);
    // a turn the daemon starts by itself (a wait that was met, a planned resume): refused, nothing sent, no second stop
    await expect(core!.tasks.send(id, "続けて", { daemon: true })).rejects.toThrow("is not held by this machine");
    expect([said(), stops(id).length]).toEqual([[], 1]);
    // the person's reply: refused while the other machine holds the PBI, with who holds it
    const refused = await post(base, `/api/tasks/${id}/send`, { text: "続けて" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/^PBI #\d+ は pc1 が .* まで持っている。同じ PBI を 2 台で進めないよう/);
    expect(said()).toEqual([]);
    // given back there: the reply takes the lease again and the turn runs
    await pc.release("acme/app", n);
    expect((await post(base, `/api/tasks/${id}/send`, { text: "続けて" })).status).toBe(200);
    await until(() => said().length > 0);
    expect(said()).toEqual(["続けて"]);
    expect(await stored(s3, n)).toMatchObject({ machine: "instance", state: "held" });
  });

  test("a daemon that was down while its lease ran out and was taken does not resume the Task: the lease it no longer has is found at the turn's start, with no renewal round in between", async () => {
    const { base, s3 } = await bootEnding();
    const { n, id } = await started(base);
    // as after a restart: nothing of the lease in this daemon's memory, and the bucket says the work machine has it
    await leaseOf(base, n, "release");
    await new PbiLeases(s3, { machine: "pc1", ttlMs: 900_000 }).acquire("acme/app", n);
    await expect(core!.tasks.send(id, "再開", { daemon: true })).rejects.toThrow("is not held by this machine");
    expect([said(), stops(id)]).toEqual([[], [[`#${n}`, "decision", "waiting"]]]);
    // its own lease, still valid in the bucket after a restart, is read at the gate and the turn goes on
    const { n: m, id: other } = await started(base);
    const kept = await stored(s3, m);
    await leaseOf(base, m, "release");
    await s3.put(leaseKey("acme/app", m), new TextEncoder().encode(JSON.stringify(kept)));
    await core!.tasks.send(other, "再開", { daemon: true });
    await until(() => said().length > 0);
    expect([said(), stops(other)]).toEqual([["再開"], []]);
    // and it is renewed again from here on
    const first = (await stored(s3, m)).expiresAt as number;
    await until(async () => ((await stored(s3, m)).expiresAt as number) > first);
    expect(await stored(s3, m)).toMatchObject({ machine: "instance", state: "held" });
  });

  test("a stage Task that ended for good gives its PBI's lease back; one that waits for a PR or for the person keeps it; a lease a session took for itself is left", async () => {
    const { base, s3 } = await bootEnding();
    const { n, id } = await started(base);
    expect((await stored(s3, n)).state).toBe("held");
    // it waits for the person: the lease stays through a round
    core!.db.updateTask(id, { outcome: "needs_action" });
    core!.db.sqlite.run("UPDATE tasks SET judging_at = NULL WHERE id = ?", [id]);
    await Bun.sleep(250); // several renewal rounds
    expect((await stored(s3, n)).state).toBe("held");
    // finished: given back at the next round, and the other machine can start the PBI
    core!.db.updateTask(id, { outcome: "finished" });
    core!.db.sqlite.run("UPDATE tasks SET judging_at = NULL WHERE id = ?", [id]); // judged (this daemon's judge never answers)
    await until(async () => (await stored(s3, n)).state === "released");
    expect((await stored(s3, n)).state).toBe("released");
    const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: 900_000 });
    expect(await pc.acquire("acme/app", n)).toEqual({ ok: true });
    await pc.release("acme/app", n);
    // one the person stopped while it waited for them still waits for them: its lease stays (a reply takes it up again)
    const { n: m, id: second } = await started(base);
    core!.db.updateTask(second, { outcome: "needs_action" });
    core!.db.sqlite.run("UPDATE tasks SET judging_at = NULL WHERE id = ?", [second]);
    await post(base, `/api/tasks/${second}/abort`, {});
    await Bun.sleep(250);
    expect((await stored(s3, m)).state).toBe("held");
    // a lease a session took through the route has no stage Task: it is not the daemon's to give back
    await leaseOf(base, 306, "acquire");
    await Bun.sleep(250);
    expect((await stored(s3, 306)).state).toBe("held");
  });
});

describe("uplink", () => {
  test("what a work machine put while the instance was stopped is in at its start: the Task is listed with its machine and is read only", async () => {
    const s3 = memoryS3();
    const pcHome = mkdtempSync(join(tmpdir(), "sb-uplink-server-pc-"));
    try {
      const pcCfg = loadConfig({ SWITCHBOARD_HOME: join(pcHome, "sb"), SWITCHBOARD_KNOWLEDGE: join(pcHome, "k"), SWITCHBOARD_CLAUDE_PROJECTS: join(pcHome, "c"), SWITCHBOARD_CODEX_HOME: join(pcHome, "x"), ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b" });
      mkdirSync(pcCfg.home, { recursive: true });
      const pc = new Db(pcCfg.dbPath);
      pc.insertTask(task("t-pc"));
      pc.appendEventAt("t-pc", { t: "status", text: "on the PC" }, 5_000);
      await sendUplink(pc, pcCfg, s3);
      pc.close();
    } finally {
      rmSync(pcHome, { recursive: true, force: true });
    }
    const { base } = await boot(RECEIVE, s3);
    let listed: Task | undefined;
    for (let n = 0; n < 200 && !listed; n++) {
      listed = ((await (await fetch(`${base}/api/tasks`)).json()) as Task[]).find((t) => t.id === "t-pc");
      if (!listed) await Bun.sleep(10);
    }
    expect(listed?.machine).toBe("pc1");
    for (const [path, body] of [["send", { text: "続けて" }], ["resume", { text: "" }], ["abort", {}], ["model", { model: null }]] as const) {
      const r = await post(base, `/api/tasks/t-pc/${path}`, body);
      expect([path, r.status]).toEqual([path, 409]);
      expect(((await r.json()) as { error: string }).error).toBe("この Task は pc1 で動きました。返信は pc1 の Switchboard から行います。");
    }
    // a Task of this instance's own is answered as before
    core!.db.insertTask(task("t-own", { cwd: meta().path, scope: [meta().path], workspaceId: meta().id }));
    expect((await post(base, "/api/tasks/t-own/send", { text: "続けて" })).status).not.toBe(409);
  });

  test("every way of acting on a Task of another machine is refused on the instance: the socket, an answer to a question, the routes — and nothing is written to its record", async () => {
    const { base } = await boot(RECEIVE);
    core!.db.insertTask(task("t-pc", { machine: "pc1", workspaceId: meta().id, cwd: meta().path, runnerSessionId: "s-pc", outcome: "needs_action", updatedAt: Date.now(), statusAt: Date.now() }));
    core!.db.appendEventAt("t-pc", { t: "status", text: "on the PC" }, 5_000);
    const record = () => JSON.stringify([core!.db.sqlite.query("SELECT * FROM tasks WHERE id = 't-pc'").get(), core!.db.sqlite.query("SELECT count(*) AS n FROM events WHERE task_id = 't-pc'").get(), core!.db.sqlite.query("SELECT count(*) AS n FROM task_grants").get()]);
    const before = record();
    const line = "この Task は pc1 で動きました。返信は pc1 の Switchboard から行います。";
    // the WebSocket: a reply (with a sentence that would be a merge grant), an approval, a stop
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const errors: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the socket did not open"));
    });
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; message?: string };
      if (msg.type === "error") errors.push(msg.message ?? "");
    };
    ws.send(JSON.stringify({ type: "task.send", taskId: "t-pc", text: "PR #5 を判定の外でマージしてよい" }));
    ws.send(JSON.stringify({ type: "permission.respond", taskId: "t-pc", id: "p1", decision: "allow" }));
    ws.send(JSON.stringify({ type: "task.abort", taskId: "t-pc" }));
    for (let n = 0; n < 200 && errors.length < 3; n++) await Bun.sleep(10);
    ws.close();
    expect(errors).toEqual([line, line, line]);
    // the questions put to the person do not offer it, and an answer aimed at it by id is not carried out
    const asks = (await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ task?: { id: string } | null }> };
    expect(asks.asks.filter((a) => a.task?.id === "t-pc")).toEqual([]);
    for (const [id, answer] of [["approval:t-pc:p1", { kind: "allow" }], ["stop:t-pc/s1", { kind: "text", text: "続けて" }], ["check:t-pc", { kind: "text", text: "続けて" }]] as const) {
      const r = await post(base, "/api/asks/answer", { id, answer });
      expect([id, r.status === 200 || r.status === 201]).toEqual([id, false]);
    }
    for (const [path, body] of [["send", { text: "続けて" }], ["resume", { text: "" }], ["abort", {}], ["model", { model: null }], ["fork", { seq: 1 }]] as const) expect([path, (await post(base, `/api/tasks/t-pc/${path}`, body)).status]).toEqual([path, 409]);
    expect(core!.tasks.isLive("t-pc")).toBe(false);
    expect(record()).toBe(before);
  });

  test("this machine's files are not read as a Task of another machine's: its diff, its footprint, its checks and its artifact's refresh leave them alone", async () => {
    const { base } = await boot(RECEIVE);
    // the paths the Task names exist here too, with this machine's own uncommitted work in them
    const repo = join(home, "same-path");
    mkdirSync(repo, { recursive: true });
    await Bun.$`git -C ${repo} init -q`.quiet();
    writeFileSync(join(repo, "local.txt"), "this machine's own file\n");
    writeFileSync(join(repo, "report.md"), "this machine's own report\n");
    core!.db.insertTask(task("t-pc", { machine: "pc1", workspaceId: meta().id, cwd: repo, scope: [repo] }));
    core!.db.insertArtifact({ id: "ar1", taskId: "t-pc", title: "report", kind: "file", source: join(repo, "report.md"), entry: "report.md", mime: "text/markdown", size: 1, removedAt: null, createdAt: 1, updatedAt: 1, appDays: 0, appRequestTaskId: null });
    const artifactsDir = loadConfig({ SWITCHBOARD_HOME: join(home, "sb") }).artifactsDir;
    const copy = join(artifactsDir, "t-pc", "ar1", "report.md");
    mkdirSync(join(artifactsDir, "t-pc", "ar1"), { recursive: true });
    writeFileSync(copy, "the report as it came in from pc1\n");
    const line = "この Task は pc1 で動きました。返信は pc1 の Switchboard から行います。";
    // the diff shows nothing of this machine's work tree, and the footprint measures none of its folders
    expect(await (await fetch(`${base}/api/tasks/t-pc/diff`)).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/tasks/t-pc/footprint`)).json()).toMatchObject({ files: 0, bytes: 0 });
    // the artifact is not read again from the same path here
    const refresh = await post(base, "/api/artifacts/ar1/refresh", {});
    expect([refresh.status, ((await refresh.json()) as { error: string }).error]).toEqual([409, line]);
    expect(readFileSync(copy, "utf8")).toBe("the report as it came in from pc1\n");
    // the checks do not run on this machine's checkout for it
    const checks = await post(base, "/api/tasks/t-pc/checks", {});
    expect([checks.status, ((await checks.json()) as { error: string }).error]).toEqual([409, line]);
    expect(core!.db.getCheckRun("t-pc")).toBeNull();
    // a Task of this machine's own at the same place is read as before
    core!.db.insertTask(task("t-own", { workspaceId: meta().id, cwd: repo, scope: [repo] }));
    const own = (await (await fetch(`${base}/api/tasks/t-own/diff`)).json()) as Array<{ rel: string; source: string }>;
    expect(own.map((f) => [f.rel, f.source])).toContainEqual(["local.txt", "worktree"]);
    expect(((await (await fetch(`${base}/api/tasks/t-own/footprint`)).json()) as { files: number }).files).toBeGreaterThan(0);
  });

  test("alone, none of it runs: no mode, no bucket, no timer of the uplink or the leases, nothing of the forge held back", async () => {
    const s3 = memoryS3();
    const { base } = await boot({}, s3);
    await Bun.sleep(150);
    expect(s3.calls).toBe(0);
    expect(core!.tasks).toBeDefined();
    const health = (await (await fetch(`${base}/api/health`)).json()) as { uplinkSkipped: unknown[]; uplinkRefused: unknown[] };
    expect([health.uplinkSkipped, health.uplinkRefused]).toEqual([[], []]);
    // a candidate (a copy of a database) with the variables set shares nothing either
    await core!.stop();
    core = null;
    rmSync(home, { recursive: true, force: true });
    const s3b = memoryS3();
    await boot({ ...RECEIVE, SWITCHBOARD_CANDIDATE: "1" }, s3b);
    await Bun.sleep(150);
    expect(s3b.calls).toBe(0);
  });

  test("the settings of the feature alone switch nothing on in this version: the instance's variables without the second one give a daemon that runs alone — no request to the bucket, no timer of the uplink or the leases, no role — and a work machine's do not start at all", async () => {
    // what was enough before: the mode, a registered machine, short intervals (a timer that ran would show within the wait)
    const before = { SWITCHBOARD_UPLINK: "receive", SWITCHBOARD_UPLINK_MACHINES: "pc1=acme/app", SWITCHBOARD_UPLINK_INTERVAL_S: "0.05", SWITCHBOARD_LEASE_RENEW_S: "0.05", SWITCHBOARD_LEASE_TTL_S: "0.15" };
    const s3 = memoryS3();
    // something waits in the bucket that the feature would take in, and a lease it would read
    await s3.put("uplink/pc1/pc1-0000000000001-000000.tar.zst", new Uint8Array(8));
    await s3.put("backlog/pc1/000000000001.json", new Uint8Array(8));
    await s3.put(leaseKey("acme/app", 1), new TextEncoder().encode(JSON.stringify({ pbi: 1, machine: "pc1", token: "t", state: "held", expiresAt: Date.now() + 60_000 })));
    const calls = s3.calls;
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void said.push(a.join(" "));
    let base: string;
    try {
      ({ base } = await boot(before, s3));
    } finally {
      console.warn = warn;
    }
    await Bun.sleep(400);
    // no S3 call: nothing listed, read or written, at the start or by a timer
    expect(s3.calls).toBe(calls);
    expect([...s3.objects.keys()].sort()).toEqual(["backlog/pc1/000000000001.json", "lease/acme/app/1.json", "uplink/pc1/pc1-0000000000001-000000.tar.zst"]);
    // no role: the daemon is neither the receiving instance nor a work machine, and holds no leases
    expect(loadConfig({ SWITCHBOARD_HOME: join(home, "sb"), ...before }).uplink).toMatchObject({ mode: null, machines: {} });
    const { n, action } = await startable(base);
    expect(await (await post(base, `/api/backlog/${n}/lease`, { workspaceId: meta().id, action: "acquire" })).json()).toEqual({ enabled: false });
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ uplinkSkipped: [], uplinkRefused: [] });
    // a PBI the other machine "holds" starts as on a daemon alone, and still nothing is asked of the bucket
    expect((await post(base, `/api/backlog/${n}/start`, { workspaceId: meta().id, action })).status).toBe(201);
    await Bun.sleep(100);
    expect(s3.calls).toBe(calls);
    // and it is said once, in the log, why
    expect(said.filter((l) => l.includes("SWITCHBOARD_UPLINK=receive") && l.includes("runs alone"))).toHaveLength(1);
    // a work machine's settings alone: the daemon does not start (it must not run as an instance of its own instead)
    expect(() => loadConfig({ SWITCHBOARD_HOME: join(home, "pc"), SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b" })).toThrow("not available in this version");
    // the second variable with any other value is not the opt-in
    expect(() => loadConfig({ SWITCHBOARD_HOME: join(home, "pc"), SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b", SWITCHBOARD_UPLINK_PREVIEW: "1" })).toThrow("not available in this version");
    expect(UPLINK_PREVIEW).toEqual({ SWITCHBOARD_UPLINK_PREVIEW: "not-for-use" });
  });

  test("the instance with no machine registered takes in from nobody: only its own leases are read in the bucket, and backlog-export/ is listed to withdraw what an earlier registry wrote", async () => {
    const s3 = memoryS3();
    await s3.put("uplink/pc1/pc1-0000000000001-000000.tar.zst", new Uint8Array(8));
    await s3.put("backlog/pc1/000000000001.json", new Uint8Array(8));
    const asked: string[] = [];
    const watching = { ...s3, put: s3.put, get: (k: string) => (asked.push(`get ${k}`), s3.get(k)), list: (p: string, a?: string) => (asked.push(`list ${p}`), s3.list(p, a)) };
    await boot({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "receive", SWITCHBOARD_UPLINK_INTERVAL_S: "0.05", SWITCHBOARD_LEASE_RENEW_S: "0.05" }, watching as never);
    await Bun.sleep(300);
    expect([...new Set(asked)].sort()).toEqual(["list backlog-export/", "list lease/"]);
  });

  test("a work machine's daemon writes nothing to the forge and decides nothing by itself: no write reaches gh, the sweep fired by hand starts nothing", async () => {
    const calls: string[][] = [];
    const spy: GhRunner = async (args, cwd) => (calls.push(args), gh(args, cwd));
    home = mkdtempSync(join(tmpdir(), "sb-uplink-server-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: join(home, "sb"), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_CODEX_HOME: join(home, "codex"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b", SWITCHBOARD_UPLINK_INTERVAL_S: "3600" });
    const seen: Array<{ env?: Record<string, string | undefined> }> = [];
    const noting: RunnerAdapter = { ...holding, start: (o, emit) => (seen.push(o), holding.start(o, emit)) };
    core = await startServer(cfg, [noting], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: () => null, gh: spy, backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined), s3: memoryS3() });
    const base = `http://127.0.0.1:${core.server.port}`;
    await Bun.sleep(200);
    // the daemon's own gh: a write asked of it is answered as failed and never run
    const { ghReadsOnly } = await import("../../../ops-kit/src/gh-reads.ts");
    expect(calls.filter((c) => !ghReadsOnly(c))).toEqual([]);
    // "バックログを進める" fired by hand: nothing is chosen, and the log says why
    const sweep = (await (await post(base, "/api/schedules", { title: "バックログを進める", cron: "0 */3 * * *", workspaceId: meta().id, runner: "claude", prompt: "", action: "backlog-next" })).json()) as { id: string };
    expect((await post(base, `/api/schedules/${sweep.id}/run`, {})).status).toBe(409);
    const log = JSON.stringify(await (await fetch(`${base}/api/schedules/log`)).json());
    expect(log).toContain("作業場のマシンでは行いません");
    expect(core.db.listTasks().filter((t) => t.stage)).toEqual([]);
    // a Task started there is told the forge is read only
    const made = await post(base, "/api/tasks", { prompt: "やって", runner: "claude", cwd: meta().path, workspaceId: meta().id });
    expect(made.status).toBe(201);
    expect(seen.at(-1)?.env?.OPS_KIT_FORGE_READ_ONLY).toBe("1");
    expect(calls.filter((c) => !ghReadsOnly(c))).toEqual([]);
  });

  test("a delta this instance is too old for is told in the health answer, with both levels", async () => {
    const { base } = await boot(RECEIVE);
    expect(((await (await fetch(`${base}/api/health`)).json()) as { uplinkSkipped: unknown[] }).uplinkSkipped).toEqual([]);
    core!.db.setSetting("uplink.skipped", [{ machine: "pc1", deltaId: "pc1-1-000000", theirs: 301, ours: 297, at: 1 }]);
    expect(((await (await fetch(`${base}/api/health`)).json()) as { uplinkSkipped: unknown[] }).uplinkSkipped).toEqual([{ machine: "pc1", theirs: 301, ours: 297 }]);
  });
});

describe("the stores setupBacklog builds", () => {
  test("the lease store and the uplink's own each carry their own time limit, the bucket-name lookup included", async () => {
    const seen: Array<{ cmd: string; timeoutMs?: number }> = [];
    const run: AwsRun = async (args, opts) => {
      seen.push({ cmd: args[0] === "ssm" ? "ssm" : `${args[0]} ${args[1]}`, timeoutMs: opts?.timeoutMs });
      return args[0] === "ssm" ? { code: 0, stdout: "named\n", stderr: "" } : { code: 254, stdout: "", stderr: "NoSuchKey" };
    };
    const { s3, leases } = uplinkStores({ bucket: "", leaseCallTimeoutMs: 20_000, uplinkCallTimeoutMs: 600_000 }, run);
    await leases.get("k");
    expect(seen).toEqual([{ cmd: "ssm", timeoutMs: 20_000 }, { cmd: "s3api get-object", timeoutMs: 20_000 }]);
    seen.length = 0;
    await s3.get("k");
    expect(seen).toEqual([{ cmd: "ssm", timeoutMs: 600_000 }, { cmd: "s3api get-object", timeoutMs: 600_000 }]);
  });
});

describe("the uplink round with a request that never answers", () => {
  test("a listing of a machine's uplink/ that never returns ends the round at the limit, the withdrawal still runs in it, and the next round runs", async () => {
    const mem = memoryS3();
    const key = "backlog-export/pc2/acme/app.json.zst"; // a machine no longer registered: its export is to be withdrawn
    await mem.put(key, new Uint8Array(8));
    const stuck = { key: null, list: "uplink/pc1/" };
    let listed = 0;
    const run: AwsRun = async (args, opts) => {
      if (args[1] === "list-objects-v2" && args[args.indexOf("--prefix") + 1] === "uplink/pc1/") listed++;
      return emulated(mem, stuck)(args, opts);
    };
    const { s3 } = uplinkStores({ bucket: "b", leaseCallTimeoutMs: 20_000, uplinkCallTimeoutMs: 300 }, run);
    await boot({ ...RECEIVE, SWITCHBOARD_UPLINK_INTERVAL_S: "0.6" }, s3 as never);
    const withdrawn = async () => (await mem.get(key))!.body.length !== 8;
    // the first round waited for the stuck listing until the limit, then withdrew the export that no machine is registered for
    for (let k = 0; k < 200 && !(await withdrawn()); k++) await Bun.sleep(20);
    expect(await withdrawn()).toBe(true);
    expect(listed).toBe(1);
    // the busy flag came back (a round that is still busy returns at once): the next round on the interval asked again
    for (let k = 0; k < 200 && listed < 2; k++) await Bun.sleep(20);
    expect(listed).toBeGreaterThanOrEqual(2);
  }, 15_000);
});

describe("the uplink's mode stays with the daemon", () => {
  test("what it starts does not inherit it: a daemon booted from its environment after the start reads no mode and leaves the bucket alone", async () => {
    // the instance's sb-env (or a work machine's env file) puts the mode in the daemon's own environment; a runner, a
    // terminal or a scratch daemon a Task boots from what it inherits must not take leases or write exports as this machine
    const before = Object.fromEntries(Object.keys(RECEIVE).map((k) => [k, process.env[k]]));
    Object.assign(process.env, RECEIVE);
    try {
      const { s3 } = await boot(RECEIVE);
      for (const name of ["SWITCHBOARD_UPLINK", "SWITCHBOARD_UPLINK_PREVIEW", "SWITCHBOARD_UPLINK_MACHINES"]) expect({ name, inherited: process.env[name] }).toEqual({ name, inherited: undefined });
      // the running daemon took the mode at its start (it asked the bucket), and a second one from the inherited environment has none
      expect(s3.calls).toBeGreaterThan(0);
      expect(loadConfig({ ...process.env, SWITCHBOARD_HOME: join(home, "scratch") }).uplink.mode).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("its own replacement keeps it: a daemon without a supervisor restarted by itself comes back in the same mode", async () => {
    // a work machine started by hand (no sb-rescue) must not come back as an instance of its own after its own restart
    const set: Record<string, string> = { ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b" };
    const before = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    Object.assign(process.env, set);
    home = mkdtempSync(join(tmpdir(), "sb-uplink-restart-"));
    const health = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const exit = process.exit;
    try {
      const cfg = loadConfig({ ...set, SWITCHBOARD_HOME: join(home, "sb"), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_CODEX_HOME: join(home, "codex"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_PORT: "0" });
      core = await startServer(cfg, [holding], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: () => null, gh: importing(gh, () => []), judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined), s3: memoryS3() });
      expect(process.env.SWITCHBOARD_UPLINK).toBeUndefined();
      const out = join(home, "env");
      process.exit = (() => undefined) as unknown as typeof process.exit;
      const sc = { db: { listWorkingTasks: () => [] }, restarting: true, broadcast: () => {}, stopAll: async () => {}, cfg, server: { port: health.port } };
      await performRestart(sc as unknown as Parameters<typeof performRestart>[0], ["/bin/sh", "-c", `env > '${out}.tmp' && mv '${out}.tmp' '${out}'`], false, true);
      process.exit = exit;
      for (let n = 0; n < 100 && !existsSync(out); n++) await Bun.sleep(20);
      const child = Object.fromEntries(readFileSync(out, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      expect(loadConfig({ ...child, SWITCHBOARD_HOME: join(home, "next") }).uplink.mode).toBe("send");
    } finally {
      process.exit = exit;
      health.stop(true);
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 40_000);
});
