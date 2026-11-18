import { prepareTeleportWorktree } from "../claude-cloud.ts";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { TeleportProgress, TerminalStatus } from "@switchboard/protocol";
import { isWorking } from "../task-status.ts";
import type { ServerContext } from "./context.ts";

export const teleportCwd = (_sc: unknown, cwd: string) => { try { return realpathSync(cwd); } catch { return resolve(cwd); } };

export const setTeleport = (sc: Pick<ServerContext, "teleports" | "broadcast">, taskId: string, p: TeleportProgress) => {
  const was = sc.teleports.get(taskId);
  if (was && was.phase === p.phase && was.question === p.question && was.message === p.message) return; // the same state again (a start, then the CLI's own first report)
  sc.teleports.set(taskId, p); sc.broadcast({ type: "task.teleport", taskId, progress: p }); };

export const setTerminal = (sc: Pick<ServerContext, "terminals" | "broadcast">, taskId: string, status: TerminalStatus | null) => {
  if (status === null) sc.terminals.delete(taskId); else sc.terminals.set(taskId, status);
  sc.broadcast({ type: "task.terminal", taskId, status });
};

/** null = started; a string = why it was refused. */
export const startTeleport = (sc: Pick<ServerContext, "db" | "detected" | "pty" | "tasks" | "teleportCwd" | "teleportCwds" | "setTeleport" | "history">, taskId: string): string | null => {
  const task = sc.db.getTask(taskId);
  const bin = sc.detected.find(d => d.adapter.id === "claude")?.info.path;
  if (!sc.pty || !task || task.runner !== "claude" || task.executionMode !== "cloud" || !task.cloudSession || sc.tasks.isLive(task.id) || !existsSync(task.cwd) || !bin) {
    return "Cloudセッション・停止済みlauncher・cwd・Claude CLIを確認してください。";
  }
  // The continuation runs in its own worktree: reservation, release and the busy check are about that
  // directory only, so a Local Task at work in the clone is neither stopped nor refused.
  let work: string;
  try { work = prepareTeleportWorktree(task.cwd, task.id); } catch (e) { return String((e as Error).message ?? e); }
  const cwd = sc.teleportCwd(work);
  if (sc.teleportCwds.has(cwd)) return "同じcwdのTeleport Terminalが使用中です。終了後に開始してください。";
  // Only a turn in flight blocks: a finished Local Task's process idles for the next reply (idleMs) or is already
  // closing; Teleport starts once every one of them has exited. An archived one can still hold its process.
  const held = [...sc.db.listTasks(), ...sc.db.listTasks(true)].filter(t => t.executionMode === "local" && t.runner === "claude" && sc.teleportCwd(t.cwd) === cwd && sc.tasks.holdsProcess(t.id));
  const busy = held.find(t => isWorking(t, "gate"));
  if (busy) return `この Cloud Task の続きの Local Task「${busy.title.replace(/[\x00-\x1f\x7f]/g, " ")}」が作業中です。終わってから押してください。`;
  const cloudId = task.cloudSession.id;
  sc.teleportCwds.add(cwd); // reserved first: beforeResume refuses replies to the held Tasks while they are released
  sc.tasks.record(task.id, { t: "status", text: `作業コピー ${work} で続けます。元の clone は変更しません。` });
  sc.setTeleport(task.id, { phase: "teleporting" });
  sc.pty.prepareTeleport(task.id);
  void Promise.all(held.map(t => sc.tasks.releaseAndWait(t.id))).then(() => sc.pty!.startTeleport(task.id, work, bin, cloudId, async result => {
    sc.setTeleport(task.id, { phase: "importing" });
    try {
      if (result.localSessionId) {
        const local = await sc.history.importTeleportedSession(task.id, result.localSessionId, work);
        result.message = "Local Taskへの取込みを確認しました。Cloudへ自動同期しません。";
        sc.tasks.record(task.id, { t: "status", text: result.message });
        sc.setTeleport(task.id, { phase: "done", message: result.message, localTaskId: local.id });
      } else {
        sc.tasks.record(task.id, { t: "status", text: result.message });
        sc.setTeleport(task.id, { phase: "unconfirmed", message: result.message });
      }
    } catch {
      const message = "Local履歴は未確認です。元Cloud Taskを保持しました。公式TerminalとGit状態を確認してください。自動再試行はしません。";
      result.message = message;
      sc.tasks.record(task.id, { t: "status", text: message });
      sc.setTeleport(task.id, { phase: "unconfirmed", message });
    } finally { sc.teleportCwds.delete(cwd); }
  }, p => sc.setTeleport(task.id, p))).catch(e => {
    sc.teleportCwds.delete(cwd);
    sc.setTeleport(task.id, { phase: "unconfirmed", message: String((e as Error).message ?? e) });
  });
  return null;
};
