import type { RunnerId, RunnerInfo } from "@switchboard/protocol";

/** What is missing when the daemon gave no note (or no runner list): the words Home showed on hover before #3354. */
const MISSING: Record<RunnerId, string> = {
  claude: "claude が PATH にありません。Claude Code をインストールしてください（https://claude.com/claude-code）",
  codex: "codex が PATH にありません（公式インストーラ: curl -fsSL https://chatgpt.com/codex/install.sh | sh）",
  dak: "DAK の agent（http://127.0.0.1:8000、SWITCHBOARD_DAK_URL で変更）に到達できません。DAK リポジトリで docker compose up",
};

/** Why runner `id` cannot be picked and what to do, as text read without hovering (#3354); null when it can be picked. */
export function unavailableNotice(info: RunnerInfo | undefined, id: RunnerId): string | null {
  if (info?.available) return null;
  return info?.note ?? MISSING[id];
}

/**
 * The line under the runners (#3354): each runner the daemon listed as unavailable, with its reason. Empty until the
 * daemon has listed them (loading, unreachable, no token): nothing is known to be missing then.
 */
export function unavailableNotices(runners: RunnerInfo[] | undefined): Array<{ id: RunnerId; text: string }> {
  return (runners ?? []).filter((r) => !r.available).map((r) => ({ id: r.id, text: unavailableNotice(r, r.id)! }));
}

/**
 * The first reason 開始 cannot be pressed, in the order the person fixes them (#3354); null when it can. `runnerOk` is the
 * selected runner, `anyRunnerOk` any runner. `ws` false = 自動, which only Cloud refuses.
 */
export function startBlockedReason(s: { prompt: string; stale: boolean; attachBusy: boolean; runnerOk: boolean; cloud: boolean; ws: boolean; anyRunnerOk: boolean }): string | null {
  if (!s.prompt.trim()) return "本文を書いてください";
  if (s.stale) return "Workspace を変えたので、本文に入れ直してください";
  if (!s.cloud && s.attachBusy) return "添付のアップロードが終わるまで待ってください";
  if (!s.anyRunnerOk) return "使えるランナーがありません。ランナーの下の行の理由を直してください";
  if (!s.runnerOk) return "選んだランナーは使えません。使えるランナーを選んでください";
  if (s.cloud && !s.ws) return "Cloud は Workspace を選んでください";
  return null;
}
