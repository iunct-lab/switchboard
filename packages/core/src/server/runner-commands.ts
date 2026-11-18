import { homedir } from "node:os";
import type { RunnerCommand } from "@switchboard/protocol";
import type { ServerContext } from "./context.ts";

/** A read that cannot answer: the status the route sends and the reason. */
export class RunnerCommandsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Entry = { list?: RunnerCommand[]; reading?: Promise<RunnerCommand[]> };

// The daemon's memory only (one map per daemon, told apart by its db): the last list of each (runner, workspace) and the read in
// flight. A restart reads again on the next "/".
const perDaemon = new WeakMap<object, Map<string, Entry>>();

/**
 * The commands a runner offers after "/" in a workspace (no workspace = the home directory). A list read before is answered at
 * once and one read in the background refreshes it; with none yet the caller waits. Requests that come while a read is running
 * wait for that read, so the runner is never started twice for the same (runner, workspace). A failed read keeps the last list.
 */
export async function runnerCommands(sc: Pick<ServerContext, "adapters" | "db">, runner: string, workspaceId: string): Promise<{ commands: RunnerCommand[] }> {
  const adapter = sc.adapters.find((a) => a.id === runner);
  if (!adapter) throw new RunnerCommandsError(`runner "${runner}" is not here`, 404);
  const ws = workspaceId ? sc.db.getWorkspace(workspaceId) : null;
  if (workspaceId && !ws) throw new RunnerCommandsError(`workspace "${workspaceId}" is not here`, 404);
  if (!adapter.listCommands) return { commands: [] };
  const entries = perDaemon.get(sc.db) ?? new Map<string, Entry>();
  perDaemon.set(sc.db, entries);
  const key = `${runner}:${workspaceId}`;
  const entry = entries.get(key) ?? {};
  entries.set(key, entry);
  const read = () => {
    // Started inside a promise so an adapter that throws before it returns one fails the same way as one that rejects.
    entry.reading ??= Promise.resolve().then(() => adapter.listCommands!(ws?.path ?? homedir())).then(
      (list) => {
        entry.list = list;
        entry.reading = undefined;
        return list;
      },
      (e) => {
        entry.reading = undefined;
        throw e;
      },
    );
    return entry.reading;
  };
  if (entry.list) {
    read().catch((e) => console.warn(`runner commands: refreshing ${key} failed; the last list is kept (${String((e as Error)?.message ?? e)})`));
    return { commands: entry.list };
  }
  try {
    return { commands: await read() };
  } catch (e) {
    throw new RunnerCommandsError(e instanceof Error ? e.message : String(e), 502);
  }
}
