import { z } from "zod";
import { Job } from "./job.ts";

/** Why a daemon run ended. */
export const StopReason = z.enum(["oomd", "restart", "host-stop", "promote", "crash", "unknown"]);
export type StopReason = z.infer<typeof StopReason>;
/** One JST day × cause: the stops, the turns they cut (one per task per stop) and the tasks. */
export const OpsStopsRow = z.object({ day: z.string(), reason: StopReason, stops: z.number(), turns: z.number(), taskIds: z.array(z.string()) });
export type OpsStopsRow = z.infer<typeof OpsStopsRow>;
/** `GET /api/ops/stops?days=`: the closed runs of the period, and the run in progress. */
export const OpsStops = z.object({ days: z.number(), rows: z.array(OpsStopsRow), running: z.object({ startedAt: z.number(), version: z.string().nullable() }).nullable() });
export type OpsStops = z.infer<typeof OpsStops>;

/** What a process of the daemon's unit is doing. */
export const LoadKind = z.enum(["runner", "subagent", "test", "browser", "docker", "build", "judge", "archive", "backlog", "other"]);
export type LoadKind = z.infer<typeof LoadKind>;
/** One JST hour of the unit's load: its peaks, and how many times it reached memory.max. */
export const OpsLoadHour = z.object({
  hour: z.string() /* JST "YYYY-MM-DD HH" */,
  maxMem: z.number(),
  memMax: z.number().nullable(),
  maxSwap: z.number(),
  limitHits: z.number(),
  maxCpuPct: z.number().nullable(),
  maxPressureFull: z.number().nullable(),
  maxDockerMem: z.number().nullable(),
});
export type OpsLoadHour = z.infer<typeof OpsLoadHour>;
/** Task × owner × kind over the period: the largest RSS of one minute, and the CPU time used. */
export const OpsLoadGroup = z.object({ taskId: z.string().nullable(), owner: z.enum(["task", "daemon", "other"]), kind: LoadKind, maxRss: z.number(), cpuMs: z.number() });
export type OpsLoadGroup = z.infer<typeof OpsLoadGroup>;
/** `GET /api/ops/load?days=&task=`. `available` false: this host has no cgroup v2 / /proc to read (macOS). */
export const OpsLoad = z.object({ available: z.boolean(), days: z.number(), hours: z.array(OpsLoadHour), groups: z.array(OpsLoadGroup) });
export type OpsLoad = z.infer<typeof OpsLoad>;
/** How a running job compares with the finished ones of its kind: `none` too few to say, `long` past twice their median. */
export const RunVerdict = z.enum(["none", "normal", "long"]);
export type RunVerdict = z.infer<typeof RunVerdict>;
/**
 * A job holding one of the machine's heavy-process slots (`ops-kit heavy`). `taskTitle` null: outside a Task, or a Task this daemon does not know.
 * `typicalMs`: the median time of the finished runs of its kind that ended with exit 0 (null: fewer than 3); `samples`: how many there were.
 */
export const ResourceRun = z.object({ pid: z.number(), name: z.string(), cwd: z.string(), taskId: z.string().nullable(), taskTitle: z.string().nullable(), queuedAt: z.string(), startedAt: z.string(), typicalMs: z.number().nullable(), samples: z.number(), verdict: RunVerdict });
export type ResourceRun = z.infer<typeof ResourceRun>;
/** A job waiting for a slot (`slot`) or for the free memory to rise above the floor (`memory`). `memoryOnly`: it takes no slot, so it does not count in when the slots are free. */
export const ResourceWait = z.object({ pid: z.number(), name: z.string(), cwd: z.string(), taskId: z.string().nullable(), taskTitle: z.string().nullable(), queuedAt: z.string(), reason: z.enum(["slot", "memory"]), memoryOnly: z.boolean(), typicalMs: z.number().nullable(), samples: z.number() });
export type ResourceWait = z.infer<typeof ResourceWait>;
/** A Task that waits for free memory (not for a run slot): the Task start's own judgment, in the queue's order. */
export const TaskWait = z.object({ taskId: z.string(), taskTitle: z.string().nullable(), queuedAt: z.string(), reason: z.literal("memory") });
export type TaskWait = z.infer<typeof TaskWait>;
/** A job as the resources screen lists it: without its summary and folder, with its Task's title (null: a Task this daemon does not know). */
export const OpsJob = Job.omit({ summary: true, cwd: true, repo: true, head: true, base: true, as: true, kinds: true, result: true }).extend({ taskTitle: z.string().nullable() });
export type OpsJob = z.infer<typeof OpsJob>;
/**
 * `GET /api/ops/resources`: now. `memory` null: no /proc/meminfo (macOS). `consumers` is the latest minute of
 * ops_load_groups (null: none in the last 7 days), largest RSS first. `eta`: ms from now until everything holding a slot and
 * waiting for one would be done (`beside` runs and `memoryOnly` waits take no slot and are left out) by their kinds' medians (null: nothing running or waiting); `unknown` runs had no median and are left out.
 */
export const OpsResources = z.object({
  memory: z.object({ availableBytes: z.number(), totalBytes: z.number(), swapUsedBytes: z.number(), floorBytes: z.number(), safetyBytes: z.number() }).nullable(),
  slots: z.object({ max: z.number(), running: z.array(ResourceRun), beside: z.array(ResourceRun), waiting: z.array(ResourceWait) }),
  eta: z.object({ etaMs: z.number().nullable(), unknown: z.number() }),
  /** The Tasks waiting for free memory (below the start's safety valve), in the queue's order. A wait for the run count is not in it. */
  taskWaits: z.array(TaskWait),
  consumers: z
    .object({
      at: z.number(),
      groups: z.array(z.object({ taskId: z.string().nullable(), taskTitle: z.string().nullable(), owner: z.enum(["task", "daemon", "other"]), kind: LoadKind, rssBytes: z.number(), procs: z.number() })),
    })
    .nullable(),
  /** The jobs Tasks asked the daemon for: running, and ended in the last 7 days, newest first. Waiting for a slot shows in `slots.waiting`. */
  jobs: z.array(OpsJob),
});
export type OpsResources = z.infer<typeof OpsResources>;
/** One method × route of api_requests: request count, nearest-rank p50 / p90 of ms, the p50 of the known bytes (null: none known). */
export const OpsLatencyStat = z.object({ method: z.string(), route: z.string(), count: z.number(), p50: z.number(), p90: z.number(), bytesP50: z.number().nullable() });
export type OpsLatencyStat = z.infer<typeof OpsLatencyStat>;
/** `GET /api/ops/latency?days=`: `total` over the whole period (largest p90 first), `byDay` per JST day (newest first). */
export const OpsLatency = z.object({ days: z.number(), total: z.array(OpsLatencyStat), byDay: z.array(OpsLatencyStat.extend({ day: z.string() })) });
export type OpsLatency = z.infer<typeof OpsLatency>;
