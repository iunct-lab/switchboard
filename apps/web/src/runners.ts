import type { CustomRunner, RunnerId, RunnerInfo } from "@switchboard/protocol";

/** The runners the daemon registered, in the order it lists them. DAK is absent unless SWITCHBOARD_DAK_URL is set (#2558). */
/** `keep` is a value already saved (a schedule's runner): it stays selectable even when the daemon no longer lists it. */
export function listedRunners(runners: RunnerInfo[] | undefined, keep?: RunnerId): RunnerId[] {
  const out: RunnerId[] = runners ? runners.map((r) => r.id) : ["claude", "codex"];
  if (keep && !out.includes(keep)) out.push(keep);
  return out;
}

/** The ledger's runners: the listed ones, then any runner with a record that is not listed (a past DAK), first seen first. */
export function ledgerRunners(listed: RunnerId[], recorded: RunnerId[]): RunnerId[] {
  const out = [...listed];
  for (const r of recorded) if (!out.includes(r)) out.push(r);
  return out;
}

const BUILTIN_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", dak: "DAK" };
/** The labels the daemon last listed (a custom runner's own name), so a pill far from /api/health can show it too. */
const knownLabels = new Map<string, string>();
export function rememberRunnerLabels(runners: RunnerInfo[] | undefined) {
  for (const r of runners ?? []) if (r.label) knownLabels.set(r.id, r.label);
}

/** The name to show for a runner: the daemon's label, else the built-in name, else the id (a runner only a newer daemon knows). */
export function runnerLabel(id: string, info?: Pick<RunnerInfo, "label">): string {
  return info?.label ?? knownLabels.get(id) ?? BUILTIN_LABELS[id] ?? id;
}

/** An ADK runner (DAK or one added in Settings): no permission modes, no usage limit to resume from, no shadow of its own. */
export const isAdkRunner = (id: string) => id === "dak" || id.startsWith("custom:");

/** The fields of a server being added in Settings, as typed. */
export type CustomRunnerDraft = { name: string; label: string; url: string; app: string; tokenEnv: string };

/**
 * The entry a draft adds, or why it cannot be added (the same rules as `CustomRunner` in the protocol, said in words).
 * An empty token variable name is no token.
 */
export function customRunnerFromDraft(d: CustomRunnerDraft, saved: CustomRunner[]): { entry: CustomRunner } | { error: string } {
  const name = d.name.trim();
  const label = d.label.trim() || name;
  const url = d.url.trim();
  const app = d.app.trim();
  const tokenEnv = d.tokenEnv.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) return { error: "名前は英小文字・数字・- で 32 文字まで（先頭は英小文字か数字）" };
  if (name === "dak") return { error: "dak は SWITCHBOARD_DAK_URL の DAK の名前です（別の名前に）" };
  if (saved.some((r) => r.name === name)) return { error: `custom:${name} は既にあります（変えるなら削除して足し直す）` };
  if (!/^https?:\/\/[^/]/.test(url) || !URL.canParse(url)) return { error: "URL は http:// か https:// で始まる形で" };
  if (!app) return { error: "アプリ名を入れてください" };
  if (tokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) return { error: "トークンの環境変数名は英大文字・数字・_ で（値ではなく名前）" };
  return { entry: { name, label, url: url.replace(/\/+$/, ""), app, ...(tokenEnv ? { tokenEnv } : {}) } };
}

/** The request and its attachments leave this machine when the server is not on loopback. */
export function sendsOffHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return !(h === "localhost" || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h));
  } catch {
    return true;
  }
}
