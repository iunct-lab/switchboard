import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Workspace } from "@switchboard/protocol";
import { localBacklogSource, type GhRunner } from "./backlog.ts";
import type { Db } from "./db.ts";

/** A GitHub repository name from `owner/name` or `https://github.com/owner/name` (`.git` and a trailing `/` allowed); anything else is null. */
export function parseGithubRepo(input: string): { owner: string; name: string } | null {
  const m = /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) return null;
  const [, owner, name] = m as unknown as [string, string, string];
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(name) || /^\.+$/.test(name) || name === ".git") return null;
  return { owner, name };
}

/** Registers a directory as a workspace. `switchboard` keeps its backlog here only (#2265): the source is set now and stored as an empty import. */
export function registerWorkspace(db: Db, input: { path: string; name: string; backlog: "github" | "switchboard"; had?: Workspace }): Workspace {
  let ws = db.upsertWorkspace({ path: input.path, name: input.name, kind: "repo" });
  if (input.backlog === "switchboard" && !input.had) {
    const source = localBacklogSource(ws.id);
    db.setWorkspaceBacklogSource(ws.id, source);
    db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: Date.now() });
    ws = db.getWorkspace(ws.id)!;
  }
  return ws;
}

export class CloneError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface WorkspaceClone {
  repo: string;
  path: string;
  state: "cloning" | "failed";
  error?: string;
  startedAt: number;
}

/** Clones of GitHub repositories next to the checkout, in memory only: a restart forgets them (#2575). */
export class WorkspaceClones {
  private readonly rows = new Map<string, WorkspaceClone>();

  constructor(private readonly db: Db, private readonly gh: GhRunner, private readonly repoRoot: string, private readonly onChange: () => void) {}

  list(): WorkspaceClone[] {
    return [...this.rows.values()];
  }

  /** Checks the target and that the caller can push, then clones in the background. Throws CloneError for what the request got wrong. */
  async start(repo: { owner: string; name: string }, opts: { backlog?: "github" | "switchboard" }): Promise<WorkspaceClone> {
    const full = `${repo.owner}/${repo.name}`;
    const cwd = dirname(this.repoRoot);
    const path = join(cwd, repo.name);
    if (existsSync(path) || this.rows.get(path)?.state === "cloning") throw new CloneError(`${path} は既にあります。上書きしません`, 409);
    // a workspace still registered at this path (its directory was deleted) keeps its backlog, as the path form says
    const had = this.db.listWorkspaces().find((w) => w.path === path);
    if (had && opts.backlog !== undefined && had.backlog !== opts.backlog) throw new CloneError(`この workspace のバックログは ${had.backlog} に置いています。切り替えは #2266 です`, 409);
    // reserved before the first await, so a second request for the same name is 409 and runs nothing
    const row: WorkspaceClone = { repo: full, path, state: "cloning", startedAt: Date.now() };
    this.rows.set(path, row);
    this.onChange();
    const perm = await this.gh(["api", `repos/${full}`, "--jq", ".permissions.push"], cwd);
    if (perm.code !== 0 || perm.stdout.trim() !== "true") {
      this.rows.delete(path);
      this.onChange();
      if (perm.code !== 0) throw new CloneError(`見つからないか読めません: ${perm.stderr.trim().split("\n").pop() ?? ""}`, 404);
      throw new CloneError("他者のリポジトリはこの欄では追加しません（#2576）", 403);
    }
    const started = { ...row };
    void this.run(row, repo, cwd, opts);
    return started;
  }

  private async run(row: WorkspaceClone, repo: { name: string }, cwd: string, opts: { backlog?: "github" | "switchboard" }): Promise<void> {
    try {
      const r = await this.gh(["repo", "clone", row.repo, row.path], cwd);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `gh repo clone が ${r.code} で終わりました`);
      registerWorkspace(this.db, { path: row.path, name: repo.name, backlog: opts.backlog ?? "github", had: this.db.listWorkspaces().find((w) => w.path === row.path) });
      this.rows.delete(row.path);
    } catch (e) {
      row.state = "failed";
      row.error = (e as Error).message;
    }
    this.onChange();
  }
}
