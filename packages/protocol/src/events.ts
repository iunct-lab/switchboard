import { z } from "zod";

/** Which runner produced a session. Adapters are plugins; any subset may be installed. */
export const RunnerId = z.enum(["claude", "codex", "dak"]);
export type RunnerId = z.infer<typeof RunnerId>;

export const PermissionKind = z.enum(["exec", "write", "network", "other"]);
export type PermissionKind = z.infer<typeof PermissionKind>;

export const PermissionDecision = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

/**
 * The user's reply to a question tool (Claude's AskUserQuestion): question text → chosen label(s) / free text. Checked
 * in place rather than with z.record, which rebuilds the object and drops a `__proto__` key — the question text is
 * the agent's, and its answer must not get lost on the way back.
 */
export const PermissionAnswers = z.custom<Record<string, string>>((v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string"));
export type PermissionAnswers = z.infer<typeof PermissionAnswers>;

/** Which Knowledge approval rule matched a permission.ask (issue #13). */
export const ApprovalRuleMatch = z.object({
  /** Knowledge path of the document, e.g. rules/dak.md */
  source: z.string(),
  pattern: z.string(),
  mode: z.enum(["confirm", "allow"]),
  /** The path or command the pattern matched. */
  subject: z.string(),
});
export type ApprovalRuleMatch = z.infer<typeof ApprovalRuleMatch>;

/**
 * Why work stopped (#939), as a code — never read from free text. `transient` = a network drop / timeout / HTTP 502·503·504;
 * `auth` / `permission` / `input` are never retried; `decision` = waiting on the person's answer; `depends` = waiting on
 * another Issue / PR; `unknown` = nothing said why (never joined with a stop whose evidence differs).
 */
export const StopReasonCode = z.enum(["usage-limit", "github-limit", "transient", "auth", "permission", "input", "decision", "depends", "unknown"]);
export type StopReasonCode = z.infer<typeof StopReasonCode>;

/** waiting = for a condition to change; retrying = a bounded retry is planned / running; exhausted = retries used up; resolved = went on. */
export const StopState = z.enum(["waiting", "retrying", "exhausted", "resolved"]);
export type StopState = z.infer<typeof StopState>;

const clip = (n: number) => z.string().transform((s) => s.slice(0, n));

/** One thing a stop waits on (#939): `key` names it (`pr#12`, `resetsAt`), `value` is how it stands, `met` = it no longer holds the work back. */
export const StopCondition = z.object({ key: clip(200), value: clip(200), met: z.boolean() });
export type StopCondition = z.infer<typeof StopCondition>;

/**
 * One stop of a piece of work (#939), recorded by the daemon as `stop.record`. Same work + op + target + reason = the same
 * series. `work`: the Issue it is for (workspace + number) or, with none, the task. `evidence` is a short reason in words
 * — never a credential or a command's raw output. `answer` = the person's newest answer known at the stop (`seq:<n>` of
 * a permission.resolved / send, or an Issue comment URL). `actions` = what was done about it (retries, with their result).
 * Over-long text and lists are cut rather than refused, so a stop is never lost to its own length.
 */
export const StopRecord = z.object({
  /** Never cut: it tells an update of a stop from a new one. */
  id: z.string().max(200),
  work: z.object({ workspaceId: z.string().nullable(), issue: z.number().int().positive().nullable(), taskId: z.string() }),
  op: clip(100),
  target: clip(200).default(""),
  reason: StopReasonCode.catch("unknown"),
  evidence: clip(300).default(""),
  /** Whether running it again is known to be harmless (#949): read-only, or it failed before it did anything. unknown = never retried by itself. */
  safety: z.enum(["read-only", "before-effect", "unknown"]).catch("unknown"),
  conditions: z.array(StopCondition).transform((a) => a.slice(-20)).default([]),
  answer: z.object({ ref: clip(300), at: z.number() }).nullable().default(null),
  actions: z.array(z.object({ attempt: z.number().int(), at: z.number().default(0), what: clip(200), ok: z.boolean().nullable() })).transform((a) => a.slice(-20)).default([]),
  state: StopState.catch("waiting"),
  at: z.number(),
});
export type StopRecord = z.infer<typeof StopRecord>;

/**
 * AgentEvent — the one event vocabulary every adapter normalizes into.
 * Everything above the adapter layer (store, ledger, UI) only knows this.
 */
export const AgentEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("cloud.session.created"), id: z.string(), url: z.string() }),
  z.object({
    t: z.literal("session.start"),
    runner: RunnerId,
    runnerSessionId: z.string().optional(),
    cwd: z.string(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    runnerVersion: z.string().optional(),
  }),
  z.object({ t: z.literal("status"), text: z.string() }),
  z.object({
    t: z.literal("message.delta"),
    role: z.enum(["assistant", "user"]),
    text: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    t: z.literal("tool.call"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    summary: z.string(),
  }),
  z.object({
    t: z.literal("tool.result"),
    id: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  z.object({
    t: z.literal("permission.ask"),
    id: z.string(),
    kind: PermissionKind,
    tool: z.string(),
    input: z.unknown(),
    detail: z.string(),
    toolUseId: z.string().optional(),
    /** Set by the daemon when a Knowledge approval rule matched (confirm → still asked, with the reason shown). */
    rule: ApprovalRuleMatch.optional(),
  }),
  z.object({
    t: z.literal("permission.resolved"),
    id: z.string(),
    decision: PermissionDecision,
    by: z.enum(["user", "rule", "timeout"]),
    /** The rule that decided, when by = rule. */
    rule: ApprovalRuleMatch.optional(),
  }),
  z.object({
    t: z.literal("usage"),
    /** reported = the runner itself reported cost; turn = per-API-call counters; estimated = we priced it */
    source: z.enum(["reported", "turn", "estimated"]),
    model: z.string().optional(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    /** The part of cacheWriteTokens written to the 1-hour cache (Claude; priced at 2x input, the rest at 1.25x). */
    cacheWrite1hTokens: z.number().optional(),
    costUsd: z.number().optional(),
    /**
     * true = the tokens and costUsd are this runner session's running total for `model` (Claude's `result`, #2353),
     * not this turn's: the daemon books the difference from the session's previous total.
     */
    cumulative: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("quota"),
    runner: RunnerId,
    /** e.g. { five_hour: {utilization: 0.16, resetsAt: 1788624600}, seven_day: {...} } */
    windows: z.record(z.object({ utilization: z.number(), resetsAt: z.number() })),
    /** The runner's own verdict, as reported (Claude `rate_limit_info.status`: allowed | allowed_warning | rejected …). */
    status: z.string().optional(),
    /** The window the runner names as the binding one (Claude `rateLimitType`, e.g. five_hour) — which reset to wait for (#102). */
    limitType: z.string().optional(),
  }),
  z.object({
    t: z.literal("artifact"),
    kind: z.enum(["diff", "file", "doc"]),
    path: z.string(),
    stat: z.string().optional(),
  }),
  /**
   * A file of the task's (#125): one the person attached to the turn that follows, or one the runner made (#124,
   * DAK's artifacts — recorded after the runner's `artifact(file)`). Always recorded by the daemon, never emitted by an
   * adapter. Bytes: GET /api/attachments/:id.
   */
  z.object({
    t: z.literal("attachment"),
    id: z.string(),
    name: z.string(),
    mime: z.string(),
    size: z.number(),
  }),
  /** A stop of the task's work (#939). Always recorded by the daemon, never emitted by an adapter. */
  z.object({ t: z.literal("stop.record"), stop: StopRecord }),
  /** The artifact an agent's `switchboard-artifact` fence registered (#1778). Recorded by the daemon, never emitted by an adapter. */
  z.object({ t: z.literal("artifact.saved"), id: z.string(), title: z.string() }),
  /**
   * How many background jobs the runner still has (Claude `system/background_tasks_changed`: run_in_background shells,
   * Monitors). A job's notification starts a turn on the runner's own, so the process is not released while any is left.
   */
  z.object({ t: z.literal("background"), count: z.number().int().nonnegative() }),
  z.object({
    t: z.literal("session.end"),
    status: z.enum(["ok", "error", "aborted"]),
    summary: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** Persisted / broadcast wrapper: every event belongs to a task and has a monotonic seq. */
export const EventEnvelope = z.object({
  taskId: z.string(),
  seq: z.number(),
  ts: z.number(),
  ev: AgentEvent,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
