import type { RunnerCommand } from "@switchboard/protocol";
import { api } from "./api/index.ts";

/* "/" in a request or reply box: the runner's commands and skills, read from the daemon and narrowed by what is typed. */

/** The word after a leading "/" (up to the first blank or line break); null when the text does not start with "/". */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)/.exec(text);
  return m ? m[1]! : null;
}

/** The list is offered while the head word is still being typed: "/pbi" yes, "/pbi 12" (an argument follows) no. */
export const slashOpen = (text: string): boolean => /^\/\S*$/.test(text);

/** Commands whose name holds `query` (any case): names that start with it first, then by name. */
export function suggestCommands(list: RunnerCommand[], query: string): RunnerCommand[] {
  const q = query.toLowerCase();
  const rank = (c: RunnerCommand) => (c.name.toLowerCase().startsWith(q) ? 0 : 1);
  return list
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** `text` with its head word (`/` and what follows up to a blank) replaced by `insert` and one space. */
export function putCommand(text: string, insert: string): string {
  return `${insert} ${text.replace(/^\/\S*\s?/, "")}`;
}

const loaded = new Map<string, Promise<RunnerCommand[]>>();
/**
 * The list for a runner in a workspace (null = the home directory), read once and reused after;
 * a failed read is forgotten, so the next "/" asks again.
 */
export function loadCommands(
  runner: string,
  workspaceId: string | null,
  read: (runner: string, workspaceId: string | null) => Promise<{ commands: RunnerCommand[] }> = (r, w) => api.runnerCommands(r, w),
): Promise<RunnerCommand[]> {
  const key = `${runner}:${workspaceId ?? ""}`;
  let p = loaded.get(key);
  if (!p) {
    const mine: Promise<RunnerCommand[]> = read(runner, workspaceId).then((r) => r.commands);
    p = mine;
    loaded.set(key, mine);
    mine.catch(() => { if (loaded.get(key) === mine) loaded.delete(key); });
  }
  return p;
}
/** The read for what the box holds: the list while it is open, none otherwise (opening Home or a Task reads nothing). */
export function readFor(
  text: string,
  runner: string,
  workspaceId: string | null,
  read?: (runner: string, workspaceId: string | null) => Promise<{ commands: RunnerCommand[] }>,
): Promise<RunnerCommand[]> | null {
  return slashOpen(text) ? loadCommands(runner, workspaceId, read) : null;
}
/** Forget every list (tests). */
export const forgetCommands = () => loaded.clear();

/** What the picker shows for the text: nothing, the one failure line, or the rows. */
export type SlashView = { kind: "none" } | { kind: "failed" } | { kind: "rows"; rows: RunnerCommand[] };

/** `data` is null until read, an Error when the read failed. */
export function slashView(text: string, data: RunnerCommand[] | Error | null): SlashView {
  if (!slashOpen(text) || data === null) return { kind: "none" };
  if (data instanceof Error) return { kind: "failed" };
  const rows = suggestCommands(data, slashQuery(text)!);
  return rows.length ? { kind: "rows", rows } : { kind: "none" };
}
