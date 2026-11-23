import { z } from "zod";
import { AskQuestion, PermissionKind, StopCondition } from "../events.ts";
import { AskAnswer, AskAnswerKind } from "./answer.ts";
import { Artifact } from "./artifact.ts";
import { Backlog } from "./backlog.ts";
import { AnswerPolicy, AskPolicy, PolicyInput, PolicySubject } from "./policy.ts";
import { DeviceAuthView } from "./task.ts";
import { WaitKind } from "./waits.ts";

/** One unanswered permission.ask across all tasks: answered with POST /api/tasks/:taskId/permission { id }. */
export const PendingApproval = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  workspace: z.string().nullable(),
  id: z.string(),
  kind: PermissionKind,
  tool: z.string(),
  input: z.unknown().optional(),
  detail: z.string(),
  /** The MCP server's own claim about the tool, copied from the ask (`permission.ask`, same values); absent for every other approval. */
  mcpHint: z.enum(["read-only", "destructive", "write", "unknown"]).optional(),
  askedAt: z.number(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

/**
 * Where an open question comes from: approval = a tool approval of a Task, decision = an Issue's `## 判断待ち`,
 * check = an operational check asked in a Task's conversation, confirmation = an acceptance criterion waiting on the
 * user's own check, stop = a stop record (`stop.record`), wait = a PBI waiting for PRs / Issues to close, notice = the
 * daemon's notice, built from the current state each time.
 */
export const AskKind = z.enum(["approval", "decision", "check", "confirmation", "stop", "wait", "notice"]);
export type AskKind = z.infer<typeof AskKind>;

/**
 * open = not answered yet (the screen's 未回答), held = the person put it on hold (`## 保留`; still theirs to answer),
 * answered = an answer is recorded and the work has not gone on yet, resolved = it went on.
 */
export const AskState = z.enum(["open", "held", "answered", "resolved"]);
export type AskState = z.infer<typeof AskState>;

/**
 * What stands in the way that an answer does not take away: depends = a PR / Issue still open, condition = a stop
 * condition not met (e.g. `ci: failure`), runner = the runner refused (permission / auth) with no tool approval to answer.
 */
export const AskBlocker = z.object({ kind: z.enum(["depends", "condition", "runner"]), detail: z.string() });
export type AskBlocker = z.infer<typeof AskBlocker>;

/**
 * How the work goes on after the answer, read from the records each time: answered = written, the work not asked to
 * go on (yet), queued = waits to be resumed (`reason`), running = the work runs (`taskId`), failed = it
 * did not start or ended in error (`reason`). `at` = when that state was seen to begin (ms).
 */
export const AskResume = z.object({ state: z.enum(["answered", "queued", "running", "failed"]), reason: z.string().nullable(), taskId: z.string().nullable(), at: z.number() });
export type AskResume = z.infer<typeof AskResume>;

export const Ask = z.object({
  id: z.string(),
  kind: AskKind,
  needs: z.enum(["person", "auto"]),
  state: AskState,
  /** When it was asked (ms). */
  at: z.number(),
  /** When its state last changed (ms); `at` while it is open. Answered / resolved ones are shown for a day after it. */
  changedAt: z.number(),
  workspace: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** The backlog item it belongs to: a PBI, or a request. */
  pbi: z.object({ number: z.number(), title: z.string(), url: z.string() }).nullable(),
  /** The Issue it is asked on (a PBI or one of its Tasks). */
  issue: z.object({ number: z.number(), url: z.string() }).nullable(),
  task: z.object({ id: z.string(), title: z.string().nullable(), /** The Issue a stage Task works on (`Task.stage.issue`); null for an ordinary Task. */ stageIssue: z.number().nullable().optional() }).nullable(),
  reason: z.string().nullable(),
  question: z.string().nullable(),
  choices: z.array(z.string()),
  /** A runner's question tool's questions, answered together by `{ kind: "questions" }`; empty for any other question. */
  questions: z.array(AskQuestion).default([]),
  /** Each choice's grant (the ` — 許可: <文>` of its line), in the order of `choices`; null = the choice has none. */
  grants: z.array(z.string().nullable()).default([]),
  /** A permission stop's grant, sent once by the `grant` answer. */
  grant: z.string().nullable().default(null),
  recommendation: z.object({ choice: z.string(), why: z.string() }).nullable(),
  /** What goes on once it is answered. */
  next: z.string().nullable(),
  /** The record it was read from: an Issue (url) or a Task's conversation (taskId). */
  source: z.object({ label: z.string(), url: z.string().nullable(), taskId: z.string().nullable() }),
  route: z.enum(["approval", "backlog", "task", "issue", "none"]),
  conditions: z.array(StopCondition),
  /** The kinds of answer it takes; empty = not answered from the screen (automatic, or the runner refused). */
  answers: z.array(AskAnswerKind),
  /** Where the work stopped (`**止めた場所**:`), with the first `PR #n` it names (a merge check is about that PR's head). */
  place: z.object({ text: z.string(), pr: z.number().nullable(), /** The `[聞く]` / `[再チェック` lines under `**止めた場所**:` (merge-gate's reasons); empty = none. */ reasons: z.array(z.string()).default([]), /** The first `+<n>/-<m>` of the place; null = none. */ diff: z.string().nullable().default(null) }).nullable(),
  /** The screen mockups to compare before answering: the HTML artifacts, not removed, of the Task the question's `**画面イメージ**:` names. */
  mockups: z.array(Artifact).default([]),
  blockers: z.array(AskBlocker),
  /** null = not answered yet, or the answer's work is over (resolved). */
  resume: AskResume.nullable(),
  /** What a saved policy is matched on: the operation and target. null = none recorded. */
  subject: PolicySubject.nullable(),
  /** What the screen shows about policies. */
  policy: AskPolicy,
  /**
   * The other PBIs of the same Workspace whose unmet prerequisite or wait names this question's PBI, Issue or stage Issue,
   * when answering closes the question's PBI (its last confirmation line, every Task closed): the answer lets them go on.
   * Empty for a question whose answer does not close it.
   */
  unblocks: z.array(z.object({ number: z.number(), title: z.string(), url: z.string() })),
  /** The same PBIs for a question whose answer does not close its PBI: they wait for the PBI to be done, not for this answer. Empty when `unblocks` has them. */
  waiting: z.array(z.object({ number: z.number(), title: z.string(), url: z.string() })),
  /** The Project Priority of the question's PBI; null = unset or not found. */
  priority: z.string().nullable(),
  /** The last reply (the last `session.end`'s summary, up to 2000 characters) of the Task of a stop a person has to answer and has not; shown as it is, never read for questions. null for the other questions. */
  lastReply: z.string().nullable(),
  /**
   * A decision the work did not stop for (`**進め方**: 推奨で進める`): it went on with the recommendation, and the person
   * looks at it afterwards — confirmed (one by one, or a Workspace's at once) or overturned by another answer.
   */
  proceeding: z.boolean().optional(),
  /** Only a question for a wait past its limit (`waitover:`): which wait of the Task it is — its kind and its key (`pr#12`, `job#3`, …). */
  wait: z.object({ kind: WaitKind, key: z.string() }).optional(),
});
export type Ask = z.infer<typeof Ask>;

/** `A` of the choice line `A: 置き換える — 影響: …` (and of a recommendation `A — 理由`); the whole text when it has no short head. */
export const choiceKey = (c: string): string => /^([^:：\s]{1,12})(?::\s|：)/.exec(c)?.[1] ?? c;
/** Whether `choice` is the one the question recommends: the same short head. */
export const isRecommendedChoice = (choice: string, recommendation: { choice: string } | null): boolean => !!recommendation && choiceKey(choice) === choiceKey(recommendation.choice);

/** POST /api/asks/answer: the answer to the question `id` as it was on screen. */
export const AskAnswerInput = z.object({
  id: z.string().min(1),
  answer: AskAnswer,
  /** Save the answer as a policy with it. */
  policy: PolicyInput.optional(),
  /** `batch:deploy`: the Tasks of the batch the person approves; the others wait. */
  taskIds: z.array(z.string()).max(50).optional(),
  /**
   * The questions the screen showed when the button was pressed; required for these ids. `proceed-all:<workspace>`: only
   * these are confirmed — one that came up since is not. `batch:deploy`: the `askId` of each chosen Task as the batch
   * listed it — a chosen Task whose question has another id now is 409 and nothing is sent. An id is as long as `id`
   * above may be (a stop's id carries its operation and target).
   */
  askIds: z.array(z.string()).max(500).optional(),
});
export type AskAnswerInput = z.infer<typeof AskAnswerInput>;
/**
 * `already` = the question was answered before (a resend): nothing was written again. `ask` = the question now, null when
 * it is gone. `changes` = what had moved on the PR it stopped at when a text answer was written (written with it too).
 */
export const AskAnswerResult = z.object({ ask: Ask.nullable(), already: z.boolean(), changes: z.array(z.string()).default([]), /** The policy saved with the answer. */ policy: AnswerPolicy.nullable().optional() });
export type AskAnswerResult = z.infer<typeof AskAnswerResult>;
/** 409's body: the question changed since it was shown — what changed, and the question now (null = none waits). */
export const AskChanged = z.object({ error: z.string(), changes: z.array(z.string()), current: Ask.nullable() });
export type AskChanged = z.infer<typeof AskChanged>;

/**
 * The Tasks stopped on the same kind of wait across workspaces: sso = an SSO login (reason `auth`), deploy = a
 * deploy the runner refused (reason `permission` with a deploy word in its op / target). Each Task once, oldest Task
 * first; `askId` = the question it shows as on its own (the stop, or what it folded into).
 */
export const AskBatch = z.object({
  id: z.enum(["batch:sso", "batch:deploy"]),
  kind: z.enum(["sso", "deploy"]),
  asks: z.array(z.object({ askId: z.string(), taskId: z.string(), title: z.string(), workspaceId: z.string().nullable(), op: z.string(), at: z.number() })),
  /** sso: the Task sent on to log in (no longer in `asks`), until its turn ends; the others are sent on after it. */
  loggingIn: z.object({ taskId: z.string(), title: z.string() }).nullable().default(null),
  /** sso: that Task's device code, while it waits for the person's approval. */
  deviceAuth: DeviceAuthView.nullable().default(null),
});
export type AskBatch = z.infer<typeof AskBatch>;
/** POST /api/asks/answer with a batch's id: the Tasks sent on now, and the batch after it (null = gone). */
export const AskBatchResult = z.object({ sent: z.array(z.string()), already: z.boolean(), batch: AskBatch.nullable() });
export type AskBatchResult = z.infer<typeof AskBatchResult>;

/** GET /api/asks: the open questions, and those answered / resolved within the last day. `errors` = the backlog's. `batches` = the batches of Tasks stopped on the same kind of wait (`AskBatch`: SSO, deploy). */
export const AskList = z.object({ fetchedAt: z.number(), asks: z.array(Ask), errors: Backlog.shape.errors, batches: z.array(AskBatch).default([]) });
export type AskList = z.infer<typeof AskList>;
