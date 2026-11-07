import type { OpsJob, OpsResources, ResourceRun, ResourceWait } from "@switchboard/protocol";
import { watchHealth } from "./healthWatch.ts";
import { fmtBytes, kindLabel } from "./ops.ts";
import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";

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
    detail: t(common.resMemoryDetail, { total: fmtBytes(memory.totalBytes), swap: fmtBytes(memory.swapUsedBytes) }),
  };
}

/** A run named for a person: its Task's title (or the id of a Task this daemon does not know), or 「Task の外」. */
export function runOwner(r: { taskId: string | null; taskTitle: string | null }): string {
  return r.taskTitle ?? (r.taskId ? `Task ${r.taskId}` : t(common.resOutsideTask));
}

/** What a waiting run waits for: the slot's holders (Task and run), or the free memory against the floor. */
export function waitLine(wait: ResourceWait, running: ResourceRun[], memory: OpsResources["memory"]): string {
  if (wait.reason === "memory") {
    const m = memoryLine(memory);
    if (!m) return t(common.resWaitMemoryUnknown);
    // the kit decided on its own read; this one may already be above the floor before its next look
    return t(m.below ? common.resWaitMemoryBelow : common.resWaitMemoryAbove, { free: m.free, floor: m.floor });
  }
  return running.length ? t(common.resWaitSlot, { holders: running.map((r) => t(common.resSlotHolder, { owner: runOwner(r), name: r.name })).join(t(common.resSlotHolderSep)) }) : t(common.resWaitSlotGone);
}

/** How long since `iso`: 「45 秒」 under a minute, 「12 分」 under an hour, then 「1 時間 5 分」. */
export function since(iso: string, now: number): string {
  return duration(now - Date.parse(iso));
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t(common.resSeconds, { n: s });
  const m = Math.floor(s / 60);
  return m < 60 ? t(common.resMinutes, { n: m }) : t(common.resHoursMinutes, { h: Math.floor(m / 60), m: m % 60 });
}

/** A run's usual time: 「14 分 · 28 件」 (the median of its kind's successful runs and how many), or 「実績なし」 under 3 of them. */
export function typicalLabel(row: Pick<ResourceRun | ResourceWait, "typicalMs" | "samples">): string {
  return row.typicalMs === null ? t(common.resNoHistory) : t(common.resTypical, { time: duration(row.typicalMs), n: row.samples });
}

/** The running run against its usual time, in words (not by color alone). */
export function verdictLabel(run: Pick<ResourceRun, "verdict">): string {
  return { none: t(common.resNoHistory), normal: t(common.resVerdictNormal), long: t(common.resVerdictLong) }[run.verdict];
}

/**
 * 「全部終わるまでの目安」: 「約 38 分」 and the runs left out for having no record; 「待ちはありません」 when nothing runs or
 * waits; 「実績なし」 when every one of the `jobs` running and waiting has no record (a 0 left of nothing known is not 「1 分以内」).
 */
export function etaLine(eta: OpsResources["eta"], jobs: number): { value: string; note: string | null } {
  if (eta.etaMs === null) return { value: t(common.resNoWaits), note: null };
  if (eta.unknown >= jobs) return { value: t(common.resNoHistory), note: t(common.resUnknownAll, { n: eta.unknown }) };
  return { value: eta.etaMs < 60_000 ? t(common.resUnderMinute) : t(common.resAbout, { time: duration(eta.etaMs) }), note: eta.unknown > 0 ? t(common.resUnknownSome, { n: eta.unknown }) : null };
}

/** The latest minute's rows, named: the Task (a link when there is one), the daemon, or the rest. */
export function consumerRows(c: NonNullable<OpsResources["consumers"]>): Array<{ key: string; taskId: string | null; taskTitle: string | null; label: string; kind: string; rss: string; procs: number }> {
  return c.groups.map((g) => ({
    key: `${g.owner}/${g.taskId ?? ""}/${g.kind}`,
    taskId: g.owner === "task" ? g.taskId : null,
    taskTitle: g.taskTitle,
    label: g.owner === "task" ? runOwner(g) : g.owner === "daemon" ? t(common.resDaemon) : t(common.resOther),
    kind: kindLabel[g.kind],
    rss: fmtBytes(g.rssBytes),
    procs: g.procs,
  }));
}

/**
 * A job's row on the resources screen (#3995): its kind (with the review's runner), its status in words (not by color
 * alone; a failure with its exit code), and how long it has run or ran.
 */
export function jobRow(job: OpsJob, now: number): { kind: string; status: string; elapsed: string } {
  const status =
    job.status === "running" ? t(common.resJobRunning) : job.status === "pass" ? t(common.resJobPass) : job.status === "fail" ? t(common.resJobFail, { code: job.exitCode ?? "-" }) : t(common.resJobAborted);
  return { kind: job.runner ? `${job.kind} (${job.runner})` : job.kind, status, elapsed: duration((job.endedAt ?? now) - job.startedAt) };
}

/** 「15:31 時点」: the minute the sampler's rows are from, in this browser's clock. */
export function atLabel(ms: number): string {
  const d = new Date(ms);
  return t(common.resAt, { time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` });
}
