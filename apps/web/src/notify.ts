import type { ServerMessage, TaskSummary, TerminalStatus } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";

/**
 * OS notifications for approval waits (#1138), shown only while the page is open (no Web Push).
 * Notices come only from /ws messages, never from a GET /api/approvals refetch, so a reconnect does not notify again.
 */

/** One OS notification. Title and tool name only: no detail / input / prompt / judgedReason. */
export type Notice = { key: string; taskId: string; title: string; body: string };

/**
 * The notice a /ws message calls for, or null. A permission.ask notifies once per (task, ask id); its
 * permission.resolved marks the ask seen, so a late redelivery stays quiet. A task.updated notifies when the outcome
 * turns needs_action on a task not reviewed yet and not waiting (a waiting task's ask already notified).
 * A task.updated into a disk wait (#2234) notifies once per wait; leaving it re-arms.
 * A task.terminal waiting (Claude Code in the terminal tab, #1574) notifies once per wait; a task.deviceAuth with a code
 * (#2046) once per code. task.terminals (what is, sent
 * after hello; noticesFor) notifies only a wait that came while away from a status this page knew: not after a reload,
 * and not the same wait again on a reconnect.
 * `tasks` is the list before this message is applied; `seen` is kept across messages and grows here.
 */
export function noticeFor(m: ServerMessage, tasks: TaskSummary[], seen: Set<string>): Notice | null {
  if (m.type === "event") {
    const { taskId, ev } = m.env;
    if (ev.t !== "permission.ask" && ev.t !== "permission.resolved") return null;
    const key = `${taskId}\u0000ask\u0000${ev.id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (ev.t === "permission.resolved") return null;
    return { key, taskId, title: tasks.find((x) => x.id === taskId)?.title ?? taskId, body: t(home.noticeToolApproval, { tool: ev.tool }) };
  }
  if (m.type === "task.updated") {
    const task = m.task;
    const prev = tasks.find((x) => x.id === task.id);
    const diskKey = `${task.id}\u0000disk`;
    if (task.resumeReason !== "disk") seen.delete(diskKey);
    else if (!seen.has(diskKey)) {
      seen.add(diskKey);
      if (prev?.resumeReason !== "disk") return { key: diskKey, taskId: task.id, title: task.title, body: t(home.noticeDiskFull) };
    }
    // One notice per turn into needs_action: leaving it re-arms (a hand-set outcome keeps updatedAt, so no timestamp)
    const key = `${task.id}\u0000needs_action`;
    if (task.outcome !== "needs_action") seen.delete(key);
    if (prev?.outcome === "needs_action" || task.outcome !== "needs_action" || task.reviewedAt !== null || task.status === "waiting") return null;
    if (seen.has(key)) return null;
    seen.add(key);
    return { key, taskId: task.id, title: task.title, body: t(home.noticeNeedsAnswer) };
  }
  if (m.type === "task.terminal") return terminalNotice(m.taskId, m.status, true, tasks, seen);
  // a device code to approve (#2046): once per code, like an approval wait
  if (m.type === "task.deviceAuth" && m.auth) {
    const key = `${m.taskId}\u0000deviceAuth\u0000${m.auth.expiresAt}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { key, taskId: m.taskId, title: tasks.find((x) => x.id === m.taskId)?.title ?? m.taskId, body: t(home.noticeSso) };
  }
  return null;
}

/** noticeFor, and task.terminals: what is after hello, with a notice for each Task it calls for (see noticeFor). */
export function noticesFor(m: ServerMessage, tasks: TaskSummary[], seen: Set<string>): Notice[] {
  if (m.type !== "task.terminals") {
    const n = noticeFor(m, tasks, seen);
    return n ? [n] : [];
  }
  // a Task left out has no Claude Code in its terminal now: forget it, as its null would have
  for (const k of [...seen]) {
    const [taskId, kind] = k.split("\u0000");
    if (kind === "terminal" && !(taskId! in m.terminals)) seen.delete(k);
  }
  return Object.entries(m.terminals).flatMap(([taskId, status]) => terminalNotice(taskId, status, false, tasks, seen) ?? []);
}

/** `live`: a change now, not the state resent after hello. A null status (the shell ended) forgets the Task. */
function terminalNotice(taskId: string, status: TerminalStatus | null, live: boolean, tasks: TaskSummary[], seen: Set<string>): Notice | null {
  const key = `${taskId}\u0000terminal`, known = `${key}\u0000known`;
  if (status !== "waiting") {
    seen.delete(key);
    if (status === null) seen.delete(known);
    else seen.add(known);
    return null;
  }
  if (seen.has(key)) return null;
  seen.add(key);
  if (!live && !seen.has(known)) return null;
  return { key, taskId, title: tasks.find((x) => x.id === taskId)?.title ?? taskId, body: t(home.noticeTerminal) };
}

/** The part of the browser's Notification API used here; injected so tests can pass a fake. */
export type NotificationCtor = {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): { onclick: ((e: Event) => void) | null; close(): void };
};

export type NotifyPermission = "unsupported" | NotificationPermission;

export function notifyPermission(N: NotificationCtor | undefined): NotifyPermission {
  return N === undefined ? "unsupported" : N.permission;
}

/**
 * Shows the notice when the browser allows it; clicking opens the task. False when not allowed (denied, revoked,
 * unsupported) or when the constructor throws (Android Chrome only notifies through a Service Worker) — the approvals
 * list and badge still show the wait.
 */
export function showNotice(n: Notice, N: NotificationCtor | undefined, onOpen: (taskId: string) => void): boolean {
  if (notifyPermission(N) !== "granted") return false;
  try {
    const shown = new N!(n.title, { body: n.body, tag: n.key });
    shown.onclick = () => {
      onOpen(n.taskId);
      shown.close();
    };
    return true;
  } catch {
    return false;
  }
}
