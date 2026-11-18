import type { McpServerConfig, Task } from "@switchboard/protocol";
import { LOOPBACK_HOSTNAMES } from "../auth.ts";
import { mcpServersFor, WorkspaceMcp } from "../mcp.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { cleanupContainers } from "../containers.ts";
import { stopTaskProcesses } from "../detached.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checksEnabledByDefault, SelfDev } from "../selfdev.ts";
import { Staging } from "../staging.ts";
import { privateTmpOf } from "../tasks/sessions.ts";

// what a Task's Claude reads instead of the user-wide MCP servers: mcp.yaml `servers`, for its Workspace
export const taskMcpServers = (sc: Pick<ServerContext, "mcpPolicy" | "db">, t: Task) => mcpServersFor(sc.mcpPolicy, t.workspaceId ? (sc.db.getWorkspace(t.workspaceId)?.name ?? null) : null);

// What a Task's runner is started with: Claude gets mcp.yaml's servers; an AG-UI agent set to receive it gets the Task's own
// Workspace MCP endpoint and nothing else (not mcp.yaml's servers: those can hold other credentials). A `custom:` runner
// never falls back to mcp.yaml's servers; ADK and the rest get none. With passkey login a non-local agent gets none either,
// even when it was saved before passkey login was turned on: a Task's token counts only from loopback there.
export const startMcpServers = (sc: Pick<ServerContext, "taskMcpServers" | "bootCustomRunners" | "cfg" | "mcp">, t: Task): Record<string, McpServerConfig> | undefined => {
  if (!t.runner.startsWith("custom:")) return sc.taskMcpServers(t);
  const custom = sc.bootCustomRunners.get(t.runner);
  if (custom?.port !== "agui" || !custom.sendWorkspaceMcp) return undefined;
  if (sc.cfg.sessionPublicKey && !LOOPBACK_HOSTNAMES.has(new URL(custom.url).hostname)) return undefined;
  const ep = sc.mcp.issue(t.id);
  return { workspace: { type: "http", url: ep.url, headers: { authorization: `Bearer ${ep.token}` } } };
};

// a Task on a workspace whose backlog is kept here only: the kit's `backlog` picks it by id, not by a GitHub repository
export const localBacklogEnv = (sc: Pick<ServerContext, "db">, id: string): Record<string, string> => {
  const wsId = sc.db.getTask(id)?.workspaceId;
  return wsId && sc.db.getWorkspace(wsId)?.backlog === "switchboard" ? { BACKLOG_WORKSPACE: wsId } : {};
};

export function setupWorkspaceMcp(sc: Pick<ServerContextInit, "staging" | "db" | "tasks" | "mcp" | "mcpPolicy" | "publicUrl" | "deviceAuths" | "pty" | "cfg" | "dockerLogDir" | "checksOn" | "opts" | "selfdev" | "broadcast">): void {
  sc.staging = new Staging(sc.db, (id, ev) => sc.tasks.record(id, ev));
  sc.mcp = new WorkspaceMcp({ getTask: (id) => sc.db.getTask(id), record: (id, ev) => sc.tasks.record(id, ev), recordStop: (id, r) => sc.tasks.recordStop(id, r), stopOf: (id, r) => sc.tasks.stopOf(id, r), askPermission: (id, ask) => sc.tasks.askPermission(id, ask), staging: sc.staging }, sc.mcpPolicy, sc.publicUrl);
  // The endpoint lives as long as the task's runner process: a follow-up on a "done" task reuses it; abort/error/release end it.
  sc.tasks.onTaskEnd((taskId, task) => {
    void sc.mcp.revoke(taskId);
    sc.deviceAuths.clear(taskId);
    sc.pty?.close(taskId);
    // What the task detached (setsid / nohup) with the daemon's mark in its environment; a task with a
    // resume planned keeps it, as at the start
    if (task.resumeAt !== null) return;
    // (a `done` task may be resumed with its files: those are swept at the start, sweepPrivateTmps)
    try {
      if (task.status !== "done") rmSync(privateTmpOf(join(sc.cfg.home, "tmp"), taskId), { recursive: true, force: true });
    } catch {
      // what cannot be removed stays; the cleanup below goes on
    }
    // its compose projects and labelled containers, unless another task still open started the same project
    void cleanupContainers(taskId, { logDir: sc.dockerLogDir, isOpen: (id) => sc.tasks.isLive(id) || ((t) => t !== null && !["done", "error", "aborted"].includes(t.status))(sc.db.getTask(id)) }).then((r) => {
      if (r) sc.tasks.record(taskId, { t: "status", text: "skipped" in r ? `コンテナの片付けを飛ばしました（${r.skipped}）` : `コンテナを片付けました（プロジェクト ${r.projects.length} 件、コンテナ ${r.containers} 件${r.failed > 0 ? `、失敗 ${r.failed} 件` : ""}）` });
    }).catch(() => undefined);
    void stopTaskProcesses(taskId, { home: sc.cfg.home }).then((n) => {
      if (n > 0) sc.tasks.record(taskId, { t: "status", text: `切り離されたプロセスを ${n} 件止めました` });
    }).catch(() => undefined);
  });

  // Self-dev: after a turn on the meta workspace finishes successfully, run the repository's checks.
  // Off inside `bun test` and inside a check subprocess (no recursion) unless a test opts in explicitly.
  sc.checksOn = sc.opts.selfdevChecks ?? checksEnabledByDefault();
  sc.selfdev = new SelfDev(sc.db, sc.cfg.repoRoot, (taskId, run) => sc.broadcast({ type: "checks.updated", taskId, ok: run.ok }));
}
