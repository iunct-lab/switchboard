import { ForgeRefused, type ForgeImpl, type ForgeTarget } from "./forge.ts";
import type { Verification } from "./forge-github.ts";
import { findSecrets, NO_HOST, type HostAws } from "./secrets.ts";

/**
 * GitLab's side of the forge operations (#892), through the signed-in `glab` CLI: `glab api` carries the login of the
 * host it is given, so no credential is kept, read or printed here, and `gh` (GitHub's login) is never pointed at a
 * GitLab host. `sh` runs a command and throws on a non-zero exit. docs/design/forge-integration.md.
 */
export type Sh = (cmd: string[]) => Promise<string>;

/** A GitLab record's id as stored: the instance-wide `id` (an Issue's `iid` is its number, per project). */
export const gitlabId = (kind: "issue" | "note" | "merge_request", id: number) => `gitlab:${kind}:${id}`;

/** The REST path of the target's project: its full path, encoded (`group/sub/app` → `projects/group%2Fsub%2Fapp`). */
export function projectPath(target: ForgeTarget): string {
  if (target.service !== "gitlab" || !target.repository) throw new Error("GitLab の対象には project（group/name）が要ります");
  return `projects/${encodeURIComponent(target.repository)}`;
}

/**
 * One call of GitLab's REST API v4 on the target's host (`path` below `/api/v4/`). `fields` go as `-f key=value`. The
 * method is always named: glab makes a call with fields a POST unless told otherwise, and a read must never write.
 * Answers the parsed JSON.
 */
export async function glabApi(sh: Sh, target: ForgeTarget, path: string, opts: { method?: "GET" | "POST" | "PUT" | "DELETE"; fields?: Record<string, string> } = {}): Promise<unknown> {
  const cmd = ["glab", "api", "--hostname", target.host, "-X", opts.method ?? "GET"];
  for (const [k, v] of Object.entries(opts.fields ?? {})) cmd.push("-f", `${k}=${v}`);
  cmd.push(path);
  const out = await sh(cmd);
  return out.trim() ? JSON.parse(out) : null;
}

/**
 * Whether `glab` is signed in to the target's host. Not signed in (or no glab at all) is said as the fact the person
 * acts on — signing in is theirs to do — never with what glab printed (it may show a token).
 */
export async function gitlabAuth(sh: Sh, target: ForgeTarget): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await sh(["glab", "auth", "status", "--hostname", target.host]);
    return { ok: true };
  } catch {
    return { ok: false, reason: `${target.host} の glab にログインしていません（glab auth login --hostname ${target.host} は利用者が行う）` };
  }
}

/** `glab` from PATH. A failed call throws with the HTTP status glab names, never with the rest of what it printed. */
export const runGlab: Sh = async (cmd) => {
  let p;
  try {
    p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch {
    throw new GitlabError("glab を起動できません（glab が入っていない）", null);
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new GitlabError(`glab api が失敗しました${statusIn(err) ? `（HTTP ${statusIn(err)}）` : ""}`, statusIn(err));
  return out;
};

/** A GitLab call that failed; `status` = the HTTP status (null = not known: not reached, no glab). */
export class GitlabError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}
const statusIn = (text: string) => Number(/\(HTTP (\d{3})\)|\b([45]\d\d)\b/.exec(text)?.slice(1).find(Boolean)) || null;
/** The HTTP status of a failed call (a GitlabError's, or one named in another error's message). */
export const statusOf = (e: unknown) => (e instanceof GitlabError ? e.status : statusIn(String((e as Error)?.message ?? e)));

/** An Issue as the backlog stores it (the shape of BacklogIssueData); `id` = its stored id. */
export interface GitlabIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  /** GitLab (CE) closes one way: closed = completed. */
  stateReason: "COMPLETED" | null;
  body: string;
  labels: string[];
  milestone: string | null;
  /** From the body's `## 親 PBI` (GitLab CE has no sub-issues): its first `#N`; null = the section names none; undefined = no such section. */
  parent: number | null | undefined;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
/** A comment: a note that is not GitLab's own (a label change, a mention). */
export interface GitlabNote {
  id: string;
  issue: number;
  body: string;
  createdAt: string;
}

type RawIssue = { id: number; iid: number; title: string; web_url: string; state: string; description: string | null; labels: string[]; milestone: { title: string } | null; created_at: string; updated_at: string; closed_at: string | null };
type RawNote = { id: number; body: string; system: boolean; created_at: string };

const PER_PAGE = 100;
/** Every page of a list (GitLab's `page` / `per_page`): a page shorter than PER_PAGE is the last. */
async function every<T>(sh: Sh, target: ForgeTarget, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const got = await glabApi(sh, target, `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(got)) throw new GitlabError(`GitLab の ${path.split("?")[0]} の応答が一覧ではありません`, null);
    out.push(...(got as T[]));
    if (got.length < PER_PAGE) return out;
  }
}

export function parentIn(body: string): number | null | undefined {
  const m = /^##\s*親 PBI[ \t]*\r?\n(?:[ \t]*\r?\n)*([^\r\n]*)/m.exec(body);
  return m ? Number(/#(\d+)/.exec(m[1]!)?.[1]) || null : undefined;
}

export function issueOf(raw: RawIssue): GitlabIssue {
  if (typeof raw?.id !== "number" || typeof raw.iid !== "number" || typeof raw.title !== "string" || !Array.isArray(raw.labels) || (raw.state !== "opened" && raw.state !== "closed"))
    throw new GitlabError("GitLab の Issue の応答の形が想定と違います", null);
  const body = raw.description ?? "";
  return {
    id: gitlabId("issue", raw.id), number: raw.iid, title: raw.title, url: raw.web_url, state: raw.state === "opened" ? "OPEN" : "CLOSED", stateReason: raw.state === "closed" ? "COMPLETED" : null,
    body, labels: raw.labels, milestone: raw.milestone?.title ?? null, parent: parentIn(body), createdAt: raw.created_at, updatedAt: raw.updated_at, closedAt: raw.closed_at ?? null,
  };
}

/**
 * The project's Issues in one state (`opened` / `closed`), oldest update first; `since` = only those updated at or
 * after it (GitLab's `updated_after`). A label change, a close, a comment all move an Issue's `updated_at`.
 */
export async function readGitlabIssues(sh: Sh, target: ForgeTarget, state: "opened" | "closed", since: string | null): Promise<GitlabIssue[]> {
  const q = `state=${state}&order_by=updated_at&sort=asc${since ? `&updated_after=${encodeURIComponent(since)}` : ""}`;
  return (await every<RawIssue>(sh, target, `${projectPath(target)}/issues?${q}`)).map(issueOf);
}

/** One Issue by number; "unavailable" = GitLab answered 404 (deleted, moved), "forbidden" = 403. */
export async function readGitlabIssue(sh: Sh, target: ForgeTarget, iid: number): Promise<GitlabIssue | "unavailable" | "forbidden"> {
  try {
    return issueOf((await glabApi(sh, target, `${projectPath(target)}/issues/${iid}`)) as RawIssue);
  } catch (e) {
    const s = statusOf(e);
    if (s === 404) return "unavailable";
    if (s === 403) return "forbidden";
    throw e;
  }
}

/** An Issue's comments, oldest first: GitLab's own notes (`system`) are not comments. */
export async function readGitlabNotes(sh: Sh, target: ForgeTarget, iid: number): Promise<GitlabNote[]> {
  const notes = await every<RawNote>(sh, target, `${projectPath(target)}/issues/${iid}/notes?sort=asc&order_by=created_at`);
  return notes.filter((n) => !n.system).map((n) => ({ id: gitlabId("note", n.id), issue: iid, body: n.body, createdAt: n.created_at }));
}

/* ---------- writes (#2910): what the backlog's sender sends ---------- */

/** Sets an Issue's fields (`title`, `description`, `state_event`, `add_labels`, `remove_labels`, `milestone_id`). */
export async function updateGitlabIssue(sh: Sh, target: ForgeTarget, iid: number, fields: Record<string, string>): Promise<void> {
  await glabApi(sh, target, `${projectPath(target)}/issues/${iid}`, { method: "PUT", fields });
}

/** Makes an Issue; answers it as stored. */
export async function createGitlabIssue(sh: Sh, target: ForgeTarget, fields: Record<string, string>): Promise<GitlabIssue> {
  return issueOf((await glabApi(sh, target, `${projectPath(target)}/issues`, { method: "POST", fields })) as RawIssue);
}

/** Posts a comment (a note) on an Issue; answers it as stored. */
export async function postGitlabNote(sh: Sh, target: ForgeTarget, iid: number, body: string): Promise<GitlabNote> {
  const n = (await glabApi(sh, target, `${projectPath(target)}/issues/${iid}/notes`, { method: "POST", fields: { body } })) as RawNote;
  if (typeof n?.id !== "number") throw new GitlabError("GitLab の答えに note の id がありません", null);
  return { id: gitlabId("note", n.id), issue: iid, body: n.body, createdAt: n.created_at };
}

/** The id of the project's Milestone titled `title`; a title it does not have is refused (422). */
export async function gitlabMilestoneId(sh: Sh, target: ForgeTarget, title: string): Promise<number> {
  const all = (await glabApi(sh, target, `${projectPath(target)}/milestones?title=${encodeURIComponent(title)}`)) as Array<{ id: number; title: string }>;
  const m = Array.isArray(all) ? all.find((x) => x.title === title) : undefined;
  if (!m) throw new GitlabError(`Milestone「${title}」がありません`, 422);
  return m.id;
}

/**
 * The first item of a list (`path`, newest first) whose body carries `marker`, among those made since `since` (ms):
 * an Issue (`description`) or a note (`body`). undefined = not there; null = not every page could be read.
 */
export async function findGitlabMarked(sh: Sh, target: ForgeTarget, path: string, marker: string, since: number): Promise<Record<string, unknown> | undefined | null> {
  for (let page = 1; page <= 10; page++) {
    const q = `created_after=${encodeURIComponent(new Date(since - 60_000).toISOString())}&per_page=${PER_PAGE}&page=${page}`;
    const list = (await glabApi(sh, target, `${projectPath(target)}${path}${path.includes("?") ? "&" : "?"}${q}`)) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) return null;
    const hit = list.find((x) => String(x.description ?? x.body ?? "").includes(marker));
    if (hit || list.length < PER_PAGE) return hit;
  }
  return null;
}

/* ---------- merge requests (#923): GitLab's own MR, review and discussions — nothing of them is kept here ---------- */

/** An MR as it is now: `head` / `base` = the sha its diff is between; `mergeStatus` = GitLab's `detailed_merge_status`. */
export interface GitlabMr {
  iid: number;
  url: string;
  state: "opened" | "closed" | "merged" | "locked";
  draft: boolean;
  source: string;
  target: string;
  head: string;
  base: string | null;
  mergeStatus: string | null;
}
/** A discussion (a review thread): resolved = every resolvable note in it is. `path` / `line` = where on the diff, if anywhere. */
export interface GitlabDiscussion {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  /** `path` / `line` = the new file's; `oldPath` / `oldLine` = the old file's (a removed line has only these). */
  notes: Array<{ id: number; body: string; author: string | null; path: string | null; line: number | null; oldPath: string | null; oldLine: number | null }>;
}

type RawMr = { iid: number; web_url: string; state: GitlabMr["state"]; draft?: boolean; source_branch: string; target_branch: string; sha: string; diff_refs?: { base_sha: string; head_sha: string; start_sha: string } | null; detailed_merge_status?: string | null };
type RawDiscussion = { id: string; notes: Array<{ id: number; body: string; author?: { username: string } | null; resolvable?: boolean; resolved?: boolean; system?: boolean; position?: { new_path?: string; new_line?: number | null; old_path?: string; old_line?: number | null } | null }> };

function mrOf(raw: RawMr): GitlabMr {
  if (typeof raw?.iid !== "number" || typeof raw.sha !== "string") throw new GitlabError("GitLab の MR の応答の形が想定と違います", null);
  return { iid: raw.iid, url: raw.web_url, state: raw.state, draft: !!raw.draft, source: raw.source_branch, target: raw.target_branch, head: raw.sha, base: raw.diff_refs?.base_sha ?? null, mergeStatus: raw.detailed_merge_status ?? null };
}

/** Refuses a text that carries a value that signs in: nothing is posted (`findSecrets`, as every forge operation). */
function refuseSecrets(texts: string[], host: HostAws): void {
  const kinds = [...new Set(texts.flatMap((t) => findSecrets(t, host).map((h) => h.kind)))];
  if (kinds.length) throw new ForgeRefused(`認証に使える値（${kinds.join(", ")}）が含まれるので GitLab に送りません`);
}

const mrPath = (target: ForgeTarget, iid: number) => `${projectPath(target)}/merge_requests/${iid}`;

/** Opens an MR from `source` (a branch pushed with git) into `target`. */
export async function createGitlabMr(sh: Sh, target: ForgeTarget, mr: { source: string; target: string; title: string; description: string }, host: HostAws = NO_HOST): Promise<GitlabMr> {
  refuseSecrets([mr.title, mr.description], host);
  return mrOf((await glabApi(sh, target, `${projectPath(target)}/merge_requests`, { method: "POST", fields: { source_branch: mr.source, target_branch: mr.target, title: mr.title, description: mr.description } })) as RawMr);
}

export async function viewGitlabMr(sh: Sh, target: ForgeTarget, iid: number): Promise<GitlabMr> {
  return mrOf((await glabApi(sh, target, mrPath(target, iid))) as RawMr);
}

/** Every discussion of the MR (GitLab's own notes left out). */
export async function gitlabMrDiscussions(sh: Sh, target: ForgeTarget, iid: number): Promise<GitlabDiscussion[]> {
  const all = await every<RawDiscussion>(sh, target, `${mrPath(target, iid)}/discussions`);
  return all.flatMap((d) => {
    const notes = d.notes.filter((n) => !n.system);
    if (!notes.length) return [];
    const resolvable = notes.filter((n) => n.resolvable);
    return [{
      id: d.id, resolvable: resolvable.length > 0, resolved: resolvable.length > 0 && resolvable.every((n) => n.resolved),
      notes: notes.map((n) => ({ id: n.id, body: n.body, author: n.author?.username ?? null, path: n.position?.new_path ?? null, line: n.position?.new_line ?? null, oldPath: n.position?.old_path ?? null, oldLine: n.position?.old_line ?? null })),
    }];
  });
}

/**
 * Starts a discussion on the MR: on a line of the new file when `at` is given (GitLab's position on the MR's current
 * diff), else on the MR. Answers its id.
 */
export async function startGitlabDiscussion(sh: Sh, target: ForgeTarget, iid: number, body: string, at?: { path: string; line: number }, host: HostAws = NO_HOST): Promise<string> {
  refuseSecrets([body], host);
  const fields: Record<string, string> = { body };
  if (at) {
    const refs = ((await glabApi(sh, target, mrPath(target, iid))) as RawMr).diff_refs;
    if (!refs) throw new GitlabError(`!${iid} の差分の位置を読めません`, null);
    // GitLab wants both paths: the old one is the file's before the MR (a renamed file's differs); a line of the new
    // file (an added or kept one) is named by its new line
    const file = (await every<{ old_path: string; new_path: string }>(sh, target, `${mrPath(target, iid)}/diffs`)).find((d) => d.new_path === at.path);
    if (!file) throw new GitlabError(`${at.path} は !${iid} の差分にありません`, 422);
    Object.assign(fields, { "position[position_type]": "text", "position[base_sha]": refs.base_sha, "position[start_sha]": refs.start_sha, "position[head_sha]": refs.head_sha, "position[old_path]": file.old_path, "position[new_path]": at.path, "position[new_line]": String(at.line) });
  }
  const d = (await glabApi(sh, target, `${mrPath(target, iid)}/discussions`, { method: "POST", fields })) as { id?: string };
  if (typeof d?.id !== "string") throw new GitlabError("GitLab の答えに discussion の id がありません", null);
  return d.id;
}

/** Resolves a discussion; throws when GitLab does not answer that it is. */
export async function resolveGitlabDiscussion(sh: Sh, target: ForgeTarget, iid: number, id: string): Promise<void> {
  if (!/^[0-9a-f]{8,64}$/.test(id)) throw new GitlabError(`discussion の id ではありません: ${id}`, 422);
  const d = (await glabApi(sh, target, `${mrPath(target, iid)}/discussions/${id}?resolved=true`, { method: "PUT" })) as RawDiscussion;
  const resolvable = d?.notes?.filter((n) => n.resolvable) ?? [];
  if (!resolvable.length || !resolvable.every((n) => n.resolved)) throw new GitlabError(`${id} が resolve にならなかった`, null);
}

/* ---------- the merge gate and the local CI's report (#924) ---------- */

/** GitLab's `verification` (the local CI's result): a note on the MR (`pr` = the MR's iid). */
export const gitlabForge = (sh: Sh): ForgeImpl<Verification, void> => ({
  verification: async (op) => {
    await glabApi(sh, op.target, `${mrPath(op.target, op.payload.pr)}/notes`, { method: "POST", fields: { body: op.payload.body } });
  },
});

/** What the merge gate reads of an MR, as GitLab has it now (no paid API: approvals are not read). */
export interface GitlabMergeRead {
  mr: GitlabMr;
  /** The head pipeline: its sha and status; null = none ran. */
  pipeline: { sha: string; status: string } | null;
  /** Every path the MR changes, a renamed file's old one too (with no lines of its own). */
  files: Array<{ path: string; additions: number; deletions: number }>;
  authored: string[];
  /** Notes not GitLab's own, oldest first, with the author's access level on the project (0 = none, not read). */
  notes: Array<{ body: string; createdAt: string; access: number }>;
  unresolved: number;
  /** The target branch's tip now. */
  baseTip: string;
}

/** A diff's added and removed lines (GitLab gives the patch, not the counts). */
const counted = (diff: string) => diff.split("\n").reduce((n, l) => ({ additions: n.additions + (l.startsWith("+") ? 1 : 0), deletions: n.deletions + (l.startsWith("-") ? 1 : 0) }), { additions: 0, deletions: 0 });

export async function readGitlabMerge(sh: Sh, target: ForgeTarget, iid: number): Promise<GitlabMergeRead> {
  const raw = (await glabApi(sh, target, mrPath(target, iid))) as RawMr & { head_pipeline?: { sha: string; status: string } | null };
  const mr = mrOf(raw);
  const diffs = await every<{ old_path: string; new_path: string; diff: string; too_large?: boolean; collapsed?: boolean }>(sh, target, `${mrPath(target, iid)}/diffs`);
  // a patch GitLab left out is a size not known: not judged (never counted as nothing changed)
  const cut = diffs.filter((d) => d.too_large || (d.collapsed && !d.diff));
  if (cut.length) throw new GitlabError(`!${iid} の差分を GitLab が省いた（${cut.map((d) => d.new_path).join(", ")}）。行数が分からない`, null);
  const commits = await every<{ authored_date: string }>(sh, target, `${mrPath(target, iid)}/commits`);
  const notes = (await every<{ body: string; created_at: string; system: boolean; author?: { id: number } | null }>(sh, target, `${mrPath(target, iid)}/notes?sort=asc&order_by=created_at`)).filter((n) => !n.system);
  const levels = new Map<number, number>();
  for (const id of new Set(notes.flatMap((n) => (n.author ? [n.author.id] : [])))) {
    try {
      levels.set(id, ((await glabApi(sh, target, `${projectPath(target)}/members/all/${id}`)) as { access_level?: number }).access_level ?? 0);
    } catch (e) {
      if (statusOf(e) !== 404) throw e;
      levels.set(id, 0);
    }
  }
  const discussions = await gitlabMrDiscussions(sh, target, iid);
  const branch = (await glabApi(sh, target, `${projectPath(target)}/repository/branches/${encodeURIComponent(mr.target)}`)) as { commit?: { id?: string } };
  if (!/^[0-9a-f]{40}$/.test(branch?.commit?.id ?? "")) throw new GitlabError(`枝 ${mr.target} の先端が読めない`, null);
  return {
    mr, pipeline: raw.head_pipeline ? { sha: raw.head_pipeline.sha, status: raw.head_pipeline.status } : null,
    // a renamed file is both its paths: the old one's protection (a security file moved away) counts too
    files: diffs.flatMap((d) => [{ path: d.new_path, ...counted(d.diff) }, ...(d.old_path !== d.new_path ? [{ path: d.old_path, additions: 0, deletions: 0 }] : [])]), authored: commits.map((c) => c.authored_date),
    notes: notes.map((n) => ({ body: n.body, createdAt: n.created_at, access: n.author ? (levels.get(n.author.id) ?? 0) : 0 })),
    unresolved: discussions.filter((d) => d.resolvable && !d.resolved).length, baseTip: branch.commit!.id!,
  };
}

/** Merges the MR only at `head` (GitLab refuses with 409 when the head moved): GitLab's own merge. */
export async function mergeGitlabMr(sh: Sh, target: ForgeTarget, iid: number, head: string): Promise<void> {
  const m = (await glabApi(sh, target, `${mrPath(target, iid)}/merge`, { method: "PUT", fields: { sha: head, should_remove_source_branch: "true" } })) as { state?: string };
  if (m?.state !== "merged") throw new GitlabError(`!${iid} がマージされなかった（${m?.state ?? "不明"}）`, null);
}
