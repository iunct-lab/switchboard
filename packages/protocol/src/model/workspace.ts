import { z } from "zod";

export const WorkspaceKind = z.enum(["repo", "meta"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

/**
 * backlog-next's slots of one workspace: how many stage Tasks of each kind it keeps
 * running there. 0 = that slot is not moved automatically there.
 */
export const WorkspaceSweep = z.object({ implement: z.number().int().min(0).max(3), plan: z.number().int().min(0).max(3) });
export type WorkspaceSweep = z.infer<typeof WorkspaceSweep>;
/** `new` / `continuing` do not change how backlog-next picks; `maintenance` only moves bug / deps PBIs and routine-check requests. */
export const WorkspaceMode = z.enum(["new", "continuing", "maintenance"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;
/** The share of the week's usage this workspace is meant to get (0〜1; null = not set, picked as before) and its mode. */
export const WorkspaceAllocation = z.object({ share: z.number().min(0).max(1).nullable(), mode: WorkspaceMode });
export type WorkspaceAllocation = z.infer<typeof WorkspaceAllocation>;

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  kind: WorkspaceKind,
  createdAt: z.number(),
  /**
   * The repository variable that holds this workspace's GitHub Project URL, for the backlog. Unset = SWITCHBOARD_PROJECT_URL.
   * Each repository keeps the URL under its own name (e.g. the one its Actions add Issues to the Project with).
   */
  projectVar: z.string().optional(),
  /**
   * Where the workspace's backlog is kept: `github` = imported from and sent to its GitHub repository and
   * Project; `switchboard` = only in Switchboard's stored data (no GitHub Issue or Project). PRs and CI stay with the
   * repository's forge either way.
   */
  backlog: z.enum(["github", "switchboard"]).default("github"),
  /** The repository's `owner/name` when it was added from someone else's repository. This workspace never writes there. */
  upstream: z.string().optional(),
  /**
   * The workspace's rules kept on Switchboard's side (what an adoption worked out, instead of a commit to the repository):
   * added to the first prompt of every Task started in this workspace. Unset = none.
   */
  rules: z.string().optional(),
  /**
   * The workspace's settings kept on Switchboard's side, as JSON text in the shape of `ops.config.json` (the CI's steps, the
   * backlog's fields and sections, ...): what the tools use when the repository has no `ops.config.json` of its own. A
   * repository that has the file is run with that file alone (never mixed key by key). Unset = none.
   */
  config: z.string().optional(),
  /** backlog-next's slots here; a new workspace starts with one of each. */
  sweep: WorkspaceSweep.default({ implement: 1, plan: 1 }),
  /** The share of the weekly usage and the mode; a new workspace has no share and continues. */
  allocation: WorkspaceAllocation.default({ share: null, mode: "continuing" }),
  /**
   * When a PBI's Issue is closed, the reports of its work (the Tasks' Markdown / HTML artifacts and links) are attached to
   * that Issue on GitHub as Issue artifacts. Off unless the person turns it on (a preview feature of GitHub's, reached
   * through its CLI only); it has an effect only while the workspace syncs with GitHub.
   */
  issueArtifacts: z.boolean().default(false),
});
export type Workspace = z.infer<typeof Workspace>;

/** 新しいリポジトリ: the name and what it is for. Everything else is decided in the Task's conversation. */
export const NewRepoInput = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  purpose: z.string().trim().min(1).max(2_000),
});
export type NewRepoInput = z.infer<typeof NewRepoInput>;

/** The rules of a workspace kept on Switchboard's side; empty = none. */
export const WorkspaceRulesInput = z.object({ rules: z.string().max(8_000) });
/** The settings of a workspace kept on Switchboard's side (JSON text, the shape of `ops.config.json`); empty = none. */
export const WorkspaceConfigInput = z.object({ config: z.string().max(40_000) });
/**
 * `GET /api/workspaces/:id/config`: the saved text ("" = none), the file the daemon wrote it to (what `OPS_KIT_CONFIG` names for
 * the workspace's Tasks and jobs; null = none saved), and which settings the workspace runs with now: `repository` = its
 * checkout has an `ops.config.json` (that file alone is used), `switchboard` = the saved ones, `none` = neither.
 * `config` is always the confirmed text: a saved change of a key the local CI or the merge gate reads is `pending` until
 * the person confirms it.
 */
export const WorkspaceConfigView = z.object({
  id: z.string(),
  config: z.string(),
  file: z.string().nullable(),
  source: z.enum(["repository", "switchboard", "none"]),
  /** The confirmed text's name (the first 12 hex digits of its sha256; the merge gate prints the same); null = none saved. */
  version: z.string().nullable().default(null),
  /** A change that waits for the person's confirmation among the questions (`askId`): not in force. null = none. */
  pending: z.object({ id: z.number(), askId: z.string(), at: z.number(), source: z.string(), keys: z.array(z.string()), config: z.string() }).nullable().default(null),
});
export type WorkspaceConfigView = z.infer<typeof WorkspaceConfigView>;
export type WorkspaceRulesInput = z.infer<typeof WorkspaceRulesInput>;

/** 立ち上げ: the concept the baseline Task starts from (the p2-baseline candidate). It goes into the Task's first prompt as data, and is kept nowhere else. */
export const BaselineInput = z.object({ concept: z.string().trim().min(1).max(8_000) });
export type BaselineInput = z.infer<typeof BaselineInput>;
