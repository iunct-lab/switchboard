import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personWait, type AgentEvent, type AskQuestion, type RunnerAdapter, type Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { StopReport } from "./stops.ts";
import { NO_GH, NO_HISTORY, item, j, startServer, waitFor } from "./api-test-harness.ts";
import { awaitingReply, pickNext, replyWaitingIn, stopHeld } from "./backlog-pick.ts";
import { withActive } from "./server/backlog-read.ts";

// The Task's own flow as the daemon runs it: a stop is recorded after a turn, then the person replies and the next turn
// ends on a question. The outcome the stop and the turn's end write is what decides the ask card and the Home split.
describe("a stop left by an earlier turn and a turn that ends on a question", () => {
  const QUESTION: AskQuestion = { header: null, question: "続けるか", options: [{ label: "A", description: null }, { label: "B", description: null }], multiSelect: false };
  const START: AgentEvent = { t: "session.start", runner: "claude", runnerSessionId: "sess-s", cwd: "/tmp" };
  const ENDS: AgentEvent = { t: "session.end", status: "ok", summary: "done" };
  const DEPENDS = StopReport.parse({ id: "wait-ci", op: "gh pr checks", target: "PR #12", reason: "depends", evidence: "CI 待ち", conditions: [{ key: "pr#12", value: "merged", met: false }] });

  /** A fake runner whose turns are scripted one by one: the first turn on start, each next one on a send (the last repeats). */
  const turned = (turns: AgentEvent[][]): RunnerAdapter => ({
    id: "claude",
    async detect() {
      return { available: true, version: "fake" };
    },
    start(_opts, emit) {
      let n = 0;
      let closed = false;
      const run = () => {
        if (closed) return;
        for (const ev of turns[Math.min(n++, turns.length - 1)]!) emit(ev);
      };
      queueMicrotask(run);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      return {
        send: (text) => {
          emit({ t: "message.delta", role: "user", text });
          queueMicrotask(run);
        },
        respondPermission: () => undefined,
        abort: async () => {
          closed = true;
          resolveExit(null);
        },
        close: async () => {
          closed = true;
          resolveExit(0);
        },
        exited,
      };
    },
  });

  const post = (b: string, path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: b, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

  /** A daemon with one Task whose first turn has ended, running the `turns` scripts. */
  const boot = async (turns: AgentEvent[][], stage?: Task["stage"]) => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-stale-stop-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [turned(turns)], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const meta = c.db.listWorkspaces().find((w) => w.kind === "meta")!;
    // a stage Task's row: no judge, so the first turn's reply is not being judged (a Task being judged is at work on its Issue)
    if (stage) c.db.setSetting("settings", { judge: { enabled: false } });
    const t = c.tasks.create(stage ? { workspaceId: meta.id, cwd: meta.path, title: "#939 実装: stale stop", prompt: "p", runner: "claude", stage } : { cwd: h, title: "stale stop", prompt: "p", runner: "claude" });
    await waitFor(async () => c.db.getTask(t.id)!.status === "done");
    const task = () => c.db.getTask(t.id) as Task;
    const checks = async () => ((await fetch(`${b}/api/asks`).then(j)) as { asks: Array<{ kind: string; task: { id: string } | null }> }).asks.filter((a) => a.task?.id === t.id && a.kind === "check");
    const stop = async () => {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    };
    // the Issue's backlog row as the daemon reads it: its last stage Task (`lastTask`, with the outcome the daemon wrote) and
    // `replyWaiting`, and the Task at work on it as the daemon counts it (`activeStageTask`). The PBI has an open Task, so the
    // queue would resume it when no one waits
    const row = () =>
      withActive({ db: c.db, activeStageTask: (ws, n) => c.db.activeStageTask(ws, n), mockupsOf: () => [] }, { items: [item({ number: 939, workspaceId: meta.id, stage: "in-progress", tasks: { total: 1, done: 0, doneAt: null } })] } as never).items[0]!;
    return { c, b, t, task, checks, row, stop };
  };

  // the reply that starts the next turn: the person's answers the stop; another Task's (`from`) leaves it open and unanswered
  test.each([
    ["the person", undefined, true],
    ["another Task", "task_sender", false],
  ] as const)("a depends stop after a turn only waits; the next turn that ends on a question needs the person, and its check shows (reply from %s)", async (_who, from, answered) => {
    const x = await boot([[START, ENDS], [START, { t: "question.ask", id: "q1", questions: [QUESTION] }, ENDS]]);
    try {
      expect(x.c.tasks.recordStop(x.t.id, DEPENDS).ok).toBe(true);
      expect(x.task().outcome).toBe("waits");
      expect(personWait(x.task())).toBe("waits");
      expect(await x.checks()).toEqual([]);

      expect((await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "続けて", ...(from ? { from } : {}) })).status).toBe(200);
      await waitFor(async () => x.task().outcome === "needs_action");
      await waitFor(async () => x.task().status === "done");
      expect(personWait(x.task())).toBe("needs");
      expect(await x.checks()).toHaveLength(1);
      // the stop is still on record, answered by the person's reply or still open and unanswered after another Task's; either
      // way it was recorded before the question and does not keep the Task off 要対応
      const records = x.c.db.listStopRecords([x.t.id]);
      expect(new Set(records.map((s) => s.id.split("/").pop()))).toEqual(new Set(["wait-ci"]));
      const latest = records.at(-1)!;
      expect(latest.answer != null).toBe(answered);
      if (!answered) expect(latest.state).toBe("waiting");
    } finally {
      await x.stop();
    }
  });

  test("a depends stop after a turn that ended on a question puts the Task back to waiting, and its check goes", async () => {
    const x = await boot([[START, { t: "question.ask", id: "q1", questions: [QUESTION] }, ENDS]]);
    try {
      expect(x.task().outcome).toBe("needs_action");
      expect(personWait(x.task())).toBe("needs");
      expect(await x.checks()).toHaveLength(1);

      expect(x.c.tasks.recordStop(x.t.id, DEPENDS).ok).toBe(true);
      expect(x.task().outcome).toBe("waits");
      expect(personWait(x.task())).toBe("waits");
      expect(await x.checks()).toEqual([]);
    } finally {
      await x.stop();
    }
  });

  const STAGE = { issue: 939, action: "complete" } as const;

  test("a stage Task: a depends stop, then a turn that ends on a question, is waiting for a reply on the backlog row and is not started again", async () => {
    const x = await boot([[START, ENDS], [START, { t: "question.ask", id: "q1", questions: [QUESTION] }, ENDS]], STAGE);
    try {
      // before any stop or question nothing waits and no Task is at work: the queue would start the stage again on this row
      expect(x.row().activeTaskId).toBeNull();
      expect(awaitingReply(x.row())).toBe(false);
      expect(pickNext([x.row()], "implement")?.item.number).toBe(939);
      expect(x.c.tasks.recordStop(x.t.id, DEPENDS).ok).toBe(true);
      expect(x.row()).toMatchObject({ replyWaiting: false, lastTask: { id: x.t.id, outcome: "waits" } });

      expect((await post(x.b, `/api/tasks/${x.t.id}/send`, { text: "続けて" })).status).toBe(200);
      await waitFor(async () => x.task().outcome === "needs_action");
      await waitFor(async () => x.task().status === "done");
      const row = x.row();
      expect(row).toMatchObject({ replyWaiting: true, lastTask: { id: x.t.id, outcome: "needs_action" } });
      expect(awaitingReply(row)).toBe(true);
      expect(pickNext([row], "implement")).toBeNull();
      expect(replyWaitingIn([row], "implement")).toEqual([row]);
      // the old stop's condition (PR 12 merged) still holds the row too; once it is met, the stop holds nothing and it is the
      // reply alone that keeps the queue from starting the stage again
      expect(stopHeld(row)).toBe(true);
      const met = { ...row, prereqs: [{ number: 12, kind: "pr" as const, need: "merged" as const, state: "met" as const, via: [], confirming: false }] };
      expect(stopHeld(met)).toBe(false);
      expect(pickNext([met], "implement")).toBeNull();
      expect(replyWaitingIn([met], "implement")).toEqual([met]);
    } finally {
      await x.stop();
    }
  });

  test("a stage Task: a depends stop after a turn that ended on a question is not waiting for a reply on the backlog row", async () => {
    const x = await boot([[START, { t: "question.ask", id: "q1", questions: [QUESTION] }, ENDS]], STAGE);
    try {
      expect(x.row()).toMatchObject({ replyWaiting: true, lastTask: { outcome: "needs_action" } });
      expect(x.c.tasks.recordStop(x.t.id, DEPENDS).ok).toBe(true);
      const row = x.row();
      expect(row).toMatchObject({ replyWaiting: false, lastTask: { id: x.t.id, outcome: "waits" } });
      expect(awaitingReply(row)).toBe(false);
      expect(replyWaitingIn([row], "implement")).toEqual([]);
    } finally {
      await x.stop();
    }
  });
});
