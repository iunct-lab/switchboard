import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AgentEvent, RunnerAdapter, RunnerId, RunnerSession } from "../packages/protocol/src/index.ts";
import { Db } from "../packages/core/src/db.ts";
import { parseArgs, runTrial, trialInputs } from "./judge-trial.ts";

const dir = mkdtempSync(join(tmpdir(), "switchboard-judge-trial-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A database with two finished tasks: one that reported, one that asked (its last turn is the one that counts). */
function fixtureDb(): string {
  const path = join(dir, "switchboard.db");
  const db = new Db(path);
  const task = (id: string, title: string) => db.insertTask({ id, workspaceId: null, title, runner: "claude", cwd: dir, scope: [dir], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 });
  task("task_done", "README の誤字 | 直す");
  task("task_ask", "設定の置き場所");
  task("task_quiet", "返答なし");
  const ev = (id: string, e: AgentEvent) => db.appendEvent(id, e);
  ev("task_done", { t: "message.delta", role: "user", text: "README の誤字を直して" });
  ev("task_done", { t: "session.end", status: "ok", summary: "直しました" });
  ev("task_ask", { t: "message.delta", role: "user", text: "設定をどこに置くか考えて" });
  ev("task_ask", { t: "session.end", status: "ok", summary: "最初の案" });
  ev("task_ask", { t: "message.delta", role: "user", text: "もう少し" });
  ev("task_ask", { t: "session.end", status: "ok", summary: "A と B のどちらにしますか" });
  ev("task_quiet", { t: "message.delta", role: "user", text: "p" });
  ev("task_quiet", { t: "session.end", status: "ok", summary: "  " });
  db.close();
  return path;
}

const DB_PATH = fixtureDb();

/** Answers the judge from the reply in the prompt: a question mark-ish reply is needs_action. */
function judgeAdapter(id: RunnerId): RunnerAdapter {
  return {
    id,
    permissionModes: [{ value: id === "codex" ? "read-only" : "plan", label: "ro", description: "ro" }],
    async detect() {
      return { available: true };
    },
    start(opts, emit) {
      let exit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (exit = r));
      const asks = opts.prompt.includes("どちらにしますか");
      queueMicrotask(() => {
        emit({ t: "message.delta", role: "assistant", text: JSON.stringify({ result: asks ? "needs_action" : "done", reason: asks ? "選択を | 求めている" : "報告している" }) });
        emit({ t: "session.end", status: "ok" });
        exit(0);
      });
      const s: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => exit(0), close: async () => exit(0), exited };
      return s;
    },
  };
}

test("trialInputs reads the title, the first request and the last turn's reply, read-only; an unknown id is reported", () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    expect(trialInputs(db, ["task_ask", "task_done", "task_quiet", "task_none"])).toEqual([
      { id: "task_ask", title: "設定の置き場所", prompt: "設定をどこに置くか考えて", lastReply: "A と B のどちらにしますか" },
      { id: "task_done", title: "README の誤字 | 直す", prompt: "README の誤字を直して", lastReply: "直しました" },
      { id: "task_quiet", error: "the last turn has no reply" },
      { id: "task_none", error: "no such task" },
    ]);
  } finally {
    db.close();
  }
});

test("runTrial judges each task with the fake runners and prints one table row per task", async () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const table = await runTrial(db, ["task_done", "task_ask", "task_none"], { adapters: new Map([["codex", judgeAdapter("codex")]]), settings: { enabled: true, runner: "codex", model: "gpt-6-luna" }, cwd: dir });
    const lines = table.split("\n");
    expect(lines[0]).toBe("| task | title | 判定 | 理由 | 判定したランナー | 秒 |");
    expect(lines[2]).toMatch(/^\| task_done \| README の誤字 ／ 直す \| 完了 \| 報告している \| codex:gpt-6-luna \| \d+\.\d \|$/);
    expect(lines[3]).toMatch(/^\| task_ask \| 設定の置き場所 \| 要対応 \| 選択を ／ 求めている \| codex:gpt-6-luna \| \d+\.\d \|$/);
    expect(lines[4]).toBe("| task_none | — | 失敗 | no such task | — | — |");
  } finally {
    db.close();
  }
});

test("runTrial without the configured runner: Claude Haiku judges (the judge's own fallback)", async () => {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const table = await runTrial(db, ["task_done"], { adapters: new Map([["claude", judgeAdapter("claude")]]), settings: { enabled: true, runner: "codex", model: "gpt-6-luna" }, cwd: dir });
    expect(table.split("\n")[2]).toMatch(/^\| task_done \| .* \| 完了 \| 報告している \| claude:claude-haiku-4-5 \| /);
  } finally {
    db.close();
  }
});

test("parseArgs: the ids with or without --db, the default database, and nothing to judge", () => {
  expect(parseArgs(["task_a", "task_b"], "/home/u")).toEqual({ dbPath: "/home/u/.switchboard/switchboard.db", ids: ["task_a", "task_b"] });
  expect(parseArgs(["task_a", "--db", "/x.db", "task_b"], "/home/u")).toEqual({ dbPath: "/x.db", ids: ["task_a", "task_b"] });
  expect(parseArgs(["--db", "/x.db"], "/home/u")).toBeNull();
  expect(parseArgs(["task_a", "--db"], "/home/u")).toBeNull();
});
