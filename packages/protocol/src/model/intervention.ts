import { z } from "zod";
import { StopReasonCode } from "../events.ts";

/**
 * A person's intervention, counted from Switchboard's records and the stored copy of the Issues — not kept as a table:
 * `approval` (a tool or question the person allowed / denied), `decision` (a `## 回答` on an Issue, a later message to a Task),
 * `resume` (a stage Task started by the button), `classifier` (an allow the person gave to an ask Claude Code's auto-mode
 * classifier stopped — `permission.ask` reason classifier — counted here instead of as an approval). `ref` points at the record: `comment:<node id>` / `task:<id>#seq:<n>` /
 * `task:<id>`. `afterWaits` is for a resume only: true = the PBI waited for something (a /pbi-complete release with `waits=`)
 * and all of it was closed before this start, false = it did not or something was still open, null = not known (a record missing).
 */
export const Intervention = z.object({
  kind: z.enum(["approval", "decision", "resume", "classifier"]),
  at: z.number(),
  workspaceId: z.string(),
  issue: z.number().nullable(),
  pbi: z.number().nullable(),
  taskId: z.string().nullable(),
  ref: z.string(),
  afterWaits: z.boolean().nullable(),
});
export type Intervention = z.infer<typeof Intervention>;

/** What could not be counted: shown as 不明, never as 0. `issue` null = the whole workspace. */
export const InterventionUnknown = z.object({ workspaceId: z.string(), issue: z.number().nullable(), why: z.string(), /** The PBI it belongs to when the Issue says so but the PBI is not stored. */ pbi: z.number().optional() });
export type InterventionUnknown = z.infer<typeof InterventionUnknown>;

/** Why people were needed: the stops of a period by reason, with the Issues and Tasks to look at. */
export const InterventionReason = z.object({
  reason: StopReasonCode,
  count: z.number(),
  /** Stops of this reason that did not go on by themselves: left exhausted or waiting, or a person intervened on the same Issue / Task after. */
  notAutoResumed: z.number(),
  /** The newest five. `url` is the Issue as stored; null when it names none or is not stored. */
  evidence: z.array(z.object({ workspaceId: z.string().nullable(), issue: z.number().nullable(), pbi: z.number().nullable(), taskId: z.string(), url: z.string().nullable(), evidence: z.string(), at: z.number() })),
});
export type InterventionReason = z.infer<typeof InterventionReason>;

/**
 * Interventions over `[from, to)` (ms) of `days` days. `total` / `byKind` are the interventions in it; `unknown` is how
 * many places could not be counted at all (a workspace never imported, an Issue not stored): they have no time, so it is the
 * same in every window, and a count shown with it is "at least". `completed` is over the PBIs closed in the window (all their
 * interventions, however old); `open` / `done` split the window's interventions by whether their PBI is open or closed now.
 */
export const InterventionWindow = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  from: z.number(),
  to: z.number(),
  total: z.number(),
  byKind: z.object({ approval: z.number(), decision: z.number(), resume: z.number(), classifier: z.number() }),
  unknown: z.number(),
  /** Stops that needed a person and stopped again after the person had answered the same one. */
  reAsks: z.number(),
  resumesAfterWaits: z.object({ count: z.number(), unknown: z.number() }),
  open: z.object({ pbis: z.number(), interventions: z.number() }),
  done: z.object({ pbis: z.number(), interventions: z.number() }),
  completed: z.object({ pbis: z.number(), perPbi: z.number().nullable(), unknownPbis: z.number() }),
  reasons: z.array(InterventionReason),
  /** Per repository: the `## 判断待ち` asked in the window, by how the ask went on (stopped = waited or no 進め方 line; proceeded = went on with the recommendation, `overturned` of them the person then overturned) and the median ms to the first `## 回答` (null = none answered). */
  questions: z.array(z.object({ workspaceId: z.string(), stopped: z.number(), proceeded: z.number(), overturned: z.number(), medianAnswerMs: z.number().nullable() })),
});
export type InterventionWindow = z.infer<typeof InterventionWindow>;

/** `GET /api/interventions`: the last 7 and 30 days, each against the period before it. */
export const InterventionView = z.object({
  now: z.number(),
  windows: z.array(z.object({ current: InterventionWindow, previous: InterventionWindow })),
});
export type InterventionView = z.infer<typeof InterventionView>;
