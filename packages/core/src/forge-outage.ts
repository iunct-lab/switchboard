/**
 * Whether GitHub cannot be used for now, as the daemon itself observes it. A local change may stand in for a pull request
 * only then (docs/design/forge-integration.md, "While GitHub cannot be used, and coming back"): the answer is never a
 * Task's word for it, and never yes for a failure that waiting does not mend.
 */
import { outageOf, responseOf, retryAtFromResponse, type GithubOutage } from "../../../ops-kit/src/gh.ts";
import type { GhRunner } from "./backlog-gh.ts";

/** How long the daemon's own call is waited for: past it, GitHub did not answer (a timeout is an outage). */
export const OUTAGE_PROBE_TIMEOUT_MS = 10_000;

export type OutageAnswer =
  /** Observed: `evidence` is what was seen (the standing wait, or the first line of the failed call). */
  | { unusable: true; kind: GithubOutage["kind"] | "wait"; until: number | null; evidence: string }
  /** `usable`: the call went through. `permanent`: a login or permission failure. `unknown`: a failure of no class that passes. */
  | { unusable: false; reason: "usable" | "permanent" | "unknown"; detail: string };

/**
 * Asks once. `waitUntil`: the end of the wait the daemon's own sync stands in for this workspace (0 = none) — a limit or an
 * outage it met itself; while it stands nothing is asked. Else one call that costs no budget (`gh api rate_limit`) is
 * made in `cwd` and read with the kit's `outageOf`: no answer in time, a network error, a 5xx, or a budget at 0 with its
 * reset time say unusable. A 401 / 403 / 404 says permanent, a call that works says usable, anything else unknown.
 */
export async function githubOutage(deps: { gh: GhRunner; waitUntil: number; now?: () => number; timeoutMs?: number }, cwd: string): Promise<OutageAnswer> {
  const now = (deps.now ?? Date.now)();
  if (deps.waitUntil > now) return { unusable: true, kind: "wait", until: deps.waitUntil, evidence: "アプリ自身の取込みが GitHub の上限か障害で待っている" };
  const timedOut = Symbol("timeout");
  const r = await Promise.race([
    deps.gh(["api", "--include", "rate_limit"], cwd).catch((e: unknown) => ({ code: 1, stdout: "", stderr: String((e as Error).message ?? e) })),
    Bun.sleep(deps.timeoutMs ?? OUTAGE_PROBE_TIMEOUT_MS).then(() => timedOut),
  ]);
  if (typeof r === "symbol") return { unusable: true, kind: "network", until: null, evidence: "GitHub が時間内に答えない" };
  const first = (r.stderr || r.stdout).trim().split("\n")[0]!.slice(0, 200);
  if (r.code === 0) {
    // the budgets themselves: at 0 the calls a PR's flow needs are refused until the reset GitHub names
    try {
      const body = r.stdout.slice(r.stdout.indexOf("{"));
      const resources = (JSON.parse(body) as { resources?: Record<string, { remaining?: number; reset?: number }> }).resources ?? {};
      for (const name of ["graphql", "core"]) {
        const b = resources[name];
        if (b && b.remaining === 0 && typeof b.reset === "number" && b.reset * 1000 > now) return { unusable: true, kind: "primary", until: b.reset * 1000, evidence: `GitHub の ${name} の上限が 0（${new Date(b.reset * 1000).toISOString()} まで）` };
      }
    } catch {}
    return { unusable: false, reason: "usable", detail: "GitHub は答えている" };
  }
  const response = responseOf(r.stdout, r.stderr);
  const outage = outageOf(response, now);
  if (outage) return { unusable: true, ...outage, evidence: first };
  return { unusable: false, reason: retryAtFromResponse(response, now)?.kind === "auth" || [401, 403, 404].includes(response.status ?? 0) ? "permanent" : "unknown", detail: first || `gh が exit ${r.code}` };
}

/** Why a local change is not made, said to the Task that asked (the route's 409). */
export function outageRefusal(a: Extract<OutageAnswer, { unusable: false }>): string {
  if (a.reason === "usable") return "GitHub は使えます（アプリが今確かめました）。ローカルの変更に切り替えるのは、GitHub が一時的に使えないとアプリが確かめたときだけです。PR で進めてください";
  if (a.reason === "permanent") return `GitHub の認証か権限の失敗です（${a.detail}）。待っても直らないので、ローカルの変更には切り替えません。止まって利用者に報告してください`;
  return `GitHub が一時的に使えないとは確かめられませんでした（${a.detail}）。ローカルの変更には切り替えません。止まって利用者に報告してください`;
}
