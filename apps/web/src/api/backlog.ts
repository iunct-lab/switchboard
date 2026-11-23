import type { Backlog, BacklogAllocation, BacklogAction, BacklogCreateInput, BacklogEditInput, BacklogIssueDetail, BacklogQueue, BacklogQueueInput, EvalStage, RequestEval, Task } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const backlogApi = {
  backlogAllocation: () => req<BacklogAllocation>("/api/backlog/allocation"),
  /** Open requests and PBIs of every registered workspace's GitHub backlog; as stored by the daemon's last import; refresh imports first. */
  backlog: (refresh = false) => req<Backlog>(`/api/backlog${refresh ? "?refresh=1" : ""}`),
  /** The backlog queue: the PBIs to implement in order, kept in the daemon; the closed ones moved to `ended`. */
  backlogQueue: () => req<BacklogQueue>("/api/backlog/queue"),
  /** Changes the fields of the queue it names and answers the queue as stored. */
  saveBacklogQueue: (input: BacklogQueueInput) => req<BacklogQueue>("/api/backlog/queue", { method: "PUT", body: JSON.stringify(input) }),
  /** Starts a row's next stage as a meta Task. 409 with `body.taskId` = that stage is already running. */
  startBacklog: (workspaceId: string, n: number, action: BacklogAction) => req<Task>(`/api/backlog/${n}/start`, { method: "POST", body: JSON.stringify({ workspaceId, action }) }),
  /** Answers a needs-decision item: `## 回答` on the Issue and the label off. */
  answerBacklog: (workspaceId: string, n: number, text: string, issue?: number, at?: string) => req<{ ok: boolean }>(`/api/backlog/${n}/answer`, { method: "POST", body: JSON.stringify({ workspaceId, text, issue, at }) }),
  /** One stored Issue with its stored edits, held conflicts and sync; `ref` = its number or the localId of one made here. */
  backlogIssue: (workspaceId: string, ref: number | string) => req<BacklogIssueDetail>(`/api/backlog/${ref}?workspaceId=${encodeURIComponent(workspaceId)}`),
  /** Keeps an edit here (202) and sends it to GitHub later; with `resolve` alone, a choice on a held conflict (409 = it moved since read). */
  editBacklog: (workspaceId: string, ref: number | string, edit: Omit<BacklogEditInput, "workspaceId">) => req<{ localId: string | null; operations?: string[] }>(`/api/backlog/${ref}`, { method: "PATCH", body: JSON.stringify({ workspaceId, ...edit }) }),
  /** A new Issue kept here (202, its localId) and created on GitHub later. */
  createBacklog: (workspaceId: string, input: Partial<Omit<BacklogCreateInput, "workspaceId">> & { title: string }) => req<{ localId: string }>("/api/backlog", { method: "POST", body: JSON.stringify({ workspaceId, ...input }) }),
  /** A plain comment kept here and sent later. */
  commentBacklog: (workspaceId: string, n: number, text: string) => req<{ operation: string }>(`/api/backlog/${n}/comment`, { method: "POST", body: JSON.stringify({ workspaceId, text }) }),
  /** The Insights summary: this week's tasks to rate and the human − judge gap. */
  /** The evaluation of a closed request with its PBIs as one unit: the stages that went wrong, a rating and a note; one per request. */
  setRequestEval: (workspaceId: string, number: number, body: { stages: EvalStage[]; rating: number; comment: string }) => req<RequestEval>(`/api/backlog/${number}/evals/human`, { method: "PUT", body: JSON.stringify({ workspaceId, ...body }) }),
  clearRequestEval: (workspaceId: string, number: number) => req<{ ok: true }>(`/api/backlog/${number}/evals/human?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" }),
};
