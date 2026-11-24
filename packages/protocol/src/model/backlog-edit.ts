import { z } from "zod";
import { BacklogItem } from "./backlog.ts";

const fieldValue = z.union([z.string(), z.number(), z.null()]);
/** A branch name as `refs/heads/<name>` takes it: no space, `..`, `@{`, `//`, not starting with `-` or `/`, not ending with `/`, `.` or `.lock`. */
const branchName = z.string().min(1).max(255).regex(/^(?![-/])(?!.*(?:\.\.|@\{|\/\/))(?!.*(?:\/|\.|\.lock)$)[^\s~^:?*\[\\]+$/, "枝の名前ではありません");
const issueText = { title: z.string().trim().min(1).max(256), body: z.string().max(65_536) };

/**
 * An edit of one stored Issue (`PATCH /api/backlog/:number`), kept here and sent to GitHub later: only the fields
 * given change. `labels` adds / removes names; `project` puts it in the workspace's Project or takes it out, `fields`
 * sets that Project's fields by name. An unknown key is refused.
 */
export const BacklogEditInput = z
  .object({
    workspaceId: z.string(),
    title: issueText.title.optional(),
    body: issueText.body.optional(),
    labels: z.object({ add: z.array(z.string().min(1)).default([]), remove: z.array(z.string().min(1)).default([]) }).strict().optional(),
    state: z.enum(["OPEN", "CLOSED"]).optional(),
    /** Why it is closed: only with `state: "CLOSED"` — closing it, or changing the reason of one closed. */
    stateReason: z.enum(["COMPLETED", "NOT_PLANNED"]).optional(),
    milestone: z.string().min(1).nullable().optional(),
    parent: z.number().int().positive().nullable().optional(),
    project: z.boolean().optional(),
    fields: z.record(z.string().min(1), fieldValue).optional(),
    /**
     * A choice on a held conflict instead of an edit: `field` as the held edit names it, `local` = send the value
     * made here (on GitHub's), `remote` = keep GitHub's; `expectedRevision` = the conflict's `revision` as read.
     */
    resolve: z.object({ field: z.string().min(1), choice: z.enum(["local", "remote"]), expectedRevision: z.string().min(1) }).strict().optional(),
    /** Sends a `failed` operation of the Issue again, its cause put right: `operation` = the held edit's id. */
    retry: z.object({ operation: z.string().min(1) }).strict().optional(),
    /** Takes back a comment still inside its send window (60 s): `operation` = the held edit's id. */
    cancel: z.object({ operation: z.string().min(1) }).strict().optional(),
    /** Takes back an `unknown` / `failed` operation of the Issue: nothing is sent for it; `reason` is kept with it. */
    withdraw: z.object({ operation: z.string().min(1), reason: z.string().min(1).max(200) }).strict().optional(),
    /** A local change merged: the tip its base was moved to, and when. Or `reportedAt` alone: its summary was left on GitHub. */
    change: z.union([
      z.object({ mergeCommit: z.string().regex(/^[0-9a-f]{40}$/), mergedAt: z.string().min(1), reviewedHead: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
      z.object({ reportedAt: z.string().min(1) }).strict(),
    ]).optional(),
  })
  .strict()
  .refine((e) => !e.resolve || Object.keys(e).every((k) => k === "workspaceId" || k === "resolve"), { message: "resolve は編集と一緒には送れません" })
  .refine((e) => !e.retry || Object.keys(e).every((k) => k === "workspaceId" || k === "retry"), { message: "retry は編集と一緒には送れません" })
  .refine((e) => !e.cancel || Object.keys(e).every((k) => k === "workspaceId" || k === "cancel"), { message: "cancel は編集と一緒には送れません" })
  .refine((e) => !e.withdraw || Object.keys(e).every((k) => k === "workspaceId" || k === "withdraw"), { message: "withdraw は編集と一緒には送れません" })
  .refine((e) => !e.stateReason || e.state === "CLOSED", { message: "閉じた理由は state CLOSED と一緒に送ります" })
  .refine((e) => !e.change || "reportedAt" in e.change || e.state === "CLOSED", { message: "変更のマージは state CLOSED と一緒に送ります" });
export type BacklogEditInput = z.infer<typeof BacklogEditInput>;

/** A new Issue (`POST /api/backlog`), kept here and created on GitHub later; `fields` puts it in the workspace's Project. */
export const BacklogCreateInput = z
  .object({
    workspaceId: z.string(),
    title: issueText.title,
    body: issueText.body.default(""),
    labels: z.array(z.string().min(1)).default([]),
    milestone: z.string().min(1).nullable().default(null),
    parent: z.number().int().positive().nullable().default(null),
    fields: z.record(z.string().min(1), fieldValue).nullable().default(null),
    /**
     * Makes it a local change: the branch to merge and the one it goes into. A workspace whose Issues are GitHub's keeps
     * it apart from them, numbered from 1; `pr` (only there) = the PR it stands in for.
     */
    change: z.object({ head: branchName, base: branchName, pr: z.number().int().positive().optional() }).strict().optional(),
  })
  .strict();
export type BacklogCreateInput = z.infer<typeof BacklogCreateInput>;

/** An Issue a Task opened: the URL in the result of its `gh issue create` / `request_issue.sh`. `repo` is `owner/name`, lower case. */
export const CreatedIssue = z.object({ repo: z.string(), number: z.number() });
export type CreatedIssue = z.infer<typeof CreatedIssue>;

/**
 * An open request or PBI a Task opened, as the Task's screen lists it: the stored Issue's title and URL, in the
 * workspace whose backlog reads its repository. `item` = its backlog item with its stage Task (withActive); null where
 * the backlog has none (a request with a derived PBI).
 */
export const CreatedIssueRow = CreatedIssue.extend({ workspaceId: z.string(), title: z.string(), url: z.string(), kind: z.enum(["request", "pbi"]), item: BacklogItem.nullable() });
export type CreatedIssueRow = z.infer<typeof CreatedIssueRow>;
