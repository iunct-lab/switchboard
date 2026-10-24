import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, StartOptions } from "@switchboard/protocol";
import { Db, abortOrphanedTasks } from "./db.ts";
import { TaskManager } from "./tasks.ts";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ref = { id: "session_0123456789abcdefghijklmn", url: "https://claude.ai/code/session_0123456789abcdefghijklmn" };
function setup(events: AgentEvent[], code = 0) {
  const cwd = mkdtempSync(join(tmpdir(), "switchboard-cloud-task-")); dirs.push(cwd);
  const file = join(cwd, "test.db"), db = new Db(file), starts: StartOptions[] = [];
  const adapter: RunnerAdapter = { id: "claude", permissionModes: [{ value: "default", label: "Default", description: "Default" }], defaultPermissionMode: "default", detect: async () => ({ available: true }), start: (opts, emit) => {
    starts.push(opts); for (const e of events) emit(e);
    return { exited: Promise.resolve(code), send: () => { throw new Error("unexpected send"); }, respondPermission: () => { throw new Error("unexpected permission"); }, abort: async () => {}, close: async () => {} };
  } };
  const tasks = new TaskManager(db, new Map([["claude", adapter], ["codex", { ...adapter, id: "codex" as const }]]), () => {}, { defaultShadowRunner: () => "codex", defaultPermissionMode: () => "default", deviceAuthEnv: () => ({ DEVICE_AUTH_URL: "private" }) });
  return { cwd, file, db, tasks, starts, input: { cwd, title: "Cloud", prompt: "Read", runner: "claude" as const, executionMode: "cloud" as const } };
}

test("creation and launcher exit, including nonzero, never complete a Cloud task", async () => {
  for (const code of [0, 1]) {
    const s = setup([{ t: "cloud.session.created", ...ref }, { t: "session.end", status: "ok", summary: "Done" }], code);
    let judged = 0; s.tasks.onTurnEnd(() => judged++);
    const t = s.tasks.create(s.input); await Bun.sleep(1);
    expect(s.db.getTask(t.id)).toMatchObject({ status: "idle", outcome: "unknown", cloudSession: ref, runnerSessionId: null, permissionMode: null, resumeAt: null });
    expect(judged).toBe(0); expect(s.starts).toHaveLength(1);
    expect(s.starts[0]).toMatchObject({ executionMode: "cloud", cwd: s.cwd, prompt: "Read" });
    expect(s.starts[0]!.env).toBeUndefined(); expect(s.starts[0]!.preamble).toBeUndefined();
    await expect(s.tasks.send(t.id, "more")).rejects.toThrow("公式 Web");
    await expect(s.tasks.setModel(t.id, "model")).rejects.toThrow("公式 Web");
    await expect(s.tasks.setPermissionMode(t.id, "default")).rejects.toThrow("公式 Web");
    expect(() => s.tasks.setResumeAt(t.id, Date.now())).toThrow("公式 Web");
    expect((await s.tasks.abort(t.id)).status).toBe("idle");
    await s.tasks.shutdown(); s.db.close(); const reopened = new Db(s.file);
    expect(reopened.getTask(t.id)).toMatchObject({ cloudSession: ref, outcome: "unknown", status: "idle" }); reopened.close();
  }
});

test("no reference or invalid reference remains error/unknown without Local fallback", async () => {
  for (const events of [[], [{ t: "cloud.session.created", id: ref.id, url: "https://example.com" }]] as AgentEvent[][]) {
    const s = setup(events); const t = s.tasks.create(s.input); await Bun.sleep(1);
    expect(s.db.getTask(t.id)).toMatchObject({ status: "error", outcome: "unknown", cloudSession: null, resumeAt: null });
    await s.tasks.shutdown(); s.db.close();
  }
});

test("unsupported Cloud input is refused before insertion, suggestion or spawn", () => {
  const s = setup([]);
  for (const extra of [{ runner: "codex" }, { budgetUsd: 1 }, { model: "model" }, { permissionMode: "default" }, { shadowRunner: "codex" }, { attachmentIds: ["id"] }, { scope: ["/other"] }, { scheduleId: "schedule" }]) {
    expect(() => s.tasks.create({ ...s.input, ...extra } as Parameters<TaskManager["create"]>[0])).toThrow();
  }
  expect(s.starts).toHaveLength(0); expect(s.db.listTasks()).toHaveLength(0); s.db.close();
});

test("orphaned Cloud launcher cannot schedule Local resume or report aborted Cloud work", async () => {
  const s = setup([{ t: "cloud.session.created", ...ref }]); const t = s.tasks.create(s.input); await Bun.sleep(1);
  s.db.updateTask(t.id, { status: "running" }); abortOrphanedTasks(s.db);
  expect(s.db.getTask(t.id)).toMatchObject({ status: "idle", outcome: "unknown", cloudSession: ref, resumeAt: null });
  await s.tasks.shutdown(); s.db.close();
});

test("Teleport evidence is target-specific, normal-exit only and unique", async () => {
  const { TeleportOutput, teleportArgs, teleportFailure } = await import("./claude-cloud.ts");
  const id = ref.id, uuid = "11111111-1111-4111-8111-111111111111";
  const p = new TeleportOutput(id);
  for (const part of [`Teleport ${id}\n`, "Session resumed\n", "Resume this session with:\nclaude --resume ", uuid]) p.feed(part);
  expect(p.finish(0).localSessionId).toBe(uuid);
  const fragmented = new TeleportOutput(id);
  for (const c of `Teleport ${id}\nSession resumed\nclaude --resume ${uuid}\n`) fragmented.feed(c);
  expect(fragmented.finish(0).localSessionId).toBe(uuid);
  // CLI 2.1.296 in a PTY: words placed by cursor moves, no spaces (seen in the #1133 live check; text here is synthetic)
  const drawn = new TeleportOutput(id);
  drawn.feed(`\x1b[2G\u25d3\x1b[4GTeleporting\x1b[16Gsession\u2026 ${id}\r\n\x1b[2G\u25cf\x1b[4GSession\x1b[12Gresumed\r\n\x1b[1C\x1b[4A\x1b[?25hResume this session with:\r\nclaude --resume ${uuid}\r\n`);
  expect(drawn.finish(0).localSessionId).toBe(uuid);
  // a cursor move inside an ID is not a gap: the ID is not cut down to the target's, a second UUID is not hidden
  const cut = new TeleportOutput(id); cut.feed(`Teleport ${id}\x1b[1Cextra\nSession resumed\nclaude --resume ${uuid}\n`);
  expect(cut.finish(0).localSessionId).toBeNull();
  const second = new TeleportOutput(id); second.feed(`Teleport ${id}\nSession resumed\nclaude --resume ${uuid}\nclaude --resume 22222222-2222-4222-8222-\x1b[1C222222222222\n`);
  expect(second.finish(0).localSessionId).toBeNull();
  const spaced = new TeleportOutput(id); spaced.feed(`Teleport ${id}\nSession resumed\nclaude --resume ${uuid}\nclaude  --resume 22222222-2222-4222-8222-222222222222\n`);
  expect(spaced.finish(0).localSessionId).toBeNull();
  const wrong = new TeleportOutput("session_differentabcdefghijklmn"); wrong.feed(`Teleport ${id}\nSession resumed\nclaude --resume ${uuid}\n`);
  expect(wrong.finish(0).localSessionId).toBeNull();
  const missing = new TeleportOutput(id); missing.feed(`Teleport ${id}\nDirty/untracked approval\nSession resumed\n`);
  expect(missing.finish(0)).toMatchObject({ localSessionId: null, message: expect.stringContaining("未確認") });
  expect(p.finish(1).localSessionId).toBeNull();
  p.feed("\nclaude --resume 22222222-2222-4222-8222-222222222222\n");
  expect(p.finish(0).localSessionId).toBeNull();
  expect(teleportArgs("--teleport [session] Resume a cloud session", id)).toEqual(["--teleport", id]);
  expect(teleportArgs("--teleport Resume a cloud session", id)).toEqual(["--teleport"]);
  expect(() => teleportArgs("old help", id)).toThrow();
  expect(teleportFailure("repository mismatch")).toContain("リポジトリ");
  expect(teleportFailure("branch not pushed")).toContain("push");
  expect(teleportFailure("permission denied")).toContain("アクセス");
  expect(teleportFailure("account mismatch")).toContain("アカウント");
  expect(teleportFailure("API key not supported")).toContain("サブスクリプション");
});
