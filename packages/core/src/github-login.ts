import type { GhRunner } from "./backlog.ts";

/**
 * GitHub's own login from the screen, for a machine where nothing logged `gh` in beforehand (a container on a PC; the
 * cloud host logs in with its stored token at boot). The daemon runs `gh auth login --web` through `RunnerLogins`, the
 * same relay as a runner's login: gh prints a one-time code and `https://github.com/login/device` without a terminal
 * and waits for the approval in the person's browser. gh writes the credentials itself; Switchboard keeps none.
 *
 * Scopes: gh's defaults (repo, read:org, gist) plus `project` (the backlog's Project fields) and `workflow` (pushing a
 * branch that changes `.github/workflows/`).
 */
export const GITHUB_LOGIN_ARGS = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "project,workflow"];
export const GITHUB_LOGIN_HOSTS = ["github.com"];
/** The logout: gh removes its stored credentials for github.com (`gh auth logout` without `--user` asks nothing when one account is logged in). */
export const GITHUB_LOGOUT_ARGS = ["auth", "logout", "--hostname", "github.com"];

export interface GithubStatus {
  /** `missing`: no gh to run here, so there is no login to offer either. */
  login: "ok" | "none" | "missing";
  /** The account gh is logged in as, when it says. */
  account?: string;
}

/** `gh auth status` for github.com: exit 0 is a usable login; 127 (gh could not be started) is missing; anything else (no login, a refused token) is none. */
export async function githubStatus(gh: GhRunner, cwd: string): Promise<GithubStatus> {
  const r = await gh(["auth", "status", "--hostname", "github.com"], cwd);
  if (r.code === 127) return { login: "missing" };
  if (r.code !== 0) return { login: "none" };
  const account = `${r.stdout}\n${r.stderr}`.match(/Logged in to github\.com account (\S+)/)?.[1];
  return account ? { login: "ok", account } : { login: "ok" };
}

export type GitConfigRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** `git config --global …` of the daemon's user. A missing git answers like a failed command. */
export const runGitConfig: GitConfigRunner = async (args) => {
  try {
    const p = Bun.spawn(["git", "config", "--global", ...args], { stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
};

/**
 * After a login: git's https fetch and push use gh's credentials, as the cloud host's do. A machine whose git has no
 * commit name or email yet (a new container) gets them from the GitHub account — the name (or the login) and the
 * account's noreply address — so a Task's first commit does not stop on them. Values already set are left alone.
 * Answers whether `setup-git` worked; the identity is best effort.
 */
export async function afterGithubLogin(gh: GhRunner, cwd: string, git: GitConfigRunner = runGitConfig): Promise<boolean> {
  const ok = (await gh(["auth", "setup-git", "--hostname", "github.com"], cwd)).code === 0;
  const [name, email] = await Promise.all([git(["user.name"]), git(["user.email"])]);
  if (name.stdout.trim() && email.stdout.trim()) return ok;
  const u = await gh(["api", "user", "--jq", '[.id, .login, .name // ""] | @tsv'], cwd);
  const [id, login, full] = u.stdout.trim().split("\t");
  if (u.code !== 0 || !id || !login) return ok;
  if (!name.stdout.trim()) await git(["user.name", full || login]);
  if (!email.stdout.trim()) await git(["user.email", `${id}+${login}@users.noreply.github.com`]);
  return ok;
}
