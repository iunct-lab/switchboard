/**
 * Imports a repository's GitHub backlog into the database (#885): its requests, PBIs and Tasks (closed ones too), every
 * comment of them, their Project items, and the pull requests a PBI waits for (#817). Stored only when every page was
 * read (Db.putBacklogSnapshot): a failed import stores nothing, and the cursor and lastSuccessfulSync stay where the
 * last complete one left them.
 *
 * One import is three reads. 1. The Issues updated since the cursor (all of them the first time), in full. 2. The
 * open Issues with their Project items only: a Project field change does not touch the Issue's updatedAt. The first page
 * of this read also lists the open pull requests with their changed files (#1059; the pages after it only when there are
 * more than 50), so what the other work touches is stored without another call. 3. Per number,
 * the stored open Issues and open PRs the two lists no longer have (closed into another label, moved, deleted, hidden), the
 * targets of the PBIs' waits and the prerequisites open PBIs and Tasks name (#937, `**前提**:`; a pull request with its
 * merge commit, an Issue with how it was closed): an Issue comes back in full, a 404 marks the record `unavailable` and a 403 `forbidden`,
 * neither erases what was stored. A comment or Project item that a complete read of its Issue no longer lists is
 * marked `unavailable`.
 *
 * What it does not see: a comment edited or deleted without the Issue's updatedAt moving is seen at the Issue's next
 * update; a closed Issue that left the labels is not asked again (closed records stay as they were), except as a
 * wait or a prerequisite: one on a closed request / PBI / Task is answered by what is stored, on any other closed Issue
 * it is asked again by every import. A record marked
 * `unavailable` / `forbidden` that was open is asked again by every import, so one that comes back is seen.
 */
import { existsSync } from "node:fs";
import type { BacklogCommentData, BacklogErrorKind, BacklogIssueData, BacklogPullRequestData, BacklogItem, BacklogObjectKind, BacklogRecord, BacklogRepositoryKey, BacklogSource } from "@switchboard/protocol";
import type { BacklogSnapshotEntry, Db } from "./db.ts";
import { BacklogError, backlogRepoOf, prereqsOf, projectOf, readStoredBacklog, syncsGithub, waitsOf, type BacklogWorkspace, type GhRunner } from "./backlog.ts";
import { linkedIssues } from "../../../scripts/task-paths.ts";
import { Limit, sendGithubOperations } from "./backlog-send.ts";
import { applyLocalOperations } from "./backlog-local.ts";
import { advanceEnabling, enablingWaits } from "./backlog-enable.ts";
import { forgeTargetOf, ForgeUnsupported, originOf, runForgeOperation, type ForgeTarget } from "../../../ops-kit/src/forge.ts";
import { GitlabError, readGitlabIssue, readGitlabIssues, readGitlabNotes, runGlab, type GitlabIssue, type Sh } from "../../../ops-kit/src/forge-gitlab.ts";
import { callMetric, githubHost, GithubRetryState, noCall, parseIncluded, responseOf, retryAtFromResponse, waitMessage, type GithubFailure, type MetricSink } from "../../../ops-kit/src/gh.ts";

const TYPES = ["type:request", "type:pbi", "type:task"];
const LABELS = `labels:${JSON.stringify(TYPES)}`;
const FIELD = "field{ ... on ProjectV2FieldCommon{ name } }";
const PROJECT_ITEMS = `projectItems(first:20){ totalCount nodes{ id project{ number owner{ ... on Organization{ login } ... on User{ login } } } fieldValues(first:50){ totalCount nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ name ${FIELD} } ... on ProjectV2ItemFieldNumberValue{ number ${FIELD} } ... on ProjectV2ItemFieldTextValue{ text ${FIELD} } ... on ProjectV2ItemFieldDateValue{ date ${FIELD} } } } } }`;
const COMMENTS = "pageInfo{ hasNextPage endCursor } nodes{ id body createdAt }";
const ISSUE = `id number title url state stateReason body createdAt updatedAt closedAt milestone{ title } parent{ number } labels(first:100){ totalCount nodes{ name } } subIssues(first:100){ totalCount nodes{ number } } comments(first:100){ ${COMMENTS} } ${PROJECT_ITEMS}`;

const changedQuery = (since: boolean) =>
  `query($o:String!,$r:String!,$after:String${since ? ",$since:DateTime!" : ""}){ repository(owner:$o,name:$r){ issues(first:50, after:$after, states:[OPEN,CLOSED], ${LABELS}${since ? ", filterBy:{since:$since}" : ""}, orderBy:{field:UPDATED_AT, direction:ASC}){ pageInfo{ hasNextPage endCursor } nodes{ ${ISSUE} } } } }`;
const PR_FILES = "files(first:100){ totalCount nodes{ path } }";
const PR_FIELDS = `id number state isDraft updatedAt closedAt mergedAt headRefName body labels(first:100){ totalCount nodes{ name } } ${PR_FILES}`;
/** The open Issues with their Project items; the first page (no `after`) also lists the open PRs with their files (#1059). */
const openQuery = (withPulls: boolean) =>
  `query($o:String!,$r:String!,$after:String){ repository(owner:$o,name:$r){ issues(first:100, after:$after, states:OPEN, ${LABELS}){ pageInfo{ hasNextPage endCursor } nodes{ number ${PROJECT_ITEMS} } }${withPulls ? ` pullRequests(first:50, states:OPEN, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ ${PR_FIELDS} } }` : ""} } }`;
const OPEN_PULLS = `query($o:String!,$r:String!,$after:String){ repository(owner:$o,name:$r){ pullRequests(first:50, after:$after, states:OPEN, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ ${PR_FIELDS} } } } }`;
const MORE_COMMENTS = `query($o:String!,$r:String!,$n:Int!,$after:String!){ repository(owner:$o,name:$r){ issue(number:$n){ comments(first:100, after:$after){ ${COMMENTS} } } } }`;
const recheckQuery = (numbers: number[]) =>
  `query($o:String!,$r:String!){ repository(owner:$o,name:$r){ ${numbers.map((n) => `w${n}: issueOrPullRequest(number:${n}){ __typename ... on Issue{ ${ISSUE} } ... on PullRequest{ ${PR_FIELDS} mergeCommit{ oid } } }`).join(" ")} } }`;
/** The Issues a PR closes (#1183): the rule of `scripts/task-paths.ts` (`linkedIssues`). No duplicates, ascending. */
export const closesOf = (body: string | null, headRefName: string | null): number[] => [...new Set(linkedIssues({ body, headRefName }))].sort((a, b) => a - b);
/** A PR as stored (#1059): `files` null = more than the 100 read, so what it touches is not fully known. */
function pullEntry(raw: RawPull): BacklogSnapshotEntry {
  const text = (v: unknown) => typeof v === "string";
  if (!text(raw?.id) || typeof raw.number !== "number" || !text(raw.state) || !text(raw.updatedAt)) throw new BacklogError("gh api graphql（PR）の応答の形が想定と違います");
  const f = raw.files;
  const files = Array.isArray(f?.nodes) && typeof f.totalCount === "number" && f.totalCount <= f.nodes.length ? f.nodes.map((x) => x.path) : null;
  return {
    objectKind: "pull-request", externalId: raw.id, fetchState: "fetched",
    remote: { number: raw.number, state: raw.state, isDraft: !!raw.isDraft, labels: all(raw.labels, `#${raw.number} のラベル`).map((l) => l.name), closes: closesOf(raw.body, raw.headRefName), mergeCommit: raw.mergeCommit?.oid ?? null, updatedAt: raw.updatedAt, files, closedAt: raw.closedAt ?? null, mergedAt: raw.mergedAt ?? null },
  };
}
/** Numbers per recheck query: each alias is a whole Issue. */
const RECHECK_BATCH = 20;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
type Counted<T> = { totalCount: number; nodes: T[] };
type RawItem = { id: string; project: { number: number; owner: { login: string } }; fieldValues: Counted<{ name?: string; number?: number; text?: string; date?: string; field?: { name: string } }> };
type RawPull = { id: string; number: number; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; updatedAt: string; closedAt?: string | null; mergedAt?: string | null; headRefName: string | null; body: string | null; labels: Counted<{ name: string }>; files: Counted<{ path: string }>; mergeCommit?: { oid: string } | null };
type RawComment = { id: string; body: string; createdAt: string };
type RawIssue = {
  id: string; number: number; title: string; url: string; state: "OPEN" | "CLOSED"; stateReason?: BacklogIssueData["stateReason"]; body: string; createdAt: string; updatedAt: string; closedAt?: string | null;
  milestone: { title: string } | null; parent: { number: number } | null; labels: Counted<{ name: string }>; subIssues: Counted<{ number: number }>;
  comments: Page<RawComment>; projectItems: Counted<RawItem>;
};
type GqlError = { type?: string; path?: Array<string | number>; message?: string };
type Vars = Record<string, string | number>;

/**
 * One GraphQL call. `partial`: an alias GitHub answered with NOT_FOUND / FORBIDDEN is an answer (null data plus the
 * error), not a failure; every other error fails the import.
 */
async function graphql(gh: GhRunner, cwd: string, query: string, vars: Vars, partial = false): Promise<{ data: any; errors: GqlError[] }> {
  const args = ["api", "graphql", "--include", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => (typeof v === "number" ? ["-F", `${k}=${v}`] : ["-f", `${k}=${v}`]))];
  const r = await gh(args, cwd);
  let answer: { data?: unknown; errors?: GqlError[] } | null = null;
  try {
    answer = JSON.parse(parseIncluded(r.stdout).body);
  } catch {}
  const errors = Array.isArray(answer?.errors) ? answer.errors : [];
  const answered = errors.every((e) => partial && (e.type === "NOT_FOUND" || e.type === "FORBIDDEN") && e.path?.length === 2);
  if (!answer?.data || !answered || (r.code !== 0 && !errors.length))
    throw new BacklogError(`gh api graphql: ${(errors[0]?.message ?? (r.stderr.trim() || `exit ${r.code}`)).slice(0, 200)}`, responseOf(r.stdout, r.stderr));
  return { data: answer.data, errors };
}

function page<T>(p: unknown, what: string): Page<T> {
  const v = p as Page<T> | undefined;
  if (!v || !Array.isArray(v.nodes) || typeof v.pageInfo?.hasNextPage !== "boolean") throw new BacklogError(`gh api graphql（${what}）の応答の形が想定と違います`);
  return v;
}

/** Throws when a list was cut at its `first:` — an import is complete or not stored. */
function all<T>(c: Counted<T> | undefined, what: string): T[] {
  if (!c || !Array.isArray(c.nodes) || c.totalCount > c.nodes.length) throw new BacklogError(`${what}を全部は読めません（${c?.totalCount ?? "?"} 件）`);
  return c.nodes;
}

function itemEntries(issue: number, items: Counted<RawItem> | undefined): BacklogSnapshotEntry[] {
  return all(items, `#${issue} の Project 項目`).map((i) => {
    const fields = Object.fromEntries(all(i.fieldValues, `#${issue} の Project 項目の値`).flatMap((v) => (v.field?.name ? [[v.field.name, v.name ?? v.number ?? v.text ?? v.date ?? null]] : [])));
    return { objectKind: "project-item", externalId: i.id, remote: { issue, owner: i.project.owner.login, project: i.project.number, fields }, fetchState: "fetched" };
  });
}

/** An Issue read in full: itself, every comment (the pages after the first are asked for), its Project items. */
async function issueEntries(gh: GhRunner, cwd: string, vars: Vars, raw: RawIssue): Promise<BacklogSnapshotEntry[]> {
  const text = (v: unknown) => typeof v === "string";
  if (!text(raw?.id) || typeof raw.number !== "number" || ![raw.title, raw.url, raw.state, raw.body, raw.createdAt, raw.updatedAt].every(text))
    throw new BacklogError("gh api graphql（Issue）の応答の形が想定と違います");
  const n = raw.number;
  const comments = [...page<RawComment>(raw.comments, `#${n} のコメント`).nodes];
  for (let p = raw.comments; p.pageInfo.hasNextPage; ) {
    const { data } = await graphql(gh, cwd, MORE_COMMENTS, { ...vars, n, after: p.pageInfo.endCursor ?? "" });
    p = page<RawComment>(data?.repository?.issue?.comments, `#${n} のコメント`);
    comments.push(...p.nodes);
  }
  const issue: BacklogIssueData = {
    number: n, title: raw.title, url: raw.url, state: raw.state, stateReason: raw.stateReason ?? null, body: raw.body, labels: all(raw.labels, `#${n} のラベル`).map((l) => l.name),
    milestone: raw.milestone?.title ?? null, parent: raw.parent?.number ?? null, subIssues: all(raw.subIssues, `#${n} の sub-issue`).map((s) => s.number),
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, closedAt: raw.closedAt ?? null,
  };
  return [
    { objectKind: "issue", externalId: raw.id, remote: issue, fetchState: "fetched" },
    ...comments.map((c): BacklogSnapshotEntry => ({ objectKind: "comment", externalId: c.id, remote: { issue: n, body: c.body, createdAt: c.createdAt }, fetchState: "fetched" })),
    ...itemEntries(n, raw.projectItems),
  ];
}

const issueNumber = (r: BacklogRecord) => (r.remote ? ("issue" in r.remote ? r.remote.issue : r.remote.number) : null);

/**
 * Reads what one import stores, against what is `stored` for the repository. `since` = the cursor: the newest
 * `updatedAt` of the last import (null = read every Issue). Throws BacklogError on any failure.
 */
export async function fetchGithubSnapshot(gh: GhRunner, cwd: string, repo: { owner: string; name: string }, stored: BacklogRecord[], since: string | null): Promise<{ records: BacklogSnapshotEntry[]; cursor: string | null }> {
  const vars: Vars = { o: repo.owner, r: repo.name };
  const out = new Map<string, BacklogSnapshotEntry>();
  const put = (e: BacklogSnapshotEntry) => out.set(`${e.objectKind}:${e.externalId}`, e);
  const children = (kind: BacklogObjectKind, n: number) => stored.filter((r) => r.objectKind === kind && issueNumber(r) === n).map((r) => r.externalId);
  /** Puts `entries` and marks the stored `kind` records of Issue n they no longer list. */
  const replace = (n: number, kinds: BacklogObjectKind[], entries: BacklogSnapshotEntry[]) => {
    entries.forEach(put);
    for (const kind of kinds) {
      const seen = new Set(entries.filter((e) => e.objectKind === kind).map((e) => e.externalId));
      for (const id of children(kind, n)) if (!seen.has(id)) put({ objectKind: kind, externalId: id, remote: null, fetchState: "unavailable" });
    }
  };
  const read = new Set<number>();
  const readIssue = async (raw: RawIssue) => {
    replace(raw.number, ["comment", "project-item"], await issueEntries(gh, cwd, vars, raw));
    read.add(raw.number);
  };

  let cursor = since;
  for (let after: string | null = null; ; ) {
    const { data } = await graphql(gh, cwd, changedQuery(!!since), { ...vars, ...(after ? { after } : {}), ...(since ? { since } : {}) });
    const issues = page<RawIssue>(data?.repository?.issues, "Issue");
    for (const raw of issues.nodes) {
      await readIssue(raw);
      if (!cursor || raw.updatedAt > cursor) cursor = raw.updatedAt;
    }
    if (!issues.pageInfo.hasNextPage) break;
    after = issues.pageInfo.endCursor;
  }

  const open = new Set<number>();
  const openPulls = new Set<number>();
  const putPulls = (p: Page<RawPull>) =>
    p.nodes.forEach((raw) => {
      put(pullEntry(raw));
      openPulls.add(raw.number);
    });
  let morePulls: string | null = null;
  for (let after: string | null = null; ; ) {
    const { data } = await graphql(gh, cwd, openQuery(!after), { ...vars, ...(after ? { after } : {}) });
    if (!after) {
      const pulls = page<RawPull>(data?.repository?.pullRequests, "開いた PR");
      putPulls(pulls);
      if (pulls.pageInfo.hasNextPage) morePulls = pulls.pageInfo.endCursor;
    }
    const issues = page<{ number: number; projectItems: Counted<RawItem> }>(data?.repository?.issues, "開いた Issue");
    for (const raw of issues.nodes) {
      open.add(raw.number);
      if (!read.has(raw.number)) replace(raw.number, ["project-item"], itemEntries(raw.number, raw.projectItems));
    }
    if (!issues.pageInfo.hasNextPage) break;
    after = issues.pageInfo.endCursor;
  }

  // an open PR the first page did not hold: the pages after it, only when there are more than 50
  while (morePulls) {
    const { data } = await graphql(gh, cwd, OPEN_PULLS, { ...vars, after: morePulls });
    const pulls = page<RawPull>(data?.repository?.pullRequests, "開いた PR");
    putPulls(pulls);
    morePulls = pulls.pageInfo.hasNextPage ? pulls.pageInfo.endCursor : null;
  }

  // what is known after the two lists: the stored records with this import's on top
  const known = new Map(stored.map((r) => [`${r.objectKind}:${r.externalId}`, { kind: r.objectKind, id: r.externalId, remote: r.remote, state: r.fetchState }]));
  for (const [k, e] of out) known.set(k, { kind: e.objectKind, id: e.externalId, remote: e.fetchState === "fetched" ? e.remote : (known.get(k)?.remote ?? null), state: e.fetchState });
  // an Issue made here and not on GitHub yet (#2266, turning the sync on) is no Issue of GitHub's to ask for
  const issues = [...known.values()].filter((r) => r.kind === "issue" && r.remote && !r.id.startsWith("sb:")) as Array<{ id: string; remote: BacklogIssueData }>;
  const stale = issues.filter((r) => r.remote.state === "OPEN" && !open.has(r.remote.number) && !read.has(r.remote.number)).map((r) => r.remote.number);
  const waits = issues
    .filter((r) => r.remote.state === "OPEN" && r.remote.labels.includes("type:pbi"))
    .flatMap((pbi) => {
      const comments = [...known.values()].filter((c) => c.kind === "comment" && c.state === "fetched" && (c.remote as BacklogCommentData | null)?.issue === pbi.remote.number).map((c) => c.remote as BacklogCommentData);
      return waitsOf(comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))?.numbers ?? [];
    });
  // the prerequisites an open PBI / Task names (#937) are asked like the waits
  const prereqs = issues.filter((r) => r.remote.state === "OPEN" && (r.remote.labels.includes("type:pbi") || r.remote.labels.includes("type:task"))).flatMap((r) => prereqsOf(r.remote.body).map((p) => p.number));
  const byNumber = new Map([...known.values()].filter((r) => (r.kind === "issue" || r.kind === "pull-request") && r.remote && !r.id.startsWith("sb:")).map((r) => [(r.remote as { number: number }).number, r]));
  // a wait on a closed request / PBI / Task is answered by what is stored: reopening it moves its updatedAt, and the
  // first read lists it then. Another closed Issue is asked again: no list would show it reopened
  const closed = (n: number) => {
    const r = byNumber.get(n);
    const issue = r?.kind === "issue" && r.state === "fetched" ? (r.remote as BacklogIssueData) : null;
    return !!issue && issue.state === "CLOSED" && issue.labels.some((l) => TYPES.includes(l));
  };
  // a stored open PR the full list no longer has was closed or merged: asked again by its number (#1059)
  const gone = [...known.values()].filter((r) => r.kind === "pull-request" && (r.remote as BacklogPullRequestData | null)?.state === "OPEN").map((r) => (r.remote as BacklogPullRequestData).number).filter((n) => !openPulls.has(n));
  const numbers = [...new Set([...stale, ...gone, ...[...waits, ...prereqs].filter((n) => !closed(n))])].filter((n) => !read.has(n) && !open.has(n) && !openPulls.has(n)).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += RECHECK_BATCH) {
    const batch = numbers.slice(i, i + RECHECK_BATCH);
    const { data, errors } = await graphql(gh, cwd, recheckQuery(batch), vars, true);
    for (const n of batch) {
      const node = data?.repository?.[`w${n}`];
      if (node?.__typename === "Issue") await readIssue(node);
      else if (node?.__typename === "PullRequest")
        put(pullEntry(node));
      else {
        const type = errors.find((e) => e.path?.[1] === `w${n}`)?.type;
        if (type !== "NOT_FOUND" && type !== "FORBIDDEN") throw new BacklogError(`gh api graphql（再確認）の応答に #${n} がありません`);
        const prev = byNumber.get(n);
        if (prev) put({ objectKind: prev.kind, externalId: prev.id, remote: null, fetchState: type === "FORBIDDEN" ? "forbidden" : "unavailable" } as BacklogSnapshotEntry);
      }
    }
  }
  return { records: [...out.values()], cursor };
}

/**
 * Imports the backlog of the repository checked out at `ws.path` (#885) and stores it when complete — unless
 * `superseded` says a write to the repository came after it began (nothing is stored then) — with the
 * repository and the Project the workspace reads (`projectOf`). On a failure
 * nothing is stored; when GitHub said when to come back (a limit), that time is kept as the repository's `retryAt`.
 * `changed` = it read something other than what was stored (a value, or how a record was read). Throws BacklogError.
 */
export async function importGithubSnapshot(gh: GhRunner, db: Db, ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">, now = Date.now(), superseded = (_key: BacklogRepositoryKey) => false, enabling = false): Promise<{ key: BacklogRepositoryKey; changed: boolean; project: BacklogSource["project"] | null }> {
  const { repo, owner, name, private: isPrivate } = await backlogRepoOf(gh, ws.path);
  await refuseAnotherCheckout(gh, ws, db.getWorkspaceBacklogSource(ws.id), repo);
  const key: BacklogRepositoryKey = { service: "github", host: githubHost(), repository: repo };
  let changed = false;
  let project: BacklogSource["project"] | null = null;
  try {
    project = await projectOf(gh, ws);
    const stored = db.listBacklogRecords(key);
    const snap = await fetchGithubSnapshot(gh, ws.path, { owner, name }, stored, db.getBacklogRepository(key)?.cursor ?? null);
    changed = changedFrom(stored, snap.records);
    // the daemon wrote to the repository while this read: what it read is older than what the read-back stores; or
    // the workspace's GitHub sync was turned off meanwhile, its first import too (#2266): nothing of GitHub is stored then
    // — unless this is the read that turns it on (enableGithubSync: it writes the source itself, after the records moved)
    const current = db.getWorkspaceBacklogSource(ws.id);
    if (superseded(key) || (!enabling && current && !syncsGithub(current))) return { key, changed, project };
    db.putBacklogSnapshot(key, { ...snap, syncedAt: now });
    if (enabling) return { key, changed, project };
    // which repository and Project this workspace reads, so its backlog is read from storage without asking GitHub;
    // not when its Project variable changed meanwhile (that forgot the source, and the next import reads the new one).
    // Turning the sync on (#2266) and the numbers it gave stay
    const kept = current?.service === key.service && current.host === key.host && current.repository === key.repository ? { ...(current.enabling ? { enabling: current.enabling } : {}), ...(current.numbers ? { numbers: current.numbers } : {}) } : {};
    if ((db.getWorkspace(ws.id)?.projectVar ?? null) === (ws.projectVar ?? null)) db.setWorkspaceBacklogSource(ws.id, { ...key, project, private: isPrivate, ...kept });
  } catch (e) {
    const at = e instanceof BacklogError && e.response ? retryAtFromResponse(e.response, now)?.at : null;
    if (at) db.setBacklogRetryAt(key, at);
    throw e;
  }
  return { key, changed, project };
}

/** Whether `records` read something other than what was `stored` (a value, or how a record was read). */
function changedFrom(stored: BacklogRecord[], records: BacklogSnapshotEntry[]): boolean {
  const was = new Map(stored.map((r) => [`${r.objectKind}:${r.externalId}`, r]));
  return records.some((e) => {
    const r = was.get(`${e.objectKind}:${e.externalId}`);
    return !r || r.fetchState !== e.fetchState || (e.fetchState === "fetched" && JSON.stringify(r.remote) !== JSON.stringify(e.remote));
  });
}

/**
 * Reads what one import of a GitLab project (#892) stores, against what is `stored` for it; `since` = the cursor (the
 * newest `updated_at` of the last import). Every open Issue is listed each time and the closed ones updated since the
 * cursor (all the first time); an Issue's comments are read again when its `updated_at` moved. A stored open Issue
 * neither list has (deleted, moved) is read by number: 404 → `unavailable`, 403 → `forbidden`. GitLab CE has no
 * sub-issues: the parent is the body's `## 親 PBI` (no such section: the stored one), and a parent's `subIssues` are the
 * Issues whose parent it is. No Project
 * item is made (a board's column is its label). docs/design/forge-integration.md.
 */
export async function fetchGitlabSnapshot(sh: Sh, target: ForgeTarget, stored: BacklogRecord[], since: string | null): Promise<{ records: BacklogSnapshotEntry[]; cursor: string | null }> {
  const out = new Map<string, BacklogSnapshotEntry>();
  const put = (e: BacklogSnapshotEntry) => out.set(`${e.objectKind}:${e.externalId}`, e);
  const was = new Map<number, { id: string; value: BacklogIssueData; fetched: boolean }>();
  for (const r of stored) if (r.objectKind === "issue" && r.remote) was.set((r.remote as BacklogIssueData).number, { id: r.externalId, value: r.remote as BacklogIssueData, fetched: r.fetchState === "fetched" });
  const listed = [...(await readGitlabIssues(sh, target, "opened", null)), ...(await readGitlabIssues(sh, target, "closed", since))];
  let cursor = since;
  const read = new Map<number, GitlabIssue>();
  for (const i of listed) {
    if (!cursor || i.updatedAt > cursor) cursor = i.updatedAt;
    // the backlog's Issues, and any stored one (it may have left the labels)
    if (TYPES.some((t) => i.labels.includes(t)) || was.has(i.number)) read.set(i.number, i);
  }
  for (const [n, prev] of was) {
    if (prev.value.state !== "OPEN" || listed.some((i) => i.number === n)) continue;
    const got = await readGitlabIssue(sh, target, n);
    if (typeof got === "string") put({ objectKind: "issue", externalId: prev.id, remote: null, fetchState: got });
    else read.set(n, got);
  }
  // the parents, over what is stored and what was read
  const parentOf = new Map<number, number | null>([...was].map(([n, p]) => [n, p.value.parent]));
  // a body without the section keeps the one stored (set by an edit here)
  for (const [n, i] of read) parentOf.set(n, i.parent !== undefined ? i.parent : (was.get(n)?.value.parent ?? null));
  const subIssues = (n: number) => [...parentOf].flatMap(([m, p]) => (p === n ? [m] : [])).sort((a, b) => a - b);
  for (const [n, i] of read) {
    const prev = was.get(n)?.value;
    const { id, parent: _, ...rest } = i;
    const value: BacklogIssueData = { ...rest, parent: parentOf.get(n) ?? null, subIssues: subIssues(n) };
    // unchanged and read as it was: nothing to store (one stored 403 / 404 that reads again is stored again)
    if (prev && was.get(n)!.fetched && JSON.stringify(prev) === JSON.stringify(value)) continue;
    put({ objectKind: "issue", externalId: id, remote: value, fetchState: "fetched" });
    if (prev && prev.updatedAt === i.updatedAt) continue;
    const notes = await readGitlabNotes(sh, target, n);
    notes.forEach((c) => put({ objectKind: "comment", externalId: c.id, remote: { issue: n, body: c.body, createdAt: c.createdAt }, fetchState: "fetched" }));
    const seen = new Set(notes.map((c) => c.id));
    for (const r of stored) if (r.objectKind === "comment" && r.remote && (r.remote as { issue: number }).issue === n && !seen.has(r.externalId)) put({ objectKind: "comment", externalId: r.externalId, remote: null, fetchState: "unavailable" });
  }
  // a stored parent whose children changed
  for (const [n, p] of was) {
    if (read.has(n) || out.has(`issue:${p.id}`)) continue;
    const subs = subIssues(n);
    if (JSON.stringify(subs) !== JSON.stringify(p.value.subIssues)) put({ objectKind: "issue", externalId: p.id, remote: { ...p.value, subIssues: subs }, fetchState: "fetched" });
  }
  return { records: [...out.values()], cursor };
}

/**
 * Imports the GitLab project `target` names (#892) for the workspace and stores it when complete — unless `superseded`
 * says a write came after it began, or the workspace's sync was turned off meanwhile. The workspace's source is the
 * project (no GitHub Project: `project` is the project path with number 0). A failed GitLab call is a BacklogError
 * with the HTTP status only. glab carries the login (`forge-gitlab.ts`).
 */
export async function importGitlabSnapshot(sh: Sh, db: Db, ws: Pick<BacklogWorkspace, "id">, target: ForgeTarget, now = Date.now(), superseded = (_key: BacklogRepositoryKey) => false): Promise<{ key: BacklogRepositoryKey; changed: boolean }> {
  const key: BacklogRepositoryKey = { service: "gitlab", host: target.host, repository: target.repository! };
  const stored = db.listBacklogRecords(key);
  let snap;
  try {
    snap = await fetchGitlabSnapshot(sh, target, stored, db.getBacklogRepository(key)?.cursor ?? null);
  } catch (e) {
    if (e instanceof GitlabError) throw new BacklogError(`GitLab（${target.host}）: ${e.message}`);
    throw e;
  }
  const changed = changedFrom(stored, snap.records);
  const current = db.getWorkspaceBacklogSource(ws.id);
  if (superseded(key) || (current && !syncsGithub(current))) return { key, changed };
  db.putBacklogSnapshot(key, { ...snap, syncedAt: now });
  const same = current?.service === key.service && current.host === key.host && current.repository === key.repository;
  db.setWorkspaceBacklogSource(ws.id, { ...(same ? current : {}), ...key, project: { owner: key.repository, number: 0 } });
  return { key, changed };
}

/**
 * Refuses an import whose checkout is not the workspace's registered GitHub repository (#2799), so a clone of another
 * repository (a rebuild that cloned a public one of the same name) does not overwrite the registration the rebuild
 * clones from. A registered name GitHub forwards to the checkout's (a rename) is followed. Throws BacklogError.
 */
async function refuseAnotherCheckout(gh: GhRunner, ws: Pick<BacklogWorkspace, "path">, source: BacklogSource | null, repo: string): Promise<void> {
  if (source?.service !== "github" || source.repository.toLowerCase() === repo.toLowerCase()) return;
  const r = await gh(["api", `repos/${source.repository}`, "--jq", ".full_name"], ws.path).catch(() => null);
  if (r?.code === 0 && r.stdout.trim().toLowerCase() === repo.toLowerCase()) return;
  throw new BacklogError(`workspace の checkout は ${repo}、登録は ${source.repository} です。違うリポジトリの clone なので取り込みません。origin を確かめてください`);
}

/**
 * How often a workspace's backlog is read again by itself (#887) when no Webhook says so: every minute while it
 * changes; each read that finds nothing new (or fails) doubles the wait, up to 15 minutes. A limit's time comes first.
 */
export const POLL_MIN_MS = 60_000;
export const POLL_MAX_MS = 15 * 60_000;
/** A notice (#887, a Webhook) starts at most one import per workspace in this time, and at most HINT_BUDGET in all. */
export const HINT_WINDOW_MS = 60_000;
export const HINT_BUDGET = 10;

/**
 * The workspaces a GitHub Webhook delivery names (#887): those whose stored backlog is of its `repository.full_name`
 * (Issues, comments, sub-issues), or whose Project's owner is its `organization.login` (a Project item: an
 * Organization's Webhook carries no repository). Nothing else of the payload is read: it is not signed in, and what is
 * stored is only what an import reads from GitHub. Anything not of that shape names none.
 */
export function noticeTargets(payload: unknown, workspaces: Array<{ id: string; source: BacklogSource | null }>): string[] {
  const p = payload as { repository?: { full_name?: unknown }; organization?: { login?: unknown } } | null;
  const name = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v.toLowerCase() : null);
  const repo = name(p?.repository?.full_name);
  const org = repo ? null : name(p?.organization?.login);
  return workspaces.flatMap(({ id, source }) =>
    source?.service === "github" && !source.disabled && ((repo && source.repository.toLowerCase() === repo) || (org && source.project.owner.toLowerCase() === org)) ? [id] : [],
  );
}

const repoName = (k: BacklogRepositoryKey) => `${k.service} ${k.host} ${k.repository}`;

/** A workspace's stored backlog and how its sync stands (#885). */
export interface StoredBacklog {
  /** When the last complete import was stored (ms); null = never imported. */
  fetchedAt: number | null;
  items: BacklogItem[];
  /** An import of the workspace is under way. */
  syncing: boolean;
  /** Why the last import failed (or is not asked, during a limit); null = it succeeded. */
  error: string | null;
  /** What the owner has to do about `error` (#2362); null with no error. */
  errorKind: BacklogErrorKind | null;
}

/**
 * Keeps each workspace's stored backlog in step with GitHub (#885): one import at a time per workspace, which every
 * caller of `sync` shares. After a limit or an outage GitHub is not asked until its time (GithubRetryState per host,
 * and the `retryAt` stored with the repository, which outlives a restart): the call is refused with the reason.
 * Reading (`read`) never asks GitHub.
 */
export class BacklogSync {
  /** `since` = the last write (`seq`) when the import began. */
  private running = new Map<string, { since: number; run: Promise<void> }>();
  /** The import that follows one begun before a write (#441 review: an answer must not come back with an older copy). */
  private next = new Map<string, Promise<void>>();
  /**
   * Writes are numbered (`seq`; not timed: the read-back import starts in the same millisecond), and the last one is
   * kept per repository and per workspace (`lastWrite`). Per repository: two checkouts of one repository store into
   * the same records. Per workspace: a workspace not imported yet, or whose Project variable changed, has no repository.
   */
  private seq = 0;
  private lastWrite = new Map<string, number>();
  /** Per workspace, the `since` of its last import that stored: what it stored is newer than every write up to it. */
  private stored = new Map<string, number>();
  /** The last import's failure per workspace; `until` = a refusal during a wait, which is over at that time. */
  private failures = new Map<string, { message: string; until?: number; kind?: BacklogErrorKind }>();
  private limits: GithubRetryState;
  private gh: GhRunner;
  /** How GitLab is asked (#892): the signed-in glab. */
  glab: Sh = runGlab;
  /** `sink`: gets the measure of every gh call and of every sync answered without one (#895). */
  /** `sends`: false on a daemon that must not write to GitHub (sb-rescue's candidate runs on a copy of the database: what it sent, the daemon would send again). */
  constructor(private db: Db, gh: GhRunner, private clock = () => Date.now(), private sink?: MetricSink, private sends = true) {
    this.limits = new GithubRetryState(clock);
    this.gh = !sink ? gh : async (args, cwd) => {
      // a runner that throws (or rejects) is a failed call too (#987 recheck)
      const r = await Promise.resolve().then(() => gh(args, cwd)).catch((e: unknown) => {
        sink(callMetric(args, "", String((e as Error)?.message ?? e), 1, clock()));
        throw e;
      });
      sink(callMetric(args, r.stdout, r.stderr, r.code, clock()));
      return r;
    };
  }

  /**
   * Imports the workspace's backlog; one under way is shared, unless it began before the last write to the repository —
   * then the import after it is. Rejects with BacklogError (the reason is kept for `read`). `notice`: a Webhook's
   * notice asked for it (`hint`); `echo` = it came within a minute of the daemon's own write to the repository.
   */
  sync(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">, notice?: { echo: boolean }): Promise<void> {
    const now = this.clock();
    // the repository the workspace reads, for the measures of what asks nothing (null before its first import)
    const source = this.db.getWorkspaceBacklogSource(ws.id);
    // a backlog kept here only (#2265), or one whose GitHub sync is off (#2266): what is stored is the newest there is —
    // nothing is asked, waited for or read again
    if (source && !syncsGithub(source)) {
      this.db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: now });
      this.failures.delete(ws.id);
      // a read planned while it still synced is not made
      clearTimeout(this.polls.get(ws.id)?.timer);
      this.polls.delete(ws.id);
      return Promise.resolve();
    }
    const repo = source?.repository ?? null;
    const under = this.running.get(ws.id);
    if (under) {
      // joining the import under way asks nothing; the one queued after a write will ask
      if (!this.writtenSince(ws, null, under.since)) {
        this.sink?.(noCall("backlog", "shared", now, null, repo));
        return under.run;
      }
      let next = this.next.get(ws.id);
      if (!next) {
        next = under.run.catch(() => undefined).then(() => {
          this.next.delete(ws.id);
          // the import before it may have stored what came after the write already (it followed a superseded one)
          if (!this.writtenSince(ws, null, this.stored.get(ws.id) ?? -1)) return;
          return this.sync(this.current(ws));
        });
        this.next.set(ws.id, next);
      } else this.sink?.(noCall("backlog", "shared", now, null, repo));
      return next;
    }
    // the repository's service (#920, its ops.config.json `forge`); a waiting limit is its host's: GitHub's wait does not hold a GitLab import (#892)
    let target: ForgeTarget | null = null;
    let refused: unknown = null;
    try {
      target = forgeTargetOf(ws.path, originOf(ws.path));
    } catch (e) {
      refused = e;
    }
    const host = target?.host ?? githubHost();
    const stored = source ? this.db.getBacklogRepository(source)?.retryAt : null;
    const wait = this.limits.waiting(host) ?? (stored && stored > now ? { until: stored, reason: "primary" as const } : null);
    if (wait) {
      this.sink?.(noCall("backlog", "waited", now, wait.reason, repo));
      this.failures.set(ws.id, { message: waitMessage(wait), until: wait.until });
      this.pollLater(ws);
      return Promise.reject(new BacklogError(waitMessage(wait)));
    }
    // a notice folded before this import begins is read by it, whatever comes of it
    const folded = (this.noticed.get(ws.id) ?? Infinity) <= now;
    const reads = !!notice || folded;
    // notices that all came right after the daemon's own write (its echo) find nothing new, which says nothing of notices
    const echo = (notice?.echo ?? true) && (!folded || (this.noticeEcho.get(ws.id) ?? true));
    if (folded) this.noticed.delete(ws.id), this.noticeEcho.delete(ws.id);
    const since = this.seq;
    let superseded = false;
    // a service not supported (or a GitLab checkout of another project) is the import's failure, said as it is
    const read = (ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">) => () => importGithubSnapshot(this.gh, this.db, ws, now, (key) => (superseded = this.writtenSince(ws, key, since)));
    // (an async body runs at once up to its first wait: the read starts now, as it did before)
    const readGitlab = (op: { target: ForgeTarget }) => importGitlabSnapshot(this.glab, this.db, ws, op.target, now, (key) => (superseded = this.writtenSince(ws, key, since)));
    const imported = (async () => {
      if (!target) throw refused;
      return runForgeOperation({ kind: "read", target, payload: null }, { github: { read: read(ws) }, gitlab: { read: readGitlab } });
    })().then(
      ({ changed }) => {
        this.every.set(ws.id, changed ? POLL_MIN_MS : this.longer(ws.id));
        if (reads && (changed || !echo)) this.hintEvery.set(ws.id, changed ? HINT_WINDOW_MS : Math.min(POLL_MAX_MS, 2 * this.hintWindow(ws.id)));
        this.failures.delete(ws.id);
        this.limits.succeeded(host, now);
        if (!superseded) this.stored.set(ws.id, since);
        // GitHub answers again: what was kept while it did not is sent (#886)
        this.send(ws);
        // what was stored changed: a wait it closed may let a PBI go on now (#1879); one that stored nothing is followed by one that does
        if (changed && !superseded) for (const l of this.imported) {
          try {
            l(ws.id);
          } catch (e) {
            console.error(`[backlog] after the import of ${ws.id}: ${String((e as Error)?.message ?? e)}`);
          }
        }
      },
      (e: unknown) => {
        const until = e instanceof BacklogError && e.response ? this.limits.failed(host, e.response)?.until : null;
        if (until && source) this.db.setBacklogRetryAt(source, until);
        this.failures.set(ws.id, { message: e instanceof BacklogError || e instanceof ForgeUnsupported ? e.message : `想定外のエラー: ${String((e as Error)?.message ?? e).slice(0, 200)}`, kind: e instanceof BacklogError ? e.kind : undefined });
        this.every.set(ws.id, this.longer(ws.id));
        // a notice that could not be read in is no reason to read every minute either (forged during an outage)
        if (reads && !echo) this.hintEvery.set(ws.id, Math.min(POLL_MAX_MS, 2 * this.hintWindow(ws.id)));
        throw e;
      },
    ).finally(() => {
      this.running.delete(ws.id);
      this.pollLater(ws);
    });
    // one that stored nothing (a write came while it read) is followed by one that reads the write, and its callers
    // (the sweep, 再読込) wait for that: they decide on what is stored after it, not on the copy from before
    const run = imported.then(() => (superseded ? this.sync(this.current(ws)) : undefined));
    this.running.set(ws.id, { since, run });
    return run;
  }

  private imported = new Set<(wsId: string) => void>();
  /** Called with the workspace's id after an import that stored a change; returns the unsubscribe. */
  onImported(l: (wsId: string) => void): () => void {
    this.imported.add(l);
    return () => this.imported.delete(l);
  }

  /** The workspace as it is now: a `projectVar` changed since the caller read it is the one imported. */
  private current(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">): Pick<BacklogWorkspace, "id" | "path" | "projectVar"> {
    return this.db.getWorkspace(ws.id) ?? ws;
  }

  /**
   * Whether the daemon wrote, after write `since`, to this workspace or to the repository its records are stored under
   * (`key`, when the import knows it; else the workspace's last import's).
   */
  private writtenSince(ws: Pick<BacklogWorkspace, "id">, key: BacklogRepositoryKey | null, since: number): boolean {
    const repo = key ?? this.db.getWorkspaceBacklogSource(ws.id);
    const last = Math.max(this.lastWrite.get(`workspace ${ws.id}`) ?? 0, repo ? (this.lastWrite.get(repoName(repo)) ?? 0) : 0);
    return last > since;
  }

  /** After the daemon wrote to the workspace's repository: an import that reads it back is asked for. */
  wrote(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">): void {
    this.written(ws);
    this.request(ws);
  }

  /** Numbers a write: an import begun before it stores nothing (what it read may be older than the write). */
  private written(ws: Pick<BacklogWorkspace, "id">): void {
    const at = this.clock();
    this.writtenAt.set(`workspace ${ws.id}`, at);
    const n = ++this.seq;
    this.lastWrite.set(`workspace ${ws.id}`, n);
    const repo = this.db.getWorkspaceBacklogSource(ws.id);
    if (repo) this.lastWrite.set(repoName(repo), n), this.writtenAt.set(repoName(repo), at);
  }

  /** The daemon wrote to the workspace's repository (through any checkout of it) within a minute before `at`. */
  private wroteRecently(ws: Pick<BacklogWorkspace, "id">, at: number): boolean {
    const repo = this.db.getWorkspaceBacklogSource(ws.id);
    const last = Math.max(this.writtenAt.get(`workspace ${ws.id}`) ?? -Infinity, repo ? (this.writtenAt.get(repoName(repo)) ?? -Infinity) : -Infinity);
    return last >= at - HINT_WINDOW_MS;
  }

  /** The send under way per repository (#886): one at a time; one asked for meanwhile runs after it. */
  private sending = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  /**
   * Sends the workspace's repository's edits kept here (#886, backlog-send.ts), never during a limit or an outage of the
   * host (the same wait as the imports); what was sent is imported back. Tried again by itself at the time the first
   * operation still waiting may go. Resolves when this send is over; never rejects.
   */
  send(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const source = this.db.getWorkspaceBacklogSource(ws.id);
    // a backlog kept here only (#2265), or one whose GitHub sync is off (#2266): applied at once, nothing goes out — on
    // sb-rescue's candidate too (it sends nothing). An edit of a GitHub record of the latter waits (applyLocalOperations)
    if (source && !syncsGithub(source)) {
      try {
        applyLocalOperations(this.db, source, this.clock());
        this.failures.delete(ws.id);
      } catch (e) {
        this.failures.set(ws.id, { message: `保存できませんでした: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
      }
      return Promise.resolve();
    }
    if (!source || !this.sends) return Promise.resolve();
    const key = repoName(source);
    const run = (this.sending.get(key) ?? Promise.resolve()).then(() => this.sendNow(ws, source)).catch(() => undefined);
    this.sending.set(key, run);
    void run.finally(() => this.sending.get(key) === run && this.sending.delete(key));
    return run;
  }

  private async sendNow(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">, source: BacklogSource): Promise<void> {
    // one queued behind another send while the workspace's GitHub sync was turned off (#2266) sends nothing
    if (!syncsGithub(this.db.getWorkspaceBacklogSource(ws.id))) return;
    const now = this.clock();
    const stored = this.db.getBacklogRepository(source)?.retryAt;
    // the wait is the host's: GitHub's does not hold a GitLab project's sends (#2910)
    const until = this.limits.waiting(source.host)?.until ?? (stored && stored > now ? stored : null);
    if (until) return this.later(ws, source, until);
    // what was written is imported back, whatever came of the rest of the run (a conflict, a limit) — after a wait
    // is recorded, so the import waits with it
    let wrote = false;
    const held = new Set(this.db.listPendingBacklogOperations(source).flatMap((o) => (o.status === "conflict" ? [o.id] : [])));
    try {
      // each write at once, not at the end of the run: an import that read before it must not judge the edits after
      // it on the older value (#887)
      await sendGithubOperations(this.gh, this.db, ws.path, source, this.clock, () => {
        wrote = true;
        this.written(ws);
      }, () => syncsGithub(this.db.getWorkspaceBacklogSource(ws.id)), (op) => enablingWaits(this.db.getWorkspaceBacklogSource(ws.id), op), this.glab);
    } catch (e) {
      if (!(e instanceof Limit)) throw e;
      // turned off meanwhile (#2266): nothing more goes, nothing waits for a time
      if (e.kind === "off") return;
      // a login refused waits for the next send (an edit, an import), and says why where the backlog shows errors (an
      // import would only fail the same way); a limit is the host's, as the imports' are
      if (e.kind === "auth") return void this.failures.set(ws.id, { message: e.message, kind: source.service === "github" ? "gh-login" : undefined });
      const until = (e.response && this.limits.failed(source.host, e.response)?.until) || e.until;
      this.db.setBacklogRetryAt(source, until);
      if (wrote) this.wrote(ws);
      return this.later(ws, source, until);
    }
    // turning the sync on (#2266): once every Issue made here has GitHub's number, its bodies, parents and comments are
    // sent next; once they are, GitHub's Project items replace the ones kept here (a create resumed after an outage
    // wrote no post, so nothing else reads them)
    const step = this.db.getWorkspaceBacklogSource(ws.id)?.enabling ? advanceEnabling(this.db, ws.id, this.clock()) : null;
    if (step === "queued") void this.send(ws);
    if (step === "ended") this.request(ws);
    const pending = this.db.listPendingBacklogOperations(source);
    if (wrote) this.wrote(ws);
    // held at the check before the write (#887): nothing written, but GitHub's value it read is not stored — an import
    // reads it, so the choice on the conflict is offered with GitHub's value, not the older copy
    else if (pending.some((o) => o.status === "conflict" && !held.has(o.id))) this.request(ws);
    const next = pending.flatMap((o) => (o.status === "pending" && o.retryAt ? [o.retryAt] : []));
    if (next.length) this.later(ws, source, Math.min(...next));
  }

  /** At the daemon's stop: no send or read waits on a timer any more (it would find the database closed). */
  stop(): void {
    // a send or an import under way that ends after this neither sends nor sets a timer (#549: one that did, on a closed database)
    this.stopped = true;
    this.polling = false;
    for (const t of this.timers.values()) clearTimeout(t);
    for (const p of this.polls.values()) clearTimeout(p.timer);
    this.timers.clear();
    this.polls.clear();
  }

  /** The wait before the next read of each workspace (POLL_MIN_MS … POLL_MAX_MS); none yet = the shortest. */
  private every = new Map<string, number>();
  private polling = false;
  /** The next read of each workspace by itself: when, and its timer (which does not keep the daemon up). */
  private polls = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

  private longer(id: string): number {
    return Math.min(POLL_MAX_MS, 2 * (this.every.get(id) ?? POLL_MIN_MS));
  }

  /**
   * From now on, every workspace asked for is read again by itself (#887): after its wait (`every`; POLL_MAX_MS for one
   * never imported), and not before the host's or the repository's wait is over. Each import (or refusal during a wait) sets
   * the next time. Per workspace: two checkouts of one repository are read each on their own.
   */
  startPolling(): void {
    this.polling = true;
  }

  /** When a notice last started an import, per workspace; and every one that did within the last HINT_WINDOW_MS. */
  private hinted = new Map<string, number>();
  private hints: number[] = [];
  /** The notice window per workspace (`hintWindow`). */
  private hintEvery = new Map<string, number>();
  /** A notice folded into a later read, per workspace: its time, until an import begins after it. */
  private noticed = new Map<string, number>();
  /** Whether every notice folded in `noticed` came right after the daemon's own write (an echo). */
  private noticeEcho = new Map<string, boolean>();
  /** When the daemon last wrote, per workspace and per repository (ms). */
  private writtenAt = new Map<string, number>();

  /**
   * A notice that the workspace's repository changed on GitHub (#887, a Webhook): asks for an import — never with
   * anything the notice said. One per workspace per window (`hintWindow`) and HINT_BUDGET a minute in all start an
   * import at once; the rest are folded into a read no later than the window's end (the poll), and so is one that
   * comes while an import of the workspace runs (that import may have read before the change) or during a wait.
   * Returns whether it started one.
   */
  hint(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">): boolean {
    // a daemon that does not read by itself (sb-rescue's candidate) takes no notice
    if (!this.polling) return false;
    const now = this.clock();
    const echo = this.wroteRecently(ws, now);
    this.hints = this.hints.filter((t) => t > now - HINT_WINDOW_MS);
    const last = this.hinted.get(ws.id);
    // during a wait the notice asks nothing and spends no budget: it is read at the wait's end
    if ((last !== undefined && now - last < this.hintWindow(ws.id)) || this.hints.length >= HINT_BUDGET || this.running.has(ws.id) || this.waitUntil(ws) > now) {
      this.noticeEcho.set(ws.id, (this.noticed.has(ws.id) ? (this.noticeEcho.get(ws.id) ?? true) : true) && echo);
      this.noticed.set(ws.id, now);
      if ((this.nextPoll(ws.id) ?? Infinity) > now + this.hintWindow(ws.id)) this.pollLater(ws);
      return false;
    }
    this.hinted.set(ws.id, now);
    this.hints.push(now);
    this.sync(ws, { echo }).catch(() => undefined);
    return true;
  }

  /**
   * How often notices may start an import of the workspace: a minute while the imports that read notices find changes,
   * twice as long each time one finds nothing new (up to POLL_MAX_MS) — notices that bring nothing (forged, repeated)
   * cannot keep GitHub read every minute. The echo of the daemon's own write (within a minute of it) does not widen it.
   */
  hintWindow(id: string): number {
    return this.hintEvery.get(id) ?? HINT_WINDOW_MS;
  }

  /**
   * What GitHub's host is waited for, and until when (ms): no call goes to it meanwhile, the budget's read neither (#549).
   * After a restart the wait a repository stored counts too, as `sync` counts it; its kind was not stored (`reason` null).
   */
  hostWait(): { until: number; reason: GithubFailure | null } | null {
    const now = this.limits.now();
    const stored = Math.max(0, ...this.db.listWorkspaces().map((ws) => {
      const source = this.db.getWorkspaceBacklogSource(ws.id);
      return (source && this.db.getBacklogRepository(source)?.retryAt) || 0;
    }));
    return this.limits.waiting(githubHost()) ?? (stored > now ? { until: stored, reason: null } : null);
  }

  /** The end of the host's or the workspace's repository's wait (ms); 0 = none. */
  private waitUntil(ws: Pick<BacklogWorkspace, "id">): number {
    const source = this.db.getWorkspaceBacklogSource(ws.id);
    return Math.max(this.limits.waiting(source?.host ?? githubHost())?.until ?? 0, (source && this.db.getBacklogRepository(source)?.retryAt) || 0);
  }

  /** When the workspace is read again by itself (ms); null = not planned. */
  nextPoll(id: string): number | null {
    return this.polls.get(id)?.at ?? null;
  }

  /** A notice folded meanwhile brings it to that notice's minute at the latest; a limit's time still comes first. */
  private pollLater(ws: Pick<BacklogWorkspace, "id">): void {
    if (!this.polling) return;
    const source = this.db.getWorkspaceBacklogSource(ws.id);
    // a backlog kept here only (#2265), or one whose GitHub sync is off (#2266), has nothing to read again
    if (!syncsGithub(source)) return;
    const now = this.clock();
    const wait = this.waitUntil(ws);
    // one never imported may be no GitHub checkout (the meta workspace), or its first import failed for a while: tried
    // again at the longest wait only
    const by = (this.noticed.get(ws.id) ?? Infinity) + this.hintWindow(ws.id);
    const at = Math.max(wait, Math.min(by, now + (source ? (this.every.get(ws.id) ?? POLL_MIN_MS) : POLL_MAX_MS)));
    clearTimeout(this.polls.get(ws.id)?.timer);
    const timer = setTimeout(() => {
      this.polls.delete(ws.id);
      // a workspace removed meanwhile, or whose checkout is gone, is not read again
      const cur = this.db.getWorkspace(ws.id);
      if (cur && existsSync(cur.path)) this.request(cur);
    }, at - now);
    timer.unref?.();
    this.polls.set(ws.id, { at, timer });
  }

  /** Sends again at `at` (ms); one timer per repository, which does not keep the daemon up. */
  private later(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">, source: BacklogSource, at: number): void {
    if (this.stopped) return;
    const key = repoName(source);
    clearTimeout(this.timers.get(key));
    const t = setTimeout(() => (this.timers.delete(key), this.send(ws)), Math.max(0, at - this.clock()));
    t.unref?.();
    this.timers.set(key, t);
  }

  /**
   * Brings the workspace up to date before a start decides on it (#909): what is kept here is sent (never rejects), then
   * the repository is imported. Resolves once the import is stored; rejects with BacklogError during a limit or an
   * outage, or when GitHub cannot be read — a start then goes on with the stored data (#2264).
   */
  async settle(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">): Promise<void> {
    await this.send(ws);
    await this.sync(ws);
  }

  /** Asks for an import without waiting for it; its failure is kept for `read`. */
  request(ws: Pick<BacklogWorkspace, "id" | "path" | "projectVar">): void {
    this.sync(ws).catch(() => undefined);
  }

  /** Why the workspace's last import failed (or is held back); null = it did not. Cheap: reads no records. */
  importError(ws: Pick<BacklogWorkspace, "id">): string | null {
    const f = this.failures.get(ws.id);
    return f && !(f.until !== undefined && f.until <= this.clock()) ? f.message : null;
  }

  /** The stored backlog of the workspace and its sync state; never asks GitHub. `opts` goes to readStoredBacklog (#937). */
  read(ws: Pick<BacklogWorkspace, "id" | "name" | "path">, opts: Parameters<typeof readStoredBacklog>[2] = {}): StoredBacklog {
    const f = this.failures.get(ws.id);
    const failed = f && !(f.until !== undefined && f.until <= this.clock()) ? f : null;
    const error = failed?.message ?? null;
    // one queued after a write is under way too
    return { ...readStoredBacklog(this.db, ws, { ...opts, importFailed: error !== null, now: this.clock() }), syncing: this.running.has(ws.id) || this.next.has(ws.id), error, errorKind: failed ? (failed.kind ?? "other") : null };
  }
}
