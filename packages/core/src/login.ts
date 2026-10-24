import type { RunnerId } from "@switchboard/protocol";

/**
 * A turn that ended on the runner's own "not logged in" error (#180). The runner's status command (`detect()`) only
 * runs every minute and may say "logged in" while the server has revoked the token, so the turn's error text also marks
 * the login expired. Same shape as `LIMIT_TEXT` in ratelimit.ts; the text is the runner's, never a credential.
 */
const AUTH_TEXT: Record<RunnerId, RegExp[]> = {
  // Claude Code prints "Not logged in · Please run /login", "Invalid API key · Please run /login" and
  // "OAuth token has expired. Please obtain a new token or refresh your existing token." (wording only, not recorded).
  claude: [/not logged in/i, /please run \/login/i, /oauth token (?:has )?(?:expired|been revoked)/i, /invalid api key/i],
  // Not recorded: "Not logged in" (`codex login status`), the refresh-token failure asking to sign in again, and 401s.
  // A bare "refresh token" is not enough: "Failed to refresh token: connection timed out" is the network, not the login.
  codex: [/not logged in/i, /login required/i, /\bunauthori[sz]ed\b/i, /\bstatus:? 401\b/i, /\b401 unauthori[sz]ed\b/i, /refresh token (?:has |had )?(?:expired|was already used|is invalid|been revoked)/i, /sign in again/i],
  dak: [],
};

/** How old the last status-command answer may be before GET /api/health asks again. */
export const LOGIN_RECHECK_MS = 60_000;
/** The same for the banner's 再確認 (`?recheck=1`): soon enough after a login, not a way to spawn the runners at will. */
export const LOGIN_FORCED_RECHECK_MS = 5_000;

/** Whether a runner's error text says its login is gone (as opposed to any other failure). */
export function isAuthText(runner: RunnerId, text: string | undefined): boolean {
  if (!text) return false;
  return (AUTH_TEXT[runner] ?? []).some((re) => re.test(text));
}
