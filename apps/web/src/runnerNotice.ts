import type { RunnerId, RunnerInfo } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";

/** What is missing when the daemon gave no note (or no runner list): the words Home showed on hover before #3354. */
const MISSING: Record<"claude" | "codex" | "dak", string> = {
  claude: t(home.missingClaude),
  codex: t(home.missingCodex),
  dak: t(home.dakUnreachable),
};

/** Why runner `id` cannot be picked and what to do, as text read without hovering (#3354); null when it can be picked. */
export function unavailableNotice(info: RunnerInfo | undefined, id: RunnerId): string | null {
  if (info?.available) return null;
  // an ADK server added in Settings (`custom:<name>`) has no fixed install advice: its own detect() note says what failed
  return info?.note ?? (id in MISSING ? MISSING[id as keyof typeof MISSING] : t(home.unreachable, { name: info?.label ?? id }));
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
  if (!s.prompt.trim()) return t(home.blockedPrompt);
  if (s.stale) return t(home.staleDraft);
  if (!s.cloud && s.attachBusy) return t(home.blockedAttach);
  if (!s.anyRunnerOk) return t(home.blockedNoRunner);
  if (!s.runnerOk) return t(home.blockedRunner);
  if (s.cloud && !s.ws) return t(home.blockedCloudWs);
  return null;
}
