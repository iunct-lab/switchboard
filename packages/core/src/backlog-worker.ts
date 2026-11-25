/**
 * The Task that wrote a claim comment of the parallel guard, and whether it still holds what it claimed: the stored
 * operation that wrote the comment names the Task that asked for it (`backlog_operations.task_id`).
 */
import { personWait, type BacklogCommentData, type BacklogIssueData, type BacklogRepositoryKey, type BacklogSource } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { claimOn } from "./backlog-overlap.ts";
import { shown, shownRecords } from "./backlog-stored.ts";

export type ClaimTask = { id: string; stageIssue: number | null; holds: boolean };

/**
 * `commentId` (the stored record's id) -> its Task; null = no Task is known (written outside the app, by another machine,
 * before operations kept their Task). `holds` = the Task is not archived and is at work (running, waiting for approval, a
 * background or daemon job, a planned resume, a run slot, being judged) or waits for the person (`needs`). A Task whose row
 * is gone holds nothing.
 */
export function claimTaskOf(db: Db, source: BacklogRepositoryKey): (commentId: string) => ClaimTask | null {
  return (commentId) => {
    const id = db.backlogOperationTask(source, commentId);
    if (id === null) return null;
    const task = db.getTask(id);
    if (!task) return { id, stageIssue: null, holds: false };
    return { id, stageIssue: task.stage?.issue ?? null, holds: task.archivedAt === null && (db.taskAtWork(id) || personWait(task) === "needs") };
  };
}

const sameSource = (a: BacklogRepositoryKey, b: BacklogRepositoryKey) => a.service === b.service && a.host === b.host && a.repository === b.repository;

/**
 * Who works on PBI `pbi` of a repository: the stage Task that runs on it (`by: "stage"`), else the Task that holds it by a claim
 * of the parallel guard (`by: "claim"`; `taskId` null = a claim whose Task is not known). null = nobody. One answer: a stage
 * Task wins over a claim.
 */
export function pbiWorker(db: Db, source: BacklogSource, pbi: number): { taskId: string | null; by: "stage" | "claim" } | null {
  const workspaces = db.listWorkspaces().filter((w) => { const s = db.getWorkspaceBacklogSource(w.id); return !!s && sameSource(s, source); });
  for (const w of workspaces) {
    const t = db.activeStageTask(w.id, pbi);
    if (t) return { taskId: t.id, by: "stage" };
  }
  const records = shownRecords(db, source);
  const ids = new Map<BacklogCommentData, string>();
  const comments = records.flatMap((r) => {
    const c = r.objectKind === "comment" ? (r.remote as BacklogCommentData) : null;
    if (c?.issue !== pbi) return [];
    ids.set(c, r.externalId);
    return [c];
  }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const taskOf = claimTaskOf(db, source);
  for (const w of workspaces) {
    const claim = claimOn({
      commentsOf: () => comments,
      ended: (n, at) => db.endedStageRanAt(w.id, n, at),
      claimTask: (c) => { const id = ids.get(c as BacklogCommentData); return id === undefined ? null : taskOf(id); },
    })(pbi);
    if (claim) return { taskId: claim.taskId, by: "claim" };
  }
  return null;
}

/**
 * The refusal of a child under PBI `parent` made by Task `caller` (null = no Task is proven: the screen, a Task whose proof
 * could not be read, another machine's envelope), or null when it may be made: no parent, nobody works on the PBI, or the
 * caller is the one that does (two unknowns are not the same Task). The text names the Task and lists the children it made
 * (those not sent yet too: the ones already numbered `#N title`, the others `送信待ち <localId> title`).
 */
export function heldParentRefusal(db: Db, source: BacklogSource, parent: number | null, caller: string | null): string | null {
  if (parent === null) return null;
  const worker = pbiWorker(db, source, parent);
  if (!worker || (worker.taskId !== null && worker.taskId === caller)) return null;
  const records = new Map(db.listBacklogRecords(source, "issue").map((r) => [r.externalId, r]));
  const children = db.listBacklogOperations(source).flatMap((o) => {
    if (o.kind !== "create" || (o.payload as { parent?: number | null }).parent !== parent || (worker.taskId !== null && o.taskId !== worker.taskId)) return [];
    const rec = records.get(o.remoteId ?? o.target) ?? records.get(o.target);
    const value = rec ? (shown(rec) as BacklogIssueData | null) : null;
    const title = value?.title ?? (o.payload as { title?: string }).title ?? "";
    return [value?.number ? `#${value.number} ${title}` : `送信待ち ${o.target.replace(/^local:/, "")} ${title}`];
  });
  return [
    `#${parent} は Task ${worker.taskId ?? "（不明）"}（${worker.by === "stage" ? "工程の Task" : "占有"}）が扱っています。子は作りません`,
    ...(children.length ? ["その Task が作った子:", ...children.map((c) => `- ${c}`)] : []),
    "相手の一覧を読んで、自分の分解をやめる",
  ].join("\n");
}
