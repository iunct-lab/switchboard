import type { Workspace } from "@switchboard/protocol";

/** The workspaces a list or a picker offers. A Release install keeps one meta row only as the home of the skills and the schedules, so it is not offered. */
export function shownWorkspaces(workspaces: Workspace[], releaseOnly: boolean): Workspace[] {
  return releaseOnly ? workspaces.filter((w) => w.kind !== "meta") : workspaces;
}
