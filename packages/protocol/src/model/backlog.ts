import { z } from "zod";
import { RunnerId } from "../events.ts";
import { Artifact } from "./artifact.ts";
import { BacklogAction, TaskOutcome, TaskStatus } from "./shared.ts";
import { StopSummary } from "./stop.ts";
import { WorkspaceMode } from "./workspace.ts";

/**
 * What each workspace got of the week's spend against its share (`GET /api/backlog/allocation`). `actual` is the part of
 * the spend (metered + billed, all runners) that went to the workspace, 0〜1; `shortfall` = share − actual (null with no share).
 * `flow` is the same for flow-improvement work against its limit; `windowStart` (ms) is where the week's window begins.
 */
export const BacklogAllocation = z.object({
  windowStart: z.number(),
  workspaces: z.array(z.object({ workspaceId: z.string(), share: z.number().nullable(), mode: WorkspaceMode, actual: z.number(), shortfall: z.number().nullable() })),
  flow: z.object({ limit: z.number(), actual: z.number() }),
  /**
   * The limit on flow-improvement PBIs in progress at once (`quotaAndResume.flowLimit`) and, per workspace that has any,
   * the PBIs counted against it now (`counted`) and the Ready ones it holds back (`held`), as the firing counts them.
   */
  flowLimit: z.object({ limit: z.number(), workspaces: z.array(z.object({ workspaceId: z.string(), counted: z.array(z.number()), held: z.array(z.number()) })) }),
});
export type BacklogAllocation = z.infer<typeof BacklogAllocation>;

/**
 * A `## 判断待ち` the work went on from with its recommendation, as the stored backlog has it: asked on `issue` (a PBI, or
 * one of its Tasks — then `pbi` is the parent), with the `## 回答` that confirmed or overturned it. `pbi.open` false =
 * the PBI closed (`closedAt`) with the recommendation standing.
 */
export const ProceedingQuestion = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  issue: z.object({ number: z.number(), url: z.string() }),
  pbi: z.object({ number: z.number(), title: z.string(), url: z.string(), open: z.boolean() }),
  body: z.string(),
  at: z.string(),
  answer: z.object({ at: z.string(), body: z.string() }).nullable(),
  closedAt: z.string().nullable(),
  /**
   * Why the reversibility table does not let the work go on from this question although its 進め方 line says 推奨で進める
   * (no kind, a kind the table does not list as compensable, a stop word, a table that cannot be read): it is asked of
   * the person like a question that waits. null = the table lets it go on.
   */
  stopped: z.string().nullable().default(null),
});
export type ProceedingQuestion = z.infer<typeof ProceedingQuestion>;

/**
 * Where an open request or PBI of the meta workspace's GitHub backlog stands. Read from GitHub on request, never
 * stored: `request` = a request with no derived PBI yet, `needs-tasks` = a PBI not yet Ready (Project Status Backlog or
 * unset), `ready`, `in-progress` = In progress / In review, `needs-decision` = labelled `needs-decision` (wins over the rest).
 */
export const BacklogStage = z.enum(["request", "needs-tasks", "ready", "in-progress", "needs-decision"]);
export type BacklogStage = z.infer<typeof BacklogStage>;

/**
 * How one prerequisite or wait of a PBI stands, judged from the stored records each time they are read: `met` =
 * done (an Issue closed as completed, a PR merged, and for `need: "release"` its merge commit in the running release);
 * `pending` = not yet (open, Draft too, or merged but not released); `withdrawn` = closed without being done (NOT_PLANNED
 * / DUPLICATE, a PR closed unmerged); `missing` = not stored (404, or never read); `cycle` = it waits back on the PBI;
 * `unknown` = cannot be judged here (a release that cannot be checked). Only `met` lets the PBI go on.
 */
export const BacklogPrereqState = z.enum(["met", "pending", "withdrawn", "missing", "cycle", "unknown"]);
export type BacklogPrereqState = z.infer<typeof BacklogPrereqState>;

/**
 * How a stored Issue (or a workspace's whole backlog) stands against GitHub: `synced` = nothing waits to be sent
 * and the last read was complete; `pending` = an edit is stored here and not (known to be) sent; `conflict` = an edit is
 * held until chosen on; `error` = it cannot be told or sent (an import failed, GitHub no longer shows it, an edit was refused).
 */
export const BacklogSyncState = z.enum(["synced", "pending", "conflict", "error"]);
export type BacklogSyncState = z.infer<typeof BacklogSyncState>;

/**
 * Why a state is not `synced` and not just "waiting to send": `failed` = an edit GitHub refused, `unknown` = a post whose
 * answer was lost (looked for before it is sent again), `unavailable` / `forbidden` = GitHub answered 404 / 403 for it,
 * `unfetched` = never read in full, `import` = the last import of the workspace failed or is held back until `retryAt`.
 */
export const BacklogSyncReason = z.enum(["failed", "unknown", "unavailable", "forbidden", "unfetched", "import"]);
export type BacklogSyncReason = z.infer<typeof BacklogSyncReason>;

/** A held conflict as the list shows it: the three values of `BacklogHeldEdit.conflict`, with the field and the revision a choice names. */
export const BacklogSyncConflict = z.object({ field: z.string().nullable(), base: z.unknown().optional(), local: z.unknown().optional(), remote: z.unknown().optional(), remoteRead: z.boolean(), revision: z.string() });
export type BacklogSyncConflict = z.infer<typeof BacklogSyncConflict>;

/**
 * The sync of one Issue or one workspace. `lastSuccessfulSync` = when it was last read in full (ms; null = never —
 * a failed read never moves it); `retryAt` = GitHub is not asked before this (ms); `pendingCount` = edits stored here, not
 * done; `guarantee` = what a send promises: "A" = checked against GitHub just before and after each write.
 */
export const BacklogSyncInfo = z.object({
  state: BacklogSyncState,
  reason: BacklogSyncReason.nullable(),
  lastSuccessfulSync: z.number().nullable(),
  retryAt: z.number().nullable(),
  pendingCount: z.number(),
  conflicts: z.array(BacklogSyncConflict),
  guarantee: z.literal("A"),
  /** On a work machine: the records are a copy of the instance's, taken at `takenAt` (`lastSuccessfulSync` is then the instance's own last import). Absent = read from the service here. */
  replica: z.object({ takenAt: z.number() }).optional(),
});
export type BacklogSyncInfo = z.infer<typeof BacklogSyncInfo>;

/**
 * A prerequisite a PBI or one of its open Tasks names on its `**前提**:` line. `kind` null = not stored; `need` =
 * what makes it met (`done` an Issue, `merged` a PR, `release` with `（リリース）`). A number is listed once: `via` =
 * the open Tasks that name it, ascending; `[]` = only the PBI's own body names it.
 */
export const BacklogPrereq = z.object({ number: z.number(), kind: z.enum(["issue", "pr"]).nullable(), need: z.enum(["done", "merged", "release"]), state: BacklogPrereqState, via: z.array(z.number()), /** `met` because the PBI is left with only the user's checks. */ confirming: z.boolean() });
export type BacklogPrereq = z.infer<typeof BacklogPrereq>;

export const BacklogItem = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  type: z.enum(["request", "pbi"]),
  stage: BacklogStage,
  /** Project fields; null when the Issue is not in the Project or the field is unset. */
  priority: z.string().nullable(),
  storyPoints: z.number().nullable(),
  createdAt: z.string(),
  /**
   * Sub-issues (Tasks) of a PBI; null for a request. `doneAt` = the newest `updatedAt` of the closed sub-issues (ISO), null
   * when none is closed.
   */
  tasks: z.object({ total: z.number(), done: z.number(), doneAt: z.string().nullable() }).nullable(),
  /**
   * The open question of a needs-decision item; always null until then. `issue` = the Issue it is asked on: the item
   * itself, or an open Task of an in-progress PBI — the answer is written there.
   */
  decision: z.object({ body: z.string(), at: z.string(), issue: z.number() }).nullable(),
  /** The newest `## 回答` on an in-progress PBI or its Tasks, or on a Ready PBI itself; null for the other stages or when there is none. */
  answeredAt: z.string().nullable(),
  /** The `## 保留` newer than the item's `## 判断待ち`, on the Issue asked on; null when none (or not needs-decision). */
  heldAt: z.string().nullable(),
  /** A running / waiting stage Task started for this Issue (its title starts with "#<number> "); null when none. */
  activeTaskId: z.string().nullable(),
  /** The Project's Status by name (In progress / In review / …); null when the Issue is not in the Project or it is unset. */
  projectStatus: z.string().nullable(),
  /** When the Issue was last updated on GitHub (ISO string). */
  updatedAt: z.string(),
  /**
   * The newest-created stage Task of this Issue in any state; a finished one's `updatedAt` is when it finished.
   * `action` = the stage named in its title; null when the title names none.
   * `outcome` / `reviewedAt` and `resumeAt` (a usage-limit stop's planned resume) are the Task's own, so backlog-next
   * can leave an item whose Task ended asking the person or could not run.
   */
  lastTask: z.object({ id: z.string(), status: TaskStatus, statusAt: z.number(), createdAt: z.number(), updatedAt: z.number(), action: BacklogAction.nullable(), outcome: TaskOutcome, reviewedAt: z.number().nullable(), resumeAt: z.number().nullable(), started: z.boolean() }).nullable(),
  /**
   * Its last stage Task waits for the person's reply: `awaitingReply`, or that Task's newest stop series
   * is `next = "decide"`. The daemon adds it (withActive), not stored.
   */
  replyWaiting: z.boolean(),
  /** The newest `## 状況` comment of an in-progress item; always null for the other stages. */
  report: z.object({ body: z.string(), at: z.string() }).nullable(),
  /**
   * The acceptance criteria of an In progress / In review PBI still waiting on the user's own check: unchecked lines
   * of `## 到達点 / 受け入れ条件` outside fences with `（利用者確認: …）`. `n` = the line's number among all the section's
   * checkbox lines (checked ones too, from 1); `text` = the line after `- [ ] `. Empty for the other items. A line naming
   * decisions (`（利用者確認: 回答で確かめる #n — …）`) is not here once every named Issue is stored: their cards ask. Empty while a Task of the PBI is open: what is not built
   * cannot be checked (`asked` of `packages/core/src/pbi-progress.ts`).
   * `after` = the time (ISO 8601 with a zone) a line says `期日 … 以降`: not asked before it; still counted for `closable`.
   */
  confirmations: z.array(z.object({ n: z.number(), text: z.string(), after: z.string().nullable() })),
  /**
   * An in-progress PBI whose Tasks are all closed and with no confirmation left: its row offers 閉じる. Not while a
   * decision a confirmation line names is still labelled `needs-decision`. The answer of `packages/core/src/pbi-progress.ts`.
   */
  closable: z.boolean(),
  /**
   * The other answers of `packages/core/src/pbi-progress.ts` (docs/design/pbi-progress.md): `closableByApi` = the API
   * takes 閉じる (Tasks all closed, confirmations left or not); `closesOnAnswer` = the one confirmation line whose answer
   * closes the PBI, null = none does.
   */
  progress: z.object({ closableByApi: z.boolean(), closesOnAnswer: z.number().nullable() }),
  /** Labelled `on-hold`: backlog-next leaves it in every slot and stage; only that firing looks at this, its row's buttons do not. */
  onHold: z.boolean(),
  /** Carries the `flow-improvement` label. */
  flow: z.boolean(),
  /** The length of the Issue's body in characters: what a process definition's `auto.maxBodyChars` compares when `requestChars` is null. */
  bodyChars: z.number().int().min(0),
  /** The length of the `## 要望` section's text (fence lines left out), what `auto.maxBodyChars` compares first; null = the Issue has no such section, or it holds no words (the body's length is used). */
  requestChars: z.number().int().min(0).nullable(),
  /** The Project's Kind field (feature / bug / deps …) by name; null when unset or not in the Project. */
  kind: z.string().nullable(),
  /** Who said a request's words: the `- 誰の言葉:` line of its `## 出典` (fences left out); null = no such line, or none of the three values. */
  requestFrom: z.enum(["利用者", "エージェント", "定期の検査"]).nullable(),
  /** The Issue a PBI's `## 元要望` section names first; null = a request, or a PBI naming none. */
  origin: z.number().int().nullable(),
  /** The Issue's label names: what a process definition's `auto.excludeLabels` and `direct-returned` read. */
  labels: z.array(z.string()),
  /**
   * What a Ready / in-progress PBI stopped to wait for: the PRs / Issues of the same repository named by its newest
   * /pbi-complete release, with whether each is still open. Deferred PRs and explicitly recorded overlap waits on decision Tasks are excluded. Empty when there is no such record, a later one cleared it,
   * the item is not a Ready / in-progress PBI, or an 実装 (`complete`) stage Task was created after `waitsAt` (the daemon empties it then).
   * `open` null = its state could not be read (not stored; `kind` is then "issue"), neither open nor closed, and it
   * still holds the PBI. `reason` = why the release named it: "overlap" (`--overlap-waits`, the files overlap) or
   * "prerequisite" (`--waits`, a Task it builds on is not done; a `waits=` written before `--overlap-waits` existed may
   * have been an overlap too — held until closed either way). `pbi` = the PBI that moves the wait forward: an
   * Issue's own number when it is a PBI, else its parent; a PR's from the Issues it closes (`closes`), the first that
   * gives one. `title` null = that PBI is not stored; `pbi` null = none found (不明). Its stage Task is read from that
   * PBI's own item in the same answer (`activeTaskId` / `lastTask`), not copied here.
   * `state` = how it stands (BacklogPrereqState): an overlap is met once closed, a prerequisite once done (a PR
   * closed unmerged or an Issue closed as not planned is `withdrawn`, and holds). `open` follows it: false = met, true =
   * pending, null = anything else.
   */
  waits: z.array(z.object({ number: z.number(), kind: z.enum(["issue", "pr"]), open: z.boolean().nullable(), state: BacklogPrereqState, reason: z.enum(["overlap", "prerequisite"]), pbi: z.object({ number: z.number(), title: z.string().nullable() }).nullable() })),
  /**
   * What a Ready / in-progress PBI's open Tasks touch that other work touches too, judged from the stored records
   * (an open PR's files, an In progress Task's body) by the rule of scripts/parallel-guard.ts. `hits` = the other side's
   * `ref` (`PR #n` / `Task #m`) and its `path`; `unknown` = why it cannot be judged (a PR's files are not all stored).
   * null = not judged (not such a PBI, no path named) or no overlap. A hit with `turn` is not work under way: the path is
   * kept for the PBI `turn`, which yielded on an overlap earlier and starts first (`ref` = its Task that names the path).
   */
  overlap: z.object({ hits: z.array(z.object({ ref: z.string(), path: z.string(), working: z.boolean(), turn: z.number().int().optional() })), unknown: z.string().nullable() }).nullable(),
  /**
   * The Tasks of the PBI the app judged free of overlaps and able to start now (not in review, no open PR of their own):
   * the 実装 prompt names them, so the session starts from one the guard in the Task lets go too. Absent = not judged, or
   * the PBI overlaps.
   */
  freeTasks: z.array(z.number()).optional(),
  /** When that release was written (ISO string); retained when deferred waits are filtered out so the item can resume, null when no release applies. Compared with an 実装 stage Task's creation time. */
  waitsAt: z.string().nullable(),
  /** A date the PBI waits for (the release mark's `after=`): `at` as written, `met` = it has passed when the backlog was built. null = no date. */
  waitsUntil: z.object({ at: z.string(), met: z.boolean() }).nullable(),
  /**
   * The prerequisites of a Ready / in-progress PBI: those its body names, and those its open Tasks name outside
   * the PBI when every open Task has one not met (one Task free to go lets the PBI go on). Empty for the other items.
   */
  prereqs: z.array(BacklogPrereq),
  /** The stops of the Issue's stage Tasks, one per series; empty until the daemon adds them. */
  stopSummary: z.array(StopSummary),
  /** The Task a PBI's body names on its `**画面イメージ**:` line outside fences, the first id in it; null for a request or no line. */
  mockupTask: z.string().nullable(),
  /** That Task's screen mockups: its HTML artifacts, not removed, as a question's `mockups`; empty until the daemon adds them. */
  mockups: z.array(Artifact),
  /** How this Issue stands against GitHub; what a start is judged on, not only shown. */
  sync: BacklogSyncInfo,
  /** The registered workspace whose repository the Issue is in. */
  workspaceId: z.string(),
  workspaceName: z.string(),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

/** `workspaceId`: the registered workspace whose repository the Issue is in (#n is per repository). */
export const BacklogStartInput = z.object({ workspaceId: z.string(), action: BacklogAction, runner: RunnerId.optional(), model: z.string().optional(), effort: z.string().optional() });
export type BacklogStartInput = z.infer<typeof BacklogStartInput>;

/**
 * The user's answer to a needs-decision item: written on the Issue as `## 回答` + text. `issue`: the Issue of the
 * question on screen (`decision.issue`); the answer is refused when the item now asks on another one.
 * `confirm`: the answer to confirmation `n` of the item's `confirmations` instead — `ok` checks that line of the
 * PBI's body, otherwise `text` is the reason it is not right (required then).
 */
export const BacklogAnswerInput = z
  .object({
    workspaceId: z.string(),
    text: z.string().trim().max(20_000).default(""),
    issue: z.number().int().positive().optional(),
    confirm: z.object({ n: z.number().int().positive(), ok: z.boolean() }).optional(),
    /** The Task that sends the answer (as `SendTaskInput.from`): the answer is then that Task's, never the person's words or permission. */
    from: z.string().trim().min(1).max(200).regex(/^[\w.:-]+$/).optional(),
  })
  .refine((a) => a.confirm?.ok || a.text.length > 0, { message: "text is required", path: ["text"] });
export type BacklogAnswerInput = z.infer<typeof BacklogAnswerInput>;

/**
 * A plain comment on a stored Issue, kept here and sent later like an answer — without an answer's label change.
 * Whose question a `## 判断待ち` in the comment is (the Task stopped at a question the work may not go on from) is not
 * said here: the request's headers prove the Task it comes from (`callingTask`; `ops-kit backlog comment` sends them).
 */
export const BacklogCommentInput = z.object({ workspaceId: z.string(), text: z.string().trim().min(1).max(20_000) }).strict();
export type BacklogCommentInput = z.infer<typeof BacklogCommentInput>;

/** `POST /api/backlog/sync`: the workspace whose stored backlog is brought up to date. */
export const BacklogSyncInput = z.object({ workspaceId: z.string() }).strict();

/** One PBI in the backlog queue: the order the person chose to implement in, one list across the workspaces. */
export const BacklogQueueEntry = z.object({ workspaceId: z.string(), number: z.number().int().positive() }).strict();
export type BacklogQueueEntry = z.infer<typeof BacklogQueueEntry>;

/** A PBI that left the queue: closed on GitHub, or taken out by the person. The newest 20 are kept. */
export const BacklogQueueEnded = z.object({ workspaceId: z.string(), number: z.number(), title: z.string(), at: z.number(), reason: z.enum(["closed", "removed"]) });
export type BacklogQueueEnded = z.infer<typeof BacklogQueueEnded>;

/** How many of the queue's implementation Tasks may run at once. */
export const BacklogQueueConcurrency = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * The backlog queue: the PBIs to implement, in order, kept in the daemon (`GET /api/backlog/queue`). `enabled`
 * off (the default) starts nothing from it.
 */
export const BacklogQueue = z.object({
  enabled: z.boolean(),
  concurrency: BacklogQueueConcurrency,
  items: z.array(BacklogQueueEntry),
  ended: z.array(BacklogQueueEnded),
  /** What the queue's last start decided: what it started, what it left and why, or that it is empty; one line each. null = never ran. */
  lastNote: z.string().nullable(),
  /** When `lastNote` was written (ms). null = never. */
  lastNoteAt: z.number().nullable(),
});
export type BacklogQueue = z.infer<typeof BacklogQueue>;

/** `PUT /api/backlog/queue`: what changes; the fields left out stay. */
export const BacklogQueueInput = z.object({ enabled: z.boolean().optional(), concurrency: BacklogQueueConcurrency.optional(), items: z.array(BacklogQueueEntry).optional() }).strict();
export type BacklogQueueInput = z.infer<typeof BacklogQueueInput>;

/**
 * What a backlog error asks of the owner, decided where gh was called (not read back from its wording):
 * `gh-login` = gh is not logged in or its login was refused, `project-var` = the repository variable holding the
 * Project URL is missing, `other` = anything else (a limit, no directory, …; its message says it).
 */
export const BacklogErrorKind = z.enum(["gh-login", "project-var", "other"]).default("other");
export type BacklogErrorKind = z.infer<typeof BacklogErrorKind>;

export const Backlog = z.object({
  /**
   * When the stored backlog was imported from GitHub (ms): the oldest of the GitHub-synced workspaces shown, now
   * when none ever was. A workspace kept only here (`backlog: "switchboard"`) is not counted: it is not read from GitHub.
   */
  fetchedAt: z.number(),
  items: z.array(BacklogItem),
  /**
   * Workspaces whose last import failed or that were never imported: the reason. What a workspace had
   * stored still comes; one never imported has no items — never an empty list as if read.
   */
  errors: z.array(z.object({ workspaceId: z.string(), workspaceName: z.string(), message: z.string(), kind: BacklogErrorKind })).default([]),
  /** The decisions the work went on from with their recommendation (not items: nothing waits on them), open PBIs' and those closed within the day. */
  proceeding: z.array(ProceedingQuestion).optional(),
  /** The local changes of the workspaces kept here: every open one, and each workspace's newest 10 closed. */
  changes: z.array(z.object({
    workspaceId: z.string(), number: z.number(), title: z.string(), state: z.enum(["OPEN", "CLOSED"]),
    head: z.string(), base: z.string(), mergeCommit: z.string().nullable(), mergedAt: z.string().nullable(), updatedAt: z.string(),
    pr: z.number().nullable(), reportedAt: z.string().nullable(),
  })).default([]),
  /** Each workspace's sync: an import under way, and when the last complete one was stored (null = never). */
  syncs: z.array(z.object({
    workspaceId: z.string(),
    /** Whether its backlog syncs with GitHub: the same values as `Workspace.backlog`. */
    backlog: z.enum(["github", "switchboard"]),
    /** Turning its GitHub sync on: the Issues made here only to make on GitHub, and those made; null = not under way. */
    enabling: z.object({ total: z.number(), done: z.number() }).nullable(),
    /** The repository its stored backlog is of (`owner/name`: the kit's `backlog` finds the workspace by it); null = never imported. */
    repository: z.string().nullable(),
    syncing: z.boolean(),
    syncedAt: z.number().nullable(),
    /** The workspace as a whole: the worst of its Issues', or an import that failed / never ran. */
    sync: BacklogSyncInfo,
    /** Issues made here that GitHub has not numbered yet: no number to start a stage on. */
    creates: z.array(z.object({ localId: z.string(), title: z.string(), state: BacklogSyncState })).default([]),
    /** Numbered Issues that hold operations not sent, Closed ones too: opened from the sync line to be resolved. */
    issues: z.array(z.object({
      number: z.number(), title: z.string(), url: z.string(), closed: z.boolean(),
      state: BacklogSyncState, pendingCount: z.number(), conflictCount: z.number(),
    })).default([]),
  })).default([]),
});
export type Backlog = z.infer<typeof Backlog>;
