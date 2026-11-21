// test-reads: none
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { realCliSourceDeps, type CliSourceDeps } from "./cli-update-source.ts";
import { placesOf } from "./cli-update-install.ts";
import { NO_GH, NO_HISTORY, SCRIPT, fakeAdapter, holdingClaude, j, startServer, until } from "./api-test-harness.ts";

/**
 * The daemon with its real update code (cli-update-source.ts and cli-update-install.ts, `--version` of a real file
 * included) over two fakes: a distributor that answers as downloads.claude.ai does, and the one turn the runner would
 * run. The host is a folder under a temp directory.
 */

const HOUR = 3_600_000;
const NOW = Date.now();
interface Version { published: number; says?: string; sum?: string; noManifest?: boolean; redirectTo?: string }
const content = (v: string, says = v) => `#!/bin/sh\necho "${says} (Claude Code)"\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function rig(opts: { candidate?: boolean; installed?: string | null; env?: Record<string, string>; adapter?: ReturnType<typeof holdingClaude>["adapter"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "switchboard.cli-update-api."));
  const dataHome = join(dir, "data");
  const host = join(dir, "host");
  const dist = { latest: "2.1.0", versions: new Map<string, Version>(), fetched: [] as string[] };
  const turns: string[] = [];
  /** while set, a turn does not come back until it resolves (a check that holds the links) */
  const gate: { wait: Promise<void> | null } = { wait: null };
  dist.versions.set("2.1.0", { published: NOW - 100 * HOUR });
  const seed = opts.installed === undefined ? "2.1.0" : opts.installed;
  const p = placesOf("claude", host, "aarch64-unknown-linux-musl");
  if (seed) {
    mkdirSync(p.versions, { recursive: true });
    writeFileSync(p.bin(seed), content(seed));
    chmodSync(p.bin(seed), 0o755);
    mkdirSync(join(p.link, ".."), { recursive: true });
    symlinkSync(p.dir(seed), p.link);
  }
  const real = await realCliSourceDeps();
  const source: CliSourceDeps = {
    ...real,
    target: () => ({ arch: "arm64", musl: false }),
    fetch: async (url) => {
      dist.fetched.push(url);
      const u = new URL(url);
      if (u.hostname === "evil.example") return new Response("not what was asked for");
      const base = "/claude-code-releases/";
      if (u.hostname !== "downloads.claude.ai" || !u.pathname.startsWith(base)) return new Response("no", { status: 404 });
      const rest = u.pathname.slice(base.length);
      if (rest === "latest") return new Response(dist.latest);
      const [v, ...file] = rest.split("/");
      const meta = dist.versions.get(v!);
      if (!meta) return new Response("no", { status: 404 });
      if (file.join("/") === "manifest.json.sig") return new Response("no", { status: 404 }); // no signature published
      if (file.join("/") === "manifest.json") {
        if (meta.noManifest) return new Response("no", { status: 404 });
        const body = content(v!, meta.says);
        return Response.json({ version: v, buildDate: new Date(meta.published).toISOString(), platforms: { "linux-arm64": { checksum: meta.sum ?? sha(body) } } });
      }
      if (file.join("/") === "linux-arm64/claude") {
        if (meta.redirectTo) return new Response(null, { status: 302, headers: { location: meta.redirectTo } });
        return new Response(content(v!, meta.says));
      }
      return new Response("no", { status: 404 });
    },
  };
  const cfg = loadConfig({ SWITCHBOARD_HOME: dataHome, SWITCHBOARD_PORT: "0", ...NO_HISTORY, ...(opts.candidate ? { SWITCHBOARD_CANDIDATE: "1" } : {}), ...opts.env });
  const core = await startServer(cfg, [opts.adapter ?? fakeAdapter(SCRIPT)], {
    port: 0,
    selfdevChecks: false,
    dryRunRestart: true,
    gh: NO_GH,
    cliUpdate: { source, install: { home: host, codexTarget: "aarch64-unknown-linux-musl", turn: async (_r, bin) => {
      turns.push(bin);
      if (gate.wait) await gate.wait;
    } }, checkMs: 40 },
  });
  cleanup.push(async () => {
    await core.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${core.server.port}`;
  const send = (method: string, path: string, body?: object) => fetch(`${base}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return {
    core, dist, turns, gate, p, base, send,
    /** the version the link points at (what runs) */
    linked: () => p.versionOf(readlinkSync(p.link).split("/").at(-1)!),
    publish: (v: string, meta: Partial<Version> = {}) => {
      dist.versions.set(v, { published: NOW - 2 * HOUR, ...meta });
      dist.latest = v;
    },
    settings: (cliUpdate: object | null) => send("PATCH", "/api/settings", { cliUpdate }),
    state: async () => (await (await send("GET", "/api/runners/updates")).json()) as { enabled: boolean; runners: Array<{ runner: string; current: string | null; previous: string | null; waiting: { version: string; reason: string } | null; rollbackWaiting: boolean; note: string | null }>; records: Array<{ outcome: string; toVersion: string; fromVersion: string | null; reason: string; by: string; sha256: string | null }> },
    rows: () => core.db.listCliUpdates(50).reverse().map((r) => `${r.outcome} ${r.fromVersion ?? "-"}->${r.toVersion}`),
    startTask: async (title = "busy") => (await send("POST", "/api/tasks", { cwd: dir, title, prompt: "p", runner: "claude" }).then(j)).id as string,
    /** the version is in: the link moved and the record says so (the link moves a moment before the row) */
    installed: (v: string) => until(() => core.db.listCliUpdates(50).some((x) => x.outcome === "installed" && x.toVersion === v)),
    /** what the CLI prints when run through the link, as the host runs it */
    runs: async () => (await Bun.$`${p.link} --version`.text()).trim(),
  };
}
const SETTLE = 400; // ten firings of the 40 ms interval

describe("host CLI updates through the daemon", () => {
  test("refuses the three bad downloads", async () => {
    const r = await rig();
    // a download that redirects off the distributor's hosts
    r.publish("2.2.0", { redirectTo: "https://evil.example/claude" });
    await until(() => r.core.db.listCliUpdates(5).length === 1);
    // a file that is not the one the manifest lists
    r.publish("2.3.0", { sum: "0".repeat(64) });
    await until(() => r.core.db.listCliUpdates(5).length === 2);
    // a latest the distributor no longer has a manifest for
    r.publish("2.4.0", { noManifest: true });
    await until(() => r.core.db.listCliUpdates(5).length === 3);
    await Bun.sleep(SETTLE);
    // each is told once, with its reason, and none of them was run or linked
    expect((await r.state()).records.map((x) => [x.outcome, x.toVersion, x.reason.split(":")[0], x.by])).toEqual([
      ["refused", "2.4.0", "withdrawn", "auto"],
      ["refused", "2.3.0", "mismatch", "auto"],
      ["refused", "2.2.0", "not-official", "auto"],
    ]);
    expect(r.linked()).toBe("2.1.0");
    expect(await r.runs()).toBe("2.1.0 (Claude Code)");
    expect(r.turns).toEqual([]);
    expect(existsSync(r.p.dir("2.2.0")) || existsSync(r.p.dir("2.3.0"))).toBe(false);
  });

  test("does not swap while a Task runs", async () => {
    const holding = holdingClaude();
    const r = await rig({ adapter: holding.adapter });
    expect((await r.settings({ missingSignature: "allow" })).status).toBe(200);
    const task = await r.startTask();
    await until(() => r.core.db.listWorkingTasks("gate").length === 1);
    r.publish("2.2.0");
    await until(async () => (await r.state()).runners[0]!.waiting?.version === "2.2.0");
    await Bun.sleep(SETTLE);
    // checked and tried (one turn), but the link has not moved while the Task runs
    expect(r.linked()).toBe("2.1.0");
    expect(r.turns).toHaveLength(1);
    expect(await r.state().then((s) => [s.runners[0]!.waiting, s.records.map((x) => x.outcome)])).toEqual([{ version: "2.2.0", reason: expect.stringContaining("Task が動いている") }, ["waiting"]]);
    // the Task ends: the version goes in, with no second turn
    await r.send("POST", `/api/tasks/${task}/abort`);
    await r.installed("2.2.0");
    expect(r.turns).toHaveLength(1);
    expect(await r.runs()).toBe("2.2.0 (Claude Code)");
    expect(r.rows()).toEqual(["waiting 2.1.0->2.2.0", "installed 2.1.0->2.2.0"]);
    expect((await r.state()).runners[0]).toMatchObject({ current: "2.2.0", waiting: null });
  });

  test("wait hours pick a different version", async () => {
    const r = await rig();
    expect((await r.settings({ missingSignature: "allow", waitHours: 24 })).status).toBe(200);
    // 2.2.0 has been out for 30 hours, so a 24-hour wait takes it
    r.publish("2.2.0", { published: NOW - 30 * HOUR });
    await r.installed("2.2.0");
    // 2.3.0 came out 2 hours ago: it is held, and says for how long
    r.publish("2.3.0", { published: NOW - 2 * HOUR });
    await until(async () => (await r.state()).runners[0]!.waiting?.version === "2.3.0");
    await Bun.sleep(SETTLE);
    expect(r.linked()).toBe("2.2.0");
    expect((await r.state()).runners[0]!.waiting!.reason).toMatch(/24 時間待つ（あと約 22 時間）/);
    // with no wait, the same 2.3.0 goes in
    expect((await r.settings({ waitHours: 0 })).status).toBe(200);
    await r.installed("2.3.0");
    // the wait is in the record too, once, with its reason
    expect(r.rows()).toEqual(["installed 2.1.0->2.2.0", "waiting 2.2.0->2.3.0", "installed 2.2.0->2.3.0"]);
    expect(r.core.db.listCliUpdates(5).find((x) => x.outcome === "waiting")!.reason).toBe("出てから 24 時間待つ");
  });

  test("rolls back from the API", async () => {
    const holding = holdingClaude();
    const r = await rig({ adapter: holding.adapter });
    expect((await r.settings({ missingSignature: "allow" })).status).toBe(200);
    // nothing was put in yet, so there is nothing to go back to; an unknown runner has no CLI here
    const none = await r.send("POST", "/api/runners/claude/rollback");
    expect(none.status).toBe(409);
    expect(((await none.json()) as { ok: boolean; reason: string }).reason).toContain("戻す先の版");
    expect((await r.send("POST", "/api/runners/nope/rollback")).status).toBe(404);
    r.publish("2.2.0");
    await r.installed("2.2.0");
    r.publish("2.3.0");
    await r.installed("2.3.0");
    expect((await r.state()).runners[0]).toMatchObject({ current: "2.3.0", previous: "2.2.0" });
    // a Task runs: the answer is "when it is free", and the link stays until then
    const task = await r.startTask();
    await until(() => r.core.db.listWorkingTasks("gate").length === 1);
    const asked = await r.send("POST", "/api/runners/claude/rollback");
    expect([asked.status, await asked.json()]).toEqual([202, { ok: true, waiting: true, to: "2.2.0", reason: expect.stringContaining("空いたら") }]);
    await Bun.sleep(SETTLE);
    expect(r.linked()).toBe("2.3.0");
    expect((await r.state()).runners[0]!.rollbackWaiting).toBe(true);
    await r.send("POST", `/api/tasks/${task}/abort`);
    await until(() => r.core.db.lastCliUpdate("claude", "rolled-back") !== null);
    expect(await r.runs()).toBe("2.2.0 (Claude Code)");
    // asked by a person, and the version put back from is not brought in again by itself
    await Bun.sleep(SETTLE);
    expect(r.linked()).toBe("2.2.0");
    expect((await r.state()).records[0]).toMatchObject({ outcome: "rolled-back", fromVersion: "2.3.0", toVersion: "2.2.0", by: "person" });
    // with no Task running it is done in the answer; 2.3.0, which the person went back from, is not the target
    r.publish("2.4.0");
    await r.installed("2.4.0");
    const done = await r.send("POST", "/api/runners/claude/rollback");
    expect([done.status, await done.json()]).toEqual([200, { ok: true, waiting: false, to: "2.2.0", reason: "2.2.0 に戻した" }]);
    expect(r.linked()).toBe("2.2.0");
  });

  test("a version checked under looser settings is checked again, not moved in", async () => {
    const holding = holdingClaude();
    const r = await rig({ adapter: holding.adapter });
    expect((await r.settings({ missingSignature: "allow", smoke: "version" })).status).toBe(200);
    const task = await r.startTask();
    await until(() => r.core.db.listWorkingTasks("gate").length === 1);
    r.publish("2.2.0");
    await until(async () => (await r.state()).runners[0]!.waiting?.version === "2.2.0");
    // while it waits for the Task, the person requires a turn: the move must not record a turn that never ran
    expect((await r.settings({ smoke: "turn" })).status).toBe(200);
    await r.send("POST", `/api/tasks/${task}/abort`);
    await r.installed("2.2.0");
    expect(r.turns).toHaveLength(1);
    // the same with a signature: checked under "allow", then "refuse" keeps it out
    const task2 = await r.startTask("busy again");
    await until(() => r.core.db.listWorkingTasks("gate").length === 1);
    r.publish("2.3.0");
    await until(async () => (await r.state()).runners[0]!.waiting?.version === "2.3.0");
    expect((await r.settings({ missingSignature: "refuse" })).status).toBe(200);
    await r.send("POST", `/api/tasks/${task2}/abort`);
    await until(() => r.core.db.listCliUpdates(1)[0]!.outcome === "refused");
    await Bun.sleep(SETTLE);
    expect(r.linked()).toBe("2.2.0");
    expect(r.core.db.listCliUpdates(1)[0]).toMatchObject({ toVersion: "2.3.0", reason: expect.stringContaining("unsigned") });
  });

  test("a rollback asked while a check holds the links waits for it, and does not hang the request", async () => {
    const r = await rig();
    expect((await r.settings({ missingSignature: "allow" })).status).toBe(200);
    r.publish("2.2.0");
    await r.installed("2.2.0");
    r.publish("2.3.0");
    await r.installed("2.3.0");
    let open!: () => void;
    r.gate.wait = new Promise<void>((res) => (open = res));
    r.publish("2.4.0");
    await until(() => r.turns.length === 3); // the check of 2.4.0 is in its turn
    const asked = await r.send("POST", "/api/runners/claude/rollback");
    expect([asked.status, await asked.json()]).toEqual([202, { ok: true, waiting: true, to: "2.2.0", reason: expect.stringContaining("確かめている") }]);
    expect(r.linked()).toBe("2.3.0");
    r.gate.wait = null;
    open();
    await until(() => r.core.db.lastCliUpdate("claude", "rolled-back") !== null);
    // the rollback went first, from 2.3.0 to 2.2.0 as answered (2.4.0, still published, may go in at a later check)
    expect(r.core.db.lastCliUpdate("claude", "rolled-back")).toMatchObject({ fromVersion: "2.3.0", toVersion: "2.2.0", by: "person" });
  });

  test("a version waiting for the Tasks goes in only if it still fits: a longer wait, or the distributor going back, keeps it out", async () => {
    const holding = holdingClaude();
    const r = await rig({ adapter: holding.adapter });
    expect((await r.settings({ missingSignature: "allow" })).status).toBe(200);
    const task = await r.startTask();
    await until(() => r.core.db.listWorkingTasks("gate").length === 1);
    r.publish("2.2.0"); // out 2 hours ago
    await until(async () => (await r.state()).runners[0]!.waiting?.version === "2.2.0");
    expect((await r.settings({ waitHours: 24 })).status).toBe(200);
    await r.send("POST", `/api/tasks/${task}/abort`);
    await Bun.sleep(SETTLE);
    expect(r.linked()).toBe("2.1.0");
    expect((await r.state()).runners[0]!.waiting).toMatchObject({ version: "2.2.0", reason: expect.stringContaining("24 時間待つ") });

    // back to no wait, a Task again, and the distributor's newest goes back below what waits: it is recorded as withdrawn
    expect((await r.settings({ waitHours: 0 })).status).toBe(200);
    const task2 = await r.startTask("busy again");
    await until(() => r.core.db.listWorkingTasks("gate").length === 1);
    await until(async () => (await r.state()).runners[0]!.waiting?.reason.includes("Task") === true);
    r.dist.latest = "2.1.0";
    await until(() => r.core.db.listCliUpdates(1)[0]!.outcome === "refused");
    expect(r.core.db.listCliUpdates(1)[0]).toMatchObject({ toVersion: "2.2.0", reason: expect.stringContaining("withdrawn") });
    await r.send("POST", `/api/tasks/${task2}/abort`);
    await Bun.sleep(SETTLE);
    expect(r.linked()).toBe("2.1.0");
  });

  test("the distributor going back below what waits, but not below what runs, still records the waiting version as withdrawn", async () => {
    const holding = holdingClaude();
    const r = await rig({ adapter: holding.adapter });
    expect((await r.settings({ missingSignature: "allow" })).status).toBe(200);
    r.dist.versions.set("2.2.0", { published: NOW - 2 * HOUR });
    const task = await r.startTask();
    await until(() => r.core.db.listWorkingTasks("gate").length === 1);
    r.publish("2.3.0");
    await until(async () => (await r.state()).runners[0]!.waiting?.version === "2.3.0");
    r.dist.latest = "2.2.0";
    await until(() => r.core.db.listCliUpdates(5).some((x) => x.outcome === "refused" && x.toVersion === "2.3.0"));
    expect(r.core.db.listCliUpdates(5).find((x) => x.toVersion === "2.3.0" && x.outcome === "refused")!.reason).toContain("withdrawn");
    // its checked files go too (not what runs, not what a rollback goes to)
    expect(existsSync(r.p.dir("2.3.0"))).toBe(false);
    await r.send("POST", `/api/tasks/${task}/abort`);
  });

  test("a version is refused once, even when other versions were refused in between", async () => {
    const r = await rig();
    r.publish("2.2.0", { noManifest: true });
    await until(() => r.core.db.listCliUpdates(5).length === 1);
    r.publish("2.3.0", { noManifest: true });
    await until(() => r.core.db.listCliUpdates(5).length === 2);
    r.dist.latest = "2.2.0";
    await Bun.sleep(SETTLE);
    expect(r.rows()).toEqual(["refused 2.1.0->2.2.0", "refused 2.1.0->2.3.0"]);
  });

  test("a version placed before a restart (or a wait) and never moved in is placed again and goes in", async () => {
    const r = await rig();
    expect((await r.settings({ missingSignature: "allow" })).status).toBe(200);
    // what an earlier daemon left: 2.2.0 placed, the daemon restarted before it moved in (other bytes than the download)
    writeFileSync(r.p.bin("2.2.0"), "#!/bin/sh\necho 2.2.0 (Claude Code) left over\n");
    chmodSync(r.p.bin("2.2.0"), 0o755);
    r.publish("2.2.0");
    await r.installed("2.2.0");
    expect(await r.runs()).toBe("2.2.0 (Claude Code)");
  });

  test("with nothing new, only the version name is read", async () => {
    const r = await rig();
    await Bun.sleep(SETTLE);
    expect(r.dist.fetched.length).toBeGreaterThan(2);
    expect(r.dist.fetched.every((u) => u.endsWith("/latest"))).toBe(true);
  });

  test("settings choose signature and smoke", async () => {
    const r = await rig();
    expect((await r.send("GET", "/api/settings").then(j)).cliUpdate).toEqual({ checkMinutes: 60, waitHours: 0, missingSignature: "refuse", smoke: "turn" });
    for (const bad of [{ checkMinutes: 0 }, { checkMinutes: 1441 }, { waitHours: -1 }, { waitHours: 721 }, { missingSignature: "maybe" }, { smoke: "none" }]) expect((await r.settings(bad)).status).toBe(400);
    // the distributor publishes no signature, and the default keeps the version out
    r.publish("2.2.0");
    await until(() => r.core.db.listCliUpdates(5).length === 1);
    await Bun.sleep(SETTLE);
    expect(await r.state().then((s) => s.records.map((x) => [x.outcome, x.reason]))).toEqual([["refused", "unsigned: the distributor published no signature"]]);
    expect(r.linked()).toBe("2.1.0");
    // allowing it takes the same version in, after one turn
    expect((await r.settings({ missingSignature: "allow" })).status).toBe(200);
    await r.installed("2.2.0");
    expect(r.turns).toHaveLength(1);
    expect((await r.state()).records[0]).toMatchObject({ outcome: "installed", reason: expect.stringContaining("1 ターン"), sha256: sha(content("2.2.0")) });
    // `version` takes the next one in on `--version` alone: no turn is run
    expect((await r.settings({ smoke: "version" })).status).toBe(200);
    r.publish("2.3.0");
    await r.installed("2.3.0");
    expect(r.turns).toHaveLength(1);
    // a version that does not say what the distributor lists never gets the link, whatever the settings
    r.publish("2.4.0", { says: "9.9.9" });
    await until(() => r.core.db.listCliUpdates(1)[0]!.toVersion === "2.4.0");
    expect(r.core.db.listCliUpdates(1)[0]).toMatchObject({ outcome: "refused", reason: expect.stringContaining("--version") });
    await Bun.sleep(SETTLE);
    expect(r.linked()).toBe("2.3.0");
  });

  test("a candidate daemon and a host without the installer's link leave the host alone", async () => {
    const candidate = await rig({ candidate: true });
    candidate.publish("2.2.0");
    await candidate.settings({ missingSignature: "allow" });
    await Bun.sleep(SETTLE);
    expect(candidate.linked()).toBe("2.1.0");
    expect(candidate.dist.fetched).toEqual([]);
    expect((await candidate.state()).enabled).toBe(false);
    const refused = await candidate.send("POST", "/api/runners/claude/rollback");
    expect(refused.status).toBe(409);

    const bare = await rig({ installed: null });
    await bare.settings({ missingSignature: "allow" });
    bare.publish("2.2.0");
    await Bun.sleep(SETTLE);
    expect(bare.dist.fetched).toEqual([]);
    expect((await bare.state()).runners[0]).toMatchObject({ runner: "claude", current: null, note: expect.stringContaining("symlink が無い") });
    expect(existsSync(bare.p.link)).toBe(false);
  });
});
