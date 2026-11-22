import type { CliRollbackResult, CliUpdateRunner, CliUpdateState, RunnerCommand, RunnerId, RunnerInfo } from "@switchboard/protocol";
import { type LoginMode } from "../login.ts";
import type { PromotionDrain, ReleaseStatus } from "../release.ts";
import { loginPath } from "../loginRow.ts";
import { req, setLoginMode } from "./request.ts";

/** The daemon's view of a runner login started from the screen (mirrors packages/core/src/runnerlogin.ts). */
export interface RunnerLoginView {
  runner: string;
  state: "waiting" | "done" | "failed";
  url?: string;
  code?: string;
  needsCode: boolean;
  error?: string;
}

/** The daemon's `gh auth status` (mirrors packages/core/src/github-login.ts). */
export interface GithubStatus {
  /** `missing`: no gh on the daemon's machine, so no login to offer. */
  login: "ok" | "none" | "missing";
  account?: string;
}

export interface Health {
  ok: boolean;
  protocol: string;
  /** Absent until the request is authorized (off-loopback without the token). */
  runners?: RunnerInfo[];
  home: string;
  /** `home` with the daemon user's home directory shortened to `~` (the daemon knows homedir(); the browser does not). */
  homeDisplay?: string;
  /** The data directory is under the OS temp area: what is recorded there can vanish. */
  homeIsTemp?: boolean;
  repoRoot: string;
  /** True when the daemon listens off-loopback and /api needs the token from ~/.switchboard/token. */
  authRequired: boolean;
  /** How a person gets in before being authorized: the cloud host's passkey page, or the token. */
  login?: LoginMode;
  /** When the cloud login's idle time and cap end (ms); only for a request that came in with the login cookie. */
  session?: { idleUntil: number; expiresAt: number };
  /** LLM routing suggestions: the saved setting plus whether this daemon can actually produce them. */
  routing?: { llm: { enabled: boolean; runner: RunnerId; model: string; available: boolean } };
  mcp: { base: string };
  /** What this distribution of the daemon can do. pty = the terminal tab. */
  features?: { pty: boolean };
  /** A problem with the cloud host's daily history archive (packages/core/src/archive-status.ts); null when there is none. */
  archive?: { kind: "failed" | "stuck" | "stale"; at: number; detail?: string } | null;
  /** A promotion that holds new turns back until the Tasks a restart would cut have stopped, one whose restart was asked for, or one whose hold ended at its limit (release.ts `drainBanner`). */
  promotionDrain?: PromotionDrain;
  /** Deltas a work machine sent that this instance cannot take in yet: the sender's database (`theirs`) is newer than this one (`ours`). Empty or absent = none. */
  uplinkSkipped?: Array<{ machine: string; theirs: number; ours: number }>;
}

/** The calls of this group; `api` (index.ts) holds every group's. */
export const daemonApi = {
  /** A runner's own login from the screen: the URL / device code it prints, or a box for its page's code. */
  runnerLogin: (runner: string, kind?: "console") => req<RunnerLoginView>(`${loginPath(runner)}${kind ? "?billing=api" : ""}`, { method: "POST" }),
  /** The runner's own logout; the login is read again, so the next health says it is logged out. */
  runnerLogout: (runner: string) => req<{ ok: boolean }>(`/api/runners/${runner}/logout`, { method: "POST" }),
  runnerLoginState: (runner: string) => req<RunnerLoginView>(loginPath(runner)),
  runnerLoginCode: (runner: string, code: string) => req<RunnerLoginView>(`/api/runners/${runner}/login/code`, { method: "POST", body: JSON.stringify({ code }) }),
  runnerLoginCancel: (runner: string) => req<RunnerLoginView>(loginPath(runner), { method: "DELETE" }),
  /** The host CLIs' versions and the record of what was put in, kept out or put back (read when Settings opens and after a rollback, not polled). */
  cliUpdates: () => req<CliUpdateState>("/api/runners/updates"),
  /** Puts the CLI back to the version before the current one; `waiting` = a Task runs, so it is done when none does. */
  rollbackCli: (runner: CliUpdateRunner) => req<CliRollbackResult>(`/api/runners/${runner}/rollback`, { method: "POST" }),
  /** What a request or reply box offers after "/": the runner's own commands and skills (`workspaceId` null = the daemon's home directory). */
  runnerCommands: (runner: string, workspaceId: string | null) => req<{ commands: RunnerCommand[] }>(`/api/runners/${runner}/commands${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
  /** gh's login on this machine: `none` until someone logs in (a machine without the cloud host's stored token). */
  githubStatus: () => req<GithubStatus>("/api/github/status"),
  githubLogout: () => req<{ ok: boolean }>("/api/github/logout", { method: "POST" }),
  /** `recheck` = ask the runners' login status commands again now instead of within the minute. */
  health: (opts: { recheck?: boolean } = {}) => req<Health>(opts.recheck ? "/api/health?recheck=1" : "/api/health").then((h) => (setLoginMode(h.login), h)),
  restartDaemon: (taskId?: string, force = false) => req<{ restarting: boolean; supervised: boolean; argv: string[] }>("/api/daemon/restart", { method: "POST", body: JSON.stringify({ taskId, force }) }),
  release: () => req<ReleaseStatus>("/api/daemon/release"),
  recheckRelease: () => req<{ started: "review"; tag: string }>("/api/daemon/release/review", { method: "POST" }),
  promote: (commit: string, force = false) => req<{ started: string; commit: string }>("/api/daemon/promote", { method: "POST", body: JSON.stringify({ commit, force }) }),
};
