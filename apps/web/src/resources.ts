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
  return duration(now - Date.parse(iso));
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時間 ${m % 60} 分`;
}

/** A run's usual time: 「14 分 · 28 件」 (the median of its kind's successful runs and how many), or 「実績なし」 under 3 of them. */
export function typicalLabel(row: Pick<ResourceRun | ResourceWait, "typicalMs" | "samples">): string {
  return row.typicalMs === null ? "実績なし" : `${duration(row.typicalMs)} · ${row.samples} 件`;
}

/** The running run against its usual time, in words (not by color alone). */
export function verdictLabel(run: Pick<ResourceRun, "verdict">): string {
  return { none: "実績なし", normal: "普段どおり", long: "普段の 2 倍より長い" }[run.verdict];
}

/**
 * 「全部終わるまでの目安」: 「約 38 分」 and the runs left out for having no record; 「待ちはありません」 when nothing runs or
 * waits; 「実績なし」 when every one of the `jobs` running and waiting has no record (a 0 left of nothing known is not 「1 分以内」).
 */
export function etaLine(eta: OpsResources["eta"], jobs: number): { value: string; note: string | null } {
  if (eta.etaMs === null) return { value: "待ちはありません", note: null };
  if (eta.unknown >= jobs) return { value: "実績なし", note: `実績の無い ${eta.unknown} 件` };
  return { value: eta.etaMs < 60_000 ? "1 分以内" : `約 ${duration(eta.etaMs)}`, note: eta.unknown > 0 ? `実績の無い ${eta.unknown} 件を除く` : null };
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
