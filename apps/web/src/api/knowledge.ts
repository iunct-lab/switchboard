import type { KnowledgeDoc, KnowledgeSearchHit, Workspace } from "@switchboard/protocol";
import { req } from "./request.ts";

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

/** The calls of this group; `api` (index.ts) holds every group's. */
export const knowledgeApi = {
  knowledge: () => req<KnowledgeIndex>("/api/knowledge"),
  knowledgeSearch: (q: string) => req<KnowledgeSearchHit[]>(`/api/knowledge/search?q=${encodeURIComponent(q)}`),
  knowledgeDoc: (path: string) => req<KnowledgeDocDetail>(`/api/knowledge/doc?path=${encodeURIComponent(path)}`),
  knowledgeWrite: (path: string, content: string) => req<KnowledgeDoc>("/api/knowledge/doc", { method: "POST", body: JSON.stringify({ path, content }) }),
  knowledgeReindex: () => req<{ indexed: number; removed: number }>("/api/knowledge/reindex", { method: "POST" }),
  materializePreview: (workspaceId?: string) => req<{ workspace?: Workspace; files: MaterializeFile[]; warnings: Array<{ path: string; message: string }> }>(`/api/materialize/preview${workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`}`),
  materializeApply: (workspaceId: string | undefined, opts: { paths?: string[]; expected?: Record<string, string>; force?: boolean } = {}) =>
    req<MaterializeApplyResult>("/api/materialize/apply", { method: "POST", body: JSON.stringify({ workspaceId, ...opts }) }),
};
