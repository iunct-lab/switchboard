import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BacklogSource, Workspace } from "@switchboard/protocol";
import { localBacklogSource, type GhRunner } from "./backlog.ts";
import type { Db } from "./db.ts";

/**
 * A GitHub repository name from `owner/name`, `https://github.com/owner/name`, `git@github.com:owner/name` or
 * `ssh://git@github.com/owner/name` (`.git` and a trailing `/` allowed); anything else is null.
 */
export function parseGithubRepo(input: string): { owner: string; name: string } | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) return null;
  const [, owner, name] = m as unknown as [string, string, string];
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(name) || /^\.+$/.test(name) || name === ".git") return null;
  return { owner, name };
}

/**
 * Why a runner must not start in the checkout at `path` (#2799): its origin is not the workspace's registered GitHub
 * repository (`source`). null = it is, the workspace has no GitHub registration, or the folder has no origin (not a
 * git checkout, or one without an origin: nothing to push to). Reads git only (no network): an origin left at a
 * renamed repository's old name stops too, and the text says how to fix it.
 */
export function originMismatch(path: string, source: BacklogSource | null, originOf = gitOrigin): string | null {
  if (source?.service !== "github") return null;
  const raw = originOf(path);
  if (raw === null) return null;
  // a URL may carry credentials before the host: never repeat them
  const url = raw.trim().replace(/^(https?:\/\/)[^@/]*@/, "$1");
  // a URL on GitHub only: a bare `owner/name` is a path on this machine
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(url) ? parseGithubRepo(url) : null;
  const origin = repo ? `${repo.owner}/${repo.name}` : url;
  if (repo && origin.toLowerCase() === source.repository.toLowerCase()) return null;
  return `origin は ${origin}、登録は ${source.repository} です。登録のリポジトリの clone にする（\`git remote set-url origin https://github.com/${source.repository}.git\` など）まで Task を起動しません`;
}

/** The origin URL of the checkout at `path`; null = not a git checkout, or one without an origin. */
export function gitOrigin(path: string): string | null {
  const r = spawnSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

/**
 * The workspaces a Task cannot use (#2799): registered to a GitHub repository whose folder is gone (a rebuild that could
 * not clone it, or moved a clone of another repository aside) or whose origin is not that repository (originMismatch).
 * Read each time 判断待ち is (#2866): a fixed one is simply not listed any more.
 */
export function unusableWorkspaces(db: Db, originOf = gitOrigin): Array<{ workspace: { id: string; name: string }; why: string }> {
  const out: Array<{ workspace: { id: string; name: string }; why: string }> = [];
  for (const ws of db.listWorkspaces()) {
    const source = db.getWorkspaceBacklogSource(ws.id);
    if (source?.service !== "github") continue;
    const why = existsSync(ws.path)
      ? originMismatch(ws.path, source, originOf)
      : `フォルダ ${ws.path} がありません（作り直しで clone できなかったか、登録のリポジトリ ${source.repository} と違う clone だったので退避された。理由はシステムのログの \`bootstrap:\` の行、退避した clone は \`${ws.path}.unverified-*\`）。\`gh repo clone ${source.repository} ${ws.path}\` で置き直すまで、この workspace の Task は起動しません`;
    if (why) out.push({ workspace: { id: ws.id, name: ws.name }, why });
  }
  return out;
}

/** Registers a directory as a workspace. `switchboard` keeps its backlog here only (#2265): the source is set now and stored as an empty import. */
export function registerWorkspace(db: Db, input: { path: string; name: string; backlog: "github" | "switchboard"; had?: Workspace; upstream?: string }): Workspace {
  let ws = db.upsertWorkspace({ path: input.path, name: input.name, kind: "repo", ...(input.upstream ? { upstream: input.upstream } : {}) });
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

/**
 * Makes a fresh clone of someone else's repository write nothing back (#2576): its `origin` becomes `upstream`, the only
 * remote (`gh repo clone` of a fork has already added the parent as `upstream`), and the clone is marked for the kit's
 * refusal (`noWriteRefusal`). Throws what git said.
 */
function detachFromOrigin(path: string, repo: string): void {
  const git = (...args: string[]) => spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  git("remote", "remove", "upstream");
  for (const args of [["remote", "rename", "origin", "upstream"], ["config", "--add", "ops-kit.noWrite", repo]]) {
    const r = git(...args);
    if (r.status !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `git ${args[0]} が失敗しました`);
  }
}

/**
 * Makes the private repository `mine` (just created, empty) the clone's `origin` and gh's default (#2579): every branch of
 * `upstream` and every tag is pushed to it, the checked-out branch first so it becomes the default branch. Throws what git
 * or gh said.
 */
async function pushToOwnCopy(path: string, mine: string, gh: GhRunner): Promise<void> {
  // asynchronous: a slow transfer must not hold the daemon's event loop
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", "-C", path, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    if (code !== 0) throw new Error(`git ${args[0]}: ${err.trim().split("\n").pop() || code}`);
  };
  await git("remote", "add", "origin", `https://github.com/${mine}.git`);
  // the clone has upstream's default branch only; the others become branches here so that --all carries them
  await git("fetch", "--update-head-ok", "upstream", "+refs/heads/*:refs/heads/*");
  // -u: every branch tracks the copy, so a plain `git push` / `git pull` goes to origin, not to upstream
  await git("push", "-u", "origin", "HEAD");
  await git("push", "-u", "origin", "--all");
  await git("push", "origin", "--tags");
  // gh would otherwise pick upstream as the default (repoOf reads the remote set-default marks first)
  const d = await gh(["repo", "set-default", mine], path);
  if (d.code !== 0) throw new Error(`gh repo set-default: ${d.stderr.trim().split("\n").pop() || d.code}`);
}

/** Clones of GitHub repositories next to the checkout, in memory only: a restart forgets them (#2575). */
export class WorkspaceClones {
  private readonly rows = new Map<string, WorkspaceClone>();

  constructor(private readonly db: Db, private readonly gh: GhRunner, private readonly repoRoot: string, private readonly onChange: () => void) {}

  list(): WorkspaceClone[] {
    return [...this.rows.values()];
  }

  /**
   * Checks the target, then clones in the background; a repository the caller cannot push to is added as someone else's
   * (#2576): its backlog is here, and it writes nothing back to `full_name`, the name it has now (a renamed one answers
   * under the old name too). `ownCopy` (#2579) also creates a private `<you>/<name>` and makes it the clone's origin and
   * gh's default, the backlog as asked (GitHub when absent). A path that a workspace keeps stays as it is. Throws
   * CloneError for what the request got wrong.
   */
  async start(repo: { owner: string; name: string }, opts: { backlog?: "github" | "switchboard"; ownCopy?: boolean }): Promise<WorkspaceClone> {
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
    const perm = await this.gh(["api", `repos/${full}`, "--jq", '"\\(.permissions.push) \\(.full_name)"'], cwd);
    const [push, canonical] = perm.stdout.trim().split(" ");
    const foreign = perm.code === 0 && push !== "true";
    const refuse = (message: string, status: number) => {
      this.rows.delete(path);
      this.onChange();
      return new CloneError(message, status);
    };
    if (perm.code !== 0) throw refuse(`見つからないか読めません: ${perm.stderr.trim().split("\n").pop() ?? ""}`, 404);
    if (opts.ownCopy && !foreign) throw refuse(`${full} には push できます。自分の非公開リポジトリを作る印は、push できない他者のリポジトリのときだけです`, 400);
    // a path keeps what it was: someone else's repository does not take over a workspace that syncs with GitHub, nor your own a foreign one
    if (!opts.ownCopy && (foreign ? had && had.backlog !== "switchboard" : had?.upstream)) {
      throw refuse(foreign ? `この workspace のバックログは ${had!.backlog} に置いています。他者のリポジトリは ${path} に追加できません` : `${path} の workspace は他者のリポジトリ ${had!.upstream} です。自分のリポジトリは追加できません`, 409);
    }
    let mine: string | null = null;
    if (opts.ownCopy) {
      const me = await this.gh(["api", "user", "--jq", ".login"], cwd);
      const login = me.stdout.trim();
      if (me.code !== 0 || !login) throw refuse(`自分の GitHub のアカウントが分かりません: ${me.stderr.trim().split("\n").pop() ?? ""}`, 502);
      mine = `${login}/${repo.name}`;
      // an existing one of yours is never pushed over (a 404 is the only answer that lets it go on)
      const there = await this.gh(["api", `repos/${mine}`, "--jq", ".full_name"], cwd);
      if (there.code === 0) throw refuse(`自分のアカウントに ${mine} が既にあります。作らず写しません`, 409);
      if (!/HTTP 404/.test(there.stderr)) throw refuse(`${mine} があるか確かめられません: ${there.stderr.trim().split("\n").pop() ?? ""}`, 502);
    }
    const started = { ...row };
    void this.run(row, repo, cwd, opts, foreign ? (canonical ?? full) : null, mine);
    return started;
  }

  private async run(row: WorkspaceClone, repo: { name: string }, cwd: string, opts: { backlog?: "github" | "switchboard" }, upstream: string | null, mine: string | null): Promise<void> {
    let created = false;
    try {
      const r = await this.gh(["repo", "clone", row.repo, row.path], cwd);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `gh repo clone が ${r.code} で終わりました`);
      if (upstream) detachFromOrigin(row.path, upstream);
      if (mine) {
        const c = await this.gh(["repo", "create", mine, "--private"], cwd);
        if (c.code !== 0) throw new Error(`gh repo create: ${c.stderr.trim().split("\n").pop() || c.code}`);
        created = true;
        await pushToOwnCopy(row.path, mine, this.gh);
      }
      const backlog = upstream && !mine ? "switchboard" : (opts.backlog ?? "github");
      registerWorkspace(this.db, { path: row.path, name: repo.name, backlog, had: this.db.listWorkspaces().find((w) => w.path === row.path), ...(upstream ? { upstream } : {}) });
      this.rows.delete(row.path);
    } catch (e) {
      row.state = "failed";
      // what was made stays (deleting a repository is the person's call)
      row.error = created ? `${(e as Error).message}（${mine} は作成済みです。消すか使うかは手で）` : (e as Error).message;
    }
    this.onChange();
  }
}
