/** Workspaces. */

import type { BacklogSource, Workspace, WorkspaceAllocation, WorkspaceSweep } from "@switchboard/protocol";
import { basename, dirname } from "node:path";
import { newId } from "./util.ts";
import { DbCore } from "./core.ts";

/** Workspaces. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class WorkspaceQueries extends DbCore {
  /* ---------- workspaces ---------- */

  listWorkspaces(): Workspace[] {
    return this.sqlite.query("SELECT * FROM workspaces ORDER BY kind DESC, name").all().map(rowToWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const r = this.sqlite.query("SELECT * FROM workspaces WHERE id = ?").get(id);
    return r ? rowToWorkspace(r) : null;
  }

  /** `backlog` is not stored as such: it is read from the workspace's backlog source (setWorkspaceBacklogSource). */
  upsertWorkspace(ws: Omit<Workspace, "id" | "createdAt" | "backlog" | "sweep" | "allocation" | "issueArtifacts"> & { id?: string }): Workspace {
    const existing = this.sqlite.query("SELECT * FROM workspaces WHERE path = ?").get(ws.path);
    if (existing) {
      this.sqlite.query("UPDATE workspaces SET name = ?, kind = ?, upstream = COALESCE(?, upstream) WHERE path = ?").run(ws.name, ws.kind, ws.upstream ?? null, ws.path);
      return rowToWorkspace(this.sqlite.query("SELECT * FROM workspaces WHERE path = ?").get(ws.path));
    }
    const row: Workspace = { id: ws.id ?? newId("ws"), name: ws.name, path: ws.path, kind: ws.kind, createdAt: Date.now(), backlog: "github", sweep: { implement: 1, plan: 1 }, allocation: { share: null, mode: "continuing" }, issueArtifacts: false, ...(ws.upstream ? { upstream: ws.upstream } : {}) };
    this.sqlite.query("INSERT INTO workspaces (id, name, path, kind, created_at, upstream) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.name, row.path, row.kind, row.createdAt, ws.upstream ?? null);
    return row;
  }

  /**
   * The one meta workspace, at `path`. One matters: the first meta row is the one read (`listWorkspaces`' order), and
   * one left at a removed release would hand every Task that release's hook path, which blocks all its Bash calls.
   * An install from a Release used to register each release directory as the meta workspace; it is now the link
   * `releases/current`. When `path` is that link, the meta rows at its sibling release directories (named by a full
   * commit id, as sb-rescue names them; gone or still kept:
   * the restart of a promotion comes before the old releases are removed) are that one workspace: the one read so far
   * moves to `path` with its id and settings, and their Tasks get `path` instead (cwd and scope, workspace) so they can
   * start, resume and fork again. The row already at `path` is kept when there is one; any other meta row (another
   * checkout) becomes a repo and keeps its Tasks.
   */
  seedMetaWorkspace(path: string, name: string): Workspace {
    const metas = this.sqlite.query("SELECT id, path FROM workspaces WHERE kind = 'meta' ORDER BY name").all() as { id: string; path: string }[];
    const at = this.sqlite.query("SELECT id FROM workspaces WHERE path = ?").get(path) as { id: string } | null;
    const releases = basename(path) === "current" ? metas.filter((m) => dirname(m.path) === dirname(path) && RELEASE_ID.test(basename(m.path))) : [];
    const inUse = metas.find((m) => m.path !== path);
    let id = "";
    this.sqlite.transaction(() => {
      if (at) {
        this.sqlite.query("UPDATE workspaces SET name = ?, kind = 'meta' WHERE id = ?").run(name, at.id);
        id = at.id;
      } else if (inUse && releases.some((m) => m.id === inUse.id)) {
        this.sqlite.query("UPDATE workspaces SET name = ?, path = ? WHERE id = ?").run(name, path, inUse.id);
        id = inUse.id;
      } else id = this.upsertWorkspace({ name, path, kind: "meta" }).id;
      this.sqlite.query("UPDATE workspaces SET kind = 'repo' WHERE kind = 'meta' AND id != ?").run(id);
      for (const r of releases) {
        this.movePathsOfTasks(r.path, path);
        this.sqlite.query("UPDATE tasks SET workspace_id = ? WHERE workspace_id = ?").run(id, r.id);
      }
    })();
    return this.getWorkspace(id)!;
  }

  /** Tasks' cwd and scope entries at `from` or under it are moved to `to` (at a path boundary). */
  private movePathsOfTasks(from: string, to: string): void {
    const map = (v: string) => (v === from || v.startsWith(`${from}/`) ? to + v.slice(from.length) : v);
    const rows = this.sqlite.query("SELECT id, cwd, scope FROM tasks WHERE instr(cwd, ?1) = 1 OR instr(scope, ?1) > 0").all(from) as { id: string; cwd: string; scope: string }[];
    for (const r of rows) {
      let scope = r.scope;
      try {
        const list = JSON.parse(r.scope) as unknown;
        if (Array.isArray(list)) scope = JSON.stringify(list.map((d) => (typeof d === "string" ? map(d) : d)));
      } catch {
        // a scope that is not a JSON list is left as it is
      }
      this.sqlite.query("UPDATE tasks SET cwd = ?, scope = ? WHERE id = ?").run(map(r.cwd), scope, r.id);
    }
  }

  /** The hash of the runner config the person confirmed for a foreign repository. */
  setRunnerConfigOk(id: string, hash: string): void {
    this.sqlite.query("UPDATE workspaces SET runner_config_ok = ? WHERE id = ?").run(hash, id);
  }

  getRunnerConfigOk(id: string): string | null {
    const r = this.sqlite.query("SELECT runner_config_ok FROM workspaces WHERE id = ?").get(id) as { runner_config_ok: string | null } | null;
    return r?.runner_config_ok ?? null;
  }

  /**
   * The repository variable the backlog reads the Project URL from; null = back to SWITCHBOARD_PROJECT_URL. The stored
   * backlog's source goes with it: the workspace reads as not imported until an import reads the new Project.
   * A workspace whose backlog is kept here only has no Project variable: the caller refuses it first.
   */
  setWorkspaceProjectVar(id: string, name: string | null): Workspace | null {
    this.sqlite.query("UPDATE workspaces SET project_var = ?, backlog_source = NULL WHERE id = ?").run(name, id);
    return this.getWorkspace(id);
  }

  /**
   * A change asked of the workspace's settings kept here (the shape of `ops.config.json` as JSON text, null = none): always
   * recorded with what the settings were. `confirmed` puts it in force at once (`workspaces.config`); `pending` leaves the
   * settings as they are until `decideConfigChange`. Either way an earlier pending request of the workspace is superseded:
   * one question at a time. There is no other writer of `workspaces.config`, so it only ever holds a confirmed value.
   */
  recordConfigChange(c: { workspaceId: string; at: number; source: string; after: string | null; keys: string[]; state: "pending" | "confirmed" }): WorkspaceConfigChange {
    return this.recordConfigChangeBy(c, () => ({ keys: c.keys, state: c.state }))!;
  }

  /**
   * `recordConfigChange` with what changes, and whether it is in force at once, decided inside the transaction that
   * records it: `decide` gets the settings as they are in force at that moment (and whether a request waits), never a
   * value read before the caller waited for something. Null from `decide` = nothing to record (null is returned).
   */
  recordConfigChangeBy(c: { workspaceId: string; at: number; source: string; after: string | null }, decide: (before: string | null, waiting: boolean) => { keys: string[]; state: "pending" | "confirmed" } | null): WorkspaceConfigChange | null {
    return this.sqlite.transaction(() => {
      const before = (this.sqlite.query("SELECT config FROM workspaces WHERE id = ?").get(c.workspaceId) as { config: string | null } | null)?.config ?? null;
      const waiting = this.sqlite.query("SELECT 1 FROM workspace_config_changes WHERE workspace_id = ? AND state = 'pending'").get(c.workspaceId) !== null;
      const d = decide(before, waiting);
      if (!d) return null;
      this.sqlite.query("UPDATE workspace_config_changes SET state = 'superseded', decided_at = ? WHERE workspace_id = ? AND state = 'pending'").run(c.at, c.workspaceId);
      const confirmed = d.state === "confirmed";
      const r = this.sqlite.query("INSERT INTO workspace_config_changes (workspace_id, at, source, before, after, keys, state, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
        .get(c.workspaceId, c.at, c.source, before, c.after, JSON.stringify(d.keys), d.state, confirmed ? c.at : null, confirmed ? c.source : null);
      if (confirmed) this.sqlite.query("UPDATE workspaces SET config = ? WHERE id = ?").run(c.after, c.workspaceId);
      return rowToConfigChange(r);
    })();
  }

  /**
   * The person's answer to a pending change: `confirmed` puts it in force, `rejected` leaves the settings. Null when it is
   * not pending any more, or — for a confirmation — when the settings are no longer the ones the change was asked against
   * (nothing is written: what the person saw is not what would go in force).
   */
  decideConfigChange(id: number, state: "confirmed" | "rejected", by: string, at: number, note: string | null = null): WorkspaceConfigChange | null {
    return this.sqlite.transaction(() => {
      const c = this.getConfigChange(id);
      if (!c || c.state !== "pending") return null;
      const now = (this.sqlite.query("SELECT config FROM workspaces WHERE id = ?").get(c.workspaceId) as { config: string | null } | null) ?? null;
      if (state === "confirmed" && (!now || (now.config ?? null) !== c.before)) return null;
      this.sqlite.query("UPDATE workspace_config_changes SET state = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?").run(state, at, by, note, id);
      if (state === "confirmed") this.sqlite.query("UPDATE workspaces SET config = ? WHERE id = ?").run(c.after, c.workspaceId);
      return this.getConfigChange(id);
    })();
  }

  getConfigChange(id: number): WorkspaceConfigChange | null {
    const r = this.sqlite.query("SELECT * FROM workspace_config_changes WHERE id = ?").get(id);
    return r ? rowToConfigChange(r) : null;
  }

  /** The changes waiting for the person, one per workspace at most, oldest first. */
  pendingConfigChanges(): WorkspaceConfigChange[] {
    return this.sqlite.query("SELECT * FROM workspace_config_changes WHERE state = 'pending' ORDER BY id").all().map(rowToConfigChange);
  }

  /** The changes the person answered since `since` (ms), oldest first. */
  decidedConfigChangesSince(since: number): WorkspaceConfigChange[] {
    return this.sqlite.query("SELECT * FROM workspace_config_changes WHERE state IN ('confirmed', 'rejected') AND decided_at >= ? ORDER BY id").all(since).map(rowToConfigChange);
  }

  /** A workspace's record of changes, newest first. */
  listConfigChanges(workspaceId: string, limit = 50): WorkspaceConfigChange[] {
    return this.sqlite.query("SELECT * FROM workspace_config_changes WHERE workspace_id = ? ORDER BY id DESC LIMIT ?").all(workspaceId, limit).map(rowToConfigChange);
  }

  /** The workspace's rules kept here (null = none); the repository is not touched. */
  setWorkspaceRules(id: string, rules: string | null): Workspace | null {
    this.sqlite.query("UPDATE workspaces SET rules = ? WHERE id = ?").run(rules, id);
    return this.getWorkspace(id);
  }

  /** backlog-next's slots of the workspace; a side not given stays as it is. */
  setWorkspaceSweep(id: string, patch: Partial<WorkspaceSweep>): Workspace | null {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const next = { ...ws.sweep, ...patch };
    this.sqlite.query("UPDATE workspaces SET sweep_implement = ?, sweep_plan = ? WHERE id = ?").run(next.implement, next.plan, id);
    return this.getWorkspace(id);
  }

  /** Whether closing a PBI attaches its work's reports to the Issue on GitHub (`Workspace.issueArtifacts`). */
  setWorkspaceIssueArtifacts(id: string, on: boolean): Workspace | null {
    this.sqlite.query("UPDATE workspaces SET issue_artifacts = ? WHERE id = ?").run(on ? 1 : 0, id);
    return this.getWorkspace(id);
  }

  /** The share of the weekly usage and the mode of the workspace; a side not given stays as it is. */
  setWorkspaceAllocation(id: string, patch: Partial<WorkspaceAllocation>): Workspace | null {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const next = { ...ws.allocation, ...patch };
    this.sqlite.query("UPDATE workspaces SET alloc_share = ?, alloc_mode = ? WHERE id = ?").run(next.share, next.mode, id);
    return this.getWorkspace(id);
  }

  /** The registration only: Tasks keep their `workspace_id` (their history stays readable). */
  deleteWorkspace(id: string): void {
    // a change still waiting for the person has nothing left to change: its record stays, closed
    this.sqlite.query("UPDATE workspace_config_changes SET state = 'superseded', decided_at = ? WHERE workspace_id = ? AND state = 'pending'").run(Date.now(), id);
    this.sqlite.query("DELETE FROM workspaces WHERE id = ?").run(id);
  }
}

/** One row of `workspace_config_changes` (schema.ts says what each state means). */
export interface WorkspaceConfigChange { id: number; workspaceId: string; at: number; source: string; before: string | null; after: string | null; keys: string[]; state: "pending" | "confirmed" | "rejected" | "superseded"; decidedAt: number | null; decidedBy: string | null; note: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToConfigChange(r: any): WorkspaceConfigChange {
  return { id: r.id, workspaceId: r.workspace_id, at: r.at, source: r.source, before: r.before ?? null, after: r.after ?? null, keys: JSON.parse(r.keys) as string[], state: r.state, decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null, note: r.note ?? null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToWorkspace(r: any): Workspace {
  // a workspace whose backlog is kept here only, or whose GitHub sync is off, says so in its source
  // (backlog-gh.ts syncsGithub); none, or a GitHub one = github
  const source = r.backlog_source ? (JSON.parse(r.backlog_source) as BacklogSource) : null;
  const backlog = source && (source.service === "switchboard" || source.disabled) ? "switchboard" : "github";
  return { id: r.id, name: r.name, path: r.path, kind: r.kind, createdAt: r.created_at, backlog, sweep: { implement: r.sweep_implement, plan: r.sweep_plan }, allocation: { share: r.alloc_share, mode: r.alloc_mode }, issueArtifacts: r.issue_artifacts === 1, ...(r.project_var ? { projectVar: r.project_var } : {}), ...(r.upstream ? { upstream: r.upstream } : {}), ...(r.rules ? { rules: r.rules } : {}), ...(r.config ? { config: r.config } : {}) };
}

/** The name sb-rescue gives a release directory: the full commit id. */
const RELEASE_ID = /^[0-9a-f]{40}$/;
