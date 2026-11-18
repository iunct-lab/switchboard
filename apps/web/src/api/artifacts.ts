import type { Artifact, Attachment, ReportRow } from "@switchboard/protocol";
import { acrossParams, type AcrossQuery } from "../reports.ts";
import { req, getToken } from "./request.ts";

export type AppUse = { appDays: number; appRequestTaskId: string | null };

/** The calls of this group; `api` (index.ts) holds every group's. */
export const artifactsApi = {
  /** Attachments: upload first, then send the ids with a turn. */
  uploadAttachments: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("file", f, f.name);
    return req<Attachment[]>("/api/attachments", { method: "POST", body: fd });
  },
  removeArtifact: (id: string) => req<Artifact>(`/api/artifacts/${id}`, { method: "DELETE" }),
  restoreArtifact: (id: string) => req<Artifact>(`/api/artifacts/${id}/restore`, { method: "POST" }),
  refreshArtifact: (id: string) => req<Artifact>(`/api/artifacts/${id}/refresh`, { method: "POST" }),
  viewArtifact: (id: string) => req<{ url: string }>(`/api/artifacts/${id}/view`, { method: "POST" }),
  /** A throwaway app read the API through the screen: the days counted, and the request Task Switchboard started for it on the 3rd. */
  artifactAppUse: (id: string) => req<AppUse>(`/api/artifacts/${id}/app-use`, { method: "POST" }),
  /** Reports across Tasks: every task's HTML artifacts, newest first. */
  reports: (o: AcrossQuery = {}) => req<ReportRow[]>(`/api/reports${acrossParams(o)}`),
  /** Every artifact across Tasks, newest first; the same query as `reports`. */
  allArtifacts: (o: AcrossQuery = {}) => req<ReportRow[]>(`/api/artifacts${acrossParams(o)}`),
  deleteAttachment: (id: string) => req<{ ok: boolean }>(`/api/attachments/${id}`, { method: "DELETE" }),
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
  /** The bytes, with the token when one is set (an <img src> could not send it). */
  attachmentBlob: async (id: string): Promise<Blob> => {
    const token = getToken();
    const r = await fetch(`/api/attachments/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.blob();
  },
};
