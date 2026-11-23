/**
 * `mergeRecords`: what the app records of a PR for a merge verdict (GET /api/merge-records): the jobs it ran, the
 * person's grant of the head, whether it started the Task as a direct one. The address comes from `MERGE_RECORDS_URL`,
 * else the origin of `BACKLOG_URL`; the key from the file `MERGE_RECORDS_TOKEN_FILE` names, else `BACKLOG_TOKEN_FILE`.
 * A caller outside the app's Task fills them first; with none, the call throws like any other the app cannot answer.
 */
import { GRANT_WAIT_MS, client } from "./backlog-client.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

/** The app's origin and the file of its key, from one source: `MERGE_RECORDS_URL` with `MERGE_RECORDS_TOKEN_FILE`, else `BACKLOG_URL` (its origin) with `BACKLOG_TOKEN_FILE`. It throws when no source has both. */
export function appLocation(env: Env): { url: string; tokenFile: string } {
  if (env.MERGE_RECORDS_URL && env.MERGE_RECORDS_TOKEN_FILE) return { url: env.MERGE_RECORDS_URL, tokenFile: env.MERGE_RECORDS_TOKEN_FILE };
  if (env.BACKLOG_URL && env.BACKLOG_TOKEN_FILE) return { url: new URL(env.BACKLOG_URL).origin, tokenFile: env.BACKLOG_TOKEN_FILE };
  throw new Error("merge-records: the app's address and key file are not given together (MERGE_RECORDS_URL with MERGE_RECORDS_TOKEN_FILE, or BACKLOG_URL with BACKLOG_TOKEN_FILE)");
}

export interface MergeRecordJob {
  id: number;
  kind: string;
  taskId: string;
  pr: number;
  runner: string | null;
  status: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  repo: string;
  head: string | null;
  base: string | null;
  as: string | null;
  kinds: string[];
  result: unknown;
}
export interface MergeRecords {
  jobs: MergeRecordJob[];
  granted: boolean | null;
  direct: boolean;
}

/** The records of `prs` of `repo`; it throws when the app cannot answer (not reached, 4xx, 5xx, no answer in `GRANT_WAIT_MS`), so the caller cannot judge. */
export async function mergeRecords(env: Env, q: { repo: string; prs: number[]; taskId?: string; head?: string }, f: Fetch = fetch): Promise<MergeRecords> {
  const { url, tokenFile } = appLocation(env);
  const params = new URLSearchParams({ repo: q.repo });
  for (const n of q.prs) params.append("pr", String(n));
  if (q.taskId) params.set("taskId", q.taskId);
  if (q.head) params.set("head", q.head);
  const call = client({ ...env, BACKLOG_URL: url, BACKLOG_TOKEN_FILE: tokenFile }, (u, init) => f(u, { ...init, signal: AbortSignal.timeout(GRANT_WAIT_MS) }));
  const a = (await call("GET", `/api/merge-records?${params}`)) as Partial<MergeRecords> | null;
  if (!a || !Array.isArray(a.jobs) || typeof a.direct !== "boolean") throw new Error("merge-records: the app's answer has no records");
  return { jobs: a.jobs, granted: typeof a.granted === "boolean" ? a.granted : null, direct: a.direct };
}
