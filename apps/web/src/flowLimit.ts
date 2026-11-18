import type { BacklogAllocation } from "@switchboard/protocol";

/** One line under the flow limit's field: the PBIs a workspace has counted against the limit, or the Ready ones the limit holds back. */
export interface FlowLimitRow { kind: "counted" | "held"; ws: string; numbers: number[] }

/**
 * The lines under the flow limit's field, from `GET /api/backlog/allocation`'s `flowLimit`: per workspace (by its name;
 * its id when the name is not known) the counted PBIs first, then the held ones. A side with no PBI has no line.
 */
export function flowLimitRows(flow: BacklogAllocation["flowLimit"], names: ReadonlyMap<string, string>): FlowLimitRow[] {
  return flow.workspaces.flatMap((w) => {
    const ws = names.get(w.workspaceId) ?? w.workspaceId;
    return ([["counted", w.counted], ["held", w.held]] as const).flatMap(([kind, numbers]) => (numbers.length ? [{ kind, ws, numbers }] : []));
  });
}

/** The numbers as shown: `#12 #34`. */
export const flowNumbers = (numbers: number[]) => numbers.map((n) => `#${n}`).join(" ");
