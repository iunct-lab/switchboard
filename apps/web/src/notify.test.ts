import { expect, test } from "bun:test";
import type { AgentEvent, PendingApproval, ServerMessage, Task, TaskOutcome, TaskStatus } from "@switchboard/protocol";
import { applyApprovalEvent } from "./approvals.ts";
import { type NotificationCtor, noticeFor, notifyPermission, showNotice } from "./notify.ts";

const task = (id: string, status: TaskStatus, outcome: TaskOutcome, reviewedAt: number | null = null, updatedAt = 1): Task => ({ id, workspaceId: null, title: `title of ${id}`, runner: "claude", cwd: "/w", scope: ["/w"], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome, reviewedAt, judgedResult: null, judgedReason: "secret judged reason", judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 0, createdAt: 0, updatedAt });
const ev = (taskId: string, e: AgentEvent, ts = 1): ServerMessage => ({ type: "event", env: { taskId, seq: ts, ts, ev: e } });
const ask = (id: string): AgentEvent => ({ t: "permission.ask", id, kind: "write", tool: "Write", input: { file_path: "src/secret-input.ts" }, detail: "write src/secret-detail.ts" });
const resolved = (id: string): AgentEvent => ({ t: "permission.resolved", id, decision: "allow", by: "user" });
const updated = (t: Task): ServerMessage => ({ type: "task.updated", task: t });

/** A fake Notification constructor that records what was shown. */
function fakeNotification(permission: NotificationPermission, throws = false) {
  const shown: { title: string; options?: NotificationOptions; closed: boolean; onclick: ((e: Event) => void) | null }[] = [];
  const N = class {
    static permission: NotificationPermission = permission;
    static async requestPermission(): Promise<NotificationPermission> {
      return N.permission;
    }
    onclick: ((e: Event) => void) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      if (throws) throw new TypeError("Illegal constructor");
      const rec = { title, options, closed: false, onclick: null as ((e: Event) => void) | null };
      shown.push(rec);
      // the record reads the handler the caller sets after construction
      Object.defineProperty(this, "onclick", { get: () => rec.onclick, set: (f) => (rec.onclick = f) });
      this.close = () => (rec.closed = true);
    }
    close() {}
  };
  return { N: N as unknown as NotificationCtor & { permission: NotificationPermission }, shown };
}

test("(a) an ask notifies once; a redelivery and an ask after its permission.resolved stay quiet; other events are null", () => {
  const seen = new Set<string>();
  const tasks = [task("t1", "waiting", "unknown")];
  const n = noticeFor(ev("t1", ask("p1")), tasks, seen);
  expect(n).toEqual({ key: "t1\u0000ask\u0000p1", taskId: "t1", title: "title of t1", body: "ツール承認待ち: Write" });
  expect(noticeFor(ev("t1", ask("p1")), tasks, seen)).toBeNull();
  expect(noticeFor(ev("t1", resolved("p2")), tasks, seen)).toBeNull();
  expect(noticeFor(ev("t1", ask("p2")), tasks, seen)).toBeNull();
  expect(noticeFor(ev("t1", { t: "message.delta", role: "assistant", text: "x" }), tasks, seen)).toBeNull();
  expect(noticeFor(ev("t1", { t: "session.end", status: "ok" }), tasks, seen)).toBeNull();
  // an unknown task shows its id as the title
  expect(noticeFor(ev("t9", ask("p1")), tasks, seen)?.title).toBe("t9");
});

test("(b) task.updated notifies when the outcome turns needs_action, not reviewed and not waiting", () => {
  const seen = new Set<string>();
  const before = [task("t1", "done", "unknown")];
  const n = noticeFor(updated(task("t1", "done", "needs_action", null, 5)), before, seen);
  expect(n).toEqual({ key: "t1\u0000needs_action", taskId: "t1", title: "title of t1", body: "要対応: 回答を待っています" });
  // already needs_action before this message
  expect(noticeFor(updated(task("t1", "done", "needs_action", null, 6)), [task("t1", "done", "needs_action")], seen)).toBeNull();
  // the same update delivered twice before the list caught up
  expect(noticeFor(updated(task("t1", "done", "needs_action", null, 5)), before, seen)).toBeNull();
  expect(noticeFor(updated(task("t2", "done", "needs_action", 3, 5)), [task("t2", "done", "unknown")], seen)).toBeNull();
  expect(noticeFor(updated(task("t3", "waiting", "needs_action", null, 5)), [task("t3", "running", "unknown")], seen)).toBeNull();
  expect(noticeFor(updated(task("t4", "done", "done", null, 5)), [task("t4", "running", "unknown")], seen)).toBeNull();
  // a hand-set outcome keeps updatedAt: done → needs_action → done → needs_action notifies twice
  expect(noticeFor(updated(task("t1", "done", "done", null, 5)), [task("t1", "done", "needs_action")], seen)).toBeNull();
  expect(noticeFor(updated(task("t1", "done", "needs_action", null, 5)), [task("t1", "done", "done")], seen)?.taskId).toBe("t1");
});

test("(c) the notice carries neither the ask's detail / input nor the judged reason", () => {
  const notices = [noticeFor(ev("t1", ask("p1")), [task("t1", "waiting", "unknown")], new Set()), noticeFor(updated(task("t1", "done", "needs_action", null, 2)), [task("t1", "done", "unknown")], new Set())];
  for (const n of notices) {
    const text = JSON.stringify(n);
    for (const s of ["secret-input", "secret-detail", "secret judged reason"]) expect(text).not.toContain(s);
  }
});

test("(d) denied or revoked permission shows nothing, while the approvals list still holds the ask", () => {
  const n = noticeFor(ev("t1", ask("p1")), [], new Set())!;
  const denied = fakeNotification("denied");
  expect(showNotice(n, denied.N, () => {})).toBe(false);
  expect(denied.shown).toHaveLength(0);

  const revoked = fakeNotification("granted");
  expect(showNotice(n, revoked.N, () => {})).toBe(true);
  revoked.N.permission = "denied";
  const n2 = noticeFor(ev("t1", ask("p2")), [], new Set())!;
  expect(showNotice(n2, revoked.N, () => {})).toBe(false);
  expect(revoked.shown).toHaveLength(1);

  let list: PendingApproval[] = [];
  list = applyApprovalEvent(list, { taskId: "t1", seq: 1, ts: 1, ev: ask("p2") });
  expect(list.map((a) => [a.taskId, a.id])).toEqual([["t1", "p2"]]);

  expect(notifyPermission(undefined)).toBe("unsupported");
  expect(notifyPermission(denied.N)).toBe("denied");
  expect(showNotice(n, undefined, () => {})).toBe(false);
});

test("(e) clicking the notification opens the task and closes it", () => {
  const f = fakeNotification("granted");
  const opened: string[] = [];
  const n = noticeFor(ev("t1", ask("p1")), [], new Set())!;
  expect(showNotice(n, f.N, (id) => opened.push(id))).toBe(true);
  expect(f.shown[0]!.title).toBe("t1");
  expect(f.shown[0]!.options).toEqual({ body: "ツール承認待ち: Write", tag: n.key });
  f.shown[0]!.onclick!(new Event("click"));
  expect(opened).toEqual(["t1"]);
  expect(f.shown[0]!.closed).toBe(true);
});

test("(f) a constructor that throws (Android Chrome) returns false", () => {
  const f = fakeNotification("granted", true);
  expect(showNotice(noticeFor(ev("t1", ask("p1")), [], new Set())!, f.N, () => {})).toBe(false);
});
