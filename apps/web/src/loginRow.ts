import type { RunnerInfo } from "@switchboard/protocol";

/**
 * What the settings row of a runner's own login shows (#2528): the kind while logged in, with the logout button;
 * "ログアウト中" while it ran out or was logged out, where the login buttons take the place of the logout one.
 * Only claude has the row, except that any runner switched to Amazon Bedrock says so (codex, #1731). A kind that is not
 * known (an older CLI) is left out, not guessed.
 */
export function loginRowView(r: Pick<RunnerInfo, "id" | "login" | "loginKind">): { text: string; logout: boolean; bedrock?: true } | null {
  // chosen in the settings (#1730): always shown, with neither login nor logout (the runner's own login is not in use)
  if (r.loginKind === "bedrock") return { text: "使用中: サードパーティのプラットフォーム（Amazon Bedrock）", logout: false, bedrock: true };
  if (r.id !== "claude") return null;
  if (r.login === "ok") {
    const kind = r.loginKind === "claude.ai" ? ": Claude アカウント" : r.loginKind === "console" ? ": Anthropic Console" : "";
    return { text: `ログイン中${kind}`, logout: true };
  }
  if (r.login === "expired") return { text: "ログアウト中", logout: false };
  return null;
}
