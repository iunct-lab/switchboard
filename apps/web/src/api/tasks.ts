import type { Artifact, Attachment, CheckRun, CloudPreparation, CreatedIssue, CreatedIssueRow, CreateTaskInput, DeviceAuthView, EventEnvelope, Footprint, HumanAnswers, HistorySession, Queue, RoutingSuggestion, StagedChange, StopSummary, SuggestInput, Task, TaskDiffFile, TaskEvals, TaskOutcome, TaskListItem, TaskStopMark, TeleportProgress } from "@switchboard/protocol";
import type { EventsArchive } from "../events-archive.ts";
import { req } from "./request.ts";

export interface TaskDetail {
  localContinuations: Task[];
  sourceCloudTask: Task | null;
  task: Task;
  events: EventEnvelope[];
  cost: { costUsd: number; tokens: number };
  /** The Claude Code session log behind this task, once the daemon has seen it; null for the rest. */
  history: HistorySession | null;
  /** Files sent with this task's turns, in the order they were sent. */
  attachments: Attachment[];
  /** The stops of this task's work as series: counts, answers, what changed, what is needed next. */
  stopSummary?: StopSummary[];
  /** Where the conversation went once it was moved to S3; null when it is still here. */
  eventsArchive?: EventsArchive | null;
  /** "Continue locally": where it is for this Cloud Task; null when none was started since the daemon came up. */
  teleport?: TeleportProgress | null;
  /** The MCP servers this task's Claude gets (`mcp.yaml` servers); the user-wide ones are not handed over. Empty for other runners and Cloud. */
  mcpServers?: string[];
  /** The Issues this task opened (`gh issue create` / `request_issue.sh`); not shown on any screen. */
  createdIssues?: CreatedIssue[];
  /** The open requests and PBIs among them with their backlog items: the Task screen's この Task が作った Issue. Only on a read of the latest events (not `after` / `before`). */
  createdRows?: CreatedIssueRow[];
  /** Its final report put something off (the words of DEFERRED_WORDS); not shown on any screen. */
  deferred?: boolean;
}

/** Events per 「以前の会話を読む」; the daemon sends the last 200 when a Task is opened. */
export const OLDER_PAGE = 200;

/** The calls of this group; `api` (index.ts) holds every group's. */
export const tasksApi = {
  /** 改善要望にする: the draft the feedback dialog opens with for a task's evaluations. */
  evalsDraft: (id: string) => req<{ text: string }>(`/api/tasks/${id}/evals/draft`),
  taskStops: () => req<Record<string, TaskStopMark>>("/api/tasks/stops"),
  tasks: (opts: { archived?: boolean } = {}) => req<TaskListItem[]>(opts.archived ? "/api/tasks?archived=1" : "/api/tasks"),
  // after: only the events past that seq (the catch-up after a dropped WebSocket)
  /** The Task without its events: what a turn's end changes besides them (cost, stops, history). */
  taskMeta: (id: string) => req<TaskDetail>(`/api/tasks/${id}?limit=0`),
  /** The `limit` events just before `before`: the page above what the Task screen holds. */
  taskEvents: (id: string, before: number, limit = OLDER_PAGE) => req<TaskDetail>(`/api/tasks/${id}?before=${before}&limit=${limit}`).then((d) => d.events),
  /** Every event past `seq`, never cut to a page (0 = the whole log): what comparing a fork with its parent reads. */
  taskSince: (id: string, seq: number) => req<TaskDetail>(`/api/tasks/${id}?after=${seq}`),
  task: (id: string, after = 0) => req<TaskDetail>(`/api/tasks/${id}${after > 0 ? `?after=${after}` : ""}`),
  /** A Task's approval wait; null when there is none. */
  /** Start the official Teleport for a Cloud Task; progress comes as task.teleport. Rejects with the reason it was refused. */
  startTeleport: (id: string) => req<{ started: true }>(`/api/tasks/${id}/teleport`, { method: "POST" }),
  deviceAuth: (id: string) => req<DeviceAuthView | null>(`/api/tasks/${id}/device-auth`),
  renameTask: (id: string, title: string) => req<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  createTask: (input: CreateTaskInput) => req<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  suggest: (input: SuggestInput) => req<RoutingSuggestion & { source: string; cloudPreparation?: CloudPreparation }>("/api/tasks/suggest", { method: "POST", body: JSON.stringify(input) }),
  send: (id: string, text: string, attachmentIds?: string[]) => req<Task>(`/api/tasks/${id}/send`, { method: "POST", body: JSON.stringify({ text, attachmentIds }) }),
  /** Fork a Task from the finished turn whose `session.end` is at `seq`: the new Task, idle until its first reply. */
  forkTask: (id: string, seq: number) => req<Task>(`/api/tasks/${id}/fork`, { method: "POST", body: JSON.stringify({ seq }) }),
  /** Artifacts: reports registered on the Task screen. `viewArtifact` gives the url the daemon serves it from. */
  listArtifacts: (taskId: string) => req<Artifact[]>(`/api/tasks/${taskId}/artifacts`),
  addArtifact: (taskId: string, body: { source: string; title?: string }) => req<Artifact>(`/api/tasks/${taskId}/artifacts`, { method: "POST", body: JSON.stringify(body) }),
  permission: (id: string, permId: string, decision: "allow" | "deny") => req<Task>(`/api/tasks/${id}/permission`, { method: "POST", body: JSON.stringify({ id: permId, decision }) }),
  abort: (id: string) => req<Task>(`/api/tasks/${id}/abort`, { method: "POST" }),
  /** Change the permission mode of an existing task: live for Claude, next turn for Codex. */
  setPermissionMode: (id: string, mode: string) => req<Task>(`/api/tasks/${id}/permission-mode`, { method: "POST", body: JSON.stringify({ mode }) }),
  /** Change the model of an existing task: used from the next turn. null = the CLI's default. */
  setTaskModel: (id: string, model: string | null) => req<Task>(`/api/tasks/${id}/model`, { method: "POST", body: JSON.stringify({ model }) }),
  /** Change the thinking effort of an existing task: used from the next turn. null = the CLI's default. */
  setTaskEffort: (id: string, effort: string | null) => req<Task>(`/api/tasks/${id}/effort`, { method: "POST", body: JSON.stringify({ effort }) }),
  /** Usage-limit resume: send the follow-up now, or forget the planned resume. */
  resumeNow: (id: string, text?: string) => req<Task>(`/api/tasks/${id}/resume`, { method: "POST", ...(text?.trim() ? { body: JSON.stringify({ text: text.trim() }) } : {}) }),
  cancelResume: (id: string) => req<Task>(`/api/tasks/${id}/resume`, { method: "DELETE" }),
  footprint: (id: string) => req<Footprint>(`/api/tasks/${id}/footprint`),
  mcpEndpoint: (id: string) => req<{ url: string; token: string }>(`/api/tasks/${id}/mcp`),
  mcpRotate: (id: string) => req<{ url: string; token: string }>(`/api/tasks/${id}/mcp/rotate`, { method: "POST" }),
  staging: (id: string) => req<Array<Omit<StagedChange, "before" | "after">>>(`/api/tasks/${id}/staging`),
  taskDiff: (id: string) => req<TaskDiffFile[]>(`/api/tasks/${id}/diff`),
  checks: (id: string) => req<{ run: CheckRun | null; running: boolean; meta: boolean; current: boolean }>(`/api/tasks/${id}/checks`),
  runChecks: (id: string) => req<{ run: CheckRun | null; running: boolean; meta: boolean; current: boolean }>(`/api/tasks/${id}/checks`, { method: "POST" }),
  queue: () => req<Queue>("/api/queue"),
  stagingApply: (id: string, sid: string) => req<StagedChange>(`/api/tasks/${id}/staging/${sid}/apply`, { method: "POST" }),
  stagingReject: (id: string, sid: string) => req<StagedChange>(`/api/tasks/${id}/staging/${sid}/reject`, { method: "POST" }),
  /** Evals: the task's rule metrics (and later the judge's and the person's evaluations). */
  taskEvals: (id: string) => req<TaskEvals>(`/api/tasks/${id}/evals`),
  /** 再評価: scores the task now, in the background; the result arrives as evals.updated. */
  judgeEvals: (id: string) => req<{ queued: boolean }>(`/api/tasks/${id}/evals/judge`, { method: "POST" }),
  /** The person's own rating and note: one per task, replaced; DELETE clears it. Both answer the task's evals. */
  setHumanEval: (id: string, body: { rating: number; comment: string } & HumanAnswers) => req<TaskEvals>(`/api/tasks/${id}/evals/human`, { method: "PUT", body: JSON.stringify(body) }),
  clearHumanEval: (id: string) => req<TaskEvals>(`/api/tasks/${id}/evals/human`, { method: "DELETE" }),
  setArchived: (id: string, archived: boolean) => req<Task>(`/api/tasks/${id}/archive`, { method: "POST", body: JSON.stringify({ archived }) }),
  setOutcome: (id: string, body: { outcome?: TaskOutcome; reviewed?: boolean }) => req<{ task: Task }>(`/api/tasks/${id}/outcome`, { method: "POST", body: JSON.stringify(body) }),
  setBudget: (id: string, budgetUsd: number | null) => req<{ task: Task; overBudget: boolean }>(`/api/tasks/${id}/budget`, { method: "POST", body: JSON.stringify({ budgetUsd }) }),
};
