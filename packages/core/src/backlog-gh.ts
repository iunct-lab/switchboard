/**
 * How the backlog reaches GitHub and which backlog a workspace has: the `gh` runner and its errors, the repository and
 * the Project of a checkout, GitHub's GraphQL budget, and the source of a workspace's backlog (GitHub's, or one kept
 * here only). GitHub is the source of truth; the DB keeps a copy of it (backlog-sync.ts) that backlog-stored.ts reads.
 */
import type { BacklogSource, GithubBudget } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { noWriteRefusal } from "../../../ops-kit/src/config.ts";
import { workspaceConfigPath } from "./workspace-config.ts";
import { readFileSync } from "node:fs";
import { parseIncluded, responseOf, retryAtFromResponse, type GithubFailure, type GithubResponse } from "../../../ops-kit/src/gh.ts";

export type GhRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `gh` from PATH. A missing binary answers like a failed command so the caller reports it instead of throwing. */
export const runGh: GhRunner = async (args, cwd) => {
  try {
    const p = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: `gh を起動できません: ${(e as Error).message}` };
  }
};

/**
 * `response`: what GitHub answered to the failed call (status, headers, errors), to tell a limit from other failures.
 * `kind`: what the owner has to do about it (BacklogErrorKind), when the place that called gh knows.
 */
export class BacklogError extends Error {
  constructor(message: string, readonly response?: GithubResponse, readonly kind?: "gh-login" | "project-var") {
    super(message);
  }
}

/** The workspace a backlog is read for: gh runs in `path`, and its items carry `id` / `name`. */
export interface BacklogWorkspace {
  id: string;
  name: string;
  path: string;
  /** Repository variable holding the Project URL (Workspace.projectVar); unset = SWITCHBOARD_PROJECT_URL. */
  projectVar?: string;
}

/**
 * Below this GraphQL budget left, a Task stopped by GitHub's limit is resumed at the budget's reset (`ratelimit.ts`):
 * twice the heaviest read (`gh project item-list`, about 400 points) still fits. A stage start does not wait on it.
 */
export const GITHUB_REMAINING_MIN = 1000;

/**
 * GitHub's GraphQL budget, asked at most once per `ttlMs` (1 point a time): a failed read is kept as long as a
 * good one, so a gh that fails is not asked on every look; calls at the same time share one read. `null` = not known,
 * and a read that takes longer than `timeoutMs` is not known either (a stage button or the ledger does not hang on gh).
 * At 0 left GitHub refuses the read itself: a refusal for its primary limit is 0 left until the time GitHub gave.
 * While the host is waited for (`waiting`, BacklogSync's) nothing is asked: a primary
 * limit is 0 left until its end, another wait (or one whose kind is not known) is not known.
 */
export class GithubBudgetCache {
  private last: { at: number; value: Promise<GithubBudget | null> } | null = null;
  /** A read gh has not answered yet: a stuck gh is waited on again, not joined by one more process a minute. */
  private reading: Promise<GithubBudget | null> | null = null;
  /** The limit GitHub last said, for the budgets made without asking: GitHub's budget of a user until it says. */
  private limit = 5000;
  constructor(private readonly gh: GhRunner, private readonly ttlMs = 60_000, private readonly clock = () => Date.now(), private readonly timeoutMs = 10_000, private readonly waiting: () => { until: number; reason: GithubFailure | null } | null = () => null) {}

  get(cwd: string): Promise<GithubBudget | null> {
    const now = this.clock();
    const wait = this.waiting();
    if (wait) return Promise.resolve(wait.reason === "primary" ? { remaining: 0, limit: this.limit, resetsAt: Math.floor(wait.until / 1000) } : null);
    if (this.last && now - this.last.at < this.ttlMs) return this.last.value;
    if (!this.reading) {
      const reading = this.read(cwd);
      this.reading = reading;
      void reading.finally(() => { if (this.reading === reading) this.reading = null; });
    }
    const value = Promise.race([this.reading, Bun.sleep(this.timeoutMs).then(() => null)]);
    this.last = { at: now, value };
    return value;
  }

  private async read(cwd: string): Promise<GithubBudget | null> {
    const r = await this.gh(["api", "graphql", "--include", "-f", "query={ rateLimit { limit remaining resetAt } }"], cwd).catch(() => null);
    if (!r) return null;
    const { headers, body } = parseIncluded(r.stdout);
    if (r.code !== 0) {
      const limited = retryAtFromResponse(responseOf(r.stdout, r.stderr), this.clock());
      const limit = Number(headers["x-ratelimit-limit"]);
      if (limited?.kind !== "primary" || limited.at === null) return null;
      if (limit > 0) this.limit = limit;
      return { remaining: 0, limit: this.limit, resetsAt: Math.floor(limited.at / 1000) };
    }
    // the answer's own headers, when the body does not say (GitHub answers a limited read with 200 and errors)
    const fromHeaders = (): GithubBudget | null => {
      const remaining = Number(headers["x-ratelimit-remaining"]);
      const limit = Number(headers["x-ratelimit-limit"]);
      const reset = Number(headers["x-ratelimit-reset"]);
      if (!Number.isFinite(remaining) || !Number.isFinite(reset) || headers["x-ratelimit-remaining"] === undefined || headers["x-ratelimit-reset"] === undefined) return null;
      if (limit > 0) this.limit = limit;
      return { remaining, limit: this.limit, resetsAt: reset };
    };
    try {
      const l = (JSON.parse(body) as { data?: { rateLimit?: { limit?: unknown; remaining?: unknown; resetAt?: unknown } } })?.data?.rateLimit;
      const resetsAt = typeof l?.resetAt === "string" ? Date.parse(l.resetAt) / 1000 : NaN;
      if (typeof l?.limit !== "number" || typeof l.remaining !== "number" || !Number.isFinite(resetsAt)) return fromHeaders();
      this.limit = l.limit;
      return { remaining: l.remaining, limit: l.limit, resetsAt };
    } catch {
      return fromHeaders();
    }
  }
}

/** The repository checked out at `cwd` and whether it is private. */
export async function repoOf(gh: GhRunner, cwd: string): Promise<{ repo: string; owner: string; name: string; private: boolean }> {
  const answer = (await call(gh, cwd, ["repo", "view", "--json", "nameWithOwner,isPrivate", "-q", '"\\(.nameWithOwner) \\(.isPrivate)"'])).trim();
  const [repo = "", visibility] = answer.split(/\s+/);
  const [owner, name] = repo.split("/");
  if (!owner || !name || (visibility !== "true" && visibility !== "false")) throw new BacklogError(`リポジトリを特定できません: ${answer.slice(0, 200)}`);
  return { repo, owner, name, private: visibility === "true" };
}

/**
 * The repository whose backlog the checkout at `cwd` imports and writes (`repoOf`). A clone of the public copy that
 * still resolves to it, or one marked `ops-kit.noWrite` (`noWriteRefusal`), is refused: its backlog is neither imported nor sent, and the
 * import's failure says how to point the clone at one's own repository. A read only (the secret scan) uses `repoOf`.
 */
export async function backlogRepoOf(gh: GhRunner, cwd: string): Promise<{ repo: string; owner: string; name: string; private: boolean }> {
  const r = await repoOf(gh, cwd);
  const refusal = noWriteRefusal(r.repo, cwd);
  if (refusal) throw new BacklogError(refusal);
  return r;
}

/**
 * A workspace whose backlog is kept in Switchboard only: no GitHub Issue or Project. Its records are stored
 * under the workspace's id, so two of them never share a number.
 */
export const LOCAL_BACKLOG = { service: "switchboard", host: "local" } as const;
/** Its source: the Project is this workspace's stored data only (owner / number are what records are matched on, no Project elsewhere). */
export const localBacklogSource = (workspaceId: string): BacklogSource => ({ ...LOCAL_BACKLOG, repository: workspaceId, project: { owner: "switchboard", number: 0 } });

/**
 * Whether the workspace's backlog reads and writes its service's Issues — GitHub's Issues and Project, or a
 * GitLab project's Issues: not one kept here only, nor one whose sync was turned off. null = a workspace
 * not imported yet. (The name is older than GitLab.)
 */
export const syncsGithub = (s: BacklogSource | null | undefined) => !s || (s.service !== "switchboard" && !s.disabled);

/**
 * Where a workspace's local changes are kept: its own records when they are kept here only, else the workspace's
 * records without a service (`localBacklogSource`) — apart from the service's Issues and numbered from 1 there. A change
 * among GitHub's numbers would take the number an Issue still waiting to be created gets, and their comments would mix.
 * Nothing of it is ever sent. null = a workspace with no source yet.
 */
export function changeSourceOf(db: Db, workspaceId: string): BacklogSource | null {
  const source = db.getWorkspaceBacklogSource(workspaceId);
  return !source || source.service === "switchboard" ? source : localBacklogSource(workspaceId);
}
/** Whether the workspace's changes are kept apart from its Issues (`changeSourceOf`): the same number may then name a change and an Issue. */
export const changesApart = (source: BacklogSource | null | undefined) => !!source && source.service !== "switchboard";

/** gh's own wording (and GitHub's 401) for a missing or refused login. */
export const GH_LOGIN_REFUSED = /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i;

export async function call(gh: GhRunner, cwd: string, args: string[]): Promise<string> {
  const r = await gh(args, cwd);
  if (r.code !== 0) {
    // gh's own wording for a missing or refused login: the backlog then says to log in, not this text
    const login = GH_LOGIN_REFUSED.test(r.stderr) ? "gh-login" : undefined;
    throw new BacklogError(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr.trim() || `exit ${r.code}`).slice(0, 200)}`, responseOf(r.stdout, r.stderr), login);
  }
  // `gh api --include` puts the status and headers first: only the body is the answer
  return parseIncluded(r.stdout).body;
}

/** The Project a workspace's backlog reads, from the URL `…/<orgs|users>/<owner>/projects/<number>`. */
export interface BacklogProject {
  owner: string;
  number: number;
}

/**
 * The Project of the workspace: the repository variable the workspace names (its own naming), else
 * SWITCHBOARD_PROJECT_URL — from the environment, the `projectUrl` of the settings the checkout is run with, or the
 * repository variable, as the backlog scripts read it. The environment applies to every workspace, so a workspace that
 * names its variable is not overridden by it.
 */
export async function projectOf(gh: GhRunner, ws: Pick<BacklogWorkspace, "path" | "projectVar"> & { id?: string }): Promise<BacklogProject> {
  const varName = ws.projectVar ?? "SWITCHBOARD_PROJECT_URL";
  // the settings the checkout is run with (its own `ops.config.json`, else the workspace's saved ones) may name the Project, as the kit reads it: after the environment, before the variable
  const configured = (): string | undefined => {
    try {
      const file = workspaceConfigPath(ws.id ? { id: ws.id } : null, ws.path);
      const url = file ? (JSON.parse(readFileSync(file, "utf8")) as { projectUrl?: unknown } | null)?.projectUrl : undefined;
      return typeof url === "string" && url !== "" ? url : undefined;
    } catch {
      return undefined;
    }
  };
  const variable = () => call(gh, ws.path, ["variable", "get", varName]).catch((e: unknown) => {
    // the variable is not set: the backlog then shows how to set up a Project, or to go without GitHub
    if (e instanceof BacklogError && !e.kind && /was not found/i.test(e.message)) throw new BacklogError(e.message, e.response, "project-var");
    throw e;
  });
  const projectUrl = (ws.projectVar ? await variable() : (process.env.SWITCHBOARD_PROJECT_URL ?? configured() ?? (await variable()))).trim();
  const parts = projectUrl.split("/");
  const number = Number(parts.at(-1));
  if (!Number.isInteger(number) || number <= 0) throw new BacklogError(`${varName} から Project 番号が取れません: ${projectUrl.slice(0, 200)}`);
  return { owner: parts.at(-3) ?? "", number };
}
