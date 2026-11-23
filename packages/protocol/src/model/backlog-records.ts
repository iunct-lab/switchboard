import { z } from "zod";
import { BacklogSyncInfo } from "./backlog.ts";

/**
 * Where a stored backlog record comes from: one repository of one service. The Issue number alone is not an id —
 * two repositories have a `#12` each. `repository` is `owner/name` as GitHub spells it (`gh repo view`'s nameWithOwner):
 * GitHub ignores case there, the key does not.
 */
/** `service`: `github`, `gitlab` (`repository` = the project's full path its `forge` names, so a GitHub `#12` and a GitLab `#12` are two records), or `switchboard` = a workspace whose backlog is kept here only (`repository` = the workspace id). */
export const BacklogRepositoryKey = z.object({ service: z.enum(["github", "gitlab", "switchboard"]), host: z.string(), repository: z.string() });
export type BacklogRepositoryKey = z.infer<typeof BacklogRepositoryKey>;

/**
 * What a stored record is: an Issue, one comment of one, an Issue's item in a Project, or a pull request a PBI
 * waits for.
 */
export const BacklogObjectKind = z.enum(["issue", "comment", "project-item", "pull-request"]);
export type BacklogObjectKind = z.infer<typeof BacklogObjectKind>;

/**
 * How the last import left a record: `fetched` = read in full; `unfetched` = needed but not read yet (an empty
 * answer is not this); `unavailable` = GitHub answered 404 (gone or hidden — not a proof of deletion); `forbidden` = 403.
 * A record that is not `fetched` keeps the `remote` it had.
 */
export const BacklogFetchState = z.enum(["fetched", "unfetched", "unavailable", "forbidden"]);
export type BacklogFetchState = z.infer<typeof BacklogFetchState>;

/**
 * A local change: what a pull request is on a workspace with no forge — a Task's branch to be merged into `base`.
 * Kept on the Issue record it is (numbered with the Issues, as GitHub numbers PRs). `head` / `base` = branch names; the
 * tips are not kept (they move): read from git when shown. `mergeCommit` / `mergedAt` = the tip `base` was moved to by
 * the merge, and when; null until then. `reviewedHead` = the head that was judged and merged (what the review and the local
 * CI saw): the merge rebases it, so `mergeCommit` is another sha; null until then, and for one merged before this was kept.
 */
export const BacklogChange = z.object({
  head: z.string(), base: z.string(), mergeCommit: z.string().nullable(), mergedAt: z.string().nullable(), reviewedHead: z.string().nullable(),
  /** The GitHub PR it stands in for while GitHub could not be used; null = none (a workspace without PRs, or no PR was made yet). */
  pr: z.number().nullable(),
  /** When its review and judgement were summed up on GitHub after it came back; null = not yet (or nothing to report to). */
  reportedAt: z.string().nullable(),
});
export type BacklogChange = z.infer<typeof BacklogChange>;

/** An Issue as stored: body (Markdown) and the standard fields; `parent` / `subIssues` are Issue numbers of the same repository. */
export const BacklogIssueData = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  /** How it was closed: COMPLETED is done; NOT_PLANNED / DUPLICATE are withdrawn. null = never read (made here). */
  stateReason: z.enum(["COMPLETED", "NOT_PLANNED", "DUPLICATE", "REOPENED"]).nullable(),
  body: z.string(),
  labels: z.array(z.string()),
  milestone: z.string().nullable(),
  parent: z.number().nullable(),
  subIssues: z.array(z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When it was closed; null = open, never read, or stored before this was kept (the next import fills it). */
  closedAt: z.string().nullable(),
  /** Set when it is a local change, not an Issue. */
  change: BacklogChange.optional(),
});
export type BacklogIssueData = z.infer<typeof BacklogIssueData>;

/** `authorAssociation`: the commenter's relation to the repository as GitHub says it (OWNER, MEMBER, COLLABORATOR, …); absent for a comment stored before it was kept, and for one made here. */
export const BacklogCommentData = z.object({ issue: z.number(), body: z.string(), createdAt: z.string(), authorAssociation: z.string().optional() });
export type BacklogCommentData = z.infer<typeof BacklogCommentData>;

/**
 * An Issue's item in a Project: the field values by field name (Status, Priority, Story Points, …). A Project
 * number is unique per owner only, so `owner` (its login) comes with it.
 */
export const BacklogProjectItemData = z.object({ issue: z.number(), owner: z.string(), project: z.number(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])) });
export type BacklogProjectItemData = z.infer<typeof BacklogProjectItemData>;

/**
 * A pull request as stored: what a PBI's wait reads and, for an open one, what it changes: `updatedAt` and `files` (the changed paths; null = more than the 100 read, i.e. not fully known, never "no files"). `closes` = the Issues it closes, read
 * from its body's `Closes #n` and its branch `sb/<n>-` (no duplicates, ascending); the body and branch are not stored. `head` = the sha of its head commit when last read (null = a record from before it was kept). Its comments are stored as `comment` records whose `issue` is the PR's number (a PR and an Issue share one numbering).
 */
export const BacklogPullRequestData = z.object({ number: z.number(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(), labels: z.array(z.string()), closes: z.array(z.number()), mergeCommit: z.string().nullable(), updatedAt: z.string(), files: z.array(z.string()).nullable(), closedAt: z.string().nullable(), mergedAt: z.string().nullable(), head: z.string().nullable() });
export type BacklogPullRequestData = z.infer<typeof BacklogPullRequestData>;

/**
 * One stored record. `externalId` = the service's id of the object (a node id). `remote` = what the service last
 * answered, `base` = the value both sides agreed on at the last sync, `local` = an edit not sent yet (null = none);
 * null `remote` / `base` = never read. `fetchedAt` = when `remote` was read (ms).
 */
const record = <K extends BacklogObjectKind, D extends z.ZodTypeAny>(kind: K, data: D) =>
  BacklogRepositoryKey.extend({
    objectKind: z.literal(kind),
    externalId: z.string(),
    remote: data.nullable(),
    base: data.nullable(),
    local: data.nullable(),
    fetchedAt: z.number().nullable(),
    fetchState: BacklogFetchState,
  });
export const BacklogRecord = z.discriminatedUnion("objectKind", [record("issue", BacklogIssueData), record("comment", BacklogCommentData), record("project-item", BacklogProjectItemData), record("pull-request", BacklogPullRequestData)]);
export type BacklogRecord = z.infer<typeof BacklogRecord>;

/**
 * A repository's sync state: `cursor` = where the next incremental read starts, `lastSuccessfulSync` = when the
 * last complete import was stored (ms), `retryAt` = not before this (a limit or an outage); null = never / none.
 */
export const BacklogRepositorySync = BacklogRepositoryKey.extend({ cursor: z.string().nullable(), lastSuccessfulSync: z.number().nullable(), retryAt: z.number().nullable() });
export type BacklogRepositorySync = z.infer<typeof BacklogRepositorySync>;

/**
 * One field of the workspace's Project a value can be written to: its name, its type (the four `fieldValue`
 * sends; ITERATION, TITLE, LABELS … are not here) and, for a single select, its choices in the Project's order.
 */
export const BacklogProjectField = z.object({
  name: z.string(),
  dataType: z.enum(["SINGLE_SELECT", "NUMBER", "TEXT", "DATE"]),
  options: z.array(z.string()),
});
export type BacklogProjectField = z.infer<typeof BacklogProjectField>;

/**
 * Where a workspace's backlog comes from: its repository and the Project it reads (`projectVar` /
 * SWITCHBOARD_PROJECT_URL; a Project number is unique per owner only). Written by each import, so the stored backlog is
 * read without asking GitHub which repository the checkout is. `disabled`: the workspace's GitHub sync is off —
 * its records stay under this key and nothing reads or writes GitHub's Issues or Project until it is on again.
 * `enabling` / `numbers`: turning it on (backlog-enable.ts).
 */
export const BacklogSource = BacklogRepositoryKey.extend({
  project: z.object({ owner: z.string(), number: z.number() }),
  disabled: z.literal(true).optional(),
  /**
   * Its GitHub sync being turned on: since when; the Issues made here only are being made on GitHub. `queued`:
   * all are, and their bodies, parents and comments (with `#N` rewritten to GitHub's numbers) are being sent.
   */
  enabling: z.object({ since: z.number(), queued: z.literal(true).optional() }).optional(),
  /** The Issues made on GitHub by turning it on: their number here (`from`) and GitHub's (`to`). */
  numbers: z.array(z.object({ from: z.number(), to: z.number() })).optional(),
  /**
   * Whether GitHub says the repository is private, written by each import. The host's rebuild checks a clone against it
   * and `repository`: a renamed repository's old name may now be a public one.
   */
  private: z.boolean().optional(),
  /**
   * The Project's writable fields, in its order, written by each import. Absent on a backlog kept here (its
   * choices are `ops.config.json`'s) and, until its next import, on a source stored before.
   */
  projectFields: z.array(BacklogProjectField).optional(),
});
export type BacklogSource = z.infer<typeof BacklogSource>;

/**
 * An edit of an Issue held, not sent: a `conflict` (GitHub's value moved off the one it was made on), `failed`
 * (refused: a permission, an input) or `unknown` (a post whose answer was lost). `reason` = why, as the last check
 * said; `updatedAt` = when (ms). A conflict carries the three values: `base` = the value the edit was made on, `local`
 * = the edit's, `remote` = GitHub's as last imported (`remoteRead` false: not read, then `remote` is null), and the
 * `revision` a choice on it names (PATCH `resolve`).
 */
export const BacklogHeldEdit = z.object({
  operation: z.string(),
  kind: z.enum(["create", "set", "comment", "artifact"]),
  field: z.string().nullable(),
  status: z.enum(["conflict", "failed", "unknown"]),
  reason: z.string().nullable(),
  updatedAt: z.number(),
  conflict: z.object({ base: z.unknown().optional(), local: z.unknown().optional(), remote: z.unknown().optional(), remoteRead: z.boolean(), revision: z.string() }).nullable(),
});
export type BacklogHeldEdit = z.infer<typeof BacklogHeldEdit>;

/**
 * One stored Issue (`GET /api/backlog/:number`): its body and fields, every stored comment (oldest first) and its
 * fields in the workspace's Project (null = not in it). `fetchedAt` = when it was last read; `fetchState` = how.
 */
export const BacklogIssueDetail = z.object({
  workspaceId: z.string(),
  issue: BacklogIssueData,
  /**
   * `id`: the stored record's id (GitHub's comment id, or `sb:<seq>` on a backlog kept here).
   * `seq`: the sequence number of the operation that wrote a comment here, the same before and after it is sent; null for
   * one only imported from GitHub. The order the parallel guard decides who came first by.
   */
  comments: z.array(BacklogCommentData.extend({ id: z.string(), seq: z.number().nullable().default(null) })),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable(),
  /** The fields of the Project a value can be written to: what the edit form offers; `fields` is checked against them. */
  projectFields: z.array(BacklogProjectField).default([]),
  fetchedAt: z.number().nullable(),
  fetchState: BacklogFetchState,
  /** An Issue made here: the id it is read and edited by before GitHub gives it a number (0 until then), and after. */
  localId: z.string().nullable().default(null),
  /** Edits of it not sent to GitHub yet. */
  pending: z.number().default(0),
  /** Those of them held: not sent until chosen on (a conflict) or looked into. */
  held: z.array(BacklogHeldEdit).default([]),
  /** How this Issue stands against GitHub, as its row in the list tells. */
  sync: BacklogSyncInfo,
  /** What the check before and after a send can and cannot keep (初期方式 A). */
  limits: z.string(),
  /** A local change's branch tips now (40 hex; null = the branch is not there); null when it is not a change. */
  changeRefs: z.object({ head: z.string().nullable(), base: z.string().nullable() }).nullable().default(null),
});
export type BacklogIssueDetail = z.infer<typeof BacklogIssueDetail>;
