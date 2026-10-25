import type { RunnerId, RunnerInfo } from "@switchboard/protocol";

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
