// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { recordingText, skipRecordings, assertRecordings } from "../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, utimesSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";
import { TaskSummary } from "@switchboard/protocol";
import { loadConfig, teleportWorktreePath } from "./config.ts";
import { claudeProjectDirName } from "@switchboard/adapter-claude";
import { HistoryImporter } from "./history.ts";
import { SCRIPT, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("history import: Claude Code sessions run in a terminal, from ~/.claude/projects", () => {
  const FIXTURE = recordingText("packages/adapters/claude/fixtures/terminal-session.jsonl");
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);
  const cliUser = (cwd: string, sessionId: string, text: string, ts: string) =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid: crypto.randomUUID(), timestamp: ts, permissionMode: "auto", effort: null, origin: { kind: "human" }, promptSource: "typed", userType: "external", entrypoint: "cli", cwd, sessionId, version: "2.1.263", gitBranch: "main" });
  const cliAssistant = (cwd: string, sessionId: string, id: string, text: string, ts: string) =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { model: "claude-fable-5-1", id, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }, uuid: crypto.randomUUID(), timestamp: ts, userType: "external", entrypoint: "cli", cwd, sessionId, version: "2.1.263", gitBranch: "main" });
  /** A workspace directory and the Claude projects folder Claude Code would use for it. */
  const setup = (tag: string) => {
    const h = mkdtempSync(join(tmpdir(), `switchboard-${tag}-`));
    const repo = join(h, "repo");
    mkdirSync(repo);
    const projects = join(h, "projects");
    const pdir = join(projects, claudeProjectDirName(repo));
    mkdirSync(pdir, { recursive: true });
    return { h, repo, projects, pdir };
  };
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/teleport-session.jsonl"))("history Teleport links exact normal log, reuses owner, rejects mismatches and resumes Local after exit", async () => {
    assertRecordings("packages/adapters/claude/fixtures/teleport-session.jsonl");
    const { h, repo, projects, pdir } = setup("teleport-history");
    for (const a of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]]) Bun.spawnSync(["git", ...a], { cwd: repo });
    const starts: StartOptions[] = [];
    const cloudId = "session_0123456789abcdefghijklmn";
    const bin = join(h, "fake-teleport"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume"\n', { mode: 0o755 });
    const cloudAdapter = fakeAdapter([{ t: "cloud.session.created", id: cloudId, url: `https://claude.ai/code/${cloudId}` }], { starts, detect: () => ({ path: bin }) });
    const localStarts: StartOptions[] = [];
    const localAdapter = fakeAdapter([{ t: "session.end", status: "ok" }], { starts: localStarts });
    const adapter = { ...cloudAdapter, start: (o: StartOptions, emit: Parameters<RunnerAdapter["start"]>[1]) => o.executionMode === "cloud" ? cloudAdapter.start(o, emit) : localAdapter.start(o, emit) };
    let data!: (s: string) => void, exit!: (e: { exitCode: number }) => void, spawns = 0;
    const fakePty = { pid: 99999999, onData: (f: typeof data) => { data = f; }, onExit: (f: typeof exit) => { exit = f; }, write: () => {}, resize: () => {}, kill: () => {} };
    const { PtyManager } = await import("./pty.ts");
    const pty = (await PtyManager.load(async () => ({ spawn: (() => { spawns++; return fakePty; }) as any })))!; spawns = 0;
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_CLAUDE_PROJECTS: projects, SWITCHBOARD_HISTORY_POLL_MS: "0" }), [adapter], { port: 0, loadPty: async () => pty });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const ws = c.db.upsertWorkspace({ name: "repo", path: repo, kind: "repo" });
      // Register through an alias, as on macOS /var → /private/var.
      const alias = join(h, "alias"); symlinkSync(repo, alias);
      const cloud = c.tasks.create({ runner: "claude", workspaceId: ws.id, cwd: alias, title: "Cloud", prompt: "Cloud", executionMode: "cloud" });
      await waitFor(async () => !c.tasks.isLive(cloud.id));
      const file = join(pdir, `${SESSION}.jsonl`);
      const fixture = recordingText("packages/adapters/claude/fixtures/teleport-session.jsonl").replaceAll("/work/repo", realpathSync(repo));
      writeFileSync(file, fixture);
      c.history.scan(); // normal importer wins the race; the same owner must be reused
      const owner = c.db.listTasksBySession("claude", SESSION)[0]!;
      const before = c.db.listEvents(owner.id).length, tokens = c.db.taskCost(owner.id).tokens;
      const local = await c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd);
      expect(local.id).toBe(owner.id); expect(local.sourceCloudTaskId).toBe(cloud.id);
      c.history.scan(); await c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd);
      expect(c.db.listTasksBySession("claude", SESSION)).toHaveLength(1);
      expect(c.db.listEvents(local.id).length).toBe(before + 1); // normal exit flushes exactly one pending end
      const after = c.db.listEvents(local.id).length;
      expect(c.db.taskCost(local.id).tokens).toBe(tokens);
      const again = new HistoryImporter(c.db, { projectsDir: projects, pollMs: 0 }); again.scan(); await again.importTeleportedSession(cloud.id, SESSION, cloud.cwd);
      expect(c.db.listEvents(local.id)).toHaveLength(after);
      const detail = await fetch(`${b}/api/tasks/${cloud.id}`).then(j);
      expect(detail.localContinuations.map((t: Task) => t.id)).toEqual([local.id]);
      expect((await fetch(`${b}/api/tasks/${local.id}`).then(j)).sourceCloudTask.cloudSession.id).toBe(cloudId);
      const freshId = "33333333-3333-4333-8333-333333333333";
      writeFileSync(join(pdir, `${freshId}.jsonl`), fixture.replaceAll(SESSION, freshId));
      const fresh = await c.history.importTeleportedSession(cloud.id, freshId, cloud.cwd);
      expect(fresh.sourceCloudTaskId).toBe(cloud.id); expect(fresh.runnerSessionId).toBe(freshId);
      expect(c.db.listEvents(fresh.id).filter(e => e.ev.t === "message.delta").map(e => e.ev)).toEqual(c.db.listEvents(local.id).filter(e => e.ev.t === "message.delta").map(e => e.ev));
      const other = c.tasks.create({ runner: "claude", workspaceId: ws.id, cwd: repo, title: "other", prompt: "other", executionMode: "cloud" });
      await waitFor(async () => !c.tasks.isLive(other.id));
      await expect(c.history.importTeleportedSession(other.id, SESSION, other.cwd)).rejects.toThrow("所有者");
      await expect(c.history.importTeleportedSession(cloud.id, "../wrong", cloud.cwd)).rejects.toThrow();
      writeFileSync(file, fixture.replaceAll(SESSION, "22222222-2222-4222-8222-222222222222"));
      await expect(c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd)).rejects.toThrow("セッションID");
      writeFileSync(file, fixture.replaceAll(realpathSync(repo), "/other/repo"));
      await expect(c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd)).rejects.toThrow("cwd/Workspace"); writeFileSync(file, fixture);
      // A continuation in a worktree under the same Workspace: the log's cwd is the worktree, and the caller names it.
      const wt = teleportWorktreePath(realpathSync(repo), cloud.id); Bun.spawnSync(["git", "worktree", "add", "--detach", wt, "HEAD"], { cwd: repo });
      const wtId = "55555555-5555-4555-8555-555555555555";
      writeFileSync(join(pdir, `${wtId}.jsonl`), fixture.replaceAll(SESSION, wtId).replaceAll(realpathSync(repo), realpathSync(wt)));
      await expect(c.history.importTeleportedSession(cloud.id, wtId, cloud.cwd)).rejects.toThrow("cwd/Workspace");
      await expect(c.history.importTeleportedSession(cloud.id, wtId, "/other/repo")).rejects.toThrow("cwd/Workspace");
      const inWt = await c.history.importTeleportedSession(cloud.id, wtId, wt);
      expect(realpathSync(inWt.cwd)).toBe(realpathSync(wt)); expect(inWt.workspaceId).toBe(ws.id); expect(inWt.sourceCloudTaskId).toBe(cloud.id);
      const post = () => fetch(`${b}/api/tasks/${cloud.id}/teleport`, { method: "POST" });
      const progress = async () => (await fetch(`${b}/api/tasks/${cloud.id}`).then(j)).teleport as { phase: string; message?: string; localTaskId?: string } | null;
      // The screen's socket: what task.teleport tells it, in order.
      const phases: string[] = [];
      const feed = new WebSocket(`ws://127.0.0.1:${c.server.port}/ws`);
      feed.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.type === "task.teleport" && m.taskId === cloud.id) phases.push(m.progress.phase); };
      await new Promise<void>((res, rej) => { feed.onopen = () => res(); feed.onerror = () => rej(new Error("socket")); });
      expect(await progress()).toBeNull();
      const actualId = "44444444-4444-4444-8444-444444444444";
      writeFileSync(join(pdir, `${actualId}.jsonl`), fixture.replaceAll(SESSION, actualId).replaceAll(realpathSync(repo), realpathSync(wt))); // the continuation runs in the worktree
      expect((await post()).status).toBe(202); // no terminal socket is opened
      await waitFor(async () => spawns === 1);
      expect((await post()).status).toBe(409); expect(spawns).toBe(1);
      const blocked = await fetch(`${b}/api/tasks/${inWt.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "next" }) }); // a Task in the continuation worktree is held; one in the clone is not
      expect(blocked.status).toBe(409); expect((await blocked.json() as any).error).toContain("Teleport"); expect(localStarts).toHaveLength(0);
      data(`${cloudId}\nSession resumed\n`); // quiet after resumed: the daemon ends the CLI itself
      await waitFor(async () => (await progress())?.phase === "exiting");
      data(`claude --resume ${actualId}\n`); exit({ exitCode: 0 });
      await waitFor(async () => c.db.listLocalTasksForCloud(cloud.id).some(t => t.runnerSessionId === actualId));
      const actual = c.db.listTasksBySession("claude", actualId)[0]!;
      await waitFor(async () => (await progress())?.phase === "done");
      expect(await progress()).toMatchObject({ phase: "done", localTaskId: actual.id });
      expect(phases).toEqual(["teleporting", "exiting", "importing", "done"]);
      expect(c.db.listEvents(cloud.id).at(-1)!.ev).toMatchObject({ t: "status", text: expect.stringContaining("Local Taskへの取込みを確認") });
      await c.tasks.send(actual.id, "next"); expect(localStarts[0]).toMatchObject({ resumeSessionId: actualId }); expect(localStarts[0]!.executionMode).not.toBe("cloud");
      await waitFor(async () => !c.tasks.isLive(actual.id));
      expect((await post()).status).toBe(202); await waitFor(async () => spawns === 2);
      const links = c.db.listLocalTasksForCloud(cloud.id).length;
      data("Cancelled\n"); exit({ exitCode: 1 });
      expect(c.db.listLocalTasksForCloud(cloud.id)).toHaveLength(links);
      expect(c.db.listEvents(cloud.id).at(-1)!.ev).toMatchObject({ t: "status", text: expect.stringContaining("取り消されました") });
      await waitFor(async () => (await progress())?.phase === "unconfirmed");
      await c.tasks.send(actual.id, "after cancel"); expect(localStarts).toHaveLength(2);
      await waitFor(async () => !c.tasks.isLive(actual.id));
      expect((await post()).status).toBe(202); await waitFor(async () => spawns === 3);
      data(`${cloudId}\nSession resumed\nclaude --resume 77777777-7777-4777-8777-777777777777\n`); exit({ exitCode: 0 });
      await waitFor(async () => (await progress())?.message?.includes("Local履歴は未確認") === true);
      expect(await progress()).toMatchObject({ phase: "unconfirmed" });
      expect(c.db.listEvents(cloud.id).at(-1)!.ev).toMatchObject({ t: "status", text: expect.stringContaining("Local履歴は未確認") });
      expect(c.db.listLocalTasksForCloud(cloud.id)).toHaveLength(links);
      await c.tasks.send(actual.id, "after missing log"); expect(localStarts).toHaveLength(3);
      expect(c.db.getTask(cloud.id)).toMatchObject({ cloudSession: { id: cloudId }, runnerSessionId: null, executionMode: "cloud" });

    } finally { await c.stop(); rmSync(h, { recursive: true, force: true }); }
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("history Teleport large logs yield and refuse mutation during validation", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("teleport-large");
    const cloudId = "session_0123456789abcdefghijklmn";
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_CLAUDE_PROJECTS: projects, SWITCHBOARD_HISTORY_POLL_MS: "0" }), [fakeAdapter([{ t: "cloud.session.created", id: cloudId, url: `https://claude.ai/code/${cloudId}` }])], { port: 0 });
    try {
      const ws = c.db.upsertWorkspace({ name: "repo", path: repo, kind: "repo" });
      const cloud = c.tasks.create({ runner: "claude", workspaceId: ws.id, cwd: repo, title: "Cloud", prompt: "Cloud", executionMode: "cloud" });
      await waitFor(async () => !c.tasks.isLive(cloud.id));
      const id = "88888888-8888-4888-8888-888888888888", changedId = "99999999-9999-4999-8999-999999999999";
      const padding = JSON.stringify({ type: "file-history-snapshot", sessionId: id, pad: "x".repeat(1024 * 1024) }) + "\n";
      const contents = FIXTURE.replaceAll("/work/repo", realpathSync(repo)).replaceAll(SESSION, id) + padding.repeat(18);
      const file = join(pdir, `${id}.jsonl`); writeFileSync(file, contents);
      let yielded = false; setTimeout(() => { yielded = true; }, 0);
      const local = await c.history.importTeleportedSession(cloud.id, id, cloud.cwd);
      expect(yielded).toBe(true); expect(local.sourceCloudTaskId).toBe(cloud.id);
      expect(c.history.forTask(local.id)!.offset).toBe(Bun.file(file).size);
      const changed = join(pdir, `${changedId}.jsonl`); writeFileSync(changed, contents.replaceAll(id, changedId));
      setTimeout(() => appendFileSync(changed, JSON.stringify({ type: "file-history-snapshot", sessionId: changedId }) + "\n"), 0);
      await expect(c.history.importTeleportedSession(cloud.id, changedId, cloud.cwd)).rejects.toThrow("変更");
      expect(c.db.listLocalTasksForCloud(cloud.id).map(t => t.id)).toEqual([local.id]);
    } finally { await c.stop(); rmSync(h, { recursive: true, force: true }); }
  });

  /** Make the file look untouched for a minute: a trailing end_turn is only taken as the end of the turn once the file is quiet. */
  const age = (file: string) => {
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
  };
  const daemon = (h: string, projects: string, adapter = fakeAdapter(SCRIPT)) => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: projects, SWITCHBOARD_HISTORY_POLL_MS: "0" }), [adapter], { port: 0, selfdevChecks: false });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("a terminal session under a workspace becomes a done task (origin terminal) with the log's own timestamps and priced ledger rows; passes are incremental and idempotent", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("hist");
    const text = FIXTURE.replaceAll("/work/repo", repo);
    const file = join(pdir, `${SESSION}.jsonl`);
    writeFileSync(file, text);
    age(file);
    const c = await daemon(h, projects);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      // the repo is not a workspace yet: seen, not imported
      expect(c.history.scan()).toMatchObject({ files: 1, created: 0, appended: 0, skippedForeign: 1, skippedOtherHost: 0, errors: [] });
      expect(await fetch(`${b}/api/tasks`).then(j)).toEqual([]);
      const ws = await post(`${b}/api/workspaces`, { path: repo });
      const r = await post(`${b}/api/history/import`);
      expect(r).toMatchObject({ files: 1, created: 1, appended: 0, skippedForeign: 0, errors: [] });
      const tasks = await fetch(`${b}/api/tasks`).then(j);
      expect(tasks).toHaveLength(1);
      const t = (await fetch(`${b}/api/tasks/${tasks[0].id}`).then(j)).task;
      expect(t).toMatchObject({ origin: "terminal", runner: "claude", status: "done", runnerSessionId: SESSION, title: "リポジトリ構成の説明", model: "claude-fable-5-1", permissionMode: "acceptEdits", workspaceId: ws.id, cwd: repo, scope: [repo], routing: null, budgetUsd: null });
      expect(t.createdAt).toBe(Date.parse("2026-09-06T12:52:26.186Z")); // first record of the log, not the import time
      expect(t.updatedAt).toBe(Date.parse("2026-09-06T13:10:05.000Z"));
      expect(t.statusAt).toBe(t.updatedAt); // imported as done: done since the log's last record, not since it began
      expect(t).toMatchObject({ outcome: "unknown", reviewedAt: t.updatedAt }); // watched in the terminal: reviewed
      const d = await fetch(`${b}/api/tasks/${t.id}`).then(j);
      expect(d.events).toHaveLength(22);
      expect(d.events[0].ev.t).toBe("session.start");
      expect(d.events[0].ts).toBe(Date.parse("2026-09-06T12:52:26.200Z"));
      expect(d.events.at(-1).ev).toMatchObject({ t: "session.end", status: "ok" }); // the file was quiet: the trailing end_turn closed the turn
      expect(d.history).toMatchObject({ sessionId: SESSION, taskId: t.id, origin: "terminal", path: file, offset: Buffer.byteLength(text) });
      // usage per assistant message → priced from pricing.json; Claude is a subscription runner → billed 0
      expect(d.cost.costUsd).toBeGreaterThan(0);
      const rows = c.db.sqlite.query("SELECT source, billed_usd AS billed, model FROM ledger WHERE task_id = ? ORDER BY ts").all(t.id) as Array<{ source: string; billed: number; model: string }>;
      expect(rows).toHaveLength(5);
      expect(rows.every((x) => x.source === "priced" && x.billed === 0 && x.model === "claude-fable-5-1")).toBe(true);
      expect(c.db.ledgerTasks(36500)[0]).toMatchObject({ taskId: t.id, origin: "terminal", runner: "claude" });
      // nothing new → nothing happens
      expect(c.history.scan()).toMatchObject({ files: 1, created: 0, appended: 0 });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(22);
      // the terminal keeps going: a typed prompt and an end_turn answer land in the file
      appendFileSync(file, `${cliUser(repo, SESSION, "続きを", "2026-09-06T13:20:00.000Z")}\n${cliAssistant(repo, SESSION, "msg_F", "はい", "2026-09-06T13:20:05.000Z")}\n`);
      expect(c.history.scan()).toMatchObject({ created: 0, appended: 1 });
      let ev = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events;
      expect(ev).toHaveLength(25); // user, assistant, usage — the end waits until the file is quiet (more blocks may follow)
      expect(ev.at(-3).ev).toMatchObject({ t: "message.delta", role: "user", text: "続きを" });
      expect(ev.at(-3).ts).toBe(Date.parse("2026-09-06T13:20:00.000Z"));
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.updatedAt).toBe(Date.parse("2026-09-06T13:20:05.000Z"));
      age(file);
      expect(c.history.scan()).toMatchObject({ created: 0, appended: 1 });
      ev = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events;
      expect(ev).toHaveLength(26);
      expect(ev.at(-1).ev).toMatchObject({ t: "session.end", status: "ok" });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.reviewedAt).toBe(t.reviewedAt); // a continued terminal turn stays reviewed
      expect(c.history.scan()).toMatchObject({ appended: 0 }); // …and only once
      const st = await fetch(`${b}/api/history`).then(j);
      expect(st).toMatchObject({ dir: projects, enabled: true, pollMs: 0 });
      expect(st.sessions).toHaveLength(1);
      expect(st.sessions[0]).toMatchObject({ sessionId: SESSION, taskId: t.id, origin: "terminal" });
      expect(st.lastScanAt).toBeGreaterThan(0);
      expect(st.lastResult.files).toBe(1);
      expect(st.sessions[0].pathDisplay).toBe(file.startsWith(homedir()) ? `~${file.slice(homedir().length)}` : file);
      // a daemon restart: a second importer on the same database re-reads nothing (offset + parser state persisted)
      const again = new HistoryImporter(c.db, { projectsDir: projects, pollMs: 0 });
      expect(again.scan()).toMatchObject({ files: 1, created: 0, appended: 0, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(26);
      // …in the middle of a message: the thinking record of an end_turn message lands, the daemon restarts (a fresh
      // importer restores offset + parser state), then the text record lands → one usage, one end, in order
      const half = (block: unknown) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { model: "claude-fable-5-1", id: "msg_G", type: "message", role: "assistant", content: [block], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }, uuid: crypto.randomUUID(), timestamp: "2026-09-06T13:25:00.000Z", userType: "external", entrypoint: "cli", cwd: repo, sessionId: SESSION, version: "2.1.263", gitBranch: "main" });
      appendFileSync(file, `${half({ type: "thinking", thinking: "" })}\n`);
      expect(c.history.scan()).toMatchObject({ appended: 1 }); // usage only; the end waits (file not quiet)
      appendFileSync(file, `${half({ type: "text", text: "split" })}\n`);
      const third = new HistoryImporter(c.db, { projectsDir: projects, pollMs: 0 });
      expect(third.scan()).toMatchObject({ appended: 1, errors: [] });
      age(file);
      expect(third.scan()).toMatchObject({ appended: 1, errors: [] });
      const evG = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.slice(26).map((e: { ev: AgentEvent }) => e.ev);
      expect(evG.map((e: AgentEvent) => e.t)).toEqual(["usage", "message.delta", "session.end"]); // not usage twice, not end twice
      // a state this build cannot read: reported, the file goes on from its offset (no second session.start), the row is rewritten readable
      c.db.upsertHistoryImport({ ...c.db.getHistoryImport(SESSION)!, state: "{corrupt" });
      appendFileSync(file, `${cliUser(repo, SESSION, "after corrupt state", "2026-09-06T13:26:00.000Z")}\n`);
      const corrupt = c.history.scan();
      expect(corrupt.errors[0]).toMatch(/unreadable/);
      expect(corrupt.appended).toBe(1);
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.slice(29).map((e: { ev: AgentEvent }) => e.ev.t)).toEqual(["message.delta"]);
      expect(c.history.scan()).toMatchObject({ appended: 0, errors: [] });
      // a partial last line (still being written) waits; the newline completes it
      appendFileSync(file, cliUser(repo, SESSION, "途中", "2026-09-06T13:30:00.000Z").slice(0, 40));
      expect(c.history.scan()).toMatchObject({ appended: 0, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(30);
      const size = Buffer.byteLength(readFileSync(file, "utf8"));
      truncateSync(file, size - 40);
      appendFileSync(file, `${cliUser(repo, SESSION, "途中", "2026-09-06T13:30:00.000Z")}\n`);
      expect(c.history.scan()).toMatchObject({ appended: 1, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(31);
      // a file that shrank is reported and continued from its new end, never re-read (that would duplicate events)
      truncateSync(file, 100);
      const shrunk = c.history.scan();
      expect(shrunk.errors[0]).toMatch(/shrank/);
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(31);
      appendFileSync(file, `\n${cliUser(repo, SESSION, "また", "2026-09-06T13:40:00.000Z")}\n`);
      expect(c.history.scan()).toMatchObject({ appended: 1, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.at(-1).ev).toMatchObject({ t: "message.delta", text: "また" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("no task for a session written only by an SDK host, for a cwd outside every workspace, or for a task whose process is live; a Switchboard task gets its later terminal turns appended", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("hist2");
    const script: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-live", cwd: repo }, { t: "message.delta", role: "assistant", text: "hi" }, { t: "session.end", status: "ok" }];
    const c = await daemon(h, projects, fakeAdapter(script, { lingers: true }));
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      await post(`${b}/api/workspaces`, { path: repo });
      await new Promise((r) => setTimeout(r, 20)); // let the boot pass (next tick) run over the still-empty folder first
      // (a) only sdk-cli records (+ the title): another host's session, or ours before its task recorded the session id
      const sdkOnly = FIXTURE.split("\n").filter((l) => l && (JSON.parse(l).entrypoint === "sdk-cli" || JSON.parse(l).type === "ai-title")).join("\n") + "\n";
      writeFileSync(join(pdir, "22222222-2222-4222-8222-222222222222.jsonl"), sdkOnly.replaceAll("/work/repo", repo).replaceAll(SESSION, "22222222-2222-4222-8222-222222222222"));
      // (b) a terminal session in a directory that is no workspace
      const other = join(h, "elsewhere");
      mkdirSync(other);
      mkdirSync(join(projects, claudeProjectDirName(other)), { recursive: true });
      writeFileSync(join(projects, claudeProjectDirName(other), "44444444-4444-4444-8444-444444444444.jsonl"), FIXTURE.replaceAll("/work/repo", other).replaceAll(SESSION, "44444444-4444-4444-8444-444444444444"));
      // (c) a task Switchboard ran (origin switchboard) whose session the person later continued in a terminal
      const mine = c.db.insertTask({ id: "task_mine", workspaceId: null, title: "mine", runner: "claude", cwd: repo, scope: [repo], status: "done", runnerSessionId: "33333333-3333-4333-8333-333333333333", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 });
      const fileC = join(pdir, "33333333-3333-4333-8333-333333333333.jsonl");
      writeFileSync(fileC, FIXTURE.replaceAll("/work/repo", repo).replaceAll(SESSION, "33333333-3333-4333-8333-333333333333"));
      age(fileC);
      // (d) a task whose runner process is alive right now (lingering after its turn): its file is not touched
      const live = await post(`${b}/api/tasks`, { cwd: repo, title: "live", prompt: "p", runner: "claude" });
      for (let i = 0; i < 50 && (await fetch(`${b}/api/tasks/${live.id}`).then(j)).task.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
      expect(c.tasks.isLive(live.id)).toBe(true);
      writeFileSync(join(pdir, "sess-live.jsonl"), FIXTURE.replaceAll("/work/repo", repo).replaceAll(SESSION, "sess-live"));

      const r = c.history.scan();
      expect(r).toMatchObject({ files: 4, created: 0, appended: 1, skippedForeign: 1, skippedOtherHost: 1, errors: [] });
      expect(c.history.scan()).toMatchObject({ skippedOtherHost: 0, skippedForeign: 1 }); // the sdk-only file is not re-read until it grows
      const tasks = (await fetch(`${b}/api/tasks`).then(j)) as TaskSummary[];
      expect(tasks.map((t) => t.id).sort()).toEqual([live.id, mine.id].sort()); // no new task
      const m = await fetch(`${b}/api/tasks/${mine.id}`).then(j);
      expect(m.task).toMatchObject({ origin: "switchboard", title: "mine", permissionMode: "auto" }); // the log does not rename or re-mode a Switchboard task
      expect(m.task.updatedAt).toBe(Date.parse("2026-09-06T13:10:05.000Z")); // …but its clock follows the appended turns
      expect(m.events).toHaveLength(22);
      expect(m.history).toMatchObject({ sessionId: "33333333-3333-4333-8333-333333333333", origin: "switchboard", path: fileC });
      const l = await fetch(`${b}/api/tasks/${live.id}`).then(j);
      expect(l.events).toHaveLength(script.length); // untouched
      expect(l.history).toBeNull();
      expect((await fetch(`${b}/api/history`).then(j)).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["33333333-3333-4333-8333-333333333333"]);
      // once the process is released, the same pass picks the file up
      await c.tasks.release(live.id);
      expect(c.history.scan()).toMatchObject({ created: 0, appended: 1, skippedOtherHost: 0, skippedForeign: 1 });
      expect((await fetch(`${b}/api/tasks/${live.id}`).then(j)).events.length).toBeGreaterThan(script.length);
      // the workspace arrives later: the foreign session comes in on the next pass
      await post(`${b}/api/workspaces`, { path: other });
      expect(c.history.scan()).toMatchObject({ created: 1, skippedForeign: 0 });
      const imported = ((await fetch(`${b}/api/tasks`).then(j)) as TaskSummary[]).find((t) => t.origin === "terminal")!;
      expect((await fetch(`${b}/api/tasks/${imported.id}`).then(j)).task).toMatchObject({ cwd: other, runnerSessionId: "44444444-4444-4444-8444-444444444444" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("cwd is matched resolved (Claude Code logs the physical path); a danger mode is not carried over; a terminal turn that just finished goes in before a reply from here", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("hist3");
    const real = realpathSync(repo); // on macOS the temp dir is /var/… → /private/var/…
    const script: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: SESSION, cwd: repo }, { t: "message.delta", role: "assistant", text: "resumed" }, { t: "session.end", status: "ok" }];
    const starts: StartOptions[] = [];
    const c = await daemon(h, projects, fakeAdapter(script, { starts, modes: ["auto", "bypass"], dangerModes: ["bypass"], defaultMode: "auto" }));
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      await post(`${b}/api/workspaces`, { path: repo }); // registered as typed (the symlinked form)
      const file = join(pdir, `${SESSION}.jsonl`);
      writeFileSync(file, FIXTURE.replaceAll("/work/repo", real).replaceAll('"permissionMode":"acceptEdits"', '"permissionMode":"bypass"'));
      age(file);
      expect(c.history.scan()).toMatchObject({ created: 1, skippedForeign: 0, errors: [] });
      const listedId = ((await fetch(`${b}/api/tasks`).then(j)) as TaskSummary[])[0]!.id;
      const t = (await fetch(`${b}/api/tasks/${listedId}`).then(j)).task as Task;
      expect(t).toMatchObject({ origin: "terminal", cwd: real, permissionMode: null }); // bypass is not inherited; the last `permission-mode` was acceptEdits → also replaced
      // the person types one more turn in the terminal and gets an answer (end_turn, file still "hot"), then replies
      // from Switchboard before the next pass: the terminal turn — and its end — go in before the reply
      appendFileSync(file, `${cliUser(real, SESSION, "terminal の最後の一言", "2026-09-06T14:00:00.000Z")}\n${cliAssistant(real, SESSION, "msg_H", "了解", "2026-09-06T14:00:05.000Z")}\n`);
      const sent = await post(`${b}/api/tasks/${t.id}/send`, { text: "from switchboard" });
      expect(sent.status).toBe("running");
      for (let i = 0; i < 50 && (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
      const ev = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.map((e: { ev: AgentEvent }) => e.ev);
      const iTerminal = ev.findIndex((e: AgentEvent) => e.t === "message.delta" && e.text === "terminal の最後の一言");
      const iReply = ev.findIndex((e: AgentEvent) => e.t === "message.delta" && e.text === "resumed"); // the resumed turn's answer (the fake runner echoes no prompt)
      expect(iTerminal).toBeGreaterThan(0);
      expect(iReply).toBeGreaterThan(iTerminal);
      expect(ev.slice(iTerminal, iReply).map((e: AgentEvent) => e.t)).toEqual(["message.delta", "message.delta", "usage", "session.end", "session.start"]); // the terminal turn closed before the reply's turn
      expect(starts[0]).toMatchObject({ resumeSessionId: SESSION, permissionMode: "auto" }); // resumed with the resolved default, not bypass
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("a session file of another machine's Task is not imported into it", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("hist-other");
    const c = await daemon(h, projects, fakeAdapter([{ t: "session.end", status: "ok" }]));
    try {
      const ws = c.db.upsertWorkspace({ name: "repo", path: repo, kind: "repo" });
      const t = c.tasks.create({ runner: "claude", workspaceId: ws.id, cwd: repo, title: "taken in", prompt: "go" });
      await waitFor(async () => c.db.getTask(t.id)!.status === "done");
      c.db.sqlite.query("UPDATE tasks SET machine = 'pc1', runner_session_id = ? WHERE id = ?").run(SESSION, t.id);
      const file = join(pdir, `${SESSION}.jsonl`);
      writeFileSync(file, FIXTURE.replaceAll("/work/repo", repo));
      age(file);
      const events = () => c.db.listEvents(t.id).length;
      const before = events(), tasks = c.db.listTasks().length;
      const first = c.history.scan();
      expect(first).toMatchObject({ files: 1, created: 0, appended: 0 });
      expect(first.errors).toEqual([`${SESSION}.jsonl: session of a Task of pc1; not imported`]);
      expect(events()).toBe(before);
      expect(c.db.listTasks()).toHaveLength(tasks);
      expect(c.db.getHistoryImport(SESSION)).toBeNull();
      // the file growing does not change it
      appendFileSync(file, `${cliUser(repo, SESSION, "もう一言", "2026-09-06T14:00:00.000Z")}\n`);
      c.history.scan();
      expect(events()).toBe(before);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
