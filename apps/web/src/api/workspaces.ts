import type { Task, Workspace, WorkspaceAllocation, WorkspaceConfigView, WorkspaceRemoval, WorkspaceSweep } from "@switchboard/protocol";
import { req } from "./request.ts";

/** A clone going on or failed; a finished one is a workspace and no longer listed. */
export type WorkspaceClone = { repo: string; path: string; state: "cloning" | "failed"; error?: string };

export type RunnerConfigView = { upstream: string; files: { path: string; content: string }[]; hash: string; confirmed: boolean };

/** The calls of this group; `api` (index.ts) holds every group's. */
export const workspacesApi = {
  workspaces: () => req<Workspace[]>("/api/workspaces"),
  /** `backlog`: `switchboard` keeps the workspace's Issues and Project in Switchboard only; PRs stay with the repository. */
  addWorkspace: (path: string, backlog: "github" | "switchboard" = "github") => req<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ path, backlog }) }),
  /** A GitHub repository added by name: answers at once (202); the clone goes on in the daemon, see `workspaceClones`. */
  addWorkspaceFromGithub: (repo: string, backlog: "github" | "switchboard" = "github", ownCopy = false, ownCopyOwner = "") => {
    const owner = ownCopyOwner.trim();
    return req<{ repo: string; path: string; state: "cloning" }>("/api/workspaces", { method: "POST", body: JSON.stringify({ repo, backlog, ownCopy, ...(ownCopy && owner ? { ownCopyOwner: owner } : {}) }) });
  },
  workspaceRemoval: (id: string) => req<WorkspaceRemoval>(`/api/workspaces/${id}/removal`),
  removeWorkspace: (id: string, deleteCopy: boolean) => req<{ ok: true }>(`/api/workspaces/${id}`, { method: "DELETE", body: JSON.stringify({ deleteCopy }) }),
  workspaceClones: () => req<WorkspaceClone[]>("/api/workspaces/clones"),
  /** A foreign repository's runner config: `confirmed` = Tasks may start; a stale `hash` is refused (409). */
  runnerConfig: (id: string) => req<RunnerConfigView>(`/api/workspaces/${id}/runner-config`),
  confirmRunnerConfig: (id: string, hash: string) => req<{ ok: true }>(`/api/workspaces/${id}/runner-config`, { method: "POST", body: JSON.stringify({ hash }) }),
  /** The workspace's rules kept on Switchboard's side (empty = none). */
  setWorkspaceRules: (id: string, rules: string) => req<{ id: string; rules: string }>(`/api/workspaces/${id}/rules`, { method: "PUT", body: JSON.stringify({ rules }) }),
  /** The workspace's settings kept on Switchboard's side (the shape of ops.config.json; empty = none), and which settings it runs with now. */
  workspaceConfig: (id: string) => req<WorkspaceConfigView>(`/api/workspaces/${id}/config`),
  setWorkspaceConfig: (id: string, config: string) => req<WorkspaceConfigView>(`/api/workspaces/${id}/config`, { method: "PUT", body: JSON.stringify({ config }) }),
  syncUpstream: (id: string) => req<Task>(`/api/workspaces/${id}/upstream-sync`, { method: "POST" }),
  /** 取り込み: a meta Task that runs the adopt-repo skill on this workspace (asks before it writes anything). */
  adoptRepo: (id: string) => req<Task>(`/api/workspaces/${id}/adopt`, { method: "POST" }),
  /** 立ち上げ: a Task in this workspace under the p2-baseline candidate, the concept as data. */
  startBaseline: (id: string, concept: string) => req<Task>(`/api/workspaces/${id}/baseline`, { method: "POST", body: JSON.stringify({ concept }) }),
  /**
   * Turns the workspace's GitHub sync off (`switchboard`) or on (`github`): on answers how far it is (202), or
   * rejects with why GitHub could not be read (424, nothing changed). `projectVar` = the Project of one kept here only.
   */
  setWorkspaceBacklog: (id: string, backlog: "github" | "switchboard", projectVar?: string | null) =>
    req<Workspace & { enabling?: { total: number; done: number } }>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ backlog, ...(projectVar === undefined ? {} : { projectVar }) }) }),
  setWorkspaceSweep: (id: string, sweep: Partial<WorkspaceSweep>) => req<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ sweep }) }),
  /** Whether closing a PBI attaches its work's reports to the Issue on GitHub (refused while the workspace does not sync with GitHub). */
  setWorkspaceIssueArtifacts: (id: string, on: boolean) => req<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ issueArtifacts: on }) }),
  setWorkspaceAllocation: (id: string, allocation: Partial<WorkspaceAllocation>) => req<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ allocation }) }),
  setWorkspaceProjectVar: (id: string, projectVar: string | null) => req<Workspace>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ projectVar }) }),
  workspaceBrief: (id: string) => req<{ workspaceId: string; text: string }>(`/api/workspaces/${id}/brief`),
  newRepo: (name: string, purpose: string) => req<Task>("/api/new-repo", { method: "POST", body: JSON.stringify({ name, purpose }) }),
};
