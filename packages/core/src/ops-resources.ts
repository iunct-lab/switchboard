// The resources screen's one read (#3332, docs/design/ops-metrics.md): the host's free memory now, the machine's heavy-process
// slots and who waits for them (`ops-kit heavy`'s files), and the latest minute of the load sampler's task × kind RSS.
// Read when asked, nothing on a timer, and no walk of /proc's processes: the sampler already did that this minute.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadKind, OpsResources } from "@switchboard/protocol";
import { readHeavyState } from "../../../ops-kit/src/heavy.ts";
import type { Db } from "./db.ts";

/** /proc/meminfo in bytes; null where it cannot be read. */
export function readMemInfo(procRoot = "/proc"): { availableBytes: number; totalBytes: number; swapUsedBytes: number } | null {
  let text: string;
  try {
    text = readFileSync(join(procRoot, "meminfo"), "utf8");
  } catch {
    return null;
  }
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const available = kb("MemAvailable");
  const total = kb("MemTotal");
  if (available === undefined || total === undefined) return null;
  return { availableBytes: available, totalBytes: total, swapUsedBytes: (kb("SwapTotal") ?? 0) - (kb("SwapFree") ?? 0) };
}

const MB = 1024 * 1024;

export function opsResources(db: Db, opts: { home: string; procRoot?: string }): OpsResources {
  const heavy = readHeavyState(opts.home);
  const mem = readMemInfo(opts.procRoot);
  const latest = db.sqlite.query("SELECT MAX(ts) AS ts FROM ops_load_groups").get() as { ts: number | null } | null;
  const rows = latest?.ts
    ? (db.sqlite.query("SELECT task_id, owner, kind, rss, procs FROM ops_load_groups WHERE ts = ? ORDER BY rss DESC").all(latest.ts) as Array<{
        task_id: string | null;
        owner: "task" | "daemon" | "other";
        kind: LoadKind;
        rss: number;
        procs: number;
      }>)
    : [];
  // the names of the Tasks that appear, each looked up once
  const titles = new Map<string, string | null>();
  const title = (id: string | null) => {
    if (id === null) return null;
    if (!titles.has(id)) titles.set(id, db.getTask(id)?.title ?? null);
    return titles.get(id)!;
  };
  return {
    memory: mem && { ...mem, floorBytes: heavy.config.minFreeMb * MB },
    slots: {
      max: heavy.config.max,
      running: heavy.running.map((r) => ({ ...r, taskTitle: title(r.taskId) })),
      waiting: heavy.waiting.map((w) => ({ ...w, taskTitle: title(w.taskId) })),
    },
    consumers: latest?.ts
      ? { at: latest.ts, groups: rows.map((g) => ({ taskId: g.task_id, taskTitle: title(g.task_id), owner: g.owner, kind: g.kind, rssBytes: g.rss, procs: g.procs })) }
      : null,
  };
}
