import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskAnswerResult, AskList, Backlog, RunnerAdapter, Task } from "@switchboard/protocol";
import { importing } from "../fixtures/github-import.ts";
import { ASK_HISTORY_MS } from "./asks.ts";
import type { GhRunner } from "./backlog.ts";
import { loadConfig } from "./config.ts";
import type { judgeTurn } from "./judge.ts";
import { startServer, type CoreServer } from "./server.ts";

/* What a restart of the daemon keeps (#1139): the same SWITCHBOARD_HOME opened by a second startServer, as asks-answer.test.ts boots one. */

const pages = (await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json()) as unknown[];
const decisions = (await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json()) as unknown;
const gh: GhRunner = async (args) => {
  if (args[0] === "repo") return { code: 0, stdout: "acme/app\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};
/** No runner to start on: the stage Task is not created, the answer's start fails. */
const broken: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: false }),
  start: () => ({ send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) }),
};

/** A runner whose Task ends its first turn with "done" and then waits (a later send starts a turn that never ends). */
const finishing: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true, version: "fake" }),
  start: (_o, emit) => {
    queueMicrotask(() => {
      emit({ t: "message.delta", role: "user", text: "依頼文" });
      emit({ t: "message.delta", role: "assistant", text: "done" });
      emit({ t: "session.end", status: "ok", summary: "done" });
    });
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};
const hang: typeof judgeTurn = () => new Promise(() => undefined);

let core: CoreServer | null = null;
let adapter: RunnerAdapter = broken;
let judge: typeof judgeTurn = hang;
let home = "";
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(home, { recursive: true, force: true });
  home = "";
  adapter = broken;
  judge = hang;
});

/** Starts the daemon on `home` (a new directory the first time) and waits for the backlog to be read. */
async function boot(): Promise<string> {
  if (!home) home = mkdtempSync(join(tmpdir(), "sb-server-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(gh), backlogAutoImport: true, judge: (i, o) => judge(i, o), rubricJudge: () => new Promise(() => undefined) });
  const base = `http://127.0.0.1:${core.server.port}`;
  for (let n = 0; n < 400; n++) {
    const b = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
    if (b.syncs.length && !b.syncs.some((s) => s.syncing)) break;
    await Bun.sleep(10);
  }
  return base;
}
const restart = async (): Promise<string> => {
  await core!.stop();
  return boot();
};
const decisionOf306 = async (base: string) => ((await (await fetch(`${base}/api/asks`)).json()) as AskList).asks.find((a) => a.kind === "decision" && a.pbi?.number === 306)!;
const answer = (base: string, id: string, a: unknown) => fetch(`${base}/api/asks/answer`, { method: "POST", body: JSON.stringify({ id, answer: a }) });
const comments = () => core!.db.listPendingBacklogOperations().filter((o) => o.kind === "comment").length;

describe("daemon restart (#1139)", () => {
  test("再起動: a start that failed after an answer is still failed, with the same reason", async () => {
    const base = await boot();
    const ask = await decisionOf306(base);
    const body = (await (await answer(base, ask.id, { kind: "text", text: "B で" })).json()) as AskAnswerResult;
    expect(body.ask!.resume).toMatchObject({ state: "failed", reason: "ランナーが検出されていません" });
    const after = await decisionOf306(await restart());
    expect(after).toMatchObject({ state: "answered", resume: { state: "failed", reason: "ランナーが検出されていません" } });
  });

  test("再起動: an answer sent again after the restart says already and writes nothing more", async () => {
    const base = await boot();
    const ask = await decisionOf306(base);
    expect(((await (await answer(base, ask.id, { kind: "choice", choice: "B: ファイル — 影響: 移行が要らない" })).json()) as AskAnswerResult).already).toBe(false);
    const written = comments();
    const again = await answer(await restart(), ask.id, { kind: "choice", choice: "B: ファイル — 影響: 移行が要らない" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as AskAnswerResult).already).toBe(true);
    expect(comments()).toBe(written);
  });

  test("再起動: an answer older than a day is forgotten when the next answer comes", async () => {
    const base = await boot();
    const old = { at: Date.now() - ASK_HISTORY_MS - 1000 };
    core!.db.rememberAskAnswer("old", { ...old, failure: { ...old, reason: "x" } });
    core!.db.rememberAskAnswer("new", { at: Date.now(), failure: { at: Date.now(), reason: "y" } });
    await answer(base, "nothing", { kind: "text", text: "x" });
    expect(core!.db.askAnswer("old")).toBeNull();
    expect(core!.db.askAnswer("new")).not.toBeNull();
  });
});

describe("judgement across a restart (#1139)", () => {
  const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const until = async (ok: () => boolean) => {
    for (let n = 0; n < 400 && !ok(); n++) await Bun.sleep(10);
    expect(ok()).toBe(true);
  };
  const create = async (base: string): Promise<Task> => (await (await post(base, "/api/tasks", { cwd: home, title: "judged", prompt: "依頼文", runner: "claude" })).json()) as Task;

  test("再起動 判定: a judgement cut short by the restart is made again once, and the mark goes", async () => {
    adapter = finishing;
    const base = await boot();
    const t = await create(base);
    await until(() => core!.db.getTask(t.id)?.judgingAt != null);
    expect(core!.db.getTask(t.id)).toMatchObject({ status: "done", outcome: "unknown", judgedResult: null });
    const calls: string[] = [];
    judge = async (input) => (calls.push(input.lastReply), { result: "needs_action", reason: "選択を求めている", runner: "codex", model: "m" });
    await restart();
    await until(() => core!.db.getTask(t.id)?.judgedResult === "needs_action");
    expect(calls).toEqual(["done"]);
    expect(core!.db.getTask(t.id)).toMatchObject({ outcome: "needs_action", judgingAt: null });
    // a third start finds nothing left to judge
    await restart();
    await Bun.sleep(100);
    expect(calls).toHaveLength(1);
  });

  test("再起動 判定: a Task whose next turn started is not judged again", async () => {
    adapter = finishing;
    const base = await boot();
    const t = await create(base);
    await until(() => core!.db.getTask(t.id)?.judgingAt != null);
    expect((await post(base, `/api/tasks/${t.id}/send`, { text: "もう一度" })).status).toBe(200);
    expect(core!.db.getTask(t.id)).toMatchObject({ status: "running", judgingAt: null });
    const calls: string[] = [];
    judge = async (input) => (calls.push(input.lastReply), { result: "done", reason: "x", runner: "codex", model: "m" });
    await restart();
    await Bun.sleep(100);
    expect(calls).toEqual([]);
    expect(core!.db.getTask(t.id)).toMatchObject({ judgedResult: null, judgingAt: null });
  });
});
