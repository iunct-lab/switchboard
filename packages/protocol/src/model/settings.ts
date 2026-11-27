import { z } from "zod";
import { RunnerId } from "../events.ts";
import { SettingsPrice } from "./pricing.ts";
import { ModelOption } from "./runner.ts";

/** The name of the Settings field of `quotaAndResume.flowLimit`: the screen's label and the log line that points at it are this one. */
export const FLOW_LIMIT_FIELD = "開発の流れの同時の上限";

/**
 * LLM routing suggestions. The runner is asked through its own adapter (Switchboard holds no API key), so the
 * choice of runner and model decides whose subscription quota a task creation spends. `model` empty = the CLI default.
 */
export const LlmRoutingSettings = z
  .object({
    enabled: z.boolean().default(false),
    runner: RunnerId.default("claude"),
    model: z.string().default(""),
    /** "" = the runner's default (`defaultEffort`, else the CLI's). */
    effort: z.string().default(""),
    /**
     * How long a task creation waits for the suggestion before going with the rule table alone. The default is the
     * 5 s the design asks for, but a real `claude -p` turn (CLI start + extended thinking) measured ~12 s, so it is
     * a knob: raising it trades a slower Create button for actually getting a suggestion.
     */
    timeoutMs: z.number().int().min(1000).max(60_000).default(5000),
  })
  .prefault({});
export type LlmRoutingSettings = z.infer<typeof LlmRoutingSettings>;

export const RoutingSettings = z.object({ llm: LlmRoutingSettings }).prefault({});
export type RoutingSettings = z.infer<typeof RoutingSettings>;

/**
 * The automatic judgement at the end of a turn: one read-only turn of this runner reads the last reply and
 * says whether the task is done or waiting on the person. On by default with Codex (the person's choice,
 * 2026-09-28); when it cannot answer, Claude Haiku is asked once instead (`judgeAndChoice.judgeFallbackRunner` / `judgeFallbackModel`).
 */
export const JudgeSettings = z
  .object({
    enabled: z.boolean().default(true),
    runner: RunnerId.default("codex"),
    model: z.string().default("gpt-6-luna"),
    /** "" = the runner's default (`defaultEffort`, else the CLI's). */
    effort: z.string().default(""),
    /** The rubric judge's input caps in characters: the transcript, the person's later messages in all, and each of them. */
    recapChars: z.number().int().positive().default(12_000),
    laterChars: z.number().int().positive().default(4_000),
    laterEachChars: z.number().int().positive().default(600),
    /** For a stage Task: the PBI's story and out-of-scope (each), and the source request's `## 要望`, in characters. */
    pbiChars: z.number().int().positive().default(800),
    requestChars: z.number().int().positive().default(800),
    /** The skills the request names, all together, in characters. */
    skillChars: z.number().int().positive().default(20_000),
  })
  .prefault({});
export type JudgeSettings = z.infer<typeof JudgeSettings>;

/**
 * Evals: the rubric judge at the end of a `done` turn. On by default, like the two-way judge; the runner and
 * model are the `judge` setting's (one setting, one subscription), so this only switches it off.
 */
export const EvalsSettings = z.object({ judge: z.object({ enabled: z.boolean().default(true) }).prefault({}) }).prefault({});
export type EvalsSettings = z.infer<typeof EvalsSettings>;

/**
 * Naming a task after its first turn. On by default: it spends a runner's quota once per task. Codex `gpt-6-luna`
 * (the person's choice, 2026-09-28, the same answer as the judge's); when it cannot answer, the judge's fallback is asked.
 * `model` / `effort` empty = the runner's default.
 */
export const TitlesSettings = z.object({ auto: z.boolean().default(true), runner: RunnerId.default("codex"), model: z.string().default("gpt-6-luna"), effort: z.string().default("") }).prefault({});
export type TitlesSettings = z.infer<typeof TitlesSettings>;

/**
 * The kinds of Task that start by themselves: the feedback modes (`FeedbackInput.mode`) and the backlog stages
 * (`BacklogAction`), under their own names.
 */
export const AutoStartKind = z.enum(["fix", "request", "to-pbi", "to-tasks", "complete", "check", "close", "direct", "new-repo", "upstream-sync", "adopt-repo", "baseline", "bundle"]);
export type AutoStartKind = z.infer<typeof AutoStartKind>;

/**
 * One kind's own runner / model / effort / permission mode; `model` / `effort` empty = that runner's CLI default.
 * No `runner` = the kind follows the common (or the schedule's) runner and changes only the rest; `permissionMode`
 * absent = the runner's default. `budgetUsd` absent = the schedule's / the settings' default; `shadow` absent = the
 * common 並走, "off" = none, a runner = mirror to it.
 */
export const AutoStartChoice = z.object({ runner: RunnerId.optional(), model: z.string().default(""), effort: z.string().default(""), permissionMode: z.string().optional(), budgetUsd: z.number().positive().optional(), shadow: z.union([z.literal("off"), RunnerId]).optional() });
export type AutoStartChoice = z.infer<typeof AutoStartChoice>;

/**
 * What a Task that starts by itself runs on: the backlog stage buttons and the feedback button. A schedule has
 * its own runner / model / effort. `model` / `effort` empty = that runner's CLI default. `byKind`: a
 * kind with its own choice starts on it; a kind without one follows these common values (a schedule, its own).
 */
export const AutoStartSettings = z
  .object({
    runner: RunnerId.default("claude"),
    model: z.string().default(""),
    effort: z.string().default(""),
    byKind: z
      .object({
        fix: AutoStartChoice.optional(),
        request: AutoStartChoice.optional(),
        "to-pbi": AutoStartChoice.optional(),
        "to-tasks": AutoStartChoice.optional(),
        complete: AutoStartChoice.optional(),
        check: AutoStartChoice.optional(),
        close: AutoStartChoice.optional(),
        direct: AutoStartChoice.optional(),
        "new-repo": AutoStartChoice.optional(),
        "upstream-sync": AutoStartChoice.optional(),
        "adopt-repo": AutoStartChoice.optional(),
        baseline: AutoStartChoice.optional(),
        bundle: AutoStartChoice.optional(),
      })
      .prefault({}),
    /**
     * 上限のときの代わり: while the decided runner has a usage window at `fallbackAt` or more that has not reset,
     * the next usable runner of this order starts the Task instead, on its CLI default model. Empty = no switch.
     */
    fallback: z.array(RunnerId).default([]),
    fallbackAt: z.number().min(0.5).max(1).default(0.9),
    /**
     * Task ごとの実装のモデル: the model an 実装 Task (/pbi-complete) hands each Task's implementation
     * to, as a subagent; reviews, merge decisions and closing stay on the kind's own model. Empty = 同じ (no paragraph,
     * as before). Claude only.
     */
    completeTaskModel: z.string().default(""),
  })
  .prefault({});
export type AutoStartSettings = z.infer<typeof AutoStartSettings>;

/** The kernel's own tunables (the part of the Tasks that picks by evidence). */
const kernelFields = {
  /** The share of Tasks (a ratio of counts, 0 to 1) spent on exploring instead of the best-known choice. A count, not a cost: a cost is known only as an estimate, and a count can be compared with the strata's n as it is. */
  explorationShare: z.number().min(0).max(1),
};

/**
 * Values the person may want to tune while running, one group per section of the settings screen. The ranges
 * are written once here (no defaults) and used by both `Settings` (with the defaults) and `SettingsPatch` (partial).
 * The defaults are the constants core used before; those constants stay in core as the source of the defaults.
 */
const quotaAndResumeFields = {
  /** backlog-next holds back to one stage Task overall when the Claude usage is at or above this (`QUOTA_LIMIT`). */
  backlogQuotaLimit: z.number().gt(0).max(1),
  /** Wait before resuming a usage-limit stop whose reset time is unknown; doubles per attempt up to `retryMaxDelayMs`. */
  retryDelayMs: z.number().int().min(60_000).max(86_400_000),
  retryMaxDelayMs: z.number().int().min(60_000).max(86_400_000),
  /** Give up resuming after this many usage-limit stops in a row (`MAX_CONSECUTIVE_STOPS`). */
  maxLimitStops: z.number().int().min(1).max(100),
  /** The text sent on a usage-limit resume. The daemon puts `[Switchboard 自動再開] ` before it, so it is still told apart. */
  resumePrompt: z.string().trim().min(1).max(2000),
  /** How many times a Task stopped by a daemon stop is resumed (`MAX_STOP_RESUMES`). */
  maxStopResumes: z.number().int().min(1).max(10),
  /** A Task in a turn, or on its runner's background jobs, with no event for this long is shown as 応答なし (`WAIT_BOUNDS.silentMs`). */
  silentAfterMs: z.number().int().min(60_000).max(86_400_000),
  /** The longest a wait for something this machine does itself may last before the person is told: a job, a run slot, a resume that is due (`WAIT_BOUNDS.ownMs`). */
  waitLimitMs: z.number().int().min(60_000).max(30 * 86_400_000),
  /** How long the backlog queue may start nothing (enabled, none of its 実装 Tasks running, not for the usage limit) before the person is told. */
  queueStallMs: z.number().int().min(60_000).max(86_400_000),
  /** The longest a wait for someone else's work may last before the person is told: a PR or an Issue of another Task, a stop with no end of its own (`WAIT_BOUNDS.othersMs`). */
  dependsLimitMs: z.number().int().min(60_000).max(30 * 86_400_000),
  /** The runner comparison marks a row with fewer Tasks than this as a thin sample (`THIN_SAMPLE` in web). */
  thinSample: z.number().int().min(1).max(1000),
  /** At most this many flow-improvement PBIs are in progress at once; backlog-next starts no more (P0 excepted). */
  flowLimit: z.number().int().min(0).max(100),
  /** The most the `flow-improvement` work may take of the week's usage (0〜1); backlog-next starts no more of it above this (P0 excepted). */
  flowShareLimit: z.number().min(0).max(1),
  /** The budget (USD) of a Task made without one (a request, a schedule with none). null = no budget. Cost caps live in this group: this, `fableBudgetUsd` and `backlogQuotaLimit`. */
  defaultBudgetUsd: z.number().positive().max(10_000).nullable(),
  /** Fable の Task に、予算が無ければ付ける既定の予算。Fable の Task では `defaultBudgetUsd` より先に使う。null = 付けない */
  fableBudgetUsd: z.number().positive().max(10_000).nullable(),
};
const judgeAndChoiceFields = {
  /** Asked once when the judge's runner cannot answer (`JUDGE_FALLBACK`). */
  judgeFallbackRunner: RunnerId,
  judgeFallbackModel: z.string().max(200),
  judgeFallbackEffort: z.string().max(50),
  /** How long one judge turn may take (`JUDGE_TIMEOUT_MS`). */
  judgeTimeoutMs: z.number().int().min(1000).max(600_000),
  /**
   * How long the automatic Workspace choice of a task creation may take before the creation is refused (409). Kept
   * apart from the suggestion's `timeoutMs`: that one is a soft deadline (go with the rule table), this one is a hang
   * guard and must not be shortened by tuning the suggestion.
   */
  workspaceChoiceTimeoutMs: z.number().int().min(1000).max(600_000),
};
const newDefaultsFields = {
  /** The runner Home's creation form starts on. */
  taskRunner: RunnerId,
  /** The model and thinking effort Home's creation form starts on for that runner. "" = the runner's default. */
  taskModel: z.string().max(200),
  taskEffort: z.string().max(50),
  /** The cron a new schedule starts with. Checked with core's `parseCron` on PATCH. */
  scheduleCron: z.string().trim().min(1).max(100),
};

/** How a new version is found and brought in under sb-rescue (the settings screen's 動いている版). */
const releaseFields = {
  /** How often the daemon reads the newest release tag. */
  checkMinutes: z.number().int().min(1).max(1440),
  /**
   * How far a new version found is taken by itself: `promote` = its diff is checked (a public copy) and it is promoted,
   * `review` = only the check starts and the person promotes it, `off` = neither (the screen shows the new version).
   * A promotion asked for by a Task or by the person is outside this.
   */
  auto: z.enum(["promote", "review", "off"]),
  /**
   * The longest a promotion waiting for the Tasks a restart would cut (running, stopped on an approval or a question,
   * with background jobs) keeps new turns from starting. Past it new turns start again and the person is told; no Task
   * is cut for it, and the promotion keeps waiting.
   */
  drainMinutes: z.number().int().min(5).max(1440),
  /**
   * What the tag CI must have said before a tag of a development origin is promoted by itself: `no-fail` (the default:
   * a promotion does not wait for the tag CI) = any tag without a recorded fail, `pass` = only a tag with a pass.
   * A tag that failed is never promoted by itself. A tag held by either is told in 判断待ち.
   */
  tagCi: z.enum(["pass", "no-fail"]),
};
export const ReleaseSettings = z
  .object({
    checkMinutes: releaseFields.checkMinutes.default(10),
    auto: releaseFields.auto.default("promote"),
    drainMinutes: releaseFields.drainMinutes.default(60),
    tagCi: releaseFields.tagCi.default("no-fail"),
  })
  .prefault({});
export type ReleaseSettings = z.infer<typeof ReleaseSettings>;

/** How the host's Claude Code and Codex CLIs are brought up to date (docs/design/cli-update.md): how often the distributor is read, how long a version is let age, what to do with one that has no checksum or signature, and how far it is tried. */
const cliUpdateFields = {
  /** How often the daemon reads the distributors' newest versions. */
  checkMinutes: z.number().int().min(1).max(1440),
  /** How many hours a version must have been out before it is taken (0 = at once). */
  waitHours: z.number().int().min(0).max(720),
  /** What to do with a version whose checksum or signature the distributor does not publish: `refuse` = keep it out, `allow` = take it after the other checks. A checksum or signature that does not match is always refused. */
  missingSignature: z.enum(["refuse", "allow"]),
  /** What a new version must pass before the link moves: `turn` = `--version` and one read-only turn, `version` = `--version` only. */
  smoke: z.enum(["turn", "version"]),
};
export const CliUpdateSettings = z
  .object({
    checkMinutes: cliUpdateFields.checkMinutes.default(60),
    waitHours: cliUpdateFields.waitHours.default(0),
    missingSignature: cliUpdateFields.missingSignature.default("refuse"),
    smoke: cliUpdateFields.smoke.default("turn"),
  })
  .prefault({});
export type CliUpdateSettings = z.infer<typeof CliUpdateSettings>;

export const QuotaAndResumeSettings = z
  .object({
    backlogQuotaLimit: quotaAndResumeFields.backlogQuotaLimit.default(0.8),
    retryDelayMs: quotaAndResumeFields.retryDelayMs.default(15 * 60_000),
    retryMaxDelayMs: quotaAndResumeFields.retryMaxDelayMs.default(4 * 3600_000),
    maxLimitStops: quotaAndResumeFields.maxLimitStops.default(8),
    resumePrompt: quotaAndResumeFields.resumePrompt.default("使用上限がリセットされました。中断した箇所から作業を続けてください。"),
    maxStopResumes: quotaAndResumeFields.maxStopResumes.default(2),
    silentAfterMs: quotaAndResumeFields.silentAfterMs.default(10 * 60_000),
    waitLimitMs: quotaAndResumeFields.waitLimitMs.default(6 * 3600_000),
    queueStallMs: quotaAndResumeFields.queueStallMs.default(3_600_000),
    dependsLimitMs: quotaAndResumeFields.dependsLimitMs.default(3 * 86_400_000),
    thinSample: quotaAndResumeFields.thinSample.default(5),
    flowLimit: quotaAndResumeFields.flowLimit.default(1),
    flowShareLimit: quotaAndResumeFields.flowShareLimit.default(0.25),
    defaultBudgetUsd: quotaAndResumeFields.defaultBudgetUsd.default(null),
    fableBudgetUsd: quotaAndResumeFields.fableBudgetUsd.default(null),
  })
  .prefault({});
export type QuotaAndResumeSettings = z.infer<typeof QuotaAndResumeSettings>;

export const KernelSettings = z
  .object({
    explorationShare: kernelFields.explorationShare.default(0.1),
  })
  .prefault({});
export type KernelSettings = z.infer<typeof KernelSettings>;

export const JudgeAndChoiceSettings = z
  .object({
    judgeFallbackRunner: judgeAndChoiceFields.judgeFallbackRunner.default("claude"),
    judgeFallbackModel: judgeAndChoiceFields.judgeFallbackModel.default("claude-haiku-4-5"),
    judgeFallbackEffort: judgeAndChoiceFields.judgeFallbackEffort.default(""),
    judgeTimeoutMs: judgeAndChoiceFields.judgeTimeoutMs.default(60_000),
    workspaceChoiceTimeoutMs: judgeAndChoiceFields.workspaceChoiceTimeoutMs.default(60_000),
  })
  .prefault({});
export type JudgeAndChoiceSettings = z.infer<typeof JudgeAndChoiceSettings>;

export const NewDefaultsSettings = z
  .object({
    taskRunner: newDefaultsFields.taskRunner.default("claude"),
    taskModel: newDefaultsFields.taskModel.default(""),
    taskEffort: newDefaultsFields.taskEffort.default(""),
    scheduleCron: newDefaultsFields.scheduleCron.default("0 3 * * *"),
  })
  .prefault({});
export type NewDefaultsSettings = z.infer<typeof NewDefaultsSettings>;

/**
 * Who reviews a PR: the runner other than the one that implemented it, or a new session of the same runner. It reaches a
 * Task as text (the skills placed at its start are rendered for it; the stage prompts name the reviewer by it) and decides
 * the runner of a review job when the job is asked for.
 */
export const ReviewRunnerChoice = z.enum(["other", "same"]);
export type ReviewRunnerChoice = z.infer<typeof ReviewRunnerChoice>;

/** Daemon settings the UI can change. Stored in sqlite; `~/.switchboard` files stay for the other knobs. */
export const Settings = z.object({
  /** runner → permission mode used when a task is created without one. Absent = the adapter's own default. */
  defaultPermissionMode: z.record(z.string(), z.string()).default({}),
  /** runner → thinking effort of the subagents a task starts (CLAUDE_CODE_SUBAGENT_EFFORT). Absent = same as the task. */
  subagentEffort: z.record(z.string(), z.string()).default({}),
  /** runner → model of the subagents a task starts (CLAUDE_CODE_SUBAGENT_MODEL). Absent = same as the task. */
  subagentModel: z.record(z.string(), z.string()).default({}),
  /** runner → model / thinking effort used when a Task is started by hand or by itself without them. Absent = the CLI's own default. */
  defaultModel: z.record(z.string(), z.string()).default({}),
  defaultEffort: z.record(z.string(), z.string()).default({}),
  /** runner → resume a task stopped on the usage limit once it lifts. Absent = off. */
  autoResume: z.record(z.string(), z.boolean()).default({}),
  /** Shadow run: runner every new task is mirrored to unless the creation says otherwise; null = off. */
  shadowRunner: RunnerId.nullable().default(null),
  /**
   * Whether this instance develops Switchboard itself. false: the backlog does not read the meta workspace (no gh call,
   * no row). The key's absence = true, so a database and a test that never set it behave as before; a new HOME starts with false
   * (`seedNewHome`, written by main.ts).
   */
  developSelf: z.boolean().default(true),
  /** Whether the backlog's automatic processing starts a small request in the direct candidate by its `auto` criteria, in every registered workspace alike. false: it never does, anywhere (the row's button is separate). */
  autoDirect: z.boolean().default(true),
  /** LLM runner suggestions. Off by default: switching it on spends the runner's quota on every task creation. */
  routing: RoutingSettings.prefault({}),
  /** Judge each finished turn as done / needs action. On by default: it spends the runner's quota once per turn. */
  judge: JudgeSettings.prefault({}),
  /** Runner and model of the Tasks that start by themselves. */
  autoStart: AutoStartSettings.prefault({}),
  /** Main reviewer of a PR (`ReviewRunnerChoice` says where it takes effect). */
  reviewRunner: ReviewRunnerChoice.default("other"),
  /**
   * Who reads a recheck and a post-merge audit, relative to the main reviewer: `other` = the runner that is not the main
   * reviewer, `same` = a new session of the main reviewer's runner. Unset = the review setting's value (`recheckSetting`).
   */
  recheckRunner: ReviewRunnerChoice.optional(),
  /** runner → model / thinking effort a review job (main review, recheck, audit) runs with. Absent = the Task's default (`defaultModel` / `defaultEffort`). */
  reviewModel: z.record(z.string(), z.string()).default({}),
  reviewEffort: z.record(z.string(), z.string()).default({}),
  /** How many local Tasks the daemon lets be running / waiting at once; the rest wait for a free slot. */
  maxRunners: z.number().int().min(1).max(8).default(3),
  /** The rubric judge. */
  evals: EvalsSettings.prefault({}),
  /** Name a task after its first turn. */
  titles: TitlesSettings.prefault({}),
  /** Usage threshold and automatic resume. */
  quotaAndResume: QuotaAndResumeSettings.prefault({}),
  /** The kernel's exploration share. */
  kernel: KernelSettings.prefault({}),
  /** The judge's fallback and timeouts, the Workspace choice's timeout. */
  judgeAndChoice: JudgeAndChoiceSettings.prefault({}),
  /** What the creation forms start with. */
  newDefaults: NewDefaultsSettings.prefault({}),
  /** The interval of the check for a new version, how far it goes by itself, and the limit of the wait before a promotion. */
  release: ReleaseSettings.prefault({}),
  /** How the host's Claude Code and Codex CLIs are updated: the interval, the wait, and the two checks. */
  cliUpdate: CliUpdateSettings.prefault({}),
  /**
   * runner → region of Amazon Bedrock. Absent = the runner runs on its own login (the Claude account). Only
   * what the user chose is saved: no key, no profile; the CLI reads AWS credentials its own way (docs/design/bedrock.md).
   */
  bedrock: z.record(z.string(), z.object({ region: z.string() })).default({}),
  /** model → price (USD / 1M tokens) over pricing.json's row of the same model; read on every use, no restart. */
  prices: z.record(z.string(), SettingsPrice).default({}),
  /**
   * runner → the model choices, in the order shown. Absent = the adapter's bundled list. Replaces the list of
   * the runner's own login only: on Amazon Bedrock the ids are spelled differently and the adapter's Bedrock list stays.
   */
  models: z.record(z.string(), z.array(ModelOption)).default({}),
  /**
   * runner → the CLI's model ids left out of the list on purpose: not offered as candidates by 「CLI の表を読む」.
   * Absent = the ids the bundled list leaves out (the daemon's SHIPPED_HIDDEN_MODELS).
   */
  hiddenModels: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * What leaves the machine (each off by default). classifierLog: Claude's OpenTelemetry `tool_decision` logs, sent to the
   * daemon's own loopback to keep the classifier's verdicts. runnerTelemetry: the runner CLIs' own telemetry and update checks.
   */
  outbound: z.object({ classifierLog: z.boolean().default(false), runnerTelemetry: z.boolean().default(false) }).prefault({}),
});
export type Settings = z.infer<typeof Settings>;

/** The recheck and post-merge audit setting in effect: the saved one, else the review setting's value. */
export const recheckSetting = (s: Pick<Settings, "recheckRunner" | "reviewRunner">): ReviewRunnerChoice => s.recheckRunner ?? s.reviewRunner;

/**
 * GET /api/settings/model-candidates: per runner, the models of the installed CLI's table that are neither
 * listed nor hidden, or why the table could not be read.
 */
export const ModelCandidates = z.array(
  z.union([z.object({ runner: RunnerId, candidates: z.array(ModelOption) }), z.object({ runner: RunnerId, error: z.string() })]),
);
export type ModelCandidates = z.infer<typeof ModelCandidates>;

const autoStartChoicePatch = z.object({ runner: RunnerId, model: z.string(), effort: z.string(), permissionMode: z.string().nullable(), budgetUsd: z.number().positive().nullable(), shadow: z.union([z.literal("off"), RunnerId]).nullable() }).partial().nullable();

/** PATCH body: null removes the override (back to the adapter default / off). */
/**
 * PATCH /api/settings. Every key may be null: the whole key goes back to its default (`Settings.parse({})`), which is how
 * every card's 既定に戻す works. Inside a key, a value is put back by sending its default (GET's `defaults`).
 */
export const SettingsPatch = z.object({
  defaultPermissionMode: z.record(z.string(), z.string().nullable()).nullable().optional(),
  subagentEffort: z.record(z.string(), z.string().nullable()).nullable().optional(),
  subagentModel: z.record(z.string(), z.string().nullable()).nullable().optional(),
  defaultModel: z.record(z.string(), z.string().nullable()).nullable().optional(),
  defaultEffort: z.record(z.string(), z.string().nullable()).nullable().optional(),
  autoResume: z.record(z.string(), z.boolean().nullable()).nullable().optional(),
  /** null = back to the runner's own login. */
  bedrock: z.record(z.string(), z.object({ region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/) }).nullable()).nullable().optional(),
  /** The whole list per runner; null = back to the adapter's bundled list. */
  models: z.record(z.string(), z.array(ModelOption).nullable()).nullable().optional(),
  /**
   * The whole 載せない list per runner, replacing the saved one — not added to SHIPPED_HIDDEN_MODELS: to hide
   * one more id, send the current list (the saved one, else GET /api/settings' `defaults.hiddenModels`) with it. [] hides
   * nothing; null = back to the bundled list's (SHIPPED_HIDDEN_MODELS).
   */
  hiddenModels: z.record(z.string(), z.array(z.string()).nullable()).nullable().optional(),
  shadowRunner: RunnerId.nullable().optional(),
  developSelf: z.boolean().nullable().optional(),
  autoDirect: z.boolean().nullable().optional(),
  /** Partial: `{ outbound: { classifierLog: true } }` leaves the other value alone. */
  outbound: z.object({ classifierLog: z.boolean(), runnerTelemetry: z.boolean() }).partial().nullable().optional(),
  /** Partial: `{ routing: { llm: { enabled: true } } }` leaves the saved runner / model alone. */
  routing: z.object({ llm: z.object({ enabled: z.boolean(), runner: RunnerId, model: z.string(), effort: z.string(), timeoutMs: z.number().int().min(1000).max(60_000) }).partial().optional() }).partial().nullable().optional(),
  /** Partial: `{ judge: { enabled: false } }` leaves the saved runner / model alone. */
  judge: z.object({ enabled: z.boolean(), runner: RunnerId, model: z.string(), effort: z.string(), recapChars: z.number().int().positive(), laterChars: z.number().int().positive(), laterEachChars: z.number().int().positive(), pbiChars: z.number().int().positive(), requestChars: z.number().int().positive(), skillChars: z.number().int().positive() }).partial().nullable().optional(),
  /**
   * Partial: `{ autoStart: { model: "x" } }` leaves the saved runner alone. `byKind`: a partial choice per kind
   * over that kind's saved one (else the common values); `null` = back to the common values.
   */
  autoStart: z
    .object({
      runner: RunnerId,
      model: z.string(),
      effort: z.string(),
      byKind: z
        .object({
          fix: autoStartChoicePatch,
          request: autoStartChoicePatch,
          "to-pbi": autoStartChoicePatch,
          "to-tasks": autoStartChoicePatch,
          complete: autoStartChoicePatch,
          check: autoStartChoicePatch,
          close: autoStartChoicePatch,
          direct: autoStartChoicePatch,
          "new-repo": autoStartChoicePatch,
          "upstream-sync": autoStartChoicePatch,
          "adopt-repo": autoStartChoicePatch,
          baseline: autoStartChoicePatch,
          bundle: autoStartChoicePatch,
        })
        .partial(),
      /** Replaces the whole order. */
      fallback: z.array(RunnerId),
      fallbackAt: z.number().min(0.5).max(1),
      /** "" = 同じ. */
      completeTaskModel: z.string(),
    })
    .partial()
    .nullable().optional(),
  reviewRunner: ReviewRunnerChoice.nullable().optional(),
  /** null = unset again (the review setting's value). */
  recheckRunner: ReviewRunnerChoice.nullable().optional(),
  /** runner → model / effort of a review job; a value null removes it (back to the Task's default). */
  reviewModel: z.record(z.string(), z.string().nullable()).nullable().optional(),
  reviewEffort: z.record(z.string(), z.string().nullable()).nullable().optional(),
  maxRunners: z.number().int().min(1).max(8).nullable().optional(),
  /** `{ evals: { judge: { enabled: false } } }` switches the rubric judge off. */
  evals: z.object({ judge: z.object({ enabled: z.boolean() }).partial().optional() }).partial().nullable().optional(),
  titles: z.object({ auto: z.boolean(), runner: RunnerId, model: z.string(), effort: z.string() }).partial().nullable().optional(),
  /** Partial: `{ quotaAndResume: { maxLimitStops: 3 } }` leaves the rest alone; null puts the whole group back to the defaults. */
  quotaAndResume: z.object(quotaAndResumeFields).partial().nullable().optional(),
  kernel: z.object(kernelFields).partial().nullable().optional(),
  judgeAndChoice: z.object(judgeAndChoiceFields).partial().nullable().optional(),
  newDefaults: z.object(newDefaultsFields).partial().nullable().optional(),
  release: z.object(releaseFields).partial().nullable().optional(),
  cliUpdate: z.object(cliUpdateFields).partial().nullable().optional(),
  /** model → price row; null removes the row (back to pricing.json's row, if any). */
  prices: z.record(z.string(), SettingsPrice.nullable()).nullable().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
