import type { AnswerPolicy, Artifact, AskAnswer, AskAnswerResult, AskList, Attachment, Backlog, BacklogAction, BacklogCreateInput, BacklogEditInput, BacklogIssueDetail, CheckRun, CloudPreparation, CreateTaskInput, DeviceAuthView, EvalsListRow, EventEnvelope, FeedbackInput, FlowView, Footprint, HistoryScanResult, HistorySession, HistoryStatus, InboxNote, InterventionView, KnowledgeDoc, KnowledgeSearchHit, LedgerDaily, LedgerModelRow, LedgerSummary, LedgerTaskRow, OpsLatency, OpsLoad, OpsStops, PendingApproval, PerfSample, PerfSummaryRow, PolicyInput, PolicyList, PolicyPatch, Preset, PresetExpandInput, PresetExpansion, PresetInput, PresetList, PricingTable, Queue, ReportRow, RoutingLogRow, RoutingStats, RoutingSuggestion, RunnerId, RunnerInfo, Schedule, ScheduleInput, ServerMessage, Settings, SettingsPatch, StagedChange, StopSummary, SuggestInput, Task, TaskDiffFile, TaskEvals, TaskOutcome, TeleportProgress, Workspace, WorkspaceRemoval, WorkspaceSweep } from "@switchboard/protocol";
import { hasTypedText, hostStopped, LEAVE_STOPPED, loginRoute, stoppedRoute, type LoginMode } from "./login.ts";
import type { ReleaseStatus } from "./release.ts";
import type { EventsArchive } from "./events-archive.ts";
import { RECENT_MESSAGE, askRecentCheck, isRecentRefusal } from "./recent.ts";
export type { InboxNote };

/** The daemon's view of a runner login started from the screen (#354; mirrors packages/core/src/runnerlogin.ts). */
export interface RunnerLoginView {
  runner: string;
  state: "waiting" | "done" | "failed";
  url?: string;
  code?: string;
  needsCode: boolean;
  error?: string;
}

export interface Health {
  ok: boolean;
  protocol: string;
  /** Absent until the request is authorized (off-loopback without the token). */
  runners?: RunnerInfo[];
  home: string;
  /** `home` with the daemon user's home directory shortened to `~` (the daemon knows homedir(); the browser does not). */
  homeDisplay?: string;
  /** The data directory is under the OS temp area: what is recorded there can vanish (#64). */
  homeIsTemp?: boolean;
  repoRoot: string;
  /** True when the daemon listens off-loopback and /api needs the token from ~/.switchboard/token. */
  authRequired: boolean;
  /** How a person gets in before being authorized (#211): the cloud host's passkey page, or the token. */
  login?: LoginMode;
  /** When the cloud login's idle time and cap end (ms; #498); only for a request that came in with the login cookie. */
  session?: { idleUntil: number; expiresAt: number };
  /** LLM routing suggestions (#25): the saved setting plus whether this daemon can actually produce them. */
  routing?: { llm: { enabled: boolean; runner: RunnerId; model: string; available: boolean } };
  mcp: { base: string };
  /** What this distribution of the daemon can do. pty = the terminal tab (#16). */
  features?: { pty: boolean };
  /** A problem with the cloud host's daily history archive (packages/core/src/archive-status.ts, #1201); null when there is none. */
  archive?: { kind: "failed" | "stuck" | "stale"; at: number; detail?: string } | null;
}

const TOKEN_KEY = "switchboard.token";
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export interface KnowledgeIndex {
  dir: string;
  /** Set when the folder could not be prepared (unwritable path); the index is then empty. */
  disabled: string | null;
  git: { isRepo: boolean; clean: boolean | null };
  docs: KnowledgeDoc[];
}
export interface KnowledgeDocDetail {
  doc: KnowledgeDoc;
  content: string;
  body: string;
}

export interface MaterializeFile {
  relPath: string;
  abs: string;
  target: string;
  sources: string[];
  exists: boolean;
  status: "new" | "changed" | "unchanged" | "removed";
  conflicts: string[];
  handwrittenBytes: number;
  diff: string;
  next: string;
  hash: string;
}
export interface MaterializeApplyResult {
  written: string[];
  removed: string[];
  skipped: Array<{ relPath: string; reason: "conflict" | "stale" }>;
  files: MaterializeFile[];
  warnings: Array<{ path: string; message: string }>;
}

/** Evals (#1221): where a request was drafted from; goes into its 出典. The protocol's own shape, so the two cannot drift. */
export type FeedbackSource = NonNullable<FeedbackInput["source"]>;

export interface TaskDetail {
  localContinuations: Task[];
  sourceCloudTask: Task | null;
  task: Task;
  events: EventEnvelope[];
  cost: { costUsd: number; tokens: number };
  /** The Claude Code session log behind this task, once the daemon has seen it (#91); null for the rest. */
  history: HistorySession | null;
  /** Files sent with this task's turns (#125), in the order they were sent. */
  attachments: Attachment[];
  /** The stops of this task's work as series (#939): counts, answers, what changed, what is needed next. */
  stopSummary?: StopSummary[];
  /** Where the conversation went once it was moved to S3 (#1431); null when it is still here. */
  eventsArchive?: EventsArchive | null;
  /** "Continue locally" (#1306): where it is for this Cloud Task; null when none was started since the daemon came up. */
  teleport?: TeleportProgress | null;
  /** The MCP servers this task's Claude gets (#2090, `mcp.yaml` servers); the user-wide ones are not handed over. Empty for other runners and Cloud. */
  mcpServers?: string[];
}

/** What `/api/health` said about the login (#211); set by health() so a later 401 knows where to send the browser. */
let loginMode: LoginMode | undefined;

/** When the user said 移らない, the failing requests of the next minute do not ask again. */
let declinedAt = 0;
function mayLeave(): boolean {
  if (!hasTypedText(document)) return true;
  if (Date.now() - declinedAt < 60_000) return false;
  if (confirm(LEAVE_STOPPED)) return true;
  declinedAt = Date.now();
  return false;
}

/** After an action that changed something, the cloud login's idle time is moved on (#498): the Starter alone can sign the cookie again, so this asks it; at most once every RENEW_EVERY_MS, and a failure is not an error of the action. */
export const RENEW_EVERY_MS = 10 * 60_000;
let renewedAt = 0;
export function renewLogin(mode: LoginMode | undefined, method: string | undefined, now = Date.now(), send: () => Promise<unknown> = () => fetch("/_auth/renew", { method: "POST", credentials: "same-origin" })): boolean {
  if (mode !== "passkey" || !method || method === "GET" || method === "HEAD" || now - renewedAt < RENEW_EVERY_MS) return false;
  renewedAt = now;
  void send().catch(() => {});
  return true;
}
/** Test hook: forget the last renewal. */
export const resetRenewal = () => { renewedAt = 0; };

async function req<T>(url: string, init?: RequestInit, retried = false): Promise<T> {
  const token = getToken();
  // A FormData body sets its own multipart content-type (with the boundary); forcing JSON here would break it.
  const headers: Record<string, string> = init?.body instanceof FormData ? {} : { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    // a strong operation wants a passkey check from the last 5 minutes (#1491): ask once, then send it again once
    if (isRecentRefusal(r.status, body)) {
      if (!retried && (await askRecentCheck())) return req<T>(url, init, true);
      throw Object.assign(new Error(RECENT_MESSAGE), { status: r.status, body });
    }
    // the cloud host is stopped (CloudFront's HTML page instead of JSON): to the login page, which starts it (#211) —
    // once /api/health says so too; one dropped connection gets the same page and must not throw away the screen.
    // A longer outage of a running daemon looks the same, so with text typed on the page the user decides.
    const stopped = stoppedRoute({ status: r.status, contentType: r.headers.get("content-type"), path: location.pathname + location.search });
    if (stopped && (await hostStopped()) && mayLeave()) location.replace(stopped);
    // the cloud login cookie expired mid-session: back to the passkey page, then here again (#211)
    if (r.status === 401 && loginMode === "passkey") {
      const to = loginRoute({ authorized: false, hasToken: !!token, mode: loginMode, path: location.pathname + location.search });
      if (to.kind === "passkey") location.assign(to.url);
    }
    // `status` and `body` ride along so a caller can tell a refusal it can act on (409, e.g. with a taskId) from a failure it cannot
    throw Object.assign(new Error((body as { error?: string }).error ?? `${r.status} ${r.statusText}`), { status: r.status, body });
  }
  renewLogin(loginMode, init?.method?.toUpperCase());
  return (await r.json()) as T;
}

/** GET / PATCH /api/settings: the saved settings, the runners, and the defaults of the tunables (#835) for the settings screen. */
export type SettingsResponse = Settings & { runners: RunnerInfo[]; defaults: Pick<Settings, "quotaAndResume" | "judgeAndChoice" | "newDefaults"> };

/** Events per 「以前の会話を読む」 (#1142); the daemon sends the last 200 when a Task is opened. */
export const OLDER_PAGE = 200;

/** A clone going on or failed (#2575); a finished one is a workspace and no longer listed. */
export type WorkspaceClone = { repo: string; path: string; state: "cloning" | "failed"; error?: string };

export const api = {
  feedback: (text: string, attachmentIds?: string[], screen?: string, mode: "request" | "fix" = "request", workspaceId?: string, source?: FeedbackSource) => req<Task>("/api/feedback", { method: "POST", body: JSON.stringify({ text, attachmentIds, screen, mode, workspaceId, source }) }),
  /** 改善要望にする (#1221): the draft the feedback dialog opens with for a task's evaluations. */
  evalsDraft: (id: string) => req<{ text: string }>(`/api/tasks/${id}/evals/draft`),
  /** A runner's own login from the screen (#354): the URL / device code it prints, or a box for its page's code. */
  runnerLogin: (runner: string, kind?: "console") => req<RunnerLoginView>(`/api/runners/${runner}/login${kind ? "?billing=api" : ""}`, { method: "POST" }),
  /** The runner's own logout (#2528); the login is read again, so the next health says it is logged out. */
  runnerLogout: (runner: string) => req<{ ok: boolean }>(`/api/runners/${runner}/logout`, { method: "POST" }),
  runnerLoginState: (runner: string) => req<RunnerLoginView>(`/api/runners/${runner}/login`),
  runnerLoginCode: (runner: string, code: string) => req<RunnerLoginView>(`/api/runners/${runner}/login/code`, { method: "POST", body: JSON.stringify({ code }) }),
  runnerLoginCancel: (runner: string) => req<RunnerLoginView>(`/api/runners/${runner}/login`, { method: "DELETE" }),
  /** `recheck` = ask the runners' login status commands again now instead of within the minute (#180). */
  health: (opts: { recheck?: boolean } = {}) => req<Health>(opts.recheck ? "/api/health?recheck=1" : "/api/health").then((h) => ((loginMode = h.login), h)),
  workspaces: () => req<Workspace[]>("/api/workspaces"),
  /** `backlog`: `switchboard` keeps the workspace's Issues and Project in Switchboard only (#2265); PRs stay with the repository. */
  addWorkspace: (path: string, backlog: "github" | "switchboard" = "github") => req<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ path, backlog }) }),
  /** A GitHub repository added by name (#2575): answers at once (202); the clone goes on in the daemon, see `workspaceClones`. */
  addWorkspaceFromGithub: (repo: string, backlog: "github" | "switchboard" = "github") => req<{ repo: string; path: string; state: "cloning" }>("/api/workspaces", { method: "POST", body: JSON.stringify({ repo, backlog }) }),
  workspaceRemoval: (id: string) => req<WorkspaceRemoval>(`/api/workspaces/${id}/removal`),
  removeWorkspace: (id: string, deleteCopy: boolean) => req<{ ok: true }>(`/api/workspaces/${id}`, { method: "DELETE", body: JSON.stringify({ deleteCopy }) }),
  workspaceClones: () => req<WorkspaceClone[]>("/api/workspaces/clones"),
  /**
   * Turns the workspace's GitHub sync off (`switchboard`) or on (`github`, #2266): on answers how far it is (202), or
   * rejects with why GitHub could not be read (424, nothing changed). `projectVar` = the Project of one kept here only.
   */
  setWorkspaceBacklog: (id: string, backlog: "github" | "switchboard", projectVar?: string | null) =>
    req<Workspace & { enabling?: { total: number; done: number } }>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ backlog, ...(projectVar === undefined ? {} : { projectVar }) }) }),
  setWorkspaceSweep: (id: string, sweep: Partial<WorkspaceSweep>) => req<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ sweep }) }),
  setWorkspaceProjectVar: (id: string, projectVar: string | null) => req<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ projectVar }) }),
  workspaceBrief: (id: string) => req<{ workspaceId: string; text: string }>(`/api/workspaces/${id}/brief`),
  tasks: (opts: { archived?: boolean } = {}) => req<Task[]>(opts.archived ? "/api/tasks?archived=1" : "/api/tasks"),
  // after: only the events past that seq (the catch-up after a dropped WebSocket, #1137)
  /** The Task without its events (#1142): what a turn's end changes besides them (cost, stops, history). */
  taskMeta: (id: string) => req<TaskDetail>(`/api/tasks/${id}?limit=0`),
  /** The `limit` events just before `before` (#1142): the page above what the Task screen holds. */
  taskEvents: (id: string, before: number, limit = OLDER_PAGE) => req<TaskDetail>(`/api/tasks/${id}?before=${before}&limit=${limit}`).then((d) => d.events),
  task: (id: string, after = 0) => req<TaskDetail>(`/api/tasks/${id}${after > 0 ? `?after=${after}` : ""}`),
  /** A Task's approval wait (#662); null when there is none. */
  /** Start the official Teleport for a Cloud Task; progress comes as task.teleport. Rejects with the reason it was refused. */
  startTeleport: (id: string) => req<{ started: true }>(`/api/tasks/${id}/teleport`, { method: "POST" }),
  deviceAuth: (id: string) => req<DeviceAuthView | null>(`/api/tasks/${id}/device-auth`),
  newRepo: (name: string, purpose: string) => req<Task>("/api/new-repo", { method: "POST", body: JSON.stringify({ name, purpose }) }),
  renameTask: (id: string, title: string) => req<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  createTask: (input: CreateTaskInput) => req<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  suggest: (input: SuggestInput) => req<RoutingSuggestion & { source: string; cloudPreparation?: CloudPreparation }>("/api/tasks/suggest", { method: "POST", body: JSON.stringify(input) }),
  send: (id: string, text: string, attachmentIds?: string[]) => req<Task>(`/api/tasks/${id}/send`, { method: "POST", body: JSON.stringify({ text, attachmentIds }) }),
  /** Attachments (#125): upload first, then send the ids with a turn. */
  uploadAttachments: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("file", f, f.name);
    return req<Attachment[]>("/api/attachments", { method: "POST", body: fd });
  },
  /** Artifacts (#1777): reports registered on the Task screen. `viewArtifact` gives the url the daemon serves it from. */
  listArtifacts: (taskId: string) => req<Artifact[]>(`/api/tasks/${taskId}/artifacts`),
  addArtifact: (taskId: string, body: { source: string; title?: string }) => req<Artifact>(`/api/tasks/${taskId}/artifacts`, { method: "POST", body: JSON.stringify(body) }),
  removeArtifact: (id: string) => req<Artifact>(`/api/artifacts/${id}`, { method: "DELETE" }),
  restoreArtifact: (id: string) => req<Artifact>(`/api/artifacts/${id}/restore`, { method: "POST" }),
  refreshArtifact: (id: string) => req<Artifact>(`/api/artifacts/${id}/refresh`, { method: "POST" }),
  viewArtifact: (id: string) => req<{ url: string }>(`/api/artifacts/${id}/view`, { method: "POST" }),
  /** Reports across Tasks (#1835): every task's HTML artifacts, newest first. */
  reports: (limit = 20) => req<ReportRow[]>(`/api/reports?limit=${limit}`),
  deleteAttachment: (id: string) => req<{ ok: boolean }>(`/api/attachments/${id}`, { method: "DELETE" }),
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
  /** The bytes, with the token when one is set (an <img src> could not send it). */
  attachmentBlob: async (id: string): Promise<Blob> => {
    const token = getToken();
    const r = await fetch(`/api/attachments/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.blob();
  },
  /** Unanswered permission asks across tasks, newest first (#26). */
  approvals: () => req<PendingApproval[]>("/api/approvals"),
  /** Every question waiting on the user, and those answered / resolved within the day (#935). */
  asks: () => req<AskList>("/api/asks"),
  /** #936: answers one question by its id; a 409 carries `body` (AskChanged: what changed, the question now). */
  answerAsk: (id: string, answer: AskAnswer, policy?: PolicyInput) => req<AskAnswerResult>("/api/asks/answer", { method: "POST", body: JSON.stringify({ id, answer, ...(policy ? { policy } : {}) }) }),
  /** #938: the saved answer policies, and one edited / revoked. */
  listPolicies: () => req<PolicyList>("/api/policies"),
  patchPolicy: (id: string, patch: PolicyPatch) => req<AnswerPolicy>(`/api/policies/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** `answers` (question text → answer) replies to an AskUserQuestion together with the allow. */
  permission: (id: string, permId: string, decision: "allow" | "deny", answers?: Record<string, string>) =>
    req<Task>(`/api/tasks/${id}/permission`, { method: "POST", body: JSON.stringify({ id: permId, decision, answers }) }),
  abort: (id: string) => req<Task>(`/api/tasks/${id}/abort`, { method: "POST" }),
  /** Change the permission mode of an existing task (#58): live for Claude, next turn for Codex. */
  setPermissionMode: (id: string, mode: string) => req<Task>(`/api/tasks/${id}/permission-mode`, { method: "POST", body: JSON.stringify({ mode }) }),
  /** Change the model of an existing task (#155): used from the next turn. null = the CLI's default. */
  setTaskModel: (id: string, model: string | null) => req<Task>(`/api/tasks/${id}/model`, { method: "POST", body: JSON.stringify({ model }) }),
  /** Usage-limit resume (#102): send the follow-up now, or forget the planned resume. */
  resumeNow: (id: string) => req<Task>(`/api/tasks/${id}/resume`, { method: "POST" }),
  cancelResume: (id: string) => req<Task>(`/api/tasks/${id}/resume`, { method: "DELETE" }),
  settings: () => req<SettingsResponse>("/api/settings"),
  updateSettings: (patch: SettingsPatch) => req<SettingsResponse>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  footprint: (id: string) => req<Footprint>(`/api/tasks/${id}/footprint`),
  footprintFor: (dirs: string[]) => req<Footprint>(`/api/footprint?${dirs.map((d) => `dir=${encodeURIComponent(d)}`).join("&")}`),
  mcpEndpoint: (id: string) => req<{ url: string; token: string }>(`/api/tasks/${id}/mcp`),
  mcpRotate: (id: string) => req<{ url: string; token: string }>(`/api/tasks/${id}/mcp/rotate`, { method: "POST" }),
  staging: (id: string) => req<Array<Omit<StagedChange, "before" | "after">>>(`/api/tasks/${id}/staging`),
  taskDiff: (id: string) => req<TaskDiffFile[]>(`/api/tasks/${id}/diff`),
  checks: (id: string) => req<{ run: CheckRun | null; running: boolean; meta: boolean; current: boolean }>(`/api/tasks/${id}/checks`),
  runChecks: (id: string) => req<{ run: CheckRun | null; running: boolean; meta: boolean; current: boolean }>(`/api/tasks/${id}/checks`, { method: "POST" }),
  restartDaemon: (taskId?: string, force = false) => req<{ restarting: boolean; supervised: boolean; argv: string[] }>("/api/daemon/restart", { method: "POST", body: JSON.stringify({ taskId, force }) }),
  release: () => req<ReleaseStatus>("/api/daemon/release"),
  promote: (commit: string, force = false) => req<{ started: string; commit: string }>("/api/daemon/promote", { method: "POST", body: JSON.stringify({ commit, force }) }),
  /** How often a person stepped in and what made work stop, the last 7 and 30 days against the period before each (#651); counted from the daemon's records at each look. */
  interventions: () => req<InterventionView>("/api/interventions"),
  /** How long the PBIs closed in the last 30 days took, stage by stage, against the 30 before (#651); held an hour by the daemon, refresh reads again. */
  flow: (refresh = false) => req<FlowView>(`/api/flow${refresh ? "?refresh=1" : ""}`),
  /** Open requests and PBIs of every registered workspace's GitHub backlog (#264, #294); as stored by the daemon's last import (#885); refresh imports first. */
  backlog: (refresh = false) => req<Backlog>(`/api/backlog${refresh ? "?refresh=1" : ""}`),
  /** Starts a row's next stage as a meta Task (#265). 409 with `body.taskId` = that stage is already running. */
  startBacklog: (workspaceId: string, n: number, action: BacklogAction) => req<Task>(`/api/backlog/${n}/start`, { method: "POST", body: JSON.stringify({ workspaceId, action }) }),
  /** Answers a needs-decision item (#266): `## 回答` on the Issue and the label off. */
  answerBacklog: (workspaceId: string, n: number, text: string, issue?: number) => req<{ ok: boolean }>(`/api/backlog/${n}/answer`, { method: "POST", body: JSON.stringify({ workspaceId, text, issue }) }),
  /** One stored Issue with its stored edits, held conflicts and sync (#885, #908); `ref` = its number or the localId of one made here. */
  backlogIssue: (workspaceId: string, ref: number | string) => req<BacklogIssueDetail>(`/api/backlog/${ref}?workspaceId=${encodeURIComponent(workspaceId)}`),
  /** Keeps an edit here (202) and sends it to GitHub later (#886); with `resolve` alone, a choice on a held conflict (#887; 409 = it moved since read). */
  editBacklog: (workspaceId: string, ref: number | string, edit: Omit<BacklogEditInput, "workspaceId">) => req<{ localId: string | null; operations?: string[] }>(`/api/backlog/${ref}`, { method: "PATCH", body: JSON.stringify({ workspaceId, ...edit }) }),
  /** A new Issue kept here (202, its localId) and created on GitHub later (#886). */
  createBacklog: (workspaceId: string, input: Partial<Omit<BacklogCreateInput, "workspaceId">> & { title: string }) => req<{ localId: string }>("/api/backlog", { method: "POST", body: JSON.stringify({ workspaceId, ...input }) }),
  /** A plain comment kept here and sent later (#910). */
  commentBacklog: (workspaceId: string, n: number, text: string) => req<{ operation: string }>(`/api/backlog/${n}/comment`, { method: "POST", body: JSON.stringify({ workspaceId, text }) }),
  schedules: () => req<Schedule[]>("/api/schedules"),
  createSchedule: (input: ScheduleInput) => req<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, patch: Partial<ScheduleInput>) => req<Schedule>(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => req<{ ok: boolean }>(`/api/schedules/${id}`, { method: "DELETE" }),
  /** A Task, or `scanning` for a secret-scan schedule (it starts no Task; its lines go to the log, #775). */
  runSchedule: (id: string) => req<Task | { scanning: true }>(`/api/schedules/${id}/run`, { method: "POST" }),
  scheduleLog: () => req<string[]>("/api/schedules/log"),
  presets: () => req<PresetList>("/api/presets"),
  createPreset: (input: PresetInput) => req<Preset>("/api/presets", { method: "POST", body: JSON.stringify(input) }),
  updatePreset: (id: string, patch: Partial<PresetInput>) => req<Preset>(`/api/presets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePreset: (id: string) => req<{ ok: boolean }>(`/api/presets/${id}`, { method: "DELETE" }),
  expandPreset: (id: string, input: PresetExpandInput) => req<PresetExpansion>(`/api/presets/${id}/expand`, { method: "POST", body: JSON.stringify(input) }),
  queue: () => req<Queue>("/api/queue"),
  stagingApply: (id: string, sid: string) => req<StagedChange>(`/api/tasks/${id}/staging/${sid}/apply`, { method: "POST" }),
  stagingReject: (id: string, sid: string) => req<StagedChange>(`/api/tasks/${id}/staging/${sid}/reject`, { method: "POST" }),
  /** Terminal history (#91): the session-log import's status, and a pass on request. */
  history: () => req<HistoryStatus>("/api/history"),
  historyImport: () => req<HistoryScanResult>("/api/history/import", { method: "POST" }),
  /** Routing decision log joined with each task's outcome (#25). The daemon also serves it as JSONL for export. */
  routingLog: (limit = 200) => req<RoutingLogRow[]>(`/api/routing/log?limit=${limit}`),
  /** Agreement rate of each suggester with the runner actually chosen (#25). */
  routingStats: (days = 30) => req<RoutingStats>(`/api/routing/stats?days=${days}`),
  ledger: () => req<LedgerSummary>("/api/ledger/summary"),
  ledgerDaily: (days = 7) => req<LedgerDaily[]>(`/api/ledger/daily?days=${days}`),
  ledgerTasks: (days = 7) => req<LedgerTaskRow[]>(`/api/ledger/tasks?days=${days}`),
  /** Ledger (#1836): the period per runner × model, costliest first. */
  ledgerModels: (days = 7) => req<LedgerModelRow[]>(`/api/ledger/models?days=${days}`),
  perf: (rows: PerfSample[]) => req<{ ok: true; count: number }>("/api/perf", { method: "POST", body: JSON.stringify(rows) }),
  perfSummary: () => req<PerfSummaryRow[]>("/api/perf/summary"),
  opsLatency: (days = 7) => req<OpsLatency>(`/api/ops/latency?days=${days}`),
  opsStops: (days = 7) => req<OpsStops>(`/api/ops/stops?days=${days}`),
  opsLoad: (days = 7, task?: string) => req<OpsLoad>(`/api/ops/load?days=${days}${task ? `&task=${encodeURIComponent(task)}` : ""}`),
  pricing: () => req<PricingTable & { fromSettings: string[]; source: string; problems: string[] }>("/api/ledger/pricing"),
  /** Evals (#1218): the task's rule metrics (and later the judge's and the person's evaluations). */
  taskEvals: (id: string) => req<TaskEvals>(`/api/tasks/${id}/evals`),
  /** 再評価 (#1219): scores the task now, in the background; the result arrives as evals.updated. */
  judgeEvals: (id: string) => req<{ queued: boolean }>(`/api/tasks/${id}/evals/judge`, { method: "POST" }),
  /** The person's own rating and note (#1220): one per task, replaced; DELETE clears it. Both answer the task's evals. */
  setHumanEval: (id: string, body: { rating: number; comment: string }) => req<TaskEvals>(`/api/tasks/${id}/evals/human`, { method: "PUT", body: JSON.stringify(body) }),
  clearHumanEval: (id: string) => req<TaskEvals>(`/api/tasks/${id}/evals/human`, { method: "DELETE" }),
  /** The Evals list (#1221): every task's counts, rubric score and rating, newest first; the daemon filters, the screen sorts. */
  evalsList: (q: { workspaceId?: string; runner?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (q.workspaceId) qs.set("workspaceId", q.workspaceId);
    if (q.runner) qs.set("runner", q.runner);
    if (q.limit) qs.set("limit", String(q.limit));
    const query = qs.toString();
    return req<EvalsListRow[]>(`/api/evals${query ? `?${query}` : ""}`);
  },
  setArchived: (id: string, archived: boolean) => req<Task>(`/api/tasks/${id}/archive`, { method: "POST", body: JSON.stringify({ archived }) }),
  setOutcome: (id: string, body: { outcome?: TaskOutcome; reviewed?: boolean }) => req<{ task: Task }>(`/api/tasks/${id}/outcome`, { method: "POST", body: JSON.stringify(body) }),
  setBudget: (id: string, budgetUsd: number | null) => req<{ task: Task; overBudget: boolean }>(`/api/tasks/${id}/budget`, { method: "POST", body: JSON.stringify({ budgetUsd }) }),
  inbox: () => req<InboxNote[]>("/api/inbox"),
  inboxAdd: (text: string, opts: { title?: string; workspaceHint?: string } = {}) => req<InboxNote>("/api/inbox", { method: "POST", body: JSON.stringify({ text, ...opts }) }),
  inboxClose: (path: string) => req<InboxNote>("/api/inbox/close", { method: "POST", body: JSON.stringify({ path }) }),
  inboxPromote: (path: string, workspaceId: string, runner?: RunnerId) => req<{ task: Task; note: InboxNote }>("/api/inbox/promote", { method: "POST", body: JSON.stringify({ path, workspaceId, runner }) }),
  knowledge: () => req<KnowledgeIndex>("/api/knowledge"),
  knowledgeSearch: (q: string) => req<KnowledgeSearchHit[]>(`/api/knowledge/search?q=${encodeURIComponent(q)}`),
  knowledgeDoc: (path: string) => req<KnowledgeDocDetail>(`/api/knowledge/doc?path=${encodeURIComponent(path)}`),
  knowledgeWrite: (path: string, content: string) => req<KnowledgeDoc>("/api/knowledge/doc", { method: "POST", body: JSON.stringify({ path, content }) }),
  knowledgeReindex: () => req<{ indexed: number; removed: number }>("/api/knowledge/reindex", { method: "POST" }),
  materializePreview: (workspaceId?: string) => req<{ workspace?: Workspace; files: MaterializeFile[]; warnings: Array<{ path: string; message: string }> }>(`/api/materialize/preview${workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
  materializeApply: (workspaceId: string | undefined, opts: { paths?: string[]; expected?: Record<string, string>; force?: boolean } = {}) =>
    req<MaterializeApplyResult>("/api/materialize/apply", { method: "POST", body: JSON.stringify({ workspaceId, ...opts }) }),

};

/** A WebSocket URL on the page's own host. The token travels in the query: a browser WebSocket cannot set headers. */
export function wsUrl(path: string, query: Record<string, string> = {}, loc: { protocol: string; host: string } = location, token: string | null = getToken()): string {
  const q = new URLSearchParams(query);
  if (token) q.set("token", token);
  const qs = q.toString();
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}${qs ? `?${qs}` : ""}`;
}

/** WebSocket feed with automatic reconnect. */
export function connectEvents(onMessage: (m: ServerMessage) => void, onState: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  const open = () => {
    if (closed) return;
    ws = new WebSocket(wsUrl("/ws"));
    ws.onopen = () => {
      retry = 500;
      onState(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onState(false);
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 8000)));
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
