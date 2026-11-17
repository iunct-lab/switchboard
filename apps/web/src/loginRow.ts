import { isWorkingStatus, type RunnerInfo, type TaskSummary } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";
import type { LoginMode } from "./login.ts";

/** One of the four logins of the Settings group: who it is for, the state in words, and the one button it offers (none when there is nothing to press). */
export interface LoginRow {
  id: "switchboard" | "claude" | "codex" | "gh";
  label: string;
  text: string;
  action: "login" | "logout" | null;
}

const LABELS: Record<LoginRow["id"], string> = { switchboard: "Switchboard", claude: "Claude Code", codex: "Codex", gh: "GitHub" };

/**
 * The row of a runner's own login (claude, codex): the kind while logged in, with logout; "ログアウト中" while it ran out
 * or was logged out, with login; a note and no button while the tool is missing or the state is not known. A runner switched
 * to Amazon Bedrock says so, with neither (its own login is not in use). Runners without such a row (dak) give null.
 * A kind that is not known (an older CLI) is left out, not guessed.
 */
export function loginRowView(r: Pick<RunnerInfo, "id" | "login" | "loginKind" | "available">): (LoginRow & { bedrock?: true }) | null {
  if (r.id !== "claude" && r.id !== "codex") return null;
  const row = { id: r.id, label: LABELS[r.id] };
  if (r.loginKind === "bedrock") return { ...row, text: t(common.loginBedrock), action: null, bedrock: true };
  if (!r.available) return { ...row, text: t(common.loginNoTool), action: null };
  if (r.login === "ok") {
    const kind = r.loginKind === "claude.ai" ? t(common.loginClaudeAccount) : r.loginKind === "console" ? ": Anthropic Console" : "";
    return { ...row, text: t(common.loggedIn, { kind }), action: "logout" };
  }
  if (r.login === "expired") return { ...row, text: t(common.loggedOut), action: "login" };
  return { ...row, text: t(common.loginUnknown), action: null };
}

/** Switchboard's own login, from the daemon's `health.login`: the passkey login can log out; the token and no login (inside the host) have nothing to press. */
export function switchboardRowView(mode: LoginMode | undefined): LoginRow {
  const row = { id: "switchboard" as const, label: LABELS.switchboard };
  if (mode === "passkey") return { ...row, text: t(common.loginSwitchboardPasskey), action: "logout" };
  if (mode === "token") return { ...row, text: t(common.loginSwitchboardToken), action: null };
  return { ...row, text: t(common.loginSwitchboardInside), action: null };
}

/** `gh` (GitHub's CLI) logs in through the same relay as a runner, at its own path. */
export function loginPath(runner: string): string {
  return runner === "gh" ? "/api/github/login" : `/api/runners/${runner}/login`;
}

/** gh's row: login while logged out, logout once in, nothing to press without gh. */
export function githubRowView(s: { login: "ok" | "none" | "missing"; account?: string }): LoginRow {
  const row = { id: "gh" as const, label: LABELS.gh };
  if (s.login === "missing") return { ...row, text: t(common.githubMissing), action: null };
  if (s.login === "none") return { ...row, text: t(common.githubNone), action: "login" };
  return { ...row, text: s.account ? t(common.githubAs, { account: s.account }) : t(common.githubOk), action: "logout" };
}

/**
 * The sentence asked once before a logout. Running Tasks that use the login are counted: a runner's logout cuts the
 * Tasks of that runner; gh is used by every Task (its pushes and Issue writes).
 */
export function logoutConfirmText(id: "claude" | "codex" | "gh", tasks: Pick<TaskSummary, "runner" | "status">[]): string {
  const n = tasks.filter((x) => isWorkingStatus(x.status) && (id === "gh" || x.runner === id)).length;
  const label = LABELS[id];
  return n === 0 ? t(common.logoutConfirm, { label }) : t(common.logoutConfirmBusy, { n, label });
}
