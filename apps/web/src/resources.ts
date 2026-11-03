import type { OpsResources, ResourceRun, ResourceWait } from "@switchboard/protocol";
import { watchHealth } from "./healthWatch.ts";
import { fmtBytes, kindLabel } from "./ops.ts";

/** How often the resources screen reads `/api/ops/resources` while it is shown (docs/design/ops-metrics.md, リソース画面). */
export const RESOURCES_POLL_MS = 5000;

/**
 * Reads now if the page is in front, then every `RESOURCES_POLL_MS` while it stays in front and at once when it comes
 * back; nothing while it is hidden. Returns the stop (the screen calls it when it closes: nothing is read after).
 */
export function watchResources(doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">, load: () => void, everyMs = RESOURCES_POLL_MS): () => void {
  if (doc.visibilityState === "visible") load();
  return watchHealth(doc, load, everyMs);
}

/**
 * Orders the answers of reads that may overlap (a slow daemon answers after the next 5-second read went out): `ask` numbers
 * a read, `take` says whether its answer is newer than the one shown. Every answer that is newer is shown, however slow.
 */
export function latestAnswer(): { ask: () => number; take: (n: number) => boolean } {
  let asked = 0;
  let shown = 0;
  return {
    ask: () => ++asked,
    take: (n) => {
      if (n <= shown) return false;
      shown = n;
      return true;
    },
  };
}

/** The free-memory line: the free bytes against `ops-kit heavy`'s floor, and the share in use for the meter. null where the host has no /proc/meminfo. */
export function memoryLine(memory: OpsResources["memory"]): { free: string; floor: string; below: boolean; usedRatio: number; detail: string } | null {
  if (!memory) return null;
  return {
    free: fmtBytes(memory.availableBytes),
    floor: fmtBytes(memory.floorBytes),
    below: memory.availableBytes < memory.floorBytes,
    usedRatio: memory.totalBytes > 0 ? Math.min(1, Math.max(0, 1 - memory.availableBytes / memory.totalBytes)) : 0,
    detail: `全体 ${fmtBytes(memory.totalBytes)} · スワップ ${fmtBytes(memory.swapUsedBytes)} 使用`,
  };
}

/** A run named for a person: its Task's title (or the id of a Task this daemon does not know), or 「Task の外」. */
export function runOwner(r: { taskId: string | null; taskTitle: string | null }): string {
  return r.taskTitle ?? (r.taskId ? `Task ${r.taskId}` : "Task の外");
}

/** What a waiting run waits for: the slot's holders (Task and run), or the free memory against the floor. */
export function waitLine(wait: ResourceWait, running: ResourceRun[], memory: OpsResources["memory"]): string {
  if (wait.reason === "memory") {
    const m = memoryLine(memory);
    if (!m) return "空きメモリ（下限未満）";
    // the kit decided on its own read; this one may already be above the floor before its next look
    return m.below ? `空きメモリ ${m.free} < 下限 ${m.floor}` : `空きメモリ ${m.free}（下限 ${m.floor} を超えた。次の見回りで枠を見る）`;
  }
  return running.length ? `枠: ${running.map((r) => `${runOwner(r)} の ${r.name}`).join("、")}` : "枠（持ち主は終わったところ）";
}

/** How long since `iso`: 「45 秒」 under a minute, 「12 分」 under an hour, then 「1 時間 5 分」. */
export function since(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時間 ${m % 60} 分`;
}

/** The latest minute's rows, named: the Task (a link when there is one), the daemon, or the rest. */
export function consumerRows(c: NonNullable<OpsResources["consumers"]>): Array<{ key: string; taskId: string | null; taskTitle: string | null; label: string; kind: string; rss: string; procs: number }> {
  return c.groups.map((g) => ({
    key: `${g.owner}/${g.taskId ?? ""}/${g.kind}`,
    taskId: g.owner === "task" ? g.taskId : null,
    taskTitle: g.taskTitle,
    label: g.owner === "task" ? runOwner(g) : g.owner === "daemon" ? "デーモン" : "その他",
    kind: kindLabel[g.kind],
    rss: fmtBytes(g.rssBytes),
    procs: g.procs,
  }));
}

/** 「15:31 時点」: the minute the sampler's rows are from, in this browser's clock. */
export function atLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 時点`;
}
